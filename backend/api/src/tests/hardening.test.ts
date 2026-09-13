/**
 * Developer-readiness hardening: production refuses insecure defaults, one partner API at /api/v1 and /v1, a single
 * available-balance rule, settings defaults that follow the configured base currency, and admin-editable settings for
 * every documented key.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, adminToken, fund } from './helpers';
import { assertProductionSecrets, config } from '../config';
import { getChannelSettings, getWebhookSettings, getGatewayProductSettings, getAssistSettings } from '../services/settings';
import { createHold, availableBalance } from '../services/finops/holds';
import { ensureWallet } from '../services/wallets';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

describe('hardening', () => {
  it('refuses to start in production with development secrets or the default admin password', () => {
    const strong = 'x'.repeat(48);
    expect(() => assertProductionSecrets({ isProduction: true, jwtSecret: 'dev-jwt-secret-change-me', appSecret: strong, admin: { password: 'Correct-Horse-Battery-9' } })).toThrow(/JWT_SECRET/);
    expect(() => assertProductionSecrets({ isProduction: true, jwtSecret: strong, appSecret: 'short', admin: { password: 'Correct-Horse-Battery-9' } })).toThrow(/APP_SECRET/);
    expect(() => assertProductionSecrets({ isProduction: true, jwtSecret: strong, appSecret: strong, admin: { password: 'Admin123!' } })).toThrow(/ADMIN_PASSWORD/);
    expect(assertProductionSecrets({ isProduction: true, jwtSecret: strong, appSecret: strong, admin: { password: 'Correct-Horse-Battery-9' } })).toEqual([]);
    // development only warns
    expect(assertProductionSecrets({ isProduction: false, jwtSecret: 'dev-x', appSecret: 'dev-y', admin: { password: 'Admin123!' } }).length).toBe(3);
  });

  it('serves the same partner API at /api/v1 and /v1, including the merchant profile and balance classes', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Mirror Shop' });
    await fund(app, m.user.id, '100.00');
    for (const prefix of ['/api/v1', '/v1']) {
      const me = await request(app).get(`${prefix}/me`).set(m.auth);
      expect(me.status, `${prefix}/me ${JSON.stringify(me.body)}`).toBe(200);
      expect(me.body.merchant.id).toBe(m.user.id);
      const bal = await request(app).get(`${prefix}/balance`).set(m.auth);
      expect(bal.status, `${prefix}/balance ${JSON.stringify(bal.body)}`).toBe(200);
      const usd = bal.body.data.find((w: any) => w.currency === 'USD');
      expect(usd).toMatchObject({ balance: 10000, available: 10000, held: 0, frozen: 0 });
      expect(usd.holds).toEqual({});
    }
  });

  it('applies one available-balance rule everywhere (holds reduce it, frozen wallets have none)', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Held Shop' });
    await fund(app, m.user.id, '80.00');
    const wallet = ensureWallet(m.user.id, 'USD');
    createHold({ walletId: wallet.id, kind: 'reserve', amountMinor: 3000, reason: 'test reserve' }, { type: 'system' });
    expect(availableBalance(ensureWallet(m.user.id, 'USD'))).toBe(5000);
    const bal = await request(app).get('/api/v1/balance').set(m.auth);
    expect(bal.body.data.find((w: any) => w.currency === 'USD')).toMatchObject({ balance: 8000, available: 5000, held: 3000 });
    const key = await request(app)
      .post('/api/v1/api_keys')
      .set(m.auth)
      .send({ label: 'ro', mode: 'test', kind: 'restricted', scopes: ['wallets:read'] });
    const wallets = await request(app)
      .get('/api/v1/wallets')
      .set({ Authorization: `Bearer ${key.body.secret}` });
    expect(wallets.body.data.find((w: any) => w.currency === 'USD')).toMatchObject({ balance_minor: 8000, available_minor: 5000, held_minor: 3000 });
    const admin = await adminToken(app);
    const frozen = await request(app).post(`/api/admin/users/${m.user.id}/wallets/USD/freeze`).set(admin.auth).send({ reason: 'compliance review', pin: admin.pin });
    expect(frozen.status, JSON.stringify(frozen.body)).toBe(200);
    expect(availableBalance(ensureWallet(m.user.id, 'USD'))).toBe(0);
    expect((await request(app).get('/api/v1/balance').set(m.auth)).body.data.find((w: any) => w.currency === 'USD')).toMatchObject({ available: 0, frozen: 8000 });
  });

  it('defaults follow the configured base currency and the documented channel and webhook values', () => {
    const ch = getChannelSettings();
    expect(ch.ussd.serviceCode).toBe('*149*01#');
    expect(ch.ussd.sessionTtlMinutes * 60).toBe(90);
    expect(ch.ussd.maxPerTransactionCurrency).toBe(config.baseCurrency);
    expect(ch.sms.maxPerTransactionCurrency).toBe(config.baseCurrency);
    expect(getGatewayProductSettings().koda.priceCurrency).toBe(config.baseCurrency);
    expect(getAssistSettings().billing.priceCurrency).toBe(config.baseCurrency);
    const schedule = getWebhookSettings().retryScheduleSeconds;
    expect(schedule.length).toBe(8);
    expect(schedule.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(24 * 3600);
    for (let i = 1; i < schedule.length; i += 1) expect(schedule[i]).toBeGreaterThanOrEqual(schedule[i - 1]);
  });

  it('lets an administrator edit every documented settings group, including e-money and gateway products', async () => {
    const admin = await adminToken(app);
    const all = await request(app).get('/api/admin/settings').set(admin.auth);
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body.gateway_products.links.defaultDays).toBe(7);
    expect(all.body.emoney).toBeTruthy();
    expect(all.body.webhooks.retryScheduleSeconds.length).toBe(8);
    const put = await request(app)
      .put('/api/admin/settings/gateway_products')
      .set(admin.auth)
      .send({ value: { ...all.body.gateway_products, links: { defaultDays: 10 } } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(getGatewayProductSettings().links.defaultDays).toBe(10);
    const put2 = await request(app).put('/api/admin/settings/emoney').set(admin.auth).send({ value: all.body.emoney });
    expect(put2.status, JSON.stringify(put2.body)).toBe(200);
    expect((await request(app).put('/api/admin/settings/not_a_key').set(admin.auth).send({ value: {} })).status).toBe(400);
  });
});

describe('developer surface', () => {
  it('generates the REST Client quick reference from the served OpenAPI table', async () => {
    const { renderHttpFile } = await import('../docs/httpFile');
    const { openApiDocument } = await import('../docs/openapi');
    const doc = openApiDocument();
    const text = renderHttpFile(doc);
    for (const [path, methods] of Object.entries(doc.paths))
      for (const method of Object.keys(methods as object)) {
        const url = path.replace(/\{(\w+)\}/g, (_m, n) => `{{${n}}}`);
        expect(text, `${method.toUpperCase()} ${path}`).toContain(`${method.toUpperCase()} {{api}}${url}`);
      }
    expect(text).toContain('Idempotency-Key: {{$guid}}');
    expect(text).not.toContain('bp_live_');
  });

  it('imports processor statements from the raw CSV export, parsed on the server', async () => {
    const { statementLinesFromCsv } = await import('../routes/admin/finops');
    const lines = statementLinesFromCsv('reference,amountMinor,status,feeMinor\r\n"PSP-1",1250,SETTLED,25\r\nPSP-2,"3,000",FAILED,\r\n\r\n', 'usd');
    expect(lines).toEqual([
      { reference: 'PSP-1', amountMinor: '1250', currency: 'USD', status: 'SETTLED', feeMinor: '25', settlementRef: null, occurredAt: null },
      { reference: 'PSP-2', amountMinor: '3,000', currency: 'USD', status: 'FAILED', feeMinor: null, settlementRef: null, occurredAt: null },
    ]);
    const admin = await adminToken(app);
    const res = await request(app)
      .post('/api/admin/finops/reconciliation/processors/sandbox/statements')
      .set(admin.auth)
      .send({ cycleRef: '2026-09-13', currency: 'USD', csv: 'reference,amountMinor,status,feeMinor\nNO-SUCH-REF,1000,SETTLED,10\n', run: true });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.import.lineCount).toBe(1);
    const empty = await request(app)
      .post('/api/admin/finops/reconciliation/processors/sandbox/statements')
      .set(admin.auth)
      .send({ cycleRef: '2026-09-13', currency: 'USD', csv: 'reference,amountMinor\n' });
    expect(empty.status).toBe(400);
  });
});

describe('registries exposed to operators and developers', () => {
  it('lists the platform signing keys and revokes one under step-up, refusing a second revocation', async () => {
    const admin = await adminToken(app);
    const { platformSigningKey } = await import('../services/keys');
    platformSigningKey(); // the registry is populated the first time the platform signs
    const list = await request(app).get('/api/admin/signing-keys?party=platform').set(admin.auth);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.items.length).toBeGreaterThan(0);
    expect(list.body.items[0].publicKey.endsWith('…')).toBe(true); // never the full key material in the console listing
    const keyId = list.body.items[0].keyId as string;
    const noPin = await request(app).post(`/api/admin/signing-keys/${keyId}/revoke`).set(admin.auth).send({ reason: 'rotation drill' });
    expect(noPin.status).toBe(403);
    const revoked = await request(app).post(`/api/admin/signing-keys/${keyId}/revoke`).set(admin.auth).send({ reason: 'rotation drill', pin: admin.pin });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body.key.revokedAt).toBeTruthy();
    expect((await request(app).post(`/api/admin/signing-keys/${keyId}/revoke`).set(admin.auth).send({ reason: 'again', pin: admin.pin })).status).toBe(409);
    // the public registry reports the revocation and a fresh platform key is minted for new signatures
    const reg = await request(app).get(`/api/v1/keys/${keyId}`);
    expect(reg.status).toBe(200);
    expect(reg.body.revoked ?? reg.body.key?.revoked).toBe(true);
    const fresh = await request(app).get('/api/v1/keys');
    expect(JSON.stringify(fresh.body)).not.toContain(`"${keyId}"`);
  });

  it('publishes one sandbox magic-number table that the simulator itself uses', async () => {
    const res = await request(app).get('/api/v1/sandbox');
    expect(res.status).toBe(200);
    const byOutcome = Object.fromEntries(res.body.magic.map((m: any) => [m.outcome, m.msisdn]));
    for (const outcome of res.body.outcomes) expect(res.body.magicMsisdns[outcome], outcome).toBe(byOutcome[outcome]);
    expect(res.body.magic.some((m: any) => m.outcome === 'declined')).toBe(true);
  });
});
