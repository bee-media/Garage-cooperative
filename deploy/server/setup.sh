#!/usr/bin/env bash
# Первичная настройка чистого Debian 12/13 под ГСК «Родник». Запуск от root; повторный запуск безопасен
# (существующие пароли и /etc/gsk/api.env не перезаписываются).
#
#   sudo ./setup.sh --env test|prod \
#        --app-domain rodnik.example.ru --admin-domain admin.rodnik.example.ru \
#        --admin-phone 9001112233 --admin-email chairman@example.ru \
#        --deploy-pubkey "ssh-ed25519 AAAA… gitlab-ci" \
#        [--listen-addr 127.0.0.1] [--npm-ip 192.168.1.10] [--ssh-port 22] [--app-port 8081] [--admin-port 8082]
#
# Что делает: ставит Node.js 22, PostgreSQL 16, nginx, rsync, ufw, fail2ban; создаёт пользователей gsk (сервис)
# и gsk-deploy (деплой по ключу GitLab CI); базу и пароли; /etc/gsk/api.env; systemd-юниты; два внутренних
# сайта nginx (PWA на 8081, портал на 8082); ночной бэкап; брандмауэр.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Запустите от root: sudo $0 …" >&2; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ENV_NAME="" APP_DOMAIN="" ADMIN_DOMAIN="" ADMIN_PHONE="" ADMIN_EMAIL="" DEPLOY_PUBKEY=""
LISTEN_ADDR="127.0.0.1" NPM_IP="" SSH_PORT="22" APP_PORT=8081 ADMIN_PORT=8082
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift ;;
    --app-domain) APP_DOMAIN="$2"; shift ;;
    --admin-domain) ADMIN_DOMAIN="$2"; shift ;;
    --admin-phone) ADMIN_PHONE="$2"; shift ;;
    --admin-email) ADMIN_EMAIL="$2"; shift ;;
    --deploy-pubkey) DEPLOY_PUBKEY="$2"; shift ;;
    --listen-addr) LISTEN_ADDR="$2"; shift ;;
    --npm-ip) NPM_IP="$2"; shift ;;
    --ssh-port) SSH_PORT="$2"; shift ;;
    --app-port) APP_PORT="$2"; shift ;;
    --admin-port) ADMIN_PORT="$2"; shift ;;
    *) echo "Неизвестный аргумент: $1" >&2; exit 2 ;;
  esac
  shift
done

[[ "$APP_PORT" =~ ^[0-9]+$ && "$ADMIN_PORT" =~ ^[0-9]+$ && "$APP_PORT" != "$ADMIN_PORT" ]] || { echo "--app-port/--admin-port: разные числа" >&2; exit 2; }
[[ "$ENV_NAME" =~ ^(test|prod)$ ]] || { echo "--env: test или prod" >&2; exit 2; }
[[ -n "$APP_DOMAIN" && -n "$ADMIN_DOMAIN" && -n "$ADMIN_EMAIL" ]] || { echo "Нужны --app-domain, --admin-domain, --admin-email" >&2; exit 2; }
[[ "$ADMIN_PHONE" =~ ^[0-9]{10}$ ]] || { echo "--admin-phone: 10 цифр, например 9001112233" >&2; exit 2; }
[[ "$LISTEN_ADDR" == "127.0.0.1" || -n "$NPM_IP" ]] || { echo "Если --listen-addr не 127.0.0.1, укажите --npm-ip (откуда разрешить доступ)" >&2; exit 2; }
DB_NAME="gsk_${ENV_NAME}"
PUSH_DRY_RUN=$([[ "$ENV_NAME" == "prod" ]] && echo 0 || echo 1)

step() { echo; echo "━━ $*"; }
rand() { head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }

step "Пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg nginx rsync ufw fail2ban sudo unattended-upgrades postgresql-common

if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  step "Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "Node.js $(node -v), npm $(npm -v)"

if ! command -v psql >/dev/null || ! dpkg -l | grep -q '^ii  postgresql-16 '; then
  step "PostgreSQL 16 (репозиторий PGDG)"
  /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
  apt-get install -y postgresql-16
fi
systemctl enable --now postgresql

step "Пользователи и каталоги"
getent group gsk >/dev/null || groupadd --system gsk
id gsk >/dev/null 2>&1 || useradd --system --gid gsk --home-dir /var/lib/gsk --shell /usr/sbin/nologin gsk
if ! id gsk-deploy >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --gid gsk gsk-deploy
  passwd -l gsk-deploy >/dev/null   # вход только по ключу
