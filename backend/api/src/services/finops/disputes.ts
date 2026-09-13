/**
 * Disputes as first-class objects: opened by a customer, a merchant, a processor (chargeback), an institution or an
 * administrator; they keep the product deadline, reason, evidence from both sides, the responsible institution, the
 * chronology (event log), status and decision. Opening a dispute places a hold on the merchant's wallet for the
 * disputed amount; a decision releases the hold (WON) or turns it into a refund (LOST). Deadlines come from the
 * configured product rules, never invented per case, and operator intervention never deletes or edits evidence.
 */
import { getDb } from '../../db';
import { now, shortCode } from '../../lib/ids';
import { parseJson } from '../../lib/json';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import { getSetting } from '../settings';
import { recordEvent, listEvents, type Actor } from '../events';
import { findUserById, type UserRow } from '../users';
import { getTransaction } from '../ledger';
import { getUserWallet } from '../wallets';
import { emitEvent } from '../webhooks';
import { notify } from '../notifications';
import { createHold, releaseHoldsFor } from './holds';
import { createRefund } from '../gateway';
import { publish } from '../bus';

export interface DisputeSettings {
  /** Days the merchant has to respond, per rail (product rules; confirm with each scheme). */
  responseDays: Record<string, number>;
  /** What happens when the deadline passes without a response. */
  onDeadline: 'LOST' | 'UNDER_REVIEW';
  reasonCodes: string[];
}
const DEFAULT: DisputeSettings = {
  responseDays: { wallet: 7, card: 10, mobile_money: 7, bank: 10, national_switch: 15, default: 10 },
  onDeadline: 'UNDER_REVIEW',
  reasonCodes: ['not_received', 'not_as_described', 'duplicate', 'unauthorised', 'amount_incorrect', 'cancelled_service', 'fraud', 'other'],
};
export const getDisputeSettings = (): DisputeSettings => {
  const s = getSetting<Partial<DisputeSettings>>('disputes', {});
  return { ...DEFAULT, ...s, responseDays: { ...DEFAULT.responseDays, ...(s.responseDays ?? {}) } };
};

