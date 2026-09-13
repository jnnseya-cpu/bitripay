/**
 * Fraud, replay, velocity and sanctions controls. Produces a score and an action:
 *   allow  – proceed
 *   review – inbound payments are held in MANUAL_REVIEW; outbound movements stay pending for a verifier
 *   block  – the movement is refused
 * Every assessment is recorded (risk_events + event log) so decisions are attributable later.
 */
import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { AppError, forbidden } from '../lib/errors';
import { sha256 } from '../lib/crypto';
import { preCommitHooks } from './ledger';
import { verifyStepUpToken } from './webauthn';
import type { UserRow } from './users';
import { scoreFraud } from './risk/fraud';
import { openCase } from './risk/compliance';
import { getRiskSettings } from './settings';
import { toBase } from './currencies';
import { recordEvent } from './events';
import { publish } from './bus';

export interface RiskSubject {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  country?: string | null;
}
export interface RiskInput {
  userId?: string | null;
  kind: 'payment_in' | 'transfer' | 'withdrawal' | 'remittance' | 'route';
  amount: number;
  currency: string;
  subjectType: string;
  subjectId?: string | null;
  /** The other party (payer for inbound, beneficiary for outbound). */
  counterparty?: RiskSubject | null;
  /** When the beneficiary record was created – used for cooling-off on new destinations. */
  beneficiaryCreatedAt?: string | null;
  /** Fraud-scoring context (all optional; missing history simply scores nothing). */
  method?: string | null;
  recipientUserId?: string | null;
  newBeneficiary?: boolean | null;
  deviceHash?: string | null;
  ipCountry?: string | null;
  /** The request carried a valid step-up token (passkey / 2FA); satisfies a step-up decision. */
  stepUpVerified?: boolean;
}
export interface RiskAssessment {
  score: number;
  flags: string[];
  action: 'allow' | 'step_up' | 'review' | 'block';
  fraud: { id: string; score: number; band: string; factors: { code: string; points: number; detail: string }[] };
  policy: { id: string; version: number; rule: string | null; reason: string };
}

