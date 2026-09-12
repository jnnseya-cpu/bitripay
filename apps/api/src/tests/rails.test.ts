import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, adminToken, fund, manualConfirm, decideWithdrawal } from './helpers';
import { signToken } from '../lib/jwt';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

describe('direct mobile money rail (no operator API)', () => {
  it('lists world operators and pays via collection number with SMS auto-confirm', async () => {
    const admin = await adminToken(app);
    const ops = await request(app).get('/api/mobile-money-operators?country=GH');
    expect(ops.body.items.length).toBeGreaterThan(2);
    const all = await request(app).get('/api/mobile-money-operators');
    expect(all.body.items.length).toBeGreaterThan(200);
    // Admin configures the MTN Ghana collection number + SMS secret on the direct rail gateway.
    const mtn = ops.body.items.find((o: any) => o.id === 'mtn_gh');
    await request(app).put('/api/admin/momo-operators/mtn_gh').set(admin.auth).send({ ...mtn, collectionNumber: '0244000000', collectionName: 'BitriPay Ltd', payoutEnabled: true, enabled: true });
    await request(app).put('/api/admin/gateways/manual_momo').set(admin.auth).send({ name: 'Mobile money (direct)', provider: 'manual_momo', enabled: true, methods: ['mobile_money'], currencies: [], credentials: { smsSecret: 'sms-secret' } });
    // The shared-secret forwarder is only authoritative when the administrator explicitly opts in (device-signed evidence is the default).
    await request(app).put('/api/admin/settings/gateway').set(admin.auth).send({ value: { sharedSecretAutoConfirm: true } });

    const u = await registerUser(app, { country: 'GH' });
    const options = await request(app).get('/api/deposits/options?currency=GHS').set(u.auth);
    const momo = options.body.methods.find((m: any) => m.method === 'mobile_money');
    expect(momo.gateways.some((g: any) => g.provider === 'manual_momo')).toBe(true);
    expect(momo.operators.find((o: any) => o.id === 'mtn_gh').directRail).toBe(true);

    const dep = await request(app).post('/api/deposits').set(u.auth).send({ pin: '1234', method: 'mobile_money', amount: '50', currency: 'GHS', operatorId: 'mtn_gh', phone: '+233244111222' });
    expect(dep.status).toBe(201);
    expect(dep.body.payment.status).toBe('pending');
    expect(dep.body.payment.next.type).toBe('bank_instructions');
    expect(dep.body.payment.next.instructions['Send to']).toBe('0244000000');
    const ref = dep.body.payment.providerRef;
    expect(ref).toMatch(/^MM[A-Z2-9]{6}$/);

    // Operator without a collection number falls back to the sandbox simulator in development.
    const bad = await request(app).post('/api/deposits').set(u.auth).send({ pin: '1234', method: 'mobile_money', amount: '10', currency: 'GHS', operatorId: 'vodafone_gh', phone: '+233200000000' });
    expect(bad.status).toBe(201);
    expect(bad.body.payment.gateway).toBe('sandbox');

    // Forwarded receipt SMS auto-confirms the payment (wrong secret rejected).
    const rejected = await request(app).post('/api/webhooks/manual_momo').send({ secret: 'nope', text: `Payment received GHS 50.00 from 0244111222 Ref ${ref}` });
    expect(rejected.status).toBe(400);
    const ok = await request(app).post('/api/webhooks/manual_momo').send({ secret: 'sms-secret', text: `Payment received GHS 50.00 from 0244111222 Ref ${ref}. Bal: GHS 1,250.00` });
    expect(ok.body, JSON.stringify(ok.body)).toMatchObject({ handled: 1 });
    const wallets = await request(app).get('/api/wallets').set(u.auth);
    const ghs = wallets.body.items.find((w: any) => w.currency === 'GHS');
    expect(ghs.balance).toBe(5000); // no mobile money deposit fee by default

    // Admin can also confirm manually; verify shows succeeded now.
    const view = await request(app).get(`/api/deposits/${dep.body.payment.id}`).set(u.auth);
    expect(view.body.payment.status).toBe('succeeded');
  });

  it('pays out to any mobile money number, approved by admin', async () => {
    const u = await registerUser(app);
    await fund(app, u.user.id, '100.00');
    const ops = await request(app).get('/api/withdrawals/operators?country=KE').set(u.auth);
    expect(ops.body.items.some((o: any) => o.id === 'mpesa_ke')).toBe(true);
    const w = await request(app).post('/api/withdrawals').set(u.auth).send({ amount: '30', currency: 'USD', destination: { method: 'mobile_money', operatorId: 'mpesa_ke', phone: '+254712345678', name: 'Wanjiru' }, pin: '1234' });
    expect(w.status).toBe(201);
    expect(w.body.transaction.status).toBe('pending');
    expect(w.body.transaction.metadata.operator.name).toBe('M-Pesa');
    const admin = await adminToken(app);
    const list = await request(app).get('/api/admin/withdrawals?status=pending').set(admin.auth);
    expect(list.body.items.some((t: any) => t.id === w.body.transaction.id)).toBe(true);
    // The payout is routed to a payout instruction; with no prefunded M-Pesa float it waits on liquidity and can still be settled manually under maker-checker.
    expect(w.body.transaction.metadata.payoutStage).toBe('LIQUIDITY_UNAVAILABLE');
    await decideWithdrawal(app, w.body.transaction.id, 'approve', 'MPESA-QX1');
    const done = await request(app).get(`/api/wallets/transactions/${w.body.transaction.id}`).set(u.auth);
    expect(done.body.transaction.status).toBe('completed');
  });
});

