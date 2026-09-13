CREATE TABLE IF NOT EXISTS p2p_ads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  side TEXT NOT NULL,
  currency TEXT NOT NULL,
  price_currency TEXT NOT NULL,
  rate REAL NOT NULL,
  min_amount INTEGER NOT NULL,
  max_amount INTEGER NOT NULL,
  available_amount INTEGER NOT NULL,
  payment_methods TEXT NOT NULL DEFAULT '["wallet"]',
  terms TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_p2p_ads_status ON p2p_ads(status, side, currency);

CREATE TABLE IF NOT EXISTS p2p_trades (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  ad_id TEXT NOT NULL,
  buyer_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  initiator_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  price_amount INTEGER NOT NULL,
  price_currency TEXT NOT NULL,
  rate REAL NOT NULL,
  payment_method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'negotiating',
  escrow_transaction_id TEXT,
  settlement_transaction_id TEXT,
  dispute_reason TEXT,
  resolved_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_p2p_trades_buyer ON p2p_trades(buyer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_p2p_trades_seller ON p2p_trades(seller_id, created_at);

CREATE TABLE IF NOT EXISTS p2p_offers (
  id TEXT PRIMARY KEY,
  trade_id TEXT NOT NULL,
  from_user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  rate REAL NOT NULL,
  price_amount INTEGER NOT NULL,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS p2p_messages (
  id TEXT PRIMARY KEY,
  trade_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_p2p_msgs ON p2p_messages(trade_id, created_at);
