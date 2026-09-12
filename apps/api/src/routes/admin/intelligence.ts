/**
 * Intelligence console: AI gateway economics and routing, ACU policy, the agent mesh (bindings, shadow promotion,
 * kill switches), domain events, Diaspora-Direct rate policies / cards / institutions, offline protocol settings
 * and promises. Mounted at /api/admin/intelligence.
 */
import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../../lib/http';
import { requirePermission } from '../../middleware/permissions';
import { audit } from '../../services/audit';
import { getSetting, setSetting } from '../../services/settings';
import { gatewayReport, getAcuPolicy, getAiRouting, reconcileMargin, projectEconomics, assertPricingAboveFloor, modelHealth, MIN_GROSS_MARGIN } from '../../services/assist/gateway';
import { listBindings, promoteBinding, demoteBinding, setBindingEnabled, setBindingKillSwitch, SHADOW_DAYS } from '../../services/assist/bindings';
import { listDomainEvents, publish, DOMAIN_EVENT_TYPES } from '../../services/bus';
import { MESH_AGENTS, OS_AGENT_ALIASES } from '../../services/assist/registry';
import { signRatePolicy, listRatePolicies, listRateCards, issueRateCard, refreshRateCards, listInstitutions, reviewInstitution } from '../../services/diaspora';
import { getOfflineSettings, listPromises, purgeOfflineNonces } from '../../services/offline';
import { getDb } from '../../db';
import { unprocessable } from '../../lib/errors';
import { getAssistSettings } from '../../services/settings';

export const adminIntelligenceRouter = Router();
const r = adminIntelligenceRouter;

// ---------------------------------------------------------------- AI gateway
r.get('/gateway', requirePermission('agents'), (req, res) => res.json(gatewayReport(Number(req.query.days) || 30)));
r.get('/gateway/models', requirePermission('agents'), (_req, res) => res.json({ models: modelHealth().map((m) => ({ ...m, economics: projectEconomics(m.model, getAcuPolicy().expectedTokensPerRun) })), floor: MIN_GROSS_MARGIN }));
r.put('/gateway/acu-policy', requirePermission('settings'), (req, res) => {
  const b = validate(z.object({ acuPriceMicros: z.number().int().min(1).optional(), acuPerKiloToken: z.number().min(0.001).optional(), minGrossMargin: z.number().min(0).max(0.99).optional(), monthlyBudgetPerUser: z.number().min(0).optional(), monthlyBudgetPerTenant: z.number().min(0).optional(), overage: z.enum(['block', 'bill']).optional(), expectedTokensPerRun: z.number().int().min(100).optional(), expectedTokensStandard: z.number().int().min(100).optional(), expectedTokensDeep: z.number().int().min(100).optional(), alertBelowMargin: z.number().min(0).max(1).optional() }), req.body);
  if (b.minGrossMargin !== undefined && b.minGrossMargin < MIN_GROSS_MARGIN) throw unprocessable(`The margin floor cannot be set below ${MIN_GROSS_MARGIN}`, 'margin_protection_violation', { floor: MIN_GROSS_MARGIN });
  setSetting('acuPolicy', { ...getSetting('acuPolicy', {}), ...b });
  audit(req.user!.id, 'ai.acu_policy', 'settings', 'acuPolicy', b);
  res.json(getAcuPolicy());
});
r.put('/gateway/routing', requirePermission('settings'), (req, res) => {
  const b = validate(z.object({ taskTypes: z.record(z.string(), z.array(z.string().min(3)).min(1)).optional(), timeoutMs: z.number().int().min(1000).max(60_000).optional(), circuitFailures: z.number().int().min(1).optional(), circuitWindowMs: z.number().int().min(10_000).optional(), providers: z.record(z.string(), z.object({ enabled: z.boolean(), apiKey: z.string().optional().nullable(), baseUrl: z.string().url().optional().nullable() })).optional(), rateLimits: z.object({ perUserPerMinute: z.number().int().min(0), perTenantPerMinute: z.number().int().min(0), perAgentPerMinute: z.number().int().min(0) }).partial().optional() }), req.body);
  const current = getSetting<any>('aiRouting', {});
  setSetting('aiRouting', { ...current, ...b, taskTypes: { ...(current.taskTypes ?? {}), ...(b.taskTypes ?? {}) }, providers: { ...(current.providers ?? {}), ...(b.providers ?? {}) }, rateLimits: { ...(current.rateLimits ?? {}), ...(b.rateLimits ?? {}) } });
  audit(req.user!.id, 'ai.routing', 'settings', 'aiRouting', { keys: Object.keys(b) });
  const out = getAiRouting();
  res.json({ ...out, providers: Object.fromEntries(Object.entries(out.providers).map(([k, v]) => [k, { ...v, apiKey: v.apiKey ? '••••••••' : null }])) });
});
r.post('/gateway/reconcile-margin', requirePermission('agents'), (req, res) => {
  const out = reconcileMargin(req.body?.month ? String(req.body.month) : undefined);
  audit(req.user!.id, 'ai.margin.reconcile', 'ai', out.month, out);
  res.json(out);
});
/** Validate a proposed per-run price list against the floor without saving anything. */
r.post('/gateway/validate-pricing', requirePermission('agents'), (req, res) => {
  const b = validate(z.object({ standard: z.number().int().min(0), deep: z.number().int().min(0), priceCurrencyToUsd: z.number().min(0.0001).optional() }), req.body);
  const s = getAssistSettings();
  assertPricingAboveFloor({ standard: b.standard, deep: b.deep }, { standard: s.fastModel || s.model, deep: s.model }, b.priceCurrencyToUsd ?? 1);
  res.json({ ok: true, floor: getAcuPolicy().minGrossMargin });
});
r.get('/gateway/ledger', requirePermission('agents'), (req, res) => {
  const rows = getDb().prepare('SELECT * FROM ai_usage_ledger ORDER BY created_at DESC LIMIT ?').all(Math.min(500, Number(req.query.limit) || 100)) as any[];
  res.json({ items: rows.map((x) => ({ id: x.id, tenantId: x.tenant_id, userId: x.user_id, agent: x.agent, taskType: x.task_type, provider: x.provider, model: x.model, tokensIn: x.tokens_in, tokensOut: x.tokens_out, rawCostMicros: x.raw_cost_micros, acuUsed: x.acu_used, acuRevenueMicros: x.acu_revenue_micros, margin: x.margin, latencyMs: x.latency_ms, outcome: x.outcome, errorCode: x.error_code, billedTo: x.billed_to, createdAt: x.created_at })) });
});

