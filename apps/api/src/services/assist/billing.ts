/**
 * Per-use metering for the command centres, built to be lawful and profitable at the same time:
 *  - prices are disclosed once (consent, versioned) and shown on every question; nothing is ever taken silently;
 *  - a run is charged from the wallet only when it completes, only when the balance covers it, as a normal ledger
 *    posting ("Agent question · Analyst") that appears on receipts and statements with its tax share recorded;
 *  - lookups the offline planner can answer cost nothing; cheap questions go to the fast model; deep runs on the main
 *    model are priced higher and limited to the roles configured;
 *  - a small monthly allowance of free questions rewards accounts that moved money (the real revenue);
 *  - caps stop the model bill from outrunning fee income: per-run token budget, per-account daily cap, and a
 *    platform-wide monthly cap set as a share of last month's net fee revenue (with a floor). Past the cap every run
 *    degrades to the free offline planner instead of spending.
 */
import { getDb } from '../../db';
import { now } from '../../lib/ids';
import { parseJson } from '../../lib/json';
import { AppError } from '../../lib/errors';
import { formatMoney } from '@bitripay/shared';
import type { UserRow } from '../users';
import { getSystemUser } from '../users';
import { listWallets, ensureWallet, type WalletRow } from '../wallets';
import { postTransaction } from '../ledger';
import { convert, getCurrency } from '../currencies';
import { getAssistSettings } from '../settings';
import { recordEvent } from '../events';
import { hasActiveAddon } from './addon';
import { getAgentDef } from './registry';

export type Tier = 'free' | 'standard' | 'deep';
export interface BillingPlan {
  mode: 'per_use' | 'included' | 'subscription';
  tier: Tier;
  /** Wallet that will be charged (null when nothing is charged). */
  currency: string | null;
  amount: number;
  tax: number;
  /** Why the run is free: offline planner, allowance, subscription, admin, included, or degraded by the platform cap. */
  reason: 'charged' | 'offline' | 'lookup' | 'allowance' | 'subscription' | 'admin' | 'included' | 'degraded';
  model: string | null;
  charged: boolean;
  transactionId: string | null;
}

