/**
 * Risk & compliance console. Mounted at /api/admin/risk. Policies are versioned with author and approver kept
 * apart; fraud scores are explainable; compliance cases carry the SAR draft and need a second officer to close;
 * sanctions lists are sourced, versioned and refreshed; KYC tiers and KYB are reviewed here; destination changes
 * are approved or revoked; agents' float, trust and replenishment requests are operated from one place.
 */
import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../../lib/http';
import { requirePermission } from '../../middleware/permissions';
import { audit } from '../../services/audit';
import { assertPin } from '../../services/auth';
import { notFound } from '../../lib/errors';
import { findUserById } from '../../services/users';
import { getSetting, setSetting } from '../../services/settings';
import { listPolicies, getPolicy, createPolicyDraft, approvePolicy, activatePolicy, simulatePolicy, activePolicy } from '../../services/risk/policy';
import { listFraudScores, fraudOverview, getFraudSettings } from '../../services/risk/fraud';
import {
  listCases,
  getCase,
  openCase,
  assignCase,
  escalateCase,
  updateSarDraft,
  decideCase,
  closeCase,
  complianceOverview,
  runAmlScan,
  getAmlSettings,
  listSources,
  upsertSource,
  importSanctionsRows,
  parseSanctionsCsv,
  refreshSource,
  CASE_DECISIONS,
  SANCTIONS_FORMATS,
  type SanctionsFormat,
} from '../../services/risk/compliance';
import { listSanctions } from '../../services/risk';
import { getKycTierSettings, setTier, tierStatus, listKyb, getKyb, reviewKyb, TIER_LABELS } from '../../services/risk/kycTiers';
import { listDestinationChanges, approveDestinationChange, revokeDestinationChange, getAccountProtectionSettings } from '../../services/risk/accountProtection';
import {
  floatForecast,
  computeTrustScore,
  latestTrustScore,
  runTrustScores,
  runFloatAlerts,
  listFloatRequests,
  fulfilFloatRequest,
  rejectFloatRequest,
  getAgentIntelSettings,
  dynamicCommissionBps,
} from '../../services/risk/agentIntel';
import { getDb } from '../../db';

export const adminRiskRouter = Router();
const r = adminRiskRouter;
const admin = (req: any) => ({ type: 'admin' as const, id: String(req.user!.id) });

// ---------------------------------------------------------------- policies
const ruleSchema = z.object({
  id: z.string(),
  description: z.string().max(200),
  when: z.object({
    kinds: z.array(z.string()).optional(),
    minBase: z.number().optional().nullable(),
    maxBase: z.number().optional().nullable(),
    minScore: z.number().optional().nullable(),
    maxScore: z.number().optional().nullable(),
    kycTiers: z.array(z.number().int()).optional(),
    countries: z.array(z.string().length(2)).optional(),
    methods: z.array(z.string()).optional(),
    newBeneficiary: z.boolean().optional().nullable(),
    flags: z.array(z.string()).optional(),
  }),
  action: z.enum(['allow', 'step_up', 'review', 'block']),
  reason: z.string().max(60),
});
r.get('/policies', requirePermission('compliance'), (_req, res) => res.json({ items: listPolicies(), active: activePolicy().id }));
r.post('/policies', requirePermission('compliance'), (req, res) => {
  const b = validate(z.object({ name: z.string().min(2).max(120), rules: z.array(ruleSchema).min(1).max(100), notes: z.string().max(2000).optional().nullable() }), req.body);
  const p = createPolicyDraft(b as any, req.user!.id);
  audit(req.user!.id, 'risk.policy.draft', 'risk_policy', p.id, { version: p.version, rules: p.rules.length });
  res.status(201).json(p);
});
r.get('/policies/:id', requirePermission('compliance'), (req, res) => res.json(getPolicy(String(req.params.id))));
r.post('/policies/:id/approve', requirePermission('compliance'), (req, res) => {
  const p = approvePolicy(String(req.params.id), req.user!.id);
  audit(req.user!.id, 'risk.policy.approve', 'risk_policy', p.id, { version: p.version });
  res.json(p);
});
r.post('/policies/:id/activate', requirePermission('compliance'), (req, res) => {
  const p = activatePolicy(String(req.params.id), req.user!.id);
  audit(req.user!.id, 'risk.policy.activate', 'risk_policy', p.id, { version: p.version });
  res.json(p);
});
r.post('/policies/simulate', requirePermission('compliance'), (req, res) => {
  const b = validate(
    z.object({
      policyId: z.string().optional().nullable(),
      kind: z.string(),
      baseMinor: z.number().int().min(0),
      score: z.number().int().min(0).max(100),
      kycTier: z.number().int().optional().nullable(),
      country: z.string().optional().nullable(),
      method: z.string().optional().nullable(),
      newBeneficiary: z.boolean().optional().nullable(),
      flags: z.array(z.string()).optional(),
    }),
    req.body,
  );
  res.json(simulatePolicy({ ...b, flags: b.flags ?? [] }, b.policyId));
});

