-- Operations: service-level objectives (per-route-class latency roll-ups), API operations counters and the SLA register.

-- Per-minute roll-up of the in-memory latency ring buffers (middleware/slo.ts): one row per route class and minute.
CREATE TABLE IF NOT EXISTS slo_samples (
  class TEXT NOT NULL,
  minute TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  p50_ms REAL,
  p95_ms REAL,
  p99_ms REAL,
  errors INTEGER NOT NULL DEFAULT 0,
  client_errors INTEGER NOT NULL DEFAULT 0,
  rate_limited INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (class, minute)
);
CREATE INDEX IF NOT EXISTS idx_slo_samples_minute ON slo_samples(minute);

-- Requests per API key and minute (only when the request authenticated with an API key).
CREATE TABLE IF NOT EXISTS slo_api_usage (
  api_key_id TEXT NOT NULL,
  minute TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  rate_limited INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (api_key_id, minute)
);
CREATE INDEX IF NOT EXISTS idx_slo_api_usage_minute ON slo_api_usage(minute);

-- Error codes (the `error.code` of every non-2xx JSON response) per minute, for the API operations view.
CREATE TABLE IF NOT EXISTS slo_error_codes (
  code TEXT NOT NULL,
  minute TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (code, minute)
);

-- SLA register: what every counterparty (processor, operator, switch, bank, vendor) has committed to, who to call, and when it is reviewed.
CREATE TABLE IF NOT EXISTS sla_register (
  id TEXT PRIMARY KEY,
  counterparty TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('processor', 'operator', 'switch', 'bank', 'vendor')),
  service TEXT NOT NULL,
  rail_id TEXT,
  availability_target REAL,
  latency_target_ms INTEGER,
  support_contact TEXT,
  escalation_contact TEXT,
  maintenance_window TEXT,
  incident_contact TEXT,
  review_date TEXT,
  document_ref TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sla_register_rail ON sla_register(rail_id);
