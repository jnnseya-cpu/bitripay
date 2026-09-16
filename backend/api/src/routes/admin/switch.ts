/**
 * CMP-13 Operations console API for the National Switch Gateway and the rail registry. Mounted at /api/admin/switch.
 * Every mutation is permission-gated (20.2 roles), audited, and the sensitive ones keep author and approver apart.
 * There is deliberately no "mark as paid": projections change only through authenticated observations or the
 * dual-approved correction procedures exposed here.
 */
import { Router } from 'express';
import { z } from 'zod';
import fs from 'node:fs';
import { validate, wrap } from '../../lib/http';
import { requirePermission } from '../../middleware/permissions';
import { audit } from '../../services/audit';
import { assertAdminStepUp } from '../../services/verification';
import { aggregationFeesOverview, closeAggregationPeriod, settleInvoice } from '../../services/switch/fees';
import { getDb } from '../../db';
import { config } from '../../config';
import { now, shortCode } from '../../lib/ids';
import { parseJson } from '../../lib/json';
import { getSetting, setSetting } from '../../services/settings';
import {
  listConnections,
  getConnection,
  upsertConnection,
  setCertification,
  setCertificate,
  setEnabled,
  setLinkState,
  probeSwitchConnections,
  emissionGate,
  enableBlockers,
  listIncidents,
  acknowledgeIncident,
  resolveIncident,
  certificateAlerts,
} from '../../services/switch/connections';
import {
  listParticipants,
  upsertParticipant,
  approveParticipant,
  setParticipantStatus,
  upsertPair,
  setPairStatus,
  listPairs,
  registryStatus,
  serviceAvailability,
  SWITCH_PRODUCTS,
} from '../../services/switch/participants';
import { listPolicies, createPolicyDraft, approvePolicy, activatePolicy, listExceptions, createException, approveException, decideRoute, activePolicy } from '../../services/switch/policy';
import { simulatorFor, SIMULATOR_SCENARIOS } from '../../services/switch/adapter';
import {
  listPayments,
  paymentTimeline,
  cancelPayment,
  inquirePayment,
  dispatchOutbox,
  recoverUncertainEmissions,
  currentLease,
  acquireLease,
  ingestInbound,
  listInbox,
  listOutbox,
  retryOutbox,
  discardInbox,
  listCatalogue,
  upsertCatalogueEntry,
  verifyBinding,
  activateBinding,
  suspendBinding,
  getBinding,
  listAllBindings,
  resolveLinkedOperation,
  nationalView,
  expirePayments,
} from '../../services/switch/payments';
import {
  importReport,
  listImports,
  runReconciliation,
  listRuns,
  listCases,
  getCase,
  assignCase,
  proposeResolution,
  approveClosure,
  reconciliationOverview,
  checkCoverage,
} from '../../services/switch/reconciliation';
import { readEvidence, listEvidence, verifyVault } from '../../services/switch/vault';
import { listRails, getRail, pauseConnector, resumeConnector, probeConnectors, connectorSeries, scoreConnectors } from '../../services/rails';
import { setRailMaintenance } from '../../services/rails';
import { countryCapabilities, listCountryCapabilities, setCountryCapabilities, type CountryCapabilities } from '../../services/capabilities';

export const adminSwitchRouter = Router();
const r = adminSwitchRouter;

