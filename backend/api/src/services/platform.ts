/**
 * Connected accounts: the aggregator / platform model of the developer API. A developer or platform (any
 * merchant-class account with an API key) creates its customers' merchant accounts through `POST /v1/accounts`,
 * takes payments on their behalf with its own key and the `BitriPay-Account: acct_…` header, keeps an application
 * fee (a split paid from the customer's proceeds when the intent is captured), receives every event of the
 * customer on its own webhooks with the `account` field, and hands the account over with a claim link the customer
 * uses to set a password. The customer is always the merchant of record: its own user, organisation, wallets,
 * settlement profile and statements; BitriPay holds the aggregator licence, the platform integrates.
 *
 * The platform acts on the customer's organisation as an `administrator` member, so the customer sees the platform
 * under Team and can remove it at any time (`detach`): the account, its keys and its money stay the customer's.
 */
import { randomBytes } from 'node:crypto';
import { getDb } from '../db';
import { now, shortCode } from '../lib/ids';
import { sha256 } from '../lib/crypto';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { parseJson } from '../lib/json';
import { hashPassword } from '../lib/password';
import { config } from '../config';
import { MERCHANT_CLASS_ROLES, type MerchantClassRole } from '@bitripay/shared';
import { createUser, findUserById, isMerchantRole, toPublicUser, updateUser, type UserRow } from './users';
import { effectivePermissions, ensureOrganisation, extendOrganisationSummary, getOrganisation, onMemberRemovedHook, type OrganisationRow } from './organisations';
import { listWallets } from './wallets';
import { recordEvent } from './events';
import { emitEvent } from './webhooks';

