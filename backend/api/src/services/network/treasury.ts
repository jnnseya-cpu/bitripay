/**
 * Treasury for the corridor network: how much liquidity the next hours of payouts will need at each counterparty,
 * how much is there now, and the top-up that closes the gap.
 *
 * The forecast is measured, not assumed: it reads what actually left each of the counterparty's liquidity accounts
 * over a lookback window and projects that rate over the horizon, then applies the counterparty's safety factor.
 * A top-up is proposed by one administrator and approved by another before any money moves, and when it executes it
 * goes through `prefundAccount` — the same posting, the same ledger, the same reserve hook as a prefund made by
 * hand. Nothing here is a second way to move money.
 */
import { getDb } from '../../db';
import { uuid, now } from '../../lib/ids';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { recordEvent } from '../events';
import { getPayoutAccount, prefundAccount } from '../liquidity';
import { getCounterparty, listCounterparties, counterpartyFloat, type NetworkCounterparty } from './registry';
import type { UserRow } from '../users';

export const DEFAULT_HORIZON_HOURS = 48;
export const DEFAULT_LOOKBACK_DAYS = 14;

export type TopupStatus = 'proposed' | 'approved' | 'rejected' | 'executed' | 'failed';

export interface TreasuryForecast {
  id: string;
  counterpartyId: string;
  counterpartyName: string;
  currency: string;
  horizonHours: number;
  lookbackDays: number;
  /** Expected outflow over the horizon, from the measured rate. */
  forecastMinor: number;
  balanceMinor: number;
  safetyFactorBps: number;
  /** forecast × safety factor: the float the counterparty should be carrying. */
  requiredMinor: number;
  shortfallMinor: number;
  basis: { observedOutflowMinor: number; observedDays: number; dailyRateMinor: number; payoutCount: number; accounts: string[] };
  createdAt: string;
}

export interface TreasuryTopup {
  id: string;
  counterpartyId: string;
  counterpartyName: string;
  payoutAccountId: string | null;
  currency: string;
  amountMinor: number;
  status: TopupStatus;
  reason: string;
  forecastId: string | null;
  proposedBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  executedAt: string | null;
  rejectedReason: string | null;
  movementReference: string | null;
  createdAt: string;
}

const nameOf = (id: string): string => {
  try {
    return getCounterparty(id).name;
  } catch {
    return id;
  }
};

function forecastRow(r: any): TreasuryForecast {
  return {
    id: r.id,
    counterpartyId: r.counterparty_id,
    counterpartyName: nameOf(r.counterparty_id),
    currency: r.currency,
    horizonHours: r.horizon_hours,
    lookbackDays: r.lookback_days,
    forecastMinor: r.forecast_minor,
    balanceMinor: r.balance_minor,
    safetyFactorBps: r.safety_factor_bps,
    requiredMinor: r.required_minor,
    shortfallMinor: r.shortfall_minor,
    basis: JSON.parse(r.basis || '{}'),
    createdAt: r.created_at,
  };
}

function topupRow(r: any): TreasuryTopup {
  return {
    id: r.id,
    counterpartyId: r.counterparty_id,
    counterpartyName: nameOf(r.counterparty_id),
    payoutAccountId: r.payout_account_id ?? null,
    currency: r.currency,
    amountMinor: r.amount_minor,
    status: r.status,
    reason: r.reason,
    forecastId: r.forecast_id ?? null,
    proposedBy: r.proposed_by,
    approvedBy: r.approved_by ?? null,
    approvedAt: r.approved_at ?? null,
    executedAt: r.executed_at ?? null,
    rejectedReason: r.rejected_reason ?? null,
    movementReference: r.movement_reference ?? null,
    createdAt: r.created_at,
  };
}

/**
 * What left this counterparty's float in the lookback window. Payout movements are negative on the liquidity
 * account, so the outflow is their absolute sum; prefunds and adjustments are not outflow and are left out.
 */