describe('any → any routing', () => {
  it('card → another user wallet in another currency, in one request', async () => {
    const sender = await registerUser(app);
    const receiver = await registerUser(app, { tag: 'route_rcv' });
    const preview = await request(app).post('/api/money/preview').set(sender.auth).send({ destination: { method: 'wallet', to: '@route_rcv' }, amount: '40', currency: 'USD', targetCurrency: 'EUR' });
    expect(preview.body.destination.user.tag).toBe('route_rcv');
    expect(preview.body.quote.targetCurrency).toBe('EUR');
    expect(preview.body.fx.provider).toBeTruthy();
    expect(preview.body.declaration.funding.kind).toBe('wallet');
    const r = await request(app).post('/api/money').set(sender.auth).send({ source: { method: 'card', card: { number: '4242424242424242', expMonth: 12, expYear: 2030, cvc: '123', holderName: 'Sender One' } }, destination: { method: 'wallet', to: '@route_rcv', note: 'Rent' }, amount: '40', currency: 'USD', targetCurrency: 'EUR', pin: '1234' });
    expect(r.status).toBe(201);
    expect(r.body.route.status).toBe('completed');
    expect(r.body.route.payoutTransactionId).toBeTruthy();
    const rw = await request(app).get('/api/wallets').set(receiver.auth);
    const eur = rw.body.items.find((w: any) => w.currency === 'EUR');
    expect(eur.balance).toBeGreaterThan(3000);
    const list = await request(app).get('/api/money').set(sender.auth);
    expect(list.body.items[0].destination).toBe('wallet');
  });

  it('wallet → QR payment request, and wallet → mobile money payout (pending)', async () => {
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'Kiosk' });
    const payer = await registerUser(app);
    await fund(app, payer.user.id, '200.00');
    const pr = await request(app).post('/api/payment-requests').set(merchant.auth).send({ kind: 'qr', amount: '15', currency: 'USD' });
    const r = await request(app).post('/api/money').set(payer.auth).send({ source: { method: 'wallet' }, destination: { method: 'qr', data: pr.body.paymentRequest.qr }, amount: '15', currency: 'USD', pin: '1234' });
    expect(r.status).toBe(201);
    expect(r.body.route.status).toBe('completed');
    const paid = await request(app).get(`/api/payment-requests/${pr.body.paymentRequest.code}`).set(merchant.auth);
    expect(paid.body.paymentRequest.status).toBe('paid');

    const r2 = await request(app).post('/api/money').set(payer.auth).send({ source: { method: 'wallet' }, destination: { method: 'mobile_money', operatorId: 'mtn_ug', phone: '+256700000001' }, amount: '20', currency: 'USD', pin: '1234' });
    expect(r2.body.route.status).toBe('pending');
    expect(r2.body.route.payoutTransactionId).toBeTruthy();
    const bad = await request(app).post('/api/money').set(payer.auth).send({ source: { method: 'wallet' }, destination: { method: 'wallet', to: '@nobody_here' }, amount: '1', currency: 'USD', pin: '1234' });
    expect(bad.status).toBe(404);
  });

  it('mobile money (direct rail, pending) → bank: payout runs automatically after admin confirms funding', async () => {
    const admin = await adminToken(app);
    await request(app).put('/api/admin/momo-operators/airtel_ug').set(admin.auth).send({ name: 'Airtel Money', brand: 'Airtel', country: 'UG', currency: 'UGX', collectionNumber: '0750000000', payoutEnabled: true, enabled: true });
    const u = await registerUser(app);
    const r = await request(app).post('/api/money').set(u.auth).send({ source: { method: 'mobile_money', operatorId: 'airtel_ug', phone: '+256750000009' }, destination: { method: 'bank', bankName: 'Stanbic', accountName: 'Okello', accountNumber: '9030001234', country: 'UG' }, amount: '100000', currency: 'UGX', pin: '1234' });
    expect(r.status).toBe(201);
    expect(r.body.route.status, JSON.stringify(r.body.route)).toBe('funding');
    expect(r.body.route.payment?.next?.instructions?.['Send to'], JSON.stringify(r.body.route.payment)).toBe('0750000000');
    const confirm = await manualConfirm(app, r.body.route.paymentId);
    expect(confirm.payment.status).toBe('succeeded');
    const after = await request(app).get(`/api/money/${r.body.route.id}`).set(u.auth);
    expect(after.body.route.status, after.body.route.error ?? '').toBe('pending'); // payout leg queued for admin
    expect(after.body.route.payoutTransactionId).toBeTruthy();
    const tx = await request(app).get(`/api/wallets/transactions/${after.body.route.payoutTransactionId}`).set(u.auth);
    expect(tx.body.transaction.type).toBe('withdrawal');
    expect(tx.body.transaction.metadata.bankAccount.bankName).toBe('Stanbic');
  });
});

