import type { Request } from 'express';
import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { parseJson } from '../lib/json';
import { config } from '../config';
import { formatMoney } from '@bitripay/shared';
import { PROVIDERS, availableGateways, getGateway, getGatewayCredentials, listGateways } from '../payments';
import type { CardInput, GatewayPaymentRow, InitiateResult, NextAction, PaymentMethod, VerifyResult } from '../payments/types';
import { getCurrency } from './currencies';
import { calculateFee, postTransaction } from './ledger';
import { ensureWallet } from './wallets';
import { findUserById, getGatewaySettings, type UserRow } from './users';
import { notify } from './notifications';
import { getPaymentRequestByCode, markPaidByGateway, toPaymentRequest, type PaymentRequestRow } from './paymentRequests';
import { dispatchWebhook } from './webhooks';
import { onDepositCompleted } from './referrals';
import { saveCardFromToken } from './cards';
import { getModules } from './modules';
import { getOperator, listOperators } from './momo';
import { continueRouteAfterFunding, type RouteDestination } from './routing';

export interface InitiatePaymentInput {
  purpose: 'deposit' | 'checkout';
  method: PaymentMethod;
  gateway?: string | null;
  amount?: number | null;
  currency?: string | null;
  card?: CardInput;
  savedCardId?: string | null;
  saveCard?: boolean;
  phone?: string | null;
  email?: string | null;
  name?: string | null;
  paymentRequestCode?: string | null;
  returnUrl?: string | null;
  /** Mobile money operator (from the world directory). Routes to an API gateway covering it, else the direct rail. */
  operatorId?: string | null;
  /** Optional onward destination executed automatically once the money arrives (any → any). */
  route?: RouteDestination | null;
  routeId?: string | null;
}

export interface PaymentView {
  id: string;
  gateway: string;
  gatewayName: string;
  method: PaymentMethod;
  purpose: 'deposit' | 'checkout';
  amount: number;
  currency: string;
  fee: number;
  status: GatewayPaymentRow['status'];
  providerRef: string | null;
  transactionId: string | null;
  paymentRequestCode: string | null;
  failureReason: string | null;
  next: NextAction | null;
  operatorId?: string | null;
  route?: RouteDestination | null;
  createdAt: string;
  updatedAt: string;
}

