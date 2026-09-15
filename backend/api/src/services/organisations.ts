/**
 * Organisations (specification §43) and merchant RBAC (§44): the legal entity behind every merchant-class account
 * and every agent account, its members (people invited by email, tag or phone who act for the organisation with
 * their own session), the permission matrix per role, business units, and the customer export. Members never own merchant data: the
 * organisation's owner account is the principal every merchant table is keyed on, so a member's request is executed
 * as the owner while `req.actor` keeps the human for audit and step-up.
 */
import { getDb } from '../db';
import { now, shortCode } from '../lib/ids';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { parseJson } from '../lib/json';
import {
  ORG_PERMISSIONS,
  ORG_PERMISSION_KEYS,
  ORG_ROLES,
  canOwnOrganisation,
  orgRoleHasPermission,
  type BusinessUnit,
  type Organisation,
  type OrganisationMember,
  type OrgPermission,
  type OrgRole,
} from '@bitripay/shared';
import { findUserById, findUserByIdentifier, isMerchantRole, toPublicUser, updateUser, usersById, type UserRow } from './users';
import { getSetting } from './settings';
import { recordEvent } from './events';
import { notify } from './notifications';
import { publish } from './bus';

export { ORG_PERMISSIONS, ORG_PERMISSION_KEYS, ORG_ROLES, orgRoleHasPermission };
export type { OrgPermission, OrgRole };

export interface OrganisationRow {
  id: string;
  name: string;
  kind: string;
  owner_user_id: string;
  country: string | null;
  status: string;
  kyb_status: string;
  settings: string;
  created_at: string;
  updated_at: string;
}
export interface MemberRow {
  organisation_id: string;
  user_id: string;
  role: OrgRole;
  permissions: string;
  invited_by: string | null;
  created_at: string;
  updated_at: string | null;
}
export interface OrganisationSettings {
  /** The largest refund (minor units) a member holding `refunds:issue` but not `refunds:unrestricted` may issue. */
  cashierRefundLimitMinor: number;
}
/** Resolved membership of a signed-in person: the organisation they act for and what they may do there. */
export interface OrganisationContext {
  organisation: OrganisationRow;
  role: OrgRole;
  permissions: string[];
}

export const DEFAULT_CASHIER_REFUND_LIMIT_MINOR = 5_000;

/** Platform-wide default for the cashier refund limit (administrators may set `organisations.cashierRefundLimitMinor`). */
export function platformCashierRefundLimitMinor(): number {
  const s = getSetting<{ cashierRefundLimitMinor?: number }>('organisations', {});
  return Number.isInteger(s?.cashierRefundLimitMinor) && (s.cashierRefundLimitMinor as number) >= 0 ? (s.cashierRefundLimitMinor as number) : DEFAULT_CASHIER_REFUND_LIMIT_MINOR;
}

export function organisationSettings(org: OrganisationRow): OrganisationSettings {
  const raw = parseJson<Partial<OrganisationSettings>>(org.settings, {});
  const limit = raw.cashierRefundLimitMinor;
  return { cashierRefundLimitMinor: Number.isInteger(limit) && (limit as number) >= 0 ? (limit as number) : platformCashierRefundLimitMinor() };
}

