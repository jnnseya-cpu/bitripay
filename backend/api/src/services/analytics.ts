/**
 * Analytics series for the chart kit (@bitripay/charts): the same shapes feed the web app, the phone apps and the
 * console. Account analytics are scoped to the signed-in account (customer, merchant or agent); platform analytics
 * cover everything and need the reports permission. Amounts are in base-currency minor units so the UI formats them
 * with the viewer's money formatter; counts are plain numbers.
 */
import { getDb } from '../db';
import { parseJson } from '../lib/json';
import { toBase, getBaseCurrency } from './currencies';
import { usersById, type UserRow } from './users';
import { TRANSACTION_TYPE_LABELS } from '@bitripay/shared';
import { TIER_LABELS } from './risk/kycTiers';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
const day = (iso: string) => iso.slice(0, 10);
const month = (iso: string) => iso.slice(0, 7);

/** Activity families for the radar profile. */
const FAMILY_OF: Record<string, string> = {
  transfer: 'Transfers',
  money_request: 'Transfers',
  qr_payment: 'Payments',
  merchant_payment: 'Payments',
  bill_payment: 'Bills & top-ups',
  mobile_topup: 'Bills & top-ups',
  gift_card: 'Bills & top-ups',
  card_deposit: 'Money in',
  bank_deposit: 'Money in',
  mobile_money_deposit: 'Money in',
  agent_cash_in: 'Money in',
  withdrawal: 'Money out',
  agent_cash_out: 'Money out',
  payout: 'Money out',
  remittance: 'Remittance',
  exchange: 'Exchange',
  virtual_card_funding: 'Cards',
};
const CHANNEL_OF: Record<string, string> = {
  transfer: 'Wallet',
  money_request: 'Wallet',
  qr_payment: 'QR',
  merchant_payment: 'Checkout',
  card_deposit: 'Card',
  bank_deposit: 'Bank',
  mobile_money_deposit: 'Mobile money',
  agent_cash_in: 'Agent',
  agent_cash_out: 'Agent',
  withdrawal: 'Payout',
  payout: 'Payout',
  remittance: 'Remittance',
  exchange: 'FX',
  bill_payment: 'Services',
  mobile_topup: 'Services',
  gift_card: 'Services',
  virtual_card_funding: 'Cards',
};

interface Row {
  id: string;
  type: string;
  status: string;
  amount: number;
  fee: number;
  currency: string;
  sender_user_id: string | null;
  receiver_user_id: string | null;
  metadata: string;
  created_at: string;
}

export interface Datum {
  label: string;
  value: number;
}
export interface AnalyticsPayload {
  generatedAt: string;
  period: { from: string; to: string; days: number };
  currency: string;
  totals: { count: number; in: number; out: number; fees: number };
  /** Daily volume in and out (line / area). */
  trend: { labels: string[]; in: number[]; out: number[]; count: number[] };
  /** Volume by transaction type (bar / donut). */
  byType: Datum[];
  /** Volume by channel (pie / donut). */
  byChannel: Datum[];
  /** Last six months in and out (column). */
  monthly: { categories: string[]; series: { name: string; values: number[] }[] };
  /** Activity profile: operations per family (radar). */
  profile: { axes: string[]; values: number[] };
  /** Time-bound items: holds, savings goals, forwards, licences (gantt). */
  timeline: { label: string; start: string; end: string; progress?: number; group?: string }[];
  /** Counterparties by volume (treemap) and by count × volume × average (bubble). */
  counterparties: { label: string; value: number; count: number; average: number }[];
  /** Amount vs hour of day (scatter) and the raw amounts for the histogram. */
  byHour: { x: number; y: number; label: string; group: string }[];
  amounts: number[];
  /** Weekday × hour activity counts (heatmap). */
  heat: { rows: string[]; cols: string[]; values: number[][] };
  /** Role-specific extras: merchant methods, agent cash, platform accounts and KYC. */
  extras: Record<string, unknown>;
}

function empty(days: number, base: string): AnalyticsPayload {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const labels: string[] = [];
  for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) labels.push(d.toISOString().slice(0, 10));
  const months: string[] = [];
  for (let i = 5; i >= 0; i -= 1) months.push(new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  return {
    generatedAt: to.toISOString(),
    period: { from: from.toISOString(), to: to.toISOString(), days },
    currency: base,
    totals: { count: 0, in: 0, out: 0, fees: 0 },
    trend: { labels, in: labels.map(() => 0), out: labels.map(() => 0), count: labels.map(() => 0) },
    byType: [],
    byChannel: [],
    monthly: {
      categories: months,
      series: [
        { name: 'In', values: months.map(() => 0) },
        { name: 'Out', values: months.map(() => 0) },
      ],
    },
    profile: { axes: Array.from(new Set(Object.values(FAMILY_OF))), values: [] },
    timeline: [],
    counterparties: [],
    byHour: [],
    amounts: [],
    heat: { rows: WEEKDAYS, cols: HOURS, values: WEEKDAYS.map(() => HOURS.map(() => 0)) },
    extras: {},
  };
}

