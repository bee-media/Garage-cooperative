#!/usr/bin/env bash
# Восстановление из резервной копии. Запускать от root: sudo /opt/gsk/bin/restore.sh --db <файл.dump> [--files <снимок>] --yes
#
#   --db     дамп базы из /var/backups/gsk/db/
#   --files  каталог снимка из /var/backups/gsk/files/<дата-время> (необязательно)
#   --yes    подтверждение (без него скрипт только покажет, что будет сделано)
#
# Перед восстановлением автоматически делается копия ТЕКУЩЕГО состояния (метка pre-restore).
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "запустите от root (sudo)" >&2; exit 1; }
ENV_FILE="${GSK_ENV_FILE:-/etc/gsk/api.env}"
DB_DUMP=""; FILES_SNAP=""; YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --db) DB_DUMP="${2:?}"; shift ;;
    --files) FILES_SNAP="${2:?}"; shift ;;
    --yes) YES=1 ;;
    *) echo "неизвестный аргумент: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ -f "$DB_DUMP" ]] || { echo "укажите существующий файл дампа: --db <файл>" >&2; exit 2; }
[[ -z "$FILES_SNAP" || -d "$FILES_SNAP" ]] || { echo "снимок файлов не найден: $FILES_SNAP" >&2; exit 2; }

if [[ -f "$DB_DUMP.sha256" ]]; then
  ( cd "$(dirname "$DB_DUMP")" && sha256sum -c "$(basename "$DB_DUMP").sha256" ) || { echo "контрольная сумма дампа не совпала" >&2; exit 1; }
fi

echo "Будет выполнено:"
echo "  1. остановка gsk-api"
echo "  2. копия текущей базы (pre-restore)"
echo "  3. восстановление базы из $DB_DUMP (текущие данные будут ЗАМЕНЕНЫ)"
[[ -n "$FILES_SNAP" ]] && echo "  4. восстановление файлов из $FILES_SNAP (текущие файлы будут заменены)"
echo "  5. запуск gsk-api"
if [[ "$YES" -ne 1 ]]; then echo; echo "Добавьте --yes, чтобы выполнить."; exit 0; fi

set -a; . "$ENV_FILE"; set +a
PGURL="${DATABASE_URL%%\?*}"

systemctl stop gsk-api
sudo -u gsk env DATABASE_URL="$DATABASE_URL" /opt/gsk/bin/backup.sh --db-only --label pre-restore
echo "[restore] база…"
pg_restore --clean --if-exists --no-owner --single-transaction --dbname "$PGURL" "$DB_DUMP"

if [[ -n "$FILES_SNAP" ]]; then
  echo "[restore] файлы…"
  rsync -a --delete "$FILES_SNAP"/ "${STORAGE_DIR:-/var/lib/gsk/storage}"/
  chown -R gsk:gsk "${STORAGE_DIR:-/var/lib/gsk/storage}"
fi

systemctl start gsk-api
sleep 3
curl -fsS http://127.0.0.1:3000/api/health && echo && echo "[restore] готово"
