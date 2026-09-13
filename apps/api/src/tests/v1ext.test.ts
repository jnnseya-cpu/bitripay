/**
 * Gateway API v1 account endpoints (contract §14): wallets with available balance, transfer quotes ranked by the
 * smart router, idempotent wallet transfers, remittances, bulk payout batches (CSV validation, four-eyes / step-up
 * approval, in-order execution with per-row outcomes) and ACU-metered agent calls that never disclose a provider.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, adminToken, fund } from './helpers';
import { parseCsv } from '../services/bulkPayouts';
import { reconcileLedger } from '../services/ledger';
import { getDb } from '../db';

let app: ReturnType<typeof setupApp>;
beforeAll(() => { app = setupApp(); getDb().prepare("UPDATE currencies SET enabled = 1 WHERE code IN ('CDF', 'KES', 'GBP')").run(); });
const balanceOf = async (auth: Record<string, string>, currency = 'USD') => ((await request(app).get('/api/wallets').set(auth)).body.items.find((w: any) => w.currency === currency)?.balance ?? 0) as number;

describe('gateway v1 account endpoints', () => {
  it('parses CSV with quotes, CRLF and blank lines', () => {
    const rows = parseCsv('method,amount,wallet,name\r\nwallet,"25.00",@amina,"Kalala, Amina"\r\n\r\nwallet,40,@jean,"He said ""hi"""\n');
    expect(rows).toEqual([{ method: 'wallet', amount: '25.00', wallet: '@amina', name: 'Kalala, Amina' }, { method: 'wallet', amount: '40', wallet: '@jean', name: 'He said "hi"' }]);
  });

  it('reads wallets, quotes and ranks routes, and sends idempotent transfers with an API key', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Kinshasa Wholesale', country: 'CD' });
    const a = await registerUser(app);
    await fund(app, m.user.id, '300.00');
    const key = await request(app).post('/api/v1/api_keys').set(m.auth).send({ label: 'erp', mode: 'test', kind: 'restricted', scopes: ['wallets:read', 'transfers:write', 'payouts:write', 'payouts:read', 'ai:run', 'remittances:write'] });
    expect(key.status, JSON.stringify(key.body)).toBe(201);
    const k = { Authorization: `Bearer ${key.body.secret}` };
    const wallets = await request(app).get('/api/v1/wallets').set(k);
    expect(wallets.status).toBe(200);
    expect(wallets.body.data.find((w: any) => w.currency === 'USD')).toMatchObject({ balance_minor: 30000, available_minor: 30000, held_minor: 0 });
    // a key without the scope is refused
    const ro = await request(app).post('/api/v1/api_keys').set(m.auth).send({ label: 'ro', mode: 'test', kind: 'restricted', scopes: ['payment_intents:read'] });
    expect((await request(app).get('/api/v1/wallets').set({ Authorization: `Bearer ${ro.body.secret}` })).status).toBe(403);
    // quote: wallet destination has no external rails; a mobile money destination lists the ranked rails
    const q1 = await request(app).post('/api/v1/transfers/quote').set(k).send({ amount_minor: 2500, currency: 'USD', destination: { method: 'wallet', to: a.user.tag } });
    expect(q1.status, JSON.stringify(q1.body)).toBe(200);
    expect(q1.body.quote.recipientAmount).toBeGreaterThan(0);
    expect(q1.body.quote.recipientAmount).toBeLessThanOrEqual(2500);
    expect(q1.body.quote.guaranteedRecipientAmount).toBe(q1.body.quote.recipientAmount);
    expect(q1.body.quote.platformFee).toBe(2500 - q1.body.quote.recipientAmount); // every deduction disclosed
    expect(q1.body.routes).toEqual([]);
    const q2 = await request(app).post('/api/v1/transfers/quote').set(k).send({ amount_minor: 2500, currency: 'USD', target_currency: 'KES', destination: { method: 'mobile_money', operator_id: 'mpesa_ke', phone: '+254712345678' }, policy: 'cheapest' });
    expect(q2.status, JSON.stringify(q2.body)).toBe(200);
    expect(q2.body.policy).toBe('cheapest');
    expect(q2.body.quote.fxMarginBps).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(q2.body.routes)).toBe(true);
    for (let i = 1; i < q2.body.routes.length; i += 1) expect(q2.body.routes[i - 1].usable >= q2.body.routes[i].usable || q2.body.routes[i - 1].score >= q2.body.routes[i].score).toBe(true);
    // transfer, replayed with the same Idempotency-Key: one movement
    const t1 = await request(app).post('/api/v1/transfers').set({ ...k, 'Idempotency-Key': 'sal-001' }).send({ to: a.user.tag, amount_minor: 2500, currency: 'USD', note: 'Salary' });
    expect(t1.status, JSON.stringify(t1.body)).toBe(201);
    const t2 = await request(app).post('/api/v1/transfers').set({ ...k, 'Idempotency-Key': 'sal-001' }).send({ to: a.user.tag, amount_minor: 2500, currency: 'USD', note: 'Salary' });
    expect(t2.body.transfer.id).toBe(t1.body.transfer.id);
    expect(await balanceOf(a.auth)).toBe(2500);
    expect((await request(app).get(`/api/v1/transfers/${t1.body.transfer.id}`).set(k)).body.transfer.id).toBe(t1.body.transfer.id);
    // remittance to a wallet through the key
    const b = await registerUser(app);
    const r = await request(app).post('/api/v1/remittances').set({ ...k, 'Idempotency-Key': 'rem-1' }).send({ amount_minor: 1000, currency: 'USD', target_currency: 'USD', payout_method: 'wallet', recipient: { name: 'Family', tag: b.user.tag } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.remittance.status).toBe('completed');
    const rAgain = await request(app).post('/api/v1/remittances').set({ ...k, 'Idempotency-Key': 'rem-1' }).send({ amount_minor: 1000, currency: 'USD', target_currency: 'USD', payout_method: 'wallet', recipient: { name: 'Family', tag: b.user.tag } });
    expect(rAgain.status).toBe(200);
    expect(await balanceOf(b.auth)).toBe(1000);
    // an agent run through the key: metered, sanitised (no provider, model, tokens or cost)
    const ai = await request(app).post('/api/v1/ai/SavingsAdvisor').set(k).send({ input: 'How much did I pay out today?' });
    expect(ai.status, JSON.stringify(ai.body)).toBe(200);
    expect(ai.body.agent.key).toBe('analyst');
    for (const f of ['provider', 'model', 'tokensIn', 'tokensOut', 'acu']) expect(ai.body.run[f]).toBeUndefined();
    expect(['completed', 'failed', 'needs_approval', 'cancelled']).toContain(ai.body.run.status);
    expect((await request(app).post('/api/v1/ai/NoSuchAgent').set(k).send({ input: 'x' })).status).toBe(404);
    const run = await request(app).get(`/api/v1/ai/runs/${ai.body.run.id}`).set(k);
    expect(run.body.run.id).toBe(ai.body.run.id);
    expect(run.body.run.model).toBeUndefined();
  });

  it('validates a bulk payout batch row by row, enforces four-eyes or step-up on approval, executes in order and reports per-row outcomes', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Coopérative Lumière', country: 'CD' });
    const amina = await registerUser(app);
    const jean = await registerUser(app);
    await fund(app, m.user.id, '200.00');
    const key = await request(app).post('/api/v1/api_keys').set(m.auth).send({ label: 'payroll', mode: 'test', kind: 'restricted', scopes: ['payouts:write', 'payouts:read', 'payouts:approve'] });
    const k = { Authorization: `Bearer ${key.body.secret}` };
    const csv = ['method,amount,wallet,operator_id,phone,name,reference', `wallet,25.00,${amina.user.tag},,,Amina,SAL-1`, `wallet,40.00,${jean.user.tag},,,Jean,SAL-2`, 'wallet,10.00,@nobody-here,,,Ghost,SAL-3', `wallet,abc,${amina.user.tag},,,Amina,SAL-4`, 'mobile_money,30.00,,mpesa_ke,+254712345678,Wanjiru,SAL-5'].join('\n');
    const created = await request(app).post('/api/v1/payouts/batches').set({ ...k, 'Idempotency-Key': 'payroll-sept' }).send({ currency: 'USD', csv, reference: 'PAYROLL-09' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const batch = created.body.batch;
    expect(batch.status).toBe('PENDING_APPROVAL');
    expect([batch.rowCount, batch.validRows, batch.invalidRows]).toEqual([5, 3, 2]);
    expect(batch.totalMinor).toBe(2500 + 4000 + 3000);
    expect(batch.rows.find((r: any) => r.reference === 'SAL-3').error).toMatch(/no BitriPay account/);
    expect(batch.rows.find((r: any) => r.reference === 'SAL-4').error).toMatch(/not a number/);
    expect(created.body.readiness.blockedByInvalidRows).toBe(true);
    // same Idempotency-Key: the same batch, not a second one
    const replay = await request(app).post('/api/v1/payouts/batches').set({ ...k, 'Idempotency-Key': 'payroll-sept' }).send({ currency: 'USD', csv, reference: 'PAYROLL-09' });
    expect([200, 201]).toContain(replay.status); // the idempotency layer replays the stored response
    expect(replay.body.batch.id).toBe(batch.id);
    // the same key with a different body is refused
    expect((await request(app).post('/api/v1/payouts/batches').set({ ...k, 'Idempotency-Key': 'payroll-sept' }).send({ currency: 'USD', csv })).body.error.code).toBe('idempotency_key_reused');
    // invalid rows block approval unless the batch skips them
    expect((await request(app).post(`/api/v1/payouts/batches/${batch.id}/approve`).set(m.auth).send({ pin: '1234' })).body.error.code).toBe('batch_has_invalid_rows');
    await request(app).post(`/api/v1/payouts/batches/${batch.id}/cancel`).set(k);
    expect((await request(app).get(`/api/v1/payouts/batches/${batch.id}`).set(k)).body.batch.status).toBe('CANCELLED');
    const second = await request(app).post('/api/v1/payouts/batches').set(k).send({ currency: 'USD', csv, reference: 'PAYROLL-09', skip_invalid: true });
    const id = second.body.batch.id;
    // an API key cannot approve alone; the creator needs a PIN; a wrong PIN is refused
    expect((await request(app).post(`/api/v1/payouts/batches/${id}/approve`).set(k).send({})).body.error.code).toBe('step_up_required');
    expect((await request(app).post(`/api/v1/payouts/batches/${id}/approve`).set(m.auth).send({})).body.error.code).toBe('step_up_required');
    expect((await request(app).post(`/api/v1/payouts/batches/${id}/approve`).set(m.auth).send({ pin: '0000' })).body.error.code).toBe('invalid_pin');
    // a batch bigger than the available balance is refused before anything moves
    const big = await request(app).post('/api/v1/payouts/batches').set(k).send({ currency: 'USD', rows: [{ amount_minor: 50_000, destination: { method: 'wallet', to: amina.user.tag } }] });
    const bigApprove = await request(app).post(`/api/v1/payouts/batches/${big.body.batch.id}/approve`).set(m.auth).send({ pin: '1234' });
    expect(bigApprove.body.error.code).toBe('insufficient_funds');
    expect(await balanceOf(amina.auth)).toBe(0);
    // approved with the PIN: rows run in order, the mobile money row becomes a pending payout, invalid rows are skipped
    const approved = await request(app).post(`/api/v1/payouts/batches/${id}/approve`).set(m.auth).send({ pin: '1234' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.batch.status).toBe('EXECUTED');
    expect([approved.body.batch.paidRows, approved.body.batch.failedRows, approved.body.batch.paidMinor]).toEqual([3, 0, 9500]);
    expect(approved.body.batch.approvalMethod).toBe('step_up');
    const rows = approved.body.batch.rows;
    expect(rows.map((r: any) => r.status)).toEqual(['PAID', 'PAID', 'SKIPPED', 'SKIPPED', 'PAID']);
    expect(rows.filter((r: any) => r.status === 'PAID').every((r: any) => r.transactionId)).toBe(true);
    expect(await balanceOf(amina.auth)).toBe(2500);
    expect(await balanceOf(jean.auth)).toBe(4000);
    const momo = await request(app).get(`/api/v1/payouts/${rows[4].transactionId}`).set(k);
    expect(momo.status).toBe(200);
    expect(momo.body.status).toBe('pending');
    // re-approving an executed batch is refused; the list shows it
    expect((await request(app).post(`/api/v1/payouts/batches/${id}/approve`).set(m.auth).send({ pin: '1234' })).body.error.code).toBe('batch_not_pending');
    expect((await request(app).get('/api/v1/payouts/batches?status=EXECUTED').set(k)).body.data.map((b: any) => b.id)).toContain(id);
    // an administrator approving someone else's batch is four-eyes: no step-up needed
    const admin = await adminToken(app);
    const third = await request(app).post('/api/v1/payouts/batches').set(k).send({ currency: 'USD', rows: [{ amount_minor: 500, destination: { method: 'wallet', to: jean.user.tag }, reference: 'BONUS' }] });
    expect(third.status).toBe(201);
    const adminView = await request(app).get('/api/admin/finops/payout-batches').set(admin.auth);
    expect(adminView.status).toBe(200);
    expect(adminView.body.items.some((b: any) => b.id === third.body.batch.id)).toBe(true);
    const fourEyes = await request(app).post(`/api/admin/finops/payout-batches/${third.body.batch.id}/approve`).set(admin.auth).send({});
    expect(fourEyes.status, JSON.stringify(fourEyes.body)).toBe(200);
    expect(fourEyes.body.batch.approvalMethod).toBe('four_eyes');
    expect(await balanceOf(jean.auth)).toBe(4500);
    const events = await request(app).get('/api/v1/events?type=payout_batch.executed').set(m.auth);
    expect(events.body.data.length).toBeGreaterThanOrEqual(2);
    expect(reconcileLedger().ok).toBe(true);
  });
});

describe('cross-border routes on the partner API', () => {
  it('quotes and creates any → any routes in the recipient currency, funds remittances from any card, and follows every stage', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Diaspora Payroll Ltd', country: 'GB' });
    getDb().prepare("UPDATE users SET kyc_status = 'verified' WHERE id = ?").run(m.user.id);
    await fund(app, m.user.id, '500.00');
    const key = await request(app).post('/api/v1/api_keys').set(m.auth).send({ label: 'payroll-routes', mode: 'test', kind: 'restricted', scopes: ['routes:read', 'routes:write', 'remittances:write'] });
    const k = { Authorization: `Bearer ${key.body.secret}` };
    // recipient currencies for a mobile money destination, then a quote with the disclosed rate and fees
    const currencies = await request(app).post('/api/v1/routes/payout-currencies').set(k).send({ amount_minor: 5000, currency: 'USD', destination: { method: 'mobile_money', operator_id: 'mpesa_ke', phone: '+254712345678', name: 'Wanjiru' } });
    expect(currencies.status, JSON.stringify(currencies.body)).toBe(200);
    expect(currencies.body.options.some((o: any) => o.currency === 'KES')).toBe(true);
    const q = await request(app).post('/api/v1/routes/quote').set(k).send({ amount_minor: 5000, currency: 'USD', target_currency: 'KES', source: { method: 'card' }, destination: { method: 'mobile_money', operator_id: 'mpesa_ke', phone: '+254712345678', name: 'Wanjiru' } });
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    expect(q.body.quote.currency).toBe('USD');
    expect(q.body.quote.recipientAmount).toBeGreaterThan(0);
    expect(q.body.quote.cardFee).toBeGreaterThan(0);
    expect(q.body.quote.fxMarginBps).toBeGreaterThanOrEqual(0);
    expect(q.body.destination).toBeTruthy();
    // wallet → mobile money in KES through the key (the key is the account's own server: no PIN), replayed idempotently
    const r1 = await request(app).post('/api/v1/routes').set({ ...k, 'Idempotency-Key': 'pay-wanjiru-1' }).send({ amount_minor: 5000, currency: 'USD', target_currency: 'KES', destination: { method: 'mobile_money', operator_id: 'mpesa_ke', phone: '+254712345678', name: 'Wanjiru' }, note: 'September salary' });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r1.body.route.source).toBe('wallet');
    expect(r1.body.route.destination).toBe('mobile_money');
    expect(r1.body.route.targetCurrency).toBe('KES');
    expect(['PAYOUT_ROUTED', 'INSUFFICIENT_LIQUIDITY', 'MANUAL_REVIEW', 'AWAITING_CONFIRMATION']).toContain(r1.body.route.stage);
    const replay = await request(app).post('/api/v1/routes').set({ ...k, 'Idempotency-Key': 'pay-wanjiru-1' }).send({ amount_minor: 5000, currency: 'USD', target_currency: 'KES', destination: { method: 'mobile_money', operator_id: 'mpesa_ke', phone: '+254712345678', name: 'Wanjiru' }, note: 'September salary' });
    expect([200, 201]).toContain(replay.status);
    expect(replay.body.route.id).toBe(r1.body.route.id);
    const after = await balanceOf(m.auth);
    expect(after).toBeLessThanOrEqual(50000 - 5000); // the 50.00 left the wallet once, fees disclosed on the quote
    expect(after).toBeGreaterThan(50000 - 5000 - 500);
    expect((await request(app).get('/api/v1/routes').set(k)).body.data.map((r: any) => r.id)).toContain(r1.body.route.id);
    expect((await request(app).get(`/api/v1/routes/${r1.body.route.id}`).set(k)).body.route.stageLabel).toBeTruthy();
    // card-funded remittance from any card to mobile money in CDF: the funding leg runs through the sandbox processor
    const card = { number: '4242424242424242', exp_month: 12, exp_year: 2030, cvc: '123', holder_name: 'Sam Sender' };
    const rem = await request(app).post('/api/v1/remittances').set(k).send({ amount_minor: 2000, currency: 'USD', target_currency: 'CDF', payout_method: 'mobile_money', recipient: { name: 'Marie Kabila', phone: '+243990000123', country: 'CD', operator_id: 'orange_cd' }, source: { method: 'card', card } });
    expect(rem.status, JSON.stringify(rem.body)).toBe(201);
    expect(rem.body.route.source).toBe('card');
    expect(rem.body.route.targetCurrency).toBe('CDF');
    expect(rem.body.route.paymentId).toBeTruthy();
    expect(['FUNDED', 'PAYOUT_ROUTED', 'INSUFFICIENT_LIQUIDITY', 'MANUAL_REVIEW', 'FUNDING_PENDING', 'AWAITING_CONFIRMATION']).toContain(rem.body.route.stage);
    // a declined card fails the funding leg cleanly: nothing paid out
    const declined = await request(app).post('/api/v1/routes').set(k).send({ amount_minor: 2000, currency: 'USD', target_currency: 'CDF', source: { method: 'card', card: { ...card, number: '4000000000000002' } }, destination: { method: 'mobile_money', operator_id: 'orange_cd', phone: '+243990000123', name: 'Marie Kabila' } });
    expect(declined.status, JSON.stringify(declined.body)).toBe(201);
    expect(declined.body.route.stage).toBe('FAILED');
    expect(declined.body.route.error).toMatch(/declined/i);
    // a key without the scope is refused
    const ro = await request(app).post('/api/v1/api_keys').set(m.auth).send({ label: 'ro', mode: 'test', kind: 'restricted', scopes: ['payment_intents:read'] });
    expect((await request(app).post('/api/v1/routes/quote').set({ Authorization: `Bearer ${ro.body.secret}` }).send({ amount_minor: 100, currency: 'USD', destination: { method: 'keep' } })).status).toBe(403);
    expect(reconcileLedger().ok).toBe(true);
  }, 30_000);
});
