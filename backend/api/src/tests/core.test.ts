import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, adminToken, fund, decideWithdrawal } from './helpers';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

describe('config & auth', () => {
  it('serves public config with currencies and modules', async () => {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.baseCurrency).toBe('USD');
    expect(res.body.currencies.length).toBeGreaterThan(10);
    expect(res.body.modules.qrPayments).toBe(true);
    expect(res.body.countries.length).toBe(250);
  });

  it('registers, logs in and requires PIN for money movement', async () => {
    const { token, user } = await registerUser(app, { tag: 'alice_t' });
    expect(user.tag).toBe('alice_t');
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.body.user.hasPin).toBe(true);
    const login = await request(app).post('/api/auth/login').send({ identifier: user.email, password: 'Password123!' });
    expect(login.status).toBe(200);
    const bad = await request(app).post('/api/auth/login').send({ identifier: user.email, password: 'nope' });
    expect(bad.status).toBe(401);
  });

  it('supports phone OTP registration and login (sandbox code)', async () => {
    const phone = '+15551230000';
    const otp = await request(app).post('/api/auth/otp/request').send({ identifier: phone, purpose: 'register' });
    expect(otp.status).toBe(200);
    expect(otp.body.devCode).toHaveLength(6);
    const reg = await request(app).post('/api/auth/register').send({ fullName: 'Phone User', phone, password: 'Password123!', otpCode: otp.body.devCode });
    expect(reg.status).toBe(201);
    expect(reg.body.user.phoneVerified).toBe(true);
    const otp2 = await request(app).post('/api/auth/otp/request').send({ identifier: phone, purpose: 'login' });
    const login = await request(app).post('/api/auth/otp/verify').send({ identifier: phone, code: otp2.body.devCode });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();
  });

  it('enables 2FA and enforces it on login', async () => {
    const { auth, user } = await registerUser(app);
    const setup = await request(app).post('/api/account/2fa/setup').set(auth);
    expect(setup.body.secret).toBeTruthy();
    const { totpCode } = await import('../lib/totp');
    const enable = await request(app)
      .post('/api/account/2fa/enable')
      .set(auth)
      .send({ code: totpCode(setup.body.secret) });
    expect(enable.status).toBe(200);
    const login = await request(app).post('/api/auth/login').send({ identifier: user.email, password: 'Password123!' });
    expect(login.body.requiresTwoFactor).toBe(true);
    const blocked = await request(app).get('/api/wallets').set('Authorization', `Bearer ${login.body.token}`);
    expect(blocked.status).toBe(401);
    const done = await request(app)
      .post('/api/auth/2fa/verify')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({ code: totpCode(setup.body.secret) });
    expect(done.status).toBe(200);
    expect(done.body.requiresTwoFactor).toBeUndefined();
  });
});