// ---------------------------------------------------------------- agent mesh
r.get('/mesh', requirePermission('agents'), (_req, res) => res.json({ bindings: listBindings(), agents: MESH_AGENTS.map((a) => ({ key: a.key, registryId: a.registryId, name: a.name, aliases: a.aliases ?? [], bindings: a.bindings ?? [], tools: a.tools })), aliases: OS_AGENT_ALIASES, shadowDays: SHADOW_DAYS, eventTypes: DOMAIN_EVENT_TYPES }));
r.post('/mesh/bindings/:id/promote', requirePermission('agents'), (req, res) => {
  const b = validate(z.object({ override: z.string().min(10).max(500).optional().nullable() }), req.body ?? {});
  const out = promoteBinding(String(req.params.id), req.user!.id, b.override ?? null);
  audit(req.user!.id, 'mesh.binding.promote', 'agent_binding', out.id, { override: b.override ?? null });
  res.json(out);
});
r.post('/mesh/bindings/:id/demote', requirePermission('agents'), (req, res) => {
  const b = validate(z.object({ reason: z.string().min(3).max(500) }), req.body);
  const out = demoteBinding(String(req.params.id), req.user!.id, b.reason);
  audit(req.user!.id, 'mesh.binding.demote', 'agent_binding', out.id, { reason: b.reason });
  res.json(out);
});
r.post('/mesh/bindings/:id/enabled', requirePermission('agents'), (req, res) => {
  const b = validate(z.object({ enabled: z.boolean() }), req.body);
  res.json(setBindingEnabled(String(req.params.id), b.enabled, req.user!.id));
});
r.post('/mesh/bindings/:id/kill-switch', requirePermission('agents'), (req, res) => {
  const b = validate(z.object({ on: z.boolean(), reason: z.string().max(300).optional().nullable() }), req.body);
  const out = setBindingKillSwitch(String(req.params.id), b.on, req.user!.id, b.reason);
  audit(req.user!.id, b.on ? 'mesh.binding.kill' : 'mesh.binding.revive', 'agent_binding', out.id, { reason: b.reason ?? null });
  res.json(out);
});
r.get('/events', requirePermission('agents'), (req, res) => res.json({ items: listDomainEvents({ type: req.query.type ? String(req.query.type) : null, aggregateId: req.query.aggregate ? String(req.query.aggregate) : null, since: req.query.since ? String(req.query.since) : null, limit: Number(req.query.limit) || 100 }) }));
/** Publish a test event into the mesh (sandbox drills). */
r.post('/events', requirePermission('agents'), (req, res) => {
  const b = validate(z.object({ type: z.string().min(3).max(60), aggregateId: z.string().max(80).optional().nullable(), payload: z.record(z.string(), z.unknown()).optional() }), req.body);
  const ev = publish(b.type, { ...(b.payload ?? {}), drill: true }, { aggregateId: b.aggregateId ?? null });
  audit(req.user!.id, 'mesh.event.drill', 'domain_event', ev.eventId, { type: b.type });
  res.status(201).json(ev);
});

