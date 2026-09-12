-- Processor onboarding, versioned rate snapshots and corridor regulatory arrangements
CREATE TABLE IF NOT EXISTS rate_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  source TEXT NOT NULL,
  base TEXT NOT NULL,
  rates TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  created_by TEXT,
  note TEXT
);
ALTER TABLE corridors ADD COLUMN compliance TEXT NOT NULL DEFAULT '{}';
ALTER TABLE corridors ADD COLUMN licence_expires_at TEXT;
