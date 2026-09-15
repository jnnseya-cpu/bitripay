-- Wallet preferences: the currency a person pays with by default (main) and the alternative one. Both change at any
-- time; empty means the oldest wallet stays first. Additive.
ALTER TABLE users ADD COLUMN main_currency TEXT;
ALTER TABLE users ADD COLUMN alternative_currency TEXT;