// ---------------------------------------------------------------- Diaspora-Direct
r.get('/diaspora', requirePermission('treasury'), (_req, res) => res.json({ policies: listRatePolicies(true), cards: listRateCards(), institutions: listInstitutions() }));
r.post('/diaspora/policies', requirePermission('treasury'), (req, res) => {
  const b = validate(z.object({ sourceCurrency: z.string().length(3), destCurrency: z.string().length(3), markupBps: z.number().int().min(0).max(1500), maxValidityHours: z.number().int().min(1).max(4).optional(), feeBps: z.number().int().min(0).max(1000).optional(), feeFixedSourceMinor: z.number().int().min(0).optional(), minSourceMinor: z.number().int().min(0).optional(), maxSourceMinor: z.number().int().min(0).optional(), pin: z.string().optional() }), req.body);
  const p = signRatePolicy(req.user!, b);
  audit(req.user!.id, 'dd.rate_policy.sign', 'fx_rate_policy', p.id, { pair: `${p.sourceCurrency}/${p.destCurrency}`, markupBps: p.markupBps, version: p.version });
  res.status(201).json({ policy: p, card: issueRateCard(p.sourceCurrency, p.destCurrency, { type: 'admin', id: req.user!.id }) });
});
r.post('/diaspora/cards/refresh', requirePermission('treasury'), (_req, res) => res.json(refreshRateCards()));
r.post('/diaspora/institutions/:userId/review', requirePermission('kyc'), (req, res) => {
  const b = validate(z.object({ decision: z.enum(['verified', 'suspended', 'pending']), note: z.string().max(500).optional().nullable() }), req.body);
  const i = reviewInstitution(String(req.params.userId), req.user!, b.decision, b.note);
  audit(req.user!.id, `institution.${b.decision}`, 'institution', i.userId, { note: b.note ?? null });
  res.json(i);
});

// ---------------------------------------------------------------- offline protocol
r.get('/offline', requirePermission('transactions'), (req, res) => {
  const db = getDb();
  const promises = (db.prepare(`SELECT * FROM offline_promises ${req.query.state ? 'WHERE sync_state = ?' : ''} ORDER BY created_at DESC LIMIT ?`).all(...(req.query.state ? [String(req.query.state)] : []), Number(req.query.limit) || 100) as any[]).map((x) => ({ hash: x.intent_hash, merchantId: x.merchant_user_id, payerId: x.payer_user_id, deviceId: x.payer_device_id, amountMinor: x.amount_minor, currency: x.currency, state: x.sync_state, rejectReason: x.reject_reason, transactionId: x.transaction_id, counter: x.payer_device_counter, promisedAt: x.promised_at, syncedAt: x.synced_at }));
  const stats = db.prepare('SELECT sync_state, COUNT(*) n, COALESCE(SUM(amount_minor), 0) s FROM offline_promises GROUP BY sync_state').all() as any[];
  res.json({ settings: getOfflineSettings(), stats: stats.map((s) => ({ state: s.sync_state, count: s.n, amountMinor: s.s })), devices: (db.prepare('SELECT COUNT(*) c FROM offline_devices').get() as any).c, promises });
});
r.put('/offline/settings', requirePermission('settings'), (req, res) => {
  const b = validate(z.object({ enabled: z.boolean().optional(), maxPerPromiseBase: z.number().int().min(0).optional(), maxOutstandingPerDeviceBase: z.number().int().min(0).optional(), promiseValidityHours: z.number().int().min(1).max(72).optional(), qrTtlSeconds: z.number().int().min(60).max(3600).optional() }), req.body);
  setSetting('offline', { ...getSetting('offline', {}), ...b });
  audit(req.user!.id, 'offline.settings', 'settings', 'offline', b);
  res.json(getOfflineSettings());
});
r.post('/offline/purge-nonces', requirePermission('transactions'), (_req, res) => res.json({ purged: purgeOfflineNonces() }));
r.get('/offline/users/:userId', requirePermission('transactions'), (req, res) => res.json({ data: listPromises(String(req.params.userId), { limit: 100 }) }));
export { wrap };
