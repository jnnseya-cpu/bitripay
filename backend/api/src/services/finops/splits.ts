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
import { recordEvent, type Actor } from '../events';
import { notify } from '../notifications';
import { subscribe, type RefundSucceededPayload } from '../bus';
import { formatMinor } from '../currencies';

/**
 * What happens to a recipient's share when the payment is refunded: `pro_rata` (default) claws back the same
 * proportion of the share as was refunded of the payment; `merchant_absorbs` leaves the recipient whole and the
 * merchant bears the whole refund.
 */
export type SplitRefundPolicy = 'pro_rata' | 'merchant_absorbs';
export const SPLIT_REFUND_POLICIES: SplitRefundPolicy[] = ['pro_rata', 'merchant_absorbs'];

export interface SplitRule {
  /** @tag, email, phone or user id */
  recipient: string;
  bps?: number | null;
  fixedMinor?: number | null;
  label?: string | null;
  refundPolicy?: SplitRefundPolicy | null;
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
const toView = (r: any): SplitPayoutView => ({
  id: r.id,
  intentId: r.intent_id,
  sourceTransactionId: r.source_transaction_id,
  recipientUserId: r.recipient_user_id,
  amountMinor: r.amount_minor,
  currency: r.currency,
  label: r.label,
  transactionId: r.transaction_id,
  status: r.status,
  error: r.error,
  createdAt: r.created_at,
});

/** Resolve recipients and check the rules can be honoured on any amount (bps total ≤ 10000; fixed parts are checked at capture). */
export function validateSplits(
  rules: SplitRule[],
  merchantId: string,
): { recipient: string; recipientUserId: string; bps: number; fixedMinor: number; label: string | null; refundPolicy: SplitRefundPolicy }[] {
  if (rules.length > 10) throw badRequest('At most 10 split recipients', 'too_many_splits');
  let totalBps = 0;
  const out = rules.map((r) => {
    const u = findUserByIdentifier(r.recipient) ?? findUserById(r.recipient);
    if (!u || u.is_system || u.status !== 'active') throw badRequest(`Split recipient ${r.recipient} not found`, 'split_recipient_not_found');
    if (u.id === merchantId) throw badRequest('A split cannot pay the merchant itself', 'split_self');
    const bps = Math.max(0, Math.round(r.bps ?? 0));
    const fixed = Math.max(0, Math.round(r.fixedMinor ?? 0));
    if (!bps && !fixed) throw badRequest(`Split for ${r.recipient} needs bps or fixedMinor`, 'split_amount_required');
    const refundPolicy = r.refundPolicy ?? 'pro_rata';
    if (!SPLIT_REFUND_POLICIES.includes(refundPolicy)) throw badRequest(`Unknown split refund policy ${refundPolicy}`, 'split_refund_policy_invalid');
    totalBps += bps;
    return { recipient: r.recipient, recipientUserId: u.id, bps, fixedMinor: fixed, label: r.label ?? null, refundPolicy };
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
    db.prepare(
      'INSERT INTO split_payouts (id, intent_id, source_transaction_id, recipient_user_id, amount_minor, currency, label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, intentId, source.id, rule.recipientUserId, amount, source.currency, rule.label, 'PENDING', now(), now());
    if (amount <= 0) {
      db.prepare("UPDATE split_payouts SET status = 'PAID', updated_at = ? WHERE id = ?").run(now(), id);
      out.push(toView(db.prepare('SELECT * FROM split_payouts WHERE id = ?').get(id)));
      return;
    }
    try {
      const to = ensureWallet(rule.recipientUserId, source.currency);
      const tx = postTransaction({
        type: 'distribution',
        amount,
        currency: source.currency,
        fromWalletId: merchantWallet.id,
        toWalletId: to.id,
        senderUserId: merchant.id,
        receiverUserId: rule.recipientUserId,
        note: rule.label ?? `Split of ${source.reference}`,
        metadata: { intentId, split: true, sourceTransactionId: source.id, label: rule.label },
        idempotencyKey: `split:${id}`,
      });
      db.prepare("UPDATE split_payouts SET status = 'PAID', transaction_id = ?, updated_at = ? WHERE id = ?").run(tx.id, now(), id);
      notify(rule.recipientUserId, 'Split payment received', `${merchant.business_name ?? merchant.full_name} shared a payment with you.`, { kind: 'transfer_in', transactionId: tx.id });
    } catch (err) {
      db.prepare("UPDATE split_payouts SET status = 'FAILED', error = ?, updated_at = ? WHERE id = ?").run((err as Error).message, now(), id);
    }
    out.push(toView(db.prepare('SELECT * FROM split_payouts WHERE id = ?').get(id)));
  });
  recordEvent(
    'payment',
    intentId,
    'splits.applied',
    { type: 'system' },
    { count: out.length, paid: out.filter((s) => s.status === 'PAID').length, failed: out.filter((s) => s.status === 'FAILED').length },
  );
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
      const tx = postTransaction({
        type: 'distribution',
        amount: f.amount_minor,
        currency: f.currency,
        fromWalletId: merchantWallet.id,
        toWalletId: to.id,
        senderUserId: intent.merchant_user_id,
        receiverUserId: f.recipient_user_id,
        note: f.label ?? 'Split payment',
        metadata: { intentId, split: true, sourceTransactionId: f.source_transaction_id },
        idempotencyKey: `split:${f.id}:retry:${Date.now()}`,
      });
      db.prepare("UPDATE split_payouts SET status = 'PAID', transaction_id = ?, error = NULL, updated_at = ? WHERE id = ?").run(tx.id, now(), f.id);
    } catch (err) {
      db.prepare('UPDATE split_payouts SET error = ?, updated_at = ? WHERE id = ?').run((err as Error).message, now(), f.id);
    }
  }
  return listSplitPayouts(intentId);
}

