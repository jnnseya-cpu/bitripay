-- Phase 4: rail registry telemetry, Smart Route statistics and circuit breakers; the BitriPay National Switch Gateway
-- (participants, route policies, connections with certification gate, switch payments with separate truth
-- dimensions, attempts, inbox/outbox, consent evidence, beneficiary bindings, linked operations, evidence vault,
-- message catalogue, reconciliation imports/lines/runs/cases, dispatcher lease with fencing, DR exercises).

-- Rail telemetry: one row per connector × method × hour bucket.
CREATE TABLE IF NOT EXISTS routing_stats (
  connector TEXT NOT NULL,
  method TEXT NOT NULL,
  bucket TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  unknowns INTEGER NOT NULL DEFAULT 0,
  declines INTEGER NOT NULL DEFAULT 0,
  latency_sum_ms INTEGER NOT NULL DEFAULT 0,
  latency_max_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (connector, method, bucket)
);
CREATE TABLE IF NOT EXISTS connector_state (
  connector TEXT PRIMARY KEY,
  circuit TEXT NOT NULL DEFAULT 'closed',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  opened_at TEXT,
  half_open_at TEXT,
  paused_by TEXT,
  paused_reason TEXT,
  last_probe TEXT,
  updated_at TEXT NOT NULL
);

-- CMP-06 participant registry (official codes, services, validity; author distinct from approver).
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  country TEXT NOT NULL,
  currencies TEXT NOT NULL DEFAULT '[]',
  services TEXT NOT NULL DEFAULT '[]',
  channels TEXT NOT NULL DEFAULT '["api","qr"]',
  routing_ids TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'PENDING',
  source TEXT NOT NULL DEFAULT 'SIMULATION',
  evidence_ref TEXT,
  valid_from TEXT,
  valid_to TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  author_id TEXT,
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_participants_country ON participants(country, status);

-- Pair capability tests: a service is open for (debtor, creditor, currency, product, channel) only after its pair test.
CREATE TABLE IF NOT EXISTS participant_pairs (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  debtor_id TEXT NOT NULL,
  creditor_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  product TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'api',
  status TEXT NOT NULL DEFAULT 'UNTESTED',
  tested_at TEXT,
  evidence_ref TEXT,
  valid_from TEXT,
  valid_to TEXT,
  author_id TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (connection_id, debtor_id, creditor_id, currency, product, channel)
);

