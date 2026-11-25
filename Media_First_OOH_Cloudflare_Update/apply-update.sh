#!/usr/bin/env bash
set -euo pipefail

ROOT="$(pwd)"
UPDATE_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ ! -f "$ROOT/package.json" || ! -f "$ROOT/wrangler.jsonc" || ! -d "$ROOT/src" || ! -d "$ROOT/public" ]]; then
  echo "ERROR: Запусти цей скрипт із кореневої папки Media_First_OOH_Cloudflare (там, де package.json і wrangler.jsonc)."
  exit 1
fi

for file in src/worker.js src/sheets.js public/index.html migrations/0002_dynamic_layers_and_safe_sync.sql scripts/test-sheets.mjs scripts/validate.py package.json; do
  if [[ ! -f "$UPDATE_DIR/$file" ]]; then
    echo "ERROR: У пакеті оновлення відсутній файл: $file"
    exit 1
  fi
done

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$ROOT/.backup-cloudflare-update-$STAMP"
mkdir -p "$BACKUP/src" "$BACKUP/public" "$BACKUP/scripts"
cp "$ROOT/src/worker.js" "$BACKUP/src/worker.js"
[[ -f "$ROOT/src/sheets.js" ]] && cp "$ROOT/src/sheets.js" "$BACKUP/src/sheets.js" || true
cp "$ROOT/public/index.html" "$BACKUP/public/index.html"
[[ -f "$ROOT/scripts/validate.py" ]] && cp "$ROOT/scripts/validate.py" "$BACKUP/scripts/validate.py" || true

mkdir -p "$ROOT/migrations" "$ROOT/scripts"
cp "$UPDATE_DIR/src/worker.js" "$ROOT/src/worker.js"
cp "$UPDATE_DIR/src/sheets.js" "$ROOT/src/sheets.js"
cp "$UPDATE_DIR/public/index.html" "$ROOT/public/index.html"
cp "$UPDATE_DIR/migrations/0002_dynamic_layers_and_safe_sync.sql" "$ROOT/migrations/0002_dynamic_layers_and_safe_sync.sql"
cp "$UPDATE_DIR/scripts/test-sheets.mjs" "$ROOT/scripts/test-sheets.mjs"
cp "$UPDATE_DIR/scripts/validate.py" "$ROOT/scripts/validate.py"
cp "$UPDATE_DIR/package.json" "$ROOT/package.json"
for doc in README_UA.md DEPLOY_CHECKLIST_UA.md GOOGLE_SHEETS_SETUP_UA.md UPDATE_GUIDE_UA.md; do
  [[ -f "$UPDATE_DIR/$doc" ]] && cp "$UPDATE_DIR/$doc" "$ROOT/$doc"
done

# Preserve wrangler.jsonc (the user's real D1 id / bindings) and .dev.vars (local secrets).
echo ""
echo "✅ Оновлення встановлено. Резервна копія: $BACKUP"
echo "✅ wrangler.jsonc і .dev.vars не змінювалися."
echo "Наступні кроки: npm run db:migrate:local, npm run db:migrate:remote, npm run test."
