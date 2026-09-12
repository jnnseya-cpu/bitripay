import type { Request } from 'express';
import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../lib/errors';
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
import { continueRouteAfterFunding, recallRouteFunds, type RouteDestination } from './routing';
import { getGatewayControls } from './settings';
import { recordEvent, type Actor } from './events';
import { STAGE_LABELS, TERMINAL_STAGES, advanceThrough, transitionStage, type PaymentStage } from './lifecycle';
import { startAttempt, reconcileOpenAttempt } from './intents';
import { pickConnector, connectorHealth } from './rails';
import { assertPin } from './auth';
import { verifyStepUpToken } from './webauthn';
import { assessRisk } from './risk';
import { PROVIDERS as PROVIDER_MAP } from '../payments';
import { tryTransitionRoute } from './routeLifecycle';
import { cancelPayout } from './payouts';
import { openDispute } from './finops/disputes';

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

/** Proof of a fresh biometric (passkey step-up token) or the transaction PIN, supplied by the payer. */
export interface PaymentAuth {
  pin?: string | null;
  req?: Pick<Request, 'headers' | 'body'> | null;
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
  stage: PaymentStage;
  stageLabel: string;
  /** initiated | confirmed | settled | exception – what the customer must understand about the money. */
  stageGroup: 'initiated' | 'confirmed' | 'settled' | 'exception';
  stageDescription: string;
  authMethod: string | null;
  authenticatedAt: string | null;
  expiresAt: string | null;
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
  const stage = (row.stage ?? 'CREATED') as PaymentStage;
  const label = STAGE_LABELS[stage];
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
    stage,
    stageLabel: label.label,
    stageGroup: label.group,
    stageDescription: label.description,
    authMethod: row.auth_method ?? null,
    authenticatedAt: row.authenticated_at ?? null,
    expiresAt: row.expires_at ?? null,
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

function mergeMeta(id: string, patch: Record<string, unknown>) {
  const current = parseJson<Record<string, unknown>>(getPayment(id).metadata, {});
  updatePayment(id, { metadata: JSON.stringify({ ...current, ...patch }) });
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
  if (preferred && !operatorId) return candidates.find((g) => g.id === preferred);
  if (!operatorId) return candidates.find((g) => g.provider !== 'manual_momo') ?? candidates[0];
  const op = getOperator(operatorId);
  const api = candidates.find((g) => g.provider !== 'manual_momo' && g.provider !== 'sandbox' && (g.countries.length === 0 || g.countries.includes(op.country)) && (g.currencies.length === 0 || g.currencies.includes(op.currency)));
  if (api) return api;
  const direct = candidates.find((g) => g.provider === 'manual_momo');
  if (direct && op.collectionNumber) return direct;
  return candidates.find((g) => g.provider === 'sandbox') ?? direct ?? candidates[0];
}

/** Smart Route: best usable connector for a method among the candidates the capability filters already allowed. */
function smartPick(candidates: ReturnType<typeof availableGateways>, method: PaymentMethod, policy: string) {
  if (!candidates.length) return undefined;
  const { id } = pickConnector(candidates.map((g, i) => ({ id: g.id, method, costBps: typeof g.config.costBps === 'number' ? (g.config.costBps as number) : null, preferenceRank: i })), (['smart', 'cheapest', 'fastest', 'most_reliable'].includes(policy) ? policy : 'smart') as any);
  return id ? candidates.find((g) => g.id === id) : undefined;
}

function actorFor(user: UserRow | null | undefined): Actor {
  if (!user) return { type: 'guest' };
  return { type: user.role === 'admin' ? 'admin' : user.role === 'agent' ? 'agent' : user.role === 'merchant' ? 'merchant' : 'user', id: user.id };
}

/** Which authentication the intent carries: passkey step-up, PIN, or the external rail's own authentication (guests). */
function resolveAuthentication(user: UserRow | null, auth: PaymentAuth | undefined, gatewayProvider: string, method: PaymentMethod): { method: string | null; required: boolean } {
  if (!user) {
    // A guest is authenticated by the rail itself: the processor (3-D Secure / OTP) or the payer's own operator/bank app.
    return { method: gatewayProvider === 'sandbox' ? 'sandbox' : method === 'card' ? 'processor' : method === 'mobile_money' ? 'operator' : 'payer_bank', required: false };
  }
  const token = (auth?.req?.headers?.['x-step-up-token'] as string | undefined) || auth?.req?.body?.stepUpToken;
  if (token && verifyStepUpToken(user, token)) return { method: 'passkey', required: false };
  if (auth?.pin) {
    assertPin(user, auth.pin, undefined); // throws on a wrong PIN
    return { method: 'pin', required: false };
  }
  return { method: null, required: true };
}

/** Create a payment intent. With a signed-in payer the intent waits in AUTHENTICATION_REQUIRED until biometrics/PIN are supplied. */
export async function initiatePayment(user: UserRow | null, input: InitiatePaymentInput, auth?: PaymentAuth): Promise<PaymentView> {
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
  const policy = (request ? (getDb().prepare('SELECT method_policy FROM payment_intents WHERE id = ?').get(request.intent_id ?? '') as any)?.method_policy : null) ?? 'smart';
  let gateway = input.method === 'mobile_money' ? pickMobileMoneyGateway(candidates, input.operatorId, input.gateway) : input.gateway ? candidates.find((g) => g.id === input.gateway) : smartPick(candidates.filter((g) => g.provider !== 'manual_momo'), input.method, policy);
  if (gateway && !input.gateway && !connectorHealth(gateway.id).usable) {
    // the preferred connector is paused or its circuit is open: fail over to the best usable one for the same method
    const alternative = smartPick(candidates.filter((g) => g.id !== gateway!.id && g.provider !== 'manual_momo'), input.method, policy);
    if (alternative) gateway = alternative;
  }
  if (!gateway) throw unprocessable(`No ${input.method.replace('_', ' ')} gateway is available for ${cur.code}`, 'no_gateway');
  if (input.gateway && !connectorHealth(gateway.id).usable) throw unprocessable(`${gateway.name} is temporarily unavailable (${connectorHealth(gateway.id).reason}); choose another method or try again shortly`, 'connector_unavailable');
  if (gateway.provider === 'manual_momo' && input.operatorId) {
    const op = getOperator(input.operatorId);
    if (op.currency !== cur.code) throw badRequest(`${op.name} collects ${op.currency}. Choose ${op.currency} as the currency to pay with this operator.`, 'operator_currency_mismatch');
  }

  const feeType = input.purpose === 'checkout' ? 'merchant_payment' : input.method === 'card' ? 'card_deposit' : input.method === 'mobile_money' ? 'mobile_money_deposit' : 'bank_deposit';
  const fee = calculateFee(feeType, amount, cur.code);
  if (input.savedCardId) {
    if (!user) throw badRequest('Sign in to use a saved card');
    const card = getDb().prepare('SELECT * FROM saved_cards WHERE id = ? AND user_id = ?').get(input.savedCardId, user.id) as any;
    if (!card) throw notFound('Saved card not found');
    if (card.provider !== gateway.provider) throw badRequest(`This card can only be charged through ${card.provider}`);
  }

  const id = uuid();
  const ts = now();
  const controls = getGatewayControls();
  const expiresAt = new Date(Date.now() + controls.intentExpiryHours * 3600_000).toISOString();
  // Non-sensitive inputs are kept so the intent can be dispatched after authentication. Card data is never stored.
  const intentInput = { operatorId: input.operatorId ?? null, route: input.route ?? null, routeId: input.routeId ?? null, returnUrl: input.returnUrl ?? null, saveCard: !!input.saveCard, savedCardId: input.savedCardId ?? null };
  getDb()
    .prepare(
      `INSERT INTO gateway_payments (id, gateway, provider_ref, method, purpose, user_id, payment_request_id, amount, currency, fee, status, stage, expires_at, payer_email, payer_phone, payer_name, saved_card_id, metadata, transaction_id, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'initiated', 'CREATED', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(id, gateway.id, input.method, input.purpose, user?.id ?? null, request?.id ?? null, amount, cur.code, fee, expiresAt, input.email ?? user?.email ?? null, input.phone ?? user?.phone ?? null, input.name ?? user?.full_name ?? null, input.savedCardId ?? null, JSON.stringify({ operatorId: input.operatorId ?? null, route: input.route ?? null, routeId: input.routeId ?? null, intentInput }), ts, ts);
  const actor = actorFor(user);
  recordEvent('payment', id, 'payment.created', actor, { purpose: input.purpose, method: input.method, gateway: gateway.id, amount, currency: cur.code, fee, operatorId: input.operatorId ?? null });
  // Gateway intents: every external execution is a Payment Attempt on the intent (one in flight at a time).
  if (request?.intent_id) {
    reconcileOpenAttempt(request.intent_id);
    startAttempt(request.intent_id, { methodClass: input.method, connector: gateway.id, operatorId: input.operatorId ?? null, gatewayPaymentId: id }, actor);
  }
  transitionStage(id, 'AUTHENTICATION_REQUIRED', { type: 'system' });

  const authn = resolveAuthentication(user, auth, gateway.provider, input.method);
  if (authn.required) {
    mergeMeta(id, { next: { type: 'authenticate', message: 'Confirm this payment with biometrics or your transaction PIN.' } });
    return toPaymentView(getPayment(id));
  }
  markAuthenticated(id, authn.method!, actor);
  return dispatchToProvider(user, getPayment(id), { card: input.card, savedCardId: input.savedCardId, saveCard: input.saveCard, returnUrl: input.returnUrl });
}

function markAuthenticated(id: string, method: string, actor: Actor) {
  updatePayment(id, { authenticated_at: now(), auth_method: method });
  recordEvent('auth', id, 'payment.authenticated', actor, { method });
}

/** Second step for intents created without authentication: supply biometrics/PIN (and card details again for card payments). */
export async function authenticatePayment(user: UserRow, id: string, body: { pin?: string | null; card?: CardInput; savedCardId?: string | null; saveCard?: boolean; returnUrl?: string | null }, req: Pick<Request, 'headers' | 'body'>): Promise<PaymentView> {
  const payment = getPayment(id);
  if (payment.user_id !== user.id) throw notFound('Payment not found');
  if (payment.stage !== 'AUTHENTICATION_REQUIRED') throw conflict(`Payment is already ${STAGE_LABELS[payment.stage as PaymentStage].label.toLowerCase()}`, 'invalid_stage_transition');
  if (payment.expires_at && payment.expires_at < now()) {
    transitionStage(id, 'EXPIRED', { type: 'system' }, { reason: 'authentication_timeout' });
    throw conflict('This payment intent has expired. Start again.', 'payment_expired');
  }
  const gateway = getGateway(payment.gateway)!;
  const authn = resolveAuthentication(user, { pin: body.pin, req }, gateway.provider, payment.method);
  if (authn.required) throw badRequest('Confirm with biometrics or your transaction PIN', 'authentication_required');
  markAuthenticated(id, authn.method!, actorFor(user));
  const stored = parseJson<any>(payment.metadata, {}).intentInput ?? {};
  const routeId = parseJson<any>(payment.metadata, {}).routeId as string | null;
  if (routeId) tryTransitionRoute(routeId, 'BIOMETRICALLY_APPROVED', actorFor(user), { paymentId: id, method: authn.method });
  const view = await dispatchToProvider(user, getPayment(id), { card: body.card, savedCardId: body.savedCardId ?? stored.savedCardId, saveCard: body.saveCard ?? stored.saveCard, returnUrl: body.returnUrl ?? stored.returnUrl });
  if (routeId && view.status !== 'failed' && view.stage !== 'SETTLED') tryTransitionRoute(routeId, 'FUNDING_PENDING', actorFor(user), { paymentId: id, gateway: view.gateway });
  return view;
}

/** Hand the authenticated intent to the rail: issue instructions / redirect / prompt, or settle immediately when the processor already confirmed. */
async function dispatchToProvider(user: UserRow | null, payment: GatewayPaymentRow, secrets: { card?: CardInput; savedCardId?: string | null; saveCard?: boolean; returnUrl?: string | null }): Promise<PaymentView> {
  const gateway = getGateway(payment.gateway)!;
  const provider = PROVIDERS[gateway.provider];
  const cur = getCurrency(payment.currency, false);
  const meta = parseJson<any>(payment.metadata, {});
  const request = payment.payment_request_id ? (getDb().prepare('SELECT * FROM payment_requests WHERE id = ?').get(payment.payment_request_id) as PaymentRequestRow) : null;
  const merchant = request ? findUserById(request.requester_user_id) : null;
  let savedCardToken: string | null = null;
  if (secrets.savedCardId && user) {
    const card = getDb().prepare('SELECT * FROM saved_cards WHERE id = ? AND user_id = ?').get(secrets.savedCardId, user.id) as any;
    if (!card) throw notFound('Saved card not found');
    savedCardToken = card.provider_ref;
    updatePayment(payment.id, { saved_card_id: card.id });
  }
  const returnUrl = secrets.returnUrl || (payment.purpose === 'checkout' ? `${config.webUrl}/pay/${request!.code}?payment=${payment.id}` : `${config.webUrl}/add-money?payment=${payment.id}`);
  let result: InitiateResult;
  try {
    result = await provider.initiate({
      payment,
      amountMinor: payment.amount,
      amountMajor: payment.amount / 10 ** cur.decimals,
      currency: cur.code,
      decimals: cur.decimals,
      method: payment.method,
      payer: { email: payment.payer_email, phone: payment.payer_phone, name: payment.payer_name, userId: user?.id ?? null },
      card: secrets.card,
      savedCardToken,
      saveCard: !!secrets.saveCard && !!user,
      returnUrl,
      callbackUrl: `${config.apiUrl}/api/webhooks/${gateway.id}`,
      credentials: getGatewayCredentials(gateway.id),
      description: payment.purpose === 'checkout' ? `Payment to ${merchant!.business_name || merchant!.full_name}` : `${config.appName} wallet top-up`,
      operatorId: meta.operatorId ?? null,
    });
  } catch (err) {
    mergeMeta(payment.id, { failureReason: (err as Error).message });
    transitionStage(payment.id, 'REJECTED', { type: 'processor', id: gateway.id }, { reason: (err as Error).message });
    throw unprocessable(`Payment could not be started: ${(err as Error).message}`, 'gateway_error');
  }
  updatePayment(payment.id, { provider_ref: result.providerRef });
  mergeMeta(payment.id, { next: result.next, failureReason: result.failureReason ?? null });
  transitionStage(payment.id, 'INSTRUCTION_ISSUED', { type: 'processor', id: gateway.id }, { providerRef: result.providerRef, next: result.next?.type ?? 'none' });
  if (result.savedCard && user) saveCardFromToken(user.id, gateway.provider, result.savedCard, payment.payer_name || user.full_name);
  if (result.status === 'succeeded') {
    confirmAndSettle(getPayment(payment.id), { actor: { type: 'processor', id: gateway.id }, source: 'processor', details: { providerRef: result.providerRef } });
  } else if (result.status === 'failed') {
    mergeMeta(payment.id, { failureReason: result.failureReason ?? 'Payment failed' });
    transitionStage(payment.id, 'REJECTED', { type: 'processor', id: gateway.id }, { reason: result.failureReason ?? 'Payment failed' });
  }
  return toPaymentView(getPayment(payment.id));
}

/** Ask the provider for the latest status and settle if it succeeded. Safe to call repeatedly. */
export async function verifyPayment(id: string): Promise<PaymentView> {
  let payment = getPayment(id);
  if (TERMINAL_STAGES.includes(payment.stage as PaymentStage)) return toPaymentView(payment);
  if (expireIfDue(payment)) return toPaymentView(getPayment(id));
  if (payment.stage === 'CREATED' || payment.stage === 'AUTHENTICATION_REQUIRED') return toPaymentView(payment);
  const gateway = getGateway(payment.gateway);
  const provider = gateway ? PROVIDERS[gateway.provider] : null;
  if (!provider) return toPaymentView(payment);
  let result: VerifyResult;
  try {
    result = await provider.verify(payment, getGatewayCredentials(gateway!.id));
  } catch {
    return toPaymentView(payment); // transient provider error: stay where we are
  }
  payment = getPayment(id);
  applyProcessorResult(payment, result, { type: 'processor', id: gateway!.id });
  return toPaymentView(getPayment(id));
}

/** Intents past their expiry that never received confirmation expire; ones the payer reported as sent go to manual review instead. */
function expireIfDue(payment: GatewayPaymentRow): boolean {
  if (!payment.expires_at || payment.expires_at > now()) return false;
  if (['CREATED', 'AUTHENTICATION_REQUIRED', 'INSTRUCTION_ISSUED'].includes(payment.stage)) {
    mergeMeta(payment.id, { failureReason: 'No confirmation arrived before the payment expired' });
    transitionStage(payment.id, 'EXPIRED', { type: 'system' }, { expiresAt: payment.expires_at });
    return true;
  }
  if (payment.stage === 'PAYMENT_SENT') {
    transitionStage(payment.id, 'MANUAL_REVIEW', { type: 'system' }, { reason: 'reported_sent_but_unconfirmed_at_expiry' });
    return true;
  }
  return false;
}

export function expireStalePayments(): number {
  const rows = getDb().prepare("SELECT * FROM gateway_payments WHERE expires_at < ? AND stage IN ('CREATED','AUTHENTICATION_REQUIRED','INSTRUCTION_ISSUED','PAYMENT_SENT')").all(now()) as GatewayPaymentRow[];
  let n = 0;
  for (const r of rows) if (expireIfDue(r)) n += 1;
  return n;
}

function applyProcessorResult(payment: GatewayPaymentRow, result: VerifyResult, actor: Actor) {
  if (result.status === 'succeeded') {
    if (result.savedCard && payment.user_id) {
      const gateway = getGateway(payment.gateway);
      if (gateway) saveCardFromToken(payment.user_id, gateway.provider, result.savedCard, payment.payer_name || '');
    }
    // Processor-confirmed rails (cards, operator APIs) carry the processor's own evidence.
    if (['MANUAL_REVIEW', 'MISMATCHED', 'DUPLICATE', 'DISPUTED'].includes(payment.stage)) return; // a human decides these
    confirmAndSettle(getPayment(payment.id), { actor, source: 'processor', details: { raw: summarizeRaw(result.raw) } });
  } else if (result.status === 'failed') {
    if (!['INSTRUCTION_ISSUED', 'PAYMENT_SENT', 'EVIDENCE_RECEIVED', 'VERIFYING', 'MANUAL_REVIEW'].includes(payment.stage)) return;
    mergeMeta(payment.id, { failureReason: result.failureReason ?? 'Payment failed' });
    transitionStage(payment.id, 'REJECTED', actor, { reason: result.failureReason ?? 'Payment failed' });
    if (payment.user_id) notify(payment.user_id, 'Payment failed', result.failureReason ?? 'Your payment could not be completed.', { kind: 'payment_failed', paymentId: payment.id });
  } else if (result.status === 'unknown') {
    // The provider cannot say whether money moved: park for a human, never retry blindly (the intent goes AMBIGUOUS).
    if (!['INSTRUCTION_ISSUED', 'PAYMENT_SENT', 'EVIDENCE_RECEIVED', 'VERIFYING'].includes(payment.stage)) return;
    mergeMeta(payment.id, { failureReason: result.failureReason ?? 'Provider outcome unknown', providerOutcome: 'unknown' });
    transitionStage(payment.id, 'MANUAL_REVIEW', actor, { reason: 'provider_outcome_unknown', detail: result.failureReason ?? null });
  }
}


function summarizeRaw(raw: unknown) {
  if (!raw) return null;
  try {
    const s = JSON.stringify(raw);
    return s.length > 2000 ? `${s.slice(0, 2000)}…` : JSON.parse(s);
  } catch {
    return null;
  }
}

export interface ConfirmationInput {
  actor: Actor;
  /** processor | signed_device | shared_secret | manual */
  source: string;
  evidenceId?: string | null;
  verificationId?: string | null;
  details?: Record<string, unknown>;
}

/**
 * The only path to SETTLED. Requires the intent to be authenticated and independently confirmed:
 *   EVIDENCE_RECEIVED → VERIFYING (fraud/sanctions/velocity) → CONFIRMED → SETTLED (balanced ledger posting).
 * A risky payment stops in MANUAL_REVIEW; nothing is credited.
 */
export function confirmAndSettle(payment: GatewayPaymentRow, input: ConfirmationInput): GatewayPaymentRow {
  const db = getDb();
  return db.transaction(() => {
    const fresh = getPayment(payment.id);
    if (fresh.stage === 'SETTLED' && fresh.transaction_id) return fresh;
    if (TERMINAL_STAGES.includes(fresh.stage as PaymentStage)) throw conflict(`Payment is already ${fresh.stage.toLowerCase()}`, 'invalid_stage_transition');
    if (!fresh.authenticated_at) throw conflict('Payment was never authenticated', 'authentication_required');
    const details = { source: input.source, evidenceId: input.evidenceId ?? null, verificationId: input.verificationId ?? null, ...(input.details ?? {}) };
    advanceThrough(fresh.id, ['EVIDENCE_RECEIVED', 'VERIFYING'], input.actor, details);
    // Fraud, sanctions and velocity controls run on every confirmation, whatever its source.
    const risk = assessRisk({ userId: fresh.user_id, kind: 'payment_in', amount: fresh.amount, currency: fresh.currency, subjectType: 'payment', subjectId: fresh.id, counterparty: { name: fresh.payer_name, phone: fresh.payer_phone, email: fresh.payer_email } });
    if (risk.action !== 'allow' && input.source !== 'manual') {
      mergeMeta(fresh.id, { riskFlags: risk.flags, riskScore: risk.score });
      transitionStage(fresh.id, 'MANUAL_REVIEW', { type: 'system' }, { reason: 'risk', score: risk.score, flags: risk.flags });
      return getPayment(fresh.id);
    }
    transitionStage(fresh.id, 'CONFIRMED', input.actor, details);
    return settlePayment(getPayment(fresh.id), input.actor);
  })();
}

/** Post the balanced ledger entries for a CONFIRMED intent and mark it SETTLED. Idempotent per payment. */
export function settlePayment(payment: GatewayPaymentRow, actor: Actor = { type: 'system' }): GatewayPaymentRow {
  const db = getDb();
  return db.transaction(() => {
    const fresh = getPayment(payment.id);
    if (fresh.stage === 'SETTLED' && fresh.transaction_id) return fresh;
    if (fresh.stage !== 'CONFIRMED') throw conflict('Only confirmed payments can be settled', 'invalid_stage_transition');
    const cur = getCurrency(fresh.currency, false);
    const gateway = getGateway(fresh.gateway);
    if (fresh.purpose === 'deposit') {
      const wallet = ensureWallet(fresh.user_id!, cur.code);
      const type = fresh.method === 'card' ? 'card_deposit' : fresh.method === 'mobile_money' ? 'mobile_money_deposit' : 'bank_deposit';
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
        issuance: { authority: 'external_funding', paymentId: fresh.id, reference: fresh.provider_ref },
      });
      updatePayment(fresh.id, { transaction_id: tx.id });
      transitionStage(fresh.id, 'SETTLED', actor, { transactionId: tx.id, credited });
      notify(fresh.user_id!, 'Money added', `${formatMoney(credited, cur)} was added to your ${cur.code} wallet.`, { kind: 'deposit', transactionId: tx.id });
      onDepositCompleted(fresh.user_id!);
      const meta = parseJson<{ route?: RouteDestination | null; routeId?: string | null }>(fresh.metadata, {});
      if (meta.route && meta.routeId) continueRouteAfterFunding(meta.routeId, fresh.id, tx.id, credited);
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
        issuance: { authority: 'external_funding', paymentId: fresh.id, reference: fresh.provider_ref },
      });
      updatePayment(fresh.id, { transaction_id: tx.id });
      transitionStage(fresh.id, 'SETTLED', actor, { transactionId: tx.id });
      if (request.status === 'open') markPaidByGateway(request.code, tx.id, fresh.user_id);
      void dispatchWebhook(merchant.id, 'payment.completed', {
        paymentRequest: toPaymentRequest(getPaymentRequestByCode(request.code)),
        transaction: { id: tx.id, reference: tx.reference, amount: tx.amount, fee: tx.fee, currency: tx.currency, method: fresh.method, gateway: fresh.gateway, payerEmail: fresh.payer_email },
      });
    }
    return getPayment(fresh.id);
  })();
}

/** Reject an open intent (verifier decision or processor failure). Nothing was credited. */
export function rejectPayment(id: string, actor: Actor, reason: string): PaymentView {
  const payment = getPayment(id);
  if (TERMINAL_STAGES.includes(payment.stage as PaymentStage)) throw conflict(`Payment is already ${payment.stage.toLowerCase()}`, 'invalid_stage_transition');
  mergeMeta(id, { failureReason: reason });
  transitionStage(id, 'REJECTED', actor, { reason });
  if (payment.user_id) notify(payment.user_id, 'Payment rejected', reason, { kind: 'payment_failed', paymentId: id });
  return toPaymentView(getPayment(id));
}

/**
 * The payer reports that they sent the external payment. Screenshots and typed references are kept as
 * supporting notes only – they are never authoritative evidence. Settlement still needs independent confirmation.
 */
export function markPaymentSent(user: UserRow, id: string, proof: { reference?: string; note?: string; image?: string }): PaymentView {
  const payment = getPayment(id);
  if (payment.user_id !== user.id) throw notFound('Payment not found');
  if (payment.method !== 'bank' && payment.method !== 'mobile_money') throw badRequest('Only bank and mobile money transfers accept a sent report');
  if (!['INSTRUCTION_ISSUED', 'PAYMENT_SENT'].includes(payment.stage)) throw conflict(`Payment is ${STAGE_LABELS[payment.stage as PaymentStage].label.toLowerCase()}`, 'invalid_stage_transition');
  mergeMeta(id, { proof: { reference: proof.reference ?? null, note: proof.note ?? null, hasImage: !!proof.image, image: proof.image ?? null, submittedAt: now(), authoritative: false } });
  if (payment.stage === 'INSTRUCTION_ISSUED') transitionStage(id, 'PAYMENT_SENT', actorFor(user), { reference: proof.reference ?? null, hasImage: !!proof.image });
  else recordEvent('payment', id, 'payment.sent_report_updated', actorFor(user), { reference: proof.reference ?? null, hasImage: !!proof.image });
  return toPaymentView(getPayment(id));
}
/** @deprecated use markPaymentSent */
export const attachBankProof = markPaymentSent;

export async function handleGatewayWebhook(gatewayId: string, req: Request): Promise<{ handled: number }> {
  const gateway = getGateway(gatewayId) ?? listGateways().find((g) => g.provider === gatewayId);
  if (!gateway) throw notFound('Unknown gateway');
  const provider = PROVIDERS[gateway.provider];
  if (!provider.parseWebhook) return { handled: 0 };
  const events = await provider.parseWebhook(req, getGatewayCredentials(gateway.id));
  let handled = 0;
  for (const ev of events) {
    const payment = getDb().prepare('SELECT * FROM gateway_payments WHERE gateway = ? AND provider_ref = ?').get(gateway.id, ev.providerRef) as GatewayPaymentRow | undefined;
    if (!payment || (TERMINAL_STAGES.includes(payment.stage as PaymentStage) && !(payment.stage === 'SETTLED' && (ev.status === 'disputed' || ev.status === 'refunded')))) continue;
    recordEvent('evidence', payment.id, 'processor.webhook', { type: 'processor', id: gateway.id }, { status: ev.status, raw: summarizeRaw(ev.raw) });
    if (ev.status === 'disputed') {
      if (payment.stage === 'SETTLED') openChargeback(payment.id, { reason: ev.reason ?? 'processor dispute', providerRef: ev.providerRef, actor: { type: 'processor', id: gateway.id } });
      handled += 1;
      continue;
    }
    if (ev.status === 'refunded') {
      if (payment.stage === 'SETTLED') reverseFunding(payment, { type: 'processor', id: gateway.id }, 'refunded at processor', 'refund');
      handled += 1;
      continue;
    }
    applyProcessorResult(payment, { status: ev.status, raw: ev.raw }, { type: 'processor', id: gateway.id });
    handled += 1;
  }
  return { handled };
}

export interface ChargebackView {
  id: string;
  paymentId: string;
  routeId: string | null;
  providerRef: string | null;
  amount: number;
  currency: string;
  reason: string | null;
  status: 'open' | 'won' | 'lost' | 'reversed_before_payout';
  payoutStateAtOpen: string | null;
  reversalTransactionId: string | null;
  openedBy: string | null;
  openedAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  note: string | null;
}
function toChargeback(r: any): ChargebackView {
  return { id: r.id, paymentId: r.payment_id, routeId: r.route_id, providerRef: r.provider_ref, amount: r.amount, currency: r.currency, reason: r.reason, status: r.status, payoutStateAtOpen: r.payout_state_at_open, reversalTransactionId: r.reversal_transaction_id, openedBy: r.opened_by, openedAt: r.opened_at, resolvedBy: r.resolved_by, resolvedAt: r.resolved_at, note: r.note };
}
export function listChargebacks(status?: string | null): ChargebackView[] {
  const rows = status ? getDb().prepare('SELECT * FROM chargebacks WHERE status = ? ORDER BY opened_at DESC').all(status) : getDb().prepare('SELECT * FROM chargebacks ORDER BY opened_at DESC LIMIT 200').all();
  return (rows as any[]).map(toChargeback);
}

/** Post the reversal of a settled funding (chargeback lost / refund): customer wallet → treasury, negative balances allowed (the customer owes). */
function reverseFunding(payment: GatewayPaymentRow, actor: Actor, reason: string, kind: 'chargeback' | 'refund', amount?: number | null) {
  const cur = getCurrency(payment.currency, false);
  const wallet = payment.user_id ? ensureWallet(payment.user_id, cur.code) : null;
  const tx = postTransaction({
    type: 'refund',
    amount: amount ?? payment.amount - payment.fee,
    currency: cur.code,
    fromWalletId: wallet?.id ?? null,
    toWalletId: null,
    senderUserId: payment.user_id ?? null,
    note: `${kind === 'chargeback' ? 'Chargeback' : 'Refund'} of ${payment.provider_ref ?? payment.id}: ${reason}`,
    metadata: { paymentId: payment.id, kind, reason },
    allowNegativeSender: true,
  });
  mergeMeta(payment.id, { reversalTransactionId: tx.id, reversalKind: kind, reversalReason: reason });
  transitionStage(payment.id, 'REVERSED', actor, { transactionId: tx.id, kind, reason });
  return tx;
}

/**
 * A processor dispute (or an administrator opening one) freezes the transfer the payment funded.
 * If the payout has not left the platform yet it is cancelled and the funding reversed immediately;
 * if the recipient was already paid, the case stays open until the dispute is won or lost.
 */
export function openChargeback(paymentId: string, input: { reason?: string | null; providerRef?: string | null; actor: Actor }): ChargebackView {
  const db = getDb();
  return db.transaction(() => {
    const payment = getPayment(paymentId);
    if (payment.stage !== 'SETTLED' && payment.stage !== 'DISPUTED') throw conflict(`Payment is ${payment.stage.toLowerCase()} – only settled payments can be disputed`, 'invalid_stage_transition');
    const existing = db.prepare("SELECT * FROM chargebacks WHERE payment_id = ? AND status = 'open'").get(paymentId) as any;
    if (existing) return toChargeback(existing);
    const route = db.prepare('SELECT * FROM money_routes WHERE payment_id = ?').get(paymentId) as any;
    const payout = route?.payout_id ? (db.prepare('SELECT * FROM payout_instructions WHERE id = ?').get(route.payout_id) as any) : null;
    const id = uuid();
    transitionStage(payment.id, 'DISPUTED', input.actor, { reason: input.reason ?? null, providerRef: input.providerRef ?? null });
    let status: ChargebackView['status'] = 'open';
    let reversalTx: string | null = null;
    const payoutState = payout?.stage ?? (route ? route.stage : null);
    const notPaidOut = !route || ['CREATED', 'QUOTED', 'FUNDING_PENDING', 'FUNDED', 'PAYOUT_ROUTED', 'INSUFFICIENT_LIQUIDITY', 'MANUAL_REVIEW', 'FAILED', 'EXPIRED'].includes(route.stage);
    if (route) tryTransitionRoute(route.id, 'DISPUTED', input.actor, { paymentId, reason: input.reason ?? null });
    if (notPaidOut) {
      if (route) recallRouteFunds(route.id, input.actor, 'Funding disputed (chargeback)');
      else if (payout && ['QUEUED', 'INSUFFICIENT_LIQUIDITY', 'MANUAL_REVIEW', 'FAILED', 'EXPIRED', 'MISMATCHED', 'DUPLICATE'].includes(payout.stage)) cancelPayout(payout.id, input.actor, 'Funding disputed (chargeback)');
      const tx = reverseFunding(payment, input.actor, input.reason ?? 'chargeback', 'chargeback');
      reversalTx = tx.id;
      status = 'reversed_before_payout';
      if (route) tryTransitionRoute(route.id, 'REVERSED', input.actor, { paymentId, chargebackId: id });
    }
    db.prepare('INSERT INTO chargebacks (id, payment_id, route_id, provider_ref, amount, currency, reason, status, payout_state_at_open, reversal_transaction_id, opened_by, opened_at, resolved_by, resolved_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)').run(id, payment.id, route?.id ?? null, input.providerRef ?? payment.provider_ref, payment.amount, payment.currency, input.reason ?? null, status, payoutState, reversalTx, input.actor.id ?? null, now());
    recordEvent('chargeback', id, 'chargeback.opened', input.actor, { paymentId, routeId: route?.id ?? null, status, payoutState, reason: input.reason ?? null });
    // A chargeback on money that reached a merchant becomes a dispute object (deadline, evidence, hold, decision).
    if (status === 'open' && payment.transaction_id) {
      try {
        const d = openDispute({ transactionId: payment.transaction_id, gatewayPaymentId: payment.id, chargebackId: id, openedBy: 'processor', reasonCode: 'unauthorised', reason: input.reason ?? 'Chargeback received from the processor', responsibleInstitution: payment.gateway ?? null }, input.actor);
        db.prepare('UPDATE chargebacks SET note = ? WHERE id = ?').run(`dispute:${d.id}`, id);
      } catch (err) {
        if (!(err instanceof AppError && (err.code === 'not_disputable' || err.code === 'dispute_exists'))) throw err;
      }
    }
    if (payment.user_id) notify(payment.user_id, 'Payment disputed', status === 'reversed_before_payout' ? 'Your card payment was disputed; the transfer was cancelled and reversed.' : 'Your card payment was disputed. The transfer is under review.', { kind: 'chargeback', paymentId });
    return toChargeback(db.prepare('SELECT * FROM chargebacks WHERE id = ?').get(id));
  })();
}

/** Resolve an open chargeback: won → the transfer stands; lost → funding reversed (the customer owes the amount if it was already paid out). */
export function resolveChargeback(id: string, outcome: 'won' | 'lost', admin: UserRow, note?: string | null): ChargebackView {
  const db = getDb();
  return db.transaction(() => {
    const cb = db.prepare('SELECT * FROM chargebacks WHERE id = ?').get(id) as any;
    if (!cb) throw notFound('Chargeback not found');
    if (cb.status !== 'open') throw conflict(`Chargeback is already ${cb.status}`, 'invalid_status');
    const payment = getPayment(cb.payment_id);
    const actor: Actor = { type: 'admin', id: admin.id };
    let reversalTx: string | null = null;
    if (outcome === 'won') {
      transitionStage(payment.id, 'SETTLED', actor, { chargebackId: id, outcome });
      if (cb.route_id) tryTransitionRoute(cb.route_id, 'SETTLED', actor, { chargebackId: id, outcome });
    } else {
      reversalTx = reverseFunding(payment, actor, note ?? 'chargeback lost', 'chargeback').id;
      if (cb.route_id) tryTransitionRoute(cb.route_id, 'REVERSED', actor, { chargebackId: id, outcome });
    }
    db.prepare('UPDATE chargebacks SET status = ?, resolved_by = ?, resolved_at = ?, note = ?, reversal_transaction_id = COALESCE(?, reversal_transaction_id) WHERE id = ?').run(outcome, admin.id, now(), note ?? null, reversalTx, id);
    recordEvent('chargeback', id, `chargeback.${outcome}`, actor, { paymentId: payment.id, note: note ?? null, reversalTransactionId: reversalTx });
    return toChargeback(db.prepare('SELECT * FROM chargebacks WHERE id = ?').get(id));
  })();
}

/**
 * Refund a settled funding payment through its processor (card) – sandbox refunds succeed; processors
 * without a refund API return 'manual' and the funds stay in the wallet for treasury to refund by hand.
 */
/** Ask the processor to return `amount` to the payer's instrument. No ledger effect; callers post the balanced entries. */
export async function providerRefund(payment: GatewayPaymentRow, amount: number, reason: string, actor: Actor): Promise<import('../payments/types').RefundResult> {
  if (payment.stage !== 'SETTLED') throw conflict(`Payment is ${payment.stage.toLowerCase()} – only settled payments can be refunded`, 'invalid_stage_transition');
  if (!Number.isInteger(amount) || amount <= 0 || amount > payment.amount) throw badRequest('Invalid refund amount');
  const gateway = getGateway(payment.gateway)!;
  const provider = PROVIDER_MAP[gateway.provider];
  const result = provider.refund ? await provider.refund(payment, amount, reason, getGatewayCredentials(gateway.id)) : { status: 'manual' as const, message: `${gateway.name} has no refund API – refund manually and record it` };
  recordEvent('payment', payment.id, 'payment.refund_requested', actor, { amount, reason, result: result.status, providerRef: result.providerRef ?? null });
  return result;
}

/** Refund a deposit: the processor returns the money and the payer's wallet funding is reversed. */
export async function refundPayment(paymentId: string, amount: number, reason: string, actor: Actor): Promise<{ payment: PaymentView; result: import('../payments/types').RefundResult; transactionId: string | null }> {
  const payment = getPayment(paymentId);
  const result = await providerRefund(payment, amount, reason, actor);
  if (result.status === 'manual') return { payment: toPaymentView(payment), result, transactionId: null };
  const tx = reverseFunding(payment, actor, reason, 'refund', amount);
  mergeMeta(payment.id, { refund: { amount, providerRef: result.providerRef ?? null, status: result.status, reason } });
  return { payment: toPaymentView(getPayment(payment.id)), result, transactionId: tx.id };
}

export function findPaymentByReference(reference: string): GatewayPaymentRow | undefined {
  return getDb().prepare('SELECT * FROM gateway_payments WHERE provider_ref = ? ORDER BY created_at DESC LIMIT 1').get(reference) as GatewayPaymentRow | undefined;
}

export function listPayments(filter: { userId?: string; purpose?: string; status?: string; stage?: string; stages?: string[]; method?: string; page: number; pageSize: number }) {
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
  if (filter.stage) {
    where.push('stage = ?');
    params.push(filter.stage);
  }
  if (filter.stages?.length) {
    where.push(`stage IN (${filter.stages.map(() => '?').join(',')})`);
    params.push(...filter.stages);
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
