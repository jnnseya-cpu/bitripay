/**
 * Fraud scoring (0–100) for every money movement, from the inputs the product rules name: velocity over 1h / 24h /
 * 7d, deviation from the account's usual amounts, recipient risk, method risk, KYC-limit mismatch, time of day,
 * device and geolocation, and the sanctions screen. The score feeds the central policy, which decides
 * allow / step-up / review / block; a block opens a compliance case with a SAR draft. Rule-based controls are
 * platform-funded: they run for every account, always, and cost the account holder nothing.
 */
import { getDb } from '../../db';
import { now, shortCode } from '../../lib/ids';
import { parseJson } from '../../lib/json';
import { getSetting } from '../settings';
import { toBase } from '../currencies';
import { evaluatePolicy, type PolicyDecision } from './policy';
import { tierLimitsFor } from './kycTiers';

export interface FraudSettings {
  bands: { stepUp: number; review: number; block: number };
  methodRisk: Record<string, number>;
  velocityThresholds: { hour: number; day: number; week: number };
  velocityPoints: { hour: number; day: number; week: number };
  amountDeviationPoints: number;
  newBeneficiaryPoints: number;
  recipientRiskPoints: number;
  kycMismatchPoints: number;
  nightHours: [number, number];
  nightPoints: number;
  newDevicePoints: number;
  geoMismatchPoints: number;
  structuringPoints: number;
  /** Politically exposed person on the list: enhanced due diligence, never a block by itself. */
  pepPoints: number;
  /** Movements below this base-currency amount skip the behavioural factors (sanctions still apply). */
  minScoredBase: number;
}
const DEFAULT: FraudSettings = {
  bands: { stepUp: 31, review: 61, block: 81 },
  methodRisk: { card: 15, mobile_money: 5, bank: 5, wallet: 0, agent: 5, national_switch: 5, processor: 10 },
  velocityThresholds: { hour: 10, day: 40, week: 150 },
  velocityPoints: { hour: 20, day: 15, week: 10 },
  amountDeviationPoints: 25,
  newBeneficiaryPoints: 10,
  recipientRiskPoints: 25,
  kycMismatchPoints: 30,
  nightHours: [0, 5],
  nightPoints: 8,
  newDevicePoints: 15,
  geoMismatchPoints: 20,
  structuringPoints: 30,
  pepPoints: 45,
  minScoredBase: 0,
};
export const getFraudSettings = (): FraudSettings => {
  const s = getSetting<Partial<FraudSettings>>('fraud', {});
  return { ...DEFAULT, ...s, bands: { ...DEFAULT.bands, ...(s.bands ?? {}) }, methodRisk: { ...DEFAULT.methodRisk, ...(s.methodRisk ?? {}) }, velocityThresholds: { ...DEFAULT.velocityThresholds, ...(s.velocityThresholds ?? {}) }, velocityPoints: { ...DEFAULT.velocityPoints, ...(s.velocityPoints ?? {}) } };
};

export type FraudBand = 'approve' | 'step_up' | 'review' | 'block';
export interface FraudFactor {
  code: string;
  points: number;
  detail: string;
}
export interface FraudInput {
  userId?: string | null;
  kind: string;
  amount: number;
  currency: string;
  subjectType: string;
  subjectId?: string | null;
  method?: string | null;
  recipientUserId?: string | null;
  newBeneficiary?: boolean | null;
  deviceHash?: string | null;
  ipCountry?: string | null;
  /** Flags already established by the caller (sanctions, cooling-off, legacy velocity). */
  flags?: string[];
}
export interface FraudResult {
  id: string;
  score: number;
  band: FraudBand;
  factors: FraudFactor[];
  decision: PolicyDecision;
  baseMinor: number;
}

export function bandFor(score: number, s = getFraudSettings()): FraudBand {
  if (score >= s.bands.block) return 'block';
  if (score >= s.bands.review) return 'review';
  if (score >= s.bands.stepUp) return 'step_up';
  return 'approve';
}

function safeBase(amount: number, currency: string): number {
  try {
    return toBase(amount, currency);
  } catch {
    return amount;
  }
}

