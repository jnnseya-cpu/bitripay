/**
 * Module 15: open banking — linking under consent through the sandbox bank's hosted authorisation, statement import,
 * income verification feeding credit readiness, pay by bank through the payments pipeline, and VRP mandates that top
 * up a short wallet for subscription billing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, adminToken, fund } from './helpers';
import { reconcileLedger, calculateFee } from '../services/ledger';
import { computeReadiness } from '../services/creditReadiness';

let app: ReturnType<typeof setupApp>;
beforeAll(() => { app = setupApp(); });
const balanceOf = async (auth: Record<string, string>, currency = 'USD') => ((await request(app).get('/api/wallets').set(auth)).body.items.find((w: any) => w.currency === currency)?.balance ?? 0) as number;

describe('open banking', () => {
  it('links a bank through hosted authorisation, imports six months of statements, verifies income and feeds the readiness signal', async () => {
    const u = await registerUser(app, { country: 'CD' });
    const insts = await request(app).get('/api/open-banking/institutions?country=CD').set(u.auth);
    expect(insts.body.items.map((i: any) => i.id)).toContain('sbx-rawbank');
    // declined at the bank
    const declined = await request(app).post('/api/open-banking/links').set(u.auth).send({ institutionId: 'sbx-rawbank' });
    expect(declined.status, JSON.stringify(declined.body)).toBe(201);
    expect(declined.body.link.status).toBe('PENDING');
    expect(declined.body.link.authUrl).toContain(`/api/open-banking/sandbox/authorise/${declined.body.link.id}`);
    const page = await request(app).get(`/api/open-banking/sandbox/authorise/${declined.body.link.id}`);
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/Approve/);
    expect((await request(app).post(`/api/open-banking/sandbox/authorise/${declined.body.link.id}`).send({ decision: 'declined' })).body.link.status).toBe('DECLINED');
    // approved: accounts, statement, income
    const link = await request(app).post('/api/open-banking/links').set(u.auth).send({ institutionId: 'sbx-rawbank' });
    const done = await request(app).post(`/api/open-banking/sandbox/authorise/${link.body.link.id}`).send({ decision: 'approved' });
    expect(done.body.link.status).toBe('LINKED');
    expect(done.body.link.accounts.map((a: any) => a.currency)).toEqual(['CDF', 'USD']);
    expect(done.body.link.transactionCount).toBeGreaterThan(80);
    expect((await request(app).post(`/api/open-banking/links/${link.body.link.id}/sync`).set(u.auth)).body.link.imported).toBe(0);
    const tx = await request(app).get(`/api/open-banking/transactions?link=${link.body.link.id}&limit=5`).set(u.auth);
    expect(tx.body.items).toHaveLength(5);
    const income = (await request(app).get('/api/open-banking/income').set(u.auth)).body.income;
    expect(income.confidence).toBe('high');
    expect(income.monthlyIncomeBase).toBeGreaterThan(0);
    expect(income.streams.some((s: any) => s.label.includes('EMPLOYER') && s.regular)).toBe(true);
    const r = computeReadiness(u.user.id);
    expect(r.signals.find((s) => s.key === 'verified_income')!.points).toBe(100);
    // consent revoked: mandates die with it and the transactions stop feeding the report
    expect((await request(app).delete(`/api/open-banking/links/${link.body.link.id}`).set(u.auth)).body.link.status).toBe('REVOKED');
    expect((await request(app).get('/api/open-banking/income?refresh=1').set(u.auth)).body.income.confidence).toBe('none');
  });

  it('imports a CSV statement as real bank data and verifies the recurring income in it', async () => {
    const u = await registerUser(app, { country: 'GB' });
    const months = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
    const rows = ['date,description,amount', ...months.flatMap((m) => [`${m}-28,ACME LTD SALARY,1500.00`, `${m}-01,RENT,-650.00`, `${m}-10,TESCO,-82.40`]), 'bad-date,OOPS,x'].join('\n');
    const imp = await request(app).post('/api/open-banking/statements').set(u.auth).send({ institutionName: 'My High Street Bank', currency: 'GBP', csv: rows });
    expect(imp.status, JSON.stringify(imp.body)).toBe(201);
    expect(imp.body.link).toMatchObject({ provider: 'statement_import', status: 'LINKED', imported: 15, rejected: 1 });
    const income = (await request(app).get('/api/open-banking/income').set(u.auth)).body.income;
    expect(['medium', 'high']).toContain(income.confidence);
    const salary = income.streams.find((s: any) => s.label.startsWith('ACME'));
    expect(salary).toMatchObject({ currency: 'GBP', months: 5, medianMinor: 150000, regular: true });
    expect(income.monthlyIncomeBase).toBe(salary.monthlyBaseMinor);
    // a statement import cannot pay: no mandate on it
    const link = imp.body.link;
    expect((await request(app).post('/api/open-banking/mandates').set(u.auth).send({ linkId: link.id, accountId: link.accounts[0].id, purpose: 'top_up', maxPerPayment: '100', maxPerMonth: '300', pin: '1234' })).body.error.code).toBe('provider_unavailable');
  });

  it('pays by bank from a linked account through the payments pipeline, and a VRP mandate tops up a short wallet for billing', async () => {
    const u = await registerUser(app, { country: 'CD' });
    const link = await request(app).post('/api/open-banking/links').set(u.auth).send({ institutionId: 'sbx-rawbank' });
    const linked = (await request(app).post(`/api/open-banking/links/${link.body.link.id}/complete`).set(u.auth).send({ decision: 'approved' })).body.link;
    const usd = linked.accounts.find((a: any) => a.currency === 'USD');
    // pay by bank: an ordinary deposit on the open banking gateway, settled immediately
    const options = await request(app).get('/api/deposits/options?currency=USD').set(u.auth);
    expect(options.body.methods.find((m: any) => m.method === 'bank').gateways.map((g: any) => g.id)).toContain('open_banking');
    const dep = await request(app).post('/api/deposits').set(u.auth).send({ pin: '1234', method: 'bank', gateway: 'open_banking', amount: '50.00', currency: 'USD' });
    expect(dep.status, JSON.stringify(dep.body)).toBe(201);
    expect(dep.body.payment.status).toBe('succeeded');
    expect(await balanceOf(u.auth)).toBe(5000 - calculateFee('bank_deposit', 5000, 'USD'));
    const after = (await request(app).get('/api/open-banking/links').set(u.auth)).body.items.find((l: any) => l.id === linked.id);
    expect(after.accounts.find((a: any) => a.id === usd.id).balanceMinor).toBe(usd.balanceMinor - 5000);
    // more than the bank holds: refused by the bank, nothing credited
    const big = await request(app).post('/api/deposits').set(u.auth).send({ pin: '1234', method: 'bank', gateway: 'open_banking', amount: '999999.00', currency: 'USD' });
    expect(big.body.payment.status).toBe('failed');
    expect(big.body.payment.failureReason).toMatch(/Insufficient funds at the bank/);
    // a billing mandate (step-up) lets a subscription draw the shortfall from the bank
    expect((await request(app).post('/api/open-banking/mandates').set(u.auth).send({ linkId: linked.id, accountId: usd.id, purpose: 'billing', maxPerPayment: '40', maxPerMonth: '100' })).status).toBe(403);
    const mandate = await request(app).post('/api/open-banking/mandates').set(u.auth).send({ linkId: linked.id, accountId: usd.id, purpose: 'billing', maxPerPayment: '40', maxPerMonth: '100', pin: '1234' });
    expect(mandate.status, JSON.stringify(mandate.body)).toBe(201);
    expect(mandate.body.mandate).toMatchObject({ status: 'ACTIVE', maxPerPaymentMinor: 4000, maxPerMonthMinor: 10000, usedThisMonthMinor: 0 });
    const m = await registerUser(app, { role: 'merchant', businessName: 'Kin Gym', country: 'CD' });
    const plan = await request(app).post('/api/v1/plans').set(m.auth).send({ name: 'Gym monthly', currency: 'USD', amount_minor: 7000, interval: 'month' });
    const before = await balanceOf(u.auth); // ~49.xx, short of 70.00
    const sub = await request(app).post('/api/billing/subscriptions').set(u.auth).send({ plan: plan.body.plan.code, pin: '1234' });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    expect(sub.body.invoice.status).toBe('PAID');
    const mandates = (await request(app).get('/api/open-banking/mandates').set(u.auth)).body.items;
    expect(mandates[0].usedThisMonthMinor).toBeGreaterThanOrEqual(7000 - before);
    expect(mandates[0].usedThisMonthMinor).toBeLessThanOrEqual(4000);
    expect(await balanceOf(u.auth)).toBeGreaterThanOrEqual(0);
    // the second month exceeds what the mandate allows (per-payment limit): the invoice fails and dunning starts
    const plan2 = await request(app).post('/api/v1/plans').set(m.auth).send({ name: 'Gym premium', currency: 'USD', amount_minor: 20000, interval: 'month' });
    const sub2 = await request(app).post('/api/billing/subscriptions').set(u.auth).send({ plan: plan2.body.plan.code, pin: '1234' });
    expect(sub2.body.invoice.status).toBe('FAILED');
    expect(sub2.body.subscription.status).toBe('PAST_DUE');
    const admin = await adminToken(app);
    const ov = await request(app).get('/api/admin/growth/open-banking').set(admin.auth);
    expect(ov.status).toBe(200);
    expect(ov.body.links.some((l: any) => l.id === linked.id)).toBe(true);
    expect(ov.body.payments.filter((p: any) => p.mandateId === mandate.body.mandate.id && p.status === 'succeeded')).toHaveLength(1);
    expect(JSON.stringify(ov.body)).not.toMatch(/sbx-consent/);
    // revoking the link ends the mandate and pay by bank
    await request(app).delete(`/api/open-banking/links/${linked.id}`).set(u.auth);
    expect((await request(app).get('/api/open-banking/mandates').set(u.auth)).body.items[0].status).toBe('REVOKED');
    const gone = await request(app).post('/api/deposits').set(u.auth).send({ pin: '1234', method: 'bank', gateway: 'open_banking', amount: '5.00', currency: 'USD' });
    expect(gone.body.payment.status).toBe('failed');
    expect(gone.body.payment.failureReason).toMatch(/No linked bank account/);
    expect(reconcileLedger().ok).toBe(true);
    void fund;
  });
});
