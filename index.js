const SteamUser = require('steam-user');
const fs = require('fs');
const path = require('path');
const http = require('http');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const ssfnPath = path.join(DATA_DIR, 'ssfn.json');
const configPath = path.join(__dirname, 'steam-auth.json');

let config = {};
if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

const savedPassword = process.env.STEAM_PASSWORD || config.password;

const loginOptions = {
    accountName: process.env.STEAM_ACCOUNT || config.accountName,
    password: savedPassword,
    rememberPassword: true,
};

const gamesToIdle = (process.env.STEAM_GAMES
    ? process.env.STEAM_GAMES.split(',').map(Number)
    : null) || config.games || [570, 730];

const KICKED_HOURS = parseFloat(process.env.KICKED_RECONNECT_HOURS || '4');
const KICKED_RECONNECT_DELAY = KICKED_HOURS * 60 * 60 * 1000;

function log(msg) {
    const time = new Date().toLocaleTimeString('ru-RU');
    console.log('[' + time + '] ' + msg);
}

// Load saved loginKey
if (process.env.SSFN_DATA) {
    try {
        const saved = JSON.parse(Buffer.from(process.env.SSFN_DATA, 'base64').toString('utf8'));
        loginOptions.machineName = saved.machineName;
        loginOptions.loginKey = saved.loginKey;
        delete loginOptions.password;
        log('loginKey загружен из SSFN_DATA');
    } catch (e) {
        log('[WARN] SSFN_DATA задан но не удалось прочитать: ' + e.message);
    }
} else if (fs.existsSync(ssfnPath)) {
    try {
        const saved = JSON.parse(fs.readFileSync(ssfnPath, 'utf8'));
        loginOptions.machineName = saved.machineName;
        loginOptions.loginKey = saved.loginKey;
        delete loginOptions.password;
        log('loginKey загружен из ' + ssfnPath);
    } catch (e) {
        log('[WARN] Не удалось прочитать ssfn.json: ' + e.message);
    }
}

if (!loginOptions.accountName || (!loginOptions.password && !loginOptions.loginKey)) {
    console.error('[ОШИБКА] Нет данных для входа.');
    process.exit(1);
}

// State
const client = new SteamUser();
let reconnectTimeout = null;
let retryIdleTimeout = null;
let isBlocked = false;
let isPaused = false;
let kickedByUser = false;
let reconnectDelay = 5000;
const MAX_RECONNECT_DELAY = 60000;
let loggedIn = false;
let kickedAt = null;

// HTTP server
const PORT = process.env.PORT || 3000;
const httpServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.url === '/healthz') {
        res.end(JSON.stringify({ ok: true }));
        return;
    }
    if (req.url === '/status') {
        res.end(JSON.stringify({
            loggedIn, isBlocked, isPaused, kickedByUser,
            kickedAt: kickedAt ? kickedAt.toISOString() : null,
            games: gamesToIdle,
        }, null, 2));
        return;
    }
    if (req.url === '/resume' && req.method === 'POST') {
        kickedByUser = false;
        isPaused = false;
        isBlocked = false;
        if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
        if (!loggedIn) { reconnectDelay = 5000; client.logOn(loginOptions); }
        else { startIdling(); }
        res.end(JSON.stringify({ ok: true, message: 'Переподключаюсь...' }));
        return;
    }
    if (req.url === '/pause' && req.method === 'POST') {
        isPaused = true;
        if (loggedIn) client.gamesPlayed([]);
        res.end(JSON.stringify({ ok: true, message: 'Пауза' }));
        return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
});

httpServer.listen(PORT, () => {
    log('HTTP сервер на порту ' + PORT + ' | /status /resume /pause /healthz');
});

function startIdling() {
    if (isPaused || isBlocked) {
        log(isPaused ? 'На паузе. POST /resume чтобы возобновить.' : 'Ты играешь на ПК — жду...');
        if (isBlocked) scheduleRetryIdle();
        return;
    }
    if (retryIdleTimeout) { clearTimeout(retryIdleTimeout); retryIdleTimeout = null; }
    client.gamesPlayed(gamesToIdle);
    log('Накручиваю: ' + gamesToIdle.join(', '));
}

