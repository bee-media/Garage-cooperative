#!/usr/bin/env bash
# Аварийный сброс 2FA пользователю (потерян телефон и резервные коды):
#   sudo -u gsk-deploy /opt/gsk/bin/reset-2fa.sh 9001112233
# Действие записывается в журнал аудита (автор: server-cli).
set -euo pipefail
cd /opt/gsk/current/apps/api
node --env-file=/etc/gsk/api.env dist/cli/reset-2fa.js "${1:-}"
