-- Organisations in use (specification §43, §44): business units, member invitations, the business-unit link on
-- locations, and a backfill so every existing merchant account owns an organisation and its intents and
-- locations are stamped with it. Everything here is additive.

CREATE TABLE IF NOT EXISTS business_units (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  settlement_profile_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_units_code ON business_units(organisation_id, code);
CREATE INDEX IF NOT EXISTS idx_business_units_org ON business_units(organisation_id, created_at);

ALTER TABLE merchant_locations ADD COLUMN business_unit_id TEXT;
CREATE INDEX IF NOT EXISTS idx_locations_business_unit ON merchant_locations(business_unit_id);

ALTER TABLE organisation_members ADD COLUMN invited_by TEXT;
ALTER TABLE organisation_members ADD COLUMN updated_at TEXT;
CREATE INDEX IF NOT EXISTS idx_organisation_members_user ON organisation_members(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_organisations_owner ON organisations(owner_user_id);

-- Backfill: an organisation for every merchant-class account that has none, named after the business.
INSERT INTO organisations (id, name, kind, owner_user_id, country, status, kyb_status, settings, created_at, updated_at)
SELECT 'org_' || lower(hex(randomblob(8))), COALESCE(NULLIF(u.business_name, ''), u.full_name), u.role, u.id, u.country, 'active', 'none', '{}', u.created_at, u.created_at
FROM users u
WHERE u.role IN ('merchant', 'corporate', 'ngo', 'government', 'developer')
  AND u.is_system = 0
  AND NOT EXISTS (SELECT 1 FROM organisations o WHERE o.owner_user_id = u.id);

-- Every organisation owner is a member with the owner role.
INSERT INTO organisation_members (organisation_id, user_id, role, permissions, created_at, updated_at)
SELECT o.id, o.owner_user_id, 'owner', '["*"]', o.created_at, o.created_at
FROM organisations o
WHERE NOT EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id = o.id AND m.user_id = o.owner_user_id);

-- Existing intents and locations of those merchants carry their organisation.
UPDATE payment_intents
SET organisation_id = (SELECT o.id FROM organisations o WHERE o.owner_user_id = payment_intents.merchant_user_id ORDER BY o.created_at LIMIT 1)
WHERE organisation_id IS NULL
  AND EXISTS (SELECT 1 FROM organisations o WHERE o.owner_user_id = payment_intents.merchant_user_id);

UPDATE merchant_locations
SET organisation_id = (SELECT o.id FROM organisations o WHERE o.owner_user_id = merchant_locations.merchant_user_id ORDER BY o.created_at LIMIT 1)
WHERE organisation_id IS NULL
  AND EXISTS (SELECT 1 FROM organisations o WHERE o.owner_user_id = merchant_locations.merchant_user_id);
