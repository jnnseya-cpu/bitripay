/**
 * Payer-institution simulator for the demonstration (scene 3). It plays the customer's bank or mobile-money app that
 * scans the merchant's QR code and the institution that authorises the debit and sends the payment through the
 * national switch. Only a connection in simulation may be driven this way; on a certified connection the payer's
 * institution speaks to the switch itself and BitriPay only observes.
 *
 * Every step is the real production path: the QR is resolved like a scan, the institution's consent is recorded,
 * the payment is created as the merchant's order, the outbox is dispatched under the lease and the intent settles
 * through the mirror. Nothing is credited on any BitriPay ledger.
 */
import { forbidden, notFound, unprocessable } from '../../lib/errors';
import { findUserById, type UserRow } from '../users';
import { createIntent, getIntentRow, intentView, listIntents } from '../intents';
import { getDb } from '../../db';
import { MERCHANT_ROLES } from '../users';
import { resolveScan, intentFromStaticQr } from '../qrcodes';
import { connectionForCountry, getConnection } from './connections';
import { simulatorFor } from './adapter';
import { now } from '../../lib/ids';
import { feeEntryForPayment } from './fees';
import { listPairs, listParticipants } from './participants';
import { SIMULATOR_SCENARIOS } from './adapter';
import { createLinkedRefund, createPayment, dispatchOutbox, getPayment, getPaymentRow, ingestInbound, listBindings, listLinkedOperations, paymentTimeline, recordConsent } from './payments';

const OPEN_INTENT_STATES = new Set(['CREATED', 'REQUIRES_PAYMENT_METHOD', 'ROUTING', 'REQUIRES_CUSTOMER_ACTION']);

const merchantOf = (id: string) => {
  const m = findUserById(id) as any;
  return m ? { id: m.id, name: m.full_name, businessName: m.business_name ?? null } : null;
};

/**
 * What a simulated payer could pay, newest first, with the acceptor named: open QR / API intents, and point-of-sale
 * sales (payment requests of a merchant-class account that carry an amount and have no intent yet).
 */
export function payableIntents(limit = 50) {
  const intents = listIntents({ limit: 300 })
    .filter((i) => OPEN_INTENT_STATES.has(i.status) && (i.amount.valueMinor ?? 0) > 0)
    .map((i) => ({
      kind: 'intent' as const,
      id: i.id,
      merchantId: i.merchantId,
      amount: i.amount,
      reference: i.reference,
      description: i.description,
      status: i.status,
      createdAt: i.createdAt,
      merchant: merchantOf(i.merchantId),
    }));
  const sales = (
    getDb()
      .prepare(
        `SELECT r.* FROM payment_requests r JOIN users u ON u.id = r.requester_user_id WHERE r.status = 'open' AND r.intent_id IS NULL AND r.amount > 0 AND r.kind IN ('qr', 'request', 'link') AND u.role IN (${MERCHANT_ROLES.map(() => '?').join(', ')}) ORDER BY r.created_at DESC LIMIT 300`,
      )
      .all(...MERCHANT_ROLES) as any[]
  ).map((r) => ({
    kind: 'request' as const,
    id: r.id,
    merchantId: r.requester_user_id,
    amount: { valueMinor: r.amount as number, currency: r.currency as string },
    reference: r.code as string,
    description: r.description as string | null,
    status: 'open',
    createdAt: r.created_at as string,
    merchant: merchantOf(r.requester_user_id),
  }));
  return [...intents, ...sales].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit);
}

/** The intent of a point-of-sale sale: bound on first use (same amount and currency, source "pos"). */
export function intentForSale(paymentRequestId: string) {
  const r = getDb().prepare('SELECT * FROM payment_requests WHERE id = ?').get(paymentRequestId) as any;
  if (!r) throw notFound('Payment request not found', 'not_found');
  if (r.intent_id) return getIntentRow(r.intent_id);
  const merchant = findUserById(r.requester_user_id);
  if (!merchant) throw notFound('Merchant not found', 'merchant_not_found');
  return createIntent(merchant, { amountMinor: r.amount, currency: r.currency, reference: r.code, description: r.description ?? null, source: 'pos', paymentRequestId: r.id, idemKey: `pos-${r.id}` })
    .row;
}