fi
install -d -m 755 -o gsk-deploy -g gsk /opt/gsk /opt/gsk/releases /opt/gsk/bin
install -d -m 750 -o root -g gsk /etc/gsk
install -d -m 700 -o gsk -g gsk /var/lib/gsk
install -d -m 700 -o gsk -g gsk /var/lib/gsk/storage
install -d -m 2770 -o gsk -g gsk /var/backups/gsk

step "Скрипты деплоя и бэкапа"
install -m 755 -o root -g root "$HERE"/bin/deploy-receive.sh "$HERE"/bin/backup.sh "$HERE"/bin/restore.sh "$HERE"/bin/seed.sh "$HERE"/bin/reset-2fa.sh /opt/gsk/bin/

step "База данных $DB_NAME"
ENV_FILE=/etc/gsk/api.env
# Пустой или неполный файл (прерванный прошлый запуск) считаем отсутствующим и создаём заново
if [[ -s "$ENV_FILE" ]] && grep -q '^DATABASE_URL=' "$ENV_FILE"; then
  echo "Файл $ENV_FILE уже есть — пароли не меняю"
  ADMIN_PASSWORD="(не менялся)"
else
  DB_PASSWORD="$(rand 32)"
  JWT_SECRET="$(rand 64)"
  TOTP_KEY="$(rand 48)"
  ADMIN_PASSWORD="$(rand 12)"
  if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='gsk'" | grep -q 1; then
    sudo -u postgres psql -c "ALTER ROLE gsk LOGIN PASSWORD '${DB_PASSWORD}'"
  else
    sudo -u postgres psql -c "CREATE ROLE gsk LOGIN PASSWORD '${DB_PASSWORD}'"
  fi
  sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
    || sudo -u postgres createdb --owner gsk --template template0 --encoding UTF8 --locale C.UTF-8 "$DB_NAME"  # template0: кластер Debian может быть в SQL_ASCII

  step "Ключи VAPID для Web Push"
  VAPID_JSON="$(cd /tmp && npx --yes web-push generate-vapid-keys --json)"
  VAPID_PUBLIC="$(echo "$VAPID_JSON" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).publicKey')"
  VAPID_PRIVATE="$(echo "$VAPID_JSON" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).privateKey')"

  step "Файл окружения $ENV_FILE"
  sed -e "s|@@APP_DOMAIN@@|${APP_DOMAIN}|g" -e "s|@@ADMIN_DOMAIN@@|${ADMIN_DOMAIN}|g" \
      -e "s|@@DB_PASSWORD@@|${DB_PASSWORD}|g" -e "s|@@DB_NAME@@|${DB_NAME}|g" \
      -e "s|@@JWT_SECRET@@|${JWT_SECRET}|g" -e "s|@@TOTP_KEY@@|${TOTP_KEY}|g" -e "s|@@PUSH_DRY_RUN@@|${PUSH_DRY_RUN}|g" \
      -e "s|@@VAPID_PUBLIC@@|${VAPID_PUBLIC}|g" -e "s|@@VAPID_PRIVATE@@|${VAPID_PRIVATE}|g" \
      -e "s|@@ADMIN_EMAIL@@|${ADMIN_EMAIL}|g" -e "s|@@ADMIN_PHONE@@|${ADMIN_PHONE}|g" \
      -e "s|@@ADMIN_PASSWORD@@|${ADMIN_PASSWORD}|g" \
      "$HERE"/env/api.env.template > "$ENV_FILE.new"
  # пишем во временный файл и подменяем целиком: при сбое не остаётся пустого api.env
  grep -q '^DATABASE_URL=postgresql://gsk:' "$ENV_FILE.new" || { echo "Не удалось сформировать $ENV_FILE" >&2; rm -f "$ENV_FILE.new"; exit 1; }
  chown root:gsk "$ENV_FILE.new"; chmod 640 "$ENV_FILE.new"
  mv -f "$ENV_FILE.new" "$ENV_FILE"
fi

step "systemd"
install -m 644 "$HERE"/systemd/gsk-api.service "$HERE"/systemd/gsk-backup.service "$HERE"/systemd/gsk-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable gsk-api.service
systemctl enable --now gsk-backup.timer

