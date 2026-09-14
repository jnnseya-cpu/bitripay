-- Security contract: one-time 2FA recovery codes, admin-editable notification templates, encrypted KYC documents
-- at rest and virtual cards that no longer store a CVV (it is derived from the card at reveal/charge time).

-- Recovery codes: only the SHA-256 of each code is stored; a code is spent by setting used_at.
CREATE TABLE IF NOT EXISTS recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes(user_id, used_at);

-- Notification templates per event key, channel (sms, whatsapp, email, push) and language; {{placeholders}} are
-- substituted at send time. Defaults are seeded by the API and administrators edit them in Messaging › Templates.
CREATE TABLE IF NOT EXISTS notification_templates (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  channel TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'en',
  subject TEXT,
  body TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(key, channel, lang)
);

-- KYC document images are encrypted at rest from now on; the flag tells the reader which rows to decrypt so that
-- submissions made before this migration stay readable.
ALTER TABLE kyc_submissions ADD COLUMN documents_encrypted INTEGER NOT NULL DEFAULT 0;

-- virtual_cards.cvv_encrypted becomes nullable: new cards store nothing for the CVV (it is derived with an HMAC of the
-- card's PAN hash and expiry under APP_SECRET). SQLite cannot drop a NOT NULL constraint in place, so the table is
-- rebuilt with the same columns and every existing row (and its stored CVV, which keeps working) is carried over.
CREATE TABLE IF NOT EXISTS virtual_cards_v27 (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  currency TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  pan_encrypted TEXT NOT NULL,
  pan_hash TEXT NOT NULL UNIQUE,
  last4 TEXT NOT NULL,
  exp_month INTEGER NOT NULL,
  exp_year INTEGER NOT NULL,
  cvv_encrypted TEXT,
  holder_name TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
INSERT INTO virtual_cards_v27 (id, user_id, currency, balance, pan_encrypted, pan_hash, last4, exp_month, exp_year, cvv_encrypted, holder_name, label, status, created_at)
  SELECT id, user_id, currency, balance, pan_encrypted, pan_hash, last4, exp_month, exp_year, cvv_encrypted, holder_name, label, status, created_at FROM virtual_cards;
DROP TABLE virtual_cards;
ALTER TABLE virtual_cards_v27 RENAME TO virtual_cards;
