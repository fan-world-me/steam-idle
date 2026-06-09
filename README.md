# steam-idle

Накрутчик часов Steam. Автоматически **паузит** когда ты сам играешь, возобновляет когда закрываешь игру.

## Быстрый старт (локально)

1. Скопируй `steam-auth.example.json` → `steam-auth.json` и заполни:
   ```json
   {
     "accountName": "логин",
     "password": "пароль",
     "games": [570, 730]
   }
   ```
2. `npm install`
3. `npm start`  
   При первом запуске введёшь код Steam Guard — после этого он больше не нужен.

---

## Деплой на Fly.io (бесплатно, 24/7)

### 1. Установить flyctl
```bash
# macOS/Linux
curl -L https://fly.io/install.sh | sh

# Windows (PowerShell)
iwr https://fly.io/install.ps1 -useb | iex
```

### 2. Войти / зарегистрироваться
```bash
fly auth login
```

### 3. Первый запуск (один раз локально для Steam Guard)
```bash
npm install
npm start
# Введи код Steam Guard → нажми Ctrl+C после "Ключ входа сохранён"
```

### 4. Задеплоить

```bash
cd steam-idle
fly launch --name steam-idle --region fra --no-deploy
```

Задать секреты (вместо steam-auth.json на сервере):
```bash
fly secrets set STEAM_ACCOUNT=твой_логин STEAM_PASSWORD=твой_пароль
```

Загрузить `ssfn.json` (ключ Steam Guard) на сервер:
```bash
fly ssh console
# или через volume — см. ниже
```

Деплой:
```bash
fly deploy
```

### 5. Проверить что работает
```bash
fly logs
```

### Сохранение ssfn.json между деплоями (Volume)

Чтобы не вводить Steam Guard после каждого деплоя:
```bash
fly volumes create steam_data --region fra --size 1
```

В `fly.toml` добавить:
```toml
[mounts]
  source = "steam_data"
  destination = "/app/data"
```

И в `index.js` изменить путь к ssfn:
```js
const ssfnPath = path.join('/app/data', 'ssfn.json');
```

---

## Переменные окружения

| Переменная      | Описание                        |
|-----------------|---------------------------------|
| `STEAM_ACCOUNT` | Логин Steam                     |
| `STEAM_PASSWORD`| Пароль Steam                    |

Список игр задаётся в `steam-auth.json` → поле `"games"`.
