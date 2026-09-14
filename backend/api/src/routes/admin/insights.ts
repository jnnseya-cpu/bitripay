/**
 * Intelligence layer console. Mounted at /api/admin/insights (the admin router already requires an administrator):
 * the payment graph with identities (compliance permission only), acceptance scores and snapshots (reports), float
 * outlooks and trust-scaled limits (agents), restricted programmes and wallets funded through the ledger (treasury),
 * merchant purpose codes (compliance) and government agencies and operators (catalogs).
 */
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../lib/http';
import { requirePermission } from '../../middleware/permissions';
import { audit } from '../../services/audit';
import { getUserById } from '../../services/users';
import { toTransaction } from '../../services/ledger';
import { getCurrency } from '../../services/currencies';
import { toMinor } from '@bitripay/shared';
import { neighbours, sharedDevices, ringCandidates, muleCandidates, duplicateIdentityCandidates, rebuildGraph, graphStats, getNode } from '../../services/paymentGraph';
import { computeAcceptanceScore, listAcceptanceSnapshots, snapshotAcceptanceScores } from '../../services/acceptanceScore';
import { floatOutlook, agentLimitsFor, runFloatOutlookAlerts } from '../../services/risk/agentIntel';
import {
  createProgramme,
  updateProgramme,
  listProgrammes,
  getProgramme,
  openRestrictedWallet,
  fundRestrictedWallet,
  closeRestrictedWallet,
  listRestrictedWallets,
  restrictedWalletOwner,
  getRestrictedWallet,
  listMerchantPurposeCodes,
  setMerchantPurposeCodes,
} from '../../services/restrictedWallets';
import { createAgency, addOperator, agenciesFor, getAgency, listServices, listReferences } from '../../services/government';
import { PURPOSE_CODES } from '../../services/capabilities';

export const adminInsightsRouter = Router();
const num = (v: unknown, d: number) => (v === undefined || v === '' ? d : Number(v));

// ---------------------------------------------------------------- payment graph (identities: compliance officers only)
adminInsightsRouter.get('/graph/stats', requirePermission('reports'), (_req, res) => res.json(graphStats()));
adminInsightsRouter.get('/graph/nodes/:id', requirePermission('compliance'), (req, res) => res.json({ node: getNode(String(req.params.id)) }));
adminInsightsRouter.get('/graph/neighbours/:id', requirePermission('compliance'), (req, res) =>
  res.json(neighbours(String(req.params.id), num(req.query.depth, 1), { maxNodes: num(req.query.maxNodes, 500), kinds: req.query.kinds ? (String(req.query.kinds).split(',') as any) : undefined })),
);
adminInsightsRouter.get('/graph/shared-devices', requirePermission('compliance'), (req, res) => {
  const q = validate(z.object({ a: z.string().min(1), b: z.string().min(1) }), req.query);
  res.json({ items: sharedDevices(q.a, q.b) });
});
adminInsightsRouter.get('/graph/rings', requirePermission('compliance'), (req, res) =>
  res.json({
    items: ringCandidates({
      sinceDays: num(req.query.sinceDays, 7),
      windowHours: num(req.query.windowHours, 24),
      minLength: num(req.query.minLength, 3),
      maxLength: num(req.query.maxLength, 5),
      limit: num(req.query.limit, 50),
    }),
  }),
);
adminInsightsRouter.get('/graph/mules', requirePermission('compliance'), (req, res) =>
  res.json({
    items: muleCandidates({
      sinceDays: num(req.query.sinceDays, 30),
      minPayers: num(req.query.minPayers, 3),
      forwardMinutes: num(req.query.forwardMinutes, 60),
      threshold: Number(req.query.threshold ?? 0.8),
      limit: num(req.query.limit, 100),
    }),
  }),
);
adminInsightsRouter.get('/graph/duplicates', requirePermission('compliance'), (req, res) => res.json({ items: duplicateIdentityCandidates({ limit: num(req.query.limit, 200) }) }));
adminInsightsRouter.post('/graph/rebuild', requirePermission('compliance'), (req, res) => {
  const result = rebuildGraph();
  audit(req.user!.id, 'graph.rebuild', 'payment_graph', undefined, result);
  res.json(result);
});

