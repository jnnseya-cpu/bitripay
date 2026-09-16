/**
 * Business verification (KYB) dossier and the developer portal's webhook inbox:
 *  - a merchant files its dossier from the web app with a document file; the file is sealed at rest, the merchant
 *    view only says a file exists, the console dossier view opens it (audited) and the decision needs the
 *    administrator's PIN (step-up); a verified business is Tier 4 and notified;
 *  - the webhook inbox records a signed delivery with both signature checks and flags a tampered one.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, adminToken } from './helpers';
import { getDb } from '../db';
import { signWebhookPayload, signWebhookEd25519 } from '../services/webhooks';

let app: ReturnType<typeof setupApp>;
let admin: Awaited<ReturnType<typeof adminToken>>;
beforeAll(async () => {
  app = setupApp();
  admin = await adminToken(app);
});

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('KYB dossier', () => {
  it('is filed with sealed documents, reviewed from the console under PIN step-up and moves the business to Tier 4', async () => {
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'Kiosque Démo', country: 'CD' });
    const filed = await request(app)
      .post('/api/risk/kyb')
      .set(merchant.auth)
      .send({
        legalName: 'Kiosque Démo SARL',
        registrationNumber: 'CD/KIN/RCCM/26-B-01234',
        country: 'CD',
        address: '22 bis, avenue de la Révolution, Ngaliema, Kinshasa',
        mcc: '5411',
        expectedMonthlyVolume: 250000000,
        directors: [{ name: 'Dime Mona', role: 'Gérant' }],
        documents: [
          { kind: 'rccm', ref: 'CD/KIN/RCCM/26-B-01234', data: PNG },
          { kind: 'national_id_number', ref: '01-S9502-N60980W' },
        ],
      });
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    expect(filed.body.submission.status).toBe('pending');
    // the merchant view never carries the file, only the fact that one was uploaded; the row at rest is sealed
    const mine = await request(app).get('/api/risk/kyb').set(merchant.auth);
    expect(mine.body.status).toBe('pending');
    expect(mine.body.submission.documents).toEqual([
      { kind: 'rccm', ref: 'CD/KIN/RCCM/26-B-01234', hasFile: true },
      { kind: 'national_id_number', ref: '01-S9502-N60980W', hasFile: false },
    ]);
    const raw = getDb().prepare('SELECT documents FROM kyb_submissions WHERE id = ?').get(filed.body.submission.id) as any;
    expect(raw.documents).not.toContain('iVBORw0KGgo');
    // a document needs a reference or a file; a second pending dossier is refused
    const bad = await request(app)
      .post('/api/risk/kyb')
      .set(merchant.auth)
      .send({ legalName: 'X SARL', registrationNumber: 'RC-1', country: 'CD', address: 'Somewhere 12', expectedMonthlyVolume: 1, directors: [{ name: 'A B' }], documents: [{ kind: 'other' }] });
    expect([400, 409]).toContain(bad.status);

    // console: KYB queue, dossier with the opened file (audited), decision under PIN
    const queue = await request(app).get('/api/admin/risk/kyb?status=pending').set(admin.auth);
    expect(queue.body.items.some((k: any) => k.id === filed.body.submission.id)).toBe(true);
    expect(JSON.stringify(queue.body)).not.toContain('iVBORw0KGgo');
    const dossier = await request(app).get(`/api/admin/risk/kyb/${filed.body.submission.id}`).set(admin.auth);
    expect(dossier.body.documents[0].data).toBe(PNG);
    expect(dossier.body.directors[0]).toEqual({ name: 'Dime Mona', role: 'Gérant' });
    const logs = await request(app).get('/api/admin/audit-logs?limit=5').set(admin.auth);
    expect(JSON.stringify(logs.body)).toContain('kyb.dossier.read');
    const noPin = await request(app).post(`/api/admin/risk/kyb/${filed.body.submission.id}/review`).set(admin.auth).send({ decision: 'verified' });
    expect(noPin.status).toBe(403);
    const wrongPin = await request(app).post(`/api/admin/risk/kyb/${filed.body.submission.id}/review`).set(admin.auth).send({ decision: 'verified', pin: '0000' });
    expect(wrongPin.status).toBe(403);
    const ok = await request(app).post(`/api/admin/risk/kyb/${filed.body.submission.id}/review`).set(admin.auth).send({ decision: 'verified', pin: admin.pin });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('verified');
    const after = await request(app).get('/api/risk/kyb').set(merchant.auth);
    expect(after.body.status).toBe('verified');
    const notifications = await request(app).get('/api/account/notifications').set(merchant.auth);
    expect(JSON.stringify(notifications.body)).toContain('Business verified');
  });

  it('accepts a corporate account dossier (every merchant-class role, not only "merchant")', async () => {
    const corp = await registerUser(app, { role: 'corporate', businessName: 'Groupe Test', country: 'CD' });
    const r = await request(app)
      .post('/api/risk/kyb')
      .set(corp.auth)
      .send({
        legalName: 'Groupe Test SA',
        registrationNumber: 'CD/KIN/RCCM/26-B-09999',
        country: 'CD',
        address: 'Avenue Test 1, Kinshasa',
        expectedMonthlyVolume: 1000,
        directors: [{ name: 'Fede Nseya' }],
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });
});

describe('webhook inbox', () => {
  it('records a signed delivery with both signature checks and flags a tampered body', async () => {
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'Inbox Shop', country: 'CD' });
    const inbox = await request(app).get('/api/v1/webhook_inbox').set(merchant.auth);
    expect(inbox.status, JSON.stringify(inbox.body)).toBe(200);
    expect(inbox.body.url).toContain(`/api/v1/webhook_inbox/${inbox.body.inbox_id}`);
    expect((await request(app).get('/api/v1/webhook_inbox').set(merchant.auth)).body.inbox_id).toBe(inbox.body.inbox_id); // stable
    const ep = await request(app)
      .post('/api/v1/webhook_endpoints')
      .set(merchant.auth)
      .send({ url: inbox.body.url, events: ['payment_intent.succeeded', 'payment_intent.created'] });
    expect(ep.status, JSON.stringify(ep.body)).toBe(201);
    const body = JSON.stringify({ id: 'evt_test_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', amount_minor: 2500 } } });
    const ts = Math.floor(Date.now() / 1000);
    const deliveryId = 'wd_test_1';
    const headers = {
      'Content-Type': 'application/json',
      'BitriPay-Signature': signWebhookPayload(ep.body.secret, body, ts),
      'BitriPay-Signature-Ed25519': signWebhookEd25519(deliveryId, inbox.body.url, body, ts),
      'BitriPay-Event': 'payment_intent.succeeded',
      'BitriPay-Delivery-Id': deliveryId,
    };
    const good = await request(app).post(`/api/v1/webhook_inbox/${inbox.body.inbox_id}`).set(headers).send(body);
    expect(good.status, JSON.stringify(good.body)).toBe(200);
    expect(good.body).toMatchObject({ received: true, hmac_valid: true, ed25519_valid: true });
    const tampered = await request(app).post(`/api/v1/webhook_inbox/${inbox.body.inbox_id}`).set(headers).send(body.replace('2500', '9900'));
    expect(tampered.body).toMatchObject({ received: true, hmac_valid: false, ed25519_valid: false });
    expect((await request(app).post('/api/v1/webhook_inbox/wi_unknown').send({})).status).toBe(404);
    const list = await request(app).get('/api/v1/webhook_inbox').set(merchant.auth);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data[1]).toMatchObject({ eventType: 'payment_intent.succeeded', deliveryId, endpointId: ep.body.id, hmacValid: true, ed25519Valid: true });
    expect(list.body.data[1].headers['bitripay-signature']).toBe(headers['BitriPay-Signature']);
    // a payment intent created from the developer portal or the API emits payment_intent.created; the delivery to the inbox endpoint is queued
    const intent = await request(app)
      .post('/api/v1/qr-intents')
      .set(merchant.auth)
      .send({ amount: { currency: 'USD', value_minor: '2500' }, reference: 'ORDER-1' });
    expect(intent.status, JSON.stringify(intent.body)).toBe(201);
    const events = await request(app).get('/api/v1/events?limit=10').set(merchant.auth);
    expect(events.body.data.map((e: any) => e.type)).toContain('payment_intent.created');
    const deliveries = await request(app).get('/api/v1/webhook_deliveries?limit=10').set(merchant.auth);
    expect(deliveries.body.data.some((d: any) => d.event === 'payment_intent.created' && d.url === inbox.body.url)).toBe(true);
    expect((await request(app).delete('/api/v1/webhook_inbox').set(merchant.auth)).body.cleared).toBe(2);
    expect((await request(app).get('/api/v1/webhook_inbox').set(merchant.auth)).body.data).toHaveLength(0);
  });
});