// ---------------------------------------------------------------- connections & connectivity view
r.get('/connections', requirePermission('switch'), (_req, res) => res.json({ items: listConnections().map((c) => ({ ...c, gate: emissionGate(c), blockers: enableBlockers(c) })) }));
r.put('/connections/:id', requirePermission('security'), (req, res) => {
  const b = validate(
    z.object({
      name: z.string().min(2),
      country: z.string().length(2),
      schemeId: z.string().min(2),
      accessMode: z.enum(['DIRECT', 'SPONSORED']).optional(),
      participantId: z.string().optional().nullable(),
      sponsorId: z.string().optional().nullable(),
      adapter: z.enum(['simulator', 'certified']).optional(),
      environment: z.enum(['simulation', 'sandbox', 'production']).optional(),
      profileVersion: z.string().optional().nullable(),
      quotaPerSecond: z.number().int().min(1).max(10_000).optional(),
      inquiryReservePct: z.number().int().min(0).max(90).optional(),
      endpoint: z.string().optional().nullable(),
    }),
    req.body,
  );
  const c = upsertConnection({ id: String(req.params.id), ...b }, req.user!.id);
  audit(req.user!.id, 'switch.connection.upsert', 'switch_connection', c.id, { accessMode: c.accessMode, environment: c.environment, adapter: c.adapter });
  res.json({ connection: c, blockers: enableBlockers(c) });
});
r.post('/connections/:id/certification', requirePermission('security'), (req, res) => {
  const b = validate(
    z.object({
      status: z.enum(['INTERNAL_TESTS', 'SANDBOX', 'CERTIFIED', 'REVOKED']),
      evidenceRef: z.string().optional().nullable(),
      profileVersion: z.string().optional().nullable(),
      approverId: z.string().optional().nullable(),
    }),
    req.body,
  );
  const c = setCertification(String(req.params.id), b.status, b, req.user!.id);
  audit(req.user!.id, 'switch.certification', 'switch_connection', c.id, { status: b.status, evidenceRef: b.evidenceRef ?? null, approverId: b.approverId ?? null });
  res.json({ connection: c, blockers: enableBlockers(c) });
});
r.post('/connections/:id/certificate', requirePermission('security'), (req, res) => {
  const b = validate(
    z.object({
      fingerprint: z.string().optional().nullable(),
      subject: z.string().optional().nullable(),
      notBefore: z.string().optional().nullable(),
      notAfter: z.string().optional().nullable(),
      status: z.enum(['VALID', 'EXPIRED', 'REVOKED', 'MISSING']).optional(),
      owner: z.string().optional().nullable(),
      usage: z.string().optional().nullable(),
      revocationProcedure: z.string().optional().nullable(),
    }),
    req.body,
  );
  const c = setCertificate(String(req.params.id), b, req.user!.id);
  audit(req.user!.id, 'switch.certificate', 'switch_connection', c.id, { fingerprint: b.fingerprint ?? null, notAfter: b.notAfter ?? null, status: b.status ?? null });
  res.json({ connection: c, blockers: enableBlockers(c) });
});
r.post('/connections/:id/enable', requirePermission('security'), (req, res) => {
  const b = validate(z.object({ enabled: z.boolean() }), req.body);
  const c = setEnabled(String(req.params.id), b.enabled, req.user!.id);
  audit(req.user!.id, b.enabled ? 'switch.enable' : 'switch.disable', 'switch_connection', c.id, {});
  res.json({ connection: c });
});
r.post(
  '/connections/:id/probe',
  requirePermission('switch'),
  wrap(async (req, res) => {
    const results = await probeSwitchConnections();
    res.json({ results: results.filter((x) => x.id === String(req.params.id)), connection: getConnection(String(req.params.id)) });
  }),
);
/** Simulator only: take the simulated link down/up (degraded-mode and fencing exercises). */
r.post('/connections/:id/link', requirePermission('switch'), (req, res) => {
  const b = validate(z.object({ up: z.boolean() }), req.body);
  const c = getConnection(String(req.params.id));
  if (!c.simulation) return res.status(409).json({ error: { code: 'not_simulation', message: 'Only a simulated link can be toggled by hand' } });
  simulatorFor(c).setLink(b.up);
  setLinkState(c.id, b.up ? 'UP' : 'DOWN', { ok: b.up, message: b.up ? 'SIMULATION link up' : 'SIMULATION link down (operator-induced)', simulation: true });
  audit(req.user!.id, 'switch.simulator.link', 'switch_connection', c.id, { up: b.up });
  res.json({ connection: getConnection(c.id) });
});
/** Simulator only: inject an inbound message for a payment (duplicate success, contradictory reject, bad signature, unknown code, stale pending, tampered same id). */
r.post('/connections/:id/simulate-inbound', requirePermission('switch'), (req, res) => {
  const b = validate(
    z.object({
      stableMessageId: z.string().min(1),
      variant: z.enum(['completed', 'completed_dup', 'reject_contradiction', 'bad_signature', 'unknown_code', 'pending_stale', 'tampered_same_id']),
      externalMessageId: z.string().optional(),
    }),
    req.body,
  );
  const c = getConnection(String(req.params.id));
  if (!c.simulation) return res.status(409).json({ error: { code: 'not_simulation', message: 'Inbound injection exists only for the simulator' } });
  const msg = simulatorFor(c).inboundFor(b.stableMessageId, b.variant, { externalMessageId: b.externalMessageId });
  const result = ingestInbound(c.id, msg.raw, { source: b.variant === 'reject_contradiction' ? 'DEBTOR' : 'CREDITOR', receivedAt: now(), channel: 'simulator', remote: 'simulator' });
  audit(req.user!.id, 'switch.simulator.inbound', 'switch_connection', c.id, { variant: b.variant, stableMessageId: b.stableMessageId, outcome: result.outcome });
  res.json({ externalMessageId: msg.externalMessageId, ...result });
});
r.get('/connections/:id/simulator', requirePermission('switch'), (req, res) => {
  const c = getConnection(String(req.params.id));
  res.json({ simulation: c.simulation, scenarios: SIMULATOR_SCENARIOS, records: c.simulation ? simulatorFor(c).records() : [] });
});
r.get('/connections/:id/national-view', requirePermission('switch'), (req, res) => res.json(nationalView(String(req.params.id))));
r.post('/certificates/check', requirePermission('security'), (_req, res) => res.json(certificateAlerts()));

