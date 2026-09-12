-- Blog, SEO engine and AI content agent.
CREATE TABLE IF NOT EXISTS blog_posts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  body_md TEXT NOT NULL,
  cover_url TEXT,
  cover_alt TEXT,
  category TEXT NOT NULL DEFAULT 'guides',
  tags TEXT NOT NULL DEFAULT '[]',
  keywords TEXT NOT NULL DEFAULT '[]',
  language TEXT NOT NULL DEFAULT 'en',
  author_name TEXT NOT NULL DEFAULT 'BitriPay Editorial',
  author_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',          -- draft | review | scheduled | published | archived
  meta_title TEXT,
  meta_description TEXT,
  canonical_url TEXT,
  faq TEXT NOT NULL DEFAULT '[]',                 -- [{question, answer}]
  sources TEXT NOT NULL DEFAULT '[]',             -- [{title, url}] outbound references (backlink-worthy citations)
  social TEXT NOT NULL DEFAULT '{}',              -- generated social snippets per network
  reading_minutes INTEGER NOT NULL DEFAULT 3,
  source TEXT NOT NULL DEFAULT 'manual',          -- manual | agent | seed
  agent_run_id TEXT,
  views INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  scheduled_for TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blog_posts_status ON blog_posts(status, published_at);

-- Dynamic hyperlinks: keywords that are linked automatically wherever they appear in rendered content.
CREATE TABLE IF NOT EXISTS seo_link_rules (
  id TEXT PRIMARY KEY,
  keyword TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  kind TEXT NOT NULL DEFAULT 'internal',          -- internal | outbound
  max_per_page INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 50,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- Backlinks: inbound links discovered from referrers, plus outbound / partner links we maintain.
CREATE TABLE IF NOT EXISTS seo_backlinks (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,                        -- inbound | outbound | partner
  source_url TEXT NOT NULL,
  source_domain TEXT NOT NULL,
  target_url TEXT NOT NULL,
  anchor TEXT,
  status TEXT NOT NULL DEFAULT 'live',            -- live | pending | lost | rejected
  hits INTEGER NOT NULL DEFAULT 0,
  nofollow INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(direction, source_url, target_url)
);

-- Every AI agent run is logged with its input, output, model and token usage.
CREATE TABLE IF NOT EXISTS seo_runs (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT,
  model TEXT,
  provider TEXT NOT NULL DEFAULT 'anthropic',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',              -- ok | error | fallback
  error TEXT,
  post_id TEXT,
  triggered_by TEXT,
  created_at TEXT NOT NULL
);

-- Page views for public pages (used for popular posts and the SEO dashboard); no personal data.
CREATE TABLE IF NOT EXISTS seo_pageviews (
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path)
);