function observedOutflow(cp: NetworkCounterparty, currency: string, lookbackDays: number): { outflowMinor: number; payoutCount: number; accounts: string[] } {
  const accounts = cp.payoutAccountIds.filter((id) => {
    try {
      return getPayoutAccount(id).currency === currency;
    } catch {
      return false;
    }
  });
  if (!accounts.length) return { outflowMinor: 0, payoutCount: 0, accounts: [] };
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
  const placeholders = accounts.map(() => '?').join(', ');
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) outflow, COUNT(*) n
         FROM liquidity_movements WHERE payout_account_id IN (${placeholders}) AND currency = ? AND kind = 'payout' AND created_at >= ?`,
    )
    .get(...accounts, currency, since) as { outflow: number; n: number };
  return { outflowMinor: row.outflow, payoutCount: row.n, accounts };
}

export interface ForecastOptions {
  horizonHours?: number;
  lookbackDays?: number;
  /** Store the forecast so a top-up can cite it. Previews do not. */
  persist?: boolean;
}

/** Forecast one counterparty and currency. Returns the forecast whether or not there is a shortfall. */
export function forecastCounterparty(counterpartyId: string, currency: string, opts: ForecastOptions = {}): TreasuryForecast {
  const cp = getCounterparty(counterpartyId);
  if (!cp.currencies.includes(currency)) throw badRequest(`${cp.name} does not settle in ${currency}.`, 'unsupported_currency');
  const horizonHours = opts.horizonHours ?? DEFAULT_HORIZON_HOURS;
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  if (horizonHours < 1 || horizonHours > 720) throw badRequest('The horizon is between 1 hour and 30 days');
  if (lookbackDays < 1 || lookbackDays > 180) throw badRequest('The lookback is between 1 and 180 days');

  const observed = observedOutflow(cp, currency, lookbackDays);
  const dailyRateMinor = Math.round(observed.outflowMinor / lookbackDays);
  const forecastMinor = Math.round((dailyRateMinor * horizonHours) / 24);
  const balanceMinor = counterpartyFloat(cp.id).find((f) => f.currency === currency)?.balanceMinor ?? 0;
  const requiredMinor = Math.round((forecastMinor * cp.safetyFactorBps) / 10_000);
  const shortfallMinor = Math.max(0, requiredMinor - balanceMinor);

  const id = uuid();
  const basis = { observedOutflowMinor: observed.outflowMinor, observedDays: lookbackDays, dailyRateMinor, payoutCount: observed.payoutCount, accounts: observed.accounts };
  if (opts.persist !== false) {
    getDb()
      .prepare(
        `INSERT INTO network_treasury_forecasts (id, counterparty_id, currency, horizon_hours, lookback_days, forecast_minor, balance_minor, safety_factor_bps, required_minor, shortfall_minor, basis, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, cp.id, currency, horizonHours, lookbackDays, forecastMinor, balanceMinor, cp.safetyFactorBps, requiredMinor, shortfallMinor, JSON.stringify(basis), now());
  }
  return {
    id,
    counterpartyId: cp.id,
    counterpartyName: cp.name,
    currency,
    horizonHours,
    lookbackDays,
    forecastMinor,
    balanceMinor,
    safetyFactorBps: cp.safetyFactorBps,
    requiredMinor,
    shortfallMinor,
    basis,
    createdAt: now(),
  };
}

/** Forecast every active counterparty in every currency it settles in. Run on a schedule or from the console. */
export function forecastAll(opts: ForecastOptions = {}): TreasuryForecast[] {
  const out: TreasuryForecast[] = [];
  for (const cp of listCounterparties({ status: 'active' })) {
    for (const currency of cp.currencies) out.push(forecastCounterparty(cp.id, currency, opts));
  }
  return out.sort((a, b) => b.shortfallMinor - a.shortfallMinor);
}