function priceOf(tier: Exclude<Tier, 'free'>, currency: string): { amount: number; tax: number } {
  const b = getAssistSettings().billing;
  let amount: number;
  try {
    amount = convert(b.prices[tier], b.priceCurrency, currency);
  } catch {
    amount = b.prices[tier];
  }
  amount = Math.max(1, Math.ceil(amount));
  // prices are tax-inclusive; the tax share is recorded for the books
  const tax = Math.round((amount * b.taxRateBps) / (10_000 + b.taxRateBps));
  return { amount, tax };
}
export function fmt(minor: number, code: string) {
  try {
    return formatMoney(minor, getCurrency(code, false));
  } catch {
    return `${minor} ${code}`;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------------------------------------------------

export function disclosureText(user: UserRow) {
  const b = getAssistSettings().billing;
  const wallets = listWallets(user.id);
  const code = wallets[0]?.currency ?? b.priceCurrency;
  const std = priceOf('standard', code);
  const deep = priceOf('deep', code);
  const canDeep = b.deepRoles.includes(user.role);
  return {
    version: b.disclosureVersion,
    currency: code,
    lines: [
      `Questions your agents can answer from your own records (balances, statements, recent activity) are free.`,
      `Other questions cost ${fmt(std.amount, code)} each${canDeep ? `; an in-depth analysis you ask for explicitly costs ${fmt(deep.amount, code)}` : ''}. Prices include tax where it applies.`,
      b.freeRunsPerMonth > 0 ? `You get ${b.freeRunsPerMonth} free questions a month${b.freeRunsRequireActivity ? ' in any month you move money' : ''}.` : `There is no free allowance beyond the free lookups.`,
      `The price is shown on the button before you ask. It is taken from your wallet only after the answer arrives, and only if your balance covers it. A question that fails costs nothing.`,
      `Every charge appears in your transactions and statements as "Agent question". You can stop using the agents at any time; nothing else in BitriPay changes.`,
      `No more than ${b.dailyCapPerUser} paid questions a day per account.`,
    ],
  };
}
export function hasConsent(user: UserRow): boolean {
  if (user.role === 'admin') return true;
  const b = getAssistSettings().billing;
  if (b.mode !== 'per_use') return true;
  return !!getDb().prepare('SELECT 1 FROM agent_consents WHERE user_id = ? AND version = ?').get(user.id, b.disclosureVersion);
}
export function acceptConsent(user: UserRow, version: number, ip?: string | null) {
  const b = getAssistSettings().billing;
  if (version !== b.disclosureVersion) throw new AppError(409, 'consent_version', 'The pricing text changed; please read the current version.');
  getDb().prepare('INSERT OR REPLACE INTO agent_consents (user_id, version, accepted_at, price_snapshot, ip) VALUES (?, ?, ?, ?, ?)').run(user.id, version, now(), JSON.stringify({ priceCurrency: b.priceCurrency, prices: b.prices, taxRateBps: b.taxRateBps, freeRunsPerMonth: b.freeRunsPerMonth }), ip ?? null);
  recordEvent('admin', user.id, 'assist.consent.accepted', { type: 'user', id: user.id }, { version });
  return { version, acceptedAt: now() };
}

// ---------------------------------------------------------------------------------------------------------------------
// Allowance and caps
// ---------------------------------------------------------------------------------------------------------------------

const monthStart = () => `${now().slice(0, 7)}-01T00:00:00.000Z`;
const dayStart = () => `${now().slice(0, 10)}T00:00:00.000Z`;

function movedMoneyThisMonth(userId: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM transactions WHERE status = 'completed' AND created_at >= ? AND (sender_user_id = ? OR receiver_user_id = ?) AND type NOT IN ('admin_adjustment', 'subscription', 'agent_usage', 'promo_credit') LIMIT 1").get(monthStart(), userId, userId);
}
export function freeRunsLeft(user: UserRow): number {
  const b = getAssistSettings().billing;
  if (!b.freeRunsPerMonth) return 0;
  if (b.freeRunsRequireActivity && !movedMoneyThisMonth(user.id)) return 0;
  const used = (getDb().prepare("SELECT COUNT(*) c FROM agent_runs WHERE user_id = ? AND created_at >= ? AND json_extract(billing, '$.reason') = 'allowance'").get(user.id, monthStart()) as any).c as number;
  return Math.max(0, b.freeRunsPerMonth - used);
}
export function paidRunsToday(userId: string): number {
  return (getDb().prepare("SELECT COUNT(*) c FROM agent_runs WHERE user_id = ? AND created_at >= ? AND json_extract(billing, '$.tier') != 'free'").get(userId, dayStart()) as any).c as number;
}

/** Last month's net fee revenue in the price currency, from completed transaction fees. */
export function lastMonthFeeRevenue(): { currency: string; amount: number } {
  const b = getAssistSettings().billing;
  const d = new Date();
  const from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString();
  const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
  const rows = getDb().prepare("SELECT currency, COALESCE(SUM(fee), 0) fees FROM transactions WHERE status = 'completed' AND created_at >= ? AND created_at < ? AND type NOT IN ('subscription', 'agent_usage') GROUP BY currency").all(from, to) as { currency: string; fees: number }[];
  let total = 0;
  for (const r of rows) {
    try {
      total += convert(r.fees, r.currency, b.priceCurrency);
    } catch {
      /* unknown currency */
    }
  }
  return { currency: b.priceCurrency, amount: Math.round(total) };
}
/** Model spend this month (micro-USD from the runs table) in the price currency. */
export function monthModelSpend(): { currency: string; amount: number; usdMicros: number } {
  const b = getAssistSettings().billing;
  const micros = (getDb().prepare('SELECT COALESCE(SUM(cost_micros), 0) c FROM agent_runs WHERE created_at >= ?').get(monthStart()) as any).c as number;
  const usdMinor = Math.round(micros / 10_000);
  let amount = usdMinor;
  try {
    amount = convert(usdMinor, 'USD', b.priceCurrency);
  } catch {
    /* USD missing */
  }
  return { currency: b.priceCurrency, amount: Math.round(amount), usdMicros: micros };
}
export function platformCap() {
  const b = getAssistSettings().billing;
  const fees = lastMonthFeeRevenue();
  const cap = Math.max(b.platformCapFloorMinor, Math.round((fees.amount * b.platformCapPctOfFees) / 100));
  const spend = monthModelSpend();
  return { currency: b.priceCurrency, cap, spend: spend.amount, degraded: spend.amount >= cap, pctOfFees: b.platformCapPctOfFees, lastMonthFees: fees.amount, floor: b.platformCapFloorMinor };
}

// ---------------------------------------------------------------------------------------------------------------------
// Plan (before the run) and settle (after it)
// ---------------------------------------------------------------------------------------------------------------------

export interface PlanInput {
  user: UserRow;
  agentKey: string;
  input: string;
  depth?: 'standard' | 'deep' | null;
  /** A model key is configured (or live is simulated), so the run can leave the offline planner. */
  liveAvailable: boolean;
  /** The offline planner can answer this from the account's own records: always free, even when a model is available. */
  lookup: boolean;
  trigger: string;
  preferredCurrency?: string | null;
}
/** Decide the tier, model and price of a run before it starts; throws when the account holder cannot proceed. */
export function planRun(p: PlanInput): BillingPlan & { degradedReason?: string } {
  const s = getAssistSettings();
  const b = s.billing;
  const base: BillingPlan = { mode: b.mode, tier: 'free', currency: null, amount: 0, tax: 0, reason: 'offline', model: null, charged: false, transactionId: null };
  const wantsDeep = p.depth === 'deep' && b.deepRoles.includes(p.user.role);
  const liveTier: Exclude<Tier, 'free'> = wantsDeep ? 'deep' : 'standard';
  const liveModel = wantsDeep ? s.model : s.fastModel || s.model;
  if (p.trigger === 'schedule' || p.user.role === 'admin') return p.liveAvailable ? { ...base, tier: liveTier, model: liveModel, reason: 'admin' } : { ...base, reason: 'admin' };
  if (b.mode === 'included') return p.liveAvailable ? { ...base, tier: liveTier, model: liveModel, reason: 'included' } : { ...base, reason: 'included' };
  if (hasActiveAddon(p.user) && s.addon.enabled) return p.liveAvailable ? { ...base, tier: liveTier, model: liveModel, reason: 'subscription' } : { ...base, reason: 'subscription' };
  if (b.mode === 'subscription') throw new AppError(402, 'addon_required', 'Activate the flat plan to use your agents.');
  if (!p.liveAvailable) return base;
  // an explicit in-depth request is what the account holder asked for; only plain questions get the free lookup path
  if (p.lookup && !wantsDeep) return { ...base, reason: 'lookup' };
  if (!hasConsent(p.user)) throw new AppError(402, 'consent_required', 'Please read and accept how questions are priced before your first one.');
  // the platform cap degrades everyone to the free planner rather than spending past fee income
  const cap = platformCap();
  if (cap.degraded) return { ...base, reason: 'degraded', degradedReason: 'Agents are answering from built-in checks for now; paid answers resume next month.' };
  if (paidRunsToday(p.user.id) >= b.dailyCapPerUser) throw new AppError(429, 'daily_cap', `You have used today's ${b.dailyCapPerUser} paid questions. Free lookups still work; more tomorrow.`);
  if (liveTier === 'standard' && freeRunsLeft(p.user) > 0) return { ...base, tier: 'standard', model: liveModel, reason: 'allowance' };
  // choose the wallet: preferred currency if it covers the price, else the first wallet that does
  const wallets = listWallets(p.user.id).filter((w) => !w.frozen_at);
  const preferred = p.preferredCurrency?.toUpperCase() ?? null;
  const candidates: WalletRow[] = [...(preferred ? wallets.filter((w) => w.currency === preferred) : []), ...wallets.sort((a, c) => c.balance - a.balance)];
  for (const w of candidates) {
    const price = priceOf(liveTier, w.currency);
    if (w.balance >= price.amount) return { ...base, tier: liveTier, model: liveModel, currency: w.currency, amount: price.amount, tax: price.tax, reason: 'charged' };
  }
  const first = wallets[0]?.currency ?? b.priceCurrency;
  const price = priceOf(liveTier, first);
  throw new AppError(402, 'insufficient_balance', `This question costs ${fmt(price.amount, first)} and your balance does not cover it. Free lookups still work; add money to ask more.`);
}

/** Charge a completed run according to its plan. Never throws: a failed charge is recorded on the run and the answer stays. */
export function settleRun(runId: string): BillingPlan | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId) as any;
  if (!row) return null;
  const plan = parseJson<BillingPlan | null>(row.billing, null);
  if (!plan) return null;
  if (plan.charged || plan.reason !== 'charged' || !plan.currency || plan.amount <= 0) return plan;
  if (!['completed', 'awaiting_approval'].includes(row.status)) {
    const skipped = { ...plan, charged: false, reason: plan.reason };
    db.prepare('UPDATE agent_runs SET billing = ? WHERE id = ?').run(JSON.stringify({ ...skipped, skipped: `not charged: run ${row.status}` }), runId);
    return skipped;
  }
  const agent = getAgentDef(row.agent_key);
  try {
    const wallet = listWallets(row.user_id).find((w) => w.currency === plan.currency);
    if (!wallet || wallet.balance < plan.amount) throw new Error('balance no longer covers the price');
    const fees = getSystemUser('fees');
    const tx = postTransaction({ type: 'agent_usage', amount: plan.amount, fee: 0, currency: plan.currency, fromWalletId: wallet.id, toWalletId: ensureWallet(fees.id, plan.currency).id, senderUserId: row.user_id, receiverUserId: fees.id, note: `Agent question · ${agent?.name ?? row.agent_key}`, metadata: { runId, agent: row.agent_key, tier: plan.tier, model: row.model, tax: plan.tax, net: plan.amount - plan.tax, costMicros: row.cost_micros }, idempotencyKey: `agent_usage:${runId}` });
    const settled = { ...plan, charged: true, transactionId: tx.id };
    db.prepare('UPDATE agent_runs SET billing = ? WHERE id = ?').run(JSON.stringify(settled), runId);
    recordEvent('ledger', runId, 'assist.run.charged', { type: 'system' }, { amount: plan.amount, currency: plan.currency, tier: plan.tier, transactionId: tx.id });
    return settled;
  } catch (e: any) {
    const unpaid = { ...plan, charged: false, skipped: `not charged: ${String(e?.message ?? e).slice(0, 120)}` };
    db.prepare('UPDATE agent_runs SET billing = ? WHERE id = ?').run(JSON.stringify(unpaid), runId);
    recordEvent('ledger', runId, 'assist.run.unpaid', { type: 'system' }, { amount: plan.amount, currency: plan.currency, reason: unpaid.skipped });
    return unpaid;
  }
}

