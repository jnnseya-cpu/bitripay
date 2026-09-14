/**
 * System operations console: process and database health, SLO report, API operations (usage per key, error codes,
 * rate limiting), the SLA register with measured breaches, and the gate-to-scale panel. Read-only except the SLA
 * register, whose every change is audited.
 */
import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db';
import { config } from '../../config';
import { validate } from '../../lib/http';
import { requirePermission } from '../../middleware/permissions';
import { audit } from '../../services/audit';
import { sloReport, flushSlo, SLO_TARGETS, SWITCH_AVAILABILITY_TARGET } from '../../middleware/slo';
import { listRails } from '../../services/rails';
import { listGuardianChecks, getOperatingState, suspenseBalances, BALANCE_CLASSES } from '../../services/guardian';
import { listIncidents } from '../../services/switch/connections';
import { gateToScale } from '../../services/goLive';
import { listSla, getSla, createSla, updateSla, deleteSla, slaBreaches, slaInputSchema, SLA_KINDS } from '../../services/sla';

export const adminSystemRouter = Router();
const r = adminSystemRouter;

const startedAt = new Date().toISOString();

function databaseHealth() {
  const db = getDb();
  const journalMode = db.pragma('journal_mode', { simple: true }) as string;
  const pageSize = Number(db.pragma('page_size', { simple: true }));
  const pageCount = Number(db.pragma('page_count', { simple: true }));
  const freelist = Number(db.pragma('freelist_count', { simple: true }));
  const wal = journalMode === 'wal' ? ((db.pragma('wal_checkpoint(PASSIVE)') as any[])[0] ?? null) : null;
  const onDisk = config.databasePath !== ':memory:';
  const fileBytes = onDisk && fs.existsSync(config.databasePath) ? fs.statSync(config.databasePath).size : null;
  const walBytes = onDisk && fs.existsSync(`${config.databasePath}-wal`) ? fs.statSync(`${config.databasePath}-wal`).size : null;
  const migrations = db.prepare('SELECT COUNT(*) c, MAX(name) last FROM migrations').get() as { c: number; last: string | null };
  return {
    path: onDisk ? 'file' : 'memory',
    journalMode,
    pageSize,
    pageCount,
    logicalBytes: pageSize * pageCount,
    freelistPages: freelist,
    fileBytes,
    walBytes,
    /** `busy`, `log` (WAL frames) and `checkpointed` from PRAGMA wal_checkpoint(PASSIVE). */
    walCheckpoint: wal,
    migrations: { count: migrations.c, last: migrations.last },
  };
}

r.get('/health', requirePermission('reports'), (_req, res) => {
  const db = getDb();
  const mem = process.memoryUsage();
  const webhooks = db
    .prepare(
      'SELECT SUM(CASE WHEN success = 0 AND dead = 0 THEN 1 ELSE 0 END) pending, SUM(CASE WHEN dead = 1 THEN 1 ELSE 0 END) dead, SUM(CASE WHEN success = 0 AND attempts > 0 AND dead = 0 THEN 1 ELSE 0 END) retrying FROM webhook_deliveries',
    )
    .get() as {
    pending: number | null;
    dead: number | null;
    retrying: number | null;
  };
  const outbox = db.prepare('SELECT SUM(CASE WHEN delivered_at IS NULL AND dead = 0 THEN 1 ELSE 0 END) pending, SUM(CASE WHEN dead = 1 THEN 1 ELSE 0 END) dead FROM outbox_messages').get() as {
    pending: number | null;
    dead: number | null;
  };
  const rails = listRails();
  const byState: Record<string, number> = { HEALTHY: 0, DEGRADED: 0, UNAVAILABLE: 0, MAINTENANCE: 0 };
  for (const e of rails) byState[e.health.state] = (byState[e.health.state] ?? 0) + 1;
  const lastGuardian = listGuardianChecks(1)[0] ?? null;
  const operating = getOperatingState();
  const openIncidents = listIncidents('OPEN');
  const slo = sloReport();
  res.json({
    generatedAt: new Date().toISOString(),
    process: {
      startedAt,
      uptimeSeconds: Math.round(process.uptime()),
      pid: process.pid,
      node: process.version,
      environment: config.isProduction ? 'production' : config.isTest ? 'test' : 'development',
    },
    memory: { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed, heapTotalBytes: mem.heapTotal, externalBytes: mem.external },
    database: databaseHealth(),
    // jobs.ts keeps its last-run timestamps in module-private variables and exports none of them.
    scheduler: { enabled: !config.isTest, lastRuns: 'not exposed' },
    webhooks: { pending: webhooks.pending ?? 0, retrying: webhooks.retrying ?? 0, dead: webhooks.dead ?? 0 },
    switchOutbox: { pending: outbox.pending ?? 0, dead: outbox.dead ?? 0 },
    rails: {
      total: rails.length,
      byState,
      notUsable: rails.filter((e) => !e.health.usable).map((e) => ({ id: e.id, name: e.name, state: e.health.state, reason: e.health.reason })),
    },
    guardian: {
      operatingMode: operating.mode,
      lastCheck: lastGuardian ? { id: lastGuardian.id, ok: lastGuardian.ok, halted: lastGuardian.halted, at: lastGuardian.createdAt, findings: lastGuardian.findings.length } : null,
      openViolations: lastGuardian && !lastGuardian.ok ? lastGuardian.findings : [],
      balanceClasses: BALANCE_CLASSES,
      suspense: suspenseBalances(),
    },
    incidents: { open: openIncidents.length, items: openIncidents.slice(0, 10) },
    slo: { summary: slo.summary, switchAvailability: slo.switchAvailability, generatedAt: slo.generatedAt },
  });
});

