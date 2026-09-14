/**
 * Operations contract: SLO measurement (route classes, ring buffers, per-minute roll-ups, API-key and rate-limit
 * counters), the system health and API operations views, the SLA register with measured breaches, the gate to scale
 * computed from 30 days of real data, rail maintenance windows and the capability matrix editor.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, adminToken } from './helpers';
import { getDb } from '../db';
import { classifyRoute, recordSlo, flushSlo, measure, sloReport, resetSloMemory, SLO_TARGETS } from '../middleware/slo';
import { gateToScale } from '../services/goLive';
import { pauseConnector, resumeConnector } from '../services/rails';
import { now, uuid } from '../lib/ids';

let app: ReturnType<typeof setupApp>;
let admin: Awaited<ReturnType<typeof adminToken>>;

beforeAll(async () => {
  app = setupApp();
  resetSloMemory();
  admin = await adminToken(app);
});

describe('SLO measurement', () => {
  it('classifies partner, QR, KODA, money and switch routes into their SLO classes', () => {
    expect(classifyRoute('POST', '/api/v1/payment_intents')).toBe('intent_create');
    expect(classifyRoute('POST', '/v1/qr/abc/intent')).toBe('intent_create');
    expect(classifyRoute('POST', '/api/v1/qr-intents')).toBe('intent_create');
    expect(classifyRoute('GET', '/api/v1/payment_intents')).toBe('other');
    expect(classifyRoute('GET', '/api/v1/resolve/REF-1')).toBe('qr_resolve');
    expect(classifyRoute('GET', '/api/qr/abc')).toBe('qr_resolve');
    expect(classifyRoute('POST', '/api/v1/verifications')).toBe('koda_verify');
    expect(classifyRoute('POST', '/api/money/routes')).toBe('money_post');
    expect(classifyRoute('POST', '/api/v1/payments')).toBe('switch');
    expect(classifyRoute('GET', '/v1/participants')).toBe('switch');
    expect(classifyRoute('GET', '/api/admin/stats')).toBe('other');
  });

  it('times real requests through the middleware and rolls them up per class with a met/missed verdict', async () => {
    // A real HTTP request lands in the qr_resolve class whatever its status; the intent creation class is decided by method + path.
    await request(app).get('/api/v1/resolve/NOPE-1');
    await request(app).post('/api/v1/payment_intents').send({});
    // Synthetic samples with a known distribution: with the real request above, 101 samples of which the two slowest are 900 ms → nearest-rank p99 = 900.
    for (let i = 0; i < 98; i += 1) recordSlo({ className: 'intent_create', latencyMs: 20 + (i % 5), statusCode: 201 });
    recordSlo({ className: 'intent_create', latencyMs: 900, statusCode: 201 });
    recordSlo({ className: 'intent_create', latencyMs: 900, statusCode: 201 });
    for (let i = 0; i < 50; i += 1) recordSlo({ className: 'koda_verify', latencyMs: 300, statusCode: 200 });
    const flushed = flushSlo();
    expect(flushed.classes).toBeGreaterThanOrEqual(2);
    const rows = getDb().prepare('SELECT class, count, p50_ms, p95_ms, p99_ms, errors, client_errors FROM slo_samples ORDER BY class').all() as any[];
    const intent = rows.find((r) => r.class === 'intent_create');
    expect(intent.count).toBeGreaterThanOrEqual(100);
    expect(intent.p99_ms).toBe(900);
    expect(rows.find((r) => r.class === 'qr_resolve').count).toBeGreaterThanOrEqual(1);

    const report = sloReport();
    const ic = report.classes.find((c) => c.class === 'intent_create')!;
    expect(ic.target).toEqual(SLO_TARGETS.intent_create);
    expect(ic.windows['1h'].p99Ms).toBe(900);
    expect(ic.windows['1h'].met).toBe(false); // 900 ms p99 misses the 300 ms target
    const kv = report.classes.find((c) => c.class === 'koda_verify')!;
    expect(kv.windows['24h'].p95Ms).toBe(300);
    expect(kv.windows['24h'].met).toBe(true);
    // No switch traffic → availability is unknown, not assumed.
    expect(report.switchAvailability['24h'].availability).toBeNull();
    expect(report.switchAvailability['24h'].met).toBeNull();
    expect(report.switchAvailability.target).toBe(0.9995);

    const res = await request(app).get('/api/admin/system/slo').set(admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.report.classes.map((c: any) => c.class)).toEqual(expect.arrayContaining(['intent_create', 'qr_resolve', 'koda_verify', 'money_post', 'switch', 'other']));
    expect(res.body.targets.money_post.maxMs).toBe(50);
  });

  it('measures in-process spans (sync and async) and computes switch availability from server errors', async () => {
    const value = measure('ledger_write', () => 42);
    expect(value).toBe(42);
    const asyncValue = await measure('ledger_write', async () => 'done');
    expect(asyncValue).toBe('done');
    expect(() =>
      measure('ledger_write', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    for (let i = 0; i < 9_999; i += 1) recordSlo({ className: 'switch', latencyMs: 40, statusCode: 200 });
    recordSlo({ className: 'switch', latencyMs: 40, statusCode: 503 });
    flushSlo();
    const report = sloReport();
    const span = report.classes.find((c) => c.class === 'ledger_write')!;
    expect(span.windows['1h'].sampled).toBe(3);
    expect(span.windows['1h'].errors).toBe(1);
    expect(span.target).toBeNull();
    expect(report.switchAvailability['24h'].requests).toBe(10_000);
    expect(report.switchAvailability['24h'].availability).toBe(0.9999);
    expect(report.switchAvailability['24h'].met).toBe(true); // 99.99 % ≥ 99.95 %
  });

  it('counts requests per API key, rate-limited responses and error codes in the API operations view', async () => {
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'Ops Shop' });
    const keyRow = { id: uuid(), userId: merchant.user.id };
    getDb()
      .prepare("INSERT INTO api_keys (id, user_id, label, prefix, key_hash, mode, created_at) VALUES (?, ?, 'ops', 'sk_test_opsk', ?, 'test', ?)")
      .run(keyRow.id, keyRow.userId, `hash-${keyRow.id}`, now());
    for (let i = 0; i < 7; i += 1) recordSlo({ className: 'other', latencyMs: 5, statusCode: 200, apiKeyId: keyRow.id });
    recordSlo({ className: 'other', latencyMs: 5, statusCode: 429, apiKeyId: keyRow.id, errorCode: 'rate_limited' });
    recordSlo({ className: 'other', latencyMs: 5, statusCode: 404, apiKeyId: keyRow.id, errorCode: 'not_found' });
    recordSlo({ className: 'other', latencyMs: 5, statusCode: 404, errorCode: 'not_found' });
    const res = await request(app).get('/api/admin/system/api-ops').set(admin.auth);
    expect(res.status).toBe(200);
    const key = res.body.keys.find((k: any) => k.apiKeyId === keyRow.id);
    expect(key).toMatchObject({ prefix: 'sk_test_opsk', label: 'ops', mode: 'test', requests: 9, errors: 2, rateLimited: 1 });
    expect(res.body.totals.rateLimited).toBeGreaterThanOrEqual(1);
    const nf = res.body.topErrorCodes.find((c: any) => c.code === 'not_found');
    expect(nf.count).toBeGreaterThanOrEqual(2);
    expect(res.body.topErrorCodes.some((c: any) => c.code === 'rate_limited')).toBe(true);
  });
});

describe('System health', () => {
  it('reports process, database, scheduler, webhook backlog, rails, Guardian and SLO summary', async () => {
    const res = await request(app).get('/api/admin/system/health').set(admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.process.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(res.body.memory.rssBytes).toBeGreaterThan(0);
    expect(res.body.database.journalMode).toBeTruthy();
    expect(res.body.database.migrations.count).toBeGreaterThanOrEqual(31);
    expect(res.body.database.migrations.last).toMatch(/^\d{3}_.+\.sql$/);
    expect(res.body.database.pageCount).toBeGreaterThan(0);
    expect(res.body.scheduler.lastRuns).toBe('not exposed');
    expect(res.body.webhooks).toEqual({ pending: 0, retrying: 0, dead: 0 });
    expect(res.body.rails.total).toBeGreaterThan(0);
    expect(Object.keys(res.body.rails.byState)).toEqual(expect.arrayContaining(['HEALTHY', 'DEGRADED', 'UNAVAILABLE', 'MAINTENANCE']));
    expect(res.body.guardian.operatingMode).toBe('normal');
    expect(res.body.guardian.openViolations).toEqual([]);
    expect(res.body.slo.summary).toHaveProperty('met');
    expect(res.body.slo.switchAvailability.target).toBe(0.9995);
  });

  it('refuses the system views to staff administrators without the reports permission', async () => {
    const created = await request(app)
      .post('/api/admin/users')
      .set(admin.auth)
      .send({ fullName: 'Support Only', email: 'support-only@bitripay.local', password: 'Support123!', role: 'admin', permissions: ['support'] });
    expect(created.status).toBe(201);
    const login = await request(app).post('/api/auth/login').send({ identifier: 'support-only@bitripay.local', password: 'Support123!' });
    const auth = { Authorization: `Bearer ${login.body.token}` };
    const health = await request(app).get('/api/admin/system/health').set(auth);
    expect(health.status).toBe(403);
    expect(health.body.error.code).toBe('permission_denied');
    const sla = await request(app).post('/api/admin/system/sla').set(auth).send({ counterparty: 'X', kind: 'vendor', service: 'y' });
    expect(sla.status).toBe(403);
  });
});

describe('Gate to scale', () => {
  it('is honestly not ready on an empty platform and says why for each item', async () => {
    const gate = gateToScale();
    expect(gate.ready).toBe(false);
    expect(gate.windowDays).toBe(30);
    expect(gate.items.map((i) => i.id)).toEqual(['auto_reconciliation', 'exception_rate', 'guardian_halts', 'fraud_loss']);
    for (const item of gate.items) {
      expect(item.ok).toBe(false);
      expect(item.blocking).toBe(true);
      expect(item.fix).toBeTruthy();
    }
    expect(gate.items[0].detail).toContain('No reconciliation run');
    expect(gate.items[1].detail).toContain('No paid payment');
    expect(gate.items[2].detail).toContain('Guardian has not run');
    expect(gate.items[3].detail).toContain('No captured volume');
    const res = await request(app).get('/api/admin/go-live').set(admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.gateToScale.ready).toBe(false);
    expect(res.body.gateToScale.items).toHaveLength(4);
    const direct = await request(app).get('/api/admin/system/gate-to-scale?days=7').set(admin.auth);
    expect(direct.status).toBe(200);
    expect(direct.body.windowDays).toBe(7);
  });

  it('becomes ready once 30 days of real rows meet every threshold, and flips back on a Guardian halt', async () => {
    const db = getDb();
    const t = now();
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'Gate Shop' });
    // 98 % auto-reconciliation across two runs.
    db.prepare(
      "INSERT INTO reconciliation_runs (id, connection_id, cycle_ref, coverage, totals, matched, cases_opened, complete, run_by, created_at) VALUES (?, 'stripe', '2026-09-10', '{}', '{}', 60, 1, 1, NULL, ?)",
    ).run(uuid(), t);
    db.prepare(
      "INSERT INTO reconciliation_runs (id, connection_id, cycle_ref, coverage, totals, matched, cases_opened, complete, run_by, created_at) VALUES (?, 'NATIONAL_SWITCH_CD', '2026-09-10', '{}', '{}', 38, 1, 1, NULL, ?)",
    ).run(uuid(), t);
    // 200 settled intents of 50.00 USD; one dispute lost at 1.00 USD → 1 bps; one exception on 200 payments → 0.5 %.
    const insertIntent = db.prepare("INSERT INTO payment_intents (id, merchant_user_id, amount_minor, currency, status, created_at, updated_at) VALUES (?, ?, 5000, 'USD', 'SETTLED', ?, ?)");
    for (let i = 0; i < 200; i += 1) insertIntent.run(uuid(), merchant.user.id, t, t);
    db.prepare(
      "INSERT INTO disputes (id, merchant_user_id, opened_by, reason_code, amount_minor, currency, rail, status, deadline_at, decision, decided_at, created_at, updated_at) VALUES (?, ?, 'customer', 'fraud', 100, 'USD', 'card', 'LOST', ?, 'LOST', ?, ?, ?)",
    ).run(uuid(), merchant.user.id, t, t, t, t);
    db.prepare("INSERT INTO guardian_checks (id, ok, transactions_checked, findings, halted, created_at) VALUES (?, 1, 200, '[]', 0, ?)").run(uuid(), t);

    const gate = gateToScale();
    expect(gate.items.find((i) => i.id === 'auto_reconciliation')).toMatchObject({ ok: true });
    expect(gate.items.find((i) => i.id === 'auto_reconciliation')!.detail).toContain('98.00 %');
    expect(gate.items.find((i) => i.id === 'exception_rate')).toMatchObject({ ok: true });
    expect(gate.items.find((i) => i.id === 'exception_rate')!.detail).toContain('0.50 %');
    expect(gate.items.find((i) => i.id === 'guardian_halts')).toMatchObject({ ok: true });
    expect(gate.items.find((i) => i.id === 'fraud_loss')).toMatchObject({ ok: true });
    expect(gate.items.find((i) => i.id === 'fraud_loss')!.detail).toContain('1.00 bps');
    expect(gate.ready).toBe(true);

    // One Guardian halt inside the window closes the gate again.
    db.prepare('INSERT INTO guardian_checks (id, ok, transactions_checked, findings, halted, created_at) VALUES (?, 0, 201, \'[{"kind":"unbalanced"}]\', 1, ?)').run(uuid(), now());
    const after = gateToScale();
    expect(after.items.find((i) => i.id === 'guardian_halts')).toMatchObject({ ok: false });
    expect(after.items.find((i) => i.id === 'guardian_halts')!.detail).toContain('1 halt(s)');
    expect(after.ready).toBe(false);
  });
});

describe('SLA register', () => {
  let id: string;
  it('creates, lists, updates, reads and deletes entries with an audit trail', async () => {
    const created = await request(app).post('/api/admin/system/sla').set(admin.auth).send({
      counterparty: 'Demo Processor Ltd',
      kind: 'processor',
      service: 'Card acquiring (Stripe)',
      railId: 'wallet',
      availabilityTarget: 0.999,
      latencyTargetMs: 1500,
      supportContact: 'support@processor.example',
      escalationContact: '+243 000 000 000 (duty manager)',
      maintenanceWindow: 'Sunday 02:00–04:00 UTC',
      incidentContact: 'incidents@processor.example',
      reviewDate: '2027-01-31',
      documentRef: 'MSA-2026-014 §7',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    id = created.body.entry.id;
    expect(created.body.entry).toMatchObject({
      counterparty: 'Demo Processor Ltd',
      kind: 'processor',
      railId: 'wallet',
      availabilityTarget: 0.999,
      reviewDate: '2027-01-31',
      createdBy: expect.any(String),
    });

    const bad = await request(app).post('/api/admin/system/sla').set(admin.auth).send({ counterparty: 'Nope', kind: 'bank', service: 'x-service', railId: 'no-such-rail' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('unknown_rail');
    const badKind = await request(app).post('/api/admin/system/sla').set(admin.auth).send({ counterparty: 'Nope', kind: 'telco', service: 'x-service' });
    expect(badKind.status).toBe(400);

    const list = await request(app).get('/api/admin/system/sla?kind=processor').set(admin.auth);
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: any) => i.id)).toContain(id);
    expect(list.body.kinds).toEqual(['processor', 'operator', 'switch', 'bank', 'vendor']);
    expect(list.body.rails.some((r: any) => r.id === 'wallet')).toBe(true);

    const updated = await request(app).put(`/api/admin/system/sla/${id}`).set(admin.auth).send({ latencyTargetMs: 1200, escalationContact: null });
    expect(updated.status).toBe(200);
    expect(updated.body.entry.latencyTargetMs).toBe(1200);
    expect(updated.body.entry.escalationContact).toBeNull();
    expect(updated.body.entry.supportContact).toBe('support@processor.example');

    const one = await request(app).get(`/api/admin/system/sla/${id}`).set(admin.auth);
    expect(one.body.entry.id).toBe(id);

    const actions = (getDb().prepare("SELECT action FROM audit_logs WHERE target_type = 'sla' AND target_id = ? ORDER BY created_at").all(id) as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(['sla.create', 'sla.update']);
  });

  it('reports a breach when the measured rail health misses the commitment, and none when it recovers', async () => {
    const healthy = await request(app).get('/api/admin/system/sla/breaches').set(admin.auth);
    expect(healthy.status).toBe(200);
    const before = healthy.body.items.find((i: any) => i.entry.id === id);
    expect(before.measured.source).toBe('rail_health');
    expect(before.breached).toBe(false);
    expect(before.reviewOverdue).toBe(false);

    pauseConnector('wallet', 'ops', 'processor incident');
    const paused = await request(app).get('/api/admin/system/sla/breaches').set(admin.auth);
    const during = paused.body.items.find((i: any) => i.entry.id === id);
    expect(during.measured.state).toBe('UNAVAILABLE');
    expect(during.breached).toBe(true);
    expect(during.reasons.join(' ')).toContain('UNAVAILABLE');
    expect(paused.body.breached).toBeGreaterThanOrEqual(1);
    resumeConnector('wallet', 'ops');

    // A switch commitment is measured against the SLO availability roll-up (99.99 % measured above ≥ 99.95 % committed).
    const sw = await request(app)
      .post('/api/admin/system/sla')
      .set(admin.auth)
      .send({ counterparty: 'Switch Monétique National', kind: 'switch', service: 'Merchant payments', availabilityTarget: 0.9995, reviewDate: '2020-01-01' });
    expect(sw.status).toBe(201);
    const breaches = await request(app).get('/api/admin/system/sla/breaches').set(admin.auth);
    const swItem = breaches.body.items.find((i: any) => i.entry.id === sw.body.entry.id);
    expect(swItem.measured.source).toBe('switch_slo');
    expect(swItem.measured.availability).toBe(0.9999);
    expect(swItem.breached).toBe(false);
    expect(swItem.reviewOverdue).toBe(true);

    const removed = await request(app).delete(`/api/admin/system/sla/${id}`).set(admin.auth);
    expect(removed.status).toBe(200);
    expect((await request(app).get(`/api/admin/system/sla/${id}`).set(admin.auth)).status).toBe(404);
    expect(getDb().prepare("SELECT COUNT(*) c FROM audit_logs WHERE action = 'sla.delete' AND target_id = ?").get(id)).toEqual({ c: 1 });
  });
});

describe('Rail maintenance and capability matrix', () => {
  it('opens and clears an administrator maintenance window on a rail through the switch console', async () => {
    const on = await request(app).post('/api/admin/switch/rails/wallet/maintenance').set(admin.auth).send({ on: true, reason: 'ledger upgrade window' });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.health.state).toBe('MAINTENANCE');
    expect(on.body.health.usable).toBe(false);
    expect(on.body.health.maintenance.reason).toBe('ledger upgrade window');
    const health = await request(app).get('/api/admin/system/health').set(admin.auth);
    expect(health.body.rails.byState.MAINTENANCE).toBeGreaterThanOrEqual(1);
    expect(health.body.rails.notUsable.some((r: any) => r.id === 'wallet' && r.state === 'MAINTENANCE')).toBe(true);
    const off = await request(app).post('/api/admin/switch/rails/wallet/maintenance').set(admin.auth).send({ on: false });
    expect(off.status).toBe(200);
    expect(off.body.health.state).toBe('HEALTHY');
    expect(off.body.health.maintenance).toBeNull();
    const missing = await request(app).post('/api/admin/switch/rails/no-such-rail/maintenance').set(admin.auth).send({ on: true, reason: 'unknown rail' });
    expect(missing.status).toBe(404);
    const actions = (
      getDb().prepare("SELECT action FROM audit_logs WHERE target_type = 'rail' AND target_id = 'wallet' AND action LIKE 'rail.maintenance%' ORDER BY created_at").all() as { action: string }[]
    ).map((a) => a.action);
    expect(actions).toEqual(['rail.maintenance.on', 'rail.maintenance.off']);
  });

  it('exposes the country × method × rail matrix and writes edits through to the enforced country capabilities', async () => {
    const matrix = await request(app).get('/api/admin/switch/capability-matrix').set(admin.auth);
    expect(matrix.status).toBe(200);
    expect(matrix.body.methods.map((m: any) => m.method)).toEqual(['wallet', 'card', 'mobile_money', 'bank', 'national_switch', 'bitcoin']);
    const cd = matrix.body.items.find((c: any) => c.country === 'CD');
    expect(cd.methods.find((m: any) => m.method === 'mobile_money').allowed).toBe(true);
    expect(cd.methods.find((m: any) => m.method === 'national_switch').allowed).toBe(true);
    const wallet = cd.methods.find((m: any) => m.method === 'wallet');
    expect(wallet.rails.some((r: any) => r.id === 'wallet' && r.enabled === true)).toBe(true);

    const edited = await request(app)
      .put('/api/admin/switch/capability-matrix/cd')
      .set(admin.auth)
      .send({ methods: { mobile_money: false }, maxPerTransaction: 250000 });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.capabilities.mobileMoney).toBe(false);
    expect(edited.body.capabilities.maxPerTransaction).toBe(250000);
    expect(edited.body.matrix.methods.find((m: any) => m.method === 'mobile_money').allowed).toBe(false);
    // The same source of truth the policy and routing layers read.
    const caps = await request(app).get('/api/admin/capabilities/CD').set(admin.auth);
    expect(caps.body.capabilities.mobileMoney).toBe(false);
    expect(caps.body.capabilities.maxPerTransaction).toBe(250000);
    const restored = await request(app)
      .put('/api/admin/switch/capability-matrix/CD')
      .set(admin.auth)
      .send({ methods: { mobile_money: true }, maxPerTransaction: 0 });
    expect(restored.body.capabilities.mobileMoney).toBe(true);
    const bad = await request(app)
      .put('/api/admin/switch/capability-matrix/CD')
      .set(admin.auth)
      .send({ methods: { teleport: true } });
    expect(bad.status).toBe(400);
    expect(getDb().prepare("SELECT COUNT(*) c FROM audit_logs WHERE action = 'capabilities.matrix.update' AND target_id = 'CD'").get()).toEqual({ c: 2 });
  });
});
