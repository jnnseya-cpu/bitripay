/**
 * Acceptance tests for the Biometric Universal Payment Gateway requirements:
 * lifecycle stages, no-API evidence engine, maker-checker, balanced ledger, idempotency, risk controls,
 * FX disclosure, route declarations and honest interoperability.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { setupApp, registerUser, adminToken, checkerToken, fund, manualConfirm } from './helpers';
import { signWebhookPayload, verifyWebhookSignature } from '../services/webhooks';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

function deviceKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey };
}
function signEvidence(privateKey: import('node:crypto').KeyObject, fields: { deviceId: string; nonce: string; receivedAt: string; from: string; operatorId?: string | null; text: string }) {
  const canonical = [fields.deviceId, fields.nonce, fields.receivedAt, fields.from, fields.operatorId ?? '', fields.text].join('\n');
  return sign(null, Buffer.from(canonical), privateKey).toString('base64');
}

async function setupDirectRail() {
  const admin = await adminToken(app);
  const ops = await request(app).get('/api/mobile-money-operators?country=KE');
  const mpesa = ops.body.items.find((o: any) => o.id === 'mpesa_ke');
  await request(app).put('/api/admin/momo-operators/mpesa_ke').set(admin.auth).send({ ...mpesa, collectionNumber: '0712000000', collectionName: 'BitriPay Ltd', payoutEnabled: true, enabled: true });
  await request(app).put('/api/admin/gateways/manual_momo').set(admin.auth).send({ name: 'Mobile money (direct)', provider: 'manual_momo', enabled: true, methods: ['mobile_money'], currencies: [], credentials: { smsSecret: 'sms-secret' } });
  await request(app).put('/api/admin/settings/gateway').set(admin.auth).send({ value: { sharedSecretAutoConfirm: false, makerChecker: true, adminStepUp: true } });
  const keys = deviceKeys();
  const dev = await request(app).post('/api/admin/evidence/devices').set(admin.auth).send({ name: 'Collection phone KE', publicKey: keys.publicPem, operatorIds: ['mpesa_ke'] });
  expect(dev.status, JSON.stringify(dev.body)).toBe(201);
  return { admin, deviceId: dev.body.device.id as string, ...keys };
}

async function balance(auth: Record<string, string>, currency: string) {
  const w = await request(app).get('/api/wallets').set(auth);
  return w.body.items.find((x: any) => x.currency === currency)?.balance ?? 0;
}

describe('payment lifecycle', () => {
  it('creates an intent for every rail, gates it on biometric/PIN authentication and records every stage change', async () => {
    const u = await registerUser(app, { country: 'KE' });
    // Without authentication the intent stops at AUTHENTICATION_REQUIRED and no instructions are issued.
    const noAuth = await request(app).post('/api/deposits').set(u.auth).send({ method: 'bank', amount: '30', currency: 'USD', gateway: 'manual_bank' });
    expect(noAuth.status).toBe(201);
    expect(noAuth.body.payment.stage).toBe('AUTHENTICATION_REQUIRED');
    expect(noAuth.body.payment.next.type).toBe('authenticate');
    expect(noAuth.body.payment.providerRef).toBeNull();
    const wrong = await request(app).post(`/api/deposits/${noAuth.body.payment.id}/authenticate`).set(u.auth).send({ pin: '0000' });
    expect(wrong.status).toBe(403);
    const authed = await request(app).post(`/api/deposits/${noAuth.body.payment.id}/authenticate`).set(u.auth).send({ pin: '1234' });
    expect(authed.status, JSON.stringify(authed.body)).toBe(200);
    expect(authed.body.payment.stage).toBe('INSTRUCTION_ISSUED');
    expect(authed.body.payment.authMethod).toBe('pin');
    expect(authed.body.payment.next.type).toBe('bank_instructions');
    expect(authed.body.payment.stageGroup).toBe('initiated');

    // Card via the sandbox processor settles end to end; the declaration says it is a sandbox.
    const card = await request(app).post('/api/deposits').set(u.auth).send({ method: 'card', amount: '25', currency: 'USD', pin: '1234', card: { number: '4242424242424242', expMonth: 12, expYear: 2030, cvc: '123', holderName: 'Kim Test' } });
    expect(card.body.payment.stage).toBe('SETTLED');
    expect(card.body.payment.stageGroup).toBe('settled');
    expect(card.body.declaration.carrier).toBe('sandbox');
    expect(card.body.declaration.regulatedRail).toBe(true);
    const events = await request(app).get(`/api/deposits/${card.body.payment.id}/events`).set(u.auth);
    const seq = events.body.items.map((e: any) => e.event);
    expect(seq).toEqual(['payment.created', 'payment.authentication_required', 'payment.authenticated', 'payment.instruction_issued', 'payment.evidence_received', 'payment.verifying', 'payment.confirmed', 'payment.settled']);
    for (const e of events.body.items) {
      expect(e.createdAt).toMatch(/^\d{4}-/);
      expect(e.actorType).toBeTruthy();
    }

    // Mobile money on the direct rail (no operator API) and a wallet-funded route both create intents too.
    const { admin } = await setupDirectRail();
    const momo = await request(app).post('/api/deposits').set(u.auth).send({ method: 'mobile_money', amount: '500', currency: 'KES', operatorId: 'mpesa_ke', phone: '+254712345678', pin: '1234' });
    expect(momo.status, JSON.stringify(momo.body)).toBe(201);
    expect(momo.body.payment.stage).toBe('INSTRUCTION_ISSUED');
    expect(momo.body.declaration.processing).toBe('assisted');
    expect(momo.body.declaration.confirmation).toContain('SMS');
    expect(await balance(u.auth, 'KES')).toBe(0);
    // "I have sent it" moves to PAYMENT_SENT; a screenshot is recorded as non-authoritative and still credits nothing.
    const sent = await request(app).post(`/api/deposits/${momo.body.payment.id}/sent`).set(u.auth).send({ reference: 'QX12ABCD34', image: 'data:image/png;base64,AAAA' });
    expect(sent.body.payment.stage).toBe('PAYMENT_SENT');
    expect(await balance(u.auth, 'KES')).toBe(0);
    const c = await request(app).get(`/api/admin/payments/${momo.body.payment.id}/case`).set(admin.auth);
    expect(c.body.proof.authoritative).toBe(false);
    expect(c.body.evidence).toHaveLength(0);
  });

  it('expires intents that never get confirmed, crediting nothing', async () => {
    const admin = await adminToken(app);
    const u = await registerUser(app);
    await request(app).put('/api/admin/settings/gateway').set(admin.auth).send({ value: { intentExpiryHours: 0.0000001 } });
    const p = await request(app).post('/api/deposits').set(u.auth).send({ method: 'bank', amount: '30', currency: 'USD', gateway: 'manual_bank', pin: '1234' });
    await new Promise((r) => setTimeout(r, 20));
    const later = await request(app).get(`/api/deposits/${p.body.payment.id}`).set(u.auth);
    expect(later.body.payment.stage).toBe('EXPIRED');
    expect(later.body.payment.status).toBe('failed');
    await request(app).put('/api/admin/settings/gateway').set(admin.auth).send({ value: { intentExpiryHours: 48 } });
    expect(await balance(u.auth, 'USD')).toBe(0);
    // A terminal intent cannot be revived by a manual proposal.
    const propose = await request(app).post(`/api/admin/payments/${p.body.payment.id}/confirm`).set(admin.auth).send({});
    expect(propose.status).toBe(409);
  });
});

describe('no-API evidence engine', () => {
  it('authenticates, parses and matches a device-signed operator SMS; rejects bad signatures, replays, duplicates and mismatches', async () => {
    const { admin, deviceId, privateKey } = await setupDirectRail();
    const u = await registerUser(app, { country: 'KE' });
    const dep = await request(app).post('/api/deposits').set(u.auth).send({ method: 'mobile_money', amount: '1000', currency: 'KES', operatorId: 'mpesa_ke', phone: '+254712345678', pin: '1234' });
    const ref = dep.body.payment.providerRef as string;
    const text = `QX7A1B2C3D Confirmed. You have received Ksh1,000.00 from JOHN DOE 254712345678 on 11/9/26 at 10:15 AM. Ref ${ref}. New M-PESA balance is Ksh5,400.00.`;
    const base = { deviceId, receivedAt: new Date().toISOString(), from: 'MPESA', operatorId: 'mpesa_ke', text };

    // Wrong key → rejected, nothing credited.
    const otherKey = deviceKeys();
    const forged = await request(app).post('/api/evidence/sms').send({ ...base, nonce: randomUUID(), signature: signEvidence(otherKey.privateKey, { ...base, nonce: 'x' }) });
    expect(forged.status).toBe(401);
    expect(await balance(u.auth, 'KES')).toBe(0);

    // Parsing dry-run shows what the template extracted.
    const parsed = await request(app).post('/api/admin/evidence/parse-test').set(admin.auth).send({ text, operatorId: 'mpesa_ke' });
    expect(parsed.body.parsed.reference).toBe(ref);
    expect(parsed.body.parsed.amount).toBe('1000.00');
    expect(parsed.body.parsed.externalRef).toBe('QX7A1B2C3D');
    expect(parsed.body.parsed.senderPhone).toBe('254712345678');
    expect(parsed.body.parsed.confidence).toBeGreaterThanOrEqual(80);

    // Properly signed evidence settles the intent.
    const nonce = randomUUID();
    const ok = await request(app).post('/api/evidence/sms').send({ ...base, nonce, signature: signEvidence(privateKey, { ...base, nonce }) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.evidence.outcome).toBe('settled');
    expect(await balance(u.auth, 'KES')).toBe(100000);
    const view = await request(app).get(`/api/deposits/${dep.body.payment.id}`).set(u.auth);
    expect(view.body.payment.stage).toBe('SETTLED');

    // Replaying the exact same signed submission is refused (nonce) and cannot settle again.
    const replay = await request(app).post('/api/evidence/sms').send({ ...base, nonce, signature: signEvidence(privateKey, { ...base, nonce }) });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('evidence_replay');
    // The same message with a fresh nonce is a duplicate submission – still nothing more is credited.
    const n2 = randomUUID();
    const dup = await request(app).post('/api/evidence/sms').send({ ...base, nonce: n2, signature: signEvidence(privateKey, { ...base, nonce: n2 }) });
    expect(dup.body.evidence.outcome).toBe('duplicate');
    expect(await balance(u.auth, 'KES')).toBe(100000);

    // A second intent presented with a receipt whose operator transaction id was already used → DUPLICATE, no credit.
    const dep2 = await request(app).post('/api/deposits').set(u.auth).send({ method: 'mobile_money', amount: '1000', currency: 'KES', operatorId: 'mpesa_ke', phone: '+254712345678', pin: '1234' });
    const ref2 = dep2.body.payment.providerRef as string;
    const reused = { ...base, text: `QX7A1B2C3D Confirmed. You have received Ksh1,000.00 from JOHN DOE 254712345678 on 11/9/26 at 10:20 AM. Ref ${ref2}.` };
    const n3 = randomUUID();
    const dupRef = await request(app).post('/api/evidence/sms').send({ ...reused, nonce: n3, signature: signEvidence(privateKey, { ...reused, nonce: n3 }) });
    expect(dupRef.body.evidence.outcome).toBe('duplicate');
    expect(dupRef.body.evidence.reasons.join(',')).toContain('external_ref_reused');
    const v2 = await request(app).get(`/api/deposits/${dep2.body.payment.id}`).set(u.auth);
    expect(v2.body.payment.stage).toBe('DUPLICATE');
    expect(await balance(u.auth, 'KES')).toBe(100000);

    // Amount / sender mismatches are recorded, never settled.
    const dep3 = await request(app).post('/api/deposits').set(u.auth).send({ method: 'mobile_money', amount: '1000', currency: 'KES', operatorId: 'mpesa_ke', phone: '+254712345678', pin: '1234' });
    const bad = { ...base, text: `QY9Z8Y7X6W Confirmed. You have received Ksh900.00 from JANE ROE 254700000000 on 11/9/26 at 10:30 AM. Ref ${dep3.body.payment.providerRef}.` };
    const n4 = randomUUID();
    const mis = await request(app).post('/api/evidence/sms').send({ ...bad, nonce: n4, signature: signEvidence(privateKey, { ...bad, nonce: n4 }) });
    expect(mis.body.evidence.outcome).toBe('mismatched');
    expect(mis.body.evidence.reasons).toEqual(expect.arrayContaining(['amount_mismatch', 'sender_mismatch']));
    const v3 = await request(app).get(`/api/deposits/${dep3.body.payment.id}`).set(u.auth);
    expect(v3.body.payment.stage).toBe('MISMATCHED');
    expect(await balance(u.auth, 'KES')).toBe(100000);

    // Everything is preserved: raw text, parsed values, verifier identity, outcomes, and the event chain verifies.
    const list = await request(app).get(`/api/admin/evidence?paymentId=${dep.body.payment.id}`).set(admin.auth);
    expect(list.body.items.length).toBeGreaterThanOrEqual(2);
    expect(list.body.items[0].rawText).toContain('Confirmed');
    expect(list.body.items[0].verifier.type).toBe('device');
    const events = await request(app).get(`/api/admin/events?subjectId=${dep.body.payment.id}`).set(admin.auth);
    expect(events.body.chain.ok).toBe(true);
    expect(events.body.items.some((e: any) => e.event === 'evidence.received')).toBe(true);

    // A revoked device can no longer submit.
    await request(app).delete(`/api/admin/evidence/devices/${deviceId}`).set(admin.auth).send({ reason: 'phone lost' });
    const n5 = randomUUID();
    const revoked = await request(app).post('/api/evidence/sms').send({ ...base, nonce: n5, signature: signEvidence(privateKey, { ...base, nonce: n5 }) });
    expect(revoked.status).toBe(403);
  });

  it('routes the legacy shared-secret forwarder and unsupported messages to manual review', async () => {
    const { admin } = await setupDirectRail();
    const u = await registerUser(app, { country: 'KE' });
    const dep = await request(app).post('/api/deposits').set(u.auth).send({ method: 'mobile_money', amount: '250', currency: 'KES', operatorId: 'mpesa_ke', phone: '+254722000111', pin: '1234' });
    const ref = dep.body.payment.providerRef;
    const hook = await request(app).post('/api/webhooks/manual_momo').send({ secret: 'sms-secret', operatorId: 'mpesa_ke', text: `QA1B2C3D4E Confirmed. You have received Ksh250.00 from ANN 254722000111. Ref ${ref}.` });
    expect(hook.status).toBe(200);
    expect(hook.body.evidence.outcome).toBe('review');
    expect(hook.body.evidence.reasons).toContain('shared_secret_not_authoritative');
    const v = await request(app).get(`/api/deposits/${dep.body.payment.id}`).set(u.auth);
    expect(v.body.payment.stage).toBe('MANUAL_REVIEW');
    expect(await balance(u.auth, 'KES')).toBe(0);
    // The verification queue shows it; maker-checker settles it.
    const queue = await request(app).get('/api/admin/verifications').set(admin.auth);
    expect(queue.body.queue.some((p: any) => p.id === dep.body.payment.id)).toBe(true);
    const done = await manualConfirm(app, dep.body.payment.id);
    expect(done.payment.stage).toBe('SETTLED');
    expect(await balance(u.auth, 'KES')).toBe(25000);
    // Unparseable text with no reference is stored as unsupported for a human.
    const junk = await request(app).post('/api/webhooks/manual_momo').send({ secret: 'sms-secret', text: 'Hello, your airtime bundle expires tomorrow' });
    expect(junk.body.evidence.outcome).toBe('unsupported');
  });
});

describe('maker-checker and administrative step-up', () => {
  it('requires a different approver with a fresh step-up, and declining sends the payment back to review', async () => {
    const admin = await adminToken(app);
    const checker = await checkerToken(app);
    const u = await registerUser(app);
    const dep = await request(app).post('/api/deposits').set(u.auth).send({ method: 'bank', amount: '80', currency: 'USD', gateway: 'manual_bank', pin: '1234' });
    const proposed = await request(app).post(`/api/admin/payments/${dep.body.payment.id}/confirm`).set(admin.auth).send({ note: 'Statement line 42' });
    expect(proposed.body.verification.status).toBe('proposed');
    const noStepUp = await request(app).post(`/api/admin/verifications/${proposed.body.verification.id}/approve`).set(checker.auth).send({});
    expect(noStepUp.status).toBe(403);
    expect(await balance(u.auth, 'USD')).toBe(0);
    const declined = await request(app).post(`/api/admin/verifications/${proposed.body.verification.id}/decline`).set(checker.auth).send({ reason: 'Amount differs on statement' });
    expect(declined.body.verification.status).toBe('declined');
    expect(declined.body.payment.stage).toBe('MANUAL_REVIEW');
    // Reject path also needs two people.
    const rej = await request(app).post(`/api/admin/payments/${dep.body.payment.id}/reject`).set(admin.auth).send({ reason: 'Never received' });
    const rejOk = await request(app).post(`/api/admin/verifications/${rej.body.verification.id}/approve`).set(checker.auth).send({ pin: checker.pin });
    expect(rejOk.body.payment.stage).toBe('REJECTED');
    expect(await balance(u.auth, 'USD')).toBe(0);
    // Withdrawal approvals need step-up as well.
    const rich = await registerUser(app);
    await fund(app, rich.user.id, '100.00');
    const bank = await request(app).post('/api/bank-accounts').set(rich.auth).send({ bankName: 'Bank', accountName: 'Rich Person', accountNumber: '99887766', currency: 'USD', pin: '1234' });
    const w = await request(app).post('/api/withdrawals').set(rich.auth).send({ amount: '10', currency: 'USD', bankAccountId: bank.body.bankAccount.id, pin: '1234' });
    // Documentary evidence is mandatory for an administrative settlement proposal …
    const noRef = await request(app).post(`/api/admin/withdrawals/${w.body.transaction.id}/approve`).set(admin.auth).send({});
    expect(noRef.status).toBe(400);
    const wProposed = await request(app).post(`/api/admin/withdrawals/${w.body.transaction.id}/approve`).set(admin.auth).send({ payoutReference: 'BANK-77', note: 'Bank statement line 12 checked' });
    expect(wProposed.status).toBe(200);
    expect(wProposed.body.transaction.status).toBe('pending');
    // … and the checker needs a fresh step-up.
    const noPin = await request(app).post(`/api/admin/verifications/${wProposed.body.verification.id}/approve`).set(checker.auth).send({});
    expect(noPin.status).toBe(403);
    const withPin = await request(app).post(`/api/admin/verifications/${wProposed.body.verification.id}/approve`).set(checker.auth).send({ pin: checker.pin });
    expect(withPin.status).toBe(200);
    const done = await request(app).get(`/api/wallets/transactions/${w.body.transaction.id}`).set(rich.auth);
    expect(done.body.transaction.status).toBe('completed');
  });
});

describe('ledger, audit and idempotency', () => {
  it('keeps every transaction balanced per currency and the event chain intact', async () => {
    const admin = await adminToken(app);
    const a = await registerUser(app);
    await fund(app, a.user.id, '100.00');
    await request(app).post('/api/wallets/exchange').set(a.auth).send({ from: 'USD', to: 'EUR', amount: '20', pin: '1234' });
    const r = await request(app).get('/api/admin/reconcile').set(admin.auth);
    expect(r.body.ledger.ok, JSON.stringify(r.body.ledger)).toBe(true);
    expect(r.body.ledger.unbalancedTransactions).toEqual([]);
    expect(r.body.ledger.walletMismatches).toEqual([]);
    expect(r.body.events.ok).toBe(true);
    expect(r.body.events.checked).toBeGreaterThan(10);
    // Audit and event logs are append-only at the database level.
    const { getDb } = await import('../db');
    expect(() => getDb().prepare("UPDATE event_log SET details = '{}' WHERE seq = 1").run()).toThrow(/append-only/);
    expect(() => getDb().prepare('DELETE FROM ledger_entries').run()).toThrow(/append-only/);
  });

  it('replays identical requests under an Idempotency-Key and refuses key reuse with a different body', async () => {
    const a = await registerUser(app);
    const b = await registerUser(app, { tag: 'idem_rcv' });
    await fund(app, a.user.id, '50.00');
    const key = randomUUID();
    const first = await request(app).post('/api/transfers').set(a.auth).set('Idempotency-Key', key).send({ to: '@idem_rcv', amount: '10', currency: 'USD', pin: '1234' });
    expect(first.status).toBe(201);
    const again = await request(app).post('/api/transfers').set(a.auth).set('Idempotency-Key', key).send({ to: '@idem_rcv', amount: '10', currency: 'USD', pin: '1234' });
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.transaction.id).toBe(first.body.transaction.id);
    expect(await balance(b.auth, 'USD')).toBe(1000);
    const different = await request(app).post('/api/transfers').set(a.auth).set('Idempotency-Key', key).send({ to: '@idem_rcv', amount: '11', currency: 'USD', pin: '1234' });
    expect(different.status).toBe(422);
  });

  it('signs outbound webhooks with a timestamp and rejects stale or tampered signatures', () => {
    const payload = JSON.stringify({ id: 'evt', event: 'payment.completed' });
    const header = signWebhookPayload('whsec', payload);
    expect(header).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
    expect(verifyWebhookSignature('whsec', payload, header)).toBe(true);
    expect(verifyWebhookSignature('whsec', payload + ' ', header)).toBe(false);
    expect(verifyWebhookSignature('other', payload, header)).toBe(false);
    expect(verifyWebhookSignature('whsec', payload, signWebhookPayload('whsec', payload, Math.floor(Date.now() / 1000) - 3600))).toBe(false);
  });
});

describe('risk controls', () => {
  it('blocks sanctioned counterparties, enforces cooling-off for new beneficiaries and holds risky inbound payments', async () => {
    const admin = await adminToken(app);
    const a = await registerUser(app);
    const bad = await registerUser(app, { fullName: 'Blocked Person', tag: 'blocked_p' });
    await fund(app, a.user.id, '1000.00');
    await request(app).post('/api/admin/sanctions').set(admin.auth).send({ kind: 'name', value: 'Blocked Person', note: 'test list' });
    const t = await request(app).post('/api/transfers').set(a.auth).send({ to: '@blocked_p', amount: '5', currency: 'USD', pin: '1234' });
    expect(t.status).toBe(403);
    expect(t.body.error.code).toBe('risk_blocked');
    expect(await balance(bad.auth, 'USD')).toBe(0);
    // A brand-new bank account cannot receive a large payout until the cooling-off period has passed.
    await request(app).put('/api/admin/settings/risk').set(admin.auth).send({ value: { coolingOffAmount: 10_000, coolingOffMinutes: 60 } });
    const bank = await request(app).post('/api/bank-accounts').set(a.auth).send({ bankName: 'New Bank', accountName: 'A Person', accountNumber: '55556666', currency: 'USD', pin: '1234' });
    const big = await request(app).post('/api/withdrawals').set(a.auth).send({ amount: '200', currency: 'USD', bankAccountId: bank.body.bankAccount.id, pin: '1234' });
    expect(big.status).toBe(403);
    expect(big.body.error.code).toBe('cooling_off');
    const small = await request(app).post('/api/withdrawals').set(a.auth).send({ amount: '20', currency: 'USD', bankAccountId: bank.body.bankAccount.id, pin: '1234' });
    expect(small.status).toBe(201);
    // Inbound: a sanctioned payer's card payment stops in MANUAL_REVIEW even though the processor approved it.
    const card = await request(app).post('/api/deposits').set(bad.auth).send({ method: 'card', amount: '25', currency: 'USD', pin: '1234', card: { number: '4242424242424242', expMonth: 12, expYear: 2030, cvc: '123', holderName: 'Blocked Person' } });
    expect(card.body.payment.stage).toBe('MANUAL_REVIEW');
    expect(await balance(bad.auth, 'USD')).toBe(0);
    const risk = await request(app).get('/api/admin/risk-events').set(admin.auth);
    expect(risk.body.items.some((r: any) => r.action !== 'allow')).toBe(true);
  });
});

describe('FX disclosure and route declarations', () => {
  it('discloses rate provider, timestamp, markup and expiry; administrator rates are never guaranteed', async () => {
    const a = await registerUser(app);
    const q = await request(app).get('/api/wallets/exchange/quote?from=USD&to=EUR&amount=100').set(a.auth);
    expect(q.body.fx.sourceCurrency).toBe('USD');
    expect(q.body.fx.targetCurrency).toBe('EUR');
    expect(q.body.fx.midRate).toBeGreaterThan(0);
    expect(q.body.fx.rate).toBeLessThan(q.body.fx.midRate);
    expect(q.body.fx.markupBps).toBe(100);
    // Bundled rates are versioned test rates and are labelled as non-live; they are never guaranteed.
    expect(q.body.fx.provider).toMatch(/^test_rates_v\d+$/);
    expect(q.body.fx.providerLabel).toContain('NOT live');
    expect(q.body.fx.guaranteed).toBe(false);
    expect(q.body.fx.stale).toBe(true);
    expect(q.body.estimatedReceive).toBeGreaterThan(0);
    // With a live provider stamp the quote becomes guaranteed for the TTL and locks the rate.
    const admin = await adminToken(app);
    const { getDb } = await import('../db');
    getDb().prepare("UPDATE currencies SET rate_source = 'frankfurter', rate_updated_at = ? WHERE code = 'EUR'").run(new Date().toISOString());
    const live = await request(app).get('/api/wallets/exchange/quote?from=USD&to=EUR&amount=100').set(a.auth);
    expect(live.body.fx.guaranteed).toBe(true);
    expect(live.body.fx.expiresAt).toBeTruthy();
    expect(live.body.fx.quoteId).toBeTruthy();
    await fund(app, a.user.id, '100.00');
    getDb().prepare("UPDATE currencies SET rate_to_base = rate_to_base * 2 WHERE code = 'EUR'").run(); // market moves after the quote
    const ex = await request(app).post('/api/wallets/exchange').set(a.auth).send({ from: 'USD', to: 'EUR', amount: '10', pin: '1234', quoteId: live.body.fx.quoteId });
    expect(ex.status, JSON.stringify(ex.body)).toBe(201);
    expect(ex.body.guaranteed).toBe(true);
    expect(ex.body.rate).toBeCloseTo(live.body.fx.rate, 6);
    getDb().prepare("UPDATE currencies SET rate_to_base = rate_to_base / 2, rate_source = 'manual' WHERE code = 'EUR'").run();
    void admin;
  });

  it('declares initiation, confirmation, settlement, timing, fees, refund and processing mode for every logical route', async () => {
    const a = await registerUser(app, { country: 'GH' });
    const cat = await request(app).get('/api/money/catalog?currency=USD').set(a.auth);
    expect(cat.body.items.length).toBeGreaterThanOrEqual(30);
    for (const r of cat.body.items) {
      for (const leg of [r.funding, r.payout]) for (const k of ['initiation', 'confirmation', 'settlement', 'expectedCompletion', 'processing', 'refundMethod']) expect(leg[k], `${r.source}->${r.destination} ${k}`).toBeTruthy();
      expect(['automatic', 'assisted', 'manual']).toContain(r.processing);
      expect(r.disclosure).toBeTruthy();
    }
    const bankToBank = cat.body.items.find((r: any) => r.source === 'bank' && r.destination === 'bank');
    expect(bankToBank.processing).toBe('manual');
    expect(bankToBank.disclosure).toContain('independently confirmed');
    const walletToQr = cat.body.items.find((r: any) => r.source === 'wallet' && r.destination === 'qr');
    expect(walletToQr.processing).toBe('automatic');
    expect(walletToQr.expectedCompletion).toBe('Instant');
  });

  it('resolves a QR code to the right payment intent without exposing sensitive data', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'QR Shop', phone: '+233200000123' });
    const pr = await request(app).post('/api/payment-requests').set(m.auth).send({ kind: 'qr', amount: '12', currency: 'USD' });
    const resolved = await request(app).post('/api/qr/resolve').send({ data: pr.body.paymentRequest.qr });
    expect(resolved.body.kind).toBe('payment_request');
    expect(resolved.body.paymentRequest.code).toBe(pr.body.paymentRequest.code);
    const text = JSON.stringify(resolved.body);
    expect(text).not.toContain(m.user.email);
    expect(text).not.toContain('+233200000123');
    expect(text).not.toContain('balance');
    expect(text).not.toContain('pin');
  });
});