-- Route policy versions (approved, immutable once active) and the future exception registry (RTE-004).
CREATE TABLE IF NOT EXISTS route_policies (
  version INTEGER PRIMARY KEY AUTOINCREMENT,
  country TEXT NOT NULL,
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
CREATE TABLE IF NOT EXISTS routing_exceptions (
  id TEXT PRIMARY KEY,
  country TEXT NOT NULL,
  scope TEXT NOT NULL,
  products TEXT NOT NULL DEFAULT '[]',
  participants TEXT NOT NULL DEFAULT '[]',
  currency TEXT,
  document_ref TEXT NOT NULL,
  document_sha256 TEXT,
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  author_id TEXT NOT NULL,
  first_approver_id TEXT,
  second_approver_id TEXT,
  signature TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Switch connections (one per scheme/country): access mode, adapter, certification gate, certificate inventory.
CREATE TABLE IF NOT EXISTS switch_connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  scheme_id TEXT NOT NULL,
  access_mode TEXT NOT NULL DEFAULT 'DIRECT',
  participant_id TEXT,
  sponsor_id TEXT,
  adapter TEXT NOT NULL DEFAULT 'simulator',
  environment TEXT NOT NULL DEFAULT 'simulation',
  profile_version TEXT,
  certification TEXT NOT NULL DEFAULT '{"status":"NOT_STARTED"}',
  certificate TEXT NOT NULL DEFAULT '{}',
  endpoint_enc TEXT,
  quota_per_second INTEGER NOT NULL DEFAULT 20,
  inquiry_reserve_pct INTEGER NOT NULL DEFAULT 25,
  enabled INTEGER NOT NULL DEFAULT 0,
  health TEXT NOT NULL DEFAULT '{}',
  link_state TEXT NOT NULL DEFAULT 'DOWN',
  simulator_scenarios TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Beneficiary bindings: merchant ↔ institution account, verified, versioned, immutable per payment.
CREATE TABLE IF NOT EXISTS beneficiary_bindings (
  id TEXT PRIMARY KEY,
  merchant_user_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  account_token TEXT NOT NULL,
  account_masked TEXT NOT NULL,
  account_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  verification TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  requested_by TEXT,
  approved_by TEXT,
  approved_at TEXT,
  replaces_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bindings_merchant ON beneficiary_bindings(merchant_user_id, status);

-- Consent evidence: proof that the payer authorised this amount to this beneficiary (audience-bound, expiring).
CREATE TABLE IF NOT EXISTS consent_evidence (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  participant_id TEXT NOT NULL,
  audience TEXT NOT NULL,
  merchant_user_id TEXT NOT NULL,
  beneficiary_binding_id TEXT,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  account_token TEXT,
  proof_hash TEXT NOT NULL,
  payment_id TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

-- Switch payments (the dossier's `payments`), linked one-to-one to a platform payment intent.
CREATE TABLE IF NOT EXISTS switch_payments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  merchant_user_id TEXT NOT NULL,
  api_client_id TEXT,
  merchant_order_id TEXT NOT NULL,
  product TEXT NOT NULL,
  intent_id TEXT,
  connection_id TEXT,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  payer_participant_id TEXT NOT NULL,
  payer_account_token TEXT,
  beneficiary_binding_id TEXT NOT NULL,
  beneficiary_binding_version INTEGER NOT NULL,
  consent_reference TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'RECEIVED',
  state_version INTEGER NOT NULL DEFAULT 1,
  authorization_status TEXT NOT NULL DEFAULT 'NOT_OBSERVED',
  beneficiary_credit_status TEXT NOT NULL DEFAULT 'NOT_OBSERVED',
  settlement_status TEXT NOT NULL DEFAULT 'NOT_OBSERVED',
  reconciliation_status TEXT NOT NULL DEFAULT 'NOT_DUE',
  resolution_status TEXT NOT NULL DEFAULT 'NONE',
  route TEXT NOT NULL DEFAULT '{}',
  external_message_id TEXT,
  external_reference TEXT,
  switch_correlation_id TEXT,
  rejection TEXT,
  expires_at TEXT NOT NULL,
  dispatched_at TEXT,
  completed_at TEXT,
  fingerprint TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, merchant_user_id, merchant_order_id)
);
CREATE INDEX IF NOT EXISTS idx_switch_payments_status ON switch_payments(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_switch_payments_merchant ON switch_payments(merchant_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_switch_payments_ext ON switch_payments(external_message_id);

-- Financial idempotency tombstones (never released by TTL).
CREATE TABLE IF NOT EXISTS switch_idempotency (
  tenant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  resource_id TEXT,
  status TEXT NOT NULL DEFAULT 'RESERVED',
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, operation, key)
);

CREATE TABLE IF NOT EXISTS switch_attempts (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'SUBMIT',
  stable_message_id TEXT NOT NULL UNIQUE,
  access_mode TEXT NOT NULL,
  participant_id TEXT,
  sponsor_id TEXT,
  fencing_token INTEGER,
  emission_possible INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT,
  responded_at TEXT,
  observation TEXT,
  codec_version TEXT,
  status TEXT NOT NULL DEFAULT 'PREPARED',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_switch_attempts_payment ON switch_attempts(payment_id, seq);

CREATE TABLE IF NOT EXISTS switch_events (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  state_version INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  proof_ref TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (payment_id, seq)
);

-- Observation journal (13.1): facts observed, never balances.
CREATE TABLE IF NOT EXISTS switch_journal (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL,
  fact TEXT NOT NULL,
  amount_minor INTEGER,
  currency TEXT,
  source TEXT NOT NULL,
  reference TEXT,
  proof_ref TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_switch_journal_payment ON switch_journal(payment_id);

CREATE TABLE IF NOT EXISTS inbox_messages (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  source TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  payment_id TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  quarantine INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  payload TEXT NOT NULL,
  proof_ref TEXT,
  occurred_at TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  UNIQUE (connection_id, source, external_message_id)
);

CREATE TABLE IF NOT EXISTS outbox_messages (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payment_id TEXT,
  connection_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  available_at TEXT NOT NULL,
  lease_until TEXT,
  lease_owner TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  last_error TEXT,
  delivered_at TEXT,
  dead INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox_messages(delivered_at, dead, available_at);

-- Dispatcher lease with a monotonic fencing token: an old leader cannot emit after another was promoted.
CREATE TABLE IF NOT EXISTS dispatcher_lease (
  name TEXT PRIMARY KEY,
  owner TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS linked_operations (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'RESERVED',
  reason TEXT,
  idem_key TEXT,
  stable_message_id TEXT,
  external_reference TEXT,
  observation TEXT,
  requested_by TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_linked_ops_payment ON linked_operations(payment_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_linked_ops_idem ON linked_operations(payment_id, idem_key);

CREATE TABLE IF NOT EXISTS message_catalogue (
  id TEXT PRIMARY KEY,
  product TEXT NOT NULL,
  external_code TEXT NOT NULL,
  phase TEXT NOT NULL,
  meaning TEXT NOT NULL,
  finality TEXT NOT NULL,
  minimum_proof TEXT NOT NULL,
  authority TEXT NOT NULL,
  transition TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'SIMULATION',
  created_at TEXT NOT NULL,
  UNIQUE (product, external_code, version)
);

-- Append-only evidence vault: raw bytes needed for investigation, encrypted, separate from technical logs.
CREATE TABLE IF NOT EXISTS evidence_vault (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject_id TEXT,
  sha256 TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vault_subject ON evidence_vault(subject_id);

CREATE TABLE IF NOT EXISTS reconciliation_imports (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  source TEXT NOT NULL,
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  cycle_ref TEXT NOT NULL,
  currency TEXT NOT NULL,
  checksum TEXT NOT NULL,
  line_count INTEGER NOT NULL,
  control_total INTEGER NOT NULL,
  replaces_import_id TEXT,
  imported_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (connection_id, source, cycle_ref, checksum)
);
CREATE TABLE IF NOT EXISTS reconciliation_lines (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL,
  external_reference TEXT NOT NULL,
  correlation_id TEXT,
  debtor_id TEXT,
  creditor_id TEXT,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  fee_minor INTEGER,
  settlement_ref TEXT,
  business_date TEXT,
  occurred_at TEXT,
  matched_payment_id TEXT,
  raw TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_recon_lines_import ON reconciliation_lines(import_id);
CREATE INDEX IF NOT EXISTS idx_recon_lines_ref ON reconciliation_lines(external_reference);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  cycle_ref TEXT NOT NULL,
  coverage TEXT NOT NULL,
  totals TEXT NOT NULL,
  matched INTEGER NOT NULL DEFAULT 0,
  cases_opened INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0,
  run_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reconciliation_cases (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  class TEXT NOT NULL,
  payment_id TEXT,
  line_id TEXT,
  run_id TEXT,
  cycle_ref TEXT,
  exposure_minor INTEGER NOT NULL DEFAULT 0,
  currency TEXT,
  references_json TEXT NOT NULL DEFAULT '{}',
  sources TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'OPEN',
  priority TEXT NOT NULL DEFAULT 'NORMAL',
  owner_id TEXT,
  next_action TEXT,
  due_at TEXT,
  documents TEXT NOT NULL DEFAULT '[]',
  resolution TEXT,
  resolved_by TEXT,
  closure_approved_by TEXT,
  merchant_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recon_cases_status ON reconciliation_cases(status, class);
CREATE INDEX IF NOT EXISTS idx_recon_cases_payment ON reconciliation_cases(payment_id);

CREATE TABLE IF NOT EXISTS dr_exercises (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  outcome TEXT NOT NULL,
  rto_minutes INTEGER,
  rpo_seconds INTEGER,
  checklist TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  run_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  subject_type TEXT,
  subject_id TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN',
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);
