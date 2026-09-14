/**
 * Intelligence layer contract (specification §27, §58, §59, §61, §105, §106): the merchant acceptance score, the
 * payment graph and its compliance queries, float intelligence with trust-scaled agent limits, smart restricted
 * wallets enforced by a ledger posting policy, and the government QR infrastructure.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, adminToken, fund } from './helpers';
import { getDb } from '../db';
import { uuid, txReference } from '../lib/ids';
import { setSetting } from '../services/settings';
import { computeAcceptanceScore, snapshotAcceptanceScores, listAcceptanceSnapshots, ACCEPTANCE_WEIGHTS } from '../services/acceptanceScore';
import { ringCandidates, muleCandidates, duplicateIdentityCandidates, sharedDevices, neighbours, rebuildGraph, graphStats, personNodeId } from '../services/paymentGraph';
import { floatOutlook, agentLimitsFor, runFloatOutlookAlerts, normalCdf } from '../services/risk/agentIntel';
import { postTransaction, emoneySupply } from '../services/ledger';
import { getUserWallet } from '../services/wallets';
import { getIntentRow } from '../services/intents';
import { getReference, syncGovReferences } from '../services/government';
import { createLocation } from '../services/qrcodes';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

const transfer = (auth: Record<string, string>, to: string, amount: string, headers: Record<string, string> = {}) =>
  request(app).post('/api/transfers').set(auth).set(headers).send({ to, amount, currency: 'USD', pin: '1234' });

describe('§27 merchant acceptance score', () => {
  it('scores captured, failed and refunded sandbox intents with documented weights, deterministic recommendations and a daily snapshot', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Score Shop', country: 'CD' });
    const payer = await registerUser(app);
    await fund(app, payer.user.id, '100.00');
    await fund(app, m.user.id, '1.00'); // covers the platform fee kept on refund
    const key = (await request(app).post('/api/v1/api_keys').set(m.auth).send({ label: 'sim', mode: 'test' })).body.secret as string;
    const keyAuth = { Authorization: `Bearer ${key}` };
    // 1. sandbox: a failed attempt (invalid MSISDN) then a successful one on the same intent → captured
    const pi1 = (await request(app).post('/api/v1/payment_intents').set(keyAuth).send({ currency: 'USD', amount_minor: 1500, reference: 'ACC-1' })).body;
    expect((await request(app).post('/api/v1/sandbox/simulate').set(keyAuth).send({ payment_intent: pi1.id, outcome: 'fail' })).status).toBe(200);
    const ok = await request(app).post('/api/v1/sandbox/simulate').set(keyAuth).send({ payment_intent: pi1.id, outcome: 'succeed' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // 2. wallet-paid intent, fully refunded
    const pi2 = (await request(app).post('/api/v1/payment_intents').set(m.auth).send({ currency: 'USD', amount_minor: 2000 })).body;
    expect((await request(app).post(`/api/v1/payment_intents/${pi2.id}/pay/wallet`).set(payer.auth).send({ pin: '1234' })).status).toBe(201);
    const refund = await request(app).post('/api/v1/refunds').set(m.auth).send({ payment_intent: pi2.id, amount_minor: 2000, reason: 'order cancelled' });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    // 3. an intent the customer never paid, cancelled by the merchant → lost
    const pi3 = (await request(app).post('/api/v1/payment_intents').set(m.auth).send({ currency: 'USD', amount_minor: 900 })).body;
    expect((await request(app).post(`/api/v1/payment_intents/${pi3.id}/cancel`).set(m.auth).send({})).status).toBe(200);

    const res = await request(app).get('/api/insights/acceptance-score').set(m.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.score).toBeGreaterThanOrEqual(0);
    expect(res.body.score).toBeLessThanOrEqual(100);
    expect(Object.values(ACCEPTANCE_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    expect(res.body.weights).toEqual(ACCEPTANCE_WEIGHTS);
    const c = res.body.components;
    expect(c.checkoutConversion.sample).toBe(3);
    expect(c.checkoutConversion.ratio).toBeCloseTo(2 / 3, 3);
    expect(c.checkoutConversion.score).toBe(67);
    expect(c.qrConversion.sample).toBe(0); // no QR traffic: excluded from the weighted average
    expect(c.providerFailureExposure.sample).toBeGreaterThanOrEqual(3);
    expect(c.refundRate.sample).toBe(2);
    expect(c.refundRate.ratio).toBeCloseTo(2000 / 3500, 3);
    expect(c.refundRate.score).toBe(0); // 57 % of captured volume refunded: five points per percentage point
    expect(c.disputeRate.score).toBe(100);
    expect(c.customerReturnRate.sample).toBeGreaterThanOrEqual(1);
    // weighted average over the components that have data
    const active = Object.values(c as Record<string, { score: number; weight: number; sample: number }>).filter((x) => x.sample > 0);
    const expected = Math.round(active.reduce((a, x) => a + x.score * x.weight, 0) / active.reduce((a, x) => a + x.weight, 0));
    expect(res.body.score).toBe(expected);
    // recommendations: weakest first, deterministic text from the component ratio, at most three
    expect(res.body.recommendations.length).toBeGreaterThanOrEqual(2);
    expect(res.body.recommendations.length).toBeLessThanOrEqual(3);
    expect(res.body.recommendations[0].component).toBe('refundRate');
    expect(res.body.recommendations[0].action).toContain('57.1%');
    expect(res.body.recommendations.map((r: any) => r.component)).toContain('checkoutConversion');
    const again = computeAcceptanceScore(m.user.id, 30);
    expect(again.recommendations.map((r) => r.action)).toEqual(res.body.recommendations.map((r: any) => r.action));
    // daily snapshot
    const snap = snapshotAcceptanceScores();
    expect(snap.snapped).toBeGreaterThanOrEqual(1);
    expect(getDb().prepare('SELECT COUNT(*) c FROM merchant_acceptance_scores WHERE merchant_user_id = ?').get(m.user.id)).toEqual({ c: 1 });
    expect(listAcceptanceSnapshots(m.user.id)[0].score).toBe(res.body.score);
    expect((await request(app).get('/api/insights/acceptance-score').set(m.auth)).body.history).toHaveLength(1);
  });

  it('is readable with a restricted key holding payment_intents:read and refused without the scope or the merchant role', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Key Shop', country: 'CD' });
    const ro = (
      await request(app)
        .post('/api/v1/api_keys')
        .set(m.auth)
        .send({ label: 'ro', mode: 'test', kind: 'restricted', scopes: ['payment_intents:read'] })
    ).body.secret as string;
    const other = (
      await request(app)
        .post('/api/v1/api_keys')
        .set(m.auth)
        .send({ label: 'w', mode: 'test', kind: 'restricted', scopes: ['wallets:read'] })
    ).body.secret as string;
    const okRes = await request(app)
      .get('/api/insights/acceptance-score')
      .set({ Authorization: `Bearer ${ro}` });
    expect(okRes.status, JSON.stringify(okRes.body)).toBe(200);
    expect(okRes.body.score).toBe(0); // nothing in the window yet
    expect(okRes.body.recommendations[0].action).toContain('No payments in the window');
    const denied = await request(app)
      .get('/api/insights/acceptance-score')
      .set({ Authorization: `Bearer ${other}` });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('scope_denied');
    const user = await registerUser(app);
    const role = await request(app).get('/api/insights/acceptance-score').set(user.auth);
    expect(role.status).toBe(403);
    expect(role.body.error.code).toBe('role_required');
  });
});

describe('§58 payment graph', () => {
  it('detects a 3-node payment ring closed within 24 hours, incrementally from the bus and after a rebuild', async () => {
    const [a, b, c] = await Promise.all([registerUser(app, { tag: 'ring_a' }), registerUser(app, { tag: 'ring_b' }), registerUser(app, { tag: 'ring_c' })]);
    for (const u of [a, b, c]) await fund(app, u.user.id, '50.00');
    expect((await transfer(a.auth, 'ring_b', '20.00')).status).toBe(201);
    expect((await transfer(b.auth, 'ring_c', '20.00')).status).toBe(201);
    expect((await transfer(c.auth, 'ring_a', '20.00')).status).toBe(201);
    const nodes = [personNodeId(a.user), personNodeId(b.user), personNodeId(c.user)];
    const ring = ringCandidates().find((r) => nodes.every((n) => r.nodes.includes(n)));
    expect(ring).toBeDefined();
    expect(ring!.nodes).toHaveLength(3);
    expect(ring!.edges).toHaveLength(3);
    expect(ring!.spanMinutes).toBeLessThan(24 * 60);
    expect(ring!.amountMinor).toBe(6000);
    // neighbourhood: two hops from A reach B and C
    const hood = neighbours(a.user.id, 2);
    expect(hood.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(nodes));
    expect(hood.edges.some((e) => e.kind === 'paid')).toBe(true);
    expect(hood.edges.some((e) => e.kind === 'received')).toBe(true);
    // rebuilding from the ledger reproduces the same graph
    const before = graphStats();
    const rebuilt = rebuildGraph();
    expect(rebuilt.transactions).toBeGreaterThan(0);
    expect(graphStats()).toEqual(before);
    expect(ringCandidates().some((r) => nodes.every((n) => r.nodes.includes(n)))).toBe(true);
  });

  it('flags a mule: three payers in, more than 80 % forwarded within the hour', async () => {
    const mule = await registerUser(app, { tag: 'mule_m' });
    const sink = await registerUser(app, { tag: 'mule_x' });
    const payers = await Promise.all([1, 2, 3].map((i) => registerUser(app, { tag: `mule_p${i}` })));
    for (const p of payers) {
      await fund(app, p.user.id, '30.00');
      expect((await transfer(p.auth, 'mule_m', '20.00')).status).toBe(201);
    }
    expect((await transfer(mule.auth, 'mule_x', '55.00')).status).toBe(201);
    const found = muleCandidates().find((m) => m.node === personNodeId(mule.user));
    expect(found).toBeDefined();
    expect(found!.payers).toBe(3);
    expect(found!.inboundMinor).toBe(6000);
    expect(found!.forwardedMinor).toBe(5500);
    expect(found!.forwardedShare).toBeGreaterThan(0.8);
    expect(muleCandidates().some((m) => m.node === personNodeId(sink.user))).toBe(false);
  });

  it('finds duplicate identities through a shared device, exposes identities to compliance administrators only and aggregates for merchants', async () => {
    const d1 = await registerUser(app, { tag: 'dup_one' });
    const d2 = await registerUser(app, { tag: 'dup_two' });
    const shop = await registerUser(app, { role: 'merchant', businessName: 'Dup Shop', country: 'CD', tag: 'dup_shop' });
    await fund(app, d1.user.id, '20.00');
    await fund(app, d2.user.id, '20.00');
    expect((await transfer(d1.auth, 'dup_shop', '5.00', { 'x-device-id': 'dev-shared-42' })).status).toBe(201);
    expect((await transfer(d2.auth, 'dup_shop', '5.00', { 'x-device-id': 'dev-shared-42' })).status).toBe(201);
    const shared = sharedDevices(d1.user.id, d2.user.id);
    expect(shared.map((n) => n.id)).toContain('device:dev-shared-42');
    const pair = duplicateIdentityCandidates().find((p) => [p.a, p.b].sort().join() === [personNodeId(d1.user), personNodeId(d2.user)].sort().join());
    expect(pair).toBeDefined();
    expect(pair!.signals).toContainEqual({ kind: 'shared_device', ref: 'device:dev-shared-42' });
    expect(pair!.confidence).toBeGreaterThanOrEqual(0.6);
    // merchants only see counts
    const summary = await request(app).get('/api/insights/graph/summary').set(shop.auth);
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    expect(summary.body.payers).toBe(2);
    expect(summary.body.devices).toBe(1);
    expect(summary.body.sharedDevicePayerPairs).toBe(1);
    expect(JSON.stringify(summary.body)).not.toContain(d1.user.id);
    // identities: super admin (compliance) yes; a staff admin without the compliance permission and a merchant no
    const admin = await adminToken(app);
    const rings = await request(app).get('/api/admin/insights/graph/duplicates').set(admin.auth);
    expect(rings.status).toBe(200);
    expect(rings.body.items.some((p: any) => p.signals.some((s: any) => s.ref === 'device:dev-shared-42'))).toBe(true);
    const devices = await request(app).get('/api/admin/insights/graph/shared-devices').set(admin.auth).query({ a: d1.user.id, b: d2.user.id });
    expect(devices.body.items.map((n: any) => n.id)).toContain('device:dev-shared-42');
    const staff = await request(app)
      .post('/api/admin/users')
      .set(admin.auth)
      .send({ fullName: 'Reports Only', email: 'reports.only@bitripay.local', password: 'Reports123!', role: 'admin', permissions: ['reports'] });
    expect(staff.status).toBe(201);
    const staffLogin = await request(app).post('/api/auth/login').send({ identifier: 'reports.only@bitripay.local', password: 'Reports123!' });
    const staffAuth = { Authorization: `Bearer ${staffLogin.body.token}` };
    expect((await request(app).get('/api/admin/insights/graph/stats').set(staffAuth)).status).toBe(200);
    const denied = await request(app)
      .get('/api/admin/insights/graph/neighbours/' + personNodeId(d1.user))
      .set(staffAuth);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('permission_denied');
    expect((await request(app).get('/api/admin/insights/graph/rings').set(shop.auth)).status).toBe(403);
  });
});

describe('§59 float intelligence', () => {
  /** Eight weeks of hourly cash-ins in the buckets the outlook is about to look at (synthetic history for the forecaster). */
  function seedCashIns(agentId: string, customerId: string, amountMinor: number) {
    const db = getDb();
    const agentWallet = getUserWallet(agentId, 'USD');
    const customerWallet = getUserWallet(customerId, 'USD');
    const insert = db.prepare(
      "INSERT INTO transactions (id, reference, type, status, amount, fee, currency, receive_amount, receive_currency, sender_user_id, receiver_user_id, sender_wallet_id, receiver_wallet_id, note, metadata, created_at, completed_at) VALUES (?, ?, 'agent_cash_in', 'completed', ?, 0, 'USD', ?, 'USD', ?, ?, ?, ?, 'seeded history', '{}', ?, ?)",
    );
    for (let week = 1; week <= 8; week += 1)
      for (let hour = 0; hour < 4; hour += 1) {
        const at = new Date(Date.now() - week * 7 * 86_400_000 + hour * 3_600_000 + 60_000).toISOString();
        insert.run(uuid(), txReference(), amountMinor, amountMinor, agentId, customerId, agentWallet.id, customerWallet.id, at, at);
      }
  }

  it('predicts depletion from eight weeks of weekday/hour history: HIGH risk recommends a rebalance and notifies, nothing moves by itself', async () => {
    const agent = await registerUser(app, { role: 'agent', tag: 'float_agent', businessName: 'Float Agent', country: 'CD' });
    const customer = await registerUser(app, { tag: 'float_cust' });
    await fund(app, agent.user.id, '100.00');
    expect(normalCdf(0)).toBeCloseTo(0.5, 5);
    expect(normalCdf(1.2816)).toBeCloseTo(0.9, 3);
    const calm = floatOutlook(agent.user.id, 'USD')[0];
    expect(calm.risk).toBe('LOW');
    expect(calm.recommendedAction).toBe('hold');
    expect(calm.demand.samples).toBe(0);
    seedCashIns(agent.user.id, customer.user.id, 5000);
    const [o] = floatOutlook(agent.user.id, 'USD');
    expect(o.digitalFloatMinor).toBe(10_000);
    expect(o.demand.samples).toBe(32);
    expect(o.demand.expectedCashInMinor).toBeGreaterThan(10_000);
    expect(o.predicted4hDigitalMinor).toBeLessThan(0);
    expect(o.depletionProbability).toBeGreaterThanOrEqual(0.5);
    expect(o.risk).toBe('HIGH');
    expect(o.recommendedAction).toBe('rebalance');
    expect(o.recommendedAmountMinor).toBeGreaterThan(0);
    expect(o.cashFloatSource).toBe('estimated');
    expect(o.predicted4hCashMinor).toBeGreaterThan(o.cashFloatMinor);
    const before = getUserWallet(agent.user.id, 'USD').balance;
    const alerts = runFloatOutlookAlerts();
    expect(alerts.alerted).toBeGreaterThanOrEqual(1);
    expect(runFloatOutlookAlerts().alerted).toBe(0); // once per hour
    expect(getUserWallet(agent.user.id, 'USD').balance).toBe(before); // only a recommendation
    const notif = await request(app).get('/api/account/notifications').set(agent.auth);
    expect(notif.body.items.some((n: any) => n.title === 'Float depletion likely' && n.body.includes('Request'))).toBe(true);
    // the agent's own endpoint and the cash declaration that turns the estimate into a declared float
    const res = await request(app).get('/api/insights/float-outlook').set(agent.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.outlooks[0].risk).toBe('HIGH');
    expect(res.body.limits.band).toBe('new');
    const declared = await request(app).post('/api/insights/float-outlook/cash').set(agent.auth).send({ currency: 'USD', amount: '250.00' });
    expect(declared.status).toBe(201);
    expect(declared.body.outlooks[0].cashFloatSource).toBe('declared');
    expect(declared.body.outlooks[0].cashFloatMinor).toBe(25_000);
    expect((await request(app).get('/api/insights/float-outlook').set(customer.auth)).status).toBe(403);
  });

  it('scales per-transaction and daily ceilings with the trust band and enforces them on cash-in', async () => {
    const agent = await registerUser(app, { role: 'agent', tag: 'limit_agent', businessName: 'Limit Agent', country: 'CD' });
    await registerUser(app, { tag: 'limit_cust' });
    await fund(app, agent.user.id, '2000.00');
    setSetting('agentIntel', { limitBaseMinor: { perTransaction: 50_000, daily: 60_000 } });
    const fresh = agentLimitsFor(agent.user);
    expect(fresh.band).toBe('new');
    expect(fresh.perTransactionMinor).toBe(25_000);
    expect(fresh.dailyMinor).toBe(30_000);
    const over = await request(app).post('/api/agents/me/cash-in').set(agent.auth).send({ customer: 'limit_cust', amount: '300.00', currency: 'USD', pin: '1234' });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('agent_limit_exceeded');
    expect(over.body.error.details.scope).toBe('per_transaction');
    expect((await request(app).post('/api/agents/me/cash-in').set(agent.auth).send({ customer: 'limit_cust', amount: '200.00', currency: 'USD', pin: '1234' })).status).toBe(201);
    expect(agentLimitsFor(agent.user).usedTodayMinor).toBe(20_000);
    // a gold agent gets four times the ceilings of a new one
    getDb()
      .prepare("INSERT INTO agent_scores (id, agent_user_id, score, band, factors, commission_bonus_bps, computed_at) VALUES (?, ?, 80, 'gold', '{}', 10, ?)")
      .run(`as_${uuid().slice(0, 12)}`, agent.user.id, new Date().toISOString());
    const gold = agentLimitsFor(agent.user);
    expect(gold.band).toBe('gold');
    expect(gold.perTransactionMinor).toBe(100_000);
    expect(gold.dailyMinor).toBe(120_000);
    expect((await request(app).post('/api/agents/me/cash-in').set(agent.auth).send({ customer: 'limit_cust', amount: '300.00', currency: 'USD', pin: '1234' })).status).toBe(201);
    // the daily ceiling: 500 used of 1 200; a 900 cash-in fits the per-transaction ceiling but crosses the day's
    const daily = await request(app).post('/api/agents/me/cash-in').set(agent.auth).send({ customer: 'limit_cust', amount: '900.00', currency: 'USD', pin: '1234' });
    expect(daily.status).toBe(422);
    expect(daily.body.error.code).toBe('agent_limit_exceeded');
    expect(daily.body.error.details.scope).toBe('daily');
    expect(daily.body.error.details.used).toBe(50_000);
    setSetting('agentIntel', {});
  });
});

