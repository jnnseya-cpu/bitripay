-- Trend intelligence: a control layer over the content agent this platform already runs.
--
-- Today `runContentSchedule()` takes the next entry off a hand-written topic list. That is the whole of its
-- judgement about what the market wants. These tables replace the list with evidence: observations arrive from
-- first-party events and permitted key-free feeds, cluster into topics, and are scored for opportunity and
-- confidence by a deterministic formula. A topic that clears the bands becomes a versioned Growth Brief, and the
-- existing agent resolves that brief at run time instead of reading the list.
--
-- Nothing here publishes anything by itself. A brief changes what the agent is asked to write about, for whom, and
-- which claims it may make; the existing review, approval and audit path still decides whether a draft goes live.
-- No new external credential is involved: signals are first-party or key-free, and generation reuses the assist
-- gateway already configured for the platform, falling back to deterministic templates when it is unavailable.

-- Where a signal comes from and what it is allowed to prove. `access_path` is the spec's registry field: a source
-- that needs a credential the platform does not already hold is recorded as unavailable rather than prompted for.
CREATE TABLE IF NOT EXISTS ti_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  family TEXT NOT NULL,
  access_path TEXT NOT NULL CHECK (access_path IN ('first_party', 'public_keyless', 'host_mediated', 'file_import')),
  -- 0-100, the operator's view of how much this family's word is worth; feeds the confidence quality component.
  quality INTEGER NOT NULL DEFAULT 50,
  -- A source whose newest complete window is older than this cannot support a fresh automated action.
  stale_after_hours INTEGER NOT NULL DEFAULT 48,
  cadence_minutes INTEGER NOT NULL DEFAULT 60,
  -- Context-only sources can corroborate nothing on their own (pageviews are attention, not buyer intent).
  context_only INTEGER NOT NULL DEFAULT 0,
  terms TEXT,
  permitted_uses TEXT NOT NULL DEFAULT '[]',
  territories TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  unavailable_reason TEXT,
  last_polled_at TEXT,
  last_window_end TEXT,
  created_at TEXT NOT NULL
);

-- A normalised observation. Event time, window, ingestion time and coverage are kept apart on purpose: a feed gap
-- is unknown data, never zero interest, and a late arrival must not be read as a fresh one.
CREATE TABLE IF NOT EXISTS ti_observations (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES ti_sources(id),
  source_record_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  observed_at TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  market TEXT NOT NULL DEFAULT 'ZZ',
  locale TEXT,
  segment TEXT,
  term TEXT NOT NULL,
  term_canonical TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT 'count',
  -- Indexed feeds (a 0-100 trends index) must never be compared against raw-count gates.
  scaling_scope TEXT NOT NULL DEFAULT 'absolute' CHECK (scaling_scope IN ('absolute', 'indexed')),
  coverage REAL NOT NULL DEFAULT 1,
  evidence_hash TEXT NOT NULL,
  evidence_uri TEXT,
  terms_version TEXT,
  created_at TEXT NOT NULL
);
-- The replay rule: the same source record at the same revision lands once. A different payload for the same key is
-- a conflict for the caller to resolve, not a silent second observation inflating a count.
CREATE UNIQUE INDEX IF NOT EXISTS ti_observations_key ON ti_observations (source_id, source_record_id, revision);
CREATE INDEX IF NOT EXISTS ti_observations_window ON ti_observations (term_canonical, market, window_end);

-- A topic: the thing a brief is about. Distinct buyer intents, markets and categories stay distinct even when the
-- words are similar, so a competitor's announcement cannot be merged into the platform's own demand.
CREATE TABLE IF NOT EXISTS ti_topics (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  label TEXT NOT NULL,
  market TEXT NOT NULL DEFAULT 'ZZ',
  locale TEXT,
  intent TEXT,
  terms TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'watching', 'eligible', 'briefed', 'dismissed', 'expired')),
  dismissed_reason TEXT,
  cooldown_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ti_topics_scope ON ti_topics (slug, market);