// ---------------------------------------------------------------- participants, pairs, registry
r.get('/participants', requirePermission('switch'), (req, res) =>
  res.json({
    items: listParticipants({ country: req.query.country ? String(req.query.country) : null, status: req.query.status ? String(req.query.status) : null }),
    registry: registryStatus(String(req.query.country ?? 'CD')),
  }),
);
r.post('/participants', requirePermission('switch'), (req, res) => {
  const b = validate(
    z.object({
      id: z.string().min(3),
      name: z.string().min(2),
      kind: z.enum(['BANK', 'MMO', 'PSP', 'SWITCH', 'SPONSOR', 'AGGREGATOR']),
      country: z.string().length(2),
      currencies: z.array(z.string().length(3)),
      services: z.array(z.string()),
      channels: z.array(z.string()).optional(),
      routingIds: z.record(z.string(), z.string()).optional(),
      source: z.enum(['SIMULATION', 'OFFICIAL']).optional(),
      evidenceRef: z.string().optional().nullable(),
      validFrom: z.string().optional().nullable(),
      validTo: z.string().optional().nullable(),
    }),
    req.body,
  );
  const p = upsertParticipant(b, req.user!.id);
  audit(req.user!.id, 'switch.participant.upsert', 'participant', p.id, { version: p.version, source: p.source });
  res.status(201).json({ participant: p });
});
r.post('/participants/:id/approve', requirePermission('approvals'), (req, res) => {
  const p = approveParticipant(String(req.params.id), req.user!.id);
  audit(req.user!.id, 'switch.participant.approve', 'participant', p.id, { version: p.version });
  res.json({ participant: p });
});
r.post('/participants/:id/status', requirePermission('switch'), (req, res) => {
  const b = validate(z.object({ status: z.enum(['SUSPENDED', 'RETIRED', 'ACTIVE']), reason: z.string().min(3).max(300) }), req.body);
  const p = setParticipantStatus(String(req.params.id), b.status, req.user!.id, b.reason);
  audit(req.user!.id, 'switch.participant.status', 'participant', p.id, { status: b.status, reason: b.reason });
  res.json({ participant: p });
});
r.get('/pairs', requirePermission('switch'), (req, res) => res.json({ items: listPairs(req.query.connection ? String(req.query.connection) : null) }));
r.post('/pairs', requirePermission('switch'), (req, res) => {
  const b = validate(
    z.object({ connectionId: z.string(), debtorId: z.string(), creditorId: z.string(), currency: z.string().length(3), product: z.enum(SWITCH_PRODUCTS), channel: z.string().optional() }),
    req.body,
  );
  const p = upsertPair(b, req.user!.id);
  audit(req.user!.id, 'switch.pair.upsert', 'participant_pair', p.id, {});
  res.status(201).json({ pair: p });
});
r.post('/pairs/:id/status', requirePermission('approvals'), (req, res) => {
  const b = validate(z.object({ status: z.enum(['OPEN', 'FAILED', 'CLOSED']), evidenceRef: z.string().optional().nullable(), validTo: z.string().optional().nullable() }), req.body);
  const p = setPairStatus(String(req.params.id), b.status, b, req.user!.id);
  audit(req.user!.id, 'switch.pair.status', 'participant_pair', p.id, { status: b.status, evidenceRef: b.evidenceRef ?? null });
  res.json({ pair: p });
});
r.get('/availability', requirePermission('switch'), (req, res) => {
  const q = validate(
    z.object({ connection: z.string(), debtor: z.string(), creditor: z.string(), currency: z.string().length(3), product: z.string().default('MERCHANT_PAYMENT'), channel: z.string().default('api') }),
    req.query,
  );
  const c = getConnection(q.connection);
  res.json({
    availability: serviceAvailability({
      connectionId: c.id,
      connectionEnabled: c.enabled,
      environmentCertified: c.environment !== 'production' || c.certification.status === 'CERTIFIED',
      country: c.country,
      debtorId: q.debtor,
      creditorId: q.creditor,
      currency: q.currency,
      product: q.product,
      channel: q.channel,
    }),
    decision: decideRoute({ country: c.country, debtorId: q.debtor, creditorId: q.creditor, product: q.product, channel: q.channel, currency: q.currency, amountMinor: 100 }),
  });
});

// ---------------------------------------------------------------- route policies & exceptions (configuration view)
r.get('/policies', requirePermission('switch'), (req, res) =>
  res.json({
    active: activePolicy(String(req.query.country ?? 'CD')),
    items: listPolicies(req.query.country ? String(req.query.country) : null),
    exceptions: listExceptions(req.query.country ? String(req.query.country) : null),
  }),
);
r.post('/policies', requirePermission('switch'), (req, res) => {
  const b = validate(z.object({ country: z.string().length(2), rules: z.record(z.string(), z.unknown()).default({}), notes: z.string().max(500).optional().nullable() }), req.body);
  const p = createPolicyDraft(b.country, b.rules as any, req.user!.id, b.notes ?? null);
  audit(req.user!.id, 'switch.policy.draft', 'route_policy', String(p.version), {});
  res.status(201).json({ policy: p });
});
r.post('/policies/:version/approve', requirePermission('approvals'), (req, res) => {
  const p = approvePolicy(Number(req.params.version), req.user!.id);
  audit(req.user!.id, 'switch.policy.approve', 'route_policy', String(p.version), {});
  res.json({ policy: p });
});
r.post('/policies/:version/activate', requirePermission('security'), (req, res) => {
  const p = activatePolicy(Number(req.params.version), req.user!.id);
  audit(req.user!.id, 'switch.policy.activate', 'route_policy', String(p.version), {});
  res.json({ policy: p });
});
r.post('/exceptions', requirePermission('compliance'), (req, res) => {
  const b = validate(
    z.object({
      country: z.string().length(2),
      scope: z.string().min(3),
      products: z.array(z.string()),
      participants: z.array(z.string()),
      currency: z.string().length(3).optional().nullable(),
      documentRef: z.string().min(3),
      documentSha256: z.string().optional().nullable(),
      validFrom: z.string(),
      validTo: z.string(),
    }),
    req.body,
  );
  const e = createException(b, req.user!.id);
  audit(req.user!.id, 'switch.exception.draft', 'routing_exception', e.id, { documentRef: b.documentRef });
  res.status(201).json({ exception: e });
});
r.post('/exceptions/:id/approve', requirePermission('approvals'), (req, res) => {
  const e = approveException(String(req.params.id), req.user!.id);
  audit(req.user!.id, 'switch.exception.approve', 'routing_exception', e.id, { status: e.status });
  res.json({ exception: e });
});

