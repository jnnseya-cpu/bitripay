/**
 * The command centres are a paid add-on. An account holder activates them for a period by paying a small fee from
 * their wallet (a normal ledger posting to the fees account), can cancel renewal at any time, and loses nothing else
 * when the period ends: every other BitriPay feature works exactly as before. Administrators never pay.
 */
import { getDb } from '../../db';
import { uuid, now } from '../../lib/ids';
import { AppError, badRequest, unprocessable } from '../../lib/errors';
import { formatMoney } from '@bitripay/shared';
import type { UserRow } from '../users';
import { getSystemUser, findUserById } from '../users';
import { getUserWallet, ensureWallet, listWallets } from '../wallets';
import { postTransaction } from '../ledger';
import { convert, getCurrency } from '../currencies';
import { getAssistSettings } from '../settings';
import { assertPin } from '../auth';
import { notify } from '../notifications';
import { recordEvent } from '../events';

export interface SubscriptionView {
  id: string;
  status: 'active' | 'expired' | 'cancelled';
  currency: string;
  amount: number;
  periodDays: number;
  autoRenew: boolean;
  startedAt: string;
  expiresAt: string;
  cancelledAt: string | null;
  renewals: number;
}
const toView = (r: any): SubscriptionView => ({ id: r.id, status: r.status, currency: r.currency, amount: r.amount, periodDays: r.period_days, autoRenew: !!r.auto_renew, startedAt: r.started_at, expiresAt: r.expires_at, cancelledAt: r.cancelled_at, renewals: r.renewals });

export function currentSubscription(userId: string): SubscriptionView | null {
  const r = getDb().prepare("SELECT * FROM agent_subscriptions WHERE user_id = ? ORDER BY expires_at DESC LIMIT 1").get(userId) as any;
  return r ? toView(r) : null;
}
export function hasActiveAddon(user: UserRow): boolean {
  if (user.role === 'admin') return true;
  const s = getAssistSettings().addon;
  if (!s.enabled) return true;
  const sub = currentSubscription(user.id);
  return !!sub && sub.status === 'active' && sub.expiresAt > now();
}

/** Price of one period in a wallet currency, at the platform rate from the price currency. */
export function priceIn(currency: string): { currency: string; amount: number; formatted: string } {
  const s = getAssistSettings().addon;
  const code = currency.toUpperCase();
  let amount: number;
  try {
    amount = convert(s.priceMinor, s.priceCurrency, code);
  } catch {
    amount = s.priceMinor;
  }
  const cur = getCurrency(code, false);
  // never below one minor unit; round up to a tidy number of the smallest sensible step
  amount = Math.max(1, Math.ceil(amount));
  return { currency: code, amount, formatted: formatMoney(amount, cur) };
}

export function addonStatus(user: UserRow) {
  const s = getAssistSettings().addon;
  const sub = currentSubscription(user.id);
  const active = hasActiveAddon(user);
  const month = now().slice(0, 7);
  const runs = (getDb().prepare('SELECT COUNT(*) c FROM agent_runs WHERE user_id = ? AND created_at >= ?').get(user.id, `${month}-01T00:00:00.000Z`) as any).c as number;
  const prices = listWallets(user.id).map((w) => priceIn(w.currency));
  if (!prices.length) prices.push(priceIn(s.priceCurrency));
  return { required: s.enabled && user.role !== 'admin', active, subscription: sub, periodDays: s.periodDays, prices, freeRuns: s.freeRuns, freeRunsLeft: Math.max(0, s.freeRuns - runs), autoRenewDefault: s.autoRenew };
}

/** Throws unless the account holder may start a run (active add-on, free run left, administrator, or add-on switched off). */
export function assertAddon(user: UserRow) {
  const st = addonStatus(user);
  if (!st.required || st.active) return;
  if (st.freeRunsLeft > 0) return;
  throw new AppError(402, 'addon_required', `Activate the command centre add-on (${st.prices[0]?.formatted ?? ''} for ${st.periodDays} days) to keep using your agents. Everything else in BitriPay works as usual.`);
}

function charge(user: UserRow, currency: string, amount: number, periodDays: number, renewal: boolean) {
  const cur = getCurrency(currency);
  const wallet = getUserWallet(user.id, cur.code);
  if (wallet.balance < amount) throw unprocessable(`Insufficient balance: the add-on costs ${formatMoney(amount, cur)}`, 'insufficient_funds');
  const fees = getSystemUser('fees');
  return postTransaction({ type: 'subscription', amount, fee: 0, currency: cur.code, fromWalletId: wallet.id, toWalletId: ensureWallet(fees.id, cur.code).id, senderUserId: user.id, receiverUserId: fees.id, note: `Command centre add-on · ${periodDays} days${renewal ? ' (renewal)' : ''}`, metadata: { addon: 'assist', periodDays, renewal } });
}