-- A frozen score for one topic at one window end. Frozen because an experiment's evidence must not move under it:
-- a correction creates a superseding snapshot rather than editing this one.
CREATE TABLE IF NOT EXISTS ti_opportunities (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES ti_topics(id),
  window_end TEXT NOT NULL,
  scoring_version TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  opportunity_score REAL NOT NULL,
  confidence REAL NOT NULL,
  demand REAL NOT NULL,
  fit REAL NOT NULL,
  commercial_intent REAL NOT NULL,
  timing REAL NOT NULL,
  readiness REAL NOT NULL,
  source_quality REAL NOT NULL,
  corroboration REAL NOT NULL,
  coverage REAL NOT NULL,
  freshness REAL NOT NULL,
  families TEXT NOT NULL DEFAULT '[]',
  evidence_ids TEXT NOT NULL DEFAULT '[]',
  vetoes TEXT NOT NULL DEFAULT '[]',
  band TEXT NOT NULL CHECK (band IN ('archive', 'watch', 'brief', 'auto_eligible')),
  reasons TEXT NOT NULL DEFAULT '[]',
  superseded_by TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ti_opportunities_frozen ON ti_opportunities (topic_id, window_end, scoring_version, input_digest);

-- A claim the agent is allowed to make, with the evidence behind it. A factual marketing claim that maps to no
-- approved claim is refused; this is what stops a model inventing a capability the platform does not have.
CREATE TABLE IF NOT EXISTS ti_claims (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  text TEXT NOT NULL,
  evidence TEXT,
  valid_from TEXT,
  valid_until TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ti_claims_rev ON ti_claims (code, revision);

-- The Growth Brief. One approved brief is active per market, locale and topic at a time, for a short window, so the
-- agent cannot be steered by two contradictory instructions or by one that has stopped being true.
CREATE TABLE IF NOT EXISTS ti_briefs (
  id TEXT PRIMARY KEY,
  brief_ref TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  topic_id TEXT NOT NULL REFERENCES ti_topics(id),
  opportunity_id TEXT NOT NULL REFERENCES ti_opportunities(id),
  market TEXT NOT NULL,
  locale TEXT NOT NULL,
  audience TEXT NOT NULL,
  intent TEXT NOT NULL,
  objective TEXT NOT NULL,
  cta_id TEXT,
  approved_claim_ids TEXT NOT NULL DEFAULT '[]',
  prohibited_claims TEXT NOT NULL DEFAULT '[]',
  allowed_channels TEXT NOT NULL DEFAULT '[]',
  evidence_ids TEXT NOT NULL DEFAULT '[]',
  opportunity_score REAL NOT NULL,
  confidence REAL NOT NULL,
  policy_version INTEGER NOT NULL DEFAULT 1,
  experiment_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'superseded', 'expired', 'revoked')),
  degraded INTEGER NOT NULL DEFAULT 0,
  degraded_reason TEXT,
  valid_from TEXT,
  expires_at TEXT,
  proposed_by TEXT,
  approved_by TEXT,
  approved_at TEXT,
  payload_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ti_briefs_version ON ti_briefs (brief_ref, version);
-- At most one approved brief per scope, enforced at write time rather than checked afterwards.
CREATE UNIQUE INDEX IF NOT EXISTS ti_briefs_active ON ti_briefs (topic_id, market, locale) WHERE status = 'approved';

-- Every brief the agent resolved, and what it did with it. The audit answer to "why did it write that".
CREATE TABLE IF NOT EXISTS ti_brief_uses (
  id TEXT PRIMARY KEY,
  brief_id TEXT REFERENCES ti_briefs(id),
  brief_version INTEGER,
  channel TEXT NOT NULL,
  resolved_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('used', 'baseline', 'expired', 'unavailable')),
  detail TEXT,
  post_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ti_brief_uses_brief ON ti_brief_uses (brief_id, resolved_at);
