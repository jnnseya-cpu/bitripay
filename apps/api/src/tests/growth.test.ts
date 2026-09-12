/**
 * Modules 11, 13 and 16: FX alerts, auto-convert rules and forwards; credit readiness with consented lender access;
 * merchant subscription plans, mandates, invoices with tax and usage, dunning and cancellation.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, adminToken, fund } from './helpers';
import { getDb } from '../db';
import { reconcileLedger } from '../services/ledger';
import { checkFxAlerts, runSweepRules, runForwards, currentRate } from '../services/fxTools';
import { listCurrencies, upsertCurrency } from '../services/currencies';
import { runBilling, DUNNING_DAYS } from '../services/billing';
import { computeReadiness } from '../services/creditReadiness';

let app: ReturnType<typeof setupApp>;
beforeAll(() => { app = setupApp(); });
const balanceOf = async (auth: Record<string, string>, currency = 'USD') => ((await request(app).get('/api/wallets').set(auth)).body.items.find((w: any) => w.currency === currency)?.balance ?? 0) as number;
const tomorrow = (days = 1) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe('FX engine tools', () => {
  it('fires rate alerts once when the reference rate crosses the target', async () => {
    const u = await registerUser(app);
    const mid = currentRate('USD', 'EUR').midRate;
    const hit = await request(app).post('/api/fx-tools/alerts').set(u.auth).send({ baseCurrency: 'USD', quoteCurrency: 'EUR', direction: 'above', targetRate: mid * 0.9 });
    const wait = await request(app).post('/api/fx-tools/alerts').set(u.auth).send({ baseCurrency: 'USD', quoteCurrency: 'EUR', direction: 'above', targetRate: mid * 1.5, note: 'sell dollars' });
    expect(hit.status, JSON.stringify(hit.body)).toBe(201);
    expect(wait.status).toBe(201);
    expect((await request(app).post('/api/fx-tools/alerts').set(u.auth).send({ baseCurrency: 'USD', quoteCurrency: 'USD', direction: 'above', targetRate: 1 })).status).toBe(400);
    const first = checkFxAlerts();
    expect(first.triggered).toBe(1);
    expect(checkFxAlerts().triggered).toBe(0); // fires once
    const view = await request(app).get('/api/fx-tools').set(u.auth);
    const a = view.body.alerts.find((x: any) => x.id === hit.body.alert.id);
    expect(a.status).toBe('TRIGGERED');
    expect(a.triggeredRate).toBeCloseTo(mid, 6);
    expect(view.body.alerts.find((x: any) => x.id === wait.body.alert.id).status).toBe('ACTIVE');
    // the rate moves: the waiting alert fires
    const eur = listCurrencies(false).find((c) => c.code === 'EUR')!;
    upsertCurrency({ code: 'EUR', name: eur.name, symbol: eur.symbol, decimals: eur.decimals, rateToBase: eur.rateToBase * 1.6, enabled: true });
    expect(checkFxAlerts().triggered).toBe(1);
    upsertCurrency({ code: 'EUR', name: eur.name, symbol: eur.symbol, decimals: eur.decimals, rateToBase: eur.rateToBase, enabled: true });
    const notif = await request(app).get('/api/account/notifications').set(u.auth);
    expect(notif.body.items.filter((n: any) => n.title.includes('USD/EUR'))).toHaveLength(2);
  });

  it('auto-converts a share of receipts and sweeps balances above a floor, only above the rate floor the account holder set', async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await fund(app, a.user.id, '500.00');
    // a standing conversion instruction is step-up protected
    expect((await request(app).post('/api/fx-tools/rules').set(b.auth).send({ fromCurrency: 'USD', toCurrency: 'EUR', kind: 'on_receipt', shareBps: 5000 })).status).toBe(403);
    const rule = await request(app).post('/api/fx-tools/rules').set(b.auth).send({ fromCurrency: 'USD', toCurrency: 'EUR', kind: 'on_receipt', shareBps: 5000, pin: '1234' });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    expect((await request(app).post('/api/fx-tools/rules').set(b.auth).send({ fromCurrency: 'USD', toCurrency: 'EUR', kind: 'on_receipt', shareBps: 2000, pin: '1234' })).body.error.code).toBe('rule_exists');
    const t = await request(app).post('/api/transfers').set(a.auth).send({ to: b.user.tag, amount: '100.00', currency: 'USD', pin: '1234' });
    expect(t.status).toBe(201);
    const eur = await balanceOf(b.auth, 'EUR');
    expect(eur).toBeGreaterThan(0);
    const usd = await balanceOf(b.auth, 'USD');
    expect(usd).toBeLessThan(5000 + 1); // half converted plus the exchange fee
    const rules = (await request(app).get('/api/fx-tools').set(b.auth)).body.rules;
    expect(rules[0]).toMatchObject({ runs: 1, convertedMinor: 5000, lastError: null });
    // a rate floor above the market blocks the rule and says why
    await request(app).post(`/api/fx-tools/rules/${rule.body.rule.id}/delete`).set(b.auth);
    const floored = await request(app).post('/api/fx-tools/rules').set(b.auth).send({ fromCurrency: 'USD', toCurrency: 'EUR', kind: 'on_receipt', shareBps: 10000, minRate: 99, pin: '1234' });
    await request(app).post('/api/transfers').set(a.auth).send({ to: b.user.tag, amount: '10.00', currency: 'USD', pin: '1234' });
    const after = (await request(app).get('/api/fx-tools').set(b.auth)).body.rules.find((r: any) => r.id === floored.body.rule.id);
    expect(after.runs).toBe(0);
    expect(after.lastError).toMatch(/below your floor/);
    expect(await balanceOf(b.auth, 'EUR')).toBe(eur);
    // sweep: keep 20.00 USD, convert the rest
    await request(app).post(`/api/fx-tools/rules/${floored.body.rule.id}/pause`).set(b.auth);
    const sweep = await request(app).post('/api/fx-tools/rules').set(b.auth).send({ fromCurrency: 'USD', toCurrency: 'EUR', kind: 'sweep', keep: '20.00', pin: '1234' });
    expect(sweep.status, JSON.stringify(sweep.body)).toBe(201);
    const before = await balanceOf(b.auth, 'USD');
    const r = runSweepRules();
    expect(r.converted).toBe(1);
    const left = await balanceOf(b.auth, 'USD');
    expect(left).toBeGreaterThanOrEqual(2000);
    expect(left).toBeLessThan(before);
    expect(left - 2000).toBeLessThan(100); // only the exchange fee rounding stays above the floor
    expect(runSweepRules().converted).toBe(0); // nothing above the floor now
    expect(reconcileLedger().ok).toBe(true);
  });

  it('locks a forward rate with the money ring-fenced, settles at the locked rate whatever the market does, and caps tenor', async () => {
    const u = await registerUser(app);
    await fund(app, u.user.id, '300.00');
    const q = await request(app).get(`/api/fx-tools/forwards/quote?from=USD&to=EUR&amount=200&settleOn=${tomorrow(5)}`).set(u.auth);
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    const spot = currentRate('USD', 'EUR');
    expect(q.body.rate).toBeLessThan(spot.rate);
    expect(q.body.rate).toBeCloseTo(spot.rate * (1 - q.body.forwardBps / 10_000), 8);
    expect(q.body.disclosure).toMatch(/forward margin/);
    expect((await request(app).get(`/api/fx-tools/forwards/quote?from=USD&to=EUR&amount=200&settleOn=${tomorrow(90)}`).set(u.auth)).body.error.code).toBe('tenor_too_long');
    expect((await request(app).get(`/api/fx-tools/forwards/quote?from=USD&to=EUR&amount=200&settleOn=${tomorrow(0)}`).set(u.auth)).body.error.code).toBe('invalid_date');
    const locked = await request(app).post('/api/fx-tools/forwards').set(u.auth).send({ fromCurrency: 'USD', toCurrency: 'EUR', amount: '200.00', settleOn: tomorrow(5), pin: '1234' });
    expect(locked.status, JSON.stringify(locked.body)).toBe(201);
    const f = locked.body.forward;
    expect(f.status).toBe('LOCKED');
    expect(f.receiveMinor).toBe(q.body.receiveMinor);
    // the 200.00 (+ fee) is ring-fenced: the balance shows 300.00 but only the rest can be spent
    expect(await balanceOf(u.auth)).toBe(30000);
    const other = await registerUser(app);
    const spend = await request(app).post('/api/transfers').set(u.auth).send({ to: other.user.tag, amount: '150.00', currency: 'USD', pin: '1234' });
    expect(spend.status).toBe(422);
    expect(spend.body.error.code).toBe('insufficient_funds');
    expect((await request(app).post('/api/transfers').set(u.auth).send({ to: other.user.tag, amount: '50.00', currency: 'USD', pin: '1234' })).status).toBe(201);
    // not due yet; the market moves against the platform; an administrator settles early at the locked rate
    expect((await request(app).post(`/api/fx-tools/forwards/${f.id}/settle`).set(u.auth)).body.error.code).toBe('forward_not_due');
    const eur = listCurrencies(false).find((c) => c.code === 'EUR')!;
    upsertCurrency({ code: 'EUR', name: eur.name, symbol: eur.symbol, decimals: eur.decimals, rateToBase: eur.rateToBase * 0.7, enabled: true });
    const admin = await adminToken(app);
    const settled = await request(app).post(`/api/admin/growth/fx/forwards/${f.id}/settle`).set(admin.auth);
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect(settled.body.forward.status).toBe('SETTLED');
    upsertCurrency({ code: 'EUR', name: eur.name, symbol: eur.symbol, decimals: eur.decimals, rateToBase: eur.rateToBase, enabled: true });
    expect(await balanceOf(u.auth, 'EUR')).toBe(f.receiveMinor);
    const usdLeft = await balanceOf(u.auth, 'USD');
    expect(usdLeft).toBeLessThan(30000 - 5000 - 20000 + 1);
    expect((getDb().prepare("SELECT COUNT(*) c FROM holds WHERE ref_type = 'fx_forward' AND ref_id = ? AND status = 'ACTIVE'").get(f.id) as any).c).toBe(0);
    // a second forward can be cancelled, releasing the hold; the daily job leaves it alone
    const second = await request(app).post('/api/fx-tools/forwards').set(u.auth).send({ fromCurrency: 'USD', toCurrency: 'EUR', amount: '10.00', settleOn: tomorrow(2), pin: '1234' });
    expect(second.status).toBe(201);
    expect(runForwards()).toEqual({ settled: 0, expired: 0 });
    const cancelled = await request(app).post(`/api/fx-tools/forwards/${second.body.forward.id}/cancel`).set(u.auth);
    expect(cancelled.body.forward.status).toBe('CANCELLED');
    expect((getDb().prepare("SELECT COUNT(*) c FROM holds WHERE ref_type = 'fx_forward' AND status = 'ACTIVE'").get() as any).c).toBe(0);
    const book = await request(app).get('/api/admin/growth/fx').set(admin.auth);
    expect(book.body.forwards.some((x: any) => x.id === f.id && x.status === 'SETTLED')).toBe(true);
    expect(reconcileLedger().ok).toBe(true);
  });
});

describe('credit readiness', () => {
  it('scores from the ledger with explained factors, improves with income, savings and commitments, and reaches lenders only through consent', async () => {
    const fresh = await registerUser(app);
    const r0 = (await request(app).get('/api/credit').set(fresh.auth)).body.readiness;
    expect(r0.band).toBe('building');
    expect(r0.score).toBeLessThan(200);
    expect(r0.signals.map((s: any) => s.key)).toEqual(['income_regularity', 'spend_discipline', 'savings', 'balance_stability', 'account', 'commitments', 'conduct', 'verified_income']);
    expect(r0.tips.length).toBeGreaterThan(2);
    // an account with income, savings and paid commitments
    const payer = await registerUser(app);
    const saver = await registerUser(app);
    await fund(app, payer.user.id, '1000.00');
    const goal = await request(app).post('/api/savings/goals').set(saver.auth).send({ name: 'Buffer', currency: 'USD', makeDefault: true });
    await request(app).put('/api/savings/settings').set(saver.auth).send({ autoAnchor: true, anchorBps: 1500 });
    await request(app).post('/api/transfers').set(payer.auth).send({ to: saver.user.tag, amount: '300.00', currency: 'USD', pin: '1234' });
    await request(app).post('/api/transfers').set(saver.auth).send({ to: payer.user.tag, amount: '40.00', currency: 'USD', pin: '1234' });
    getDb().prepare("UPDATE users SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 120 * 86_400_000).toISOString(), saver.user.id);
    const r1 = computeReadiness(saver.user.id);
    expect(r1.score).toBeGreaterThan(r0.score + 150);
    expect(r1.signals.find((s) => s.key === 'savings')!.points).toBeGreaterThan(0);
    expect(r1.signals.find((s) => s.key === 'spend_discipline')!.points).toBe(180);
    expect(['fair', 'good', 'strong']).toContain(r1.band);
    void goal;
    // consent: the lender reads the signal with a key holding credit:read; revocation closes the door
    const lender = await registerUser(app, { role: 'merchant', businessName: 'Kivu Microfinance', country: 'CD' });
    const key = await request(app).post('/api/v1/api_keys').set(lender.auth).send({ label: 'scoring', mode: 'test', kind: 'restricted', scopes: ['credit:read'] });
    const k = { Authorization: `Bearer ${key.body.secret}` };
    expect((await request(app).post('/api/credit/consents').set(saver.auth).send({ lenderName: 'Kivu Microfinance', purpose: 'stock loan' })).status).toBe(403); // step-up
    const consent = await request(app).post('/api/credit/consents').set(saver.auth).send({ lenderName: 'Kivu Microfinance', purpose: 'stock loan', days: 30, pin: '1234' });
    expect(consent.status, JSON.stringify(consent.body)).toBe(201);
    const code = consent.body.consent.accessCode;
    const seen = await request(app).get(`/api/v1/credit_readiness/${code}`).set(k);
    expect(seen.status, JSON.stringify(seen.body)).toBe(200);
    expect(seen.body.score).toBe(r1.score);
    expect(seen.body.subject.reference).toBe(saver.user.tag);
    expect(seen.body.disclaimer).toMatch(/does not lend/);
    expect(JSON.stringify(seen.body)).not.toMatch(/transactions|amountMinor/);
    expect((await request(app).get('/api/v1/credit_readiness/CR-NOPE-NOPE').set(k)).status).toBe(404);
    const mine = (await request(app).get('/api/credit').set(saver.auth)).body.consents[0];
    expect(mine.accessCount).toBe(1);
    await request(app).delete(`/api/credit/consents/${consent.body.consent.id}`).set(saver.auth);
    expect((await request(app).get(`/api/v1/credit_readiness/${code}`).set(k)).body.error.code).toBe('consent_revoked');
  });
});

describe('subscriptions and billing', () => {
  it('bills plans with tax and metered usage per period, retries failed collections on the dunning schedule, and cancels cleanly', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Kinshasa Fibre', country: 'CD' });
    const c = await registerUser(app);
    await fund(app, c.user.id, '40.00');
    const plan = await request(app).post('/api/v1/plans').set(m.auth).send({ name: 'Home 20 Mbps', currency: 'USD', amount_minor: 1000, interval: 'month', tax_bps: 1600, tax_label: 'VAT', usage_unit: 'GB', usage_price_minor: 50 });
    expect(plan.status, JSON.stringify(plan.body)).toBe(201);
    const code = plan.body.plan.code;
    expect((await request(app).get(`/api/billing/plans/${code}`).set(c.auth)).body.plan.amountMinor).toBe(1000);
    // the mandate is step-up protected
    expect((await request(app).post('/api/billing/subscriptions').set(c.auth).send({ plan: code })).status).toBe(403);
    const sub = await request(app).post('/api/billing/subscriptions').set(c.auth).send({ plan: code, pin: '1234' });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    expect(sub.body.subscription.status).toBe('ACTIVE');
    expect(sub.body.invoice).toMatchObject({ status: 'PAID', subtotalMinor: 1000, taxMinor: 160, totalMinor: 1160 });
    expect(await balanceOf(c.auth)).toBe(4000 - 1160);
    expect(await balanceOf(m.auth)).toBeGreaterThan(1000); // merchant payment, fee on the receiver
    expect((await request(app).post('/api/billing/subscriptions').set(c.auth).send({ plan: code, pin: '1234' })).body.error.code).toBe('already_subscribed');
    // usage during the period, then the next period is collected with it
    const id = sub.body.subscription.id;
    expect((await request(app).post(`/api/v1/subscriptions/${id}/usage`).set(m.auth).send({ quantity: 12 })).body.subscription.usageQty).toBe(12);
    const periodEnd = new Date(sub.body.subscription.currentPeriodEnd);
    const run1 = await runBilling(new Date(periodEnd.getTime() + 1000));
    expect(run1).toMatchObject({ collected: 1, failed: 0 });
    const invoices = (await request(app).get(`/api/v1/subscriptions/${id}`).set(m.auth)).body.invoices;
    expect(invoices[0]).toMatchObject({ status: 'PAID', usageQty: 12, usageMinor: 600, subtotalMinor: 1000, taxMinor: 256, totalMinor: 1856 });
    expect(await balanceOf(c.auth)).toBe(4000 - 1160 - 1856);
    // third period: the wallet is short → dunning
    const s2 = (await request(app).get(`/api/v1/subscriptions/${id}`).set(m.auth)).body.subscription;
    let at = new Date(Date.parse(s2.currentPeriodEnd) + 1000);
    const run2 = await runBilling(at);
    expect(run2).toMatchObject({ collected: 0, failed: 1 });
    let s3 = (await request(app).get(`/api/billing/subscriptions/${id}`).set(c.auth)).body.subscription;
    expect(s3.status).toBe('PAST_DUE');
    expect(s3.dunningAttempts).toBe(1);
    expect(Date.parse(s3.nextChargeAt) - Date.now()).toBeGreaterThan(0.9 * DUNNING_DAYS[0] * 86_400_000);
    const notif = await request(app).get('/api/account/notifications').set(c.auth);
    expect(notif.body.items.some((n: any) => n.title.includes('payment failed'))).toBe(true);
    // every retry fails until the schedule is exhausted, then the subscription cancels and the invoice is voided
    let runs = 0;
    while (s3.status === 'PAST_DUE' && runs < 6) {
      at = new Date(Date.parse(s3.nextChargeAt) + 1000);
      await runBilling(at);
      s3 = (await request(app).get(`/api/billing/subscriptions/${id}`).set(c.auth)).body.subscription;
      runs += 1;
    }
    expect(runs).toBe(DUNNING_DAYS.length);
    expect(s3.status).toBe('CANCELLED');
    const failedInvoice = (await request(app).get(`/api/v1/subscriptions/${id}`).set(m.auth)).body.invoices[0];
    expect(failedInvoice.status).toBe('VOID');
    expect(failedInvoice.attempts).toBe(DUNNING_DAYS.length + 1);
    // a trial plan charges nothing until the trial ends; cancel-at-period-end ends without a charge
    const trial = await request(app).post('/api/v1/plans').set(m.auth).send({ name: 'Starter', currency: 'USD', amount_minor: 500, interval: 'week', trial_days: 7 });
    const c2 = await registerUser(app);
    await fund(app, c2.user.id, '10.00');
    const t = await request(app).post('/api/billing/subscriptions').set(c2.auth).send({ plan: trial.body.plan.code, pin: '1234' });
    expect(t.body.subscription.status).toBe('TRIALING');
    expect(t.body.invoice).toBeNull();
    expect(await balanceOf(c2.auth)).toBe(1000);
    expect(await runBilling(new Date(Date.parse(t.body.subscription.currentPeriodEnd) + 1000))).toMatchObject({ collected: 1 });
    expect(await balanceOf(c2.auth)).toBe(500);
    const cancel = await request(app).post(`/api/billing/subscriptions/${t.body.subscription.id}/cancel`).set(c2.auth).send({});
    expect(cancel.body.subscription.cancelAtPeriodEnd).toBe(true);
    expect(cancel.body.subscription.status).toBe('ACTIVE');
    const after = await runBilling(new Date(Date.parse(cancel.body.subscription.currentPeriodEnd) + 1000));
    expect(after.ended).toBe(1);
    expect(await balanceOf(c2.auth)).toBe(500);
    const overview = (await request(app).get('/api/v1/subscriptions').set(m.auth)).body.overview;
    expect(overview.byStatus.CANCELLED).toBe(1);
    expect(overview.byStatus.ENDED).toBe(1);
    const events = await request(app).get('/api/v1/events?type=invoice.paid').set(m.auth);
    expect(events.body.data.length).toBeGreaterThanOrEqual(3);
    expect(reconcileLedger().ok).toBe(true);
  });
});
