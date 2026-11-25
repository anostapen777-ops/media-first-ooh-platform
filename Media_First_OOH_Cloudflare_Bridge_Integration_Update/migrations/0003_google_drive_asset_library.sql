CREATE TABLE IF NOT EXISTS drive_library_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_assets (
  id TEXT PRIMARY KEY,
  stable_key TEXT NOT NULL,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('photo','scheme')),
  source_url TEXT NOT NULL,
  source_sheet TEXT NOT NULL DEFAULT '',
  object_title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','copied','needs_attention')),
  drive_file_id TEXT,
  drive_web_view_link TEXT,
  mime_type TEXT,
  file_name TEXT,
  google_user_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  last_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(stable_key, asset_type)
);
CREATE INDEX IF NOT EXISTS inventory_assets_status_idx ON inventory_assets(status, updated_at);
CREATE INDEX IF NOT EXISTS inventory_assets_stable_idx ON inventory_assets(stable_key, asset_type);
CREATE INDEX IF NOT EXISTS inventory_assets_drive_file_idx ON inventory_assets(drive_file_id);
