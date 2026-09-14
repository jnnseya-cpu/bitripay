-- Communication event engine: one delivery log for every event × channel × recipient, and per-user opt-outs by
-- category and channel (mandatory notices ignore them). Everything here is additive.

CREATE TABLE IF NOT EXISTS comms_deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  category TEXT NOT NULL,
  channel TEXT NOT NULL,
  user_id TEXT,
  recipient TEXT,
  subject TEXT,
  status TEXT NOT NULL,
  via TEXT,
  error TEXT,
  mandatory INTEGER NOT NULL DEFAULT 0,
  test INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comms_deliveries_created ON comms_deliveries(created_at);
CREATE INDEX IF NOT EXISTS idx_comms_deliveries_event ON comms_deliveries(event_id, channel);
CREATE INDEX IF NOT EXISTS idx_comms_deliveries_user ON comms_deliveries(user_id, created_at);

ALTER TABLE users ADD COLUMN comms_prefs TEXT NOT NULL DEFAULT '{}';
