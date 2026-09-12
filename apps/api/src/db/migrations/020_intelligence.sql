-- Phase 7: offline protocol, Diaspora-Direct, domain events, agent mesh bindings, AI gateway ledger.
CREATE TABLE IF NOT EXISTS offline_devices (
  device_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  label TEXT,
  last_counter INTEGER NOT NULL DEFAULT 0,
  registered_at TEXT NOT NULL,
  last_sync_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_offline_devices_user ON offline_devices(user_id);

CREATE TABLE IF NOT EXISTS offline_nonces (
  nonce TEXT PRIMARY KEY,
  issued_to TEXT,
  used_by TEXT,
  used_at TEXT,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS offline_promises (
  intent_hash TEXT PRIMARY KEY,
  merchant_user_id TEXT NOT NULL,
  payer_user_id TEXT NOT NULL,
  payer_device_id TEXT NOT NULL,
  merchant_key_id TEXT NOT NULL,
  payer_key_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  nonce TEXT NOT NULL,
  reference TEXT,
  merchant_sig TEXT NOT NULL,
  payer_sig TEXT NOT NULL,
  payer_device_counter INTEGER NOT NULL,
  promised_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  submitted_by TEXT,
  sync_state TEXT NOT NULL DEFAULT 'PENDING_SYNC',
  reject_reason TEXT,
  transaction_id TEXT,
  intent_id TEXT,
  receipt_sig TEXT,
  synced_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_offline_promises_payer ON offline_promises(payer_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_offline_promises_merchant ON offline_promises(merchant_user_id, created_at);

-- Diaspora-Direct: signed rate policy, rate cards, institutions with purpose codes, purpose-locked quotes
CREATE TABLE IF NOT EXISTS fx_rate_policies (
  id TEXT PRIMARY KEY,
  source_currency TEXT NOT NULL,
  dest_currency TEXT NOT NULL,
  markup_bps INTEGER NOT NULL,
  max_validity_hours INTEGER NOT NULL DEFAULT 4,
  fee_bps INTEGER NOT NULL DEFAULT 0,
  fee_fixed_source_minor INTEGER NOT NULL DEFAULT 0,
  min_source_minor INTEGER NOT NULL DEFAULT 0,
  max_source_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  signed_by TEXT NOT NULL,
  signature TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  retired_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_fx_policies_pair ON fx_rate_policies(source_currency, dest_currency, status);
CREATE TABLE IF NOT EXISTS fx_rate_cards (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  source_currency TEXT NOT NULL,
  dest_currency TEXT NOT NULL,
  mid_rate REAL NOT NULL,
  customer_rate REAL NOT NULL,
  markup_bps INTEGER NOT NULL,
  provider TEXT NOT NULL,
  rate_timestamp TEXT,
  valid_from TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  signature TEXT NOT NULL,
  key_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fx_cards_pair ON fx_rate_cards(source_currency, dest_currency, valid_until);
CREATE TABLE IF NOT EXISTS institutions (
  user_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  registry_ref TEXT,
  purpose_codes TEXT NOT NULL DEFAULT '[]',
  country TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  verified_by TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS diaspora_quotes (
  id TEXT PRIMARY KEY,
  payer_user_id TEXT NOT NULL,
  beneficiary_user_id TEXT NOT NULL,
  rate_card_id TEXT NOT NULL,
  source_currency TEXT NOT NULL,
  dest_currency TEXT NOT NULL,
  source_minor INTEGER NOT NULL,
  fee_minor INTEGER NOT NULL,
  dest_minor INTEGER NOT NULL,
  customer_rate REAL NOT NULL,
  purpose_code TEXT NOT NULL,
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'QUOTED',
  transaction_id TEXT,
  intent_id TEXT,
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diaspora_quotes_payer ON diaspora_quotes(payer_user_id, created_at);

-- Domain events (bitripay.events) and agent mesh bindings
CREATE TABLE IF NOT EXISTS domain_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'platform',
  aggregate_id TEXT,
  occurred_at TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  handled TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_domain_events_type ON domain_events(type, occurred_at);
CREATE TABLE IF NOT EXISTS agent_bindings (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  registry_id TEXT NOT NULL,
  autonomy TEXT NOT NULL DEFAULT 'shadow',
  enabled INTEGER NOT NULL DEFAULT 1,
  shadow_since TEXT NOT NULL,
  promoted_at TEXT,
  promoted_by TEXT,
  kill_switch INTEGER NOT NULL DEFAULT 0,
  runs INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(event_type, agent_key)
);

-- AI gateway usage ledger (administrators only) and per-operation ACU
CREATE TABLE IF NOT EXISTS ai_usage_ledger (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'platform',
  user_id TEXT,
  agent TEXT NOT NULL,
  task_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  raw_cost_micros INTEGER NOT NULL DEFAULT 0,
  acu_used REAL NOT NULL DEFAULT 0,
  acu_revenue_micros INTEGER NOT NULL DEFAULT 0,
  margin REAL,
  latency_ms INTEGER,
  outcome TEXT NOT NULL,
  error_code TEXT,
  billed_to TEXT NOT NULL DEFAULT 'platform',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_day ON ai_usage_ledger(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage_ledger(user_id, created_at);
CREATE TABLE IF NOT EXISTS acu_budgets (
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  month TEXT NOT NULL,
  budget_acu REAL NOT NULL,
  used_acu REAL NOT NULL DEFAULT 0,
  overage TEXT NOT NULL DEFAULT 'block',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id, month)
);