/** Fold ledger rows into the chart series. `viewer` scopes in/out; without it every row counts as platform volume. */
function fold(rows: Row[], out: AnalyticsPayload, viewer: string | null) {
  const dayIndex = new Map(out.trend.labels.map((l, i) => [l, i]));
  const monthIndex = new Map(out.monthly.categories.map((m, i) => [m, i]));
  const byType = new Map<string, number>();
  const byChannel = new Map<string, number>();
  const family = new Map<string, number>();
  const cp = new Map<string, { value: number; count: number }>();
  for (const r of rows) {
    const base = toBase(r.amount, r.currency);
    const fee = toBase(r.fee, r.currency);
    const isOut = viewer ? r.sender_user_id === viewer && r.receiver_user_id !== viewer : false;
    const isIn = viewer ? r.receiver_user_id === viewer && r.sender_user_id !== viewer : true;
    out.totals.count += 1;
    if (isOut) out.totals.out += base;
    if (isIn) out.totals.in += base;
    if (!viewer || isOut) out.totals.fees += fee;
    const di = dayIndex.get(day(r.created_at));
    if (di !== undefined) {
      out.trend.count[di] += 1;
      if (isOut) out.trend.out[di] += base;
      if (isIn) out.trend.in[di] += base;
    }
    const mi = monthIndex.get(month(r.created_at));
    if (mi !== undefined) {
      if (isIn) out.monthly.series[0].values[mi] += base;
      if (isOut) out.monthly.series[1].values[mi] += base;
    }
    const typeLabel = (TRANSACTION_TYPE_LABELS as Record<string, string>)[r.type] ?? r.type;
    byType.set(typeLabel, (byType.get(typeLabel) ?? 0) + base);
    const ch = CHANNEL_OF[r.type] ?? 'Platform';
    byChannel.set(ch, (byChannel.get(ch) ?? 0) + base);
    const fam = FAMILY_OF[r.type] ?? 'Other';
    family.set(fam, (family.get(fam) ?? 0) + 1);
    const other = viewer ? (isOut ? r.receiver_user_id : isIn ? r.sender_user_id : null) : (r.receiver_user_id ?? r.sender_user_id);
    if (other) {
      const c = cp.get(other) ?? { value: 0, count: 0 };
      c.value += base;
      c.count += 1;
      cp.set(other, c);
    }
    const t = new Date(r.created_at);
    const hour = t.getUTCHours();
    const wd = (t.getUTCDay() + 6) % 7;
    out.heat.values[wd][hour] += 1;
    if (out.byHour.length < 2000) out.byHour.push({ x: hour + t.getUTCMinutes() / 60, y: base, label: typeLabel, group: fam });
    if (out.amounts.length < 5000) out.amounts.push(base);
  }
  out.byType = [...byType].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  out.byChannel = [...byChannel].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  out.profile.values = out.profile.axes.map((a) => family.get(a) ?? 0);
  const top = [...cp].sort((a, b) => b[1].value - a[1].value).slice(0, 12);
  const names = usersById(top.map(([id]) => id));
  out.counterparties = top.map(([id, c]) => {
    const u = names.get(id);
    return { label: u ? (u.businessName ?? u.fullName ?? `@${u.tag}`) : 'Platform', value: c.value, count: c.count, average: Math.round(c.value / c.count) };
  });
}

function periodRows(where: string, params: unknown[], from: string): Row[] {
  return getDb()
    .prepare(
      `SELECT id, type, status, amount, fee, currency, sender_user_id, receiver_user_id, metadata, created_at FROM transactions WHERE status = 'completed' AND created_at >= ? AND ${where} ORDER BY created_at ASC LIMIT 100000`,
    )
    .all(from, ...params) as Row[];
}

