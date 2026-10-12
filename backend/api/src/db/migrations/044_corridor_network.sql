-- Corridor network: the regulated money-movement posture that sits on top of the corridors, liquidity accounts,
-- ledger and settlement engine the platform already runs. Nothing here moves money by itself — every movement is
-- still a balanced posting through the ledger and every payout still leaves through an existing rail. These tables
-- hold the posture (which phase a corridor is in, under whose licence, with which rails and limits), the
-- counterparty side of settlement (positions, batches, prefunding), the ISO 20022 messages exchanged with a sponsor
-- bank, the daily safeguarding evidence an e-money issuer must keep, and the phase gates and open questions that
-- decide whether the next phase is funded at all.

-- A corridor's regulatory posture. `corridor_id` links to the operational corridor when one exists; a network
-- corridor may be declared before its operational twin.
CREATE TABLE IF NOT EXISTS network_corridors (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  source_country TEXT NOT NULL,
  dest_country TEXT NOT NULL,
  source_currency TEXT NOT NULL,
  dest_currency TEXT NOT NULL,
  settlement_currency TEXT NOT NULL,
  phase INTEGER NOT NULL DEFAULT 1,
  regulatory_mode TEXT NOT NULL DEFAULT 'non_custodial',
  licence_basis TEXT,
  principal_name TEXT,
  collection_rails TEXT NOT NULL DEFAULT '[]',
  payout_rails TEXT NOT NULL DEFAULT '[]',
  settlement_rails TEXT NOT NULL DEFAULT '[]',
  limits TEXT NOT NULL DEFAULT '{}',
  stablecoin_allowed INTEGER NOT NULL DEFAULT 0,
  papss_allowed INTEGER NOT NULL DEFAULT 0,
  corridor_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_network_corridors_status ON network_corridors(status, phase);

-- Who BitriPay owes, is owed by, or prefunds at: operators, banks, aggregators, a sponsor bank, a stablecoin
-- provider, an EMI principal. `payout_account_ids` links the existing liquidity payout accounts that carry the float.
CREATE TABLE IF NOT EXISTS network_counterparties (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  country TEXT,
  currencies TEXT NOT NULL DEFAULT '[]',
  settlement_window TEXT NOT NULL DEFAULT 'daily',
  exposure_limit_minor INTEGER NOT NULL DEFAULT 0,
  exposure_currency TEXT,
  safety_factor_bps INTEGER NOT NULL DEFAULT 15000,
  payout_account_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The counterparty sub-ledger: what a counterparty received for BitriPay (a collection it now owes) and what it paid
-- for BitriPay out of its own funds (a post-paid payout BitriPay now owes). Signed: positive is owed to BitriPay.
-- Prefunding is deliberately NOT here — placing BitriPay's own liquidity at a partner is a treasury movement on the
-- liquidity account, and counting it twice would make every position wrong.
CREATE TABLE IF NOT EXISTS network_counterparty_movements (
  id TEXT PRIMARY KEY,
  counterparty_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  window_key TEXT NOT NULL,
  reference TEXT,
  payment_id TEXT,
  statement_message_id TEXT,
  position_id TEXT,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(counterparty_id, currency, kind, reference)
);
CREATE INDEX IF NOT EXISTS idx_network_cp_movements_window ON network_counterparty_movements(counterparty_id, currency, window_key);

-- The net position with one counterparty, in one currency, for one settlement window.
CREATE TABLE IF NOT EXISTS network_positions (
  id TEXT PRIMARY KEY,
  counterparty_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  window_key TEXT NOT NULL,
  gross_in_minor INTEGER NOT NULL DEFAULT 0,
  gross_out_minor INTEGER NOT NULL DEFAULT 0,
  net_minor INTEGER NOT NULL DEFAULT 0,
  entry_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  batch_id TEXT,
  UNIQUE(counterparty_id, currency, window_key)
);
CREATE INDEX IF NOT EXISTS idx_network_positions_status ON network_positions(status, counterparty_id);

-- One settlement instruction per counterparty, currency and window. Four eyes: proposed by one administrator,
-- approved by another, then instructed on a settlement rail and reconciled against the counterparty's statement.
CREATE TABLE IF NOT EXISTS network_settlement_batches (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  counterparty_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  window_key TEXT NOT NULL,
  net_minor INTEGER NOT NULL,
  direction TEXT NOT NULL,
  rail TEXT NOT NULL,
  corridor_code TEXT,
  status TEXT NOT NULL DEFAULT 'proposed',
  external_ref TEXT,
  instruction_ref TEXT,
  message_id TEXT,
  failure_reason TEXT,
  created_by TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  instructed_at TEXT,
  confirmed_at TEXT,
  reconciled_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(counterparty_id, currency, window_key)
);
CREATE INDEX IF NOT EXISTS idx_network_batches_status ON network_settlement_batches(status, counterparty_id);

-- What the next horizon of payouts is expected to need at a counterparty, against what it holds now.
CREATE TABLE IF NOT EXISTS network_treasury_forecasts (
  id TEXT PRIMARY KEY,
  counterparty_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  horizon_hours INTEGER NOT NULL,
  lookback_days INTEGER NOT NULL,
  forecast_minor INTEGER NOT NULL,
  balance_minor INTEGER NOT NULL,
  safety_factor_bps INTEGER NOT NULL,
  required_minor INTEGER NOT NULL,
  shortfall_minor INTEGER NOT NULL,
  basis TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_network_forecasts_cp ON network_treasury_forecasts(counterparty_id, currency, created_at);

-- A prefunding top-up: proposed from a forecast, approved by a second administrator, executed as a prefund on the
-- liquidity account that carries the float.
CREATE TABLE IF NOT EXISTS network_treasury_topups (
  id TEXT PRIMARY KEY,
  counterparty_id TEXT NOT NULL,
  payout_account_id TEXT,
  currency TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  reason TEXT NOT NULL,
  forecast_id TEXT,
  proposed_by TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  executed_at TEXT,
  rejected_reason TEXT,
  movement_reference TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_network_topups_status ON network_treasury_topups(status, counterparty_id);

-- ISO 20022 messages built for, or imported from, a sponsor bank. Payload is the canonical XML; nothing is sent
-- from here — a file is exported and the answer is imported.
CREATE TABLE IF NOT EXISTS network_iso_messages (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  direction TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  batch_id TEXT,
  end_to_end_id TEXT,
  counterparty_id TEXT,
  currency TEXT,
  amount_minor INTEGER,
  status TEXT NOT NULL DEFAULT 'built',
  status_reason TEXT,
  file_name TEXT,
  payload TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  UNIQUE(kind, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_network_iso_batch ON network_iso_messages(batch_id, kind);

-- The daily safeguarding evidence: customer liability against safeguarded funds, internally and externally.
CREATE TABLE IF NOT EXISTS network_safeguarding_checks (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  currency TEXT NOT NULL,
  liability_minor INTEGER NOT NULL,
  safeguarded_minor INTEGER NOT NULL,
  external_minor INTEGER,
  shortfall_minor INTEGER NOT NULL DEFAULT 0,
  internal_ok INTEGER NOT NULL DEFAULT 0,
  external_ok INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  topped_up_minor INTEGER NOT NULL DEFAULT 0,
  topped_up_by TEXT,
  topped_up_at TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(day, currency)
);

-- The resolution pack an administrator could use to return customer funds, regenerated daily and hash-chained so a
-- regulator can see it was never edited afterwards.
CREATE TABLE IF NOT EXISTS network_resolution_packs (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL UNIQUE,
  hash TEXT NOT NULL,
  prev_hash TEXT,
  holder_count INTEGER NOT NULL,
  currencies TEXT NOT NULL DEFAULT '[]',
  totals TEXT NOT NULL DEFAULT '{}',
  content TEXT NOT NULL,
  generated_by TEXT,
  created_at TEXT NOT NULL
);

-- The gate a phase must pass before the next one is funded, and the measurement behind it.
CREATE TABLE IF NOT EXISTS network_gates (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  phase INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'gate',
  criterion TEXT NOT NULL,
  target TEXT NOT NULL,
  unit TEXT,
  measured TEXT,
  status TEXT NOT NULL DEFAULT 'not_started',
  evidence TEXT,
  owner TEXT,
  checked_by TEXT,
  checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_network_gates_phase ON network_gates(phase, kind);

-- The questions that must be answered before a phase is built, each with an owner and an answer of record.
CREATE TABLE IF NOT EXISTS network_questions (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  area TEXT NOT NULL,
  question TEXT NOT NULL,
  phase INTEGER NOT NULL DEFAULT 1,
  owner TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  answer TEXT,
  answered_by TEXT,
  answered_at TEXT,
  blocks TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_network_questions_status ON network_questions(status, phase);
