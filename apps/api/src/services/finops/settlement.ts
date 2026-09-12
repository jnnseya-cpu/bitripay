/**
 * Settlement engine: profiles (per merchant, rail and currency: schedule T+0 / T+1 / T+2 / weekly / manual, cut-off
 * hour, destination, minimum), cycles (what was collected between two cut-offs, net of fees, refunds, splits and
 * holds), obligations (closed cycles not yet paid) and statements (numbered, hashed, JSON / CSV / PDF). Paying a cycle
 * goes through the withdrawal workflow with its maker-checker controls; the existing `settlements` rows and the
 * automated sweep keep working as before — a profile simply makes the cadence explicit and auditable.
 */
import { getDb } from '../../db';
import { now, shortCode, uuid } from '../../lib/ids';
import { parseJson } from '../../lib/json';
import { sha256 } from '../../lib/crypto';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { config } from '../../config';
import { PdfDocument } from '../../lib/pdf';
import { formatMoney } from '@bitripay/shared';
import { findUserById, getGatewaySettings, type UserRow } from '../users';
import { getCurrency, toBase } from '../currencies';
import { registerDestinationChange, assertDestinationUsable } from '../risk/accountProtection';
import { getUserWallet, listWallets } from '../wallets';
import { requestWithdrawal, type WithdrawalDestination } from '../withdrawals';
import { recordEvent, type Actor } from '../events';
import { emitEvent } from '../webhooks';
import { notify } from '../notifications';
import { heldAmount } from './holds';
import { transactionStatusHooks } from '../ledger';

export type SettlementSchedule = 'T0' | 'T1' | 'T2' | 'weekly' | 'manual';
export interface SettlementProfile {
  id: string;
  userId: string;
  rail: string;
  currency: string;
  schedule: SettlementSchedule;
  cutoffHourUtc: number;
  destination: WithdrawalDestination | { method: 'wallet' } | Record<string, never>;
  minAmount: number;
  auto: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}
const toProfile = (r: any): SettlementProfile => ({ id: r.id, userId: r.user_id, rail: r.rail, currency: r.currency, schedule: r.schedule, cutoffHourUtc: r.cutoff_hour_utc, destination: parseJson(r.destination, {}), minAmount: r.min_amount, auto: !!r.auto, active: !!r.active, createdAt: r.created_at, updatedAt: r.updated_at });

export interface SettlementCycle {
  id: string;
  userId: string;
  profileId: string | null;
  currency: string;
  rail: string;
  periodFrom: string;
  periodTo: string;
  businessDate: string;
  status: 'OPEN' | 'CLOSED' | 'PAYING' | 'PAID' | 'FAILED' | 'SKIPPED';
  grossMinor: number;
  feesMinor: number;
  refundsMinor: number;
  splitsMinor: number;
  holdsMinor: number;
  netMinor: number;
  itemCount: number;
  dueAt: string | null;
  withdrawalTransactionId: string | null;
  settlementId: string | null;
  hash: string | null;
  closedAt: string | null;
  paidAt: string | null;
  failure: string | null;
  createdAt: string;
}
const toCycle = (r: any): SettlementCycle => ({ id: r.id, userId: r.user_id, profileId: r.profile_id, currency: r.currency, rail: r.rail, periodFrom: r.period_from, periodTo: r.period_to, businessDate: r.business_date, status: r.status, grossMinor: r.gross_minor, feesMinor: r.fees_minor, refundsMinor: r.refunds_minor, splitsMinor: r.splits_minor, holdsMinor: r.holds_minor, netMinor: r.net_minor, itemCount: r.item_count, dueAt: r.due_at, withdrawalTransactionId: r.withdrawal_transaction_id, settlementId: r.settlement_id, hash: r.hash, closedAt: r.closed_at, paidAt: r.paid_at, failure: r.failure, createdAt: r.created_at });

