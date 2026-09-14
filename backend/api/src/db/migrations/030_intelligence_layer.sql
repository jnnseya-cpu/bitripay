-- Intelligence layer (specification §27, §58, §59, §61, §105, §106): merchant acceptance score snapshots, the payment
-- graph, agent cash declarations for float intelligence, smart restricted wallets and the government QR infrastructure.

-- §27 merchant acceptance score: one snapshot per merchant and day (snapshotAcceptanceScores()).
CREATE TABLE IF NOT EXISTS merchant_acceptance_scores (
  id TEXT PRIMARY KEY,
  merchant_user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  score INTEGER NOT NULL,
  window_days INTEGER NOT NULL,
  components TEXT NOT NULL DEFAULT '{}',
  recommendations TEXT NOT NULL DEFAULT '[]',
  computed_at TEXT NOT NULL,
  UNIQUE(merchant_user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_acceptance_scores_merchant ON merchant_acceptance_scores(merchant_user_id, day);

-- §58 payment graph: nodes (user, merchant, agent, device, beneficiary, payment_method, provider, location) and edges
-- (paid, received, cashed_in, cashed_out, used_device, used_method, routed_via, shares_beneficiary, located_at), one edge
-- row per observed event so cycles and forwarding can be checked against time.
CREATE TABLE IF NOT EXISTS graph_nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  label TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_kind ON graph_nodes(kind, ref);
CREATE TABLE IF NOT EXISTS graph_edges (
  id TEXT PRIMARY KEY,
  from_node TEXT NOT NULL,
  to_node TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_minor INTEGER NOT NULL DEFAULT 0,
  currency TEXT,
  ref TEXT,
  occurred_at TEXT NOT NULL,
  UNIQUE(from_node, to_node, kind, ref)
);
CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_node, kind, occurred_at);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_node, kind, occurred_at);
CREATE INDEX IF NOT EXISTS idx_graph_edges_kind ON graph_edges(kind, occurred_at);

-- §59 float intelligence: the physical cash an agent counted (the ledger only knows the digital float).
CREATE TABLE IF NOT EXISTS agent_cash_declarations (
  id TEXT PRIMARY KEY,
  agent_user_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  declared_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_cash_declarations ON agent_cash_declarations(agent_user_id, currency, declared_at);

-- §61 smart restricted wallets: a programme says where the money may go; a restricted wallet is a real ledger wallet
-- bound to a programme and a beneficiary, enforced by a posting policy inside postTransaction.
CREATE TABLE IF NOT EXISTS restricted_programmes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sponsor_user_id TEXT,
  purpose_code TEXT NOT NULL,
  eligible_mccs TEXT NOT NULL DEFAULT '[]',
  eligible_merchant_ids TEXT NOT NULL DEFAULT '[]',
  max_tx_minor INTEGER,
  currency TEXT NOT NULL,
  countries TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT,
  cash_out_allowed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS restricted_wallets (
  id TEXT PRIMARY KEY,
  programme_id TEXT NOT NULL REFERENCES restricted_programmes(id),
  user_id TEXT NOT NULL,
  holder_user_id TEXT NOT NULL,
  wallet_id TEXT NOT NULL UNIQUE REFERENCES wallets(id),
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(programme_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_restricted_wallets_user ON restricted_wallets(user_id, status);
CREATE TABLE IF NOT EXISTS merchant_purpose_codes (
  user_id TEXT NOT NULL,
  purpose_code TEXT NOT NULL,
  granted_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, purpose_code)
);

-- §105/§106 government QR infrastructure: agencies collect through their merchant account; each service carries a
-- revenue code; every citizen reference is a payment intent with purpose GOVERNMENT_FEE or TAX.
CREATE TABLE IF NOT EXISTS gov_agencies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  country TEXT NOT NULL,
  region TEXT,
  merchant_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gov_services (
  id TEXT PRIMARY KEY,
  agency_id TEXT NOT NULL REFERENCES gov_agencies(id),
  name TEXT NOT NULL,
  revenue_code TEXT NOT NULL,
  purpose_code TEXT NOT NULL DEFAULT 'GOVERNMENT_FEE',
  currency TEXT NOT NULL,
  fixed_amount_minor INTEGER,
  reusable INTEGER NOT NULL DEFAULT 0,
  qr_id TEXT,
  reference_ttl_minutes INTEGER NOT NULL DEFAULT 4320,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(agency_id, revenue_code)
);
CREATE TABLE IF NOT EXISTS gov_references (
  id TEXT PRIMARY KEY,
  agency_id TEXT NOT NULL REFERENCES gov_agencies(id),
  service_id TEXT NOT NULL REFERENCES gov_services(id),
  citizen_ref TEXT NOT NULL,
  region TEXT,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  reconciliation_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'OPEN',
  intent_id TEXT,
  transaction_id TEXT,
  payer_user_id TEXT,
  agent_user_id TEXT,
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  refunded_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gov_references_agency ON gov_references(agency_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_gov_references_intent ON gov_references(intent_id);
CREATE TABLE IF NOT EXISTS gov_agency_operators (
  agency_id TEXT NOT NULL REFERENCES gov_agencies(id),
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator',
  granted_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agency_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_gov_agency_operators_user ON gov_agency_operators(user_id);
