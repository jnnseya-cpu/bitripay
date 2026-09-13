/**
 * Savings automation (module 12) and wellbeing (§2.5). Goals are ring-fenced sub-balances: every contribution is a
 * hold of kind `savings` on the wallet, so the money never leaves the ledger, cannot be spent by accident, and is
 * released back the moment the account holder withdraws from the goal. The 10% anchor runs on every income event
 * for account holders who opted in (the anchor can be raised, never set below 10%); round-ups sweep the change of
 * every outgoing payment. The live-within-means monitor compares 30-day spend with income and, when it turns red,
 * the SavingsAdvisor produces a concrete rule-based plan.
 */
import { getDb } from '../db';
import { now, shortCode } from '../lib/ids';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { subscribe, type DomainEvent } from './bus';
import { createHold, releaseHold, listHolds } from './finops/holds';
import { getUserWallet, listWallets } from './wallets';
import { type UserRow } from './users';
import { recordEvent, type Actor } from './events';
import { notify } from './notifications';
import { getCurrency } from './currencies';
import { formatMoney } from '@bitripay/shared';

export const MIN_ANCHOR_BPS = 1000;
/** Transaction types that count as income for the anchor and the wellbeing monitor. */
export const INCOME_TYPES = new Set([
  'transfer',
  'qr_payment',
  'merchant_payment',
  'money_request',
  'card_deposit',
  'bank_deposit',
  'mobile_money_deposit',
  'agent_cash_in',
  'remittance',
  'refund',
  'distribution',
  'referral_reward',
  'payout',
]);
/** Administrative credits and e-money issuance are not earned income: they never trigger the anchor nor count in the monitor. */
export const NON_INCOME_TYPES = new Set(['admin_adjustment', 'emoney_mint', 'emoney_burn', 'exchange']);
export const SPEND_TYPES = new Set([
  'transfer',
  'qr_payment',
  'merchant_payment',
  'money_request',
  'withdrawal',
  'remittance',
  'virtual_card_funding',
  'gift_card',
  'bill_payment',
  'mobile_topup',
  'agent_cash_out',
  'subscription',
  'agent_usage',
  'verification',
]);