describe('wallets, transfers & ledger', () => {
  it('transfers money with fees and keeps the ledger balanced', async () => {
    const a = await registerUser(app, { tag: 'sender1' });
    const b = await registerUser(app, { tag: 'receiver1' });
    await fund(app, a.user.id, '100.00');
    const fee = await request(app).get('/api/transfers/fee?amount=25.00&currency=USD').set(a.auth);
    expect(fee.body.fee).toBe(13); // 0.5% of 2500 = 12.5 -> 13
    const tx = await request(app).post('/api/transfers').set(a.auth).send({ to: '@receiver1', amount: '25.00', currency: 'USD', note: 'hi', pin: '1234' });
    expect(tx.status).toBe(201);
    expect(tx.body.transaction.type).toBe('transfer');
    expect(tx.body.transaction.counterparty.tag).toBe('receiver1');
    const wa = await request(app).get('/api/wallets').set(a.auth);
    const wb = await request(app).get('/api/wallets').set(b.auth);
    expect(wa.body.items[0].balance).toBe(10000 - 2500 - 13);
    expect(wb.body.items[0].balance).toBe(2500);
    const wrongPin = await request(app).post('/api/transfers').set(a.auth).send({ to: 'receiver1', amount: '1.00', currency: 'USD', pin: '0000' });
    expect(wrongPin.status).toBe(403);
    const tooMuch = await request(app).post('/api/transfers').set(a.auth).send({ to: 'receiver1', amount: '90.00', currency: 'USD', pin: '1234' });
    expect(tooMuch.body.error.code).toBe('insufficient_funds');
    // idempotency
    const k1 = await request(app).post('/api/transfers').set(a.auth).send({ to: 'receiver1', amount: '1.00', currency: 'USD', pin: '1234', idempotencyKey: 'same-key' });
    const k2 = await request(app).post('/api/transfers').set(a.auth).send({ to: 'receiver1', amount: '1.00', currency: 'USD', pin: '1234', idempotencyKey: 'same-key' });
    expect(k1.body.transaction.id).toBe(k2.body.transaction.id);
    const list = await request(app).get('/api/wallets/transactions').set(b.auth);
    expect(list.body.items[0].direction).toBe('in');
  });

  it('exchanges between own wallets using platform rate with margin', async () => {
    const a = await registerUser(app);
    await fund(app, a.user.id, '100.00');
    const quote = await request(app).get('/api/wallets/exchange/quote?from=USD&to=EUR&amount=50').set(a.auth);
    expect(quote.body.receive).toBeLessThan(5000);
    const ex = await request(app).post('/api/wallets/exchange').set(a.auth).send({ from: 'USD', to: 'EUR', amount: '50', pin: '1234' });
    expect(ex.status).toBe(201);
    const wallets = await request(app).get('/api/wallets').set(a.auth);
    const eur = wallets.body.items.find((w: any) => w.currency === 'EUR');
    expect(eur.balance).toBe(quote.body.receive);
  });

  it('enforces unverified limits', async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await fund(app, a.user.id, '2000.00');
    const res = await request(app).post('/api/transfers').set(a.auth).send({ to: b.user.tag, amount: '600.00', currency: 'USD', pin: '1234' });
    expect(res.body.error.code).toBe('limit_exceeded');
  });
});

describe('QR & payment requests', () => {
  it('resolves static and dynamic QR codes and pays them', async () => {
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'Shop', tag: 'shop1' });
    const payer = await registerUser(app);
    await fund(app, payer.user.id, '50.00');
    const myQr = await request(app).get('/api/qr/me?amount=5.00&currency=USD').set(merchant.auth);
    expect(myQr.body.content).toContain('/q?');
    const resolved = await request(app).post('/api/qr/resolve').set(payer.auth).send({ data: myQr.body.content });
    expect(resolved.body.kind).toBe('merchant');
    expect(resolved.body.amount).toBe('5.00');

    const pr = await request(app).post('/api/payment-requests').set(merchant.auth).send({ kind: 'qr', amount: '12.00', currency: 'USD', description: 'Table 4' });
    expect(pr.status).toBe(201);
    const code = pr.body.paymentRequest.code;
    const dyn = await request(app).post('/api/qr/resolve').set(payer.auth).send({ data: pr.body.paymentRequest.qr });
    expect(dyn.body.kind).toBe('payment_request');
    const pay = await request(app).post(`/api/payment-requests/${code}/pay`).set(payer.auth).send({ pin: '1234' });
    expect(pay.status).toBe(201);
    expect(pay.body.transaction.type).toBe('merchant_payment');
    expect(pay.body.paymentRequest.status).toBe('paid');
    const again = await request(app).post(`/api/payment-requests/${code}/pay`).set(payer.auth).send({ pin: '1234' });
    expect(again.status).toBe(409);
    const mw = await request(app).get('/api/wallets').set(merchant.auth);
    expect(mw.body.items[0].balance).toBe(1200 - 18); // 1.5% merchant fee
  });

  it('handles money requests between users', async () => {
    const a = await registerUser(app, { tag: 'asker' });
    const b = await registerUser(app, { tag: 'payerb' });
    await fund(app, b.user.id, '20.00');
    const req = await request(app).post('/api/payment-requests').set(a.auth).send({ kind: 'request', amount: '10.00', currency: 'USD', payer: 'payerb' });
    expect(req.status).toBe(201);
    const incoming = await request(app).get('/api/payment-requests?role=payer').set(b.auth);
    expect(incoming.body.items).toHaveLength(1);
    const notif = await request(app).get('/api/account/notifications').set(b.auth);
    expect(notif.body.items.some((n: any) => n.data.kind === 'money_request')).toBe(true);
    const pay = await request(app).post(`/api/payment-requests/${req.body.paymentRequest.code}/pay`).set(b.auth).send({ pin: '1234' });
    expect(pay.status).toBe(201);
    expect(pay.body.transaction.type).toBe('money_request');
  });
});

