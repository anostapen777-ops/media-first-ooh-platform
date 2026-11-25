CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','user')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS login_challenges (
  nonce TEXT PRIMARY KEY,
  user_id TEXT,
  email TEXT NOT NULL,
  salt TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS login_challenges_expiry_idx ON login_challenges(expires_at);

CREATE TABLE IF NOT EXISTS inventory (
  id TEXT PRIMARY KEY,
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
CREATE INDEX IF NOT EXISTS inventory_city_idx ON inventory(city);
CREATE INDEX IF NOT EXISTS inventory_layer_idx ON inventory(layer);
CREATE INDEX IF NOT EXISTS inventory_partner_idx ON inventory(partner);
CREATE INDEX IF NOT EXISTS inventory_campaign_idx ON inventory(campaign);

CREATE TABLE IF NOT EXISTS user_selections (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  board_ids_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS saved_programs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  board_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS saved_programs_user_idx ON saved_programs(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS google_connections (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  google_email TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  scopes TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  filename TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  provider_message_id TEXT
);
