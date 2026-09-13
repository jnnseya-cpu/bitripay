/**
 * Phase 5 — financial operations: versioned fee schedules with author/approver separation and scoped resolution,
 * the agent commission ledger, marketplace split payouts, holds and balance classes, disputes as objects (hold,
 * evidence, deadline, decision → refund), settlement profiles / cycles / statements / obligations paid through the
 * withdrawal workflow, and the three-way processor reconciliation feeding the operations workbench.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, adminToken, checkerToken, fund, decideWithdrawal } from './helpers';
import { getDb } from '../db';
import { calculateFee } from '../services/ledger';
import { runSettlementSchedules } from '../services/finops/settlement';
import { sweepDisputeDeadlines } from '../services/finops/disputes';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

const balanceOf = async (auth: Record<string, string>, currency = 'USD') => ((await request(app).get('/api/wallets').set(auth)).body.items.find((w: any) => w.currency === currency)?.balance ?? 0) as number;

async function merchantPaidByWallet(merchant: Awaited<ReturnType<typeof registerUser>>, payer: Awaited<ReturnType<typeof registerUser>>, amountMinor: number, extra: Record<string, unknown> = {}) {
  const intent = await request(app).post('/api/v1/payment_intents').set(merchant.auth).send({ amount_minor: amountMinor, currency: 'USD', description: 'Order', ...extra });
  expect(intent.status, JSON.stringify(intent.body)).toBe(201);
  const paid = await request(app).post(`/api/v1/payment_intents/${intent.body.id}/pay/wallet`).set(payer.auth).send({ pin: '1234' });
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  const row = getDb().prepare('SELECT id, status, transaction_id FROM payment_intents WHERE id = ?').get(intent.body.id) as any;
  return { intentId: intent.body.id as string, transactionId: row.transaction_id as string, status: row.status as string };
}

describe('fee schedules', () => {
  it('drafts, approves (never by the author) and activates versioned schedules; resolution goes merchant > tier > country > platform > settings with floors and caps', async () => {
    const admin = await adminToken(app);
    const checker = await checkerToken(app);
    const m = await registerUser(app, { role: 'merchant', businessName: 'Tiered Shop', country: 'CD' });
    // baseline from the flat setting
    expect(calculateFee('merchant_payment', 10_000, 'USD')).toBe(150);
    const before = await request(app).get('/api/admin/finops/fees/effective').set(admin.auth).query({ type: 'merchant_payment', user: m.user.id });
    expect(before.body.resolved.source.scope).toBe('settings');

    const draft = await request(app).post('/api/admin/finops/fees/schedules').set(admin.auth).send({ scope: 'platform', rules: { merchant_payment: { fixed: 0, bps: 100, min: 50 } }, notes: 'Platform v1' });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body.status).toBe('DRAFT');
    const selfApprove = await request(app).post(`/api/admin/finops/fees/schedules/${draft.body.id}/approve`).set(admin.auth);
    expect(selfApprove.status).toBe(409);
    const notActive = await request(app).post(`/api/admin/finops/fees/schedules/${draft.body.id}/activate`).set(admin.auth);
    expect(notActive.status).toBe(409);
    const approved = await request(app).post(`/api/admin/finops/fees/schedules/${draft.body.id}/approve`).set(checker.auth);
    expect(approved.body.status).toBe('APPROVED');
    const active = await request(app).post(`/api/admin/finops/fees/schedules/${draft.body.id}/activate`).set(admin.auth);
    expect(active.body.status).toBe('ACTIVE');
    expect(calculateFee('merchant_payment', 10_000, 'USD')).toBe(100); // 1% now
    expect(calculateFee('merchant_payment', 1_000, 'USD')).toBe(50); // floor of 0.50 applies

    // a tier schedule beats the platform one for members of the tier
    await request(app).put(`/api/admin/finops/fees/tier/${m.user.id}`).set(admin.auth).send({ tier: 'gold' });
    const tier = await request(app).post('/api/admin/finops/fees/schedules').set(admin.auth).send({ scope: 'tier', scopeRef: 'gold', rules: { merchant_payment: { fixed: 0, bps: 50, max: 100 } } });
    await request(app).post(`/api/admin/finops/fees/schedules/${tier.body.id}/approve`).set(checker.auth);
    await request(app).post(`/api/admin/finops/fees/schedules/${tier.body.id}/activate`).set(admin.auth);
    expect(calculateFee('merchant_payment', 10_000, 'USD', null, { userId: m.user.id })).toBe(50);
    expect(calculateFee('merchant_payment', 100_000, 'USD', null, { userId: m.user.id })).toBe(100); // capped at 1.00
    expect(calculateFee('merchant_payment', 10_000, 'USD')).toBe(100); // others still on the platform schedule
    const mine = await request(app).get('/api/v1/fee_schedule').set(m.auth);
    expect(mine.body.tier).toBe('gold');
    expect(mine.body.data.find((f: any) => f.type === 'merchant_payment').source.scope).toBe('tier');
    // a second platform version retires the first
    const v2 = await request(app).post('/api/admin/finops/fees/schedules').set(admin.auth).send({ scope: 'platform', rules: { merchant_payment: { fixed: 0, bps: 150 } } });
    expect(v2.body.version).toBe(2);
    await request(app).post(`/api/admin/finops/fees/schedules/${v2.body.id}/approve`).set(checker.auth);
    await request(app).post(`/api/admin/finops/fees/schedules/${v2.body.id}/activate`).set(admin.auth);
    const list = await request(app).get('/api/admin/finops/fees/schedules').set(admin.auth).query({ scope: 'platform' });
    expect(list.body.items.map((s: any) => [s.version, s.status])).toEqual([[2, 'ACTIVE'], [1, 'RETIRED']]);
    expect(calculateFee('merchant_payment', 10_000, 'USD')).toBe(150);
    // clean up the tier so later merchants in this file pay the default fee
    await request(app).post(`/api/admin/finops/fees/schedules/${tier.body.id}/retire`).set(admin.auth);
    await request(app).put(`/api/admin/finops/fees/tier/${m.user.id}`).set(admin.auth).send({ tier: null });
  });
});

describe('commission ledger', () => {
  it('records every agent commission with its period and the platform share, and issues a statement', async () => {
    const admin = await adminToken(app);
    await request(app).put('/api/admin/finops/commissions/settings').set(admin.auth).send({ platformShareBps: 1000 });
    const agent = await registerUser(app, { role: 'agent', tag: 'finagent', businessName: 'Fin Agent' });
    const customer = await registerUser(app, { tag: 'fincust' });
    await fund(app, agent.user.id, '500.00');
    const cashIn = await request(app).post('/api/agents/me/cash-in').set(agent.auth).send({ customer: 'fincust', amount: '100.00', currency: 'USD', pin: '1234' });
    expect(cashIn.status, JSON.stringify(cashIn.body)).toBe(201);
    const req = await request(app).post('/api/agents/cash-out').set(customer.auth).send({ agent: 'finagent', amount: '50.00', currency: 'USD', pin: '1234' });
    const confirm = await request(app).post('/api/agents/me/cash-out/confirm').set(agent.auth).send({ code: req.body.request.code, pin: '1234' });
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(201);
    const period = new Date().toISOString().slice(0, 7);
    const st = await request(app).get(`/api/admin/finops/commissions/${agent.user.id}`).set(admin.auth).query({ period });
    expect(st.status).toBe(200);
    const kinds = st.body.entries.map((e: any) => e.kind).sort();
    expect(kinds).toEqual(['cash_in', 'cash_out']);
    expect(st.body.entries.find((e: any) => e.kind === 'cash_in').amountMinor).toBe(50); // 0.5% of 100.00
    expect(st.body.entries.find((e: any) => e.kind === 'cash_in').platformShareMinor).toBe(5); // 10% platform share
    expect(st.body.statement.totals.USD.earned).toBe(50 + 25);
    expect(st.body.statement.totals.USD.count).toBe(2);
    const overview = await request(app).get('/api/admin/finops/commissions/overview').set(admin.auth).query({ period });
    expect(overview.body.rows.some((r: any) => r.agentUserId === agent.user.id && r.kind === 'cash_out' && r.amountMinor === 25)).toBe(true);
    await request(app).put('/api/admin/finops/commissions/settings').set(admin.auth).send({ platformShareBps: 0 });
  });
});

describe('split payments', () => {
  it('validates split rules on the intent and pays each share from the merchant wallet when the intent is captured', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Market Place', country: 'CD' });
    const seller = await registerUser(app, { tag: 'seller1' });
    const courier = await registerUser(app, { tag: 'courier1' });
    const payer = await registerUser(app);
    await fund(app, payer.user.id, '100.00');
    const over = await request(app).post('/api/v1/payment_intents').set(m.auth).send({ amount_minor: 5000, currency: 'USD', splits: [{ recipient: '@seller1', bps: 6000 }, { recipient: 'courier1', bps: 5000 }] });
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe('split_over_100');
    const self = await request(app).post('/api/v1/payment_intents').set(m.auth).send({ amount_minor: 5000, currency: 'USD', splits: [{ recipient: m.user.tag, bps: 100 }] });
    expect(self.body.error.code).toBe('split_self');
    const unknown = await request(app).post('/api/v1/payment_intents').set(m.auth).send({ amount_minor: 5000, currency: 'USD', splits: [{ recipient: 'nobody-here', bps: 100 }] });
    expect(unknown.body.error.code).toBe('split_recipient_not_found');

    const { intentId } = await merchantPaidByWallet(m, payer, 5000, { splits: [{ recipient: 'seller1', bps: 2000, label: 'Seller share' }, { recipient: 'courier1', fixed_minor: 100, label: 'Delivery' }] });
    // merchant received 5000 - 1.5% fee = 4925; fixed 100 first, then 20% of the remaining 4825 = 965
    const shares = await request(app).get(`/api/v1/payment_intents/${intentId}/splits`).set(m.auth);
    expect(shares.status).toBe(200);
    expect(shares.body.data.map((s: any) => [s.label, s.amountMinor, s.status])).toEqual([['Seller share', 965, 'PAID'], ['Delivery', 100, 'PAID']]);
    expect(await balanceOf(seller.auth)).toBe(965);
    expect(await balanceOf(courier.auth)).toBe(100);
    expect(await balanceOf(m.auth)).toBe(4925 - 965 - 100);
    const tx = getDb().prepare('SELECT type, metadata FROM transactions WHERE id = ?').get(shares.body.data[0].transactionId) as any;
    expect(tx.type).toBe('distribution');
    expect(JSON.parse(tx.metadata).split).toBe(true);
    // the seller cannot read the merchant's splits
    const foreign = await request(app).get(`/api/v1/payment_intents/${intentId}/splits`).set(seller.auth);
    expect(foreign.status).toBe(403);
  });
});

describe('holds and balance classes', () => {
  it('a hold keeps money in the wallet but out of the available class until released; expired holds release themselves', async () => {
    const admin = await adminToken(app);
    const m = await registerUser(app, { role: 'merchant', businessName: 'Held Shop', country: 'CD' });
    await fund(app, m.user.id, '30.00');
    const hold = await request(app).post('/api/admin/finops/holds').set(admin.auth).send({ userId: m.user.id, currency: 'USD', amountMinor: 1000, kind: 'reserve', reason: 'Rolling reserve for a new merchant' });
    expect(hold.status, JSON.stringify(hold.body)).toBe(201);
    expect(hold.body.status).toBe('ACTIVE');
    let bal = await request(app).get('/api/v1/balance').set(m.auth);
    let usd = bal.body.data.find((d: any) => d.currency === 'USD');
    expect(usd.balance).toBe(3000);
    expect(usd.held).toBe(1000);
    expect(usd.holds.reserve).toBe(1000);
    expect(usd.available).toBe(2000);
    const mine = await request(app).get('/api/v1/holds').set(m.auth);
    expect(mine.body.data).toHaveLength(1);
    const twice = await request(app).post(`/api/admin/finops/holds/${hold.body.id}/release`).set(admin.auth).send({ reason: 'Reserve period over' });
    expect(twice.body.status).toBe('RELEASED');
    expect((await request(app).post(`/api/admin/finops/holds/${hold.body.id}/release`).set(admin.auth).send({ reason: 'again' })).status).toBe(409);
    bal = await request(app).get('/api/v1/balance').set(m.auth);
    usd = bal.body.data.find((d: any) => d.currency === 'USD');
    expect(usd.available).toBe(3000);
    // expiring hold
    const short = await request(app).post('/api/admin/finops/holds').set(admin.auth).send({ userId: m.user.id, currency: 'USD', amountMinor: 500, kind: 'review', reason: 'Risk review', expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(short.status).toBe(201);
    const expired = await request(app).post('/api/admin/finops/holds/expire').set(admin.auth);
    expect(expired.body.released).toBe(1);
    expect((await request(app).get(`/api/admin/finops/holds/${short.body.id}`).set(admin.auth)).body.status).toBe('RELEASED');
  });
});

describe('disputes', () => {
  it('opening a dispute holds the amount and marks the intent; WON releases, LOST refunds through the refund object; deadlines are swept', async () => {
    const admin = await adminToken(app);
    const m = await registerUser(app, { role: 'merchant', businessName: 'Disputed Shop', country: 'CD' });
    const payer = await registerUser(app);
    await fund(app, payer.user.id, '100.00');
    await fund(app, m.user.id, '1.00'); // the merchant covers the platform fee on a refund
    const p1 = await merchantPaidByWallet(m, payer, 2000);
    const p2 = await merchantPaidByWallet(m, payer, 3000);
    const bad = await request(app).post('/api/admin/finops/disputes').set(admin.auth).send({ transactionId: p1.transactionId, openedBy: 'customer', reasonCode: 'nope' });
    expect(bad.status).toBe(400);
    const d1 = await request(app).post('/api/admin/finops/disputes').set(admin.auth).send({ transactionId: p1.transactionId, openedBy: 'customer', reasonCode: 'not_received', reason: 'Never delivered', evidenceText: 'Customer called support' });
    expect(d1.status, JSON.stringify(d1.body)).toBe(201);
    expect(d1.body.status).toBe('OPEN');
    expect(d1.body.holdId).toMatch(/^hold_/);
    expect(d1.body.rail).toBe('wallet');
    expect(d1.body.evidence).toHaveLength(1);
    expect(getDb().prepare('SELECT status FROM payment_intents WHERE id = ?').pluck().get(p1.intentId)).toBe('DISPUTED');
    const dup = await request(app).post('/api/admin/finops/disputes').set(admin.auth).send({ transactionId: p1.transactionId, openedBy: 'customer', reasonCode: 'not_received' });
    expect(dup.status).toBe(409);
    let bal = (await request(app).get('/api/v1/balance').set(m.auth)).body.data.find((d: any) => d.currency === 'USD');
    expect(bal.disputed).toBe(2000);
    expect(bal.available).toBe(bal.balance - 2000);
    // merchant sees it, responds with evidence; the customer cannot
    const list = await request(app).get('/api/v1/disputes').set(m.auth);
    expect(list.body.data.map((d: any) => d.id)).toEqual([d1.body.id]);
    expect((await request(app).get(`/api/v1/disputes/${d1.body.id}`).set(payer.auth)).status).toBe(403);
    const resp = await request(app).post(`/api/v1/disputes/${d1.body.id}/respond`).set(m.auth).send({ response: 'Delivered and signed for on 2 March', files: ['pod-123.pdf'] });
    expect(resp.status, JSON.stringify(resp.body)).toBe(200);
    expect(resp.body.status).toBe('UNDER_REVIEW');
    expect(resp.body.evidence).toHaveLength(2);
    const won = await request(app).post(`/api/admin/finops/disputes/${d1.body.id}/decide`).set(admin.auth).send({ decision: 'WON', reason: 'Proof of delivery provided' });
    expect(won.status, JSON.stringify(won.body)).toBe(200);
    expect(won.body.status).toBe('WON');
    expect(getDb().prepare('SELECT status FROM holds WHERE id = ?').pluck().get(d1.body.holdId)).toBe('RELEASED');
    expect(getDb().prepare('SELECT status FROM payment_intents WHERE id = ?').pluck().get(p1.intentId)).toBe('SETTLED');
    const chron = await request(app).get(`/api/admin/finops/disputes/${d1.body.id}`).set(admin.auth);
    expect(chron.body.chronology.map((e: any) => e.event)).toEqual(['dispute.opened', 'dispute.evidence', 'dispute.merchant_responded', 'dispute.won']);

    // second dispute lost: the payer gets the money back through a refund object
    const payerBefore = await balanceOf(payer.auth);
    const d2 = await request(app).post('/api/admin/finops/disputes').set(admin.auth).send({ intentId: p2.intentId, openedBy: 'customer', reasonCode: 'not_as_described', amountMinor: 1000 });
    expect(d2.status, JSON.stringify(d2.body)).toBe(201);
    const evidence = await request(app).post(`/api/admin/finops/disputes/${d2.body.id}/request-evidence`).set(admin.auth).send({ note: 'Please provide the product photos' });
    expect(evidence.body.status).toBe('EVIDENCE_REQUESTED');
    const lost = await request(app).post(`/api/admin/finops/disputes/${d2.body.id}/decide`).set(admin.auth).send({ decision: 'LOST', reason: 'No evidence' });
    expect(lost.status, JSON.stringify(lost.body)).toBe(200);
    expect(lost.body.status).toBe('LOST');
    expect(lost.body.refundId).toMatch(/^re_/);
    expect(await balanceOf(payer.auth)).toBe(payerBefore + 1000);
    const refund = await request(app).get(`/api/v1/refunds/${lost.body.refundId}`).set(m.auth);
    expect(refund.body.status).toBe('SUCCEEDED');
    bal = (await request(app).get('/api/v1/balance').set(m.auth)).body.data.find((d: any) => d.currency === 'USD');
    expect(bal.disputed).toBe(0);

    // merchant-opened dispute and withdrawal; a passed deadline moves an unanswered one under review
    const p3 = await merchantPaidByWallet(m, payer, 500);
    const mine = await request(app).post('/api/v1/disputes').set(m.auth).send({ payment_intent: p3.intentId, reason_code: 'duplicate', reason: 'Customer paid twice' });
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    expect(mine.body.openedBy).toBe('merchant');
    const withdrawn = await request(app).post(`/api/v1/disputes/${mine.body.id}/withdraw`).set(m.auth);
    expect(withdrawn.body.status).toBe('WITHDRAWN');
    const p4 = await merchantPaidByWallet(m, payer, 700);
    const late = await request(app).post('/api/admin/finops/disputes').set(admin.auth).send({ intentId: p4.intentId, openedBy: 'customer', reasonCode: 'other' });
    getDb().prepare('UPDATE disputes SET deadline_at = ? WHERE id = ?').run(new Date(Date.now() - 60_000).toISOString(), late.body.id);
    expect(sweepDisputeDeadlines()).toBe(1);
    expect((await request(app).get(`/api/admin/finops/disputes/${late.body.id}`).set(admin.auth)).body.status).toBe('UNDER_REVIEW');
    const tooLate = await request(app).post(`/api/v1/disputes/${late.body.id}/respond`).set(m.auth).send({ response: 'sorry' });
    expect(tooLate.status).toBe(409);
  });
});

describe('settlement engine', () => {
  it('closes cycles net of fees, refunds, splits and holds, issues hashed statements, and pays through the withdrawal workflow', async () => {
    const admin = await adminToken(app);
    const m = await registerUser(app, { role: 'merchant', businessName: 'Settled Shop', country: 'CD' });
    await registerUser(app, { tag: 'settlepartner' });
    const payer = await registerUser(app);
    await fund(app, payer.user.id, '200.00');
    const profile = await request(app).post('/api/v1/settlement_profiles').set(m.auth).send({ currency: 'USD', schedule: 'T1', cutoff_hour_utc: 0, destination: { method: 'wallet' }, auto: true });
    expect(profile.status, JSON.stringify(profile.body)).toBe(201);
    expect((await request(app).get('/api/v1/settlement_profiles').set(m.auth)).body.data).toHaveLength(1);
    await merchantPaidByWallet(m, payer, 10_000); // fee 150
    await merchantPaidByWallet(m, payer, 4_000, { splits: [{ recipient: 'settlepartner', bps: 5000 }] }); // fee 60, split 50% of 3940 = 1970
    const hold = await request(app).post('/api/admin/finops/holds').set(admin.auth).send({ userId: m.user.id, currency: 'USD', amountMinor: 300, kind: 'compliance', reason: 'Pending document' });
    expect(hold.status).toBe(201);
    const empty = await request(app).post('/api/v1/settlement_cycles').set(m.auth).send({ currency: 'EUR' });
    expect(empty.body.status).toBe('SKIPPED');
    const cycle = await request(app).post('/api/v1/settlement_cycles').set(m.auth).send({ currency: 'USD' });
    expect(cycle.status, JSON.stringify(cycle.body)).toBe(201);
    expect(cycle.body.status).toBe('CLOSED');
    expect(cycle.body.grossMinor).toBe(14_000);
    expect(cycle.body.feesMinor).toBe(210);
    expect(cycle.body.splitsMinor).toBe(1970);
    expect(cycle.body.holdsMinor).toBe(300);
    expect(cycle.body.netMinor).toBe(14_000 - 210 - 1970 - 300);
    expect(cycle.body.itemCount).toBe(3);
    expect(cycle.body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(cycle.body.dueAt).toBeTruthy();
    const detail = await request(app).get(`/api/v1/settlement_cycles/${cycle.body.id}`).set(m.auth);
    expect(detail.body.items.map((i: any) => i.kind).sort()).toEqual(['payment', 'payment', 'split']);
    const stmt = await request(app).get(`/api/v1/settlement_cycles/${cycle.body.id}/statement`).set(m.auth);
    expect(stmt.body.number).toMatch(/^SET-\d{8}-/);
    expect(stmt.body.totals.net).toBe(cycle.body.netMinor);
    const csv = await request(app).get(`/api/v1/settlement_cycles/${cycle.body.id}/statement`).set(m.auth).query({ format: 'csv' });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Gross 140.00');
    const pdf = await request(app).get(`/api/v1/settlement_cycles/${cycle.body.id}/statement`).set(m.auth).query({ format: 'pdf' }).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    // a second close with nothing new is skipped; the webhook event was recorded
    expect((await request(app).post('/api/v1/settlement_cycles').set(m.auth).send({ currency: 'USD' })).body.status).toBe('SKIPPED');
    const events = await request(app).get('/api/v1/events').set(m.auth);
    expect(events.body.data.some((e: any) => e.type === 'payment_intent.settled')).toBe(true);
    // obligations list it until it is paid; wallet destination just marks it paid
    const obl = await request(app).get('/api/admin/finops/settlements/obligations').set(admin.auth).query({ user: m.user.id });
    expect(obl.body.byCurrency.USD.count).toBe(1);
    const paid = await request(app).post(`/api/v1/settlement_cycles/${cycle.body.id}/pay`).set(m.auth).send({});
    expect(paid.body.status).toBe('PAID');
    expect((await request(app).get('/api/admin/finops/settlements/obligations').set(admin.auth).query({ user: m.user.id })).body.byCurrency.USD).toBeUndefined();

    // bank destination: the cycle is paid through a withdrawal under maker-checker and mirrors its outcome
    const bank = await request(app).post('/api/bank-accounts').set(m.auth).send({ bankName: 'Rawbank', accountName: 'Settled Shop', accountNumber: '00112233', currency: 'USD', pin: '1234' });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    const bankProfile = await request(app).post('/api/v1/settlement_profiles').set(m.auth).send({ currency: 'USD', schedule: 'T0', destination: { method: 'bank', bankAccountId: bank.body.bankAccount.id } });
    expect(bankProfile.body.id).toBe(profile.body.id); // one profile per rail and currency, updated in place
    await merchantPaidByWallet(m, payer, 2_000); // fee 30
    const c2 = await request(app).post('/api/admin/finops/settlements/cycles').set(admin.auth).send({ userId: m.user.id, currency: 'USD', pay: true });
    expect(c2.status, JSON.stringify(c2.body)).toBe(201);
    expect(c2.body.status).toBe('PAYING');
    expect(c2.body.netMinor).toBe(2_000 - 30 - 300); // the compliance hold still applies
    expect(c2.body.withdrawalTransactionId).toBeTruthy();
    const settlementRow = getDb().prepare('SELECT status FROM settlements WHERE id = ?').get(c2.body.settlementId) as any;
    expect(settlementRow.status).toBe('pending');
    await decideWithdrawal(app, c2.body.withdrawalTransactionId, 'approve');
    const after = await request(app).get(`/api/admin/finops/settlements/cycles/${c2.body.id}`).set(admin.auth);
    expect(after.body.status).toBe('PAID');
    expect(after.body.paidAt).toBeTruthy();
    expect((getDb().prepare('SELECT status FROM settlements WHERE id = ?').get(c2.body.settlementId) as any).status).toBe('paid');
    const cal = await request(app).get('/api/v1/settlement_calendar').set(m.auth);
    expect(cal.body.upcoming[0].schedule).toBe('T0');
    expect(cal.body.recent.length).toBeGreaterThanOrEqual(3);
    // the scheduler closes at each auto profile's cut-off once per business day; T+1 cycles are not paid before their due date
    const m2 = await registerUser(app, { role: 'merchant', businessName: 'Scheduled Shop', country: 'CD' });
    await request(app).post('/api/v1/settlement_profiles').set(m2.auth).send({ currency: 'USD', schedule: 'T1', cutoff_hour_utc: 0, destination: { method: 'wallet' }, auto: true });
    await merchantPaidByWallet(m2, payer, 1_000);
    const run = runSettlementSchedules(new Date());
    expect(run.closed).toBeGreaterThanOrEqual(1);
    const scheduled = (await request(app).get('/api/v1/settlement_cycles').set(m2.auth)).body.data;
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].status).toBe('CLOSED');
    expect(scheduled[0].netMinor).toBe(1_000 - 15);
    const rerun = runSettlementSchedules(new Date());
    expect(rerun.closed).toBe(0); // one close per profile and business day
    expect((await request(app).get('/api/v1/settlement_cycles').set(m2.auth)).body.data).toHaveLength(1);
  });
});

describe('processor reconciliation workbench', () => {
  it('matches a processor statement three ways (statement ↔ gateway payment ↔ ledger) and opens cases for every discrepancy', async () => {
    const admin = await adminToken(app);
    const u = await registerUser(app, { country: 'KE' });
    const card = await request(app).post('/api/deposits').set(u.auth).send({ method: 'card', amount: '25', currency: 'USD', pin: '1234', card: { number: '4242424242424242', expMonth: 12, expYear: 2030, cvc: '123', holderName: 'Kim Test' } });
    expect(card.body.payment.stage).toBe('SETTLED');
    const gp = getDb().prepare('SELECT gateway, provider_ref, amount, fee, currency FROM gateway_payments WHERE id = ?').get(card.body.payment.id) as any;
    expect(gp.provider_ref).toBeTruthy();
    const day = new Date().toISOString().slice(0, 10);
    const lines = [
      { reference: gp.provider_ref, amountMinor: gp.amount, currency: 'USD', status: 'SETTLED', feeMinor: gp.fee },
      { reference: 'ghost-ref-1', amountMinor: 999, currency: 'USD', status: 'SETTLED' },
    ];
    const wrongTotal = await request(app).post(`/api/admin/finops/reconciliation/processors/${gp.gateway}/statements`).set(admin.auth).send({ cycleRef: day, currency: 'USD', lines, controlTotalMinor: 1 });
    expect(wrongTotal.status).toBe(400);
    expect(wrongTotal.body.error.code).toBe('control_total_mismatch');
    const imp = await request(app).post(`/api/admin/finops/reconciliation/processors/${gp.gateway}/statements`).set(admin.auth).send({ cycleRef: day, currency: 'USD', lines, controlTotalMinor: gp.amount + 999, run: true });
    expect(imp.status, JSON.stringify(imp.body)).toBe(201);
    expect(imp.body.import.duplicate).toBe(false);
    expect(imp.body.import.lineCount).toBe(2);
    expect(imp.body.run.matched).toBe(1);
    expect(imp.body.run.complete).toBe(true);
    expect(imp.body.run.casesOpened).toBeGreaterThanOrEqual(1);
    const again = await request(app).post(`/api/admin/finops/reconciliation/processors/${gp.gateway}/statements`).set(admin.auth).send({ cycleRef: day, currency: 'USD', lines });
    expect(again.body.import.duplicate).toBe(true);
    const wb = await request(app).get('/api/admin/finops/reconciliation/workbench').set(admin.auth);
    expect(wb.status).toBe(200);
    const ghost = wb.body.openCases.find((c: any) => c.class === 'EXTERNAL_ONLY' && c.references?.reference === 'ghost-ref-1');
    expect(ghost).toBeTruthy();
    expect(ghost.connectionId).toBe(`gateway:${gp.gateway}`);
    expect(wb.body.exceptions.some((e: any) => e.connectionId === `gateway:${gp.gateway}`)).toBe(true);
    expect(wb.body.recentRuns[0].cycleRef).toBe(day);
    // a settled payment the statement does not mention is flagged on the next run of the same cycle
    const card2 = await request(app).post('/api/deposits').set(u.auth).send({ method: 'card', amount: '10', currency: 'USD', pin: '1234', card: { number: '4242424242424242', expMonth: 12, expYear: 2030, cvc: '123', holderName: 'Kim Test' } });
    const run2 = await request(app).post(`/api/admin/finops/reconciliation/processors/${gp.gateway}/run`).set(admin.auth).send({ cycleRef: day });
    expect(run2.status).toBe(200);
    const cases = await request(app).get('/api/admin/switch/cases').set(admin.auth).query({ class: 'SETTLEMENT_NOT_OBSERVED' });
    expect(cases.body.data.some((c: any) => c.paymentId === card2.body.payment.id)).toBe(true);
  });
});