describe('§61 smart restricted wallets', () => {
  it('lets an education wallet pay a school but not a bar, not above the ceiling, not after expiry, and never withdraw or cash out', async () => {
    const admin = await adminToken(app);
    const school = await registerUser(app, { role: 'merchant', businessName: 'Lycée Kin', country: 'CD', tag: 'lycee_kin' });
    const bar = await registerUser(app, { role: 'merchant', businessName: 'Bar Kin', country: 'CD', tag: 'bar_kin' });
    const agent = await registerUser(app, { role: 'agent', businessName: 'Cash Agent', country: 'CD', tag: 'cash_agent' });
    const student = await registerUser(app, { tag: 'student_1' });
    const granted = await request(app)
      .put(`/api/admin/insights/merchants/${school.user.id}/purpose-codes`)
      .set(admin.auth)
      .send({ purposeCodes: ['SCHOOL'] });
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    expect(granted.body.purposeCodes).toEqual(['SCHOOL']);
    const prog = await request(app).post('/api/admin/insights/restricted/programmes').set(admin.auth).send({ name: 'Education grant 2026', purposeCode: 'SCHOOL', currency: 'USD', maxTx: '150.00' });
    expect(prog.status, JSON.stringify(prog.body)).toBe(201);
    const opened = await request(app).post('/api/admin/insights/restricted/wallets').set(admin.auth).send({ programmeId: prog.body.programme.id, userId: student.user.id });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const rw = opened.body.wallet;
    const funded = await request(app).post(`/api/admin/insights/restricted/wallets/${rw.id}/fund`).set(admin.auth).send({ amount: '300.00' });
    expect(funded.status, JSON.stringify(funded.body)).toBe(201);
    expect(funded.body.transaction.metadata.issuance.authority).toBe('programme');
    const mine = await request(app).get('/api/restricted/wallets').set(student.auth);
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0].balanceMinor).toBe(30_000);
    expect(mine.body.items[0].programme.purposeCode).toBe('SCHOOL');
    // eligibility explains itself
    expect((await request(app).get(`/api/restricted/wallets/${rw.id}/eligibility`).set(student.auth).query({ merchant: 'lycee_kin' })).body).toMatchObject({
      eligible: true,
      reason: 'granted purpose code SCHOOL',
    });
    expect((await request(app).get(`/api/restricted/wallets/${rw.id}/eligibility`).set(student.auth).query({ merchant: 'bar_kin' })).body.eligible).toBe(false);
    // pays the school
    const schoolBefore = getUserWallet(school.user.id, 'USD').balance;
    const paid = await request(app).post(`/api/restricted/wallets/${rw.id}/pay`).set(student.auth).send({ merchant: 'lycee_kin', amount: '100.00', pin: '1234' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.transaction.type).toBe('merchant_payment');
    expect(paid.body.wallet.balanceMinor).toBe(20_000);
    expect(getUserWallet(school.user.id, 'USD').balance - schoolBefore).toBe(10_000 - paid.body.transaction.fee);
    // not the bar
    const barPay = await request(app).post(`/api/restricted/wallets/${rw.id}/pay`).set(student.auth).send({ merchant: bar.user.tag, amount: '10.00', pin: '1234' });
    expect(barPay.status).toBe(403);
    expect(barPay.body.error.code).toBe('restricted_wallet_policy');
    expect(barPay.body.error.message).toContain('not eligible for SCHOOL');
    // not above the programme ceiling (refused before the balance is even looked at)
    const big = await request(app).post(`/api/restricted/wallets/${rw.id}/pay`).set(student.auth).send({ merchant: 'lycee_kin', amount: '180.00', pin: '1234' });
    expect(big.status).toBe(403);
    expect(big.body.error.message).toContain('capped');
    // not an agent (cash-out) and not a withdrawal through the ledger itself
    const cashOut = await request(app).post(`/api/restricted/wallets/${rw.id}/pay`).set(student.auth).send({ merchant: 'cash_agent', amount: '10.00', pin: '1234' });
    expect(cashOut.status).toBe(403);
    expect(cashOut.body.error.code).toBe('restricted_wallet_policy');
    expect(() => postTransaction({ type: 'withdrawal', amount: 1000, currency: 'USD', fromWalletId: rw.walletId, toWalletId: null, senderUserId: student.user.id })).toThrow(/cannot be withdrawn/);
    expect(() =>
      postTransaction({
        type: 'agent_cash_out',
        amount: 1000,
        currency: 'USD',
        fromWalletId: rw.walletId,
        toWalletId: getUserWallet(agent.user.id, 'USD').id,
        senderUserId: student.user.id,
        receiverUserId: agent.user.id,
      }),
    ).toThrow(/cannot be withdrawn/);
    expect(getUserWallet(student.user.id, 'USD').balance).toBe(0); // the beneficiary's ordinary wallet was never touched
    expect(mine.body.items[0].walletId).toBe(rw.walletId);
    // expiry closes the tap; a programme that allows cash-out opens it
    expect((await request(app).patch(`/api/admin/insights/restricted/programmes/${prog.body.programme.id}`).set(admin.auth).send({ expiresAt: '2020-01-01T00:00:00.000Z' })).status).toBe(200);
    const expired = await request(app).post(`/api/restricted/wallets/${rw.id}/pay`).set(student.auth).send({ merchant: 'lycee_kin', amount: '10.00', pin: '1234' });
    expect(expired.status).toBe(403);
    expect(expired.body.error.message).toContain('expired');
    expect((await request(app).patch(`/api/admin/insights/restricted/programmes/${prog.body.programme.id}`).set(admin.auth).send({ expiresAt: null, cashOutAllowed: true })).status).toBe(200);
    const withdrawn = postTransaction({ type: 'withdrawal', amount: 1000, currency: 'USD', fromWalletId: rw.walletId, toWalletId: null, senderUserId: student.user.id, status: 'pending' });
    expect(withdrawn.status).toBe('pending');
    expect((await request(app).get('/api/restricted/wallets').set(student.auth)).body.items[0].balanceMinor).toBe(19_000);
  });

  it('pays a school payment intent from the restricted wallet and captures it through the intent machine', async () => {
    const admin = await adminToken(app);
    const school = await registerUser(app, { role: 'merchant', businessName: 'Collège Est', country: 'CD', tag: 'college_est' });
    const student = await registerUser(app, { tag: 'student_2' });
    const prog = (
      await request(app)
        .post('/api/admin/insights/restricted/programmes')
        .set(admin.auth)
        .send({ name: 'Bursary', purposeCode: 'SCHOOL', currency: 'USD', eligibleMerchantIds: [school.user.id] })
    ).body.programme;
    const rw = (await request(app).post('/api/admin/insights/restricted/wallets').set(admin.auth).send({ programmeId: prog.id, userId: student.user.id })).body.wallet;
    expect((await request(app).post(`/api/admin/insights/restricted/wallets/${rw.id}/fund`).set(admin.auth).send({ amount: '50.00' })).status).toBe(201);
    const pi = (await request(app).post('/api/v1/payment_intents').set(school.auth).send({ currency: 'USD', amount_minor: 2500, reference: 'TERM-1', purpose_code: 'SCHOOL' })).body;
    const paid = await request(app).post(`/api/restricted/wallets/${rw.id}/pay`).set(student.auth).send({ intentId: pi.id, pin: '1234' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const row = getIntentRow(pi.id);
    expect(['CAPTURED', 'SETTLEMENT_PENDING', 'SETTLED']).toContain(row.status);
    expect(row.transaction_id).toBe(paid.body.transaction.id);
    expect(paid.body.wallet.balanceMinor).toBe(2500);
    const again = await request(app).post(`/api/restricted/wallets/${rw.id}/pay`).set(student.auth).send({ intentId: pi.id, pin: '1234' });
    expect(again.status).toBe(409);
    // the programme listing and a wallet that belongs to someone else
    expect((await request(app).get('/api/admin/insights/restricted/programmes').set(admin.auth)).body.items.some((p: any) => p.id === prog.id)).toBe(true);
    const stranger = await registerUser(app);
    expect((await request(app).get(`/api/restricted/wallets/${rw.id}`).set(stranger.auth)).status).toBe(403);
  });
});

describe('§105/§106 government QR infrastructure', () => {
  it('issues a reference as a GOVERNMENT_FEE intent with gov metadata, marks it PAID from the captured intent and totals the dashboard', async () => {
    const admin = await adminToken(app);
    const agencyAccount = await registerUser(app, { role: 'merchant', businessName: 'DGI Kinshasa', country: 'CD', tag: 'dgi_kin' });
    const citizen = await registerUser(app, { tag: 'citizen_1' });
    await fund(app, citizen.user.id, '500.00');
    await fund(app, agencyAccount.user.id, '1.00');
    const created = await request(app)
      .post('/api/admin/insights/government/agencies')
      .set(admin.auth)
      .send({ name: 'Direction Générale des Impôts', code: 'DGI', country: 'CD', region: 'Kinshasa', merchant: 'dgi_kin' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const agency = created.body.agency;
    expect(getDb().prepare('SELECT status, purpose_codes FROM institutions WHERE user_id = ?').get(agencyAccount.user.id)).toMatchObject({ status: 'verified' });
    // a reusable fixed-amount service gets an institution QR; a variable TAX service does not
    const passport = await request(app)
      .post(`/api/government/agencies/${agency.id}/services`)
      .set(agencyAccount.auth)
      .send({ name: 'Passport fee', revenueCode: 'PASS-01', currency: 'USD', fixedAmount: '50.00', reusable: true });
    expect(passport.status, JSON.stringify(passport.body)).toBe(201);
    expect(passport.body.service.qrId).toMatch(/^qr_/);
    expect(getDb().prepare('SELECT kind, purpose_code, amount FROM qr_codes WHERE id = ?').get(passport.body.service.qrId)).toEqual({
      kind: 'institution',
      purpose_code: 'GOVERNMENT_FEE',
      amount: 5000,
    });
    const tax = await request(app)
      .post(`/api/government/agencies/${agency.id}/services`)
      .set(agencyAccount.auth)
      .send({ name: 'Property tax', revenueCode: 'TAX-PROP', purposeCode: 'TAX', currency: 'USD' });
    expect(tax.status).toBe(201);
    expect(tax.body.service.qrId).toBeNull();
    // the reference is a payment intent with purpose GOVERNMENT_FEE and metadata.gov
    const ref = await request(app).post(`/api/government/services/${passport.body.service.id}/references`).set(agencyAccount.auth).send({ citizenRef: 'CIT-0001', region: 'Kinshasa' });
    expect(ref.status, JSON.stringify(ref.body)).toBe(201);
    expect(ref.body.reference.status).toBe('OPEN');
    expect(ref.body.reference.reconciliationCode).toMatch(/^DGI-PASS-01-/);
    expect(ref.body.reference.payUrl).toContain('/pay/');
    expect(ref.body.intent.purposeCode).toBe('GOVERNMENT_FEE');
    const intentRow = getIntentRow(ref.body.reference.intentId);
    expect(JSON.parse(intentRow.metadata).gov).toMatchObject({ agencyCode: 'DGI', revenueCode: 'PASS-01', citizenRef: 'CIT-0001', reconciliationCode: ref.body.reference.reconciliationCode });
    expect(intentRow.reference).toBe(ref.body.reference.reconciliationCode);
    // the citizen pays the intent from the wallet → the bus marks the reference PAID
    const paid = await request(app).post(`/api/v1/payment_intents/${ref.body.reference.intentId}/pay/wallet`).set(citizen.auth).send({ pin: '1234' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const after = getReference(ref.body.reference.reconciliationCode);
    expect(after.status).toBe('PAID');
    expect(after.transactionId).toBe(paid.body.transaction.id);
    expect(after.payerUserId).toBe(citizen.user.id);
    expect(after.paidAt).toBeTruthy();
    const lookup = await request(app).get(`/api/government/references/${ref.body.reference.reconciliationCode}`).set(agencyAccount.auth);
    expect(lookup.body.reference.status).toBe('PAID');
    expect((await request(app).get(`/api/government/references/${ref.body.reference.reconciliationCode}`).set(citizen.auth)).status).toBe(200); // the payer may read it
    const dash = await request(app).get('/api/government/dashboard').set(agencyAccount.auth);
    expect(dash.status, JSON.stringify(dash.body)).toBe(200);
    expect(dash.body.agencies.map((a: any) => a.id)).toEqual([agency.id]);
    expect(dash.body.collections).toEqual([{ currency: 'USD', count: 1, total: 5000 }]);
    expect(dash.body.byService.find((s: any) => s.revenueCode === 'PASS-01')).toMatchObject({ count: 1, total: 5000 });
    expect(dash.body.byRegion.find((r: any) => r.region === 'Kinshasa')).toMatchObject({ count: 1, total: 5000 });
    expect(dash.body.byStatus.PAID.count).toBe(1);
    expect(dash.body.unmatched).toEqual([]);
    // an agent collects a tax reference at the counter → agent collections
    const agent = await registerUser(app, { role: 'agent', businessName: 'Counter Agent', country: 'CD', tag: 'counter_agent' });
    const taxRef = await request(app).post(`/api/government/services/${tax.body.service.id}/references`).set(agent.auth).send({ citizenRef: 'PARCEL-77', amount: '120.00', region: 'Lubumbashi' });
    expect(taxRef.status, JSON.stringify(taxRef.body)).toBe(201);
    expect(taxRef.body.reference.agentUserId).toBe(agent.user.id);
    expect(taxRef.body.intent.purposeCode).toBe('TAX');
    expect((await request(app).post(`/api/v1/payment_intents/${taxRef.body.reference.intentId}/pay/wallet`).set(citizen.auth).send({ pin: '1234' })).status).toBe(201);
    const dash2 = (await request(app).get('/api/government/dashboard').set(admin.auth).query({ agencyId: agency.id })).body;
    expect(dash2.collections).toEqual([{ currency: 'USD', count: 2, total: 17_000 }]);
    expect(dash2.agentCollections).toHaveLength(1);
    expect(dash2.agentCollections[0]).toMatchObject({ agentUserId: agent.user.id, count: 1, total: 12_000 });
    expect(dash2.byRegion.find((r: any) => r.region === 'Lubumbashi').total).toBe(12_000);
    // a refund through the gateway marks the reference REFUNDED
    const refund = await request(app).post('/api/v1/refunds').set(agencyAccount.auth).send({ payment_intent: ref.body.reference.intentId, amount_minor: 5000, reason: 'duplicate application' });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    expect(getReference(ref.body.reference.id).status).toBe('REFUNDED');
    const dash3 = (await request(app).get('/api/government/dashboard').set(agencyAccount.auth)).body;
    expect(dash3.refunds.count).toBe(1);
    expect(dash3.collections).toEqual([{ currency: 'USD', count: 1, total: 12_000 }]);
    // audit export
    const csv = await request(app).get('/api/government/audit-export.csv').set(agencyAccount.auth);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.text.trim().split('\n');
    expect(lines[0]).toBe(
      'reconciliation_code,agency_code,agency_name,service,revenue_code,purpose_code,citizen_ref,region,amount_minor,currency,status,intent_id,transaction_id,payer_user_id,agent_user_id,created_at,paid_at,refunded_at,expires_at',
    );
    expect(lines).toHaveLength(3);
    expect(csv.text).toContain(`${ref.body.reference.reconciliationCode},DGI,Direction Générale des Impôts,Passport fee,PASS-01,GOVERNMENT_FEE,CIT-0001,Kinshasa,5000,USD,REFUNDED,`);
    expect(csv.text).toContain(`,TAX-PROP,TAX,PARCEL-77,Lubumbashi,12000,USD,PAID,`);
    // strangers see nothing
    const stranger = await registerUser(app);
    expect((await request(app).get('/api/government/dashboard').set(stranger.auth)).body.agencies).toEqual([]);
    expect((await request(app).get(`/api/government/references/${ref.body.reference.reconciliationCode}`).set(stranger.auth)).status).toBe(403);
    expect((await request(app).post(`/api/government/agencies/${agency.id}/services`).set(stranger.auth).send({ name: 'Extra fee', revenueCode: 'X-1', currency: 'USD' })).status).toBe(403);
  });

  it('detects unmatched credits: money that reached the agency account without a reference behind it', async () => {
    const admin = await adminToken(app);
    const agencyAccount = await registerUser(app, { role: 'merchant', businessName: 'Mairie de Goma', country: 'CD', tag: 'mairie_goma' });
    const citizen = await registerUser(app, { tag: 'citizen_2' });
    await fund(app, citizen.user.id, '100.00');
    const agency = (await request(app).post('/api/admin/insights/government/agencies').set(admin.auth).send({ name: 'Mairie de Goma', code: 'GOMA', country: 'CD', merchant: 'mairie_goma' })).body
      .agency;
    const svc = (
      await request(app).post(`/api/government/agencies/${agency.id}/services`).set(agencyAccount.auth).send({ name: 'Market stall', revenueCode: 'MKT-01', currency: 'USD', fixedAmount: '10.00' })
    ).body.service;
    const ref = (await request(app).post(`/api/government/services/${svc.id}/references`).set(agencyAccount.auth).send({ citizenRef: 'STALL-9' })).body.reference;
    expect((await request(app).post(`/api/v1/payment_intents/${ref.intentId}/pay/wallet`).set(citizen.auth).send({ pin: '1234' })).status).toBe(201);
    // a plain gateway intent without a reference and a direct transfer both land on the agency account
    const loose = (await request(app).post('/api/v1/payment_intents').set(agencyAccount.auth).send({ currency: 'USD', amount_minor: 700, reference: 'CASH-DESK' })).body;
    expect((await request(app).post(`/api/v1/payment_intents/${loose.id}/pay/wallet`).set(citizen.auth).send({ pin: '1234' })).status).toBe(201);
    const direct = await transfer(citizen.auth, 'mairie_goma', '3.00');
    expect(direct.status).toBe(201);
    const dash = (await request(app).get('/api/government/dashboard').set(agencyAccount.auth)).body;
    expect(dash.collections).toEqual([{ currency: 'USD', count: 1, total: 1000 }]);
    expect(dash.unmatched).toHaveLength(2);
    expect(dash.unmatched.map((u: any) => u.amount).sort()).toEqual([300, 700]);
    expect(dash.unmatched.find((u: any) => u.intentId === loose.id).sender.id).toBe(citizen.user.id);
    expect(dash.unmatched.some((u: any) => u.intentId === ref.intentId)).toBe(false);
    // operators added by an administrator see the same dashboard
    const clerk = await registerUser(app, { tag: 'goma_clerk' });
    expect((await request(app).post(`/api/admin/insights/government/agencies/${agency.id}/operators`).set(admin.auth).send({ user: 'goma_clerk', role: 'auditor' })).status).toBe(201);
    const clerkDash = (await request(app).get('/api/government/dashboard').set(clerk.auth)).body;
    expect(clerkDash.agencies[0].code).toBe('GOMA');
    expect(clerkDash.unmatched).toHaveLength(2);
    expect((await request(app).get('/api/government/agencies').set(clerk.auth)).body.items).toHaveLength(1);
  });
});

describe('§61 programme eligibility by MCC, country and sponsor funding', () => {
  it('qualifies a merchant through its location MCC, refuses one outside the programme countries, and funds from the sponsor wallet without creating money', async () => {
    const admin = await adminToken(app);
    const sponsor = await registerUser(app, { role: 'merchant', businessName: 'Health NGO', country: 'CD', tag: 'health_ngo' });
    await fund(app, sponsor.user.id, '80.00');
    const clinic = await registerUser(app, { role: 'merchant', businessName: 'Clinique Nord', country: 'CD', tag: 'clinique_nord' });
    createLocation(clinic.user, { name: 'Main clinic', city: 'Goma', country: 'CD', mcc: '8062' });
    const abroad = await registerUser(app, { role: 'merchant', businessName: 'Nairobi Clinic', country: 'KE', tag: 'nairobi_clinic' });
    createLocation(abroad.user, { name: 'Nairobi', city: 'Nairobi', country: 'KE', mcc: '8062' });
    const patient = await registerUser(app, { tag: 'patient_1' });
    const prog = (
      await request(app)
        .post('/api/admin/insights/restricted/programmes')
        .set(admin.auth)
        .send({ name: 'Health voucher', purposeCode: 'HEALTH', currency: 'USD', eligibleMccs: ['8062', '8011'], countries: ['CD'], sponsorUserId: sponsor.user.id })
    ).body.programme;
    expect(prog.eligibleMccs).toEqual(['8062', '8011']);
    const rw = (await request(app).post('/api/admin/insights/restricted/wallets').set(admin.auth).send({ programmeId: prog.id, userId: patient.user.id })).body.wallet;
    const supplyBefore = emoneySupply().find((s) => s.currency === 'USD')!.outstanding;
    const funded = await request(app).post(`/api/admin/insights/restricted/wallets/${rw.id}/fund`).set(admin.auth).send({ amount: '60.00' });
    expect(funded.status, JSON.stringify(funded.body)).toBe(201);
    expect(funded.body.transaction.type).toBe('distribution');
    expect(funded.body.transaction.metadata.source).toBe('sponsor');
    expect(funded.body.transaction.metadata.issuance).toBeUndefined();
    expect(getUserWallet(sponsor.user.id, 'USD').balance).toBe(2000);
    expect(emoneySupply().find((s) => s.currency === 'USD')!.outstanding).toBe(supplyBefore); // moved, not created
    expect((await request(app).get(`/api/restricted/wallets/${rw.id}/eligibility`).set(patient.auth).query({ merchant: 'clinique_nord' })).body).toMatchObject({
      eligible: true,
      reason: 'merchant category 8062 is eligible',
    });
    expect((await request(app).get(`/api/restricted/wallets/${rw.id}/eligibility`).set(patient.auth).query({ merchant: 'nairobi_clinic' })).body.reason).toContain('outside the programme countries');
    expect((await request(app).post(`/api/restricted/wallets/${rw.id}/pay`).set(patient.auth).send({ merchant: 'clinique_nord', amount: '25.00', pin: '1234' })).status).toBe(201);
    const ke = await request(app).post(`/api/restricted/wallets/${rw.id}/pay`).set(patient.auth).send({ merchant: 'nairobi_clinic', amount: '25.00', pin: '1234' });
    expect(ke.status).toBe(403);
    expect(ke.body.error.code).toBe('restricted_wallet_policy');
    // a closed wallet refuses everything, even eligible merchants
    expect((await request(app).post(`/api/admin/insights/restricted/wallets/${rw.id}/close`).set(admin.auth)).body.wallet.status).toBe('CLOSED');
    const closed = await request(app).post(`/api/restricted/wallets/${rw.id}/pay`).set(patient.auth).send({ merchant: 'clinique_nord', amount: '5.00', pin: '1234' });
    expect(closed.status).toBe(409);
    expect(() =>
      postTransaction({
        type: 'merchant_payment',
        amount: 500,
        currency: 'USD',
        fromWalletId: rw.walletId,
        toWalletId: getUserWallet(clinic.user.id, 'USD').id,
        senderUserId: patient.user.id,
        receiverUserId: clinic.user.id,
      }),
    ).toThrow(/closed/);
  });
});

describe('§105 reference lifecycle', () => {
  it('expires open references, keeps the neighbourhood depth bounded and reports empty shared devices for unrelated accounts', async () => {
    const admin = await adminToken(app);
    const agencyAccount = await registerUser(app, { role: 'merchant', businessName: 'Port Authority', country: 'CD', tag: 'port_auth' });
    const agency = (await request(app).post('/api/admin/insights/government/agencies').set(admin.auth).send({ name: 'Port Authority', code: 'PORT', country: 'CD', merchant: 'port_auth' })).body
      .agency;
    const svc = (
      await request(app).post(`/api/government/agencies/${agency.id}/services`).set(agencyAccount.auth).send({ name: 'Berth fee', revenueCode: 'BERTH', currency: 'USD', fixedAmount: '40.00' })
    ).body.service;
    const ref = (await request(app).post(`/api/government/services/${svc.id}/references`).set(agencyAccount.auth).send({ citizenRef: 'VESSEL-1', expiresInMinutes: 5 })).body.reference;
    expect(ref.status).toBe('OPEN');
    getDb().prepare('UPDATE gov_references SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', ref.id);
    expect(syncGovReferences().expired).toBe(1);
    expect(getReference(ref.id).status).toBe('EXPIRED');
    const dash = (await request(app).get('/api/government/dashboard').set(agencyAccount.auth)).body;
    expect(dash.byStatus.EXPIRED.count).toBe(1);
    expect(dash.collections).toEqual([]);
    expect((await request(app).get('/api/government/audit-export.csv').set(agencyAccount.auth)).text).toContain(
      `${ref.reconciliationCode},PORT,Port Authority,Berth fee,BERTH,GOVERNMENT_FEE,VESSEL-1,,4000,USD,EXPIRED,`,
    );
    // graph queries stay bounded and honest
    const hood = neighbours(agencyAccount.user.id, 9);
    expect(hood.depth).toBe(3);
    expect(hood.nodes.map((n) => n.id)).toContain(personNodeId(agencyAccount.user));
    expect(sharedDevices(agencyAccount.user.id, admin.token.slice(0, 8))).toEqual([]);
  });
});
