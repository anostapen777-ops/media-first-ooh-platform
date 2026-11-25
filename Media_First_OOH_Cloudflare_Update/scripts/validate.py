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

settings = json.loads(config.read_text(encoding="utf-8"))
require(settings.get("main") == "src/worker.js", "Wrangler entry point")
require(settings.get("assets", {}).get("directory") == "./public", "Static assets directory")
require(bool(settings.get("d1_databases")) and settings["d1_databases"][0].get("binding") == "DB", "D1 binding configured (R2 is optional)")
require("0 6 * * *" in settings.get("triggers", {}).get("crons", []), "Daily UTC inventory sync trigger configured")

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
require("/api/google/sync" in worker_text and "values:batchGet" in worker_text, "Google Sheets dynamic reader and sync endpoint are present")
require("password:$id('login-password').value" not in raw_html, "Login form does not send plaintext password")

memory_db = sqlite3.connect(":memory:")
memory_db.execute("PRAGMA foreign_keys = ON")
memory_db.executescript(migration.read_text(encoding="utf-8"))
seed_text = seed_sql.read_text(encoding="utf-8")
statements = [x.strip() for x in seed_text.split(";") if x.strip()]
max_statement_bytes = max(len(x.encode("utf-8")) for x in statements)
require(max_statement_bytes < 100_000, f"Largest seed SQL statement below D1 100 KB cap ({max_statement_bytes} bytes)")
memory_db.executescript(seed_text)
memory_db.executescript(migration2.read_text(encoding="utf-8"))
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