// ---------------------------------------------------------------- fraud scores
r.get('/fraud', requirePermission('compliance'), (req, res) =>
  res.json({
    ...fraudOverview(Number(req.query.days) || 7),
    items: listFraudScores({
      userId: req.query.user ? String(req.query.user) : null,
      band: req.query.band ? String(req.query.band) : null,
      action: req.query.action ? String(req.query.action) : null,
      limit: Number(req.query.limit) || 100,
    }),
  }),
);
r.put('/fraud/settings', requirePermission('compliance'), (req, res) => {
  const b = validate(
    z.object({
      bands: z
        .object({ stepUp: z.number().int().min(1).max(100), review: z.number().int().min(1).max(100), block: z.number().int().min(1).max(100) })
        .partial()
        .optional(),
      methodRisk: z.record(z.string(), z.number().min(0).max(100)).optional(),
      velocityThresholds: z.object({ hour: z.number().int(), day: z.number().int(), week: z.number().int() }).partial().optional(),
      velocityPoints: z.object({ hour: z.number().int(), day: z.number().int(), week: z.number().int() }).partial().optional(),
      amountDeviationPoints: z.number().int().optional(),
      newBeneficiaryPoints: z.number().int().optional(),
      recipientRiskPoints: z.number().int().optional(),
      kycMismatchPoints: z.number().int().optional(),
      nightHours: z.tuple([z.number().int().min(0).max(23), z.number().int().min(0).max(23)]).optional(),
      nightPoints: z.number().int().optional(),
      newDevicePoints: z.number().int().optional(),
      geoMismatchPoints: z.number().int().optional(),
      structuringPoints: z.number().int().optional(),
      minScoredBase: z.number().int().min(0).optional(),
    }),
    req.body,
  );
  const current = getSetting<any>('fraud', {});
  setSetting('fraud', { ...current, ...b, bands: { ...(current.bands ?? {}), ...(b.bands ?? {}) }, methodRisk: { ...(current.methodRisk ?? {}), ...(b.methodRisk ?? {}) } });
  audit(req.user!.id, 'risk.fraud.settings', 'settings', 'fraud', b);
  res.json(getFraudSettings());
});

