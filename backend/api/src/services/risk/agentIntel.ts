/**
 * Agent intelligence: float forecasts (how many days of cash-in an agent can still serve, when to refill), a trust
 * score built from the agent's own record (tenure, consistency, disputes and reversals, abandoned requests,
 * verification level, float discipline), commissions that move with the score and with where liquidity is
 * needed, float replenishment requests routed through the e-money maker-checker, and agent-assisted onboarding
 * that opens a Tier 1 account in minutes and pays the onboarding commission.
 */
import { randomInt } from 'node:crypto';
import { getDb } from '../../db';
import { config } from '../../config';
import { now, shortCode, uuid } from '../../lib/ids';
import { parseJson } from '../../lib/json';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { getSetting, getAppSettings } from '../settings';
import { getBaseCurrency, getCurrency, toBase } from '../currencies';
import { formatMoney } from '@bitripay/shared';
import { recordEvent } from '../events';
import { findUserById, createUser, updateUser, toPublicUser, type UserRow } from '../users';
import { listWallets, ensureWallet } from '../wallets';
import { notify } from '../notifications';
import { proposeVerification, verificationOutcomeHooks } from '../verification';
import { hashPassword } from '../../lib/password';
import { recordCommission } from '../finops/commissions';
import { setTier } from './kycTiers';
import { publish } from '../bus';
import { resolveFeeRule } from '../finops/fees';

export interface AgentIntelSettings {
  /** Days of average outflow the float should cover; below alertDays the agent (and operations) are alerted. */
  targetDays: number;
  alertDays: number;
  /** Commission bonus (bps) per trust band, added to the agent's base commission. */
  bonusByBand: Record<'new' | 'bronze' | 'silver' | 'gold' | 'platinum', number>;
  /** Extra cash-in commission where the network needs liquidity (agents whose float runway is below alertDays). */
  liquidityBonusBps: number;
  /** Minimum tenure (days) before bonuses apply. */
  minTenureDays: number;
  onboardingCommissionMinor: number;
  /** §59 float intelligence: base cash-operation ceilings (base currency, minor units) scaled by trust band. */
  limitBaseMinor: { perTransaction: number; daily: number };
  limitMultiplierByBand: Record<'new' | 'bronze' | 'silver' | 'gold' | 'platinum', number>;
  /** Hours the float outlook looks ahead and the depletion probabilities that make the risk MEDIUM / HIGH. */
  outlookHours: number;
  depletionMediumProbability: number;
  depletionHighProbability: number;
}
const DEFAULT: AgentIntelSettings = {
  targetDays: 3,
  alertDays: 1,
  bonusByBand: { new: 0, bronze: 0, silver: 5, gold: 10, platinum: 20 },
  liquidityBonusBps: 10,
  minTenureDays: 30,
  onboardingCommissionMinor: 200,
  limitBaseMinor: { perTransaction: 200_000, daily: 2_000_000 },
  limitMultiplierByBand: { new: 0.5, bronze: 1, silver: 1.5, gold: 2, platinum: 3 },
  outlookHours: 4,
  depletionMediumProbability: 0.2,
  depletionHighProbability: 0.5,
};
export const getAgentIntelSettings = (): AgentIntelSettings => {
  const s = getSetting<Partial<AgentIntelSettings>>('agentIntel', {});
  return {
    ...DEFAULT,
    ...s,
    bonusByBand: { ...DEFAULT.bonusByBand, ...(s.bonusByBand ?? {}) },
    limitBaseMinor: { ...DEFAULT.limitBaseMinor, ...(s.limitBaseMinor ?? {}) },
    limitMultiplierByBand: { ...DEFAULT.limitMultiplierByBand, ...(s.limitMultiplierByBand ?? {}) },
  };
};

