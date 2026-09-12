/**
 * Split payments: a merchant (marketplace, cooperative, school) declares how a captured payment is shared. Rules are
 * validated when the intent is created; when the intent is captured the merchant's wallet pays each recipient through
 * ordinary `distribution` transactions, so every share is a ledger movement with its own reference and the sum of
 * the shares can never exceed what the merchant actually received.
 */
import { getDb } from '../../db';
import { now, shortCode } from '../../lib/ids';
import { parseJson } from '../../lib/json';
import { badRequest } from '../../lib/errors';
import { findUserByIdentifier, findUserById } from '../users';
import { ensureWallet, getUserWallet } from '../wallets';
import { postTransaction, getTransaction } from '../ledger';
import { recordEvent } from '../events';
import { notify } from '../notifications';

export interface SplitRule {
  /** @tag, email, phone or user id */
  recipient: string;
  bps?: number | null;
  fixedMinor?: number | null;
  label?: string | null;
}
export interface SplitPayoutView {
  id: string;
  intentId: string;
  sourceTransactionId: string;
  recipientUserId: string;
  amountMinor: number;
  currency: string;
  label: string | null;
  transactionId: string | null;
  status: 'PENDING' | 'PAID' | 'FAILED';
  error: string | null;
  createdAt: string;
}
const toView = (r: any): SplitPayoutView => ({ id: r.id, intentId: r.intent_id, sourceTransactionId: r.source_transaction_id, recipientUserId: r.recipient_user_id, amountMinor: r.amount_minor, currency: r.currency, label: r.label, transactionId: r.transaction_id, status: r.status, error: r.error, createdAt: r.created_at });

/** Resolve recipients and check the rules can be honoured on any amount (bps total ≤ 10000; fixed parts are checked at capture). */
export function validateSplits(rules: SplitRule[], merchantId: string): { recipient: string; recipientUserId: string; bps: number; fixedMinor: number; label: string | null }[] {
  if (rules.length > 10) throw badRequest('At most 10 split recipients', 'too_many_splits');
  let totalBps = 0;
  const out = rules.map((r) => {
    const u = findUserByIdentifier(r.recipient) ?? findUserById(r.recipient);
    if (!u || u.is_system || u.status !== 'active') throw badRequest(`Split recipient ${r.recipient} not found`, 'split_recipient_not_found');
    if (u.id === merchantId) throw badRequest('A split cannot pay the merchant itself', 'split_self');
    const bps = Math.max(0, Math.round(r.bps ?? 0));
    const fixed = Math.max(0, Math.round(r.fixedMinor ?? 0));
    if (!bps && !fixed) throw badRequest(`Split for ${r.recipient} needs bps or fixedMinor`, 'split_amount_required');
    totalBps += bps;
    return { recipient: r.recipient, recipientUserId: u.id, bps, fixedMinor: fixed, label: r.label ?? null };
  });
  if (totalBps > 10_000) throw badRequest('Split percentages exceed 100%', 'split_over_100');
  return out;
}

