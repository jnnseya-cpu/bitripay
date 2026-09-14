/**
 * KYC tiers and their limits. Tier 1 (basic: verified contact, name, country), Tier 2 (standard: identity document
 * and selfie), Tier 3 (enhanced: proof of address not older than 90 days), Tier 4 (business: KYB). Limits are
 * configured per tier and per country — nothing is hard-coded — and evaluated in the base currency at the live
 * rate. A breach is refused with a BP-5xxx code and audited. Accounts that were never tiered keep the legacy
 * verified / unverified limits, so nothing changes for them until they opt in.
 */
import { getDb } from '../../db';
import { now, uuid } from '../../lib/ids';
import { parseJson } from '../../lib/json';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { getSetting } from '../settings';
import { toBase } from '../currencies';
import { recordEvent, type Actor } from '../events';
import { findUserById, updateUser, toPublicUser, type UserRow } from '../users';
import { notify } from '../notifications';
import { publish } from '../bus';

export interface TierLimits {
  perTransaction: number;
  daily: number;
  monthly: number;
}
/** Maximum total wallet balance (base minor) per tier; null = no ceiling. */
export type BalanceCaps = Record<string, number | null>;
export interface KycTierSettings {
  /** Base-currency minor units per tier; tier 4 (business) is null = custom / no platform ceiling. */
  default: Record<string, TierLimits | null>;
  countries: Record<string, Partial<Record<string, TierLimits | null>>>;
  /** Balance ceilings per tier, platform-wide and per country (same shape as the transaction limits). */
  balanceCaps: { default: BalanceCaps; countries: Record<string, Partial<BalanceCaps>> };
  addressDocMaxAgeDays: number;
  /** Monthly collection volume (base minor) above which a merchant must complete KYB. */
  kybMonthlyVolumeThreshold: number;
}
/**
 * Per-country seed values, in base-currency minor units (USD cents at the default base). They follow the shape of
 * each regulator's tiered-KYC schedule and are deliberately conservative; every figure is admin-editable under
 * Risk › KYC tiers and none is read anywhere but through the settings. Seed values, adjust per licence:
 *  - CD: BCC e-money instruction (compte de monnaie électronique, three categories) – the platform default schedule.
 *  - KE: CBK National Payment System regulations / operator wallet limits (≈ KES 250k per transaction, 500k daily).
 *  - NG: CBN three-tier KYC (tier 1 ≈ NGN 50k per transaction, 300k daily/balance; tier 2 ≈ NGN 100k / 500k).
 *  - GH: Bank of Ghana e-money guidelines (minimum / medium / enhanced KYC daily, monthly and balance ceilings).
 *  - SN: BCEAO instruction 008-05-2015 (e-money balance ≈ XOF 2M, monthly ≈ XOF 10M at full KYC).
 *  - UG: Bank of Uganda National Payment Systems Act tiers (≈ UGX 5M per transaction, 10M daily).
 *  - GB: MLR 2017 reg. 38 simplified due diligence for e-money (£250 stored / monthly), full CDD above.
 *  - FR: 5AMLD art. 12 / ACPR (€150 anonymous e-money ceiling), full CDD above.
 *  - US: FinCEN prepaid access rule (31 CFR 1010.100(ww): $1,000 daily load / withdrawal for limited-KYC access).
 */
