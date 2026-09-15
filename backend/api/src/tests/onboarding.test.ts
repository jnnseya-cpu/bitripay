/** Processor onboarding, live rate providers and regulatory arrangements – the paths that turn the sandbox into a production platform. */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { generateKeyPairSync } from 'node:crypto';
import { setupApp, registerUser, adminToken, checkerToken } from './helpers';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

describe('processor onboarding', () => {
  it('tests gateway connectivity, derives test/live mode from the keys and hides live keys while in sandbox mode', async () => {
    const admin = await adminToken(app);
    const sbx = await request(app).post('/api/admin/gateways/sandbox/test').set(admin.auth);
    expect(sbx.body.ok).toBe(true);
    expect(sbx.body.mode).toBe('test');
    expect(sbx.body.webhookUrl).toContain('/api/webhooks/sandbox');
    // Live Stripe keys are recognised as live and are not offered to payers while the platform is in sandbox mode.
    await request(app)
      .put('/api/admin/gateways/stripe_live')
      .set(admin.auth)
      .send({
        name: 'Stripe live',
        provider: 'stripe',
        enabled: true,
        methods: ['card'],
        currencies: ['USD'],
        credentials: { secretKey: 'sk_live_abc', publishableKey: 'pk_live_abc', webhookSecret: 'whsec_x' },
        config: { threeDSecure: 'any' },
      });
    const list = await request(app).get('/api/admin/gateways').set(admin.auth);
    const live = list.body.items.find((g: any) => g.id === 'stripe_live');
    expect(live.mode).toBe('live');
    const u = await registerUser(app);
    const options = await request(app).get('/api/deposits/options?currency=USD').set(u.auth);
    expect(options.body.methods.find((m: any) => m.method === 'card').gateways.some((g: any) => g.id === 'stripe_live')).toBe(false);
    // A connectivity test with fake keys fails honestly (no network here) and the result is remembered for the checklist.
    const t = await request(app).post('/api/admin/gateways/stripe_live/test').set(admin.auth);
    expect(t.body.ok).toBe(false);
    expect(t.body.mode).toBe('live');
    const after = await request(app).get('/api/admin/gateways').set(admin.auth);
    expect(after.body.items.find((g: any) => g.id === 'stripe_live').lastHealth.ok).toBe(false);
    await request(app).delete('/api/admin/gateways/stripe_live').set(admin.auth);
  });

  it('exposes a go-live checklist and refuses the switch to live while blocking items are open', async () => {
    const admin = await adminToken(app);
    const cl = await request(app).get('/api/admin/go-live').set(admin.auth);
    expect(cl.status).toBe(200);
    expect(cl.body.mode).toBe('sandbox');
    expect(cl.body.readyForLive).toBe(false);
    const ids = cl.body.items.map((i: any) => i.id);
    for (const id of ['processor', 'processor_live_keys', 'rates', 'corridor_live', 'liquidity', 'sanctions', 'maker_checker', 'kyc', 'secrets']) expect(ids).toContain(id);
    for (const i of cl.body.items) if (!i.ok) expect(i.fix ?? i.detail).toBeTruthy();
    const sw = await request(app)
      .put('/api/admin/settings/compliance')
      .set(admin.auth)
      .send({ value: { mode: 'live' }, pin: admin.pin });
    expect(sw.status).toBe(400);
    expect(sw.body.error.code).toBe('go_live_blocked');
    expect(sw.body.error.details.items.some((i: any) => i.id === 'sandbox_off' && !i.ok)).toBe(true);
    expect((await request(app).get('/api/config')).body.features.complianceMode).toBe('sandbox');
  });
});