/** Called once the intent is captured and the merchant wallet holds the money. Idempotent per intent. */
export function applySplits(intentId: string): SplitPayoutView[] {
  const db = getDb();
  const intent = db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(intentId) as any;
  if (!intent?.transaction_id) return [];
  const meta = parseJson<{ splits?: ReturnType<typeof validateSplits> }>(intent.metadata, {});
  const rules = meta.splits ?? [];
  if (!rules.length) return [];
  if (db.prepare('SELECT 1 FROM split_payouts WHERE intent_id = ? LIMIT 1').get(intentId)) return listSplitPayouts(intentId);
  const source = getTransaction(intent.transaction_id);
  if (!source) return [];
  const merchant = findUserById(intent.merchant_user_id)!;
  const received = source.receive_amount ?? source.amount - source.fee; // what the merchant actually got
  const fixedSum = rules.reduce((s, r) => s + r.fixedMinor, 0);
  // Fixed parts come first; percentages apply to what is left so the shares can never exceed the amount received.
  const distributable = Math.max(0, received - fixedSum);
  const shares = rules.map((r) => Math.round((distributable * r.bps) / 10_000));
  const out: SplitPayoutView[] = [];
  const merchantWallet = getUserWallet(merchant.id, source.currency);
  rules.forEach((rule, i) => {
    const amount = rule.fixedMinor + shares[i];
    const id = `sp_${shortCode(12).toLowerCase()}`;
    db.prepare('INSERT INTO split_payouts (id, intent_id, source_transaction_id, recipient_user_id, amount_minor, currency, label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, intentId, source.id, rule.recipientUserId, amount, source.currency, rule.label, 'PENDING', now(), now());
    if (amount <= 0) {
      db.prepare("UPDATE split_payouts SET status = 'PAID', updated_at = ? WHERE id = ?").run(now(), id);
      out.push(toView(db.prepare('SELECT * FROM split_payouts WHERE id = ?').get(id)));
      return;
    }
    try {
      const to = ensureWallet(rule.recipientUserId, source.currency);
      const tx = postTransaction({ type: 'distribution', amount, currency: source.currency, fromWalletId: merchantWallet.id, toWalletId: to.id, senderUserId: merchant.id, receiverUserId: rule.recipientUserId, note: rule.label ?? `Split of ${source.reference}`, metadata: { intentId, split: true, sourceTransactionId: source.id, label: rule.label }, idempotencyKey: `split:${id}` });
      db.prepare("UPDATE split_payouts SET status = 'PAID', transaction_id = ?, updated_at = ? WHERE id = ?").run(tx.id, now(), id);
      notify(rule.recipientUserId, 'Split payment received', `${merchant.business_name ?? merchant.full_name} shared a payment with you.`, { kind: 'transfer_in', transactionId: tx.id });
    } catch (err) {
      db.prepare("UPDATE split_payouts SET status = 'FAILED', error = ?, updated_at = ? WHERE id = ?").run((err as Error).message, now(), id);
    }
    out.push(toView(db.prepare('SELECT * FROM split_payouts WHERE id = ?').get(id)));
  });
  recordEvent('payment', intentId, 'splits.applied', { type: 'system' }, { count: out.length, paid: out.filter((s) => s.status === 'PAID').length, failed: out.filter((s) => s.status === 'FAILED').length });
  return out;
}

export function listSplitPayouts(intentId: string): SplitPayoutView[] {
  return (getDb().prepare('SELECT * FROM split_payouts WHERE intent_id = ? ORDER BY created_at').all(intentId) as any[]).map(toView);
}

/** Retry failed shares (for example after the merchant topped up). */
export function retrySplits(intentId: string): SplitPayoutView[] {
  const db = getDb();
  const failed = db.prepare("SELECT * FROM split_payouts WHERE intent_id = ? AND status = 'FAILED'").all(intentId) as any[];
  const intent = db.prepare('SELECT merchant_user_id FROM payment_intents WHERE id = ?').get(intentId) as any;
  for (const f of failed) {
    try {
      const merchantWallet = getUserWallet(intent.merchant_user_id, f.currency);
      const to = ensureWallet(f.recipient_user_id, f.currency);
      const tx = postTransaction({ type: 'distribution', amount: f.amount_minor, currency: f.currency, fromWalletId: merchantWallet.id, toWalletId: to.id, senderUserId: intent.merchant_user_id, receiverUserId: f.recipient_user_id, note: f.label ?? 'Split payment', metadata: { intentId, split: true, sourceTransactionId: f.source_transaction_id }, idempotencyKey: `split:${f.id}:retry:${Date.now()}` });
      db.prepare("UPDATE split_payouts SET status = 'PAID', transaction_id = ?, error = NULL, updated_at = ? WHERE id = ?").run(tx.id, now(), f.id);
    } catch (err) {
      db.prepare('UPDATE split_payouts SET error = ?, updated_at = ? WHERE id = ?').run((err as Error).message, now(), f.id);
    }
  }
  return listSplitPayouts(intentId);
}
