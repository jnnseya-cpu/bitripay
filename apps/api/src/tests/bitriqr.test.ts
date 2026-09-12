/**
 * BitriQR and payment intents: signed EMVCo QR codes resolved through the key registry, the canonical intent state
 * machine with attempts and the payment event store, wallet settlement through the existing ledger, static codes
 * with payer-entered amounts, revocation, expiry, idempotency, Guardian invariants and the country capability matrix.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, fund, adminToken } from './helpers';
import { decode, verify, crc16 } from '@bitripay/bitriqr';
import { getDb } from '../db';
import { runGuardian, setOperatingMode, getOperatingState } from '../services/guardian';
import { startAttempt, finishAttempt, expireIntents, getIntentRow } from '../services/intents';
import { countryCapabilities, serviceAllowed } from '../services/capabilities';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

describe('BitriQR payment intents', () => {
  it('creates a signed dynamic QR for an intent, resolves it as a verified merchant, and settles it from a wallet through the ledger', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Pharmacie Limete', country: 'CD' });
    const payer = await registerUser(app);
    await fund(app, payer.user.id, '100.00', 'USD');
    const created = await request(app).post('/api/v1/payment_intents').set(m.auth).set('Idempotency-Key', 'order-1042').send({ amount_minor: 2500, currency: 'USD', reference: 'INV-2026-0912', purpose_code: 'HEALTH', description: 'Prescription' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const pi = created.body;
    expect(pi.id).toMatch(/^pi_/);
    expect(pi.status).toBe('REQUIRES_PAYMENT_METHOD');
    expect(pi.client_secret).toContain('_secret_');
    expect(pi.qr_payload).toMatch(/^000201/);
    expect(pi.uri).toBe(`bitripay://pay/${pi.id}`);
    expect(pi.checkout_url).toContain('/pay/');
    // the payload is a valid EMVCo TLV with the BitriQR signed extension
    const d = decode(pi.qr_payload);
    expect(d.mode).toBe('dynamic');
    expect(d.amount).toBe('25');
    expect(d.currency).toBe('USD');
    expect(d.intentRef).toBe(pi.id);
    expect(d.purposeCode).toBe('HEALTH');
    expect(d.merchantName).toBe('PHARMACIE LIMETE');
    expect(d.signed).toBe(true);
    expect(d.crcValid).toBe(true);
    // the same Idempotency-Key returns the same intent
    const again = await request(app).post('/api/v1/payment_intents').set(m.auth).set('Idempotency-Key', 'order-1042').send({ amount_minor: 2500, currency: 'USD', reference: 'INV-2026-0912', purpose_code: 'HEALTH', description: 'Prescription' });
    expect(again.body.id).toBe(pi.id);
    // the key registry publishes the merchant key with an ETag
    const keys = await request(app).get('/api/v1/keys');
    expect(keys.status).toBe(200);
    expect(keys.body.keys.some((k: any) => k.keyId === d.keyId && k.scope === 'MERCHANT')).toBe(true);
    const cached = await request(app).get('/api/v1/keys').set('If-None-Match', keys.headers.etag);
    expect(cached.status).toBe(304);
    const one = await request(app).get(`/api/v1/keys/${d.keyId}`);
    const pub = one.body.publicKey as string;
    const { createPublicKey, verify: nodeVerify } = await import('node:crypto');
    const ok = await verify(d, (p, s) => nodeVerify(null, Buffer.from(p), createPublicKey({ key: Buffer.from(pub, 'base64'), format: 'der', type: 'spki' }), Buffer.from(s)));
    expect(ok.trust).toBe('verified');
    // the payer's app resolves the scan: verified merchant, amount, methods
    const resolved = await request(app).post('/api/v1/resolve').set(payer.auth).send({ content: pi.qr_payload, channel: 'app' });
    expect(resolved.status).toBe(200);
    expect(resolved.body.kind).toBe('intent');
    expect(resolved.body.trust).toBe('verified');
    expect(resolved.body.merchant.businessName).toBe('Pharmacie Limete');
    expect(resolved.body.amount).toBe(2500);
    expect(resolved.body.methods.find((x: any) => x.methodClass === 'wallet').available).toBe(true);
    expect(resolved.body.disclosures).toContain('fx_rate');
    // a tampered payload fails the CRC and is refused
    const tampered = await request(app).post('/api/v1/resolve').set(payer.auth).send({ content: pi.qr_payload.replace('540225', '540299') });
    expect(tampered.body.kind).toBe('invalid');
    expect(tampered.body.reasons).toContain('crc_mismatch');
    // the URI form resolves too
    const viaUri = await request(app).get(`/api/v1/resolve/${encodeURIComponent(pi.uri)}`).set(payer.auth);
    expect(viaUri.body.intent.id).toBe(pi.id);
    // pay from the wallet: attempt → ledger posting → captured → settlement pending
    const paid = await request(app).post(`/api/v1/payment_intents/${pi.id}/pay/wallet`).set(payer.auth).send({ pin: '1234' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.payment_intent.status).toBe('SETTLEMENT_PENDING');
    expect(paid.body.transaction.type).toBe('merchant_payment');
    expect(paid.body.payment_intent.attempts).toHaveLength(1);
    expect(paid.body.payment_intent.attempts[0].status).toBe('CAPTURED');
    expect(paid.body.payment_intent.transactionId).toBe(paid.body.transaction.id);
    const mw = await request(app).get('/api/wallets').set(m.auth);
    expect(mw.body.items.find((w: any) => w.currency === 'USD').balance).toBeGreaterThan(0);
    // the event store carries the confirmed event with the ledger transaction; the timeline shows every step
    const events = getDb().prepare('SELECT state, transaction_id FROM payment_events WHERE intent_id = ? ORDER BY occurred_at').all(pi.id) as any[];
    expect(events.map((e) => e.state)).toEqual(['INITIATED', 'PENDING', 'CONFIRMED']);
    expect(events[2].transaction_id).toBe(paid.body.transaction.id);
    const tl = await request(app).get(`/api/v1/payment_intents/${pi.id}/timeline`).set(m.auth);
    expect(tl.body.timeline.map((t: any) => t.event)).toEqual(expect.arrayContaining(['intent.created', 'attempt.started', 'intent.captured', 'intent.settlement_pending', 'attempt.captured']));
    // scanning again reports it is already paid; the merchant cannot cancel a captured intent
    const rescan = await request(app).post('/api/v1/resolve').set(payer.auth).send({ content: pi.qr_payload });
    expect(rescan.body.intent.status).toBe('SETTLEMENT_PENDING');
    const cancel = await request(app).post(`/api/v1/payment_intents/${pi.id}/cancel`).set(m.auth).send({});
    expect(cancel.status).toBe(409);
    // the client secret lets a checkout page read the intent without a session
    const anon = await request(app).get(`/api/v1/payment_intents/${pi.id}?client_secret=${pi.client_secret}`);
    expect(anon.status).toBe(200);
    const noSecret = await request(app).get(`/api/v1/payment_intents/${pi.id}`);
    expect(noSecret.status).toBe(403);
  });

  it('runs static merchant codes with locations: payer enters the amount, trust follows the signature, revocation stops scans, analytics count conversion', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Mama Chantal Foods', country: 'CD' });
    const payer = await registerUser(app);
    await fund(app, payer.user.id, '50.00', 'USD');
    const loc = await request(app).post('/api/v1/locations').set(m.auth).send({ name: 'Marché Central stall 12', city: 'Kinshasa', mcc: '5499' });
    expect(loc.status).toBe(201);
    const term = await request(app).post(`/api/v1/locations/${loc.body.id}/terminals`).set(m.auth).send({ label: 'Counter 1' });
    expect(term.status).toBe(201);
    const qr = await request(app).post('/api/v1/qr_codes').set(m.auth).send({ location_id: loc.body.id, terminal_id: term.body.id, currency: 'USD', rails: ['wallet', 'mpesa', 'airtel', 'orange', 'card'], asset_ref: 'STICKER-0001' });
    expect(qr.status, JSON.stringify(qr.body)).toBe(201);
    expect(qr.body.mode).toBe('STATIC');
    expect(qr.body.signed).toBe(true);
    const d = decode(qr.body.payload);
    expect(d.mode).toBe('static');
    expect(d.amount).toBe(null);
    expect(d.mcc).toBe('5499');
    expect(d.city).toBe('Kinshasa');
    expect(d.rails).toEqual(['wallet', 'mpesa', 'airtel', 'orange', 'card']);
    // an unsigned static code is allowed but only earns basic trust
    const basic = await request(app).post('/api/v1/qr_codes').set(m.auth).send({ currency: 'USD', sign: false });
    const basicScan = await request(app).post('/api/v1/resolve').send({ content: basic.body.payload });
    expect(basicScan.body.trust).toBe('basic');
    expect(basicScan.body.kind).toBe('static');
    // signed: verified merchant with location, no amount yet
    const scan = await request(app).post('/api/v1/resolve').set(payer.auth).send({ content: qr.body.payload });
    expect(scan.body.kind).toBe('static');
    expect(scan.body.trust).toBe('verified');
    expect(scan.body.merchant.location.name).toBe('Marché Central stall 12');
    // the payer enters the amount: an intent is created for this code and paid from the wallet
    const intent = await request(app).post(`/api/v1/qr/${qr.body.id}/intent`).set(payer.auth).send({ amount: '7.50' });
    expect(intent.status, JSON.stringify(intent.body)).toBe(201);
    expect(intent.body.source).toBe('qr');
    expect(intent.body.locationId).toBe(loc.body.id);
    const paid = await request(app).post(`/api/v1/payment_intents/${intent.body.id}/pay/wallet`).set(payer.auth).send({ pin: '1234' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.transaction.amount).toBe(750);
    const analytics = await request(app).get('/api/v1/qr_codes/analytics').set(m.auth);
    expect(analytics.body.intentsFromQr).toBe(1);
    expect(analytics.body.paidFromQr).toBe(1);
    expect(analytics.body.conversion).toBe(100);
    expect(analytics.body.byLocation[0].name).toBe('Marché Central stall 12');
    // the sticker is reported stolen: revoked at once, every scan refused and counted as suspicious
    const revoked = await request(app).post(`/api/v1/qr_codes/${qr.body.id}/revoke`).set(m.auth).send({ reason: 'stolen' });
    expect(revoked.body.status).toBe('revoked');
    const dead = await request(app).post('/api/v1/resolve').set(payer.auth).send({ content: qr.body.payload });
    expect(dead.body.kind).toBe('invalid');
    expect(dead.body.reasons).toEqual(['qr_revoked', 'stolen']);
    const after = await request(app).get('/api/v1/qr_codes/analytics').set(m.auth);
    expect(after.body.suspiciousScans).toBe(1);
    const list = await request(app).get(`/api/v1/qr_codes?location_id=${loc.body.id}`).set(m.auth);
    expect(list.body.data).toHaveLength(1);
  });

  it('blocks a second attempt while one is in flight, recovers from retryable failures, holds ambiguous outcomes, and expires untouched intents', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Kiosk Deux' });
    const created = await request(app).post('/api/v1/payment_intents').set(m.auth).send({ amount_minor: 1000, currency: 'USD', qr: false, expires_in_minutes: 1 });
    const id = created.body.id as string;
    const a1 = startAttempt(id, { methodClass: 'mobile_money', rail: 'mpesa', connector: 'sandbox' }, { type: 'guest' });
    expect(a1.status).toBe('PROCESSING');
    expect(getIntentRow(id).status).toBe('REQUIRES_CUSTOMER_ACTION');
    expect(() => startAttempt(id, { methodClass: 'card' }, { type: 'guest' })).toThrow(/blocked/);
    // provider timed out with an unknown outcome: the intent is held ambiguous, not failed and not retried blindly
    finishAttempt(a1.id, 'UNKNOWN', { error: 'STK push timed out' }, { type: 'system' });
    expect(getIntentRow(id).status).toBe('AMBIGUOUS');
    expect(getIntentRow(id).ambiguous_since).toBeTruthy();
    expect(() => startAttempt(id, { methodClass: 'card' }, { type: 'guest' })).toThrow(/blocked/);
    // the statement later shows it failed: attempt closes, intent returns to method selection (recovery)
    finishAttempt(a1.id, 'FAILED', { failureCategory: 'customer_abandoned' }, { type: 'system' });
    expect(getIntentRow(id).status).toBe('REQUIRES_PAYMENT_METHOD');
    const a2 = startAttempt(id, { methodClass: 'card', connector: 'sandbox' }, { type: 'guest' });
    expect(a2.seq).toBe(2);
    finishAttempt(a2.id, 'FAILED', { failureCategory: 'fraud_block', error: 'blocked by policy' }, { type: 'system' });
    expect(getIntentRow(id).status).toBe('FAILED');
    // an untouched intent past its expiry is expired by the job; an in-flight attempt keeps one alive
    const fresh = await request(app).post('/api/v1/payment_intents').set(m.auth).send({ amount_minor: 500, currency: 'USD', qr: false });
    getDb().prepare("UPDATE payment_intents SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(fresh.body.id);
    expect(expireIntents()).toBe(1);
    expect(getIntentRow(fresh.body.id).status).toBe('EXPIRED');
    const gone = await request(app).post('/api/v1/resolve').send({ content: fresh.body.uri });
    expect(gone.body.intent.status).toBe('EXPIRED');
  });

  it('Guardian proves the ledger invariants and halts money movement when they break, until an administrator clears it', async () => {
    const before = runGuardian();
    expect(before.ok).toBe(true);
    expect(before.halted).toBe(false);
    const m = await registerUser(app, { role: 'merchant', businessName: 'Halt Test' });
    // corrupt a stored balance directly (what an administrator could never do through the API)
    const w = getDb().prepare('SELECT id FROM wallets WHERE user_id = ?').get(m.user.id) as any;
    getDb().prepare('UPDATE wallets SET balance = balance + 999 WHERE id = ?').run(w.id);
    const broken = runGuardian();
    expect(broken.ok).toBe(false);
    expect(broken.findings.some((f) => f.kind === 'wallet_mismatch' && f.ref === w.id)).toBe(true);
    expect(broken.halted).toBe(true);
    expect(getOperatingState().mode).toBe('halted');
    const refused = await request(app).post('/api/v1/payment_intents').set(m.auth).send({ amount_minor: 100, currency: 'USD' });
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('guardian_halt');
    const status = await request(app).get('/api/v1/status');
    expect(status.body.mode).toBe('halted');
    // repair and clear
    getDb().prepare('UPDATE wallets SET balance = balance - 999 WHERE id = ?').run(w.id);
    expect(runGuardian().ok).toBe(true);
    const admin = await adminToken(app);
    setOperatingMode('normal', 'ledger repaired', admin.token ? null : null);
    const okAgain = await request(app).post('/api/v1/payment_intents').set(m.auth).send({ amount_minor: 100, currency: 'USD', qr: false });
    expect(okAgain.status).toBe(201);
  });

  it('applies the country capability matrix, including the mandatory national switch and the aggregator licence phase for DRC', async () => {
    const cd = countryCapabilities('CD');
    expect(cd.nationalSwitch).toEqual({ required: true, connector: 'NATIONAL_SWITCH_CD' });
    expect(cd.licencePhase).toBe('aggregator');
    expect(serviceAllowed('CD', 'virtualCards')).toBe(false);
    expect(serviceAllowed('CD', 'mobileMoney')).toBe(true);
    expect(countryCapabilities('GB').licencePhase).toBe('full');
    expect(serviceAllowed('GB', 'wallet')).toBe(true);
    const m = await registerUser(app, { role: 'merchant', businessName: 'Boutique', country: 'CD' });
    const wrongCurrency = await request(app).post('/api/v1/payment_intents').set(m.auth).send({ amount_minor: 100, currency: 'KES', qr: false });
    expect(wrongCurrency.status).toBe(400);
    expect(wrongCurrency.body.error.code).toBe('currency_not_collectable');
    const methods = await request(app).get('/api/v1/payment_methods/available?currency=USD&country=CD').set(m.auth);
    expect(methods.body.capabilities.requiredDisclosures).toContain('safeguarding');
    expect(crc16('123456789')).toBe('29B1');
  });
});
