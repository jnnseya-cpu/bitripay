-- Gateway contract: idempotency key hygiene, refund rejection, manual capture, FX quote amounts and asynchronous
-- sanctions screening of domestic payment intents.

-- Idempotency keys carry the endpoint they were used on and expire 24 hours after creation (purged lazily).
ALTER TABLE idempotency_keys ADD COLUMN endpoint TEXT;
ALTER TABLE idempotency_keys ADD COLUMN expires_at TEXT;
CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);

-- Refund lifecycle: a manual refund can be rejected by the merchant or operations.
ALTER TABLE refunds ADD COLUMN rejected_by TEXT;
ALTER TABLE refunds ADD COLUMN rejected_at TEXT;
ALTER TABLE refunds ADD COLUMN rejection_reason TEXT;

-- Manual capture: when the authorisation landed and how much of it was captured.
ALTER TABLE payment_intents ADD COLUMN authorised_at TEXT;
ALTER TABLE payment_intents ADD COLUMN captured_amount_minor INTEGER;

-- Locked FX quotes created through the partner API keep the amount they were quoted for.
ALTER TABLE fx_quotes ADD COLUMN amount_minor INTEGER;
ALTER TABLE fx_quotes ADD COLUMN fee_minor INTEGER;
ALTER TABLE fx_quotes ADD COLUMN recipient_minor INTEGER;

-- Domestic intents are screened asynchronously; cross-border intents are screened synchronously at creation.
CREATE TABLE IF NOT EXISTS sanctions_screenings (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'PENDING',
  hits TEXT,
  created_at TEXT NOT NULL,
  screened_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sanctions_screenings_status ON sanctions_screenings(status, created_at);
CREATE INDEX IF NOT EXISTS idx_sanctions_screenings_subject ON sanctions_screenings(subject_type, subject_id);