// ---------------------------------------------------------------------------------------------------------------------
// Float forecast
// ---------------------------------------------------------------------------------------------------------------------
export interface FloatForecast {
  currency: string;
  balanceMinor: number;
  avgDailyOutflowMinor: number;
  avgDailyInflowMinor: number;
  runwayDays: number | null;
  targetFloatMinor: number;
  refillRecommendedMinor: number;
  status: 'ok' | 'low' | 'critical' | 'idle';
  window: { days: number; cashIns: number; cashOuts: number };
}
export function floatForecast(agentId: string, days = 14): FloatForecast[] {
  const db = getDb();
  const s = getAgentIntelSettings();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  return listWallets(agentId).map((w) => {
    // cash-in debits the float (agent pays the customer); cash-out and pickups credit it
    const out = db
      .prepare("SELECT COUNT(*) c, COALESCE(SUM(amount), 0) s FROM transactions WHERE sender_user_id = ? AND currency = ? AND type = 'agent_cash_in' AND status = 'completed' AND created_at >= ?")
      .get(agentId, w.currency, since) as any;
    const inn = db
      .prepare("SELECT COUNT(*) c, COALESCE(SUM(amount), 0) s FROM transactions WHERE receiver_user_id = ? AND currency = ? AND type = 'agent_cash_out' AND status = 'completed' AND created_at >= ?")
      .get(agentId, w.currency, since) as any;
    const avgOut = Math.round(out.s / days);
    const avgIn = Math.round(inn.s / days);
    const net = Math.max(0, avgOut - avgIn);
    const runway = net > 0 ? Math.round((w.balance / net) * 10) / 10 : null;
    const target = Math.round(Math.max(avgOut, net) * s.targetDays);
    const refill = Math.max(0, target - w.balance);
    const status: FloatForecast['status'] = out.c + inn.c === 0 ? 'idle' : runway !== null && runway < s.alertDays ? 'critical' : runway !== null && runway < s.targetDays ? 'low' : 'ok';
    return {
      currency: w.currency,
      balanceMinor: w.balance,
      avgDailyOutflowMinor: avgOut,
      avgDailyInflowMinor: avgIn,
      runwayDays: runway,
      targetFloatMinor: target,
      refillRecommendedMinor: refill,
      status,
      window: { days, cashIns: out.c, cashOuts: inn.c },
    };
  });
}
/** Daily: alert agents whose runway is below the threshold and tell operations. */
export function runFloatAlerts(): { alerted: number } {
  const db = getDb();
  let alerted = 0;
  for (const a of db.prepare("SELECT id FROM users WHERE role = 'agent' AND status = 'active'").all() as { id: string }[]) {
    for (const f of floatForecast(a.id)) {
      if (f.status !== 'critical' && f.status !== 'low') continue;
      const cur = getCurrency(f.currency, false);
      const key = `float:${a.id}:${f.currency}:${now().slice(0, 10)}`;
      if (db.prepare("SELECT 1 FROM event_log WHERE stream = 'liquidity' AND subject_id = ? LIMIT 1").get(key)) continue;
      recordEvent(
        'liquidity',
        key,
        'agent.float_low',
        { type: 'system' },
        { agentId: a.id, currency: f.currency, balance: f.balanceMinor, runwayDays: f.runwayDays, refill: f.refillRecommendedMinor, status: f.status },
      );
      publish('agent.float_low', { agentId: a.id, currency: f.currency, balance: f.balanceMinor, runwayDays: f.runwayDays, refill: f.refillRecommendedMinor, status: f.status }, { aggregateId: a.id });
      notify(
        a.id,
        f.status === 'critical' ? 'Float critically low' : 'Float running low',
        `${formatMoney(f.balanceMinor, cur)} covers about ${f.runwayDays} day(s) of cash-in. Refill ${formatMoney(f.refillRecommendedMinor, cur)} to reach your ${getAgentIntelSettings().targetDays}-day target.`,
        { kind: 'wallet', loud: f.status === 'critical' },
      );
      alerted += 1;
    }
  }
  return { alerted };
}

