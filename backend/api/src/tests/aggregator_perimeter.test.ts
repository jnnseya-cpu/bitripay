/**
 * The aggregator perimeter of Instructions n°42 and n°58 of the Banque Centrale du Congo:
 *  - one click in the console switches every issuer and acquirer function off (audited); the API refuses them with
 *    module_disabled and the message tells the customer the service comes after the authorisation; acceptance (QR,
 *    payment requests, links, merchant gateway) keeps working;
 *  - a merchant's QR intent is settled by a payment through the national switch (intent_id): the intent reaches
 *    SETTLED through the mirror, no customer ledger entry, the aggregation fee is accrued;
 *  - a refund of that payment credits the aggregation fee back to the merchant (art. 23: principal and fees).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, adminToken, checkerToken, fund } from './helpers';
import { getDb } from '../db';
import { setSetting } from '../services/settings';
import { getModules, DEFAULT_MODULES, AGGREGATOR_PERIMETER_OFF } from '../services/modules';
import { dispatchOutbox, getPaymentRow } from '../services/switch/payments';
import { feeEntryForPayment, merchantAggregationFees } from '../services/switch/fees';
import { getIntentRow } from '../services/intents';

let app: ReturnType<typeof setupApp>;
let admin: Awaited<ReturnType<typeof adminToken>>;
let checker: Awaited<ReturnType<typeof checkerToken>>;
const CONN = 'NATIONAL_SWITCH_CD';

beforeAll(async () => {
  app = setupApp();
  getDb().prepare("UPDATE currencies SET enabled = 1 WHERE code IN ('CDF', 'USD')").run();
  admin = await adminToken(app);
  checker = await checkerToken(app);
  setSetting('switch', { inquiryDelaysSeconds: [0, 0, 0, 0], maxInquiries: 3, uncertainTimeoutSeconds: 1 });
});
afterAll(() => setSetting('modules', DEFAULT_MODULES));

async function inject(stableMessageId: string, variant: string) {
  const r = await request(app).post(`/api/admin/switch/connections/${CONN}/simulate-inbound`).set(admin.auth).send({ stableMessageId, variant });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}

describe('aggregator perimeter switch', () => {
  it('switches every issuer and acquirer function off in one audited click; the API refuses them and acceptance keeps working', async () => {
    const customer = await registerUser(app);
    const other = await registerUser(app);
    await fund(app, customer.user.id, '50.00');
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'Kiosque Test', country: 'CD' });

    const before = await request(app).get('/api/admin/settings/modules/aggregator-perimeter').set(admin.auth);
    expect(before.body.applied).toBe(false);
    const applied = await request(app).post('/api/admin/settings/modules/aggregator-perimeter').set(admin.auth).send({});
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    for (const k of AGGREGATOR_PERIMETER_OFF) expect(getModules()[k], k).toBe(false);
    expect(getModules().qrPayments).toBe(true);
    expect((await request(app).get('/api/admin/settings/modules/aggregator-perimeter').set(admin.auth)).body.applied).toBe(true);
    const logs = await request(app).get('/api/admin/audit-logs?limit=5').set(admin.auth);
    expect(JSON.stringify(logs.body)).toContain('settings.modules.aggregator_perimeter');
    expect((await request(app).get('/api/config')).body.modules.transfers).toBe(false);

    // issuer functions: refused with the authorisation message
    const transfer = await request(app).post('/api/transfers').set(customer.auth).send({ to: other.user.tag, amount: '1.00', currency: 'USD', pin: '1234' });
    expect(transfer.status).toBe(422);
    expect(transfer.body.error.code).toBe('module_disabled');
    const savings = await request(app).get('/api/savings').set(customer.auth);
    expect(savings.status).toBe(422);
    expect(savings.body.error.code).toBe('module_disabled');
    expect(savings.body.error.message).toContain('authorisation of the Banque Centrale du Congo');
    expect((await request(app).get('/api/open-banking/institutions').set(customer.auth)).body.error.code).toBe('module_disabled');
    expect((await request(app).get('/api/credit').set(customer.auth)).body.error.code).toBe('module_disabled');
    const billers = await request(app).get('/api/bills/billers').set(customer.auth);
    const bill = await request(app).post('/api/bills').set(customer.auth).send({ billerId: billers.body.items[0].id, accountNumber: 'METER-0001', amount: '10.00', pin: '1234' });
    expect(bill.body.error.code).toBe('module_disabled');

    // acceptance stays on: a merchant payment request with items and VAT
    const sale = await request(app)
      .post('/api/payment-requests')
      .set(merchant.auth)
      .send({ amount: '11.60', currency: 'USD', note: 'Sale', items: [{ description: 'Pain', quantity: 2, unitPrice: '5.00' }], vatRate: 16 });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
  });
});

describe('QR intent settled through the national switch', () => {
  it('links the switch payment to the merchant QR intent, settles it without a ledger entry, accrues then credits the aggregation fee on refund', async () => {
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'Kin Bakery', country: 'CD' });
    const key = await request(app).post('/api/v1/api_keys').set(merchant.auth).send({ label: 'switch', mode: 'test' });
    const auth = { Authorization: `Bearer ${key.body.secret}` };
    const b = await request(app).post('/api/v1/beneficiary_bindings').set(auth).send({ participant_id: 'DEMO_MMO_B', account_token: 'acct-merchant-778899', account_name: 'Kin Bakery SARL' });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    await request(app).post(`/api/admin/switch/bindings/${b.body.id}/verify`).set(admin.auth).send({ method: 'institution_confirmation', reference: 'MMO-B-CONF-9' });
    const act = await request(app).post(`/api/admin/switch/bindings/${b.body.id}/activate`).set(checker.auth);
    expect(act.body.binding.status).toBe('ACTIVE');

    // the merchant's QR code for a 250 000 CDF sale (signed EMVCo QR)
    const qr = await request(app)
      .post('/api/v1/qr-intents')
      .set(auth)
      .send({ amount: { currency: 'CDF', value_minor: '25000000' }, reference: 'POS-77', description: 'Two loaves' });
    expect(qr.status, JSON.stringify(qr.body)).toBe(201);
    expect(qr.body.qr.signed).toBe(true);

    // wrong amount is refused; then the payer's institution pays through the switch (simulation)
    const consent = await request(app)
      .post('/api/v1/consents')
      .set(auth)
      .send({ participant_id: 'DEMO_BANK_A', beneficiary_binding_id: b.body.id, amount: { currency: 'CDF', value_minor: '25000000' }, account_token: 'tok_ok', proof: `sim-consent-${Date.now()}` });
    expect(consent.status, JSON.stringify(consent.body)).toBe(201);
    const body = {
      merchant_order_id: 'POS-77',
      product: 'MERCHANT_PAYMENT',
      amount: { currency: 'CDF', value_minor: '25000000' },
      payer: { participant_id: 'DEMO_BANK_A', account_token: 'tok_ok' },
      beneficiary_binding_id: b.body.id,
      consent_reference: consent.body.reference,
      intent_id: qr.body.intent_id,
      channel: 'qr',
    };
    const bad = await request(app)
      .post('/api/v1/payments')
      .set(auth)
      .send({ ...body, amount: { currency: 'CDF', value_minor: '24000000' } });
    expect(bad.status).toBe(409);
    const pay = await request(app).post('/api/v1/payments').set(auth).send(body);
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    expect(pay.body.intent_id).toBe(qr.body.intent_id);
    const dup = await request(app)
      .post('/api/v1/payments')
      .set(auth)
      .send({ ...body, merchant_order_id: 'POS-77-B' });
    expect(dup.status).toBe(409); // one settlement per intent

    await dispatchOutbox('node:test', { limit: 100 });
    const done = await request(app).get(`/api/v1/payments/${pay.body.payment_id}`).set(auth);
    expect(done.body.status).toBe('COMPLETED');
    const intent = getIntentRow(qr.body.intent_id);
    expect(['CAPTURED', 'SETTLED', 'SETTLEMENT_PENDING']).toContain(intent.status);
    // no customer ledger entry: the merchant's BitriPay wallet did not move
    const wallets = await request(app).get('/api/wallets').set(merchant.auth);
    expect(wallets.body.items.every((w: any) => w.balance === 0)).toBe(true);
    const fee = feeEntryForPayment(pay.body.payment_id)!;
    expect(fee.status).toBe('accrued');
    expect(fee.amount).toBeGreaterThan(0);

    // full refund through the switch: the fee accrued on it is credited back (Instruction n°58 art. 23)
    const refund = await request(app).post(`/api/v1/payments/${pay.body.payment_id}/refunds`).set(auth).send({ reason: 'Customer returned the goods' });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    getDb()
      .prepare('UPDATE outbox_messages SET available_at = ? WHERE payment_id = ? AND delivered_at IS NULL')
      .run(new Date(Date.now() - 1000).toISOString(), pay.body.payment_id);
    await dispatchOutbox('node:test', { limit: 100 });
    const op = getDb().prepare("SELECT * FROM linked_operations WHERE payment_id = ? AND kind = 'REFUND'").get(pay.body.payment_id) as any;
    expect(op).toBeTruthy();
    if (op.status !== 'SUCCEEDED') await inject(op.stable_message_id, 'completion');
    const after = feeEntryForPayment(pay.body.payment_id)!;
    expect(after.status).toBe('reversed');
    expect(after.amount).toBe(0);
    expect(after.reversed).toBe(25000000);
    const view = merchantAggregationFees(merchant.id);
    expect(view.accrued.find((a) => a.currency === 'CDF')?.total ?? 0).toBe(0);
    expect(getPaymentRow(pay.body.payment_id).status).toBe('COMPLETED');
  });
});