/** Payer institutions that can reach the merchant's active settlement account for this intent, and the simulator's account tokens. */
export function payerOptions(intentId: string) {
  const intent = getIntentRow(intentId);
  const merchant = findUserById(intent.merchant_user_id);
  if (!merchant) throw notFound('Merchant not found', 'merchant_not_found');
  const conn = connectionForCountry(merchant.country ?? 'CD');
  const bindings = listBindings(merchant.id).filter((b) => b.status === 'ACTIVE');
  const pairs = conn ? listPairs(conn.id).filter((p) => p.status === 'OPEN' && p.currency === intent.currency) : [];
  const participants = conn ? listParticipants({ country: conn.country, status: 'ACTIVE' }) : [];
  const payers = participants
    .filter((p) => p.kind !== 'AGGREGATOR' && bindings.some((b) => pairs.some((x) => x.debtorId === p.id && x.creditorId === b.participantId)))
    .map((p) => ({ participant_id: p.id, name: p.name, kind: p.kind }));
  return {
    intent: intentView(intent),
    merchant: { id: merchant.id, name: merchant.full_name, businessName: (merchant as any).business_name ?? null },
    connection: conn ? { id: conn.id, simulation: conn.simulation, environment: conn.environment } : null,
    bindings: bindings.map((b) => ({ id: b.id, participantId: b.participantId, accountMasked: b.accountMasked, accountName: b.accountName })),
    payers,
    tokens: Object.entries(SIMULATOR_SCENARIOS).map(([token, scenario]) => ({ token, scenario })),
  };
}

export async function simulatePayerPayment(
  admin: UserRow,
  input: { intentId?: string | null; paymentRequestId?: string | null; qrPayload?: string | null; amountMinor?: number | null; participantId: string; accountToken?: string | null },
) {
  let intentId = input.intentId ?? null;
  if (!intentId && input.paymentRequestId) intentId = intentForSale(input.paymentRequestId).id;
  if (!intentId && input.qrPayload) {
    const r = await resolveScan(input.qrPayload, { channel: 'simulator' });
    if (r.kind === 'intent' && r.intent) intentId = r.intent.id;
    else if (r.kind === 'static' && r.qr) {
      if (!input.amountMinor || input.amountMinor <= 0) throw unprocessable('A static QR carries no amount: enter the amount the payer types', 'amount_required');
      intentId = intentFromStaticQr(r.qr.id, input.amountMinor, null).id;
    } else throw unprocessable(`This QR cannot be paid: ${r.reasons.join(', ') || r.kind}`, 'qr_not_payable');
  }
  if (!intentId) throw unprocessable('Choose an open sale or intent, or paste a QR code', 'intent_required');
  const intent = getIntentRow(intentId);
  if (!OPEN_INTENT_STATES.has(intent.status)) throw unprocessable(`The intent is ${intent.status}; only an open intent can be paid`, 'intent_not_open');
  if (!intent.amount_minor || intent.amount_minor <= 0) throw unprocessable('The intent carries no amount', 'amount_required');
  const merchant = findUserById(intent.merchant_user_id);
  if (!merchant) throw notFound('Merchant not found', 'merchant_not_found');
  const conn = connectionForCountry(merchant.country ?? 'CD');
  if (!conn) throw unprocessable('No national switch connection for the merchant country', 'switch_connection_missing');
  if (!conn.simulation) throw forbidden('The payer simulator only drives a connection in simulation; on a certified connection the payer institution speaks to the switch itself', 'simulation_only');
  const pairs = listPairs(conn.id).filter((p) => p.status === 'OPEN' && p.currency === intent.currency && p.debtorId === input.participantId);
  const bindings = listBindings(merchant.id).filter((b) => b.status === 'ACTIVE');
  if (!bindings.length) throw unprocessable('The acceptor has no active settlement account at a participating institution: declare and activate one first (scene 2)', 'binding_required');
  const binding = bindings.find((b) => pairs.some((p) => p.creditorId === b.participantId));
  if (!binding) throw unprocessable(`No open pair from ${input.participantId} to the acceptor's institution in ${intent.currency}`, 'pair_not_open');
  const accountToken = input.accountToken?.trim() || 'tok_ok';
  const consent = recordConsent({
    participantId: input.participantId,
    audience: 'bitripay',
    merchantUserId: merchant.id,
    bindingId: binding.id,
    amountMinor: intent.amount_minor,
    currency: intent.currency,
    accountToken,
    proof: `simulator:${admin.id}:${intent.id}:${Date.now()}`,
  });
  const r = createPayment(
    merchant,
    null,
    {
      merchant_order_id: (intent.reference ?? intent.id).slice(0, 64),
      product: 'MERCHANT_PAYMENT',
      amount: { currency: intent.currency, value_minor: String(intent.amount_minor) },
      payer: { participant_id: input.participantId, account_token: accountToken },
      beneficiary_binding_id: binding.id,
      consent_reference: consent.reference,
      intent_id: intent.id,
      channel: 'qr',
      description: intent.description ?? null,
      metadata: { simulator: true, simulatedBy: admin.id },
    } as any,
    `sim-${intent.id}-${Date.now()}`,
  );
  // The standing dispatcher may hold the lease: the demonstration takes it over (fencing token) so the payment completes now.
  const dispatched = await dispatchOutbox(`admin:${admin.id}`, { limit: 100, force: true });
  const id = r.payment.payment_id;
  return {
    payment: getPayment(merchant.id, id),
    timeline: paymentTimeline(id),
    intent: intentView(getIntentRow(intent.id)),
    binding,
    consentReference: consent.reference,
    dispatched: dispatched.processed,
  };
}

