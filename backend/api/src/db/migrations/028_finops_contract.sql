-- Financial operations contract: settlement currency vs collection currency (with the disclosed conversion posted
-- through the ledger), separate provider fee / BitriPay fee / tax lines on every settlement item and cycle, and the
-- allocation of refunds back across split recipients. Everything is additive: existing columns keep their meaning.

-- Settlement profiles: the currency the merchant is paid in may differ from the currency collected.
ALTER TABLE settlement_profiles ADD COLUMN settlement_currency TEXT;
ALTER TABLE settlement_profiles ADD COLUMN auto_convert INTEGER NOT NULL DEFAULT 0;

-- Cycles: fee lines broken out (fees_minor stays the total deducted) and the settlement-currency obligation.
ALTER TABLE settlement_cycles ADD COLUMN provider_fees_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settlement_cycles ADD COLUMN platform_fees_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settlement_cycles ADD COLUMN fee_tax_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settlement_cycles ADD COLUMN settlement_currency TEXT;
ALTER TABLE settlement_cycles ADD COLUMN settlement_amount_minor INTEGER;
ALTER TABLE settlement_cycles ADD COLUMN conversion TEXT;

-- Items: the same three lines per collection (fee_minor stays the total).
ALTER TABLE settlement_items ADD COLUMN provider_fee_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settlement_items ADD COLUMN platform_fee_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settlement_items ADD COLUMN fee_tax_minor INTEGER NOT NULL DEFAULT 0;

-- Refunds of split payments: what each recipient gave back, per refund, through a reverse distribution.
CREATE TABLE IF NOT EXISTS split_refund_allocations (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  refund_id TEXT NOT NULL,
  split_payout_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  policy TEXT NOT NULL DEFAULT 'pro_rata',
  transaction_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_split_refund_alloc_intent ON split_refund_allocations(intent_id);
CREATE INDEX IF NOT EXISTS idx_split_refund_alloc_refund ON split_refund_allocations(refund_id);

-- Intents carry `settlement_profile_id` since 015 (payment_intents); the settlement engine now reads it to route each
-- collection to that profile's cycle, so index the assignment.
CREATE INDEX IF NOT EXISTS idx_payment_intents_settlement_profile ON payment_intents(settlement_profile_id);
CREATE INDEX IF NOT EXISTS idx_split_refund_alloc_payout ON split_refund_allocations(split_payout_id);