const COUNTRY_SEEDS: Record<string, Record<string, TierLimits | null>> = {
  CD: {
    '1': { perTransaction: 5_000, daily: 5_000, monthly: 20_000 },
    '2': { perTransaction: 50_000, daily: 50_000, monthly: 200_000 },
    '3': { perTransaction: 500_000, daily: 500_000, monthly: 2_000_000 },
    '4': null,
  },
  KE: {
    '1': { perTransaction: 10_000, daily: 30_000, monthly: 100_000 },
    '2': { perTransaction: 190_000, daily: 380_000, monthly: 1_500_000 },
    '3': { perTransaction: 500_000, daily: 1_000_000, monthly: 4_000_000 },
    '4': null,
  },
  NG: {
    '1': { perTransaction: 3_500, daily: 20_000, monthly: 60_000 },
    '2': { perTransaction: 7_000, daily: 35_000, monthly: 150_000 },
    '3': { perTransaction: 350_000, daily: 700_000, monthly: 3_000_000 },
    '4': null,
  },
  GH: {
    '1': { perTransaction: 2_000, daily: 2_000, monthly: 20_000 },
    '2': { perTransaction: 13_000, daily: 13_000, monthly: 130_000 },
    '3': { perTransaction: 33_000, daily: 33_000, monthly: 330_000 },
    '4': null,
  },
  SN: {
    '1': { perTransaction: 20_000, daily: 50_000, monthly: 200_000 },
    '2': { perTransaction: 100_000, daily: 330_000, monthly: 1_650_000 },
    '3': { perTransaction: 330_000, daily: 1_000_000, monthly: 5_000_000 },
    '4': null,
  },
  UG: {
    '1': { perTransaction: 5_000, daily: 15_000, monthly: 60_000 },
    '2': { perTransaction: 135_000, daily: 270_000, monthly: 1_000_000 },
    '3': { perTransaction: 270_000, daily: 700_000, monthly: 3_000_000 },
    '4': null,
  },
  GB: {
    '1': { perTransaction: 25_000, daily: 25_000, monthly: 30_000 },
    '2': { perTransaction: 250_000, daily: 500_000, monthly: 2_000_000 },
    '3': { perTransaction: 1_000_000, daily: 2_500_000, monthly: 10_000_000 },
    '4': null,
  },
  FR: {
    '1': { perTransaction: 15_000, daily: 15_000, monthly: 16_000 },
    '2': { perTransaction: 250_000, daily: 500_000, monthly: 2_000_000 },
    '3': { perTransaction: 1_000_000, daily: 2_500_000, monthly: 10_000_000 },
    '4': null,
  },
  US: {
    '1': { perTransaction: 50_000, daily: 100_000, monthly: 200_000 },
    '2': { perTransaction: 300_000, daily: 500_000, monthly: 2_000_000 },
    '3': { perTransaction: 1_000_000, daily: 2_500_000, monthly: 10_000_000 },
    '4': null,
  },
};
/** Balance ceilings from the same schedules (seed values, adjust per licence). */
const BALANCE_SEEDS: Record<string, BalanceCaps> = {
  CD: { '1': 50_000, '2': 300_000, '3': 2_000_000, '4': null },
  KE: { '1': 50_000, '2': 380_000, '3': 1_000_000, '4': null },
  NG: { '1': 20_000, '2': 35_000, '3': 3_500_000, '4': null },
  GH: { '1': 7_000, '2': 65_000, '3': 130_000, '4': null },
  SN: { '1': 100_000, '2': 330_000, '3': 1_000_000, '4': null },
  UG: { '1': 30_000, '2': 270_000, '3': 700_000, '4': null },
  GB: { '1': 30_000, '2': 1_000_000, '3': 5_000_000, '4': null },
  FR: { '1': 16_000, '2': 1_000_000, '3': 5_000_000, '4': null },
  US: { '1': 100_000, '2': 1_000_000, '3': 5_000_000, '4': null },
};
const DEFAULT: KycTierSettings = {
  // The platform default schedule is the home-market (DRC) schedule; other countries override it below.
  default: { ...COUNTRY_SEEDS.CD },
  countries: COUNTRY_SEEDS,
  balanceCaps: { default: { ...BALANCE_SEEDS.CD }, countries: BALANCE_SEEDS },
  addressDocMaxAgeDays: 90,
  kybMonthlyVolumeThreshold: 1_000_000,
};
/** Stored per-country entries override the seeds tier by tier, so an admin edit never wipes the other tiers of a country. */
function mergeCountries<T>(seed: Record<string, Partial<Record<string, T>>>, stored: Record<string, Partial<Record<string, T>>> | undefined) {
  const out: Record<string, Partial<Record<string, T>>> = {};
  for (const cc of new Set([...Object.keys(seed), ...Object.keys(stored ?? {})])) out[cc] = { ...(seed[cc] ?? {}), ...(stored?.[cc] ?? {}) };
  return out;
}
export const getKycTierSettings = (): KycTierSettings => {
  const s = getSetting<Partial<KycTierSettings>>('kycTiers', {});
  return {
    ...DEFAULT,
    ...s,
    default: { ...DEFAULT.default, ...(s.default ?? {}) },
    countries: mergeCountries(DEFAULT.countries, s.countries),
    balanceCaps: { default: { ...DEFAULT.balanceCaps.default, ...(s.balanceCaps?.default ?? {}) }, countries: mergeCountries(DEFAULT.balanceCaps.countries, s.balanceCaps?.countries) },
  };
};

export const TIER_LABELS: Record<number, string> = { 0: 'Not tiered', 1: 'Tier 1 · Basic', 2: 'Tier 2 · Standard', 3: 'Tier 3 · Enhanced', 4: 'Tier 4 · Business' };

