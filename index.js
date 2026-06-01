const SteamUser = require('steam-user');
const fs = require('fs');

const client = new SteamUser();
let reconnectTimeout;

const loginOptions = JSON.parse(fs.readFileSync('steam-auth.json', 'utf8'));

if (fs.existsSync('ssfn.json')) {
    const saved = JSON.parse(fs.readFileSync('ssfn.json', 'utf8'));
    loginOptions.machineName = saved.machineName;
    loginOptions.loginKey = saved.loginKey;
    delete loginOptions.password;
}

function connect() {
    console.log('[' + new Date().toLocaleTimeString() + '] Подключаюсь к Steam...');
    client.logOn(loginOptions);
}

connect();

client.on('steamGuard', (domain, callback) => {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Введи код из Steam Guard: ', (code) => {
        rl.close();
        callback(code);
    });
});

client.on('loginKey', (key) => {
    fs.writeFileSync('ssfn.json', JSON.stringify({ loginKey: key, machineName: 'steam-idle' }));
});

client.on('loggedOn', () => {
    console.log('[' + new Date().toLocaleTimeString() + '] Залогинился в Steam!');
    client.gamesPlayed([570, 730]); // Dota 2 + CS2
    console.log('[' + new Date().toLocaleTimeString() + '] Dota 2 и CS2 запущены, часы идут...');
    
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
});

client.on('error', (err) => {
    console.error('[' + new Date().toLocaleTimeString() + '] Ошибка:', err.message);
    
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(() => {
        console.log('[' + new Date().toLocaleTimeString() + '] Переподключаюсь...');
        connect();
    }, 5000);
});

client.on('loggedOff', () => {
    console.log('[' + new Date().toLocaleTimeString() + '] Отключился');
    
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(() => {
        console.log('[' + new Date().toLocaleTimeString() + '] Переподключаюсь...');
        connect();
    }, 5000);
});

client.on('disconnected', () => {
    console.log('[' + new Date().toLocaleTimeString() + '] Соединение разорвано');
    
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(() => {
        console.log('[' + new Date().toLocaleTimeString() + '] Переподключаюсь...');
        connect();
    }, 5000);
});
