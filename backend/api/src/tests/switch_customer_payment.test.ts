/**
 * Where the customer's money comes from (aggregator perimeter): the customer pays the acceptor's QR from the account
 * they hold at their own institution, through the national switch. Signed in (the app) or a guest (hosted checkout),
 * they choose the institution and give their identifier there; the switch payment is the acceptor's order on its
 * active settlement account; the institution's answer is a state, never a BitriPay ledger entry.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, adminToken, checkerToken } from './helpers';
import { getDb } from '../db';
import { setSetting } from '../services/settings';
import { feeEntryForPayment } from '../services/switch/fees';
import { runGuardian, getOperatingState } from '../services/guardian';

let app: ReturnType<typeof setupApp>;
let admin: Awaited<ReturnType<typeof adminToken>>;
let checker: Awaited<ReturnType<typeof checkerToken>>;
beforeAll(async () => {
  app = setupApp();
  getDb().prepare("UPDATE currencies SET enabled = 1 WHERE code IN ('CDF', 'USD')").run();
  admin = await adminToken(app);
  checker = await checkerToken(app);
  setSetting('switch', { inquiryDelaysSeconds: [0, 0, 0, 0], maxInquiries: 3, uncertainTimeoutSeconds: 1 });
});

async function acceptorWithAccount(name: string) {
  const merchant = await registerUser(app, { role: 'merchant', businessName: name, country: 'CD' });
  const b = await request(app).post('/api/v1/beneficiary_bindings').set(merchant.auth).send({ participant_id: 'DEMO_MMO_B', account_token: '+243990000321', account_name: name });
  expect(b.status, JSON.stringify(b.body)).toBe(201);
  await request(app).post(`/api/admin/switch/bindings/${b.body.id}/verify`).set(admin.auth).send({ method: 'institution_confirmation', reference: 'MMO-B-CONF-9' });
  const act = await request(app).post(`/api/admin/switch/bindings/${b.body.id}/activate`).set(checker.auth);
  expect(act.status, JSON.stringify(act.body)).toBe(200);
  return merchant;
}

describe('pay from your own institution', () => {
  it('a signed-in customer scans a point-of-sale QR, picks their bank and pays: the sale turns paid, the fee accrues, no ledger entry, Guardian ok', async () => {
    const merchant = await acceptorWithAccount('Kiosque Client');
    const customer = await registerUser(app, { country: 'CD' });
    const sale = await request(app)
      .post('/api/payment-requests')
      .set(merchant.auth)
      .send({ amount: '9.28', currency: 'CDF', note: 'Deux pains', items: [{ description: 'Pain', quantity: 2, unitPrice: '4.00' }], vatRate: 16 });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    const code = sale.body.paymentRequest.code as string;

    // the app lists the institutions that can reach the acceptor's account in this currency (banks and mobile money, never the aggregator)
    const inst = await request(app).get(`/api/pay/institutions?code=${code}`).set(customer.auth);
    expect(inst.status, JSON.stringify(inst.body)).toBe(200);
    expect(inst.body.available).toBe(true);
    expect(inst.body.simulation).toBe(true);
    const ids = inst.body.institutions.map((i: any) => i.participant_id);
    expect(ids).toContain('DEMO_BANK_A');
    expect(ids.some((i: string) => i.includes('BITRIPAY') || i.includes('AGG'))).toBe(false);
    // the hosted checkout of this sale offers the method too
    const info = await request(app).get(`/api/checkout/${code}`);
    expect(info.body.methods).toContain('national_switch');

    // the customer pays from Demo Bank A with their account identifier there
    const paid = await request(app).post('/api/pay/institution').set(customer.auth).send({ code, participant_id: 'DEMO_BANK_A', account_token: '+243811234567' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.payment.status).toBe('COMPLETED');
    expect(paid.body.payment.customer_message.fr).toMatch(/confirmé/);
    expect(paid.body.payment.payer.participant_id).toBe('DEMO_BANK_A');
    expect(paid.body.payment.payer.account_masked).not.toContain('1234567');
    expect(['CAPTURED', 'SETTLED', 'SETTLEMENT_PENDING']).toContain(paid.body.intent.status);
    // the point of sale shows the sale paid
    const posView = await request(app).get(`/api/payment-requests/${code}`).set(merchant.auth);
    expect(posView.body.paymentRequest.status).toBe('paid');
    // the aggregation fee accrues on the acceptor; nothing on any wallet
    expect(feeEntryForPayment(paid.body.payment.payment_id)?.status).toBe('accrued');
    expect((await request(app).get('/api/wallets').set(merchant.auth)).body.items.every((w: any) => w.balance === 0)).toBe(true);
    expect((await request(app).get('/api/wallets').set(customer.auth)).body.items.every((w: any) => w.balance === 0)).toBe(true);
    // the customer can poll the state with the intent it holds, and nobody can read it with another intent
    const state = await request(app).get(`/api/pay/institution/${paid.body.payment.payment_id}?intent=${paid.body.intent.id}`);
    expect(state.status).toBe(200);
    expect(state.body.payment.status).toBe('COMPLETED');
    expect((await request(app).get(`/api/pay/institution/${paid.body.payment.payment_id}?intent=pi_other`)).status).toBe(404);
    // paying the same sale twice is refused
    const again = await request(app).post('/api/pay/institution').set(customer.auth).send({ code, participant_id: 'DEMO_BANK_A', account_token: '+243811234567' });
    expect(again.status).toBe(422);
    const guardian = runGuardian({ haltOnFailure: true });
    expect(guardian.findings.filter((f) => f.kind === 'captured_without_posting')).toEqual([]);
    expect(getOperatingState().mode).not.toBe('halted');
  });

  it('a guest on the hosted checkout pays a QR intent; a rejection by the institution is a state, not an error; a static QR takes the amount', async () => {
    const merchant = await acceptorWithAccount('Boutique Invités');
    const qr = await request(app)
      .post('/api/v1/qr-intents')
      .set(merchant.auth)
      .send({ amount: { currency: 'CDF', value_minor: '2500' }, reference: 'DEMO-9', description: 'Invité' });
    expect(qr.status, JSON.stringify(qr.body)).toBe(201);
    const list = await request(app).get(`/api/pay/institutions?intent=${qr.body.intent_id}`);
    expect(list.body.institutions.map((i: any) => i.participant_id)).toContain('DEMO_MMO_A');
    // insufficient funds at the institution: REJECTED comes back as a state with the customer wording
    const rejected = await request(app).post('/api/pay/institution').send({ intent_id: qr.body.intent_id, participant_id: 'DEMO_BANK_A', account_token: 'tok_reject' });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(201);
    expect(rejected.body.payment.status).toBe('REJECTED');
    expect(rejected.body.payment.customer_message.fr).toMatch(/refusé/);
    // the intent stays payable after a rejection: the guest tries their mobile money instead
    const ok = await request(app).post('/api/pay/institution').send({ intent_id: qr.body.intent_id, participant_id: 'DEMO_MMO_A', account_token: '+243990000777' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.payment.status).toBe('COMPLETED');

    // a static sticker: the customer types the amount
    const stat = await request(app).post('/api/v1/qr_codes').set(merchant.auth).send({ currency: 'CDF', reference: 'Comptoir' });
    expect(stat.status, JSON.stringify(stat.body)).toBe(201);
    const noAmount = await request(app)
      .post('/api/pay/institution')
      .send({ qr_id: stat.body.id ?? stat.body.qr?.id, participant_id: 'DEMO_BANK_A', account_token: '+243811234567' });
    expect(noAmount.status).toBe(400);
    const withAmount = await request(app)
      .post('/api/pay/institution')
      .send({ qr_id: stat.body.id ?? stat.body.qr?.id, amount: '15.00', participant_id: 'DEMO_BANK_A', account_token: '+243811234567' });
    expect(withAmount.status, JSON.stringify(withAmount.body)).toBe(201);
    expect(withAmount.body.payment.status).toBe('COMPLETED');
    expect(withAmount.body.payment.amount.value_minor ?? withAmount.body.payment.amount).toBeTruthy();
  });

  it('refuses an acceptor without an active settlement account, a closed pair, and the acceptor paying its own code', async () => {
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'Sans Compte Client', country: 'CD' });
    const qr = await request(app)
      .post('/api/v1/qr-intents')
      .set(merchant.auth)
      .send({ amount: { currency: 'CDF', value_minor: '500' }, reference: 'X-1' });
    const none = await request(app).get(`/api/pay/institutions?intent=${qr.body.intent_id}`);
    expect(none.body).toMatchObject({ available: false, institutions: [] });
    const r = await request(app).post('/api/pay/institution').send({ intent_id: qr.body.intent_id, participant_id: 'DEMO_BANK_A', account_token: '+243811234567' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('binding_required');
    const withAccount = await acceptorWithAccount('Propre Code');
    const own = await request(app)
      .post('/api/v1/qr-intents')
      .set(withAccount.auth)
      .send({ amount: { currency: 'USD', value_minor: '500' }, reference: 'X-2' });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    const self = await request(app).post('/api/pay/institution').set(withAccount.auth).send({ intent_id: own.body.intent_id, participant_id: 'DEMO_BANK_A', account_token: '+243811234567' });
    expect(self.status).toBe(422);
    expect(self.body.error.code).toBe('own_code');
    const unknown = await request(app).post('/api/pay/institution').send({ intent_id: own.body.intent_id, participant_id: 'NO_SUCH_BANK', account_token: '+243811234567' });
    expect([404, 422]).toContain(unknown.status);
  });
});