r.get('/slo', requirePermission('reports'), (_req, res) => res.json({ report: sloReport(), targets: SLO_TARGETS, switchAvailabilityTarget: SWITCH_AVAILABILITY_TARGET }));

r.get('/api-ops', requirePermission('reports'), (req, res) => {
  const hours = Math.min(24 * 30, Math.max(1, Number(req.query.hours) || 24));
  flushSlo();
  const db = getDb();
  const sinceMinute = new Date(Date.now() - hours * 3600_000).toISOString().slice(0, 16);
  const keys = db
    .prepare(
      `SELECT u.api_key_id, k.prefix, k.label, k.mode, k.kind, k.user_id, k.revoked_at, SUM(u.count) requests, SUM(u.errors) errors, SUM(u.rate_limited) rate_limited, MAX(u.minute) last_minute
       FROM slo_api_usage u LEFT JOIN api_keys k ON k.id = u.api_key_id WHERE u.minute >= ? GROUP BY u.api_key_id ORDER BY requests DESC LIMIT 200`,
    )
    .all(sinceMinute) as any[];
  const codes = db.prepare('SELECT code, SUM(count) n FROM slo_error_codes WHERE minute >= ? GROUP BY code ORDER BY n DESC LIMIT 25').all(sinceMinute) as { code: string; n: number }[];
  const totals = db
    .prepare(
      'SELECT COALESCE(SUM(count), 0) requests, COALESCE(SUM(errors), 0) errors, COALESCE(SUM(client_errors), 0) client_errors, COALESCE(SUM(rate_limited), 0) rate_limited FROM slo_samples WHERE minute >= ?',
    )
    .get(sinceMinute) as {
    requests: number;
    errors: number;
    client_errors: number;
    rate_limited: number;
  };
  res.json({
    hours,
    since: sinceMinute,
    totals: { requests: totals.requests, serverErrors: totals.errors, clientErrors: totals.client_errors, rateLimited: totals.rate_limited },
    keys: keys.map((k) => ({
      apiKeyId: k.api_key_id,
      prefix: k.prefix ?? null,
      label: k.label ?? null,
      mode: k.mode ?? null,
      kind: k.kind ?? null,
      userId: k.user_id ?? null,
      revoked: !!k.revoked_at,
      requests: k.requests,
      errors: k.errors,
      rateLimited: k.rate_limited,
      lastMinute: k.last_minute,
    })),
    topErrorCodes: codes.map((c) => ({ code: c.code, count: c.n })),
  });
});

// ---------------------------------------------------------------- SLA register (audited CRUD) and breaches
r.get('/sla', requirePermission('reports'), (req, res) =>
  res.json({
    items: listSla({ kind: req.query.kind ? (String(req.query.kind) as any) : null, railId: req.query.rail ? String(req.query.rail) : null }),
    kinds: SLA_KINDS,
    rails: listRails().map((e) => ({ id: e.id, name: e.name, kind: e.kind })),
  }),
);
r.get('/sla/breaches', requirePermission('reports'), (_req, res) => res.json(slaBreaches()));
r.get('/sla/:id', requirePermission('reports'), (req, res) => res.json({ entry: getSla(String(req.params.id)) }));
r.post('/sla', requirePermission('settings'), (req, res) => {
  const body = validate(slaInputSchema, req.body);
  const entry = createSla(body, req.user!.id);
  audit(req.user!.id, 'sla.create', 'sla', entry.id, { counterparty: entry.counterparty, kind: entry.kind, service: entry.service, railId: entry.railId });
  res.status(201).json({ entry });
});
r.put('/sla/:id', requirePermission('settings'), (req, res) => {
  const body = validate(slaInputSchema.partial(), req.body);
  const entry = updateSla(String(req.params.id), body);
  audit(req.user!.id, 'sla.update', 'sla', entry.id, { keys: Object.keys(body) });
  res.json({ entry });
});
r.delete('/sla/:id', requirePermission('settings'), (req, res) => {
  const entry = deleteSla(String(req.params.id));
  audit(req.user!.id, 'sla.delete', 'sla', entry.id, { counterparty: entry.counterparty, service: entry.service });
  res.json({ ok: true, entry });
});

// ---------------------------------------------------------------- gate to scale
r.get('/gate-to-scale', requirePermission('reports'), (req, res) => {
  const q = validate(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), req.query);
  res.json(gateToScale(q.days));
});
