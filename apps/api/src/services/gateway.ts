/**
 * Gateway objects layered on payment intents: hosted checkout sessions, payment links, refunds with atomic
 * reservations, Scan-to-Verify (KODA) verifications, payouts and the sandbox outcome simulator.
 *
 * Nothing here moves money on its own: checkout sessions and links create intents that the existing wallet/QR/
 * checkout flows settle; refunds post balanced ledger entries from the merchant's wallet (and ask the processor to
 * return card/mobile-money funds); payouts go through the withdrawal workflow with its maker-checker controls.
 */
import { getDb } from '../db';
import { now, shortCode, uuid } from '../lib/ids';
import { parseJson } from '../lib/json';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { config } from '../config';
import { getCurrency } from './currencies';
import { findUserById, type UserRow } from './users';
import { createIntent, getIntentRow, intentView, cancelIntent, transitionIntent, appendPaymentEvent, listAttempts, type IntentRow, type IntentView } from './intents';
import { createStaticQr, getQr, revokeQr, listQrs, type QrView } from './qrcodes';
import { postTransaction, getTransaction, toTransaction, transactionStatusHooks, type TransactionRow } from './ledger';
import { ensureWallet } from './wallets';
import { getPayment, providerRefund, initiatePayment, verifyPayment } from './payments';
import { requestWithdrawal, type WithdrawalDestination } from './withdrawals';
import { getPayoutByTransaction } from './payouts';
import { emitEvent } from './webhooks';
import { recordEvent, type Actor } from './events';
import { getGatewayProductSettings } from './settings';
import { assertMoneyMovementAllowed } from './guardian';
import { notify } from './notifications';
import { formatMoney } from '@bitripay/shared';

const paymentRequired = (message: string, code = 'payment_required') => new AppError(402, code, message);

// ---------------------------------------------------------------------------------------------------------------------
// Checkout sessions
// ---------------------------------------------------------------------------------------------------------------------
export interface LineItem {
  name: string;
  quantity: number;
  unitAmountMinor: number;
}
export interface CheckoutSessionView {
  id: string;
  object: 'checkout.session';
  status: 'open' | 'complete' | 'expired';
  url: string;
  intentId: string;
  paymentIntent: IntentView;
  amount: { valueMinor: number; currency: string };
  lineItems: LineItem[];
  customer: { email?: string | null; phone?: string | null; name?: string | null } | null;
  successUrl: string | null;
  cancelUrl: string | null;
  expiresAt: string;
  completedAt: string | null;
  createdAt: string;
}

function sessionView(r: any): CheckoutSessionView {
  const intent = intentView(getIntentRow(r.intent_id));
  return {
    id: r.id,
    object: 'checkout.session',
    status: r.status,
    url: `${config.webUrl}/pay/${intent.paymentRequestCode}?cs=${r.id}`,
    intentId: r.intent_id,
    paymentIntent: intent,
    amount: { valueMinor: intent.amount.valueMinor ?? 0, currency: intent.amount.currency },
    lineItems: parseJson<LineItem[]>(r.line_items, []),
    customer: r.customer ? parseJson(r.customer, null) : null,
    successUrl: r.success_url,
    cancelUrl: r.cancel_url,
    expiresAt: r.expires_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
  };
}

export interface CreateCheckoutSessionInput {
  amountMinor?: number | null;
  currency: string;
  lineItems?: LineItem[];
  successUrl?: string | null;
  cancelUrl?: string | null;
  customer?: { email?: string | null; phone?: string | null; name?: string | null } | null;
  reference?: string | null;
  description?: string | null;
  purposeCode?: string | null;
  metadata?: Record<string, unknown>;
  expiresInMinutes?: number | null;
  allowedMethods?: string[];
  rails?: string[];
  idemKey?: string | null;
}

