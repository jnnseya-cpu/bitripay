/**
 * E-money issuance engine: regulated e-money backed 1:1 by cleared safeguarded funds.
 *  - issuable ≤ cleared reserves − pending redemptions − reserved exposure − outstanding e-money
 *  - reserve funding, issuance and pool minting all go through maker-checker
 *  - reconciliation breaches suspend issuance automatically
 *  - distribution moves existing e-money; it never creates it
 *  - promotional and sandbox balances are labelled and never money
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { getDb } from '../db';
import { setupApp, adminToken, checkerToken, registerUser, fund } from './helpers';

let app: ReturnType<typeof setupApp>;

async function createLiveProgramme(currency = 'GBP') {
  const admin = await adminToken(app);
  const p = await request(app).put('/api/admin/emoney/programmes/new').set(admin.auth).send({ currency, jurisdiction: 'GB', issuerModel: 'own_authorisation', issuerName: 'BitriPay Ltd', licenceRef: 'FRN 900000', regulator: 'FCA', safeguardingBank: 'Barclays', safeguardingAccountRef: 'GB00 SAFE 0001' });
  expect(p.status).toBe(200);
  expect(p.body.programme.readiness.ready).toBe(true);
  // The platform is in sandbox mode in tests, so go-live is refused by the API; simulate an authorised live programme directly.
  const live = await request(app).post(`/api/admin/emoney/programmes/${p.body.programme.id}/status`).set(admin.auth).send({ status: 'live', pin: admin.pin });
  expect(live.status).toBe(403);
  expect(live.body.error.code).toBe('go_live_blocked');
  getDb().prepare("UPDATE emoney_programmes SET status = 'live' WHERE id = ?").run(p.body.programme.id);
  return { admin, id: p.body.programme.id as string };
}

async function confirmReserve(programmeId: string, amount: string, reference: string) {
  const admin = await adminToken(app);
  const checker = await checkerToken(app);
  const r = await request(app).post(`/api/admin/emoney/programmes/${programmeId}/reserves`).set(admin.auth).send({ amount, reference, note: 'Bank statement line checked by treasury', evidence: { statementLine: reference } });
  expect(r.status).toBe(201);
  expect(r.body.movement.status).toBe('pending');
  // maker cannot check their own confirmation
  const self = await request(app).post(`/api/admin/verifications/${r.body.verification.id}/approve`).set(admin.auth).send({ pin: admin.pin });
  expect(self.status).toBe(403);
  const ok = await request(app).post(`/api/admin/verifications/${r.body.verification.id}/approve`).set(checker.auth).send({ pin: checker.pin });
  expect(ok.status).toBe(200);
  return r.body.movement.id as string;
}

async function issue(userId: string, amount: string, currency: string, expectStatus = 201) {
  const admin = await adminToken(app);
  const res = await request(app).post(`/api/admin/users/${userId}/adjust`).set(admin.auth).send({ direction: 'credit', amount, currency, reason: 'Issuance against cleared reserves' });
  expect(res.status).toBe(expectStatus);
  if (res.status !== 201) return res.body;
  const checker = await checkerToken(app);
  const ok = await request(app).post(`/api/admin/verifications/${res.body.verification.id}/approve`).set(checker.auth).send({ pin: checker.pin });
  expect(ok.status).toBe(200);
  return ok.body;
}

describe('e-money issuance engine', () => {
  beforeAll(async () => {
    app = setupApp();
    const admin = await adminToken(app);
    await request(app).put('/api/admin/currencies/GBP').set(admin.auth).send({ enabled: true });
  });

  it('labels sandbox balances and auto-registers a sandbox programme; the go-live checklist blocks on the issuer', async () => {
    const u = await registerUser(app);
    await fund(app, u.user.id, '20.00', 'USD');
    const w = await request(app).get('/api/wallets').set(u.auth);
    expect(w.body.items[0].classification.class).toBe('sandbox');
    expect(w.body.items[0].classification.redeemable).toBe(false);
    const admin = await adminToken(app);
    const ov = await request(app).get('/api/admin/emoney').set(admin.auth);
    expect(ov.body.programmes.some((p: any) => p.currency === 'USD' && p.status === 'sandbox')).toBe(true);
    const gl = await request(app).get('/api/admin/go-live').set(admin.auth);
    const item = gl.body.items.find((i: any) => i.id === 'emoney_issuer');
    expect(item.ok).toBe(false);
    expect(item.blocking).toBe(true);
  });

  it('never issues beyond cleared safeguarded reserves and redeems on withdrawal', async () => {
    const { admin, id } = await createLiveProgramme('GBP');
    const holder = await registerUser(app);
    // nothing cleared yet → even the request is refused
    const refused = await issue(holder.user.id, '100.00', 'GBP', 422);
    expect(refused.error.code).toBe('reserve_insufficient');
    await confirmReserve(id, '1000.00', 'BANKREF-1');
    let p = await request(app).get(`/api/admin/emoney/programmes/${id}`).set(admin.auth);
    expect(p.body.programme.position.clearedReserves).toBe(100_000);
    expect(p.body.programme.position.headroom).toBe(100_000);
    await issue(holder.user.id, '600.00', 'GBP');
    const w = await request(app).get('/api/wallets').set(holder.auth);
    const gbp = w.body.items.find((x: any) => x.currency === 'GBP');
    expect(gbp.balance).toBe(60_000);
    p = await request(app).get(`/api/admin/emoney/programmes/${id}`).set(admin.auth);
    expect(p.body.programme.position.liabilities).toBe(60_000);
    expect(p.body.programme.position.headroom).toBe(40_000);
    const over = await issue(holder.user.id, '500.00', 'GBP', 422);
    expect(over.error.code).toBe('reserve_insufficient');
    // a pending withdrawal counts as a pending redemption; completing it moves cash out of the reserve
    const bank = await request(app).post('/api/bank-accounts').set(holder.auth).send({ bankName: 'Test Bank', accountName: 'Holder', accountNumber: '12345678', currency: 'GBP', pin: '1234' });
    const wd = await request(app).post('/api/withdrawals').set(holder.auth).send({ amount: '100.00', currency: 'GBP', bankAccountId: bank.body.bankAccount.id, pin: '1234' });
    expect(wd.status).toBe(201);
    p = await request(app).get(`/api/admin/emoney/programmes/${id}`).set(admin.auth);
    const held = wd.body.transaction.amount + wd.body.transaction.fee;
    expect(p.body.programme.position.pendingRedemptions).toBe(held);
    expect(p.body.programme.position.liabilities).toBe(60_000 - held);
    const checker = await checkerToken(app);
    const proposed = await request(app).post(`/api/admin/withdrawals/${wd.body.transaction.id}/approve`).set(admin.auth).send({ payoutReference: 'BANKOUT-1', note: 'Faster payment sent from safeguarding account' });
    expect(proposed.status).toBe(200);
    await request(app).post(`/api/admin/verifications/${proposed.body.verification.id}/approve`).set(checker.auth).send({ pin: checker.pin });
    p = await request(app).get(`/api/admin/emoney/programmes/${id}`).set(admin.auth);
    expect(p.body.programme.position.pendingRedemptions).toBe(0);
    expect(p.body.programme.position.clearedReserves).toBe(100_000 - held);
    expect(p.body.movements.some((m: any) => m.kind === 'redemption' && m.status === 'cleared' && m.amount === held)).toBe(true);
    // the ledger accounting entry is on record: safeguarded cash asset ↔ e-money liability stays balanced
    const rec = await request(app).post('/api/admin/emoney/reconcile').set(admin.auth).send({});
    expect(rec.status).toBe(200);
    expect(rec.body.items.find((r: any) => r.programmeId === id).status).toBe('ok');
  });

  it('suspends issuance automatically when reconciliation finds outstanding e-money above the reserves', async () => {
    const { admin, id } = await createLiveProgramme('EUR');
    const holder = await registerUser(app);
    const movementId = await confirmReserve(id, '300.00', 'BANKREF-EUR');
    await issue(holder.user.id, '250.00', 'EUR');
    // the funding turns out to be wrong (bank reversal) → reserves drop below the liabilities
    const rev = await request(app).post(`/api/admin/emoney/reserves/${movementId}/reverse`).set(admin.auth).send({ reason: 'Bank reversed the transfer', pin: admin.pin });
    expect(rev.status).toBe(200);
    const rec = await request(app).post('/api/admin/emoney/reconcile').set(admin.auth).send({});
    const mine = rec.body.items.find((r: any) => r.programmeId === id);
    expect(mine.status).toBe('breach');
    const p = await request(app).get(`/api/admin/emoney/programmes/${id}`).set(admin.auth);
    expect(p.body.programme.status).toBe('suspended');
    const refused = await issue(holder.user.id, '1.00', 'EUR', 403);
    expect(refused.error.code).toBe('issuance_suspended');
    // administrators were alerted (loud)
    const notes = await request(app).get('/api/account/notifications').set(admin.auth);
    expect(notes.body.items.some((n: any) => n.title.startsWith('Issuance suspended') && n.data?.loud)).toBe(true);
  });

  it('distributes existing e-money through pools without creating any, under step-up, and can freeze a balance', async () => {
    const { admin, id } = await createLiveProgramme('KES');
    await confirmReserve(id, '5000.00', 'BANKREF-KES');
    const checker = await checkerToken(app);
    const country = await request(app).post('/api/admin/emoney/pools').set(admin.auth).send({ programmeId: id, name: 'Kenya pool', level: 'country', country: 'KE' });
    expect(country.status).toBe(201);
    const agentUser = await registerUser(app);
    const master = await request(app).post('/api/admin/emoney/pools').set(admin.auth).send({ programmeId: id, name: 'Nairobi master agent', level: 'master_agent', parentId: country.body.pool.id, ownerUserId: agentUser.user.id });
    expect(master.status).toBe(201);
    const bad = await request(app).post('/api/admin/emoney/pools').set(admin.auth).send({ programmeId: id, name: 'Upside down', level: 'country', parentId: master.body.pool.id });
    expect(bad.status).toBe(400);
    // mint into the country pool (maker-checker, against reserves)
    const mint = await request(app).post('/api/admin/emoney/issue').set(admin.auth).send({ programmeId: id, poolId: country.body.pool.id, amount: '2000.00', reason: 'Kenya float' });
    expect(mint.status).toBe(201);
    await request(app).post(`/api/admin/verifications/${mint.body.verification.id}/approve`).set(checker.auth).send({ pin: checker.pin });
    // allocation down the hierarchy moves money; nothing is created
    const a1 = await request(app).post(`/api/admin/emoney/pools/${country.body.pool.id}/allocate`).set(admin.auth).send({ toPoolId: master.body.pool.id, amount: '500.00', reason: 'Master agent float', pin: admin.pin });
    expect(a1.status).toBe(200);
    const holder = await registerUser(app);
    const a2 = await request(app).post(`/api/admin/emoney/pools/${master.body.pool.id}/allocate`).set(admin.auth).send({ toUserId: holder.user.id, amount: '120.00', reason: 'Cash-in at agent', pin: admin.pin });
    expect(a2.status).toBe(200);
    const tooMuch = await request(app).post(`/api/admin/emoney/pools/${master.body.pool.id}/allocate`).set(admin.auth).send({ toUserId: holder.user.id, amount: '900.00', reason: 'Too much', pin: admin.pin });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error.code).toBe('insufficient_funds');
    const pools = await request(app).get('/api/admin/emoney/pools').set(admin.auth);
    expect(pools.body.items.find((p: any) => p.id === country.body.pool.id).balance).toBe(150_000);
    expect(pools.body.items.find((p: any) => p.id === master.body.pool.id).balance).toBe(38_000);
    const w = await request(app).get('/api/wallets').set(holder.auth);
    expect(w.body.items.find((x: any) => x.currency === 'KES').balance).toBe(12_000);
    // outstanding e-money = user balances + pool balances; still fully covered
    const p = await request(app).get(`/api/admin/emoney/programmes/${id}`).set(admin.auth);
    expect(p.body.programme.position.liabilities).toBe(200_000);
    expect(p.body.programme.position.poolBalances).toBe(188_000);
    expect(p.body.programme.position.headroom).toBe(300_000);
    // the pool owner can see their pool
    const mine = await request(app).get('/api/account/pools').set(agentUser.auth);
    expect(mine.body.items.map((x: any) => x.id)).toContain(master.body.pool.id);
    // freeze: the holder cannot move the balance until it is released
    const frozen = await request(app).post(`/api/admin/users/${holder.user.id}/wallets/KES/freeze`).set(admin.auth).send({ reason: 'Court order 12/2026', pin: admin.pin });
    expect(frozen.status).toBe(200);
    expect(frozen.body.wallet.frozen).toBe(true);
    const blocked = await request(app).post('/api/transfers').set(holder.auth).send({ pin: '1234', to: `@${agentUser.user.tag}`, amount: '10.00', currency: 'KES' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('wallet_frozen');
    await request(app).post(`/api/admin/users/${holder.user.id}/wallets/KES/freeze`).set(admin.auth).send({ freeze: false, reason: 'Order lifted', pin: admin.pin });
    const okTx = await request(app).post('/api/transfers').set(holder.auth).send({ pin: '1234', to: `@${agentUser.user.tag}`, amount: '10.00', currency: 'KES' });
    expect(okTx.status).toBe(201);
  });

  it('refuses to mark a programme live without the issuer arrangements and records every step immutably', async () => {
    const admin = await adminToken(app);
    const p = await request(app).put('/api/admin/emoney/programmes/new').set(admin.auth).send({ currency: 'USD', jurisdiction: 'US', issuerModel: 'partner_issuer', issuerName: 'Partner Bank NA' });
    expect(p.status).toBe(200);
    expect(p.body.programme.readiness.ready).toBe(false);
    const live = await request(app).post(`/api/admin/emoney/programmes/${p.body.programme.id}/status`).set(admin.auth).send({ status: 'live', pin: admin.pin });
    expect(live.status).toBe(400);
    expect(live.body.error.code).toBe('programme_arrangements_required');
    const events = await request(app).get('/api/admin/events?stream=issuance&limit=200').set(admin.auth);
    const kinds = events.body.items.map((e: any) => e.event);
    for (const k of ['programme.created', 'reserve.funding.pending', 'reserve.funding.cleared', 'emoney.minted', 'pool.allocated', 'reconciliation.breach', 'programme.suspended', 'wallet.frozen', 'reserve.redemption.cleared']) expect(kinds).toContain(k);
    expect(events.body.chain.ok).toBe(true);
  });
});