describe('deposits & checkout via sandbox gateway', () => {
  it('adds money by card, declines test cards, saves cards', async () => {
    const a = await registerUser(app);
    const options = await request(app).get('/api/deposits/options?currency=USD').set(a.auth);
    expect(options.body.methods.find((m: any) => m.method === 'card').gateways[0].id).toBe('sandbox');
    const ok = await request(app)
      .post('/api/deposits')
      .set(a.auth)
      .send({ pin: '1234', method: 'card', amount: '100.00', currency: 'USD', card: { number: '4242424242424242', expMonth: 12, expYear: 2030, cvc: '123', holderName: 'A B' }, saveCard: true });
    expect(ok.status).toBe(201);
    expect(ok.body.payment.status).toBe('succeeded');
    const wallets = await request(app).get('/api/wallets').set(a.auth);
    expect(wallets.body.items[0].balance).toBe(10000 - 30 - 290); // fixed 0.30 + 2.9%
    const declined = await request(app)
      .post('/api/deposits')
      .set(a.auth)
      .send({ pin: '1234', method: 'card', amount: '10.00', currency: 'USD', card: { number: '4000000000000002', expMonth: 12, expYear: 2030, cvc: '123', holderName: 'A B' } });
    expect(declined.body.payment.status).toBe('failed');
    expect(declined.body.payment.failureReason).toContain('declined');
    const cards = await request(app).get('/api/cards').set(a.auth);
    expect(cards.body.items).toHaveLength(1);
    const saved = await request(app).post('/api/deposits').set(a.auth).send({ pin: '1234', method: 'card', amount: '5.00', currency: 'USD', savedCardId: cards.body.items[0].id });
    expect(saved.body.payment.status).toBe('succeeded');
  });

  it('simulates mobile money prompts and manual bank transfers', async () => {
    const a = await registerUser(app);
    const momo = await request(app).post('/api/deposits').set(a.auth).send({ pin: '1234', method: 'mobile_money', amount: '20.00', currency: 'USD', phone: '+233200000001' });
    expect(momo.body.payment.status).toBe('pending');
    expect(momo.body.payment.next.type).toBe('prompt');
    const bank = await request(app).post('/api/deposits').set(a.auth).send({ pin: '1234', method: 'bank', amount: '30.00', currency: 'USD', gateway: 'manual_bank' });
    expect(bank.body.payment.next.type).toBe('bank_instructions');
    const admin = await adminToken(app);
    const pending = await request(app).get('/api/admin/payments?method=bank&status=pending').set(admin.auth);
    expect(pending.body.items.some((p: any) => p.id === bank.body.payment.id)).toBe(true);
    // Manual bank confirmation is maker-checker: a single admin cannot settle it alone.
    const alone = await request(app).post(`/api/admin/payments/${bank.body.payment.id}/confirm`).set(admin.auth).send({ note: 'seen' });
    expect(alone.body.payment.stage).toBe('VERIFYING');
    const self = await request(app).post(`/api/admin/verifications/${alone.body.verification.id}/approve`).set(admin.auth).send({ pin: admin.pin });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('maker_checker');
    const wallets0 = await request(app).get('/api/wallets').set(a.auth);
    expect(wallets0.body.items[0].balance).toBe(0); // nothing credited until approved
    const checker = await (await import('./helpers')).checkerToken(app);
    const confirm = await request(app).post(`/api/admin/verifications/${alone.body.verification.id}/approve`).set(checker.auth).send({ pin: checker.pin });
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(200);
    expect(confirm.body.payment.status).toBe('succeeded');
    expect(confirm.body.payment.stage).toBe('SETTLED');
    const wallets = await request(app).get('/api/wallets').set(a.auth);
    expect(wallets.body.items[0].balance).toBe(3000);
  });

  it('runs guest checkout with card and virtual card on a merchant payment link', async () => {
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'Store', tag: 'store9' });
    const link = await request(app).post('/api/payment-requests').set(merchant.auth).send({ kind: 'link', amount: '40.00', currency: 'USD', description: 'Order 1' });
    const code = link.body.paymentRequest.code;
    const info = await request(app).get(`/api/checkout/${code}`);
    expect(info.body.methods).toContain('card');
    const pay = await request(app)
      .post(`/api/checkout/${code}/pay`)
      .send({ method: 'card', card: { number: '5555555555554444', expMonth: 1, expYear: 2031, cvc: '999', holderName: 'Guest' }, email: 'guest@example.com' });
    expect(pay.status).toBe(201);
    expect(pay.body.payment.status).toBe('succeeded');
    expect(pay.body.paymentRequest.status).toBe('paid');
    const mw = await request(app).get('/api/wallets').set(merchant.auth);
    expect(mw.body.items[0].balance).toBe(4000 - 60);

    // virtual card flow
    const holder = await registerUser(app);
    await fund(app, holder.user.id, '100.00');
    const card = await request(app).post('/api/virtual-cards').set(holder.auth).send({ currency: 'USD', pin: '1234' });
    expect(card.status, JSON.stringify(card.body)).toBe(201);
    await request(app).post(`/api/virtual-cards/${card.body.card.id}/fund`).set(holder.auth).send({ amount: '60.00', pin: '1234' });
    const reveal = await request(app).post(`/api/virtual-cards/${card.body.card.id}/reveal`).set(holder.auth).send({ pin: '1234' });
    expect(reveal.body.card.number).toMatch(/^627311\d{10}$/);
    const link2 = await request(app).post('/api/payment-requests').set(merchant.auth).send({ kind: 'link', amount: '25.00', currency: 'USD' });
    const vpay = await request(app)
      .post(`/api/checkout/${link2.body.paymentRequest.code}/pay`)
      .send({
        method: 'virtual_card',
        card: { number: reveal.body.card.number, expMonth: reveal.body.card.expMonth, expYear: reveal.body.card.expYear, cvc: reveal.body.card.cvv, holderName: 'Card Holder' },
      });
    expect(vpay.status).toBe(201);
    expect(vpay.body.status).toBe('succeeded');
    const cards = await request(app).get('/api/virtual-cards').set(holder.auth);
    expect(cards.body.items[0].balance).toBe(6000 - 2500);
  });

  it('exposes the merchant v1 API with API keys and webhooks config', async () => {
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'API Shop' });
    const key = await request(app).post('/api/merchant/api-keys').set(merchant.auth).send({ label: 'woo' });
    expect(key.body.apiKey.secret).toMatch(/^sk_live_/); // legacy bp_ keys keep authenticating; new keys use the sk_/rk_/pk_ prefixes
    const v1 = await request(app)
      .post('/v1/payment-requests')
      .set('Authorization', `Bearer ${key.body.apiKey.secret}`)
      .send({ amount: '9.99', currency: 'USD', description: 'Woo order', metadata: { orderId: 55 } });
    expect(v1.status).toBe(201);
    expect(v1.body.checkoutUrl).toContain('/pay/');
    const get = await request(app).get(`/v1/payment-requests/${v1.body.paymentRequest.code}`).set('Authorization', `Bearer ${key.body.apiKey.secret}`);
    expect(get.body.paymentRequest.metadata.orderId).toBe(55);
    const wh = await request(app).put('/api/merchant/webhook').set(merchant.auth).send({ url: 'https://example.com/hook' });
    expect(wh.body.webhookSecret).toMatch(/^whsec_/);
    const denied = await request(app)
      .get('/v1/balance')
      .set(merchant.auth.Authorization ? { Authorization: 'Bearer sk_live_invalid' } : {});
    expect(denied.status).toBe(401);
  });
});