// ---------------------------------------------------------------- payments (transaction view), inquiries, bindings
r.get('/payments', requirePermission('switch'), (req, res) =>
  res.json({
    items: listPayments({
      status: req.query.status ? String(req.query.status) : null,
      connectionId: req.query.connection ? String(req.query.connection) : null,
      uncertainOnly: req.query.uncertain === '1',
      limit: Number(req.query.limit) || 50,
    }),
  }),
);
r.get('/payments/:id', requirePermission('switch'), (req, res) => res.json(paymentTimeline(String(req.params.id))));
r.post(
  '/payments/:id/inquire',
  requirePermission('switch'),
  wrap(async (req, res) => {
    const t = paymentTimeline(String(req.params.id));
    const last = t.attempts[t.attempts.length - 1];
    if (!last) return res.status(409).json({ error: { code: 'no_attempt', message: 'Nothing was ever transmitted for this payment' } });
    const result = await inquirePayment(String(req.params.id), last.id, 99);
    audit(req.user!.id, 'switch.inquiry', 'switch_payment', String(req.params.id), { result: result.result });
    res.json({ result, payment: paymentTimeline(String(req.params.id)).payment });
  }),
);
r.post('/payments/:id/cancel', requirePermission('switch'), (req, res) => {
  const p = cancelPayment(null, String(req.params.id), { type: 'admin', id: req.user!.id }, String(req.body?.reason ?? 'operations'));
  audit(req.user!.id, 'switch.cancel', 'switch_payment', p.payment_id, { reason: req.body?.reason ?? null });
  res.json(p);
});
r.get('/payments/:id/evidence', requirePermission('security'), (req, res) => res.json({ items: listEvidence(String(req.params.id)) }));
r.get('/evidence/:id', requirePermission('security'), (req, res) => {
  const e = readEvidence(String(req.params.id));
  audit(req.user!.id, 'vault.read', 'evidence', e.entry.id, { kind: e.entry.kind, subjectId: e.entry.subjectId });
  res.json(e);
});
r.get('/vault/verify', requirePermission('security'), (_req, res) => res.json(verifyVault()));
r.post('/bindings/:id/verify', requirePermission('compliance'), (req, res) => {
  const b = validate(z.object({ method: z.string().min(2), reference: z.string().min(2), note: z.string().optional().nullable() }), req.body);
  const v = verifyBinding(String(req.params.id), req.user!.id, b);
  audit(req.user!.id, 'switch.binding.verify', 'beneficiary_binding', v.id, { method: b.method, reference: b.reference });
  res.json({ binding: v });
});
r.post('/bindings/:id/activate', requirePermission('approvals'), (req, res) => {
  const v = activateBinding(String(req.params.id), req.user!.id);
  audit(req.user!.id, 'switch.binding.activate', 'beneficiary_binding', v.id, {});
  res.json({ binding: v });
});
r.post('/bindings/:id/suspend', requirePermission('compliance'), (req, res) => {
  const b = validate(z.object({ reason: z.string().min(3) }), req.body);
  const v = suspendBinding(String(req.params.id), req.user!.id, b.reason);
  audit(req.user!.id, 'switch.binding.suspend', 'beneficiary_binding', v.id, { reason: b.reason });
  res.json({ binding: v });
});
r.get('/bindings', requirePermission('switch'), (req, res) =>
  res.json({ items: listAllBindings({ status: req.query.status ? String(req.query.status).toUpperCase() : null, limit: Number(req.query.limit) || 100 }) }),
);
r.get('/bindings/:id', requirePermission('switch'), (req, res) => res.json({ binding: getBinding(null, String(req.params.id)) }));
r.post('/operations/:id/resolve', requirePermission('approvals'), (req, res) => {
  const b = validate(z.object({ outcome: z.enum(['SUCCEEDED', 'REJECTED']), evidenceRef: z.string().min(2) }), req.body);
  const op = resolveLinkedOperation(String(req.params.id), b.outcome, b.evidenceRef, req.user!.id);
  audit(req.user!.id, 'switch.operation.resolve', 'linked_operation', op.id, { outcome: b.outcome, evidenceRef: b.evidenceRef });
  res.json({ operation: op });
});