export function normalizeName(v: string) {
  return v.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
export function normalizePhoneDigits(v: string) {
  return v.replace(/\D/g, '').slice(-9);
}

export function addSanction(kind: 'name' | 'phone' | 'email' | 'country' | 'pep', value: string, note?: string | null, createdBy?: string | null) {
  const normalized = kind === 'name' || kind === 'pep' ? normalizeName(value) : kind === 'phone' ? normalizePhoneDigits(value) : value.trim().toLowerCase();
  const id = uuid();
  getDb().prepare('INSERT INTO sanctions_entries (id, kind, value, normalized, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, kind, value, normalized, note ?? null, createdBy ?? null, now());
  return { id, kind, value, normalized, note: note ?? null, createdAt: now() };
}
export function listSanctions(filter: { source?: string | null; kind?: string | null; limit?: number } = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.source) {
    where.push('source = ?');
    params.push(filter.source);
  }
  if (filter.kind) {
    where.push('kind = ?');
    params.push(filter.kind);
  }
  return (getDb().prepare(`SELECT * FROM sanctions_entries ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`).all(...params, Math.min(5000, filter.limit ?? 500)) as any[]).map((r) => ({ id: r.id, kind: r.kind, value: r.value, note: r.note, source: r.source ?? 'manual', externalId: r.external_id ?? null, listVersion: r.list_version ?? null, createdBy: r.created_by, createdAt: r.created_at }));
}
export function deleteSanction(id: string) {
  getDb().prepare('DELETE FROM sanctions_entries WHERE id = ?').run(id);
}

/**
 * Screen a party against the lists. Names match on normalized containment; phones on the last 9 digits.
 * Sanctions hits are `sanctions:*` (the policy blocks them); politically exposed persons are `pep:*` (raise the
 * score, enhanced due diligence, never a block by themselves).
 */
export function screenSanctions(subject: RiskSubject | null | undefined): string[] {
  if (!subject) return [];
  const db = getDb();
  const hits: string[] = [];
  const rows = db.prepare('SELECT kind, normalized, value FROM sanctions_entries').all() as { kind: string; normalized: string; value: string }[];
  if (!rows.length) return hits;
  const name = subject.name ? normalizeName(subject.name) : '';
  const phone = subject.phone ? normalizePhoneDigits(subject.phone) : '';
  const email = subject.email?.trim().toLowerCase() ?? '';
  const country = subject.country?.trim().toLowerCase() ?? '';
  for (const r of rows) {
    if (r.kind === 'name' && name && r.normalized && (name === r.normalized || name.includes(r.normalized))) hits.push(`sanctions:name:${r.value}`);
    if (r.kind === 'pep' && name && r.normalized && (name === r.normalized || name.includes(r.normalized))) hits.push(`pep:name:${r.value}`);
    if (r.kind === 'phone' && phone && r.normalized && phone === r.normalized) hits.push(`sanctions:phone:${r.value}`);
    if (r.kind === 'email' && email && email === r.normalized) hits.push(`sanctions:email:${r.value}`);
    if (r.kind === 'country' && country && country === r.normalized) hits.push(`sanctions:country:${r.value}`);
  }
  return hits;
}

/** Device / geolocation / step-up context from an HTTP request, for the routes that move money. */
export function riskContext(req: { headers?: Record<string, unknown>; body?: any; user?: UserRow; ip?: string }): { stepUpVerified: boolean; deviceHash: string | null; ipCountry: string | null } {
  const h = (k: string) => (req.headers?.[k] as string | undefined) ?? null;
  const token = h('x-step-up-token') || req.body?.stepUpToken;
  const device = h('x-device-id') || h('x-device-fingerprint') || (h('user-agent') ? sha256(String(h('user-agent'))).slice(0, 24) : null);
  const country = h('x-ip-country') || h('cf-ipcountry') || h('x-country') || null;
  return { stepUpVerified: !!(req.user && token && verifyStepUpToken(req.user, token)), deviceHash: device, ipCountry: country ? String(country).toUpperCase().slice(0, 2) : null };
}

/**
 * Assess a movement: legacy controls (sanctions, velocity, cooling-off) produce flags; the fraud scorer adds the
 * behavioural factors; the active policy turns score + flags into the decision. Everything is recorded
 * (risk_events, fraud_scores, event log) and a block opens a compliance case with a suspicious activity report draft.
 */
export function assessRisk(input: RiskInput): RiskAssessment {
  const s = getRiskSettings();
  const db = getDb();
  const flags: string[] = [];
  const sanctions = screenSanctions(input.counterparty);
  flags.push(...sanctions);
  if (input.userId) {
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    const perHour = (db.prepare('SELECT COUNT(*) c FROM transactions WHERE (sender_user_id = ? OR receiver_user_id = ?) AND created_at >= ?').get(input.userId, input.userId, hourAgo) as any).c as number;
    const perDay = (db.prepare('SELECT COUNT(*) c FROM transactions WHERE (sender_user_id = ? OR receiver_user_id = ?) AND created_at >= ?').get(input.userId, input.userId, dayAgo) as any).c as number;
    if (s.maxTxPerHour && perHour >= s.maxTxPerHour) flags.push(`velocity:hour:${perHour}`);
    if (s.maxTxPerDay && perDay >= s.maxTxPerDay) flags.push(`velocity:day:${perDay}`);
  }
  if (input.beneficiaryCreatedAt && s.coolingOffMinutes > 0) {
    const ageMs = Date.now() - new Date(input.beneficiaryCreatedAt).getTime();
    if (ageMs < s.coolingOffMinutes * 60_000) {
      let base = input.amount;
      try {
        base = toBase(input.amount, input.currency);
      } catch {
        /* keep raw */
      }
      if (base > s.coolingOffAmount) flags.push(`cooling_off:new_beneficiary:${Math.round(ageMs / 60_000)}m`);
    }
  }
  const fraud = scoreFraud({ userId: input.userId, kind: input.kind, amount: input.amount, currency: input.currency, subjectType: input.subjectType, subjectId: input.subjectId, method: input.method, recipientUserId: input.recipientUserId, newBeneficiary: input.newBeneficiary, deviceHash: input.deviceHash, ipCountry: input.ipCountry, flags });
  let action: RiskAssessment['action'] = fraud.decision.action;
  // Inbound money has nobody to step up: a step-up decision simply lets it in (review and block still hold it).
  if (action === 'step_up' && (input.kind === 'payment_in' || input.kind === 'route')) action = 'allow';
  const allFlags = [...flags, ...fraud.factors.filter((f) => !['sanctions', 'cooling_off', 'velocity_legacy_hour', 'velocity_legacy_day'].includes(f.code)).map((f) => `fraud:${f.code}`)];
  const id = uuid();
  db.prepare('INSERT INTO risk_events (id, user_id, subject_type, subject_id, kind, score, flags, action, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, input.userId ?? null, input.subjectType, input.subjectId ?? null, input.kind, fraud.score, JSON.stringify(allFlags), action, now());
  if (action !== 'allow') recordEvent('risk', input.subjectId ?? id, `risk.${action}`, { type: 'system' }, { kind: input.kind, score: fraud.score, flags: allFlags, userId: input.userId ?? null, rule: fraud.decision.rule?.id ?? null, policy: `${fraud.decision.policyId}@v${fraud.decision.version}` });
  if (action === 'block' && input.userId) {
    openCase({
      kind: sanctions.length ? 'SANCTIONS' : 'FRAUD',
      userId: input.userId,
      subjectType: input.subjectType,
      subjectId: input.subjectId ?? fraud.id,
      severity: 'critical',
      title: sanctions.length ? 'Sanctions hit on a money movement' : `Movement blocked by the risk policy (score ${fraud.score})`,
      summary: `${input.kind} of ${input.amount} ${input.currency} refused by rule ${fraud.decision.rule?.id ?? 'n/a'} (policy v${fraud.decision.version}).`,
      indicators: [...allFlags, ...fraud.factors.map((f) => `${f.code}: ${f.detail}`)],
      dedupeKey: `risk:${input.userId}:${input.subjectType}:${input.subjectId ?? fraud.id}`,
      amounts: [{ valueMinor: input.amount, currency: input.currency }],
      sar: true,
    });
  }
  return { score: fraud.score, flags: allFlags, action, fraud: { id: fraud.id, score: fraud.score, band: fraud.band, factors: fraud.factors }, policy: { id: fraud.decision.policyId, version: fraud.decision.version, rule: fraud.decision.rule?.id ?? null, reason: fraud.decision.reason } };
}

/** Outbound guard: refuse blocked movements with a clear reason; ask for step-up when the policy says so. */
export function enforceOutboundRisk(input: RiskInput): RiskAssessment {
  const r = assessRisk(input);
  if (r.action === 'block') {
    const cooling = r.flags.find((f) => f.startsWith('cooling_off'));
    if (cooling) throw forbidden(`This beneficiary was added recently. Larger amounts can be sent once the ${getRiskSettings().coolingOffMinutes}-minute cooling-off period has passed.`, 'cooling_off');
    if (r.flags.some((f) => f.startsWith('sanctions'))) {
      publish('sanctions.hit', { userId: input.userId ?? null, kind: input.kind, hits: r.flags.filter((f) => f.startsWith('sanctions')), amountMinor: input.amount, currency: input.currency }, { aggregateId: input.userId ?? input.subjectId ?? null });
      throw forbidden('This transaction cannot be processed. Please contact support.', 'risk_blocked');
    }
    if (r.flags.some((f) => f.startsWith('velocity:'))) throw forbidden('Too many transactions in a short period. Please try again later.', 'velocity_limit');
    throw forbidden('This transaction cannot be processed right now. Our team has been notified and will contact you if anything is needed.', 'risk_blocked');
  }
  if (r.action === 'step_up' && !input.stepUpVerified) {
    throw new AppError(403, 'step_up_required', 'Please confirm this transaction with your passkey or authenticator code.', { challenge: 'step_up', score: r.score, rule: r.policy.rule, factors: r.fraud.factors.map((f) => f.code) });
  }
  return r;
}

// Sanctions are screened once more inside the ledger, so no code path can post money for a listed party.
const LEDGER_HOOK = Symbol.for('bitripay.risk.ledgerHook');
if (!(globalThis as any)[LEDGER_HOOK]) {
  (globalThis as any)[LEDGER_HOOK] = true;
  preCommitHooks.push(({ input, fromUser, toUser }) => {
    for (const [role, u] of [['sender', fromUser], ['receiver', toUser]] as const) {
      if (!u || u.is_system) continue;
      const hits = screenSanctions({ name: u.full_name, phone: u.phone, email: u.email, country: u.country }).filter((h) => h.startsWith('sanctions:'));
      if (!hits.length) continue;
      // The posting's database transaction rolls back when we throw, so the trail is written once it has unwound.
      queueMicrotask(() => {
        publish('sanctions.hit', { userId: u.id, kind: input.type, hits, amountMinor: input.amount, currency: input.currency, role }, { aggregateId: u.id });
        recordEvent('risk', u.id, 'ledger.sanctions_refused', { type: 'system' }, { role, type: input.type, amount: input.amount, currency: input.currency, hits });
        openCase({ kind: 'SANCTIONS', userId: u.id, subjectType: 'ledger', subjectId: null, severity: 'critical', title: 'Ledger posting refused: sanctioned party', summary: `${input.type} of ${input.amount} ${input.currency} with ${role} ${u.full_name} refused at commit (${hits.join(', ')}).`, indicators: hits, dedupeKey: `ledger-sanctions:${u.id}:${now().slice(0, 10)}`, sar: true });
      });
      throw forbidden('This transaction cannot be processed. Please contact support.', 'sanctions_hit');
    }
  });
}

export function listRiskEvents(page = 1, pageSize = 50) {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) c FROM risk_events').get() as any).c as number;
  const rows = db.prepare('SELECT * FROM risk_events ORDER BY created_at DESC LIMIT ? OFFSET ?').all(pageSize, (page - 1) * pageSize) as any[];
  return { items: rows.map((r) => ({ id: r.id, userId: r.user_id, subjectType: r.subject_type, subjectId: r.subject_id, kind: r.kind, score: r.score, flags: JSON.parse(r.flags || '[]'), action: r.action, createdAt: r.created_at })), total };
}
