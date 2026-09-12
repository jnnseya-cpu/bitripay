-- Revocable sessions for BitriPay Lite (no-JavaScript web): the cookie holds only an opaque id.
CREATE TABLE IF NOT EXISTS lite_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_lite_sessions_user ON lite_sessions(user_id, expires_at);