describe('live rate providers', () => {
  it('records versioned snapshots, supports keyed providers and manual imports, and reports freshness', async () => {
    const admin = await adminToken(app);
    const status0 = await request(app).get('/api/admin/currencies/rate-status').set(admin.auth);
    expect(status0.body.providers.map((p: any) => p.id)).toEqual(expect.arrayContaining(['frankfurter', 'open_er_api', 'exchangerate_host', 'openexchangerates', 'fixer']));
    expect(status0.body.freshness.live).toBe(false); // bundled test rates
    // A keyed provider without a key is refused with a clear message.
    await request(app)
      .put('/api/admin/settings/app')
      .set(admin.auth)
      .send({ value: { rateProvider: 'openexchangerates' } });
    const noKey = await request(app).post('/api/admin/currencies/refresh').set(admin.auth).send({});
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.code).toBe('rate_provider_key_required');
    // The key is stored encrypted and masked when read back.
    await request(app)
      .put('/api/admin/settings/app')
      .set(admin.auth)
      .send({ value: { rateProvider: 'frankfurter', rateProviderKey: 'secret-key-123' } });
    const settings = await request(app).get('/api/admin/settings').set(admin.auth);
    expect(settings.body.app.rateProviderKey).toBe('••••••••');
    const { getDb } = await import('../db');
    expect(String((getDb().prepare("SELECT value FROM settings WHERE key = 'app'").get() as any).value)).not.toContain('secret-key-123');
    // A live refresh records its outcome either way: without outbound network (this sandbox) the failure and its reason,
    // with network (CI runners) a live versioned snapshot and a clean status.
    const refresh = await request(app).post('/api/admin/currencies/refresh').set(admin.auth).send({ provider: 'frankfurter' });
    const st = await request(app).get('/api/admin/currencies/rate-status').set(admin.auth);
    if (refresh.status === 200) {
      expect(refresh.body.provider).toBe('frankfurter');
      expect(refresh.body.snapshotId).toBeTruthy();
      expect(st.body.status.lastError).toBeNull();
      expect(st.body.status.consecutiveFailures).toBe(0);
      expect(st.body.freshness.live).toBe(true);
    } else {
      expect(refresh.status).toBe(400);
      expect(refresh.body.error.code).toBe('rate_provider_error');
      expect(st.body.status.lastError).toBeTruthy();
      expect(st.body.status.consecutiveFailures).toBeGreaterThan(0);
    }
    // Manual versioned import: labelled non-live, never guaranteed, visible in the snapshot history.
    const imp = await request(app)
      .post('/api/admin/currencies/import')
      .set(admin.auth)
      .send({ rates: { EUR: 0.91, GBP: 0.78, KES: 129.5 }, note: 'Treasury desk rates 12 Sep' });
    expect(imp.status).toBe(201);
    expect(imp.body.updated).toEqual(expect.arrayContaining(['EUR', 'GBP', 'KES']));
    const u = await registerUser(app);
    const q = await request(app).get('/api/wallets/exchange/quote?from=USD&to=EUR&amount=10').set(u.auth);
    expect(q.body.fx.provider).toBe(`import_v${imp.body.snapshotId}`);
    expect(q.body.fx.providerLabel).toContain('NOT live');
    expect(q.body.fx.guaranteed).toBe(false);
    expect(q.body.rate).toBeCloseTo(0.91 * 0.99, 4);
    const st2 = await request(app).get('/api/admin/currencies/rate-status').set(admin.auth);
    expect(st2.body.snapshots[0].source).toBe('manual_import');
    // A live provider stamp makes rates live + fresh for the checklist.
    getDb().prepare("UPDATE currencies SET rate_source = 'frankfurter', rate_updated_at = ? WHERE is_base = 0 AND enabled = 1").run(new Date().toISOString());
    const st3 = await request(app).get('/api/admin/currencies/rate-status').set(admin.auth);
    expect(st3.body.freshness.live).toBe(true);
    expect(st3.body.freshness.fresh).toBe(true);
    await request(app)
      .put('/api/admin/settings/app')
      .set(admin.auth)
      .send({ value: { rateProvider: 'manual' } });
  });
});

describe('agent device enrolment', () => {
  it('lets an agent enrol a payout device only on a payout account they operate', async () => {
    const admin = await adminToken(app);
    const agent = await registerUser(app, { role: 'agent', businessName: 'Nairobi Point', country: 'KE' });
    const other = await registerUser(app, { role: 'agent', businessName: 'Other Point', country: 'KE' });
    const { getDb } = await import('../db');
    getDb().prepare("UPDATE users SET kyc_status = 'verified' WHERE id IN (?, ?)").run(agent.user.id, other.user.id);
    const mine = await request(app)
      .post('/api/admin/liquidity/accounts')
      .set(admin.auth)
      .send({ rail: 'mobile_money', operatorId: 'mpesa_ke', country: 'KE', currency: 'KES', label: 'M-Pesa SIM A', msisdn: '+254700000200', agentUserId: agent.user.id });
    const theirs = await request(app)
      .post('/api/admin/liquidity/accounts')
      .set(admin.auth)
      .send({ rail: 'mobile_money', operatorId: 'mpesa_ke', country: 'KE', currency: 'KES', label: 'M-Pesa SIM B', msisdn: '+254700000300', agentUserId: other.user.id });
    const accounts = await request(app).get('/api/payouts/agent/accounts').set(agent.auth);
    expect(accounts.body.items.map((a: any) => a.id)).toEqual([mine.body.account.id]);
    const pem = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const denied = await request(app)
      .post('/api/evidence/devices')
      .set(agent.auth)
      .send({ name: 'Phone', publicKey: pem, kind: 'payout', simMsisdn: '+254700000300', payoutAccountId: theirs.body.account.id });
    expect(denied.status).toBe(403);
    const ok = await request(app)
      .post('/api/evidence/devices')
      .set(agent.auth)
      .send({ name: 'Phone', publicKey: pem, kind: 'payout', simMsisdn: '+254700000200', payoutAccountId: mine.body.account.id });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.device.kind).toBe('payout');
    expect(ok.body.device.agentUserId).toBe(agent.user.id);
    const acc = await request(app).get('/api/payouts/agent/accounts').set(agent.auth);
    expect(acc.body.items[0].deviceId).toBe(ok.body.device.id);
    void checkerToken;
  });
});
