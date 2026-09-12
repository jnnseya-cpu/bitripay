/**
 * Tools for the operations agent mesh (registry PR-A01…PR-F02). Every tool is a thin, typed door onto a Phase 4–6
 * service: reads are free of side effects; anything that changes state is either a proposal (notification, draft)
 * or an approval-gated administrative action that a second person executes. Nothing here can move money, mark a
 * payment paid, change a national route or clear a sanctions hit.
 */
import { z } from 'zod';
import { getDb } from '../../db';
import { registerTools, type ToolDef } from './tools';
import type { Role } from '@bitripay/shared';
import { listRails, connectorHealth, connectorStats, pauseConnector, resumeConnector } from '../rails';
import { listPayments as listSwitchPayments, paymentTimeline, recoverUncertainEmissions } from '../switch/payments';
import { listCases as listReconCases, getCase as getReconCase, proposeResolution } from '../switch/reconciliation';
import { workbenchSummary } from '../finops/processorRecon';
import { getDispute, disputeChronology, decideDispute, listDisputes } from '../finops/disputes';
import { getTransaction, toTransaction } from '../ledger';
import { listRateCards, listRatePolicies, signRatePolicy } from '../diaspora';
import { fxDisclosure } from '../fx';
import { floatForecast, latestTrustScore, listFloatRequests } from '../risk/agentIntel';
import { listFraudScores } from '../risk/fraud';
import { listCases as listComplianceCases } from '../risk/compliance';
import { activePolicy } from '../risk/policy';
import { createVerification, verificationQuota } from '../gateway';
import { merchantStats } from '../merchant';
import { settlementCalendar } from '../finops/settlement';
import { tierStatus } from '../risk/kycTiers';
import { notify } from '../notifications';
import { findUserById } from '../users';

const ADMIN: Role[] = ['admin'];
const MERCHANT: Role[] = ['merchant', 'admin'];
const t = <S extends z.ZodTypeAny>(d: ToolDef<S>) => d;