// ---------------------------------------------------------------- acceptance scores
adminInsightsRouter.get('/acceptance/:merchantId', requirePermission('reports'), (req, res) => {
  const merchant = getUserById(String(req.params.merchantId));
  res.json({ ...computeAcceptanceScore(merchant.id, num(req.query.days, 30)), history: listAcceptanceSnapshots(merchant.id, num(req.query.history, 90)) });
});
adminInsightsRouter.post('/acceptance/snapshot', requirePermission('reports'), (req, res) => {
  const result = snapshotAcceptanceScores(num(req.body?.days, 30));
  audit(req.user!.id, 'acceptance.snapshot', 'merchant_acceptance_scores', result.day, result);
  res.json(result);
});

// ---------------------------------------------------------------- float intelligence
adminInsightsRouter.get('/float/:agentId', requirePermission('agents'), (req, res) => {
  const agent = getUserById(String(req.params.agentId));
  res.json({ outlooks: floatOutlook(agent.id, req.query.currency ? String(req.query.currency) : null), limits: agentLimitsFor(agent) });
});
adminInsightsRouter.post('/float/alerts', requirePermission('agents'), (req, res) => {
  const result = runFloatOutlookAlerts();
  audit(req.user!.id, 'float.outlook_alerts', 'agents', undefined, result);
  res.json(result);
});

// ---------------------------------------------------------------- restricted programmes and wallets
const programmeSchema = z.object({
  name: z.string().min(2).max(120),
  purposeCode: z.string().min(2).max(40),
  currency: z.string().length(3),
  sponsorUserId: z.string().optional().nullable(),
  eligibleMccs: z.array(z.string().max(8)).max(200).optional(),
  eligibleMerchantIds: z.array(z.string()).max(500).optional(),
  maxTx: z.string().optional().nullable(),
  countries: z.array(z.string().length(2)).max(50).optional(),
  expiresAt: z.string().optional().nullable(),
  cashOutAllowed: z.boolean().optional(),
});
adminInsightsRouter.get('/restricted/programmes', requirePermission('reports'), (req, res) =>
  res.json({ items: listProgrammes({ status: req.query.status ? String(req.query.status) : null }), purposeCodes: PURPOSE_CODES }),
);
adminInsightsRouter.post('/restricted/programmes', requirePermission('treasury'), (req, res) => {
  const b = validate(programmeSchema, req.body);
  const cur = getCurrency(b.currency);
  const p = createProgramme(req.user!, { ...b, currency: cur.code, maxTxMinor: b.maxTx ? toMinor(b.maxTx, cur.decimals) : null });
  audit(req.user!.id, 'restricted.programme_created', 'restricted_programme', p.id, { name: p.name, purposeCode: p.purposeCode });
  res.status(201).json({ programme: p });
});
adminInsightsRouter.get('/restricted/programmes/:id', requirePermission('reports'), (req, res) => res.json({ programme: getProgramme(String(req.params.id)) }));
adminInsightsRouter.patch('/restricted/programmes/:id', requirePermission('treasury'), (req, res) => {
  const b = validate(programmeSchema.partial().extend({ status: z.enum(['active', 'suspended', 'closed']).optional() }), req.body);
  const current = getProgramme(String(req.params.id));
  const { maxTx, currency: _currency, purposeCode: _purpose, ...rest } = b;
  const p = updateProgramme(req.user!, current.id, { ...rest, ...(maxTx !== undefined ? { maxTxMinor: maxTx ? toMinor(maxTx, getCurrency(current.currency).decimals) : null } : {}) });
  audit(req.user!.id, 'restricted.programme_updated', 'restricted_programme', p.id, { fields: Object.keys(b) });
  res.json({ programme: p });
});
adminInsightsRouter.get('/restricted/wallets', requirePermission('users'), (req, res) => {
  const q = validate(z.object({ userId: z.string().min(1) }), req.query);
  res.json({ items: listRestrictedWallets(q.userId).map((w) => ({ ...w, owner: restrictedWalletOwner(w) })) });
});
adminInsightsRouter.post('/restricted/wallets', requirePermission('treasury'), (req, res) => {
  const b = validate(z.object({ programmeId: z.string().min(1), userId: z.string().min(1) }), req.body);
  const w = openRestrictedWallet(req.user!, b);
  audit(req.user!.id, 'restricted.wallet_opened', 'restricted_wallet', w.id, { programmeId: w.programmeId, userId: w.userId });
  res.status(201).json({ wallet: w });
});
adminInsightsRouter.post('/restricted/wallets/:id/fund', requirePermission('treasury'), (req, res) => {
  const b = validate(z.object({ amount: z.string(), note: z.string().max(200).optional().nullable() }), req.body);
  const w = getRestrictedWallet(String(req.params.id));
  const cur = getCurrency(w.currency);
  const result = fundRestrictedWallet(req.user!, { restrictedWalletId: w.id, amountMinor: toMinor(b.amount, cur.decimals), note: b.note ?? null });
  audit(req.user!.id, 'restricted.wallet_funded', 'restricted_wallet', w.id, { amount: result.transaction.amount, currency: w.currency, transactionId: result.transaction.id });
  res.status(201).json({ wallet: result.wallet, transaction: toTransaction(result.transaction) });
});
adminInsightsRouter.post('/restricted/wallets/:id/close', requirePermission('treasury'), (req, res) => {
  const w = closeRestrictedWallet(req.user!, String(req.params.id));
  audit(req.user!.id, 'restricted.wallet_closed', 'restricted_wallet', w.id, {});
  res.json({ wallet: w });
});
adminInsightsRouter.get('/merchants/:id/purpose-codes', requirePermission('compliance'), (req, res) =>
  res.json({ merchantId: String(req.params.id), purposeCodes: listMerchantPurposeCodes(String(req.params.id)) }),
);
adminInsightsRouter.put('/merchants/:id/purpose-codes', requirePermission('compliance'), (req, res) => {
  const b = validate(z.object({ purposeCodes: z.array(z.string().min(2).max(40)).max(50) }), req.body);
  const codes = setMerchantPurposeCodes(req.user!, String(req.params.id), b.purposeCodes);
  audit(req.user!.id, 'merchant.purpose_codes_set', 'user', String(req.params.id), { codes });
  res.json({ merchantId: String(req.params.id), purposeCodes: codes });
});

