-- Savings automation: goals are ring-fenced inside the wallet through holds (kind 'savings'); nothing leaves the ledger.
CREATE TABLE IF NOT EXISTS savings_settings (
  user_id TEXT PRIMARY KEY,
  auto_anchor INTEGER NOT NULL DEFAULT 0,
  anchor_bps INTEGER NOT NULL DEFAULT 1000,
  round_ups INTEGER NOT NULL DEFAULT 0,
  round_to_minor INTEGER NOT NULL DEFAULT 100,
  default_goal_id TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS savings_goals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  name TEXT NOT NULL,
  target_minor INTEGER NOT NULL DEFAULT 0,
  saved_minor INTEGER NOT NULL DEFAULT 0,
  deadline TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_savings_goals_user ON savings_goals(user_id, status);
CREATE TABLE IF NOT EXISTS savings_movements (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  hold_id TEXT,
  source_transaction_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_savings_movements_goal ON savings_movements(goal_id, created_at);
