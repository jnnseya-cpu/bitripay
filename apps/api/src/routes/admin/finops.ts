/**
 * Finance operations console (Phase 5). Mounted at /api/admin/finops. Fee schedules are versioned with author and
 * approver kept apart; settlement cycles can be closed and paid for any merchant; disputes are decided here; holds
 * are placed and released with a reason; the commission ledger and the processor reconciliation workbench give
 * finance one place to see the network's cost and every unexplained cent.
 */
import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../../lib/http';
import { requirePermission } from '../../middleware/permissions';
import { audit } from '../../services/audit';
import { getDb } from '../../db';
import { findUserById } from '../../services/users';
import { notFound } from '../../lib/errors';
import { getSetting, setSetting } from '../../services/settings';
import { listFeeSchedules, getFeeSchedule, createFeeSchedule, approveFeeSchedule, activateFeeSchedule, retireFeeSchedule, resolveFeeRule, effectiveFees, setFeeTier } from '../../services/finops/fees';
import { listCycles, getCycle, cycleItems, closeCycle, payCycle, obligations, cycleStatement, cycleStatementCsv, cycleStatementPdf, runSettlementSchedules, listProfiles } from '../../services/finops/settlement';
import { listDisputes, getDispute, openDispute, decideDispute, requestEvidence, addEvidence, withdrawDispute, disputeChronology, sweepDisputeDeadlines, getDisputeSettings } from '../../services/finops/disputes';
import { createHold, releaseHold, listHolds, getHold, expireHolds } from '../../services/finops/holds';
import { listCommissions, commissionStatement, commissionOverview, getCommissionSettings } from '../../services/finops/commissions';
import { importProcessorStatement, runProcessorReconciliation, workbenchSummary } from '../../services/finops/processorRecon';
import { listSplitPayouts, retrySplits } from '../../services/finops/splits';
import { getUserWallet } from '../../services/wallets';
import { FEE_TYPES } from '@bitripay/shared';

export const adminFinopsRouter = Router();
const r = adminFinopsRouter;
const admin = (req: any) => ({ type: 'admin' as const, id: String(req.user!.id) });

// ---------------------------------------------------------------- fee schedules
const ruleSchema = z.object({ fixed: z.number().min(0).optional(), bps: z.number().min(0).max(10_000).optional(), min: z.number().min(0).optional(), max: z.number().min(0).optional() });
r.get('/fees/schedules', requirePermission('settings'), (req, res) => res.json({ items: listFeeSchedules({ scope: (req.query.scope as any) ?? null, scopeRef: req.query.scope_ref ? String(req.query.scope_ref) : null, status: req.query.status ? String(req.query.status) : null }), feeTypes: FEE_TYPES }));
r.post('/fees/schedules', requirePermission('settings'), (req, res) => {
  const b = validate(z.object({ scope: z.enum(['platform', 'country', 'tier', 'merchant']), scopeRef: z.string().max(80).optional().nullable(), rules: z.record(z.string(), ruleSchema), effectiveFrom: z.string().datetime().optional().nullable(), effectiveTo: z.string().datetime().optional().nullable(), notes: z.string().max(2000).optional().nullable() }), req.body);
  const s = createFeeSchedule(b, req.user!.id);
  audit(req.user!.id, 'fees.schedule.draft', 'fee_schedule', s.id, { scope: s.scope, scopeRef: s.scopeRef, version: s.version });
  res.status(201).json(s);
});
r.get('/fees/schedules/:id', requirePermission('settings'), (req, res) => res.json(getFeeSchedule(String(req.params.id))));
r.post('/fees/schedules/:id/approve', requirePermission('settings'), (req, res) => {
  const s = approveFeeSchedule(String(req.params.id), req.user!.id);
  audit(req.user!.id, 'fees.schedule.approve', 'fee_schedule', s.id, { version: s.version });
  res.json(s);
});
r.post('/fees/schedules/:id/activate', requirePermission('settings'), (req, res) => {
  const s = activateFeeSchedule(String(req.params.id), req.user!.id);
  audit(req.user!.id, 'fees.schedule.activate', 'fee_schedule', s.id, { version: s.version });
  res.json(s);
});
r.post('/fees/schedules/:id/retire', requirePermission('settings'), (req, res) => {
  const s = retireFeeSchedule(String(req.params.id), req.user!.id);
  audit(req.user!.id, 'fees.schedule.retire', 'fee_schedule', s.id, {});
  res.json(s);
});
/** Explain which rule applies to a user (or a country / tier) for each fee type. */
r.get('/fees/effective', requirePermission('settings'), (req, res) => {
  const ctx = { userId: req.query.user ? String(req.query.user) : null, country: req.query.country ? String(req.query.country) : null, tier: req.query.tier ? String(req.query.tier) : null };
  const type = req.query.type ? String(req.query.type) : null;
  res.json(type ? { type, resolved: resolveFeeRule(type, ctx) } : { data: effectiveFees(ctx) });
});
r.put('/fees/tier/:userId', requirePermission('users'), (req, res) => {
  const b = validate(z.object({ tier: z.string().max(40).nullable() }), req.body);
  if (!findUserById(String(req.params.userId))) throw notFound('User not found', 'user_not_found');
  setFeeTier(String(req.params.userId), b.tier, req.user!.id);
  audit(req.user!.id, 'fees.tier.set', 'user', String(req.params.userId), { tier: b.tier });
  res.json({ ok: true, userId: String(req.params.userId), tier: b.tier });
});