describe('withdrawals, agents, remittance', () => {
  it('holds withdrawal funds until admin approves or rejects', async () => {
    const a = await registerUser(app);
    await fund(app, a.user.id, '100.00');
    const bank = await request(app).post('/api/bank-accounts').set(a.auth).send({ bankName: 'Test Bank', accountName: 'Alice Test', accountNumber: '12345678', currency: 'USD', pin: '1234' });
    const w = await request(app).post('/api/withdrawals').set(a.auth).send({ amount: '40.00', currency: 'USD', bankAccountId: bank.body.bankAccount.id, pin: '1234' });
    expect(w.status).toBe(201);
    expect(w.body.transaction.status).toBe('pending');
    let wallets = await request(app).get('/api/wallets').set(a.auth);
    expect(wallets.body.items[0].balance).toBe(10000 - 4000 - 140); // 1.00 fixed + 1%
    const admin = await adminToken(app);
    // A single administrator cannot decide a payout: the reject is a proposal until a second admin approves it.
    const alone = await request(app).post(`/api/admin/withdrawals/${w.body.transaction.id}/reject`).set(admin.auth).send({ reason: 'bad account' });
    expect(alone.status).toBe(200);
    expect(alone.body.transaction.status).toBe('pending');
    const wait = await request(app).get('/api/wallets').set(a.auth);
    expect(wait.body.items[0].balance).toBe(10000 - 4000 - 140);
    const self = await request(app).post(`/api/admin/verifications/${alone.body.verification.id}/approve`).set(admin.auth).send({ pin: admin.pin });
    expect(self.status).toBe(403);
    const checker = await (await import('./helpers')).checkerToken(app);
    const rej = await request(app).post(`/api/admin/verifications/${alone.body.verification.id}/approve`).set(checker.auth).send({ pin: checker.pin });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    const rejTx = await request(app).get(`/api/wallets/transactions/${w.body.transaction.id}`).set(a.auth);
    expect(rejTx.body.transaction.status).toBe('rejected');
    wallets = await request(app).get('/api/wallets').set(a.auth);
    expect(wallets.body.items[0].balance).toBe(10000);
    const w2 = await request(app).post('/api/withdrawals').set(a.auth).send({ amount: '10.00', currency: 'USD', bankAccountId: bank.body.bankAccount.id, pin: '1234' });
    const ok = await decideWithdrawal(app, w2.body.transaction.id, 'approve', 'BANK-1');
    const okTx = await request(app).get(`/api/wallets/transactions/${w2.body.transaction.id}`).set(a.auth);
    expect(okTx.body.transaction.status).toBe('completed');
    expect(okTx.body.transaction.metadata.payoutReference).toBeTruthy();
    void ok;
  });

  it('agent cash-in and cash-out with commission', async () => {
    const agent = await registerUser(app, { role: 'agent', tag: 'agent7', businessName: 'Agent 7' });
    const customer = await registerUser(app, { tag: 'cust7' });
    await fund(app, agent.user.id, '500.00');
    const cashIn = await request(app).post('/api/agents/me/cash-in').set(agent.auth).send({ customer: 'cust7', amount: '100.00', currency: 'USD', pin: '1234' });
    expect(cashIn.status).toBe(201);
    let cw = await request(app).get('/api/wallets').set(customer.auth);
    expect(cw.body.items[0].balance).toBe(10000 - 100); // 1% fee deducted
    const aw = await request(app).get('/api/wallets').set(agent.auth);
    expect(aw.body.items[0].balance).toBe(50000 - 10000 + 50); // float out, 0.5% commission earned
    const req = await request(app).post('/api/agents/cash-out').set(customer.auth).send({ agent: 'agent7', amount: '50.00', currency: 'USD', pin: '1234' });
    expect(req.status).toBe(201);
    const confirm = await request(app).post('/api/agents/me/cash-out/confirm').set(agent.auth).send({ code: req.body.request.code, pin: '1234' });
    expect(confirm.status).toBe(201);
    cw = await request(app).get('/api/wallets').set(customer.auth);
    expect(cw.body.items[0].balance).toBe(9900 - 5000 - 75);
    const stats = await request(app).get('/api/agents/me/stats').set(agent.auth);
    expect(stats.body.cashInCount).toBe(1);
    expect(stats.body.cashOutCount).toBe(1);
  });

  it('sends remittances to wallet instantly and via cash pickup through an agent', async () => {
    const sender = await registerUser(app);
    const recipient = await registerUser(app, { tag: 'family1' });
    const agent = await registerUser(app, { role: 'agent', tag: 'pickupagent' });
    await fund(app, sender.user.id, '400.00');
    const quote = await request(app).get('/api/remittances/quote?from=USD&to=NGN&amount=100').set(sender.auth);
    expect(quote.body.targetCurrency).toBe('NGN');
    expect(quote.body.targetAmount).toBeGreaterThan(0);
    const r1 = await request(app)
      .post('/api/remittances')
      .set(sender.auth)
      .send({ amount: '100', sourceCurrency: 'USD', targetCurrency: 'NGN', payoutMethod: 'wallet', recipient: { name: 'Family', tag: 'family1' }, pin: '1234', saveRecipient: true });
    expect(r1.status).toBe(201);
    expect(r1.body.remittance.status).toBe('completed');
    const rw = await request(app).get('/api/wallets').set(recipient.auth);
    expect(rw.body.items.find((w: any) => w.currency === 'NGN').balance).toBe(quote.body.targetAmount);
    const saved = await request(app).get('/api/recipients').set(sender.auth);
    expect(saved.body.items).toHaveLength(1);
    const r2 = await request(app)
      .post('/api/remittances')
      .set(sender.auth)
      .send({ amount: '50', sourceCurrency: 'USD', targetCurrency: 'USD', payoutMethod: 'cash_pickup', recipient: { name: 'Cousin', idNumber: 'ID-1' }, pin: '1234' });
    expect(r2.body.remittance.status).toBe('ready_for_pickup');
    const pickup = await request(app).post(`/api/agents/me/pickups/${r2.body.remittance.pickupCode}/payout`).set(agent.auth).send({ recipientIdNumber: 'ID-1', pin: '1234' });
    expect(pickup.status).toBe(200);
    expect(pickup.body.remittance.status).toBe('completed');
    const aw = await request(app).get('/api/wallets').set(agent.auth);
    expect(aw.body.items[0].balance).toBe(5000);
  });
});

