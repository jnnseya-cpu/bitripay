/**
 * Commission ledger for agents (and referrers): every commission credited by a transaction is recorded as an entry
 * with its period, kind and the platform's share, so agents get a statement and finance sees the cost of the network.
 * The credit itself is still posted by the transaction's fee split (unchanged); this is the analytical ledger on top.
 */
import { getDb } from '../../db';
import { now, shortCode } from '../../lib/ids';
import { parseJson } from '../../lib/json';
import { getSetting } from '../settings';
import { findUserById } from '../users';
import { getCurrency } from '../currencies';
import { formatMoney } from '@bitripay/shared';

export interface CommissionSettings {
  /** Share of every agent commission retained by the platform (bps of the commission). */
  platformShareBps: number;
  /** Minimum accrued amount (base currency minor units) before an on-demand payout statement is issued. */
  payoutThreshold: number;
  onboardingFeeMinor: number;
}
const DEFAULT: CommissionSettings = { platformShareBps: 0, payoutThreshold: 5_000, onboardingFeeMinor: 200 };
export const getCommissionSettings = (): CommissionSettings => ({ ...DEFAULT, ...getSetting<Partial<CommissionSettings>>('commissions', {}) });

export type CommissionKind = 'cash_in' | 'cash_out' | 'onboarding' | 'bill_assisted' | 'topup_assisted' | 'remittance_payout' | 'referral';
export interface CommissionEntry {
  id: string;
  agentUserId: string;
  transactionId: string | null;
  kind: CommissionKind;
  amountMinor: number;
  platformShareMinor: number;
  currency: string;
  status: 'CREDITED' | 'ACCRUED' | 'PAID' | 'REVERSED';
  period: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}
const toView = (r: any): CommissionEntry => ({
  id: r.id,
  agentUserId: r.agent_user_id,
  transactionId: r.transaction_id,
  kind: r.kind,
  amountMinor: r.amount_minor,
  platformShareMinor: r.platform_share_minor,
  currency: r.currency,
  status: r.status,
  period: r.period,
  metadata: parseJson(r.metadata, {}),
  createdAt: r.created_at,
});

export function recordCommission(input: {
  agentUserId: string;
  transactionId?: string | null;
  kind: CommissionKind;
  amountMinor: number;
  currency: string;
  status?: CommissionEntry['status'];
  metadata?: Record<string, unknown>;
}): CommissionEntry {
  const settings = getCommissionSettings();
  const share = Math.round((input.amountMinor * settings.platformShareBps) / 10_000);
  const id = `cm_${shortCode(12).toLowerCase()}`;
  getDb()
    .prepare(
      'INSERT INTO commission_entries (id, agent_user_id, transaction_id, kind, amount_minor, platform_share_minor, currency, status, period, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      id,
      input.agentUserId,
      input.transactionId ?? null,
      input.kind,
      input.amountMinor,
      share,
      input.currency,
      input.status ?? 'CREDITED',
      now().slice(0, 7),
      JSON.stringify(input.metadata ?? {}),
      now(),
    );
  return toView(getDb().prepare('SELECT * FROM commission_entries WHERE id = ?').get(id));
}

export function listCommissions(agentUserId: string, filter: { period?: string | null; limit?: number } = {}): CommissionEntry[] {
  return (
    getDb()
      .prepare(`SELECT * FROM commission_entries WHERE agent_user_id = ? ${filter.period ? 'AND period = ?' : ''} ORDER BY created_at DESC LIMIT ?`)
      .all(...(filter.period ? [agentUserId, filter.period] : [agentUserId]), Math.min(500, filter.limit ?? 100)) as any[]
  ).map(toView);
}

/** Period statement: totals per kind and currency, platform share, entries. */
export function commissionStatement(agentUserId: string, period = now().slice(0, 7)) {
  const agent = findUserById(agentUserId);
  const entries = listCommissions(agentUserId, { period, limit: 500 });
  const totals: Record<string, { earned: number; platformShare: number; count: number; byKind: Record<string, number> }> = {};
  for (const e of entries) {
    totals[e.currency] ??= { earned: 0, platformShare: 0, count: 0, byKind: {} };
    totals[e.currency].earned += e.amountMinor;
    totals[e.currency].platformShare += e.platformShareMinor;
    totals[e.currency].count += 1;
    totals[e.currency].byKind[e.kind] = (totals[e.currency].byKind[e.kind] ?? 0) + e.amountMinor;
  }
  return {
    agent: agent ? { id: agent.id, name: agent.business_name || agent.full_name, tag: agent.tag } : null,
    period,
    totals: Object.fromEntries(Object.entries(totals).map(([cur, t]) => [cur, { ...t, earnedFormatted: formatMoney(t.earned, getCurrency(cur, false)) }])),
    entries,
    generatedAt: now(),
  };
}

/** Finance view: commissions across the network for a period. */
export function commissionOverview(period = now().slice(0, 7)) {
  const rows = getDb()
    .prepare('SELECT agent_user_id, currency, kind, COUNT(*) n, SUM(amount_minor) s, SUM(platform_share_minor) p FROM commission_entries WHERE period = ? GROUP BY agent_user_id, currency, kind')
    .all(period) as any[];
  return { period, rows: rows.map((r) => ({ agentUserId: r.agent_user_id, currency: r.currency, kind: r.kind, count: r.n, amountMinor: r.s, platformShareMinor: r.p })) };
}