export type DisputeStatus = 'OPEN' | 'EVIDENCE_REQUESTED' | 'UNDER_REVIEW' | 'WON' | 'LOST' | 'WITHDRAWN' | 'EXPIRED';
export interface DisputeView {
  id: string;
  merchantId: string;
  customerId: string | null;
  intentId: string | null;
  transactionId: string | null;
  gatewayPaymentId: string | null;
  chargebackId: string | null;
  switchPaymentId: string | null;
  openedBy: string;
  reasonCode: string;
  reason: string | null;
  amount: { valueMinor: number; currency: string };
  rail: string;
  status: DisputeStatus;
  deadlineAt: string;
  responsibleInstitution: string | null;
  evidence: { by: string; role: string; at: string; text: string; files: string[] }[];
  merchantResponse: string | null;
  respondedAt: string | null;
  decision: 'WON' | 'LOST' | null;
  decisionReason: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  holdId: string | null;
  refundId: string | null;
  createdAt: string;
  updatedAt: string;
}
const toView = (r: any): DisputeView => ({
  id: r.id,
  merchantId: r.merchant_user_id,
  customerId: r.customer_user_id,
  intentId: r.intent_id,
  transactionId: r.transaction_id,
  gatewayPaymentId: r.gateway_payment_id,
  chargebackId: r.chargeback_id,
  switchPaymentId: r.switch_payment_id,
  openedBy: r.opened_by,
  reasonCode: r.reason_code,
  reason: r.reason,
  amount: { valueMinor: r.amount_minor, currency: r.currency },
  rail: r.rail,
  status: r.status,
  deadlineAt: r.deadline_at,
  responsibleInstitution: r.responsible_institution,
  evidence: parseJson(r.evidence, []),
  merchantResponse: r.merchant_response,
  respondedAt: r.responded_at,
  decision: r.decision,
  decisionReason: r.decision_reason,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at,
  holdId: r.hold_id,
  refundId: r.refund_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface OpenDisputeInput {
  transactionId?: string | null;
  intentId?: string | null;
  gatewayPaymentId?: string | null;
  chargebackId?: string | null;
  switchPaymentId?: string | null;
  openedBy: 'customer' | 'merchant' | 'processor' | 'institution' | 'admin';
  reasonCode: string;
  reason?: string | null;
  amountMinor?: number | null;
  responsibleInstitution?: string | null;
  evidenceText?: string | null;
}

export function openDispute(input: OpenDisputeInput, actor: Actor): DisputeView {
  const db = getDb();
  const settings = getDisputeSettings();
  if (!settings.reasonCodes.includes(input.reasonCode)) throw badRequest(`Unknown reason code; use one of ${settings.reasonCodes.join(', ')}`, 'invalid_reason_code');
  let tx = input.transactionId ? getTransaction(input.transactionId) : undefined;
  let intentId = input.intentId ?? null;
  if (!tx && intentId) {
    const i = db.prepare('SELECT transaction_id FROM payment_intents WHERE id = ?').get(intentId) as any;
    if (i?.transaction_id) tx = getTransaction(i.transaction_id);
  }
  if (!tx && input.gatewayPaymentId) {
    const gp = db.prepare('SELECT transaction_id FROM gateway_payments WHERE id = ?').get(input.gatewayPaymentId) as any;
    if (gp?.transaction_id) tx = getTransaction(gp.transaction_id);
  }
  if (!tx) throw notFound('The disputed payment could not be found', 'payment_not_found');
  if (!tx.receiver_user_id) throw badRequest('Only payments to a merchant can be disputed', 'not_disputable');
  if (!intentId) intentId = tx.intent_id ?? null;
  const merchant = findUserById(tx.receiver_user_id)!;
  const existing = db.prepare("SELECT id FROM disputes WHERE transaction_id = ? AND status IN ('OPEN', 'EVIDENCE_REQUESTED', 'UNDER_REVIEW')").get(tx.id) as any;
  if (existing) throw conflict(`A dispute (${existing.id}) is already open on this payment`, 'dispute_exists');
  const amount = input.amountMinor ?? tx.amount;
  if (!Number.isInteger(amount) || amount <= 0 || amount > tx.amount) throw badRequest('Disputed amount must be between 1 and the payment amount', 'invalid_amount');
  const rail = (parseJson<any>(tx.metadata, {}).method as string | undefined) ?? (tx.sender_wallet_id ? 'wallet' : 'card');
  const days = settings.responseDays[rail] ?? settings.responseDays.default ?? 10;
  const id = `dp_${shortCode(14).toLowerCase()}`;
  const deadline = new Date(Date.now() + days * 86_400_000).toISOString();
  db.transaction(() => {
    db.prepare(
      'INSERT INTO disputes (id, merchant_user_id, customer_user_id, intent_id, transaction_id, gateway_payment_id, chargeback_id, switch_payment_id, opened_by, reason_code, reason, amount_minor, currency, rail, status, deadline_at, responsible_institution, evidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      merchant.id,
      tx!.sender_user_id,
      intentId,
      tx!.id,
      input.gatewayPaymentId ?? null,
      input.chargebackId ?? null,
      input.switchPaymentId ?? null,
      input.openedBy,
      input.reasonCode,
      input.reason ?? null,
      amount,
      tx!.currency,
      rail,
      'OPEN',
      deadline,
      input.responsibleInstitution ?? null,
      JSON.stringify(input.evidenceText ? [{ by: actor.id ?? input.openedBy, role: input.openedBy, at: now(), text: input.evidenceText, files: [] }] : []),
      now(),
      now(),
    );
    // the disputed amount stays in the merchant wallet but is no longer available or settleable
    try {
      const wallet = getUserWallet(merchant.id, tx!.currency);
      const hold = createHold({ walletId: wallet.id, amountMinor: amount, kind: 'dispute', refType: 'dispute', refId: id, reason: `${input.reasonCode} (${input.openedBy})` }, actor);
      db.prepare('UPDATE disputes SET hold_id = ? WHERE id = ?').run(hold.id, id);
    } catch {
      /* no wallet in that currency yet: nothing to hold */
    }
    if (intentId) {
      const st = (db.prepare('SELECT status FROM payment_intents WHERE id = ?').get(intentId) as any)?.status;
      if (['CAPTURED', 'SETTLEMENT_PENDING', 'SETTLED'].includes(st)) db.prepare("UPDATE payment_intents SET status = 'DISPUTED', updated_at = ? WHERE id = ?").run(now(), intentId);
    }
  })();
  recordEvent('chargeback', id, 'dispute.opened', actor, { transactionId: tx.id, amount, reasonCode: input.reasonCode, openedBy: input.openedBy, deadline, rail });
  const view = getDispute(null, id);
  emitEvent(merchant.id, 'payment_intent.disputed', { dispute: view }, { resource: { type: 'dispute', id } });
  publish(
    'dispute.opened',
    { disputeId: id, merchantId: merchant.id, reasonCode: input.reasonCode, amountMinor: amount, currency: tx.currency, openedBy: input.openedBy },
    { aggregateId: id, tenantId: merchant.id },
  );
  notify(merchant.id, 'Payment disputed', `${amount / 100} ${tx.currency}: ${input.reasonCode.replace(/_/g, ' ')}. Respond with evidence before ${deadline.slice(0, 10)}.`, {
    kind: 'chargeback',
    disputeId: id,
  });
  return view;
}

export function getDispute(merchantId: string | null, id: string): DisputeView {
  const r = getDb().prepare('SELECT * FROM disputes WHERE id = ?').get(id) as any;
  if (!r || (merchantId && r.merchant_user_id !== merchantId)) throw notFound('Dispute not found', 'dispute_not_found');
  return toView(r);
}
export function listDisputes(filter: { merchantId?: string | null; customerId?: string | null; status?: string | null; limit?: number } = {}): DisputeView[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.merchantId) {
    where.push('merchant_user_id = ?');
    params.push(filter.merchantId);
  }
  if (filter.customerId) {
    where.push('customer_user_id = ?');
    params.push(filter.customerId);
  }
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  return (
    getDb()
      .prepare(`SELECT * FROM disputes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, Math.min(200, filter.limit ?? 50)) as any[]
  ).map(toView);
}

const OPEN: DisputeStatus[] = ['OPEN', 'EVIDENCE_REQUESTED', 'UNDER_REVIEW'];

/** Evidence is appended, never edited or removed. */
export function addEvidence(id: string, by: { id: string; role: string }, text: string, files: string[] = []): DisputeView {
  const d = getDispute(null, id);
  if (!OPEN.includes(d.status)) throw conflict(`Dispute is ${d.status}`, 'dispute_closed');
  if (!text.trim() && !files.length) throw badRequest('Evidence needs text or files', 'evidence_required');
  getDb()
    .prepare('UPDATE disputes SET evidence = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify([...d.evidence, { by: by.id, role: by.role, at: now(), text, files }]), now(), id);
  recordEvent('chargeback', id, 'dispute.evidence', { type: by.role === 'admin' ? 'admin' : by.role === 'merchant' ? 'merchant' : 'user', id: by.id }, { chars: text.length, files: files.length });
  return getDispute(null, id);
}

export function merchantRespond(merchant: UserRow, id: string, response: string, files: string[] = []): DisputeView {
  const d = getDispute(merchant.id, id);
  if (!OPEN.includes(d.status)) throw conflict(`Dispute is ${d.status}`, 'dispute_closed');
  if (d.deadlineAt < now()) throw conflict('The response deadline has passed', 'deadline_passed');
  addEvidence(id, { id: merchant.id, role: 'merchant' }, response, files);
  getDb().prepare("UPDATE disputes SET merchant_response = ?, responded_at = ?, status = 'UNDER_REVIEW', updated_at = ? WHERE id = ?").run(response, now(), now(), id);
  recordEvent('chargeback', id, 'dispute.merchant_responded', { type: 'merchant', id: merchant.id }, {});
  return getDispute(null, id);
}

export function requestEvidence(id: string, admin: UserRow, note: string): DisputeView {
  const d = getDispute(null, id);
  if (!OPEN.includes(d.status)) throw conflict(`Dispute is ${d.status}`, 'dispute_closed');
  getDb().prepare("UPDATE disputes SET status = 'EVIDENCE_REQUESTED', updated_at = ? WHERE id = ?").run(now(), id);
  addEvidence(id, { id: admin.id, role: 'admin' }, `Evidence requested: ${note}`);
  notify(d.merchantId, 'Evidence requested', note, { kind: 'chargeback', disputeId: id });
  return getDispute(null, id);
}

/** Decide. LOST refunds the disputed amount to the payer through the refund object; WON releases the hold. */
export async function decideDispute(id: string, decision: 'WON' | 'LOST', admin: UserRow, reason: string): Promise<DisputeView> {
  const db = getDb();
  const d = getDispute(null, id);
  if (!OPEN.includes(d.status)) throw conflict(`Dispute is ${d.status}`, 'dispute_closed');
  if (!reason.trim()) throw badRequest('A decision needs a reason', 'reason_required');
  const actor: Actor = { type: 'admin', id: admin.id };
  let refundId: string | null = null;
  if (decision === 'LOST') {
    releaseHoldsFor('dispute', id, actor, 'dispute lost: refunding');
    const merchant = findUserById(d.merchantId)!;
    if (d.transactionId) {
      const r = await createRefund(merchant, { transactionId: d.transactionId, amountMinor: d.amount.valueMinor, reason: `dispute ${id}: ${reason}`, idemKey: `dispute:${id}` }, actor);
      refundId = r.id;
      if (r.status === 'FAILED') {
        // keep the money reserved until the merchant can cover it
        const wallet = getUserWallet(d.merchantId, d.amount.currency);
        createHold({ walletId: wallet.id, amountMinor: d.amount.valueMinor, kind: 'dispute', refType: 'dispute', refId: id, reason: 'refund pending funds' }, actor);
        throw new AppError(402, 'refund_failed', `The dispute is decided but the refund failed: ${r.error}. The amount stays on hold.`);
      }
    }
  } else releaseHoldsFor('dispute', id, actor, 'dispute won');
  db.prepare('UPDATE disputes SET status = ?, decision = ?, decision_reason = ?, decided_by = ?, decided_at = ?, refund_id = ?, updated_at = ? WHERE id = ?').run(
    decision,
    decision,
    reason,
    admin.id,
    now(),
    refundId,
    now(),
    id,
  );
  if (d.intentId) {
    const st = (db.prepare('SELECT status FROM payment_intents WHERE id = ?').get(d.intentId) as any)?.status;
    if (st === 'DISPUTED' && decision === 'WON') db.prepare("UPDATE payment_intents SET status = 'SETTLED', updated_at = ? WHERE id = ?").run(now(), d.intentId);
  }
  recordEvent('chargeback', id, `dispute.${decision.toLowerCase()}`, actor, { reason, refundId });
  const view = getDispute(null, id);
  emitEvent(d.merchantId, 'payment_intent.disputed', { dispute: view }, { resource: { type: 'dispute', id } });
  notify(d.merchantId, decision === 'WON' ? 'Dispute won' : 'Dispute lost', decision === 'WON' ? 'The hold on the disputed amount was released.' : 'The disputed amount was refunded to the payer.', {
    kind: 'chargeback',
    disputeId: id,
  });
  return view;
}

export function withdrawDispute(id: string, by: Actor): DisputeView {
  const d = getDispute(null, id);
  if (!OPEN.includes(d.status)) throw conflict(`Dispute is ${d.status}`, 'dispute_closed');
  releaseHoldsFor('dispute', id, by, 'dispute withdrawn');
  getDb().prepare("UPDATE disputes SET status = 'WITHDRAWN', updated_at = ? WHERE id = ?").run(now(), id);
  recordEvent('chargeback', id, 'dispute.withdrawn', by, {});
  return getDispute(null, id);
}

/** Deadline sweep: an unanswered dispute moves to review (or is lost, per the product rule). */
export function sweepDisputeDeadlines(): number {
  const settings = getDisputeSettings();
  const rows = getDb().prepare("SELECT id FROM disputes WHERE status IN ('OPEN', 'EVIDENCE_REQUESTED') AND deadline_at < ?").all(now()) as { id: string }[];
  for (const r of rows) {
    getDb()
      .prepare('UPDATE disputes SET status = ?, updated_at = ? WHERE id = ?')
      .run(settings.onDeadline === 'LOST' ? 'EXPIRED' : 'UNDER_REVIEW', now(), r.id);
    recordEvent('chargeback', r.id, 'dispute.deadline_passed', { type: 'system' }, { outcome: settings.onDeadline });
  }
  return rows.length;
}

export function disputeChronology(id: string) {
  const d = getDispute(null, id);
  return {
    dispute: d,
    events: listEvents({ stream: 'chargeback', subjectId: id, limit: 200 }).items.map((e) => ({
      at: e.createdAt,
      event: e.event,
      actor: e.actor.type,
      actorId: e.actor.id ?? null,
      details: e.details,
    })),
  };
}