/** Score, decide with the policy, and record. Never throws for missing history: a new account simply has no behavioural factors. */
export function scoreFraud(input: FraudInput): FraudResult {
  const s = getFraudSettings();
  const db = getDb();
  const factors: FraudFactor[] = [];
  const flags = [...(input.flags ?? [])];
  const baseMinor = safeBase(input.amount, input.currency);
  const user = input.userId ? (db.prepare('SELECT id, country, kyc_tier, kyc_status, created_at FROM users WHERE id = ?').get(input.userId) as any) : null;
  const add = (code: string, points: number, detail: string) => {
    if (points > 0) factors.push({ code, points, detail });
  };
  for (const f of flags) {
    if (f.startsWith('sanctions:')) add('sanctions', 100, f);
    else if (f.startsWith('cooling_off:')) add('cooling_off', 90, f);
    else if (f.startsWith('velocity:hour')) add('velocity_legacy_hour', 60, f);
    else if (f.startsWith('velocity:day')) add('velocity_legacy_day', 40, f);
    else if (f.startsWith('pep:')) add('pep', s.pepPoints, f);
  }
  if (user && baseMinor >= s.minScoredBase) {
    const t = Date.now();
    const count = (since: number) => (db.prepare("SELECT COUNT(*) c FROM transactions WHERE sender_user_id = ? AND status IN ('pending', 'completed') AND created_at >= ?").get(user.id, new Date(t - since).toISOString()) as any).c as number;
    const hour = count(3600_000);
    const day = count(86_400_000);
    const week = count(7 * 86_400_000);
    if (hour >= s.velocityThresholds.hour) add('velocity_1h', s.velocityPoints.hour, `${hour} outgoing movements in the last hour`);
    if (day >= s.velocityThresholds.day) add('velocity_24h', s.velocityPoints.day, `${day} outgoing movements in the last 24 hours`);
    if (week >= s.velocityThresholds.week) add('velocity_7d', s.velocityPoints.week, `${week} outgoing movements in the last 7 days`);
    // amount deviation: compared with the account's own last 30 days (needs at least 5 movements to be meaningful)
    const hist = db.prepare("SELECT amount, currency FROM transactions WHERE sender_user_id = ? AND status = 'completed' AND created_at >= ? AND type NOT IN ('exchange') ORDER BY created_at DESC LIMIT 100").all(user.id, new Date(t - 30 * 86_400_000).toISOString()) as { amount: number; currency: string }[];
    if (hist.length >= 5) {
      const bases = hist.map((h) => safeBase(h.amount, h.currency));
      const mean = bases.reduce((a, b) => a + b, 0) / bases.length;
      const sd = Math.sqrt(bases.reduce((a, b) => a + (b - mean) ** 2, 0) / bases.length);
      const z = sd > 0 ? (baseMinor - mean) / sd : baseMinor > mean * 3 ? 4 : 0;
      if (z >= 3) add('amount_deviation', s.amountDeviationPoints, `amount is ${z.toFixed(1)} standard deviations above the 30-day mean`);
      else if (z >= 2) add('amount_deviation', Math.round(s.amountDeviationPoints / 2), `amount is ${z.toFixed(1)} standard deviations above the 30-day mean`);
    }
    // structuring: several movements just under the per-transaction limit in 24h
    const limits = tierLimitsFor(user);
    if (limits?.perTransaction) {
      const near = (db.prepare("SELECT amount, currency FROM transactions WHERE sender_user_id = ? AND status IN ('pending', 'completed') AND created_at >= ?").all(user.id, new Date(t - 86_400_000).toISOString()) as { amount: number; currency: string }[]).filter((r) => {
        const b = safeBase(r.amount, r.currency);
        return b >= limits.perTransaction * 0.8 && b <= limits.perTransaction;
      }).length;
      if (near >= 3 && baseMinor >= limits.perTransaction * 0.8) add('structuring', s.structuringPoints, `${near} movements at 80–100% of the per-transaction limit in 24h`);
      if (baseMinor > limits.perTransaction) add('kyc_limit_mismatch', s.kycMismatchPoints, `amount exceeds the tier ${user.kyc_tier} per-transaction limit`);
    }
    // recipient risk: prior blocks / open compliance cases on the recipient
    if (input.recipientUserId) {
      const rr = (db.prepare("SELECT COUNT(*) c FROM fraud_scores WHERE user_id = ? AND band IN ('review', 'block') AND created_at >= ?").get(input.recipientUserId, new Date(t - 30 * 86_400_000).toISOString()) as any).c as number;
      const cases = (db.prepare("SELECT COUNT(*) c FROM compliance_cases WHERE user_id = ? AND status NOT IN ('CLOSED')").get(input.recipientUserId) as any).c as number;
      if (rr > 0 || cases > 0) add('recipient_risk', s.recipientRiskPoints, `recipient has ${rr} recent adverse score(s) and ${cases} open case(s)`);
    }
    if (input.newBeneficiary) add('new_beneficiary', s.newBeneficiaryPoints, 'first movement to this beneficiary');
    // time of day in the account's own timezone is unknown; we use UTC hours the product rules define as night
    const h = new Date().getUTCHours();
    const [from, to] = s.nightHours;
    if (from <= to ? h >= from && h < to : h >= from || h < to) {
      const recentNight = (db.prepare("SELECT COUNT(*) c FROM transactions WHERE sender_user_id = ? AND status = 'completed' AND CAST(strftime('%H', created_at) AS INTEGER) BETWEEN ? AND ?").get(user.id, from, Math.max(from, to - 1)) as any).c as number;
      if (recentNight === 0 && hist.length >= 5) add('unusual_hour', s.nightPoints, 'first movement during night hours');
    }
    if (input.deviceHash) {
      const known = db.prepare('SELECT 1 FROM fraud_scores WHERE user_id = ? AND device_hash = ? LIMIT 1').get(user.id, input.deviceHash);
      const any = db.prepare('SELECT 1 FROM fraud_scores WHERE user_id = ? AND device_hash IS NOT NULL LIMIT 1').get(user.id);
      if (!known && any) add('new_device', s.newDevicePoints, 'movement from a device not seen before on this account');
    }
    if (input.ipCountry && user.country && input.ipCountry.toUpperCase() !== String(user.country).toUpperCase()) add('geo_mismatch', s.geoMismatchPoints, `request from ${input.ipCountry.toUpperCase()}, account registered in ${String(user.country).toUpperCase()}`);
  }
  const method = input.method ?? null;
  if (method && s.methodRisk[method]) add('method_risk', s.methodRisk[method], `${method} carries base risk`);
  const score = Math.min(100, factors.reduce((a, f) => a + f.points, 0));
  const band = bandFor(score, s);
  const decision = evaluatePolicy({ kind: input.kind, baseMinor, score, kycTier: user?.kyc_tier ?? null, country: user?.country ?? null, method, newBeneficiary: input.newBeneficiary ?? null, flags: [...flags, ...factors.map((f) => `fraud:${f.code}`)] });
  const id = `fs_${shortCode(14).toLowerCase()}`;
  db.prepare('INSERT INTO fraud_scores (id, user_id, subject_type, subject_id, kind, amount_minor, currency, base_minor, score, band, factors, action, policy_rule, policy_id, device_hash, ip_country, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, input.userId ?? null, input.subjectType, input.subjectId ?? null, input.kind, input.amount, input.currency, baseMinor, score, band, JSON.stringify(factors), decision.action, decision.rule?.id ?? null, decision.policyId, input.deviceHash ?? null, input.ipCountry ? input.ipCountry.toUpperCase() : null, now());
  return { id, score, band, factors, decision, baseMinor };
}

export function listFraudScores(filter: { userId?: string | null; band?: string | null; action?: string | null; limit?: number } = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.userId) {
    where.push('user_id = ?');
    params.push(filter.userId);
  }
  if (filter.band) {
    where.push('band = ?');
    params.push(filter.band);
  }
  if (filter.action) {
    where.push('action = ?');
    params.push(filter.action);
  }
  const rows = getDb().prepare(`SELECT * FROM fraud_scores ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`).all(...params, Math.min(500, filter.limit ?? 100)) as any[];
  return rows.map((r) => ({ id: r.id, userId: r.user_id, subjectType: r.subject_type, subjectId: r.subject_id, kind: r.kind, amount: { valueMinor: r.amount_minor, currency: r.currency }, baseMinor: r.base_minor, score: r.score, band: r.band, factors: parseJson(r.factors, []), action: r.action, policyRule: r.policy_rule, policyId: r.policy_id, deviceHash: r.device_hash, ipCountry: r.ip_country, createdAt: r.created_at }));
}

export function fraudOverview(days = 7) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = getDb().prepare('SELECT band, action, COUNT(*) n FROM fraud_scores WHERE created_at >= ? GROUP BY band, action').all(since) as any[];
  const byBand: Record<string, number> = { approve: 0, step_up: 0, review: 0, block: 0 };
  const byAction: Record<string, number> = { allow: 0, step_up: 0, review: 0, block: 0 };
  for (const r of rows) {
    byBand[r.band] = (byBand[r.band] ?? 0) + r.n;
    byAction[r.action] = (byAction[r.action] ?? 0) + r.n;
  }
  const topFactors = (getDb().prepare('SELECT factors FROM fraud_scores WHERE created_at >= ? AND score > 0').all(since) as any[]).flatMap((r) => parseJson<FraudFactor[]>(r.factors, [])).reduce<Record<string, number>>((acc, f) => ({ ...acc, [f.code]: (acc[f.code] ?? 0) + 1 }), {});
  return { days, byBand, byAction, topFactors, settings: getFraudSettings() };
}
