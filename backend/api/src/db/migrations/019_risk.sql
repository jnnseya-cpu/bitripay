-- Phase 6: risk, compliance and agent intelligence.
-- KYC tiers and business verification
ALTER TABLE users ADD COLUMN kyc_tier INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN kyb_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE users ADD COLUMN password_changed_at TEXT;
ALTER TABLE users ADD COLUMN trust_score INTEGER;
ALTER TABLE kyc_submissions ADD COLUMN proof_of_address TEXT;
ALTER TABLE kyc_submissions ADD COLUMN address_doc_date TEXT;
ALTER TABLE kyc_submissions ADD COLUMN requested_tier INTEGER NOT NULL DEFAULT 2;
ALTER TABLE kyc_submissions ADD COLUMN liveness INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS kyb_submissions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  legal_name TEXT NOT NULL,
  registration_number TEXT NOT NULL,
  country TEXT NOT NULL,
  address TEXT NOT NULL,
  mcc TEXT,
  expected_monthly_volume INTEGER NOT NULL DEFAULT 0,
  licence_ref TEXT,
  directors TEXT NOT NULL DEFAULT '[]',
  documents TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kyb_user ON kyb_submissions(user_id, created_at);

-- Central, versioned risk policy (rules evaluated in order; first match decides)
CREATE TABLE IF NOT EXISTS risk_policies (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  rules TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  author_id TEXT,
  approved_by TEXT,
  approved_at TEXT,
  activated_at TEXT,
  retired_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);

-- Fraud scores (every scored movement, with its factors and the decision)
CREATE TABLE IF NOT EXISTS fraud_scores (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  kind TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  base_minor INTEGER NOT NULL,
  score INTEGER NOT NULL,
  band TEXT NOT NULL,
  factors TEXT NOT NULL DEFAULT '[]',
  action TEXT NOT NULL,
  policy_rule TEXT,
  policy_id TEXT,
  device_hash TEXT,
  ip_country TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fraud_user ON fraud_scores(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_fraud_band ON fraud_scores(band, created_at);

-- Compliance cases (fraud blocks, AML findings, sanctions hits) with SAR drafts and audited decisions
CREATE TABLE IF NOT EXISTS compliance_cases (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  user_id TEXT,
  subject_type TEXT,
  subject_id TEXT,
  severity TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'OPEN',
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  indicators TEXT NOT NULL DEFAULT '[]',
  sar_draft TEXT,
  sar_reference TEXT,
  assigned_to TEXT,
  opened_by TEXT,
  decision TEXT,
  decision_reason TEXT,
  decided_by TEXT,
  decided_at TEXT,
  closed_by TEXT,
  closed_at TEXT,
  dedupe_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compliance_status ON compliance_cases(status, severity, created_at);
CREATE INDEX IF NOT EXISTS idx_compliance_user ON compliance_cases(user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_compliance_dedupe ON compliance_cases(dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Sanctions lists: named sources with versions (entries keep pointing at their source)
ALTER TABLE sanctions_entries ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE sanctions_entries ADD COLUMN external_id TEXT;
ALTER TABLE sanctions_entries ADD COLUMN list_version TEXT;
CREATE TABLE IF NOT EXISTS sanctions_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT,
  format TEXT NOT NULL DEFAULT 'csv',
  kind TEXT NOT NULL DEFAULT 'sanctions',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_version TEXT,
  last_count INTEGER,
  last_refreshed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);

-- Settlement-account change protection
CREATE TABLE IF NOT EXISTS destination_changes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref_id TEXT,
  previous TEXT,
  next TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'COOLING',
  risk_flags TEXT NOT NULL DEFAULT '[]',
  effective_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  revoked_by TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_destchange_user ON destination_changes(user_id, created_at);

-- Agent intelligence
CREATE TABLE IF NOT EXISTS agent_scores (
  id TEXT PRIMARY KEY,
  agent_user_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  band TEXT NOT NULL,
  factors TEXT NOT NULL DEFAULT '{}',
  commission_bonus_bps INTEGER NOT NULL DEFAULT 0,
  computed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_scores ON agent_scores(agent_user_id, computed_at);
CREATE TABLE IF NOT EXISTS float_requests (
  id TEXT PRIMARY KEY,
  agent_user_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  method TEXT NOT NULL,
  reference TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'REQUESTED',
  verification_id TEXT,
  handled_by TEXT,
  handled_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_float_requests ON float_requests(agent_user_id, status, created_at);