export function listForecasts(filter: { counterpartyId?: string | null; limit?: number } = {}): TreasuryForecast[] {
  const where = filter.counterpartyId ? 'WHERE counterparty_id = ?' : '';
  const args = filter.counterpartyId ? [filter.counterpartyId] : [];
  return (
    getDb()
      .prepare(`SELECT * FROM network_treasury_forecasts ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...args, Math.min(filter.limit ?? 100, 500)) as any[]
  ).map(forecastRow);
}

// ------------------------------------------------------------------ top-ups

export function listTopups(filter: { status?: TopupStatus | null; counterpartyId?: string | null; limit?: number } = {}): TreasuryTopup[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.status) {
    where.push('status = ?');
    args.push(filter.status);
  }
  if (filter.counterpartyId) {
    where.push('counterparty_id = ?');
    args.push(filter.counterpartyId);
  }
  const sql = `SELECT * FROM network_treasury_topups ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
  return (
    getDb()
      .prepare(sql)
      .all(...args, Math.min(filter.limit ?? 100, 500)) as any[]
  ).map(topupRow);
}

export function getTopup(id: string): TreasuryTopup {
  const r = getDb().prepare('SELECT * FROM network_treasury_topups WHERE id = ?').get(id) as any;
  if (!r) throw notFound('Unknown top-up', 'topup_not_found');
  return topupRow(r);
}

export interface TopupInput {
  counterpartyId: string;
  currency: string;
  amountMinor: number;
  reason: string;
  payoutAccountId?: string | null;
  forecastId?: string | null;
}

export function proposeTopup(input: TopupInput, admin: UserRow): TreasuryTopup {
  const cp = getCounterparty(input.counterpartyId);
  if (cp.status !== 'active') throw badRequest(`${cp.name} is ${cp.status}: activate it before prefunding it.`, 'counterparty_not_active');
  if (!cp.currencies.includes(input.currency)) throw badRequest(`${cp.name} does not settle in ${input.currency}.`, 'unsupported_currency');
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) throw badRequest('Amount must be a positive integer in minor units', 'invalid_amount');
  if (!input.reason.trim()) throw badRequest('Say why this prefunding is needed.');
  const accountId = input.payoutAccountId ?? cp.payoutAccountIds.find((id) => getPayoutAccount(id).currency === input.currency) ?? null;
  if (!accountId) throw badRequest(`No liquidity account in ${input.currency} is linked to ${cp.name}.`, 'float_account_required');
  const account = getPayoutAccount(accountId);
  if (account.currency !== input.currency) throw badRequest(`${account.label} holds ${account.currency}, not ${input.currency}.`, 'unsupported_currency');
  if (!cp.payoutAccountIds.includes(accountId)) throw badRequest(`${account.label} is not linked to ${cp.name}.`, 'account_not_linked');

  const id = uuid();
  getDb()
    .prepare(
      `INSERT INTO network_treasury_topups (id, counterparty_id, payout_account_id, currency, amount_minor, status, reason, forecast_id, proposed_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?)`,
    )
    .run(id, cp.id, accountId, input.currency, input.amountMinor, input.reason, input.forecastId ?? null, admin.id, now());
  recordEvent('network', id, 'network.topup.proposed', { type: 'admin', id: admin.id }, { counterparty: cp.name, currency: input.currency, amount: input.amountMinor, reason: input.reason });
  return getTopup(id);
}

/** Propose a top-up for every shortfall a fresh forecast finds, skipping counterparties that already have one waiting. */
export function proposeTopupsForShortfalls(admin: UserRow, opts: ForecastOptions = {}): TreasuryTopup[] {
  const pending = new Set(listTopups({ status: 'proposed' }).map((t) => `${t.counterpartyId}:${t.currency}`));
  const approved = new Set(listTopups({ status: 'approved' }).map((t) => `${t.counterpartyId}:${t.currency}`));
  const out: TreasuryTopup[] = [];
  for (const f of forecastAll(opts)) {
    const key = `${f.counterpartyId}:${f.currency}`;
    if (!f.shortfallMinor || pending.has(key) || approved.has(key)) continue;
    const cp = getCounterparty(f.counterpartyId);
    if (cp.status !== 'active' || !cp.payoutAccountIds.length) continue;
    out.push(
      proposeTopup(
        {
          counterpartyId: f.counterpartyId,
          currency: f.currency,
          amountMinor: f.shortfallMinor,
          reason: `Forecast shortfall over ${f.horizonHours} h at a safety factor of ${(f.safetyFactorBps / 10_000).toFixed(2)}×`,
          forecastId: f.id,
        },
        admin,
      ),
    );
    pending.add(key);
  }
  return out;
}

/** Four eyes: the administrator who proposed the prefunding may not approve it. */
export function approveTopup(id: string, admin: UserRow): TreasuryTopup {
  const t = getTopup(id);
  if (t.status !== 'proposed') throw conflict(`This top-up is ${t.status}.`, 'topup_not_proposed');
  if (t.proposedBy === admin.id) throw badRequest('Prefunding is approved by a second administrator.', 'approver_required');
  getDb().prepare("UPDATE network_treasury_topups SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?").run(admin.id, now(), id);
  recordEvent('network', id, 'network.topup.approved', { type: 'admin', id: admin.id }, { counterparty: t.counterpartyName, amount: t.amountMinor });
  return getTopup(id);
}

export function rejectTopup(id: string, reason: string, admin: UserRow): TreasuryTopup {
  const t = getTopup(id);
  if (t.status !== 'proposed' && t.status !== 'approved') throw conflict(`This top-up is ${t.status}.`, 'topup_not_pending');
  if (!reason.trim()) throw badRequest('Say why the prefunding is refused.');
  getDb().prepare("UPDATE network_treasury_topups SET status = 'rejected', rejected_reason = ? WHERE id = ?").run(reason, id);
  recordEvent('network', id, 'network.topup.rejected', { type: 'admin', id: admin.id }, { counterparty: t.counterpartyName, reason });
  return getTopup(id);
}

/**
 * Execute an approved top-up: one prefund on the linked liquidity account, through the existing posting path, so the
 * ledger, the reserve hook and the liquidity movement log all see exactly what they would see from a manual prefund.
 */
export function executeTopup(id: string, admin: UserRow): TreasuryTopup {
  const t = getTopup(id);
  if (t.status !== 'approved') throw conflict('A top-up is executed after a second administrator has approved it.', 'topup_not_approved');
  if (!t.payoutAccountId) throw badRequest('This top-up has no liquidity account to prefund.', 'float_account_required');
  const reference = `TOPUP-${t.id.slice(0, 8).toUpperCase()}`;
  try {
    prefundAccount(t.payoutAccountId, t.amountMinor, { reference, note: t.reason }, admin);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Prefunding failed';
    getDb().prepare("UPDATE network_treasury_topups SET status = 'failed', rejected_reason = ? WHERE id = ?").run(message, id);
    recordEvent('network', id, 'network.topup.failed', { type: 'admin', id: admin.id }, { counterparty: t.counterpartyName, reason: message });
    throw err;
  }
  getDb().prepare("UPDATE network_treasury_topups SET status = 'executed', executed_at = ?, movement_reference = ? WHERE id = ?").run(now(), reference, id);
  recordEvent('network', id, 'network.topup.executed', { type: 'admin', id: admin.id }, { counterparty: t.counterpartyName, amount: t.amountMinor, reference });
  return getTopup(id);
}

/** The daily treasury picture: float by counterparty, forecast need, exposure against limit, what waits on a person. */
export function treasuryReport(opts: ForecastOptions = {}) {
  const forecasts = forecastAll({ ...opts, persist: false });
  const counterparties = listCounterparties();
  const exposure = counterparties.flatMap((cp) =>
    counterpartyFloat(cp.id).map((f) => ({
      counterpartyId: cp.id,
      counterparty: cp.name,
      kind: cp.kind,
      currency: f.currency,
      balanceMinor: f.balanceMinor,
      exposureLimitMinor: f.exposureLimitMinor,
      utilisationBps: f.utilisationBps,
      overLimit: f.overLimit,
    })),
  );
  const topups = listTopups({ limit: 100 });
  return {
    forecasts,
    exposure,
    shortfalls: forecasts.filter((f) => f.shortfallMinor > 0),
    overLimit: exposure.filter((e) => e.overLimit),
    topups,
    waiting: {
      awaitingApproval: topups.filter((t) => t.status === 'proposed').length,
      awaitingExecution: topups.filter((t) => t.status === 'approved').length,
    },
  };
}