// ---------------------------------------------------------------- compliance cases
r.get('/cases', requirePermission('compliance'), (req, res) =>
  res.json({
    ...complianceOverview(),
    items: listCases({
      status: req.query.status ? String(req.query.status) : null,
      kind: req.query.kind ? String(req.query.kind) : null,
      userId: req.query.user ? String(req.query.user) : null,
      assignedTo: req.query.assigned ? String(req.query.assigned) : null,
      severity: req.query.severity ? String(req.query.severity) : null,
      limit: Number(req.query.limit) || 100,
    }),
    decisions: CASE_DECISIONS,
  }),
);
r.post('/cases', requirePermission('compliance'), (req, res) => {
  const b = validate(
    z.object({
      userId: z.string().optional().nullable(),
      subjectType: z.string().max(40).optional().nullable(),
      subjectId: z.string().max(80).optional().nullable(),
      severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      title: z.string().min(3).max(200),
      summary: z.string().min(3).max(4000),
      indicators: z.array(z.string().max(200)).max(50).optional(),
      sar: z.boolean().optional(),
    }),
    req.body,
  );
  const c = openCase({ kind: 'MANUAL', ...b, openedBy: req.user!.id });
  audit(req.user!.id, 'compliance.case.open', 'compliance_case', c.id, { severity: c.severity });
  res.status(201).json(c);
});
r.get('/cases/:id', requirePermission('compliance'), (req, res) => res.json(getCase(String(req.params.id))));
r.post('/cases/:id/assign', requirePermission('compliance'), (req, res) => {
  const b = validate(z.object({ officerId: z.string().optional() }), req.body ?? {});
  const officer = b.officerId ?? req.user!.id;
  if (!findUserById(officer)) throw notFound('Officer not found', 'user_not_found');
  res.json(assignCase(String(req.params.id), officer, admin(req)));
});
r.post('/cases/:id/escalate', requirePermission('compliance'), (req, res) => {
  const b = validate(z.object({ note: z.string().min(3).max(2000) }), req.body);
  res.json(escalateCase(String(req.params.id), admin(req), b.note));
});
r.put('/cases/:id/sar', requirePermission('compliance'), (req, res) => {
  const b = validate(z.object({ text: z.string().min(10).max(40_000) }), req.body);
  res.json(updateSarDraft(String(req.params.id), b.text, admin(req)));
});
r.post('/cases/:id/decide', requirePermission('compliance'), (req, res) => {
  const b = validate(z.object({ decision: z.enum(CASE_DECISIONS), reason: z.string().min(3).max(2000), sarReference: z.string().max(120).optional().nullable() }), req.body);
  const c = decideCase(String(req.params.id), b.decision, b.reason, req.user!.id, b.sarReference);
  audit(req.user!.id, 'compliance.case.decide', 'compliance_case', c.id, { decision: b.decision, sarReference: b.sarReference ?? null });
  res.json(c);
});
r.post('/cases/:id/close', requirePermission('compliance'), (req, res) => {
  const c = closeCase(String(req.params.id), req.user!.id);
  audit(req.user!.id, 'compliance.case.close', 'compliance_case', c.id, {});
  res.json(c);
});
r.post('/aml/run', requirePermission('compliance'), (req, res) => {
  const out = runAmlScan();
  audit(req.user!.id, 'compliance.aml.run', 'aml', undefined, out);
  res.json(out);
});
r.put('/aml/settings', requirePermission('compliance'), (req, res) => {
  const b = validate(
    z.object({
      highRiskCountries: z.array(z.string().length(2)).optional(),
      structuring: z
        .object({ window24hCount: z.number().int().min(2), nearLimitPct: z.number().int().min(50).max(100) })
        .partial()
        .optional(),
      passThrough: z
        .object({ distinctSenders24h: z.number().int().min(2), forwardedPct: z.number().int().min(10).max(100) })
        .partial()
        .optional(),
      dormantDays: z.number().int().min(7).optional(),
      burstMultiplier: z.number().min(1).optional(),
      pepPoints: z.number().int().min(0).max(100).optional(),
    }),
    req.body,
  );
  const current = getSetting<any>('aml', {});
  setSetting('aml', { ...current, ...b, structuring: { ...(current.structuring ?? {}), ...(b.structuring ?? {}) }, passThrough: { ...(current.passThrough ?? {}), ...(b.passThrough ?? {}) } });
  audit(req.user!.id, 'compliance.aml.settings', 'settings', 'aml', b);
  res.json(getAmlSettings());
});

// ---------------------------------------------------------------- sanctions sources
r.get('/sanctions/sources', requirePermission('compliance'), (req, res) =>
  res.json({
    items: listSources(),
    entries: listSanctions({ source: req.query.source ? String(req.query.source) : null, kind: req.query.kind ? String(req.query.kind) : null, limit: Number(req.query.limit) || 200 }),
  }),
);
r.put('/sanctions/sources/:id', requirePermission('compliance'), (req, res) => {
  const b = validate(
    z.object({
      name: z.string().min(2).max(120),
      url: z.string().url().optional().nullable(),
      format: z.enum(SANCTIONS_FORMATS as [SanctionsFormat, ...SanctionsFormat[]]).optional(),
      kind: z.enum(['sanctions', 'pep']).optional(),
      enabled: z.boolean().optional(),
    }),
    req.body,
  );
  const s = upsertSource({ id: String(req.params.id), ...b });
  audit(req.user!.id, 'compliance.sanctions.source', 'sanctions_source', s.id, { name: s.name, url: s.url });
  res.json(s);
});
r.post('/sanctions/sources/:id/import', requirePermission('compliance'), (req, res) => {
  const b = validate(
    z.object({
      version: z.string().min(1).max(80),
      rows: z
        .array(
          z.object({
            kind: z.enum(['name', 'phone', 'email', 'country', 'pep']),
            value: z.string().min(1).max(200),
            externalId: z.string().max(80).optional().nullable(),
            note: z.string().max(300).optional().nullable(),
          }),
        )
        .optional(),
      csv: z.string().max(20_000_000).optional(),
    }),
    req.body,
  );
  const rows = b.rows ?? (b.csv ? parseSanctionsCsv(b.csv) : []);
  const out = importSanctionsRows(String(req.params.id), rows, b.version, admin(req));
  audit(req.user!.id, 'compliance.sanctions.import', 'sanctions_source', String(req.params.id), out);
  res.json(out);
});
r.post(
  '/sanctions/sources/:id/refresh',
  requirePermission('compliance'),
  wrap(async (req, res) => {
    const out = await refreshSource(String(req.params.id), admin(req));
    audit(req.user!.id, 'compliance.sanctions.refresh', 'sanctions_source', String(req.params.id), out);
    res.json(out);
  }),
);

