/**
 * A customer pays an acceptor from the account they already hold at their own institution, through the national
 * switch. The customer (signed in to the app, or a guest on the hosted checkout page) scans or opens the acceptor's
 * QR / link, picks the institution and gives the identifier of their account there; BitriPay records the consent
 * request, creates the switch payment as the acceptor's order on its active settlement account and dispatches it;
 * the payer's institution authenticates its customer and answers through the switch. Nothing is credited on any
 * BitriPay ledger: the money goes from the customer's institution to the acceptor's institution.
 *
 * Same production path as the console's payer simulator (scene 3), without the simulation-only guard: on a
 * certified connection the institution's answer arrives asynchronously and the customer polls the state.
 */
import { badRequest, notFound, unprocessable } from '../../lib/errors';
import { getDb } from '../../db';
import { findUserById, type UserRow } from '../users';
import { getIntentRow, intentView } from '../intents';
import { getPaymentRequestByCode } from '../paymentRequests';
import { intentFromStaticQr } from '../qrcodes';
import { connectionForCountry } from './connections';
import { listPairs, listParticipants } from './participants';
import { createPayment, dispatchOutbox, getPayment, getPaymentRow, listBindings, paymentView, recordConsent, type SwitchPaymentView } from './payments';
import { intentForSale } from './payerSimulator';

const OPEN_INTENT_STATES = new Set(['CREATED', 'REQUIRES_PAYMENT_METHOD', 'ROUTING', 'REQUIRES_CUSTOMER_ACTION']);

export interface InstitutionOption {
  participant_id: string;
  name: string;
  kind: string;
}

/** The institutions a customer can pay this acceptor from, in this currency: an open pair from the institution to the acceptor's active settlement account. */
export function institutionsFor(merchantUserId: string, currency: string): { available: boolean; simulation: boolean; institutions: InstitutionOption[] } {
  const merchant = findUserById(merchantUserId);
  if (!merchant) return { available: false, simulation: false, institutions: [] };
  const conn = connectionForCountry(merchant.country ?? 'CD');
  if (!conn) return { available: false, simulation: false, institutions: [] };
  const bindings = listBindings(merchant.id).filter((b) => b.status === 'ACTIVE');
  if (!bindings.length) return { available: false, simulation: conn.simulation, institutions: [] };
  const pairs = listPairs(conn.id).filter((p) => p.status === 'OPEN' && p.currency === currency);
  const institutions = listParticipants({ country: conn.country, status: 'ACTIVE' })
    .filter((p) => p.kind !== 'AGGREGATOR' && bindings.some((b) => pairs.some((x) => x.debtorId === p.id && x.creditorId === b.participantId)))
    .map((p) => ({ participant_id: p.id, name: p.name, kind: p.kind }));
  return { available: institutions.length > 0, simulation: conn.simulation, institutions };
}

/** Whether the hosted checkout of this acceptor may offer "pay from your institution" for this currency. */
export function switchAvailableFor(merchantUserId: string, currency: string): boolean {
  try {
    return institutionsFor(merchantUserId, currency).available;
  } catch {
    return false;
  }
}

export interface PayFromInstitutionInput {
  intentId?: string | null;
  /** A payment request / hosted checkout code (payment links, point-of-sale sales, API requests). */
  paymentRequestCode?: string | null;
  /** A static BitriQR sticker with the amount the customer typed (minor units). */
  qrId?: string | null;
  amountMinor?: number | null;
  participantId: string;
  /** The customer's identifier at that institution (mobile money number, account number). Never stored in clear beyond the masked form. */
  accountToken: string;
}

export interface PayFromInstitutionResult {
  payment: SwitchPaymentView;
  intent: ReturnType<typeof intentView>;
  simulation: boolean;
}

function intentFor(input: PayFromInstitutionInput, payer: UserRow | null) {
  if (input.intentId) return getIntentRow(input.intentId);
  if (input.paymentRequestCode) {
    const row = getPaymentRequestByCode(input.paymentRequestCode);
    if (row.status !== 'open') throw unprocessable(`This payment request is ${row.status}`, 'request_not_open');
    if (!row.amount) throw unprocessable('This request has no fixed amount', 'amount_required');
    return intentForSale(row.id);
  }
  if (input.qrId) {
    if (!input.amountMinor || input.amountMinor <= 0) throw badRequest('Enter the amount to pay', 'amount_required');
    return getIntentRow(intentFromStaticQr(input.qrId, input.amountMinor, payer).id);
  }
  throw badRequest('Nothing to pay: give an intent, a payment code or a QR', 'intent_required');
}

