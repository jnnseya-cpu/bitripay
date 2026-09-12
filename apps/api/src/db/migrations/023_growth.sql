-- Modules 11 (FX alerts, auto-convert, forwards), 13 (credit readiness) and 16 (merchant subscriptions and billing)
CREATE TABLE IF NOT EXISTS fx_alerts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  base_currency TEXT NOT NULL,
  quote_currency TEXT NOT NULL,
  direction TEXT NOT NULL,
  target_rate REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  note TEXT,
  triggered_at TEXT,
  triggered_rate REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fx_alerts_user ON fx_alerts(user_id, status);

CREATE TABLE IF NOT EXISTS fx_auto_rules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  from_currency TEXT NOT NULL,
  to_currency TEXT NOT NULL,
  kind TEXT NOT NULL,
  share_bps INTEGER NOT NULL DEFAULT 10000,
  keep_minor INTEGER NOT NULL DEFAULT 0,
  min_rate REAL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  runs INTEGER NOT NULL DEFAULT 0,
  converted_minor INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fx_auto_rules_user ON fx_auto_rules(user_id, status);

CREATE TABLE IF NOT EXISTS fx_forwards (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  from_currency TEXT NOT NULL,
  to_currency TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  receive_minor INTEGER NOT NULL,
  rate REAL NOT NULL,
  mid_rate REAL NOT NULL,
  margin_bps INTEGER NOT NULL,
  forward_bps INTEGER NOT NULL,
  settle_on TEXT NOT NULL,
  expires_on TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'LOCKED',
  hold_id TEXT,
  transaction_id TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_fx_forwards_user ON fx_forwards(user_id, status);

CREATE TABLE IF NOT EXISTS credit_readiness (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  score INTEGER NOT NULL,
  band TEXT NOT NULL,
  signals TEXT NOT NULL,
  tips TEXT NOT NULL,
  computed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS credit_consents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  lender_name TEXT NOT NULL,
  purpose TEXT,
  access_code TEXT NOT NULL UNIQUE,
  granted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_accessed_at TEXT,
  access_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_credit_consents_user ON credit_consents(user_id);

CREATE TABLE IF NOT EXISTS merchant_plans (
  id TEXT PRIMARY KEY,
  merchant_user_id TEXT NOT NULL REFERENCES users(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  currency TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  interval TEXT NOT NULL,
  interval_count INTEGER NOT NULL DEFAULT 1,
  trial_days INTEGER NOT NULL DEFAULT 0,
  tax_bps INTEGER NOT NULL DEFAULT 0,
  tax_label TEXT,
  usage_unit TEXT,
  usage_price_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_merchant_plans_merchant ON merchant_plans(merchant_user_id, status);

CREATE TABLE IF NOT EXISTS merchant_subscriptions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES merchant_plans(id),
  merchant_user_id TEXT NOT NULL REFERENCES users(id),
  customer_user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  current_period_start TEXT NOT NULL,
  current_period_end TEXT NOT NULL,
  next_charge_at TEXT NOT NULL,
  mandate_confirmed_at TEXT NOT NULL,
  usage_qty INTEGER NOT NULL DEFAULT 0,
  dunning_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  cancelled_at TEXT,
  ended_at TEXT,
  reference TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_merchant_subscriptions_due ON merchant_subscriptions(status, next_charge_at);
CREATE INDEX IF NOT EXISTS idx_merchant_subscriptions_customer ON merchant_subscriptions(customer_user_id);
CREATE INDEX IF NOT EXISTS idx_merchant_subscriptions_merchant ON merchant_subscriptions(merchant_user_id);

CREATE TABLE IF NOT EXISTS merchant_invoices (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES merchant_subscriptions(id),
  merchant_user_id TEXT NOT NULL,
  customer_user_id TEXT NOT NULL,
  number TEXT NOT NULL UNIQUE,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  currency TEXT NOT NULL,
  subtotal_minor INTEGER NOT NULL,
  usage_qty INTEGER NOT NULL DEFAULT 0,
  usage_minor INTEGER NOT NULL DEFAULT 0,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  transaction_id TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_merchant_invoices_sub ON merchant_invoices(subscription_id, created_at);
CREATE INDEX IF NOT EXISTS idx_merchant_invoices_due ON merchant_invoices(status, next_attempt_at);