export const MESH_TOOLS: ToolDef<any>[] = [
  t({ name: 'rails.health', description: 'Every rail and connector with its circuit state, 24h success rate, latency and pause reason.', roles: ADMIN, permission: 'switch', sideEffect: false, schema: z.object({ kind: z.string().optional() }), run: (_c, i) => ({ rails: listRails({ kind: (i.kind as any) ?? null }).map((r) => ({ id: r.id, kind: r.kind, name: r.name, health: connectorHealth(r.id), stats: connectorStats(r.id) })) }) }),
  t({ name: 'rails.propose_pause', description: 'Pause a degraded connector so Smart Route stops choosing it (payments reroute). Requires a second administrator.', roles: ADMIN, permission: 'switch', sideEffect: true, requiresApproval: true, schema: z.object({ connector: z.string(), reason: z.string().min(8).max(300) }), summarize: (i) => `Pause connector ${i.connector}: ${i.reason}`, run: (c, i) => ({ health: pauseConnector(i.connector, c.actor.id, `[agent:${c.agentKey}] ${i.reason}`) }) }),
  t({ name: 'rails.propose_resume', description: 'Resume a paused connector after it probes healthy. Requires a second administrator.', roles: ADMIN, permission: 'switch', sideEffect: true, requiresApproval: true, schema: z.object({ connector: z.string() }), summarize: (i) => `Resume connector ${i.connector}`, run: (c, i) => ({ health: resumeConnector(i.connector, c.actor.id) }) }),
  t({ name: 'switch.uncertain', description: 'Switch payments in an uncertain state (UNKNOWN, timed out, pending past the inquiry window) with their timelines.', roles: ADMIN, permission: 'switch', sideEffect: false, schema: z.object({ limit: z.number().int().min(1).max(50).default(20) }), run: (_c, i) => ({ payments: listSwitchPayments({ uncertainOnly: true, limit: i.limit }).map((p) => ({ ...p, timeline: paymentTimeline(p.payment_id) })) }) }),
  t({ name: 'switch.recover_uncertain', description: 'Run the uncertainty recovery now: inquiries for every uncertain emission. Never re-emits; safe to call.', roles: ADMIN, permission: 'switch', sideEffect: true, schema: z.object({}), summarize: () => 'Recover uncertain emissions (inquiries only)', run: () => ({ recovered: recoverUncertainEmissions() }) }),
  t({ name: 'recon.cases', description: 'Open reconciliation cases across the national switch and the processors, with exposure and age.', roles: ADMIN, permission: 'reconciliation', sideEffect: false, schema: z.object({ status: z.string().optional(), olderThanHours: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50) }), run: (_c, i) => ({ cases: listReconCases({ status: i.status ?? 'OPEN', limit: i.limit }).data.filter((c) => c.ageHours >= i.olderThanHours), workbench: workbenchSummary() }) }),
  t({ name: 'recon.evidence_pack', description: 'Everything on file for one reconciliation case: the case, the local payment timeline, the statement line, related events.', roles: ADMIN, permission: 'reconciliation', sideEffect: false, schema: z.object({ caseId: z.string() }), run: (_c, i) => {
    const c = getReconCase(i.caseId);
    const line = c.lineId ? getDb().prepare('SELECT * FROM reconciliation_lines WHERE id = ?').get(c.lineId) : null;
    let timeline: unknown = null;
    if (c.paymentId) {
      try {
        timeline = paymentTimeline(c.paymentId);
      } catch {
        const gp = getDb().prepare('SELECT * FROM gateway_payments WHERE id = ?').get(c.paymentId) as any;
        timeline = gp ? { gatewayPayment: { id: gp.id, gateway: gp.gateway, providerRef: gp.provider_ref, amount: gp.amount, currency: gp.currency, stage: gp.stage, transactionId: gp.transaction_id } } : null;
      }
    }
    return { case: c, statementLine: line, timeline };
  } }),
  t({ name: 'recon.propose_resolution', description: 'Attach a proposed resolution and documents to a case for a human to approve closure. Never closes anything by itself.', roles: ADMIN, permission: 'reconciliation', sideEffect: true, requiresApproval: true, schema: z.object({ caseId: z.string(), resolution: z.string().min(10).max(2000), documents: z.array(z.string()).max(10).default([]) }), summarize: (i) => `Propose resolution on case ${i.caseId}`, run: (c, i) => ({ case: proposeResolution(i.caseId, `[agent:${c.agentKey}] ${i.resolution}`, i.documents, c.actor.id) }) }),
  t({ name: 'disputes.summary', description: 'A dispute with both sides’ evidence, its chronology and the underlying transaction.', roles: ADMIN, permission: 'transactions', sideEffect: false, schema: z.object({ disputeId: z.string() }), run: (_c, i) => {
    const d = getDispute(null, i.disputeId);
    const tx = d.transactionId ? getTransaction(d.transactionId) : null;
    return { dispute: d, chronology: disputeChronology(d.id).events, transaction: tx ? toTransaction(tx, d.merchantId) : null };
  } }),
  t({ name: 'disputes.open', description: 'Disputes awaiting a decision, oldest first.', roles: ADMIN, permission: 'transactions', sideEffect: false, schema: z.object({ limit: z.number().int().min(1).max(100).default(30) }), run: (_c, i) => ({ disputes: listDisputes({ status: 'UNDER_REVIEW', limit: i.limit }) }) }),
  t({ name: 'disputes.propose_ruling', description: 'Propose WON or LOST with the reasoning. A second administrator confirms; only then does money move (a LOST ruling refunds through the refund object).', roles: ADMIN, permission: 'transactions', sideEffect: true, requiresApproval: true, schema: z.object({ disputeId: z.string(), decision: z.enum(['WON', 'LOST']), reason: z.string().min(10).max(2000) }), summarize: (i) => `Rule dispute ${i.disputeId} ${i.decision}: ${i.reason.slice(0, 120)}`, run: async (c, i) => ({ dispute: await decideDispute(i.disputeId, i.decision, c.actor, `[agent:${c.agentKey}] ${i.reason}`) }) }),
  t({ name: 'fx.rate_card', description: 'Published Diaspora-Direct rate cards, their signed policies and the live mid-market disclosure for a pair.', roles: ADMIN, permission: 'treasury', sideEffect: false, schema: z.object({ sourceCurrency: z.string().length(3).optional(), destCurrency: z.string().length(3).optional() }), run: (_c, i) => ({ cards: listRateCards(), policies: listRatePolicies(), live: i.sourceCurrency && i.destCurrency ? fxDisclosure(i.sourceCurrency.toUpperCase(), i.destCurrency.toUpperCase(), null, false) : null }) }),
  t({ name: 'fx.propose_policy', description: 'Propose a new signed rate policy (markup, fees, ceilings) for a pair. A second administrator signs it; cards are re-issued under it.', roles: ADMIN, permission: 'treasury', sideEffect: true, requiresApproval: true, schema: z.object({ sourceCurrency: z.string().length(3), destCurrency: z.string().length(3), markupBps: z.number().int().min(0).max(1500), feeBps: z.number().int().min(0).max(1000).default(0), feeFixedSourceMinor: z.number().int().min(0).default(0), maxValidityHours: z.number().int().min(1).max(4).default(4), rationale: z.string().min(10).max(500) }), summarize: (i) => `Sign rate policy ${i.sourceCurrency}/${i.destCurrency} at ${i.markupBps} bps: ${i.rationale.slice(0, 100)}`, run: (c, i) => ({ policy: signRatePolicy(c.actor, { sourceCurrency: i.sourceCurrency, destCurrency: i.destCurrency, markupBps: i.markupBps, feeBps: i.feeBps, feeFixedSourceMinor: i.feeFixedSourceMinor, maxValidityHours: i.maxValidityHours }) }) }),
  t({ name: 'agents.float_overview', description: 'Float forecasts (runway, refill) and trust bands for every active cash agent, plus open replenishment requests.', roles: ADMIN, permission: 'agents', sideEffect: false, schema: z.object({ onlyLow: z.boolean().default(true) }), run: (_c, i) => {
    const agents = getDb().prepare("SELECT id, full_name, business_name, tag, country FROM users WHERE role = 'agent' AND status = 'active'").all() as any[];
    const rows = agents.map((a) => ({ id: a.id, name: a.business_name || a.full_name, tag: a.tag, country: a.country, band: latestTrustScore(a.id)?.band ?? null, float: floatForecast(a.id) })).filter((r) => !i.onlyLow || r.float.some((f) => f.status === 'low' || f.status === 'critical'));
    return { agents: rows, requests: listFloatRequests({ status: 'REQUESTED', limit: 50 }) };
  } }),
  t({ name: 'agents.recommend_refill', description: 'Send an agent a refill recommendation within the signed envelope (amount ≤ the forecast target). Moves no money.', roles: ADMIN, permission: 'agents', sideEffect: true, schema: z.object({ agentId: z.string(), currency: z.string().length(3), amountMinor: z.number().int().positive(), note: z.string().max(300).default('') }), summarize: (i) => `Recommend refill of ${i.amountMinor} ${i.currency} to ${i.agentId}`, run: (c, i) => {
    const f = floatForecast(i.agentId).find((x) => x.currency === i.currency.toUpperCase());
    if (!f) return { error: 'no_wallet' };
    const capped = Math.min(i.amountMinor, Math.max(f.refillRecommendedMinor, f.targetFloatMinor));
    notify(i.agentId, 'Float refill recommended', `Operations suggest refilling ${capped / 100} ${i.currency.toUpperCase()} (runway ${f.runwayDays ?? '∞'} days). ${i.note}`.trim(), { kind: 'wallet', agent: c.agentKey });
    return { recommended: capped, forecast: f };
  } }),
  t({ name: 'fraud.explain', description: 'Recent fraud scores for an account or subject with every factor, the rule that decided and the active policy version.', roles: ADMIN, permission: 'compliance', sideEffect: false, schema: z.object({ userId: z.string().optional(), band: z.string().optional(), limit: z.number().int().min(1).max(50).default(10) }), run: (_c, i) => ({ scores: listFraudScores({ userId: i.userId ?? null, band: i.band ?? null, limit: i.limit }), policy: { id: activePolicy().id, version: activePolicy().version } }) }),
  t({ name: 'compliance.cases', description: 'Open compliance cases (fraud blocks, AML findings, sanctions hits) with their SAR drafts.', roles: ADMIN, permission: 'compliance', sideEffect: false, schema: z.object({ kind: z.string().optional(), limit: z.number().int().min(1).max(100).default(30) }), run: (_c, i) => ({ cases: listComplianceCases({ kind: i.kind ?? null, status: null, limit: i.limit }).filter((c) => c.status !== 'CLOSED') }) }),
  t({ name: 'verification.koda', description: 'Scan-to-Verify (KODA): confirm within seconds whether a payment with this reference or MSISDN+amount reached the merchant. Free within the monthly quota, then charged as disclosed.', roles: MERCHANT, sideEffect: true, schema: z.object({ rail: z.string().default('any'), reference: z.string().optional(), msisdn: z.string().optional(), amountMinor: z.number().int().positive().optional(), currency: z.string().length(3).optional() }), summarize: (i) => `Verify ${i.reference ?? `${i.msisdn} ${i.amountMinor}`}`, run: (c, i) => ({ verification: createVerification(c.user, { rail: i.rail, reference: i.reference ?? null, msisdn: i.msisdn ?? null, amountMinor: i.amountMinor ?? null, currency: i.currency ?? null }), quota: verificationQuota(c.user.id) }) }),
  t({ name: 'merchant.growth', description: 'Weekly growth picture for a merchant: sales, methods, settlement calendar, open disputes, verification level.', roles: MERCHANT, sideEffect: false, schema: z.object({}), run: (c) => ({ stats: merchantStats(c.user), settlement: settlementCalendar(c.user.id), disputes: listDisputes({ merchantId: c.user.id, limit: 10 }).filter((d) => !['WON', 'LOST', 'WITHDRAWN'].includes(d.status)), verification: tierStatus(c.user as any) }) }),
  t({ name: 'onboarding.status', description: 'Verification level, limits and the next step for an account.', roles: ['user', 'merchant', 'agent', 'admin'], sideEffect: false, schema: z.object({ userId: z.string().optional() }), run: (c, i) => {
    const u = c.user.role === 'admin' && i.userId ? findUserById(i.userId) : c.user;
    return u ? tierStatus(u as any) : { error: 'not_found' };
  } }),
];
registerTools(MESH_TOOLS);