// ---------------------------------------------------------------- government agencies
adminInsightsRouter.get('/government/agencies', requirePermission('catalogs'), (req, res) => res.json({ items: agenciesFor(req.user!) }));
adminInsightsRouter.post('/government/agencies', requirePermission('catalogs'), (req, res) => {
  const b = validate(
    z.object({ name: z.string().min(2).max(160), code: z.string().min(2).max(20), country: z.string().length(2), region: z.string().max(80).optional().nullable(), merchant: z.string().min(2) }),
    req.body,
  );
  const a = createAgency(req.user!, b);
  audit(req.user!.id, 'gov.agency_created', 'gov_agency', a.id, { code: a.code, merchantUserId: a.merchantUserId });
  res.status(201).json({ agency: a });
});
adminInsightsRouter.get('/government/agencies/:id', requirePermission('catalogs'), (req, res) => {
  const a = getAgency(String(req.params.id));
  res.json({ agency: a, services: listServices(a.id), references: listReferences({ agencyId: a.id, limit: 100 }) });
});
adminInsightsRouter.post('/government/agencies/:id/operators', requirePermission('catalogs'), (req, res) => {
  const b = validate(z.object({ user: z.string().min(2), role: z.enum(['owner', 'operator', 'auditor']).optional() }), req.body);
  const op = addOperator(req.user!, String(req.params.id), b);
  audit(req.user!.id, 'gov.operator_added', 'gov_agency', op.agencyId, { userId: op.user.id, role: op.role });
  res.status(201).json({ operator: op });
});
