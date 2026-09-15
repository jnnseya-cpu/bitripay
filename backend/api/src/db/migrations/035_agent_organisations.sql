-- Agent teams: every agent account owns an organisation too, so counter staff can work at its till with their own
-- login and an assigned role (specification §43/§44 extended to agents). Same tables as merchants; the owner is the
-- agent account and every cash operation still settles on the agent's float. Everything here is additive.

INSERT INTO organisations (id, name, kind, owner_user_id, country, status, kyb_status, settings, created_at, updated_at)
SELECT 'org_' || lower(hex(randomblob(8))), COALESCE(NULLIF(u.business_name, ''), u.full_name), 'agent', u.id, u.country, 'active', 'none', '{}', u.created_at, u.created_at
FROM users u
WHERE u.role = 'agent'
  AND u.is_system = 0
  AND NOT EXISTS (SELECT 1 FROM organisations o WHERE o.owner_user_id = u.id);

INSERT INTO organisation_members (organisation_id, user_id, role, permissions, created_at, updated_at)
SELECT o.id, o.owner_user_id, 'owner', '["*"]', o.created_at, o.created_at
FROM organisations o
WHERE NOT EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id = o.id AND m.user_id = o.owner_user_id);
