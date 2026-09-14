import { getDb } from '../db';
import { uuid, now, shortCode } from '../lib/ids';
import { hashPassword } from '../lib/password';
import { badRequest, conflict, notFound } from '../lib/errors';
import { parseJson } from '../lib/json';
import { MERCHANT_CLASS_ROLES, type PublicUser, type Role, type User } from '@bitripay/shared';
import { ensureWallet } from './wallets';
import { getBaseCurrency } from './currencies';

const COLORS = ['#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#d97706', '#16a34a', '#0d9488', '#0891b2', '#4f46e5'];

export interface UserRow {
  id: string;
  tag: string;
  email: string | null;
  phone: string | null;
  password_hash: string | null;
  full_name: string;
  role: Role;
  avatar_color: string;
  country: string | null;
  business_name: string | null;
  pin_hash: string | null;
  kyc_status: User['kycStatus'];
  status: 'active' | 'suspended';
  email_verified: number;
  phone_verified: number;
  two_factor_secret: string | null;
  two_factor_enabled: number;
  referral_code: string;
  referred_by: string | null;
  agent_commission_bps: number | null;
  webhook_url: string | null;
  webhook_secret: string | null;
  gateway_settings: string;
  language: string;
  is_system: number;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Merchant-class account types (merchant, corporate, ngo, government, developer): every one of them gets an organisation and the merchant surfaces. */
export const MERCHANT_ROLES: readonly Role[] = MERCHANT_CLASS_ROLES;
export function isMerchantRole(role: Role | string | null | undefined): boolean {
  return !!role && (MERCHANT_CLASS_ROLES as readonly string[]).includes(role);
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    tag: row.tag,
    fullName: row.full_name,
    role: row.role,
    avatarColor: row.avatar_color,
    businessName: row.business_name,
    country: row.country,
  };
}

export function toUser(row: UserRow): User {
  return {
    ...toPublicUser(row),
    email: row.email,
    phone: row.phone,
    emailVerified: !!row.email_verified,
    phoneVerified: !!row.phone_verified,
    kycStatus: row.kyc_status,
    status: row.status,
    hasPin: !!row.pin_hash,
    twoFactorEnabled: !!row.two_factor_enabled,
    loudAlerts: (row as any).loud_alerts === undefined ? true : !!(row as any).loud_alerts,
    referralCode: row.referral_code,
    referredBy: row.referred_by,
    agentCommissionBps: row.agent_commission_bps,
    webhookUrl: row.webhook_url,
    createdAt: row.created_at,
  };
}

export function normalizeEmail(email?: string | null): string | null {
  const e = email?.trim().toLowerCase();
  return e ? e : null;
}

import { normalizePhone } from '@bitripay/shared';
export { normalizePhone };

export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^@/, '').toLowerCase();
}

export function findUserById(id: string): UserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function getUserById(id: string): UserRow {
  const u = findUserById(id);
  if (!u) throw notFound('User not found', 'user_not_found');
  return u;
}

export function findUserByEmail(email: string): UserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email)) as UserRow | undefined;
}

export function findUserByPhone(phone: string): UserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE phone = ?').get(normalizePhone(phone)) as UserRow | undefined;
}

export function findUserByTag(tag: string): UserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE tag = ?').get(normalizeTag(tag)) as UserRow | undefined;
}

/** Find a user by tag, @tag, email, phone or id. */
export function findUserByIdentifier(identifier: string): UserRow | undefined {
  const value = identifier.trim();
  if (!value) return undefined;
  if (value.includes('@') && !value.startsWith('@')) return findUserByEmail(value);
  if (/^\+?\d{7,15}$/.test(value.replace(/[\s-]/g, ''))) return findUserByPhone(value) || findUserByTag(value);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(value)) return findUserById(value);
  return findUserByTag(value);
}

function uniqueTag(base: string): string {
  const db = getDb();
  let candidate =
    base
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, 20) || 'user';
  if (candidate.length < 3) candidate = candidate.padEnd(3, '0');
  let attempt = candidate;
  let i = 0;
  while (db.prepare('SELECT 1 FROM users WHERE tag = ?').get(attempt)) {
    i += 1;
    attempt = `${candidate}${Math.floor(Math.random() * 9000 + 1000)}`;
    if (i > 20) attempt = `${candidate}${shortCode(4).toLowerCase()}`;
  }
  return attempt;
}

export interface CreateUserInput {
  email?: string | null;
  phone?: string | null;
  password?: string | null;
  fullName: string;
  role?: Role;
  tag?: string;
  country?: string | null;
  businessName?: string | null;
  referralCode?: string | null;
  isSystem?: boolean;
  emailVerified?: boolean;
  phoneVerified?: boolean;
}

