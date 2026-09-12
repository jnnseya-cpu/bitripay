/**
 * Credit readiness (module 13): a signal for lenders, never lending. The score is computed from the account's own
 * ledger history — income regularity, spend discipline, savings behaviour, balance stability, account age and
 * verification, disputes and risk reviews — explained factor by factor with concrete tips. Nothing leaves the
 * platform without the account holder's consent: a lender receives the score, the band and the signals through a
 * consented access code, never the transactions themselves.
 */
import { getDb } from '../db';
import { now, shortCode } from '../lib/ids';
import { badRequest, notFound, forbidden } from '../lib/errors';
import { parseJson } from '../lib/json';
import { toBase } from './currencies';
import { getBaseCurrency } from './currencies';
import { findUserById, type UserRow } from './users';
import { recordEvent, type Actor } from './events';
import { publish } from './bus';
import { INCOME_TYPES, SPEND_TYPES } from './savings';

export type ReadinessBand = 'building' | 'fair' | 'good' | 'strong';
export interface ReadinessSignal { key: string; label: string; value: number | string | null; points: number; max: number; note: string }
export interface Readiness { userId: string; score: number; band: ReadinessBand; signals: ReadinessSignal[]; tips: string[]; computedAt: string; windowDays: number }
const WINDOW_DAYS = 180;
const bandOf = (score: number): ReadinessBand => (score >= 750 ? 'strong' : score >= 550 ? 'good' : score >= 350 ? 'fair' : 'building');