// ---------------------------------------------------------------------------------------------------------------------
// Refunds of split payments
// ---------------------------------------------------------------------------------------------------------------------
export interface SplitRefundAllocationView {
  id: string;
  intentId: string;
  refundId: string;
  splitPayoutId: string;
  recipientUserId: string;
  amountMinor: number;
  currency: string;
  policy: SplitRefundPolicy;
  transactionId: string | null;
  status: 'PENDING' | 'RECOVERED' | 'ABSORBED' | 'FAILED';
  error: string | null;
  createdAt: string;
}
const toAllocation = (r: any): SplitRefundAllocationView => ({
  id: r.id,
  intentId: r.intent_id,
  refundId: r.refund_id,
  splitPayoutId: r.split_payout_id,
  recipientUserId: r.recipient_user_id,
  amountMinor: r.amount_minor,
  currency: r.currency,
  policy: r.policy,
  transactionId: r.transaction_id,
  status: r.status,
  error: r.error,
  createdAt: r.created_at,
});

export function listSplitRefundAllocations(intentId: string, refundId?: string | null): SplitRefundAllocationView[] {
  const db = getDb();
  const rows = refundId
    ? db.prepare('SELECT * FROM split_refund_allocations WHERE intent_id = ? AND refund_id = ? ORDER BY created_at').all(intentId, refundId)
    : db.prepare('SELECT * FROM split_refund_allocations WHERE intent_id = ? ORDER BY created_at').all(intentId);
  return (rows as any[]).map(toAllocation);
}

/** The refund policy of a paid share: the rule's own policy, else the intent-level `splitRefundPolicy`, else pro rata. */
function policyFor(rules: { recipientUserId: string; label: string | null; refundPolicy?: SplitRefundPolicy | null }[], intentMeta: Record<string, any>, share: any): SplitRefundPolicy {
  const rule = rules.find((r) => r.recipientUserId === share.recipient_user_id && (r.label ?? null) === (share.label ?? null)) ?? rules.find((r) => r.recipientUserId === share.recipient_user_id);
  const p = rule?.refundPolicy ?? intentMeta.splitRefundPolicy ?? 'pro_rata';
  return SPLIT_REFUND_POLICIES.includes(p) ? p : 'pro_rata';
}

/**
 * A captured payment with splits was refunded (fully or partially): allocate the refund back across the recipients.
 * Pro rata: each paid share gives back the same proportion of itself as the refund is of the payment principal, capped
 * by what that share has not already given back. `merchant_absorbs` shares are recorded as ABSORBED and keep their
 * money. Every recovery is a reverse `distribution` (recipient wallet → merchant wallet) with its own ledger entries;
 * a recipient without enough balance is recorded FAILED and can be retried. Idempotent per refund.
 */
