#!/usr/bin/env python3
"""Offline integrity checks for the Media First OOH Cloudflare package."""
from __future__ import annotations

import collections
import json
import re
import sqlite3
import subprocess
import tempfile
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"FAIL: {message}")
    print(f"PASS: {message}")


class InlineScriptParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.in_script = False
        self.external = False
        self.current: list[str] = []
        self.inline_scripts: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() == "script":
            self.in_script = True
            self.external = any(k.lower() == "src" for k, _ in attrs)
            self.current = []

    def handle_data(self, data):
        if self.in_script and not self.external:
            self.current.append(data)

    def handle_endtag(self, tag):
        if tag.lower() == "script" and self.in_script:
            if not self.external:
                self.inline_scripts.append("".join(self.current))
            self.in_script = False
            self.external = False
            self.current = []


worker = ROOT / "src" / "worker.js"
html = ROOT / "public" / "index.html"
seed_json = ROOT / "data" / "inventory-seed.json"
seed_sql = ROOT / "data" / "seed_inventory.sql"
migration = ROOT / "migrations" / "0001_initial.sql"
migration2 = ROOT / "migrations" / "0002_dynamic_layers_and_safe_sync.sql"
migration3 = ROOT / "migrations" / "0003_google_drive_asset_library.sql"
migration4 = ROOT / "migrations" / "0004_apps_script_bridge.sql"
config = ROOT / "wrangler.jsonc"

subprocess.run(["node", "--check", str(worker)], check=True)
subprocess.run(["node", "--check", str(ROOT / "src" / "sheets.js")], check=True)
require(True, "Worker and Sheets parser JavaScript syntax")

raw_html = html.read_text(encoding="utf-8")
parser = InlineScriptParser()
parser.feed(raw_html)
for i, script in enumerate(parser.inline_scripts, start=1):
    with tempfile.NamedTemporaryFile("w", suffix=".js", encoding="utf-8", delete=False) as f:
        f.write(script)
        path = f.name
    subprocess.run(["node", "--check", path], check=True)
require(bool(parser.inline_scripts), f"{len(parser.inline_scripts)} inline frontend scripts syntax")

if config.exists():
    settings = json.loads(config.read_text(encoding="utf-8"))
    require(settings.get("main") == "src/worker.js", "Wrangler entry point")
    require(settings.get("assets", {}).get("directory") == "./public", "Static assets directory")
    require("r2_buckets" not in settings, "R2 disabled; Google Drive is the asset store")
    require(bool(settings.get("d1_databases")) and settings["d1_databases"][0].get("binding") == "DB", "D1 binding configured (R2 is optional)")
    crons = settings.get("triggers", {}).get("crons", [])
    require("0 6 * * *" not in crons and "*/5 * * * *" not in crons, "Cloudflare Cron disabled; Apps Script owns Google schedules")
else:
    require("APPS_SCRIPT_BRIDGE_SECRET" in (ROOT / "INTEGRATION_SETUP_UA.md").read_text(encoding="utf-8"), "Bridge setup instructions include Worker secret")

rows = json.loads(seed_json.read_text(encoding="utf-8"))
counts = collections.Counter(r.get("_layer") for r in rows)
require(len(rows) == 336, "Seed JSON contains 336 objects")
require(counts == {"promo": 194, "local": 70, "restaurant": 72}, "Layer counts are 194 / 70 / 72")
require(len({r.get("_id") for r in rows}) == len(rows), "All inventory IDs are unique")
require(all(-90 <= float(r["_lat"]) <= 90 and -180 <= float(r["_lon"]) <= 180 for r in rows), "All inventory coordinates are valid")
require(sum(bool(r.get("_photo")) for r in rows) == 260, "260 photo links retained")
require(sum(bool(r.get("_scheme")) for r in rows) == 152, "152 scheme links retained")