/** What the apps show: mode, consent state, prices per wallet, allowance, caps. */
export function billingStatus(user: UserRow) {
  const s = getAssistSettings();
  const b = s.billing;
  const wallets = listWallets(user.id);
  const codes = wallets.length ? wallets.map((w) => w.currency) : [b.priceCurrency];
  const prices = codes.map((code) => {
    const std = priceOf('standard', code);
    const deep = priceOf('deep', code);
    return { currency: code, standard: std.amount, standardFormatted: fmt(std.amount, code), deep: deep.amount, deepFormatted: fmt(deep.amount, code), balance: wallets.find((w) => w.currency === code)?.balance ?? 0 };
  });
  const cap = platformCap();
  return { mode: b.mode, consentRequired: b.mode === 'per_use' && user.role !== 'admin' && !hasConsent(user), disclosure: disclosureText(user), prices, freeRunsPerMonth: b.freeRunsPerMonth, freeRunsLeft: user.role === 'admin' ? null : freeRunsLeft(user), dailyCap: b.dailyCapPerUser, paidToday: paidRunsToday(user.id), canDeep: b.deepRoles.includes(user.role), degraded: cap.degraded, subscriptionActive: s.addon.enabled && hasActiveAddon(user) && user.role !== 'admin', flatPlanAvailable: s.addon.enabled };
}

