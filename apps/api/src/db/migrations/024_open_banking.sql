-- Module 15: open banking. Linked bank accounts under consent, imported transactions, income verification,
-- variable recurring payment mandates (top-ups and billing) and the pay-by-bank payments they execute.
CREATE TABLE IF NOT EXISTS open_banking_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  institution_id TEXT NOT NULL,
  institution_name TEXT NOT NULL,
  country TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  provider_ref TEXT,
  consent_encrypted TEXT,
  consent_expires_at TEXT,
  accounts TEXT NOT NULL DEFAULT '[]',
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  linked_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ob_links_user ON open_banking_links(user_id, status);

CREATE TABLE IF NOT EXISTS open_banking_transactions (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES open_banking_links(id),
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  booked_at TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  description TEXT NOT NULL,
  counterparty TEXT,
  category TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(link_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_ob_tx_user ON open_banking_transactions(user_id, booked_at);

CREATE TABLE IF NOT EXISTS open_banking_income (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  monthly_income_base INTEGER NOT NULL,
  months_covered INTEGER NOT NULL,
  streams TEXT NOT NULL,
  confidence TEXT NOT NULL,
  computed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS open_banking_mandates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  link_id TEXT NOT NULL REFERENCES open_banking_links(id),
  account_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  purpose TEXT NOT NULL,
  max_per_payment_minor INTEGER NOT NULL,
  max_per_month_minor INTEGER NOT NULL,
  used_month TEXT,
  used_month_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  provider_ref TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ob_mandates_user ON open_banking_mandates(user_id, status);

CREATE TABLE IF NOT EXISTS open_banking_payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  mandate_id TEXT,
  gateway_payment_id TEXT,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_ref TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ob_payments_user ON open_banking_payments(user_id, created_at);
