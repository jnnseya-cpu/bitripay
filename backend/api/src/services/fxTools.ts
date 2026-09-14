/**
 * FX engine tools (module 11): rate alerts, auto-convert rules and forwards.
 * - Alerts watch the reference (mid-market) rate the platform holds and notify once when it crosses the target.
 * - Auto-convert rules convert a share of every receipt, or sweep whatever sits above a floor, at the disclosed
 *   customer rate — and only when the rate is at least the floor the account holder set. Nothing converts without a
 *   rule the account holder created (rule 7 of the FX section: never convert without explicit instruction).
 * - Forwards lock today's disclosed rate (plus the forward margin) for a settlement date up to the configured tenor;
 *   the source amount is ring-fenced as a hold so it is there on the day, and the conversion is booked at the locked
 *   rate whatever the market does. The platform's exposure is capped per account and in total by settings.
 */
import { getDb } from '../db';
import { now, shortCode } from '../lib/ids';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { getCurrency, convertWithMargin, toBase, listCurrencies } from './currencies';
import { calculateFee, postTransaction } from './ledger';
import { getUserWallet, ensureWallet, listWallets } from './wallets';
import { createHold, releaseHold, heldByKind } from './finops/holds';
import { exchange } from './transfers';
import { findUserById, type UserRow } from './users';
import { notify } from './notifications';
import { recordEvent, type Actor } from './events';
import { publish, subscribe, type DomainEvent } from './bus';
import { getSetting } from './settings';
import { formatMoney } from '@bitripay/shared';

export interface ForwardSettings {
  enabled: boolean;
  /** Extra margin over the spot customer rate, in basis points, for carrying the rate risk. */
  forwardBps: number;
  maxTenorDays: number;
  /** Per-forward and per-account open exposure ceilings in base-currency minor units. */
  maxPerForwardBase: number;
  maxOpenPerAccountBase: number;
  maxOpenTotalBase: number;
  /** Days after the settlement date before an unsettled forward expires and its hold is released. */
  graceDays: number;
}
const DEFAULT_FORWARDS: ForwardSettings = { enabled: true, forwardBps: 75, maxTenorDays: 30, maxPerForwardBase: 500_000, maxOpenPerAccountBase: 2_000_000, maxOpenTotalBase: 50_000_000, graceDays: 7 };
export const getForwardSettings = (): ForwardSettings => ({ ...DEFAULT_FORWARDS, ...getSetting<Partial<ForwardSettings>>('fxForwards', {}) });

/** Reference and customer rate for one unit of `from` in `to`. */
export function currentRate(from: string, to: string): { midRate: number; rate: number; marginBps: number } {
  const f = getCurrency(from);
  getCurrency(to);
  const q = convertWithMargin(10 ** f.decimals, f.code, to);
  return { midRate: q.midRate, rate: q.rate, marginBps: q.marginBps };
}

