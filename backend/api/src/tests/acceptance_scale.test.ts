/**
 * Scale and safety acceptance items from the build contract: ten thousand concurrent postings that leave the ledger
 * zero-sum, no endpoint that lets a client write a balance or a payment state directly, and an end-to-end payment
 * that needs zero ACU (the agents can be switched off entirely without touching money movement).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, fund, adminToken } from './helpers';
import { postTransaction, reconcileLedger, calculateFee } from '../services/ledger';
import { getUserWallet } from '../services/wallets';
import { getDb } from '../db';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

describe('scale', () => {
  it('posts 10 000 concurrent transfers and stays zero-sum with every wallet equal to its derived balance', async () => {
    const users = [] as Awaited<ReturnType<typeof registerUser>>[];
    for (let i = 0; i < 8; i += 1) users.push(await registerUser(app));
    for (const u of users) await fund(app, u.user.id, '10000.00', 'USD');
    const wallets = users.map((u) => getUserWallet(u.user.id, 'USD'));
    const before = wallets.reduce((s, w) => s + w.balance, 0);
    let seed = 20260913;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const started = Date.now();
    // ten thousand postings fired without awaiting each other: the ledger serialises them in one SQLite connection
    const outcomes = await Promise.all(
      Array.from({ length: 10_000 }, (_, i) =>
        Promise.resolve().then(() => {
          const a = Math.floor(rand() * users.length);
          const b = (a + 1 + Math.floor(rand() * (users.length - 1))) % users.length;
          const amount = 1 + Math.floor(rand() * 500);
          try {
            postTransaction({
              type: 'transfer',
              amount,
              fee: calculateFee('transfer', amount, 'USD'),
              currency: 'USD',
              fromWalletId: wallets[a].id,
              toWalletId: wallets[b].id,
              senderUserId: users[a].user.id,
              receiverUserId: users[b].user.id,
              note: `scale ${i}`,
            });
            return 'posted';
          } catch (err: any) {
            if (/insufficient/i.test(err.code ?? err.message)) return 'refused';
            throw err;
          }
        }),
      ),
    );
    const posted = outcomes.filter((o) => o === 'posted').length;
    expect(posted).toBeGreaterThan(9000);
    const elapsed = Date.now() - started;
    const recon = reconcileLedger();
    expect(recon.ok, JSON.stringify(recon).slice(0, 400)).toBe(true);
    expect(recon.unbalancedTransactions).toEqual([]);
    expect(recon.walletMismatches).toEqual([]);
    // money only moved between the eight wallets and the fee account: user total fell by exactly the fees collected
    const after = users.map((u) => getUserWallet(u.user.id, 'USD').balance).reduce((s, b) => s + b, 0);
    const fees = (getDb().prepare("SELECT COALESCE(SUM(fee), 0) f FROM transactions WHERE type = 'transfer' AND note LIKE 'scale %'").get() as any).f as number;
    expect(before - after).toBe(fees);
    expect(elapsed).toBeLessThan(120_000);
  }, 180_000);
});

describe('no client write', () => {
  it('refuses every attempt by a client to set a balance, a transaction state or an intent state directly', async () => {
    const u = await registerUser(app);
    const m = await registerUser(app, { role: 'merchant', businessName: 'No Write Ltd' });
    await fund(app, u.user.id, '10.00');
    const wallet = getUserWallet(u.user.id, 'USD');
    const tx = getDb().prepare('SELECT id FROM transactions WHERE receiver_wallet_id = ? ORDER BY created_at DESC LIMIT 1').get(wallet.id) as any;
    const intent = await request(app).post('/api/v1/payment_intents').set(m.auth).set('Idempotency-Key', 'ncw-1').send({ amount_minor: 500, currency: 'USD' });
    expect(intent.status, JSON.stringify(intent.body)).toBe(201);
    const attempts: [string, string, Record<string, string>, unknown][] = [
      ['PATCH', `/api/wallets/${wallet.id}`, u.auth, { balance: 1_000_000 }],
      ['PUT', `/api/wallets/${wallet.id}`, u.auth, { balance: 1_000_000 }],
      ['POST', `/api/wallets/${wallet.id}/balance`, u.auth, { balance: 1_000_000 }],
      ['PATCH', `/api/wallets/transactions/${tx?.id}`, u.auth, { status: 'completed', amount: 1 }],
      ['PATCH', `/api/v1/transactions/${tx?.id}`, m.auth, { status: 'completed' }],
      ['PATCH', `/api/v1/payment_intents/${intent.body.id}`, m.auth, { status: 'CAPTURED' }],
      ['PUT', `/api/v1/payment_intents/${intent.body.id}`, m.auth, { status: 'SETTLED' }],
      ['POST', `/api/v1/payment_intents/${intent.body.id}/status`, m.auth, { status: 'CAPTURED' }],
      ['POST', `/api/v1/payment_intents/${intent.body.id}/succeed`, m.auth, {}],
    ];
    for (const [method, path, auth, body] of attempts) {
      const res = await (request(app) as any)[method.toLowerCase()](path).set(auth).send(body);
      expect([404, 405, 400, 403, 422], `${method} ${path} → ${res.status}`).toContain(res.status);
    }
    expect(getUserWallet(u.user.id, 'USD').balance).toBe(1000);
    expect((await request(app).get(`/api/v1/payment_intents/${intent.body.id}`).set(m.auth)).body.status).not.toBe('CAPTURED');
    // the ledger is untouched and still balanced
    expect(reconcileLedger().ok).toBe(true);
  });
});

describe('zero-ACU end to end', () => {
  it('completes a wallet payment, a QR payment and a settlement read with the agent kill switch on and every allowance at zero', async () => {
    const admin = await adminToken(app);
    const kill = await request(app).post('/api/admin/agents/kill-switch').set(admin.auth).send({ on: true, pin: admin.pin });
    expect(kill.status, JSON.stringify(kill.body)).toBe(200);
    const capped = await request(app)
      .put('/api/admin/agents/settings')
      .set(admin.auth)
      .send({ allowances: { user: 0, merchant: 0, agent: 0, admin: 0 } });
    expect(capped.status, JSON.stringify(capped.body)).toBe(200);
    const payer = await registerUser(app);
    const m = await registerUser(app, { role: 'merchant', businessName: 'Zero ACU Café' });
    await fund(app, payer.user.id, '20.00');
    // wallet transfer
    const send = await request(app).post('/api/transfers').set(payer.auth).send({ to: m.user.tag, amount: '5.00', currency: 'USD', pin: '1234' });
    expect(send.status, JSON.stringify(send.body)).toBe(201);
    // QR payment request paid from the wallet
    const pr = await request(app).post('/api/payment-requests').set(m.auth).send({ kind: 'qr', amount: '3.00', currency: 'USD', description: 'Espresso' });
    expect(pr.status, JSON.stringify(pr.body)).toBe(201);
    const pay = await request(app).post(`/api/payment-requests/${pr.body.paymentRequest.code}/pay`).set(payer.auth).send({ pin: '1234' });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    // an agent run is refused (paused), money is not
    const run = await request(app).post('/api/assist/runs').set(m.auth).send({ agent: 'analyst', input: 'How did I do today?' });
    expect(run.body.error?.code, JSON.stringify(run.body)).toBe('assist_paused');
    expect((await request(app).get('/api/v1/balance').set(m.auth)).status).toBe(200);
    expect(reconcileLedger().ok).toBe(true);
    // restore
    await request(app).post('/api/admin/agents/kill-switch').set(admin.auth).send({ on: false, pin: admin.pin });
  });
});