/** Activate (or extend) the add-on by paying one period from the chosen wallet. Needs the transaction PIN or a step-up token. */
export function activateAddon(user: UserRow, currency: string, pin: string | undefined, req: { headers?: Record<string, unknown>; body?: any }, autoRenew?: boolean): SubscriptionView {
  const s = getAssistSettings().addon;
  if (!s.enabled) throw badRequest('The command centres are included for everyone right now; nothing to activate.', 'addon_not_required');
  if (user.role === 'admin') throw badRequest('Administrators do not pay for the add-on.', 'addon_not_required');
  assertPin(user, pin, req);
  const price = priceIn(currency);
  const db = getDb();
  return db.transaction(() => {
    const tx = charge(user, price.currency, price.amount, s.periodDays, false);
    const existing = currentSubscription(user.id);
    const base = existing && existing.status === 'active' && existing.expiresAt > now() ? new Date(existing.expiresAt) : new Date();
    const expires = new Date(base.getTime() + s.periodDays * 86400_000).toISOString();
    const renew = (autoRenew ?? s.autoRenew) ? 1 : 0;
    if (existing && existing.status === 'active' && existing.expiresAt > now()) {
      db.prepare('UPDATE agent_subscriptions SET expires_at = ?, auto_renew = ?, last_transaction_id = ?, renewals = renewals + 1, updated_at = ? WHERE id = ?').run(expires, renew, tx.id, now(), existing.id);
    } else {
      db.prepare('INSERT INTO agent_subscriptions (id, user_id, status, currency, amount, period_days, auto_renew, started_at, expires_at, last_transaction_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(uuid(), user.id, 'active', price.currency, price.amount, s.periodDays, renew, now(), expires, tx.id, now(), now());
    }
    recordEvent('admin', user.id, 'assist.addon.activated', { type: user.role === 'admin' ? 'admin' : 'user', id: user.id }, { currency: price.currency, amount: price.amount, periodDays: s.periodDays, transactionId: tx.id });
    notify(user.id, 'Command centre activated', `Your agents are active until ${expires.slice(0, 10)}. ${price.formatted} was taken from your ${price.currency} wallet.`, { kind: 'agent', transactionId: tx.id });
    return currentSubscription(user.id)!;
  })();
}

/** Stop renewals; the current period keeps running to its end. */
export function cancelAddon(user: UserRow): SubscriptionView | null {
  const sub = currentSubscription(user.id);
  if (!sub) return null;
  getDb().prepare("UPDATE agent_subscriptions SET auto_renew = 0, cancelled_at = COALESCE(cancelled_at, ?), updated_at = ? WHERE id = ?").run(now(), now(), sub.id);
  recordEvent('admin', user.id, 'assist.addon.cancelled', { type: 'user', id: user.id }, { subscriptionId: sub.id });
  return currentSubscription(user.id);
}
export function setAutoRenew(user: UserRow, on: boolean): SubscriptionView | null {
  const sub = currentSubscription(user.id);
  if (!sub) return null;
  getDb().prepare('UPDATE agent_subscriptions SET auto_renew = ?, cancelled_at = ?, updated_at = ? WHERE id = ?').run(on ? 1 : 0, on ? null : now(), now(), sub.id);
  return currentSubscription(user.id);
}

/** Daily: renew expiring subscriptions from the wallet when allowed, otherwise let them lapse and tell the account holder. */
export function renewSubscriptions(): { renewed: number; expired: number } {
  const db = getDb();
  const s = getAssistSettings().addon;
  const due = db.prepare("SELECT * FROM agent_subscriptions WHERE status = 'active' AND expires_at <= ?").all(now()) as any[];
  let renewed = 0;
  let expired = 0;
  for (const r of due) {
    const user = findUserById(r.user_id);
    if (!user || user.status !== 'active') {
      db.prepare("UPDATE agent_subscriptions SET status = 'expired', updated_at = ? WHERE id = ?").run(now(), r.id);
      expired++;
      continue;
    }
    if (r.auto_renew && s.enabled) {
      try {
        const price = priceIn(r.currency);
        const tx = charge(user, price.currency, price.amount, s.periodDays, true);
        const expires = new Date(Date.now() + s.periodDays * 86400_000).toISOString();
        db.prepare('UPDATE agent_subscriptions SET expires_at = ?, amount = ?, last_transaction_id = ?, renewals = renewals + 1, updated_at = ? WHERE id = ?').run(expires, price.amount, tx.id, now(), r.id);
        notify(user.id, 'Command centre renewed', `${price.formatted} was taken from your ${price.currency} wallet. Active until ${expires.slice(0, 10)}. Cancel any time in the command centre.`, { kind: 'agent', transactionId: tx.id });
        renewed++;
        continue;
      } catch (e: any) {
        notify(user.id, 'Command centre paused', `We could not renew your add-on (${e?.message ?? 'payment failed'}). Everything else keeps working; activate again whenever you like.`, { kind: 'agent' });
      }
    } else if (s.enabled) notify(user.id, 'Command centre ended', 'Your add-on period has ended. Everything else keeps working; activate again whenever you like.', { kind: 'agent' });
    db.prepare("UPDATE agent_subscriptions SET status = 'expired', updated_at = ? WHERE id = ?").run(now(), r.id);
    expired++;
  }
  return { renewed, expired };
}

export function addonReport() {
  const db = getDb();
  const active = (db.prepare("SELECT COUNT(*) c FROM agent_subscriptions WHERE status = 'active' AND expires_at > ?").get(now()) as any).c;
  const revenue = db.prepare("SELECT currency, COUNT(*) c, COALESCE(SUM(amount), 0) total FROM transactions WHERE type = 'subscription' AND status = 'completed' GROUP BY currency").all();
  const recent = (db.prepare('SELECT * FROM agent_subscriptions ORDER BY updated_at DESC LIMIT 50').all() as any[]).map((r) => ({ ...toView(r), userId: r.user_id }));
  return { active, revenue, recent };
}