// ---------------------------------------------------------------- alerts
export interface FxAlert {
  id: string;
  baseCurrency: string;
  quoteCurrency: string;
  direction: 'above' | 'below';
  targetRate: number;
  status: 'ACTIVE' | 'TRIGGERED' | 'CANCELLED';
  note: string | null;
  triggeredAt: string | null;
  triggeredRate: number | null;
  currentRate: number;
  createdAt: string;
}
const alertView = (r: any): FxAlert => ({
  id: r.id,
  baseCurrency: r.base_currency,
  quoteCurrency: r.quote_currency,
  direction: r.direction,
  targetRate: r.target_rate,
  status: r.status,
  note: r.note,
  triggeredAt: r.triggered_at,
  triggeredRate: r.triggered_rate,
  currentRate: safeMid(r.base_currency, r.quote_currency),
  createdAt: r.created_at,
});
function safeMid(from: string, to: string): number {
  try {
    return currentRate(from, to).midRate;
  } catch {
    return 0;
  }
}
export function createAlert(user: UserRow, input: { baseCurrency: string; quoteCurrency: string; direction: 'above' | 'below'; targetRate: number; note?: string | null }): FxAlert {
  const base = getCurrency(input.baseCurrency);
  const quote = getCurrency(input.quoteCurrency);
  if (base.code === quote.code) throw badRequest('Choose two different currencies');
  if (!(input.targetRate > 0)) throw badRequest('Target rate must be positive', 'invalid_rate');
  const active = (getDb().prepare("SELECT COUNT(*) c FROM fx_alerts WHERE user_id = ? AND status = 'ACTIVE'").get(user.id) as any).c;
  if (active >= 20) throw conflict('You can have at most 20 active alerts', 'too_many_alerts');
  const id = `fxa_${shortCode(10).toLowerCase()}`;
  getDb()
    .prepare('INSERT INTO fx_alerts (id, user_id, base_currency, quote_currency, direction, target_rate, status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, user.id, base.code, quote.code, input.direction, input.targetRate, 'ACTIVE', input.note ?? null, now());
  return alertView(getDb().prepare('SELECT * FROM fx_alerts WHERE id = ?').get(id));
}
export function listAlerts(userId: string): FxAlert[] {
  return (getDb().prepare('SELECT * FROM fx_alerts WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(userId) as any[]).map(alertView);
}
export function cancelAlert(userId: string, id: string): FxAlert {
  const r = getDb().prepare('UPDATE fx_alerts SET status = ? WHERE id = ? AND user_id = ? AND status = ?').run('CANCELLED', id, userId, 'ACTIVE');
  if (!r.changes) throw notFound('Alert not found or already closed', 'alert_not_found');
  return alertView(getDb().prepare('SELECT * FROM fx_alerts WHERE id = ?').get(id));
}
/** Job: evaluate every active alert against the reference rate; fire once. */
export function checkFxAlerts(): { checked: number; triggered: number } {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM fx_alerts WHERE status = 'ACTIVE'").all() as any[];
  let triggered = 0;
  for (const a of rows) {
    let mid: number;
    try {
      mid = currentRate(a.base_currency, a.quote_currency).midRate;
    } catch {
      continue;
    }
    const hit = a.direction === 'above' ? mid >= a.target_rate : mid <= a.target_rate;
    if (!hit) continue;
    db.prepare("UPDATE fx_alerts SET status = 'TRIGGERED', triggered_at = ?, triggered_rate = ? WHERE id = ?").run(now(), mid, a.id);
    triggered += 1;
    notify(
      a.user_id,
      `${a.base_currency}/${a.quote_currency} ${a.direction === 'above' ? 'reached' : 'fell to'} ${mid.toFixed(4)}`,
      `Your alert at ${a.target_rate} fired. Open Exchange to convert at today's disclosed rate.`,
      { kind: 'wallet', alertId: a.id, url: '/app/exchange' },
    );
    publish('fx.alert_triggered', { userId: a.user_id, alertId: a.id, base: a.base_currency, quote: a.quote_currency, rate: mid, target: a.target_rate }, { aggregateId: a.id, tenantId: a.user_id });
  }
  return { checked: rows.length, triggered };
}

// ---------------------------------------------------------------- auto-convert rules
export interface AutoRule {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  kind: 'on_receipt' | 'sweep';
  shareBps: number;
  keepMinor: number;
  minRate: number | null;
  status: 'ACTIVE' | 'PAUSED';
  runs: number;
  convertedMinor: number;
  lastRunAt: string | null;
  lastError: string | null;
  createdAt: string;
}
const ruleView = (r: any): AutoRule => ({
  id: r.id,
  fromCurrency: r.from_currency,
  toCurrency: r.to_currency,
  kind: r.kind,
  shareBps: r.share_bps,
  keepMinor: r.keep_minor,
  minRate: r.min_rate,
  status: r.status,
  runs: r.runs,
  convertedMinor: r.converted_minor,
  lastRunAt: r.last_run_at,
  lastError: r.last_error,
  createdAt: r.created_at,
});
export function createAutoRule(
  user: UserRow,
  input: { fromCurrency: string; toCurrency: string; kind: 'on_receipt' | 'sweep'; shareBps?: number | null; keepMinor?: number | null; minRate?: number | null },
): AutoRule {
  const from = getCurrency(input.fromCurrency);
  const to = getCurrency(input.toCurrency);
  if (from.code === to.code) throw badRequest('Choose two different currencies');
  const share = input.shareBps ?? 10_000;
  if (share < 1 || share > 10_000) throw badRequest('Share must be between 0.01% and 100%', 'invalid_share');
  if (input.kind === 'sweep' && (input.keepMinor ?? 0) < 0) throw badRequest('The amount to keep cannot be negative');
  const dup = getDb()
    .prepare("SELECT id FROM fx_auto_rules WHERE user_id = ? AND from_currency = ? AND to_currency = ? AND kind = ? AND status = 'ACTIVE'")
    .get(user.id, from.code, to.code, input.kind);
  if (dup) throw conflict('An active rule for this pair and trigger already exists', 'rule_exists');
  const id = `fxr_${shortCode(10).toLowerCase()}`;
  getDb()
    .prepare('INSERT INTO fx_auto_rules (id, user_id, from_currency, to_currency, kind, share_bps, keep_minor, min_rate, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, user.id, from.code, to.code, input.kind, share, input.keepMinor ?? 0, input.minRate ?? null, 'ACTIVE', now(), now());
  recordEvent('ledger', id, 'fx.rule_created', { type: 'user', id: user.id }, { from: from.code, to: to.code, kind: input.kind, share, keep: input.keepMinor ?? 0, minRate: input.minRate ?? null });
  return ruleView(getDb().prepare('SELECT * FROM fx_auto_rules WHERE id = ?').get(id));
}
export function listAutoRules(userId: string): AutoRule[] {
  return (getDb().prepare('SELECT * FROM fx_auto_rules WHERE user_id = ? ORDER BY created_at DESC').all(userId) as any[]).map(ruleView);
}
export function setAutoRuleStatus(userId: string, id: string, status: 'ACTIVE' | 'PAUSED'): AutoRule {
  const r = getDb().prepare('UPDATE fx_auto_rules SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(status, now(), id, userId);
  if (!r.changes) throw notFound('Rule not found', 'rule_not_found');
  return ruleView(getDb().prepare('SELECT * FROM fx_auto_rules WHERE id = ?').get(id));
}
export function deleteAutoRule(userId: string, id: string): void {
  const r = getDb().prepare('DELETE FROM fx_auto_rules WHERE id = ? AND user_id = ?').run(id, userId);
  if (!r.changes) throw notFound('Rule not found', 'rule_not_found');
}
function runRule(rule: any, amountMinor: number): boolean {
  const db = getDb();
  const user = findUserById(rule.user_id);
  if (!user) return false;
  try {
    const { rate } = currentRate(rule.from_currency, rule.to_currency);
    if (rule.min_rate && rate < rule.min_rate) {
      db.prepare('UPDATE fx_auto_rules SET last_run_at = ?, last_error = ?, updated_at = ? WHERE id = ?').run(now(), `rate ${rate.toFixed(4)} below your floor ${rule.min_rate}`, now(), rule.id);
      return false;
    }
    const wallet = getUserWallet(user.id, rule.from_currency);
    const held = Object.values(heldByKind(wallet.id)).reduce((a, b) => a + b, 0);
    const available = wallet.balance - held;
    const fee = calculateFee('exchange', amountMinor, rule.from_currency);
    if (amountMinor <= 0 || available < amountMinor + fee) {
      db.prepare('UPDATE fx_auto_rules SET last_run_at = ?, last_error = ?, updated_at = ? WHERE id = ?').run(now(), 'not enough available balance', now(), rule.id);
      return false;
    }
    const r = exchange(user, rule.from_currency, rule.to_currency, amountMinor);
    db.prepare('UPDATE fx_auto_rules SET runs = runs + 1, converted_minor = converted_minor + ?, last_run_at = ?, last_error = NULL, updated_at = ? WHERE id = ?').run(
      amountMinor,
      now(),
      now(),
      rule.id,
    );
    notify(
      user.id,
      'Auto-convert done',
      `${formatMoney(amountMinor, getCurrency(rule.from_currency))} became ${formatMoney(r.received, getCurrency(rule.to_currency))} at ${r.rate.toFixed(4)} (your ${rule.kind === 'on_receipt' ? 'on-receipt' : 'sweep'} rule).`,
      { kind: 'wallet', transactionId: r.tx.id },
    );
    return true;
  } catch (err) {
    db.prepare('UPDATE fx_auto_rules SET last_run_at = ?, last_error = ?, updated_at = ? WHERE id = ?').run(now(), (err as Error).message, now(), rule.id);
    return false;
  }
}
export function onIncomeForRules(ev: DomainEvent): void {
  const p = ev.payload as { userId?: string; amountMinor?: number; currency?: string; type?: string };
  if (!p.userId || !p.amountMinor || !p.currency || p.type === 'exchange') return;
  const rules = getDb().prepare("SELECT * FROM fx_auto_rules WHERE user_id = ? AND from_currency = ? AND kind = 'on_receipt' AND status = 'ACTIVE'").all(p.userId, p.currency) as any[];
  for (const rule of rules) runRule(rule, Math.floor((p.amountMinor * rule.share_bps) / 10_000));
}
/** Job: sweep rules convert whatever sits above the amount to keep. */
export function runSweepRules(): { ran: number; converted: number } {
  const rules = getDb().prepare("SELECT * FROM fx_auto_rules WHERE kind = 'sweep' AND status = 'ACTIVE'").all() as any[];
  let converted = 0;
  for (const rule of rules) {
    const wallet = listWallets(rule.user_id).find((w) => w.currency === rule.from_currency);
    if (!wallet) continue;
    const held = Object.values(heldByKind(wallet.id)).reduce((a, b) => a + b, 0);
    const excess = wallet.balance - held - rule.keep_minor;
    if (excess <= 0) continue;
    // Convert the amount whose fee still fits inside the excess, so the balance lands on the floor rather than fee-above it.
    let amount = excess - calculateFee('exchange', excess, rule.from_currency);
    for (let i = 0; i < 3 && amount > 0 && amount + calculateFee('exchange', amount, rule.from_currency) > excess; i += 1) amount = excess - calculateFee('exchange', amount, rule.from_currency);
    while (amount > 0 && amount + 1 + calculateFee('exchange', amount + 1, rule.from_currency) <= excess) amount += 1; // fee rounding: leave nothing above the floor
    if (amount > 0 && runRule(rule, amount)) converted += 1;
  }
  return { ran: rules.length, converted };
}

// ---------------------------------------------------------------- forwards
export interface ForwardView {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  amountMinor: number;
  receiveMinor: number;
  rate: number;
  midRate: number;
  marginBps: number;
  forwardBps: number;
  settleOn: string;
  expiresOn: string;
  status: 'LOCKED' | 'SETTLED' | 'EXPIRED' | 'CANCELLED';
  transactionId: string | null;
  createdAt: string;
  settledAt: string | null;
}
const forwardView = (r: any): ForwardView => ({
  id: r.id,
  fromCurrency: r.from_currency,
  toCurrency: r.to_currency,
  amountMinor: r.amount_minor,
  receiveMinor: r.receive_minor,
  rate: r.rate,
  midRate: r.mid_rate,
  marginBps: r.margin_bps,
  forwardBps: r.forward_bps,
  settleOn: r.settle_on,
  expiresOn: r.expires_on,
  status: r.status,
  transactionId: r.transaction_id,
  createdAt: r.created_at,
  settledAt: r.settled_at,
});
export function quoteForward(from: string, to: string, amountMinor: number, settleOn: string) {
  const s = getForwardSettings();
  if (!s.enabled) throw unprocessable('Forwards are not available right now', 'forwards_disabled');
  const f = getCurrency(from);
  const t = getCurrency(to);
  if (f.code === t.code) throw badRequest('Choose two different currencies');
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw badRequest('Amount must be positive', 'invalid_amount');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(settleOn) ? settleOn : null;
  if (!day) throw badRequest('settleOn must be a date (YYYY-MM-DD)', 'invalid_date');
  const days = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z')) / 86_400_000);
  if (days < 1) throw badRequest('The settlement date must be tomorrow or later', 'invalid_date');
  if (days > s.maxTenorDays) throw unprocessable(`Forwards run at most ${s.maxTenorDays} days ahead`, 'tenor_too_long', { maxTenorDays: s.maxTenorDays });
  if (toBase(amountMinor, f.code) > s.maxPerForwardBase) throw unprocessable('Amount exceeds the forward ceiling', 'forward_ceiling', { maxPerForwardBase: s.maxPerForwardBase });
  const spot = currentRate(f.code, t.code);
  const rate = spot.rate * (1 - s.forwardBps / 10_000);
  const receiveMinor = Math.floor((amountMinor / 10 ** f.decimals) * rate * 10 ** t.decimals);
  if (receiveMinor <= 0) throw badRequest('Amount too small to convert');
  const fee = calculateFee('exchange', amountMinor, f.code);
  const expiresOn = new Date(Date.parse(`${day}T00:00:00Z`) + s.graceDays * 86_400_000).toISOString().slice(0, 10);
  return {
    fromCurrency: f.code,
    toCurrency: t.code,
    amountMinor,
    receiveMinor,
    rate,
    midRate: spot.midRate,
    marginBps: spot.marginBps,
    forwardBps: s.forwardBps,
    fee,
    settleOn: day,
    expiresOn,
    days,
    disclosure: `Locked rate ${rate.toFixed(6)} = reference ${spot.midRate.toFixed(6)} less the ${spot.marginBps / 100}% exchange margin and the ${s.forwardBps / 100}% forward margin. ${formatMoney(amountMinor + fee, f)} is ring-fenced until ${day}.`,
  };
}
export function lockForward(user: UserRow, input: { fromCurrency: string; toCurrency: string; amountMinor: number; settleOn: string }, actor: Actor): ForwardView {
  const q = quoteForward(input.fromCurrency, input.toCurrency, input.amountMinor, input.settleOn);
  const s = getForwardSettings();
  const db = getDb();
  const openAccount = (
    db.prepare("SELECT COALESCE(SUM(amount_minor), 0) s, from_currency FROM fx_forwards WHERE user_id = ? AND status = 'LOCKED' GROUP BY from_currency").all(user.id) as any[]
  ).reduce((a, r) => a + toBase(r.s, r.from_currency), 0);
  if (openAccount + toBase(q.amountMinor, q.fromCurrency) > s.maxOpenPerAccountBase)
    throw unprocessable('Open forwards on this account would exceed the ceiling', 'forward_account_ceiling', { maxOpenPerAccountBase: s.maxOpenPerAccountBase });
  const openTotal = (db.prepare("SELECT COALESCE(SUM(amount_minor), 0) s, from_currency FROM fx_forwards WHERE status = 'LOCKED' GROUP BY from_currency").all() as any[]).reduce(
    (a, r) => a + toBase(r.s, r.from_currency),
    0,
  );
  if (openTotal + toBase(q.amountMinor, q.fromCurrency) > s.maxOpenTotalBase) throw unprocessable('The platform forward book is full for now; try a smaller amount or later', 'forward_book_full');
  const wallet = getUserWallet(user.id, q.fromCurrency);
  const held = Object.values(heldByKind(wallet.id)).reduce((a, b) => a + b, 0);
  if (wallet.balance - held < q.amountMinor + q.fee)
    throw unprocessable('Not enough available balance to ring-fence for this forward', 'insufficient_funds', { available: wallet.balance - held, needed: q.amountMinor + q.fee });
  const id = `fwd_${shortCode(10).toLowerCase()}`;
  db.transaction(() => {
    const hold = createHold(
      { walletId: wallet.id, amountMinor: q.amountMinor + q.fee, kind: 'reserve', refType: 'fx_forward', refId: id, reason: `forward ${q.fromCurrency}→${q.toCurrency} settling ${q.settleOn}` },
      actor,
    );
    db.prepare(
      'INSERT INTO fx_forwards (id, user_id, from_currency, to_currency, amount_minor, receive_minor, rate, mid_rate, margin_bps, forward_bps, settle_on, expires_on, status, hold_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, user.id, q.fromCurrency, q.toCurrency, q.amountMinor, q.receiveMinor, q.rate, q.midRate, q.marginBps, q.forwardBps, q.settleOn, q.expiresOn, 'LOCKED', hold.id, now());
  })();
  recordEvent('ledger', id, 'fx.forward_locked', actor, { from: q.fromCurrency, to: q.toCurrency, amount: q.amountMinor, receive: q.receiveMinor, rate: q.rate, settleOn: q.settleOn });
  notify(
    user.id,
    'Rate locked',
    `${formatMoney(q.amountMinor, getCurrency(q.fromCurrency))} will become ${formatMoney(q.receiveMinor, getCurrency(q.toCurrency))} on ${q.settleOn} at ${q.rate.toFixed(4)}, whatever the market does.`,
    { kind: 'wallet', forwardId: id },
  );
  return forwardView(db.prepare('SELECT * FROM fx_forwards WHERE id = ?').get(id));
}
export function listForwards(userId: string): ForwardView[] {
  return (getDb().prepare('SELECT * FROM fx_forwards WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(userId) as any[]).map(forwardView);
}
export function getForward(userId: string, id: string): ForwardView {
  const r = getDb().prepare('SELECT * FROM fx_forwards WHERE id = ? AND user_id = ?').get(id, userId);
  if (!r) throw notFound('Forward not found', 'forward_not_found');
  return forwardView(r);
}
/** Book the conversion at the locked rate. Callable by the account holder from the settlement date, and by the daily job. */
export function settleForward(id: string, actor: Actor, opts: { force?: boolean } = {}): ForwardView {
  const db = getDb();
  const f = db.prepare('SELECT * FROM fx_forwards WHERE id = ?').get(id) as any;
  if (!f) throw notFound('Forward not found', 'forward_not_found');
  if (f.status !== 'LOCKED') throw conflict(`This forward is ${f.status.toLowerCase()}`, 'forward_not_open');
  const today = new Date().toISOString().slice(0, 10);
  if (!opts.force && today < f.settle_on) throw conflict(`This forward settles on ${f.settle_on}`, 'forward_not_due');
  const user = findUserById(f.user_id)!;
  const fee = calculateFee('exchange', f.amount_minor, f.from_currency);
  const fromWallet = getUserWallet(user.id, f.from_currency);
  const toWallet = ensureWallet(user.id, f.to_currency);
  const tx = db.transaction(() => {
    if (f.hold_id) releaseHold(f.hold_id, actor, 'forward settlement');
    const posted = postTransaction({
      type: 'exchange',
      amount: f.amount_minor,
      fee,
      currency: f.from_currency,
      receiveAmount: f.receive_minor,
      receiveCurrency: f.to_currency,
      fromWalletId: fromWallet.id,
      toWalletId: toWallet.id,
      senderUserId: user.id,
      receiverUserId: user.id,
      note: `Forward ${f.from_currency} → ${f.to_currency} at ${Number(f.rate).toFixed(4)} (locked ${f.created_at.slice(0, 10)})`,
      metadata: { forwardId: id, rate: f.rate, midRate: f.mid_rate, marginBps: f.margin_bps, forwardBps: f.forward_bps, guaranteed: true, settleOn: f.settle_on },
    });
    db.prepare("UPDATE fx_forwards SET status = 'SETTLED', transaction_id = ?, settled_at = ?, closed_at = ? WHERE id = ?").run(posted.id, now(), now(), id);
    return posted;
  })();
  recordEvent('ledger', id, 'fx.forward_settled', actor, { transactionId: tx.id });
  notify(
    user.id,
    'Forward settled',
    `${formatMoney(f.amount_minor, getCurrency(f.from_currency))} became ${formatMoney(f.receive_minor, getCurrency(f.to_currency))} at your locked rate ${Number(f.rate).toFixed(4)}.`,
    { kind: 'wallet', transactionId: tx.id },
  );
  return forwardView(db.prepare('SELECT * FROM fx_forwards WHERE id = ?').get(id));
}
export function cancelForward(userId: string, id: string, actor: Actor): ForwardView {
  const db = getDb();
  const f = db.prepare('SELECT * FROM fx_forwards WHERE id = ? AND user_id = ?').get(id, userId) as any;
  if (!f) throw notFound('Forward not found', 'forward_not_found');
  if (f.status !== 'LOCKED') throw conflict(`This forward is ${f.status.toLowerCase()}`, 'forward_not_open');
  if (f.hold_id) releaseHold(f.hold_id, actor, 'forward cancelled');
  db.prepare("UPDATE fx_forwards SET status = 'CANCELLED', closed_at = ? WHERE id = ?").run(now(), id);
  recordEvent('ledger', id, 'fx.forward_cancelled', actor, {});
  return forwardView(db.prepare('SELECT * FROM fx_forwards WHERE id = ?').get(id));
}
/** Job: settle forwards whose date has come (the money is ring-fenced, so this never fails for lack of funds) and expire the stragglers. */
export function runForwards(): { settled: number; expired: number } {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  let settled = 0;
  let expired = 0;
  for (const f of db.prepare("SELECT id, expires_on FROM fx_forwards WHERE status = 'LOCKED' AND settle_on <= ?").all(today) as any[]) {
    try {
      settleForward(f.id, { type: 'system' });
      settled += 1;
    } catch (err) {
      if (f.expires_on < today) {
        const row = db.prepare('SELECT * FROM fx_forwards WHERE id = ?').get(f.id) as any;
        if (row.hold_id)
          try {
            releaseHold(row.hold_id, { type: 'system' }, 'forward expired');
          } catch {
            /* already released */
          }
        db.prepare("UPDATE fx_forwards SET status = 'EXPIRED', closed_at = ? WHERE id = ?").run(now(), f.id);
        expired += 1;
      } else console.warn(`[fx] forward ${f.id} not settled: ${(err as Error).message}`);
    }
  }
  return { settled, expired };
}
export function fxOverview(user: UserRow) {
  const pairs = listWallets(user.id).map((w) => w.currency);
  const rates = pairs
    .flatMap((a) =>
      pairs
        .filter((b) => b !== a)
        .map((b) => {
          try {
            const r = currentRate(a, b);
            return { from: a, to: b, ...r };
          } catch {
            return null;
          }
        }),
    )
    .filter(Boolean);
  return {
    alerts: listAlerts(user.id),
    rules: listAutoRules(user.id),
    forwards: listForwards(user.id),
    rates,
    forwardSettings: (({ enabled, forwardBps, maxTenorDays }) => ({ enabled, forwardBps, maxTenorDays }))(getForwardSettings()),
    currencies: listCurrencies(true).map((c) => c.code),
  };
}
const HOOK = Symbol.for('bitripay.fxTools.subscribed');
if (!(globalThis as any)[HOOK]) {
  (globalThis as any)[HOOK] = true;
  subscribe('fx-auto-convert', ['income.received'], onIncomeForRules);
}