describe('services & referrals', () => {
  it('pays bills, tops up phones and buys gift cards', async () => {
    const a = await registerUser(app);
    await fund(app, a.user.id, '300.00');
    const billers = await request(app).get('/api/bills/billers').set(a.auth);
    const usd = billers.body.items.find((b: any) => b.currency === 'USD');
    const bill = await request(app).post('/api/bills').set(a.auth).send({ billerId: usd.id, accountNumber: 'ACC-1', amount: '20.00', pin: '1234' });
    expect(bill.status).toBe(201);
    expect(bill.body.receiptNo).toMatch(/^BILL-/);
    const ops = await request(app).get('/api/topups/operators').set(a.auth);
    const op = ops.body.items.find((o: any) => o.currency === 'USD');
    const top = await request(app).post('/api/topups').set(a.auth).send({ operatorId: op.id, phone: '+15550001111', amount: '10.00', pin: '1234' });
    expect(top.status).toBe(201);
    const products = await request(app).get('/api/gift-cards/products').set(a.auth);
    const p = products.body.items.find((x: any) => x.currency === 'USD');
    const gift = await request(app)
      .post('/api/gift-cards')
      .set(a.auth)
      .send({ productId: p.id, amount: String(p.denominations[0] / 100), pin: '1234' });
    expect(gift.status).toBe(201);
    expect(gift.body.code).toMatch(/^[A-Z0-9]{4}-/);
    const mine = await request(app).get('/api/gift-cards').set(a.auth);
    expect(mine.body.items).toHaveLength(1);
  });

  it('pays multi-level referral rewards on first deposit', async () => {
    const l2 = await registerUser(app);
    const l1 = await registerUser(app, { referralCode: l2.user.referralCode });
    const newbie = await registerUser(app, { referralCode: l1.user.referralCode });
    await request(app)
      .post('/api/deposits')
      .set(newbie.auth)
      .send({ pin: '1234', method: 'card', amount: '50.00', currency: 'USD', card: { number: '4242424242424242', expMonth: 12, expYear: 2030, cvc: '123', holderName: 'New User' } });
    const w1 = await request(app).get('/api/wallets').set(l1.auth);
    const w2 = await request(app).get('/api/wallets').set(l2.auth);
    // Referral rewards are promotional credit – a marketing liability – never redeemable e-money.
    expect(w1.body.items[0].balance).toBe(0);
    expect(w1.body.items[0].promoBalance).toBe(500);
    expect(w2.body.items[0].promoBalance).toBe(200);
    expect(w1.body.promoCredits[0].programme).toBe('referral_rewards');
    expect(w1.body.items[0].classification.class).toBe('sandbox');
    // Promotional credit cannot be withdrawn or sent, but it covers platform fees on internal transfers.
    const send = await request(app).post('/api/transfers').set(l1.auth).send({ pin: '1234', to: newbie.user.tag, amount: '1.00', currency: 'USD' });
    expect(send.status).toBe(422);
    expect(send.body.error.code).toBe('insufficient_funds');
    await fund(app, l1.user.id, '100.00', 'USD');
    const t = await request(app)
      .post('/api/transfers')
      .set(l1.auth)
      .send({ pin: '1234', to: `@${newbie.user.tag}`, amount: '50.00', currency: 'USD' });
    expect(t.status).toBe(201);
    expect(t.body.transaction.fee).toBeGreaterThan(0);
    const after = await request(app).get('/api/wallets').set(l1.auth);
    expect(after.body.items[0].balance).toBe(10_000 - 5_000);
    expect(after.body.items[0].promoBalance).toBe(500 - t.body.transaction.fee);
    const stats = await request(app).get('/api/account/referrals').set(l1.auth);
    expect(stats.body.referredCount).toBe(1);
    expect(stats.body.totalEarned).toBe(500);
  });
});