export function organisationView(org: OrganisationRow): Organisation {
  return {
    id: org.id,
    name: org.name,
    kind: org.kind,
    ownerUserId: org.owner_user_id,
    country: org.country,
    status: org.status,
    kybStatus: org.kyb_status,
    settings: organisationSettings(org),
    createdAt: org.created_at,
    updatedAt: org.updated_at,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Organisations
// ---------------------------------------------------------------------------------------------------------------------
export function findOrganisation(id: string): OrganisationRow | undefined {
  return getDb().prepare('SELECT * FROM organisations WHERE id = ?').get(id) as OrganisationRow | undefined;
}
export function getOrganisation(id: string): OrganisationRow {
  const org = findOrganisation(id);
  if (!org) throw notFound('Organisation not found', 'organisation_not_found');
  return org;
}
export function findOrganisationForOwner(userId: string): OrganisationRow | undefined {
  return getDb().prepare('SELECT * FROM organisations WHERE owner_user_id = ? ORDER BY created_at LIMIT 1').get(userId) as OrganisationRow | undefined;
}

/** An organisation owned by an agent account: its members are the agent's counter staff and act on the agent surfaces. */
export const isAgentOrganisation = (org: Pick<OrganisationRow, 'kind'>): boolean => org.kind === 'agent';

/**
 * The organisation a merchant-class or agent account owns, created on first use for accounts that predate
 * organisations (registration, `upgradeToMerchant` and agent sign-up create it eagerly). Administrators and personal
 * accounts own none.
 */
export function ensureOrganisation(user: UserRow): OrganisationRow {
  const existing = findOrganisationForOwner(user.id);
  if (existing) return existing;
  if (!canOwnOrganisation(user.role)) throw badRequest('Only merchant-class accounts (merchant, corporate, NGO, government, developer) and agent accounts own an organisation', 'merchant_required');
  const db = getDb();
  const id = `org_${shortCode(12).toLowerCase()}`;
  const ts = now();
  const name = user.business_name?.trim() || user.full_name;
  db.transaction(() => {
    db.prepare("INSERT INTO organisations (id, name, kind, owner_user_id, country, status, kyb_status, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', 'none', '{}', ?, ?)").run(
      id,
      name,
      user.role,
      user.id,
      user.country ?? null,
      ts,
      ts,
    );
    db.prepare("INSERT INTO organisation_members (organisation_id, user_id, role, permissions, invited_by, created_at, updated_at) VALUES (?, ?, 'owner', '[\"*\"]', NULL, ?, ?)").run(
      id,
      user.id,
      ts,
      ts,
    );
    recordEvent('auth', id, 'organisation.created', { type: 'merchant', id: user.id }, { name, kind: user.role });
  })();
  publish('organisation.created', { organisationId: id, ownerUserId: user.id, name, kind: user.role }, { aggregateId: id, tenantId: user.id });
  return getOrganisation(id);
}

/** Organisation id to stamp on merchant objects: the owner's organisation (created on first use); null for administrators without one. */
export function organisationIdFor(merchant: UserRow): string | null {
  if (isMerchantRole(merchant.role)) return ensureOrganisation(merchant).id;
  return findOrganisationForOwner(merchant.id)?.id ?? null;
}

/**
 * Registration of a merchant-class account: `auth.register` stores merchant-class sign-ups as `merchant`; the
 * requested account type (corporate, ngo, government, developer) is applied here and the organisation created.
 */
export function onMerchantClassRegistered(userId: string, requestedRole: string | null | undefined): UserRow {
  let user = findUserById(userId);
  if (!user) throw notFound('User not found', 'user_not_found');
  if (!isMerchantRole(user.role) && !isMerchantRole(requestedRole)) return user;
  if (requestedRole && isMerchantRole(requestedRole) && user.role !== requestedRole) user = updateUser(user.id, { role: requestedRole });
  ensureOrganisation(user);
  return user;
}

/** Registration of an agent account: the agent's organisation (its team) exists from the first sign-in. */
export function onAgentRegistered(userId: string): UserRow {
  const user = findUserById(userId);
  if (!user) throw notFound('User not found', 'user_not_found');
  if (user.role === 'agent') ensureOrganisation(user);
  return user;
}

export function updateOrganisation(org: OrganisationRow, actor: UserRow, patch: { name?: string | null; cashierRefundLimitMinor?: number | null }): OrganisationRow {
  const db = getDb();
  const settings = { ...parseJson<Partial<OrganisationSettings>>(org.settings, {}) };
  if (patch.cashierRefundLimitMinor !== undefined) {
    if (patch.cashierRefundLimitMinor === null) delete settings.cashierRefundLimitMinor;
    else {
      if (!Number.isInteger(patch.cashierRefundLimitMinor) || patch.cashierRefundLimitMinor < 0) throw badRequest('The cashier refund limit is a non-negative integer in minor units', 'invalid_limit');
      settings.cashierRefundLimitMinor = patch.cashierRefundLimitMinor;
    }
  }
  const name = patch.name?.trim() ? patch.name.trim() : org.name;
  db.prepare('UPDATE organisations SET name = ?, settings = ?, updated_at = ? WHERE id = ?').run(name, JSON.stringify(settings), now(), org.id);
  recordEvent('auth', org.id, 'organisation.updated', { type: 'merchant', id: actor.id }, { name, settings });
  return getOrganisation(org.id);
}

// ---------------------------------------------------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------------------------------------------------
function memberRow(orgId: string, userId: string): MemberRow | undefined {
  return getDb().prepare('SELECT * FROM organisation_members WHERE organisation_id = ? AND user_id = ?').get(orgId, userId) as MemberRow | undefined;
}
function memberPermissions(row: Pick<MemberRow, 'permissions'>): string[] {
  return parseJson<string[]>(row.permissions, []).filter((p) => p === '*' || (ORG_PERMISSION_KEYS as readonly string[]).includes(p));
}
/** The permissions a member effectively holds: its role's row of the matrix plus any per-member grants. */
export function effectivePermissions(role: OrgRole, extra: readonly string[] = []): string[] {
  const fromRole = ORG_PERMISSIONS[role] ?? [];
  if (fromRole.includes('*') || extra.includes('*')) return ['*'];
  return Array.from(new Set([...fromRole, ...extra]));
}
export function hasOrgPermission(ctx: Pick<OrganisationContext, 'role' | 'permissions'> | null | undefined, permission: OrgPermission): boolean {
  if (!ctx) return true; // no organisation context: the account acts for itself (owner) — every permission
  return orgRoleHasPermission(ctx.role, permission, ctx.permissions);
}

export function memberView(row: MemberRow, users?: Map<string, ReturnType<typeof toPublicUser>>): OrganisationMember {
  const user = users?.get(row.user_id) ?? (findUserById(row.user_id) ? toPublicUser(findUserById(row.user_id)!) : null);
  return {
    organisationId: row.organisation_id,
    userId: row.user_id,
    role: row.role,
    permissions: effectivePermissions(row.role, memberPermissions(row)) as (OrgPermission | '*')[],
    user,
    invitedBy: row.invited_by,
    createdAt: row.created_at,
  };
}

export function listMembers(orgId: string): OrganisationMember[] {
  const rows = getDb().prepare("SELECT * FROM organisation_members WHERE organisation_id = ? ORDER BY CASE WHEN role = 'owner' THEN 0 ELSE 1 END, created_at").all(orgId) as MemberRow[];
  const users = usersById(rows.map((r) => r.user_id));
  return rows.map((r) => memberView(r, users));
}

/** Every organisation a person is a member of (their own first when they own one). */
export function membershipsOf(userId: string): OrganisationContext[] {
  const rows = getDb()
    .prepare(
      "SELECT m.* FROM organisation_members m JOIN organisations o ON o.id = m.organisation_id WHERE m.user_id = ? AND o.status = 'active' ORDER BY CASE WHEN m.role = 'owner' THEN 0 ELSE 1 END, m.created_at",
    )
    .all(userId) as MemberRow[];
  return rows.map((r) => ({ organisation: getOrganisation(r.organisation_id), role: r.role, permissions: effectivePermissions(r.role, memberPermissions(r)) }));
}

/**
 * The organisation a signed-in person acts for: the one requested (X-Organisation-Id), else their first membership
 * of the kind the surface serves (`agent` on the agent surfaces, a merchant-class organisation on the merchant
 * surfaces) so a person who is both a shop's cashier and an agent's counter clerk lands in the right one without a
 * header; the first membership of any kind when the surface is shared.
 */
export function resolveMembership(user: UserRow, preferredOrganisationId?: string | null, surface: 'merchant' | 'agent' | 'any' = 'any'): OrganisationContext | null {
  const all = membershipsOf(user.id);
  if (!all.length) return null;
  if (preferredOrganisationId) {
    const picked = all.find((m) => m.organisation.id === preferredOrganisationId);
    if (!picked) throw forbidden('You are not a member of that organisation', 'not_a_member');
    return picked;
  }
  if (surface === 'agent') return all.find((m) => isAgentOrganisation(m.organisation)) ?? null;
  if (surface === 'merchant') return all.find((m) => !isAgentOrganisation(m.organisation)) ?? null;
  return all[0];
}

/** Compact list of a person's memberships for the session payload (`GET /api/auth/me`): where they can act and as what. */
export function membershipSummaries(userId: string): { organisationId: string; name: string; kind: string; role: OrgRole; owner: boolean }[] {
  return membershipsOf(userId).map((m) => ({ organisationId: m.organisation.id, name: m.organisation.name, kind: m.organisation.kind, role: m.role, owner: m.role === 'owner' }));
}

function assertAssignableRole(role: string): asserts role is OrgRole {
  if (!(ORG_ROLES as readonly string[]).includes(role)) throw badRequest(`Unknown organisation role "${role}"`, 'unknown_role');
  if (role === 'owner') throw badRequest('The owner role belongs to the account that registered the organisation and cannot be assigned', 'owner_not_assignable');
}

export function inviteMember(org: OrganisationRow, actor: UserRow, input: { identifier: string; role: string; permissions?: string[] }): OrganisationMember {
  assertAssignableRole(input.role);
  const user = findUserByIdentifier(input.identifier);
  if (!user) throw notFound('No BitriPay account matches that email, phone or @tag. Ask them to sign up first.', 'member_not_found');
  if (user.is_system || user.role === 'admin') throw badRequest('Platform administrators and system accounts cannot join an organisation', 'member_not_eligible');
  if (user.status !== 'active') throw badRequest('This account is suspended', 'member_not_eligible');
  if (user.id === org.owner_user_id) throw conflict('That account owns this organisation', 'already_member');
  if (memberRow(org.id, user.id)) throw conflict('This person is already a member of the organisation', 'already_member');
  const extra = (input.permissions ?? []).filter((p) => (ORG_PERMISSION_KEYS as readonly string[]).includes(p));
  const ts = now();
  const db = getDb();
  db.transaction(() => {
    db.prepare('INSERT INTO organisation_members (organisation_id, user_id, role, permissions, invited_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      org.id,
      user.id,
      input.role,
      JSON.stringify(extra),
      actor.id,
      ts,
      ts,
    );
    recordEvent('auth', org.id, 'organisation.member_added', { type: 'merchant', id: actor.id }, { userId: user.id, role: input.role, permissions: extra });
  })();
  const where = isAgentOrganisation(org) ? 'Open the agent dashboard to work at its counter.' : 'Open the merchant centre to act for the organisation.';
  notify(user.id, `You joined ${org.name}`, `${actor.full_name} added you to ${org.name} as ${input.role.replace(/_/g, ' ')}. ${where}`, {
    kind: 'organisation',
    organisationId: org.id,
    role: input.role,
  });
  return memberView(memberRow(org.id, user.id)!);
}

export function updateMemberRole(org: OrganisationRow, actor: UserRow, userId: string, input: { role: string; permissions?: string[] }): OrganisationMember {
  const row = memberRow(org.id, userId);
  if (!row) throw notFound('Member not found', 'member_not_found');
  if (row.role === 'owner') throw forbidden('The owner role cannot be changed', 'owner_immutable');
  assertAssignableRole(input.role);
  const extra = input.permissions === undefined ? memberPermissions(row) : input.permissions.filter((p) => (ORG_PERMISSION_KEYS as readonly string[]).includes(p));
  const db = getDb();
  db.transaction(() => {
    db.prepare('UPDATE organisation_members SET role = ?, permissions = ?, updated_at = ? WHERE organisation_id = ? AND user_id = ?').run(input.role, JSON.stringify(extra), now(), org.id, userId);
    recordEvent('auth', org.id, 'organisation.member_role_changed', { type: 'merchant', id: actor.id }, { userId, from: row.role, to: input.role, permissions: extra });
  })();
  return memberView(memberRow(org.id, userId)!);
}

export function removeMember(org: OrganisationRow, actor: UserRow, userId: string): { removed: true; userId: string } {
  const row = memberRow(org.id, userId);
  if (!row) throw notFound('Member not found', 'member_not_found');
  if (row.role === 'owner') throw forbidden('The owner cannot be removed from the organisation', 'owner_immutable');
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM organisation_members WHERE organisation_id = ? AND user_id = ?').run(org.id, userId);
    recordEvent('auth', org.id, 'organisation.member_removed', { type: 'merchant', id: actor.id }, { userId, role: row.role });
  })();
  return { removed: true, userId };
}