// ---------------------------------------------------------------- inbox / outbox / catalogue / dispatcher
r.get('/inbox', requirePermission('switch'), (req, res) =>
  res.json({
    items: listInbox({
      connectionId: req.query.connection ? String(req.query.connection) : null,
      quarantine: req.query.quarantine === '1' ? true : req.query.quarantine === '0' ? false : null,
      limit: Number(req.query.limit) || 50,
    }),
  }),
);
r.post('/inbox/:id/discard', requirePermission('security'), (req, res) => {
  const b = validate(z.object({ reason: z.string().min(3) }), req.body);
  discardInbox(String(req.params.id), req.user!.id, b.reason);
  audit(req.user!.id, 'switch.inbox.discard', 'inbox', String(req.params.id), { reason: b.reason });
  res.json({ discarded: true });
});
r.get('/outbox', requirePermission('switch'), (req, res) =>
  res.json({ items: listOutbox({ dead: req.query.dead === '1', pending: req.query.pending === '1', limit: Number(req.query.limit) || 50 }) }),
);
r.post('/outbox/:id/retry', requirePermission('switch'), (req, res) => {
  const m = retryOutbox(String(req.params.id), req.user!.id);
  audit(req.user!.id, 'switch.outbox.retry', 'outbox', String(req.params.id), {});
  res.json({ message: m });
});
r.get('/catalogue', requirePermission('switch'), (req, res) => res.json({ items: listCatalogue(req.query.product ? String(req.query.product) : null) }));
r.post('/catalogue', requirePermission('security'), (req, res) => {
  const b = validate(
    z.object({
      product: z.string(),
      externalCode: z.string(),
      phase: z.string(),
      meaning: z.string(),
      finality: z.enum(['NONE', 'AUTHORIZATION', 'COMPLETION', 'REJECTION']),
      minimumProof: z.string(),
      authority: z.string(),
      transition: z.string(),
      source: z.enum(['SIMULATION', 'OFFICIAL']).default('OFFICIAL'),
    }),
    req.body,
  );
  const e = upsertCatalogueEntry(b, req.user!.id);
  audit(req.user!.id, 'switch.catalogue.version', 'message_catalogue', e.id, { product: e.product, code: e.externalCode, version: e.version });
  res.status(201).json({ entry: e });
});
r.get('/dispatcher', requirePermission('switch'), (_req, res) =>
  res.json({ lease: currentLease(), pending: listOutbox({ pending: true, limit: 200 }).length, dead: listOutbox({ dead: true, limit: 200 }).length }),
);
r.post(
  '/dispatcher/run',
  requirePermission('switch'),
  wrap(async (req, res) => {
    const result = await dispatchOutbox(`admin:${req.user!.id}`, { force: req.body?.force === true });
    audit(req.user!.id, 'switch.dispatch', 'dispatcher', 'switch', { processed: result.processed, forced: req.body?.force === true });
    res.json(result);
  }),
);
r.post('/dispatcher/recover', requirePermission('switch'), (req, res) => {
  const recovered = recoverUncertainEmissions();
  const expired = expirePayments();
  audit(req.user!.id, 'switch.recover', 'dispatcher', 'switch', { recovered, expired });
  res.json({ recovered, expired });
});
/** Failover exercise: promote a new dispatcher owner; the previous leader's fencing token becomes invalid. */
r.post('/dispatcher/takeover', requirePermission('security'), (req, res) => {
  const lease = acquireLease(String(req.body?.owner ?? `admin:${req.user!.id}`), { force: true });
  audit(req.user!.id, 'switch.dispatcher.takeover', 'dispatcher', 'switch', { lease });
  res.json({ lease });
});

// ---------------------------------------------------------------- reconciliation
r.get('/reconciliation/:connection', requirePermission('reconciliation'), (req, res) => res.json(reconciliationOverview(String(req.params.connection))));
r.get('/reconciliation/:connection/imports', requirePermission('reconciliation'), (req, res) =>
  res.json({ items: listImports(String(req.params.connection), req.query.cycle ? String(req.query.cycle) : null) }),
);
r.post(
  '/reconciliation/:connection/imports',
  requirePermission('reconciliation'),
  wrap(async (req, res) => {
    const b = validate(
      z.object({
        source: z.enum(['SWITCH', 'INSTITUTION', 'SPONSOR']),
        cycleRef: z.string().min(4),
        periodFrom: z.string(),
        periodTo: z.string(),
        currency: z.string().length(3),
        lines: z.array(z.record(z.string(), z.unknown())).max(50_000),
        controlTotalMinor: z.union([z.string(), z.number()]).optional().nullable(),
        replacesImportId: z.string().optional().nullable(),
        signatureValid: z.boolean().optional(),
      }),
      req.body,
    );
    const imp = await importReport(String(req.params.connection), b as any, req.user!.id);
    audit(req.user!.id, 'reconciliation.import', 'reconciliation_import', imp.id, { source: b.source, cycleRef: b.cycleRef, lines: imp.lineCount, duplicate: !!imp.duplicate });
    res.status(imp.duplicate ? 200 : 201).json({ import: imp });
  }),
);
r.get('/reconciliation/:connection/runs', requirePermission('reconciliation'), (req, res) => res.json({ items: listRuns(String(req.params.connection)) }));
r.post('/reconciliation/:connection/runs', requirePermission('reconciliation'), (req, res) => {
  const b = validate(z.object({ cycleRef: z.string().min(4) }), req.body);
  const run = runReconciliation(String(req.params.connection), b.cycleRef, req.user!.id);
  audit(req.user!.id, 'reconciliation.run', 'reconciliation_run', run.id, { cycleRef: b.cycleRef, cases: run.casesOpened, complete: run.complete });
  res.status(201).json({ run });
});
r.post('/reconciliation/coverage-check', requirePermission('reconciliation'), (_req, res) => res.json(checkCoverage()));
r.get('/cases', requirePermission('reconciliation'), (req, res) =>
  res.json(
    listCases({
      connectionId: req.query.connection ? String(req.query.connection) : null,
      status: req.query.status ? String(req.query.status) : null,
      class: req.query.class ? String(req.query.class) : null,
      paymentId: req.query.payment ? String(req.query.payment) : null,
      limit: Number(req.query.limit) || 50,
      cursor: req.query.cursor ? String(req.query.cursor) : null,
    }),
  ),
);
r.get('/cases/:id', requirePermission('reconciliation'), (req, res) => res.json({ case: getCase(String(req.params.id)) }));
r.post('/cases/:id/assign', requirePermission('reconciliation'), (req, res) => {
  const b = validate(z.object({ ownerId: z.string().min(1) }), req.body);
  const c = assignCase(String(req.params.id), b.ownerId, req.user!.id);
  audit(req.user!.id, 'reconciliation.case.assign', 'reconciliation_case', c.id, { ownerId: b.ownerId });
  res.json({ case: c });
});
r.post('/cases/:id/resolve', requirePermission('reconciliation'), (req, res) => {
  const b = validate(z.object({ resolution: z.string().min(5).max(2000), documents: z.array(z.string()).default([]) }), req.body);
  const c = proposeResolution(String(req.params.id), b.resolution, b.documents, req.user!.id);
  audit(req.user!.id, 'reconciliation.case.resolve', 'reconciliation_case', c.id, { documents: b.documents.length });
  res.json({ case: c });
});
r.post('/cases/:id/approve-closure', requirePermission('approvals'), (req, res) => {
  const c = approveClosure(String(req.params.id), req.user!.id);
  audit(req.user!.id, 'reconciliation.case.close', 'reconciliation_case', c.id, {});
  res.json({ case: c });
});