describe('P2P trading', () => {
  it('completes a wallet-settled trade and escrows an external one', async () => {
    const seller = await registerUser(app);
    const buyer = await registerUser(app);
    await fund(app, seller.user.id, '200.00', 'USD');
    await fund(app, buyer.user.id, '500.00', 'EUR');
    const ad = await request(app)
      .post('/api/p2p/ads')
      .set(seller.auth)
      .send({ side: 'sell', currency: 'USD', priceCurrency: 'EUR', rate: 0.9, minAmount: '10', maxAmount: '100', availableAmount: '150', paymentMethods: ['wallet', 'bank_transfer'] });
    expect(ad.status).toBe(201);
    const trade = await request(app).post('/api/p2p/trades').set(buyer.auth).send({ adId: ad.body.ad.id, amount: '50', paymentMethod: 'wallet' });
    expect(trade.status).toBe(201);
    expect(trade.body.trade.priceAmount).toBe(4500);
    const counter = await request(app).post(`/api/p2p/trades/${trade.body.trade.id}/counter`).set(seller.auth).send({ amount: '50', rate: 0.92 });
    expect(counter.body.trade.priceAmount).toBe(4600);
    const accept = await request(app).post(`/api/p2p/trades/${trade.body.trade.id}/accept`).set(buyer.auth).send({ pin: '1234' });
    expect(accept.status).toBe(200);
    expect(accept.body.trade.status).toBe('completed');
    const bw = await request(app).get('/api/wallets').set(buyer.auth);
    expect(bw.body.items.find((w: any) => w.currency === 'USD').balance).toBe(5000);
    expect(bw.body.items.find((w: any) => w.currency === 'EUR').balance).toBe(50000 - 4600);

    const t2 = await request(app).post('/api/p2p/trades').set(buyer.auth).send({ adId: ad.body.ad.id, amount: '20', paymentMethod: 'bank_transfer' });
    const acc2 = await request(app).post(`/api/p2p/trades/${t2.body.trade.id}/accept`).set(seller.auth).send({ pin: '1234' });
    expect(acc2.body.trade.status).toBe('escrowed');
    await request(app).post(`/api/p2p/trades/${t2.body.trade.id}/paid`).set(buyer.auth);
    const disputed = await request(app).post(`/api/p2p/trades/${t2.body.trade.id}/dispute`).set(seller.auth).send({ reason: 'No payment received' });
    expect(disputed.body.trade.status).toBe('disputed');
    const admin = await adminToken(app);
    const resolved = await request(app).post(`/api/admin/p2p/trades/${t2.body.trade.id}/resolve`).set(admin.auth).send({ outcome: 'refund' });
    expect(resolved.body.trade.status).toBe('refunded');
    const sw = await request(app).get('/api/wallets').set(seller.auth);
    expect(sw.body.items.find((w: any) => w.currency === 'USD').balance).toBe(20000 - 5000 - 25); // 0.5% p2p fee on completed trade only
  });
});

