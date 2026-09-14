-- Offline payment lifecycle (specification §28): counter-gap evidence per payer device.
CREATE TABLE IF NOT EXISTS offline_counter_gaps (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  expected_counter INTEGER NOT NULL,
  received_counter INTEGER NOT NULL,
  promise_hash TEXT NOT NULL,
  detected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_offline_counter_gaps_device ON offline_counter_gaps(device_id, detected_at);
