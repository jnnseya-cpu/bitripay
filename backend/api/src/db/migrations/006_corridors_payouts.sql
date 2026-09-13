-- Corridor registry, prefunded liquidity, payout instructions, chargebacks, route lifecycle
ALTER TABLE money_routes ADD COLUMN stage TEXT NOT NULL DEFAULT 'CREATED';
ALTER TABLE money_routes ADD COLUMN quote TEXT NOT NULL DEFAULT '{}';
ALTER TABLE money_routes ADD COLUMN corridor_id TEXT;
ALTER TABLE money_routes ADD COLUMN payout_id TEXT;
ALTER TABLE money_routes ADD COLUMN expires_at TEXT;
ALTER TABLE money_routes ADD COLUMN source_of_funds TEXT;
CREATE INDEX IF NOT EXISTS idx_routes_stage ON money_routes(stage, updated_at);

ALTER TABLE evidence_devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'collection';
ALTER TABLE evidence_devices ADD COLUMN sim_msisdn TEXT;
ALTER TABLE evidence_devices ADD COLUMN sim_iccid TEXT;
ALTER TABLE evidence_devices ADD COLUMN agent_user_id TEXT;
ALTER TABLE evidence_devices ADD COLUMN payout_account_id TEXT;

ALTER TABLE payment_evidence ADD COLUMN direction TEXT NOT NULL DEFAULT 'in';
ALTER TABLE payment_evidence ADD COLUMN payout_id TEXT;
ALTER TABLE payment_evidence ADD COLUMN sim_identity TEXT;
ALTER TABLE payment_evidence ADD COLUMN operator_timestamp TEXT;
ALTER TABLE payment_evidence ADD COLUMN client_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_evidence_payout ON payment_evidence(payout_id, created_at);

ALTER TABLE manual_verifications ADD COLUMN subject_type TEXT NOT NULL DEFAULT 'payment';
ALTER TABLE manual_verifications ADD COLUMN external_ref TEXT;

CREATE TABLE IF NOT EXISTS corridors (
  id TEXT PRIMARY KEY,
  source_country TEXT,
  source_currency TEXT NOT NULL,
  dest_country TEXT NOT NULL,
  dest_currency TEXT NOT NULL,
  operator_id TEXT,
  rail TEXT NOT NULL DEFAULT 'mobile_money',
  status TEXT NOT NULL DEFAULT 'sandbox',
  collection_partner TEXT,
  payout_partner TEXT,
  licence_ref TEXT,
  approved_by TEXT,
  approved_at TEXT,
  estimated_payout_minutes INTEGER NOT NULL DEFAULT 60,
  max_amount INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_corridors_dest ON corridors(dest_country, operator_id, dest_currency);

CREATE TABLE IF NOT EXISTS payout_accounts (
  id TEXT PRIMARY KEY,
  rail TEXT NOT NULL,
  operator_id TEXT,
  country TEXT NOT NULL,
  currency TEXT NOT NULL,
  label TEXT NOT NULL,
  msisdn TEXT,
  sim_iccid TEXT,
  bank_name TEXT,
  account_number TEXT,
  system_user_id TEXT NOT NULL,
  agent_user_id TEXT,
  device_id TEXT,
  daily_limit INTEGER NOT NULL DEFAULT 0,
  per_tx_limit INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payout_accounts_op ON payout_accounts(rail, operator_id, currency, status);

CREATE TABLE IF NOT EXISTS liquidity_movements (
  id TEXT PRIMARY KEY,
  payout_account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  transaction_id TEXT,
  reference TEXT,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payout_instructions (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  route_id TEXT,
  transaction_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  corridor_id TEXT,
  payout_account_id TEXT,
  agent_user_id TEXT,
  rail TEXT NOT NULL,
  operator_id TEXT,
  recipient_msisdn TEXT,
  recipient_name TEXT,
  bank_details TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'QUEUED',
  claimed_by_device_id TEXT,
  claimed_by_user_id TEXT,
  claimed_at TEXT,
  evidence_id TEXT,
  external_ref TEXT,
  float_transaction_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  risk_flags TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payouts_stage ON payout_instructions(stage, payout_account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payouts_tx ON payout_instructions(transaction_id);

CREATE TABLE IF NOT EXISTS chargebacks (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL,
  route_id TEXT,
  provider_ref TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  payout_state_at_open TEXT,
  reversal_transaction_id TEXT,
  opened_by TEXT,
  opened_at TEXT NOT NULL,
  resolved_by TEXT,
  resolved_at TEXT,
  note TEXT
);