// ---------------------------------------------------------------------------------------------------------------------
// Refund limits
// ---------------------------------------------------------------------------------------------------------------------
/** A member without `refunds:unrestricted` may only refund up to the organisation's cashier limit; an unknown amount (full refund) counts as unlimited. */
export function assertRefundWithinMemberLimit(org: OrganisationRow | null | undefined, ctx: OrganisationContext | null | undefined, amountMinor: number | null): void {
  if (!ctx || hasOrgPermission(ctx, 'refunds:unrestricted')) return;
  if (!hasOrgPermission(ctx, 'refunds:issue')) throw forbidden(`Your organisation role (${ctx.role.replace(/_/g, ' ')}) cannot issue refunds`, 'org_permission_denied');
  const limit = org ? organisationSettings(org).cashierRefundLimitMinor : platformCashierRefundLimitMinor();
  if (amountMinor == null)
    throw forbidden(`Your organisation role can refund at most ${limit} minor units per refund; specify amount_minor (a full refund needs a finance manager or the owner)`, 'refund_limit_exceeded');
  if (amountMinor > limit) throw forbidden(`Your organisation role can refund at most ${limit} minor units per refund; ${amountMinor} needs a finance manager or the owner`, 'refund_limit_exceeded');
}

// ---------------------------------------------------------------------------------------------------------------------
// Business units
// ---------------------------------------------------------------------------------------------------------------------
interface BusinessUnitRow {
  id: string;
  organisation_id: string;
  name: string;
  code: string;
  settlement_profile_id: string | null;
  created_at: string;
  updated_at: string;
}
function unitView(r: BusinessUnitRow): BusinessUnit {
  const locations = (getDb().prepare('SELECT COUNT(*) c FROM merchant_locations WHERE business_unit_id = ?').get(r.id) as { c: number }).c;
  return { id: r.id, organisationId: r.organisation_id, name: r.name, code: r.code, settlementProfileId: r.settlement_profile_id, locations, createdAt: r.created_at, updatedAt: r.updated_at };
}
function unitRow(org: OrganisationRow, id: string): BusinessUnitRow {
  const r = getDb().prepare('SELECT * FROM business_units WHERE id = ? AND organisation_id = ?').get(id, org.id) as BusinessUnitRow | undefined;
  if (!r) throw notFound('Business unit not found', 'business_unit_not_found');
  return r;
}
function unitCode(name: string, code?: string | null): string {
  const c = (code?.trim() || name)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 16);
  if (c.length < 2) throw badRequest('Business unit code needs at least 2 letters or digits', 'invalid_code');
  return c;
}
function assertSettlementProfile(org: OrganisationRow, settlementProfileId: string | null | undefined) {
  if (!settlementProfileId) return null;
  const p = getDb().prepare('SELECT id FROM settlement_profiles WHERE id = ? AND user_id = ?').get(settlementProfileId, org.owner_user_id);
  if (!p) throw notFound('Settlement profile not found for this organisation', 'settlement_profile_not_found');
  return settlementProfileId;
}

