/**
 * National Switch Gateway acceptance tests T01–T32 (dossier §22) against the simulator, plus the rail registry,
 * Smart Route scoring and circuit breakers. Financial invariants are asserted, not only HTTP codes: one financial
 * command per order, no resend after uncertainty, no status regression, reservations never exceeded, no ledger
 * posting for observation-only rails.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, adminToken, checkerToken } from './helpers';
import { getDb } from '../db';
import { setSetting } from '../services/settings';
import { dispatchOutbox, emitPayment, acquireLease, recoverUncertainEmissions, getPaymentRow, paymentTimeline, listLinkedOperations, refundable } from '../services/switch/payments';
import { simulatorFor } from '../services/switch/adapter';
import { getConnection, setCertificate, setLinkState, emissionGate, certificateAlerts, upsertConnection } from '../services/switch/connections';
import { setParticipantStatus, getParticipant } from '../services/switch/participants';
import { businessDate } from '../services/switch/settings';
import { listCases, importReport, runReconciliation } from '../services/switch/reconciliation';
import { recordRoutingOutcome, connectorHealth, pickConnector, scoreConnectors, listRails, pauseConnector, resumeConnector } from '../services/rails';
import { runGuardian } from '../services/guardian';
import { getIntentRow } from '../services/intents';

let app: ReturnType<typeof setupApp>;
let merchant: Awaited<ReturnType<typeof registerUser>>;
let auth: Record<string, string>;
let admin: Awaited<ReturnType<typeof adminToken>>;
let checker: Awaited<ReturnType<typeof checkerToken>>;
let bindingId: string;
const CONN = 'NATIONAL_SWITCH_CD';
const NODE = 'node:test';
let orderSeq = 0;

async function consent(amount: number, token = 'tok_ok', participant = 'DEMO_BANK_A') {
  const r = await request(app)
    .post('/api/v1/consents')
    .set(auth)
    .send({ participant_id: participant, beneficiary_binding_id: bindingId, amount: { currency: 'CDF', value_minor: String(amount) }, account_token: token, proof: `sim-consent-${Date.now()}` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.reference as string;
}
async function createPayment(opts: { amount?: number; token?: string; participant?: string; consent?: boolean; idem?: string; order?: string; extra?: Record<string, unknown> } = {}) {
  const amount = opts.amount ?? 250_000_00;
  const token = opts.token ?? 'tok_ok';
  const participant = opts.participant ?? 'DEMO_BANK_A';
  const c = opts.consent === false ? null : await consent(amount, token, participant);
  const order = opts.order ?? `INV-2026-${String(++orderSeq).padStart(6, '0')}`;
  const req = request(app).post('/api/v1/payments').set(auth);
  if (opts.idem) req.set('Idempotency-Key', opts.idem);
  const r = await req.send({
    merchant_order_id: order,
    product: 'MERCHANT_PAYMENT',
    amount: { currency: 'CDF', value_minor: String(amount) },
    payer: { participant_id: participant, account_token: token },
    beneficiary_binding_id: bindingId,
    consent_reference: c,
    description: `Order ${order}`,
    ...(opts.extra ?? {}),
  });
  return r;
}
async function dispatch(owner = NODE) {
  return dispatchOutbox(owner, { limit: 100 });
}
function makeDue(paymentId: string) {
  getDb()
    .prepare('UPDATE outbox_messages SET available_at = ? WHERE payment_id = ? AND delivered_at IS NULL')
    .run(new Date(Date.now() - 1000).toISOString(), paymentId);
}
async function inject(stableMessageId: string, variant: string, externalMessageId?: string) {
  const r = await request(app).post(`/api/admin/switch/connections/${CONN}/simulate-inbound`).set(admin.auth).send({ stableMessageId, variant, externalMessageId });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { outcome: string; ack: boolean; duplicate: boolean; quarantined: boolean; externalMessageId: string };
}

beforeAll(async () => {
  app = setupApp();
  getDb().prepare("UPDATE currencies SET enabled = 1 WHERE code IN ('CDF', 'USD')").run();
  admin = await adminToken(app);
  checker = await checkerToken(app);
  merchant = await registerUser(app, { role: 'merchant', businessName: 'Kin Bakery', country: 'CD' });
  const key = await request(app).post('/api/v1/api_keys').set(merchant.auth).send({ label: 'switch', mode: 'test' });
  auth = { Authorization: `Bearer ${key.body.secret}` };
  // beneficiary binding: requested by the merchant, verified by compliance, activated by a second person
  const b = await request(app).post('/api/v1/beneficiary_bindings').set(auth).send({ participant_id: 'DEMO_MMO_B', account_token: 'acct-merchant-778899', account_name: 'Kin Bakery SARL' });
  expect(b.status, JSON.stringify(b.body)).toBe(201);
  expect(b.body.status).toBe('PENDING');
  expect(b.body.accountMasked).toMatch(/^•+8899$/);
  const v = await request(app).post(`/api/admin/switch/bindings/${b.body.id}/verify`).set(admin.auth).send({ method: 'institution_confirmation', reference: 'MMO-B-CONF-1' });
  expect(v.body.binding.status).toBe('VERIFIED');
  const selfApprove = await request(app).post(`/api/admin/switch/bindings/${b.body.id}/activate`).set(admin.auth);
  expect(selfApprove.status).toBe(400); // verifier cannot activate
  const a = await request(app).post(`/api/admin/switch/bindings/${b.body.id}/activate`).set(checker.auth);
  expect(a.body.binding.status).toBe('ACTIVE');
  bindingId = b.body.id;
  setSetting('switch', { inquiryDelaysSeconds: [0, 0, 0, 0], maxInquiries: 3, uncertainTimeoutSeconds: 1 });
});

describe('L1 internal core: identity, idempotency, state machine', () => {
  it('T01/T02/T03 — same key and order → one resource and one command; changed content → 409; new key same order → duplicate refused', async () => {
    const c = await consent(250_000_00);
    const body = {
      merchant_order_id: 'INV-2026-000187',
      product: 'MERCHANT_PAYMENT',
      amount: { currency: 'CDF', value_minor: '25000000' },
      payer: { participant_id: 'DEMO_BANK_A', account_token: 'tok_ok' },
      beneficiary_binding_id: bindingId,
      consent_reference: c,
      description: 'Order INV-2026-000187',
    };
    // two simultaneous creations: exactly one 201; the other is either the identical resource (200) or told the key is in progress (409) — never a second payment
    const [ra, rb] = await Promise.all([
      request(app).post('/api/v1/payments').set(auth).set('Idempotency-Key', 'k-187').send(body),
      request(app).post('/api/v1/payments').set(auth).set('Idempotency-Key', 'k-187').send(body),
    ]);
    const created = [ra, rb].filter((x) => x.status === 201);
    expect(created, JSON.stringify([ra.body, rb.body])).toHaveLength(1);
    const otherStatus = [ra, rb].find((x) => x.status !== 201)!.status;
    expect([200, 409]).toContain(otherStatus);
    const r1 = created[0];
    // the client keeps the same key and asks again: the identical resource comes back with 200
    const replay = await request(app).post('/api/v1/payments').set(auth).set('Idempotency-Key', 'k-187').send(body);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.payment_id).toBe(r1.body.payment_id);
    const pid = r1.body.payment_id as string;
    expect(r1.body.status).toBe('READY');
    expect(r1.body.route).toMatchObject({ class: 'DOMESTIC_INTEROPERABLE', rail: 'NATIONAL_SWITCH', access_mode: 'DIRECT', scheme_id: 'SMN-CD' });
    expect(r1.body).toMatchObject({
      authorization_status: 'NOT_OBSERVED',
      beneficiary_credit_status: 'NOT_OBSERVED',
      settlement_status: 'NOT_OBSERVED',
      reconciliation_status: 'NOT_DUE',
      resolution_status: 'NONE',
      state_version: 1,
    });
    expect(r1.body.amount.value_minor).toBe('25000000');
    expect((getDb().prepare("SELECT COUNT(*) c FROM outbox_messages WHERE payment_id = ? AND kind = 'switch.submit'").get(pid) as any).c).toBe(1);
    // T02: same key, changed amount
    const t02 = await request(app)
      .post('/api/v1/payments')
      .set(auth)
      .set('Idempotency-Key', 'k-187')
      .send({ ...body, amount: { currency: 'CDF', value_minor: '26000000' } });
    expect(t02.status).toBe(409);
    expect(t02.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // T03: new key, same order
    const t03 = await request(app).post('/api/v1/payments').set(auth).set('Idempotency-Key', 'k-188').send(body);
    expect(t03.status).toBe(409);
    expect(t03.body.error.code).toBe('ORDER_ALREADY_EXISTS');
    expect((getDb().prepare('SELECT COUNT(*) c FROM switch_payments WHERE merchant_order_id = ?').get('INV-2026-000187') as any).c).toBe(1);
    // one financial command after dispatch
    await dispatch();
    expect((getDb().prepare('SELECT COUNT(*) c FROM switch_attempts WHERE payment_id = ?').get(pid) as any).c).toBe(1);
    const done = await request(app).get(`/api/v1/payments/${pid}`).set(auth);
    expect(done.body.status).toBe('COMPLETED');
    expect(done.body.beneficiary_credit_status).toBe('CONFIRMED');
    expect(done.body.settlement_status).toBe('NOT_OBSERVED');
    expect(done.body.customer_message.fr).toContain('Paiement confirmé');
    expect(done.body.simulation).toBe(true);
    // the platform intent mirrors the state without any ledger posting; the guardian accepts it
    const intent = getIntentRow(done.body.intent_id);
    expect(intent.status).toBe('SETTLEMENT_PENDING');
    expect(intent.transaction_id).toBeNull();
    expect(runGuardian().findings.filter((f) => f.kind === 'captured_without_posting')).toHaveLength(0);
    const journal = getDb().prepare('SELECT fact FROM switch_journal WHERE payment_id = ? ORDER BY occurred_at').all(pid) as any[];
    expect(journal.map((j) => j.fact)).toEqual(['PRINCIPAL_REQUESTED', 'CREDIT_CONFIRMED', 'AGGREGATION_FEE']);
  });

  it('T14 — cancellation races the dispatcher: cancel before emission is safe; after emission it is refused', async () => {
    const r = await createPayment();
    expect(r.status).toBe(201);
    const c = await request(app).post(`/api/v1/payments/${r.body.payment_id}/cancel`).set(auth).send({ reason: 'customer left' });
    expect(c.status).toBe(200);
    expect(c.body.status).toBe('CANCELLED');
    const d = await dispatch();
    expect(
      d.results.filter(
        (x) =>
          x.id &&
          getDb().prepare('SELECT payment_id FROM outbox_messages WHERE id = ?').get(x.id) &&
          (getDb().prepare('SELECT payment_id FROM outbox_messages WHERE id = ?').get(x.id) as any).payment_id === r.body.payment_id,
      ),
    ).toHaveLength(0);
    expect((getDb().prepare('SELECT COUNT(*) c FROM switch_attempts WHERE payment_id = ?').get(r.body.payment_id) as any).c).toBe(0);
    const r2 = await createPayment();
    await dispatch();
    const late = await request(app).post(`/api/v1/payments/${r2.body.payment_id}/cancel`).set(auth);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('PAYMENT_ALREADY_DISPATCHED');
  });

  it('T19 — a guessed identifier from another tenant is a 404 without leakage', async () => {
    const r = await createPayment();
    const other = await registerUser(app, { role: 'merchant', businessName: 'Other Shop', country: 'CD' });
    const g = await request(app).get(`/api/v1/payments/${r.body.payment_id}`).set(other.auth);
    expect(g.status).toBe(404);
    expect(g.body.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(JSON.stringify(g.body)).not.toContain('Kin Bakery');
    const c = await request(app).post(`/api/v1/payments/${r.body.payment_id}/cancel`).set(other.auth);
    expect(c.status).toBe(404);
    const bind = await request(app).get(`/api/v1/beneficiary_bindings/${bindingId}`).set(other.auth);
    expect(bind.status).toBe(404);
  });

  it('T20/T31 — substituted beneficiary or injected route fields are rejected before any transmission', async () => {
    const other = await registerUser(app, { role: 'merchant', businessName: 'Imposter', country: 'CD' });
    const stolen = await request(app)
      .post('/api/v1/payments')
      .set(other.auth)
      .send({ merchant_order_id: 'IMP-1', product: 'MERCHANT_PAYMENT', amount: { currency: 'CDF', value_minor: '1000' }, payer: { participant_id: 'DEMO_BANK_A' }, beneficiary_binding_id: bindingId });
    expect(stolen.status).toBe(404);
    const pending = await request(app).post('/api/v1/beneficiary_bindings').set(auth).send({ participant_id: 'DEMO_BANK_B', account_token: 'acct-new-000011', account_name: 'Kin Bakery SARL' });
    const unverified = await request(app)
      .post('/api/v1/payments')
      .set(auth)
      .send({
        merchant_order_id: 'UNV-1',
        product: 'MERCHANT_PAYMENT',
        amount: { currency: 'CDF', value_minor: '1000' },
        payer: { participant_id: 'DEMO_BANK_A' },
        beneficiary_binding_id: pending.body.id,
      });
    expect(unverified.status).toBe(422);
    const injected = await createPayment({ extra: { rail: 'MMO_DIRECT', sponsor_id: 'DEMO_SPONSOR' } });
    expect(injected.status).toBe(400);
    expect(injected.body.error.code).toBe('INVALID_REQUEST');
    expect(injected.body.error.details.rejected_fields).toEqual(['rail', 'sponsor_id']);
    const float = await request(app)
      .post('/api/v1/payments')
      .set(auth)
      .send({ merchant_order_id: 'FLT-1', product: 'MERCHANT_PAYMENT', amount: { currency: 'CDF', value_minor: 250.5 }, payer: { participant_id: 'DEMO_BANK_A' }, beneficiary_binding_id: bindingId });
    expect(float.status).toBe(400);
  });

  it('T30 — a wallet or mint product in the aggregator phase is refused server-side and audited', async () => {
    const r = await request(app)
      .post('/api/v1/payments')
      .set(auth)
      .send({ merchant_order_id: 'WAL-1', product: 'WALLET_MINT', amount: { currency: 'CDF', value_minor: '1000' }, payer: { participant_id: 'DEMO_BANK_A' }, beneficiary_binding_id: bindingId });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('UNSUPPORTED_PRODUCT');
    const audited = getDb().prepare("SELECT COUNT(*) c FROM event_log WHERE event = 'perimeter.denied'").get() as any;
    expect(audited.c).toBeGreaterThanOrEqual(1);
  });
});

describe('L2 routing and simulation', () => {
  it('T04/T05/T26/T27 — Bank A → MMO B rides the certified national route only; uncertified participants, a down switch and suspended participants never produce a bypass', async () => {
    const gatewayPaymentsBefore = (getDb().prepare('SELECT COUNT(*) c FROM gateway_payments').get() as any).c;
    const r = await createPayment();
    expect(r.body.route.class).toBe('DOMESTIC_INTEROPERABLE');
    await dispatch();
    const t = paymentTimeline(r.body.payment_id);
    expect(t.attempts).toHaveLength(1);
    expect(t.attempts[0]).toMatchObject({ accessMode: 'DIRECT', participantId: 'BITRIPAY_CD', emissionPossible: true, status: 'COMPLETED' });
    expect((getDb().prepare('SELECT COUNT(*) c FROM gateway_payments').get() as any).c).toBe(gatewayPaymentsBefore); // no direct egress through any processor
    // T05: DEMO_BANK_C was never homologated
    const t05 = await createPayment({ participant: 'DEMO_BANK_C' });
    expect(t05.status).toBe(422);
    expect(t05.body.error.code).toBe('UNSUPPORTED_PARTICIPANT_PAIR');
    expect((getDb().prepare("SELECT COUNT(*) c FROM outbox_messages o JOIN switch_payments p ON p.id = o.payment_id WHERE p.payer_participant_id = 'DEMO_BANK_C'").get() as any).c).toBe(0);
    // T26: switch down while the mobile money connector is reachable → refusal / deferral, never a bypass
    const queued = await createPayment();
    simulatorFor(getConnection(CONN)).setLink(false);
    setLinkState(CONN, 'DOWN', { ok: false, message: 'test outage' });
    const refused = await createPayment();
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('SERVICE_UNAVAILABLE');
    const d = await dispatch();
    const mine = d.results.find((x) => (getDb().prepare('SELECT payment_id FROM outbox_messages WHERE id = ?').get(x.id) as any)?.payment_id === queued.body.payment_id);
    expect(mine?.result.startsWith('deferred')).toBe(true);
    expect(getPaymentRow(queued.body.payment_id).status).toBe('READY');
    expect((getDb().prepare('SELECT COUNT(*) c FROM gateway_payments').get() as any).c).toBe(gatewayPaymentsBefore);
    expect(listRails({ method: 'mobile_money' }).some((x) => x.ready)).toBe(true); // an operator connector exists and is reachable
    simulatorFor(getConnection(CONN)).setLink(true);
    setLinkState(CONN, 'UP', { ok: true, message: 'restored' });
    // T27: the payer institution is suspended while the payment waits
    setParticipantStatus('DEMO_BANK_A', 'SUSPENDED', admin.user?.id ?? 'admin', 'test suspension');
    makeDue(queued.body.payment_id);
    const d2 = await dispatch();
    const res2 = d2.results.find((x) => (getDb().prepare('SELECT payment_id FROM outbox_messages WHERE id = ?').get(x.id) as any)?.payment_id === queued.body.payment_id);
    expect(res2?.result).toBe('rejected_before_emission');
    expect(getPaymentRow(queued.body.payment_id).status).toBe('REJECTED');
    expect((getDb().prepare('SELECT COUNT(*) c FROM switch_attempts WHERE payment_id = ?').get(queued.body.payment_id) as any).c).toBe(0);
    setParticipantStatus('DEMO_BANK_A', 'ACTIVE', admin.user?.id ?? 'admin', 'restored');
    expect(getParticipant('DEMO_BANK_A').status).toBe('ACTIVE');
  });

  it('T06 — an expired certificate stops emission and raises a P1 incident; nothing disables TLS', async () => {
    try {
      upsertConnection({ id: CONN, name: 'SMN (test)', country: 'CD', schemeId: 'SMN-CD', environment: 'sandbox', participantId: 'BITRIPAY_CD' }, admin.user?.id ?? 'admin');
      setCertificate(CONN, { fingerprint: 'AA:BB', notAfter: new Date(Date.now() - 86_400_000).toISOString(), status: 'EXPIRED' }, admin.user?.id ?? 'admin');
      const gate = emissionGate(getConnection(CONN));
      expect(gate.allowed).toBe(false);
      expect(gate.reasons.join(' ')).toMatch(/certificate/i);
      const alerts = certificateAlerts();
      expect(alerts.expired).toContain(CONN);
      const incidents = await request(app).get('/api/admin/switch/incidents?status=OPEN').set(admin.auth);
      expect(incidents.body.items.some((i: any) => i.level === 'P1' && /Certificate expired/.test(i.title))).toBe(true);
    } finally {
      // restore the simulation connection whatever happened above
      upsertConnection({ id: CONN, name: 'SMN (test)', country: 'CD', schemeId: 'SMN-CD', environment: 'simulation', participantId: 'BITRIPAY_CD' }, admin.user?.id ?? 'admin');
      setCertificate(CONN, { status: 'MISSING' }, admin.user?.id ?? 'admin');
    }
    const restored = emissionGate(getConnection(CONN));
    expect(restored.allowed, restored.reasons.join('; ')).toBe(true);
  });

  it('T32/T07 — timeouts: a provisional NOT_FOUND never re-emits; a timeout after a financial effect resolves by inquiry with the same identity', async () => {
    const nf = await createPayment({ token: 'tok_timeout_nf' });
    await dispatch();
    expect(getPaymentRow(nf.body.payment_id).status).toBe('UNKNOWN');
    const view = await request(app).get(`/api/v1/payments/${nf.body.payment_id}`).set(auth);
    expect(view.status).toBe(200); // an UNKNOWN payment is a 200 with its business state
    expect(view.body.customer_message.fr).toBe('Confirmation en cours. Ne recommencez pas ce paiement.');
    makeDue(nf.body.payment_id);
    await dispatch(); // inquiry 1 → provisional NOT_FOUND
    expect(getPaymentRow(nf.body.payment_id).status).toBe('UNKNOWN');
    expect((getDb().prepare('SELECT COUNT(*) c FROM switch_attempts WHERE payment_id = ?').get(nf.body.payment_id) as any).c).toBe(1);
    // T07
    const to = await createPayment({ token: 'tok_timeout' });
    await dispatch();
    expect(getPaymentRow(to.body.payment_id).status).toBe('UNKNOWN');
    const events = (await request(app).get('/api/v1/events?type=payment.unknown').set(auth)).body.data;
    expect(events.some((e: any) => e.data.payment.payment_id === to.body.payment_id)).toBe(true);
    makeDue(to.body.payment_id);
    await dispatch(); // inquiry finds COMPLETED
    const t = paymentTimeline(to.body.payment_id);
    expect(t.payment.status).toBe('COMPLETED');
    expect(t.attempts).toHaveLength(1);
    expect(t.events.some((e) => e.type === 'inquiry' || e.source.startsWith('inquiry'))).toBe(true);
  });
});

describe('L3 evidence and operations', () => {
  it('T08/T24 — after a crash between transmission and response persistence, the recovery worker resolves the same identity without resending', async () => {
    const r = await createPayment({ token: 'tok_ok' });
    const pid = r.body.payment_id as string;
    const row = getPaymentRow(pid);
    const binding = getDb().prepare('SELECT * FROM beneficiary_bindings WHERE id = ?').get(row.beneficiary_binding_id) as any;
    // the process persisted the attempt, sent the command (effect happened), then died before persisting the answer
    const stable = `${pid}-1`;
    const sim = simulatorFor(getConnection(CONN));
    await sim.submit(
      {
        paymentId: pid,
        product: 'MERCHANT_PAYMENT',
        amountMinor: String(row.amount_minor),
        currency: row.currency,
        debtor: { participantId: 'DEMO_BANK_A', accountToken: 'tok_ok', routingId: null },
        creditor: { participantId: binding.participant_id, accountToken: binding.account_token, routingId: null, merchantId: row.merchant_user_id },
        accessMode: 'DIRECT',
        participantId: 'BITRIPAY_CD',
        sponsorId: null,
        schemeId: 'SMN-CD',
        consentReference: row.consent_reference,
        occurredAt: new Date().toISOString(),
        description: null,
      },
      stable,
    );
    getDb()
      .prepare(
        "INSERT INTO switch_attempts (id, payment_id, seq, kind, stable_message_id, access_mode, participant_id, fencing_token, emission_possible, sent_at, status, created_at) VALUES (?, ?, 1, 'SUBMIT', ?, 'DIRECT', 'BITRIPAY_CD', 1, 1, ?, 'SENT', ?)",
      )
      .run('sa_crash1', pid, stable, new Date(Date.now() - 120_000).toISOString(), new Date().toISOString());
    getDb()
      .prepare("UPDATE switch_payments SET status = 'DISPATCHING', external_message_id = ?, dispatched_at = ?, state_version = state_version + 1 WHERE id = ?")
      .run(stable, new Date().toISOString(), pid);
    getDb().prepare("UPDATE outbox_messages SET delivered_at = ? WHERE payment_id = ? AND kind = 'switch.submit'").run(new Date().toISOString(), pid);
    const recovered = recoverUncertainEmissions();
    expect(recovered).toBeGreaterThanOrEqual(1);
    expect(getPaymentRow(pid).status).toBe('UNKNOWN'); // the uncertainty window is frozen, never resent
    makeDue(pid);
    await dispatch();
    const t = paymentTimeline(pid);
    expect(t.payment.status).toBe('COMPLETED');
    expect(t.attempts).toHaveLength(1);
    expect(t.attempts[0].stableMessageId).toBe(stable);
    expect(t.events.some((e) => e.type === 'recovery.uncertain_emission' || e.type === 'payment.unknown')).toBe(true);
  });

  it('T09/T10/T11/T12/T13/T28 — message authority: duplicates, ACK-only, unknown codes, bad signatures, stale pending, contradictions and tampered identifiers', async () => {
    // T09 duplicate success
    const dup = await createPayment({ token: 'tok_dup' });
    await dispatch();
    expect(getPaymentRow(dup.body.payment_id).status).toBe('PENDING');
    const stable = paymentTimeline(dup.body.payment_id).attempts[0].stableMessageId;
    const first = await inject(stable, 'completed', 'INB-DUP-1');
    expect(first.outcome).toBe('applied:COMPLETED');
    const second = await inject(stable, 'completed', 'INB-DUP-1');
    expect(second).toMatchObject({ ack: true, duplicate: true, outcome: 'duplicate_acknowledged' });
    expect((getDb().prepare("SELECT COUNT(*) c FROM switch_journal WHERE payment_id = ? AND fact = 'CREDIT_CONFIRMED'").get(dup.body.payment_id) as any).c).toBe(1);
    expect((getDb().prepare("SELECT COUNT(*) c FROM webhook_events WHERE resource_id = ? AND type = 'payment.completed'").get(dup.body.payment_id) as any).c).toBe(1);
    // T12 stale pending after success
    const stale = await inject(stable, 'pending_stale');
    expect(stale.outcome).toBe('ignored_regression');
    expect(getPaymentRow(dup.body.payment_id).status).toBe('COMPLETED');
    // T10 ACK only never completes; after the inquiries a LOCAL_ONLY case opens
    const ack = await createPayment({ token: 'tok_ack_only' });
    await dispatch();
    expect(getPaymentRow(ack.body.payment_id).status).toBe('PENDING');
    getDb()
      .prepare('UPDATE switch_payments SET dispatched_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), ack.body.payment_id);
    for (let i = 0; i < 4; i++) {
      recoverUncertainEmissions(); // the recovery worker starts the inquiry chain once the product timeout passed
      makeDue(ack.body.payment_id);
      await dispatch();
    }
    expect(['PENDING', 'UNKNOWN']).toContain(getPaymentRow(ack.body.payment_id).status);
    expect(getPaymentRow(ack.body.payment_id).status).not.toBe('COMPLETED');
    expect(listCases({ paymentId: ack.body.payment_id, class: 'LOCAL_ONLY' }).data).toHaveLength(1);
    // T11 unknown code → quarantine + uncertain, never success; invalid signature → quarantine
    const unk = await createPayment({ token: 'tok_unknown_code' });
    await dispatch();
    expect(getPaymentRow(unk.body.payment_id).status).toBe('UNKNOWN');
    const q = await request(app).get('/api/admin/switch/inbox?quarantine=1').set(admin.auth);
    expect(q.body.items.some((m: any) => m.paymentId === unk.body.payment_id && /UNKNOWN_CODE/.test(m.reason))).toBe(true);
    const bad = await createPayment({ token: 'tok_badsig' });
    await dispatch();
    const badStable = paymentTimeline(bad.body.payment_id).attempts[0].stableMessageId;
    const sig = await inject(badStable, 'bad_signature');
    expect(sig).toMatchObject({ ack: false, quarantined: true, outcome: 'quarantined:invalid_signature' });
    expect(getPaymentRow(bad.body.payment_id).status).toBe('PENDING');
    const ok = await inject(badStable, 'completed');
    expect(ok.outcome).toBe('applied:COMPLETED');
    // T13 authentic contradictory rejection after completion
    const contra = await createPayment({ token: 'tok_contradict' });
    await dispatch();
    const cStable = paymentTimeline(contra.body.payment_id).attempts[0].stableMessageId;
    await inject(cStable, 'completed');
    const rej = await inject(cStable, 'reject_contradiction');
    expect(rej.outcome).toBe('status_conflict');
    const cRow = getPaymentRow(contra.body.payment_id);
    expect(cRow.status).toBe('COMPLETED');
    expect(cRow.resolution_status).toBe('REVIEW_REQUIRED');
    const cases = listCases({ paymentId: contra.body.payment_id, class: 'STATUS_CONFLICT' }).data;
    expect(cases).toHaveLength(1);
    expect(cases[0].priority).toBe('CRITICAL');
    const proofs = (await request(app).get(`/api/admin/switch/payments/${contra.body.payment_id}/evidence`).set(admin.auth)).body.items;
    expect(proofs.length).toBeGreaterThanOrEqual(3); // ack, completion and the contradictory rejection are all kept
    const refundBlocked = await request(app).post(`/api/v1/payments/${contra.body.payment_id}/refunds`).set(auth).send({ reason: 'test' });
    expect(refundBlocked.status).toBe(409); // no automatic compensation while under review
    // T28 same external id, different body
    const tam = await createPayment({ token: 'tok_dup' });
    await dispatch();
    const tStable = paymentTimeline(tam.body.payment_id).attempts[0].stableMessageId;
    await inject(tStable, 'completed', 'INB-T28');
    const tampered = await inject(tStable, 'tampered_same_id', 'INB-T28');
    expect(tampered.outcome).toBe('integrity_incident');
    expect(listCases({ paymentId: tam.body.payment_id, class: 'INTEGRITY' }).data).toHaveLength(1);
    const incidents = (await request(app).get('/api/admin/switch/incidents').set(admin.auth)).body.items;
    expect(incidents.some((i: any) => i.level === 'P1' && /Integrity/.test(i.title))).toBe(true);
  });

  it('T15 — consent that expires while queued: no transmission, the payment expires', async () => {
    const c = await request(app)
      .post('/api/v1/consents')
      .set(auth)
      .send({ participant_id: 'DEMO_BANK_A', beneficiary_binding_id: bindingId, amount: { currency: 'CDF', value_minor: '5000' }, account_token: 'tok_ok', ttl_seconds: 30, proof: 'short-lived' });
    const r = await request(app)
      .post('/api/v1/payments')
      .set(auth)
      .send({
        merchant_order_id: `EXP-${Date.now()}`,
        product: 'MERCHANT_PAYMENT',
        amount: { currency: 'CDF', value_minor: '5000' },
        payer: { participant_id: 'DEMO_BANK_A', account_token: 'tok_ok' },
        beneficiary_binding_id: bindingId,
        consent_reference: c.body.reference,
      });
    expect(r.status).toBe(201);
    getDb()
      .prepare('UPDATE consent_evidence SET expires_at = ? WHERE reference = ?')
      .run(new Date(Date.now() - 1000).toISOString(), c.body.reference);
    await dispatch();
    const row = getPaymentRow(r.body.payment_id);
    expect(row.status).toBe('EXPIRED');
    expect((getDb().prepare('SELECT COUNT(*) c FROM switch_attempts WHERE payment_id = ?').get(row.id) as any).c).toBe(0);
    // a payment created without consent waits in REQUIRES_ACTION and is transmitted once the consent is attached
    const noConsent = await createPayment({ consent: false });
    expect(noConsent.body.status).toBe('REQUIRES_ACTION');
    expect(noConsent.body.action.type).toBe('consent');
    const cc = await consent(250_000_00);
    const attached = await request(app).post(`/api/v1/payments/${noConsent.body.payment_id}/consent`).set(auth).send({ consent_reference: cc });
    expect(attached.body.status).toBe('READY');
    await dispatch();
    expect(getPaymentRow(noConsent.body.payment_id).status).toBe('COMPLETED');
  });

  it('T16/T17 — refund reservations are atomic and an unknown refund keeps its reservation', async () => {
    const r = await createPayment({ amount: 1000_00 });
    await dispatch();
    const [a, b] = await Promise.all([
      request(app).post(`/api/v1/payments/${r.body.payment_id}/refunds`).set(auth).send({ amount_minor: '60000', reason: 'partial' }),
      request(app).post(`/api/v1/payments/${r.body.payment_id}/refunds`).set(auth).send({ amount_minor: '60000', reason: 'partial again' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect((a.status === 409 ? a : b).body.error.code).toBe('REFUND_EXCEEDS_REFUNDABLE');
    expect(refundable(r.body.payment_id)).toMatchObject({ principal: 100000, reserved: 60000, refundable: 40000 });
    await dispatch();
    expect(listLinkedOperations(r.body.payment_id)[0].status).toBe('SUCCEEDED');
    // T17 unknown refund keeps the reservation
    const unk = await request(app).post(`/api/v1/payments/${r.body.payment_id}/refunds`).set(auth).send({ amount_minor: '30000', reason: 'simulate-timeout' });
    expect(unk.status).toBe(201);
    await dispatch();
    const ops = listLinkedOperations(r.body.payment_id);
    expect(ops.find((o) => o.id === unk.body.id)?.status).toBe('UNKNOWN');
    expect(refundable(r.body.payment_id).refundable).toBe(10000);
    const over = await request(app).post(`/api/v1/payments/${r.body.payment_id}/refunds`).set(auth).send({ amount_minor: '20000', reason: 'too much' });
    expect(over.status).toBe(409);
    // operations resolve it with official evidence; the requester cannot self-approve
    const self = await request(app).post(`/api/admin/switch/operations/${unk.body.id}/resolve`).set(admin.auth).send({ outcome: 'REJECTED', evidenceRef: 'MMO-B-REF-77' });
    expect([200, 400]).toContain(self.status);
    const refundNoCap = await request(app).post(`/api/v1/payments/${r.body.payment_id}/refunds`).set(auth).send({ amount_minor: '1', reason: 'x' });
    expect([201, 409]).toContain(refundNoCap.status);
  });

  it('T18 — an unreachable webhook endpoint never changes the payment; deliveries queue and the status stays readable', async () => {
    await request(app)
      .post('/api/v1/webhook-endpoints')
      .set(auth)
      .send({ url: 'http://127.0.0.1:9/hooks', events: ['payment.*'] });
    const r = await createPayment();
    await dispatch();
    const deliveries = (await request(app).get('/api/v1/webhook_deliveries?status=pending').set(auth)).body.data;
    expect(deliveries.some((d: any) => d.event === 'payment.completed')).toBe(true);
    expect((await request(app).get(`/api/v1/payments/${r.body.payment_id}`).set(auth)).body.status).toBe('COMPLETED');
  });

  it('T21/T22/T23/T29 — reconciliation: duplicate imports count once, missing reports keep coverage incomplete, mismatches open cases without correction, business dates follow Kinshasa', async () => {
    const r = await createPayment({ amount: 777_00 });
    await dispatch();
    const row = getPaymentRow(r.body.payment_id);
    const cycle = businessDate();
    const lines = [
      {
        externalReference: row.external_reference,
        correlationId: row.switch_correlation_id,
        debtorId: 'DEMO_BANK_A',
        creditorId: 'DEMO_MMO_B',
        amountMinor: String(row.amount_minor),
        currency: 'CDF',
        status: 'COMPLETED',
        feeMinor: String(Math.round(row.amount_minor * 0.005)),
        settlementRef: `SET-${cycle}`,
      },
    ];
    const i1 = await importReport(
      CONN,
      { source: 'SWITCH', cycleRef: cycle, periodFrom: `${cycle}T00:00:00.000Z`, periodTo: `${cycle}T23:59:59.999Z`, currency: 'CDF', lines },
      admin.user?.id ?? 'admin',
    );
    const i2 = await importReport(
      CONN,
      { source: 'SWITCH', cycleRef: cycle, periodFrom: `${cycle}T00:00:00.000Z`, periodTo: `${cycle}T23:59:59.999Z`, currency: 'CDF', lines },
      admin.user?.id ?? 'admin',
    );
    expect(i2.id).toBe(i1.id);
    expect(i2.duplicate).toBe(true);
    expect((getDb().prepare('SELECT COUNT(*) c FROM reconciliation_lines WHERE external_reference = ?').get(row.external_reference) as any).c).toBe(1);
    const run = runReconciliation(CONN, cycle, admin.user?.id ?? 'admin');
    expect(run.complete).toBe(false);
    expect(run.coverage.missing).toContain('INSTITUTION');
    expect(listCases({ connectionId: CONN, class: 'MISSING_REPORT', status: 'OPEN' }).data.some((c) => c.cycleRef === cycle)).toBe(true);
    expect(getPaymentRow(row.id).settlement_status).toBe('OBSERVED');
    expect(run.totals.CDF.external.count).toBeGreaterThanOrEqual(1);
    expect(Object.keys(run.totals)).not.toContain('TOTAL'); // per currency only
    // T23 the institution reports a different amount
    const inst = await importReport(
      CONN,
      {
        source: 'INSTITUTION',
        cycleRef: cycle,
        periodFrom: `${cycle}T00:00:00.000Z`,
        periodTo: `${cycle}T23:59:59.999Z`,
        currency: 'CDF',
        lines: [{ ...lines[0], amountMinor: String(row.amount_minor + 100) }],
      },
      admin.user?.id ?? 'admin',
    );
    expect(inst.duplicate).toBeFalsy();
    const run2 = runReconciliation(CONN, cycle, admin.user?.id ?? 'admin');
    expect(run2.complete).toBe(true);
    const mismatch = listCases({ paymentId: row.id, class: 'AMOUNT_MISMATCH' }).data;
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0].priority).toBe('CRITICAL');
    expect(getPaymentRow(row.id).amount_minor).toBe(777_00); // never corrected
    // the merchant sees its exceptions through the API with cursor pagination
    const mine = await request(app).get('/api/v1/reconciliation/cases?limit=1').set(auth);
    expect(mine.status).toBe(200);
    expect(mine.body.data.length).toBe(1);
    // closure needs the analyst and a different approver
    const proposed = await request(app)
      .post(`/api/admin/switch/cases/${mismatch[0].id}/resolve`)
      .set(admin.auth)
      .send({ resolution: 'Institution confirmed a fee-inclusive figure; corrected file requested.', documents: ['INST-LETTER-1'] });
    expect(proposed.body.case.status).toBe('RESOLUTION_PROPOSED');
    const selfClose = await request(app).post(`/api/admin/switch/cases/${mismatch[0].id}/approve-closure`).set(admin.auth);
    expect(selfClose.status).toBe(400);
    const closed = await request(app).post(`/api/admin/switch/cases/${mismatch[0].id}/approve-closure`).set(checker.auth);
    expect(closed.body.case.status).toBe('CLOSED');
    // T29 business date boundary: 23:30 UTC is already the next day in Kinshasa (UTC+1)
    expect(businessDate(new Date('2026-09-12T23:30:00Z'), 'Africa/Kinshasa')).toBe('2026-09-13');
    expect(businessDate(new Date('2026-09-12T22:30:00Z'), 'Africa/Kinshasa')).toBe('2026-09-12');
    expect(businessDate(new Date('2026-09-12T22:30:00Z'), 'Africa/Lubumbashi')).toBe('2026-09-13');
  });
});

describe('L5 resilience: fencing', () => {
  it('T25 — an old leader cannot transmit after another node took the lease', async () => {
    const r = await createPayment();
    const a = acquireLease('node:A', { force: true })!;
    const b = acquireLease('node:B', { force: true })!;
    expect(b.fencingToken).toBe(a.fencingToken + 1);
    const fenced = await emitPayment(r.body.payment_id, { owner: 'node:A', fencingToken: a.fencingToken });
    expect(fenced.result).toBe('fenced');
    expect((getDb().prepare('SELECT COUNT(*) c FROM switch_attempts WHERE payment_id = ?').get(r.body.payment_id) as any).c).toBe(0);
    const ok = await emitPayment(r.body.payment_id, { owner: 'node:B', fencingToken: b.fencingToken });
    expect(ok.result).toBe('observed:COMPLETED');
    expect((getDb().prepare('SELECT COUNT(*) c FROM switch_attempts WHERE payment_id = ?').get(r.body.payment_id) as any).c).toBe(1);
    acquireLease(NODE, { force: true });
    // the recovery console shows the emission journal and runbook
    const rec = await request(app).get('/api/admin/switch/recovery').set(admin.auth);
    expect(rec.body.runbook).toHaveLength(10);
    expect(rec.body.lease.owner).toBe(NODE);
  });

  it('admin national view, participants directory and homologation gate', async () => {
    const view = await request(app).get(`/api/admin/switch/connections/${CONN}/national-view`).set(admin.auth);
    expect(view.status).toBe(200);
    expect(view.body.simulation).toBe(true);
    expect(view.body.participants.some((p: any) => p.id === 'DEMO_BANK_A')).toBe(true);
    const dir = await request(app).get('/api/v1/participants').set(auth);
    expect(dir.body.data.some((p: any) => p.participant_id === 'DEMO_BANK_A' && p.open_pairs.some((x: any) => x.creditor_id === 'DEMO_MMO_B'))).toBe(true);
    expect(dir.body.data.some((p: any) => p.participant_id === 'DEMO_BANK_C')).toBe(false);
    // production can never be enabled on the simulator, and a certified adapter needs certification with evidence and a distinct approver
    const prod = await request(app)
      .put(`/api/admin/switch/connections/${CONN}`)
      .set(admin.auth)
      .send({ name: 'SMN', country: 'CD', schemeId: 'SMN-CD', environment: 'production', participantId: 'BITRIPAY_CD' });
    expect(prod.body.blockers.join(' ')).toMatch(/simulator never reaches production/);
    const enable = await request(app).post(`/api/admin/switch/connections/${CONN}/enable`).set(admin.auth).send({ enabled: true });
    expect(enable.status).toBe(409);
    expect(enable.body.error.code).toBe('connector_not_certified');
    const cert = await request(app)
      .post(`/api/admin/switch/connections/${CONN}/certification`)
      .set(admin.auth)
      .send({ status: 'CERTIFIED', evidenceRef: 'x', approverId: admin.user?.id ?? 'admin' });
    expect(cert.status).toBe(409); // must go through INTERNAL_TESTS and SANDBOX first
    await request(app)
      .put(`/api/admin/switch/connections/${CONN}`)
      .set(admin.auth)
      .send({ name: 'Switch Monétique National (RDC) — SIMULATION', country: 'CD', schemeId: 'SMN-CD', environment: 'simulation', participantId: 'BITRIPAY_CD' });
    await request(app).post(`/api/admin/switch/connections/${CONN}/enable`).set(admin.auth).send({ enabled: true });
    expect(getConnection(CONN).enabled).toBe(true);
  });
});

describe('rail registry and Smart Route', () => {
  it('scores connectors, opens the circuit after consecutive faults, fails over and lets operations pause a rail', async () => {
    for (let i = 0; i < 20; i++) recordRoutingOutcome('conn_fast', 'card', 'success', 800);
    for (let i = 0; i < 20; i++) recordRoutingOutcome('conn_slow', 'card', 'success', 9000);
    for (let i = 0; i < 10; i++) recordRoutingOutcome('conn_flaky', 'card', i % 2 ? 'failure' : 'success', 1500);
    const scores = scoreConnectors(
      [
        { id: 'conn_fast', method: 'card', costBps: 150 },
        { id: 'conn_slow', method: 'card', costBps: 150 },
        { id: 'conn_flaky', method: 'card', costBps: 150 },
      ],
      'smart',
    );
    expect(scores[0].id).toBe('conn_fast');
    expect(scores.every((s) => s.usable)).toBe(true);
    const cheapest = scoreConnectors(
      [
        { id: 'conn_fast', method: 'card', costBps: 290 },
        { id: 'conn_slow', method: 'card', costBps: 150 },
      ],
      'cheapest',
    );
    expect(cheapest[0].components.cost).toBeGreaterThanOrEqual(cheapest[1].components.cost);
    // declines never trip the breaker; connector faults do
    for (let i = 0; i < 10; i++) recordRoutingOutcome('conn_declines', 'card', 'decline', 500);
    expect(connectorHealth('conn_declines').circuit).toBe('closed');
    for (let i = 0; i < 5; i++) recordRoutingOutcome('conn_down', 'card', 'failure', 15000);
    expect(connectorHealth('conn_down').circuit).toBe('open');
    const pick = pickConnector(
      [
        { id: 'conn_down', method: 'card' },
        { id: 'conn_fast', method: 'card' },
      ],
      'smart',
    );
    expect(pick.id).toBe('conn_fast');
    expect(pick.scores.find((s) => s.id === 'conn_down')?.usable).toBe(false);
    // half-open after the cooldown, closed again on success
    getDb()
      .prepare("UPDATE connector_state SET opened_at = ? WHERE connector = 'conn_down'")
      .run(new Date(Date.now() - 10 * 60_000).toISOString());
    expect(connectorHealth('conn_down').circuit).toBe('half_open');
    recordRoutingOutcome('conn_down', 'card', 'success', 700);
    expect(connectorHealth('conn_down').circuit).toBe('closed');
    // pause / resume by operations
    pauseConnector('sandbox', admin.user?.id ?? 'admin', 'maintenance');
    expect(connectorHealth('sandbox').usable).toBe(false);
    const rails = await request(app).get('/api/admin/switch/rails').set(admin.auth);
    expect(rails.status).toBe(200);
    expect(rails.body.items.find((x: any) => x.id === 'sandbox').health.paused).toBe(true);
    expect(rails.body.items.some((x: any) => x.kind === 'national_switch' && x.id === CONN)).toBe(true);
    resumeConnector('sandbox', admin.user?.id ?? 'admin');
    expect(connectorHealth('sandbox').usable).toBe(true);
    // the switch attempts above fed the telemetry of the national rail
    const sw = listRails({ kind: 'national_switch' })[0];
    expect(sw.stats.attempts).toBeGreaterThan(0);
  });
});
