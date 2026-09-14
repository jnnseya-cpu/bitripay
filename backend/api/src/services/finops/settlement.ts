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
import { getCurrency, toBase, convertWithMargin } from '../currencies';
import { registerDestinationChange, assertDestinationUsable } from '../risk/accountProtection';
import { getUserWallet, listWallets, ensureWallet } from '../wallets';
import { requestWithdrawal, type WithdrawalDestination } from '../withdrawals';
import { recordEvent, type Actor } from '../events';
import { emitEvent } from '../webhooks';
import { notify } from '../notifications';
import { heldAmount } from './holds';
import { feeTaxRateBps, splitFeeTax, getFinopsSettings } from './fees';
import { transactionStatusHooks, postTransaction } from '../ledger';
import { publish } from '../bus';

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
  /** Currency the merchant is paid in. Defaults to the collection currency; when it differs the obligation is converted. */
  settlementCurrency: string;
  /** Convert at close (true) or when the cycle is paid (false). Either way the conversion is a ledger exchange at the disclosed rate. */
  autoConvert: boolean;
  createdAt: string;
  updatedAt: string;
}
const toProfile = (r: any): SettlementProfile => ({
  id: r.id,
  userId: r.user_id,
  rail: r.rail,
  currency: r.currency,
  schedule: r.schedule,
  cutoffHourUtc: r.cutoff_hour_utc,
  destination: parseJson(r.destination, {}),
  minAmount: r.min_amount,
  auto: !!r.auto,
  active: !!r.active,
  settlementCurrency: r.settlement_currency ?? r.currency,
  autoConvert: !!r.auto_convert,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** How a cycle's obligation was (or would be) converted from the collection currency into the settlement currency. */
export interface SettlementConversion {
  fromCurrency: string;
  toCurrency: string;
  fromMinor: number;
  toMinor: number;
  /** Customer rate after the margin, and the mid-market rate it was derived from. */
  rate: number;
  midRate: number;
  marginBps: number;
  /** Ledger exchange transaction once posted; null while the conversion is only quoted. */
  transactionId: string | null;
  convertedAt: string | null;
  error: string | null;
}

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
  /** feesMinor broken out: what the rail / processor charged, the BitriPay fee proper and the tax on it. */
  providerFeesMinor: number;
  platformFeesMinor: number;
  feeTaxMinor: number;
  /** Obligation in the settlement currency (equals currency / netMinor when no conversion applies). */
  settlementCurrency: string;
  settlementAmountMinor: number;
  conversion: SettlementConversion | null;
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
const toCycle = (r: any): SettlementCycle => ({
  id: r.id,
  userId: r.user_id,
  profileId: r.profile_id,
  currency: r.currency,
  rail: r.rail,
  periodFrom: r.period_from,
  periodTo: r.period_to,
  businessDate: r.business_date,
  status: r.status,
  grossMinor: r.gross_minor,
  feesMinor: r.fees_minor,
  refundsMinor: r.refunds_minor,
  splitsMinor: r.splits_minor,
  holdsMinor: r.holds_minor,
  netMinor: r.net_minor,
  providerFeesMinor: r.provider_fees_minor ?? 0,
  platformFeesMinor: r.platform_fees_minor ?? 0,
  feeTaxMinor: r.fee_tax_minor ?? 0,
  settlementCurrency: r.settlement_currency ?? r.currency,
  settlementAmountMinor: r.settlement_amount_minor ?? r.net_minor,
  conversion: parseJson<SettlementConversion | null>(r.conversion, null),
  itemCount: r.item_count,
  dueAt: r.due_at,
  withdrawalTransactionId: r.withdrawal_transaction_id,
  settlementId: r.settlement_id,
  hash: r.hash,
  closedAt: r.closed_at,
  paidAt: r.paid_at,
  failure: r.failure,
  createdAt: r.created_at,
});

// ---------------------------------------------------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------------------------------------------------
export function upsertProfile(
  user: UserRow,
  input: {
    rail?: string;
    currency: string;
    schedule: SettlementSchedule;
    cutoffHourUtc?: number;
    destination?: SettlementProfile['destination'];
    minAmount?: number;
    auto?: boolean;
    active?: boolean;
    settlementCurrency?: string | null;
    autoConvert?: boolean;
  },
): SettlementProfile {
  const cur = getCurrency(input.currency);
  const settlementCurrency = input.settlementCurrency ? getCurrency(input.settlementCurrency).code : null;
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
    if (input.destination && JSON.stringify(input.destination) !== JSON.stringify(previous) && (input.destination as any).method !== 'wallet')
      registerDestinationChange(
        user,
        { kind: 'settlement_profile', refId: existing.id, previous, next: input.destination as Record<string, unknown> },
        { type: user.role === 'admin' ? 'admin' : 'merchant', id: user.id },
      );
    db.prepare(
      'UPDATE settlement_profiles SET schedule = ?, cutoff_hour_utc = ?, destination = ?, min_amount = ?, auto = ?, active = ?, settlement_currency = ?, auto_convert = ?, updated_at = ? WHERE id = ?',
    ).run(
      input.schedule,
      cutoff,
      JSON.stringify(input.destination ?? parseJson(existing.destination, {})),
      input.minAmount ?? existing.min_amount,
      (input.auto ?? !!existing.auto) ? 1 : 0,
      (input.active ?? !!existing.active) ? 1 : 0,
      settlementCurrency ?? existing.settlement_currency ?? cur.code,
      (input.autoConvert ?? !!existing.auto_convert) ? 1 : 0,
      now(),
      existing.id,
    );
    recordEvent(
      'ledger',
      existing.id,
      'settlement_profile.updated',
      { type: user.role === 'admin' ? 'admin' : 'merchant', id: user.id },
      {
        schedule: input.schedule,
        rail,
        currency: cur.code,
        settlementCurrency: settlementCurrency ?? existing.settlement_currency ?? cur.code,
        autoConvert: input.autoConvert ?? !!existing.auto_convert,
      },
    );
    return toProfile(db.prepare('SELECT * FROM settlement_profiles WHERE id = ?').get(existing.id));
  }
  const id = `sp_${shortCode(12).toLowerCase()}`;
  if (input.destination && (input.destination as any).method && (input.destination as any).method !== 'wallet')
    registerDestinationChange(
      user,
      { kind: 'settlement_profile', refId: id, previous: null, next: input.destination as Record<string, unknown> },
      { type: user.role === 'admin' ? 'admin' : 'merchant', id: user.id },
    );
  db.prepare(
    'INSERT INTO settlement_profiles (id, user_id, rail, currency, schedule, cutoff_hour_utc, destination, min_amount, auto, active, settlement_currency, auto_convert, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    user.id,
    rail,
    cur.code,
    input.schedule,
    cutoff,
    JSON.stringify(input.destination ?? {}),
    input.minAmount ?? 0,
    (input.auto ?? true) ? 1 : 0,
    (input.active ?? true) ? 1 : 0,
    settlementCurrency ?? cur.code,
    input.autoConvert ? 1 : 0,
    now(),
    now(),
  );
  recordEvent(
    'ledger',
    id,
    'settlement_profile.created',
    { type: user.role === 'admin' ? 'admin' : 'merchant', id: user.id },
    { schedule: input.schedule, rail, currency: cur.code, settlementCurrency: settlementCurrency ?? cur.code, autoConvert: !!input.autoConvert },
  );
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

/** Administrative toggle of automatic conversion (optionally changing the settlement currency at the same time). */
export function setProfileAutoConvert(id: string, enabled: boolean, actor: Actor, settlementCurrency?: string | null): SettlementProfile {
  const p = getProfile(null, id);
  const target = settlementCurrency ? getCurrency(settlementCurrency).code : p.settlementCurrency;
  getDb()
    .prepare('UPDATE settlement_profiles SET auto_convert = ?, settlement_currency = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, target, now(), id);
  recordEvent('ledger', id, 'settlement_profile.auto_convert', actor, { enabled, settlementCurrency: target, previous: { enabled: p.autoConvert, settlementCurrency: p.settlementCurrency } });
  return getProfile(null, id);
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
 * What the rail / processor charged for a collection: the processor statement line matched to the gateway payment
 * (three-way reconciliation), else a `providerFeeMinor` the connector recorded on the transaction, else 0. Never
 * blended with the BitriPay fee.
 */
export function providerFeeFor(t: { id: string; intent_id?: string | null; metadata: string }): number {
  const db = getDb();
  const meta = parseJson<Record<string, any>>(t.metadata, {});
  if (typeof meta.providerFeeMinor === 'number' && Number.isFinite(meta.providerFeeMinor)) return Math.max(0, Math.round(meta.providerFeeMinor));
  const gatewayPaymentId: string | null =
    meta.paymentId ??
    (t.intent_id ? ((db.prepare('SELECT gateway_payment_id FROM payment_intents WHERE id = ?').get(t.intent_id) as any)?.gateway_payment_id ?? null) : null) ??
    (db.prepare('SELECT id FROM gateway_payments WHERE transaction_id = ?').get(t.id) as any)?.id ??
    null;
  if (!gatewayPaymentId) return 0;
  const line = db.prepare('SELECT fee_minor FROM reconciliation_lines WHERE matched_payment_id = ? AND fee_minor IS NOT NULL ORDER BY rowid DESC LIMIT 1').get(gatewayPaymentId) as any;
  return line ? Math.max(0, Math.round(line.fee_minor)) : 0;
}

export interface CycleLine {
  transaction: any;
  intentId: string | null;
  amountMinor: number;
  feeMinor: number;
  providerFeeMinor: number;
  platformFeeMinor: number;
  feeTaxMinor: number;
}
export interface CycleInputs {
  periodFrom: string;
  periodTo: string;
  profile: SettlementProfile | null;
  collections: CycleLine[];
  refunds: any[];
  splits: any[];
  taxRateBps: number;
  totals: {
    gross: number;
    fees: number;
    providerFees: number;
    platformFees: number;
    feeTax: number;
    refunds: number;
    splits: number;
    holds: number;
    net: number;
    itemCount: number;
  };
}

/**
 * Everything a cycle for a merchant / currency / rail would contain right now (or up to `periodTo`): completed
 * collections since the previous cycle that are not yet in any cycle, refunds, split distributions and active holds,
 * with each collection's fee broken into provider fee, BitriPay fee and tax. Shared by the close and the preview.
 *
 * Profile assignment: an intent carrying `settlement_profile_id` belongs to that profile's cycle; every other
 * collection belongs to the default profile of its currency and rail (or to the profile-less cycle).
 */
export function collectCycleInputs(userId: string, currency: string, rail = 'default', opts: { profileId?: string | null; periodTo?: string | null } = {}): CycleInputs {
  const db = getDb();
  const cur = getCurrency(currency);
  const periodTo = opts.periodTo ?? now();
  const last = db
    .prepare("SELECT period_to FROM settlement_cycles WHERE user_id = ? AND currency = ? AND rail = ? AND status != 'SKIPPED' ORDER BY period_to DESC LIMIT 1")
    .get(userId, cur.code, rail) as any;
  const periodFrom = last?.period_to ?? '1970-01-01T00:00:00.000Z';
  const profile = opts.profileId ? getProfile(userId, opts.profileId) : (listProfiles(userId).find((p) => p.currency === cur.code && p.rail === rail) ?? null);
  const activeProfiles = new Set(listProfiles(userId).map((p) => p.id));
  const collections = db
    .prepare(
      "SELECT t.*, pi.settlement_profile_id AS intent_profile_id FROM transactions t LEFT JOIN payment_intents pi ON pi.id = t.intent_id WHERE t.receiver_user_id = ? AND t.currency = ? AND t.type IN ('merchant_payment', 'qr_payment') AND t.status IN ('completed', 'reversed') AND t.completed_at > ? AND t.completed_at <= ? AND t.id NOT IN (SELECT transaction_id FROM settlement_items)",
    )
    .all(userId, cur.code, periodFrom, periodTo) as any[];
  const inRail = collections.filter((t) => {
    const assigned: string | null = t.intent_profile_id && activeProfiles.has(t.intent_profile_id) ? t.intent_profile_id : null;
    if (assigned) return !!profile && assigned === profile.id; // explicitly routed to a profile: only that profile's cycle takes it
    return rail === 'default' || RAIL_OF[parseJson<any>(t.metadata, {}).method ?? 'wallet'] === rail;
  });
  const refunds = db
    .prepare(
      "SELECT * FROM transactions WHERE sender_user_id = ? AND currency = ? AND type = 'refund' AND status = 'completed' AND completed_at > ? AND completed_at <= ? AND id NOT IN (SELECT transaction_id FROM settlement_items)",
    )
    .all(userId, cur.code, periodFrom, periodTo) as any[];
  const splits = db
    .prepare(
      "SELECT * FROM transactions WHERE sender_user_id = ? AND currency = ? AND type = 'distribution' AND status = 'completed' AND json_extract(metadata, '$.split') = 1 AND completed_at > ? AND completed_at <= ? AND id NOT IN (SELECT transaction_id FROM settlement_items)",
    )
    .all(userId, cur.code, periodFrom, periodTo) as any[];
  const taxRateBps = feeTaxRateBps();
  const lines: CycleLine[] = inRail.map((t) => {
    const tax = splitFeeTax(t.fee, taxRateBps);
    return {
      transaction: t,
      intentId: t.intent_id ?? null,
      amountMinor: t.amount,
      feeMinor: t.fee,
      providerFeeMinor: providerFeeFor(t),
      platformFeeMinor: tax.platformFeeMinor,
      feeTaxMinor: tax.feeTaxMinor,
    };
  });
  const gross = lines.reduce((a, l) => a + l.amountMinor, 0);
  const fees = lines.reduce((a, l) => a + l.feeMinor, 0);
  const providerFees = lines.reduce((a, l) => a + l.providerFeeMinor, 0);
  const platformFees = lines.reduce((a, l) => a + l.platformFeeMinor, 0);
  const feeTax = lines.reduce((a, l) => a + l.feeTaxMinor, 0);
  const refunded = refunds.reduce((a, t) => a + t.amount, 0);
  const split = splits.reduce((a, t) => a + t.amount, 0);
  const wallet = listWallets(userId).find((w) => w.currency === cur.code);
  const holds = wallet ? heldAmount(wallet.id) : 0;
  const net = Math.max(0, gross - fees - refunded - split - holds);
  return {
    periodFrom,
    periodTo,
    profile,
    collections: lines,
    refunds,
    splits,
    taxRateBps,
    totals: { gross, fees, providerFees, platformFees, feeTax, refunds: refunded, splits: split, holds, net, itemCount: lines.length + refunds.length + splits.length },
  };
}

/** Indicative conversion of an obligation into the profile's settlement currency at the platform rate with the disclosed margin. */
export function quoteConversion(fromCurrency: string, toCurrency: string, amountMinor: number): SettlementConversion | null {
  if (fromCurrency === toCurrency) return null;
  const q = convertWithMargin(amountMinor, fromCurrency, toCurrency);
  return { fromCurrency, toCurrency, fromMinor: amountMinor, toMinor: q.amount, rate: q.rate, midRate: q.midRate, marginBps: q.marginBps, transactionId: null, convertedAt: null, error: null };
}

/**
 * Close a cycle for a merchant / currency / rail: every completed collection since the previous cycle that is not
 * yet in any cycle, its fees, refunds posted against those collections, split distributions and active holds.
 */
export function closeCycle(
  userId: string,
  currency: string,
  rail = 'default',
  opts: { profileId?: string | null; periodTo?: string | null; businessDate?: string | null; actor?: Actor } = {},
): SettlementCycle {
  const db = getDb();
  const cur = getCurrency(currency);
  const user = findUserById(userId);
  if (!user) throw notFound('Merchant not found', 'user_not_found');
  const inputs = collectCycleInputs(userId, cur.code, rail, { profileId: opts.profileId ?? null, periodTo: opts.periodTo ?? null });
  const { periodFrom, periodTo, profile, refunds, splits } = inputs;
  const { gross, fees, providerFees, platformFees, feeTax, refunds: refunded, splits: split, holds, net } = inputs.totals;
  const inRail = inputs.collections;
  const id = `sc_${shortCode(14).toLowerCase()}`;
  const closedAt = new Date(periodTo);
  const businessDate = opts.businessDate ?? periodTo.slice(0, 10);
  const status: SettlementCycle['status'] = inputs.totals.itemCount === 0 ? 'SKIPPED' : 'CLOSED';
  const settlementCurrency = profile?.settlementCurrency ?? cur.code;
  const quote = quoteConversion(cur.code, settlementCurrency, net);
  db.transaction(() => {
    db.prepare(
      'INSERT INTO settlement_cycles (id, user_id, profile_id, currency, rail, period_from, period_to, business_date, status, gross_minor, fees_minor, refunds_minor, splits_minor, holds_minor, net_minor, provider_fees_minor, platform_fees_minor, fee_tax_minor, settlement_currency, settlement_amount_minor, conversion, item_count, due_at, closed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      userId,
      profile?.id ?? null,
      cur.code,
      rail,
      periodFrom,
      periodTo,
      businessDate,
      status,
      gross,
      fees,
      refunded,
      split,
      holds,
      net,
      providerFees,
      platformFees,
      feeTax,
      settlementCurrency,
      quote ? quote.toMinor : net,
      quote ? JSON.stringify(quote) : null,
      inputs.totals.itemCount,
      profile ? dueDate(profile.schedule, closedAt) : dueDate('T1', closedAt),
      now(),
      now(),
      now(),
    );
    const ins = db.prepare(
      'INSERT INTO settlement_items (id, cycle_id, transaction_id, intent_id, kind, amount_minor, fee_minor, provider_fee_minor, platform_fee_minor, fee_tax_minor, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const l of inRail)
      ins.run(uuid(), id, l.transaction.id, l.intentId, 'payment', l.amountMinor, l.feeMinor, l.providerFeeMinor, l.platformFeeMinor, l.feeTaxMinor, l.transaction.completed_at, now());
    for (const t of refunds) ins.run(uuid(), id, t.id, null, 'refund', -t.amount, 0, 0, 0, 0, t.completed_at, now());
    for (const t of splits) ins.run(uuid(), id, t.id, parseJson<any>(t.metadata, {}).intentId ?? null, 'split', -t.amount, 0, 0, 0, 0, t.completed_at, now());
    const hash = sha256(`${id}|${userId}|${cur.code}|${periodFrom}|${periodTo}|${gross}|${fees}|${refunded}|${split}|${holds}|${net}|${inRail.map((l) => l.transaction.id).join(',')}`);
    db.prepare('UPDATE settlement_cycles SET hash = ? WHERE id = ?').run(hash, id);
  })();
  recordEvent('ledger', id, 'settlement_cycle.closed', opts.actor ?? { type: 'system' }, {
    userId,
    currency: cur.code,
    rail,
    gross,
    fees,
    providerFees,
    platformFees,
    feeTax,
    refunded,
    split,
    holds,
    net,
    settlementCurrency,
    items: inRail.length,
  });
  if (status === 'CLOSED' && quote && profile?.autoConvert && net > 0) convertCycleObligation(id, opts.actor ?? { type: 'system' });
  const cycle = getCycle(null, id);
  if (status === 'CLOSED') {
    emitEvent(userId, 'payment_intent.settled', { settlementCycle: cycle }, { resource: { type: 'settlement_cycle', id } });
    publish('settlement.cycle_closed', { cycleId: id, merchantId: userId, currency: cur.code, netMinor: net, itemCount: inRail.length }, { aggregateId: id, tenantId: userId });
    publish(
      'settlement.closed',
      {
        userId,
        cycleId: id,
        currency: cur.code,
        amountMinor: net,
        settlementCurrency: cycle.settlementCurrency,
        settlementAmountMinor: cycle.settlementAmountMinor,
        providerFeesMinor: providerFees,
        platformFeesMinor: platformFees,
        feeTaxMinor: feeTax,
      },
      { aggregateId: id, tenantId: userId },
    );
  }
  return cycle;
}

/**
 * Convert a closed cycle's net obligation from the collection currency into the profile's settlement currency: an
 * `exchange` posting from the merchant's collection-currency wallet to its settlement-currency wallet at the platform
 * rate with the disclosed margin (the ledger books the two treasury FX legs). Idempotent; a shortfall is recorded on
 * the cycle and retried at payment time.
 */
export function convertCycleObligation(cycleId: string, actor: Actor): SettlementCycle {
  const db = getDb();
  const c = getCycle(null, cycleId);
  if (c.settlementCurrency === c.currency || c.netMinor <= 0) return c;
  if (c.conversion?.transactionId) return c;
  const quote = quoteConversion(c.currency, c.settlementCurrency, c.netMinor)!;
  const user = findUserById(c.userId)!;
  try {
    const from = getUserWallet(c.userId, c.currency);
    const to = ensureWallet(c.userId, c.settlementCurrency);
    const tx = postTransaction({
      type: 'exchange',
      amount: c.netMinor,
      currency: c.currency,
      receiveAmount: quote.toMinor,
      receiveCurrency: c.settlementCurrency,
      fromWalletId: from.id,
      toWalletId: to.id,
      senderUserId: user.id,
      receiverUserId: user.id,
      note: `Settlement ${cycleId}: ${c.currency} → ${c.settlementCurrency}`,
      metadata: { settlementCycleId: cycleId, rate: quote.rate, midRate: quote.midRate, marginBps: quote.marginBps, settlementConversion: true },
      idempotencyKey: `settlement_conversion:${cycleId}`,
    });
    const conversion: SettlementConversion = { ...quote, transactionId: tx.id, convertedAt: now(), error: null };
    db.prepare('UPDATE settlement_cycles SET conversion = ?, settlement_amount_minor = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(conversion), quote.toMinor, now(), cycleId);
    recordEvent('ledger', cycleId, 'settlement_cycle.converted', actor, { ...quote, transactionId: tx.id });
  } catch (err) {
    const conversion: SettlementConversion = { ...quote, transactionId: null, convertedAt: null, error: (err as Error).message };
    db.prepare('UPDATE settlement_cycles SET conversion = ?, settlement_amount_minor = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(conversion), quote.toMinor, now(), cycleId);
    recordEvent('ledger', cycleId, 'settlement_cycle.conversion_deferred', actor, { ...quote, error: (err as Error).message });
  }
  return getCycle(null, cycleId);
}

/** What the next cycle of a profile would settle right now, with the conversion into the settlement currency disclosed. */
export function previewProfile(userId: string, profileId: string) {
  const p = getProfile(userId, profileId);
  const inputs = collectCycleInputs(userId, p.currency, p.rail, { profileId: p.id });
  const cur = getCurrency(p.currency, false);
  const settleCur = getCurrency(p.settlementCurrency, false);
  const t = inputs.totals;
  // Nothing to settle yet: no conversion to disclose (the pair is still visible through collectionCurrency / settlementCurrency).
  const conversion = t.net > 0 ? quoteConversion(p.currency, p.settlementCurrency, t.net) : null;
  return {
    profile: p,
    collectionCurrency: p.currency,
    settlementCurrency: p.settlementCurrency,
    autoConvert: p.autoConvert,
    periodFrom: inputs.periodFrom,
    asOf: inputs.periodTo,
    itemCount: t.itemCount,
    wouldSkip: t.itemCount === 0,
    taxRateBps: inputs.taxRateBps,
    totals: {
      gross: t.gross,
      fees: t.fees,
      providerFees: t.providerFees,
      platformFees: t.platformFees,
      feeTax: t.feeTax,
      refunds: t.refunds,
      splits: t.splits,
      holds: t.holds,
      net: t.net,
      formatted: {
        gross: formatMoney(t.gross, cur),
        fees: formatMoney(t.fees, cur),
        providerFees: formatMoney(t.providerFees, cur),
        platformFees: formatMoney(t.platformFees, cur),
        feeTax: formatMoney(t.feeTax, cur),
        refunds: formatMoney(t.refunds, cur),
        splits: formatMoney(t.splits, cur),
        holds: formatMoney(t.holds, cur),
        net: formatMoney(t.net, cur),
      },
    },
    settlement: {
      currency: p.settlementCurrency,
      amountMinor: conversion ? conversion.toMinor : t.net,
      formatted: formatMoney(conversion ? conversion.toMinor : t.net, settleCur),
      conversion,
      convertsAt: conversion ? (p.autoConvert ? 'close' : 'payment') : null,
    },
    items: inputs.collections.map((l) => ({
      transactionId: l.transaction.id,
      reference: l.transaction.reference,
      intentId: l.intentId,
      amountMinor: l.amountMinor,
      feeMinor: l.feeMinor,
      providerFeeMinor: l.providerFeeMinor,
      platformFeeMinor: l.platformFeeMinor,
      feeTaxMinor: l.feeTaxMinor,
      occurredAt: l.transaction.completed_at,
    })),
  };
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
  return (
    getDb()
      .prepare(`SELECT * FROM settlement_cycles ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, Math.min(200, filter.limit ?? 50)) as any[]
  ).map(toCycle);
}
export function cycleItems(cycleId: string) {
  return (
    getDb()
      .prepare('SELECT si.*, t.reference, t.type, t.note FROM settlement_items si JOIN transactions t ON t.id = si.transaction_id WHERE si.cycle_id = ? ORDER BY si.occurred_at')
      .all(cycleId) as any[]
  ).map((r) => ({
    id: r.id,
    transactionId: r.transaction_id,
    reference: r.reference,
    intentId: r.intent_id,
    kind: r.kind,
    type: r.type,
    amountMinor: r.amount_minor,
    feeMinor: r.fee_minor,
    providerFeeMinor: r.provider_fee_minor ?? 0,
    platformFeeMinor: r.platform_fee_minor ?? 0,
    feeTaxMinor: r.fee_tax_minor ?? 0,
    note: r.note,
    occurredAt: r.occurred_at,
  }));
}

/** `GET /v1/settlements/:id`: the cycle with its items and the statement summary (separate fee and tax lines) embedded. */
export function settlementView(userId: string | null, id: string) {
  const c = getCycle(userId, id);
  const st = cycleStatement(c.id);
  return { ...c, items: st.items, statement: { number: st.number, totals: st.totals, settlement: st.settlement, hash: st.hash, generatedAt: st.generatedAt } };
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
  // A settlement currency that differs from the collection currency: convert now if the close did not (auto-convert off or deferred).
  const converted = c.settlementCurrency !== c.currency && c.netMinor > 0 ? convertCycleObligation(cycleId, actor) : c;
  const conversionPosted = !!converted.conversion?.transactionId;
  const payCurrency = conversionPosted ? converted.settlementCurrency : c.currency;
  const payNet = conversionPosted ? converted.settlementAmountMinor : c.netMinor;
  if (!dest) {
    // no external destination: the money simply stays available in the wallet (wallet settlement)
    db.prepare("UPDATE settlement_cycles SET status = 'PAID', paid_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), cycleId);
    recordEvent('ledger', cycleId, 'settlement_cycle.paid', actor, { method: 'wallet', net: c.netMinor, currency: payCurrency, amount: payNet });
    publishSettlementPaid(getCycle(null, cycleId), 'wallet', payCurrency, payNet);
    return getCycle(null, cycleId);
  }
  const wallet = getUserWallet(c.userId, payCurrency);
  const payable = Math.min(payNet, Math.max(0, wallet.balance - heldAmount(wallet.id)));
  if (profile && payable > 0) assertDestinationUsable(user, 'settlement_profile', profile.id, toBase(payable, payCurrency));
  if (payable <= 0 || payable < (profile?.minAmount ?? 0)) {
    db.prepare("UPDATE settlement_cycles SET status = 'FAILED', failure = ?, updated_at = ? WHERE id = ?").run(
      payable <= 0 ? 'nothing available to settle (holds or prior withdrawals)' : `below the minimum of ${profile?.minAmount}`,
      now(),
      cycleId,
    );
    return getCycle(null, cycleId);
  }
  try {
    const tx = requestWithdrawal(user, { amount: payable, currency: payCurrency, destination: dest, note: `Settlement ${cycleId} (${c.periodFrom.slice(0, 10)} → ${c.periodTo.slice(0, 10)})` });
    const settlementId = uuid();
    db.prepare("INSERT INTO settlements (id, user_id, bank_account_id, amount, currency, status, transaction_id, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)").run(
      settlementId,
      c.userId,
      'bankAccountId' in dest ? dest.bankAccountId : null,
      payable,
      payCurrency,
      tx.id,
      now(),
    );
    db.prepare("UPDATE settlement_cycles SET status = 'PAYING', withdrawal_transaction_id = ?, settlement_id = ?, updated_at = ? WHERE id = ?").run(tx.id, settlementId, now(), cycleId);
    recordEvent('ledger', cycleId, 'settlement_cycle.paying', actor, { transactionId: tx.id, amount: payable, currency: payCurrency });
    notify(c.userId, 'Settlement on its way', `${formatMoney(payable, getCurrency(payCurrency, false))} from cycle ${c.periodTo.slice(0, 10)} is being paid out.`, { kind: 'payout', cycleId });
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
  if (outcome === 'completed') {
    const paidRow = db.prepare('SELECT amount, currency FROM settlements WHERE transaction_id = ?').get(transactionId) as { amount: number; currency: string } | undefined;
    const cycle = getCycle(null, c.id);
    publishSettlementPaid(cycle, 'withdrawal', paidRow?.currency ?? cycle.settlementCurrency, paidRow?.amount ?? cycle.settlementAmountMinor);
  }
}

/**
 * §62 `settlement.paid`: the obligation reached the merchant (wallet settlement or completed withdrawal). `currency` /
 * `amountMinor` are what was actually paid: the settlement currency once the conversion is posted, else the collection currency.
 */
function publishSettlementPaid(c: SettlementCycle, method: 'wallet' | 'withdrawal', currency: string, amountMinor: number) {
  publish(
    'settlement.paid',
    {
      userId: c.userId,
      cycleId: c.id,
      currency,
      amountMinor,
      settlementCurrency: c.settlementCurrency,
      settlementAmountMinor: c.settlementAmountMinor,
      collectionCurrency: c.currency,
      netMinor: c.netMinor,
      method,
      withdrawalTransactionId: c.withdrawalTransactionId,
    },
    { aggregateId: c.id, tenantId: c.userId },
  );
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
    const already =
      db.prepare("SELECT 1 FROM settlement_cycles WHERE profile_id = ? AND business_date = ? AND status != 'SKIPPED'").get(p.id, today) ??
      db.prepare('SELECT 1 FROM settlement_cycles WHERE profile_id = ? AND business_date = ?').get(p.id, today);
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
  const settleCur = getCurrency(c.settlementCurrency, false);
  return {
    number: `SET-${c.businessDate.replace(/-/g, '')}-${c.id.slice(3, 9).toUpperCase()}`,
    cycle: c,
    merchant: { id: user.id, name: user.business_name || user.full_name, tag: user.tag, country: user.country },
    currency: cur.code,
    totals: {
      gross: c.grossMinor,
      /** Total deducted from the merchant (= platformFees + feeTax). Never the only figure shown. */
      fees: c.feesMinor,
      providerFees: c.providerFeesMinor,
      platformFees: c.platformFeesMinor,
      feeTax: c.feeTaxMinor,
      taxRateBps: feeTaxRateBps(),
      taxLabel: getFinopsSettings().feeTaxLabel,
      refunds: c.refundsMinor,
      splits: c.splitsMinor,
      holds: c.holdsMinor,
      net: c.netMinor,
      formatted: {
        gross: formatMoney(c.grossMinor, cur),
        fees: formatMoney(c.feesMinor, cur),
        providerFees: formatMoney(c.providerFeesMinor, cur),
        platformFees: formatMoney(c.platformFeesMinor, cur),
        feeTax: formatMoney(c.feeTaxMinor, cur),
        refunds: formatMoney(c.refundsMinor, cur),
        splits: formatMoney(c.splitsMinor, cur),
        holds: formatMoney(c.holdsMinor, cur),
        net: formatMoney(c.netMinor, cur),
      },
    },
    settlement: {
      currency: c.settlementCurrency,
      amountMinor: c.settlementAmountMinor,
      formatted: formatMoney(c.settlementAmountMinor, settleCur),
      conversion: c.conversion,
    },
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
  const head = [
    `# ${config.appName} settlement statement ${s.number}`,
    `# Merchant: ${s.merchant.name} (@${s.merchant.tag})`,
    `# Period: ${s.cycle.periodFrom} to ${s.cycle.periodTo} · ${s.currency}`,
    `# Gross ${money(s.totals.gross)} · Fees ${money(s.totals.fees)} · Refunds ${money(s.totals.refunds)} · Splits ${money(s.totals.splits)} · Holds ${money(s.totals.holds)} · Net ${money(s.totals.net)}`,
    `# Provider fee ${money(s.totals.providerFees)} · BitriPay fee ${money(s.totals.platformFees)} · Tax on BitriPay fee ${money(s.totals.feeTax)} (${s.totals.taxLabel} ${s.totals.taxRateBps / 100}%)`,
    ...(s.settlement.currency !== s.currency
      ? [
          `# Settlement: ${s.settlement.formatted} ${s.settlement.currency}${s.settlement.conversion ? ` at ${s.settlement.conversion.rate} (mid ${s.settlement.conversion.midRate}, margin ${s.settlement.conversion.marginBps} bps${s.settlement.conversion.transactionId ? `, posted ${s.settlement.conversion.transactionId}` : ', quoted'})` : ''}`,
        ]
      : []),
    `# Hash: ${s.hash}`,
  ];
  const rows = [['Date', 'Reference', 'Kind', 'Description', 'Amount', 'Fee', 'Provider fee', 'BitriPay fee', 'Tax on BitriPay fee'].join(',')];
  for (const i of s.items)
    rows.push([i.occurredAt, i.reference, i.kind, q(i.note), money(i.amountMinor), money(i.feeMinor), money(i.providerFeeMinor), money(i.platformFeeMinor), money(i.feeTaxMinor)].join(','));
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
  doc.pair('  of which BitriPay fee', `− ${money(s.totals.platformFees)}`);
  doc.pair(`  of which tax on BitriPay fee (${s.totals.taxLabel} ${s.totals.taxRateBps / 100}%)`, `− ${money(s.totals.feeTax)}`);
  doc.pair('Provider (rail) fee, borne by BitriPay', money(s.totals.providerFees));
  doc.pair('Refunds', `− ${money(s.totals.refunds)}`);
  doc.pair('Split payments', `− ${money(s.totals.splits)}`);
  doc.pair('Holds', `− ${money(s.totals.holds)}`);
  doc.pair('Net settlement', money(s.totals.net), { size: 11 });
  if (s.settlement.currency !== s.currency) {
    doc.pair(`Paid in ${s.settlement.currency}`, s.settlement.formatted, { size: 11 });
    if (s.settlement.conversion)
      doc.pair(
        'Conversion',
        `1 ${s.currency} = ${s.settlement.conversion.rate.toFixed(6)} ${s.settlement.currency} (mid ${s.settlement.conversion.midRate.toFixed(6)}, margin ${s.settlement.conversion.marginBps} bps) · ${s.settlement.conversion.transactionId ? `posted ${s.settlement.conversion.transactionId}` : 'quoted, posted at payment'}`,
      );
  }
  doc.space(10);
  doc.text(`Items (${s.items.length})`, { size: 12, bold: true });
  doc.space(4);
  const rows = s.items.map((i) => [
    i.occurredAt.slice(0, 16).replace('T', ' '),
    i.reference,
    i.kind,
    (i.note ?? '').slice(0, 24),
    money(i.amountMinor),
    money(i.feeMinor),
    money(i.providerFeeMinor),
    money(i.platformFeeMinor),
    money(i.feeTaxMinor),
  ]);
  if (rows.length)
    doc.table(
      [
        { title: 'Date', width: 64 },
        { title: 'Reference', width: 58 },
        { title: 'Kind', width: 40 },
        { title: 'Description', width: 93 },
        { title: 'Amount', width: 66, align: 'right' as const },
        { title: 'Fee', width: 52, align: 'right' as const },
        { title: 'Provider', width: 48, align: 'right' as const },
        { title: 'BitriPay', width: 50, align: 'right' as const },
        { title: 'Tax', width: 44, align: 'right' as const },
      ],
      rows,
      { zebra: true, size: 7 },
    );
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
