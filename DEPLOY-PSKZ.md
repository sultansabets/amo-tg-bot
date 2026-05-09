# Инструкция: деплой `amo-tg-bot` на VPS от ps.kz

Пошаговый чек-лист от заказа сервера до работающего бота. Время от начала до конца — ~30–40 минут.

---

## 0. Что нужно подготовить заранее (до VPS)

Соберите эти данные в текстовый файл, чтобы потом просто скопировать в `.env`:

| Что | Где взять |
|---|---|
| **Telegram Bot Token** | [@BotFather](https://t.me/BotFather) → `/newbot` → имя → username → выдаст токен `123456:ABC...` |
| **AMO_DOMAIN** | Поддомен вашей amoCRM, например `mycompany.amocrm.ru` (без `https://`) |
| **AMO_CLIENT_ID** | amoCRM → Настройки → Интеграции → Создать интеграцию → ID интеграции |
| **AMO_CLIENT_SECRET** | Там же → Секретный ключ |
| **AMO_REDIRECT_URI** | `http://IP_VPS:3000/amo/oauth` (IP узнаете после заказа VPS — пока оставьте placeholder) |
| **WEBHOOK_SECRET** | Любая длинная случайная строка, например `openssl rand -hex 16` или придумайте сами |
| **amoCRM user_id менеджеров** | amoCRM → Настройки → Пользователи → клик по человеку → ID в URL |
| **IGNORED_STAGE_IDS** | ID этапов «Успешно» и «Закрыто/неуспешно» в amoCRM (стандартно `142,143`, но проверьте) |

---

## 1. Заказать VPS на ps.kz

1. Зайти на **[ps.kz/vps](https://ps.kz/vps)** → выбрать тариф. Для бота хватит **самого младшего** (1 vCPU, 1 ГБ RAM, 10–20 ГБ диска).
2. ОС: **Ubuntu 22.04 LTS** (или 24.04 LTS).
3. Регион — Алматы (ближе к amoCRM по сети, плюс совпадение TZ).
4. Оплатить, дождаться письма с **IP** и **root-паролем** (обычно 5–15 минут).

> На некоторых тарифах ps.kz даёт KVM-консоль через личный кабинет — пригодится, если потеряете SSH-доступ.

---

## 2. Первый вход и базовая настройка сервера

С локального компьютера:

```bash
ssh root@IP_ВАШЕГО_VPS
# вводите пароль из письма
```

Внутри сервера:

```bash
# 1. Обновить систему
apt update && apt upgrade -y

# 2. Создать пользователя для бота (не работаем под root)
adduser bot                  # придумайте пароль
usermod -aG sudo bot

# 3. Перенести SSH-ключи (опционально, но желательно)
mkdir -p /home/bot/.ssh
cp ~/.ssh/authorized_keys /home/bot/.ssh/ 2>/dev/null || true
chown -R bot:bot /home/bot/.ssh
chmod 700 /home/bot/.ssh
[ -f /home/bot/.ssh/authorized_keys ] && chmod 600 /home/bot/.ssh/authorized_keys

# 4. Настроить firewall
ufw allow OpenSSH
ufw allow 3000/tcp           # порт бота для вебхуков и OAuth
ufw --force enable
ufw status

# 5. Поставить Node.js 20 LTS, git, build-tools
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs git build-essential python3

# 6. Поставить PM2 глобально
npm install -g pm2

# 7. Установить часовой пояс (логи будут читаться приятнее)
timedatectl set-timezone Asia/Almaty
```

Проверить версии:

```bash
node -v        # должно быть v20.x
npm -v
pm2 -v
```

Выйти из root и зайти под `bot`:

```bash
exit
ssh bot@IP_ВАШЕГО_VPS
```

---

## 3. Залить код на сервер

### Вариант A — через GitHub (рекомендую)

На локальной машине:

```bash
cd "/Users/reformatortech/Downloads/tg bot nirify"
git init
git add .
git commit -m "init amo-tg-bot"
# создайте приватный репозиторий на github.com, потом:
git remote add origin git@github.com:ВАШ_ЛОГИН/amo-tg-bot.git
git push -u origin main
```

На сервере:

```bash
cd ~
git clone https://github.com/ВАШ_ЛОГИН/amo-tg-bot.git
cd amo-tg-bot
```

Если репо приватный — либо сделайте его публичным временно, либо настройте deploy key / personal access token.

### Вариант B — через `scp` (без git)

С локальной машины:

```bash
cd "/Users/reformatortech/Downloads"
# создаём архив без node_modules
tar --exclude='tg bot nirify/node_modules' --exclude='tg bot nirify/data' \
    -czf amo-tg-bot.tar.gz "tg bot nirify"
scp amo-tg-bot.tar.gz bot@IP_VPS:~/
```

На сервере:

```bash
cd ~
tar -xzf amo-tg-bot.tar.gz
mv "tg bot nirify" amo-tg-bot
cd amo-tg-bot
```

---

## 4. Установить зависимости и настроить `.env`

```bash
cd ~/amo-tg-bot
npm install --omit=dev

cp .env.example .env
nano .env
```

Заполните:

```env
TELEGRAM_BOT_TOKEN=123456:ABC...
AMO_DOMAIN=mycompany.amocrm.ru
AMO_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AMO_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
AMO_REDIRECT_URI=http://IP_ВАШЕГО_VPS:3000/amo/oauth
AMO_ACCESS_TOKEN=
AMO_REFRESH_TOKEN=
PORT=3000
WEBHOOK_SECRET=придумайте_длинную_строку
STALE_LEAD_MINUTES=60
UNANSWERED_MESSAGE_MINUTES=15
CRON_INTERVAL_MINUTES=10
NOTIFICATION_COOLDOWN_MINUTES=60
MONITORED_STAGE_IDS=
IGNORED_STAGE_IDS=142,143
```

Сохранить: `Ctrl+O`, `Enter`, `Ctrl+X`.

---

## 5. Запустить под PM2

```bash
cd ~/amo-tg-bot
pm2 start ecosystem.config.js
pm2 logs amo-tg-bot --lines 30
```

Должны увидеть:

```
✅ HTTP server listening on :3000
✅ Telegram bot started (long polling)
✅ Scheduler started: */10 * * * * (Asia/Almaty)
```

Включить автозапуск при ребуте сервера:

```bash
pm2 save
pm2 startup
# выполните команду, которую PM2 напечатал (она настроит systemd)
```

---

## 6. Настройки в amoCRM

### 6.1. Интеграция (если ещё не создавали)

amoCRM → **Настройки → Интеграции → Создать интеграцию → Внешняя интеграция**:

- **Название**: `tg-notifier` (любое)
- **Ссылка для перенаправления (Redirect URI)**: ровно `http://IP_VPS:3000/amo/oauth`
- **Права доступа**: Сделки, Контакты, Примечания, Задачи (на чтение достаточно)
- Сохранить → скопировать **ID интеграции** и **Секретный ключ** в `.env`, перезапустить бота:
  ```bash
  pm2 restart amo-tg-bot
  ```

### 6.2. Получить первый OAuth-токен

1. Откройте интеграцию в amoCRM → вкладка **Ключи и доступы** → нажмите **Установить**.
2. Браузер сделает редирект на `http://IP_VPS:3000/amo/oauth?code=...` — бот обменяет код на токены и покажет: **✅ Токен получен**.
3. В логах PM2 появится `✅ amoCRM OAuth: tokens stored`.

С этого момента бот сам обновляет токены (буфер 60 секунд + повтор при 401).

### 6.3. Подписать вебхуки

В той же интеграции → вкладка **Вебхуки → Добавить**:

- **URL**: `http://IP_VPS:3000/amo/webhook/ВАШ_WEBHOOK_SECRET`
- События:
  - **Сделки**: добавление, изменение, смена этапа, удаление
  - **Примечания**: добавление

Сохранить.

---

## 7. Привязать менеджеров в Telegram

Каждый менеджер делает:

1. Найти бота в Telegram по username → `/start`
2. Бот ответит `Ваш chat_id: 12345678`
3. Узнать свой `amo_user_id` (см. таблицу в начале)
4. Отправить `/addme 1234567` (свой amoCRM user_id)
5. Проверить: `/whoami`

Вы как админ можете проверить всех: `/list` и пороги: `/status`.

Тестовое уведомление по конкретному лиду:

```
/test 56789
```

(`56789` — реальный ID лида в amoCRM).

---

## 8. Что ещё имеет смысл добавить

Это **опциональные** улучшения. Бот работает и без них.

### 8.1. HTTPS через домен и Caddy (если есть домен)

Если у вас есть домен (через ps.kz или Cloudflare), направьте A-запись `bot.вашдомен.kz` на IP VPS, поставьте **Caddy** — он автоматически выпустит TLS-сертификат:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```
bot.вашдомен.kz {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl reload caddy
```

После этого:
- Закрыть порт 3000 наружу: `sudo ufw delete allow 3000/tcp`, открыть 80 и 443
- В `.env` поменять `AMO_REDIRECT_URI=https://bot.вашдомен.kz/amo/oauth`
- В amoCRM в интеграции обновить Redirect URI и URL вебхука на HTTPS
- `pm2 restart amo-tg-bot`

### 8.2. Бэкап SQLite

Раз в сутки в 4:00 копировать БД:

```bash
crontab -e
```

Добавить:

```
0 4 * * * cp ~/amo-tg-bot/data/bot.sqlite ~/amo-tg-bot/data/bot.sqlite.bak.$(date +\%Y\%m\%d) && find ~/amo-tg-bot/data -name 'bot.sqlite.bak.*' -mtime +14 -delete
```

### 8.3. Защита SSH

```bash
sudo nano /etc/ssh/sshd_config
# PermitRootLogin no
# PasswordAuthentication no   # только если ssh-ключи уже работают!
sudo systemctl restart sshd
```

### 8.4. Мониторинг падений

PM2 рестартит бота автоматически. Если хочется уведомления в Telegram при падении — поставьте `pm2 install pm2-telegram-notifier` или просто проверьте `pm2 status` через cron.

### 8.5. Алматы-таймзона на сервере

Уже сделана в шаге 2 (`timedatectl set-timezone Asia/Almaty`). Сам бот всё равно форматирует даты в `Asia/Almaty` независимо от системного TZ.

---

## 9. Обновление кода в будущем

```bash
ssh bot@IP_VPS
cd ~/amo-tg-bot
git pull                       # или scp нового архива
npm install --omit=dev
pm2 restart amo-tg-bot
pm2 logs amo-tg-bot --lines 50
```

---

## 10. Чек-лист «всё работает»

- [ ] `pm2 status` показывает `amo-tg-bot` со статусом `online`
- [ ] `pm2 logs amo-tg-bot` без `❌`
- [ ] В Telegram бот отвечает на `/start`
- [ ] `/status` возвращает корректные пороги
- [ ] OAuth прошёл (`✅ amoCRM OAuth: tokens stored` в логах)
- [ ] В amoCRM создан тестовый лид → в логах `📨 Lead ... upserted into stage_tracking`
- [ ] `/test <реальный_lead_id>` присылает красивое уведомление в чат
- [ ] Через `STALE_LEAD_MINUTES + CRON_INTERVAL_MINUTES` минут на застрявшем лиде приходит автоматическое уведомление

Если всё — ⏰ ✅
