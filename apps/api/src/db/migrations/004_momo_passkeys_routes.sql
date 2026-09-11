CREATE TABLE IF NOT EXISTS momo_operators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT NOT NULL,
  country TEXT NOT NULL,
  currency TEXT NOT NULL,
  ussd TEXT,
  color TEXT NOT NULL DEFAULT '#6366f1',
  collection_number TEXT,
  collection_name TEXT,
  instructions TEXT,
  payout_enabled INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_momo_country ON momo_operators(country, enabled);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  device_type TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0,
  device_name TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  purpose TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS money_routes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_method TEXT NOT NULL,
  source_details TEXT NOT NULL DEFAULT '{}',
  destination_method TEXT NOT NULL,
  destination_details TEXT NOT NULL DEFAULT '{}',
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  target_currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payment_id TEXT,
  funding_transaction_id TEXT,
  payout_transaction_id TEXT,
  note TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_routes_user ON money_routes(user_id, created_at);
