/**
 * Payment Intents: the core object of the BitriPay gateway. An intent is the merchant's authoritative request
 * (amount, currency, purpose, expiry); it carries the canonical state machine independent of any provider, one or
 * more Payment Attempts (one per rail execution, never two in flight), and the payment event store. Execution is
 * merged with the existing platform: each intent is backed by a payment request so the wallet, QR and hosted
 * checkout flows already in place settle it through the same double-entry ledger, and the outcome always comes from
 * an authoritative event (ledger posting, verified processor callback, verified evidence), never from a screen.
 */
import { randomBytes } from 'node:crypto';
import { getDb } from '../db';
import { uuid, now, shortCode } from '../lib/ids';
import { parseJson } from '../lib/json';
import { sha256 } from '../lib/crypto';
import { badRequest, conflict, notFound } from '../lib/errors';
import { config } from '../config';
import type { UserRow } from './users';
import { findUserById, toPublicUser } from './users';
import { getCurrency } from './currencies';
import { createPaymentRequest, type PaymentRequestRow } from './paymentRequests';
import { recordEvent, type Actor } from './events';
import { countryCapabilities } from './capabilities';
import { paymentOptions } from './payments';
import { assertMoneyMovementAllowed } from './guardian';
import { dispatchWebhook } from './webhooks';
import { getGatewaySettings } from './users';
import { completeCheckoutSessionForIntent } from './gateway';
import { recordRoutingOutcome, pickConnector, type RouteCandidate } from './rails';
import { applySplits } from './finops/splits';
import { assertKybIfRequired } from './risk/kycTiers';
import { publish } from './bus';

export const INTENT_STATES = [
  'CREATED',
  'REQUIRES_PAYMENT_METHOD',
  'ROUTING',
  'REQUIRES_CUSTOMER_ACTION',
  'PROCESSING',
  'AUTHORISED',
  'CAPTURED',
  'SETTLEMENT_PENDING',
  'SETTLED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'DISPUTED',
  'REVERSED',
  'UNDER_REVIEW',
  'UNKNOWN_PROVIDER_STATE',
  'AMBIGUOUS',
] as const;
export type IntentState = (typeof INTENT_STATES)[number];
export const TERMINAL_INTENT_STATES: IntentState[] = ['SETTLED', 'FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED', 'REVERSED'];

const TRANSITIONS: Record<IntentState, IntentState[]> = {
  CREATED: ['REQUIRES_PAYMENT_METHOD', 'CANCELLED', 'EXPIRED'],
  REQUIRES_PAYMENT_METHOD: ['ROUTING', 'REQUIRES_CUSTOMER_ACTION', 'PROCESSING', 'CAPTURED', 'CANCELLED', 'EXPIRED', 'UNDER_REVIEW'],
  ROUTING: ['REQUIRES_CUSTOMER_ACTION', 'PROCESSING', 'REQUIRES_PAYMENT_METHOD', 'FAILED', 'CANCELLED', 'EXPIRED', 'UNDER_REVIEW'],
  REQUIRES_CUSTOMER_ACTION: ['PROCESSING', 'REQUIRES_PAYMENT_METHOD', 'FAILED', 'CANCELLED', 'EXPIRED', 'AMBIGUOUS'],
  PROCESSING: ['AUTHORISED', 'CAPTURED', 'REQUIRES_PAYMENT_METHOD', 'FAILED', 'AMBIGUOUS', 'UNKNOWN_PROVIDER_STATE', 'UNDER_REVIEW', 'EXPIRED'],
  AUTHORISED: ['CAPTURED', 'FAILED', 'CANCELLED', 'UNDER_REVIEW'],
  CAPTURED: ['SETTLEMENT_PENDING', 'SETTLED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED', 'REVERSED'],
  SETTLEMENT_PENDING: ['SETTLED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED', 'REVERSED'],
  SETTLED: ['PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED', 'REVERSED'],
  PARTIALLY_REFUNDED: ['REFUNDED', 'DISPUTED', 'SETTLED'],
  REFUNDED: [],
  DISPUTED: ['SETTLED', 'REVERSED', 'REFUNDED'],
  REVERSED: [],
  UNDER_REVIEW: ['REQUIRES_PAYMENT_METHOD', 'PROCESSING', 'CAPTURED', 'FAILED', 'CANCELLED'],
  UNKNOWN_PROVIDER_STATE: ['CAPTURED', 'FAILED', 'AMBIGUOUS', 'UNDER_REVIEW', 'REQUIRES_PAYMENT_METHOD'],
  AMBIGUOUS: ['CAPTURED', 'FAILED', 'UNDER_REVIEW', 'UNKNOWN_PROVIDER_STATE', 'REQUIRES_PAYMENT_METHOD'],
  FAILED: [],
  EXPIRED: [],
  CANCELLED: [],
};

export type AttemptStatus = 'CREATED' | 'PROCESSING' | 'AUTHORISED' | 'CAPTURED' | 'FAILED' | 'UNKNOWN' | 'ABANDONED';
/** Failure categories decide whether another attempt may follow. */
export const RETRYABLE_FAILURES = new Set(['declined', 'insufficient_funds', 'customer_abandoned', 'provider_unavailable', 'timeout_before_send', 'invalid_msisdn', 'limit_exceeded', 'cancelled']);
export const NON_RETRYABLE_FAILURES = new Set(['fraud_block', 'compliance_block', 'expired']);