/**
 * Create and dispatch the switch payment for the customer. The answer of the payer's institution is in
 * `payment.status` (COMPLETED / REJECTED / PENDING…) with the customer wording in both languages; a rejection is a
 * state, not an error.
 */
export async function payFromInstitution(
  payer: UserRow | null,
  input: PayFromInstitutionInput,
  ctx: { ip?: string | null; channel: 'customer_app' | 'hosted_checkout' },
): Promise<PayFromInstitutionResult> {
  const participantId = input.participantId?.trim();
  const accountToken = input.accountToken?.trim();
  if (!participantId) throw badRequest('Choose the institution you pay from', 'participant_required');
  if (!accountToken || accountToken.length < 4 || accountToken.length > 64) throw badRequest('Give your identifier at that institution (mobile money number or account number)', 'account_required');
  const intent = intentFor(input, payer);
  if (!OPEN_INTENT_STATES.has(intent.status)) throw unprocessable(`This payment is ${intent.status.toLowerCase().replace(/_/g, ' ')}; only an open payment can be paid`, 'intent_not_open');
  if (!intent.amount_minor || intent.amount_minor <= 0) throw unprocessable('The payment carries no amount', 'amount_required');
  const merchant = findUserById(intent.merchant_user_id);
  if (!merchant) throw notFound('Merchant not found', 'merchant_not_found');
  if (payer && payer.id === merchant.id) throw unprocessable('This is your own code', 'own_code');
  const conn = connectionForCountry(merchant.country ?? 'CD');
  if (!conn) throw unprocessable('Paying from an institution is not available for this acceptor yet', 'switch_connection_missing');
  const bindings = listBindings(merchant.id).filter((b) => b.status === 'ACTIVE');
  if (!bindings.length) throw unprocessable('This acceptor has no active settlement account at a participating institution yet', 'binding_required');
  const pairs = listPairs(conn.id).filter((p) => p.status === 'OPEN' && p.currency === intent.currency && p.debtorId === participantId);
  const binding = bindings.find((b) => pairs.some((p) => p.creditorId === b.participantId));
  if (!binding) throw unprocessable(`Payments from ${participantId} to this acceptor in ${intent.currency} are not open`, 'pair_not_open');
  const consent = recordConsent({
    participantId,
    audience: 'bitripay',
    merchantUserId: merchant.id,
    bindingId: binding.id,
    amountMinor: intent.amount_minor,
    currency: intent.currency,
    accountToken,
    proof: `${ctx.channel}:${payer?.id ?? 'guest'}:${intent.id}:${Date.now()}`,
  });
  // One order id per attempt: after a rejection or an expiry the customer may try again from another institution (the intent is still open).
  const priorAttempts = (getDb().prepare('SELECT COUNT(*) c FROM switch_payments WHERE intent_id = ?').get(intent.id) as { c: number }).c;
  const baseOrder = (intent.reference ?? intent.id).slice(0, 58);
  const r = createPayment(
    merchant,
    null,
    {
      merchant_order_id: priorAttempts ? `${baseOrder}~${priorAttempts + 1}` : baseOrder,
      product: 'MERCHANT_PAYMENT',
      amount: { currency: intent.currency, value_minor: String(intent.amount_minor) },
      payer: { participant_id: participantId, account_token: accountToken },
      beneficiary_binding_id: binding.id,
      consent_reference: consent.reference,
      intent_id: intent.id,
      channel: 'qr',
      description: intent.description ?? null,
      metadata: { payer_channel: ctx.channel, payer_user_id: payer?.id ?? null, payer_ip: ctx.ip ?? null },
    } as any,
    `cust-${intent.id}-${priorAttempts + 1}-${participantId}-${accountToken.slice(-4)}`,
  );
  // Dispatch now under the customer's own owner (fencing token) so the institution's synchronous answer reaches the customer at once.
  await dispatchOutbox(`customer:${payer?.id ?? 'guest'}:${intent.id}`, { limit: 50, force: true });
  return { payment: getPayment(merchant.id, r.payment.payment_id), intent: intentView(getIntentRow(intent.id)), simulation: conn.simulation };
}

/** The state of a customer payment, for polling: the payment must belong to the intent the customer holds. */
export function customerPaymentState(paymentId: string, intentId: string): PayFromInstitutionResult {
  const row = getPaymentRow(paymentId);
  if (row.intent_id !== intentId) throw notFound('Payment not found', 'not_found');
  const conn = connectionForCountry((findUserById(row.merchant_user_id)?.country as string | undefined) ?? 'CD');
  return { payment: paymentView(row), intent: intentView(getIntentRow(intentId)), simulation: conn?.simulation ?? false };
}
