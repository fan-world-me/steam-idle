const SteamUser = require('steam-user');
const fs = require('fs');
const path = require('path');

const client = new SteamUser();
let reconnectTimeout = null;
let isBlocked = false;
let reconnectDelay = 5000;    // начинаем с 5 сек
const MAX_RECONNECT_DELAY = 60000; // не чаще раза в минуту при повторных ошибках

// Конфиг: читаем из steam-auth.json или переменных окружения
const configPath = path.join(__dirname, 'steam-auth.json');
let config = {};
if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

// Хранимы пароль отдельно — нужен как запасной если loginKey протухнет
const savedPassword = process.env.STEAM_PASSWORD || config.password;

const loginOptions = {
    accountName: process.env.STEAM_ACCOUNT || config.accountName,
    password: savedPassword,
};

// Список игр: из конфига, или дефолт Dota 2 + CS2
const gamesToIdle = config.games || [570, 730];

// Сохранённый ключ входа (чтобы не вводить Steam Guard каждый раз)
// На сервере (Fly.io) используем /app/data — персистентный volume
// Локально — рядом со скриптом
const dataDir = process.env.DATA_DIR ||
    (fs.existsSync('/app/data') ? '/app/data' : __dirname);
const ssfnPath = path.join(dataDir, 'ssfn.json');
if (fs.existsSync(ssfnPath)) {
    const saved = JSON.parse(fs.readFileSync(ssfnPath, 'utf8'));
    loginOptions.machineName = saved.machineName;
    loginOptions.loginKey = saved.loginKey;
    delete loginOptions.password; // loginKey заменяет пароль
}

// ФИКС: проверяем после загрузки ssfn.json — loginKey тоже считается валидными данными
if (!loginOptions.accountName || (!loginOptions.password && !loginOptions.loginKey)) {
    console.error('[ОШИБКА] Нет данных для входа. Укажи STEAM_ACCOUNT + STEAM_PASSWORD или подложи ssfn.json');
    process.exit(1);
}

function log(msg) {
    const time = new Date().toLocaleTimeString('ru-RU');
    console.log('[' + time + '] ' + msg);
}

function scheduleReconnect() {
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        log('Переподключаюсь... (задержка была ' + reconnectDelay / 1000 + 'с)');
        // Экспоненциальный backoff: увеличиваем задержку при повторных ошибках
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
        client.logOn(loginOptions);
    }, reconnectDelay);
}

function startIdling() {
    if (isBlocked) {
        log('Накрутка на паузе (ты сейчас играешь), жду...');
        return;
    }
    client.gamesPlayed(gamesToIdle);
    log('Накручиваю часы в играх: ' + gamesToIdle.join(', '));
}

// --- Подключение ---
log('Подключаюсь к Steam...');
client.logOn(loginOptions);

// Steam Guard — один промт за раз, предотвращаем дублирование
let guardActive = false;

client.on('steamGuard', (domain, callback) => {
    if (!process.stdin.isTTY) {
        log('[ОШИБКА] Нужен Steam Guard, но бот запущен на сервере без терминала.');
        log('Сначала запусти локально, введи код, дождись "Ключ входа сохранён", потом деплой.');
        process.exit(1);
    }

    // Steam может вызвать steamGuard несколько раз пока ждём ввод — игнорируем повторы
    if (guardActive) {
        log('Steam повторно запросил Guard — жди пока подтвердишь в приложении...');
        return;
    }

    guardActive = true;
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    let prompt;
    if (domain) {
        prompt = '\nВведи код из письма на ' + domain + ': ';
    } else {
        prompt = '\n  Если подтверждаешь через телефон:\n  1. Открой Steam на телефоне → нажми "Подтвердить вход"\n  2. После подтверждения нажми Enter здесь\n\n  Если вводишь код из Steam Guard: введи код и нажми Enter\n\n> ';
    }

    rl.question(prompt, (code) => {
        rl.close();
        guardActive = false;
        callback(code.trim());
    });
});

// Сохраняем ключ входа — после этого Steam Guard больше не нужен
client.on('loginKey', (key) => {
    const data = { loginKey: key, machineName: 'steam-idle' };
    fs.writeFileSync(ssfnPath, JSON.stringify(data));
    // Обновляем loginOptions чтобы реконнект тоже использовал новый ключ
    loginOptions.loginKey = key;
    loginOptions.machineName = 'steam-idle';
    delete loginOptions.password;
    log('Ключ входа сохранён — Steam Guard больше не нужен');
});

// ФИКС: сбрасываем таймер реконнекта и задержку при успешном входе
client.on('loggedOn', () => {
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }
    reconnectDelay = 5000; // сброс backoff после успешного входа
    log('Залогинился успешно!');
    startIdling();
});

// Срабатывает когда ты сам начинаешь/заканчиваешь играть на своём ПК
// Steam шлёт blocked=false при каждом входе — реагируем только на реальное изменение состояния
client.on('playingState', (blocked, playingApp) => {
    if (blocked && !isBlocked) {
        log('Ты играешь на своём ПК (appid=' + playingApp + ') — накрутка приостановлена');
        isBlocked = true;
        client.gamesPlayed([]); // снимаем чтобы не было конфликта и переподключений
    } else if (!blocked && isBlocked) {
        log('Ты закрыл игру на ПК — возобновляю накрутку');
        isBlocked = false;
        startIdling();
    }
    // blocked=false при входе и isBlocked=false → игнорируем (Steam шлёт это всегда при логине)
});

// ФИКС: если loginKey протухнул — восстанавливаем пароль и удаляем мёртвый ключ
client.on('error', (err) => {
    log('Ошибка: ' + err.message);

    const isExpiredKey =
        err.eresult === SteamUser.EResult.InvalidPassword ||
        err.eresult === SteamUser.EResult.AccessDenied;

    if (isExpiredKey && loginOptions.loginKey) {
        log('loginKey больше не действителен — пробую войти по паролю');
        delete loginOptions.loginKey;
        delete loginOptions.machineName;
        loginOptions.password = savedPassword;
        if (fs.existsSync(ssfnPath)) fs.unlinkSync(ssfnPath); // удаляем мёртвый ключ
    }

    scheduleReconnect();
});

client.on('loggedOff', () => {
    log('Вышел из Steam');
    scheduleReconnect();
});

client.on('disconnected', () => {
    log('Соединение разорвано');
    scheduleReconnect();
});

// Чистое завершение
function shutdown() {
    log('Завершаю работу...');
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    client.logOff();
    setTimeout(() => process.exit(0), 1500);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
