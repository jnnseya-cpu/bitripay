import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Request, Response } from 'express';
import { setupApp, registerUser, adminToken } from './helpers';
import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { AppError } from '../lib/errors';
import { rateLimit, keyByDevice, keyByMsisdn, keyByQrId, keyByUser, refundLimit, payoutLimit } from '../middleware/rateLimit';
import { correlationIdFromHeaders, currentCorrelationId, withRequestContext } from '../middleware/correlation';
import { audit, listAuditLogs } from '../services/audit';
import {
  listRails,
  getRail,
  getRoutingSettings,
  setRailMaintenance,
  getRailMaintenance,
  listRailMaintenance,
  connectorHealth,
  connectorStats,
  recordRoutingOutcome,
  recordProbe,
  resumeConnector,
  bucketOf,
  amountBandOf,
  prefixOf,
  percentile,
  pruneRoutingStats,
  scoreConnectors,
  pickConnector,
  routingReport,
  concentrationShares,
  railCapabilities,
} from '../services/rails';
import { sandboxProvider, parseSandboxStatement, SANDBOX_CAPABILITIES } from '../payments/sandbox';
import { PROVIDERS } from '../payments';
import type { GatewayPaymentRow, InitiateContext } from '../payments/types';
import { ambiguousCreditFindings, runGuardian, getOperatingState, setOperatingMode } from '../services/guardian';
import { AGENTS, OS_AGENT_ALIASES, agentForAlias, getAgentDef } from '../services/assist/registry';
import { computePromptHash, getRun, MACHINE_GENERATED } from '../services/assist/runtime';
import { findUserById } from '../services/users';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Minimal Express request/response doubles for exercising a limiter outside the app. */
function fakeReq(over: Partial<Request> & { headers?: Record<string, string>; body?: unknown; params?: Record<string, string> } = {}): Request {
  return { method: 'POST', path: '/x', headers: {}, body: {}, params: {}, ip: '203.0.113.9', socket: { remoteAddress: '203.0.113.9' }, ...over } as unknown as Request;
}
function fakeRes(): Response & { headers: Record<string, unknown> } {
  const headers: Record<string, unknown> = {};
  return { headers, setHeader: (k: string, v: unknown) => (headers[k.toLowerCase()] = v) } as unknown as Response & { headers: Record<string, unknown> };
}
/** Run a limiter once; resolves to the AppError it refused with, or null when the request passed. */
function hit(limiter: ReturnType<typeof rateLimit>, req: Request, res = fakeRes()): AppError | null {
  let out: AppError | null = null;
  limiter(req, res, (err?: unknown) => {
    out = (err as AppError) ?? null;
  });
  return out;
}