export function createCheckoutSession(merchant: UserRow, input: CreateCheckoutSessionInput): CheckoutSessionView {
  const settings = getGatewayProductSettings().checkout;
  const items = (input.lineItems ?? []).map((li) => {
    if (!li.name?.trim() || !Number.isInteger(li.quantity) || li.quantity <= 0 || !Number.isInteger(li.unitAmountMinor) || li.unitAmountMinor < 0) throw badRequest('Each line item needs a name, a positive quantity and a non-negative unit amount in minor units', 'invalid_line_item');
    return { name: li.name.trim().slice(0, 120), quantity: li.quantity, unitAmountMinor: li.unitAmountMinor };
  });
  const itemsTotal = items.reduce((s, li) => s + li.quantity * li.unitAmountMinor, 0);
  const amount = input.amountMinor ?? (items.length ? itemsTotal : null);
  if (amount == null) throw badRequest('Provide amount_minor or line_items', 'amount_required');
  if (items.length && input.amountMinor != null && input.amountMinor !== itemsTotal) throw badRequest(`Line items total ${itemsTotal} but amount_minor is ${input.amountMinor}`, 'amount_mismatch');
  const minutes = Math.min(settings.maxMinutes, Math.max(5, input.expiresInMinutes ?? settings.defaultMinutes));
  for (const u of [input.successUrl, input.cancelUrl]) if (u && !/^https?:\/\//.test(u)) throw badRequest('success_url and cancel_url must be absolute http(s) URLs', 'invalid_url');
  const db = getDb();
  if (input.idemKey) {
    const existing = db.prepare('SELECT cs.* FROM checkout_sessions cs JOIN payment_intents pi ON pi.id = cs.intent_id WHERE cs.merchant_user_id = ? AND pi.idem_key = ?').get(merchant.id, `cs:${input.idemKey}`) as any;
    if (existing) return sessionView(syncSession(existing));
  }
  const id = `cs_${shortCode(20).toLowerCase()}`;
  return db.transaction(() => {
    const { row } = createIntent(merchant, {
      amountMinor: amount,
      currency: input.currency,
      rails: input.rails,
      reference: input.reference ?? null,
      description: input.description ?? (items.length ? items.map((i) => `${i.quantity}× ${i.name}`).join(', ').slice(0, 200) : null),
      purposeCode: input.purposeCode ?? null,
      expiresInMinutes: minutes,
      metadata: { ...(input.metadata ?? {}), checkoutSessionId: id },
      customerMsisdn: input.customer?.phone ?? null,
      source: 'checkout',
      idemKey: input.idemKey ? `cs:${input.idemKey}` : null,
      successUrl: input.successUrl ?? null,
      cancelUrl: input.cancelUrl ?? null,
      allowedMethods: input.allowedMethods,
    });
    db.prepare('INSERT INTO checkout_sessions (id, intent_id, merchant_user_id, status, success_url, cancel_url, customer, line_items, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, row.id, merchant.id, 'open', input.successUrl ?? null, input.cancelUrl ?? null, input.customer ? JSON.stringify(input.customer) : null, JSON.stringify(items), row.expires_at ?? new Date(Date.now() + minutes * 60_000).toISOString(), now());
    recordEvent('payment', row.id, 'checkout_session.created', { type: 'merchant', id: merchant.id }, { sessionId: id, amount, currency: row.currency, lineItems: items.length });
    return sessionView(db.prepare('SELECT * FROM checkout_sessions WHERE id = ?').get(id));
  })();
}

const PAID_STATES = new Set(['CAPTURED', 'SETTLEMENT_PENDING', 'SETTLED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED']);
const DEAD_STATES = new Set(['EXPIRED', 'CANCELLED', 'FAILED', 'REVERSED']);

/** Bring an open session in line with its intent: paid → complete, expired/cancelled → expired. */
function syncSession(r: any): any {
  if (r.status !== 'open') return r;
  const db = getDb();
  const intent = getIntentRow(r.intent_id);
  if (PAID_STATES.has(intent.status)) {
    db.prepare("UPDATE checkout_sessions SET status = 'complete', completed_at = ? WHERE id = ? AND status = 'open'").run(intent.succeeded_at ?? now(), r.id);
    const fresh = db.prepare('SELECT * FROM checkout_sessions WHERE id = ?').get(r.id) as any;
    emitEvent(r.merchant_user_id, 'checkout.session.completed', { checkoutSession: sessionView(fresh) }, { resource: { type: 'checkout.session', id: r.id }, occurredAt: fresh.completed_at });
    return fresh;
  }
  if (DEAD_STATES.has(intent.status) || r.expires_at <= now()) {
    db.prepare("UPDATE checkout_sessions SET status = 'expired' WHERE id = ? AND status = 'open'").run(r.id);
    if (!DEAD_STATES.has(intent.status) && !PAID_STATES.has(intent.status)) {
      try {
        cancelIntent(intent.id, { type: 'system' }, 'checkout session expired');
      } catch {
        /* an attempt may still be in flight; the intent expiry job resolves it */
      }
    }
    const fresh = db.prepare('SELECT * FROM checkout_sessions WHERE id = ?').get(r.id) as any;
    emitEvent(r.merchant_user_id, 'checkout.session.expired', { checkoutSession: sessionView(fresh) }, { resource: { type: 'checkout.session', id: r.id } });
    return fresh;
  }
  return r;
}

export function getCheckoutSession(merchantUserId: string | null, id: string): CheckoutSessionView {
  const r = getDb().prepare('SELECT * FROM checkout_sessions WHERE id = ?').get(id) as any;
  if (!r || (merchantUserId && r.merchant_user_id !== merchantUserId)) throw notFound('Checkout session not found', 'checkout_session_not_found');
  return sessionView(syncSession(r));
}

export function listCheckoutSessions(merchantUserId: string, filter: { status?: string | null; limit?: number } = {}): CheckoutSessionView[] {
  const rows = getDb().prepare(`SELECT * FROM checkout_sessions WHERE merchant_user_id = ? ${filter.status ? 'AND status = ?' : ''} ORDER BY created_at DESC LIMIT ?`).all(...(filter.status ? [merchantUserId, filter.status] : [merchantUserId]), Math.min(200, filter.limit ?? 50)) as any[];
  return rows.map((r) => sessionView(syncSession(r)));
}

export function expireCheckoutSession(merchant: UserRow, id: string): CheckoutSessionView {
  const r = getDb().prepare('SELECT * FROM checkout_sessions WHERE id = ? AND merchant_user_id = ?').get(id, merchant.id) as any;
  if (!r) throw notFound('Checkout session not found', 'checkout_session_not_found');
  const synced = syncSession(r);
  if (synced.status !== 'open') throw conflict(`Checkout session is ${synced.status}`, 'checkout_session_closed');
  cancelIntent(r.intent_id, { type: 'merchant', id: merchant.id }, 'checkout session expired by merchant');
  return sessionView(syncSession(getDb().prepare('SELECT * FROM checkout_sessions WHERE id = ?').get(id)));
}

/** Scheduler: settle the status of every open session (paid or past expiry). */
export function syncCheckoutSessions(): { completed: number; expired: number } {
  const rows = getDb().prepare("SELECT * FROM checkout_sessions WHERE status = 'open'").all() as any[];
  let completed = 0;
  let expired = 0;
  for (const r of rows) {
    const s = syncSession(r);
    if (s.status === 'complete') completed += 1;
    else if (s.status === 'expired') expired += 1;
  }
  return { completed, expired };
}

/** Called by the intent state machine when an intent is captured (so the session completes without waiting for the job). */
export function completeCheckoutSessionForIntent(intentId: string): void {
  const r = getDb().prepare("SELECT * FROM checkout_sessions WHERE intent_id = ? AND status = 'open'").get(intentId) as any;
  if (r) syncSession(r);
}

// ---------------------------------------------------------------------------------------------------------------------
// Payment links
// ---------------------------------------------------------------------------------------------------------------------
export interface PaymentLinkView {
  id: string;
  object: 'payment_link';
  kind: 'single_use' | 'reusable';
  url: string;
  /** Deep link for apps and QR generation (`bitripay://pay/<intent>` for single-use links, the EMVCo payload for reusable codes). */
  uri: string;
  qrPayload: string | null;
  amount: { valueMinor: number | null; currency: string };
  title: string | null;
  description: string | null;
  purposeCode: string | null;
  status: string;
  uses: number;
  intentId: string | null;
  qrId: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface CreatePaymentLinkInput {
  amountMinor?: number | null;
  currency: string;
  title?: string | null;
  description?: string | null;
  reusable?: boolean;
  expiresInMinutes?: number | null;
  purposeCode?: string | null;
  successUrl?: string | null;
  cancelUrl?: string | null;
  metadata?: Record<string, unknown>;
  rails?: string[];
  idemKey?: string | null;
}

function linkFromIntent(v: IntentView): PaymentLinkView {
  return { id: v.id, object: 'payment_link', kind: 'single_use', url: v.checkoutUrl ?? `${config.webUrl}/pay/${v.paymentRequestCode}`, uri: v.uri, qrPayload: v.qrPayload, amount: v.amount, title: (v.metadata.title as string) ?? null, description: v.description, purposeCode: v.purposeCode, status: v.status, uses: PAID_STATES.has(v.status) ? 1 : 0, intentId: v.id, qrId: v.qrId, expiresAt: v.expiresAt, createdAt: v.createdAt };
}
function linkFromQr(q: QrView): PaymentLinkView {
  const uses = (getDb().prepare("SELECT COUNT(*) c FROM payment_intents WHERE qr_id = ? AND status IN ('CAPTURED','SETTLEMENT_PENDING','SETTLED','PARTIALLY_REFUNDED','REFUNDED')").get(q.id) as any).c as number;
  return { id: q.id, object: 'payment_link', kind: 'reusable', url: q.link, uri: q.uri, qrPayload: q.payload, amount: { valueMinor: q.amount, currency: q.currency }, title: q.reference, description: null, purposeCode: q.purposeCode, status: q.status, uses, intentId: null, qrId: q.id, expiresAt: q.expiresAt, createdAt: q.createdAt };
}

/**
 * A single-use link is an intent (source `link`, expires in 7 days by default) paid once through the hosted checkout.
 * A reusable link is a static BitriQR code (optionally with a fixed amount): every open creates a fresh intent, so
 * two customers paying the same link never collide and a paid intent can never be paid twice.
 */
export function createPaymentLink(merchant: UserRow, input: CreatePaymentLinkInput): PaymentLinkView {
  const settings = getGatewayProductSettings().links;
  if (input.reusable) {
    const qr = createStaticQr(merchant, { currency: input.currency, purposeCode: input.purposeCode ?? null, reference: input.title ?? input.description ?? null, kind: 'invoice', rails: input.rails, amount: input.amountMinor ?? null });
    return linkFromQr(qr);
  }
  if (!input.amountMinor) throw badRequest('Single-use links need an amount; set reusable=true for open-amount links', 'amount_required');
  const { row } = createIntent(merchant, {
    amountMinor: input.amountMinor,
    currency: input.currency,
    rails: input.rails,
    reference: input.title ?? null,
    description: input.description ?? input.title ?? null,
    purposeCode: input.purposeCode ?? null,
    expiresInMinutes: input.expiresInMinutes ?? settings.defaultDays * 24 * 60,
    metadata: { ...(input.metadata ?? {}), title: input.title ?? null, paymentLink: true },
    source: 'link',
    idemKey: input.idemKey ? `pl:${input.idemKey}` : null,
    successUrl: input.successUrl ?? null,
    cancelUrl: input.cancelUrl ?? null,
  });
  return linkFromIntent(intentView(row));
}

export function getPaymentLink(merchantUserId: string, id: string): PaymentLinkView {
  if (id.startsWith('qr_')) {
    const q = getQr(id);
    if (q.merchantId !== merchantUserId) throw notFound('Payment link not found', 'payment_link_not_found');
    return linkFromQr(q);
  }
  const r = getIntentRow(id);
  if (r.merchant_user_id !== merchantUserId || r.source !== 'link') throw notFound('Payment link not found', 'payment_link_not_found');
  return linkFromIntent(intentView(r));
}

export function listPaymentLinks(merchantUserId: string, limit = 50): PaymentLinkView[] {
  const intents = (getDb().prepare("SELECT * FROM payment_intents WHERE merchant_user_id = ? AND source = 'link' ORDER BY created_at DESC LIMIT ?").all(merchantUserId, limit) as IntentRow[]).map((r) => linkFromIntent(intentView(r)));
  const qrs = listQrs(merchantUserId, { mode: 'STATIC' })
    .filter((q) => q.kind === 'invoice')
    .map(linkFromQr);
  return [...intents, ...qrs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit);
}

export function deactivatePaymentLink(merchant: UserRow, id: string): PaymentLinkView {
  if (id.startsWith('qr_')) return linkFromQr(revokeQr(merchant, id, 'retired'));
  const r = getIntentRow(id);
  if (r.merchant_user_id !== merchant.id || r.source !== 'link') throw notFound('Payment link not found', 'payment_link_not_found');
  return linkFromIntent(intentView(cancelIntent(id, { type: 'merchant', id: merchant.id }, 'payment link deactivated')));
}

// ---------------------------------------------------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------------------------------------------------
export const REFUND_STATES = ['REQUESTED', 'PENDING', 'SUCCEEDED', 'FAILED', 'MANUAL', 'CANCELLED'] as const;
export type RefundState = (typeof REFUND_STATES)[number];
/** States that hold a reservation against the refundable amount (IDM/refund rule: unknown or pending never releases on timeout). */
const RESERVING_STATES: RefundState[] = ['REQUESTED', 'PENDING', 'SUCCEEDED', 'MANUAL'];

export interface RefundView {
  id: string;
  object: 'refund';
  intentId: string | null;
  transactionId: string;
  amount: { valueMinor: number; currency: string };
  reason: string | null;
  status: RefundState;
  method: 'wallet' | 'processor';
  refundTransactionId: string | null;
  providerRef: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
const toRefund = (r: any): RefundView => ({ id: r.id, object: 'refund', intentId: r.intent_id, transactionId: r.transaction_id, amount: { valueMinor: r.amount, currency: r.currency }, reason: r.reason, status: r.status, method: r.method, refundTransactionId: r.refund_transaction_id, providerRef: r.provider_ref, error: r.error, metadata: parseJson(r.metadata, {}), createdAt: r.created_at, updatedAt: r.updated_at });

/** Amount still refundable on a transaction: principal minus everything reserved, pending or already refunded. */
export function refundableAmount(transactionId: string): { principal: number; reserved: number; refundable: number } {
  const tx = getTransaction(transactionId);
  if (!tx) throw notFound('Transaction not found', 'transaction_not_found');
  const reserved = (getDb().prepare(`SELECT COALESCE(SUM(amount), 0) s FROM refunds WHERE transaction_id = ? AND status IN (${RESERVING_STATES.map(() => '?').join(',')})`).get(transactionId, ...RESERVING_STATES) as any).s as number;
  return { principal: tx.amount, reserved, refundable: Math.max(0, tx.amount - reserved) };
}

export interface CreateRefundInput {
  intentId?: string | null;
  transactionId?: string | null;
  amountMinor?: number | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  idemKey?: string | null;
}

/**
 * Create and execute a refund. The reservation (row insert + refundable check) happens inside one database
 * transaction so two concurrent refunds can never exceed the principal; the processor call, when needed, runs after
 * the reservation and its outcome moves the row to SUCCEEDED / PENDING / MANUAL / FAILED.
 */
export async function createRefund(merchant: UserRow, input: CreateRefundInput, actor: Actor): Promise<RefundView> {
  assertMoneyMovementAllowed('refund');
  const db = getDb();
  if (input.idemKey) {
    const existing = db.prepare('SELECT * FROM refunds WHERE merchant_user_id = ? AND idem_key = ?').get(merchant.id, input.idemKey) as any;
    if (existing) return toRefund(existing);
  }
  let intent: IntentRow | null = null;
  let tx: TransactionRow | undefined;
  if (input.intentId) {
    intent = getIntentRow(input.intentId);
    if (intent.merchant_user_id !== merchant.id) throw notFound('Payment intent not found', 'intent_not_found');
    if (!intent.transaction_id) throw conflict(`Payment intent is ${intent.status}; only captured payments can be refunded`, 'not_refundable');
    tx = getTransaction(intent.transaction_id);
  } else if (input.transactionId) {
    tx = getTransaction(input.transactionId);
    if (tx?.intent_id) intent = getIntentRow(tx.intent_id);
  } else throw badRequest('Provide payment_intent or transaction', 'target_required');
  if (!tx || tx.receiver_user_id !== merchant.id) throw notFound('Payment not found', 'payment_not_found');
  if (!['completed', 'reversed'].includes(tx.status)) throw conflict(`Payment is ${tx.status}`, 'not_refundable');
  if (!['merchant_payment', 'qr_payment', 'transfer', 'money_request'].includes(tx.type)) throw conflict(`${tx.type} transactions cannot be refunded through the gateway`, 'not_refundable');
  const cur = getCurrency(tx.currency, false);
  const meta = parseJson<Record<string, any>>(tx.metadata, {});
  const gatewayPaymentId: string | null = intent?.gateway_payment_id ?? meta.paymentId ?? null;
  const method: 'wallet' | 'processor' = tx.sender_wallet_id ? 'wallet' : 'processor';
  const id = `re_${shortCode(20).toLowerCase()}`;

  // 1. Reserve atomically.
  const reserved = db.transaction(() => {
    const { refundable } = refundableAmount(tx!.id);
    const amount = input.amountMinor ?? refundable;
    if (!Number.isInteger(amount) || amount <= 0) throw badRequest('Refund amount must be a positive integer in minor units', 'invalid_amount');
    if (amount > refundable) throw conflict(`Only ${formatMoney(refundable, cur)} of this payment can still be refunded`, 'refund_exceeds_refundable');
    db.prepare('INSERT INTO refunds (id, intent_id, transaction_id, merchant_user_id, amount, currency, reason, status, method, requested_by, idem_key, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, intent?.id ?? null, tx!.id, merchant.id, amount, cur.code, input.reason ?? null, 'REQUESTED', method, actor.id ?? null, input.idemKey ?? null, JSON.stringify({ ...(input.metadata ?? {}), gatewayPaymentId }), now(), now());
    return amount;
  })();
  emitEvent(merchant.id, 'refund.created', { refund: toRefund(db.prepare('SELECT * FROM refunds WHERE id = ?').get(id)) }, { resource: { type: 'refund', id } });
  recordEvent('payment', intent?.id ?? tx.id, 'refund.requested', actor, { refundId: id, amount: reserved, method });

  // 2. Execute.
  const fail = (error: string) => {
    db.prepare("UPDATE refunds SET status = 'FAILED', error = ?, updated_at = ? WHERE id = ?").run(error, now(), id);
    const view = toRefund(db.prepare('SELECT * FROM refunds WHERE id = ?').get(id));
    emitEvent(merchant.id, 'refund.failed', { refund: view }, { resource: { type: 'refund', id } });
    emitEvent(merchant.id, 'refund.updated', { refund: view }, { resource: { type: 'refund', id } });
    recordEvent('payment', intent?.id ?? tx!.id, 'refund.failed', actor, { refundId: id, error });
    return view;
  };
  let providerRef: string | null = null;
  if (method === 'processor') {
    if (!gatewayPaymentId) return fail('The original processor payment could not be located');
    const gp = getPayment(gatewayPaymentId);
    let result;
    try {
      result = await providerRefund(gp, reserved, input.reason ?? 'merchant refund', actor);
    } catch (err) {
      return fail((err as Error).message);
    }
    providerRef = result.providerRef ?? null;
    if (result.status === 'manual' || result.status === 'pending') {
      const st = result.status === 'manual' ? 'MANUAL' : 'PENDING';
      db.prepare('UPDATE refunds SET status = ?, provider_ref = ?, error = ?, updated_at = ? WHERE id = ?').run(st, providerRef, result.message ?? null, now(), id);
      const view = toRefund(db.prepare('SELECT * FROM refunds WHERE id = ?').get(id));
      emitEvent(merchant.id, 'refund.updated', { refund: view }, { resource: { type: 'refund', id } });
      if (st === 'MANUAL') notify(merchant.id, 'Refund needs manual execution', `${formatMoney(reserved, cur)} must be returned to the payer manually (${result.message ?? 'no refund API'}). Operations will confirm it.`, { kind: 'refund', refundId: id });
      return view;
    }
  }
  // 3. Post the balanced ledger entries: merchant wallet → payer wallet (wallet-paid) or → treasury (money left via the processor).
  try {
    const merchantWallet = ensureWallet(merchant.id, cur.code);
    const refundTx = db.transaction(() => {
      const posted = postTransaction({
        type: 'refund',
        amount: reserved,
        currency: cur.code,
        fromWalletId: merchantWallet.id,
        toWalletId: method === 'wallet' ? tx!.sender_wallet_id : null,
        senderUserId: merchant.id,
        receiverUserId: method === 'wallet' ? tx!.sender_user_id : null,
        note: `Refund of ${tx!.reference}${input.reason ? `: ${input.reason}` : ''}`,
        metadata: { refundOf: tx!.id, refundOfReference: tx!.reference, refundId: id, method, providerRef, gatewayPaymentId, reason: input.reason ?? null },
        idempotencyKey: `refund:${id}`,
      });
      db.prepare("UPDATE refunds SET status = 'SUCCEEDED', refund_transaction_id = ?, provider_ref = ?, updated_at = ? WHERE id = ?").run(posted.id, providerRef, now(), id);
      const total = (db.prepare("SELECT COALESCE(SUM(amount), 0) s FROM refunds WHERE transaction_id = ? AND status = 'SUCCEEDED'").get(tx!.id) as any).s as number;
      if (total >= tx!.amount) db.prepare("UPDATE transactions SET status = 'reversed', metadata = ? WHERE id = ?").run(JSON.stringify({ ...meta, refundTransactionId: posted.id, refundedMinor: total }), tx!.id);
      else db.prepare('UPDATE transactions SET metadata = ? WHERE id = ?').run(JSON.stringify({ ...meta, refundedMinor: total }), tx!.id);
      if (intent) {
        const target = total >= tx!.amount ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
        if (intent.status !== target && intent.status !== 'REFUNDED') {
          try {
            transitionIntent(intent.id, target, actor, { refundId: id, amount: reserved, total });
          } catch {
            /* intents in review/dispute keep their state; the refund object is the record */
          }
        }
        appendPaymentEvent({ intentId: intent.id, state: target, source: method === 'wallet' ? 'ledger' : 'processor', direction: 'out', amountMinor: reserved, currency: cur.code, transactionId: posted.id, payload: { refundId: id, providerRef } });
      }
      return posted;
    })();
    if (tx.sender_user_id && method === 'wallet') notify(tx.sender_user_id, 'Refund received', `${formatMoney(reserved, cur)} was refunded by ${merchant.business_name ?? merchant.full_name}.`, { kind: 'refund', transactionId: refundTx.id });
    const view = toRefund(db.prepare('SELECT * FROM refunds WHERE id = ?').get(id));
    emitEvent(merchant.id, 'refund.succeeded', { refund: view }, { resource: { type: 'refund', id } });
    emitEvent(merchant.id, 'refund.updated', { refund: view }, { resource: { type: 'refund', id } });
    recordEvent('payment', intent?.id ?? tx.id, 'refund.succeeded', actor, { refundId: id, transactionId: refundTx.id });
    return view;
  } catch (err) {
    return fail((err as Error).message);
  }
}

/** Operations resolve MANUAL / PENDING refunds once the processor confirms (or refuses) the return of funds. */
export async function resolveRefund(id: string, outcome: 'succeeded' | 'failed', admin: UserRow, note?: string | null): Promise<RefundView> {
  const db = getDb();
  const r = db.prepare('SELECT * FROM refunds WHERE id = ?').get(id) as any;
  if (!r) throw notFound('Refund not found', 'refund_not_found');
  if (!['MANUAL', 'PENDING'].includes(r.status)) throw conflict(`Refund is ${r.status}`, 'refund_closed');
  const merchant = findUserById(r.merchant_user_id)!;
  const actor: Actor = { type: 'admin', id: admin.id };
  if (outcome === 'failed') {
    db.prepare("UPDATE refunds SET status = 'FAILED', error = ?, approved_by = ?, updated_at = ? WHERE id = ?").run(note ?? 'refused by operations', admin.id, now(), id);
    const view = toRefund(db.prepare('SELECT * FROM refunds WHERE id = ?').get(id));
    emitEvent(merchant.id, 'refund.failed', { refund: view }, { resource: { type: 'refund', id } });
    emitEvent(merchant.id, 'refund.updated', { refund: view }, { resource: { type: 'refund', id } });
    return view;
  }
  // succeeded: post the ledger entries exactly as the automatic path does
  const tx = getTransaction(r.transaction_id)!;
  const cur = getCurrency(tx.currency, false);
  const meta = parseJson<Record<string, any>>(tx.metadata, {});
  const merchantWallet = ensureWallet(merchant.id, cur.code);
  db.transaction(() => {
    const posted = postTransaction({ type: 'refund', amount: r.amount, currency: cur.code, fromWalletId: merchantWallet.id, toWalletId: null, senderUserId: merchant.id, receiverUserId: null, note: `Refund of ${tx.reference} (confirmed by operations)`, metadata: { refundOf: tx.id, refundOfReference: tx.reference, refundId: id, method: 'processor', providerRef: r.provider_ref, note: note ?? null }, idempotencyKey: `refund:${id}` });
    db.prepare("UPDATE refunds SET status = 'SUCCEEDED', refund_transaction_id = ?, approved_by = ?, updated_at = ? WHERE id = ?").run(posted.id, admin.id, now(), id);
    const total = (db.prepare("SELECT COALESCE(SUM(amount), 0) s FROM refunds WHERE transaction_id = ? AND status = 'SUCCEEDED'").get(tx.id) as any).s as number;
    db.prepare('UPDATE transactions SET status = ?, metadata = ? WHERE id = ?').run(total >= tx.amount ? 'reversed' : tx.status, JSON.stringify({ ...meta, refundedMinor: total }), tx.id);
    if (r.intent_id) {
      const intent = getIntentRow(r.intent_id);
      const target = total >= tx.amount ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      if (intent.status !== target && intent.status !== 'REFUNDED') {
        try {
          transitionIntent(intent.id, target, actor, { refundId: id, amount: r.amount, total });
        } catch {
          /* keep review/dispute states */
        }
      }
      appendPaymentEvent({ intentId: intent.id, state: target, source: 'manual', direction: 'out', amountMinor: r.amount, currency: cur.code, transactionId: posted.id, payload: { refundId: id, adminId: admin.id } });
    }
  })();
  const view = toRefund(db.prepare('SELECT * FROM refunds WHERE id = ?').get(id));
  emitEvent(merchant.id, 'refund.succeeded', { refund: view }, { resource: { type: 'refund', id } });
  emitEvent(merchant.id, 'refund.updated', { refund: view }, { resource: { type: 'refund', id } });
  return view;
}

export function getRefund(merchantUserId: string | null, id: string): RefundView {
  const r = getDb().prepare('SELECT * FROM refunds WHERE id = ?').get(id) as any;
  if (!r || (merchantUserId && r.merchant_user_id !== merchantUserId)) throw notFound('Refund not found', 'refund_not_found');
  return toRefund(r);
}

export function listRefunds(filter: { merchantUserId?: string | null; intentId?: string | null; transactionId?: string | null; status?: string | null; limit?: number } = {}): RefundView[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.merchantUserId) {
    where.push('merchant_user_id = ?');
    params.push(filter.merchantUserId);
  }
  if (filter.intentId) {
    where.push('intent_id = ?');
    params.push(filter.intentId);
  }
  if (filter.transactionId) {
    where.push('transaction_id = ?');
    params.push(filter.transactionId);
  }
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  return (getDb().prepare(`SELECT * FROM refunds ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`).all(...params, Math.min(200, filter.limit ?? 50)) as any[]).map(toRefund);
}

// ---------------------------------------------------------------------------------------------------------------------
// Scan-to-Verify (KODA)
// ---------------------------------------------------------------------------------------------------------------------
export type VerificationStatus = 'VERIFIED' | 'PENDING' | 'NOT_FOUND' | 'AMBIGUOUS' | 'MISMATCH';
export interface VerificationView {
  id: string;
  object: 'verification';
  rail: string;
  reference: string | null;
  msisdn: string | null;
  amount: { valueMinor: number | null; currency: string | null };
  window: { from: string | null; to: string | null };
  status: VerificationStatus;
  confidence: number;
  reasons: string[];
  match: { paymentId: string | null; intentId: string | null; evidenceId: string | null; transactionId: string | null; settledAt: string | null; amount: number | null; currency: string | null; stage: string | null } | null;
  charged: boolean;
  createdAt: string;
}
const toVerification = (r: any): VerificationView => ({ id: r.id, object: 'verification', rail: r.rail, reference: r.reference, msisdn: r.msisdn, amount: { valueMinor: r.amount, currency: r.currency }, window: { from: r.window_from, to: r.window_to }, status: r.status, confidence: r.confidence, reasons: parseJson<string[]>(r.reasons, []), match: r.payment_id || r.intent_id || r.evidence_id ? parseJson(r.match ?? 'null', null) : null, charged: !!r.charged, createdAt: r.created_at });

function normaliseMsisdn(v: string | null | undefined): string | null {
  const d = (v ?? '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-9) : null; // compare on the national significant part
}

export interface CreateVerificationInput {
  rail: string;
  reference?: string | null;
  msisdn?: string | null;
  amountMinor?: number | null;
  currency?: string | null;
  windowHours?: number | null;
}

/**
 * Answer "did this payment reach me?" from evidence the platform already holds: settled gateway payments, verified
 * evidence (SMS/API confirmations) and ledger postings for this merchant. Reference matches are conclusive;
 * MSISDN + amount + time-window matches are strong; anything else is NOT_FOUND. Results never mark a payment paid.
 */
export function createVerification(merchant: UserRow, input: CreateVerificationInput): VerificationView {
  const settings = getGatewayProductSettings().koda;
  const db = getDb();
  const reference = input.reference?.trim() || null;
  const msisdn = normaliseMsisdn(input.msisdn);
  if (!reference && !(msisdn && input.amountMinor)) throw badRequest('Provide a reference, or an MSISDN with an amount', 'criteria_required');
  const hours = Math.min(30 * 24, Math.max(1, input.windowHours ?? settings.windowHours));
  const to = now();
  const from = new Date(Date.now() - hours * 3600_000).toISOString();
  const cur = input.currency ? getCurrency(input.currency).code : null;

  // metering: free lookups per month, then a per-lookup price from the merchant wallet
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
  const used = (db.prepare('SELECT COUNT(*) c FROM verifications WHERE merchant_user_id = ? AND created_at >= ?').get(merchant.id, monthStart) as any).c as number;
  let chargeTx: TransactionRow | null = null;
  if (used >= settings.freePerMonth && settings.priceMinor > 0) {
    const wallet = ensureWallet(merchant.id, settings.priceCurrency);
    if (wallet.balance < settings.priceMinor) throw paymentRequired(`Your ${settings.freePerMonth} free verifications this month are used. Each further lookup costs ${formatMoney(settings.priceMinor, getCurrency(settings.priceCurrency, false))}; top up your ${settings.priceCurrency} balance to continue.`, 'verification_quota_exhausted');
    chargeTx = postTransaction({ type: 'verification', amount: settings.priceMinor, currency: settings.priceCurrency, fromWalletId: wallet.id, toWalletId: null, senderUserId: merchant.id, note: 'Scan-to-Verify lookup', metadata: { product: 'koda' } });
  }

  // candidates: gateway payments on this merchant's requests
  const candidates = db
    .prepare(
      `SELECT gp.id payment_id, gp.stage, gp.amount, gp.currency, gp.provider_ref, gp.payer_phone, gp.transaction_id, gp.updated_at, gp.created_at, pr.intent_id
       FROM gateway_payments gp JOIN payment_requests pr ON pr.id = gp.payment_request_id
       WHERE pr.requester_user_id = ? AND gp.created_at >= ?`,
    )
    .all(merchant.id, from) as any[];
  const evidence = db
    .prepare(
      `SELECT e.id evidence_id, e.payment_id, e.parsed, e.outcome, e.external_ref, e.created_at, gp.stage, gp.amount, gp.currency, gp.transaction_id, gp.updated_at, pr.intent_id
       FROM payment_evidence e JOIN gateway_payments gp ON gp.id = e.payment_id JOIN payment_requests pr ON pr.id = gp.payment_request_id
       WHERE pr.requester_user_id = ? AND e.created_at >= ?`,
    )
    .all(merchant.id, from) as any[];
  const ledger = reference ? (db.prepare("SELECT * FROM transactions WHERE receiver_user_id = ? AND (reference = ? OR json_extract(metadata, '$.providerRef') = ? OR json_extract(metadata, '$.reference') = ?) AND created_at >= ?").all(merchant.id, reference, reference, reference, from) as TransactionRow[]) : [];

  type Hit = { paymentId: string | null; intentId: string | null; evidenceId: string | null; transactionId: string | null; stage: string | null; amount: number; currency: string; at: string; score: number; why: string };
  const hits: Hit[] = [];
  const refEq = (a: string | null | undefined) => !!reference && !!a && a.replace(/\s+/g, '').toLowerCase() === reference.replace(/\s+/g, '').toLowerCase();
  for (const c of candidates) {
    let score = 0;
    const why: string[] = [];
    if (refEq(c.provider_ref)) {
      score += 70;
      why.push('reference');
    }
    if (msisdn && normaliseMsisdn(c.payer_phone) === msisdn) {
      score += 25;
      why.push('msisdn');
    }
    if (input.amountMinor && c.amount === input.amountMinor && (!cur || cur === c.currency)) {
      score += 25;
      why.push('amount');
    }
    if (score >= 50) hits.push({ paymentId: c.payment_id, intentId: c.intent_id, evidenceId: null, transactionId: c.transaction_id, stage: c.stage, amount: c.amount, currency: c.currency, at: c.updated_at, score, why: why.join('+') });
  }
  for (const e of evidence) {
    const parsed = parseJson<Partial<import('./evidence').ParsedEvidence>>(e.parsed, {});
    let score = 0;
    const why: string[] = [];
    if (refEq(parsed.reference) || refEq(parsed.externalRef) || refEq(e.external_ref)) {
      score += 70;
      why.push('evidence_reference');
    }
    if (msisdn && normaliseMsisdn(parsed.senderPhone) === msisdn) {
      score += 25;
      why.push('evidence_msisdn');
    }
    if (input.amountMinor && e.amount === input.amountMinor && (!cur || cur === e.currency)) {
      score += 25;
      why.push('amount');
    }
    if (score >= 50) hits.push({ paymentId: e.payment_id, intentId: e.intent_id, evidenceId: e.evidence_id, transactionId: e.transaction_id, stage: e.stage, amount: e.amount, currency: e.currency, at: e.updated_at, score, why: why.join('+') });
  }
  for (const t of ledger) hits.push({ paymentId: null, intentId: t.intent_id ?? null, evidenceId: null, transactionId: t.id, stage: t.status === 'completed' ? 'SETTLED' : t.status.toUpperCase(), amount: t.amount, currency: t.currency, at: t.completed_at ?? t.created_at, score: 80, why: 'ledger_reference' });

  // one hit per underlying payment, best score first
  const byKey = new Map<string, Hit>();
  for (const h of hits.sort((a, b) => b.score - a.score)) {
    const key = h.paymentId ?? h.transactionId ?? h.evidenceId ?? uuid();
    if (!byKey.has(key)) byKey.set(key, h);
  }
  const distinct = [...byKey.values()];
  let status: VerificationStatus;
  let confidence = 0;
  const reasons: string[] = [];
  let match: Hit | null = null;
  if (!distinct.length) {
    status = 'NOT_FOUND';
    reasons.push('no_payment_matches_the_criteria_in_window');
  } else if (distinct.length > 1 && distinct[0].score === distinct[1].score) {
    status = 'AMBIGUOUS';
    confidence = Math.min(60, distinct[0].score);
    reasons.push(`${distinct.length}_candidates_match_equally`);
  } else {
    match = distinct[0];
    if (input.amountMinor && match.amount !== input.amountMinor) {
      status = 'MISMATCH';
      confidence = 40;
      reasons.push(`amount_differs:${match.amount}`);
    } else if (match.stage === 'SETTLED' || (match.transactionId && match.stage === 'SETTLED')) {
      status = 'VERIFIED';
      confidence = Math.min(100, match.score);
      reasons.push(`matched_on:${match.why}`, 'settled');
    } else if (['REJECTED', 'EXPIRED', 'REVERSED', 'FAILED', 'CANCELLED'].includes(match.stage ?? '')) {
      status = 'NOT_FOUND';
      confidence = match.score;
      reasons.push(`matched_on:${match.why}`, `payment_${(match.stage ?? '').toLowerCase()}`);
      match = null;
    } else {
      status = 'PENDING';
      confidence = Math.min(90, match.score);
      reasons.push(`matched_on:${match.why}`, `stage:${match.stage}`);
    }
  }
  const id = `vf_${shortCode(20).toLowerCase()}`;
  const matchJson = match ? JSON.stringify({ paymentId: match.paymentId, intentId: match.intentId, evidenceId: match.evidenceId, transactionId: match.transactionId, settledAt: status === 'VERIFIED' ? match.at : null, amount: match.amount, currency: match.currency, stage: match.stage }) : null;
  db.prepare('INSERT INTO verifications (id, merchant_user_id, rail, reference, msisdn, amount, currency, window_from, window_to, status, confidence, evidence_id, payment_id, intent_id, reasons, charged, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, merchant.id, input.rail, reference, msisdn, input.amountMinor ?? null, cur, from, to, status, confidence, match?.evidenceId ?? null, match?.paymentId ?? null, match?.intentId ?? null, JSON.stringify(reasons), chargeTx ? 1 : 0, now());
  if (matchJson) db.prepare('UPDATE verifications SET match = ? WHERE id = ?').run(matchJson, id);
  if (match?.intentId && status === 'VERIFIED') appendPaymentEvent({ intentId: match.intentId, state: 'EXTERNAL_VERIFIED', source: 'koda', direction: 'internal', amountMinor: match.amount, currency: match.currency, transactionId: match.transactionId, payload: { verificationId: id, confidence } });
  const view = toVerification(db.prepare('SELECT * FROM verifications WHERE id = ?').get(id));
  emitEvent(merchant.id, 'verification.completed', { verification: view }, { resource: { type: 'verification', id } });
  return view;
}

export function getVerification(merchantUserId: string, id: string): VerificationView {
  const r = getDb().prepare('SELECT * FROM verifications WHERE id = ? AND merchant_user_id = ?').get(id, merchantUserId) as any;
  if (!r) throw notFound('Verification not found', 'verification_not_found');
  return toVerification(r);
}

export function listVerifications(merchantUserId: string, limit = 50): VerificationView[] {
  return (getDb().prepare('SELECT * FROM verifications WHERE merchant_user_id = ? ORDER BY created_at DESC LIMIT ?').all(merchantUserId, Math.min(200, limit)) as any[]).map(toVerification);
}

export function verificationQuota(merchantUserId: string) {
  const settings = getGatewayProductSettings().koda;
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
  const used = (getDb().prepare('SELECT COUNT(*) c FROM verifications WHERE merchant_user_id = ? AND created_at >= ?').get(merchantUserId, monthStart) as any).c as number;
  return { used, freePerMonth: settings.freePerMonth, remainingFree: Math.max(0, settings.freePerMonth - used), price: { valueMinor: settings.priceMinor, currency: settings.priceCurrency }, windowHours: settings.windowHours };
}

// ---------------------------------------------------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------------------------------------------------
export interface CreatePayoutInput {
  amountMinor: number;
  currency: string;
  destination: WithdrawalDestination;
  description?: string | null;
  idemKey?: string | null;
}

export function payoutView(tx: TransactionRow, viewerId: string) {
  const meta = parseJson<Record<string, any>>(tx.metadata, {});
  const payout = getPayoutByTransaction(tx.id);
  return { id: tx.id, object: 'payout', reference: tx.reference, status: tx.status, stage: payout?.stage ?? null, amount: { valueMinor: tx.amount, currency: tx.currency }, fee: tx.fee, destination: meta.method === 'mobile_money' ? { method: 'mobile_money', operator: meta.operator ?? null, phone: meta.phone ?? null, name: meta.recipientName ?? null } : { method: 'bank', bankAccount: meta.bankAccount ?? null }, description: tx.note, transaction: toTransaction(tx, viewerId), createdAt: tx.created_at, completedAt: tx.completed_at };
}

export function createPayout(merchant: UserRow, input: CreatePayoutInput) {
  assertMoneyMovementAllowed('payout');
  const db = getDb();
  if (input.idemKey) {
    const existing = db.prepare("SELECT * FROM transactions WHERE sender_user_id = ? AND type = 'withdrawal' AND idempotency_key = ?").get(merchant.id, `payout:${input.idemKey}`) as TransactionRow | undefined;
    if (existing) return payoutView(existing, merchant.id);
  }
  const tx = requestWithdrawal(merchant, { amount: input.amountMinor, currency: input.currency, destination: input.destination, note: input.description ?? null });
  if (input.idemKey) db.prepare('UPDATE transactions SET idempotency_key = ? WHERE id = ?').run(`payout:${input.idemKey}`, tx.id);
  const view = payoutView(tx, merchant.id);
  emitEvent(merchant.id, 'payout.created', { payout: view }, { resource: { type: 'payout', id: tx.id } });
  return view;
}

// payout.completed / payout.failed follow the withdrawal's ledger outcome (admin approval, agent payout, rejection)
transactionStatusHooks.push((tx, outcome) => {
  if (tx.type !== 'withdrawal' || !tx.sender_user_id) return;
  const user = findUserById(tx.sender_user_id);
  if (!user || user.role !== 'merchant') return;
  emitEvent(tx.sender_user_id, outcome === 'completed' ? 'payout.completed' : 'payout.failed', { payout: payoutView(tx, tx.sender_user_id) }, { resource: { type: 'payout', id: tx.id }, occurredAt: tx.completed_at ?? null });
});

export function getPayout(merchantUserId: string, id: string) {
  const tx = getTransaction(id);
  if (!tx || tx.type !== 'withdrawal' || tx.sender_user_id !== merchantUserId) throw notFound('Payout not found', 'payout_not_found');
  return payoutView(tx, merchantUserId);
}

export function listPayouts(merchantUserId: string, limit = 50) {
  return (getDb().prepare("SELECT * FROM transactions WHERE sender_user_id = ? AND type = 'withdrawal' ORDER BY created_at DESC LIMIT ?").all(merchantUserId, Math.min(200, limit)) as TransactionRow[]).map((t) => payoutView(t, merchantUserId));
}

// ---------------------------------------------------------------------------------------------------------------------
// Sandbox simulation
// ---------------------------------------------------------------------------------------------------------------------
export const SIMULATION_OUTCOMES = ['succeed', 'fail', 'ambiguous', 'timeout_then_succeed', 'provider_unavailable'] as const;
export type SimulationOutcome = (typeof SIMULATION_OUTCOMES)[number];
const MAGIC: Record<SimulationOutcome, string> = { succeed: '+243000000501', fail: '+243000000404', ambiguous: '+243000000408', timeout_then_succeed: '+243000000500', provider_unavailable: '+243000000503' };

/**
 * Drive an intent through the real pipeline with the sandbox processor and a magic MSISDN: an attempt is started,
 * the sandbox answers exactly as a live operator would for that number, and the outcome flows back through
 * verification, settlement and webhooks. Never available with a live key in production.
 */
export async function simulateOutcome(merchant: UserRow, intentId: string, outcome: SimulationOutcome, keyMode: 'live' | 'test' | null) {
  if (!getGatewayProductSettings().sandboxSimulation) throw forbidden('Sandbox simulation is disabled', 'simulation_disabled');
  if (config.isProduction && keyMode !== 'test') throw forbidden('Simulation requires a test-mode API key', 'test_key_required');
  const intent = getIntentRow(intentId);
  if (intent.merchant_user_id !== merchant.id) throw notFound('Payment intent not found', 'intent_not_found');
  if (!intent.payment_request_id) throw conflict('Intent has no checkout request', 'not_simulatable');
  const request = getDb().prepare('SELECT code FROM payment_requests WHERE id = ?').get(intent.payment_request_id) as { code: string };
  const phone = MAGIC[outcome];
  const payment = await initiatePayment(null, { purpose: 'checkout', paymentRequestCode: request.code, method: 'mobile_money', gateway: 'sandbox', phone, amount: intent.amount_minor ?? undefined, currency: intent.currency, name: 'Sandbox payer', email: 'sandbox@bitripay.test' } as any);
  if (outcome === 'succeed') getDb().prepare("UPDATE gateway_payments SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 4000).toISOString(), payment.id); // the sandbox approves after ~3s
  const verified = await verifyPayment(payment.id);
  return { simulation: true, outcome, msisdn: phone, payment: verified, paymentIntent: intentView(getIntentRow(intentId)), attempts: listAttempts(intentId) };
}

export function sandboxCatalogue() {
  return {
    simulation: true,
    magicMsisdns: MAGIC,
    outcomes: SIMULATION_OUTCOMES,
    cards: { success: 'any Luhn-valid number', declined: 'last four 0002', insufficientFunds: 'last four 9995', expired: 'last four 0069', incorrectCvc: 'last four 0127' },
    note: 'Sandbox rails settle to your test balance through the same ledger, state machine and webhooks as live rails.',
  };
}