export function computeReadiness(userId: string): Readiness {
  const db = getDb();
  const user = findUserById(userId);
  if (!user) throw notFound('Account not found', 'user_not_found');
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const rows = db.prepare("SELECT type, amount, fee, currency, sender_user_id, receiver_user_id, created_at FROM transactions WHERE (sender_user_id = ? OR receiver_user_id = ?) AND status = 'completed' AND created_at >= ?").all(userId, userId, since) as any[];
  const monthly: Record<string, { income: number; spend: number }> = {};
  let income = 0;
  let spend = 0;
  let bills = 0;
  for (const t of rows) {
    const m = t.created_at.slice(0, 7);
    monthly[m] ??= { income: 0, spend: 0 };
    const base = toBase(t.amount, t.currency);
    if (t.receiver_user_id === userId && t.sender_user_id !== userId && INCOME_TYPES.has(t.type)) { income += base; monthly[m].income += base; }
    if (t.sender_user_id === userId && t.receiver_user_id !== userId && SPEND_TYPES.has(t.type)) { spend += base + toBase(t.fee ?? 0, t.currency); monthly[m].spend += base; if (t.type === 'bill_payment' || t.type === 'subscription' || t.type === 'mobile_topup') bills += 1; }
  }
  const months = Object.keys(monthly).length;
  const monthsWithIncome = Object.values(monthly).filter((m) => m.income > 0).length;
  const elapsedMonths = Math.max(1, Math.min(6, Math.ceil((Date.now() - Date.parse(user.created_at)) / (30 * 86_400_000))));
  const saved = (db.prepare("SELECT COALESCE(SUM(CASE WHEN kind IN ('anchor', 'round_up', 'manual') THEN amount_minor ELSE 0 END), 0) s, COALESCE(SUM(CASE WHEN kind = 'withdrawal' THEN -amount_minor ELSE 0 END), 0) w FROM savings_movements WHERE user_id = ? AND created_at >= ?").get(userId, since) as any);
  const balances = db.prepare("SELECT e.balance_after, w.currency FROM ledger_entries e JOIN wallets w ON w.id = e.wallet_id WHERE w.user_id = ? AND e.created_at >= ? ORDER BY e.created_at").all(userId, since) as any[];
  const balBase = balances.map((b) => toBase(b.balance_after, b.currency));
  const avgBal = balBase.length ? balBase.reduce((a, b) => a + b, 0) / balBase.length : 0;
  const minBal = balBase.length ? Math.min(...balBase) : 0;
  const disputes = (db.prepare('SELECT COUNT(*) c FROM disputes WHERE customer_user_id = ? AND created_at >= ?').get(userId, since) as any).c as number;
  const reviews = (db.prepare("SELECT COUNT(*) c FROM fraud_scores WHERE user_id = ? AND action IN ('review', 'block') AND created_at >= ?").get(userId, since) as any).c as number;
  const ageDays = Math.floor((Date.now() - Date.parse(user.created_at)) / 86_400_000);
  const tier = Number((user as any).kyc_tier ?? 0);
  const base = getBaseCurrency();
  const signals: ReadinessSignal[] = [];
  const tips: string[] = [];
  const add = (key: string, label: string, value: number | string | null, points: number, max: number, note: string, tip?: string) => { signals.push({ key, label, value, points: Math.max(0, Math.min(max, Math.round(points))), max, note }); if (tip && points < max * 0.6) tips.push(tip); };
  // 1. income regularity: months with income over months on the platform (up to six)
  const regularity = elapsedMonths > 0 ? monthsWithIncome / elapsedMonths : 0;
  add('income_regularity', 'Income regularity', Math.round(regularity * 100), regularity * 200, 200, `${monthsWithIncome} of the last ${elapsedMonths} month(s) had money coming in`, 'Receive your income into BitriPay every month: regular inflows are the strongest signal a lender looks for.');
  // 2. spend discipline: share of income kept
  const ratio = income > 0 ? spend / income : spend > 0 ? 2 : 1;
  const disciplinePts = income > 0 ? (ratio <= 0.6 ? 180 : ratio <= 0.8 ? 140 : ratio < 1 ? 90 : 20) : 0;
  add('spend_discipline', 'Spending versus income', income > 0 ? Math.round(ratio * 100) : null, disciplinePts, 180, income > 0 ? `You spent ${Math.round(ratio * 100)}% of what you received` : 'No income in the window yet', 'Keep spending under 80% of income; the wellbeing monitor shows where to trim.');
  // 3. savings behaviour: net saved over income
  const netSaved = saved.s - saved.w;
  const savingsRate = income > 0 ? netSaved / income : 0;
  add('savings', 'Savings behaviour', income > 0 ? Math.round(savingsRate * 100) : null, savingsRate >= 0.15 ? 150 : savingsRate >= 0.1 ? 120 : savingsRate > 0 ? 70 : 0, 150, netSaved > 0 ? `${Math.round(savingsRate * 100)}% of income set aside in goals` : 'Nothing set aside yet', 'Turn on the 10% anchor and round-ups; steady saving weighs more than large one-off deposits.');
  // 4. balance stability: never empty, average balance relative to monthly income
  const monthlyIncome = income / elapsedMonths;
  const stabilityPts = balBase.length === 0 ? 0 : (minBal > 0 ? 60 : 0) + (monthlyIncome > 0 ? Math.min(90, (avgBal / monthlyIncome) * 90) : avgBal > 0 ? 40 : 0);
  add('balance_stability', 'Balance stability', avgBal > 0 ? Math.round(avgBal) : 0, stabilityPts, 150, balBase.length ? `Lowest balance ${minBal <= 0 ? 'hit zero' : 'stayed above zero'}; average ${Math.round(avgBal)} ${base.code} minor units` : 'No ledger history yet', 'Keep a buffer: an account that never empties reads as dependable.');
  // 5. account age and verification
  const agePts = Math.min(60, ageDays / 3);
  const kycPts = tier >= 3 ? 60 : tier === 2 ? 45 : user.kyc_status === 'verified' ? 45 : tier === 1 ? 20 : 0;
  add('account', 'Account age and verification', ageDays, agePts + kycPts, 120, `${ageDays} day(s) old, KYC tier ${tier}${user.kyc_status === 'verified' ? ' (verified)' : ''}`, 'Complete a higher KYC tier: verified identity and address lift the ceiling of what a lender can offer.');
  // 6. bills and commitments paid
  add('commitments', 'Bills and commitments', bills, Math.min(100, bills * 12), 100, `${bills} bill, subscription or top-up payment(s) in the window`, 'Pay bills and subscriptions from BitriPay so your repayment habit is visible.');
  // 7. conduct: disputes and risk reviews subtract
  const conductPts = 100 - Math.min(100, disputes * 40 + reviews * 25);
  add('conduct', 'Disputes and risk reviews', disputes + reviews, conductPts, 100, `${disputes} dispute(s), ${reviews} movement(s) held for review`);
  const score = Math.min(1000, signals.reduce((a, s) => a + s.points, 0));
  const readiness: Readiness = { userId, score, band: bandOf(score), signals, tips, computedAt: now(), windowDays: WINDOW_DAYS };
  const prev = db.prepare('SELECT score, band FROM credit_readiness WHERE user_id = ?').get(userId) as any;
  db.prepare('INSERT INTO credit_readiness (user_id, score, band, signals, tips, computed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET score = excluded.score, band = excluded.band, signals = excluded.signals, tips = excluded.tips, computed_at = excluded.computed_at').run(userId, score, readiness.band, JSON.stringify(signals), JSON.stringify(tips), readiness.computedAt);
  if (!prev || prev.band !== readiness.band) publish('credit.readiness_updated', { userId, score, band: readiness.band, previousBand: prev?.band ?? null }, { aggregateId: userId, tenantId: userId });
  return readiness;
}
export function getReadiness(userId: string, opts: { recompute?: boolean } = {}): Readiness {
  const r = getDb().prepare('SELECT * FROM credit_readiness WHERE user_id = ?').get(userId) as any;
  if (!r || opts.recompute || Date.now() - Date.parse(r.computed_at) > 86_400_000) return computeReadiness(userId);
  return { userId, score: r.score, band: r.band, signals: parseJson(r.signals, []), tips: parseJson(r.tips, []), computedAt: r.computed_at, windowDays: WINDOW_DAYS };
}
/** Weekly job: refresh every account active in the window (the CreditReadiness agent's batch). */
export function runReadinessBatch(): { computed: number } {
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const ids = getDb().prepare("SELECT DISTINCT u.id FROM users u JOIN transactions t ON (t.sender_user_id = u.id OR t.receiver_user_id = u.id) WHERE u.is_system = 0 AND u.role IN ('user', 'merchant', 'agent') AND t.created_at >= ?").all(since) as { id: string }[];
  let computed = 0;
  for (const { id } of ids) { try { computeReadiness(id); computed += 1; } catch (err) { console.warn(`[credit] ${id}: ${(err as Error).message}`); } }
  return { computed };
}

