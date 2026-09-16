-- Instruction n°58 art. 23: a reversed or refunded payment returns principal and fees. The aggregation fee accrued on
-- the reversed part is credited back to the merchant: reduced while still accrued, carried as a credit against the
-- next invoice once invoiced or paid. Additive.
ALTER TABLE switch_fee_entries ADD COLUMN reversed_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE switch_fee_entries ADD COLUMN credit_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE switch_fee_invoices ADD COLUMN credit_minor INTEGER NOT NULL DEFAULT 0;
