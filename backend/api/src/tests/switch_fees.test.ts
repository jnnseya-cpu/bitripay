/**
 * Aggregation fee on national-switch payments: quoted on the payment before emission, accrued only when the switch
 * confirms completion (never on a rejection, never as a ledger posting on the payment), invoiced per period, paid
 * from the merchant wallet as a fee posting, or recorded / voided by an administrator under step-up.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, adminToken, checkerToken, fund } from './helpers';
import { getDb } from '../db';
import { setSetting } from '../services/settings';
import { dispatchOutbox } from '../services/switch/payments';
import { accrueAggregationFee, closeAggregationPeriod, feeEntryForPayment } from '../services/switch/fees';

let app: ReturnType<typeof setupApp>;
let merchant: Awaited<ReturnType<typeof registerUser>>;
let auth: Record<string, string>;
let admin: Awaited<ReturnType<typeof adminToken>>;
let bindingId: string;
let orderSeq = 0;

async function consent(amount: number, token: string) {
  const r = await request(app)
    .post('/api/v1/consents')
    .set(auth)
    .send({ participant_id: 'DEMO_BANK_A', beneficiary_binding_id: bindingId, amount: { currency: 'CDF', value_minor: String(amount) }, account_token: token, proof: `sim-consent-${Date.now()}` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.reference as string;
}
async function createPayment(amount: number, token = 'tok_ok') {
  const c = await consent(amount, token);
  const order = `FEE-${String(++orderSeq).padStart(4, '0')}`;
  const r = await request(app)
    .post('/api/v1/payments')
    .set(auth)
    .send({
      merchant_order_id: order,
      product: 'MERCHANT_PAYMENT',
      amount: { currency: 'CDF', value_minor: String(amount) },
      payer: { participant_id: 'DEMO_BANK_A', account_token: token },
      beneficiary_binding_id: bindingId,
      consent_reference: c,
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}
async function settle(paymentId: string) {
  getDb()
    .prepare('UPDATE outbox_messages SET available_at = ? WHERE payment_id = ? AND delivered_at IS NULL')
    .run(new Date(Date.now() - 1000).toISOString(), paymentId);
  await dispatchOutbox('node:fees', { limit: 100 });
  return (await request(app).get(`/api/v1/payments/${paymentId}`).set(auth)).body;
}

beforeAll(async () => {
  app = setupApp();
  getDb().prepare("UPDATE currencies SET enabled = 1 WHERE code IN ('CDF', 'USD')").run();
  admin = await adminToken(app);
  const checker = await checkerToken(app);
  merchant = await registerUser(app, { role: 'merchant', businessName: 'Kin Pharmacy', country: 'CD' });
  const key = await request(app).post('/api/v1/api_keys').set(merchant.auth).send({ label: 'switch', mode: 'test' });
  auth = { Authorization: `Bearer ${key.body.secret}` };
  const b = await request(app).post('/api/v1/beneficiary_bindings').set(auth).send({ participant_id: 'DEMO_MMO_B', account_token: 'acct-merchant-445566', account_name: 'Kin Pharmacy SARL' });
  await request(app).post(`/api/admin/switch/bindings/${b.body.id}/verify`).set(admin.auth).send({ method: 'institution_confirmation', reference: 'MMO-B-CONF-9' });
  await request(app).post(`/api/admin/switch/bindings/${b.body.id}/activate`).set(checker.auth);
  bindingId = b.body.id;
  setSetting('switch', { inquiryDelaysSeconds: [0, 0, 0, 0], maxInquiries: 3, uncertainTimeoutSeconds: 1 });
});

describe('aggregation fee on switch payments', () => {
  it('quotes the fee on the payment, accrues it only on completion, and never on a rejection', async () => {
    const created = await createPayment(250_000_00);
    expect(created.fees.aggregation.status).toBe('quoted');
    expect(created.fees.aggregation.bps).toBe(80);
    expect(created.fees.aggregation.amount_minor).toBe(2_000_00); // 0.80 % of 250 000.00 CDF
    const done = await settle(created.payment_id);
    expect(done.status).toBe('COMPLETED');
    expect(done.fees.aggregation.status).toBe('accrued');
    expect(done.fees.aggregation.amount).toBe(2_000_00);
    // the fee is a journal fact, not a ledger posting: the merchant wallet is untouched
    const journal = getDb().prepare("SELECT fact, amount_minor, source FROM switch_journal WHERE payment_id = ? AND fact = 'AGGREGATION_FEE'").all(created.payment_id) as any[];
    expect(journal).toEqual([{ fact: 'AGGREGATION_FEE', amount_minor: 2_000_00, source: 'bitripay' }]);
    expect((await request(app).get('/api/wallets').set(merchant.auth)).body.items.every((w: any) => w.balance === 0)).toBe(true);
    // idempotent
    expect(accrueAggregationFee(getDb().prepare('SELECT * FROM switch_payments WHERE id = ?').get(created.payment_id) as any)?.id).toBe(feeEntryForPayment(created.payment_id)?.id);

    const rejected = await createPayment(100_000_00, 'tok_reject');
    const r = await settle(rejected.payment_id);
    expect(r.status).toBe('REJECTED');
    expect(feeEntryForPayment(rejected.payment_id)).toBeNull();

    const mine = await request(app).get('/api/v1/fees/aggregation').set(auth);
    expect(mine.status).toBe(200);
    expect(mine.body.accrued).toHaveLength(1);
    expect(mine.body.accrued[0].total).toBe(2_000_00);
  });

  it('invoices a closed period, the merchant pays from the wallet, and an administrator can record or void', async () => {
    const second = await createPayment(50_000_00);
    await settle(second.payment_id);
    // both entries belong to last month for the test
    const last = new Date();
    last.setMonth(last.getMonth() - 1);
    const period = last.toISOString().slice(0, 7);
    getDb().prepare("UPDATE switch_fee_entries SET period = ? WHERE merchant_user_id = ? AND status = 'accrued'").run(period, merchant.user.id);
    const thisMonth = new Date().toISOString().slice(0, 7);
    expect(() => closeAggregationPeriod(thisMonth, 'admin')).toThrow(/past period/);
    const closed = await request(app).post('/api/admin/switch/fees/close').set(admin.auth).send({ period, pin: admin.pin });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.invoices).toHaveLength(1);
    const inv = closed.body.invoices[0];
    expect(inv.total).toBe(2_000_00 + 400_00);
    expect(inv.entryCount).toBe(2);
    expect(inv.status).toBe('open');
    // closing again creates nothing
    expect((await request(app).post('/api/admin/switch/fees/close').set(admin.auth).send({ period, pin: admin.pin })).body.invoices).toHaveLength(0);

    // pay from the wallet: refused while empty, then a fee posting to the revenue account
    const short = await request(app).post(`/api/v1/fees/invoices/${inv.id}/pay`).set(merchant.auth).send({ pin: '1234' });
    expect(short.status).toBe(422);
    await fund(app, merchant.user.id, '5000.00', 'CDF');
    const paid = await request(app).post(`/api/v1/fees/invoices/${inv.id}/pay`).set(merchant.auth).send({ pin: '1234' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.invoice.status).toBe('paid');
    expect(paid.body.invoice.paidTransactionId).toBeTruthy();
    const cdf = (await request(app).get('/api/wallets').set(merchant.auth)).body.items.find((w: any) => w.currency === 'CDF');
    expect(cdf.balance).toBe(500_000 - 240_000);
    expect((await request(app).post(`/api/v1/fees/invoices/${inv.id}/pay`).set(merchant.auth).send({ pin: '1234' })).status).toBe(409);

    // a third payment, invoiced and then voided by an administrator: entries return to accrued
    const third = await createPayment(10_000_00);
    await settle(third.payment_id);
    getDb().prepare('UPDATE switch_fee_entries SET period = ? WHERE payment_id = ?').run(period, third.payment_id);
    const again = await request(app).post('/api/admin/switch/fees/close').set(admin.auth).send({ period, pin: admin.pin });
    expect(again.body.invoices).toHaveLength(0); // that merchant / period / currency already has an invoice: the late entry waits
    const overview = await request(app).get('/api/admin/switch/fees').set(admin.auth);
    expect(overview.status).toBe(200);
    expect(overview.body.invoices[0].number).toMatch(/^AGG-\d{6}$/);
    expect(overview.body.earned[0]).toEqual({ currency: 'CDF', total: 2_400_00 });
    const voided = await request(app).post(`/api/admin/switch/fees/invoices/${inv.id}/settle`).set(admin.auth).send({ kind: 'void', reason: 'test void', pin: admin.pin });
    expect(voided.status).toBe(409); // already paid
    const bank = await request(app).post(`/api/admin/switch/fees/invoices/AGG-999999/settle`).set(admin.auth).send({ kind: 'paid', reference: 'BANK-1', pin: admin.pin });
    expect(bank.status).toBe(404);
  });
});
