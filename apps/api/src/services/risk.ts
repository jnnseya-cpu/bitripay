/**
 * Fraud, replay, velocity and sanctions controls. Produces a score and an action:
 *   allow  – proceed
 *   review – inbound payments are held in MANUAL_REVIEW; outbound movements stay pending for a verifier
 *   block  – the movement is refused
 * Every assessment is recorded (risk_events + event log) so decisions are attributable later.
 */
import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { forbidden } from '../lib/errors';
import { getRiskSettings } from './settings';
import { toBase } from './currencies';
import { recordEvent } from './events';

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
}
export interface RiskAssessment {
  score: number;
  flags: string[];
  action: 'allow' | 'review' | 'block';
}

export function normalizeName(v: string) {
  return v.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
export function normalizePhoneDigits(v: string) {
  return v.replace(/\D/g, '').slice(-9);
}

export function addSanction(kind: 'name' | 'phone' | 'email' | 'country', value: string, note?: string | null, createdBy?: string | null) {
  const normalized = kind === 'name' ? normalizeName(value) : kind === 'phone' ? normalizePhoneDigits(value) : value.trim().toLowerCase();
  const id = uuid();
  getDb().prepare('INSERT INTO sanctions_entries (id, kind, value, normalized, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, kind, value, normalized, note ?? null, createdBy ?? null, now());
  return { id, kind, value, normalized, note: note ?? null, createdAt: now() };
}
export function listSanctions() {
  return (getDb().prepare('SELECT * FROM sanctions_entries ORDER BY created_at DESC').all() as any[]).map((r) => ({ id: r.id, kind: r.kind, value: r.value, note: r.note, createdBy: r.created_by, createdAt: r.created_at }));
}
export function deleteSanction(id: string) {
  getDb().prepare('DELETE FROM sanctions_entries WHERE id = ?').run(id);
}

/** Screen a party against the sanctions list. Names match on normalized containment; phones on the last 9 digits. */
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
    if (r.kind === 'phone' && phone && r.normalized && phone === r.normalized) hits.push(`sanctions:phone:${r.value}`);
    if (r.kind === 'email' && email && email === r.normalized) hits.push(`sanctions:email:${r.value}`);
    if (r.kind === 'country' && country && country === r.normalized) hits.push(`sanctions:country:${r.value}`);
  }
  return hits;
}

export function assessRisk(input: RiskInput): RiskAssessment {
  const s = getRiskSettings();
  const db = getDb();
  const flags: string[] = [];
  let score = 0;
  const sanctions = screenSanctions(input.counterparty);
  if (sanctions.length) {
    flags.push(...sanctions);
    score += 100;
  }
  if (input.userId) {
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    const perHour = (db.prepare('SELECT COUNT(*) c FROM transactions WHERE (sender_user_id = ? OR receiver_user_id = ?) AND created_at >= ?').get(input.userId, input.userId, hourAgo) as any).c as number;
    const perDay = (db.prepare('SELECT COUNT(*) c FROM transactions WHERE (sender_user_id = ? OR receiver_user_id = ?) AND created_at >= ?').get(input.userId, input.userId, dayAgo) as any).c as number;
    if (s.maxTxPerHour && perHour >= s.maxTxPerHour) {
      flags.push(`velocity:hour:${perHour}`);
      score += 60;
    }
    if (s.maxTxPerDay && perDay >= s.maxTxPerDay) {
      flags.push(`velocity:day:${perDay}`);
      score += 40;
    }
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
      if (base > s.coolingOffAmount) {
        flags.push(`cooling_off:new_beneficiary:${Math.round(ageMs / 60_000)}m`);
        score += 90;
      }
    }
  }
  const action: RiskAssessment['action'] = score >= s.blockScore ? 'block' : score >= s.reviewScore ? 'review' : 'allow';
  const id = uuid();
  db.prepare('INSERT INTO risk_events (id, user_id, subject_type, subject_id, kind, score, flags, action, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, input.userId ?? null, input.subjectType, input.subjectId ?? null, input.kind, score, JSON.stringify(flags), action, now());
  if (action !== 'allow') recordEvent('risk', input.subjectId ?? id, `risk.${action}`, { type: 'system' }, { kind: input.kind, score, flags, userId: input.userId ?? null });
  return { score, flags, action };
}

/** Outbound guard: refuse blocked movements with a clear reason. */
export function enforceOutboundRisk(input: RiskInput): RiskAssessment {
  const r = assessRisk(input);
  if (r.action === 'block') {
    const cooling = r.flags.find((f) => f.startsWith('cooling_off'));
    if (cooling) throw forbidden(`This beneficiary was added recently. Larger amounts can be sent once the ${getRiskSettings().coolingOffMinutes}-minute cooling-off period has passed.`, 'cooling_off');
    if (r.flags.some((f) => f.startsWith('sanctions'))) throw forbidden('This transaction cannot be processed. Please contact support.', 'risk_blocked');
    throw forbidden('Too many transactions in a short period. Please try again later.', 'velocity_limit');
  }
  return r;
}

export function listRiskEvents(page = 1, pageSize = 50) {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) c FROM risk_events').get() as any).c as number;
  const rows = db.prepare('SELECT * FROM risk_events ORDER BY created_at DESC LIMIT ? OFFSET ?').all(pageSize, (page - 1) * pageSize) as any[];
  return { items: rows.map((r) => ({ id: r.id, userId: r.user_id, subjectType: r.subject_type, subjectId: r.subject_id, kind: r.kind, score: r.score, flags: JSON.parse(r.flags || '[]'), action: r.action, createdAt: r.created_at })), total };
}
