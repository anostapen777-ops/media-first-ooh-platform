CREATE TABLE IF NOT EXISTS bridge_nonces (
  nonce TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bridge_nonces_created_idx ON bridge_nonces(created_at);