step "sudo: деплой может только перезапускать API"
cat > /etc/sudoers.d/gsk-deploy <<'EOF'
gsk-deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart gsk-api, /usr/bin/systemctl is-active gsk-api
EOF
chmod 440 /etc/sudoers.d/gsk-deploy
visudo -cf /etc/sudoers.d/gsk-deploy

step "SSH-ключ для GitLab CI (только деплой)"
install -d -m 700 -o gsk-deploy -g gsk /home/gsk-deploy/.ssh
if [[ -n "$DEPLOY_PUBKEY" ]]; then
  # restrict — без терминала и пересылок; command — единственное, что можно выполнить этим ключом
  echo "restrict,command=\"/opt/gsk/bin/deploy-receive.sh\" ${DEPLOY_PUBKEY}" > /home/gsk-deploy/.ssh/authorized_keys
  chown gsk-deploy:gsk /home/gsk-deploy/.ssh/authorized_keys; chmod 600 /home/gsk-deploy/.ssh/authorized_keys
  echo "Ключ установлен"
else
  echo "ВНИМАНИЕ: --deploy-pubkey не указан. Добавьте ключ позже в /home/gsk-deploy/.ssh/authorized_keys в формате:"
  echo "  restrict,command=\"/opt/gsk/bin/deploy-receive.sh\" ssh-ed25519 AAAA… gitlab-ci"
fi

step "nginx (внутренние сайты для Nginx Proxy Manager)"
# server_tokens уже может быть задан в nginx.conf (в новых Debian — да): повтор директивы ломает nginx -t
if grep -Eq '^[[:space:]]*server_tokens[[:space:]]' /etc/nginx/nginx.conf; then
  rm -f /etc/nginx/conf.d/gsk-global.conf
else
  install -m 644 "$HERE"/nginx/gsk-global.conf /etc/nginx/conf.d/gsk-global.conf
fi
install -d /etc/nginx/snippets
install -m 644 "$HERE"/nginx/gsk-security.conf /etc/nginx/snippets/gsk-security.conf
render_site() { # site title port max_body
  sed -e "s|@@SITE@@|$1|g" -e "s|@@SITE_TITLE@@|$2|g" -e "s|@@PORT@@|$3|g" -e "s|@@MAX_BODY@@|$4|g" \
      -e "s|@@LISTEN_ADDR@@|${LISTEN_ADDR}|g" "$HERE"/nginx/gsk-site.conf.template > "/etc/nginx/sites-available/gsk-$1"
  ln -sfn "/etc/nginx/sites-available/gsk-$1" "/etc/nginx/sites-enabled/gsk-$1"
}
render_site pwa   "приложение жителей (PWA)"   "$APP_PORT" "20m"
render_site admin "портал правления"           "$ADMIN_PORT" "130m"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx
systemctl reload nginx

step "Брандмауэр (ufw) и fail2ban"
ufw default deny incoming
ufw default allow outgoing
ufw allow "${SSH_PORT}/tcp"
if [[ "$LISTEN_ADDR" != "127.0.0.1" ]]; then
  ufw allow from "$NPM_IP" to any port "$APP_PORT,$ADMIN_PORT" proto tcp
fi
ufw --force enable
cat > /etc/fail2ban/jail.d/gsk.local <<EOF
[sshd]
enabled = true
port = ${SSH_PORT}
maxretry = 5
bantime = 1h
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

step "Автоматические обновления безопасности"
dpkg-reconfigure -f noninteractive unattended-upgrades || true

cat <<EOF

════════════════════════════════════════════════════════════════
 Сервер «${ENV_NAME}» подготовлен.

 Первый администратор (используйте после первого деплоя и команды seed):
   телефон: ${ADMIN_PHONE}
   пароль:  ${ADMIN_PASSWORD}
 Пароль записан в ${ENV_FILE} (SEED_ADMIN_PASSWORD). После создания администратора УДАЛИТЕ эту строку.

 Дальше:
   1) в Nginx Proxy Manager добавьте два хоста: ${APP_DOMAIN} → http://<этот сервер>:${APP_PORT}
      и ${ADMIN_DOMAIN} → http://<этот сервер>:${ADMIN_PORT} (см. docs/DEPLOY.md);
   2) запустите деплой из GitLab (ветка $( [[ "$ENV_NAME" == "prod" ]] && echo main || echo develop ));
   3) выполните:  sudo -u gsk-deploy /opt/gsk/bin/seed.sh
   4) войдите на https://${ADMIN_DOMAIN}
════════════════════════════════════════════════════════════════
EOF
