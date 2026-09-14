/**
 * Gateway contract: the specification's webhook catalogue and receiver rules, idempotency-key hygiene (409, endpoint
 * binding, 24 h expiry), the refund lifecycle with a real REJECTED state, REVERSED reachable only through a refund,
 * manual capture end to end on the sandbox rail, the partner endpoints (FX quotes, payment resolution, money requests,
 * ledger transaction detail), step-up on live API keys / rotation / high-value refunds, and sanctions screening at
 * intent creation (synchronous cross-border, asynchronous domestic).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, adminToken, fund } from './helpers';
import { getDb } from '../db';
import { WEBHOOK_CATALOGUE_NOTES, WEBHOOK_EVENT_TYPES } from '../services/webhooks';
import { purgeExpiredIdempotencyKeys, idempotencyEndpoint } from '../middleware/idempotency';
import { getIntentRow, transitionIntent, screenPendingSanctions, listAttempts } from '../services/intents';
import { REFUND_LIFECYCLE, highValueRefundThreshold } from '../services/gateway';
import { getSetting, setSetting } from '../services/settings';
import { addSanction } from '../services/risk';
import { closeCycle } from '../services/finops/settlement';
import { openDispute } from '../services/finops/disputes';
import { now } from '../lib/ids';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

const eventTypes = (userId: string, type: string) =>
  getDb().prepare('SELECT id, data FROM webhook_events WHERE user_id = ? AND type = ? ORDER BY created_at').all(userId, type) as { id: string; data: string }[];
const domainEvents = (type: string) => getDb().prepare('SELECT payload FROM domain_events WHERE type = ? ORDER BY occurred_at').all(type) as { payload: string }[];

async function merchantWithTestKey(country = 'CD') {
  const m = await registerUser(app, { role: 'merchant', businessName: `Contract ${Math.random().toString(36).slice(2, 7)}`, country });
  const key = await request(app).post('/api/v1/api_keys').set(m.auth).send({ label: 'test', mode: 'test' });
  expect(key.status, JSON.stringify(key.body)).toBe(201);
  return { ...m, key: { Authorization: `Bearer ${key.body.secret as string}` } };
}

/** A sandbox-settled intent: the real attempt machine, magic MSISDN "succeed", ledger posting to the merchant wallet. */
async function settledIntent(m: Awaited<ReturnType<typeof merchantWithTestKey>>, amountMinor: number, extra: Record<string, unknown> = {}) {
  const pi = await request(app)
    .post('/api/v1/payment_intents')
    .set(m.key)
    .send({ currency: 'USD', amount_minor: amountMinor, ...extra });
  expect(pi.status, JSON.stringify(pi.body)).toBe(201);
  const sim = await request(app).post('/api/v1/sandbox/simulate').set(m.key).send({ payment_intent: pi.body.id, outcome: 'succeed' });
  expect(sim.status, JSON.stringify(sim.body)).toBe(200);
  return { intent: pi.body, sim: sim.body };
}

describe('webhook event catalogue', () => {
  it('lists the specification events with descriptions and ships the receiver rules as notes', async () => {
    const res = await request(app).get('/api/v1/webhook_events/types');
    expect(res.status).toBe(200);
    expect(res.body.notes).toEqual([
      'Deliveries are at-least-once: dedupe by event id.',
      'A successful screen is not proof of payment; only a ledger posting is.',
      "We surface reality; we don't hide it: AMBIGUOUS means we do not know yet.",
      'Verified holds are applied per risk appetite before funds become available.',
    ]);
    expect(res.body.notes).toEqual([...WEBHOOK_CATALOGUE_NOTES]);
    const types = (res.body.data as { type: string; description: string }[]).map((t) => t.type);
    for (const t of [
      'payment_intent.authorised',
      'verification.confirmed',
      'payout.processing',
      'payout.succeeded',
      'payout.settled',
      'settlement.created',
      'settlement.completed',
      'dispute.opened',
      'refund.created',
      'refund.updated',
      'payment_intent.succeeded',
    ])
      expect(types, t).toContain(t);
    expect(new Set(types).size).toBe(types.length); // no duplicate names
    for (const t of WEBHOOK_EVENT_TYPES) expect(t.description.length, t.type).toBeGreaterThan(20);
    expect(res.body.api_version).toBeTruthy();
  });

  it('emits settlement.created once when a cycle closes (both bus names describe one moment) and dispute.opened next to payment_intent.disputed', async () => {
    const m = await merchantWithTestKey();
    const { intent } = await settledIntent(m, 2500, { reference: 'CYCLE-1' });
    const cycle = closeCycle(m.user.id, 'USD');
    expect(cycle.id).toBeTruthy();
    const created = eventTypes(m.user.id, 'settlement.created');
    expect(created).toHaveLength(1);
    expect(JSON.parse(created[0].data).data.cycleId).toBe(cycle.id);

    const admin = await adminToken(app);
    const adminUser = (await request(app).get('/api/account/me').set(admin.auth)).body.user;
    const dispute = openDispute({ intentId: intent.id, openedBy: 'customer', reasonCode: 'not_received' }, { type: 'admin', id: adminUser?.id ?? 'admin' });
    expect(dispute.id).toBeTruthy();
    expect(eventTypes(m.user.id, 'payment_intent.disputed')).toHaveLength(1);
    const opened = eventTypes(m.user.id, 'dispute.opened');
    expect(opened).toHaveLength(1);
    expect(JSON.parse(opened[0].data).data.dispute.id).toBe(dispute.id);
  });
});