/**
 * Refund of a simulated payment (Instruction n°58 art. 23: principal and fees return to the customer). The refund is
 * the merchant's compensating operation through the switch; the outbox is dispatched at once and, when the
 * simulator answers asynchronously, its completion is injected as the creditor institution would send it.
 */
export async function simulateRefund(admin: UserRow, paymentId: string, reason: string) {
  const p = getPaymentRow(paymentId);
  const conn = getConnection(p.connection_id!);
  if (!conn.simulation) throw forbidden('Refunds are simulated only on a connection in simulation', 'simulation_only');
  const merchant = findUserById(p.merchant_user_id);
  if (!merchant) throw notFound('Merchant not found', 'merchant_not_found');
  const op = createLinkedRefund(merchant, paymentId, { reason, idemKey: `sim-refund-${paymentId}-${Date.now()}` }, { type: 'admin', id: admin.id });
  getDb()
    .prepare('UPDATE outbox_messages SET available_at = ? WHERE payment_id = ? AND delivered_at IS NULL')
    .run(new Date(Date.now() - 1000).toISOString(), paymentId);
  await dispatchOutbox(`admin:${admin.id}`, { limit: 100, force: true });
  let after = listLinkedOperations(paymentId).find((o) => o.id === op.id)!;
  if (after.status !== 'SUCCEEDED' && after.status !== 'REJECTED') {
    const row = getDb().prepare('SELECT stable_message_id FROM linked_operations WHERE id = ?').get(op.id) as { stable_message_id: string | null } | undefined;
    if (!row?.stable_message_id) throw unprocessable(`The refund is ${after.status} and carries no message id to complete`, 'refund_not_transmitted');
    const msg = simulatorFor(conn).inboundFor(row.stable_message_id, 'completed', {});
    ingestInbound(conn.id, msg.raw, { source: 'CREDITOR', receivedAt: now(), channel: 'simulator', remote: 'simulator' });
    after = listLinkedOperations(paymentId).find((o) => o.id === op.id)!;
  }
  return { operation: after, payment: getPayment(merchant.id, paymentId), timeline: paymentTimeline(paymentId), fee: feeEntryForPayment(paymentId) };
}