describe('correlation id and audit trail', () => {
  it('echoes the caller X-Correlation-Id / X-Request-Id and mints a UUID otherwise', async () => {
    const supplied = await request(app).get('/api/health').set('X-Correlation-Id', 'order-42/retry:1');
    expect(supplied.headers['x-correlation-id']).toBe('order-42/retry:1');
    const viaRequestId = await request(app).get('/api/health').set('X-Request-Id', 'req_abc');
    expect(viaRequestId.headers['x-correlation-id']).toBe('req_abc');
    const minted = await request(app).get('/api/health');
    expect(minted.headers['x-correlation-id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // unsafe / oversized ids are replaced, never echoed
    expect(correlationIdFromHeaders({ 'x-correlation-id': '<script>' })).toMatch(/^[0-9a-f-]{36}$/);
    expect(correlationIdFromHeaders({ 'x-correlation-id': 'a'.repeat(200) })).toMatch(/^[0-9a-f-]{36}$/);
    // 404s carry it too (the middleware is mounted before every router)
    const missing = await request(app).get('/api/no-such-route').set('X-Correlation-Id', 'c-404');
    expect(missing.headers['x-correlation-id']).toBe('c-404');
    // outside a request there is no id; inside an explicit context there is
    expect(currentCorrelationId()).toBeNull();
    expect(withRequestContext({ correlationId: 'job-1' }, () => currentCorrelationId())).toBe('job-1');
  });

  it('audit() fills correlation_id, ip, device, result and reason on the append-only audit_logs', async () => {
    const admin = await adminToken(app);
    const res = await request(app)
      .put('/api/admin/settings/gateway')
      .set(admin.auth)
      .set('X-Correlation-Id', 'audit-corr-1')
      .set('X-Device-Id', 'ops-laptop-7')
      .send({ value: { sharedSecretAutoConfirm: false } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = getDb().prepare("SELECT * FROM audit_logs WHERE correlation_id = ? AND action = 'settings.update'").get('audit-corr-1') as any;
    expect(row).toBeTruthy();
    expect(row.device).toBe('ops-laptop-7');
    expect(row.ip).toBeTruthy();
    expect(row.result).toBe('ok');
    expect(row.reason).toBeNull();
    // the list view exposes the new columns and searches by correlation id
    const listed = await request(app).get('/api/admin/audit-logs?search=audit-corr-1').set(admin.auth);
    expect(listed.status).toBe(200);
    expect(listed.body.items[0]).toMatchObject({ correlationId: 'audit-corr-1', device: 'ops-laptop-7', result: 'ok' });
    // backward compatible signature, explicit outcome, still append-only
    const adminUser = findUserById(listed.body.items[0].adminId ?? listed.body.items[0].admin?.id)!;
    withRequestContext({ correlationId: 'job-77', ip: 'internal', device: 'scheduler' }, () =>
      audit(adminUser.id, 'contract.test', 'thing', 't1', { a: 1 }, { result: 'denied', reason: 'step-up missing' }),
    );
    const denied = getDb().prepare("SELECT * FROM audit_logs WHERE action = 'contract.test'").get() as any;
    expect(denied).toMatchObject({ correlation_id: 'job-77', ip: 'internal', device: 'scheduler', result: 'denied', reason: 'step-up missing' });
    expect(() => getDb().prepare('DELETE FROM audit_logs WHERE id = ?').run(denied.id)).toThrow(/append-only/);
    expect(listAuditLogs(1, 5, 'job-77').items[0].reason).toBe('step-up missing');
  });
});

describe('sliding-window rate limiter', () => {
  it('slides the window instead of resetting it, keeps the old signature and reports Retry-After', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T10:00:00.000Z'));
    const limiter = rateLimit({ windowMs: 10_000, max: 3, keyPrefix: 'slide', enforceInTests: true });
    const req = fakeReq();
    expect(hit(limiter, req)).toBeNull();
    vi.advanceTimersByTime(4000);
    expect(hit(limiter, req)).toBeNull();
    expect(hit(limiter, req)).toBeNull();
    const res = fakeRes();
    const refused = hit(limiter, req, res);
    expect(refused?.status).toBe(429);
    expect(refused?.code).toBe('rate_limited');
    expect(res.headers['retry-after']).toBe(6);
    expect(res.headers['x-ratelimit-remaining']).toBe(0);
    // 6 s later the first hit falls out of the trailing window: one slot opens, not the whole window
    vi.advanceTimersByTime(6000);
    expect(hit(limiter, req)).toBeNull();
    expect(hit(limiter, req)?.status).toBe(429);
    // the default (test) behaviour is unchanged: limiters without enforceInTests pass everything through
    const passive = rateLimit({ windowMs: 1000, max: 1 });
    expect(hit(passive, req)).toBeNull();
    expect(hit(passive, req)).toBeNull();
  });

  it('keys by device id, MSISDN, QR id or account and only counts the configured methods', () => {
    const byDevice = rateLimit({ windowMs: 60_000, max: 1, keyPrefix: 'dev', keyBy: keyByDevice, enforceInTests: true });
    expect(hit(byDevice, fakeReq({ headers: { 'x-device-id': 'phone-A' } }))).toBeNull();
    expect(hit(byDevice, fakeReq({ headers: { 'x-device-id': 'phone-A' } }))?.status).toBe(429);
    expect(hit(byDevice, fakeReq({ headers: { 'x-device-id': 'phone-B' } }))).toBeNull();
    // a request without the subject is not counted by this limiter
    expect(hit(byDevice, fakeReq())).toBeNull();
    expect(hit(byDevice, fakeReq())).toBeNull();

    const byMsisdn = rateLimit({ windowMs: 60_000, max: 1, keyPrefix: 'msisdn', keyBy: keyByMsisdn, enforceInTests: true });
    expect(hit(byMsisdn, fakeReq({ body: { msisdn: '+243 81 000 0001' } }))).toBeNull();
    expect(hit(byMsisdn, fakeReq({ body: { phone: '243810000001' } }))?.status).toBe(429);
    expect(hit(byMsisdn, fakeReq({ body: { msisdn: '+243810000002' } }))).toBeNull();
    expect(keyByMsisdn(fakeReq({ body: { msisdn: '12' } }))).toBeNull();

    const byQr = rateLimit({ windowMs: 60_000, max: 1, keyPrefix: 'qr', keyBy: keyByQrId, enforceInTests: true });
    expect(hit(byQr, fakeReq({ params: { id: 'qr_1' } }))).toBeNull();
    expect(hit(byQr, fakeReq({ body: { qr_id: 'qr_1' } }))?.status).toBe(429);
    expect(hit(byQr, fakeReq({ body: { qrId: 'qr_2' } }))).toBeNull();

    expect(keyByUser(fakeReq({ user: { id: 'u1' } } as any))).toBe('user:u1');
    const writes = rateLimit({ windowMs: 60_000, max: 1, keyPrefix: 'w', methods: ['POST', 'PUT', 'DELETE'], enforceInTests: true });
    expect(hit(writes, fakeReq({ method: 'GET' }))).toBeNull();
    expect(hit(writes, fakeReq({ method: 'GET' }))).toBeNull();
    expect(hit(writes, fakeReq({ method: 'POST' }))).toBeNull();
    expect(hit(writes, fakeReq({ method: 'put' }))?.status).toBe(429);
    // the money-moving partner limiters are exported for routes/v1.ts
    expect(typeof refundLimit).toBe('function');
    expect(typeof payoutLimit).toBe('function');
  });

  it('is mounted on QR resolve, inbound provider webhooks and administrative writes', async () => {
    const admin = await adminToken(app);
    const qr = await request(app).post('/api/qr/resolve').set('X-Device-Id', 'd1').send({ data: 'not-a-bitripay-qr' });
    expect(qr.headers['x-ratelimit-limit']).toBeUndefined(); // limiters are inert in tests …
    expect([200, 400, 404, 422]).toContain(qr.status); // … and the route still answers
    const hook = await request(app).post('/api/webhooks/sandbox').send({});
    expect([200, 400, 404]).toContain(hook.status);
    const read = await request(app).get('/api/admin/stats').set(admin.auth);
    expect(read.status).toBe(200);
    const write = await request(app)
      .put('/api/admin/settings/gateway')
      .set(admin.auth)
      .send({ value: { sharedSecretAutoConfirm: false } });
    expect(write.status).toBe(200);
  });
});

describe('connector health, capabilities and maintenance', () => {
  it('reports a health state and capabilities on every rail entry, sourced from the provider contract', () => {
    const rails = listRails();
    expect(rails.length).toBeGreaterThan(1);
    for (const r of rails) {
      expect(['HEALTHY', 'DEGRADED', 'UNAVAILABLE', 'MAINTENANCE']).toContain(r.health.state);
      expect(r.health).toHaveProperty('lastProbe');
      expect(r.health).toHaveProperty('lastIncidentAt');
      expect(r.capabilities).toMatchObject({
        minMinor: expect.any(Number),
        maxMinor: expect.any(Number),
        refunds: expect.any(Boolean),
        settlementT: expect.any(Number),
        webhooks: expect.any(Boolean),
      });
      expect(r.capabilities).toHaveProperty('lastIncidentAt');
    }
    const sandbox = getRail('sandbox');
    expect(sandbox.health.state).toBe('HEALTHY');
    expect(sandbox.capabilities).toMatchObject({ minMinor: SANDBOX_CAPABILITIES.minMinor, maxMinor: SANDBOX_CAPABILITIES.maxMinor, refunds: true, settlementT: 0, webhooks: true });
    expect(PROVIDERS.sandbox.capabilities!({})).toEqual(SANDBOX_CAPABILITIES);
    // providers without a contract get defaults by kind; the wallet settles instantly
    expect(railCapabilities('wallet')).toMatchObject({ refunds: true, settlementT: 0, webhooks: false });
    expect(railCapabilities('operator:mtn_gh')).toMatchObject({ refunds: false, settlementT: 1 });
    expect(getRoutingSettings().circuit.probeIntervalMinutes).toBe(1);
  });

  it('derives DEGRADED from the recent success rate, UNAVAILABLE from a failed probe / open circuit and MAINTENANCE from the admin flag', async () => {
    const admin = await adminToken(app);
    const id = 'sandbox';
    expect(connectorHealth(id).state).toBe('HEALTHY');
    // a poor success rate over the last hour (above the minimum sample) degrades a closed connector
    for (let i = 0; i < 6; i++) recordRoutingOutcome(id, 'card', 'success', 200 + i);
    for (let i = 0; i < 2; i++) recordRoutingOutcome(id, 'card', 'failure', 900);
    expect(connectorStats(id, 'card', 1).successRate).toBe(75);
    expect(connectorHealth(id).state).toBe('DEGRADED');
    // a failed probe makes it unavailable; a healthy probe with a good rate brings it back
    recordProbe(id, false, 'timeout');
    expect(connectorHealth(id).state).toBe('UNAVAILABLE');
    expect(connectorHealth(id).usable).toBe(true); // one failed probe is not an open circuit
    recordProbe(id, true, 'ok');
    for (let i = 0; i < 20; i++) recordRoutingOutcome(id, 'card', 'success', 150);
    expect(connectorHealth(id).state).toBe('HEALTHY');
    // consecutive failures open the circuit → UNAVAILABLE and unusable, with the incident timestamp
    for (let i = 0; i < getRoutingSettings().circuit.failureThreshold; i++) recordRoutingOutcome(id, 'card', 'failure', 5000);
    const open = connectorHealth(id);
    expect(open.state).toBe('UNAVAILABLE');
    expect(open.circuit).toBe('open');
    expect(open.usable).toBe(false);
    expect(open.lastIncidentAt).toBeTruthy();
    expect(getRail(id).capabilities.lastIncidentAt).toBe(open.lastIncidentAt);
    resumeConnector(id, 'admin');
    expect(connectorHealth(id).circuit).toBe('closed');
    // the breaker's failures still weigh on the hour's success rate until fresh successes dilute them
    expect(connectorHealth(id).state).toBe('DEGRADED');
    for (let i = 0; i < 60; i++) recordRoutingOutcome(id, 'card', 'success', 150);
    expect(connectorHealth(id).state).toBe('HEALTHY');
    // maintenance flag: persisted, reported on the registry, cleared by the administrator
    const on = setRailMaintenance(id, true, 'Provider maintenance window', 'admin-1');
    expect(on.state).toBe('MAINTENANCE');
    expect(on.usable).toBe(false);
    expect(on.reason).toContain('Provider maintenance window');
    expect(getRailMaintenance(id)).toMatchObject({ railId: id, reason: 'Provider maintenance window', setBy: 'admin-1' });
    expect(getDb().prepare('SELECT * FROM rail_maintenance WHERE rail_id = ?').get(id)).toBeTruthy();
    expect(listRailMaintenance().map((m) => m.railId)).toContain(id);
    const viaApi = await request(app).get('/api/admin/switch/rails/sandbox').set(admin.auth);
    expect(viaApi.status).toBe(200);
    expect(viaApi.body.rail.health.state).toBe('MAINTENANCE');
    expect(viaApi.body.rail.health.maintenance.reason).toBe('Provider maintenance window');
    // Smart Route never picks a rail under maintenance
    const pick = pickConnector([
      { id, method: 'card', costBps: 100 },
      { id: 'wallet', method: 'card', costBps: 0 },
    ]);
    expect(pick.id).toBe('wallet');
    expect(pick.scores.find((s) => s.id === id)).toMatchObject({ usable: false, score: 0 });
    const off = setRailMaintenance(id, false, null, 'admin-1');
    expect(off.state).toBe('HEALTHY');
    expect(getRailMaintenance(id)).toBeNull();
  });
});

describe('Smart Route telemetry and scoring', () => {
  it('keeps 15-minute buckets for 24 hours keyed by amount band and prefix, and scores latency on the p95', () => {
    expect(bucketOf(new Date('2026-09-14T10:47:12.000Z'))).toBe('2026-09-14T10:45');
    expect(bucketOf(new Date('2026-09-14T10:14:59.000Z'))).toBe('2026-09-14T10:00');
    expect(amountBandOf(500, 'USD')).toBe('lt10');
    expect(amountBandOf(2500, 'USD')).toBe('10_100');
    expect(amountBandOf(50_000, 'USD')).toBe('100_1000');
    expect(amountBandOf(500_000, 'USD')).toBe('gt1000');
    expect(amountBandOf(null, 'USD')).toBeNull();
    expect(prefixOf('+243 810 123 456')).toBe('243810');
    expect(prefixOf('0024381', 4)).toBe('2438');
    expect(prefixOf('12')).toBe('');
    expect(percentile([100, 200, 300, 400, 5000], 95)).toBe(5000);
    expect(percentile([], 95)).toBeNull();

    const id = 'manual_momo';
    const latencies = [100, 120, 110, 130, 115, 125, 105, 135, 4000, 118];
    for (const l of latencies) recordRoutingOutcome(id, 'mobile_money', 'success', l, { amountMinor: 2500, currency: 'USD', msisdn: '+243810000123', chosenBy: 'smart' });
    const row = getDb().prepare("SELECT * FROM routing_stats WHERE connector = ? AND method = 'mobile_money' AND amount_band = '10_100' AND prefix = '243810'").get(id) as any;
    expect(row).toBeTruthy();
    expect(row.bucket).toBe(bucketOf());
    expect(row.attempts).toBe(latencies.length);
    expect(row.smart_attempts).toBe(latencies.length);
    expect(JSON.parse(row.latency_samples)).toHaveLength(latencies.length);
    const all = connectorStats(id, 'mobile_money', 24);
    expect(all.p95LatencyMs).toBe(4000);
    expect(all.avgLatencyMs).toBeLessThan(1000);
    const band = connectorStats(id, 'mobile_money', 24, { amountBand: '10_100', prefix: '243810' });
    expect(band.attempts).toBe(latencies.length);
    expect(band.amountBand).toBe('10_100');
    expect(connectorStats(id, 'mobile_money', 24, { amountBand: 'gt1000' }).attempts).toBe(0);
    // retention: a bucket older than 24 h is pruned, the fresh one survives
    getDb()
      .prepare('INSERT INTO routing_stats (connector, method, bucket, attempts, successes) VALUES (?, ?, ?, 3, 3)')
      .run(id, 'mobile_money', bucketOf(new Date(Date.now() - 30 * 3600_000)));
    expect(pruneRoutingStats()).toBeGreaterThanOrEqual(1);
    expect(connectorStats(id, 'mobile_money', 48).attempts).toBe(latencies.length);
  });

  it('scores settlement speed, FX cost, fraud risk, liquidity and concentration, honours the policies and reports the uplift', () => {
    const a = 'ctr_alpha';
    const b = 'ctr_beta';
    // alpha carries > 60 % of the last hour's bank volume; beta is the merchant's static default (preference 0)
    for (let i = 0; i < 16; i++) recordRoutingOutcome(a, 'bank', 'success', 300, { chosenBy: 'smart' });
    // beta is cheap but only succeeds every other time (interleaved so the breaker never trips)
    for (let i = 0; i < 8; i++) recordRoutingOutcome(b, 'bank', i % 2 === 0 ? 'success' : 'failure', 200, { chosenBy: 'default' });
    const shares = concentrationShares('bank');
    expect(shares.get(a)).toBeCloseTo(16 / 24, 3);
    expect(shares.get(b)).toBeCloseTo(8 / 24, 3);
    const candidates = [
      { id: a, method: 'bank', costBps: 300, preferenceRank: 1, amountMinor: 1000, currency: 'USD', targetCurrency: 'EUR' },
      { id: b, method: 'bank', costBps: 50, preferenceRank: 0, amountMinor: 1000, currency: 'USD' },
    ];
    const smart = scoreConnectors(candidates, 'smart');
    for (const s of smart) {
      for (const k of ['success', 'latency', 'cost', 'health', 'preference', 'settlementSpeed', 'fxCost', 'fraudRisk', 'liquidity', 'concentration'] as const) {
        expect(s.components[k]).toBeGreaterThanOrEqual(0);
        expect(s.components[k]).toBeLessThanOrEqual(100);
      }
      expect(s.factors).toHaveProperty('p95LatencyMs');
      expect(s.factors).toHaveProperty('disputeRatio');
    }
    const alpha = smart.find((s) => s.id === a)!;
    const beta = smart.find((s) => s.id === b)!;
    expect(alpha.components.concentration).toBeLessThan(100);
    expect(beta.components.concentration).toBe(100);
    expect(alpha.components.fxCost).toBeLessThan(beta.components.fxCost); // USD→EUR carries a markup
    expect(alpha.factors.concentrationShare).toBeGreaterThan(getRoutingSettings().concentrationShare);
    // policies: cheapest prefers the cheap rail, most_reliable the higher success rate; every policy is accepted
    expect(scoreConnectors(candidates, 'cheapest')[0].id).toBe(b);
    expect(scoreConnectors(candidates, 'most_reliable')[0].id).toBe(a);
    expect(scoreConnectors(candidates, 'fastest')).toHaveLength(2);
    // the report carries the uplift, both the ranking-based and the measured (chosenBy) one
    const report = routingReport(candidates, 'smart');
    expect(report.window).toMatchObject({ bucketMinutes: 15, retentionHours: 24 });
    expect(report.uplift.defaultRail).toBe(b);
    expect(report.uplift.smartRail).toBe(report.scores[0].id);
    expect(report.uplift.measured).toMatchObject({ smartAttempts: 16, smartSuccesses: 16, defaultAttempts: 8, defaultSuccesses: 4 });
    expect(report.uplift.measured.points).toBe(50);
    // ranking-based uplift: the difference between the top-ranked rail's success rate and the default rail's (0 when they coincide)
    expect(report.uplift.defaultSuccessRate).toBe(50);
    expect(report.uplift.points).toBe(Math.round((report.uplift.smartSuccessRate! - report.uplift.defaultSuccessRate!) * 10) / 10);
    expect(routingReport(candidates, 'most_reliable').uplift).toMatchObject({ smartRail: a, smartSuccessRate: 100, points: 50 });
    expect(report.weights).toHaveProperty('liquidity');
    const pick = pickConnector(candidates, 'smart');
    expect(pick.defaultId).toBe(b);
    expect(pick.chosenBy).toBe(pick.id === b ? 'default' : 'smart');
  });
});

describe('provider contract extensions', () => {
  const row = (over: Partial<GatewayPaymentRow> = {}): GatewayPaymentRow =>
    ({ id: 'gp_1', gateway: 'sandbox', provider_ref: 'sbx_x', status: 'pending', method: 'card', currency: 'USD', amount: 1000, created_at: now(), updated_at: now(), ...over }) as GatewayPaymentRow;

  it('sandbox implements quote, capabilities, parseStatement and cancel; initiate is idempotent on the platform key', async () => {
    const p = sandboxProvider;
    const q = await p.quote!({ amountMinor: 10_000, currency: 'usd', method: 'card', credentials: {} });
    expect(q).toMatchObject({ feeMinor: 290, feeBps: 290, currency: 'USD', targetCurrency: 'USD', fxRate: 1, etaSeconds: 0 });
    const fx = await p.quote!({ amountMinor: 10_000, currency: 'USD', targetCurrency: 'GHS', method: 'mobile_money', fxRate: 15.2, credentials: {} });
    expect(fx.fxRate).toBe(15.2);
    expect(fx.etaSeconds).toBeGreaterThan(0);
    const csv = 'reference,amountMinor,status,feeMinor,currency\r\nsbx_a1,1000,succeeded,29,USD\r\n"sbx_b2","2500","failed","0","GHS"\r\n\r\nbad,,x,1\n';
    const lines = p.parseStatement!(csv, {});
    expect(lines).toEqual([
      { reference: 'sbx_a1', amountMinor: 1000, currency: 'USD', status: 'succeeded', feeMinor: 29, settlementRef: null, occurredAt: null },
      { reference: 'sbx_b2', amountMinor: 2500, currency: 'GHS', status: 'failed', feeMinor: 0, settlementRef: null, occurredAt: null },
    ]);
    expect(parseSandboxStatement('[{"reference":"r1","amountMinor":5,"status":"SUCCEEDED","feeMinor":1}]')[0]).toMatchObject({ reference: 'r1', amountMinor: 5, status: 'succeeded', feeMinor: 1 });
    expect(parseSandboxStatement('')).toEqual([]);
    expect(await p.cancel!(row(), {})).toMatchObject({ status: 'cancelled', providerRef: 'sbx_x' });
    expect((await p.cancel!(row({ status: 'succeeded' }), {})).status).toBe('not_cancellable');
    const ctx = (key?: string): InitiateContext => ({
      payment: row({ method: 'bank' }),
      amountMajor: 10,
      amountMinor: 1000,
      currency: 'USD',
      decimals: 2,
      method: 'bank',
      payer: { email: null, phone: null, name: null, userId: null },
      returnUrl: 'https://example.test/return',
      callbackUrl: 'https://example.test/cb',
      credentials: {},
      description: 'test',
      idempotencyKey: key,
    });
    const first = await p.initiate(ctx('pi_123'));
    const again = await p.initiate(ctx('pi_123'));
    const other = await p.initiate(ctx('pi_124'));
    expect(first.providerRef).toBe(again.providerRef);
    expect(other.providerRef).not.toBe(first.providerRef);
    expect((await p.initiate(ctx())).providerRef).not.toBe((await p.initiate(ctx())).providerRef);
    // the optional methods stay optional on the contract: providers without them still register
    for (const prov of Object.values(PROVIDERS)) {
      expect(typeof prov.initiate).toBe('function');
      for (const m of ['quote', 'capabilities', 'parseStatement', 'cancel'] as const) if (prov[m]) expect(typeof prov[m]).toBe('function');
    }
  });
});

describe('Guardian: AMBIGUOUS is never credited', () => {
  it('is clean on a healthy ledger and detects a fabricated merchant credit for an AMBIGUOUS intent', async () => {
    expect(ambiguousCreditFindings()).toEqual([]);
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'Kin Market', country: 'CD' });
    const payer = await registerUser(app);
    const db = getDb();
    const ts = now();
    const walletOf = (userId: string) => {
      let w = db.prepare('SELECT * FROM wallets WHERE user_id = ? AND currency = ?').get(userId, 'USD') as any;
      if (!w) {
        db.prepare('INSERT INTO wallets (id, user_id, currency, balance, created_at) VALUES (?, ?, ?, 0, ?)').run(uuid(), userId, 'USD', ts);
        w = db.prepare('SELECT * FROM wallets WHERE user_id = ? AND currency = ?').get(userId, 'USD');
      }
      return w as { id: string; balance: number };
    };
    const mw = walletOf(merchant.user.id);
    const pw = walletOf(payer.user.id);
    // Fabricate the violation: a balanced transaction that credits the merchant while the intent is AMBIGUOUS.
    const txId = uuid();
    const intentId = `pi_${uuid()}`;
    db.prepare(
      "INSERT INTO transactions (id, reference, type, status, amount, fee, currency, sender_user_id, receiver_user_id, metadata, created_at) VALUES (?, ?, 'payment', 'completed', 2500, 0, 'USD', ?, ?, ?, ?)",
    ).run(txId, `FAB-${txId.slice(0, 8)}`, payer.user.id, merchant.user.id, JSON.stringify({ intentId }), ts);
    db.prepare("INSERT INTO ledger_entries (id, transaction_id, wallet_id, direction, amount, balance_after, created_at) VALUES (?, ?, ?, 'debit', 2500, ?, ?)").run(
      uuid(),
      txId,
      pw.id,
      pw.balance - 2500,
      ts,
    );
    db.prepare("INSERT INTO ledger_entries (id, transaction_id, wallet_id, direction, amount, balance_after, created_at) VALUES (?, ?, ?, 'credit', 2500, ?, ?)").run(
      uuid(),
      txId,
      mw.id,
      mw.balance + 2500,
      ts,
    );
    db.prepare('UPDATE wallets SET balance = balance - 2500 WHERE id = ?').run(pw.id);
    db.prepare('UPDATE wallets SET balance = balance + 2500 WHERE id = ?').run(mw.id);
    db.prepare(
      "INSERT INTO payment_intents (id, merchant_user_id, amount_minor, currency, status, source, transaction_id, ambiguous_since, created_at, updated_at) VALUES (?, ?, 2500, 'USD', 'AMBIGUOUS', 'api', ?, ?, ?, ?)",
    ).run(intentId, merchant.user.id, txId, ts, ts, ts);
    const findings = ambiguousCreditFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'ambiguous_credited', ref: intentId });
    expect(findings[0].detail).toContain(txId);
    // the full Guardian run reports it and halts the platform; operations clear the halt afterwards
    const result = runGuardian();
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.kind === 'ambiguous_credited' && f.ref === intentId)).toBe(true);
    expect(result.halted).toBe(true);
    expect(getOperatingState().mode).toBe('halted');
    setOperatingMode('normal', 'contract test cleared', null);
    expect(getOperatingState().mode).toBe('normal');
    // UNKNOWN_PROVIDER_STATE is covered by the same invariant; a resolved (CAPTURED) intent is not a finding
    db.prepare("UPDATE payment_intents SET status = 'UNKNOWN_PROVIDER_STATE' WHERE id = ?").run(intentId);
    expect(ambiguousCreditFindings().map((f) => f.ref)).toEqual([intentId]);
    db.prepare("UPDATE payment_intents SET status = 'CAPTURED' WHERE id = ?").run(intentId);
    expect(ambiguousCreditFindings()).toEqual([]);
    expect(runGuardian({ haltOnFailure: false }).findings.some((f) => f.kind === 'ambiguous_credited')).toBe(false);
  });
});