/** Limits for a user's tier in its country (null = no ceiling; undefined = not tiered → legacy limits). */
export function tierLimitsFor(user: { kyc_tier?: number | null; country?: string | null }): TierLimits | null | undefined {
  const tier = user.kyc_tier ?? 0;
  if (!tier) return undefined;
  const s = getKycTierSettings();
  const cc = (user.country ?? '').toUpperCase();
  const byCountry = cc && s.countries[cc] ? s.countries[cc][String(tier)] : undefined;
  return byCountry !== undefined ? byCountry : (s.default[String(tier)] ?? null);
}

/** Balance ceiling for a user's tier in its country (null = no ceiling; undefined = not tiered). */
export function balanceCapFor(user: { kyc_tier?: number | null; country?: string | null }): number | null | undefined {
  const tier = user.kyc_tier ?? 0;
  if (!tier) return undefined;
  const s = getKycTierSettings();
  const cc = (user.country ?? '').toUpperCase();
  const byCountry = cc && s.balanceCaps.countries[cc] ? s.balanceCaps.countries[cc][String(tier)] : undefined;
  return byCountry !== undefined ? byCountry : (s.balanceCaps.default[String(tier)] ?? null);
}

function heldBase(userId: string): number {
  const rows = getDb().prepare('SELECT balance, currency FROM wallets WHERE user_id = ?').all(userId) as { balance: number; currency: string }[];
  return rows.reduce((sum, r) => sum + toBase(r.balance, r.currency), 0);
}

/** A credit that would push a tiered account's total balance above its tier ceiling is refused (BP-5xxx) and audited. */
export function assertBalanceCap(user: UserRow & { kyc_tier?: number | null }, amount: number, currency: string): void {
  const cap = balanceCapFor(user);
  if (cap === undefined || cap === null || !cap) return;
  const base = toBase(amount, currency);
  const held = heldBase(user.id);
  if (held + base <= cap) return;
  const tier = user.kyc_tier ?? 0;
  recordEvent('risk', user.id, 'kyc_limit.breach', { type: 'system' }, { tier, code: 'balance_cap_exceeded', base, currency, amount, held, limit: cap, scope: 'balance' });
  throw unprocessable(`This would exceed the balance limit of your ${TIER_LABELS[tier]} level. Upgrade your verification to hold more.`, 'balance_cap_exceeded', {
    tier,
    label: TIER_LABELS[tier],
    limit: cap,
    held,
    scope: 'balance',
  });
}

function usedBase(userId: string, sinceMs: number): number {
  const rows = getDb()
    .prepare("SELECT amount, currency FROM transactions WHERE sender_user_id = ? AND status IN ('pending','completed') AND created_at >= ? AND type NOT IN ('exchange')")
    .all(userId, new Date(Date.now() - sinceMs).toISOString()) as { amount: number; currency: string }[];
  return rows.reduce((sum, r) => sum + toBase(r.amount, r.currency), 0);
}

/** Server-side limit check for tiered accounts. Returns false when the account is not tiered (caller applies legacy limits). */
export function enforceTierLimits(user: UserRow & { kyc_tier?: number | null }, amount: number, currency: string): boolean {
  const limits = tierLimitsFor(user);
  if (limits === undefined) return false;
  if (limits === null) return true;
  const base = toBase(amount, currency);
  const tier = user.kyc_tier ?? 0;
  const breach = (code: string, message: string, detail: Record<string, unknown>) => {
    recordEvent('risk', user.id, 'kyc_limit.breach', { type: 'system' }, { tier, code, base, currency, amount, ...detail });
    throw unprocessable(message, code, { tier, label: TIER_LABELS[tier], ...detail });
  };
  if (limits.perTransaction && base > limits.perTransaction)
    breach('kyc_tier_limit', `Amount exceeds the per-transaction limit of your ${TIER_LABELS[tier]} level. Upgrade your verification to send more.`, {
      limit: limits.perTransaction,
      scope: 'per_transaction',
    });
  if (limits.daily && usedBase(user.id, 86_400_000) + base > limits.daily)
    breach('daily_limit_exceeded', `This would exceed the daily limit of your ${TIER_LABELS[tier]} level.`, { limit: limits.daily, scope: 'daily' });
  if (limits.monthly && usedBase(user.id, 30 * 86_400_000) + base > limits.monthly)
    breach('monthly_limit_exceeded', `This would exceed the 30-day limit of your ${TIER_LABELS[tier]} level.`, { limit: limits.monthly, scope: 'monthly' });
  return true;
}