// ---------------------------------------------------------------- aggregation fees
/** The aggregator's remuneration on switch payments: accrued per period, invoiced, settled from the wallet or recorded here under step-up. */
r.get('/fees', requirePermission('switch'), (_req, res) => res.json(aggregationFeesOverview()));
r.post('/fees/close', requirePermission('approvals'), (req, res) => {
  const body = validate(z.object({ period: z.string().regex(/^\d{4}-\d{2}$/), pin: z.string().optional() }), req.body);
  assertAdminStepUp(req.user!, body.pin, req);
  const invoices = closeAggregationPeriod(body.period, req.user!.id);
  res.json({ invoices });
});
r.post('/fees/invoices/:id/settle', requirePermission('approvals'), (req, res) => {
  const body = validate(
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('paid'), reference: z.string().min(4).max(120), pin: z.string().optional() }),
      z.object({ kind: z.literal('void'), reason: z.string().min(4).max(300), pin: z.string().optional() }),
    ]),
    req.body,
  );
  assertAdminStepUp(req.user!, body.pin, req);
  res.json({ invoice: settleInvoice(String(req.params.id), req.user!.id, body.kind === 'paid' ? { kind: 'paid', reference: body.reference } : { kind: 'void', reason: body.reason }) });
});

// ---------------------------------------------------------------- incidents
r.get('/incidents', requirePermission('switch'), (req, res) => res.json({ items: listIncidents(req.query.status ? String(req.query.status) : null) }));
r.post('/incidents/:id/ack', requirePermission('switch'), (req, res) => {
  const i = acknowledgeIncident(String(req.params.id), req.user!.id);
  audit(req.user!.id, 'incident.ack', 'incident', String(req.params.id), {});
  res.json({ incident: i });
});
r.post('/incidents/:id/resolve', requirePermission('switch'), (req, res) => {
  const i = resolveIncident(String(req.params.id), req.user!.id, req.body?.note ? String(req.body.note) : null);
  audit(req.user!.id, 'incident.resolve', 'incident', String(req.params.id), { note: req.body?.note ?? null });
  res.json({ incident: i });
});