// ---------------------------------------------------------------------------------------------------------------------
// Trust score
// ---------------------------------------------------------------------------------------------------------------------
export type TrustBand = 'new' | 'bronze' | 'silver' | 'gold' | 'platinum';
export interface TrustScore {
  agentId: string;
  score: number;
  band: TrustBand;
  factors: Record<string, { points: number; detail: string }>;
  commissionBonusBps: number;
  computedAt: string;
}
export function bandForTrust(score: number, tenureDays: number, minTenure: number): TrustBand {
  if (tenureDays < minTenure) return 'new';
  if (score >= 90) return 'platinum';
  if (score >= 75) return 'gold';
  if (score >= 55) return 'silver';
  return 'bronze';
}
export function computeTrustScore(agentId: string, persist = true): TrustScore {
  const db = getDb();
  const s = getAgentIntelSettings();
  const agent = findUserById(agentId) as (UserRow & { kyc_tier?: number; kyb_status?: string }) | undefined;
  if (!agent || agent.role !== 'agent') throw notFound('Agent not found', 'agent_not_found');
  const factors: TrustScore['factors'] = {};
  const tenureDays = Math.floor((Date.now() - Date.parse(agent.created_at)) / 86_400_000);
  const since90 = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const completed = (
    db
      .prepare("SELECT COUNT(*) c FROM transactions WHERE (sender_user_id = ? OR receiver_user_id = ?) AND type IN ('agent_cash_in', 'agent_cash_out') AND status = 'completed' AND created_at >= ?")
      .get(agentId, agentId, since90) as any
  ).c as number;
  const reversed = (
    db
      .prepare(
        "SELECT COUNT(*) c FROM transactions WHERE (sender_user_id = ? OR receiver_user_id = ?) AND type IN ('agent_cash_in', 'agent_cash_out') AND status IN ('reversed', 'failed', 'rejected') AND created_at >= ?",
      )
      .get(agentId, agentId, since90) as any
  ).c as number;
  const expired = (db.prepare("SELECT COUNT(*) c FROM cash_requests WHERE agent_id = ? AND status IN ('expired', 'cancelled') AND created_at >= ?").get(agentId, since90) as any).c as number;
  const requests = (db.prepare('SELECT COUNT(*) c FROM cash_requests WHERE agent_id = ? AND created_at >= ?').get(agentId, since90) as any).c as number;
  const disputes = (db.prepare('SELECT COUNT(*) c FROM disputes WHERE merchant_user_id = ? AND created_at >= ?').get(agentId, since90) as any).c as number;
  const lostDisputes = (db.prepare("SELECT COUNT(*) c FROM disputes WHERE merchant_user_id = ? AND status = 'LOST' AND created_at >= ?").get(agentId, since90) as any).c as number;
  const cases = (db.prepare("SELECT COUNT(*) c FROM compliance_cases WHERE user_id = ? AND status != 'CLOSED'").get(agentId) as any).c as number;
  const activeDays = (
    db
      .prepare(
        "SELECT COUNT(DISTINCT substr(created_at, 1, 10)) c FROM transactions WHERE (sender_user_id = ? OR receiver_user_id = ?) AND type IN ('agent_cash_in', 'agent_cash_out') AND status = 'completed' AND created_at >= ?",
      )
      .get(agentId, agentId, since90) as any
  ).c as number;
  const lowFloatDays = (
    db.prepare("SELECT COUNT(*) c FROM event_log WHERE stream = 'liquidity' AND event = 'agent.float_low' AND subject_id LIKE ? AND created_at >= ?").get(`float:${agentId}:%`, since90) as any
  ).c as number;
  const add = (k: string, points: number, detail: string) => (factors[k] = { points, detail });
  add('tenure', Math.min(20, Math.round((tenureDays / 365) * 20)), `${tenureDays} days on the network`);
  add('activity', Math.min(20, Math.round((activeDays / 60) * 20)), `${activeDays} active days in the last 90`);
  const reliability = completed + reversed > 0 ? 1 - reversed / (completed + reversed) : 1;
  add('reliability', Math.round(reliability * 20), `${reversed} reversed / failed of ${completed + reversed} cash operations`);
  const followThrough = requests > 0 ? 1 - expired / requests : 1;
  add('follow_through', Math.round(followThrough * 15), `${expired} of ${requests} cash-out requests expired or cancelled`);
  add('disputes', Math.max(0, 15 - lostDisputes * 5 - disputes * 2), `${disputes} dispute(s), ${lostDisputes} lost`);
  add(
    'verification',
    (agent.kyb_status === 'verified' ? 10 : 0) + Math.min(5, (agent.kyc_tier ?? 0) * 2),
    `KYC tier ${agent.kyc_tier ?? 0}${agent.kyb_status === 'verified' ? ', business verified' : ''}`,
  );
  add('float_discipline', Math.max(0, 5 - lowFloatDays), `${lowFloatDays} low-float day(s) in the last 90`);
  add('compliance', cases ? -20 : 0, cases ? `${cases} open compliance case(s)` : 'no open compliance cases');
  const score = Math.max(
    0,
    Math.min(
      100,
      Object.values(factors).reduce((a, f) => a + f.points, 0),
    ),
  );
  const band = bandForTrust(score, tenureDays, s.minTenureDays);
  const bonus = s.bonusByBand[band] ?? 0;
  const view: TrustScore = { agentId, score, band, factors, commissionBonusBps: bonus, computedAt: now() };
  if (persist) {
    db.prepare('INSERT INTO agent_scores (id, agent_user_id, score, band, factors, commission_bonus_bps, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      `as_${shortCode(12).toLowerCase()}`,
      agentId,
      score,
      band,
      JSON.stringify(factors),
      bonus,
      now(),
    );
    updateUser(agentId, { trust_score: score } as any);
  }
  return view;
}
export function latestTrustScore(agentId: string): TrustScore | null {
  const r = getDb().prepare('SELECT * FROM agent_scores WHERE agent_user_id = ? ORDER BY computed_at DESC LIMIT 1').get(agentId) as any;
  return r ? { agentId, score: r.score, band: r.band, factors: parseJson(r.factors, {}), commissionBonusBps: r.commission_bonus_bps, computedAt: r.computed_at } : null;
}
export function runTrustScores(): { scored: number } {
  let scored = 0;
  for (const a of getDb().prepare("SELECT id FROM users WHERE role = 'agent' AND status = 'active'").all() as { id: string }[]) {
    computeTrustScore(a.id, true);
    scored += 1;
  }
  return { scored };
}

/** Dynamic commission: base (per agent or platform) + trust-band bonus + liquidity bonus for cash-in where float is short. */
export function dynamicCommissionBps(
  agent: UserRow,
  kind: 'cash_in' | 'cash_out' | 'other' = 'other',
  /** Operation on the tariff grid; its agent commission applies when the agent has no contractual override. */
  feeType?: string | null,
): { bps: number; base: number; trustBonus: number; liquidityBonus: number; band: TrustBand | null } {
  const tariff = feeType ? resolveFeeRule(feeType, { userId: agent.id })?.rule.agentBps : undefined;
  const base = agent.agent_commission_bps ?? tariff ?? getAppSettings().agentCommissionBps;
  const s = getAgentIntelSettings();
  const trust = latestTrustScore(agent.id);
  const trustBonus = trust ? (s.bonusByBand[trust.band] ?? 0) : 0;
  let liquidityBonus = 0;
  if (kind === 'cash_in' && s.liquidityBonusBps) {
    const short = floatForecast(agent.id).some((f) => f.status === 'low' || f.status === 'critical');
    if (short) liquidityBonus = s.liquidityBonusBps;
  }
  return { bps: base + trustBonus + liquidityBonus, base, trustBonus, liquidityBonus, band: trust?.band ?? null };
}

