-- Regulated e-money model: issuer programmes, safeguarded reserves, distribution pools, reconciliation,
-- promotional credit kept apart from money, wallet freezes, statements, recipient currency choice.

CREATE TABLE IF NOT EXISTS emoney_programmes (
  id TEXT PRIMARY KEY,
  currency TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,
  issuer_model TEXT NOT NULL DEFAULT 'sandbox',          -- own_authorisation | partner_issuer | sandbox
  issuer_name TEXT,
  licence_ref TEXT,
  regulator TEXT,
  safeguarding_bank TEXT,
  safeguarding_account_ref TEXT,
  status TEXT NOT NULL DEFAULT 'sandbox',                -- sandbox | live | suspended
  suspended_reason TEXT,
  reserved_exposure INTEGER NOT NULL DEFAULT 0,
  limits TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(currency, jurisdiction)
);

CREATE TABLE IF NOT EXISTS reserve_movements (
  id TEXT PRIMARY KEY,
  programme_id TEXT NOT NULL REFERENCES emoney_programmes(id),
  kind TEXT NOT NULL,            -- funding | redemption | liquidity_transfer | processor_settlement | adjustment
  direction TEXT NOT NULL,       -- in | out
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,          -- pending | cleared | reversed
  reference TEXT,
  evidence TEXT,
  proposed_by TEXT,
  cleared_by TEXT,
  verification_id TEXT,
  transaction_id TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  cleared_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reserve_movements_programme ON reserve_movements(programme_id, status);

CREATE TABLE IF NOT EXISTS distribution_pools (
  id TEXT PRIMARY KEY,
  programme_id TEXT NOT NULL REFERENCES emoney_programmes(id),
  name TEXT NOT NULL,
  level TEXT NOT NULL,           -- country | institution | master_agent | agent | merchant
  parent_id TEXT,
  owner_user_id TEXT,
  country TEXT,
  currency TEXT NOT NULL,
  wallet_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  limits TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reserve_reconciliations (
  id TEXT PRIMARY KEY,
  programme_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  cleared_reserves INTEGER NOT NULL,
  pending_inflows INTEGER NOT NULL,
  pending_redemptions INTEGER NOT NULL,
  reserved_exposure INTEGER NOT NULL,
  liabilities INTEGER NOT NULL,
  pool_balances INTEGER NOT NULL,
  payout_float INTEGER NOT NULL,
  headroom INTEGER NOT NULL,
  status TEXT NOT NULL,          -- ok | warning | breach
  details TEXT,
  run_by TEXT,
  created_at TEXT NOT NULL
);

ALTER TABLE wallets ADD COLUMN promo_balance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wallets ADD COLUMN frozen_at TEXT;
ALTER TABLE wallets ADD COLUMN frozen_reason TEXT;
ALTER TABLE wallets ADD COLUMN frozen_by TEXT;

CREATE TABLE IF NOT EXISTS promo_credits (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount INTEGER NOT NULL,
  remaining INTEGER NOT NULL,
  programme TEXT NOT NULL,
  reason TEXT,
  reference_id TEXT,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',   -- active | used | expired | revoked
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_promo_credits_user ON promo_credits(user_id, status);

CREATE TABLE IF NOT EXISTS statements (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  opening_balance INTEGER NOT NULL,
  closing_balance INTEGER NOT NULL,
  entry_count INTEGER NOT NULL,
  hash TEXT NOT NULL,
  generated_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_statements_user ON statements(user_id, created_at);

ALTER TABLE corridors ADD COLUMN payout_currencies TEXT NOT NULL DEFAULT '[]';
ALTER TABLE corridors ADD COLUMN beneficiary_consent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE corridors ADD COLUMN payout_confirmation TEXT;

ALTER TABLE money_routes ADD COLUMN consent_token TEXT;
ALTER TABLE money_routes ADD COLUMN consent_confirmed_at TEXT;
ALTER TABLE money_routes ADD COLUMN confirmation_method TEXT;
ALTER TABLE money_routes ADD COLUMN currency_options TEXT;

-- Lifecycle stage names aligned with the consolidated requirement.
UPDATE money_routes SET stage = 'FUNDED' WHERE stage = 'FUNDED';
UPDATE money_routes SET stage = 'PAYOUT_ROUTED' WHERE stage = 'PAYOUT_ROUTED';
UPDATE money_routes SET stage = 'PAYOUT_SENT' WHERE stage = 'PAYOUT_SENT';
UPDATE money_routes SET stage = 'INSUFFICIENT_LIQUIDITY' WHERE stage = 'INSUFFICIENT_LIQUIDITY';
UPDATE payout_instructions SET stage = 'INSUFFICIENT_LIQUIDITY' WHERE stage = 'INSUFFICIENT_LIQUIDITY';

-- Loud (sound + vibration) alerts for money events, per user; on by default.
ALTER TABLE users ADD COLUMN loud_alerts INTEGER NOT NULL DEFAULT 1;
