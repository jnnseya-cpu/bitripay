-- Payment lifecycle stages + immutable event log + evidence engine + maker-checker + controls
ALTER TABLE gateway_payments ADD COLUMN stage TEXT NOT NULL DEFAULT 'CREATED';
ALTER TABLE gateway_payments ADD COLUMN expires_at TEXT;
ALTER TABLE gateway_payments ADD COLUMN authenticated_at TEXT;
ALTER TABLE gateway_payments ADD COLUMN auth_method TEXT;
CREATE INDEX IF NOT EXISTS idx_gp_stage ON gateway_payments(stage, updated_at);

-- Append-only, hash-chained log of authentication, evidence, approval, ledger and lifecycle events.
CREATE TABLE IF NOT EXISTS event_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  stream TEXT NOT NULL,
  subject_id TEXT,
  event TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  prev_hash TEXT,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_subject ON event_log(stream, subject_id, seq);
CREATE TRIGGER IF NOT EXISTS event_log_no_update BEFORE UPDATE ON event_log BEGIN SELECT RAISE(ABORT, 'event_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS event_log_no_delete BEFORE DELETE ON event_log BEGIN SELECT RAISE(ABORT, 'event_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_logs_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_logs_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_entries_no_update BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger_entries is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_entries_no_delete BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger_entries is append-only'); END;

-- Devices allowed to submit signed SMS evidence (the SMS-forwarder app on a collection phone).
CREATE TABLE IF NOT EXISTS evidence_devices (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'ed25519',
  operator_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  risk_score INTEGER NOT NULL DEFAULT 0,
  registered_by TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  revoked_reason TEXT
);
CREATE TABLE IF NOT EXISTS evidence_nonces (
  device_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (device_id, nonce)
);
CREATE TABLE IF NOT EXISTS operator_parse_templates (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL DEFAULT '*',
  name TEXT NOT NULL,
  patterns TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_evidence (
  id TEXT PRIMARY KEY,
  payment_id TEXT,
  device_id TEXT,
  source TEXT NOT NULL,
  operator_id TEXT,
  sender TEXT,
  raw_text TEXT NOT NULL,
  raw_hash TEXT NOT NULL,
  received_at TEXT,
  parsed TEXT NOT NULL DEFAULT '{}',
  confidence INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL,
  reasons TEXT NOT NULL DEFAULT '[]',
  external_ref TEXT,
  nonce TEXT,
  signature TEXT,
  verifier_type TEXT,
  verifier_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_payment ON payment_evidence(payment_id, created_at);
CREATE INDEX IF NOT EXISTS idx_evidence_hash ON payment_evidence(raw_hash);
CREATE INDEX IF NOT EXISTS idx_evidence_extref ON payment_evidence(operator_id, external_ref);

-- Maker-checker for manual settlement decisions.
CREATE TABLE IF NOT EXISTS manual_verifications (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL,
  action TEXT NOT NULL,
  note TEXT,
  evidence_id TEXT,
  proposed_by TEXT NOT NULL,
  proposed_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  declined_by TEXT,
  declined_at TEXT,
  decline_reason TEXT,
  status TEXT NOT NULL DEFAULT 'proposed'
);
CREATE INDEX IF NOT EXISTS idx_mv_payment ON manual_verifications(payment_id, status);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER,
  response TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS fx_quotes (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  from_currency TEXT NOT NULL,
  to_currency TEXT NOT NULL,
  mid_rate REAL NOT NULL,
  rate REAL NOT NULL,
  markup_bps INTEGER NOT NULL,
  provider TEXT NOT NULL,
  rate_timestamp TEXT,
  guaranteed INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sanctions_entries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  normalized TEXT NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sanctions_norm ON sanctions_entries(kind, normalized);

CREATE TABLE IF NOT EXISTS risk_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  kind TEXT NOT NULL,
  score INTEGER NOT NULL,
  flags TEXT NOT NULL DEFAULT '[]',
  action TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_risk_user ON risk_events(user_id, created_at);