// ---------------------------------------------------------------------------------------------------------------------
// Float replenishment requests → e-money maker-checker
// ---------------------------------------------------------------------------------------------------------------------
export interface FloatRequest {
  id: string;
  agentId: string;
  currency: string;
  amountMinor: number;
  method: string;
  reference: string | null;
  note: string | null;
  status: 'REQUESTED' | 'PROPOSED' | 'FULFILLED' | 'REJECTED' | 'CANCELLED';
  verificationId: string | null;
  handledBy: string | null;
  handledAt: string | null;
  createdAt: string;
}
const toFloat = (r: any): FloatRequest => ({
  id: r.id,
  agentId: r.agent_user_id,
  currency: r.currency,
  amountMinor: r.amount_minor,
  method: r.method,
  reference: r.reference,
  note: r.note,
  status: r.status,
  verificationId: r.verification_id,
  handledBy: r.handled_by,
  handledAt: r.handled_at,
  createdAt: r.created_at,
});
export function requestFloat(
  agent: UserRow,
  input: { currency: string; amountMinor: number; method: 'cash_deposit' | 'bank_transfer' | 'mobile_money'; reference?: string | null; note?: string | null },
): FloatRequest {
  if (agent.role !== 'agent') throw forbidden('Only agents request float', 'role_required');
  const cur = getCurrency(input.currency);
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) throw badRequest('Amount must be positive', 'invalid_amount');
  const db = getDb();
  if (db.prepare("SELECT 1 FROM float_requests WHERE agent_user_id = ? AND currency = ? AND status IN ('REQUESTED', 'PROPOSED')").get(agent.id, cur.code))
    throw conflict('A float request in this currency is already open', 'float_request_open');
  const id = `fr_${shortCode(12).toLowerCase()}`;
  db.prepare('INSERT INTO float_requests (id, agent_user_id, currency, amount_minor, method, reference, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    agent.id,
    cur.code,
    input.amountMinor,
    input.method,
    input.reference ?? null,
    input.note ?? null,
    'REQUESTED',
    now(),
  );
  recordEvent('liquidity', id, 'float_request.created', { type: 'agent', id: agent.id }, { currency: cur.code, amount: input.amountMinor, method: input.method });
  for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin' AND is_system = 0 AND status = 'active'").all() as { id: string }[])
    notify(
      a.id,
      'Agent float request',
      `${agent.business_name || agent.full_name} asks for ${formatMoney(input.amountMinor, cur)} of float (${input.method.replace('_', ' ')}${input.reference ? `, ref ${input.reference}` : ''}).`,
      { kind: 'approval', floatRequestId: id },
    );
  return toFloat(db.prepare('SELECT * FROM float_requests WHERE id = ?').get(id));
}
export function listFloatRequests(filter: { agentId?: string | null; status?: string | null; limit?: number } = {}): FloatRequest[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.agentId) {
    where.push('agent_user_id = ?');
    params.push(filter.agentId);
  }
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  return (
    getDb()
      .prepare(`SELECT * FROM float_requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, Math.min(500, filter.limit ?? 100)) as any[]
  ).map(toFloat);
}
export function getFloatRequest(id: string): FloatRequest {
  const r = getDb().prepare('SELECT * FROM float_requests WHERE id = ?').get(id);
  if (!r) throw notFound('Float request not found', 'float_request_not_found');
  return toFloat(r);
}
/** The administrator confirms the cash / transfer was received: the credit goes through the e-money maker-checker (a different admin approves). */
export function fulfilFloatRequest(id: string, admin: UserRow, note: string): FloatRequest {
  const r = getFloatRequest(id);
  if (r.status !== 'REQUESTED') throw conflict(`Float request is ${r.status}`, 'float_request_closed');
  const verification = proposeVerification(admin, r.agentId, {
    subjectType: 'issuance',
    action: 'confirm',
    note,
    payload: { direction: 'credit', amount: r.amountMinor, currency: r.currency, reason: `Agent float replenishment ${id} (${r.method}${r.reference ? ` ${r.reference}` : ''}): ${note}` },
  });
  getDb()
    .prepare('UPDATE float_requests SET status = ?, verification_id = ?, handled_by = ?, handled_at = ? WHERE id = ?')
    .run(verification.status === 'approved' ? 'FULFILLED' : 'PROPOSED', verification.id, admin.id, now(), id);
  recordEvent('liquidity', id, 'float_request.proposed', { type: 'admin', id: admin.id }, { verificationId: verification.id });
  return getFloatRequest(id);
}
/** Called when an issuance verification is approved or declined so the request mirrors the outcome. */
export function onIssuanceVerification(verificationId: string, outcome: 'approved' | 'declined'): void {
  const db = getDb();
  const r = db.prepare('SELECT id, agent_user_id FROM float_requests WHERE verification_id = ?').get(verificationId) as any;
  if (!r) return;
  db.prepare('UPDATE float_requests SET status = ? WHERE id = ?').run(outcome === 'approved' ? 'FULFILLED' : 'REJECTED', r.id);
  notify(
    r.agent_user_id,
    outcome === 'approved' ? 'Float credited' : 'Float request declined',
    outcome === 'approved' ? 'Your float replenishment was credited to your wallet.' : 'Your float request was declined; contact operations.',
    { kind: 'wallet' },
  );
}
export function rejectFloatRequest(id: string, admin: UserRow, reason: string): FloatRequest {
  const r = getFloatRequest(id);
  if (r.status !== 'REQUESTED') throw conflict(`Float request is ${r.status}`, 'float_request_closed');
  getDb().prepare("UPDATE float_requests SET status = 'REJECTED', handled_by = ?, handled_at = ?, note = COALESCE(note, '') || ' | rejected: ' || ? WHERE id = ?").run(admin.id, now(), reason, id);
  recordEvent('liquidity', id, 'float_request.rejected', { type: 'admin', id: admin.id }, { reason });
  notify(r.agentId, 'Float request declined', reason, { kind: 'wallet' });
  return getFloatRequest(id);
}

// ---------------------------------------------------------------------------------------------------------------------
// Agent-assisted onboarding: a Tier 1 account with a temporary PIN, in minutes, with the onboarding commission
// ---------------------------------------------------------------------------------------------------------------------
export function onboardCustomer(
  agent: UserRow,
  input: { fullName: string; phone: string; country: string; idPhoto?: string | null; livePhoto?: string | null; address?: string | null },
): { user: ReturnType<typeof toPublicUser>; tag: string; temporaryPin: string; tier: number; commission: number } {
  if (agent.role !== 'agent') throw forbidden('Only agents onboard customers', 'role_required');
  const user = createUser({ fullName: input.fullName, phone: input.phone, country: input.country.toUpperCase(), role: 'user', phoneVerified: true });
  const pin = String(1000 + randomInt(9000));
  updateUser(user.id, { pin_hash: hashPassword(pin) });
  const tiered = setTier(user.id, 1, { type: 'agent', id: agent.id }, `agent-assisted onboarding by ${agent.id}`);
  const db = getDb();
  db.prepare(
    'INSERT INTO kyc_submissions (id, user_id, doc_type, doc_number, full_name, dob, address, doc_front, doc_back, selfie, status, note, created_at, requested_tier, liveness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    uuid(),
    user.id,
    'agent_onboarding',
    `agent:${agent.id}`,
    input.fullName,
    null,
    input.address ?? null,
    input.idPhoto ?? null,
    null,
    input.livePhoto ?? null,
    'pending',
    `Captured by agent @${agent.tag}; review for Tier 2`,
    now(),
    2,
    input.livePhoto ? 1 : 0,
  );
  const cur = getCurrency(config.baseCurrency, false);
  const commission = getAgentIntelSettings().onboardingCommissionMinor;
  if (commission > 0) {
    ensureWallet(agent.id, cur.code);
    recordCommission({ agentUserId: agent.id, transactionId: null, kind: 'onboarding', amountMinor: commission, currency: cur.code, status: 'ACCRUED', metadata: { customerId: user.id } });
  }
  recordEvent('auth', user.id, 'user.onboarded_by_agent', { type: 'agent', id: agent.id }, { tier: 1, commission });
  notify(user.id, 'Welcome to BitriPay', `Your account @${tiered.tag} is ready. Your temporary PIN is ${pin}; change it in Security. Tier 1 limits apply until you complete verification.`, {
    kind: 'kyc',
  });
  return { user: toPublicUser(tiered), tag: tiered.tag, temporaryPin: pin, tier: 1, commission };
}

const HOOK = Symbol.for('bitripay.floatRequests.hook');
if (!(globalThis as any)[HOOK]) {
  (globalThis as any)[HOOK] = true;
  verificationOutcomeHooks.push((id, subjectType, outcome) => {
    if (subjectType === 'issuance') onIssuanceVerification(id, outcome);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Float intelligence (specification §59): what the next hours will ask of the agent's digital and cash floats, how
// likely either runs dry, and what to do about it. The model is the agent's own eight weeks of cash-in / cash-out
// bucketed by weekday and hour: the expected demand for the coming hours is the sum of the bucket means, its spread
// the sum of the bucket variances (normal approximation), corrected by pending cash-out requests, cash pickups waiting
// in the agent's currency and what the other agents of the same country are doing right now. HIGH risk never moves
// money on its own: it recommends a rebalance and notifies.
// ---------------------------------------------------------------------------------------------------------------------
export type FloatRisk = 'LOW' | 'MEDIUM' | 'HIGH';
export type FloatAction = 'hold' | 'rebalance' | 'deposit_cash' | 'collect_cash';
export interface FloatOutlook {
  agentId: string;
  currency: string;
  /** Physical cash on hand (declared + movements since the declaration; estimated from the ledger when never declared). */
  cashFloatMinor: number;
  cashFloatSource: 'declared' | 'estimated';
  /** E-money in the agent wallet. */
  digitalFloatMinor: number;
  predicted4hDigitalMinor: number;
  predicted4hCashMinor: number;
  /** Probability that the digital float is exhausted within the outlook window. */
  depletionProbability: number;
  cashDepletionProbability: number;
  risk: FloatRisk;
  recommendedAction: FloatAction;
  recommendedAmountMinor: number;
  demand: {
    hours: number;
    expectedCashInMinor: number;
    expectedCashOutMinor: number;
    stdCashInMinor: number;
    stdCashOutMinor: number;
    pendingCashOutRequestsMinor: number;
    pendingPickupsShareMinor: number;
    sameCountryDemandFactor: number;
    historyWeeks: number;
    samples: number;
  };
  computedAt: string;
}
const HISTORY_WEEKS = 8;
const bucketOf = (d: Date) => d.getUTCDay() * 24 + d.getUTCHours();
/** Standard normal CDF (Abramowitz–Stegun 7.1.26, error < 1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-x * x);
  return 0.5 * (1 + (z >= 0 ? erf : -erf));
}
/** Per-bucket mean and variance across the history weeks (weeks without activity in the bucket count as zero). */
function bucketStats(rows: { amount: number; created_at: string }[], weeks: number): Map<number, { mean: number; variance: number }> {
  const perBucketWeek = new Map<number, Map<number, number>>();
  for (const r of rows) {
    const d = new Date(r.created_at);
    const b = bucketOf(d);
    const week = Math.floor((Date.now() - d.getTime()) / (7 * 86_400_000));
    const byWeek = perBucketWeek.get(b) ?? perBucketWeek.set(b, new Map()).get(b)!;
    byWeek.set(week, (byWeek.get(week) ?? 0) + r.amount);
  }
  const stats = new Map<number, { mean: number; variance: number }>();
  for (const [b, byWeek] of perBucketWeek) {
    const samples = Array.from({ length: weeks }, (_, w) => byWeek.get(w) ?? 0);
    const mean = samples.reduce((a, x) => a + x, 0) / weeks;
    const variance = samples.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, weeks - 1);
    stats.set(b, { mean, variance });
  }
  return stats;
}
function windowDemand(stats: Map<number, { mean: number; variance: number }>, hours: number): { mean: number; variance: number } {
  let mean = 0;
  let variance = 0;
  for (let h = 0; h < hours; h += 1) {
    const s = stats.get(bucketOf(new Date(Date.now() + h * 3_600_000)));
    if (!s) continue;
    mean += s.mean;
    variance += s.variance;
  }
  return { mean, variance };
}
/** The agent counted the cash in the drawer: from here on the cash float is declared + ledger movements. */
export function declareCash(agent: UserRow, input: { currency: string; amountMinor: number }): { currency: string; amountMinor: number; declaredAt: string } {
  if (agent.role !== 'agent') throw forbidden('Only agents declare cash', 'role_required');
  const cur = getCurrency(input.currency);
  if (!Number.isInteger(input.amountMinor) || input.amountMinor < 0) throw badRequest('Cash amount must be a non-negative integer in minor units', 'invalid_amount');
  const declaredAt = now();
  getDb()
    .prepare('INSERT INTO agent_cash_declarations (id, agent_user_id, currency, amount_minor, declared_at) VALUES (?, ?, ?, ?, ?)')
    .run(`acd_${shortCode(12).toLowerCase()}`, agent.id, cur.code, input.amountMinor, declaredAt);
  recordEvent('liquidity', agent.id, 'agent.cash_declared', { type: 'agent', id: agent.id }, { currency: cur.code, amount: input.amountMinor });
  return { currency: cur.code, amountMinor: input.amountMinor, declaredAt };
}
function cashFloat(db: ReturnType<typeof getDb>, agentId: string, currency: string, historySince: string): { amount: number; source: 'declared' | 'estimated' } {
  const decl = db.prepare('SELECT amount_minor, declared_at FROM agent_cash_declarations WHERE agent_user_id = ? AND currency = ? ORDER BY declared_at DESC LIMIT 1').get(agentId, currency) as
    { amount_minor: number; declared_at: string } | undefined;
  const since = decl?.declared_at ?? historySince;
  const inn = (
    db
      .prepare("SELECT COALESCE(SUM(amount), 0) s FROM transactions WHERE sender_user_id = ? AND currency = ? AND type = 'agent_cash_in' AND status = 'completed' AND created_at >= ?")
      .get(agentId, currency, since) as any
  ).s as number;
  const out = (
    db
      .prepare("SELECT COALESCE(SUM(amount), 0) s FROM transactions WHERE receiver_user_id = ? AND currency = ? AND type = 'agent_cash_out' AND status = 'completed' AND created_at >= ?")
      .get(agentId, currency, since) as any
  ).s as number;
  const pickups = (
    db
      .prepare("SELECT COALESCE(SUM(target_amount), 0) s FROM remittances WHERE pickup_agent_id = ? AND target_currency = ? AND status = 'completed' AND completed_at >= ?")
      .get(agentId, currency, since) as any
  ).s as number;
  const amount = (decl?.amount_minor ?? 0) + inn - out - pickups;
  return { amount: decl ? amount : Math.max(0, amount), source: decl ? 'declared' : 'estimated' };
}
export function floatOutlook(agentId: string, currency?: string | null): FloatOutlook[] {
  const db = getDb();
  const s = getAgentIntelSettings();
  const agent = findUserById(agentId);
  if (!agent || agent.role !== 'agent') throw notFound('Agent not found', 'agent_not_found');
  const hours = Math.max(1, Math.min(24, s.outlookHours));
  const historySince = new Date(Date.now() - HISTORY_WEEKS * 7 * 86_400_000).toISOString();
  const wallets = listWallets(agentId).filter((w) => !currency || w.currency === currency.toUpperCase());
  const activeAgentsHere = Math.max(1, (db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'agent' AND status = 'active' AND country IS ?").get(agent.country ?? null) as any).c as number);
  return wallets.map((w) => {
    const cashIns = db
      .prepare("SELECT amount, created_at FROM transactions WHERE sender_user_id = ? AND currency = ? AND type = 'agent_cash_in' AND status = 'completed' AND created_at >= ?")
      .all(agentId, w.currency, historySince) as {
      amount: number;
      created_at: string;
    }[];
    const cashOuts = db
      .prepare("SELECT amount, created_at FROM transactions WHERE receiver_user_id = ? AND currency = ? AND type = 'agent_cash_out' AND status = 'completed' AND created_at >= ?")
      .all(agentId, w.currency, historySince) as {
      amount: number;
      created_at: string;
    }[];
    const inDemand = windowDemand(bucketStats(cashIns, HISTORY_WEEKS), hours);
    const outDemand = windowDemand(bucketStats(cashOuts, HISTORY_WEEKS), hours);
    // What the same country's agents did in the last `hours` against what their history says for those buckets: a
    // busy market day lifts every agent's expected cash-in (bounded to 0.5×–2×).
    const peerRows = db
      .prepare(
        "SELECT t.amount, t.created_at FROM transactions t JOIN users u ON u.id = t.sender_user_id WHERE u.role = 'agent' AND u.country IS ? AND t.currency = ? AND t.type = 'agent_cash_in' AND t.status = 'completed' AND t.created_at >= ?",
      )
      .all(agent.country ?? null, w.currency, historySince) as { amount: number; created_at: string }[];
    const recentSince = Date.now() - hours * 3_600_000;
    const peerRecent = peerRows.filter((r) => Date.parse(r.created_at) >= recentSince).reduce((a, r) => a + r.amount, 0);
    let peerExpected = 0;
    const peerStats = bucketStats(peerRows, HISTORY_WEEKS);
    for (let h = 1; h <= hours; h += 1) peerExpected += peerStats.get(bucketOf(new Date(Date.now() - h * 3_600_000)))?.mean ?? 0;
    const demandFactor = peerExpected > 0 ? Math.max(0.5, Math.min(2, peerRecent / peerExpected)) : 1;
    const pendingCashOut = (
      db
        .prepare("SELECT COALESCE(SUM(amount), 0) s FROM cash_requests WHERE agent_id = ? AND currency = ? AND kind = 'cash_out' AND status = 'pending' AND expires_at > ?")
        .get(agentId, w.currency, now()) as any
    ).s as number;
    const pendingPickups = (
      db.prepare("SELECT COALESCE(SUM(target_amount), 0) s FROM remittances WHERE target_currency = ? AND status = 'ready_for_pickup' AND payout_method = 'cash_pickup'").get(w.currency) as any
    ).s as number;
    const pickupShare = Math.round(pendingPickups / activeAgentsHere);
    const expectedIn = Math.round(inDemand.mean * demandFactor);
    const expectedOut = Math.round(outDemand.mean) + pendingCashOut;
    const stdIn = Math.sqrt(inDemand.variance) * demandFactor;
    const stdOut = Math.sqrt(outDemand.variance);
    const cash = cashFloat(db, agentId, w.currency, historySince);
    // digital: cash-in debits it, cash-out and pickups (paid from the treasury after the handover) credit it
    const digitalNet = expectedIn - expectedOut - pickupShare;
    const digitalStd = Math.sqrt(stdIn ** 2 + stdOut ** 2);
    const depletion = digitalStd > 0 ? 1 - normalCdf((w.balance - digitalNet) / digitalStd) : digitalNet > w.balance ? 1 : 0;
    // cash: cash-in fills the drawer, cash-out and pickups empty it
    const cashNet = expectedOut + pickupShare - expectedIn;
    const cashDepletion = digitalStd > 0 ? 1 - normalCdf((cash.amount - cashNet) / digitalStd) : cashNet > cash.amount ? 1 : 0;
    const p = Math.round(depletion * 1000) / 1000;
    const pc = Math.round(cashDepletion * 1000) / 1000;
    const worst = Math.max(p, pc);
    const risk: FloatRisk = worst >= s.depletionHighProbability ? 'HIGH' : worst >= s.depletionMediumProbability ? 'MEDIUM' : 'LOW';
    // enough to cover demand at the 90th percentile of the window
    const digitalNeed = Math.max(0, Math.round(digitalNet + 1.2816 * digitalStd - w.balance));
    const cashNeed = Math.max(0, Math.round(cashNet + 1.2816 * digitalStd - cash.amount));
    let action: FloatAction = 'hold';
    let amount = 0;
    if (risk !== 'LOW') {
      if (p >= pc) {
        action = 'rebalance';
        amount = digitalNeed;
      } else {
        action = 'collect_cash';
        amount = cashNeed;
      }
    } else if (cash.amount > 0 && cash.amount > 3 * Math.max(expectedOut + pickupShare, 1) && cash.amount > w.balance) {
      action = 'deposit_cash';
      amount = cash.amount - Math.round(expectedOut + pickupShare + 1.2816 * digitalStd);
    }
    return {
      agentId,
      currency: w.currency,
      cashFloatMinor: cash.amount,
      cashFloatSource: cash.source,
      digitalFloatMinor: w.balance,
      predicted4hDigitalMinor: Math.round(w.balance - digitalNet),
      predicted4hCashMinor: Math.round(cash.amount - cashNet),
      depletionProbability: p,
      cashDepletionProbability: pc,
      risk,
      recommendedAction: action,
      recommendedAmountMinor: Math.max(0, amount),
      demand: {
        hours,
        expectedCashInMinor: expectedIn,
        expectedCashOutMinor: expectedOut,
        stdCashInMinor: Math.round(stdIn),
        stdCashOutMinor: Math.round(stdOut),
        pendingCashOutRequestsMinor: pendingCashOut,
        pendingPickupsShareMinor: pickupShare,
        sameCountryDemandFactor: Math.round(demandFactor * 100) / 100,
        historyWeeks: HISTORY_WEEKS,
        samples: cashIns.length + cashOuts.length,
      },
      computedAt: now(),
    };
  });
}
/** Hourly: agents whose outlook is HIGH are told what to do (once per agent, currency and hour); nothing moves by itself. */
export function runFloatOutlookAlerts(): { alerted: number } {
  const db = getDb();
  let alerted = 0;
  for (const a of db.prepare("SELECT id FROM users WHERE role = 'agent' AND status = 'active'").all() as { id: string }[]) {
    for (const o of floatOutlook(a.id)) {
      if (o.risk !== 'HIGH') continue;
      const cur = getCurrency(o.currency, false);
      const key = `outlook:${a.id}:${o.currency}:${now().slice(0, 13)}`;
      if (db.prepare("SELECT 1 FROM event_log WHERE stream = 'liquidity' AND subject_id = ? LIMIT 1").get(key)) continue;
      const details = {
        agentId: a.id,
        currency: o.currency,
        balance: o.digitalFloatMinor,
        cash: o.cashFloatMinor,
        depletionProbability: o.depletionProbability,
        action: o.recommendedAction,
        amount: o.recommendedAmountMinor,
        status: 'outlook_high',
      };
      recordEvent('liquidity', key, 'agent.float_outlook_high', { type: 'system' }, details);
      publish('agent.float_low', details, { aggregateId: a.id });
      notify(
        a.id,
        'Float depletion likely',
        o.recommendedAction === 'rebalance'
          ? `Your ${o.currency} float of ${formatMoney(o.digitalFloatMinor, cur)} is likely to run out within ${o.demand.hours} hours (${Math.round(o.depletionProbability * 100)}%). Request ${formatMoney(o.recommendedAmountMinor, cur)} of float now.`
          : `Your ${o.currency} cash of ${formatMoney(o.cashFloatMinor, cur)} is likely to run out within ${o.demand.hours} hours (${Math.round(o.cashDepletionProbability * 100)}%). Collect about ${formatMoney(o.recommendedAmountMinor, cur)} in cash.`,
        { kind: 'wallet', loud: true, action: o.recommendedAction },
      );
      alerted += 1;
    }
  }
  return { alerted };
}

// ---------------------------------------------------------------------------------------------------------------------
// Trust-scaled cash-operation limits: per-transaction and daily ceilings (base currency) = base × band multiplier.
// ---------------------------------------------------------------------------------------------------------------------
export interface AgentLimits {
  agentId: string;
  band: TrustBand;
  multiplier: number;
  currency: string;
  perTransactionMinor: number;
  dailyMinor: number;
  usedTodayMinor: number;
}
export function agentLimitsFor(agent: UserRow): AgentLimits {
  const s = getAgentIntelSettings();
  const band: TrustBand = latestTrustScore(agent.id)?.band ?? (agent.role === 'agent' ? computeTrustScore(agent.id, false).band : 'new');
  const multiplier = s.limitMultiplierByBand[band] ?? 1;
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const rows = getDb()
    .prepare(
      "SELECT amount, currency FROM transactions WHERE ((sender_user_id = ? AND type = 'agent_cash_in') OR (receiver_user_id = ? AND type = 'agent_cash_out')) AND status IN ('pending', 'completed') AND created_at >= ?",
    )
    .all(agent.id, agent.id, since) as { amount: number; currency: string }[];
  const used = rows.reduce((a, r) => a + toBase(r.amount, r.currency), 0);
  return {
    agentId: agent.id,
    band,
    multiplier,
    currency: getBaseCurrency().code,
    perTransactionMinor: Math.round(s.limitBaseMinor.perTransaction * multiplier),
    dailyMinor: Math.round(s.limitBaseMinor.daily * multiplier),
    usedTodayMinor: used,
  };
}
/** Refuse a cash operation above the agent's trust-scaled ceilings (called by agentCashIn and confirmCashOut). */
export function enforceAgentLimits(agent: UserRow, amountMinor: number, currency: string): AgentLimits {
  const limits = agentLimitsFor(agent);
  const base = toBase(amountMinor, currency);
  if (base > limits.perTransactionMinor)
    throw unprocessable(`This cash operation exceeds your per-transaction ceiling for the ${limits.band} trust band`, 'agent_limit_exceeded', {
      limit: limits.perTransactionMinor,
      amount: base,
      band: limits.band,
      scope: 'per_transaction',
    });
  if (limits.usedTodayMinor + base > limits.dailyMinor)
    throw unprocessable(`This cash operation would exceed your daily ceiling for the ${limits.band} trust band`, 'agent_limit_exceeded', {
      limit: limits.dailyMinor,
      used: limits.usedTodayMinor,
      amount: base,
      band: limits.band,
      scope: 'daily',
    });
  return limits;
}
