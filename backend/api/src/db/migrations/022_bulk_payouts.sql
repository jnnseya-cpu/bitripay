-- Module 14: bulk payouts. A batch is uploaded (rows or CSV), validated row by row, approved under four-eyes or
-- step-up, and executed in order through the existing payout and transfer engines (one ledger transaction per row).
CREATE TABLE IF NOT EXISTS payout_batches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  reference TEXT,
  note TEXT,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
  row_count INTEGER NOT NULL DEFAULT 0,
  valid_rows INTEGER NOT NULL DEFAULT 0,
  invalid_rows INTEGER NOT NULL DEFAULT 0,
  paid_rows INTEGER NOT NULL DEFAULT 0,
  failed_rows INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL DEFAULT 0,
  fee_minor INTEGER NOT NULL DEFAULT 0,
  paid_minor INTEGER NOT NULL DEFAULT 0,
  skip_invalid INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_via TEXT NOT NULL DEFAULT 'session',
  approved_by TEXT,
  approved_at TEXT,
  approval_method TEXT,
  executed_at TEXT,
  cancelled_at TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_batches_idem ON payout_batches(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payout_batches_user ON payout_batches(user_id, created_at);

CREATE TABLE IF NOT EXISTS payout_batch_rows (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES payout_batches(id),
  line_no INTEGER NOT NULL,
  method TEXT NOT NULL,
  destination TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  fee_minor INTEGER NOT NULL DEFAULT 0,
  reference TEXT,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'VALID',
  error TEXT,
  transaction_id TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payout_batch_rows_batch ON payout_batch_rows(batch_id, line_no);