export function createUser(input: CreateUserInput): UserRow {
  const db = getDb();
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);
  if (!email && !phone && !input.isSystem) throw badRequest('Email or phone number is required');
  if (email && findUserByEmail(email)) throw conflict('An account with this email already exists', 'email_taken');
  if (phone && findUserByPhone(phone)) throw conflict('An account with this phone number already exists', 'phone_taken');
  let tag: string;
  if (input.tag) {
    tag = normalizeTag(input.tag);
    if (!/^[a-z0-9_]{3,20}$/.test(tag)) throw badRequest('Tag must be 3-20 characters: letters, numbers, underscore', 'invalid_tag');
    if (findUserByTag(tag)) throw conflict('This tag is already taken', 'tag_taken');
  } else {
    const base = email ? email.split('@')[0] : input.fullName.split(' ')[0] || 'user';
    tag = uniqueTag(base);
  }
  let referredBy: string | null = null;
  if (input.referralCode) {
    const ref = db.prepare('SELECT id FROM users WHERE referral_code = ? OR tag = ?').get(input.referralCode.trim().toUpperCase(), normalizeTag(input.referralCode)) as { id: string } | undefined;
    if (!ref) throw badRequest('Invalid referral code', 'invalid_referral');
    referredBy = ref.id;
  }
  const id = uuid();
  const ts = now();
  db.prepare(
    `INSERT INTO users (id, tag, email, phone, password_hash, full_name, role, avatar_color, country, business_name, referral_code, referred_by, email_verified, phone_verified, is_system, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    tag,
    email,
    phone,
    input.password ? hashPassword(input.password) : null,
    input.fullName.trim(),
    input.role || 'user',
    COLORS[Math.floor(Math.random() * COLORS.length)],
    input.country || null,
    input.businessName || null,
    `BP${shortCode(6)}`,
    referredBy,
    input.emailVerified ? 1 : 0,
    input.phoneVerified ? 1 : 0,
    input.isSystem ? 1 : 0,
    ts,
    ts,
  );
  ensureWallet(id, getBaseCurrency().code);
  return getUserById(id);
}

export function updateUser(id: string, fields: Partial<Record<keyof UserRow, unknown>>): UserRow {
  const keys = Object.keys(fields).filter((k) => fields[k as keyof UserRow] !== undefined);
  if (keys.length === 0) return getUserById(id);
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => fields[k as keyof UserRow]);
  getDb()
    .prepare(`UPDATE users SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...values, now(), id);
  return getUserById(id);
}

export function getGatewaySettings(row: UserRow): MerchantGatewaySettings {
  return { ...DEFAULT_GATEWAY_SETTINGS, ...parseJson<Partial<MerchantGatewaySettings>>(row.gateway_settings, {}) };
}

export interface MerchantGatewaySettings {
  /** Which methods this merchant accepts on hosted checkout. */
  methods: Array<'wallet' | 'card' | 'mobile_money' | 'bank' | 'virtual_card'>;
  settlementCurrency: string | null;
  autoSettle: boolean;
  successUrl: string | null;
  cancelUrl: string | null;
  brandColor: string;
  logoUrl: string | null;
  testMode: boolean;
}

export const DEFAULT_GATEWAY_SETTINGS: MerchantGatewaySettings = {
  methods: ['wallet', 'card', 'mobile_money', 'virtual_card'],
  settlementCurrency: null,
  autoSettle: false,
  successUrl: null,
  cancelUrl: null,
  brandColor: '#2563eb',
  logoUrl: null,
  testMode: false,
};

/** Fetch multiple users by id for enriching lists. */
export function usersById(ids: string[]): Map<string, PublicUser> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  const map = new Map<string, PublicUser>();
  if (unique.length === 0) return map;
  const rows = getDb()
    .prepare(`SELECT * FROM users WHERE id IN (${unique.map(() => '?').join(',')})`)
    .all(...unique) as UserRow[];
  for (const r of rows) map.set(r.id, toPublicUser(r));
  return map;
}

export function getSystemUser(tag: 'treasury' | 'fees' | 'escrow'): UserRow {
  const db = getDb();
  const systemTag = `bitripay_${tag}`;
  let row = findUserByTag(systemTag);
  if (!row) {
    const names = { treasury: 'BitriPay Treasury', fees: 'BitriPay Revenue', escrow: 'BitriPay Escrow' };
    row = createUser({ fullName: names[tag], tag: systemTag, role: 'admin', isSystem: true, email: `${systemTag}@system.local`, emailVerified: true });
    db.prepare("UPDATE users SET status = 'active', is_system = 1 WHERE id = ?").run(row.id);
  }
  return row;
}