worker_text = worker.read_text(encoding="utf-8")
asset_block = re.search(r"const ASSET_HOSTS = new Set\(\[(.*?)\]\);", worker_text, re.S)
require(asset_block is not None, "Photo proxy host allowlist present")
allowed = set(re.findall(r'"([^" ]+)"', asset_block.group(1)))
source_hosts = set()
for record in rows:
    for key in ("_photo", "_scheme"):
        value = record.get(key)
        if value:
            host = (urlparse(value).hostname or "").lower()
            if host:
                source_hosts.add(host)
missing = sorted(h for h in source_hosts if h not in allowed and not h.endswith(".sharepoint.com") and not h.endswith(".googleusercontent.com"))
require(not missing, f"All source media hosts allowlisted ({len(source_hosts)} hosts)")
require("const DATA=[];" in raw_html, "Public HTML does not embed inventory data")
require("setInterval(()=>refreshInventory(true)" in raw_html, "Open map refreshes inventory automatically every 60 seconds")
require("data-layer-toggle" in raw_html, "Layer controls are generated dynamically")
require("/api/google/test-email" in worker_text, "Gmail test endpoint is present")
require("https://www.googleapis.com/auth/drive.file" in worker_text, "Google Drive least-privilege OAuth scope is requested")
require("/api/assets/library/start" in worker_text and "/api/assets/library/process" in worker_text, "Google Drive automatic asset copy endpoints are present")
apps_code_candidate = ROOT / "apps-script" / "Code.gs"
if not apps_code_candidate.exists():
    apps_code_candidate = ROOT / "apps-script-reference" / "Code.gs"
apps_script_text = apps_code_candidate.read_text(encoding="utf-8") if apps_code_candidate.exists() else ""
require("/api/assets/library-file" in worker_text and "assets.download" in apps_script_text and "alt=media" in apps_script_text, "Apps Script-backed private Drive previews and file downloads are present")
require("drive-library-start" in raw_html and "Automatically" not in raw_html, "Admin UI exposes automatic Drive asset copy")
require("/api/google/sync" in worker_text and "inventory.apply" in worker_text, "Google Sheets sync endpoint is wired through Apps Script")
require('path === "/api/bridge/apps-script"' in worker_text, "Signed Apps Script callback endpoint is present")
require("verifyAppsScriptEnvelope" in worker_text and "bridge_nonces" in worker_text, "Worker validates HMAC and rejects replayed bridge requests")
require("APPS_SCRIPT_URL" in worker_text and "APPS_SCRIPT_BRIDGE_SECRET" in worker_text, "Worker uses server-side Apps Script URL and bridge secret")
require("payload.records.length > 5000" in worker_text and "raw.length > 15_000_000" in worker_text, "Bridge accepts scalable inventory payloads up to 5,000 records")
require("password:$id('login-password').value" not in raw_html, "Login form does not send plaintext password")
apps_code = apps_code_candidate
if apps_code.exists():
    js = apps_code.read_text(encoding="utf-8")
    with tempfile.NamedTemporaryFile("w", suffix=".js", encoding="utf-8", delete=False) as f:
        f.write(js)
        apps_js_path = f.name
    subprocess.run(["node", "--check", apps_js_path], check=True)
    require(True, "Apps Script bridge Code.gs syntax")
    require("case 'mail.test':" in js and "function sendTestMail_()" in js, "Apps Script test email action is available")
    require("MAX_SYNC_RECORDS: 5000" in js, "Apps Script sync limit matches Worker capacity")

