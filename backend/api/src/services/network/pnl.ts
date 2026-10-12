/**
 * What a corridor actually earns, line by line, from the records that already exist.
 *
 * Every line names its source, and a line the platform cannot yet derive is returned as `null` with the reason —
 * never as a zero. A dashboard that shows 0 for "partner cost" when nobody has recorded a partner cost is worse than
 * one that says the figure is not known: the first invites a decision, the second asks for the data.
 *
 * The contribution is only computed when every line it needs is known, so a corridor is never declared profitable
 * on a sum that quietly left a cost out.
 */
import { getDb } from '../../db';
import { parseJson } from '../../lib/json';
import { getSetting } from '../settings';
import { getNetworkCorridor, listNetworkCorridors, type NetworkCorridor } from './registry';

export interface PnlLine {
  key: string;
  label: string;
  /** Positive is income, negative is cost. Null means the platform has no record to derive it from. */
  amountMinor: number | null;
  source: string;
  note?: string;
}

export interface CorridorPnl {
  corridor: string;
  name: string;
  currency: string;
  from: string;
  to: string;
  paymentCount: number;
  volumeMinor: number;
  lines: PnlLine[];
  /** Sum of every known line, or null when any line is unknown. */
  contributionMinor: number | null;
  contributionPerPaymentMinor: number | null;
  /** Contribution as a share of volume, in basis points. */
  marginBps: number | null;
  unknownLines: string[];
}

/** Annual cost of the money BitriPay leaves sitting at partners, in basis points. 0 until a facility is recorded. */
const FUNDING_COST_KEY = 'network.fundingCostBps';

export function fundingCostBps(): number {
  const value = getSetting<number>(FUNDING_COST_KEY, 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function period(from?: string | null, to?: string | null): { from: string; to: string } {
  const end = to ?? new Date().toISOString();
  const start = from ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
  return { from: start, to: end };
}

/**
 * The settled payouts of a corridor in a period. A network corridor is linked to the operational corridor that
 * carries it; without that link there is nothing to measure yet, and the P&L says so rather than guessing.
 */
function settledPayouts(corridor: NetworkCorridor, from: string, to: string): { id: string; amount: number; currency: string; transaction_id: string }[] {
  if (!corridor.corridorId) return [];
  return getDb()
    .prepare("SELECT id, amount, currency, transaction_id FROM payout_instructions WHERE corridor_id = ? AND stage = 'SETTLED' AND updated_at BETWEEN ? AND ?")
    .all(corridor.corridorId, from, to) as any[];
}

export function corridorPnl(codeOrId: string, opts: { from?: string | null; to?: string | null } = {}): CorridorPnl {
  const corridor = getNetworkCorridor(codeOrId);
  const { from, to } = period(opts.from, opts.to);
  const db = getDb();
  const payouts = settledPayouts(corridor, from, to);
  const volumeMinor = payouts.reduce((n, p) => n + p.amount, 0);
  const txIds = payouts.map((p) => p.transaction_id).filter(Boolean);

  const lines: PnlLine[] = [];

  if (!corridor.corridorId) {
    lines.push({
      key: 'link',
      label: 'Fee revenue',
      amountMinor: null,
      source: 'payout instructions',
      note: 'This corridor is not linked to an operational corridor yet, so no payment can be attributed to it.',
    });
  } else {
    const placeholders = txIds.map(() => '?').join(', ');
    const feeRevenue = txIds.length ? ((db.prepare(`SELECT COALESCE(SUM(fee), 0) s FROM transactions WHERE id IN (${placeholders})`).get(...txIds) as { s: number }).s ?? 0) : 0;
    lines.push({ key: 'fees', label: 'Fee revenue', amountMinor: feeRevenue, source: 'the fee booked on each settled payment of this corridor' });

    // FX margin: only the conversions that were actually posted carry a margin, and only those are counted.
    let fxMargin = 0;
    let fxConversions = 0;
    if (txIds.length) {
      const rows = db.prepare(`SELECT amount, metadata FROM transactions WHERE id IN (${placeholders})`).all(...txIds) as { amount: number; metadata: string }[];
      for (const r of rows) {
        const meta = parseJson<Record<string, any>>(r.metadata, {});
        const bps = Number(meta.marginBps);
        if (Number.isFinite(bps) && bps > 0) {
          fxMargin += Math.round((r.amount * bps) / 10_000);
          fxConversions += 1;
        }
      }
    }
    lines.push({
      key: 'fx',
      label: 'Foreign-exchange margin',
      amountMinor: fxMargin,
      source: 'the margin recorded on each posted conversion',
      note: fxConversions ? `${fxConversions} conversion${fxConversions > 1 ? 's' : ''} in the period` : 'no conversion was posted in the period',
    });

    // Partner cost: what a provider kept, as reconciled. Null when no reconciliation line exists for any payment.
    let partnerCost = 0;
    let costed = 0;
    for (const p of payouts) {
      const line = db.prepare('SELECT fee_minor FROM reconciliation_lines WHERE matched_payment_id = ? AND fee_minor IS NOT NULL ORDER BY rowid DESC LIMIT 1').get(p.id) as
        { fee_minor: number } | undefined;
      if (line) {
        partnerCost += Math.max(0, Math.round(line.fee_minor));
        costed += 1;
      }
    }
    lines.push({
      key: 'partner_cost',
      label: 'Partner cost',
      amountMinor: payouts.length === 0 ? 0 : costed === 0 ? null : -partnerCost,
      source: 'the fee each partner kept, from its reconciled statement',
      note:
        payouts.length === 0
          ? 'no settled payment in the period'
          : costed === 0
            ? 'no partner statement has been reconciled for these payments yet'
            : `${costed} of ${payouts.length} payments carry a reconciled partner fee`,
    });
  }

  // Cost of carry on the liquidity sitting at the corridor's partners.
  const bps = fundingCostBps();
  const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000));
  const floatRow = db
    .prepare("SELECT COALESCE(SUM(w.balance), 0) s FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.is_system = 1 AND u.tag LIKE 'payout_%' AND w.currency = ?")
    .get(corridor.settlementCurrency) as { s: number };
  lines.push({
    key: 'funding',
    label: 'Cost of prefunding',
    amountMinor: bps === 0 ? null : -Math.round((floatRow.s * bps * days) / (10_000 * 365)),
    source: `the float held at partners in ${corridor.settlementCurrency} over ${days} day${days > 1 ? 's' : ''}`,
    note: bps === 0 ? `No funding cost is configured (${FUNDING_COST_KEY}); until a facility exists there is no rate to apply.` : `at ${(bps / 100).toFixed(2)} % a year`,
  });

  const unknownLines = lines.filter((l) => l.amountMinor === null).map((l) => l.label);
  const contributionMinor = unknownLines.length ? null : lines.reduce((n, l) => n + (l.amountMinor ?? 0), 0);
  return {
    corridor: corridor.code,
    name: corridor.name,
    currency: corridor.settlementCurrency,
    from,
    to,
    paymentCount: payouts.length,
    volumeMinor,
    lines,
    contributionMinor,
    contributionPerPaymentMinor: contributionMinor !== null && payouts.length ? Math.round(contributionMinor / payouts.length) : null,
    marginBps: contributionMinor !== null && volumeMinor ? Math.round((contributionMinor / volumeMinor) * 10_000) : null,
    unknownLines,
  };
}

export function networkPnl(opts: { from?: string | null; to?: string | null } = {}): CorridorPnl[] {
  return listNetworkCorridors().map((c) => corridorPnl(c.code, opts));
}
