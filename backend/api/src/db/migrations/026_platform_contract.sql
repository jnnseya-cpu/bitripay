-- Platform contract: connector maintenance flag, 15-minute Smart Route statistics keyed by amount band and
-- MSISDN/BIN prefix (with latency samples for p95 and Smart-Route-vs-default counters for the uplift metric),
-- correlation ids on the audit trail, and the prompt hash of every agent run.

-- Administrator-set maintenance flag per rail (connector health state MAINTENANCE).
CREATE TABLE IF NOT EXISTS rail_maintenance (
  rail_id TEXT PRIMARY KEY,
  reason TEXT,
  set_by TEXT,
  set_at TEXT NOT NULL
);

-- routing_stats gains two key columns (amount_band, prefix). SQLite cannot widen a primary key in place, so the
-- table is rebuilt with the wider key and every existing row is carried over under the default band/prefix.
CREATE TABLE IF NOT EXISTS routing_stats_v2 (
  connector TEXT NOT NULL,
  method TEXT NOT NULL,
  bucket TEXT NOT NULL,
  amount_band TEXT NOT NULL DEFAULT '',
  prefix TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  unknowns INTEGER NOT NULL DEFAULT 0,
  declines INTEGER NOT NULL DEFAULT 0,
  latency_sum_ms INTEGER NOT NULL DEFAULT 0,
  latency_max_ms INTEGER NOT NULL DEFAULT 0,
  -- JSON array of the latest latency samples of the bucket (capped), used for the p95.
  latency_samples TEXT NOT NULL DEFAULT '[]',
  -- Outcomes of attempts where Smart Route's choice differed from / equalled the static default rail (uplift metric).
  smart_attempts INTEGER NOT NULL DEFAULT 0,
  smart_successes INTEGER NOT NULL DEFAULT 0,
  default_attempts INTEGER NOT NULL DEFAULT 0,
  default_successes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (connector, method, bucket, amount_band, prefix)
);
INSERT INTO routing_stats_v2 (connector, method, bucket, attempts, successes, failures, unknowns, declines, latency_sum_ms, latency_max_ms)
  SELECT connector, method, bucket, attempts, successes, failures, unknowns, declines, latency_sum_ms, latency_max_ms FROM routing_stats;
DROP TABLE routing_stats;
ALTER TABLE routing_stats_v2 RENAME TO routing_stats;
CREATE INDEX IF NOT EXISTS idx_routing_stats_bucket ON routing_stats(bucket);

-- Audit trail: correlation id, client address, device and outcome of every audited action.
ALTER TABLE audit_logs ADD COLUMN correlation_id TEXT;
ALTER TABLE audit_logs ADD COLUMN ip TEXT;
ALTER TABLE audit_logs ADD COLUMN device TEXT;
ALTER TABLE audit_logs ADD COLUMN result TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE audit_logs ADD COLUMN reason TEXT;
CREATE INDEX IF NOT EXISTS idx_audit_logs_correlation ON audit_logs(correlation_id);

-- Agent runs: sha256 of the composed system prompt and tool list the run was executed with.
ALTER TABLE agent_runs ADD COLUMN prompt_hash TEXT;