describe('admin', () => {
  it('reports stats, manages settings, currencies, gateways, KYC and audit logs', async () => {
    const admin = await adminToken(app);
    const stats = await request(app).get('/api/admin/stats').set(admin.auth);
    expect(stats.status).toBe(200);
    expect(stats.body.users.user).toBeGreaterThan(0);
    const fees = await request(app)
      .put('/api/admin/settings/fees')
      .set(admin.auth)
      .send({ value: { ...stats.body.fees, transfer: { fixed: 0, bps: 100 } } });
    expect(fees.status).toBe(200);
    const cur = await request(app).put('/api/admin/currencies/XAF').set(admin.auth).send({ name: 'CFA Franc', symbol: 'FCFA', decimals: 0, rateToBase: 600, enabled: true });
    expect(cur.body.currency.enabled).toBe(true);
    const gw = await request(app)
      .put('/api/admin/gateways/stripe')
      .set(admin.auth)
      .send({ name: 'Stripe', provider: 'stripe', enabled: true, methods: ['card'], currencies: [], credentials: { secretKey: 'sk_test_x', publishableKey: 'pk_test_x' } });
    expect(gw.body.gateway.configuredKeys).toContain('secretKey');
    const u = await registerUser(app);
    const kyc = await request(app).post('/api/kyc').set(u.auth).send({ docType: 'passport', docNumber: 'P123', fullName: 'Test', selfie: 'data:image/png;base64,AAAA' });
    expect(kyc.status).toBe(201);
    const pending = await request(app).get('/api/admin/kyc?status=pending').set(admin.auth);
    expect(pending.body.items.length).toBeGreaterThan(0);
    const review = await request(app).post(`/api/admin/kyc/${kyc.body.submission.id}/review`).set(admin.auth).send({ decision: 'verified' });
    expect(review.body.submission.status).toBe('verified');
    const me = await request(app).get('/api/auth/me').set(u.auth);
    expect(me.body.user.kycStatus).toBe('verified');
    const logs = await request(app).get('/api/admin/audit-logs').set(admin.auth);
    expect(logs.body.items.length).toBeGreaterThan(2);
    const forbidden = await request(app).get('/api/admin/stats').set(u.auth);
    expect(forbidden.status).toBe(403);
    const staff = await request(app)
      .post('/api/admin/users')
      .set(admin.auth)
      .send({ fullName: 'Staff', email: 'staff@test.local', password: 'Password123!', role: 'admin', permissions: ['support'] });
    const staffLogin = await request(app).post('/api/auth/login').send({ identifier: 'staff@test.local', password: 'Password123!' });
    const noPerm = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${staffLogin.body.token}`);
    expect(noPerm.status).toBe(403);
    const okPerm = await request(app).get('/api/admin/support/tickets').set('Authorization', `Bearer ${staffLogin.body.token}`);
    expect(okPerm.status).toBe(200);
    expect(staff.status).toBe(201);
  });

  it('support tickets and live chat round-trip', async () => {
    const u = await registerUser(app);
    const admin = await adminToken(app);
    const t = await request(app).post('/api/support/tickets').set(u.auth).send({ subject: 'Help', body: 'Something broke' });
    expect(t.status).toBe(201);
    const reply = await request(app).post(`/api/admin/support/tickets/${t.body.ticket.id}/reply`).set(admin.auth).send({ body: 'On it' });
    expect(reply.body.ticket.status).toBe('answered');
    expect(reply.body.ticket.messages).toHaveLength(2);
    await request(app).post('/api/support/chat').set(u.auth).send({ body: 'hello?' });
    const convos = await request(app).get('/api/admin/support/chats').set(admin.auth);
    expect(convos.body.items[0].unread).toBe(1);
    await request(app).post(`/api/admin/support/chats/${u.user.id}`).set(admin.auth).send({ body: 'hi there' });
    const history = await request(app).get('/api/support/chat').set(u.auth);
    expect(history.body.items).toHaveLength(2);
  });
});
