#!/usr/bin/env bash
# Упаковка релиза в release.tar.gz. Вызывается в GitLab CI после сборки всех приложений:
#   ./scripts/package-release.sh <ид-релиза>
# В архив попадают только собранные файлы и манифесты зависимостей. node_modules в архив НЕ кладутся:
# сервер ставит их сам (npm ci --omit=dev), чтобы нативные модули подходили именно к нему.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ID="${1:?Укажите идентификатор релиза}"
OUT="$PWD/.release"
rm -rf "$OUT" release.tar.gz
mkdir -p "$OUT"

for app in api admin pwa; do
  [[ -d "apps/$app/dist" ]] || { echo "Нет apps/$app/dist — сначала соберите приложения" >&2; exit 1; }
  mkdir -p "$OUT/apps/$app"
  cp "apps/$app/package.json" "$OUT/apps/$app/"
  cp -r "apps/$app/dist" "$OUT/apps/$app/"
done
cp -r apps/api/prisma "$OUT/apps/api/"
cp package.json package-lock.json "$OUT/"
echo "$ID" > "$OUT/RELEASE"

tar -czf release.tar.gz -C "$OUT" .
rm -rf "$OUT"
echo "Релиз $ID: release.tar.gz ($(du -h release.tar.gz | cut -f1))"
