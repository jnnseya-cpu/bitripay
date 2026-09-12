-- BitriQR standard, payment intents with attempts, the payment event store and Guardian, merchant locations,
-- signing keys, the country capability matrix and scoped API keys. Everything here is additive.

CREATE TABLE IF NOT EXISTS organisations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'merchant',
  owner_user_id TEXT NOT NULL,
  country TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  kyb_status TEXT NOT NULL DEFAULT 'none',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS organisation_members (
  organisation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  permissions TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  PRIMARY KEY (organisation_id, user_id)
);

CREATE TABLE IF NOT EXISTS merchant_locations (
  id TEXT PRIMARY KEY,
  merchant_user_id TEXT NOT NULL,
  organisation_id TEXT,
  name TEXT NOT NULL,
  address TEXT,
  city TEXT,
  country TEXT,
  mcc TEXT,
  lat REAL,
  lng REAL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_locations_merchant ON merchant_locations(merchant_user_id, status);

CREATE TABLE IF NOT EXISTS terminals (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL,
  merchant_user_id TEXT NOT NULL,
  label TEXT NOT NULL,
  device_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_terminals_location ON terminals(location_id);

CREATE TABLE IF NOT EXISTS signing_keys (
  key_id TEXT PRIMARY KEY,
  party_type TEXT NOT NULL,
  party_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  public_key TEXT NOT NULL,
  private_key_enc TEXT,
  not_before TEXT NOT NULL,
  not_after TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signing_keys_party ON signing_keys(party_type, party_id, scope, revoked_at);

CREATE TABLE IF NOT EXISTS qr_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  merchant_user_id TEXT NOT NULL,
  location_id TEXT,
  terminal_id TEXT,
  mode TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'merchant',
  payload TEXT NOT NULL,
  uri TEXT NOT NULL,
  rails_mask INTEGER NOT NULL DEFAULT 1,
  key_id TEXT,
  amount INTEGER,
  currency TEXT NOT NULL,
  purpose_code TEXT,
  reference TEXT,
  intent_id TEXT,
  payment_request_id TEXT,
  nonce TEXT,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  revoked_reason TEXT,
  asset_ref TEXT,
  scans INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qr_merchant ON qr_codes(merchant_user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_qr_intent ON qr_codes(intent_id);

CREATE TABLE IF NOT EXISTS qr_scans (
  id TEXT PRIMARY KEY,
  qr_id TEXT,
  intent_id TEXT,
  channel TEXT NOT NULL DEFAULT 'app',
  outcome TEXT NOT NULL,
  trust TEXT,
  payer_user_id TEXT,
  ip TEXT,
  country TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qr_scans_qr ON qr_scans(qr_id, created_at);

CREATE TABLE IF NOT EXISTS payment_intents (
  id TEXT PRIMARY KEY,
  organisation_id TEXT,
  merchant_user_id TEXT NOT NULL,
  amount_minor INTEGER,
  currency TEXT NOT NULL,
  capture_method TEXT NOT NULL DEFAULT 'automatic',
  method_policy TEXT NOT NULL DEFAULT 'smart',
  rails TEXT NOT NULL DEFAULT '[]',
  reference TEXT,
  description TEXT,
  purpose_code TEXT,
  status TEXT NOT NULL DEFAULT 'CREATED',
  source TEXT NOT NULL DEFAULT 'api',
  qr_id TEXT,
  payment_request_id TEXT,
  location_id TEXT,
  terminal_id TEXT,
  customer_user_id TEXT,
  customer_msisdn TEXT,
  customer_country TEXT,
  settlement_profile_id TEXT,
  route_connector TEXT,
  client_secret_hash TEXT,
  idem_key TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  transaction_id TEXT,
  gateway_payment_id TEXT,
  expires_at TEXT,
  ambiguous_since TEXT,
  succeeded_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intents_merchant ON payment_intents(merchant_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_intents_status ON payment_intents(status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_intents_idem ON payment_intents(merchant_user_id, idem_key);

CREATE TABLE IF NOT EXISTS payment_attempts (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  method_class TEXT NOT NULL,
  rail TEXT,
  connector TEXT,
  operator_id TEXT,
  provider_ref TEXT,
  switch_correlation_id TEXT,
  gateway_payment_id TEXT,
  transaction_id TEXT,
  status TEXT NOT NULL DEFAULT 'CREATED',
  failure_category TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_intent ON payment_attempts(intent_id, seq);

CREATE TABLE IF NOT EXISTS payment_events (
  event_id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  source TEXT NOT NULL,
  direction TEXT NOT NULL,
  state TEXT NOT NULL,
  intent_id TEXT,
  attempt_id TEXT,
  corridor_id TEXT,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  counterparty TEXT,
  evidence TEXT NOT NULL DEFAULT '[]',
  payload TEXT NOT NULL DEFAULT '{}',
  transaction_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_payment_events_intent ON payment_events(intent_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_payment_events_state ON payment_events(state, occurred_at);

CREATE TABLE IF NOT EXISTS guardian_checks (
  id TEXT PRIMARY KEY,
  ok INTEGER NOT NULL,
  transactions_checked INTEGER NOT NULL,
  findings TEXT NOT NULL DEFAULT '[]',
  halted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS country_capabilities (
  country TEXT PRIMARY KEY,
  config TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE api_keys ADD COLUMN kind TEXT NOT NULL DEFAULT 'secret';
ALTER TABLE api_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT '["*"]';
ALTER TABLE api_keys ADD COLUMN ip_allowlist TEXT;
ALTER TABLE payment_requests ADD COLUMN intent_id TEXT;
ALTER TABLE gateway_payments ADD COLUMN intent_id TEXT;
ALTER TABLE gateway_payments ADD COLUMN attempt_id TEXT;
ALTER TABLE transactions ADD COLUMN intent_id TEXT;