export function tierStatus(user: UserRow & { kyc_tier?: number | null; kyb_status?: string }) {
  const tier = user.kyc_tier ?? 0;
  const limits = tierLimitsFor(user);
  return {
    tier,
    label: TIER_LABELS[tier],
    limits: limits === undefined ? null : limits,
    balanceCap: tier ? (balanceCapFor(user) ?? null) : null,
    usage: tier ? { daily: usedBase(user.id, 86_400_000), monthly: usedBase(user.id, 30 * 86_400_000), balance: heldBase(user.id) } : null,
    kybStatus: user.kyb_status ?? 'none',
    next:
      tier === 0
        ? 'Activate Tier 1 with a verified phone or email, your name and country.'
        : tier === 1
          ? 'Submit an identity document and a selfie for Tier 2.'
          : tier === 2
            ? 'Add a proof of address (≤ 90 days) for Tier 3.'
            : tier === 3
              ? 'Businesses can complete KYB for Tier 4.'
              : null,
  };
}

export function setTier(userId: string, tier: number, actor: Actor, reason: string): UserRow {
  if (![0, 1, 2, 3, 4].includes(tier)) throw badRequest('Tier must be 0–4', 'validation_error');
  const u = findUserById(userId);
  if (!u) throw notFound('User not found', 'user_not_found');
  const before = (u as any).kyc_tier ?? 0;
  updateUser(userId, { kyc_tier: tier } as any);
  recordEvent('risk', userId, 'kyc.tier_changed', actor, { from: before, to: tier, reason });
  publish('kyc.tier_changed', { userId, from: before, to: tier, reason }, { aggregateId: userId, tenantId: userId });
  if (before !== tier) notify(userId, tier > before ? 'Verification level upgraded' : 'Verification level changed', `${TIER_LABELS[tier]} is now active on your account.`, { kind: 'kyc', tier });
  return findUserById(userId)!;
}

/** Tier 1 self-activation: needs a verified contact, a name and a country. */
export function activateTier1(user: UserRow): UserRow {
  if (((user as any).kyc_tier ?? 0) >= 1) return user;
  if (!user.email_verified && !user.phone_verified) throw unprocessable('Verify your phone number or email address first', 'contact_unverified');
  if (!user.full_name?.trim() || !user.country) throw unprocessable('Add your full name and country first', 'profile_incomplete');
  return setTier(user.id, 1, { type: 'user', id: user.id }, 'self-activation');
}

// ---------------------------------------------------------------------------------------------------------------------
// KYB (business verification, Tier 4)
// ---------------------------------------------------------------------------------------------------------------------
export interface KybInput {
  legalName: string;
  registrationNumber: string;
  country: string;
  address: string;
  mcc?: string | null;
  expectedMonthlyVolume: number;
  licenceRef?: string | null;
  directors: { name: string; userId?: string | null; role?: string | null }[];
  documents?: { kind: string; ref: string }[];
}
const toKyb = (r: any) => ({
  id: r.id,
  userId: r.user_id,
  legalName: r.legal_name,
  registrationNumber: r.registration_number,
  country: r.country,
  address: r.address,
  mcc: r.mcc,
  expectedMonthlyVolume: r.expected_monthly_volume,
  licenceRef: r.licence_ref,
  directors: parseJson(r.directors, []),
  documents: parseJson(r.documents, []),
  status: r.status,
  note: r.note,
  reviewedBy: r.reviewed_by,
  reviewedAt: r.reviewed_at,
  createdAt: r.created_at,
  user: findUserById(r.user_id) ? toPublicUser(findUserById(r.user_id)!) : null,
});

