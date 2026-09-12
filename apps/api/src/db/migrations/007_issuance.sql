-- E-money issuance control: every creation of balance carries an issuance authority; admin issuance is maker-checker.
ALTER TABLE manual_verifications ADD COLUMN payload TEXT;
ALTER TABLE transactions ADD COLUMN issuance_authority TEXT;
CREATE INDEX IF NOT EXISTS idx_tx_issuance ON transactions(issuance_authority, currency);
