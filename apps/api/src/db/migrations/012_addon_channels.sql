-- Paid add-on for the command centres and the feature-phone channels (USSD, SMS).
CREATE TABLE IF NOT EXISTS agent_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  currency TEXT NOT NULL,
  amount INTEGER NOT NULL,
  period_days INTEGER NOT NULL,
  auto_renew INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  cancelled_at TEXT,
  last_transaction_id TEXT,
  renewals INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_subscriptions_user ON agent_subscriptions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_subscriptions_expiry ON agent_subscriptions(status, expires_at);

CREATE TABLE IF NOT EXISTS ussd_sessions (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'generic',
  inputs TEXT NOT NULL DEFAULT '[]',
  last_response TEXT,
  ended INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ussd_sessions_phone ON ussd_sessions(phone, updated_at);

CREATE TABLE IF NOT EXISTS channel_messages (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  direction TEXT NOT NULL,
  phone TEXT NOT NULL,
  body TEXT NOT NULL,
  user_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channel_messages_phone ON channel_messages(phone, created_at);
