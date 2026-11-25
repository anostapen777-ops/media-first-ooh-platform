ALTER TABLE inventory ADD COLUMN stable_key TEXT;
CREATE INDEX IF NOT EXISTS inventory_stable_key_idx ON inventory(stable_key);
CREATE INDEX IF NOT EXISTS inventory_source_sheet_idx ON inventory(source_sheet);

CREATE TABLE IF NOT EXISTS inventory_layers (
  layer_key TEXT PRIMARY KEY,
  source_sheet TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  color TEXT NOT NULL,
  marker_shape TEXT NOT NULL,
  marker_label TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'media',
  sort_order INTEGER NOT NULL DEFAULT 100,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_layers_stage (
  layer_key TEXT PRIMARY KEY,
  source_sheet TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  color TEXT NOT NULL,
  marker_shape TEXT NOT NULL,
  marker_label TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'media',
  sort_order INTEGER NOT NULL DEFAULT 100,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_sync_stage (
  id TEXT PRIMARY KEY,
  stable_key TEXT NOT NULL,
  layer TEXT NOT NULL,
  city TEXT,
  campaign TEXT,
  partner TEXT,
  ad_format TEXT,
  media_type TEXT,
  title TEXT,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  photo_url TEXT,
  scheme_url TEXT,
  source_sheet TEXT NOT NULL,
  source_row INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  records_count INTEGER NOT NULL DEFAULT 0,
  layers_count INTEGER NOT NULL DEFAULT 0,
  message TEXT
);
CREATE INDEX IF NOT EXISTS sync_runs_completed_idx ON sync_runs(completed_at DESC);

UPDATE inventory
SET stable_key = COALESCE(json_extract(data_json, '$._stable_key'), NULL)
WHERE stable_key IS NULL;
