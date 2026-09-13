-- Per-use metering for the command centres: disclosed prices, consent, and the billing record on every run.
CREATE TABLE IF NOT EXISTS agent_consents (
  user_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  accepted_at TEXT NOT NULL,
  price_snapshot TEXT NOT NULL,
  ip TEXT,
  PRIMARY KEY (user_id, version)
);
ALTER TABLE agent_runs ADD COLUMN billing TEXT;