export interface SavingsSettings {
  userId: string;
  autoAnchor: boolean;
  anchorBps: number;
  roundUps: boolean;
  roundToMinor: number;
  defaultGoalId: string | null;
}
export interface SavingsGoal {
  id: string;
  userId: string;
  currency: string;
  name: string;
  targetMinor: number;
  savedMinor: number;
  deadline: string | null;
  status: 'ACTIVE' | 'REACHED' | 'CLOSED';
  progress: number;
  projection: { weeklyPaceMinor: number; weeksToTarget: number | null; onTrack: boolean | null };
  createdAt: string;
  updatedAt: string;
}
const toSettings = (r: any, userId: string): SavingsSettings => ({
  userId,
  autoAnchor: !!r?.auto_anchor,
  anchorBps: r?.anchor_bps ?? MIN_ANCHOR_BPS,
  roundUps: !!r?.round_ups,
  roundToMinor: r?.round_to_minor ?? 100,
  defaultGoalId: r?.default_goal_id ?? null,
});
function toGoal(r: any): SavingsGoal {
  const db = getDb();
  const since = new Date(Date.now() - 28 * 86_400_000).toISOString();
  const recent = (
    db.prepare("SELECT COALESCE(SUM(amount_minor), 0) s FROM savings_movements WHERE goal_id = ? AND kind IN ('anchor', 'round_up', 'manual') AND created_at >= ?").get(r.id, since) as any
  ).s as number;
  const weekly = Math.round(recent / 4);
  const remaining = Math.max(0, r.target_minor - r.saved_minor);
  const weeks = r.target_minor > 0 && remaining > 0 ? (weekly > 0 ? Math.ceil(remaining / weekly) : null) : 0;
  const onTrack = r.deadline && weeks !== null ? Date.now() + weeks * 7 * 86_400_000 <= Date.parse(r.deadline) : null;
  return {
    id: r.id,
    userId: r.user_id,
    currency: r.currency,
    name: r.name,
    targetMinor: r.target_minor,
    savedMinor: r.saved_minor,
    deadline: r.deadline,
    status: r.status,
    progress: r.target_minor > 0 ? Math.min(1, r.saved_minor / r.target_minor) : 0,
    projection: { weeklyPaceMinor: weekly, weeksToTarget: weeks, onTrack },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getSavingsSettings(userId: string): SavingsSettings {
  return toSettings(getDb().prepare('SELECT * FROM savings_settings WHERE user_id = ?').get(userId), userId);
}
export function updateSavingsSettings(user: UserRow, patch: Partial<Omit<SavingsSettings, 'userId'>>): SavingsSettings {
  const cur = getSavingsSettings(user.id);
  const next = { ...cur, ...patch };
  if (next.anchorBps < MIN_ANCHOR_BPS) throw badRequest(`The savings anchor never goes below ${MIN_ANCHOR_BPS / 100}% of income`, 'anchor_below_minimum');
  if (next.anchorBps > 5000) throw badRequest('The anchor is at most 50%', 'validation_error');
  if (next.defaultGoalId) getGoal(user.id, next.defaultGoalId);
  getDb()
    .prepare(
      'INSERT INTO savings_settings (user_id, auto_anchor, anchor_bps, round_ups, round_to_minor, default_goal_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET auto_anchor = excluded.auto_anchor, anchor_bps = excluded.anchor_bps, round_ups = excluded.round_ups, round_to_minor = excluded.round_to_minor, default_goal_id = excluded.default_goal_id, updated_at = excluded.updated_at',
    )
    .run(user.id, next.autoAnchor ? 1 : 0, next.anchorBps, next.roundUps ? 1 : 0, Math.max(1, next.roundToMinor), next.defaultGoalId, now());
  recordEvent('ledger', user.id, 'savings.settings', { type: 'user', id: user.id }, { autoAnchor: next.autoAnchor, anchorBps: next.anchorBps, roundUps: next.roundUps });
  return getSavingsSettings(user.id);
}
export function listGoals(userId: string): SavingsGoal[] {
  return (getDb().prepare("SELECT * FROM savings_goals WHERE user_id = ? AND status != 'CLOSED' ORDER BY created_at").all(userId) as any[]).map(toGoal);
}
export function getGoal(userId: string, id: string): SavingsGoal {
  const r = getDb().prepare('SELECT * FROM savings_goals WHERE id = ? AND user_id = ?').get(id, userId);
  if (!r) throw notFound('Savings goal not found', 'goal_not_found');
  return toGoal(r);
}
export function createGoal(user: UserRow, input: { name: string; currency: string; targetMinor?: number | null; deadline?: string | null; makeDefault?: boolean }): SavingsGoal {
  const cur = getCurrency(input.currency);
  const id = `sg_${shortCode(10).toLowerCase()}`;
  getDb()
    .prepare('INSERT INTO savings_goals (id, user_id, currency, name, target_minor, saved_minor, deadline, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)')
    .run(id, user.id, cur.code, input.name.trim(), Math.max(0, Math.round(input.targetMinor ?? 0)), input.deadline ?? null, 'ACTIVE', now(), now());
  const s = getSavingsSettings(user.id);
  if (input.makeDefault || !s.defaultGoalId) updateSavingsSettings(user, { defaultGoalId: id });
  recordEvent('ledger', id, 'savings.goal_created', { type: 'user', id: user.id }, { currency: cur.code, target: input.targetMinor ?? 0 });
  return getGoal(user.id, id);
}
/** Ring-fence money into a goal: a hold on the wallet; fails cleanly when the available balance is short. */
export function contribute(userId: string, goalId: string, amountMinor: number, kind: 'manual' | 'anchor' | 'round_up', actor: Actor, sourceTransactionId?: string | null): SavingsGoal {
  const g = getGoal(userId, goalId);
  if (g.status !== 'ACTIVE') throw conflict('Goal is closed', 'goal_closed');
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw badRequest('Amount must be a positive integer', 'invalid_amount');
  const wallet = getUserWallet(userId, g.currency);
  const held = listHolds({ walletId: wallet.id, status: 'ACTIVE', limit: 500 }).reduce((s, h) => s + h.amountMinor, 0);
  if (wallet.balance - held < amountMinor) throw unprocessable('Not enough available balance to set aside', 'insufficient_funds');
  const db = getDb();
  db.transaction(() => {
    const hold = createHold({ walletId: wallet.id, amountMinor, kind: 'savings', refType: 'savings_goal', refId: goalId, reason: `${kind} contribution to ${g.name}` }, actor);
    db.prepare('INSERT INTO savings_movements (id, goal_id, user_id, kind, amount_minor, hold_id, source_transaction_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      `sm_${shortCode(12).toLowerCase()}`,
      goalId,
      userId,
      kind,
      amountMinor,
      hold.id,
      sourceTransactionId ?? null,
      now(),
    );
    db.prepare(
      "UPDATE savings_goals SET saved_minor = saved_minor + ?, status = CASE WHEN target_minor > 0 AND saved_minor + ? >= target_minor THEN 'REACHED' ELSE status END, updated_at = ? WHERE id = ?",
    ).run(amountMinor, amountMinor, now(), goalId);
  })();
  const after = getGoal(userId, goalId);
  if (after.status === 'REACHED' && g.status === 'ACTIVE')
    notify(userId, 'Goal reached', `${g.name}: ${formatMoney(after.savedMinor, getCurrency(g.currency, false))} set aside. Well done.`, { kind: 'wallet', goalId });
  return after;
}
/** Release money from a goal back to the spendable balance (oldest contributions first). */
export function withdrawFromGoal(userId: string, goalId: string, amountMinor: number, actor: Actor): SavingsGoal {
  const g = getGoal(userId, goalId);
  if (!Number.isInteger(amountMinor) || amountMinor <= 0 || amountMinor > g.savedMinor) throw badRequest('Amount must be between 1 and the amount saved', 'invalid_amount');
  const db = getDb();
  let remaining = amountMinor;
  db.transaction(() => {
    const holds = db.prepare("SELECT h.id, h.amount_minor FROM holds h WHERE h.ref_type = 'savings_goal' AND h.ref_id = ? AND h.status = 'ACTIVE' ORDER BY h.created_at").all(goalId) as {
      id: string;
      amount_minor: number;
    }[];
    for (const h of holds) {
      if (remaining <= 0) break;
      releaseHold(h.id, actor, 'savings withdrawal');
      const take = Math.min(h.amount_minor, remaining);
      remaining -= take;
      if (h.amount_minor > take) {
        // the rest of this contribution stays ring-fenced
        const w = getUserWallet(userId, g.currency);
        createHold({ walletId: w.id, amountMinor: h.amount_minor - take, kind: 'savings', refType: 'savings_goal', refId: goalId, reason: 'remainder after withdrawal' }, actor);
      }
    }
    db.prepare('INSERT INTO savings_movements (id, goal_id, user_id, kind, amount_minor, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      `sm_${shortCode(12).toLowerCase()}`,
      goalId,
      userId,
      'withdrawal',
      -amountMinor,
      now(),
    );
    db.prepare(
      "UPDATE savings_goals SET saved_minor = saved_minor - ?, status = CASE WHEN status = 'REACHED' AND saved_minor - ? < target_minor THEN 'ACTIVE' ELSE status END, updated_at = ? WHERE id = ?",
    ).run(amountMinor, amountMinor, now(), goalId);
  })();
  return getGoal(userId, goalId);
}
export function closeGoal(userId: string, goalId: string, actor: Actor): SavingsGoal {
  const g = getGoal(userId, goalId);
  if (g.savedMinor > 0) withdrawFromGoal(userId, goalId, g.savedMinor, actor);
  getDb().prepare("UPDATE savings_goals SET status = 'CLOSED', updated_at = ? WHERE id = ?").run(now(), goalId);
  const s = getSavingsSettings(userId);
  if (s.defaultGoalId === goalId) getDb().prepare('UPDATE savings_settings SET default_goal_id = NULL WHERE user_id = ?').run(userId);
  return toGoal(getDb().prepare('SELECT * FROM savings_goals WHERE id = ?').get(goalId));
}
export function goalMovements(userId: string, goalId: string) {
  getGoal(userId, goalId);
  return (getDb().prepare('SELECT * FROM savings_movements WHERE goal_id = ? ORDER BY created_at DESC LIMIT 200').all(goalId) as any[]).map((m) => ({
    id: m.id,
    kind: m.kind,
    amountMinor: m.amount_minor,
    sourceTransactionId: m.source_transaction_id,
    createdAt: m.created_at,
  }));
}

/** Live-within-means: 30-day income against spend per currency, with a rule-based plan when it turns amber or red. */
export function wellbeing(userId: string) {
  const db = getDb();
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const rows = db
    .prepare("SELECT type, currency, amount, fee, sender_user_id, receiver_user_id FROM transactions WHERE (sender_user_id = ? OR receiver_user_id = ?) AND status = 'completed' AND created_at >= ?")
    .all(userId, userId, since) as any[];
  const perCur: Record<string, { income: number; spend: number; byType: Record<string, number> }> = {};
  for (const t of rows) {
    perCur[t.currency] ??= { income: 0, spend: 0, byType: {} };
    if (t.receiver_user_id === userId && t.sender_user_id !== userId && INCOME_TYPES.has(t.type)) perCur[t.currency].income += t.amount;
    if (t.sender_user_id === userId && t.receiver_user_id !== userId && SPEND_TYPES.has(t.type)) {
      perCur[t.currency].spend += t.amount + (t.fee ?? 0);
      perCur[t.currency].byType[t.type] = (perCur[t.currency].byType[t.type] ?? 0) + t.amount;
    }
  }
  const settings = getSavingsSettings(userId);
  const currencies = Object.entries(perCur).map(([currency, v]) => {
    const ratio = v.income > 0 ? v.spend / v.income : v.spend > 0 ? Infinity : 0;
    const state: 'green' | 'amber' | 'red' = ratio < 0.7 ? 'green' : ratio < 1 ? 'amber' : 'red';
    const top = Object.entries(v.byType)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([type, amount]) => ({ type, amountMinor: amount }));
    const anchorMinor = Math.round((v.income * settings.anchorBps) / 10_000);
    const overspend = Math.max(0, v.spend - v.income);
    const plan =
      state === 'green'
        ? null
        : {
            weeklySavingMinor: Math.round(Math.max(anchorMinor, overspend) / 4),
            cutFrom: top.map((t) => ({ type: t.type, reduceByMinor: Math.round(t.amountMinor * (state === 'red' ? 0.2 : 0.1)) })),
            message:
              state === 'red'
                ? `You spent more than you received in the last 30 days. Set aside ${Math.round(Math.max(anchorMinor, overspend) / 4)} minor units a week and trim the three biggest categories by a fifth.`
                : `You are spending most of what comes in. Keep the ${settings.anchorBps / 100}% anchor and trim the biggest categories by a tenth.`,
          };
    return { currency, incomeMinor: v.income, spendMinor: v.spend, ratio: Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : null, state, topSpend: top, plan };
  });
  return { days: 30, currencies, overall: currencies.some((c) => c.state === 'red') ? 'red' : currencies.some((c) => c.state === 'amber') ? 'amber' : 'green' };
}
export function savingsOverview(user: UserRow) {
  return {
    settings: getSavingsSettings(user.id),
    goals: listGoals(user.id),
    wellbeing: wellbeing(user.id),
    minimumAnchorBps: MIN_ANCHOR_BPS,
    wallets: listWallets(user.id).map((w) => ({ currency: w.currency, balance: w.balance })),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Automation on domain events (opt-in; anchor never below 10%)
// ---------------------------------------------------------------------------------------------------------------------
function defaultGoalFor(userId: string, currency: string, settings: SavingsSettings): SavingsGoal | null {
  const goals = listGoals(userId).filter((g) => g.currency === currency && g.status === 'ACTIVE');
  return goals.find((g) => g.id === settings.defaultGoalId) ?? goals[0] ?? null;
}
export function onIncome(ev: DomainEvent): void {
  const p = ev.payload as { userId?: string; amountMinor?: number; currency?: string; transactionId?: string; type?: string };
  if (!p.userId || !p.amountMinor || !p.currency || NON_INCOME_TYPES.has(p.type ?? '')) return;
  const settings = getSavingsSettings(p.userId);
  if (!settings.autoAnchor) return;
  const goal = defaultGoalFor(p.userId, p.currency, settings);
  if (!goal) return;
  const amount = Math.floor((p.amountMinor * Math.max(MIN_ANCHOR_BPS, settings.anchorBps)) / 10_000);
  if (amount <= 0) return;
  try {
    contribute(p.userId, goal.id, amount, 'anchor', { type: 'system' }, p.transactionId ?? null);
  } catch (err) {
    console.warn(`[savings] anchor skipped for ${p.userId}: ${(err as Error).message}`);
  }
}
export function onSpend(ev: DomainEvent): void {
  const p = ev.payload as { senderUserId?: string | null; receiverUserId?: string | null; amountMinor?: number; currency?: string; type?: string; transactionId?: string; status?: string };
  if (!p.senderUserId || !p.amountMinor || !p.currency || !SPEND_TYPES.has(p.type ?? '') || p.senderUserId === p.receiverUserId) return;
  const settings = getSavingsSettings(p.senderUserId);
  if (!settings.roundUps) return;
  const unit = Math.max(1, settings.roundToMinor);
  const change = (unit - (p.amountMinor % unit)) % unit;
  if (change <= 0) return;
  const goal = defaultGoalFor(p.senderUserId, p.currency, settings);
  if (!goal) return;
  try {
    contribute(p.senderUserId, goal.id, change, 'round_up', { type: 'system' }, p.transactionId ?? null);
  } catch {
    /* not enough available balance for the round-up: skip silently */
  }
}
const HOOK = Symbol.for('bitripay.savings.subscribed');
if (!(globalThis as any)[HOOK]) {
  (globalThis as any)[HOOK] = true;
  subscribe('savings-anchor', ['income.received'], onIncome);
  subscribe('savings-roundups', ['transaction.settled'], (ev) => onSpend(ev));
  subscribe('savings-roundups-immediate', ['transaction.created'], (ev) => {
    if ((ev.payload as any).status === 'completed') onSpend(ev);
  });
}