// ---------------------------------------------------------------- consented lender access
export interface Consent { id: string; lenderName: string; purpose: string | null; accessCode: string; grantedAt: string; expiresAt: string; revokedAt: string | null; lastAccessedAt: string | null; accessCount: number; active: boolean }
const consentView = (r: any): Consent => ({ id: r.id, lenderName: r.lender_name, purpose: r.purpose, accessCode: r.access_code, grantedAt: r.granted_at, expiresAt: r.expires_at, revokedAt: r.revoked_at, lastAccessedAt: r.last_accessed_at, accessCount: r.access_count, active: !r.revoked_at && r.expires_at > now() });
export function grantConsent(user: UserRow, input: { lenderName: string; purpose?: string | null; days?: number | null }, actor: Actor): Consent {
  if (!input.lenderName?.trim()) throw badRequest('Name the lender you are sharing with', 'lender_required');
  const days = Math.min(365, Math.max(1, input.days ?? 90));
  const id = `crc_${shortCode(8).toLowerCase()}`;
  const code = `CR-${shortCode(6).toUpperCase()}-${shortCode(6).toUpperCase()}`;
  getDb().prepare('INSERT INTO credit_consents (id, user_id, lender_name, purpose, access_code, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, user.id, input.lenderName.trim(), input.purpose ?? null, code, now(), new Date(Date.now() + days * 86_400_000).toISOString());
  recordEvent('risk', user.id, 'credit.consent_granted', actor, { consentId: id, lender: input.lenderName.trim(), days });
  return consentView(getDb().prepare('SELECT * FROM credit_consents WHERE id = ?').get(id));
}
export function listConsents(userId: string): Consent[] { return (getDb().prepare('SELECT * FROM credit_consents WHERE user_id = ? ORDER BY granted_at DESC').all(userId) as any[]).map(consentView); }
export function revokeConsent(user: UserRow, id: string, actor: Actor): Consent {
  const r = getDb().prepare('UPDATE credit_consents SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(now(), id, user.id);
  if (!r.changes) throw notFound('Consent not found or already revoked', 'consent_not_found');
  recordEvent('risk', user.id, 'credit.consent_revoked', actor, { consentId: id });
  return consentView(getDb().prepare('SELECT * FROM credit_consents WHERE id = ?').get(id));
}
/** What a lender sees with a live consent code: score, band, signals and tips — never the underlying transactions. */
export function readinessForLender(accessCode: string, lender: { id: string; label: string }) {
  const c = getDb().prepare('SELECT * FROM credit_consents WHERE access_code = ?').get(accessCode.trim().toUpperCase()) as any;
  if (!c) throw notFound('Unknown access code', 'consent_not_found');
  if (c.revoked_at) throw forbidden('The account holder revoked this consent', 'consent_revoked');
  if (c.expires_at <= now()) throw forbidden('This consent has expired', 'consent_expired');
  getDb().prepare('UPDATE credit_consents SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?').run(now(), c.id);
  recordEvent('risk', c.user_id, 'credit.readiness_accessed', { type: 'system' }, { consentId: c.id, lender: c.lender_name, by: lender.label, keyId: lender.id });
  const r = getReadiness(c.user_id);
  const u = findUserById(c.user_id)!;
  return { consent: { id: c.id, lender: c.lender_name, purpose: c.purpose, expiresAt: c.expires_at }, subject: { reference: u.tag, country: u.country, kycTier: Number((u as any).kyc_tier ?? 0), accountAgeDays: Math.floor((Date.now() - Date.parse(u.created_at)) / 86_400_000) }, score: r.score, band: r.band, signals: r.signals.map((s) => ({ key: s.key, label: s.label, points: s.points, max: s.max, note: s.note })), computedAt: r.computedAt, disclaimer: 'A readiness signal computed from the account\'s own BitriPay history. It is not a credit decision and BitriPay does not lend.' };
}
