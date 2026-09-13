-- Phase 5 financial operations: versioned fee schedules, settlement profiles and cycles, commission ledger,
-- disputes as objects, holds (balance classes), split payments.
CREATE TABLE IF NOT EXISTS fee_schedules (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  scope TEXT NOT NULL,
  scope_ref TEXT,
  rules TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  author_id TEXT,
  approved_by TEXT,
  approved_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fee_schedules_scope ON fee_schedules(scope, scope_ref, status);
ALTER TABLE users ADD COLUMN fee_tier TEXT;

CREATE TABLE IF NOT EXISTS settlement_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  rail TEXT NOT NULL DEFAULT 'default',
  currency TEXT NOT NULL,
  schedule TEXT NOT NULL DEFAULT 'T1',
  cutoff_hour_utc INTEGER NOT NULL DEFAULT 22,
  destination TEXT NOT NULL DEFAULT '{}',
  min_amount INTEGER NOT NULL DEFAULT 0,
  auto INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, rail, currency)
);

CREATE TABLE IF NOT EXISTS settlement_cycles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  profile_id TEXT,
  currency TEXT NOT NULL,
  rail TEXT NOT NULL DEFAULT 'default',
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  business_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  gross_minor INTEGER NOT NULL DEFAULT 0,
  fees_minor INTEGER NOT NULL DEFAULT 0,
  refunds_minor INTEGER NOT NULL DEFAULT 0,
  splits_minor INTEGER NOT NULL DEFAULT 0,
  holds_minor INTEGER NOT NULL DEFAULT 0,
  net_minor INTEGER NOT NULL DEFAULT 0,
  item_count INTEGER NOT NULL DEFAULT 0,
  due_at TEXT,
  withdrawal_transaction_id TEXT,
  settlement_id TEXT,
  hash TEXT,
  closed_at TEXT,
  paid_at TEXT,
  failure TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_settlement_cycles_user ON settlement_cycles(user_id, status, currency);

CREATE TABLE IF NOT EXISTS settlement_items (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL UNIQUE,
  intent_id TEXT,
  kind TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  fee_minor INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_settlement_items_cycle ON settlement_items(cycle_id);

CREATE TABLE IF NOT EXISTS commission_entries (
  id TEXT PRIMARY KEY,
  agent_user_id TEXT NOT NULL,
  transaction_id TEXT,
  kind TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  platform_share_minor INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREDITED',
  period TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commission_agent ON commission_entries(agent_user_id, period);

CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  merchant_user_id TEXT NOT NULL,
  customer_user_id TEXT,
  intent_id TEXT,
  transaction_id TEXT,
  gateway_payment_id TEXT,
  chargeback_id TEXT,
  switch_payment_id TEXT,
  opened_by TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason TEXT,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  rail TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  deadline_at TEXT NOT NULL,
  responsible_institution TEXT,
  evidence TEXT NOT NULL DEFAULT '[]',
  merchant_response TEXT,
  responded_at TEXT,
  decision TEXT,
  decision_reason TEXT,
  decided_by TEXT,
  decided_at TEXT,
  hold_id TEXT,
  refund_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_disputes_merchant ON disputes(merchant_user_id, status);
CREATE INDEX IF NOT EXISTS idx_disputes_tx ON disputes(transaction_id);

CREATE TABLE IF NOT EXISTS holds (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_by TEXT,
  released_by TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  released_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_holds_wallet ON holds(wallet_id, status);

CREATE TABLE IF NOT EXISTS split_payouts (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  source_transaction_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  label TEXT,
  transaction_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_split_payouts_intent ON split_payouts(intent_id);