export function toPaymentView(row: GatewayPaymentRow): PaymentView {
  const meta = parseJson<any>(row.metadata, {});
  const pr = row.payment_request_id ? (getDb().prepare('SELECT code FROM payment_requests WHERE id = ?').get(row.payment_request_id) as any) : null;
  return {
    id: row.id,
    gateway: row.gateway,
    gatewayName: getGateway(row.gateway)?.name ?? row.gateway,
    method: row.method,
    purpose: row.purpose,
    amount: row.amount,
    currency: row.currency,
    fee: row.fee,
    status: row.status,
    providerRef: row.provider_ref,
    transactionId: row.transaction_id,
    paymentRequestCode: pr?.code ?? null,
    failureReason: meta.failureReason ?? null,
    next: meta.next ?? null,
    operatorId: meta.operatorId ?? null,
    route: meta.route ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getPayment(id: string): GatewayPaymentRow {
  const row = getDb().prepare('SELECT * FROM gateway_payments WHERE id = ?').get(id) as GatewayPaymentRow | undefined;
  if (!row) throw notFound('Payment not found', 'payment_not_found');
  return row;
}

function updatePayment(id: string, fields: Partial<Record<keyof GatewayPaymentRow, unknown>>) {
  const keys = Object.keys(fields);
  getDb().prepare(`UPDATE gateway_payments SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => (fields as any)[k]), now(), id);
}

/** Public list of deposit methods available for the payer's currency/country – used by the "Add money" screen and checkout. */
export function paymentOptions(currency: string, country?: string | null, purpose: 'deposit' | 'checkout' = 'deposit') {
  const methods: PaymentMethod[] = ['card', 'mobile_money', 'bank'];
  return methods
    .map((method) => ({
      method,
      gateways: availableGateways(method, currency, country).map((g) => ({ id: g.id, name: g.name, provider: g.provider, publishableKey: g.provider === 'stripe' ? getGatewayCredentials(g.id).publishableKey || null : null })),
      fee: calculateFee(method === 'card' ? 'card_deposit' : method === 'mobile_money' ? 'mobile_money_deposit' : 'bank_deposit', 10000, currency),
      /** Mobile money operators the payer can choose (world directory filtered by country when known). */
      operators: method === 'mobile_money' ? listOperators({ country: country || undefined }).map((o) => ({ id: o.id, name: o.name, brand: o.brand, country: o.country, currency: o.currency, ussd: o.ussd, color: o.color, directRail: o.directRail })) : undefined,
    }))
    .filter((m) => m.gateways.length > 0 && (purpose === 'checkout' || m.method !== 'wallet'));
}

/**
 * Pick the gateway for a mobile money payment: an API gateway whose country/currency covers the operator
 * wins; otherwise the direct rail (manual_momo) handles any operator with a collection number.
 */
function pickMobileMoneyGateway(candidates: ReturnType<typeof availableGateways>, operatorId: string | null | undefined, preferred?: string | null) {
  if (preferred) return candidates.find((g) => g.id === preferred);
  if (!operatorId) return candidates.find((g) => g.provider !== 'manual_momo') ?? candidates[0];
  const op = getOperator(operatorId);
  const api = candidates.find((g) => g.provider !== 'manual_momo' && g.provider !== 'sandbox' && (g.countries.length === 0 || g.countries.includes(op.country)) && (g.currencies.length === 0 || g.currencies.includes(op.currency)));
  if (api) return api;
  // Direct rail (collection number configured) is the real rail; the sandbox only simulates when nothing else applies.
  const direct = candidates.find((g) => g.provider === 'manual_momo');
  if (direct && op.collectionNumber) return direct;
  return candidates.find((g) => g.provider === 'sandbox') ?? direct ?? candidates[0];
}

/** Create a gateway payment and hand off to the provider. */
export async function initiatePayment(user: UserRow | null, input: InitiatePaymentInput): Promise<PaymentView> {
  const modules = getModules();
  let amount = input.amount ?? 0;
  let currency = (input.currency || '').toUpperCase();
  let request: PaymentRequestRow | null = null;
  let merchant: UserRow | null = null;

  if (input.purpose === 'deposit') {
    if (!user) throw badRequest('Sign in to add money');
    if (!modules.addMoney) throw unprocessable('Adding money is currently disabled', 'module_disabled');
  } else {
    if (!input.paymentRequestCode) throw badRequest('paymentRequestCode is required for checkout');
    request = getPaymentRequestByCode(input.paymentRequestCode);
    const view = toPaymentRequest(request);
    if (view.status !== 'open') throw conflict(`This payment request is ${view.status}`, 'request_not_open');
    merchant = findUserById(request.requester_user_id)!;
    if (merchant.role !== 'merchant') throw badRequest('Only merchant payment requests accept external payment methods');
    const settings = getGatewaySettings(merchant);
    if (!settings.methods.includes(input.method)) throw badRequest('This merchant does not accept that payment method', 'method_not_accepted');
    currency = request.currency;
    amount = request.amount ?? amount;
  }
  const cur = getCurrency(currency);
  if (!Number.isInteger(amount) || amount <= 0) throw badRequest('Amount must be greater than zero', 'invalid_amount');

  const candidates = availableGateways(input.method, cur.code, user?.country);
  const gateway = input.method === 'mobile_money' ? pickMobileMoneyGateway(candidates, input.operatorId, input.gateway) : input.gateway ? candidates.find((g) => g.id === input.gateway) : candidates.find((g) => g.provider !== 'manual_momo');
  if (!gateway) throw unprocessable(`No ${input.method.replace('_', ' ')} gateway is available for ${cur.code}`, 'no_gateway');
  const provider = PROVIDERS[gateway.provider];

  const feeType = input.purpose === 'checkout' ? 'merchant_payment' : input.method === 'card' ? 'card_deposit' : input.method === 'mobile_money' ? 'mobile_money_deposit' : 'bank_deposit';
  const fee = calculateFee(feeType, amount, cur.code);

  let savedCardToken: string | null = null;
  if (input.savedCardId) {
    if (!user) throw badRequest('Sign in to use a saved card');
    const card = getDb().prepare('SELECT * FROM saved_cards WHERE id = ? AND user_id = ?').get(input.savedCardId, user.id) as any;
    if (!card) throw notFound('Saved card not found');
    if (card.provider !== gateway.provider) throw badRequest(`This card can only be charged through ${card.provider}`);
    savedCardToken = card.provider_ref;
  }

  const id = uuid();
  const ts = now();
  getDb()
    .prepare(
      `INSERT INTO gateway_payments (id, gateway, provider_ref, method, purpose, user_id, payment_request_id, amount, currency, fee, status, payer_email, payer_phone, payer_name, saved_card_id, metadata, transaction_id, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'initiated', ?, ?, ?, ?, '{}', NULL, ?, ?)`,
    )
    .run(id, gateway.id, input.method, input.purpose, user?.id ?? null, request?.id ?? null, amount, cur.code, fee, input.email ?? user?.email ?? null, input.phone ?? user?.phone ?? null, input.name ?? user?.full_name ?? null, input.savedCardId ?? null, ts, ts);
  if (input.operatorId || input.route) updatePayment(id, { metadata: JSON.stringify({ operatorId: input.operatorId ?? null, route: input.route ?? null, routeId: input.routeId ?? null }) });

  const payment = getPayment(id);
  const returnUrl = input.returnUrl || (input.purpose === 'checkout' ? `${config.webUrl}/pay/${request!.code}?payment=${id}` : `${config.webUrl}/add-money?payment=${id}`);
  let result: InitiateResult;
  try {
    result = await provider.initiate({
      payment,
      amountMinor: amount,
      amountMajor: amount / 10 ** cur.decimals,
      currency: cur.code,
      decimals: cur.decimals,
      method: input.method,
      payer: { email: payment.payer_email, phone: payment.payer_phone, name: payment.payer_name, userId: user?.id ?? null },
      card: input.card,
      savedCardToken,
      saveCard: !!input.saveCard && !!user,
      returnUrl,
      callbackUrl: `${config.apiUrl}/api/webhooks/${gateway.id}`,
      credentials: getGatewayCredentials(gateway.id),
      description: input.purpose === 'checkout' ? `Payment to ${merchant!.business_name || merchant!.full_name}` : `${config.appName} wallet top-up`,
      operatorId: input.operatorId ?? null,
    });
  } catch (err) {
    updatePayment(id, { status: 'failed', metadata: JSON.stringify({ failureReason: (err as Error).message }) });
    throw unprocessable(`Payment could not be started: ${(err as Error).message}`, 'gateway_error');
  }
  updatePayment(id, {
    provider_ref: result.providerRef,
    status: result.status === 'succeeded' ? 'pending' : result.status,
    metadata: JSON.stringify({ ...parseJson(getPayment(id).metadata, {}), next: result.next, failureReason: result.failureReason ?? null }),
  });
  if (result.savedCard && user) saveCardFromToken(user.id, gateway.provider, result.savedCard, payment.payer_name || user.full_name);
  if (result.status === 'succeeded') settlePayment(getPayment(id));
  return toPaymentView(getPayment(id));
}

/** Ask the provider for the latest status and settle if it succeeded. Safe to call repeatedly. */
export async function verifyPayment(id: string): Promise<PaymentView> {
  const payment = getPayment(id);
  if (payment.status === 'succeeded' || payment.status === 'failed' || payment.status === 'cancelled') return toPaymentView(payment);
  const gateway = getGateway(payment.gateway);
  const provider = gateway ? PROVIDERS[gateway.provider] : null;
  if (!provider) return toPaymentView(payment);
  let result: VerifyResult;
  try {
    result = await provider.verify(payment, getGatewayCredentials(gateway!.id));
  } catch (err) {
    return toPaymentView(payment); // transient provider error: stay pending
  }
  applyVerification(payment, result);
  return toPaymentView(getPayment(id));
}

function applyVerification(payment: GatewayPaymentRow, result: VerifyResult) {
  if (result.status === 'succeeded') {
    if (result.savedCard && payment.user_id) {
      const gateway = getGateway(payment.gateway);
      if (gateway) saveCardFromToken(payment.user_id, gateway.provider, result.savedCard, payment.payer_name || '');
    }
    settlePayment(getPayment(payment.id));
  } else if (result.status === 'failed') {
    updatePayment(payment.id, { status: 'failed', metadata: JSON.stringify({ ...parseJson(payment.metadata, {}), failureReason: result.failureReason ?? 'Payment failed' }) });
    if (payment.user_id) notify(payment.user_id, 'Payment failed', result.failureReason ?? 'Your payment could not be completed.', { kind: 'payment_failed', paymentId: payment.id });
  } else if (payment.status === 'initiated') {
    updatePayment(payment.id, { status: 'pending' });
  }
}

/** Credit the ledger for a successful gateway payment. Idempotent per payment. */
export function settlePayment(payment: GatewayPaymentRow): GatewayPaymentRow {
  const db = getDb();
  return db.transaction(() => {
    const fresh = getPayment(payment.id);
    if (fresh.status === 'succeeded' && fresh.transaction_id) return fresh;
    const cur = getCurrency(fresh.currency, false);
    const gateway = getGateway(fresh.gateway);
    if (fresh.purpose === 'deposit') {
      const wallet = ensureWallet(fresh.user_id!, cur.code);
      const type = fresh.method === 'card' ? 'card_deposit' : fresh.method === 'mobile_money' ? 'mobile_money_deposit' : 'bank_deposit';
      // The payer pays `amount` externally; the platform fee is deducted from the credited amount.
      const credited = fresh.amount - fresh.fee;
      const tx = postTransaction({
        type,
        amount: fresh.amount,
        fee: fresh.fee,
        currency: cur.code,
        toWalletId: wallet.id,
        receiveAmount: credited,
        receiverUserId: fresh.user_id!,
        note: `${gateway?.name ?? fresh.gateway} ${fresh.method.replace('_', ' ')} deposit`,
        metadata: { gateway: fresh.gateway, method: fresh.method, providerRef: fresh.provider_ref, paymentId: fresh.id },
        feeFrom: 'receiver',
      });
      updatePayment(fresh.id, { status: 'succeeded', transaction_id: tx.id });
      notify(fresh.user_id!, 'Money added', `${formatMoney(credited, cur)} was added to your ${cur.code} wallet.`, { kind: 'deposit', transactionId: tx.id });
      onDepositCompleted(fresh.user_id!);
      const meta = parseJson<{ route?: RouteDestination | null; routeId?: string | null }>(fresh.metadata, {});
      if (meta.route && meta.routeId) {
        // Any → any: the funding leg landed, execute the onward destination with the credited amount.
        continueRouteAfterFunding(meta.routeId, fresh.id, tx.id, credited);
      }
    } else {
      const request = db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(fresh.payment_request_id) as PaymentRequestRow;
      const merchant = findUserById(request.requester_user_id)!;
      const wallet = ensureWallet(merchant.id, cur.code);
      const tx = postTransaction({
        type: 'merchant_payment',
        amount: fresh.amount,
        fee: fresh.fee,
        currency: cur.code,
        toWalletId: wallet.id,
        receiveAmount: fresh.amount - fresh.fee,
        feeFrom: 'receiver',
        senderUserId: fresh.user_id ?? null,
        receiverUserId: merchant.id,
        note: request.description ?? `Payment via ${fresh.method.replace('_', ' ')}`,
        metadata: { gateway: fresh.gateway, method: fresh.method, providerRef: fresh.provider_ref, paymentId: fresh.id, paymentRequestId: request.id, paymentRequestCode: request.code, payerEmail: fresh.payer_email, payerPhone: fresh.payer_phone, payerName: fresh.payer_name, ...parseJson(request.metadata, {}) },
      });
      updatePayment(fresh.id, { status: 'succeeded', transaction_id: tx.id });
      if (request.status === 'open') markPaidByGateway(request.code, tx.id, fresh.user_id);
      void dispatchWebhook(merchant.id, 'payment.completed', {
        paymentRequest: toPaymentRequest(getPaymentRequestByCode(request.code)),
        transaction: { id: tx.id, reference: tx.reference, amount: tx.amount, fee: tx.fee, currency: tx.currency, method: fresh.method, gateway: fresh.gateway, payerEmail: fresh.payer_email },
      });
    }
    return getPayment(fresh.id);
  })();
}

/** Admin confirms a manual bank transfer was received (or rejects it). */
export function confirmManualPayment(id: string, outcome: 'succeeded' | 'failed', reason?: string): PaymentView {
  const payment = getPayment(id);
  if (payment.status !== 'pending' && payment.status !== 'initiated') throw conflict(`Payment is already ${payment.status}`);
  if (outcome === 'succeeded') settlePayment(payment);
  else {
    updatePayment(id, { status: 'failed', metadata: JSON.stringify({ ...parseJson(payment.metadata, {}), failureReason: reason ?? 'Rejected by admin' }) });
    if (payment.user_id) notify(payment.user_id, 'Deposit rejected', reason ?? 'Your bank transfer could not be confirmed.', { kind: 'payment_failed', paymentId: id });
  }
  return toPaymentView(getPayment(id));
}

/** Attach a proof/reference for a pending manual bank transfer. */
export function attachBankProof(user: UserRow, id: string, proof: { reference?: string; note?: string; image?: string }) {
  const payment = getPayment(id);
  if (payment.user_id !== user.id) throw notFound('Payment not found');
  if (payment.method !== 'bank' && payment.method !== 'mobile_money') throw badRequest('Only bank and mobile money transfers accept proof');
  updatePayment(id, { status: 'pending', metadata: JSON.stringify({ ...parseJson(payment.metadata, {}), proof: { ...proof, submittedAt: now() } }) });
  return toPaymentView(getPayment(id));
}

export async function handleGatewayWebhook(gatewayId: string, req: Request): Promise<{ handled: number }> {
  const gateway = getGateway(gatewayId) ?? listGateways().find((g) => g.provider === gatewayId);
  if (!gateway) throw notFound('Unknown gateway');
  const provider = PROVIDERS[gateway.provider];
  if (!provider.parseWebhook) return { handled: 0 };
  const events = await provider.parseWebhook(req, getGatewayCredentials(gateway.id));
  let handled = 0;
  for (const ev of events) {
    const payment = getDb().prepare('SELECT * FROM gateway_payments WHERE gateway = ? AND provider_ref = ?').get(gateway.id, ev.providerRef) as GatewayPaymentRow | undefined;
    if (!payment || payment.status === 'succeeded' || payment.status === 'failed') continue;
    applyVerification(payment, { status: ev.status, raw: ev.raw });
    handled += 1;
  }
  return { handled };
}

export function listPayments(filter: { userId?: string; purpose?: string; status?: string; method?: string; page: number; pageSize: number }) {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.userId) {
    where.push('user_id = ?');
    params.push(filter.userId);
  }
  if (filter.purpose) {
    where.push('purpose = ?');
    params.push(filter.purpose);
  }
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.method) {
    where.push('method = ?');
    params.push(filter.method);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) c FROM gateway_payments ${whereSql}`).get(...params) as any).c;
  const rows = db.prepare(`SELECT * FROM gateway_payments ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, filter.pageSize, (filter.page - 1) * filter.pageSize) as GatewayPaymentRow[];
  return { items: rows.map(toPaymentView), total };
}