export function listBusinessUnits(orgId: string): BusinessUnit[] {
  return (getDb().prepare('SELECT * FROM business_units WHERE organisation_id = ? ORDER BY created_at').all(orgId) as BusinessUnitRow[]).map(unitView);
}
export function getBusinessUnit(org: OrganisationRow, id: string): BusinessUnit {
  return unitView(unitRow(org, id));
}
export function createBusinessUnit(org: OrganisationRow, actor: UserRow, input: { name: string; code?: string | null; settlementProfileId?: string | null }): BusinessUnit {
  const name = input.name.trim();
  if (name.length < 2) throw badRequest('Business unit name needs at least 2 characters', 'invalid_name');
  const code = unitCode(name, input.code);
  if (getDb().prepare('SELECT 1 FROM business_units WHERE organisation_id = ? AND code = ?').get(org.id, code)) throw conflict(`A business unit with code ${code} already exists`, 'code_taken');
  const settlementProfileId = assertSettlementProfile(org, input.settlementProfileId);
  const id = `bu_${shortCode(10).toLowerCase()}`;
  const ts = now();
  const db = getDb();
  db.transaction(() => {
    db.prepare('INSERT INTO business_units (id, organisation_id, name, code, settlement_profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id,
      org.id,
      name,
      code,
      settlementProfileId,
      ts,
      ts,
    );
    recordEvent('payment', org.id, 'business_unit.created', { type: 'merchant', id: actor.id }, { businessUnitId: id, name, code });
  })();
  return getBusinessUnit(org, id);
}
export function updateBusinessUnit(org: OrganisationRow, actor: UserRow, id: string, patch: { name?: string | null; code?: string | null; settlementProfileId?: string | null }): BusinessUnit {
  const r = unitRow(org, id);
  const name = patch.name?.trim() ? patch.name.trim() : r.name;
  const code = patch.code !== undefined && patch.code !== null ? unitCode(name, patch.code) : r.code;
  if (code !== r.code && getDb().prepare('SELECT 1 FROM business_units WHERE organisation_id = ? AND code = ? AND id != ?').get(org.id, code, id))
    throw conflict(`A business unit with code ${code} already exists`, 'code_taken');
  const settlementProfileId = patch.settlementProfileId === undefined ? r.settlement_profile_id : assertSettlementProfile(org, patch.settlementProfileId);
  const db = getDb();
  db.transaction(() => {
    db.prepare('UPDATE business_units SET name = ?, code = ?, settlement_profile_id = ?, updated_at = ? WHERE id = ?').run(name, code, settlementProfileId, now(), id);
    recordEvent('payment', org.id, 'business_unit.updated', { type: 'merchant', id: actor.id }, { businessUnitId: id, name, code, settlementProfileId });
  })();
  return getBusinessUnit(org, id);
}
/** A unit that still has locations attached cannot be deleted: unlink them first. */
export function deleteBusinessUnit(org: OrganisationRow, actor: UserRow, id: string): { deleted: true; id: string } {
  const r = unitRow(org, id);
  const linked = (getDb().prepare('SELECT COUNT(*) c FROM merchant_locations WHERE business_unit_id = ?').get(id) as { c: number }).c;
  if (linked) throw conflict(`${linked} location${linked === 1 ? ' is' : 's are'} still attached to this business unit`, 'business_unit_in_use');
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM business_units WHERE id = ?').run(id);
    recordEvent('payment', org.id, 'business_unit.deleted', { type: 'merchant', id: actor.id }, { businessUnitId: id, code: r.code });
  })();
  return { deleted: true, id };
}

