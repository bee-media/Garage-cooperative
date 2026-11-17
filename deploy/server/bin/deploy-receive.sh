#!/usr/bin/env bash
# Приём релиза от GitLab CI. Запускается ТОЛЬКО как «принудительная команда» SSH-ключа пользователя gsk-deploy
# (см. setup.sh: restrict,command="/opt/gsk/bin/deploy-receive.sh"), поэтому ключ CI не даёт ничего, кроме деплоя.
#
#   cat release.tar.gz | ssh gsk-deploy@сервер <ид-релиза>     — выкатить релиз
#   ssh gsk-deploy@сервер rollback                             — вернуть предыдущий рабочий релиз
#
# Порядок: распаковка → зависимости → prisma generate → копия БД → миграции → переключение current → перезапуск
# → проверка /api/health. Если проверка не прошла, возвращается предыдущий релиз, а команда завершается с ошибкой
# (CI-задача краснеет).
set -euo pipefail
umask 022

ROOT="${GSK_ROOT:-/opt/gsk}"
KEEP="${GSK_KEEP_RELEASES:-5}"
ENV_FILE="${GSK_ENV_FILE:-/etc/gsk/api.env}"
HEALTH_URL="${GSK_HEALTH_URL:-http://127.0.0.1:3000/api/health}"
RESTART_CMD="${GSK_RESTART_CMD:-sudo -n /usr/bin/systemctl restart gsk-api}"
# Переменные GSK_SKIP_* нужны только для проверки скрипта на компьютере разработчика
SKIP_BACKUP="${GSK_SKIP_BACKUP:-0}"
SKIP_MIGRATE="${GSK_SKIP_MIGRATE:-0}"

log()  { echo "[$(date -u +%H:%M:%S)] $*"; }
fail() { echo "ОШИБКА: $*" >&2; exit 1; }

CMD="${SSH_ORIGINAL_COMMAND:-${1:-}}"
[[ -n "$CMD" ]] || fail "не указан идентификатор релиза или команда rollback"
if [[ "$CMD" != "rollback" && ! "$CMD" =~ ^[0-9A-Za-z._-]{6,64}$ ]]; then
  fail "недопустимый идентификатор релиза"
fi

mkdir -p "$ROOT/releases"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$ROOT/.deploy.lock"
  flock -n 9 || fail "уже выполняется другой деплой"
fi

restart_api() { $RESTART_CMD; }

wait_healthy() {
  for _ in $(seq 1 40); do
    if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

switch_to() { # переключение символической ссылки одним действием
  ln -sfn "$1" "$ROOT/current.tmp"
  mv -T "$ROOT/current.tmp" "$ROOT/current"
}

current_release() { readlink -f "$ROOT/current" 2>/dev/null || true; }

# ───────────── откат ─────────────
if [[ "$CMD" == "rollback" ]]; then
  CUR="$(current_release)"
  PREV=""
  while IFS= read -r d; do
    [[ -f "$d/.deployed-ok" && "$(readlink -f "$d")" != "$CUR" ]] && { PREV="$d"; break; }
  done < <(ls -1dr "$ROOT"/releases/*/ 2>/dev/null | sed 's#/$##')
  [[ -n "$PREV" ]] || fail "нет предыдущего рабочего релиза для отката"
  log "откат: $(basename "$CUR") → $(basename "$PREV")"
  switch_to "$PREV"
  restart_api
  wait_healthy || fail "после отката API не отвечает — смотрите: journalctl -u gsk-api -n 100"
  log "откат выполнен. ВАЖНО: миграции базы назад не откатываются (при необходимости — восстановление из копии pre-deploy)"
  exit 0
fi

# ───────────── выкатка ─────────────
ID="$CMD"
REL="$ROOT/releases/$ID"
[[ ! -e "$REL" ]] || fail "релиз $ID уже существует"

SWITCHED=0
cleanup() { if [[ "$SWITCHED" -eq 0 ]]; then rm -rf "$REL"; fi; }
trap cleanup EXIT

mkdir -p "$REL"
log "распаковка релиза $ID"
tar -xz --no-same-owner --no-same-permissions -C "$REL"

for f in package.json package-lock.json apps/api/package.json apps/api/dist/main.js apps/api/prisma/schema.prisma \
         apps/pwa/dist/index.html apps/admin/dist/index.html; do
  [[ -s "$REL/$f" ]] || fail "в релизе нет файла $f"
done

cd "$REL"
log "установка зависимостей API (без запуска чужих скриптов)"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund -w @gsk/api

log "prisma generate"
( cd apps/api && npx --no-install prisma generate )

if [[ "$SKIP_BACKUP" != "1" ]]; then
  log "резервная копия базы перед миграциями"
  set -a; . "$ENV_FILE"; set +a
  "$ROOT/bin/backup.sh" --db-only --label pre-deploy
fi

if [[ "$SKIP_MIGRATE" != "1" ]]; then
  log "миграции базы"
  ( cd apps/api && set -a && . "$ENV_FILE" && set +a && npx --no-install prisma migrate deploy )
fi

PREV="$(current_release)"
log "переключение на новый релиз и перезапуск API"
switch_to "$REL"
SWITCHED=1
restart_api

if wait_healthy; then
  touch "$REL/.deployed-ok"
  log "API отвечает — релиз $ID выкачен"
else
  echo "ОШИБКА: API не ответил на $HEALTH_URL после перезапуска" >&2
  if [[ -n "$PREV" && -d "$PREV" ]]; then
    log "возвращаю предыдущий релиз $(basename "$PREV")"
    switch_to "$PREV"
    restart_api
    wait_healthy && log "предыдущий релиз восстановлен" || echo "ВНИМАНИЕ: и предыдущий релиз не отвечает, нужен ручной разбор" >&2
  fi
  echo "Журнал: journalctl -u gsk-api -n 100" >&2
  exit 1
fi

# Храним последние $KEEP релизов (текущий и предыдущий не удаляются)
CUR="$(current_release)"
COUNT=0
while IFS= read -r d; do
  COUNT=$((COUNT + 1))
  if [[ "$COUNT" -gt "$KEEP" && "$(readlink -f "$d")" != "$CUR" && "$(readlink -f "$d")" != "$PREV" ]]; then
    log "удаляю старый релиз $(basename "$d")"
    rm -rf "$d"
  fi
done < <(ls -1dr "$ROOT"/releases/*/ | sed 's#/$##')

log "готово"
