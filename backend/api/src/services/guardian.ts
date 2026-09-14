/**
 * Guardian: the ledger invariants and the platform operating mode.
 *
 * Invariants (checked on demand, hourly, and before releases): every transaction's ledger lines balance; wallet
 * balances equal the sum of their lines; no wallet is negative unless policy allows it; every payment event with a
 * ledger transaction points at a balanced one; no captured intent lacks its ledger posting; AMBIGUOUS is never
 * credited (money whose provider outcome is unknown sits in the suspense balance class, never in a merchant wallet).
 * A violation records a
 * check, raises a loud alert, and puts the platform in HALTED mode: no new intents or attempts until an
 * administrator clears it under step-up. DEGRADED mode (from the continuity plan) restricts initiation in a
 * controlled way: new intents queue instead of routing, and offline acceptance is frozen.
 */
import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { parseJson } from '../lib/json';
import { AppError } from '../lib/errors';
import { reconcileLedger } from './ledger';
import { findUserByTag, type UserRow } from './users';
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
  kind: 'unbalanced_transaction' | 'wallet_mismatch' | 'negative_balance' | 'event_without_ledger' | 'captured_without_posting' | 'refund_exceeds' | 'ambiguous_credited' | 'ambiguous_not_in_suspense';
  ref: string;
  detail: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Balance classes and the suspense account
// ---------------------------------------------------------------------------------------------------------------------
/**
 * Balance classes: `available` (spendable), `held` (holds against the wallet), `escrow` (platform-held float of a
 * pending route) and `suspense` (money whose provider outcome is unknown: AMBIGUOUS / UNKNOWN_PROVIDER_STATE intents).
 * Suspense money is never a merchant's: it sits on the suspense system account until the outcome is known.
 */
export type BalanceClass = 'available' | 'held' | 'escrow' | 'suspense';
export const BALANCE_CLASSES: BalanceClass[] = ['available', 'held', 'escrow', 'suspense'];
export const SUSPENSE_TAG = 'bitripay_suspense';
/** The suspense system account when the deployment has one (created by the ledger's system-user bootstrap), else null. */
export function suspenseAccount(): UserRow | null {
  const row = findUserByTag(SUSPENSE_TAG);
  return row && row.is_system ? row : null;
}
/** Balances held in the suspense class per currency (empty when there is no suspense account). */
export function suspenseBalances(): { currency: string; balance: number }[] {
  const acct = suspenseAccount();
  if (!acct) return [];
  return getDb().prepare('SELECT currency, balance FROM wallets WHERE user_id = ? ORDER BY currency').all(acct.id) as { currency: string; balance: number }[];
}
const AMBIGUOUS_STATES = ['AMBIGUOUS', 'UNKNOWN_PROVIDER_STATE'];
/**
 * Invariant "AMBIGUOUS is never credited": no ledger line credits the merchant's wallet for an intent whose provider
 * outcome is unknown. The intent links to its ledger through payment_intents.transaction_id, the gateway payment's
 * transaction_id, or a transaction whose metadata names the intent. When a suspense account exists the money of such
 * an intent must sit there (a credit to the suspense wallet on the same transaction).
 */