/** Charts for the signed-in account over the last `days` days. */
export function accountAnalytics(user: UserRow, days = 30): AnalyticsPayload {
  const base = getBaseCurrency().code;
  const out = empty(days, base);
  const rows = periodRows('(sender_user_id = ? OR receiver_user_id = ?)', [user.id, user.id], out.period.from);
  fold(rows, out, user.id);
  const db = getDb();
  // timeline: active holds, savings goals, forwards
  for (const h of db
    .prepare("SELECT kind, reason, amount_minor, currency, created_at, expires_at FROM holds WHERE user_id = ? AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 20")
    .all(user.id) as any[])
    out.timeline.push({
      label: `${h.kind.replace(/_/g, ' ')} hold ${h.reason ? `· ${h.reason}` : ''}`.trim(),
      start: h.created_at,
      end: h.expires_at ?? new Date(Date.now() + 7 * 86_400_000).toISOString(),
      group: 'holds',
    });
  for (const g of db
    .prepare("SELECT name, target_minor, saved_minor, deadline, created_at FROM savings_goals WHERE user_id = ? AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 20")
    .all(user.id) as any[])
    out.timeline.push({
      label: `Goal · ${g.name}`,
      start: g.created_at,
      end: g.deadline ?? new Date(Date.now() + 90 * 86_400_000).toISOString(),
      progress: g.target_minor ? Math.min(1, g.saved_minor / g.target_minor) : 0,
      group: 'savings',
    });
  for (const f of db
    .prepare("SELECT from_currency, to_currency, amount_minor, settle_on, created_at FROM fx_forwards WHERE user_id = ? AND status = 'LOCKED' ORDER BY settle_on ASC LIMIT 20")
    .all(user.id) as any[])
    out.timeline.push({ label: `Forward ${f.from_currency}→${f.to_currency}`, start: f.created_at, end: f.settle_on, group: 'fx' });
  if (user.role === 'merchant') {
    const methods = new Map<string, number>();
    for (const r of rows.filter((r) => r.receiver_user_id === user.id && (r.type === 'merchant_payment' || r.type === 'qr_payment'))) {
      const m = String(parseJson<Record<string, unknown>>(r.metadata, {}).method ?? (r.type === 'qr_payment' ? 'qr' : 'wallet')).replace(/_/g, ' ');
      methods.set(m, (methods.get(m) ?? 0) + toBase(r.amount, r.currency));
    }
    out.extras.methods = [...methods].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  }
  if (user.role === 'agent') {
    const cashIn = out.trend.labels.map(() => 0);
    const cashOut = out.trend.labels.map(() => 0);
    const idx = new Map(out.trend.labels.map((l, i) => [l, i]));
    for (const r of rows) {
      const i = idx.get(day(r.created_at));
      if (i === undefined) continue;
      if (r.type === 'agent_cash_in' && r.sender_user_id === user.id) cashIn[i] += toBase(r.amount, r.currency);
      if (r.type === 'agent_cash_out' && r.receiver_user_id === user.id) cashOut[i] += toBase(r.amount, r.currency);
    }
    out.extras.cash = { labels: out.trend.labels, cashIn, cashOut };
  }
  return out;
}

/** Platform-wide charts for the console (reports permission). */
export function platformAnalytics(days = 30): AnalyticsPayload {
  const base = getBaseCurrency().code;
  const out = empty(days, base);
  const rows = periodRows('1 = 1', [], out.period.from);
  fold(rows, out, null);
  const db = getDb();
  const users = db.prepare('SELECT id, role, country, kyc_tier, kyc_status, created_at FROM users WHERE is_system = 0').all() as {
    id: string;
    role: string;
    country: string | null;
    kyc_tier: number;
    kyc_status: string;
    created_at: string;
  }[];
  const byCountry = new Map<string, number>();
  const userCountry = new Map(users.map((u) => [u.id, u.country ?? '—']));
  for (const r of rows) {
    const c = userCountry.get(r.sender_user_id ?? '') ?? userCountry.get(r.receiver_user_id ?? '') ?? '—';
    byCountry.set(c, (byCountry.get(c) ?? 0) + toBase(r.amount, r.currency));
  }
  out.extras.byCountry = [...byCountry]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);
  const roles = ['user', 'merchant', 'agent'];
  const tiers = [0, 1, 2, 3, 4];
  out.extras.kyc = {
    categories: tiers.map((t) => TIER_LABELS[t] ?? String(t)),
    series: roles.map((role) => ({ name: role, values: tiers.map((t) => users.filter((u) => u.role === role && u.kyc_tier === t).length) })),
  };
  const growthIdx = new Map(out.trend.labels.map((l, i) => [l, i]));
  const growth = out.trend.labels.map(() => 0);
  for (const u of users) {
    const i = growthIdx.get(day(u.created_at));
    if (i !== undefined) growth[i] += 1;
  }
  out.extras.newAccounts = { labels: out.trend.labels, values: growth };
  out.extras.accounts = roles.map((role) => ({ label: role, value: users.filter((u) => u.role === role).length }));
  for (const c of db.prepare('SELECT source_currency, dest_country, dest_currency, status, created_at, licence_expires_at FROM corridors ORDER BY created_at ASC LIMIT 30').all() as any[])
    out.timeline.push({
      label: `${c.source_currency}→${c.dest_country} ${c.dest_currency} (${c.status})`,
      start: c.created_at,
      end: c.licence_expires_at ?? new Date(Date.now() + 365 * 86_400_000).toISOString(),
      group: 'corridors',
    });
  for (const h of db.prepare("SELECT kind, amount_minor, currency, created_at, expires_at FROM holds WHERE status = 'ACTIVE' ORDER BY created_at DESC LIMIT 20").all() as any[])
    out.timeline.push({ label: `${h.kind.replace(/_/g, ' ')} hold`, start: h.created_at, end: h.expires_at ?? new Date(Date.now() + 7 * 86_400_000).toISOString(), group: 'holds' });
  return out;
}