/** Margin report for the control centre: what agents earned, what they cost, and how far the cap is. */
export function billingReport() {
  const b = getAssistSettings().billing;
  const db = getDb();
  const revenueRows = db.prepare("SELECT currency, COUNT(*) c, COALESCE(SUM(amount), 0) total, COALESCE(SUM(json_extract(metadata, '$.tax')), 0) tax FROM transactions WHERE type = 'agent_usage' AND status = 'completed' AND created_at >= ? GROUP BY currency").all(monthStart()) as any[];
  let revenue = 0;
  let tax = 0;
  for (const r of revenueRows) {
    try {
      revenue += convert(r.total, r.currency, b.priceCurrency);
      tax += convert(r.tax, r.currency, b.priceCurrency);
    } catch {
      /* skip */
    }
  }
  const spend = monthModelSpend();
  const cap = platformCap();
  const runs = db.prepare("SELECT json_extract(billing, '$.reason') reason, COUNT(*) c FROM agent_runs WHERE created_at >= ? GROUP BY reason").all(monthStart()) as { reason: string | null; c: number }[];
  const consents = (db.prepare('SELECT COUNT(DISTINCT user_id) c FROM agent_consents').get() as any).c;
  return { month: now().slice(0, 7), currency: b.priceCurrency, revenue: Math.round(revenue), tax: Math.round(tax), netRevenue: Math.round(revenue - tax), modelCost: spend.amount, margin: Math.round(revenue - tax - spend.amount), cap, runsByReason: runs.map((r) => ({ reason: r.reason ?? 'unbilled', count: r.c })), consents, byCurrency: revenueRows };
}