export function submitKyb(user: UserRow, input: KybInput) {
  const db = getDb();
  if (user.role !== 'merchant' && user.role !== 'agent') throw badRequest('Only business accounts (merchants, agents) complete KYB', 'kyb_not_applicable');
  if ((user as any).kyb_status === 'verified') throw conflict('Your business is already verified', 'kyb_verified');
  if (db.prepare("SELECT 1 FROM kyb_submissions WHERE user_id = ? AND status = 'pending'").get(user.id)) throw conflict('A KYB submission is already under review', 'kyb_pending');
  if (!input.directors.length) throw badRequest('At least one director or beneficial owner is required', 'validation_error');
  // every director linked to a BitriPay account must hold Tier 2 or higher
  for (const d of input.directors) {
    if (d.userId) {
      const du = findUserById(d.userId) as any;
      if (!du) throw badRequest(`Director ${d.name}: account ${d.userId} not found`, 'validation_error');
      if ((du.kyc_tier ?? 0) < 2) throw unprocessable(`Director ${d.name} must complete Tier 2 identity verification first`, 'director_kyc_required', { userId: d.userId });
    }
  }
  const id = uuid();
  db.prepare(
    'INSERT INTO kyb_submissions (id, user_id, legal_name, registration_number, country, address, mcc, expected_monthly_volume, licence_ref, directors, documents, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    user.id,
    input.legalName.trim(),
    input.registrationNumber.trim(),
    input.country.toUpperCase(),
    input.address.trim(),
    input.mcc ?? null,
    Math.max(0, Math.round(input.expectedMonthlyVolume)),
    input.licenceRef ?? null,
    JSON.stringify(input.directors),
    JSON.stringify(input.documents ?? []),
    'pending',
    now(),
  );
  updateUser(user.id, { kyb_status: 'pending' } as any);
  recordEvent(
    'risk',
    user.id,
    'kyb.submitted',
    { type: user.role === 'agent' ? 'agent' : 'merchant', id: user.id },
    { submissionId: id, country: input.country.toUpperCase(), expectedMonthlyVolume: input.expectedMonthlyVolume },
  );
  return toKyb(db.prepare('SELECT * FROM kyb_submissions WHERE id = ?').get(id));
}
export function latestKyb(userId: string) {
  const r = getDb().prepare('SELECT * FROM kyb_submissions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(userId);
  return r ? toKyb(r) : null;
}
export function listKyb(status?: string | null, limit = 100) {
  return (
    getDb()
      .prepare(`SELECT * FROM kyb_submissions ${status ? 'WHERE status = ?' : ''} ORDER BY created_at DESC LIMIT ?`)
      .all(...(status ? [status] : []), limit) as any[]
  ).map(toKyb);
}
export function getKyb(id: string) {
  const r = getDb().prepare('SELECT * FROM kyb_submissions WHERE id = ?').get(id);
  if (!r) throw notFound('KYB submission not found', 'kyb_not_found');
  return toKyb(r);
}
export function reviewKyb(id: string, adminId: string, decision: 'verified' | 'rejected', note?: string | null) {
  const db = getDb();
  const r = db.prepare('SELECT * FROM kyb_submissions WHERE id = ?').get(id) as any;
  if (!r) throw notFound('KYB submission not found', 'kyb_not_found');
  if (r.status !== 'pending') throw conflict('Submission already reviewed', 'kyb_reviewed');
  db.prepare('UPDATE kyb_submissions SET status = ?, note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?').run(decision, note ?? null, adminId, now(), id);
  updateUser(r.user_id, { kyb_status: decision } as any);
  if (decision === 'verified') setTier(r.user_id, 4, { type: 'admin', id: adminId }, `KYB ${id} verified`);
  recordEvent('risk', r.user_id, `kyb.${decision}`, { type: 'admin', id: adminId }, { submissionId: id, note: note ?? null });
  notify(
    r.user_id,
    decision === 'verified' ? 'Business verified' : 'Business verification rejected',
    decision === 'verified' ? 'Your business is verified (Tier 4). Business limits are now active.' : `Your KYB submission was rejected${note ? `: ${note}` : ''}. You can submit again.`,
    { kind: 'kyc' },
  );
  return getKyb(id);
}

/** Merchants above the monthly collection threshold must have KYB; refused with BP-5007 until they do. */
export function assertKybIfRequired(merchant: UserRow & { kyb_status?: string }) {
  if ((merchant.kyb_status ?? 'none') === 'verified') return;
  const threshold = getKycTierSettings().kybMonthlyVolumeThreshold;
  if (!threshold) return;
  const rows = getDb()
    .prepare("SELECT amount, currency FROM transactions WHERE receiver_user_id = ? AND status = 'completed' AND type IN ('merchant_payment', 'qr_payment') AND created_at >= ?")
    .all(merchant.id, new Date(Date.now() - 30 * 86_400_000).toISOString()) as { amount: number; currency: string }[];
  const volume = rows.reduce((s, r) => s + toBase(r.amount, r.currency), 0);
  if (volume >= threshold) {
    recordEvent('risk', merchant.id, 'kyb.required', { type: 'system' }, { volume, threshold });
    throw unprocessable('Your business has reached the volume that requires business verification (KYB). Complete it to keep accepting payments.', 'kyb_required', { volume, threshold });
  }
}
