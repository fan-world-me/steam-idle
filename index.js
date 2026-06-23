const SteamUser = require('steam-user');
const fs = require('fs');
const path = require('path');
const http = require('http');

// На Fly.io храним данные на volume /data, локально — рядом со скриптом
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

// Когда нас кикнул живой пользователь — ждём столько перед автоматическим реконнектом
// Можно переопределить через KICKED_RECONNECT_HOURS (по умолчанию 4 часа)
const KICKED_HOURS = parseFloat(process.env.KICKED_RECONNECT_HOURS || '4');
const KICKED_RECONNECT_DELAY = KICKED_HOURS * 60 * 60 * 1000;

// ---- Загружаем сохранённый loginKey ----
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
    console.error('[ОШИБКА] Нет данных для входа. Укажи STEAM_ACCOUNT + STEAM_PASSWORD или подложи ssfn.json');
    process.exit(1);
}

// ---- Состояние ----
const client = new SteamUser();
let reconnectTimeout = null;
let retryIdleTimeout = null;
let isBlocked = false;          // ты сейчас играешь на ПК
let isPaused = false;           // ручная пауза через /pause
let kickedByUser = false;       // нас кикнул живой пользователь
let reconnectDelay = 5000;
const MAX_RECONNECT_DELAY = 60000;
let loggedIn = false;
let kickedAt = null;

function log(msg) {
    const time = new Date().toLocaleTimeString('ru-RU');
    console.log('[' + time + '] ' + msg);
}

// ---- HTTP-сервер для управления и healthcheck ----
const PORT = process.env.PORT || 3000;
const httpServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.url === '/healthz') {
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    if (req.url === '/status') {
        const status = {
            loggedIn,
            isBlocked,
            isPaused,
            kickedByUser,
            kickedAt: kickedAt ? kickedAt.toISOString() : null,
            reconnectsIn: reconnectTimeout
                ? 'pending'
                : (kickedByUser ? 'waiting for /resume or ' + KICKED_HOURS + 'h timeout' : 'not scheduled'),
            games: gamesToIdle,
        };
        res.end(JSON.stringify(status, null, 2));
        return;
    }

    if (req.url === '/resume' && req.method === 'POST') {
        if (kickedByUser || isPaused) {
            log('[HTTP] /resume — вручную возобновляю подключение');
            kickedByUser = false;
            isPaused = false;
            isBlocked = false;
            if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
            if (!loggedIn) {
                reconnectDelay = 5000;
                client.logOn(loginOptions);
            } else {
                startIdling();
            }
            res.end(JSON.stringify({ ok: true, message: 'Переподключаюсь...' }));
        } else {
            res.end(JSON.stringify({ ok: true, message: 'Уже работаю' }));
        }
        return;
    }

    if (req.url === '/pause' && req.method === 'POST') {
        log('[HTTP] /pause — ручная пауза накрутки');
        isPaused = true;
        if (loggedIn) {
            client.gamesPlayed([]);
            log('Накрутка остановлена вручную');
        }
        res.end(JSON.stringify({ ok: true, message: 'Пауза' }));
        return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
});

httpServer.listen(PORT, () => {
    log('HTTP сервер запущен на порту ' + PORT);
    log('  GET  /status  — текущее состояние');
    log('  POST /resume  — немедленно переподключиться');
    log('  POST /pause   — остановить накрутку');
});

// ---- Логика накрутки ----
function startIdling() {
    if (isPaused) {
        log('Накрутка на ручной паузе. Отправь POST /resume чтобы возобновить.');
        return;
    }
    if (isBlocked) {
        log('Ты сейчас играешь на ПК — накрутка приостановлена, жду...');
        scheduleRetryIdle();
        return;
    }
    if (retryIdleTimeout) { clearTimeout(retryIdleTimeout); retryIdleTimeout = null; }
    client.gamesPlayed(gamesToIdle);
    log('Накручиваю часы: ' + gamesToIdle.join(', '));
}

function scheduleRetryIdle() {
    if (retryIdleTimeout) return;
    retryIdleTimeout = setTimeout(() => {
        retryIdleTimeout = null;
        if (!isBlocked && !isPaused) return;
        log('Повторная попытка накрутки...');
        isBlocked = false;
        startIdling();
    }, 5 * 60 * 1000);
}