// ---------------------------------------------------------------- KYC tiers and KYB
r.get('/kyc/tiers', requirePermission('kyc'), (_req, res) => res.json({ settings: getKycTierSettings(), labels: TIER_LABELS }));
r.put('/kyc/tiers', requirePermission('settings'), (req, res) => {
  const limits = z.object({ perTransaction: z.number().int().min(0), daily: z.number().int().min(0), monthly: z.number().int().min(0) }).nullable();
  const b = validate(
    z.object({
      default: z.record(z.string(), limits).optional(),
      countries: z.record(z.string(), z.record(z.string(), limits)).optional(),
      addressDocMaxAgeDays: z.number().int().min(1).max(365).optional(),
      kybMonthlyVolumeThreshold: z.number().int().min(0).optional(),
    }),
    req.body,
  );
  const current = getSetting<any>('kycTiers', {});
  setSetting('kycTiers', { ...current, ...b, default: { ...(current.default ?? {}), ...(b.default ?? {}) }, countries: { ...(current.countries ?? {}), ...(b.countries ?? {}) } });
  audit(req.user!.id, 'kyc.tiers.settings', 'settings', 'kycTiers', b);
  res.json(getKycTierSettings());
});
r.get('/kyc/users/:userId', requirePermission('kyc'), (req, res) => {
  const u = findUserById(String(req.params.userId));
  if (!u) throw notFound('User not found', 'user_not_found');
  res.json(tierStatus(u as any));
});
r.put('/kyc/users/:userId/tier', requirePermission('kyc'), (req, res) => {
  const b = validate(z.object({ tier: z.number().int().min(0).max(4), reason: z.string().min(3).max(300) }), req.body);
  const u = setTier(String(req.params.userId), b.tier, admin(req), b.reason);
  audit(req.user!.id, 'kyc.tier.set', 'user', u.id, { tier: b.tier, reason: b.reason });
  res.json(tierStatus(u as any));
});
r.get('/kyb', requirePermission('kyc'), (req, res) => res.json({ items: listKyb(req.query.status ? String(req.query.status) : null, Number(req.query.limit) || 100) }));
r.get('/kyb/:id', requirePermission('kyc'), (req, res) => {
  audit(req.user!.id, 'kyb.dossier.read', 'kyb', String(req.params.id), {});
  res.json(getKyb(String(req.params.id), true));
});
// The decision is a step-up action: the reviewing administrator confirms it with their transaction PIN (or a passkey step-up token).
r.post('/kyb/:id/review', requirePermission('kyc'), (req, res) => {
  const b = validate(z.object({ decision: z.enum(['verified', 'rejected']), note: z.string().max(500).optional().nullable(), pin: z.string().optional().nullable() }), req.body);
  assertPin(req.user!, b.pin ?? undefined, req);
  const k = reviewKyb(String(req.params.id), req.user!.id, b.decision, b.note);
  audit(req.user!.id, `kyb.${b.decision}`, 'kyb', k.id, { note: b.note ?? null });
  res.json(k);
});

