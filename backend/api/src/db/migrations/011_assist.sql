-- Command centres: governed agents that read through typed tools, propose actions and never move money themselves.
CREATE TABLE IF NOT EXISTS agent_instances (
  id TEXT PRIMARY KEY,
  agent_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (agent_key, user_id)
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  agent_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL DEFAULT 'user',
  trigger_ref TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  input TEXT NOT NULL,
  context TEXT,
  output TEXT,
  messages TEXT,
  model TEXT,
  provider TEXT NOT NULL DEFAULT 'offline',
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  acu REAL NOT NULL DEFAULT 0,
  steps INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_user ON agent_runs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status, created_at);

CREATE TABLE IF NOT EXISTS agent_actions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_no INTEGER NOT NULL,
  tool TEXT NOT NULL,
  input TEXT,
  result TEXT,
  outcome TEXT NOT NULL,
  reason TEXT,
  permission TEXT,
  approval_id TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_actions_run ON agent_actions(run_id, step_no);

CREATE TABLE IF NOT EXISTS agent_approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  requested_for TEXT NOT NULL,
  tool TEXT NOT NULL,
  input TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  decided_by TEXT,
  decided_at TEXT,
  decision_reason TEXT,
  result TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_approvals_status ON agent_approvals(status, created_at);

CREATE TABLE IF NOT EXISTS agent_memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fact',
  content TEXT NOT NULL,
  source_run_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_memories_user ON agent_memories(user_id, agent_key);

CREATE TABLE IF NOT EXISTS agent_policies (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL DEFAULT '*',
  version INTEGER NOT NULL DEFAULT 1,
  rules TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'live',
  note TEXT,
  author_admin_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_policies_scope ON agent_policies(scope, scope_id, status);

CREATE TABLE IF NOT EXISTS agent_usage (
  user_id TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  model TEXT NOT NULL,
  day TEXT NOT NULL,
  runs INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  acu REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, agent_key, model, day)
);