// ---------------------------------------------------------------- settlements
r.get('/settlements/cycles', requirePermission('transactions'), (req, res) => res.json({ items: listCycles({ userId: req.query.user ? String(req.query.user) : null, status: req.query.status ? String(req.query.status) : null, currency: req.query.currency ? String(req.query.currency).toUpperCase() : null, limit: Math.min(500, Number(req.query.limit) || 100) }) }));
r.get('/settlements/obligations', requirePermission('transactions'), (req, res) => res.json(obligations(req.query.user ? String(req.query.user) : null)));
r.get('/settlements/profiles/:userId', requirePermission('transactions'), (req, res) => res.json({ items: listProfiles(String(req.params.userId)) }));
r.post('/settlements/cycles', requirePermission('treasury'), (req, res) => {
  const b = validate(z.object({ userId: z.string(), currency: z.string().length(3), rail: z.string().max(40).optional(), businessDate: z.string().optional().nullable(), pay: z.boolean().optional() }), req.body);
  if (!findUserById(b.userId)) throw notFound('User not found', 'user_not_found');
  let c = closeCycle(b.userId, b.currency.toUpperCase(), b.rail ?? 'default', { businessDate: b.businessDate ?? null, actor: admin(req) });
  if (b.pay && c.status === 'CLOSED') c = payCycle(c.id, admin(req));
  audit(req.user!.id, 'settlements.cycle.close', 'settlement_cycle', c.id, { userId: b.userId, currency: c.currency, net: c.netMinor, status: c.status });
  res.status(201).json(c);
});
r.get('/settlements/cycles/:id', requirePermission('transactions'), (req, res) => {
  const c = getCycle(null, String(req.params.id));
  res.json({ ...c, items: cycleItems(c.id) });
});
r.post('/settlements/cycles/:id/pay', requirePermission('treasury'), (req, res) => {
  const c = payCycle(String(req.params.id), admin(req));
  audit(req.user!.id, 'settlements.cycle.pay', 'settlement_cycle', c.id, { status: c.status, transactionId: c.withdrawalTransactionId });
  res.json(c);
});
r.get('/settlements/cycles/:id/statement', requirePermission('transactions'), (req, res) => {
  const format = String(req.query.format ?? 'json');
  const id = String(req.params.id);
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.send(cycleStatementCsv(id));
  }
  if (format === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    return res.send(cycleStatementPdf(id));
  }
  res.json(cycleStatement(id));
});
r.post('/settlements/run', requirePermission('treasury'), (req, res) => {
  const out = runSettlementSchedules();
  audit(req.user!.id, 'settlements.run', 'settlement_cycle', undefined, out);
  res.json(out);
});

