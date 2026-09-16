-- Sign-out revokes the one token in hand: its session id (JWT jti) is kept here until the token would have expired
-- anyway, and the authentication middleware refuses it. "Sign out everywhere" keeps using users.sessions_invalidated_at.
CREATE TABLE IF NOT EXISTS revoked_sessions (
  jti TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  revoked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revoked_sessions_expires ON revoked_sessions(expires_at);