function scheduleRetryIdle() {
    if (retryIdleTimeout) return;
    retryIdleTimeout = setTimeout(() => {
        retryIdleTimeout = null;
        if (!isBlocked && !isPaused) return;
        isBlocked = false;
        startIdling();
    }, 5 * 60 * 1000);
}

function scheduleReconnect() {
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    if (kickedByUser) {
        log('Жду ' + KICKED_HOURS + ' ч. Или POST /resume для немедленного реконнекта.');
        kickedAt = new Date();
        reconnectTimeout = setTimeout(() => {
            reconnectTimeout = null;
            if (!kickedByUser) return;
            kickedByUser = false;
            reconnectDelay = 5000;
            client.logOn(loginOptions);
        }, KICKED_RECONNECT_DELAY);
        return;
    }
    log('Переподключусь через ' + reconnectDelay / 1000 + 'с');
    reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
        client.logOn(loginOptions);
    }, reconnectDelay);
}

log('Подключаюсь к Steam...');
client.logOn(loginOptions);

let guardActive = false;
client.on('steamGuard', (domain, callback) => {
    if (!process.stdin.isTTY) {
        log('[ОШИБКА] Нужен Steam Guard — запусти локально, получи SSFN_DATA и задай через: fly secrets set SSFN_DATA=...');
        process.exit(1);
    }
    if (guardActive) return;
    guardActive = true;
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const prompt = domain
        ? '\nКод из письма на ' + domain + ': '
        : '\n  Телефон: Steam → Подтвердить вход → Enter\n  Или введи код: ';
    rl.question(prompt, (code) => { rl.close(); guardActive = false; callback(code.trim()); });
});

client.on('loginKey', (key) => {
    const data = { loginKey: key, machineName: 'steam-idle' };
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(ssfnPath, JSON.stringify(data));
    } catch (e) {
        log('[WARN] Не удалось сохранить ключ: ' + e.message);
    }
    loginOptions.loginKey = key;
    loginOptions.machineName = 'steam-idle';
    delete loginOptions.password;
});

client.on('loggedOn', () => {
    if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
    reconnectDelay = 5000;
    kickedByUser = false;
    kickedAt = null;
    loggedIn = true;
    log('Залогинился!');
    startIdling();
});

client.on('playingState', (blocked, playingApp) => {
    if (blocked && !isBlocked) {
        log('Ты играешь (appid=' + playingApp + ') — накрутка на паузе');
        isBlocked = true;
        client.gamesPlayed([]);
    } else if (!blocked && isBlocked) {
        log('Ты закрыл игру — возобновляю');
        isBlocked = false;
        if (retryIdleTimeout) { clearTimeout(retryIdleTimeout); retryIdleTimeout = null; }
        startIdling();
    }
});

client.on('error', (err) => {
    loggedIn = false;
    log('Ошибка: ' + err.message + ' (eresult=' + err.eresult + ')');

    if (err.eresult === SteamUser.EResult.LoggedInElsewhere) {
        kickedByUser = true;
        isBlocked = true;
        log('Ты зашёл в Steam на ПК. Уступаю на ' + KICKED_HOURS + ' ч. POST /resume чтобы не ждать.');
    }

    // Протухший / невалидный ключ — пробуем паролем
    const isExpiredKey =
        err.eresult === SteamUser.EResult.InvalidPassword ||
        err.eresult === SteamUser.EResult.AccessDenied ||
        err.eresult === SteamUser.EResult.InvalidSignature || // eresult=121
        err.eresult === 121; // страховка если константа не найдена

    if (isExpiredKey && loginOptions.loginKey) {
        log('loginKey невалиден (eresult=' + err.eresult + ') — пробую войти по паролю');
        delete loginOptions.loginKey;
        delete loginOptions.machineName;
        loginOptions.password = savedPassword;
        if (fs.existsSync(ssfnPath)) {
            try { fs.unlinkSync(ssfnPath); } catch(e) {}
        }
    }

    scheduleReconnect();
});

client.on('loggedOff', () => { loggedIn = false; log('Вышел'); scheduleReconnect(); });
client.on('disconnected', () => { loggedIn = false; log('Соединение разорвано'); scheduleReconnect(); });

function shutdown() {
    log('Завершаю...');
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    if (retryIdleTimeout) clearTimeout(retryIdleTimeout);
    httpServer.close();
    client.logOff();
    setTimeout(() => process.exit(0), 1500);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
