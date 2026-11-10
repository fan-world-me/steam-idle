[![Telegram](https://img.shields.io/badge/Telegram-@fan__world__me-2CA5E0?style=flat-square&logo=telegram)](https://t.me/fan_world_me)   [![Discord](https://img.shields.io/badge/Discord-fan__world__me-5865F2?style=flat-square&logo=discord)](https://discord.com/users/1040301536036786248)   [![GitHub](https://img.shields.io/badge/GitHub-fan--world--me-181717?style=flat-square&logo=github)](https://github.com/fan-world-me)   [![Portfolio](https://img.shields.io/badge/Portfolio-fan--world--me.github.io-00e5ff?style=flat-square&logo=githubpages&logoColor=white)](https://fan-world-me.github.io/)

# Steam Idle v2

Накручивает часы в Steam. Паузит когда ты сам заходишь в игру. Не мешает твоей сессии.

По умолчанию накручивает **Dota 2 (570)**, **CS2 (730)** и **Deadlock (1422450)**.

### 💭 Что изменилось по сравнению со старой версией

- 💾 **Сессия сохраняется на Fly.io** — `ssfn.json` хранится на volume `/data`, не сбрасывается при деплое
- 🛡️ **Не выбивает тебя** — когда ты заходишь в Steam, бот ждёт **4 часа** (раньше 5–10 минут) перед попыткой переподключиться
- 🎛️ **Ручное управление** — HTTP-эндпоинты `/resume` и `/pause`
- ❤️ **Healthcheck** — Fly.io проверяет, что бот живой

---

### 🧰 Tech Stack

![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![Steam](https://img.shields.io/badge/Steam-API-000000?style=flat-square&logo=steam&logoColor=white)
![Fly.io](https://img.shields.io/badge/Fly.io-deploy-8B5CF6?style=flat-square&logo=flydotio&logoColor=white)

---

### 🚀 Первый запуск (локально — нужен для Steam Guard)

```bash
npm install
node index.js
```

Введи Steam Guard код когда попросит. После сообщения **"Ключ входа сохранён"** — можно деплоить.

---

### ☁️ Деплой на Fly.io

**1. Создать volume для хранения сессии**

```bash
fly volumes create steam_data --region fra --size 1
```

**2. Задать переменные окружения**

```bash
fly secrets set STEAM_ACCOUNT=твой_логин
fly secrets set STEAM_PASSWORD=твой_пароль
```

Если хочешь накручивать другие игры (по умолчанию Dota 2 + CS2 + Deadlock):

```bash
fly secrets set STEAM_GAMES=570,730,1422450,440
```

**3. Задеплоить**

```bash
fly deploy
```

**4. Скопировать ssfn.json на volume после первого деплоя**

После первого деплоя (если уже запускал локально и есть `ssfn.json`):

```bash
fly ssh console
# внутри контейнера:
cp /app/ssfn.json /data/ssfn.json
exit
```

Или — скопируй строку **SSFN_DATA** из логов первого локального запуска и задай как секрет:

```bash
fly secrets set SSFN_DATA=<строка из логов>
```

---

### 🔌 HTTP-эндпоинты

| Метод | URL | Что делает |
|---|---|---|
| GET | `/status` | Текущее состояние бота |
| GET | `/healthz` | Healthcheck |
| POST | `/resume` | Немедленно переподключиться (после того как закончил играть) |
| POST | `/pause` | Остановить накрутку |

Пример:

```bash
# посмотреть состояние
curl https://steam-idle-yarik.fly.dev/status

# когда закончил играть — разбудить бота не ждя 4 часа
 curl -X POST https://steam-idle-yarik.fly.dev/resume
```

---

### 🌍 Переменные окружения

| Переменная | Описание | По умолчанию |
|---|---|---|
| `STEAM_ACCOUNT` | Логин Steam | — |
| `STEAM_PASSWORD` | Пароль Steam | — |
| `STEAM_GAMES` | AppID через запятую | `570,730,1422450` |
| `SSFN_DATA` | loginKey в base64 (альтернатива volume) | — |
| `KICKED_RECONNECT_HOURS` | Сколько часов ждать после кика | `4` |
| `DATA_DIR` | Где хранить ssfn.json | `/data` (Fly) / папка скрипта (локально) |
| `PORT` | Порт HTTP сервера | `3000` |

---

### 🛡️ Как работает защита от кика

```
[Ты заходишь в Steam]
        │
        ▼
[Бот получает LoggedInElsewhere]
        │
        ▼
[Бот ждёт 4 часа и не лезет обратно]
        │
        ▼
[POST /resume  или  истекло 4 часа]
        │
        ▼
[Бот переподключается и возобновляет накрутку]
```

---

Made with 🩵 in Ukraine 🇺🇦

[![Telegram](https://img.shields.io/badge/Telegram-@fan__world__me-2CA5E0?style=flat-square&logo=telegram)](https://t.me/fan_world_me)   [![Discord](https://img.shields.io/badge/Discord-fan__world__me-5865F2?style=flat-square&logo=discord)](https://discord.com/users/1040301536036786248)   [![Portfolio](https://img.shields.io/badge/Portfolio-fan--world--me.github.io-00e5ff?style=flat-square&logo=githubpages&logoColor=white)](https://fan-world-me.github.io/)