// ---------------------------------------------------------------- recovery (PRA) view: replication state, last exercise, runbook checklist
export const RECOVERY_RUNBOOK = [
  'Suspend new transmission; record the incident, time and last durable checkpoints.',
  'Isolate and fence the old site and its egress; confirm there is no dual leader.',
  'Restore identity, keys, DNS, networks and database from a validated source.',
  'Compare journals, sequences and replication; identify every possible loss window.',
  'Restore the switch channel in inquiry and receive mode; validate sessions and participant identity.',
  'Mark potentially transmitted commands uncertain and retrieve external evidence.',
  'Replay inbox, imports and outbox idempotently; never blindly resubmit payments.',
  'Resolve or isolate exceptions; revalidate consent and policies for commands never transmitted.',
  'Reopen in stages with reduced limits, monitoring and joint operations/technical approval.',
  'Produce the post-incident report: chronology, exposure, affected operations, losses, decisions, corrective actions.',
];
r.get('/recovery', requirePermission('switch'), (_req, res) => {
  const db = getDb();
  const journal = db.pragma('journal_mode', { simple: true });
  const wal = db.pragma('wal_checkpoint(PASSIVE)') as any[];
  const size = config.databasePath !== ':memory:' && fs.existsSync(config.databasePath) ? fs.statSync(config.databasePath).size : 0;
  const walSize = config.databasePath !== ':memory:' && fs.existsSync(`${config.databasePath}-wal`) ? fs.statSync(`${config.databasePath}-wal`).size : 0;
  const exercises = db.prepare('SELECT * FROM dr_exercises ORDER BY created_at DESC LIMIT 20').all() as any[];
  const checklist = getSetting<{ done: number[]; updatedAt: string | null }>('dr_checklist', { done: [], updatedAt: null });
  const uncertain = (db.prepare("SELECT COUNT(*) c FROM switch_payments WHERE status = 'UNKNOWN'").get() as any).c;
  const sentNoResponse = (db.prepare("SELECT COUNT(*) c FROM switch_attempts WHERE status = 'SENT' AND responded_at IS NULL").get() as any).c;
  res.json({
    database: { journalMode: journal, walCheckpoint: wal?.[0] ?? null, sizeBytes: size, walBytes: walSize, path: config.databasePath === ':memory:' ? 'memory' : 'file' },
    replication: {
      mode: 'single-node SQLite (WAL); inter-site replication is an infrastructure deliverable (18.1) — RPO 0 for emission references requires the durable attempt journal below',
      emissionJournal: { attemptsSentWithoutResponse: sentNoResponse, uncertainPayments: uncertain },
    },
    lease: currentLease(),
    lastExercise: exercises[0] ? { ...exercises[0], checklist: parseJson(exercises[0].checklist, []) } : null,
    exercises: exercises.map((e) => ({ ...e, checklist: parseJson(e.checklist, []) })),
    runbook: RECOVERY_RUNBOOK.map((step, i) => ({ step: i + 1, text: step, done: checklist.done.includes(i + 1) })),
    checklistUpdatedAt: checklist.updatedAt,
  });
});
r.post('/recovery/checklist', requirePermission('switch'), (req, res) => {
  const b = validate(z.object({ done: z.array(z.number().int().min(1).max(RECOVERY_RUNBOOK.length)) }), req.body);
  setSetting('dr_checklist', { done: [...new Set(b.done)].sort((a, c) => a - c), updatedAt: now() });
  audit(req.user!.id, 'recovery.checklist', 'dr', 'switch', { done: b.done });
  res.json({ done: b.done });
});
r.post('/recovery/exercises', requirePermission('security'), (req, res) => {
  const b = validate(
    z.object({
      kind: z.enum(['node_loss', 'site_loss', 'restore', 'key_rotation', 'link_loss', 'failover']),
      outcome: z.enum(['PASSED', 'FAILED', 'PARTIAL']),
      rtoMinutes: z.number().int().min(0).optional().nullable(),
      rpoSeconds: z.number().int().min(0).optional().nullable(),
      checklist: z.array(z.number().int()).default([]),
      notes: z.string().max(2000).optional().nullable(),
    }),
    req.body,
  );
  const id = `drx_${shortCode(10).toLowerCase()}`;
  getDb()
    .prepare('INSERT INTO dr_exercises (id, kind, outcome, rto_minutes, rpo_seconds, checklist, notes, run_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, b.kind, b.outcome, b.rtoMinutes ?? null, b.rpoSeconds ?? null, JSON.stringify(b.checklist), b.notes ?? null, req.user!.id, now());
  audit(req.user!.id, 'recovery.exercise', 'dr_exercise', id, { kind: b.kind, outcome: b.outcome });
  res.status(201).json({ exercise: getDb().prepare('SELECT * FROM dr_exercises WHERE id = ?').get(id) });
});

// ---------------------------------------------------------------- rail registry (all rails, not only the switch)
r.get('/rails', requirePermission('gateways'), (req, res) =>
  res.json({
    items: listRails({ kind: (req.query.kind as any) ?? null, country: req.query.country ? String(req.query.country) : null, currency: req.query.currency ? String(req.query.currency) : null }),
  }),
);
r.get('/rails/:id', requirePermission('gateways'), (req, res) => res.json({ rail: getRail(String(req.params.id)), series: connectorSeries(String(req.params.id), Number(req.query.hours) || 24) }));
r.post('/rails/:id/pause', requirePermission('gateways'), (req, res) => {
  const b = validate(z.object({ reason: z.string().min(3).max(300) }), req.body);
  const h = pauseConnector(String(req.params.id), req.user!.id, b.reason);
  audit(req.user!.id, 'rail.pause', 'rail', String(req.params.id), { reason: b.reason });
  res.json({ health: h });
});
r.post('/rails/:id/resume', requirePermission('gateways'), (req, res) => {
  const h = resumeConnector(String(req.params.id), req.user!.id);
  audit(req.user!.id, 'rail.resume', 'rail', String(req.params.id), {});
  res.json({ health: h });
});
r.post(
  '/rails/probe',
  requirePermission('gateways'),
  wrap(async (_req, res) => res.json(await probeConnectors(true))),
);
r.post('/rails/score', requirePermission('gateways'), (req, res) => {
  const b = validate(z.object({ method: z.string(), candidates: z.array(z.string()).min(1), policy: z.enum(['smart', 'cheapest', 'fastest', 'most_reliable']).default('smart') }), req.body);
  res.json({
    scores: scoreConnectors(
      b.candidates.map((id, i) => ({ id, method: b.method, preferenceRank: i })),
      b.policy,
    ),
  });
});

// ---------------------------------------------------------------- rail maintenance window (administrator-set; Smart Route stops choosing the rail until cleared)
r.post('/rails/:id/maintenance', requirePermission('gateways'), (req, res) => {
  const b = validate(z.object({ on: z.boolean(), reason: z.string().min(3).max(300).optional().nullable() }), req.body);
  getRail(String(req.params.id));
  const h = setRailMaintenance(String(req.params.id), b.on, b.on ? (b.reason ?? 'scheduled by operations') : null, req.user!.id);
  audit(req.user!.id, b.on ? 'rail.maintenance.on' : 'rail.maintenance.off', 'rail', String(req.params.id), { reason: b.reason ?? null });
  res.json({ health: h });
});

// ---------------------------------------------------------------- capability matrix: country × method × rail
/** Method columns of the matrix and the country capability flag that enables each one. */
export const CAPABILITY_MATRIX_METHODS: { method: string; flag: keyof CountryCapabilities; label: string }[] = [
  { method: 'wallet', flag: 'wallet', label: 'Wallet balance' },
  { method: 'card', flag: 'cardCollection', label: 'Card collection' },
  { method: 'mobile_money', flag: 'mobileMoney', label: 'Mobile money' },
  { method: 'bank', flag: 'bankPayout', label: 'Bank payout' },
  { method: 'national_switch', flag: 'nationalSwitch', label: 'National switch' },
  { method: 'bitcoin', flag: 'bitcoin', label: 'Bitcoin' },
];
const methodEnabled = (caps: CountryCapabilities, m: (typeof CAPABILITY_MATRIX_METHODS)[number]) => (m.flag === 'nationalSwitch' ? !!caps.nationalSwitch.connector : caps[m.flag] === true);
/**
 * The matrix as enforced today: a cell is enabled when the country allows the method (services/capabilities.ts) and
 * the rail serving that method in that country is enabled and usable (not paused, no open circuit, no maintenance).
 * Limits are the country's per-transaction ceiling in its main currency minor units (0 = policy limits only).
 */
export function capabilityMatrix(countries?: string[] | null) {
  const rails = listRails();
  const list = countries?.length ? countries.map((c) => countryCapabilities(c)) : listCountryCapabilities();
  return list.map((caps) => ({
    country: caps.country,
    licencePhase: caps.licencePhase,
    maxPerTransaction: caps.maxPerTransaction,
    methods: CAPABILITY_MATRIX_METHODS.map((m) => {
      const allowed = methodEnabled(caps, m);
      const serving = rails.filter((e) => e.methods.includes(m.method) && (!e.countries.length || e.countries.includes(caps.country)));
      return {
        method: m.method,
        label: m.label,
        allowed,
        rails: serving.map((e) => ({
          id: e.id,
          name: e.name,
          kind: e.kind,
          enabled: allowed && e.enabled && e.health.usable,
          railEnabled: e.enabled,
          state: e.health.state,
          usable: e.health.usable,
          maintenance: e.health.maintenance,
          reason: !allowed ? `method disabled for ${caps.country}` : !e.enabled ? 'rail disabled' : (e.health.reason ?? null),
        })),
      };
    }),
  }));
}
r.get('/capability-matrix', requirePermission('settings'), (req, res) =>
  res.json({
    items: capabilityMatrix(req.query.country ? String(req.query.country).split(',') : null),
    methods: CAPABILITY_MATRIX_METHODS.map((m) => ({ method: m.method, label: m.label, flag: m.flag })),
  }),
);
/** Editor: flip method columns and the per-transaction ceiling for a country; writes through to the enforced country capabilities. */
r.put('/capability-matrix/:country', requirePermission('settings'), (req, res) => {
  const b = validate(
    z.object({
      methods: z.record(z.enum(CAPABILITY_MATRIX_METHODS.map((m) => m.method) as [string, ...string[]]), z.boolean()).optional(),
      maxPerTransaction: z.number().int().min(0).optional(),
      nationalSwitchConnector: z.string().max(80).optional().nullable(),
    }),
    req.body,
  );
  const country = String(req.params.country).toUpperCase();
  const current = countryCapabilities(country);
  const patch: Partial<CountryCapabilities> = {};
  for (const [method, on] of Object.entries(b.methods ?? {})) {
    const m = CAPABILITY_MATRIX_METHODS.find((x) => x.method === method)!;
    if (m.flag === 'nationalSwitch')
      patch.nationalSwitch = { required: on ? current.nationalSwitch.required : false, connector: on ? (b.nationalSwitchConnector ?? current.nationalSwitch.connector ?? 'NATIONAL_SWITCH_CD') : null };
    else (patch as Record<string, unknown>)[m.flag] = on;
  }
  if (b.maxPerTransaction !== undefined) patch.maxPerTransaction = b.maxPerTransaction;
  const caps = setCountryCapabilities(country, patch);
  audit(req.user!.id, 'capabilities.matrix.update', 'country', caps.country, { methods: b.methods ?? {}, maxPerTransaction: b.maxPerTransaction ?? null });
  res.json({ capabilities: caps, matrix: capabilityMatrix([country])[0] });
});
