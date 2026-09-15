-- Aggregation fees on national-switch payments: accrued per completed payment (never a ledger posting on the
-- payment itself), invoiced per period and per currency, paid from the merchant's wallet or recorded by an administrator.
CREATE TABLE IF NOT EXISTS switch_fee_entries (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL UNIQUE,
  merchant_user_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  bps INTEGER NOT NULL,
  fixed_minor INTEGER NOT NULL DEFAULT 0,
  base_minor INTEGER NOT NULL,
  period TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accrued',
  invoice_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_switch_fee_entries_merchant ON switch_fee_entries(merchant_user_id, period, status);
CREATE TABLE IF NOT EXISTS switch_fee_invoices (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  merchant_user_id TEXT NOT NULL,
  period TEXT NOT NULL,
  currency TEXT NOT NULL,
  total_minor INTEGER NOT NULL,
  entry_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  paid_transaction_id TEXT,
  paid_reference TEXT,
  paid_by TEXT,
  paid_at TEXT,
  void_reason TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(merchant_user_id, period, currency)
);