export interface IntentRow {
  id: string;
  organisation_id: string | null;
  merchant_user_id: string;
  amount_minor: number | null;
  currency: string;
  capture_method: string;
  method_policy: string;
  rails: string;
  reference: string | null;
  description: string | null;
  purpose_code: string | null;
  status: IntentState;
  source: string;
  qr_id: string | null;
  payment_request_id: string | null;
  location_id: string | null;
  terminal_id: string | null;
  customer_user_id: string | null;
  customer_msisdn: string | null;
  customer_country: string | null;
  settlement_profile_id: string | null;
  route_connector: string | null;
  client_secret_hash: string | null;
  idem_key: string | null;
  metadata: string;
  transaction_id: string | null;
  gateway_payment_id: string | null;
  expires_at: string | null;
  ambiguous_since: string | null;
  succeeded_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface AttemptView {
  id: string;
  seq: number;
  methodClass: string;
  rail: string | null;
  connector: string | null;
  operatorId: string | null;
  providerRef: string | null;
  gatewayPaymentId: string | null;
  transactionId: string | null;
  status: AttemptStatus;
  failureCategory: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}
export interface IntentView {
  id: string;
  object: 'payment_intent';
  merchantId: string;
  amount: { valueMinor: number | null; currency: string };
  captureMethod: string;
  methodPolicy: string;
  rails: string[];
  reference: string | null;
  description: string | null;
  purposeCode: string | null;
  status: IntentState;
  source: string;
  qrId: string | null;
  qrPayload: string | null;
  uri: string;
  checkoutUrl: string | null;
  paymentRequestCode: string | null;
  locationId: string | null;
  terminalId: string | null;
  customer: { userId: string | null; msisdn: string | null; country: string | null };
  routeConnector: string | null;
  transactionId: string | null;
  metadata: Record<string, unknown>;
  attempts: AttemptView[];
  expiresAt: string | null;
  succeededAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const toAttempt = (r: any): AttemptView => ({
  id: r.id,
  seq: r.seq,
  methodClass: r.method_class,
  rail: r.rail,
  connector: r.connector,
  operatorId: r.operator_id,
  providerRef: r.provider_ref,
  gatewayPaymentId: r.gateway_payment_id,
  transactionId: r.transaction_id,
  status: r.status,
  failureCategory: r.failure_category,
  error: r.error,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export function getIntentRow(id: string): IntentRow {
  const r = getDb().prepare('SELECT * FROM payment_intents WHERE id = ?').get(id) as IntentRow | undefined;
  if (!r) throw notFound('Payment intent not found', 'intent_not_found');
  return r;
}
export function listAttempts(intentId: string): AttemptView[] {
  return (getDb().prepare('SELECT * FROM payment_attempts WHERE intent_id = ? ORDER BY seq').all(intentId) as any[]).map(toAttempt);
}
export function intentView(r: IntentRow): IntentView {
  const qr = r.qr_id ? (getDb().prepare('SELECT payload FROM qr_codes WHERE id = ?').get(r.qr_id) as any) : null;
  const request = r.payment_request_id ? (getDb().prepare('SELECT code FROM payment_requests WHERE id = ?').get(r.payment_request_id) as any) : null;
  return {
    id: r.id,
    object: 'payment_intent',
    merchantId: r.merchant_user_id,
    amount: { valueMinor: r.amount_minor, currency: r.currency },
    captureMethod: r.capture_method,
    methodPolicy: r.method_policy,
    rails: parseJson<string[]>(r.rails, []),
    reference: r.reference,
    description: r.description,
    purposeCode: r.purpose_code,
    status: r.status,
    source: r.source,
    qrId: r.qr_id,
    qrPayload: qr?.payload ?? null,
    uri: `bitripay://pay/${r.id}`,
    checkoutUrl: request ? `${config.webUrl}/pay/${request.code}` : null,
    paymentRequestCode: request?.code ?? null,
    locationId: r.location_id,
    terminalId: r.terminal_id,
    customer: { userId: r.customer_user_id, msisdn: r.customer_msisdn, country: r.customer_country },
    routeConnector: r.route_connector,
    transactionId: r.transaction_id,
    metadata: parseJson(r.metadata, {}),
    attempts: listAttempts(r.id),
    expiresAt: r.expires_at,
    succeededAt: r.succeeded_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Canonical state → event-store state. */
function eventState(to: IntentState): string | null {
  switch (to) {
    case 'CREATED':
    case 'REQUIRES_PAYMENT_METHOD':
      return 'INITIATED';
    case 'ROUTING':
    case 'REQUIRES_CUSTOMER_ACTION':
    case 'PROCESSING':
    case 'AUTHORISED':
      return 'PENDING';
    case 'CAPTURED':
    case 'SETTLEMENT_PENDING':
    case 'SETTLED':
      return 'CONFIRMED';
    case 'FAILED':
    case 'EXPIRED':
    case 'CANCELLED':
      return 'FAILED';
    case 'AMBIGUOUS':
    case 'UNKNOWN_PROVIDER_STATE':
      return 'AMBIGUOUS';
    case 'REVERSED':
    case 'REFUNDED':
    case 'PARTIALLY_REFUNDED':
      return 'REVERSED';
    default:
      return null;
  }
}

/** Append to the payment event store (append-only; the ledger link is asserted by Guardian). */
export function appendPaymentEvent(input: {
  intentId: string | null;
  attemptId?: string | null;
  state: string;
  source: string;
  direction: 'in' | 'out' | 'internal';
  amountMinor: number;
  currency: string;
  transactionId?: string | null;
  counterparty?: Record<string, unknown> | null;
  evidence?: unknown[];
  payload?: Record<string, unknown>;
  occurredAt?: string;
}) {
  const id = uuid();
  getDb()
    .prepare(
      'INSERT INTO payment_events (event_id, occurred_at, recorded_at, source, direction, state, intent_id, attempt_id, amount_minor, currency, counterparty, evidence, payload, transaction_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      id,
      input.occurredAt ?? now(),
      now(),
      input.source,
      input.direction,
      input.state,
      input.intentId,
      input.attemptId ?? null,
      input.amountMinor,
      input.currency,
      input.counterparty ? JSON.stringify(input.counterparty) : null,
      JSON.stringify(input.evidence ?? []),
      JSON.stringify(input.payload ?? {}),
      input.transactionId ?? null,
    );
  return id;
}

export function transitionIntent(id: string, to: IntentState, actor: Actor, details: Record<string, unknown> = {}): IntentRow {
  const db = getDb();
  return db.transaction(() => {
    const r = getIntentRow(id);
    if (r.status === to) return r;
    if (!TRANSITIONS[r.status].includes(to)) throw conflict(`Payment intent cannot move from ${r.status} to ${to}`, 'invalid_intent_transition');
    const extra: string[] = [];
    const params: unknown[] = [to, now()];
    if (to === 'AMBIGUOUS' || to === 'UNKNOWN_PROVIDER_STATE') {
      extra.push('ambiguous_since = COALESCE(ambiguous_since, ?)');
      params.push(now());
    }
    if (to === 'CAPTURED') {
      extra.push('succeeded_at = ?');
      params.push(now());
    }
    db.prepare(`UPDATE payment_intents SET status = ?, updated_at = ?${extra.length ? `, ${extra.join(', ')}` : ''} WHERE id = ?`).run(...params, id);
    recordEvent('payment', id, `intent.${to.toLowerCase()}`, actor, { from: r.status, to, ...details });
    const es = eventState(to);
    if (es && es !== eventState(r.status))
      appendPaymentEvent({
        intentId: id,
        attemptId: (details.attemptId as string) ?? null,
        state: es,
        source: String(details.source ?? actor.type),
        direction: 'in',
        amountMinor: r.amount_minor ?? 0,
        currency: r.currency,
        transactionId: (details.transactionId as string) ?? r.transaction_id ?? null,
        payload: { from: r.status, to },
      });
    return getIntentRow(id);
  })();
}

export interface CreateIntentInput {
  amountMinor?: number | null;
  currency: string;
  rails?: string[];
  captureMethod?: 'automatic' | 'manual';
  methodPolicy?: 'smart' | 'cheapest' | 'fastest' | 'most_reliable';
  reference?: string | null;
  description?: string | null;
  purposeCode?: string | null;
  expiresInMinutes?: number | null;
  metadata?: Record<string, unknown>;
  customerMsisdn?: string | null;
  customerUserId?: string | null;
  customerCountry?: string | null;
  locationId?: string | null;
  terminalId?: string | null;
  source?: 'api' | 'qr' | 'link' | 'checkout' | 'pos' | 'ussd' | 'invoice';
  idemKey?: string | null;
  settlementProfileId?: string | null;
  successUrl?: string | null;
  cancelUrl?: string | null;
  allowedMethods?: string[];
  /** Static QR scans create the intent with the scanned code. */
  qrId?: string | null;
}

export const DEFAULT_RAILS = ['wallet', 'mpesa', 'airtel', 'orange', 'card', 'bank'];

/** Create an intent for a merchant (or any account holder: P2P and agent QR use the same object). */
export function createIntent(merchant: UserRow, input: CreateIntentInput): { row: IntentRow; clientSecret: string } {
  assertMoneyMovementAllowed('intent');
  assertKybIfRequired(merchant);
  const cur = getCurrency(input.currency);
  if (input.amountMinor != null && (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0)) throw badRequest('Amount must be a positive integer in minor units', 'invalid_amount');
  const caps = countryCapabilities(merchant.country);
  if (caps.collectionCurrencies.length && !caps.collectionCurrencies.includes(cur.code) && merchant.country)
    throw badRequest(`${cur.code} cannot be collected in ${merchant.country}`, 'currency_not_collectable');
  if (input.purposeCode && !caps.purposeCodes.includes(input.purposeCode)) throw badRequest('Unsupported purpose code', 'invalid_purpose');
  const db = getDb();
  if (input.idemKey) {
    const existing = db.prepare('SELECT * FROM payment_intents WHERE merchant_user_id = ? AND idem_key = ?').get(merchant.id, input.idemKey) as IntentRow | undefined;
    if (existing) return { row: existing, clientSecret: '' };
  }
  const id = `pi_${shortCode(20).toLowerCase()}`;
  const secret = `${id}_secret_${randomBytes(18).toString('base64url')}`;
  const minutes = input.expiresInMinutes ?? (input.source === 'link' ? 60 * 24 * 7 : 30);
  const expiresAt = minutes > 0 ? new Date(Date.now() + minutes * 60_000).toISOString() : null;
  const rails = (input.rails?.length ? input.rails : DEFAULT_RAILS).map((r) => r.toLowerCase());
  return db.transaction(() => {
    // Execution object: the payment request that the wallet, QR and hosted checkout flows already settle.
    const request = createPaymentRequest(merchant, {
      kind: input.source === 'link' ? 'link' : 'qr',
      amount: input.amountMinor ?? null,
      currency: cur.code,
      description: input.description ?? input.reference ?? null,
      expiresInMinutes: minutes > 0 ? minutes : null,
      successUrl: input.successUrl ?? null,
      cancelUrl: input.cancelUrl ?? null,
      allowedMethods: input.allowedMethods ?? [],
      metadata: { ...(input.metadata ?? {}), intentId: id, purposeCode: input.purposeCode ?? null, reference: input.reference ?? null },
    });
    db.prepare(
      'INSERT INTO payment_intents (id, organisation_id, merchant_user_id, amount_minor, currency, capture_method, method_policy, rails, reference, description, purpose_code, status, source, qr_id, payment_request_id, location_id, terminal_id, customer_user_id, customer_msisdn, customer_country, settlement_profile_id, client_secret_hash, idem_key, metadata, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      null,
      merchant.id,
      input.amountMinor ?? null,
      cur.code,
      input.captureMethod ?? 'automatic',
      input.methodPolicy ?? 'smart',
      JSON.stringify(rails),
      input.reference ?? null,
      input.description ?? null,
      input.purposeCode ?? null,
      input.amountMinor ? 'REQUIRES_PAYMENT_METHOD' : 'CREATED',
      input.source ?? 'api',
      input.qrId ?? null,
      request.id,
      input.locationId ?? null,
      input.terminalId ?? null,
      input.customerUserId ?? null,
      input.customerMsisdn ?? null,
      input.customerCountry ?? null,
      input.settlementProfileId ?? null,
      sha256(secret),
      input.idemKey ?? null,
      JSON.stringify(input.metadata ?? {}),
      expiresAt,
      now(),
      now(),
    );
    db.prepare('UPDATE payment_requests SET intent_id = ? WHERE id = ?').run(id, request.id);
    recordEvent(
      'payment',
      id,
      'intent.created',
      { type: merchant.role === 'admin' ? 'admin' : 'merchant', id: merchant.id },
      { amount: input.amountMinor ?? null, currency: cur.code, source: input.source ?? 'api', purpose: input.purposeCode ?? null },
    );
    appendPaymentEvent({
      intentId: id,
      state: 'INITIATED',
      source: input.source ?? 'api',
      direction: 'in',
      amountMinor: input.amountMinor ?? 0,
      currency: cur.code,
      payload: { reference: input.reference ?? null },
    });
    return { row: getIntentRow(id), clientSecret: secret };
  })();
}

export function verifyClientSecret(row: IntentRow, secret: string | null | undefined): boolean {
  return !!secret && !!row.client_secret_hash && sha256(secret) === row.client_secret_hash;
}

/** Fill the amount of an open-amount (static QR) intent once the payer enters it. */
export function setIntentAmount(id: string, amountMinor: number, actor: Actor): IntentRow {
  const r = getIntentRow(id);
  if (r.status !== 'CREATED') throw conflict('Amount can only be set before a payment method is chosen', 'intent_not_open');
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw badRequest('Amount must be a positive integer', 'invalid_amount');
  getDb().prepare('UPDATE payment_intents SET amount_minor = ?, updated_at = ? WHERE id = ?').run(amountMinor, now(), id);
  if (r.payment_request_id) getDb().prepare('UPDATE payment_requests SET amount = ? WHERE id = ?').run(amountMinor, r.payment_request_id);
  return transitionIntent(id, 'REQUIRES_PAYMENT_METHOD', actor, { amount: amountMinor });
}

/** One attempt in flight at a time: a second attempt is blocked until the first resolves (never double-push). */
export function startAttempt(
  intentId: string,
  input: { methodClass: string; rail?: string | null; connector?: string | null; operatorId?: string | null; gatewayPaymentId?: string | null; providerRef?: string | null },
  actor: Actor,
): AttemptView {
  assertMoneyMovementAllowed('attempt');
  const db = getDb();
  return db.transaction(() => {
    const r = getIntentRow(intentId);
    if (TERMINAL_INTENT_STATES.includes(r.status) || ['CAPTURED', 'SETTLEMENT_PENDING', 'AUTHORISED'].includes(r.status)) throw conflict(`Payment intent is ${r.status}`, 'intent_closed');
    if (r.expires_at && r.expires_at < now()) {
      transitionIntent(intentId, 'EXPIRED', { type: 'system' });
      throw conflict('Payment intent has expired', 'intent_expired');
    }
    if (!r.amount_minor) throw badRequest('Intent has no amount yet', 'amount_required');
    const open = db.prepare("SELECT * FROM payment_attempts WHERE intent_id = ? AND status IN ('CREATED', 'PROCESSING', 'AUTHORISED', 'UNKNOWN') ORDER BY seq DESC LIMIT 1").get(intentId) as any;
    if (open) throw conflict(`Attempt ${open.id} is still ${open.status.toLowerCase()}; a new attempt is blocked until it resolves`, 'attempt_in_flight');
    const seq = ((db.prepare('SELECT MAX(seq) m FROM payment_attempts WHERE intent_id = ?').get(intentId) as any).m ?? 0) + 1;
    const id = `pa_${shortCode(16).toLowerCase()}`;
    db.prepare(
      'INSERT INTO payment_attempts (id, intent_id, seq, method_class, rail, connector, operator_id, provider_ref, gateway_payment_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, intentId, seq, input.methodClass, input.rail ?? null, input.connector ?? null, input.operatorId ?? null, input.providerRef ?? null, input.gatewayPaymentId ?? null, 'PROCESSING', now());
    if (input.connector) db.prepare('UPDATE payment_intents SET route_connector = ?, updated_at = ? WHERE id = ?').run(input.connector, now(), intentId);
    if (r.status !== 'PROCESSING') {
      if (r.status === 'REQUIRES_PAYMENT_METHOD' || r.status === 'ROUTING' || r.status === 'UNDER_REVIEW')
        transitionIntent(intentId, input.methodClass === 'wallet' ? 'PROCESSING' : 'REQUIRES_CUSTOMER_ACTION', actor, {
          attemptId: id,
          methodClass: input.methodClass,
          connector: input.connector ?? null,
        });
      else if (r.status === 'REQUIRES_CUSTOMER_ACTION') transitionIntent(intentId, 'PROCESSING', actor, { attemptId: id });
    }
    recordEvent('payment', intentId, 'attempt.started', actor, { attemptId: id, seq, methodClass: input.methodClass, connector: input.connector ?? null });
    return toAttempt(db.prepare('SELECT * FROM payment_attempts WHERE id = ?').get(id));
  })();
}

/** Resolve an attempt from an authoritative outcome and move the intent accordingly. Never called from a screen. */
export function finishAttempt(
  attemptId: string,
  outcome: 'CAPTURED' | 'AUTHORISED' | 'FAILED' | 'UNKNOWN' | 'ABANDONED',
  details: { failureCategory?: string | null; error?: string | null; providerRef?: string | null; transactionId?: string | null; gatewayPaymentId?: string | null; source?: string },
  actor: Actor,
): { attempt: AttemptView; intent: IntentRow } {
  const db = getDb();
  return db.transaction(() => {
    const a = db.prepare('SELECT * FROM payment_attempts WHERE id = ?').get(attemptId) as any;
    if (!a) throw notFound('Attempt not found', 'attempt_not_found');
    if (['CAPTURED', 'FAILED', 'ABANDONED'].includes(a.status) && a.status === outcome) return { attempt: toAttempt(a), intent: getIntentRow(a.intent_id) };
    db.prepare(
      'UPDATE payment_attempts SET status = ?, failure_category = ?, error = ?, provider_ref = COALESCE(?, provider_ref), transaction_id = COALESCE(?, transaction_id), gateway_payment_id = COALESCE(?, gateway_payment_id), finished_at = ? WHERE id = ?',
    ).run(
      outcome,
      details.failureCategory ?? null,
      details.error ?? null,
      details.providerRef ?? null,
      details.transactionId ?? null,
      details.gatewayPaymentId ?? null,
      outcome === 'UNKNOWN' || outcome === 'AUTHORISED' ? null : now(),
      attemptId,
    );
    const r = getIntentRow(a.intent_id);
    let intent = r;
    if (outcome === 'CAPTURED') {
      if (details.transactionId)
        db.prepare('UPDATE payment_intents SET transaction_id = ?, gateway_payment_id = COALESCE(?, gateway_payment_id), updated_at = ? WHERE id = ?').run(
          details.transactionId,
          details.gatewayPaymentId ?? null,
          now(),
          r.id,
        );
      if (details.transactionId) db.prepare('UPDATE transactions SET intent_id = ? WHERE id = ?').run(r.id, details.transactionId);
      if (r.status !== 'CAPTURED' && r.status !== 'SETTLEMENT_PENDING' && r.status !== 'SETTLED') {
        if (!TRANSITIONS[r.status].includes('CAPTURED')) transitionIntent(r.id, 'PROCESSING', actor, { attemptId });
        intent = transitionIntent(r.id, 'CAPTURED', actor, { attemptId, transactionId: details.transactionId ?? null, source: details.source ?? actor.type });
        intent = transitionIntent(r.id, 'SETTLEMENT_PENDING', { type: 'system' }, { attemptId });
      }
      const merchant = findUserById(r.merchant_user_id);
      if (merchant) void dispatchWebhook(merchant.id, 'payment_intent.succeeded', { paymentIntent: intentView(getIntentRow(r.id)) }, { resource: { type: 'payment_intent', id: r.id } });
      completeCheckoutSessionForIntent(r.id);
      // Marketplace / cooperative splits declared on the intent: paid from the merchant wallet as distribution transactions.
      try {
        const shares = applySplits(r.id);
        if (shares.some((s) => s.status === 'FAILED')) console.warn(`[intents] ${r.id}: ${shares.filter((s) => s.status === 'FAILED').length} split share(s) failed`);
      } catch (err) {
        console.error(`[intents] split payout failed for ${r.id}: ${(err as Error).message}`);
      }
    } else if (outcome === 'AUTHORISED') {
      intent = transitionIntent(r.id, 'AUTHORISED', actor, { attemptId });
    } else if (outcome === 'UNKNOWN') {
      intent = transitionIntent(r.id, r.status === 'PROCESSING' || r.status === 'REQUIRES_CUSTOMER_ACTION' ? 'AMBIGUOUS' : 'UNKNOWN_PROVIDER_STATE', actor, {
        attemptId,
        reason: details.error ?? 'provider outcome unknown',
      });
      publish(
        'attempt.unknown',
        { intentId: r.id, attemptId, connector: a.connector, method: a.method_class, amountMinor: r.amount_minor, currency: r.currency, error: details.error ?? null },
        { aggregateId: r.id, tenantId: r.merchant_user_id },
      );
      const merchant = findUserById(r.merchant_user_id);
      if (merchant) void dispatchWebhook(merchant.id, 'payment_intent.ambiguous_hold', { paymentIntent: intentView(intent), attemptId }, { resource: { type: 'payment_intent', id: r.id } });
    } else {
      // FAILED / ABANDONED: retryable failures return the intent to method selection (recovery), others close it
      const cat = details.failureCategory ?? null;
      const retryable = !(cat && NON_RETRYABLE_FAILURES.has(cat)) && (outcome === 'ABANDONED' || (cat ? RETRYABLE_FAILURES.has(cat) : false));
      const expired = r.expires_at && r.expires_at < now();
      if (retryable && !expired && r.status !== 'CAPTURED')
        intent = transitionIntent(r.id, 'REQUIRES_PAYMENT_METHOD', actor, { attemptId, failureCategory: details.failureCategory ?? null, recovery: true });
      else {
        intent = transitionIntent(r.id, expired ? 'EXPIRED' : 'FAILED', actor, { attemptId, failureCategory: details.failureCategory ?? null, error: details.error ?? null });
        const merchant = findUserById(r.merchant_user_id);
        if (merchant)
          void dispatchWebhook(
            merchant.id,
            'payment_intent.failed',
            { paymentIntent: intentView(intent), attemptId, failureCategory: details.failureCategory ?? null },
            { resource: { type: 'payment_intent', id: r.id } },
          );
      }
    }
    recordEvent('payment', r.id, `attempt.${outcome.toLowerCase()}`, actor, { attemptId, failureCategory: details.failureCategory ?? null, providerRef: details.providerRef ?? null });
    // Smart Route telemetry: the connector's own faults trip the breaker; customer declines only count as attempts.
    const latency = a.started_at ? Date.now() - Date.parse(a.started_at) : null;
    const connectorFault = details.failureCategory ? ['provider_unavailable', 'timeout_before_send'].includes(details.failureCategory) : false;
    recordRoutingOutcome(
      a.connector,
      a.method_class,
      outcome === 'CAPTURED' || outcome === 'AUTHORISED' ? 'success' : outcome === 'UNKNOWN' ? 'unknown' : connectorFault ? 'failure' : 'decline',
      latency,
    );
    return { attempt: toAttempt(db.prepare('SELECT * FROM payment_attempts WHERE id = ?').get(attemptId)), intent };
  })();
}

/** Called by the payment-request flows once the ledger posted (wallet pay, gateway settlement, evidence). */
export function onRequestPaid(request: PaymentRequestRow, transactionId: string, methodClass: string, actor: Actor, gatewayPaymentId?: string | null) {
  if (!request.intent_id) return;
  const r = getDb().prepare('SELECT * FROM payment_intents WHERE id = ?').get(request.intent_id) as IntentRow | undefined;
  if (!r) return;
  let attempt =
    (getDb().prepare("SELECT * FROM payment_attempts WHERE intent_id = ? AND status IN ('CREATED', 'PROCESSING', 'AUTHORISED', 'UNKNOWN') ORDER BY seq DESC LIMIT 1").get(r.id) as any) ??
    (gatewayPaymentId ? getDb().prepare('SELECT * FROM payment_attempts WHERE gateway_payment_id = ?').get(gatewayPaymentId) : null);
  if (!attempt) {
    if (!r.amount_minor && request.amount) getDb().prepare('UPDATE payment_intents SET amount_minor = ?, updated_at = ? WHERE id = ?').run(request.amount, now(), r.id);
    if (r.status === 'CREATED') transitionIntent(r.id, 'REQUIRES_PAYMENT_METHOD', actor);
    attempt = { id: startAttempt(r.id, { methodClass, gatewayPaymentId: gatewayPaymentId ?? null }, actor).id };
  }
  finishAttempt(attempt.id, 'CAPTURED', { transactionId, gatewayPaymentId: gatewayPaymentId ?? null, source: methodClass === 'wallet' ? 'ledger' : 'processor' }, actor);
}

/**
 * Before a new execution starts: if the open attempt's gateway payment already ended (expired, rejected, abandoned
 * before authentication) resolve it so the one-in-flight rule does not block a legitimate retry.
 */
export function reconcileOpenAttempt(intentId: string): void {
  const db = getDb();
  const open = db.prepare("SELECT * FROM payment_attempts WHERE intent_id = ? AND status IN ('CREATED', 'PROCESSING', 'AUTHORISED') ORDER BY seq DESC LIMIT 1").get(intentId) as any;
  if (!open?.gateway_payment_id) return;
  const gp = db.prepare('SELECT id, stage FROM gateway_payments WHERE id = ?').get(open.gateway_payment_id) as { id: string; stage: string } | undefined;
  if (!gp) return;
  if (gp.stage === 'CREATED' || gp.stage === 'AUTHENTICATION_REQUIRED') {
    // the customer never authenticated: nothing was sent to a provider, so the attempt is abandoned and the stale payment expires
    db.prepare("UPDATE gateway_payments SET stage = 'EXPIRED', status = 'failed', updated_at = ? WHERE id = ?").run(now(), gp.id);
    recordEvent('payment', gp.id, 'payment.expired', { type: 'system' }, { from: gp.stage, to: 'EXPIRED', reason: 'superseded_by_new_attempt' });
    finishAttempt(open.id, 'ABANDONED', { failureCategory: 'customer_abandoned', error: 'superseded by a new attempt', gatewayPaymentId: gp.id, source: 'system' }, { type: 'system' });
  } else if (gp.stage === 'EXPIRED' || gp.stage === 'REJECTED') {
    finishAttempt(open.id, 'FAILED', { failureCategory: gp.stage === 'EXPIRED' ? 'timeout_before_send' : 'declined', gatewayPaymentId: gp.id, source: 'system' }, { type: 'system' });
  }
}

/**
 * Mirror a gateway payment stage change onto its attempt. Settlement is handled by onRequestPaid (the ledger posting is
 * the authoritative event); here we translate rejections, expiries and review states.
 */
export function onGatewayPaymentStage(gatewayPaymentId: string, stage: string, actor: Actor, details: Record<string, unknown> = {}): void {
  const a = getDb().prepare("SELECT * FROM payment_attempts WHERE gateway_payment_id = ? AND status IN ('CREATED', 'PROCESSING', 'AUTHORISED', 'UNKNOWN')").get(gatewayPaymentId) as any;
  if (!a) return;
  const reason = typeof details.reason === 'string' ? details.reason : null;
  if (stage === 'REJECTED') {
    finishAttempt(a.id, 'FAILED', { failureCategory: categoriseFailure(reason), error: reason, gatewayPaymentId, source: actor.type }, actor);
  } else if (stage === 'EXPIRED') {
    finishAttempt(a.id, 'FAILED', { failureCategory: 'timeout_before_send', error: reason ?? 'no confirmation before expiry', gatewayPaymentId, source: 'system' }, actor);
  } else if (stage === 'MANUAL_REVIEW' || stage === 'MISMATCHED' || stage === 'DUPLICATE') {
    if (a.status !== 'UNKNOWN') finishAttempt(a.id, 'UNKNOWN', { error: reason ?? stage.toLowerCase(), gatewayPaymentId, source: actor.type }, actor);
  } else if (stage === 'DISPUTED') {
    const r = getIntentRow(a.intent_id);
    if (TRANSITIONS[r.status]?.includes('DISPUTED')) transitionIntent(r.id, 'DISPUTED', actor, { gatewayPaymentId, reason });
  }
}

/** Map a provider failure message to a canonical failure category (drives recovery: retryable or not). */
export function categoriseFailure(reason: string | null | undefined): string {
  const r = (reason ?? '').toLowerCase();
  if (/not found|unknown wallet|invalid (msisdn|number|phone)/.test(r)) return 'invalid_msisdn';
  if (/insufficient/.test(r)) return 'insufficient_funds';
  if (/unavailable|timeout|timed out|unreachable/.test(r)) return 'provider_unavailable';
  if (/limit/.test(r)) return 'limit_exceeded';
  if (/fraud|risk/.test(r)) return 'fraud_block';
  if (/sanction|compliance/.test(r)) return 'compliance_block';
  if (/expired|no confirmation/.test(r)) return 'timeout_before_send';
  return 'declined';
}

export function cancelIntent(id: string, actor: Actor, reason?: string | null): IntentRow {
  const r = getIntentRow(id);
  if (['CAPTURED', 'SETTLEMENT_PENDING', 'SETTLED'].includes(r.status)) throw conflict('A captured payment is refunded, not cancelled', 'intent_captured');
  const open = getDb().prepare("SELECT id FROM payment_attempts WHERE intent_id = ? AND status IN ('PROCESSING', 'UNKNOWN')").get(id) as any;
  if (open) throw conflict('An attempt is still in flight; wait for its outcome before cancelling', 'attempt_in_flight');
  const out = transitionIntent(id, 'CANCELLED', actor, { reason: reason ?? null });
  if (r.payment_request_id) getDb().prepare("UPDATE payment_requests SET status = 'cancelled' WHERE id = ? AND status = 'open'").run(r.payment_request_id);
  return out;
}

export function expireIntents(): number {
  const db = getDb();
  const rows = db
    .prepare("SELECT id FROM payment_intents WHERE expires_at IS NOT NULL AND expires_at < ? AND status IN ('CREATED', 'REQUIRES_PAYMENT_METHOD', 'ROUTING', 'REQUIRES_CUSTOMER_ACTION')")
    .all(now()) as { id: string }[];
  let n = 0;
  for (const r of rows) {
    const open = db.prepare("SELECT id FROM payment_attempts WHERE intent_id = ? AND status IN ('PROCESSING', 'UNKNOWN')").get(r.id);
    if (open) continue; // an in-flight attempt keeps the intent alive until the provider outcome is known
    try {
      transitionIntent(r.id, 'EXPIRED', { type: 'system' });
      n++;
    } catch {
      /* raced */
    }
  }
  return n;
}

/** Method discovery: what this payer may use for this intent, from rails, country capabilities and enabled gateways. */
export function discoverMethods(r: IntentRow, payer: UserRow | null, payerCountry?: string | null) {
  const merchant = findUserById(r.merchant_user_id);
  const rails = parseJson<string[]>(r.rails, DEFAULT_RAILS);
  const caps = countryCapabilities(merchant?.country ?? null);
  const gw = merchant ? getGatewaySettings(merchant) : null;
  const allowed = gw?.methods ?? ['wallet', 'card', 'mobile_money', 'bank'];
  const options = paymentOptions(r.currency, payerCountry ?? merchant?.country ?? null, 'checkout');
  const list: { methodClass: string; label: string; available: boolean; reason?: string; operators?: unknown[]; gateways?: unknown[]; crossBorder?: boolean }[] = [];
  list.push({
    methodClass: 'wallet',
    label: 'BitriPay balance',
    available: rails.includes('wallet') && caps.wallet && allowed.includes('wallet'),
    reason: payer ? undefined : 'sign in to pay from your balance',
  });
  const momo = options.find((o) => o.method === 'mobile_money');
  list.push({
    methodClass: 'mobile_money',
    label: 'Mobile money',
    available: caps.mobileMoney && !!momo && allowed.includes('mobile_money') && rails.some((x) => ['mpesa', 'airtel', 'orange', 'mobile_money'].includes(x)),
    operators: momo?.operators,
    gateways: momo?.gateways,
  });
  const card = options.find((o) => o.method === 'card');
  list.push({ methodClass: 'card', label: 'Card', available: caps.cardCollection && !!card && allowed.includes('card') && rails.includes('card'), gateways: card?.gateways });
  const bank = options.find((o) => o.method === 'bank');
  list.push({ methodClass: 'bank', label: 'Bank transfer', available: !!bank && allowed.includes('bank') && rails.includes('bank'), gateways: bank?.gateways });
  // Smart Route: rank the connectors of each method for this intent's policy; the recommended one is what the
  // checkout uses when the payer expresses no preference, and the failed connector of the last attempt is avoided.
  const lastFailed = listAttempts(r.id)
    .filter((a) => a.status === 'FAILED' && ['provider_unavailable', 'timeout_before_send'].includes(a.failureCategory ?? ''))
    .map((a) => a.connector);
  for (const m of list) {
    const gws = (m.gateways as { id: string }[] | undefined) ?? [];
    if (!gws.length) continue;
    const candidates: RouteCandidate[] = gws.map((g, i) => ({ id: g.id, method: m.methodClass, preferenceRank: i }));
    const { id, scores } = pickConnector(
      candidates.filter((c) => !lastFailed.includes(c.id)).length ? candidates.filter((c) => !lastFailed.includes(c.id)) : candidates,
      (r.method_policy as any) ?? 'smart',
    );
    (m as any).recommendedGateway = id;
    (m as any).routeScores = scores.map((sc) => ({ id: sc.id, score: sc.score, usable: sc.usable, reason: sc.reason }));
  }
  const crossBorder = !!payerCountry && !!merchant?.country && payerCountry.toUpperCase() !== merchant.country.toUpperCase();
  if (crossBorder)
    list.push({
      methodClass: 'diaspora',
      label: 'Pay from abroad in your currency',
      available: caps.crossBorder && rails.includes('diaspora') && countryCapabilities(payerCountry).crossBorder,
      crossBorder: true,
    });
  if (rails.includes('bitcoin')) list.push({ methodClass: 'bitcoin', label: 'Bitcoin / Lightning', available: caps.bitcoin, reason: caps.bitcoin ? undefined : 'not enabled in this country' });
  return list;
}

/** The operations timeline (digital twin): events, attempts and ledger references in order. */
export function intentTimeline(id: string) {
  const db = getDb();
  const events = db.prepare('SELECT * FROM event_log WHERE subject_id = ? ORDER BY seq').all(id) as any[];
  const store = db.prepare('SELECT * FROM payment_events WHERE intent_id = ? ORDER BY occurred_at').all(id) as any[];
  return {
    intent: intentView(getIntentRow(id)),
    timeline: events.map((e) => ({ at: e.created_at ?? e.occurred_at, event: e.event, actor: e.actor_type ?? e.actor, details: parseJson(e.details, {}) })),
    paymentEvents: store.map((e) => ({ id: e.event_id, at: e.occurred_at, state: e.state, source: e.source, amountMinor: e.amount_minor, currency: e.currency, transactionId: e.transaction_id })),
  };
}

export function listIntents(filter: { merchantUserId?: string | null; status?: string | null; limit?: number } = {}): IntentView[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.merchantUserId) {
    where.push('merchant_user_id = ?');
    params.push(filter.merchantUserId);
  }
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  return (
    getDb()
      .prepare(`SELECT * FROM payment_intents ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, filter.limit ?? 50) as IntentRow[]
  ).map(intentView);
}

/** Merchant identity for the trust layer. */
export function merchantIdentity(merchantUserId: string, locationId?: string | null) {
  const m = findUserById(merchantUserId);
  if (!m) throw notFound('Merchant not found', 'merchant_not_found');
  const loc = locationId ? (getDb().prepare('SELECT * FROM merchant_locations WHERE id = ?').get(locationId) as any) : null;
  return {
    ...toPublicUser(m),
    businessName: m.business_name,
    verified: m.kyc_status === 'verified',
    kycStatus: m.kyc_status,
    country: m.country,
    location: loc ? { id: loc.id, name: loc.name, city: loc.city, address: loc.address } : null,
  };
}
