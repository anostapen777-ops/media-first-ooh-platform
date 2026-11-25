#!/usr/bin/env bash
set -euo pipefail

ROOT="$(pwd)"
UPDATE_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ ! -f "$ROOT/package.json" || ! -f "$ROOT/wrangler.jsonc" || ! -d "$ROOT/src" || ! -d "$ROOT/public" ]]; then
  echo "ERROR: Запусти цей скрипт із кореневої папки Media_First_OOH_Cloudflare (там, де package.json і wrangler.jsonc)."
  exit 1
fi

FILES=(
  src/worker.js
  src/sheets.js
  public/index.html
  migrations/0004_apps_script_bridge.sql
  scripts/test-sheets.mjs
  scripts/validate.py
  apps-script/Code.gs
  apps-script/appsscript.json
  INTEGRATION_SETUP_UA.md
  README_UA.md
)
for file in "${FILES[@]}"; do
  if [[ ! -f "$UPDATE_DIR/$file" ]]; then
    echo "ERROR: У пакеті відсутній файл: $file"
    exit 1
  fi
done

# Validate the user's real D1 config before touching any files.
python3 - "$ROOT/wrangler.jsonc" <<'PY'
import json, sys
from pathlib import Path
config = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
dbs = config.get("d1_databases", [])
if not dbs or dbs[0].get("binding") != "DB":
    raise SystemExit("ERROR: У wrangler.jsonc не знайдено D1 binding DB.")
db_id = dbs[0].get("database_id", "")
if not db_id or "REPLACE_WITH" in db_id:
    raise SystemExit("ERROR: У wrangler.jsonc відсутній реальний database_id. Оновлення зупинено без змін.")
print("✅ Знайдено D1 binding DB із реальним database_id.")
PY

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$ROOT/.backup-cloudflare-bridge-$STAMP"
mkdir -p "$BACKUP/src" "$BACKUP/public" "$BACKUP/scripts" "$BACKUP/migrations" "$BACKUP"
for file in src/worker.js src/sheets.js public/index.html scripts/test-sheets.mjs scripts/validate.py migrations/0004_apps_script_bridge.sql wrangler.jsonc; do
  if [[ -f "$ROOT/$file" ]]; then
    mkdir -p "$BACKUP/$(dirname "$file")"
    cp "$ROOT/$file" "$BACKUP/$file"
  fi
done

cp "$UPDATE_DIR/src/worker.js" "$ROOT/src/worker.js"
cp "$UPDATE_DIR/src/sheets.js" "$ROOT/src/sheets.js"
cp "$UPDATE_DIR/public/index.html" "$ROOT/public/index.html"
cp "$UPDATE_DIR/migrations/0004_apps_script_bridge.sql" "$ROOT/migrations/0004_apps_script_bridge.sql"
cp "$UPDATE_DIR/scripts/test-sheets.mjs" "$ROOT/scripts/test-sheets.mjs"
cp "$UPDATE_DIR/scripts/validate.py" "$ROOT/scripts/validate.py"
cp "$UPDATE_DIR/INTEGRATION_SETUP_UA.md" "$ROOT/INTEGRATION_SETUP_UA.md"
cp "$UPDATE_DIR/README_UA.md" "$ROOT/README_UA.md"
mkdir -p "$ROOT/apps-script-reference"
cp "$UPDATE_DIR/apps-script/Code.gs" "$ROOT/apps-script-reference/Code.gs"
cp "$UPDATE_DIR/apps-script/appsscript.json" "$ROOT/apps-script-reference/appsscript.json"

# Keep the real D1 ID. Apps Script owns Google schedules, and Google Drive is
# the asset store, so remove legacy Cloudflare Cron and optional R2 bindings.
python3 - "$ROOT/wrangler.jsonc" <<'PY'
import json, sys
from pathlib import Path
p = Path(sys.argv[1])
config = json.loads(p.read_text(encoding="utf-8"))
items = config.get("d1_databases", [])
if not items or items[0].get("binding") != "DB" or not items[0].get("database_id") or "REPLACE_WITH" in items[0].get("database_id", ""):
    raise SystemExit("ERROR: D1 binding DB is invalid. Check the backup before retrying.")
triggers = config.get("triggers", {})
crons = [c for c in triggers.get("crons", []) if c not in ("0 6 * * *", "*/5 * * * *")]
if crons:
    triggers["crons"] = crons
    config["triggers"] = triggers
else:
    config.pop("triggers", None)
config.pop("r2_buckets", None)
p.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("✅ Реальний D1 ID і binding DB збережені.")
print("✅ Cloudflare Cron видалені: регулярні процеси виконуватиме Apps Script.")
print("✅ R2 binding прибрано: Google Drive залишається сховищем оригіналів.")
PY

echo ""
echo "✅ Worker Bridge встановлено. Резервна копія: $BACKUP"
echo "✅ wrangler.jsonc: збережено DB; Cloudflare Cron і R2 прибрано."
echo "✅ .dev.vars та інші локальні секрети не змінювалися."
echo "✅ D1 seed не запускався; наявні дані не перезаписувалися."
echo "Наступні команди: npm run db:migrate:local ; npm run db:migrate:remote ; npm test"
echo "Apps Script оновлюватимемо окремо після перевірки Worker patch."
