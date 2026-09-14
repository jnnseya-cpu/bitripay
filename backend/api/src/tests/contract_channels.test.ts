/**
 * Contract tests for the conversational and commerce channels: the WhatsApp Cloud API webhook (handshake, signature,
 * command grammar round trip, pay cards, admin settings masking) and Shopify via link redirect (merchant-key start,
 * scope enforcement, return redirect with the outcome).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { setupApp, registerUser, fund, adminToken } from './helpers';
import { config } from '../config';
import { getWhatsAppSettings, recentWhatsApp, recentWhatsAppOutbox, extractPaymentReference, MASK } from '../services/channels/whatsapp';

let app: ReturnType<typeof setupApp>;
let admin: Awaited<ReturnType<typeof adminToken>>;
const APP_SECRET = 'meta-app-secret-for-tests';
const VERIFY_TOKEN = 'bitripay-verify-token';
let msgSeq = 0;

const phone = () =>
  `+2439${Math.floor(Math.random() * 1e8)
    .toString()
    .padStart(8, '0')}`;
const waId = (p: string) => p.replace(/[^0-9]/g, '');

/** A Cloud API webhook body with one text message from `from` (digits, no plus). */
function inbound(from: string, text: string, id = `wamid.${Date.now()}.${++msgSeq}`) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1234567890',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: '111222333' },
              contacts: [{ profile: { name: 'Test Contact' }, wa_id: from }],
              messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
}
const sign = (raw: string, secret = APP_SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
/** POST the webhook exactly as Meta does: JSON bytes + X-Hub-Signature-256 over those bytes. */
function post(body: unknown, secret = APP_SECRET, header?: string) {
  const raw = JSON.stringify(body);
  return request(app)
    .post('/api/whatsapp')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', header ?? sign(raw, secret))
    .send(raw);
}

beforeAll(async () => {
  app = setupApp();
  admin = await adminToken(app);
  const r = await request(app).put('/api/admin/channels/whatsapp').set(admin.auth).send({ enabled: true, verifyToken: VERIFY_TOKEN, appSecret: APP_SECRET, payButtonText: 'Pay' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
});

describe('WhatsApp webhook (Meta Cloud API)', () => {
  it('answers the verification handshake with hub.challenge and refuses a wrong verify token', async () => {
    const ok = await request(app).get('/api/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '1158201444' });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('1158201444');
    expect(ok.headers['content-type']).toMatch(/text\/plain/);
    const wrong = await request(app).get('/api/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('whatsapp_verify_failed');
    const badMode = await request(app).get('/api/whatsapp').query({ 'hub.mode': 'unsubscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '1' });
    expect(badMode.status).toBe(403);
  });

  it('rejects a missing, malformed or wrong X-Hub-Signature-256 and never processes the message', async () => {
    const from = waId(phone());
    const before = recentWhatsApp(200).length;
    const wrongSecret = await post(inbound(from, 'HELP'), 'another-secret');
    expect(wrongSecret.status).toBe(403);
    expect(wrongSecret.body.error.code).toBe('whatsapp_signature');
    const missing = await request(app).post('/api/whatsapp').send(inbound(from, 'HELP'));
    expect(missing.status).toBe(403);
    const malformed = await post(inbound(from, 'HELP'), APP_SECRET, 'md5=abc');
    expect(malformed.status).toBe(403);
    // a signature over different bytes (tampered body) fails too
    const raw = JSON.stringify(inbound(from, 'HELP'));
    const tampered = await request(app).post('/api/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(raw)).send(raw.replace('HELP', 'BAL 1234'));
    expect(tampered.status).toBe(403);
    expect(recentWhatsApp(200).length).toBe(before);
  });

  it('runs BAL through the SMS command grammar and records the reply in the outbox (no access token configured)', async () => {
    const p = phone();
    const user = await registerUser(app, { phone: p });
    await fund(app, user.user.id, '25.00', 'USD');
    const r = await post(inbound(waId(p), 'BAL 1234'));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, received: 1, duplicates: 0 });
    expect(r.body.handled).toHaveLength(1);
    expect(r.body.handled[0]).toMatchObject({ from: p, kind: 'text', replyType: 'text', via: 'outbox' });
    const out = recentWhatsAppOutbox(1)[0];
    expect(out.to).toBe(waId(p));
    expect(out.payload.type).toBe('text');
    expect(out.summary).toBe('Balance: $25.00');
    expect(out.delivered).toBe(false);
    const log = recentWhatsApp(10);
    expect(log.find((m) => m.direction === 'in' && m.phone === p)?.body).toBe('BAL 1234');
    expect(log.find((m) => m.direction === 'out' && m.phone === p)?.body).toBe('Balance: $25.00');
    // wrong PIN and an unknown command come back as text too
    const bad = await post(inbound(waId(p), 'BAL 0000'));
    expect(bad.status).toBe(200);
    expect(recentWhatsAppOutbox(1)[0].summary).toBe('Wrong PIN. Format: BAL <PIN>');
    // the same message id redelivered by Meta is acknowledged, not processed again
    const id = `wamid.dup.${Date.now()}`;
    await post(inbound(waId(p), 'CODE', id));
    const dup = await post(inbound(waId(p), 'CODE', id));
    expect(dup.status).toBe(200);
    expect(dup.body).toMatchObject({ received: 1, duplicates: 1 });
    expect(dup.body.handled).toHaveLength(0);
  });

  it('turns a message containing a checkout link into an interactive cta_url pay card with amount, merchant and Pay button', async () => {
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'Kiosk Deux' });
    const cs = await request(app).post('/api/v1/checkout_sessions').set(merchant.auth).send({ amount_minor: 1250, currency: 'USD', description: 'Two coffees' });
    expect(cs.status, JSON.stringify(cs.body)).toBe(201);
    expect(cs.body.url).toMatch(/\/pay\/[A-Za-z0-9]+\?cs=cs_/);
    const p = phone();
    const r = await post(inbound(waId(p), `Hi, can you pay this? ${cs.body.url} thanks`));
    expect(r.status).toBe(200);
    expect(r.body.handled[0]).toMatchObject({ kind: 'pay_card', replyType: 'interactive' });
    const out = recentWhatsAppOutbox(1)[0];
    expect(out.payload.type).toBe('interactive');
    if (out.payload.type !== 'interactive') throw new Error('expected an interactive payload');
    const card = out.payload.interactive;
    expect(card.type).toBe('cta_url');
    expect(card.header?.text).toBe('Kiosk Deux');
    expect(card.body.text).toContain('Pay $12.50 to Kiosk Deux.');
    expect(card.body.text).toContain('Two coffees');
    expect(card.action).toEqual({ name: 'cta_url', parameters: { display_text: 'Pay', url: cs.body.url } });
    expect(card.footer?.text).toBe('Secured by BitriPay');
    // the bare session id and a payment-request code are recognised as references too
    expect(extractPaymentReference(`please pay ${cs.body.id}`)).toEqual({ kind: 'checkout_session', code: cs.body.id, url: null });
    expect(extractPaymentReference(`${config.webUrl}/pay/ABCD2345`)).toEqual({ kind: 'payment_request', code: 'ABCD2345', url: `${config.webUrl}/pay/ABCD2345` });
    expect(extractPaymentReference('BAL 1234')).toBeNull();
    // an unknown link gets a text explanation, not a card
    const unknown = await post(inbound(waId(p), `${config.webUrl}/pay/ZZZZ9999`));
    expect(unknown.body.handled[0].kind).toBe('text');
    expect(recentWhatsAppOutbox(1)[0].summary).toMatch(/was not found or has expired/);
  });

  it('admin: reads settings with secrets masked, keeps secrets when the mask is sent back, audits and exposes the simulator', async () => {
    const get = await request(app).get('/api/admin/channels/whatsapp').set(admin.auth);
    expect(get.status).toBe(200);
    expect(get.body.settings.appSecret).toBe(MASK);
    expect(get.body.settings.accessToken).toBe('');
    expect(get.body.settings.verifyToken).toBe(VERIFY_TOKEN);
    expect(get.body.webhookUrl).toBe(`${config.apiUrl}/api/whatsapp`);
    expect(get.body.readiness).toMatchObject({ canReceive: true, canSend: false });
    expect(Array.isArray(get.body.messages)).toBe(true);
    expect(Array.isArray(get.body.outbox)).toBe(true);
    // sending the mask back keeps the stored secret; a new token is stored encrypted and read back decrypted
    const put = await request(app)
      .put('/api/admin/channels/whatsapp')
      .set(admin.auth)
      .send({ appSecret: MASK, accessToken: 'EAAB-access-token', phoneNumberId: '111222333', footer: 'Kiosk Deux via BitriPay' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.settings.appSecret).toBe(MASK);
    expect(put.body.settings.accessToken).toBe(MASK);
    expect(put.body.readiness.canSend).toBe(true);
    const live = getWhatsAppSettings();
    expect(live.appSecret).toBe(APP_SECRET);
    expect(live.accessToken).toBe('EAAB-access-token');
    expect(live.footer).toBe('Kiosk Deux via BitriPay');
    // the raw settings row never holds the plain secret
    const { getDb } = await import('../db');
    const row = getDb().prepare("SELECT value FROM settings WHERE key = 'whatsapp'").get() as { value: string };
    expect(row.value).not.toContain(APP_SECRET);
    expect(row.value).not.toContain('EAAB-access-token');
    // signature verification still uses the kept secret
    const ok = await post(inbound(waId(phone()), 'HELP'));
    expect(ok.status).toBe(200);
    // audited
    const logs = await request(app).get('/api/admin/audit-logs?search=channels.whatsapp.settings.update').set(admin.auth);
    expect(logs.status).toBe(200);
    expect(logs.body.items.some((l: any) => l.action === 'channels.whatsapp.settings.update' && l.details?.secretsChanged?.includes('accessToken'))).toBe(true);
    // simulator drives the real handler
    const sim = await request(app).post('/api/admin/channels/whatsapp/simulate').set(admin.auth).send({ phone: phone(), text: 'HELP' });
    expect(sim.status).toBe(200);
    expect(sim.body.kind).toBe('text');
    expect(sim.body.reply.summary).toMatch(/^BitriPay SMS: BAL <PIN>/);
    // permission and validation
    const bad = await request(app).put('/api/admin/channels/whatsapp').set(admin.auth).send({ apiVersion: 'twenty' });
    expect(bad.status).toBe(400);
    const anon = await request(app).get('/api/admin/channels/whatsapp');
    expect(anon.status).toBe(401);
  });

  it('a disabled channel acknowledges Meta without processing and refuses the handshake', async () => {
    await request(app).put('/api/admin/channels/whatsapp').set(admin.auth).send({ enabled: false });
    const before = recentWhatsAppOutbox(200).length;
    const r = await post(inbound(waId(phone()), 'HELP'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: false, received: 0, handled: [], duplicates: 0 });
    expect(recentWhatsAppOutbox(200).length).toBe(before);
    const hs = await request(app).get('/api/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '1' });
    expect(hs.status).toBe(403);
    await request(app).put('/api/admin/channels/whatsapp').set(admin.auth).send({ enabled: true });
  });
});

describe('Shopify via link redirect', () => {
  const start = (auth: Record<string, string>, body: Record<string, unknown> = {}) =>
    request(app)
      .post('/api/shopify/start')
      .set(auth)
      .send({
        shop: 'kiosk-deux.myshopify.com',
        order_id: 1001,
        order_name: '#1001',
        amount_minor: 4990,
        currency: 'USD',
        return_url: 'https://kiosk-deux.myshopify.com/apps/bitripay/return?x=1',
        ...body,
      });

  it('starts a checkout with a merchant secret key and returns the hosted checkout redirect URL', async () => {
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'Kiosk Deux' });
    const key = await request(app).post('/api/v1/api_keys').set(merchant.auth).send({ label: 'shopify', mode: 'test' });
    expect(key.status, JSON.stringify(key.body)).toBe(201);
    const auth = { Authorization: `Bearer ${key.body.secret}` };
    const r = await start(auth);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.redirect_url).toMatch(new RegExp(`^${config.webUrl}/pay/[A-Za-z0-9]+\\?cs=cs_`));
    expect(r.body.redirect_url).toBe(r.body.session.url);
    expect(r.body.session.status).toBe('open');
    expect(r.body.session.amount).toEqual({ valueMinor: 4990, currency: 'USD' });
    expect(r.body.session.paymentIntent.metadata.shopify).toMatchObject({
      shop: 'kiosk-deux.myshopify.com',
      orderId: '1001',
      orderName: '#1001',
      returnUrl: 'https://kiosk-deux.myshopify.com/apps/bitripay/return?x=1',
    });
    expect(r.body.session.paymentIntent.metadata.shopify.ref).toMatch(/^shp_[a-z0-9]{16}$/);
    expect(r.body.session.paymentIntent.reference).toBe('shopify:1001');
    // the hosted checkout sends the shopper to the return endpoint carrying that reference
    expect(r.body.session.successUrl).toBe(`${config.apiUrl}/api/shopify/return?ref=${r.body.session.paymentIntent.metadata.shopify.ref}`);
    expect(r.body.return_url).toBe(r.body.session.successUrl);
    // the session is a regular gateway object
    const v1 = await request(app).get(`/api/v1/checkout_sessions/${r.body.session.id}`).set(auth);
    expect(v1.status).toBe(200);
    expect(v1.body.paymentIntent.metadata.shopify.shop).toBe('kiosk-deux.myshopify.com');
    // validation
    const bad = await start(auth, { shop: 'not a domain' });
    expect(bad.status).toBe(400);
    const noAmount = await start(auth, { amount_minor: 0 });
    expect(noAmount.status).toBe(400);
  });

  it('refuses a wrong key (401), a publishable key and a restricted key without checkout_sessions:write (403)', async () => {
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'Scoped Ltd' });
    const wrong = await start({ Authorization: 'Bearer sk_test_definitely_not_a_key' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('invalid_api_key');
    const none = await request(app).post('/api/shopify/start').send({});
    expect(none.status).toBe(401);
    const pk = await request(app).post('/api/v1/api_keys').set(merchant.auth).send({ label: 'browser', kind: 'publishable', mode: 'test' });
    expect(pk.body.secret).toMatch(/^pk_test_/);
    const viaPk = await start({ Authorization: `Bearer ${pk.body.secret}` });
    expect(viaPk.status).toBe(403);
    expect(viaPk.body.error.code).toBe('scope_denied');
    const ro = await request(app)
      .post('/api/v1/api_keys')
      .set(merchant.auth)
      .send({ label: 'reporting', kind: 'restricted', mode: 'test', scopes: ['payment_intents:read'] });
    expect(ro.body.secret).toMatch(/^rk_test_/);
    const viaRo = await start({ Authorization: `Bearer ${ro.body.secret}` });
    expect(viaRo.status).toBe(403);
    expect(viaRo.body.error.code).toBe('scope_denied');
    const rw = await request(app)
      .post('/api/v1/api_keys')
      .set(merchant.auth)
      .send({ label: 'shopify', kind: 'restricted', mode: 'test', scopes: ['checkout_sessions:write'] });
    const viaRw = await start({ Authorization: `Bearer ${rw.body.secret}` });
    expect(viaRw.status, JSON.stringify(viaRw.body)).toBe(201);
    // a customer session is not a merchant
    const customer = await registerUser(app);
    const viaCustomer = await start(customer.auth);
    expect(viaCustomer.status).toBe(403);
    expect(viaCustomer.body.error.code).toBe('role_required');
  });

  it('return redirects (302) to the store with bitripay_status pending, then paid after a wallet payment, and failed when expired', async () => {
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'Kiosk Deux' });
    const key = await request(app).post('/api/v1/api_keys').set(merchant.auth).send({ label: 'shopify', mode: 'test' });
    const auth = { Authorization: `Bearer ${key.body.secret}` };
    const started = await start(auth, { amount_minor: 1500 });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const session = started.body.session;
    const ref = session.paymentIntent.metadata.shopify.ref;
    // by session id
    let r = await request(app).get('/api/shopify/return').query({ session: session.id });
    expect(r.status).toBe(302);
    let loc = new URL(r.headers.location);
    expect(loc.origin + loc.pathname).toBe('https://kiosk-deux.myshopify.com/apps/bitripay/return');
    expect(loc.searchParams.get('x')).toBe('1');
    expect(loc.searchParams.get('bitripay_status')).toBe('pending');
    expect(loc.searchParams.get('session')).toBe(session.id);
    expect(loc.searchParams.get('order_id')).toBe('1001');
    // by the reference carried in the checkout's success URL
    r = await request(app).get('/api/shopify/return').query({ ref });
    expect(r.status).toBe(302);
    expect(new URL(r.headers.location).searchParams.get('session')).toBe(session.id);
    // the shopper pays from a BitriPay wallet on the hosted checkout
    const payer = await registerUser(app);
    await fund(app, payer.user.id, '50.00', 'USD');
    const code = new URL(session.url).pathname.split('/').pop()!;
    const paid = await request(app).post(`/api/checkout/${code}/wallet`).set(payer.auth).send({ pin: '1234' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    r = await request(app).get('/api/shopify/return').query({ session: session.id });
    expect(r.status).toBe(302);
    loc = new URL(r.headers.location);
    expect(loc.searchParams.get('bitripay_status')).toBe('paid');
    const status = await request(app).get('/api/shopify/status').query({ session: session.id }).set(auth);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ bitripay_status: 'paid', session_id: session.id, order_id: '1001', shop: 'kiosk-deux.myshopify.com' });
    // an expired session reports failed
    const other = await start(auth, { order_id: 1002 });
    const expired = await request(app).post(`/api/v1/checkout_sessions/${other.body.session.id}/expire`).set(auth);
    expect(expired.status, JSON.stringify(expired.body)).toBe(200);
    r = await request(app).get('/api/shopify/return').query({ session: other.body.session.id });
    expect(r.status).toBe(302);
    expect(new URL(r.headers.location).searchParams.get('bitripay_status')).toBe('failed');
    // unknown or non-Shopify sessions never redirect anywhere
    const missing = await request(app).get('/api/shopify/return').query({ session: 'cs_doesnotexist' });
    expect(missing.status).toBe(404);
    const plain = await request(app).post('/api/v1/checkout_sessions').set(auth).send({ amount_minor: 100, currency: 'USD' });
    const notShopify = await request(app).get('/api/shopify/return').query({ session: plain.body.id });
    expect(notShopify.status).toBe(404);
    expect(notShopify.body.error.code).toBe('shopify_checkout_not_found');
    const noRef = await request(app).get('/api/shopify/return');
    expect(noRef.status).toBe(400);
  });
});