describe('idempotency keys', () => {
  it('refuses a reused key with a different body or on a different endpoint with 409, binds the endpoint template and expires keys after 24 h', async () => {
    const m = await merchantWithTestKey();
    const body = { currency: 'USD', amount_minor: 700, reference: 'IDEM-1' };
    const first = await request(app).post('/api/v1/payment_intents').set(m.key).set('Idempotency-Key', 'k-contract-1').send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const replay = await request(app).post('/api/v1/payment_intents').set(m.key).set('Idempotency-Key', 'k-contract-1').send(body);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(first.body.id);
    const different = await request(app)
      .post('/api/v1/payment_intents')
      .set(m.key)
      .set('Idempotency-Key', 'k-contract-1')
      .send({ ...body, amount_minor: 701 });
    expect(different.status).toBe(409);
    expect(different.body.error.code).toBe('idempotency_key_reused');
    const elsewhere = await request(app).post('/api/v1/payment_links').set(m.key).set('Idempotency-Key', 'k-contract-1').send(body);
    expect(elsewhere.status).toBe(409);
    expect(elsewhere.body.error.code).toBe('idempotency_key_reused');
    expect(elsewhere.body.error.details.endpoint).toBe('POST /api/v1/payment_intents');

    const row = getDb().prepare("SELECT endpoint, expires_at, created_at FROM idempotency_keys WHERE key = 'k-contract-1'").get() as any;
    expect(row.endpoint).toBe('POST /api/v1/payment_intents');
    const ttlHours = (new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()) / 3600_000;
    expect(Math.round(ttlHours)).toBe(24);
    expect(idempotencyEndpoint('POST', `/api/v1/payment_intents/${first.body.id}/capture`)).toBe('POST /api/v1/payment_intents/{id}/capture');

    // expired keys are purged (throttled to once a minute; forced here) and an expired key may be used again
    getDb()
      .prepare("UPDATE idempotency_keys SET expires_at = ? WHERE key = 'k-contract-1'")
      .run(new Date(Date.now() - 1000).toISOString());
    expect(purgeExpiredIdempotencyKeys(true)).toBeGreaterThanOrEqual(1);
    const fresh = await request(app)
      .post('/api/v1/payment_intents')
      .set(m.key)
      .set('Idempotency-Key', 'k-contract-1')
      .send({ ...body, amount_minor: 702 });
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(201);
    expect(fresh.headers['idempotent-replayed']).toBeUndefined(); // handled as a new request by the middleware (the intent service keeps its own idem_key dedupe)
    const renewed = getDb().prepare("SELECT expires_at FROM idempotency_keys WHERE key = 'k-contract-1'").get() as any;
    expect(new Date(renewed.expires_at).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('refund lifecycle', () => {
  it('maps stored statuses onto the specification lifecycle, rejects a refund awaiting execution and publishes refund.succeeded on the domain bus', async () => {
    expect([...REFUND_LIFECYCLE]).toEqual(['REQUESTED', 'APPROVED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'REJECTED', 'REVERSED']);
    const m = await merchantWithTestKey();
    await fund(app, m.user.id, '5.00', 'USD');
    const { intent } = await settledIntent(m, 3000, { reference: 'RF-1' });
    const before = domainEvents('refund.succeeded').length;
    const ok = await request(app).post('/api/v1/refunds').set(m.key).send({ payment_intent: intent.id, amount_minor: 1000, reason: 'partial' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.status).toBe('SUCCEEDED');
    expect(ok.body.lifecycle).toBe('SUCCEEDED');
    expect(ok.body.rejection).toBeNull();
    const bus = domainEvents('refund.succeeded');
    expect(bus).toHaveLength(before + 1);
    expect(JSON.parse(bus[bus.length - 1].payload)).toMatchObject({ intentId: intent.id, refundId: ok.body.id, amountMinor: 1000, currency: 'USD', merchantUserId: m.user.id, merchantId: m.user.id });
    const list = await request(app).get('/api/v1/refunds').set(m.key);
    expect(list.body.lifecycle).toEqual([...REFUND_LIFECYCLE]);
    // a SUCCEEDED refund cannot be rejected
    const late = await request(app).post(`/api/v1/refunds/${ok.body.id}/reject`).set(m.key).send({ reason: 'too late' });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('refund_not_rejectable');

    // A refund on a rail without a refund API is parked as MANUAL (lifecycle APPROVED) by the executor, reserving the
    // amount until operations execute it or the merchant rejects it. Sandbox rails settle through the treasury wallet,
    // so that executor branch is not reachable over HTTP here: the parked row is written exactly as the executor does.
    const mk = await merchantWithTestKey();
    const parked = await settledIntent(mk, 25000, { reference: 'MANUAL-1' });
    const manualId = 're_contractmanual1';
    getDb()
      .prepare(
        "INSERT INTO refunds (id, intent_id, transaction_id, merchant_user_id, amount, currency, reason, status, method, requested_by, error, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, 5000, 'USD', 'customer request', 'MANUAL', 'processor', ?, 'no refund API – refund manually and record it', '{}', ?, ?)",
      )
      .run(manualId, parked.intent.id, parked.sim.paymentIntent.transactionId, mk.user.id, mk.user.id, now(), now());
    const manual = await request(app).get(`/api/v1/refunds/${manualId}`).set(mk.key);
    expect(manual.status, JSON.stringify(manual.body)).toBe(200);
    expect(manual.body.status).toBe('MANUAL');
    expect(manual.body.lifecycle).toBe('APPROVED');
    expect((await request(app).get(`/api/v1/payment_intents/${parked.intent.id}/refundable`).set(mk.key)).body.refundable).toBe(20000); // reserved while parked
    const pi = { body: { id: parked.intent.id } };
    const other = await merchantWithTestKey();
    expect((await request(app).post(`/api/v1/refunds/${manual.body.id}/reject`).set(other.key).send({ reason: 'not mine' })).status).toBe(404);
    const rejected = await request(app).post(`/api/v1/refunds/${manual.body.id}/reject`).set(mk.key).send({ reason: 'goods were delivered after all' });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body.status).toBe('REJECTED');
    expect(rejected.body.lifecycle).toBe('REJECTED');
    expect(rejected.body.rejection).toMatchObject({ by: mk.user.id, reason: 'goods were delivered after all' });
    expect(getIntentRow(pi.body.id).status).toBe('SETTLEMENT_PENDING'); // the intent kept its prior state
    const refundable = await request(app).get(`/api/v1/payment_intents/${pi.body.id}/refundable`).set(mk.key);
    expect(refundable.body.refundable).toBe(25000); // the reservation was released
    const updates = eventTypes(mk.user.id, 'refund.updated').map((e) => JSON.parse(e.data).data.refund);
    expect(updates.some((r: any) => r.id === manual.body.id && r.status === 'REJECTED')).toBe(true);
    expect((await request(app).post(`/api/v1/refunds/${manual.body.id}/reject`).set(mk.key).send({ reason: 'again' })).body.error.code).toBe('refund_not_rejectable');
  });

  it('lets REVERSED be reached only through a refund object', async () => {
    const m = await merchantWithTestKey();
    const { intent } = await settledIntent(m, 1200);
    const row = getIntentRow(intent.id);
    expect(row.status).toBe('SETTLEMENT_PENDING');
    expect(() => transitionIntent(row.id, 'REVERSED', { type: 'admin', id: 'ops' }, { reason: 'operator decision' })).toThrowError(/only reachable through a refund/);
    try {
      transitionIntent(row.id, 'REVERSED', { type: 'system' });
    } catch (err: any) {
      expect(err.status).toBe(409);
      expect(err.code).toBe('reversal_requires_refund');
    }
    expect(getIntentRow(row.id).status).toBe('SETTLEMENT_PENDING');
    expect(transitionIntent(row.id, 'REVERSED', { type: 'system' }, { refundId: 're_contract' }).status).toBe('REVERSED');
  });
});

describe('manual capture', () => {
  it('lands a capture_method manual intent in AUTHORISED on the sandbox rail, holds the funds, captures a partial amount and returns the rest', async () => {
    const m = await merchantWithTestKey();
    await fund(app, m.user.id, '2.00', 'USD');
    const pi = await request(app).post('/api/v1/payment_intents').set(m.key).send({ currency: 'USD', amount_minor: 1500, capture_method: 'manual', reference: 'AUTH-1' });
    expect(pi.status, JSON.stringify(pi.body)).toBe(201);
    expect(pi.body.captureMethod).toBe('manual');
    const sim = await request(app).post('/api/v1/sandbox/simulate').set(m.key).send({ payment_intent: pi.body.id, outcome: 'succeed' });
    expect(sim.status, JSON.stringify(sim.body)).toBe(200);
    expect(sim.body.payment.stage).toBe('SETTLED');
    expect(sim.body.paymentIntent.status).toBe('AUTHORISED');
    expect(sim.body.paymentIntent.authorisedAt).toBeTruthy();
    expect(sim.body.paymentIntent.transactionId).toBeTruthy();
    expect(sim.body.attempts[0].status).toBe('AUTHORISED');
    expect(eventTypes(m.user.id, 'payment_intent.authorised')).toHaveLength(1);
    expect(eventTypes(m.user.id, 'payment_intent.succeeded')).toHaveLength(0);
    const hold = getDb().prepare("SELECT amount_minor, status FROM holds WHERE ref_type = 'payment_intent_authorisation' AND ref_id = ?").get(pi.body.id) as any;
    expect(hold).toMatchObject({ amount_minor: 1500, status: 'ACTIVE' });
    const balance = await request(app).get('/api/v1/balance').set(m.key);
    const usd = balance.body.data.find((b: any) => b.currency === 'USD');
    expect(usd.held).toBeGreaterThanOrEqual(1500);

    // a capture above the authorisation is refused; a partial capture posts the remainder back to the payer as a refund
    const tooMuch = await request(app).post(`/api/v1/payment_intents/${pi.body.id}/capture`).set(m.key).send({ amount_minor: 1600 });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error.code).toBe('capture_exceeds_authorisation');
    const captured = await request(app).post(`/api/v1/payment_intents/${pi.body.id}/capture`).set(m.key).set('Idempotency-Key', 'cap-1').send({ amount_minor: 1000 });
    expect(captured.status, JSON.stringify(captured.body)).toBe(200);
    expect(captured.body.status).toBe('SETTLEMENT_PENDING');
    expect(captured.body.capturedAmountMinor).toBe(1000);
    expect(listAttempts(pi.body.id)[0].status).toBe('CAPTURED');
    expect(eventTypes(m.user.id, 'payment_intent.succeeded')).toHaveLength(1);
    expect((getDb().prepare("SELECT status FROM holds WHERE ref_type = 'payment_intent_authorisation' AND ref_id = ?").get(pi.body.id) as any).status).not.toBe('ACTIVE');
    const refunds = await request(app).get('/api/v1/refunds').set(m.key);
    const remainder = refunds.body.data.find((r: any) => r.intentId === pi.body.id);
    expect(remainder).toMatchObject({ status: 'SUCCEEDED', amount: { valueMinor: 500, currency: 'USD' } });
    const replay = await request(app).post(`/api/v1/payment_intents/${pi.body.id}/capture`).set(m.key).set('Idempotency-Key', 'cap-1').send({ amount_minor: 1000 });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const again = await request(app).post(`/api/v1/payment_intents/${pi.body.id}/capture`).set(m.key).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('intent_not_authorised');

    // void: cancel from AUTHORISED returns the whole authorisation to the payer and ends the intent as CANCELLED
    const pv = (await request(app).post('/api/v1/payment_intents').set(m.key).send({ currency: 'USD', amount_minor: 800, capture_method: 'manual' })).body;
    const simV = await request(app).post('/api/v1/sandbox/simulate').set(m.key).send({ payment_intent: pv.id, outcome: 'succeed' });
    expect(simV.body.paymentIntent.status).toBe('AUTHORISED');
    const voided = await request(app).post(`/api/v1/payment_intents/${pv.id}/cancel`).set(m.key).send({ reason: 'customer changed their mind' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.status).toBe('CANCELLED');
    expect(listAttempts(pv.id)[0].status).toBe('ABANDONED');
    const voidRefund = (await request(app).get('/api/v1/refunds').set(m.key)).body.data.find((r: any) => r.intentId === pv.id);
    expect(voidRefund).toMatchObject({ status: 'SUCCEEDED', amount: { valueMinor: 800, currency: 'USD' } });
    expect(eventTypes(m.user.id, 'payment_intent.succeeded')).toHaveLength(1); // a void never succeeds
    // an automatic-capture intent still captures directly
    const auto = await settledIntent(m, 600);
    expect(auto.sim.paymentIntent.status).toBe('SETTLEMENT_PENDING');
  });
});

describe('partner endpoints', () => {
  it('locks FX quotes with the full disclosure and scopes them to their owner', async () => {
    const m = await merchantWithTestKey();
    const q = await request(app).post('/api/v1/fx/quotes').set(m.key).send({ amount_minor: 100_00, currency: 'USD', target_currency: 'KES' });
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    expect(q.body.object).toBe('fx_quote');
    expect(q.body.amount).toEqual({ valueMinor: 10000, currency: 'USD' });
    expect(q.body.targetCurrency).toBe('KES');
    expect(q.body.rate).toBeGreaterThan(0);
    expect(q.body.midRate).toBeGreaterThanOrEqual(q.body.rate);
    expect(q.body.recipientAmount.currency).toBe('KES');
    expect(q.body.recipientAmount.valueMinor).toBeGreaterThan(0);
    expect(q.body.fee.valueMinor).toBeGreaterThanOrEqual(0);
    expect(['LOCKED', 'INDICATIVE']).toContain(q.body.status);
    expect(q.body.expiresAt).toBeTruthy();
    const got = await request(app).get(`/api/v1/fx/quotes/${q.body.id}`).set(m.key);
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(q.body.id);
    expect(got.body.recipientAmount.valueMinor).toBe(q.body.recipientAmount.valueMinor);
    const stranger = await merchantWithTestKey();
    expect((await request(app).get(`/api/v1/fx/quotes/${q.body.id}`).set(stranger.key)).status).toBe(404);
    expect((await request(app).post('/api/v1/fx/quotes').set(m.key).send({ amount_minor: 100, currency: 'USD', target_currency: 'USD' })).body.error.code).toBe('same_currency');
  });

  it('resolves a payment as CONFIRMED, PENDING or NOT_FOUND without consuming the verification quota', async () => {
    const m = await merchantWithTestKey();
    const { intent, sim } = await settledIntent(m, 1500, { reference: 'RES-1' });
    const quotaBefore = (await request(app).get('/api/v1/verifications/quota').set(m.key)).body;
    const byRef = await request(app).get('/api/v1/payment_resolution').set(m.key).query({ reference: sim.payment.providerRef });
    expect(byRef.status, JSON.stringify(byRef.body)).toBe(200);
    expect(byRef.body.resolution).toBe('CONFIRMED');
    expect(byRef.body.matches[0].intentId).toBe(intent.id);
    expect(byRef.body.matches[0].transactionId).toBeTruthy();
    const byIntentRef = await request(app).get('/api/v1/payment_resolution').set(m.key).query({ reference: 'RES-1', amount_minor: 1500, currency: 'USD' });
    expect(byIntentRef.body.resolution).toBe('CONFIRMED');
    const byMsisdn = await request(app).get('/api/v1/payment_resolution').set(m.key).query({ msisdn: '+243000000501', amount_minor: 1500, currency: 'USD' });
    expect(byMsisdn.body.resolution).toBe('CONFIRMED');
    const nothing = await request(app).get('/api/v1/payment_resolution').set(m.key).query({ reference: 'NOPE-999' });
    expect(nothing.body.resolution).toBe('NOT_FOUND');
    expect(nothing.body.matches).toEqual([]);
    const slow = (await request(app).post('/api/v1/payment_intents').set(m.key).send({ currency: 'USD', amount_minor: 400, reference: 'RES-SLOW' })).body;
    await request(app).post('/api/v1/sandbox/simulate').set(m.key).send({ payment_intent: slow.id, outcome: 'timeout_then_succeed' });
    const pending = await request(app).get('/api/v1/payment_resolution').set(m.key).query({ msisdn: '+243000000500', amount_minor: 400 });
    expect(pending.body.resolution).toBe('PENDING');
    expect((await request(app).get('/api/v1/payment_resolution').set(m.key).query({ msisdn: '+243000000500' })).body.error.code).toBe('criteria_required');
    const quotaAfter = (await request(app).get('/api/v1/verifications/quota').set(m.key)).body;
    expect(quotaAfter.used ?? quotaAfter.usedThisMonth ?? 0).toBe(quotaBefore.used ?? quotaBefore.usedThisMonth ?? 0);
  });

  it('creates, reads and cancels money requests addressed to a named payer', async () => {
    const m = await merchantWithTestKey();
    const payer = await registerUser(app);
    const created = await request(app)
      .post('/api/v1/money_requests')
      .set(m.key)
      .set('Idempotency-Key', 'mr-1')
      .send({ payer: `@${payer.user.tag}`, amount_minor: 2500, currency: 'USD', description: 'Invoice 12' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.object).toBe('money_request');
    expect(created.body.status).toBe('open');
    expect(created.body.payer.userId).toBe(payer.user.id);
    expect(created.body.amount).toEqual({ valueMinor: 2500, currency: 'USD' });
    expect(created.body.url).toContain(`/pay/${created.body.code}`);
    const replay = await request(app)
      .post('/api/v1/money_requests')
      .set(m.key)
      .set('Idempotency-Key', 'mr-1')
      .send({ payer: `@${payer.user.tag}`, amount_minor: 2500, currency: 'USD', description: 'Invoice 12' });
    expect(replay.body.id).toBe(created.body.id);
    const got = await request(app).get(`/api/v1/money_requests/${created.body.code}`).set(m.key);
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(created.body.id);
    const stranger = await merchantWithTestKey();
    expect((await request(app).get(`/api/v1/money_requests/${created.body.code}`).set(stranger.key)).status).toBe(404);
    expect((await request(app).post(`/api/v1/money_requests/${created.body.code}/cancel`).set(stranger.key)).status).toBe(404);
    const cancelled = await request(app).post(`/api/v1/money_requests/${created.body.code}/cancel`).set(m.key);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect((await request(app).post('/api/v1/money_requests').set(m.key).send({ payer: '@nobody_here_xyz', amount_minor: 100, currency: 'USD' })).status).toBe(400);
  });

  it('returns a ledger transaction with its balanced entries and the intent it settled', async () => {
    const m = await merchantWithTestKey();
    const { intent, sim } = await settledIntent(m, 1300, { reference: 'TX-1' });
    const txId = sim.paymentIntent.transactionId as string;
    const res = await request(app).get(`/api/v1/transactions/${txId}`).set(m.key);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.transaction.id).toBe(txId);
    expect(res.body.entries.length).toBeGreaterThan(0);
    expect(res.body.balanced).toBe(true);
    expect(res.body.entries.some((e: any) => e.account === 'own' && e.direction === 'credit')).toBe(true);
    expect(res.body.intent).toMatchObject({ id: intent.id, object: 'payment_intent', url: `/v1/payment_intents/${intent.id}` });
    const stranger = await merchantWithTestKey();
    expect((await request(app).get(`/api/v1/transactions/${txId}`).set(stranger.key)).status).toBe(404);
  });
});

describe('step-up', () => {
  it('requires PIN or passkey step-up to mint or rotate a live API key, never for test keys', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Step Up Ltd', country: 'CD' });
    const noPin = await request(app).post('/api/v1/api_keys').set(m.auth).send({ label: 'prod', mode: 'live' });
    expect(noPin.status).toBe(403);
    expect(noPin.body.error.code).toBe('step_up_required');
    const wrongPin = await request(app).post('/api/v1/api_keys').set(m.auth).send({ label: 'prod', mode: 'live', pin: '0000' });
    expect(wrongPin.status).toBe(403);
    expect(wrongPin.body.error.code).toBe('invalid_pin');
    const live = await request(app).post('/api/v1/api_keys').set(m.auth).send({ label: 'prod', mode: 'live', pin: '1234' });
    expect(live.status, JSON.stringify(live.body)).toBe(201);
    expect(live.body.secret).toMatch(/^sk_live_/);
    const test = await request(app).post('/api/v1/api_keys').set(m.auth).send({ label: 'dev', mode: 'test' });
    expect(test.status, JSON.stringify(test.body)).toBe(201);
    // rotation: live needs step-up, test does not; the old secret dies at once and the new one carries the same label
    const rotNoPin = await request(app).post(`/api/v1/api_keys/${live.body.id}/rotate`).set(m.auth).send({});
    expect(rotNoPin.status).toBe(403);
    expect(rotNoPin.body.error.code).toBe('step_up_required');
    const rotated = await request(app).post(`/api/v1/api_keys/${live.body.id}/rotate`).set(m.auth).send({ pin: '1234' });
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(201);
    expect(rotated.body.rotatedFrom).toBe(live.body.id);
    expect(rotated.body.label).toBe('prod');
    expect(rotated.body.secret).toMatch(/^sk_live_/);
    expect(
      (
        await request(app)
          .get('/api/v1/payment_intents')
          .set({ Authorization: `Bearer ${live.body.secret}` })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .get('/api/v1/payment_intents')
          .set({ Authorization: `Bearer ${rotated.body.secret}` })
      ).status,
    ).toBe(200);
    const rotTest = await request(app).post(`/api/v1/api_keys/${test.body.id}/rotate`).set(m.auth).send({});
    expect(rotTest.status, JSON.stringify(rotTest.body)).toBe(201);
    expect(rotTest.body.secret).toMatch(/^sk_test_/);
    expect((await request(app).post(`/api/v1/api_keys/${live.body.id}/rotate`).set(m.auth).send({ pin: '1234' })).status).toBe(404); // revoked keys cannot rotate
    // keys never rotate keys
    expect(
      (
        await request(app)
          .post(`/api/v1/api_keys/${rotated.body.id}/rotate`)
          .set({ Authorization: `Bearer ${rotated.body.secret}` })
          .send({})
      ).body.error.code,
    ).toBe('session_required');
  });

  it('asks a session caller for step-up on high-value refunds (risk.highValueRefundMinor) but not an API key', async () => {
    const m = await merchantWithTestKey();
    const payer = await registerUser(app);
    await fund(app, payer.user.id, '500.00', 'USD');
    await fund(app, m.user.id, '20.00', 'USD');
    // the threshold is the risk appetite setting; the default is 100 000 minor units
    expect(highValueRefundThreshold()).toBe(100_000);
    setSetting('risk', { ...getSetting<Record<string, unknown>>('risk'), highValueRefundMinor: 5_000 });
    expect(highValueRefundThreshold()).toBe(5_000);
    const big = (await request(app).post('/api/v1/payment_intents').set(m.key).send({ currency: 'USD', amount_minor: 9_000, reference: 'BIG-1' })).body;
    const paid = await request(app).post(`/api/v1/payment_intents/${big.id}/pay/wallet`).set(payer.auth).send({ pin: '1234' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const noPin = await request(app).post('/api/v1/refunds').set(m.auth).send({ payment_intent: big.id, amount_minor: 6_000, reason: 'high value' });
    expect(noPin.status).toBe(403);
    expect(noPin.body.error.code).toBe('step_up_required');
    const small = await request(app).post('/api/v1/refunds').set(m.auth).send({ payment_intent: big.id, amount_minor: 2_000, reason: 'below threshold' });
    expect(small.status, JSON.stringify(small.body)).toBe(201);
    const withPin = await request(app).post('/api/v1/refunds').set(m.auth).send({ payment_intent: big.id, amount_minor: 6_000, reason: 'high value', pin: '1234' });
    expect(withPin.status, JSON.stringify(withPin.body)).toBe(201);
    expect(withPin.body.status).toBe('SUCCEEDED');
    const second = (await request(app).post('/api/v1/payment_intents').set(m.key).send({ currency: 'USD', amount_minor: 7_000, reference: 'BIG-2' })).body;
    expect((await request(app).post(`/api/v1/payment_intents/${second.id}/pay/wallet`).set(payer.auth).send({ pin: '1234' })).status).toBe(201);
    // a full refund from a session defaults to everything refundable, which is above the threshold
    expect((await request(app).post('/api/v1/refunds').set(m.auth).send({ payment_intent: second.id, reason: 'full' })).body.error.code).toBe('step_up_required');
    const viaKey = await request(app).post('/api/v1/refunds').set(m.key).send({ payment_intent: second.id, reason: 'api keys are pre-authorised' });
    expect(viaKey.status, JSON.stringify(viaKey.body)).toBe(201);
    expect(viaKey.body.amount.valueMinor).toBe(7_000);
    setSetting('risk', { ...getSetting<Record<string, unknown>>('risk'), highValueRefundMinor: undefined });
  });
});

describe('sanctions at intent creation', () => {
  it('screens cross-border payers synchronously (403 sanctions_hit) and domestic payers asynchronously (UNDER_REVIEW on a hit)', async () => {
    const m = await merchantWithTestKey('CD');
    addSanction('phone', '+243999000111', 'contract test listing', null);
    const blocked = await request(app)
      .post('/api/v1/payment_intents')
      .set(m.key)
      .send({ currency: 'USD', amount_minor: 900, customer_country: 'KE', customer_msisdn: '+243999000111', reference: 'XB-1' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('sanctions_hit');
    expect(getDb().prepare("SELECT COUNT(*) c FROM payment_intents WHERE reference = 'XB-1'").get()).toMatchObject({ c: 0 });
    const clean = await request(app).post('/api/v1/payment_intents').set(m.key).send({ currency: 'USD', amount_minor: 900, customer_country: 'KE', customer_msisdn: '+254700000001' });
    expect(clean.status, JSON.stringify(clean.body)).toBe(201);
    expect(getDb().prepare('SELECT COUNT(*) c FROM sanctions_screenings WHERE subject_id = ?').get(clean.body.id)).toMatchObject({ c: 0 }); // screened inline, nothing pending

    const domestic = await request(app)
      .post('/api/v1/payment_intents')
      .set(m.key)
      .send({ currency: 'USD', amount_minor: 900, customer_country: 'CD', customer_msisdn: '+243999000111', reference: 'DOM-1' });
    expect(domestic.status, JSON.stringify(domestic.body)).toBe(201);
    expect(['CREATED', 'REQUIRES_PAYMENT_METHOD']).toContain(domestic.body.status); // not blocked: screened by the job
    const pending = getDb().prepare("SELECT * FROM sanctions_screenings WHERE subject_type = 'payment_intent' AND subject_id = ?").get(domestic.body.id) as any;
    expect(pending.status).toBe('PENDING');
    expect(pending.screened_at).toBeNull();
    expect(new Date(pending.created_at).getTime()).toBeLessThanOrEqual(new Date(now()).getTime());
    const innocent = await request(app).post('/api/v1/payment_intents').set(m.key).send({ currency: 'USD', amount_minor: 500, customer_country: 'CD', customer_msisdn: '+243800000002' });
    const result = screenPendingSanctions();
    expect(result.screened).toBeGreaterThanOrEqual(2);
    expect(result.hits).toBeGreaterThanOrEqual(1);
    const screened = getDb().prepare('SELECT status, hits, screened_at FROM sanctions_screenings WHERE subject_id = ?').get(domestic.body.id) as any;
    expect(screened.status).toBe('HIT');
    expect(screened.screened_at).toBeTruthy();
    expect(JSON.parse(screened.hits)[0]).toMatch(/^sanctions:phone:/);
    expect(getIntentRow(domestic.body.id).status).toBe('UNDER_REVIEW');
    expect((getDb().prepare('SELECT status FROM sanctions_screenings WHERE subject_id = ?').get(innocent.body.id) as any).status).toBe('CLEAR');
    expect(getIntentRow(innocent.body.id).status).not.toBe('UNDER_REVIEW');
    expect(screenPendingSanctions().screened).toBe(0); // nothing left to screen
    const timeline = await request(app).get(`/api/v1/payment_intents/${domestic.body.id}/timeline`).set(m.key);
    expect(JSON.stringify(timeline.body)).toContain('sanctions_hit');
  });
});
