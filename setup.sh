#!/usr/bin/env bash
# One-shot installer for amo-tg-bot on a fresh Ubuntu 22.04/24.04 VPS.
# Run as root (or via sudo) from the project directory:
#   sudo bash setup.sh

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}==>${NC} $1"; }
warn() { echo -e "${YELLOW}!! ${NC} $1"; }
fail() { echo -e "${RED}xx${NC} $1"; exit 1; }

# ---------- 0. checks ----------
if [[ $EUID -ne 0 ]]; then fail "Запустите через sudo: sudo bash setup.sh"; fi

PROJECT_DIR="$(pwd)"
if [[ ! -f "$PROJECT_DIR/package.json" ]]; then
  fail "Запустите скрипт из папки с package.json (корень проекта amo-tg-bot)."
fi

# ---------- 1. system packages ----------
log "Обновляю систему…"
apt-get update -y
apt-get upgrade -y -o Dpkg::Options::=--force-confold

log "Ставлю Node.js 20, git, build-essential, sqlite3…"
if ! command -v node >/dev/null || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
fi
apt-get install -y nodejs git build-essential python3 sqlite3 ufw

log "Ставлю PM2 глобально…"
npm install -g pm2 >/dev/null

log "Включаю Asia/Almaty…"
timedatectl set-timezone Asia/Almaty || true

# ---------- 2. user bot ----------
if ! id -u bot >/dev/null 2>&1; then
  log "Создаю пользователя bot…"
  adduser --disabled-password --gecos "" bot
  usermod -aG sudo bot
fi

INSTALL_DIR="/home/bot/amo-tg-bot"
log "Копирую проект в $INSTALL_DIR…"
mkdir -p "$INSTALL_DIR"
RSYNC_EXCLUDES=(--exclude node_modules --exclude data --exclude logs)
# Если .env УЖЕ лежит в исходнике — скопируем его. Если нет — не трогаем существующий в INSTALL_DIR.
if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  RSYNC_EXCLUDES+=(--exclude '.env')
fi
rsync -a --delete "${RSYNC_EXCLUDES[@]}" "$PROJECT_DIR"/ "$INSTALL_DIR"/
chown -R bot:bot "$INSTALL_DIR"

# ---------- 3. firewall ----------
log "Настраиваю firewall…"
ufw allow OpenSSH >/dev/null
ufw allow 3000/tcp >/dev/null
echo "y" | ufw enable >/dev/null || true

# ---------- 4. .env ----------
if [[ -f "$INSTALL_DIR/.env" ]]; then
  log ".env уже существует — пропускаю интерактивный ввод"
  chown bot:bot "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env"

  # вытащим хост/порт/секрет для итогового сообщения
  SERVER_HOST="$(grep -E '^AMO_REDIRECT_URI=' "$INSTALL_DIR/.env" | sed -E 's|.*//([^:/]+).*|\1|')"
  PORT_VAL="$(grep -E '^PORT=' "$INSTALL_DIR/.env" | cut -d= -f2)"
  WH_SECRET="$(grep -E '^WEBHOOK_SECRET=' "$INSTALL_DIR/.env" | cut -d= -f2)"
  REDIRECT_URI="$(grep -E '^AMO_REDIRECT_URI=' "$INSTALL_DIR/.env" | cut -d= -f2-)"