// ---------------------------------------------------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------------------------------------------------
export function upsertProfile(user: UserRow, input: { rail?: string; currency: string; schedule: SettlementSchedule; cutoffHourUtc?: number; destination?: SettlementProfile['destination']; minAmount?: number; auto?: boolean; active?: boolean }): SettlementProfile {
  const cur = getCurrency(input.currency);
  if (input.destination && 'bankAccountId' in input.destination) {
    const bank = getDb().prepare('SELECT id FROM bank_accounts WHERE id = ? AND user_id = ?').get(input.destination.bankAccountId, user.id);
    if (!bank) throw badRequest('Bank account not found', 'bank_account_not_found');
  }
  const cutoff = input.cutoffHourUtc ?? 22;
  if (cutoff < 0 || cutoff > 23) throw badRequest('cutoffHourUtc must be 0–23', 'invalid_cutoff');
  const db = getDb();
  const rail = input.rail ?? 'default';
  const existing = db.prepare('SELECT * FROM settlement_profiles WHERE user_id = ? AND rail = ? AND currency = ?').get(user.id, rail, cur.code) as any;
  if (existing) {
    const previous = parseJson<Record<string, unknown>>(existing.destination, {});
    if (input.destination && JSON.stringify(input.destination) !== JSON.stringify(previous) && (input.destination as any).method !== 'wallet') registerDestinationChange(user, { kind: 'settlement_profile', refId: existing.id, previous, next: input.destination as Record<string, unknown> }, { type: user.role === 'admin' ? 'admin' : 'merchant', id: user.id });
    db.prepare('UPDATE settlement_profiles SET schedule = ?, cutoff_hour_utc = ?, destination = ?, min_amount = ?, auto = ?, active = ?, updated_at = ? WHERE id = ?').run(input.schedule, cutoff, JSON.stringify(input.destination ?? parseJson(existing.destination, {})), input.minAmount ?? existing.min_amount, (input.auto ?? !!existing.auto) ? 1 : 0, (input.active ?? !!existing.active) ? 1 : 0, now(), existing.id);
    recordEvent('ledger', existing.id, 'settlement_profile.updated', { type: user.role === 'admin' ? 'admin' : 'merchant', id: user.id }, { schedule: input.schedule, rail, currency: cur.code });
    return toProfile(db.prepare('SELECT * FROM settlement_profiles WHERE id = ?').get(existing.id));
  }
  const id = `sp_${shortCode(12).toLowerCase()}`;
  if (input.destination && (input.destination as any).method && (input.destination as any).method !== 'wallet') registerDestinationChange(user, { kind: 'settlement_profile', refId: id, previous: null, next: input.destination as Record<string, unknown> }, { type: user.role === 'admin' ? 'admin' : 'merchant', id: user.id });
  db.prepare('INSERT INTO settlement_profiles (id, user_id, rail, currency, schedule, cutoff_hour_utc, destination, min_amount, auto, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, user.id, rail, cur.code, input.schedule, cutoff, JSON.stringify(input.destination ?? {}), input.minAmount ?? 0, (input.auto ?? true) ? 1 : 0, (input.active ?? true) ? 1 : 0, now(), now());
  recordEvent('ledger', id, 'settlement_profile.created', { type: user.role === 'admin' ? 'admin' : 'merchant', id: user.id }, { schedule: input.schedule, rail, currency: cur.code });
  return toProfile(db.prepare('SELECT * FROM settlement_profiles WHERE id = ?').get(id));
}
export function listProfiles(userId: string): SettlementProfile[] {
  return (getDb().prepare('SELECT * FROM settlement_profiles WHERE user_id = ? ORDER BY currency, rail').all(userId) as any[]).map(toProfile);
}
export function getProfile(userId: string | null, id: string): SettlementProfile {
  const r = getDb().prepare('SELECT * FROM settlement_profiles WHERE id = ?').get(id) as any;
  if (!r || (userId && r.user_id !== userId)) throw notFound('Settlement profile not found', 'profile_not_found');
  return toProfile(r);
}

/** Due date for a cycle closed at `closedAt` under a schedule (business days = Monday–Friday). */
export function dueDate(schedule: SettlementSchedule, closedAt: Date): string | null {
  if (schedule === 'manual') return null;
  const d = new Date(closedAt);
  const addBusinessDays = (n: number) => {
    let left = n;
    while (left > 0) {
      d.setUTCDate(d.getUTCDate() + 1);
      if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left -= 1;
    }
  };
  if (schedule === 'T0') return d.toISOString();
  if (schedule === 'T1') addBusinessDays(1);
  if (schedule === 'T2') addBusinessDays(2);
  if (schedule === 'weekly') {
    const days = (8 - d.getUTCDay()) % 7 || 7; // next Monday
    d.setUTCDate(d.getUTCDate() + days);
  }
  d.setUTCHours(9, 0, 0, 0);
  return d.toISOString();
}

// ---------------------------------------------------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------------------------------------------------
const RAIL_OF: Record<string, string> = { card: 'card', mobile_money: 'mobile_money', bank: 'bank', wallet: 'wallet', virtual_card: 'card', national_switch: 'national_switch' };

/**
 * Close a cycle for a merchant / currency / rail: every completed collection since the previous cycle that is not
 * yet in any cycle, its fees, refunds posted against those collections, split distributions and active holds.
 */
export function closeCycle(userId: string, currency: string, rail = 'default', opts: { profileId?: string | null; periodTo?: string | null; businessDate?: string | null; actor?: Actor } = {}): SettlementCycle {
  const db = getDb();
  const cur = getCurrency(currency);
  const user = findUserById(userId);
  if (!user) throw notFound('Merchant not found', 'user_not_found');
  const periodTo = opts.periodTo ?? now();
  const last = db.prepare("SELECT period_to FROM settlement_cycles WHERE user_id = ? AND currency = ? AND rail = ? AND status != 'SKIPPED' ORDER BY period_to DESC LIMIT 1").get(userId, cur.code, rail) as any;
  const periodFrom = last?.period_to ?? '1970-01-01T00:00:00.000Z';
  const collections = db.prepare("SELECT * FROM transactions WHERE receiver_user_id = ? AND currency = ? AND type IN ('merchant_payment', 'qr_payment') AND status IN ('completed', 'reversed') AND completed_at > ? AND completed_at <= ? AND id NOT IN (SELECT transaction_id FROM settlement_items)").all(userId, cur.code, periodFrom, periodTo) as any[];
  const inRail = collections.filter((t) => rail === 'default' || RAIL_OF[parseJson<any>(t.metadata, {}).method ?? 'wallet'] === rail);
  const refunds = db.prepare("SELECT * FROM transactions WHERE sender_user_id = ? AND currency = ? AND type = 'refund' AND status = 'completed' AND completed_at > ? AND completed_at <= ? AND id NOT IN (SELECT transaction_id FROM settlement_items)").all(userId, cur.code, periodFrom, periodTo) as any[];
  const splits = db.prepare("SELECT * FROM transactions WHERE sender_user_id = ? AND currency = ? AND type = 'distribution' AND status = 'completed' AND json_extract(metadata, '$.split') = 1 AND completed_at > ? AND completed_at <= ? AND id NOT IN (SELECT transaction_id FROM settlement_items)").all(userId, cur.code, periodFrom, periodTo) as any[];
  const gross = inRail.reduce((s, t) => s + t.amount, 0);
  const fees = inRail.reduce((s, t) => s + t.fee, 0);
  const refunded = refunds.reduce((s, t) => s + t.amount, 0);
  const split = splits.reduce((s, t) => s + t.amount, 0);
  const wallet = listWallets(userId).find((w) => w.currency === cur.code);
  const holds = wallet ? heldAmount(wallet.id) : 0;
  const net = Math.max(0, gross - fees - refunded - split - holds);
  const id = `sc_${shortCode(14).toLowerCase()}`;
  const profile = opts.profileId ? getProfile(userId, opts.profileId) : listProfiles(userId).find((p) => p.currency === cur.code && p.rail === rail) ?? null;
  const closedAt = new Date(periodTo);
  const businessDate = opts.businessDate ?? periodTo.slice(0, 10);
  const status: SettlementCycle['status'] = inRail.length + refunds.length + splits.length === 0 ? 'SKIPPED' : 'CLOSED';
  db.transaction(() => {
    db.prepare('INSERT INTO settlement_cycles (id, user_id, profile_id, currency, rail, period_from, period_to, business_date, status, gross_minor, fees_minor, refunds_minor, splits_minor, holds_minor, net_minor, item_count, due_at, closed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, userId, profile?.id ?? null, cur.code, rail, periodFrom, periodTo, businessDate, status, gross, fees, refunded, split, holds, net, inRail.length + refunds.length + splits.length, profile ? dueDate(profile.schedule, closedAt) : dueDate('T1', closedAt), now(), now(), now());
    const ins = db.prepare('INSERT INTO settlement_items (id, cycle_id, transaction_id, intent_id, kind, amount_minor, fee_minor, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const t of inRail) ins.run(uuid(), id, t.id, t.intent_id ?? null, 'payment', t.amount, t.fee, t.completed_at, now());
    for (const t of refunds) ins.run(uuid(), id, t.id, null, 'refund', -t.amount, 0, t.completed_at, now());
    for (const t of splits) ins.run(uuid(), id, t.id, parseJson<any>(t.metadata, {}).intentId ?? null, 'split', -t.amount, 0, t.completed_at, now());
    const hash = sha256(`${id}|${userId}|${cur.code}|${periodFrom}|${periodTo}|${gross}|${fees}|${refunded}|${split}|${holds}|${net}|${inRail.map((t) => t.id).join(',')}`);
    db.prepare('UPDATE settlement_cycles SET hash = ? WHERE id = ?').run(hash, id);
  })();
  recordEvent('ledger', id, 'settlement_cycle.closed', opts.actor ?? { type: 'system' }, { userId, currency: cur.code, rail, gross, fees, refunded, split, holds, net, items: inRail.length });
  const cycle = getCycle(null, id);
  if (status === 'CLOSED') emitEvent(userId, 'payment_intent.settled', { settlementCycle: cycle }, { resource: { type: 'settlement_cycle', id } });
  return cycle;
}

export function getCycle(userId: string | null, id: string): SettlementCycle {
  const r = getDb().prepare('SELECT * FROM settlement_cycles WHERE id = ?').get(id) as any;
  if (!r || (userId && r.user_id !== userId)) throw notFound('Settlement cycle not found', 'cycle_not_found');
  return toCycle(r);
}
export function listCycles(filter: { userId?: string | null; status?: string | null; currency?: string | null; limit?: number } = {}): SettlementCycle[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.userId) {
    where.push('user_id = ?');
    params.push(filter.userId);
  }
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.currency) {
    where.push('currency = ?');
    params.push(filter.currency.toUpperCase());
  }
  return (getDb().prepare(`SELECT * FROM settlement_cycles ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`).all(...params, Math.min(200, filter.limit ?? 50)) as any[]).map(toCycle);
}
export function cycleItems(cycleId: string) {
  return (getDb().prepare('SELECT si.*, t.reference, t.type, t.note FROM settlement_items si JOIN transactions t ON t.id = si.transaction_id WHERE si.cycle_id = ? ORDER BY si.occurred_at').all(cycleId) as any[]).map((r) => ({ id: r.id, transactionId: r.transaction_id, reference: r.reference, intentId: r.intent_id, kind: r.kind, type: r.type, amountMinor: r.amount_minor, feeMinor: r.fee_minor, note: r.note, occurredAt: r.occurred_at }));
}

/** Obligations: closed cycles awaiting payment (the merchant is owed the net). */
export function obligations(userId?: string | null) {
  const rows = listCycles({ userId, status: 'CLOSED', limit: 200 });
  const byCurrency: Record<string, { count: number; netMinor: number; overdue: number }> = {};
  for (const c of rows) {
    byCurrency[c.currency] ??= { count: 0, netMinor: 0, overdue: 0 };
    byCurrency[c.currency].count += 1;
    byCurrency[c.currency].netMinor += c.netMinor;
    if (c.dueAt && c.dueAt < now()) byCurrency[c.currency].overdue += 1;
  }
  return { cycles: rows, byCurrency };
}

/** Pay a closed cycle: the net leaves through the withdrawal workflow (maker-checker / payout accounts). */
export function payCycle(cycleId: string, actor: Actor, destinationOverride?: WithdrawalDestination | null): SettlementCycle {
  const db = getDb();
  const c = getCycle(null, cycleId);
  if (c.status !== 'CLOSED') throw conflict(`Cycle is ${c.status}`, 'cycle_not_payable');
  const user = findUserById(c.userId)!;
  const profile = c.profileId ? getProfile(null, c.profileId) : null;
  const dest = destinationOverride ?? (profile && 'method' in profile.destination && (profile.destination as any).method !== 'wallet' ? (profile.destination as WithdrawalDestination) : null);
  if (!dest) {
    // no external destination: the money simply stays available in the wallet (wallet settlement)
    db.prepare("UPDATE settlement_cycles SET status = 'PAID', paid_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), cycleId);
    recordEvent('ledger', cycleId, 'settlement_cycle.paid', actor, { method: 'wallet', net: c.netMinor });
    return getCycle(null, cycleId);
  }
  const wallet = getUserWallet(c.userId, c.currency);
  const payable = Math.min(c.netMinor, Math.max(0, wallet.balance - heldAmount(wallet.id)));
  if (profile && payable > 0) assertDestinationUsable(user, 'settlement_profile', profile.id, toBase(payable, c.currency));
  if (payable <= 0 || payable < (profile?.minAmount ?? 0)) {
    db.prepare("UPDATE settlement_cycles SET status = 'FAILED', failure = ?, updated_at = ? WHERE id = ?").run(payable <= 0 ? 'nothing available to settle (holds or prior withdrawals)' : `below the minimum of ${profile?.minAmount}`, now(), cycleId);
    return getCycle(null, cycleId);
  }
  try {
    const tx = requestWithdrawal(user, { amount: payable, currency: c.currency, destination: dest, note: `Settlement ${cycleId} (${c.periodFrom.slice(0, 10)} → ${c.periodTo.slice(0, 10)})` });
    const settlementId = uuid();
    db.prepare("INSERT INTO settlements (id, user_id, bank_account_id, amount, currency, status, transaction_id, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)").run(settlementId, c.userId, 'bankAccountId' in dest ? dest.bankAccountId : null, payable, c.currency, tx.id, now());
    db.prepare("UPDATE settlement_cycles SET status = 'PAYING', withdrawal_transaction_id = ?, settlement_id = ?, updated_at = ? WHERE id = ?").run(tx.id, settlementId, now(), cycleId);
    recordEvent('ledger', cycleId, 'settlement_cycle.paying', actor, { transactionId: tx.id, amount: payable });
    notify(c.userId, 'Settlement on its way', `${formatMoney(payable, getCurrency(c.currency, false))} from cycle ${c.periodTo.slice(0, 10)} is being paid out.`, { kind: 'payout', cycleId });
  } catch (err) {
    db.prepare("UPDATE settlement_cycles SET status = 'FAILED', failure = ?, updated_at = ? WHERE id = ?").run((err as Error).message, now(), cycleId);
    recordEvent('ledger', cycleId, 'settlement_cycle.failed', actor, { error: (err as Error).message });
  }
  return getCycle(null, cycleId);
}

/** The withdrawal finished (completed or rejected): mirror onto the cycle. Registered as a ledger status hook. */
export function onWithdrawalOutcome(transactionId: string, outcome: 'completed' | 'rejected' | 'cancelled' | 'failed'): void {
  const db = getDb();
  const c = db.prepare('SELECT id FROM settlement_cycles WHERE withdrawal_transaction_id = ?').get(transactionId) as any;
  if (!c) return;
  if (outcome === 'completed') db.prepare("UPDATE settlement_cycles SET status = 'PAID', paid_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), c.id);
  else db.prepare("UPDATE settlement_cycles SET status = 'FAILED', failure = ?, updated_at = ? WHERE id = ?").run(`withdrawal ${outcome}`, now(), c.id);
  db.prepare('UPDATE settlements SET status = ? WHERE transaction_id = ?').run(outcome === 'completed' ? 'paid' : 'failed', transactionId);
}

/** Scheduler: close cycles at each active profile's cut-off and pay the ones that are due. */
export function runSettlementSchedules(at = new Date()): { closed: number; paid: number; skipped: number } {
  const db = getDb();
  let closed = 0;
  let paid = 0;
  let skipped = 0;
  const today = at.toISOString().slice(0, 10);
  for (const p of (db.prepare('SELECT * FROM settlement_profiles WHERE active = 1 AND auto = 1').all() as any[]).map(toProfile)) {
    if (p.schedule === 'manual') continue;
    if (at.getUTCHours() < p.cutoffHourUtc) continue;
    const already = db.prepare("SELECT 1 FROM settlement_cycles WHERE profile_id = ? AND business_date = ? AND status != 'SKIPPED'").get(p.id, today) ?? db.prepare("SELECT 1 FROM settlement_cycles WHERE profile_id = ? AND business_date = ?").get(p.id, today);
    if (!already) {
      const c = closeCycle(p.userId, p.currency, p.rail, { profileId: p.id, businessDate: today });
      if (c.status === 'SKIPPED') skipped += 1;
      else closed += 1;
    }
  }
  for (const c of listCycles({ status: 'CLOSED', limit: 500 })) {
    if (c.dueAt && c.dueAt <= at.toISOString()) {
      const r = payCycle(c.id, { type: 'system' });
      if (r.status === 'PAYING' || r.status === 'PAID') paid += 1;
    }
  }
  return { closed, paid, skipped };
}

/** Upcoming cut-offs and due dates for the merchant's calendar. */
export function settlementCalendar(userId: string) {
  const profiles = listProfiles(userId);
  const gw = getGatewaySettings(findUserById(userId)!);
  const upcoming = profiles.map((p) => {
    const next = new Date();
    next.setUTCHours(p.cutoffHourUtc, 0, 0, 0);
    if (next.getTime() <= Date.now()) next.setUTCDate(next.getUTCDate() + 1);
    return { profileId: p.id, currency: p.currency, rail: p.rail, schedule: p.schedule, nextCutoff: next.toISOString(), expectedPayout: dueDate(p.schedule, next) };
  });
  return { profiles, upcoming, legacyAutoSettle: gw.autoSettle, obligations: obligations(userId), recent: listCycles({ userId, limit: 12 }) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------------------------------------------------
export function cycleStatement(cycleId: string) {
  const c = getCycle(null, cycleId);
  const user = findUserById(c.userId)!;
  const cur = getCurrency(c.currency, false);
  const items = cycleItems(cycleId);
  return {
    number: `SET-${c.businessDate.replace(/-/g, '')}-${c.id.slice(3, 9).toUpperCase()}`,
    cycle: c,
    merchant: { id: user.id, name: user.business_name || user.full_name, tag: user.tag, country: user.country },
    currency: cur.code,
    totals: { gross: c.grossMinor, fees: c.feesMinor, refunds: c.refundsMinor, splits: c.splitsMinor, holds: c.holdsMinor, net: c.netMinor, formatted: { gross: formatMoney(c.grossMinor, cur), fees: formatMoney(c.feesMinor, cur), refunds: formatMoney(c.refundsMinor, cur), splits: formatMoney(c.splitsMinor, cur), holds: formatMoney(c.holdsMinor, cur), net: formatMoney(c.netMinor, cur) } },
    items,
    hash: c.hash,
    issuer: config.appName,
    generatedAt: now(),
  };
}
export function cycleStatementCsv(cycleId: string): string {
  const s = cycleStatement(cycleId);
  const cur = getCurrency(s.currency, false);
  const money = (n: number) => (n / 10 ** cur.decimals).toFixed(cur.decimals);
  const q = (v: string | null | undefined) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = [`# ${config.appName} settlement statement ${s.number}`, `# Merchant: ${s.merchant.name} (@${s.merchant.tag})`, `# Period: ${s.cycle.periodFrom} to ${s.cycle.periodTo} · ${s.currency}`, `# Gross ${money(s.totals.gross)} · Fees ${money(s.totals.fees)} · Refunds ${money(s.totals.refunds)} · Splits ${money(s.totals.splits)} · Holds ${money(s.totals.holds)} · Net ${money(s.totals.net)}`, `# Hash: ${s.hash}`];
  const rows = [['Date', 'Reference', 'Kind', 'Description', 'Amount', 'Fee'].join(',')];
  for (const i of s.items) rows.push([i.occurredAt, i.reference, i.kind, q(i.note), money(i.amountMinor), money(i.feeMinor)].join(','));
  return [...head, ...rows].join('\n') + '\n';
}
export function cycleStatementPdf(cycleId: string): Buffer {
  const s = cycleStatement(cycleId);
  const cur = getCurrency(s.currency, false);
  const money = (n: number) => formatMoney(n, cur);
  const doc = new PdfDocument({ title: `${config.appName} settlement ${s.number}`, author: config.appName });
  doc.setFooter((p, t) => `${config.appName} · Settlement ${s.number} · SHA-256 ${(s.hash ?? '').slice(0, 32)}… · Page ${p} of ${t}`);
  doc.text(config.appName, { size: 20, bold: true });
  doc.text('Settlement statement', { size: 12, gray: 0.35 });
  doc.space(6);
  doc.rule();
  doc.pair('Statement number', s.number);
  doc.pair('Merchant', `${s.merchant.name} (@${s.merchant.tag})`);
  doc.pair('Period', `${s.cycle.periodFrom.slice(0, 16).replace('T', ' ')} → ${s.cycle.periodTo.slice(0, 16).replace('T', ' ')} (business date ${s.cycle.businessDate})`);
  doc.pair('Rail / currency', `${s.cycle.rail} · ${s.currency}`);
  doc.pair('Status', `${s.cycle.status}${s.cycle.dueAt ? ` · due ${s.cycle.dueAt.slice(0, 10)}` : ''}`);
  doc.space(4);
  doc.rule();
  doc.pair('Gross collections', money(s.totals.gross));
  doc.pair('Platform fees', `− ${money(s.totals.fees)}`);
  doc.pair('Refunds', `− ${money(s.totals.refunds)}`);
  doc.pair('Split payments', `− ${money(s.totals.splits)}`);
  doc.pair('Holds', `− ${money(s.totals.holds)}`);
  doc.pair('Net settlement', money(s.totals.net), { size: 11 });
  doc.space(10);
  doc.text(`Items (${s.items.length})`, { size: 12, bold: true });
  doc.space(4);
  const rows = s.items.map((i) => [i.occurredAt.slice(0, 16).replace('T', ' '), i.reference, i.kind, (i.note ?? '').slice(0, 40), money(i.amountMinor), money(i.feeMinor)]);
  if (rows.length) doc.table([{ title: 'Date', width: 78 }, { title: 'Reference', width: 70 }, { title: 'Kind', width: 50 }, { title: 'Description', width: 150 }, { title: 'Amount', width: 85, align: 'right' as const }, { title: 'Fee', width: 82, align: 'right' as const }], rows, { zebra: true });
  else doc.text('No items in this cycle.', { gray: 0.4 });
  doc.space(12);
  doc.rule();
  doc.text(`Generated ${s.generatedAt} from the immutable ledger. Integrity hash (SHA-256): ${s.hash}`, { size: 8, gray: 0.35 });
  return doc.render();
}

// Mirror withdrawal outcomes onto the cycles that requested them (registered once, whatever imports this module first).
const HOOK = Symbol.for('bitripay.settlement.hook');
if (!(globalThis as any)[HOOK]) {
  (globalThis as any)[HOOK] = true;
  transactionStatusHooks.push((tx, outcome) => {
    if (tx.type === 'withdrawal') onWithdrawalOutcome(tx.id, outcome);
  });
}