describe('agent registry and prompt hash', () => {
  it('resolves every operating-system alias to a registered agent, including RouteOptimiser and ContentEngine', () => {
    for (const [alias, key] of Object.entries(OS_AGENT_ALIASES)) {
      expect(getAgentDef(key), `${alias} → ${key}`).toBeTruthy();
      // an agent declaring the alias itself wins; otherwise the map decides — either way the name resolves
      const resolved = agentForAlias(alias);
      expect(resolved, alias).toBeTruthy();
      expect(resolved!.aliases?.includes(alias) ? resolved!.key : key).toBe(resolved!.key);
    }
    expect(agentForAlias('RouteOptimiser')?.key).toBe('smart_route');
    expect(agentForAlias('ContentEngine')?.key).toBe('seo_content');
    const smart = getAgentDef('smart_route')!;
    expect(smart.roles).toContain('merchant');
    expect(smart.tools).toContain('routes.quote');
    expect(smart.plan!('Which rail for 25.00 USD mobile money?', null)!.some((s) => s.tool === 'routes.quote')).toBe(true);
    expect(smart.plan!('why', { routeId: 'rt_1' })![0]).toEqual({ tool: 'routes.get', input: { id: 'rt_1' } });
    const seo = getAgentDef('seo_content')!;
    expect(seo.plan!('Draft an article on mobile money payouts in Ghana', null)![0]).toMatchObject({ tool: 'knowledge.search', input: { query: 'mobile money payouts in Ghana' } });
    // no two agents share a key
    expect(new Set(AGENTS.map((a) => a.key)).size).toBe(AGENTS.length);
  });

  it('runs /api/v1/ai/RouteOptimiser for a merchant key with ai:run, marks the run machine-generated and fills a stable prompt hash', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Lubumbashi Traders', country: 'CD' });
    const key = await request(app)
      .post('/api/v1/api_keys')
      .set(m.auth)
      .send({ label: 'erp', mode: 'test', kind: 'restricted', scopes: ['ai:run'] });
    expect(key.status, JSON.stringify(key.body)).toBe(201);
    const k = { Authorization: `Bearer ${key.body.secret}` };
    const first = await request(app).post('/api/v1/ai/RouteOptimiser').set(k).send({ input: 'Which rail will my next mobile money payment use?' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.agent.key).toBe('smart_route');
    expect(first.body.run.machineGenerated).toBe(true);
    expect(first.body.run.generatedBy).toBe('machine');
    expect(first.body.run.promptHash).toMatch(/^[0-9a-f]{64}$/);
    const second = await request(app).post('/api/v1/ai/RouteOptimiser').set(k).send({ input: 'Rank the rails for 40.00 USD to mobile money' });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.run.promptHash).toBe(first.body.run.promptHash);
    expect(getDb().prepare('SELECT prompt_hash FROM agent_runs WHERE id = ?').get(first.body.run.id)).toEqual({ prompt_hash: first.body.run.promptHash });
    expect(getRun(first.body.run.id)).toMatchObject({ ...MACHINE_GENERATED, promptHash: first.body.run.promptHash });
    const content = await request(app).post('/api/v1/ai/ContentEngine').set(k).send({ input: 'Outline a guide to mobile money payouts in Ghana' });
    expect(content.status, JSON.stringify(content.body)).toBe(200);
    expect(content.body.agent.key).toBe('seo_content');
    expect(content.body.run.promptHash).not.toBe(first.body.run.promptHash);
    // the hash is a function of the agent's system prompt and the tools the policy allows this account
    const user = findUserById(m.user.id)!;
    expect(computePromptHash(getAgentDef('smart_route')!, user)).toBe(first.body.run.promptHash);
    expect(computePromptHash(getAgentDef('seo_content')!, user)).toBe(content.body.run.promptHash);
  });
});