// ---------------------------------------------------------------- disputes
r.get('/disputes', requirePermission('transactions'), (req, res) => res.json({ items: listDisputes({ merchantId: req.query.merchant ? String(req.query.merchant) : null, status: req.query.status ? String(req.query.status) : null, limit: Math.min(500, Number(req.query.limit) || 100) }), settings: getDisputeSettings() }));
r.put('/disputes/settings', requirePermission('settings'), (req, res) => {
  const b = validate(z.object({ responseDays: z.record(z.string(), z.number().int().min(1).max(120)).optional(), onDeadline: z.enum(['LOST', 'UNDER_REVIEW']).optional(), reasonCodes: z.array(z.string().min(2).max(40)).min(1).optional() }), req.body);
  setSetting('disputes', { ...getSetting('disputes', {}), ...b });
  audit(req.user!.id, 'disputes.settings', 'settings', 'disputes', b);
  res.json(getDisputeSettings());
});
r.post('/disputes', requirePermission('transactions'), (req, res) => {
  const b = validate(z.object({ transactionId: z.string().optional().nullable(), intentId: z.string().optional().nullable(), gatewayPaymentId: z.string().optional().nullable(), switchPaymentId: z.string().optional().nullable(), openedBy: z.enum(['customer', 'merchant', 'processor', 'institution', 'admin']).optional(), reasonCode: z.string().min(2), reason: z.string().max(2000).optional().nullable(), amountMinor: z.number().int().positive().optional().nullable(), responsibleInstitution: z.string().max(80).optional().nullable(), evidenceText: z.string().max(8000).optional().nullable() }), req.body);
  const d = openDispute({ ...b, openedBy: b.openedBy ?? 'admin' }, admin(req));
  audit(req.user!.id, 'disputes.open', 'dispute', d.id, { openedBy: d.openedBy, amount: d.amount.valueMinor, reasonCode: d.reasonCode });
  res.status(201).json(d);
});
r.get('/disputes/:id', requirePermission('transactions'), (req, res) => res.json({ ...getDispute(null, String(req.params.id)), chronology: disputeChronology(String(req.params.id)).events }));
r.post('/disputes/:id/request-evidence', requirePermission('transactions'), (req, res) => {
  const b = validate(z.object({ note: z.string().min(2).max(2000) }), req.body);
  const d = requestEvidence(String(req.params.id), req.user!, b.note);
  audit(req.user!.id, 'disputes.request_evidence', 'dispute', d.id, {});
  res.json(d);
});
r.post('/disputes/:id/evidence', requirePermission('transactions'), (req, res) => {
  const b = validate(z.object({ text: z.string().max(8000).optional().default(''), files: z.array(z.string().max(300)).max(20).optional() }), req.body);
  res.json(addEvidence(String(req.params.id), { id: req.user!.id, role: 'admin' }, b.text, b.files ?? []));
});
r.post('/disputes/:id/decide', requirePermission('transactions'), wrap(async (req, res) => {
  const b = validate(z.object({ decision: z.enum(['WON', 'LOST']), reason: z.string().min(3).max(2000) }), req.body);
  const d = await decideDispute(String(req.params.id), b.decision, req.user!, b.reason);
  audit(req.user!.id, 'disputes.decide', 'dispute', d.id, { decision: b.decision, refundId: d.refundId });
  res.json(d);
}));
r.post('/disputes/:id/withdraw', requirePermission('transactions'), (req, res) => {
  const d = withdrawDispute(String(req.params.id), admin(req));
  audit(req.user!.id, 'disputes.withdraw', 'dispute', d.id, {});
  res.json(d);
});
r.post('/disputes/sweep', requirePermission('transactions'), (req, res) => res.json({ swept: sweepDisputeDeadlines() }));

// ---------------------------------------------------------------- holds
r.get('/holds', requirePermission('transactions'), (req, res) => res.json({ items: listHolds({ userId: req.query.user ? String(req.query.user) : null, walletId: req.query.wallet ? String(req.query.wallet) : null, status: req.query.status ? String(req.query.status) : null, limit: Math.min(500, Number(req.query.limit) || 100) }) }));
r.post('/holds', requirePermission('treasury'), (req, res) => {
  const b = validate(z.object({ walletId: z.string().optional(), userId: z.string().optional(), currency: z.string().length(3).optional(), amountMinor: z.number().int().positive(), kind: z.enum(['dispute', 'reserve', 'review', 'settlement', 'compliance']), reason: z.string().min(3).max(500), refType: z.string().max(40).optional().nullable(), refId: z.string().max(80).optional().nullable(), expiresAt: z.string().datetime().optional().nullable() }), req.body);
  let walletId = b.walletId;
  if (!walletId) {
    if (!b.userId || !b.currency) throw notFound('walletId, or userId and currency, is required', 'wallet_not_found');
    walletId = getUserWallet(b.userId, b.currency.toUpperCase()).id;
  }
  const h = createHold({ walletId, amountMinor: b.amountMinor, kind: b.kind, reason: b.reason, refType: b.refType ?? null, refId: b.refId ?? null, expiresAt: b.expiresAt ?? null }, admin(req));
  audit(req.user!.id, 'holds.create', 'hold', h.id, { walletId: h.walletId, amount: h.amountMinor, kind: h.kind, reason: b.reason });
  res.status(201).json(h);
});
r.get('/holds/:id', requirePermission('transactions'), (req, res) => res.json(getHold(String(req.params.id))));
r.post('/holds/:id/release', requirePermission('treasury'), (req, res) => {
  const b = validate(z.object({ reason: z.string().min(3).max(500) }), req.body);
  const h = releaseHold(String(req.params.id), admin(req), b.reason);
  audit(req.user!.id, 'holds.release', 'hold', h.id, { reason: b.reason });
  res.json(h);
});
r.post('/holds/expire', requirePermission('treasury'), (_req, res) => res.json({ released: expireHolds() }));

