#!/usr/bin/env bash
# Первичное наполнение: системные роли и первый администратор (данные берутся из /etc/gsk/api.env).
# Запуск один раз после первого деплоя:  sudo -u gsk-deploy /opt/gsk/bin/seed.sh
set -euo pipefail
cd /opt/gsk/current/apps/api
node --env-file=/etc/gsk/api.env dist/cli/seed.js