/** Attach a location (and with it its terminals and QR codes) to a business unit, or detach it with null. */
export function linkLocationToBusinessUnit(org: OrganisationRow, actor: UserRow, locationId: string, businessUnitId: string | null) {
  const db = getDb();
  const loc = db.prepare('SELECT * FROM merchant_locations WHERE id = ? AND merchant_user_id = ?').get(locationId, org.owner_user_id) as any;
  if (!loc) throw notFound('Location not found', 'location_not_found');
  if (businessUnitId) unitRow(org, businessUnitId);
  db.transaction(() => {
    db.prepare('UPDATE merchant_locations SET business_unit_id = ?, organisation_id = ?, updated_at = ? WHERE id = ?').run(businessUnitId, org.id, now(), locationId);
    recordEvent('payment', org.id, 'business_unit.location_linked', { type: 'merchant', id: actor.id }, { locationId, businessUnitId });
  })();
  const updated = db.prepare('SELECT * FROM merchant_locations WHERE id = ?').get(locationId) as any;
  return { id: updated.id, name: updated.name, organisationId: updated.organisation_id, businessUnitId: updated.business_unit_id };
}

/** The business unit a location belongs to (read-only join used by the intent view). */
export function businessUnitIdForLocation(locationId: string | null | undefined): string | null {
  if (!locationId) return null;
  return ((getDb().prepare('SELECT business_unit_id FROM merchant_locations WHERE id = ?').get(locationId) as { business_unit_id: string | null } | undefined)?.business_unit_id ?? null) as
    string | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Customer export (personal data: only members holding customers:export)
// ---------------------------------------------------------------------------------------------------------------------
export interface CustomerExportRow {
  customerUserId: string | null;
  msisdn: string | null;
  country: string | null;
  payments: number;
  totalMinor: number;
  currency: string;
  firstSeen: string;
  lastSeen: string;
}
export function exportCustomers(org: OrganisationRow): CustomerExportRow[] {
  return (
    getDb()
      .prepare(
        `SELECT COALESCE(pi.customer_user_id, pr.payer_user_id, t.sender_user_id) customer_user_id, pi.customer_msisdn, pi.customer_country, pi.currency,
                COUNT(*) payments, COALESCE(SUM(pi.amount_minor), 0) total, MIN(pi.created_at) first_seen, MAX(pi.created_at) last_seen
         FROM payment_intents pi
         LEFT JOIN payment_requests pr ON pr.id = pi.payment_request_id
         LEFT JOIN transactions t ON t.id = pi.transaction_id
         WHERE pi.merchant_user_id = ? AND (COALESCE(pi.customer_user_id, pr.payer_user_id, t.sender_user_id) IS NOT NULL OR pi.customer_msisdn IS NOT NULL)
         GROUP BY 1, 2, 3, 4 ORDER BY last_seen DESC`,
      )
      .all(org.owner_user_id) as any[]
  ).map((r) => ({
    customerUserId: r.customer_user_id,
    msisdn: r.customer_msisdn,
    country: r.customer_country,
    payments: r.payments,
    totalMinor: r.total,
    currency: r.currency,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
  }));
}
export function customersCsv(rows: CustomerExportRow[]): string {
  const esc = (v: unknown) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [
    'customer_user_id,msisdn,country,payments,total_minor,currency,first_seen,last_seen',
    ...rows.map((r) => [r.customerUserId, r.msisdn, r.country, r.payments, r.totalMinor, r.currency, r.firstSeen, r.lastSeen].map(esc).join(',')),
  ].join('\n');
}

/** Everything the Team & business units tab needs in one call. */
export function organisationSummary(org: OrganisationRow, ctx: OrganisationContext | null, actor: UserRow) {
  return {
    organisation: organisationView(org),
    membership: { userId: actor.id, role: ctx?.role ?? 'owner', permissions: ctx?.permissions ?? ['*'] },
    members: listMembers(org.id),
    businessUnits: listBusinessUnits(org.id),
    roles: ORG_ROLES,
    permissions: ORG_PERMISSIONS,
  };
}