// ---------------------------------------------------------------- commissions
r.get('/commissions/overview', requirePermission('agents'), (req, res) => res.json({ ...commissionOverview(req.query.period ? String(req.query.period) : undefined), settings: getCommissionSettings() }));
r.put('/commissions/settings', requirePermission('settings'), (req, res) => {
  const b = validate(z.object({ platformShareBps: z.number().int().min(0).max(10_000).optional(), payoutThreshold: z.number().int().min(0).optional(), onboardingFeeMinor: z.number().int().min(0).optional() }), req.body);
  setSetting('commissions', { ...getSetting('commissions', {}), ...b });
  audit(req.user!.id, 'commissions.settings', 'settings', 'commissions', b);
  res.json(getCommissionSettings());
});
r.get('/commissions/:agentId', requirePermission('agents'), (req, res) => res.json({ statement: commissionStatement(String(req.params.agentId), req.query.period ? String(req.query.period) : undefined), entries: listCommissions(String(req.params.agentId), { period: req.query.period ? String(req.query.period) : null, limit: Number(req.query.limit) || 100 }) }));

// ---------------------------------------------------------------- processor reconciliation workbench
r.get('/reconciliation/workbench', requirePermission('reconciliation'), (_req, res) => res.json(workbenchSummary()));
r.post('/reconciliation/processors/:gatewayId/statements', requirePermission('reconciliation'), (req, res) => {
  const b = validate(z.object({ source: z.enum(['PROCESSOR', 'BANK']).optional().default('PROCESSOR'), cycleRef: z.string().min(4).max(40), currency: z.string().length(3), lines: z.array(z.object({ reference: z.string().min(1), amountMinor: z.union([z.number().int(), z.string()]), currency: z.string().length(3), status: z.string().min(1), feeMinor: z.union([z.number().int(), z.string()]).optional().nullable(), settlementRef: z.string().optional().nullable(), occurredAt: z.string().optional().nullable() })).min(1).max(50_000), controlTotalMinor: z.union([z.number().int(), z.string()]).optional().nullable(), periodFrom: z.string().optional().nullable(), periodTo: z.string().optional().nullable(), run: z.boolean().optional() }), req.body);
  const imp = importProcessorStatement(String(req.params.gatewayId), b, req.user!.id);
  audit(req.user!.id, 'reconciliation.processor.import', 'reconciliation_import', imp.id, { gatewayId: String(req.params.gatewayId), cycleRef: b.cycleRef, lines: imp.lineCount, duplicate: imp.duplicate });
  const run = b.run ? runProcessorReconciliation(String(req.params.gatewayId), b.cycleRef, req.user!.id) : null;
  res.status(201).json({ import: imp, run });
});
r.post('/reconciliation/processors/:gatewayId/run', requirePermission('reconciliation'), (req, res) => {
  const b = validate(z.object({ cycleRef: z.string().min(4).max(40) }), req.body);
  const run = runProcessorReconciliation(String(req.params.gatewayId), b.cycleRef, req.user!.id);
  audit(req.user!.id, 'reconciliation.processor.run', 'reconciliation_run', (run as any).id ?? undefined, { gatewayId: String(req.params.gatewayId), cycleRef: b.cycleRef });
  res.json(run);
});

// ---------------------------------------------------------------- split payouts
r.get('/splits/:intentId', requirePermission('transactions'), (req, res) => res.json({ items: listSplitPayouts(String(req.params.intentId)) }));
r.post('/splits/:intentId/retry', requirePermission('treasury'), (req, res) => {
  const items = retrySplits(String(req.params.intentId));
  audit(req.user!.id, 'splits.retry', 'payment_intent', String(req.params.intentId), { paid: items.filter((i) => i.status === 'PAID').length });
  res.json({ items });
});
// Convenience: show the DB-level fee tier and holds of one user in one call (used by the admin console's user drawer).
r.get('/users/:userId/finance', requirePermission('users'), (req, res) => {
  const u = findUserById(String(req.params.userId));
  if (!u) throw notFound('User not found', 'user_not_found');
  res.json({ tier: (getDb().prepare('SELECT fee_tier FROM users WHERE id = ?').get(u.id) as any)?.fee_tier ?? null, fees: effectiveFees({ userId: u.id }), holds: listHolds({ userId: u.id, status: 'ACTIVE' }), profiles: listProfiles(u.id), cycles: listCycles({ userId: u.id, limit: 20 }), disputes: listDisputes({ merchantId: u.id, limit: 20 }) });
});
