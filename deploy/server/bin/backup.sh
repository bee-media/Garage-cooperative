#!/usr/bin/env bash
# Резервная копия: база PostgreSQL (дамп) + загруженные файлы (инкрементальные снимки через rsync).
# Запуск вручную:   sudo -u gsk /opt/gsk/bin/backup.sh [--db-only] [--label метка]
# По расписанию:    systemd-таймер gsk-backup.timer (каждую ночь в 03:30 МСК)
# Нужна переменная DATABASE_URL (её даёт EnvironmentFile=/etc/gsk/api.env).
#
# Каталог копий /var/backups/gsk попадает в ваш PBS вместе со всей машиной.
# В копиях личные данные: права 770/660 (только группа gsk), не выкладывайте их в открытом виде.
set -euo pipefail
umask 007   # группа gsk (сервис и пользователь деплоя) может читать и писать; остальные — нет

DEST="${BACKUP_DIR:-/var/backups/gsk}"
STORAGE="${STORAGE_DIR:-/var/lib/gsk/storage}"
KEEP_DB_DAYS="${BACKUP_KEEP_DB_DAYS:-14}"
KEEP_PREDEPLOY="${BACKUP_KEEP_PREDEPLOY:-10}"
KEEP_FILE_SNAPSHOTS="${BACKUP_KEEP_FILE_SNAPSHOTS:-7}"

DB_ONLY=0
LABEL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --db-only) DB_ONLY=1 ;;
    --label) LABEL="${2:?метка}"; shift ;;
    *) echo "неизвестный аргумент: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ -z "$LABEL" || "$LABEL" =~ ^[0-9A-Za-z._-]+$ ]] || { echo "недопустимая метка" >&2; exit 2; }
: "${DATABASE_URL:?не задана DATABASE_URL}"

TS="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST/db" "$DEST/files"   # права каталогов (2770 gsk:gsk) задаёт setup.sh

# pg_dump не понимает параметр ?schema=public из адреса Prisma
PGURL="${DATABASE_URL%%\?*}"
FILE="$DEST/db/gsk-${TS}${LABEL:+-$LABEL}.dump"

echo "[backup] дамп базы → $FILE"
pg_dump --format=custom --no-owner --dbname "$PGURL" --file "$FILE.tmp"
# Проверка: дамп читается (pg_restore --list не падает)
LIST="$(pg_restore --list "$FILE.tmp")" || { rm -f "$FILE.tmp"; echo "[backup] ОШИБКА: дамп повреждён" >&2; exit 1; }
# Первый деплой: в базе ещё нет ни одной таблицы (миграции не применялись) — копировать нечего, это не ошибка
if ! grep -q ' TABLE ' <<<"$LIST"; then
  rm -f "$FILE.tmp"
  echo "[backup] база пуста (таблиц нет) — копия не нужна"
  exit 0
fi
mv "$FILE.tmp" "$FILE"
( cd "$DEST/db" && sha256sum "$(basename "$FILE")" > "$(basename "$FILE").sha256" )

if [[ "$DB_ONLY" -eq 0 ]]; then
  if [[ -d "$STORAGE" ]]; then
    echo "[backup] файлы → $DEST/files/$TS"
    LINK=()
    [[ -d "$DEST/files/latest" ]] && LINK=(--link-dest="$DEST/files/latest")
    rsync -a "${LINK[@]}" "$STORAGE/" "$DEST/files/$TS/"
    ln -sfn "$TS" "$DEST/files/latest"
  else
    echo "[backup] каталог файлов $STORAGE не найден — пропускаю"
  fi
fi

# ── Ротация ──
# Массивы с nullglob: пустая выборка — не ошибка (при set -e/pipefail это важно для первого запуска)
shopt -s nullglob
# дампы с меткой pre-deploy: храним последние N (имена содержат время, поэтому сортировка по имени = по дате)
PRE=("$DEST"/db/gsk-*-pre-deploy.dump)
if (( ${#PRE[@]} > KEEP_PREDEPLOY )); then
  for f in "${PRE[@]:0:${#PRE[@]}-KEEP_PREDEPLOY}"; do rm -f "$f" "$f.sha256"; done
fi
# обычные дампы старше KEEP_DB_DAYS дней удаляются
find "$DEST/db" -name 'gsk-*.dump' ! -name '*-pre-deploy.dump' -mtime +"$KEEP_DB_DAYS" -print0 | while IFS= read -r -d '' f; do rm -f "$f" "$f.sha256"; done
# снимки файлов: последние N (снимки на жёстких ссылках независимы, удаление старого безопасно)
SNAPS=("$DEST"/files/20*)
if (( ${#SNAPS[@]} > KEEP_FILE_SNAPSHOTS )); then
  for d in "${SNAPS[@]:0:${#SNAPS[@]}-KEEP_FILE_SNAPSHOTS}"; do rm -rf "$d"; done
fi

echo "$TS ok $(basename "$FILE")" > "$DEST/last-backup.txt"
echo "[backup] готово: $(du -h "$FILE" | cut -f1) база"
