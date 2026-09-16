-- Built-in webhook receiver (developer portal "Webhook inbox"): every delivery a merchant points at its inbox URL is
-- stored with its headers and the result of both signature checks, so a developer sees real deliveries without an
-- external site. One inbox per merchant account.
CREATE TABLE IF NOT EXISTS webhook_inbox_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint_id TEXT,
  delivery_id TEXT,
  event_type TEXT,
  headers TEXT NOT NULL,
  body TEXT NOT NULL,
  hmac_valid INTEGER,
  ed25519_valid INTEGER,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wh_inbox_user ON webhook_inbox_messages(user_id, received_at);
ALTER TABLE users ADD COLUMN webhook_inbox_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_webhook_inbox ON users(webhook_inbox_id);
