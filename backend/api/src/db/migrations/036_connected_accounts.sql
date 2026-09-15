-- Connected accounts (aggregator / platform model): a developer or platform creates its customers' merchant accounts
-- through the API, takes payments on their behalf with its own key (BitriPay-Account header), keeps an application
-- fee, and hands the account over with a claim link. The customer is always the merchant of record: its own user,
-- organisation, wallets, settlement and statements. Everything here is additive.

CREATE TABLE IF NOT EXISTS connected_accounts (
  id TEXT PRIMARY KEY,
  platform_user_id TEXT NOT NULL,
  platform_organisation_id TEXT NOT NULL,
  user_id TEXT NOT NULL UNIQUE,
  organisation_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  application_fee_bps INTEGER NOT NULL DEFAULT 0,
  claim_token_hash TEXT,
  claim_expires_at TEXT,
  claimed_at TEXT,
  detached_at TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_connected_accounts_platform ON connected_accounts(platform_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_connected_accounts_claim ON connected_accounts(claim_token_hash);