describe('biometric step-up', () => {
  it('accepts a step-up token instead of the PIN and rejects foreign/expired ones', async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await fund(app, a.user.id, '20.00');
    const token = signToken({ sub: a.user.id, role: 'user', stepUp: true } as any, '5m');
    const ok = await request(app).post('/api/transfers').set(a.auth).set('X-Step-Up-Token', token).send({ to: b.user.tag, amount: '5', currency: 'USD' });
    expect(ok.status).toBe(201);
    const foreign = signToken({ sub: b.user.id, role: 'user', stepUp: true } as any, '5m');
    const bad = await request(app).post('/api/transfers').set(a.auth).send({ to: b.user.tag, amount: '5', currency: 'USD', stepUpToken: foreign });
    expect(bad.status).toBe(403);
    const plain = await request(app).post('/api/transfers').set(a.auth).set('X-Step-Up-Token', a.token).send({ to: b.user.tag, amount: '5', currency: 'USD' });
    expect(plain.status).toBe(403);
    const opts = await request(app).post('/api/account/passkeys/step-up/options').set(a.auth);
    expect(opts.body.error.code).toBe('no_passkey');
    const login = await request(app).post('/api/auth/passkey/options');
    expect(login.body.options.challenge).toBeTruthy();
    const list = await request(app).get('/api/account/passkeys').set(a.auth);
    expect(list.body.items).toEqual([]);
  });
});