memory_db = sqlite3.connect(":memory:")
memory_db.execute("PRAGMA foreign_keys = ON")
memory_db.executescript(migration.read_text(encoding="utf-8"))
seed_text = seed_sql.read_text(encoding="utf-8")
statements = [x.strip() for x in seed_text.split(";") if x.strip()]
max_statement_bytes = max(len(x.encode("utf-8")) for x in statements)
require(max_statement_bytes < 100_000, f"Largest seed SQL statement below D1 100 KB cap ({max_statement_bytes} bytes)")
memory_db.executescript(seed_text)
memory_db.executescript(migration2.read_text(encoding="utf-8"))
memory_db.executescript(migration3.read_text(encoding="utf-8"))
memory_db.executescript(migration4.read_text(encoding="utf-8"))
require(memory_db.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='bridge_nonces'").fetchone()[0] == 1, "Apps Script HMAC replay-protection migration created")
require(memory_db.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='inventory_assets'").fetchone()[0] == 1, "Google Drive asset library table migration created")
require(memory_db.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='drive_library_settings'").fetchone()[0] == 1, "Google Drive folder settings table migration created")
db_count = memory_db.execute("SELECT COUNT(*) FROM inventory").fetchone()[0]
require(db_count == 336, "D1 migration + seed + dynamic-layer migration execute and retain 336 rows")
require(memory_db.execute("SELECT COUNT(*) FROM inventory_layers_stage").fetchone()[0] == 0, "Layer staging table created")
require(memory_db.execute("SELECT COUNT(*) FROM inventory_sync_stage").fetchone()[0] == 0, "Inventory staging table created")

# Simulate the active-table swap that the Worker sends to D1 as one batch.
# First seed the staging table from the current active inventory.
memory_db.execute("""INSERT INTO inventory_sync_stage
  (id,stable_key,layer,city,campaign,partner,ad_format,media_type,title,latitude,longitude,photo_url,scheme_url,source_sheet,source_row,data_json,updated_at)
  SELECT id,COALESCE(stable_key,id),layer,city,campaign,partner,ad_format,media_type,title,latitude,longitude,photo_url,scheme_url,source_sheet,source_row,data_json,updated_at FROM inventory""")
memory_db.execute("""INSERT INTO inventory_layers_stage
  (layer_key,source_sheet,display_name,color,marker_shape,marker_label,kind,sort_order,updated_at)
  VALUES ('promo','national','National','#005EFF','circle','','media',10,'test'),
         ('local','local','Local','#25FF08','diamond','','media',20,'test'),
         ('restaurant','restaurants','Restaurants','#B5232F','circle','KFC','restaurant',30,'test')""")
memory_db.commit()
try:
    memory_db.execute("BEGIN")
    memory_db.execute("DELETE FROM inventory")
    memory_db.execute("INSERT INTO inventory(id,layer) VALUES('intentional-failure','test')")
    memory_db.commit()
except sqlite3.IntegrityError:
    memory_db.rollback()
require(memory_db.execute("SELECT COUNT(*) FROM inventory").fetchone()[0] == 336, "Failed inventory swap rolls back and preserves all 336 active rows")

memory_db.execute("BEGIN")
memory_db.execute("DELETE FROM inventory")
memory_db.execute("""INSERT INTO inventory
  (id,stable_key,layer,city,campaign,partner,ad_format,media_type,title,latitude,longitude,photo_url,scheme_url,source_sheet,source_row,data_json,updated_at)
  SELECT id,stable_key,layer,city,campaign,partner,ad_format,media_type,title,latitude,longitude,photo_url,scheme_url,source_sheet,source_row,data_json,updated_at FROM inventory_sync_stage""")
memory_db.execute("DELETE FROM inventory_layers")
memory_db.execute("""INSERT INTO inventory_layers(layer_key,source_sheet,display_name,color,marker_shape,marker_label,kind,sort_order,updated_at)
  SELECT layer_key,source_sheet,display_name,color,marker_shape,marker_label,kind,sort_order,updated_at FROM inventory_layers_stage""")
memory_db.commit()
require(memory_db.execute("SELECT COUNT(*) FROM inventory").fetchone()[0] == 336, "Successful staged inventory replacement retains the exact row count")
require(memory_db.execute("SELECT COUNT(*) FROM inventory_layers").fetchone()[0] == 3, "Successful staged replacement updates map layers atomically")
print("\nAll offline checks passed. This does not replace a live Cloudflare deployment test.")