function scheduleReconnect() {
    if (reconnectTimeout) clearTimeout(reconnectTimeout);

    if (kickedByUser) {
        // Нас кикнул реальный пользователь — ждём долго чтобы не мешать
        log('Буду ждать ' + KICKED_HOURS + ' ч перед реконнектом. Или отправь POST /resume чтобы не ждать.');
        kickedAt = new Date();
        reconnectTimeout = setTimeout(() => {
            reconnectTimeout = null;
            if (kickedByUser) {
                log('Прошло ' + KICKED_HOURS + ' ч — пробую переподключиться...');
                kickedByUser = false;
                reconnectDelay = 5000;
                client.logOn(loginOptions);
            }
        }, KICKED_RECONNECT_DELAY);
        return;
    }

    const delay = reconnectDelay;
    log('Переподключусь через ' + delay / 1000 + 'с');
    reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
        log('Переподключаюсь...');
        client.logOn(loginOptions);
    }, delay);
}

// ---- Steam события ----
log('Подключаюсь к Steam...');
client.logOn(loginOptions);

let guardActive = false;
client.on('steamGuard', (domain, callback) => {
    if (!process.stdin.isTTY) {
        log('[ОШИБКА] Нужен Steam Guard, но бот запущен на сервере без терминала.');
        log('Сначала запусти локально: node index.js');
        log('Введи код, дождись "Ключ входа сохранён", потом задеплой.');
        process.exit(1);
    }
    if (guardActive) { return; }
    guardActive = true;

    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    let prompt;
    if (domain) {
        prompt = '\nВведи код из письма на ' + domain + ': ';
    } else {
        prompt = '\n  Телефон: открой Steam → нажми "Подтвердить вход" → нажми Enter здесь\n  Или введи код Steam Guard: ';
    }

    rl.question(prompt, (code) => {
        rl.close();
        guardActive = false;
        callback(code.trim());
    });
});

client.on('loginKey', (key) => {
    const data = { loginKey: key, machineName: 'steam-idle' };
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(ssfnPath, JSON.stringify(data));
        log('Ключ входа сохранён в ' + ssfnPath);
    } catch (e) {
        log('[WARN] Не удалось сохранить ключ: ' + e.message);
    }
    loginOptions.loginKey = key;
    loginOptions.machineName = 'steam-idle';
    delete loginOptions.password;

    // Печатаем base64 для копирования в SSFN_DATA если нужно
    const b64 = Buffer.from(JSON.stringify(data)).toString('base64');
    log('SSFN_DATA для env (если нужно): ' + b64);
});

client.on('loggedOn', () => {
    if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
    reconnectDelay = 5000;
    kickedByUser = false;
    kickedAt = null;
    loggedIn = true;
    log('Залогинился успешно!');
    startIdling();
});

client.on('playingState', (blocked, playingApp) => {
    if (blocked && !isBlocked) {
        log('Ты играешь на своём ПК (appid=' + playingApp + ') — накрутка приостановлена');
        isBlocked = true;
        client.gamesPlayed([]);
    } else if (!blocked && isBlocked) {
        log('Ты закрыл игру на ПК — возобновляю накрутку');
        isBlocked = false;
        if (retryIdleTimeout) { clearTimeout(retryIdleTimeout); retryIdleTimeout = null; }
        startIdling();
    }
});

client.on('error', (err) => {
    loggedIn = false;
    log('Ошибка: ' + err.message + ' (eresult=' + err.eresult + ')');

    if (err.eresult === SteamUser.EResult.LoggedInElsewhere) {
        // Нас кикнул живой пользователь — долго не лезем
        kickedByUser = true;
        isBlocked = true;
        log('Ты зашёл в Steam на своём ПК. Уступаю сессию на ' + KICKED_HOURS + ' ч.');
        log('Когда закончишь — отправь POST /resume чтобы возобновить без ожидания.');
    }

    const isExpiredKey =
        err.eresult === SteamUser.EResult.InvalidPassword ||
        err.eresult === SteamUser.EResult.AccessDenied;

    if (isExpiredKey && loginOptions.loginKey) {
        log('loginKey протух — пробую войти по паролю');
        delete loginOptions.loginKey;
        delete loginOptions.machineName;
        loginOptions.password = savedPassword;
        if (fs.existsSync(ssfnPath)) fs.unlinkSync(ssfnPath);
    }

    scheduleReconnect();
});

client.on('loggedOff', () => {
    loggedIn = false;
    log('Вышел из Steam');
    scheduleReconnect();
});

client.on('disconnected', () => {
    loggedIn = false;
    log('Соединение разорвано');
    scheduleReconnect();
});

function shutdown() {
    log('Завершаю работу...');
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    if (retryIdleTimeout) clearTimeout(retryIdleTimeout);
    httpServer.close();
    client.logOff();
    setTimeout(() => process.exit(0), 1500);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