export interface ConnectedAccountRow {
  id: string;
  platform_user_id: string;
  platform_organisation_id: string;
  user_id: string;
  organisation_id: string;
  status: 'active' | 'detached';
  application_fee_bps: number;
  claim_token_hash: string | null;
  claim_expires_at: string | null;
  claimed_at: string | null;
  detached_at: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export const CLAIM_LINK_DAYS = 7;
export const MAX_APPLICATION_FEE_BPS = 5_000;

export function findConnectedAccount(id: string): ConnectedAccountRow | undefined {
  return getDb().prepare('SELECT * FROM connected_accounts WHERE id = ?').get(id) as ConnectedAccountRow | undefined;
}
export function connectedAccountForUser(userId: string): ConnectedAccountRow | undefined {
  return getDb().prepare('SELECT * FROM connected_accounts WHERE user_id = ?').get(userId) as ConnectedAccountRow | undefined;
}

/** The connected account a platform key may act for: the platform's own, still attached. */
export function resolveConnectedAccount(platform: UserRow, id: string): { account: ConnectedAccountRow; user: UserRow; organisation: OrganisationRow; permissions: string[] } {
  const account = findConnectedAccount(id);
  if (!account || account.platform_user_id !== platform.id) throw forbidden(`Account ${id} is not connected to this platform`, 'account_not_connected');
  if (account.status !== 'active') throw forbidden(`Account ${id} was detached by its owner on ${account.detached_at}`, 'account_detached');
  const user = findUserById(account.user_id);
  if (!user || user.status !== 'active') throw forbidden(`Account ${id} is ${user?.status ?? 'missing'}`, 'account_unavailable');
  return { account, user, organisation: getOrganisation(account.organisation_id), permissions: effectivePermissions('administrator') };
}

export function accountView(row: ConnectedAccountRow) {
  const user = findUserById(row.user_id);
  const org = getOrganisation(row.organisation_id);
  const balances = user ? listWallets(user.id).map((w) => ({ currency: w.currency, balance_minor: w.balance })) : [];
  return {
    id: row.id,
    object: 'account',
    business_name: org.name,
    type: org.kind,
    email: user?.email ?? null,
    phone: user?.phone ?? null,
    country: user?.country ?? null,
    tag: user?.tag ?? null,
    status: row.status,
    kyb_status: org.kyb_status,
    kyc_status: user?.kyc_status ?? null,
    onboarding: { claimed: !!row.claimed_at, claimed_at: row.claimed_at, claim_link_expires_at: row.claim_expires_at },
    application_fee_bps: row.application_fee_bps,
    balances,
    organisation_id: row.organisation_id,
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    detached_at: row.detached_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface CreateConnectedAccountInput {
  businessName: string;
  type?: string | null;
  email?: string | null;
  phone?: string | null;
  country?: string | null;
  applicationFeeBps?: number | null;
  metadata?: Record<string, unknown> | null;
}

function assertFeeBps(bps: number | null | undefined): number {
  const v = bps ?? 0;
  if (!Number.isInteger(v) || v < 0 || v > MAX_APPLICATION_FEE_BPS) throw badRequest(`application_fee_bps must be an integer between 0 and ${MAX_APPLICATION_FEE_BPS}`, 'invalid_application_fee');
  return v;
}

/** Creates the customer's merchant account (user + organisation) with the platform as administrator member. */
export function createConnectedAccount(platform: UserRow, input: CreateConnectedAccountInput) {
  if (!isMerchantRole(platform.role)) throw forbidden('Only merchant-class accounts (a developer or platform account) create connected accounts', 'merchant_required');
  const type = (input.type ?? 'merchant') as MerchantClassRole;
  if (!(MERCHANT_CLASS_ROLES as readonly string[]).includes(type)) throw badRequest(`type must be one of ${MERCHANT_CLASS_ROLES.join(', ')}`, 'invalid_account_type');
  const name = input.businessName.trim();
  if (name.length < 2) throw badRequest('business_name needs at least 2 characters', 'invalid_name');
  if (!input.email && !input.phone) throw badRequest('The customer needs an email or a phone number: the claim link and every notice go there', 'contact_required');
  const feeBps = assertFeeBps(input.applicationFeeBps);
  const platformOrg = ensureOrganisation(platform);
  const db = getDb();
  const ts = now();
  const id = `acct_${shortCode(16).toLowerCase()}`;
  const user = createUser({
    fullName: name,
    businessName: name,
    email: input.email ?? null,
    phone: input.phone ?? null,
    country: input.country ?? platform.country ?? null,
    role: type,
    password: null,
  });
  const org = ensureOrganisation(user);
  db.transaction(() => {
    db.prepare("INSERT INTO organisation_members (organisation_id, user_id, role, permissions, invited_by, created_at, updated_at) VALUES (?, ?, 'administrator', '[]', ?, ?, ?)").run(
      org.id,
      platform.id,
      platform.id,
      ts,
      ts,
    );
    db.prepare(
      "INSERT INTO connected_accounts (id, platform_user_id, platform_organisation_id, user_id, organisation_id, status, application_fee_bps, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)",
    ).run(id, platform.id, platformOrg.id, user.id, org.id, feeBps, JSON.stringify(input.metadata ?? {}), ts, ts);
    recordEvent('auth', org.id, 'connected_account.created', { type: 'merchant', id: platform.id }, { accountId: id, userId: user.id, type, applicationFeeBps: feeBps });
  })();
  const view = accountView(findConnectedAccount(id)!);
  emitEvent(platform.id, 'account.created', { account: view }, { resource: { type: 'account', id }, account: id });
  return view;
}

export function listConnectedAccounts(platform: UserRow, opts: { status?: string | null; limit?: number } = {}) {
  const rows = getDb()
    .prepare(`SELECT * FROM connected_accounts WHERE platform_user_id = ?${opts.status ? ' AND status = ?' : ''} ORDER BY created_at DESC LIMIT ?`)
    .all(...(opts.status ? [platform.id, opts.status] : [platform.id]), Math.min(200, Math.max(1, opts.limit ?? 50))) as ConnectedAccountRow[];
  return rows.map(accountView);
}

export function getConnectedAccount(platform: UserRow, id: string) {
  const row = findConnectedAccount(id);
  if (!row || row.platform_user_id !== platform.id) throw notFound('Account not found', 'account_not_found');
  return accountView(row);
}

export function updateConnectedAccount(platform: UserRow, id: string, patch: { applicationFeeBps?: number | null; metadata?: Record<string, unknown> | null }) {
  const row = findConnectedAccount(id);
  if (!row || row.platform_user_id !== platform.id) throw notFound('Account not found', 'account_not_found');
  if (row.status !== 'active') throw conflict('A detached account cannot be changed by the platform', 'account_detached');
  const feeBps = patch.applicationFeeBps === undefined ? row.application_fee_bps : assertFeeBps(patch.applicationFeeBps);
  const metadata = patch.metadata === undefined ? row.metadata : JSON.stringify(patch.metadata ?? {});
  getDb().prepare('UPDATE connected_accounts SET application_fee_bps = ?, metadata = ?, updated_at = ? WHERE id = ?').run(feeBps, metadata, now(), id);
  return accountView(findConnectedAccount(id)!);
}

/** A one-time link (7 days) the customer opens to set a password and own the account; a new link replaces the previous one. */
export function createAccountLink(platform: UserRow, id: string): { object: 'account_link'; account: string; url: string; expires_at: string } {
  const row = findConnectedAccount(id);
  if (!row || row.platform_user_id !== platform.id) throw notFound('Account not found', 'account_not_found');
  if (row.status !== 'active') throw conflict('A detached account no longer needs the platform to onboard it', 'account_detached');
  const token = randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + CLAIM_LINK_DAYS * 86_400_000).toISOString();
  getDb().prepare('UPDATE connected_accounts SET claim_token_hash = ?, claim_expires_at = ?, updated_at = ? WHERE id = ?').run(sha256(token), expires, now(), id);
  return { object: 'account_link', account: id, url: `${config.webUrl}/claim/${token}`, expires_at: expires };
}

/** The customer opens the claim link and sets a password: from now on the account is theirs to sign into. */
export function claimConnectedAccount(token: string, password: string): { user: UserRow; account: ConnectedAccountRow } {
  if (password.length < 8) throw badRequest('Password must be at least 8 characters', 'weak_password');
  const row = getDb().prepare('SELECT * FROM connected_accounts WHERE claim_token_hash = ?').get(sha256(token)) as ConnectedAccountRow | undefined;
  if (!row || !row.claim_expires_at || row.claim_expires_at < now()) throw notFound('This claim link is invalid or has expired; ask your platform for a new one', 'claim_link_invalid');
  const user = findUserById(row.user_id);
  if (!user || user.status !== 'active') throw notFound('This account is not available', 'account_unavailable');
  const ts = now();
  const updated = updateUser(user.id, { password_hash: hashPassword(password), password_changed_at: ts } as any);
  getDb().prepare('UPDATE connected_accounts SET claim_token_hash = NULL, claim_expires_at = NULL, claimed_at = COALESCE(claimed_at, ?), updated_at = ? WHERE id = ?').run(ts, ts, row.id);
  recordEvent('auth', row.organisation_id, 'connected_account.claimed', { type: 'merchant', id: user.id }, { accountId: row.id });
  emitEvent(row.platform_user_id, 'account.claimed', { account: accountView(findConnectedAccount(row.id)!) }, { resource: { type: 'account', id: row.id }, account: row.id });
  return { user: updated, account: findConnectedAccount(row.id)! };
}

/** The claim page shows whose account this is and who sent the link, without revealing anything else. */
export function describeClaimLink(token: string): { business_name: string; platform: string; expires_at: string } {
  const row = getDb().prepare('SELECT * FROM connected_accounts WHERE claim_token_hash = ?').get(sha256(token)) as ConnectedAccountRow | undefined;
  if (!row || !row.claim_expires_at || row.claim_expires_at < now()) throw notFound('This claim link is invalid or has expired; ask your platform for a new one', 'claim_link_invalid');
  const platform = findUserById(row.platform_user_id);
  return { business_name: getOrganisation(row.organisation_id).name, platform: platform?.business_name || platform?.full_name || 'your platform', expires_at: row.claim_expires_at };
}

/**
 * Ends the platform's access: called by the platform (`POST /v1/accounts/:id/detach`) or when the customer removes
 * the platform from its Team. The account, its keys, its wallets and its history stay the customer's.
 */
export function detachConnectedAccount(row: ConnectedAccountRow, actor: { type: 'merchant' | 'admin' | 'system'; id: string }) {
  if (row.status !== 'active') return accountView(row);
  const ts = now();
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM organisation_members WHERE organisation_id = ? AND user_id = ?').run(row.organisation_id, row.platform_user_id);
    db.prepare("UPDATE connected_accounts SET status = 'detached', detached_at = ?, claim_token_hash = NULL, claim_expires_at = NULL, updated_at = ? WHERE id = ?").run(ts, ts, row.id);
    recordEvent('auth', row.organisation_id, 'connected_account.detached', actor, { accountId: row.id, by: actor.type === 'merchant' && actor.id === row.platform_user_id ? 'platform' : 'owner' });
  })();
  const view = accountView(findConnectedAccount(row.id)!);
  emitEvent(row.platform_user_id, 'account.detached', { account: view }, { resource: { type: 'account', id: row.id }, account: row.id });
  return view;
}

