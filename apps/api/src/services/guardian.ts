/**
 * Guardian: the ledger invariants and the platform operating mode.
 *
 * Invariants (checked on demand, hourly, and before releases): every transaction's ledger lines balance; wallet
 * balances equal the sum of their lines; no wallet is negative unless policy allows it; every payment event with a
 * ledger transaction points at a balanced one; no captured intent lacks its ledger posting. A violation records a
 * check, raises a loud alert, and puts the platform in HALTED mode: no new intents or attempts until an
 * administrator clears it under step-up. DEGRADED mode (from the continuity plan) restricts initiation in a
 * controlled way: new intents queue instead of routing, and offline acceptance is frozen.
 */
import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { parseJson } from '../lib/json';
import { AppError } from '../lib/errors';
import { reconcileLedger } from './ledger';
import { getSetting, setSetting } from './settings';
import { notify } from './notifications';
import { recordEvent } from './events';

export type OperatingMode = 'normal' | 'degraded' | 'halted';
export interface OperatingState {
  mode: OperatingMode;
  reason: string | null;
  since: string | null;
  setBy: string | null;
  /** In degraded mode: accept intents but queue them (no routing) instead of refusing. */
  queueIntents: boolean;
  freezeOffline: boolean;
}
const DEFAULT_STATE: OperatingState = { mode: 'normal', reason: null, since: null, setBy: null, queueIntents: true, freezeOffline: true };
export const getOperatingState = () => getSetting<OperatingState>('operating_mode', DEFAULT_STATE);
export function setOperatingMode(mode: OperatingMode, reason: string | null, setBy: string | null, opts: Partial<Pick<OperatingState, 'queueIntents' | 'freezeOffline'>> = {}): OperatingState {
  const current = getOperatingState();
  const next: OperatingState = { ...current, ...opts, mode, reason, since: mode === current.mode ? current.since : now(), setBy };
  setSetting('operating_mode', next);
  recordEvent('admin', 'platform', `platform.mode.${mode}`, setBy ? { type: 'admin', id: setBy } : { type: 'system' }, { reason });
  if (mode !== 'normal') for (const a of admins()) notify(a.id, mode === 'halted' ? 'Platform HALTED by Guardian' : 'Platform in degraded mode', reason ?? '', { kind: 'reserve_breach', mode });
  return next;
}
function admins() {
  return getDb().prepare("SELECT id FROM users WHERE role = 'admin' AND is_system = 0 AND status = 'active'").all() as { id: string }[];
}
/** Money movement gate: intents and attempts call this first. */
export function assertMoneyMovementAllowed(kind: 'intent' | 'attempt' | 'offline' | 'refund' | 'payout' = 'intent') {
  const s = getOperatingState();
  if (s.mode === 'halted') throw new AppError(503, 'guardian_halt', 'Payments are paused while the ledger is being verified. Nothing has been lost; please try again shortly.');
  if (s.mode === 'degraded' && kind === 'offline' && s.freezeOffline) throw new AppError(503, 'degraded_mode', 'Offline acceptance is paused during degraded operation.');
  if (s.mode === 'degraded' && kind === 'attempt' && !s.queueIntents) throw new AppError(503, 'degraded_mode', 'New payments are paused during degraded operation.');
}

export interface GuardianFinding {
  kind: 'unbalanced_transaction' | 'wallet_mismatch' | 'negative_balance' | 'event_without_ledger' | 'captured_without_posting' | 'refund_exceeds';
  ref: string;
  detail: string;
}
export interface GuardianResult {
  id: string;
  ok: boolean;
  transactionsChecked: number;
  findings: GuardianFinding[];
  halted: boolean;
  createdAt: string;
}

export function runGuardian(opts: { haltOnFailure?: boolean } = {}): GuardianResult {
  const db = getDb();
  const findings: GuardianFinding[] = [];
  const ledger = reconcileLedger();
  for (const t of ledger.unbalancedTransactions) findings.push({ kind: 'unbalanced_transaction', ref: t, detail: 'debits do not equal credits' });
  for (const w of ledger.walletMismatches) findings.push({ kind: 'wallet_mismatch', ref: w.walletId, detail: `stored ${w.balance}, computed ${w.computed}` });
  const negatives = db.prepare("SELECT w.id, w.balance, u.tag FROM wallets w JOIN users u ON u.id = w.user_id WHERE w.balance < 0 AND u.is_system = 0").all() as any[];
  for (const n of negatives) findings.push({ kind: 'negative_balance', ref: n.id, detail: `${n.tag} at ${n.balance}` });
  const orphanEvents = db.prepare("SELECT e.event_id, e.transaction_id FROM payment_events e LEFT JOIN transactions t ON t.id = e.transaction_id WHERE e.transaction_id IS NOT NULL AND t.id IS NULL").all() as any[];
  for (const e of orphanEvents) findings.push({ kind: 'event_without_ledger', ref: e.event_id, detail: `transaction ${e.transaction_id} missing` });
  // Observation-only rails (national switch, aggregator phase) never post a customer balance: their proof is the observation journal.
  const captured = db.prepare("SELECT id FROM payment_intents WHERE status IN ('CAPTURED', 'SETTLEMENT_PENDING', 'SETTLED') AND transaction_id IS NULL AND rails NOT LIKE '%national_switch%'").all() as any[];
  for (const c of captured) findings.push({ kind: 'captured_without_posting', ref: c.id, detail: 'captured intent has no ledger transaction' });
  const overRefunded = db.prepare("SELECT * FROM (SELECT t.id, t.amount, (SELECT COALESCE(SUM(r.amount), 0) FROM transactions r WHERE r.type = 'refund' AND json_extract(r.metadata, '$.refundOf') = t.id AND r.status = 'completed') refunded FROM transactions t WHERE t.status IN ('completed', 'reversed') AND EXISTS (SELECT 1 FROM transactions r WHERE r.type = 'refund' AND json_extract(r.metadata, '$.refundOf') = t.id)) WHERE refunded > amount").all() as any[];
  for (const o of overRefunded) findings.push({ kind: 'refund_exceeds', ref: o.id, detail: `refunded ${o.refunded} of ${o.amount}` });
  const ok = findings.length === 0;
  const halt = !ok && (opts.haltOnFailure ?? true) && findings.some((f) => f.kind === 'unbalanced_transaction' || f.kind === 'wallet_mismatch' || f.kind === 'captured_without_posting');
  const id = uuid();
  db.prepare('INSERT INTO guardian_checks (id, ok, transactions_checked, findings, halted, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, ok ? 1 : 0, ledger.transactionsChecked, JSON.stringify(findings), halt ? 1 : 0, now());
  if (halt) setOperatingMode('halted', `Guardian found ${findings.length} ledger finding(s): ${findings.slice(0, 3).map((f) => `${f.kind} ${f.ref}`).join('; ')}`, null);
  recordEvent('ledger', id, ok ? 'guardian.ok' : 'guardian.findings', { type: 'system' }, { findings: findings.length, halted: halt });
  return { id, ok, transactionsChecked: ledger.transactionsChecked, findings, halted: halt, createdAt: now() };
}
export function listGuardianChecks(limit = 20): GuardianResult[] {
  return (getDb().prepare('SELECT * FROM guardian_checks ORDER BY created_at DESC LIMIT ?').all(limit) as any[]).map((r) => ({ id: r.id, ok: !!r.ok, transactionsChecked: r.transactions_checked, findings: parseJson(r.findings, []), halted: !!r.halted, createdAt: r.created_at }));
}
