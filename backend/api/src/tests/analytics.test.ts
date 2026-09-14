/**
 * Chart series: every account sees its own activity folded into the thirteen chart shapes (trend, types, channels,
 * months, profile, timeline, counterparties, hour scatter, amounts, heatmap); the console sees the platform.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, adminToken, registerUser, fund } from './helpers';
import { barChart, lineChart, heatmap, treemap, radarChart } from '@bitripay/charts';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

describe('analytics for charts', () => {
  it('folds an account’s ledger into chart series and feeds the chart kit', async () => {
    const a = await registerUser(app, { tag: 'charts1' });
    const b = await registerUser(app, { tag: 'charts2' });
    await fund(app, a.user.id, '100.00');
    const tx = await request(app).post('/api/transfers').set(a.auth).send({ to: '@charts2', amount: '30.00', currency: 'USD', pin: '1234' });
    expect(tx.status).toBe(201);
    const r = await request(app).get('/api/account/analytics?days=7').set(a.auth);
    expect(r.status).toBe(200);
    const p = r.body;
    expect(p.currency).toBe('USD');
    expect(p.totals.count).toBe(2); // funding credit + transfer
    expect(p.totals.out).toBe(3000);
    expect(p.totals.in).toBe(10_000);
    expect(p.trend.labels).toHaveLength(8);
    expect(p.trend.out.reduce((x: number, y: number) => x + y, 0)).toBe(3000);
    expect(p.byType.find((d: any) => d.label === 'Transfer').value).toBe(3000);
    expect(p.byChannel.some((d: any) => d.label === 'Wallet')).toBe(true);
    expect(p.monthly.categories).toHaveLength(6);
    expect(p.profile.axes.length).toBeGreaterThan(5);
    expect(p.counterparties.some((c: any) => c.label.includes(b.user.fullName.split(' ')[0]))).toBe(true); // the treasury credit and the recipient
    expect(p.heat.values.flat().reduce((x: number, y: number) => x + y, 0)).toBe(2);
    expect(p.amounts).toHaveLength(2);
    // the shapes feed the chart engine directly
    expect(barChart(p.byType).items.filter((i) => i.kind === 'rect')).toHaveLength(p.byType.length);
    expect(lineChart(p.trend.labels, [{ name: 'out', values: p.trend.out }]).summary).toContain('8 points');
    expect(heatmap(p.heat.rows, p.heat.cols, p.heat.values).items.filter((i) => i.kind === 'rect')).toHaveLength(7 * 24);
    expect(treemap(p.counterparties).summary).toContain('2 rectangles');
    expect(radarChart(p.profile.axes, [{ name: 'me', values: p.profile.values }]).legend).toHaveLength(1);
    // the counterparty sees the mirror image
    const rb = await request(app).get('/api/account/analytics').set(b.auth);
    expect(rb.body.totals.in).toBe(3000);
    expect(rb.body.totals.out).toBe(0);
  });

  it('adds merchant methods and agent cash series, and the console sees the platform', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Chart Shop' });
    const payer = await registerUser(app);
    await fund(app, payer.user.id, '50.00');
    const req = await request(app).post('/api/payment-requests').set(m.auth).send({ kind: 'qr', amount: '10.00', currency: 'USD' });
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    expect((await request(app).post(`/api/payment-requests/${req.body.paymentRequest.code}/pay`).set(payer.auth).send({ pin: '1234' })).status).toBe(201);
    const mr = await request(app).get('/api/account/analytics').set(m.auth);
    expect(mr.body.extras.methods[0].value).toBe(1000);
    const agent = await registerUser(app, { role: 'agent', businessName: 'Chart Agent', tag: 'chartagent' });
    const ar = await request(app).get('/api/account/analytics').set(agent.auth);
    expect(ar.body.extras.cash.labels).toHaveLength(31);
    const admin = await adminToken(app);
    const pr = await request(app).get('/api/admin/insights/analytics?days=14').set(admin.auth);
    expect(pr.status).toBe(200);
    expect(pr.body.totals.count).toBeGreaterThanOrEqual(4);
    expect(pr.body.extras.kyc.categories).toHaveLength(5);
    expect(pr.body.extras.accounts.find((a: any) => a.label === 'merchant').value).toBeGreaterThanOrEqual(1);
    expect(pr.body.extras.newAccounts.values.reduce((x: number, y: number) => x + y, 0)).toBeGreaterThanOrEqual(5);
    expect((await request(app).get('/api/admin/insights/analytics').set(payer.auth)).status).toBe(403);
  });
});