// ---------------------------------------------------------------- destination changes
r.get('/destination-changes', requirePermission('compliance'), (req, res) =>
  res.json({
    items: listDestinationChanges({ userId: req.query.user ? String(req.query.user) : null, status: req.query.status ? String(req.query.status) : null, limit: Number(req.query.limit) || 100 }),
    settings: getAccountProtectionSettings(),
  }),
);
r.post('/destination-changes/:id/approve', requirePermission('compliance'), (req, res) => {
  const c = approveDestinationChange(String(req.params.id), req.user!.id);
  audit(req.user!.id, 'destination_change.approve', 'destination_change', c.id, { userId: c.userId });
  res.json(c);
});
r.post('/destination-changes/:id/revoke', requirePermission('compliance'), (req, res) => {
  const c = revokeDestinationChange(String(req.params.id), admin(req));
  audit(req.user!.id, 'destination_change.revoke', 'destination_change', c.id, { userId: c.userId });
  res.json(c);
});

// ---------------------------------------------------------------- agents: float, trust, replenishment
r.get('/agents/overview', requirePermission('agents'), (_req, res) => {
  const agents = getDb().prepare("SELECT id, full_name, business_name, tag, country, trust_score, created_at FROM users WHERE role = 'agent' AND status = 'active' ORDER BY full_name").all() as any[];
  res.json({
    settings: getAgentIntelSettings(),
    agents: agents.map((a) => ({
      id: a.id,
      name: a.business_name || a.full_name,
      tag: a.tag,
      country: a.country,
      trustScore: a.trust_score,
      band: latestTrustScore(a.id)?.band ?? null,
      float: floatForecast(a.id),
      commission: dynamicCommissionBps({ ...a, agent_commission_bps: null } as any, 'cash_in'),
    })),
    requests: listFloatRequests({ status: 'REQUESTED', limit: 100 }),
  });
});
r.get('/agents/:id/trust', requirePermission('agents'), (req, res) =>
  res.json({
    latest: latestTrustScore(String(req.params.id)),
    history: (
      getDb().prepare('SELECT score, band, commission_bonus_bps, computed_at FROM agent_scores WHERE agent_user_id = ? ORDER BY computed_at DESC LIMIT 60').all(String(req.params.id)) as any[]
    ).map((h) => ({ score: h.score, band: h.band, bonusBps: h.commission_bonus_bps, at: h.computed_at })),
  }),
);
r.post('/agents/:id/trust/recompute', requirePermission('agents'), (req, res) => res.json(computeTrustScore(String(req.params.id), true)));
r.post('/agents/trust/run', requirePermission('agents'), (_req, res) => res.json({ ...runTrustScores(), alerts: runFloatAlerts() }));
r.get('/agents/float-requests', requirePermission('agents'), (req, res) =>
  res.json({
    items: listFloatRequests({ status: req.query.status ? String(req.query.status) : null, agentId: req.query.agent ? String(req.query.agent) : null, limit: Number(req.query.limit) || 100 }),
  }),
);
r.post('/agents/float-requests/:id/fulfil', requirePermission('issuance'), (req, res) => {
  const b = validate(z.object({ note: z.string().min(8).max(500) }), req.body);
  const f = fulfilFloatRequest(String(req.params.id), req.user!, b.note);
  audit(req.user!.id, 'agents.float.fulfil', 'float_request', f.id, { verificationId: f.verificationId, amount: f.amountMinor, currency: f.currency });
  res.json(f);
});
r.post('/agents/float-requests/:id/reject', requirePermission('agents'), (req, res) => {
  const b = validate(z.object({ reason: z.string().min(3).max(500) }), req.body);
  const f = rejectFloatRequest(String(req.params.id), req.user!, b.reason);
  audit(req.user!.id, 'agents.float.reject', 'float_request', f.id, { reason: b.reason });
  res.json(f);
});
r.put('/agents/settings', requirePermission('settings'), (req, res) => {
  const b = validate(
    z.object({
      targetDays: z.number().min(1).max(30).optional(),
      alertDays: z.number().min(0).max(30).optional(),
      bonusByBand: z.record(z.string(), z.number().int().min(0).max(500)).optional(),
      liquidityBonusBps: z.number().int().min(0).max(500).optional(),
      minTenureDays: z.number().int().min(0).optional(),
      onboardingCommissionMinor: z.number().int().min(0).optional(),
    }),
    req.body,
  );
  const current = getSetting<any>('agentIntel', {});
  setSetting('agentIntel', { ...current, ...b, bonusByBand: { ...(current.bonusByBand ?? {}), ...(b.bonusByBand ?? {}) } });
  audit(req.user!.id, 'agents.intel.settings', 'settings', 'agentIntel', b);
  res.json(getAgentIntelSettings());
});