export function ambiguousCreditFindings(): GuardianFinding[] {
  const db = getDb();
  const findings: GuardianFinding[] = [];
  const suspense = suspenseAccount();
  const intents = db
    .prepare(
      `SELECT i.id, i.status, i.merchant_user_id, i.currency, i.amount_minor, i.transaction_id, g.transaction_id gateway_transaction_id
       FROM payment_intents i LEFT JOIN gateway_payments g ON g.id = i.gateway_payment_id
       WHERE i.status IN (${AMBIGUOUS_STATES.map(() => '?').join(',')})`,
    )
    .all(...AMBIGUOUS_STATES) as any[];
  const byMetadata = db.prepare("SELECT id FROM transactions WHERE json_extract(metadata, '$.intentId') = ? OR json_extract(metadata, '$.paymentIntentId') = ?");
  const merchantCredit = db.prepare(
    `SELECT le.id, le.amount, le.transaction_id FROM ledger_entries le JOIN wallets w ON w.id = le.wallet_id
     WHERE le.transaction_id = ? AND le.direction = 'credit' AND w.user_id = ?`,
  );
  const suspenseCredit = db.prepare(
    `SELECT COALESCE(SUM(le.amount),0) s FROM ledger_entries le JOIN wallets w ON w.id = le.wallet_id WHERE le.transaction_id = ? AND le.direction = 'credit' AND w.user_id = ?`,
  );
  for (const i of intents) {
    const txIds = new Set<string>();
    if (i.transaction_id) txIds.add(i.transaction_id);
    if (i.gateway_transaction_id) txIds.add(i.gateway_transaction_id);
    for (const t of byMetadata.all(i.id, i.id) as { id: string }[]) txIds.add(t.id);
    for (const txId of txIds) {
      for (const c of merchantCredit.all(txId, i.merchant_user_id) as any[])
        findings.push({ kind: 'ambiguous_credited', ref: i.id, detail: `${i.status} intent credited ${c.amount} ${i.currency} to the merchant on transaction ${txId} (ledger entry ${c.id})` });
      if (suspense) {
        const held = (suspenseCredit.get(txId, suspense.id) as any).s as number;
        if (held <= 0) findings.push({ kind: 'ambiguous_not_in_suspense', ref: i.id, detail: `${i.status} intent has transaction ${txId} but nothing is held in suspense` });
      }
    }
  }
  return findings;
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
  const negatives = db.prepare('SELECT w.id, w.balance, u.tag FROM wallets w JOIN users u ON u.id = w.user_id WHERE w.balance < 0 AND u.is_system = 0').all() as any[];
  for (const n of negatives) findings.push({ kind: 'negative_balance', ref: n.id, detail: `${n.tag} at ${n.balance}` });
  const orphanEvents = db
    .prepare('SELECT e.event_id, e.transaction_id FROM payment_events e LEFT JOIN transactions t ON t.id = e.transaction_id WHERE e.transaction_id IS NOT NULL AND t.id IS NULL')
    .all() as any[];
  for (const e of orphanEvents) findings.push({ kind: 'event_without_ledger', ref: e.event_id, detail: `transaction ${e.transaction_id} missing` });
  // Observation-only rails (national switch, aggregator phase) never post a customer balance: their proof is the observation journal.
  const captured = db
    .prepare("SELECT id FROM payment_intents WHERE status IN ('CAPTURED', 'SETTLEMENT_PENDING', 'SETTLED') AND transaction_id IS NULL AND rails NOT LIKE '%national_switch%'")
    .all() as any[];
  for (const c of captured) findings.push({ kind: 'captured_without_posting', ref: c.id, detail: 'captured intent has no ledger transaction' });
  const overRefunded = db
    .prepare(
      "SELECT * FROM (SELECT t.id, t.amount, (SELECT COALESCE(SUM(r.amount), 0) FROM transactions r WHERE r.type = 'refund' AND json_extract(r.metadata, '$.refundOf') = t.id AND r.status = 'completed') refunded FROM transactions t WHERE t.status IN ('completed', 'reversed') AND EXISTS (SELECT 1 FROM transactions r WHERE r.type = 'refund' AND json_extract(r.metadata, '$.refundOf') = t.id)) WHERE refunded > amount",
    )
    .all() as any[];
  for (const o of overRefunded) findings.push({ kind: 'refund_exceeds', ref: o.id, detail: `refunded ${o.refunded} of ${o.amount}` });
  // AMBIGUOUS is never credited: unknown provider outcomes stay in suspense, never in a merchant wallet.
  const ambiguous = ambiguousCreditFindings();
  findings.push(...ambiguous);
  const ok = findings.length === 0;
  const halt =
    !ok &&
    (opts.haltOnFailure ?? true) &&
    findings.some((f) => f.kind === 'unbalanced_transaction' || f.kind === 'wallet_mismatch' || f.kind === 'captured_without_posting' || f.kind === 'ambiguous_credited');
  const id = uuid();
  db.prepare('INSERT INTO guardian_checks (id, ok, transactions_checked, findings, halted, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    ok ? 1 : 0,
    ledger.transactionsChecked,
    JSON.stringify(findings),
    halt ? 1 : 0,
    now(),
  );
  if (halt)
    setOperatingMode(
      'halted',
      `Guardian found ${findings.length} ledger finding(s): ${findings
        .slice(0, 3)
        .map((f) => `${f.kind} ${f.ref}`)
        .join('; ')}`,
      null,
    );
  // Loud: an AMBIGUOUS credit is told to every administrator immediately, whether or not the platform halts.
  if (ambiguous.some((f) => f.kind === 'ambiguous_credited'))
    for (const a of admins())
      notify(
        a.id,
        'Guardian: AMBIGUOUS intent credited',
        ambiguous
          .filter((f) => f.kind === 'ambiguous_credited')
          .slice(0, 3)
          .map((f) => `${f.ref}: ${f.detail}`)
          .join('\n'),
        { kind: 'reserve_breach', guardianCheck: id },
      );
  recordEvent('ledger', id, ok ? 'guardian.ok' : 'guardian.findings', { type: 'system' }, { findings: findings.length, halted: halt, ambiguous: ambiguous.length });
  return { id, ok, transactionsChecked: ledger.transactionsChecked, findings, halted: halt, createdAt: now() };
}
export function listGuardianChecks(limit = 20): GuardianResult[] {
  return (getDb().prepare('SELECT * FROM guardian_checks ORDER BY created_at DESC LIMIT ?').all(limit) as any[]).map((r) => ({
    id: r.id,
    ok: !!r.ok,
    transactionsChecked: r.transactions_checked,
    findings: parseJson(r.findings, []),
    halted: !!r.halted,
    createdAt: r.created_at,
  }));
}
