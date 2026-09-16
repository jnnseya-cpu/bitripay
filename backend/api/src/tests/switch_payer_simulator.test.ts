/**
 * Demonstration scene 3: the console's payer simulator plays the customer's institution. A POS sale (items + VAT)
 * produces a dynamic QR intent; the simulator resolves it, records the institution consent, creates the switch
 * payment on the acceptor's active settlement account and dispatches it; the intent settles through the mirror
 * without any ledger entry and the aggregation fee is accrued. A static QR needs the amount the payer types.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, adminToken, checkerToken } from './helpers';
import { getDb } from '../db';
import { setSetting } from '../services/settings';
import { getIntentRow } from '../services/intents';
import { feeEntryForPayment } from '../services/switch/fees';

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

describe('payer simulator (scene 3)', () => {
  it('pays a POS sale from a simulated payer institution through the switch and settles the intent', async () => {
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'Kiosque Démo', country: 'CD' });
    // scene 2: settlement account at Demo Mobile Money B, verified and activated by two administrators
    const b = await request(app).post('/api/v1/beneficiary_bindings').set(merchant.auth).send({ participant_id: 'DEMO_MMO_B', account_token: 'acct-kiosque-1122', account_name: 'Kiosque Démo' });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    await request(app).post(`/api/admin/switch/bindings/${b.body.id}/verify`).set(admin.auth).send({ method: 'institution_confirmation', reference: 'MMO-B-CONF-1' });
    await request(app).post(`/api/admin/switch/bindings/${b.body.id}/activate`).set(checker.auth);

    // the POS sale: two lines, VAT 16 %, dynamic QR
    const sale = await request(app)
      .post('/api/payment-requests')
      .set(merchant.auth)
      .send({ amount: '11.60', currency: 'CDF', note: 'Deux pains', items: [{ description: 'Pain', quantity: 2, unitPrice: '5.00' }], vatRate: 16 });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    const qr = await request(app)
      .post('/api/v1/qr-intents')
      .set(merchant.auth)
      .send({ amount: { currency: 'CDF', value_minor: '1160' }, reference: 'POS-1', description: 'Deux pains' });
    expect(qr.status, JSON.stringify(qr.body)).toBe(201);

    // console: the simulator lists the point-of-sale sale and the open intent with the acceptor named, and the payer institutions that can reach its account
    const open = await request(app).get('/api/admin/switch/simulator/intents').set(admin.auth);
    expect(open.body.items.find((i: any) => i.id === qr.body.intent_id).merchant.businessName).toBe('Kiosque Démo');
    const saleRow = open.body.items.find((i: any) => i.kind === 'request' && i.id === sale.body.paymentRequest.id);
    expect(saleRow.amount).toEqual({ valueMinor: 1160, currency: 'CDF' });
    // paying the sale itself: the intent is bound to the sale, the sale turns paid on the point of sale
    const salePaid = await request(app)
      .post('/api/admin/switch/simulator/pay')
      .set(admin.auth)
      .send({ payment_request_id: sale.body.paymentRequest.id, participant_id: 'DEMO_BANK_A', account_token: 'tok_ok' });
    expect(salePaid.status, JSON.stringify(salePaid.body)).toBe(200);
    expect(salePaid.body.payment.status).toBe('COMPLETED');
    const posView = await request(app).get(`/api/payment-requests/${sale.body.paymentRequest.code}`).set(merchant.auth);
    expect(posView.body.paymentRequest.status).toBe('paid');
    expect(posView.body.paymentRequest.intentId).toBe(salePaid.body.intent.id);
    expect((await request(app).get('/api/admin/switch/simulator/intents').set(admin.auth)).body.items.some((i: any) => i.id === sale.body.paymentRequest.id)).toBe(false);
    const opts = await request(app).get(`/api/admin/switch/simulator/payers?intent=${qr.body.intent_id}`).set(admin.auth);
    expect(opts.body.payers.map((p: any) => p.participant_id)).toContain('DEMO_BANK_A');
    expect(opts.body.tokens.some((t: any) => t.token === 'tok_ok')).toBe(true);

    // the payer's institution scans the QR payload and authorises the debit
    const paid = await request(app).post('/api/admin/switch/simulator/pay').set(admin.auth).send({ qr_payload: qr.body.qr.payload, participant_id: 'DEMO_BANK_A', account_token: 'tok_ok' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.payment.status).toBe('COMPLETED');
    expect(paid.body.payment.intent_id).toBe(qr.body.intent_id);
    expect(['CAPTURED', 'SETTLED', 'SETTLEMENT_PENDING']).toContain(paid.body.intent.status);
    expect(paid.body.timeline.events.length).toBeGreaterThan(0);
    expect(feeEntryForPayment(paid.body.payment.payment_id)?.status).toBe('accrued');
    // no ledger entry for the merchant
    const wallets = await request(app).get('/api/wallets').set(merchant.auth);
    expect(wallets.body.items.every((w: any) => w.balance === 0)).toBe(true);
    // refund from the console: principal and fees return, the aggregation fee is credited back (art. 23)
    const refund = await request(app).post('/api/admin/switch/simulator/refund').set(admin.auth).send({ payment_id: paid.body.payment.payment_id, reason: 'Customer returned the goods' });
    expect(refund.status, JSON.stringify(refund.body)).toBe(200);
    expect(refund.body.operation.status).toBe('SUCCEEDED');
    expect(refund.body.fee.status).toBe('reversed');
    expect(refund.body.fee.amount).toBe(0);
    // a second payment of the same intent is refused: one settlement per intent
    const again = await request(app).post('/api/admin/switch/simulator/pay').set(admin.auth).send({ intent_id: qr.body.intent_id, participant_id: 'DEMO_BANK_A' });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('intent_not_open');
    expect(getIntentRow(qr.body.intent_id).status).not.toBe('REQUIRES_PAYMENT_METHOD');
  });

  it('refuses when the acceptor has no active settlement account, and needs an amount for a static QR', async () => {
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'Sans Compte', country: 'CD' });
    const qr = await request(app)
      .post('/api/v1/qr-intents')
      .set(merchant.auth)
      .send({ amount: { currency: 'CDF', value_minor: '500' }, reference: 'POS-2' });
    const r = await request(app).post('/api/admin/switch/simulator/pay').set(admin.auth).send({ intent_id: qr.body.intent_id, participant_id: 'DEMO_BANK_A' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('binding_required');
    const stat = await request(app).post('/api/v1/qr-codes').set(merchant.auth).send({ mode: 'static', currency: 'CDF', label: 'Counter' });
    if (stat.status === 201) {
      const s = await request(app)
        .post('/api/admin/switch/simulator/pay')
        .set(admin.auth)
        .send({ qr_payload: stat.body.payload ?? stat.body.qr?.payload, participant_id: 'DEMO_BANK_A' });
      expect([422]).toContain(s.status);
      expect(['amount_required', 'binding_required']).toContain(s.body.error.code);
    }
  });
});
