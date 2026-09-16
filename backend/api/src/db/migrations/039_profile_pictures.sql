-- Profile and cover pictures for every account type (personal, merchant-class, agent, administrator). The bytes live
-- in their own table so user listings stay light; the users row only carries a version per picture, which makes the
-- public picture URL cacheable forever (a new upload changes the URL). Additive.
ALTER TABLE users ADD COLUMN picture_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN cover_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS user_pictures (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('profile', 'cover')),
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, kind)
);
