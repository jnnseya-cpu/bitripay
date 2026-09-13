CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tag TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  phone TEXT UNIQUE,
  password_hash TEXT,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  avatar_color TEXT NOT NULL DEFAULT '#2563eb',
  country TEXT,
  business_name TEXT,
  pin_hash TEXT,
  kyc_status TEXT NOT NULL DEFAULT 'none',
  status TEXT NOT NULL DEFAULT 'active',
  email_verified INTEGER NOT NULL DEFAULT 0,
  phone_verified INTEGER NOT NULL DEFAULT 0,
  two_factor_secret TEXT,
  two_factor_enabled INTEGER NOT NULL DEFAULT 0,
  referral_code TEXT UNIQUE,
  referred_by TEXT,
  agent_commission_bps INTEGER,
  webhook_url TEXT,
  webhook_secret TEXT,
  gateway_settings TEXT NOT NULL DEFAULT '{}',
  language TEXT NOT NULL DEFAULT 'en',
  is_system INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  currency TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, currency)
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  amount INTEGER NOT NULL,
  fee INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL,
  receive_amount INTEGER,
  receive_currency TEXT,
  sender_user_id TEXT,
  receiver_user_id TEXT,
  sender_wallet_id TEXT,
  receiver_wallet_id TEXT,
  note TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tx_sender ON transactions(sender_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tx_receiver ON transactions(receiver_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tx_type_status ON transactions(type, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_idempotency ON transactions(sender_user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  wallet_id TEXT NOT NULL REFERENCES wallets(id),
  direction TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_wallet ON ledger_entries(wallet_id, created_at);

CREATE TABLE IF NOT EXISTS payment_requests (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  requester_user_id TEXT NOT NULL REFERENCES users(id),
  payer_user_id TEXT,
  amount INTEGER,
  currency TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  expires_at TEXT,
  paid_transaction_id TEXT,
  success_url TEXT,
  cancel_url TEXT,
  allowed_methods TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pr_requester ON payment_requests(requester_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pr_payer ON payment_requests(payer_user_id, status);

CREATE TABLE IF NOT EXISTS gateway_payments (
  id TEXT PRIMARY KEY,
  gateway TEXT NOT NULL,
  provider_ref TEXT,
  method TEXT NOT NULL,
  purpose TEXT NOT NULL,
  user_id TEXT,
  payment_request_id TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  fee INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'initiated',
  payer_email TEXT,
  payer_phone TEXT,
  payer_name TEXT,
  saved_card_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  transaction_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gp_ref ON gateway_payments(gateway, provider_ref);
CREATE INDEX IF NOT EXISTS idx_gp_user ON gateway_payments(user_id, created_at);

CREATE TABLE IF NOT EXISTS saved_cards (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  provider_ref TEXT,
  brand TEXT NOT NULL,
  last4 TEXT NOT NULL,
  exp_month INTEGER NOT NULL,
  exp_year INTEGER NOT NULL,
  holder_name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS virtual_cards (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  currency TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  pan_encrypted TEXT NOT NULL,
  pan_hash TEXT NOT NULL UNIQUE,
  last4 TEXT NOT NULL,
  exp_month INTEGER NOT NULL,
  exp_year INTEGER NOT NULL,
  cvv_encrypted TEXT NOT NULL,
  holder_name TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  bank_name TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  currency TEXT NOT NULL,
  country TEXT,
  swift TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kyc_submissions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  doc_type TEXT NOT NULL,
  doc_number TEXT NOT NULL,
  full_name TEXT NOT NULL,
  dob TEXT,
  address TEXT,
  doc_front TEXT,
  doc_back TEXT,
  selfie TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  reviewed_by TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  channel TEXT NOT NULL,
  target TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otp_target ON otp_codes(target, purpose, consumed);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at);

CREATE TABLE IF NOT EXISTS push_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  label TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL DEFAULT 'live',
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  url TEXT NOT NULL,
  status_code INTEGER,
  success INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wh_user ON webhook_deliveries(user_id, created_at);

CREATE TABLE IF NOT EXISTS gateways (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  methods TEXT NOT NULL DEFAULT '[]',
  currencies TEXT NOT NULL DEFAULT '[]',
  countries TEXT NOT NULL DEFAULT '[]',
  credentials_encrypted TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS billers (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  currency TEXT NOT NULL,
  min_amount INTEGER NOT NULL DEFAULT 0,
  max_amount INTEGER NOT NULL DEFAULT 0,
  fee_bps INTEGER NOT NULL DEFAULT 0,
  account_label TEXT NOT NULL DEFAULT 'Account number',
  enabled INTEGER NOT NULL DEFAULT 1,
  color TEXT NOT NULL DEFAULT '#0ea5e9',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bill_payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  biller_id TEXT NOT NULL,
  account_number TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  transaction_id TEXT,
  receipt_no TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS topup_operators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  currency TEXT NOT NULL,
  min_amount INTEGER NOT NULL DEFAULT 0,
  max_amount INTEGER NOT NULL DEFAULT 0,
  denominations TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  color TEXT NOT NULL DEFAULT '#f59e0b',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mobile_topups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  transaction_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gift_card_products (
  id TEXT PRIMARY KEY,
  brand TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'shopping',
  currency TEXT NOT NULL,
  denominations TEXT NOT NULL DEFAULT '[]',
  color TEXT NOT NULL DEFAULT '#8b5cf6',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gift_cards (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  code_encrypted TEXT NOT NULL,
  pin_encrypted TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  transaction_id TEXT,
  recipient_email TEXT,
  created_at TEXT NOT NULL,
  redeemed_at TEXT
);

CREATE TABLE IF NOT EXISTS remittances (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  sender_user_id TEXT NOT NULL,
  recipient_user_id TEXT,
  saved_recipient_id TEXT,
  recipient TEXT NOT NULL DEFAULT '{}',
  payout_method TEXT NOT NULL,
  source_amount INTEGER NOT NULL,
  source_currency TEXT NOT NULL,
  target_amount INTEGER NOT NULL,
  target_currency TEXT NOT NULL,
  rate REAL NOT NULL,
  fee INTEGER NOT NULL,
  status TEXT NOT NULL,
  pickup_code TEXT UNIQUE,
  pickup_agent_id TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS saved_recipients (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  country TEXT,
  phone TEXT,
  email TEXT,
  tag TEXT,
  payout_method TEXT NOT NULL DEFAULT 'wallet',
  bank_name TEXT,
  account_number TEXT,
  currency TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cash_requests (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  transaction_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS referral_rewards (
  id TEXT PRIMARY KEY,
  referrer_id TEXT NOT NULL,
  referee_id TEXT NOT NULL,
  level INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  transaction_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS support_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_user ON chat_messages(user_id, created_at);

CREATE TABLE IF NOT EXISTS settlements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  bank_account_id TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  transaction_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS currencies (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  decimals INTEGER NOT NULL DEFAULT 2,
  rate_to_base REAL NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_base INTEGER NOT NULL DEFAULT 0,
  rate_source TEXT NOT NULL DEFAULT 'manual',
  rate_updated_at TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