export function allocateRefundAcrossSplits(intentId: string, refundId: string, amountMinor: number, actor: Actor): SplitRefundAllocationView[] {
  const db = getDb();
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw badRequest('Refund amount must be a positive integer in minor units', 'invalid_amount');
  const existing = listSplitRefundAllocations(intentId, refundId);
  if (existing.length) return existing;
  const intent = db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(intentId) as any;
  if (!intent?.transaction_id) return [];
  const source = getTransaction(intent.transaction_id);
  if (!source) return [];
  const shares = db.prepare("SELECT * FROM split_payouts WHERE intent_id = ? AND status = 'PAID' AND amount_minor > 0 ORDER BY created_at").all(intentId) as any[];
  if (!shares.length) return [];
  const meta = parseJson<Record<string, any>>(intent.metadata, {});
  const rules = (meta.splits ?? []) as ReturnType<typeof validateSplits>;
  const principal = source.amount;
  const ratio = Math.min(1, amountMinor / principal);
  const merchantWallet = getUserWallet(intent.merchant_user_id, source.currency);
  const out: SplitRefundAllocationView[] = [];
  for (const share of shares) {
    const policy = policyFor(rules, meta, share);
    const recovered = (db.prepare("SELECT COALESCE(SUM(amount_minor), 0) s FROM split_refund_allocations WHERE split_payout_id = ? AND status = 'RECOVERED'").get(share.id) as any).s as number;
    const remaining = Math.max(0, share.amount_minor - recovered);
    const wanted = policy === 'merchant_absorbs' ? 0 : Math.min(remaining, Math.round(share.amount_minor * ratio));
    const id = `sra_${shortCode(12).toLowerCase()}`;
    db.prepare(
      'INSERT INTO split_refund_allocations (id, intent_id, refund_id, split_payout_id, recipient_user_id, amount_minor, currency, policy, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, intentId, refundId, share.id, share.recipient_user_id, wanted, share.currency, policy, policy === 'merchant_absorbs' ? 'ABSORBED' : 'PENDING', now(), now());
    if (wanted > 0) {
      try {
        const from = ensureWallet(share.recipient_user_id, share.currency);
        const tx = postTransaction({
          type: 'distribution',
          amount: wanted,
          currency: share.currency,
          fromWalletId: from.id,
          toWalletId: merchantWallet.id,
          senderUserId: share.recipient_user_id,
          receiverUserId: intent.merchant_user_id,
          note: `Refund of split ${share.label ?? source.reference}`,
          metadata: { intentId, split: true, splitRefund: true, refundId, splitPayoutId: share.id, sourceTransactionId: source.id, policy },
          idempotencyKey: `split_refund:${id}`,
        });
        db.prepare("UPDATE split_refund_allocations SET status = 'RECOVERED', transaction_id = ?, updated_at = ? WHERE id = ?").run(tx.id, now(), id);
        notify(share.recipient_user_id, 'Split payment refunded', `${formatMinor(wanted, share.currency)} of a shared payment was returned to cover a customer refund.`, {
          kind: 'transfer_out',
          transactionId: tx.id,
        });
      } catch (err) {
        db.prepare("UPDATE split_refund_allocations SET status = 'FAILED', error = ?, updated_at = ? WHERE id = ?").run((err as Error).message, now(), id);
      }
    } else if (policy !== 'merchant_absorbs') db.prepare("UPDATE split_refund_allocations SET status = 'RECOVERED', updated_at = ? WHERE id = ?").run(now(), id);
    out.push(toAllocation(db.prepare('SELECT * FROM split_refund_allocations WHERE id = ?').get(id)));
  }
  recordEvent('payment', intentId, 'splits.refund_allocated', actor, {
    refundId,
    amount: amountMinor,
    recovered: out.filter((a) => a.status === 'RECOVERED').reduce((s, a) => s + a.amountMinor, 0),
    absorbed: out.filter((a) => a.status === 'ABSORBED').length,
    failed: out.filter((a) => a.status === 'FAILED').length,
  });
  return out;
}

/** Retry FAILED allocations (for example once the recipient has been topped up). */
export function retrySplitRefundAllocations(intentId: string): SplitRefundAllocationView[] {
  const db = getDb();
  const intent = db.prepare('SELECT merchant_user_id FROM payment_intents WHERE id = ?').get(intentId) as any;
  if (!intent) return [];
  for (const a of db.prepare("SELECT * FROM split_refund_allocations WHERE intent_id = ? AND status = 'FAILED'").all(intentId) as any[]) {
    try {
      const from = ensureWallet(a.recipient_user_id, a.currency);
      const merchantWallet = getUserWallet(intent.merchant_user_id, a.currency);
      const tx = postTransaction({
        type: 'distribution',
        amount: a.amount_minor,
        currency: a.currency,
        fromWalletId: from.id,
        toWalletId: merchantWallet.id,
        senderUserId: a.recipient_user_id,
        receiverUserId: intent.merchant_user_id,
        note: 'Refund of split payment',
        metadata: { intentId, split: true, splitRefund: true, refundId: a.refund_id, splitPayoutId: a.split_payout_id, policy: a.policy },
        idempotencyKey: `split_refund:${a.id}:retry:${Date.now()}`,
      });
      db.prepare("UPDATE split_refund_allocations SET status = 'RECOVERED', transaction_id = ?, error = NULL, updated_at = ? WHERE id = ?").run(tx.id, now(), a.id);
    } catch (err) {
      db.prepare('UPDATE split_refund_allocations SET error = ?, updated_at = ? WHERE id = ?').run((err as Error).message, now(), a.id);
    }
  }
  return listSplitRefundAllocations(intentId);
}

// The gateway publishes `refund.succeeded` once a refund's ledger entries are posted; split shares follow the refund.
const REFUND_HOOK = Symbol.for('bitripay.splits.refund_subscribed');
if (!(globalThis as any)[REFUND_HOOK]) {
  (globalThis as any)[REFUND_HOOK] = true;
  subscribe('splits-refund-allocation', ['refund.succeeded'], (ev) => {
    const p = ev.payload as Partial<RefundSucceededPayload>;
    if (!p.intentId || !p.refundId || !p.amountMinor) return;
    allocateRefundAcrossSplits(p.intentId, p.refundId, p.amountMinor, { type: 'system' });
  });
}