export function detachByPlatform(platform: UserRow, id: string) {
  const row = findConnectedAccount(id);
  if (!row || row.platform_user_id !== platform.id) throw notFound('Account not found', 'account_not_found');
  return detachConnectedAccount(row, { type: 'merchant', id: platform.id });
}

/** When an organisation owner removes a member who is a connected platform, the connection ends with the membership. */
export function onMemberRemoved(organisationId: string, memberUserId: string, actorUserId: string): void {
  const row = getDb().prepare("SELECT * FROM connected_accounts WHERE organisation_id = ? AND platform_user_id = ? AND status = 'active'").get(organisationId, memberUserId) as
    ConnectedAccountRow | undefined;
  if (row) detachConnectedAccount(row, { type: 'merchant', id: actorUserId });
}

/** What the customer sees under Team: the platform that connected the account. */
export function platformOf(userId: string): { accountId: string; platform: ReturnType<typeof toPublicUser>; since: string } | null {
  const row = connectedAccountForUser(userId);
  if (!row || row.status !== 'active') return null;
  const platform = findUserById(row.platform_user_id);
  return platform ? { accountId: row.id, platform: toPublicUser(platform), since: row.created_at } : null;
}

// Registered once at load: the Team tab shows the connecting platform, and removing it there ends the connection.
onMemberRemovedHook(onMemberRemoved);
extendOrganisationSummary((org) => ({ platform: platformOf(org.owner_user_id) }));
