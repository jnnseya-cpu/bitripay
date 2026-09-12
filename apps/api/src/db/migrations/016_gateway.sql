-- Gateway objects: webhook endpoints with subscriptions and persisted retries, checkout sessions, refunds and
-- verifications as first-class objects, scoped API keys, sandbox simulation.
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '["*"]',
  description TEXT,
  api_version TEXT NOT NULL DEFAULT '2026-09-01',
  active INTEGER NOT NULL DEFAULT 1,
  failures INTEGER NOT NULL DEFAULT 0,
  disabled_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_user ON webhook_endpoints(user_id, active);

ALTER TABLE webhook_deliveries ADD COLUMN endpoint_id TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN event_id TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN next_attempt_at TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN dead INTEGER NOT NULL DEFAULT 0;
ALTER TABLE webhook_deliveries ADD COLUMN replay_of TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN response_body TEXT;
CREATE INDEX IF NOT EXISTS idx_wh_next ON webhook_deliveries(success, dead, next_attempt_at);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  api_version TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_user ON webhook_events(user_id, created_at);

CREATE TABLE IF NOT EXISTS checkout_sessions (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  merchant_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  success_url TEXT,
  cancel_url TEXT,
  customer TEXT,
  line_items TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkout_sessions_intent ON checkout_sessions(intent_id);

CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  intent_id TEXT,
  transaction_id TEXT NOT NULL,
  merchant_user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'REQUESTED',
  method TEXT NOT NULL,
  refund_transaction_id TEXT,
  provider_ref TEXT,
  error TEXT,
  requested_by TEXT,
  approved_by TEXT,
  idem_key TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refunds_tx ON refunds(transaction_id);
CREATE INDEX IF NOT EXISTS idx_refunds_merchant ON refunds(merchant_user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_idem ON refunds(merchant_user_id, idem_key);

CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  merchant_user_id TEXT NOT NULL,
  rail TEXT NOT NULL,
  reference TEXT,
  msisdn TEXT,
  amount INTEGER,
  currency TEXT,
  window_from TEXT,
  window_to TEXT,
  status TEXT NOT NULL,
  confidence INTEGER NOT NULL DEFAULT 0,
  evidence_id TEXT,
  payment_id TEXT,
  intent_id TEXT,
  reasons TEXT NOT NULL DEFAULT '[]',
  match TEXT,
  charged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verifications_merchant ON verifications(merchant_user_id, created_at);
