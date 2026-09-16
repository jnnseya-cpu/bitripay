-- Nothing external needs an API key: bill payments and mobile top-ups are executed from a payout SIM (USSD / operator
-- menu) and settle only on the operator's confirmation SMS, exactly like every other external movement; each row now
-- carries its payout instruction and moves processing → completed | failed. Outbound SMS (codes, receipts, notices)
-- can leave through an enrolled phone's own SIM instead of an SMS API: a queue the payout device drains. Additive.
ALTER TABLE bill_payments ADD COLUMN payout_id TEXT;
ALTER TABLE mobile_topups ADD COLUMN payout_id TEXT;

CREATE TABLE IF NOT EXISTS sms_outbox (
  id TEXT PRIMARY KEY,
  to_msisdn TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  device_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sms_outbox_status ON sms_outbox(status, created_at);
