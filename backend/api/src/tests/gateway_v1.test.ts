/**
 * Gateway v1 objects: hosted checkout sessions, payment links, refunds with atomic reservations, Scan-to-Verify,
 * payouts, the webhook engine (endpoints, dual signatures, persisted retries, dead letters, replay), scoped API keys
 * and the sandbox simulator driving the real attempt/intent state machine with magic MSISDNs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { createPublicKey, verify as nodeVerify } from 'node:crypto';
import { setupApp, registerUser, fund, decideWithdrawal } from './helpers';
import { getDb } from '../db';
import { attemptDelivery, verifyWebhookSignature, ed25519SigningString, processDueDeliveries } from '../services/webhooks';
import { runGuardian } from '../services/guardian';
import { getIntentRow, listAttempts } from '../services/intents';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

type Received = { headers: IncomingMessage['headers']; body: string };
function receiver(status: () => number): Promise<{ server: Server; url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.statusCode = status();
      res.end(status() < 300 ? 'ok' : 'nope');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as any).port}/hooks`, received })));
}

const reusableCheck = (link: any) => link.kind === 'single_use' && link.qrPayload === null && typeof link.url === 'string';

describe('checkout sessions, links and refunds', () => {
  it('creates a hosted checkout session, settles it from a wallet, completes the session and refunds it in two parts under an atomic reservation', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Kin Bakery', country: 'CD' });
    const payer = await registerUser(app);
    await fund(app, payer.user.id, '200.00', 'USD');
    await fund(app, m.user.id, '1.00', 'USD'); // refunds return the principal; the platform fee stays with the platform, so the merchant covers it from its balance
    const ep = await request(app)
      .post('/api/v1/webhook_endpoints')
      .set(m.auth)
      .send({ url: 'http://127.0.0.1:9/hooks', events: ['checkout.session.*', 'refund.*', 'payment_intent.succeeded'] });
    expect(ep.status, JSON.stringify(ep.body)).toBe(201);
    expect(ep.body.secret).toMatch(/^whsec_/);

    const cs = await request(app)
      .post('/api/v1/checkout_sessions')
      .set(m.auth)
      .set('Idempotency-Key', 'order-77')
      .send({
        currency: 'USD',
        line_items: [
          { name: 'Croissant', quantity: 4, unit_amount_minor: 150 },
          { name: 'Coffee', quantity: 2, unit_amount_minor: 300 },
        ],
        success_url: 'https://kinbakery.example/thanks',
        cancel_url: 'https://kinbakery.example/cart',
        customer: { email: 'ana@example.com' },
        reference: 'ORD-77',
      });
    expect(cs.status, JSON.stringify(cs.body)).toBe(201);
    expect(cs.body.id).toMatch(/^cs_/);
    expect(cs.body.status).toBe('open');
    expect(cs.body.amount.valueMinor).toBe(1200);
    expect(cs.body.url).toContain(`/pay/${cs.body.paymentIntent.paymentRequestCode}?cs=${cs.body.id}`);
    expect(cs.body.paymentIntent.source).toBe('checkout');
    // idempotent replay returns the same session; the same key with a different body is refused (IDM-001)
    const again = await request(app)
      .post('/api/v1/checkout_sessions')
      .set(m.auth)
      .set('Idempotency-Key', 'order-77')
      .send({
        currency: 'USD',
        line_items: [
          { name: 'Croissant', quantity: 4, unit_amount_minor: 150 },
          { name: 'Coffee', quantity: 2, unit_amount_minor: 300 },
        ],
        success_url: 'https://kinbakery.example/thanks',
        cancel_url: 'https://kinbakery.example/cart',
        customer: { email: 'ana@example.com' },
        reference: 'ORD-77',
      });
    expect(again.body.id).toBe(cs.body.id);
    const reused = await request(app).post('/api/v1/checkout_sessions').set(m.auth).set('Idempotency-Key', 'order-77').send({ currency: 'USD', amount_minor: 1200 });
    // gateway contract: a reused Idempotency-Key is a conflict with the earlier request, so it is 409 (was 422)
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('idempotency_key_reused');
    // a mismatching total is refused
    const bad = await request(app)
      .post('/api/v1/checkout_sessions')
      .set(m.auth)
      .send({ currency: 'USD', amount_minor: 999, line_items: [{ name: 'X', quantity: 1, unit_amount_minor: 100 }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('amount_mismatch');

    const paid = await request(app).post(`/api/v1/payment_intents/${cs.body.intentId}/pay/wallet`).set(payer.auth).send({ pin: '1234' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const done = await request(app).get(`/api/v1/checkout_sessions/${cs.body.id}`).set(m.auth);
    expect(done.body.status).toBe('complete');
    expect(done.body.completedAt).toBeTruthy();
    const events = await request(app).get('/api/v1/events').set(m.auth);
    const types = events.body.data.map((e: any) => e.type);
    expect(types).toContain('checkout.session.completed');
    expect(types).toContain('payment_intent.succeeded');
    expect(events.body.data.find((e: any) => e.type === 'checkout.session.completed').data.checkoutSession.id).toBe(cs.body.id);

    // refunds: 500 then the rest; a third one exceeds the refundable amount
    const refundable = await request(app).get(`/api/v1/payment_intents/${cs.body.intentId}/refundable`).set(m.auth);
    expect(refundable.body).toMatchObject({ principal: 1200, reserved: 0, refundable: 1200 });
    const r1 = await request(app).post('/api/v1/refunds').set(m.auth).set('Idempotency-Key', 'rf-1').send({ payment_intent: cs.body.intentId, amount_minor: 500, reason: 'one croissant short' });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r1.body.status).toBe('SUCCEEDED');
    expect(r1.body.method).toBe('wallet');
    expect(r1.body.refundTransactionId).toBeTruthy();
    expect(getIntentRow(cs.body.intentId).status).toBe('PARTIALLY_REFUNDED');
    const r1again = await request(app).post('/api/v1/refunds').set(m.auth).set('Idempotency-Key', 'rf-1').send({ payment_intent: cs.body.intentId, amount_minor: 500, reason: 'one croissant short' });
    expect(r1again.body.id).toBe(r1.body.id);
    expect((await request(app).get('/api/v1/refunds').set(m.auth)).body.data).toHaveLength(1);
    const tooMuch = await request(app).post('/api/v1/refunds').set(m.auth).send({ payment_intent: cs.body.intentId, amount_minor: 800 });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error.code).toBe('refund_exceeds_refundable');
    // a refund the merchant balance cannot cover fails cleanly and releases its reservation
    const merchantBalance = (getDb().prepare("SELECT balance FROM wallets WHERE user_id = ? AND currency = 'USD'").get(m.user.id) as any).balance as number;
    getDb().prepare("UPDATE wallets SET balance = 100 WHERE user_id = ? AND currency = 'USD'").run(m.user.id);
    const short = await request(app).post('/api/v1/refunds').set(m.auth).send({ payment_intent: cs.body.intentId });
    expect(short.status).toBe(402);
    expect(short.body.status).toBe('FAILED');
    expect(short.body.error).toMatch(/insufficient/i);
    expect((await request(app).get(`/api/v1/payment_intents/${cs.body.intentId}/refundable`).set(m.auth)).body.refundable).toBe(700);
    getDb().prepare("UPDATE wallets SET balance = ? WHERE user_id = ? AND currency = 'USD'").run(merchantBalance, m.user.id);
    const r2 = await request(app).post('/api/v1/refunds').set(m.auth).send({ payment_intent: cs.body.intentId });
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    expect(r2.body.amount.valueMinor).toBe(700);
    expect(getIntentRow(cs.body.intentId).status).toBe('REFUNDED');
    const after = await request(app).get(`/api/v1/payment_intents/${cs.body.intentId}/refundable`).set(m.auth);
    expect(after.body.refundable).toBe(0);
    // the payer got the money back; the original transaction is marked reversed; the ledger still balances
    const payerWallet = getDb().prepare("SELECT balance FROM wallets WHERE user_id = ? AND currency = 'USD'").get(payer.user.id) as any;
    expect(payerWallet.balance).toBe(20000);
    const original = getDb().prepare('SELECT status FROM transactions WHERE id = ?').get(paid.body.transaction.id) as any;
    expect(original.status).toBe('reversed');
    const list = await request(app).get('/api/v1/refunds').set(m.auth);
    expect(list.body.data.map((r: any) => r.status).sort()).toEqual(['FAILED', 'SUCCEEDED', 'SUCCEEDED']);
    expect(runGuardian().findings.filter((f) => f.kind === 'refund_exceeds')).toHaveLength(0);
  });

  it('creates single-use and reusable payment links; a reusable link is a static code with a fixed amount', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Studio Lubumbashi', country: 'CD' });
    const single = await request(app).post('/api/v1/payment_links').set(m.auth).send({ currency: 'USD', amount_minor: 4500, title: 'Portrait session' });
    expect(single.status, JSON.stringify(single.body)).toBe(201);
    expect(single.body.kind).toBe('single_use');
    expect(single.body.url).toContain('/pay/');
    expect(single.body.uri).toBe(`bitripay://pay/${single.body.id}`);
    expect(reusableCheck(single.body)).toBe(true);
    const reusable = await request(app).post('/api/v1/payment_links').set(m.auth).send({ currency: 'USD', amount_minor: 1000, title: 'Tip jar', reusable: true });
    expect(reusable.status, JSON.stringify(reusable.body)).toBe(201);
    expect(reusable.body.kind).toBe('reusable');
    expect(reusable.body.id).toMatch(/^qr_/);
    expect(reusable.body.url).toContain('/q/');
    expect(reusable.body.qrPayload).toMatch(/^000201/);
    const resolved = await request(app).get(`/api/v1/resolve/${reusable.body.id}`);
    expect(resolved.body.kind).toBe('static');
    expect(resolved.body.amount).toBe(1000);
    // two payers → two distinct intents from the same link
    const a = await request(app).post(`/api/v1/qr/${reusable.body.id}/intent`).send({ amount: '10.00' });
    const b = await request(app).post(`/api/v1/qr/${reusable.body.id}/intent`).send({ amount: '10.00' });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);
    const wrong = await request(app).post(`/api/v1/qr/${reusable.body.id}/intent`).send({ amount: '5.00' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('fixed_amount');
    const links = await request(app).get('/api/v1/payment_links').set(m.auth);
    expect(links.body.data.map((l: any) => l.id).sort()).toEqual([reusable.body.id, single.body.id].sort());
    const off = await request(app).post(`/api/v1/payment_links/${reusable.body.id}/deactivate`).set(m.auth);
    expect(off.body.status).toBe('revoked');
    const gone = await request(app).get(`/api/v1/resolve/${reusable.body.id}`);
    expect(gone.body.kind).toBe('invalid');
  });
});

describe('webhook engine', () => {
  let server: Server;
  afterAll(() => server?.close());

  it('signs deliveries with HMAC and the platform ed25519 key, persists retries with a schedule, dead-letters and replays', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Hook Test' });
    let status = 200;
    const r = await receiver(() => status);
    server = r.server;
    const ep = await request(app)
      .post('/api/v1/webhook_endpoints')
      .set(m.auth)
      .send({ url: r.url, events: ['ping', 'payment_intent.*'], description: 'test' });
    expect(ep.status, JSON.stringify(ep.body)).toBe(201);
    const secret = ep.body.secret as string;
    const ping = await request(app).post(`/api/v1/webhook_endpoints/${ep.body.id}/ping`).set(m.auth);
    expect(ping.body.eventId).toMatch(/^evt_/);
    const pending = await request(app).get(`/api/v1/webhook_endpoints/${ep.body.id}/deliveries`).set(m.auth);
    expect(pending.body.data).toHaveLength(1);
    const delivery = pending.body.data[0];
    expect(delivery.attempts).toBe(0);
    // deliver
    const first = await attemptDelivery(delivery.id);
    expect(first?.success).toBe(true);
    expect(first?.statusCode).toBe(200);
    expect(r.received).toHaveLength(1);
    const got = r.received[0];
    const body = JSON.parse(got.body);
    expect(body.type).toBe('ping');
    expect(body.event).toBe('ping');
    expect(body.id).toBe(ping.body.eventId);
    expect(body.api_version).toBe('2026-09-01');
    expect(got.headers['bitripay-event']).toBe('ping');
    expect(got.headers['bitripay-delivery-id']).toBe(delivery.id);
    expect(verifyWebhookSignature(secret, got.body, got.headers['bitripay-signature'] as string)).toBe(true);
    expect(verifyWebhookSignature(secret, got.body, got.headers['x-bitripay-signature'] as string)).toBe(true);
    expect(verifyWebhookSignature('whsec_wrong', got.body, got.headers['bitripay-signature'] as string)).toBe(false);
    // asymmetric signature verifies against the published platform key
    const sig = Object.fromEntries((got.headers['bitripay-signature-ed25519'] as string).split(',').map((kv) => kv.split('=', 2) as [string, string]));
    const key = await request(app).get(`/api/v1/keys/${sig.keyId}`);
    expect(key.body.scope).toBe('PLATFORM');
    const pub = createPublicKey({ key: Buffer.from(key.body.publicKey, 'base64'), format: 'der', type: 'spki' });
    const sigB64 = (got.headers['bitripay-signature-ed25519'] as string).split('sig=')[1];
    expect(nodeVerify(null, Buffer.from(ed25519SigningString(Number(sig.t), delivery.id, r.url, got.body)), pub, Buffer.from(sigB64, 'base64'))).toBe(true);

    // failures schedule the next attempt (10s first), count attempts and eventually dead-letter
    status = 500;
    const ping2 = await request(app).post(`/api/v1/webhook_endpoints/${ep.body.id}/ping`).set(m.auth);
    const d2 = (await request(app).get('/api/v1/webhook_deliveries?status=pending').set(m.auth)).body.data.find((d: any) => d.eventId === ping2.body.eventId);
    const failed = await attemptDelivery(d2.id);
    expect(failed?.success).toBe(false);
    expect(failed?.attempts).toBe(1);
    expect(failed?.statusCode).toBe(500);
    expect(failed?.dead).toBe(false);
    const wait = new Date(failed!.nextAttemptAt!).getTime() - Date.now();
    expect(wait).toBeGreaterThan(5000);
    expect(wait).toBeLessThan(15000);
    // the scheduler only picks it up once the retry time has passed
    await processDueDeliveries();
    expect((getDb().prepare('SELECT attempts FROM webhook_deliveries WHERE id = ?').get(d2.id) as any).attempts).toBe(1);
    getDb()
      .prepare('UPDATE webhook_deliveries SET next_attempt_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), d2.id);
    await processDueDeliveries();
    expect((getDb().prepare('SELECT attempts FROM webhook_deliveries WHERE id = ?').get(d2.id) as any).attempts).toBe(2);
    // exhaust the schedule
    getDb()
      .prepare('UPDATE webhook_deliveries SET attempts = 8, next_attempt_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), d2.id);
    const dead = await attemptDelivery(d2.id);
    expect(dead?.dead).toBe(true);
    expect(dead?.nextAttemptAt).toBeNull();
    const stats = await request(app).get('/api/v1/webhook_endpoints').set(m.auth);
    expect(stats.body.stats.dead).toBe(1);
    // replay keeps the event id under a new delivery id
    status = 200;
    const replayed = await request(app).post(`/api/v1/webhook_deliveries/${d2.id}/replay`).set(m.auth);
    expect(replayed.body.replayOf).toBe(d2.id);
    expect(replayed.body.eventId).toBe(ping2.body.eventId);
    const ok = await attemptDelivery(replayed.body.id);
    expect(ok?.success).toBe(true);
    const ev = await request(app).get(`/api/v1/events/${ping2.body.eventId}`).set(m.auth);
    expect(ev.body.deliveries).toHaveLength(2);
    // secret rotation and endpoint management
    const rotated = await request(app).post(`/api/v1/webhook_endpoints/${ep.body.id}/rotate`).set(m.auth);
    expect(rotated.body.secret).not.toBe(secret);
    const disabled = await request(app).patch(`/api/v1/webhook_endpoints/${ep.body.id}`).set(m.auth).send({ active: false });
    expect(disabled.body.active).toBe(false);
    const unknownType = await request(app)
      .post('/api/v1/webhook_endpoints')
      .set(m.auth)
      .send({ url: r.url, events: ['payment.made_up'] });
    expect(unknownType.status).toBe(400);
    const types = await request(app).get('/api/v1/webhook_events/types');
    expect(types.body.data.some((t: any) => t.type === 'payment_intent.ambiguous_hold')).toBe(true);
  });
});

describe('scoped API keys', () => {
  it('restricts keys to their scopes, keeps publishable keys read-only and never lets a key mint keys', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Keys Ltd' });
    // gateway contract: minting a live key from a session needs PIN / passkey step-up (test keys need none, see contract_gateway.test.ts)
    const ro = await request(app)
      .post('/api/v1/api_keys')
      .set(m.auth)
      .send({ label: 'reporting', kind: 'restricted', scopes: ['payment_intents:read'], pin: '1234' });
    expect(ro.status, JSON.stringify(ro.body)).toBe(201);
    expect(ro.body.secret).toMatch(/^rk_live_/);
    const pk = await request(app).post('/api/v1/api_keys').set(m.auth).send({ label: 'browser', kind: 'publishable', mode: 'test' });
    expect(pk.body.secret).toMatch(/^pk_test_/);
    const sk = await request(app).post('/api/v1/api_keys').set(m.auth).send({ label: 'server', mode: 'test' });
    expect(sk.body.secret).toMatch(/^sk_test_/);
    const bad = await request(app)
      .post('/api/v1/api_keys')
      .set(m.auth)
      .send({ label: 'x', kind: 'restricted', scopes: ['everything'] });
    expect(bad.status).toBe(400);
    const roAuth = { Authorization: `Bearer ${ro.body.secret}` };
    const denied = await request(app).post('/api/v1/payment_intents').set(roAuth).send({ currency: 'USD', amount_minor: 100 });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('scope_denied');
    const created = await request(app)
      .post('/api/v1/payment_intents')
      .set({ Authorization: `Bearer ${sk.body.secret}` })
      .send({ currency: 'USD', amount_minor: 100 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const listed = await request(app).get('/api/v1/payment_intents').set(roAuth);
    expect(listed.status).toBe(200);
    expect(listed.body.data.some((i: any) => i.id === created.body.id)).toBe(true);
    const pkList = await request(app)
      .get('/api/v1/payment_intents')
      .set({ Authorization: `Bearer ${pk.body.secret}` });
    expect(pkList.status).toBe(200);
    const pkWrite = await request(app)
      .post('/api/v1/refunds')
      .set({ Authorization: `Bearer ${pk.body.secret}` })
      .send({ payment_intent: created.body.id });
    expect(pkWrite.status).toBe(403);
    const mint = await request(app)
      .post('/api/v1/api_keys')
      .set({ Authorization: `Bearer ${sk.body.secret}` })
      .send({ label: 'evil' });
    expect(mint.status).toBe(403);
    expect(mint.body.error.code).toBe('session_required');
    const revoked = await request(app).delete(`/api/v1/api_keys/${ro.body.id}`).set(m.auth);
    expect(revoked.body.revoked).toBe(true);
    const afterRevoke = await request(app).get('/api/v1/payment_intents').set(roAuth);
    expect(afterRevoke.status).toBe(401);
  });
});

describe('sandbox simulator, Scan-to-Verify and payouts', () => {
  it('drives intents through the real attempt machine with magic MSISDNs and verifies the settled payment by reference and by MSISDN', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Sim Shop', country: 'CD' });
    const mk = (await request(app).post('/api/v1/api_keys').set(m.auth).send({ label: 'sim', mode: 'test' })).body.secret as string;
    const auth = { Authorization: `Bearer ${mk}` };
    const catalogue = await request(app).get('/api/v1/sandbox');
    expect(catalogue.body.magicMsisdns.fail).toBe('+243000000404');

    // 1. wallet not found → retryable failure, intent back to REQUIRES_PAYMENT_METHOD, then succeed on the same intent
    const pi1 = (await request(app).post('/api/v1/payment_intents').set(auth).send({ currency: 'USD', amount_minor: 1500, reference: 'SIM-1' })).body;
    const fail = await request(app).post('/api/v1/sandbox/simulate').set(auth).send({ payment_intent: pi1.id, outcome: 'fail' });
    expect(fail.status, JSON.stringify(fail.body)).toBe(200);
    expect(fail.body.payment.stage).toBe('REJECTED');
    expect(fail.body.paymentIntent.status).toBe('REQUIRES_PAYMENT_METHOD');
    expect(fail.body.attempts[0].status).toBe('FAILED');
    expect(fail.body.attempts[0].failureCategory).toBe('invalid_msisdn');
    const ok = await request(app).post('/api/v1/sandbox/simulate').set(auth).send({ payment_intent: pi1.id, outcome: 'succeed' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.payment.stage).toBe('SETTLED');
    expect(ok.body.paymentIntent.status).toBe('SETTLEMENT_PENDING');
    expect(ok.body.attempts).toHaveLength(2);
    expect(ok.body.attempts[1].status).toBe('CAPTURED');
    expect(ok.body.paymentIntent.transactionId).toBeTruthy();
    const timeline = await request(app).get(`/api/v1/payment_intents/${pi1.id}/timeline`).set(auth);
    expect(timeline.body.paymentEvents.map((e: any) => e.state)).toEqual(expect.arrayContaining(['INITIATED', 'PENDING', 'CONFIRMED']));

    // 2. provider outcome unknown → attempt UNKNOWN, intent AMBIGUOUS, ambiguous_hold event, and no second attempt allowed
    const pi2 = (await request(app).post('/api/v1/payment_intents').set(auth).send({ currency: 'USD', amount_minor: 900 })).body;
    const amb = await request(app).post('/api/v1/sandbox/simulate').set(auth).send({ payment_intent: pi2.id, outcome: 'ambiguous' });
    expect(amb.status, JSON.stringify(amb.body)).toBe(200);
    expect(amb.body.payment.stage).toBe('MANUAL_REVIEW');
    expect(amb.body.paymentIntent.status).toBe('AMBIGUOUS');
    expect(listAttempts(pi2.id)[0].status).toBe('UNKNOWN');
    const blocked = await request(app).post('/api/v1/sandbox/simulate').set(auth).send({ payment_intent: pi2.id, outcome: 'succeed' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('attempt_in_flight');
    const ambEvent = getDb().prepare("SELECT id FROM webhook_events WHERE user_id = ? AND type = 'payment_intent.ambiguous_hold'").get(m.user.id);
    expect(ambEvent).toBeDefined(); // the event log is written even before any endpoint exists; there is simply nothing to deliver
    const balance = await request(app).get('/api/v1/balance').set(auth);
    const usd = balance.body.data.find((b: any) => b.currency === 'USD');
    expect(usd.pending).toBe(900);
    expect(usd.settlement_pending).toBe(1500);

    // 3. timeout then success: pending until the sandbox delay elapses
    const pi3 = (await request(app).post('/api/v1/payment_intents').set(auth).send({ currency: 'USD', amount_minor: 400 })).body;
    const slow = await request(app).post('/api/v1/sandbox/simulate').set(auth).send({ payment_intent: pi3.id, outcome: 'timeout_then_succeed' });
    expect(slow.body.payment.stage).toBe('INSTRUCTION_ISSUED');
    expect(slow.body.paymentIntent.status).toBe('REQUIRES_CUSTOMER_ACTION');

    // Scan-to-Verify: reference match and MSISDN + amount match on the settled payment; unknown reference → NOT_FOUND
    const ref = ok.body.payment.providerRef as string;
    const byRef = await request(app).post('/api/v1/verifications').set(auth).send({ rail: 'mobile_money', reference: ref });
    expect(byRef.status, JSON.stringify(byRef.body)).toBe(201);
    expect(byRef.body.status).toBe('VERIFIED');
    expect(byRef.body.confidence).toBeGreaterThanOrEqual(70);
    expect(byRef.body.match.intentId).toBe(pi1.id);
    expect(byRef.body.charged).toBe(false);
    const byMsisdn = await request(app).post('/api/v1/verifications').set(auth).send({ rail: 'mobile_money', msisdn: '+243000000501', amount_minor: 1500, currency: 'USD' });
    expect(byMsisdn.body.status).toBe('VERIFIED');
    const wrongAmount = await request(app).post('/api/v1/verifications').set(auth).send({ rail: 'mobile_money', reference: ref, amount_minor: 1400 });
    expect(wrongAmount.body.status).toBe('MISMATCH');
    const nothing = await request(app).post('/api/v1/verifications').set(auth).send({ rail: 'mobile_money', reference: 'NOPE-123' });
    expect(nothing.body.status).toBe('NOT_FOUND');
    const pendingV = await request(app).post('/api/v1/verifications').set(auth).send({ rail: 'mobile_money', msisdn: '+243000000500', amount_minor: 400 });
    expect(pendingV.body.status).toBe('PENDING');
    const quota = await request(app).get('/api/v1/verifications/quota').set(auth);
    expect(quota.body.used).toBe(5);
    expect(quota.body.remainingFree).toBe(25);
    expect(getIntentRow(pi1.id).status).toBe('SETTLEMENT_PENDING'); // a verification never changes a payment
    const paymentEvents = getDb().prepare("SELECT state FROM payment_events WHERE intent_id = ? AND state = 'EXTERNAL_VERIFIED'").all(pi1.id);
    expect(paymentEvents.length).toBeGreaterThanOrEqual(2);
  });

  it('creates a payout through the withdrawal workflow and emits payout events when operations complete it', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Payout Co' });
    await fund(app, m.user.id, '300.00', 'USD');
    await request(app)
      .post('/api/v1/webhook_endpoints')
      .set(m.auth)
      .send({ url: 'http://127.0.0.1:9/hooks', events: ['payout.*'] });
    const po = await request(app)
      .post('/api/v1/payouts')
      .set(m.auth)
      .set('Idempotency-Key', 'po-1')
      .send({
        amount_minor: 10000,
        currency: 'USD',
        destination: { method: 'bank', bank_name: 'Rawbank', account_name: 'Payout Co', account_number: '00012345678', country: 'CD' },
        description: 'weekly settlement',
      });
    expect(po.status, JSON.stringify(po.body)).toBe(201);
    expect(po.body.object).toBe('payout');
    expect(po.body.status).toBe('pending');
    expect(po.body.destination.method).toBe('bank');
    const dup = await request(app)
      .post('/api/v1/payouts')
      .set(m.auth)
      .set('Idempotency-Key', 'po-1')
      .send({
        amount_minor: 10000,
        currency: 'USD',
        destination: { method: 'bank', bank_name: 'Rawbank', account_name: 'Payout Co', account_number: '00012345678', country: 'CD' },
        description: 'weekly settlement',
      });
    expect(dup.body.id).toBe(po.body.id);
    expect((await request(app).get('/api/v1/payouts').set(m.auth)).body.data).toHaveLength(1);
    await decideWithdrawal(app, po.body.id, 'approve');
    const done = await request(app).get(`/api/v1/payouts/${po.body.id}`).set(m.auth);
    expect(done.body.status).toBe('completed');
    const events = (await request(app).get('/api/v1/events').set(m.auth)).body.data.map((e: any) => e.type);
    expect(events).toContain('payout.created');
    expect(events).toContain('payout.completed');
  });
});