else
  echo
  log "Заполнение .env. Все значения можно изменить позже в $INSTALL_DIR/.env"
  echo

  ask() {
    local prompt="$1" default="$2" varname="$3"
    local val
    if [[ -n "$default" ]]; then
      read -r -p "$prompt [$default]: " val
      val="${val:-$default}"
    else
      while [[ -z "$val" ]]; do read -r -p "$prompt: " val; done
    fi
    printf -v "$varname" '%s' "$val"
  }

  PUBLIC_IP="$(curl -s ifconfig.me || echo)"

  ask "TELEGRAM_BOT_TOKEN (от @BotFather)" "" TG_TOKEN
  ask "AMO_DOMAIN (например mycompany.amocrm.ru)" "" AMO_DOMAIN_VAL
  ask "AMO_CLIENT_ID (ID интеграции в amoCRM)" "" AMO_CLIENT_ID
  ask "AMO_CLIENT_SECRET (секретный ключ интеграции)" "" AMO_CLIENT_SECRET
  ask "Публичный IP/домен сервера" "$PUBLIC_IP" SERVER_HOST
  ask "Порт" "3000" PORT_VAL
  ask "WEBHOOK_SECRET (любая длинная строка)" "$(openssl rand -hex 16)" WH_SECRET
  ask "STALE_LEAD_MINUTES" "60" STALE
  ask "UNANSWERED_MESSAGE_MINUTES" "15" UNANS
  ask "CRON_INTERVAL_MINUTES" "10" CRON
  ask "NOTIFICATION_COOLDOWN_MINUTES" "60" COOL
  ask "IGNORED_STAGE_IDS (через запятую)" "142,143" IGNORED
  ask "MONITORED_STAGE_IDS (пусто = все)" "" MONITORED

  REDIRECT_URI="http://${SERVER_HOST}:${PORT_VAL}/amo/oauth"

  cat > "$INSTALL_DIR/.env" <<EOF
TELEGRAM_BOT_TOKEN=$TG_TOKEN

AMO_DOMAIN=$AMO_DOMAIN_VAL
AMO_CLIENT_ID=$AMO_CLIENT_ID
AMO_CLIENT_SECRET=$AMO_CLIENT_SECRET
AMO_REDIRECT_URI=$REDIRECT_URI
AMO_ACCESS_TOKEN=
AMO_REFRESH_TOKEN=

PORT=$PORT_VAL
WEBHOOK_SECRET=$WH_SECRET

STALE_LEAD_MINUTES=$STALE
UNANSWERED_MESSAGE_MINUTES=$UNANS
CRON_INTERVAL_MINUTES=$CRON
NOTIFICATION_COOLDOWN_MINUTES=$COOL

MONITORED_STAGE_IDS=$MONITORED
IGNORED_STAGE_IDS=$IGNORED
EOF
  chown bot:bot "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env"
fi

# ---------- 5. npm install + pm2 ----------
log "Устанавливаю зависимости (npm install)…"
sudo -u bot bash -c "cd $INSTALL_DIR && npm install --omit=dev"

log "Запускаю PM2…"
sudo -u bot bash -c "cd $INSTALL_DIR && pm2 start ecosystem.config.js && pm2 save"

log "Включаю автозапуск PM2 при ребуте…"
env PATH=$PATH:/usr/bin pm2 startup systemd -u bot --hp /home/bot >/dev/null
systemctl enable pm2-bot >/dev/null 2>&1 || true

# ---------- 6. summary ----------
echo
echo -e "${GREEN}=================================================${NC}"
echo -e "${GREEN} ✅ Установка завершена${NC}"
echo -e "${GREEN}=================================================${NC}"
echo
echo "📂  Папка проекта:    $INSTALL_DIR"
echo "📄  .env:             $INSTALL_DIR/.env"
echo "📒  Логи:             sudo -u bot pm2 logs amo-tg-bot"
echo
echo "🌐  Webhook URL для amoCRM:"
echo "    http://${SERVER_HOST}:${PORT_VAL}/amo/webhook/${WH_SECRET}"
echo
echo "🔑  Redirect URI для amoCRM-интеграции:"
echo "    ${REDIRECT_URI}"
echo
echo "Дальше в amoCRM:"
echo "  1) Настройки → Интеграции → ваша интеграция → Redirect URI = ${REDIRECT_URI}"
echo "  2) Вкладка «Ключи и доступы» → Установить — токены придут в бота автоматически"
echo "  3) Вебхуки → добавить URL выше → события: Сделки (add/update/status/delete) + Примечания (add)"
echo
echo "В Telegram:"
echo "  /start у бота → /addme <amo_user_id>"
echo
