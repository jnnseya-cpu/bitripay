/**
 * Aggregation fee on national-switch payments (the aggregator's remuneration). A payment routed through the switch
 * never touches the customer ledger; the fee BitriPay earns on it is therefore not deducted from the flow. It is
 * quoted when the payment is created (the merchant sees it before anything is sent), accrued in the observation
 * journal when the switch confirms completion, invoiced per period and per currency, and settled either from the
 * merchant's BitriPay wallet (an ordinary ledger posting to the fees revenue account) or recorded by an
 * administrator under step-up with the bank reference. The rate comes from the fee schedules (`switch_payment`).
 */
import { getDb } from '../../db';
import { uuid, now } from '../../lib/ids';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { applyBps } from '@bitripay/shared';
import { calculateFee, postTransaction } from '../ledger';
import { resolveFeeRule } from '../finops/fees';
import { getUserWallet } from '../wallets';
import { findUserById, getSystemUser, toPublicUser, type UserRow } from '../users';
import { getCurrency } from '../currencies';
import { audit } from '../audit';
import { notify } from '../notifications';

export interface FeeQuote {
  type: 'switch_payment';
  bps: number;
  fixed_minor: number;
  amount_minor: number;
  currency: string;
  source: string;
}
export interface FeeEntry {
  id: string;
  paymentId: string;
  merchantUserId: string;
  amount: number;
  currency: string;
  bps: number;
  base: number;
  period: string;
  status: 'accrued' | 'invoiced' | 'paid' | 'waived' | 'reversed';
  invoiceId: string | null;
  /** Principal reversed or refunded so far (Instruction n°58 art. 23). */
  reversed: number;
  /** Fee credited back after an invoice, deducted from the merchant's next invoice. */
  credit: number;
  createdAt: string;
}
export interface FeeInvoice {
  id: string;
  number: string;
  merchantUserId: string;
  merchant?: ReturnType<typeof toPublicUser> | null;
  period: string;
  currency: string;
  total: number;
  entryCount: number;
  /** Credits of reversed payments deducted from this invoice (Instruction n°58 art. 23). */
  credit: number;
  status: 'open' | 'paid' | 'void';
  paidTransactionId: string | null;
  paidReference: string | null;
  paidAt: string | null;
  createdAt: string;
}

const periodOf = (iso: string) => iso.slice(0, 7);

/** What the merchant will owe on this payment if the switch completes it; shown on the payment before emission. */
export function quoteAggregationFee(merchantUserId: string, amountMinor: number, currency: string): FeeQuote {
  const resolved = resolveFeeRule('switch_payment', { userId: merchantUserId });
  const rule = resolved?.rule ?? { fixed: 0, bps: 0 };
  const amount = calculateFee('switch_payment', amountMinor, currency, null, { userId: merchantUserId, band: false });
  const fixed = Math.max(0, amount - applyBps(amountMinor, rule.bps));
  return { type: 'switch_payment', bps: rule.bps, fixed_minor: fixed, amount_minor: amount, currency, source: resolved?.source.scope ?? 'platform' };
}

function toEntry(r: any): FeeEntry {
  return {
    id: r.id,
    paymentId: r.payment_id,
    merchantUserId: r.merchant_user_id,
    amount: r.amount_minor,
    currency: r.currency,
    bps: r.bps,
    base: r.base_minor,
    period: r.period,
    status: r.status,
    invoiceId: r.invoice_id,
    reversed: r.reversed_minor ?? 0,
    credit: r.credit_minor ?? 0,
    createdAt: r.created_at,
  };
}
function toInvoice(r: any, withMerchant = false): FeeInvoice {
  const m = withMerchant ? findUserById(r.merchant_user_id) : null;
  return {
    id: r.id,
    number: `AGG-${String(r.number).padStart(6, '0')}`,
    merchantUserId: r.merchant_user_id,
    merchant: m ? toPublicUser(m) : undefined,
    period: r.period,
    currency: r.currency,
    total: r.total_minor,
    entryCount: r.entry_count,
    credit: r.credit_minor ?? 0,
    status: r.status,
    paidTransactionId: r.paid_transaction_id,
    paidReference: r.paid_reference,
    paidAt: r.paid_at,
    createdAt: r.created_at,
  };
}

/** Accrue the fee for a completed payment; idempotent per payment; zero-rate merchants accrue nothing. */
export function accrueAggregationFee(payment: { id: string; merchant_user_id: string; amount_minor: number; currency: string; completed_at: string | null }): FeeEntry | null {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM switch_fee_entries WHERE payment_id = ?').get(payment.id);
  if (existing) return toEntry(existing);
  const quote = quoteAggregationFee(payment.merchant_user_id, payment.amount_minor, payment.currency);
  if (quote.amount_minor <= 0) return null;
  const id = uuid();
  const ts = now();
  db.prepare(
    "INSERT INTO switch_fee_entries (id, payment_id, merchant_user_id, amount_minor, currency, bps, fixed_minor, base_minor, period, status, invoice_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'accrued', NULL, ?)",
  ).run(id, payment.id, payment.merchant_user_id, quote.amount_minor, payment.currency, quote.bps, quote.fixed_minor, payment.amount_minor, periodOf(payment.completed_at ?? ts), ts);
  db.prepare('INSERT INTO switch_journal (id, payment_id, fact, amount_minor, currency, source, reference, proof_ref, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    uuid(),
    payment.id,
    'AGGREGATION_FEE',
    quote.amount_minor,
    payment.currency,
    'bitripay',
    id,
    null,
    ts,
    ts,
  );
  return toEntry(db.prepare('SELECT * FROM switch_fee_entries WHERE id = ?').get(id));
}

/**
 * Instruction n°58 art. 23: when a payment is reversed or refunded (in full or in part), the fee accrued on that
 * part is credited back to the merchant. While the entry is still accrued its amount is reduced (to zero on a full
 * reversal); once invoiced or paid, the credit is kept on the entry and deducted from the merchant's next invoice in
 * that currency. Idempotent per confirmed operation through the journal reference.
 */
export function reverseAggregationFee(paymentId: string, reversedMinor: number, kind: 'REFUND' | 'REVERSAL', reference: string): FeeEntry | null {
  const db = getDb();
  const r = db.prepare('SELECT * FROM switch_fee_entries WHERE payment_id = ?').get(paymentId) as any;
  if (!r || reversedMinor <= 0) return null;
  const already = db.prepare("SELECT 1 FROM switch_journal WHERE payment_id = ? AND fact = 'AGGREGATION_FEE_CREDIT' AND reference = ?").get(paymentId, reference);
  if (already) return toEntry(r);
  const base = r.base_minor as number;
  const share = Math.min(reversedMinor, Math.max(0, base - r.reversed_minor)); // principal not yet reversed
  if (share <= 0) return toEntry(r);
  const feeOriginal = Math.round(applyBps(base, r.bps) + r.fixed_minor);
  const feeStillDue = Math.round((feeOriginal * (base - r.reversed_minor)) / base); // fee attributable to the unreversed principal
  const credit = Math.min(feeStillDue, Math.round((feeOriginal * share) / base));
  const ts = now();
  if (r.status === 'accrued') {
    db.prepare(
      'UPDATE switch_fee_entries SET amount_minor = MAX(0, amount_minor - ?), reversed_minor = reversed_minor + ?, status = CASE WHEN amount_minor - ? <= 0 THEN ? ELSE status END WHERE id = ?',
    ).run(credit, share, credit, 'reversed', r.id);
  } else {
    db.prepare('UPDATE switch_fee_entries SET credit_minor = credit_minor + ?, reversed_minor = reversed_minor + ? WHERE id = ?').run(credit, share, r.id);
  }
  db.prepare('INSERT INTO switch_journal (id, payment_id, fact, amount_minor, currency, source, reference, proof_ref, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    uuid(),
    paymentId,
    'AGGREGATION_FEE_CREDIT',
    -credit,
    r.currency,
    'bitripay',
    reference,
    kind,
    ts,
    ts,
  );
  return toEntry(db.prepare('SELECT * FROM switch_fee_entries WHERE id = ?').get(r.id));
}

export function feeEntryForPayment(paymentId: string): FeeEntry | null {
  const r = getDb().prepare('SELECT * FROM switch_fee_entries WHERE payment_id = ?').get(paymentId);
  return r ? toEntry(r) : null;
}

/** The merchant's view: accrued (not yet invoiced) totals per currency, and invoices. */
export function merchantAggregationFees(merchantUserId: string) {
  const db = getDb();
  const accrued = db
    .prepare(
      "SELECT currency, period, COUNT(*) c, COALESCE(SUM(amount_minor), 0) total FROM switch_fee_entries WHERE merchant_user_id = ? AND status = 'accrued' GROUP BY currency, period ORDER BY period DESC",
    )
    .all(merchantUserId) as { currency: string; period: string; c: number; total: number }[];
  const invoices = (db.prepare('SELECT * FROM switch_fee_invoices WHERE merchant_user_id = ? ORDER BY number DESC LIMIT 100').all(merchantUserId) as any[]).map((r) => toInvoice(r));
  const entries = (db.prepare('SELECT * FROM switch_fee_entries WHERE merchant_user_id = ? ORDER BY created_at DESC LIMIT 200').all(merchantUserId) as any[]).map(toEntry);
  const rate = quoteAggregationFee(merchantUserId, 100_00, 'USD');
  // credits of reversed payments already invoiced, deducted from the next invoice in that currency (Instruction n°58 art. 23)
  const credits = db
    .prepare("SELECT currency, COALESCE(SUM(credit_minor), 0) total FROM switch_fee_entries WHERE merchant_user_id = ? AND credit_minor > 0 AND status IN ('invoiced', 'paid') GROUP BY currency")
    .all(merchantUserId) as { currency: string; total: number }[];
  return { rate: { bps: rate.bps, source: rate.source }, accrued: accrued.map((a) => ({ currency: a.currency, period: a.period, count: a.c, total: a.total })), credits, invoices, entries };
}

/** Close a period (YYYY-MM): one invoice per merchant and currency for the entries still accrued; returns the invoices created. */
export function closeAggregationPeriod(period: string, adminId: string): FeeInvoice[] {
  if (!/^\d{4}-\d{2}$/.test(period)) throw badRequest('Period must be YYYY-MM', 'invalid_period');
  if (period >= periodOf(now())) throw badRequest('Only a past period can be invoiced', 'period_open');
  const db = getDb();
  const groups = db
    .prepare("SELECT merchant_user_id, currency, COUNT(*) c, SUM(amount_minor) total FROM switch_fee_entries WHERE period = ? AND status = 'accrued' GROUP BY merchant_user_id, currency")
    .all(period) as { merchant_user_id: string; currency: string; c: number; total: number }[];
  const created: FeeInvoice[] = [];
  db.transaction(() => {
    for (const g of groups) {
      if (g.total <= 0) continue;
      const exists = db.prepare('SELECT id, status FROM switch_fee_invoices WHERE merchant_user_id = ? AND period = ? AND currency = ?').get(g.merchant_user_id, period, g.currency) as any;
      if (exists) continue; // already invoiced: late entries of a closed period roll into the next close of that period only through a void + re-close
      const id = uuid();
      const number = ((db.prepare('SELECT COALESCE(MAX(number), 0) n FROM switch_fee_invoices').get() as { n: number }).n ?? 0) + 1;
      // credits from reversed payments of earlier invoices reduce this invoice (never below zero); consumed credits are cleared
      const creditRows = db
        .prepare("SELECT id, credit_minor FROM switch_fee_entries WHERE merchant_user_id = ? AND currency = ? AND credit_minor > 0 AND status IN ('invoiced', 'paid') ORDER BY created_at")
        .all(g.merchant_user_id, g.currency) as { id: string; credit_minor: number }[];
      let creditApplied = 0;
      for (const c of creditRows) {
        const take = Math.min(c.credit_minor, g.total - creditApplied);
        if (take <= 0) break;
        creditApplied += take;
        db.prepare('UPDATE switch_fee_entries SET credit_minor = credit_minor - ? WHERE id = ?').run(take, c.id);
      }
      db.prepare(
        "INSERT INTO switch_fee_invoices (id, number, merchant_user_id, period, currency, total_minor, entry_count, status, created_by, created_at, credit_minor) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)",
      ).run(id, number, g.merchant_user_id, period, g.currency, g.total - creditApplied, g.c, adminId, now(), creditApplied);
      db.prepare("UPDATE switch_fee_entries SET status = 'invoiced', invoice_id = ? WHERE merchant_user_id = ? AND period = ? AND currency = ? AND status = 'accrued'").run(
        id,
        g.merchant_user_id,
        period,
        g.currency,
      );
      const inv = toInvoice(db.prepare('SELECT * FROM switch_fee_invoices WHERE id = ?').get(id));
      created.push(inv);
      notify(
        g.merchant_user_id,
        'Aggregation fee invoice',
        `Invoice ${inv.number} for ${period}: ${g.c} switch payment(s), ${(g.total / 10 ** getCurrency(g.currency, false).decimals).toFixed(2)} ${g.currency}. Pay it from your wallet under Command centre → My fees.`,
        {
          kind: 'switch_fee_invoice',
          invoiceId: id,
        },
      );
    }
  })();
  audit(adminId, 'switch.fees.period_closed', 'switch_fee_period', period, { invoices: created.length });
  return created;
}

function getInvoiceRow(id: string) {
  const r = getDb()
    .prepare('SELECT * FROM switch_fee_invoices WHERE id = ? OR number = ?')
    .get(id, Number(String(id).replace(/^AGG-/, '')) || -1) as any;
  if (!r) throw notFound('Invoice not found', 'invoice_not_found');
  return r;
}

/** The merchant pays an open invoice from its wallet in the invoice currency: a fee posting to the revenue account. */
export function payInvoiceFromWallet(merchant: UserRow, invoiceId: string): FeeInvoice {
  const db = getDb();
  const r = getInvoiceRow(invoiceId);
  if (r.merchant_user_id !== merchant.id) throw notFound('Invoice not found', 'invoice_not_found');
  if (r.status !== 'open') throw conflict(`Invoice is ${r.status}`, 'invoice_not_open');
  const wallet = getUserWallet(merchant.id, r.currency);
  const revenue = getSystemUser('fees');
  const tx = postTransaction({
    type: 'subscription',
    amount: r.total_minor,
    currency: r.currency,
    fromWalletId: wallet.id,
    toWalletId: getUserWallet(revenue.id, r.currency, true).id,
    senderUserId: merchant.id,
    receiverUserId: revenue.id,
    note: `Aggregation fees ${r.period} · invoice AGG-${String(r.number).padStart(6, '0')}`,
    metadata: { switchFeeInvoiceId: r.id, period: r.period, kind: 'switch_aggregation_fee' },
  });
  db.transaction(() => {
    db.prepare("UPDATE switch_fee_invoices SET status = 'paid', paid_transaction_id = ?, paid_by = ?, paid_at = ? WHERE id = ?").run(tx.id, merchant.id, now(), r.id);
    db.prepare("UPDATE switch_fee_entries SET status = 'paid' WHERE invoice_id = ?").run(r.id);
  })();
  return toInvoice(db.prepare('SELECT * FROM switch_fee_invoices WHERE id = ?').get(r.id));
}

/** An administrator records an invoice settled outside the wallet (bank transfer) with its reference, or voids it with a reason. */
export function settleInvoice(invoiceId: string, adminId: string, action: { kind: 'paid'; reference: string } | { kind: 'void'; reason: string }): FeeInvoice {
  const db = getDb();
  const r = getInvoiceRow(invoiceId);
  if (r.status !== 'open') throw conflict(`Invoice is ${r.status}`, 'invoice_not_open');
  db.transaction(() => {
    if (action.kind === 'paid') {
      db.prepare("UPDATE switch_fee_invoices SET status = 'paid', paid_reference = ?, paid_by = ?, paid_at = ? WHERE id = ?").run(action.reference, adminId, now(), r.id);
      db.prepare("UPDATE switch_fee_entries SET status = 'paid' WHERE invoice_id = ?").run(r.id);
    } else {
      db.prepare("UPDATE switch_fee_invoices SET status = 'void', void_reason = ?, paid_by = ?, paid_at = ? WHERE id = ?").run(action.reason, adminId, now(), r.id);
      db.prepare("UPDATE switch_fee_entries SET status = 'accrued', invoice_id = NULL WHERE invoice_id = ?").run(r.id);
    }
  })();
  audit(adminId, `switch.fees.invoice_${action.kind}`, 'switch_fee_invoice', r.id, action);
  return toInvoice(db.prepare('SELECT * FROM switch_fee_invoices WHERE id = ?').get(r.id), true);
}

/** Console overview: accrued per period and currency, open and paid invoices. */
export function aggregationFeesOverview() {
  const db = getDb();
  const accrued = db
    .prepare(
      "SELECT period, currency, COUNT(*) c, COALESCE(SUM(amount_minor), 0) total, COUNT(DISTINCT merchant_user_id) merchants FROM switch_fee_entries WHERE status = 'accrued' GROUP BY period, currency ORDER BY period DESC",
    )
    .all() as any[];
  const invoices = (db.prepare('SELECT * FROM switch_fee_invoices ORDER BY number DESC LIMIT 200').all() as any[]).map((r) => toInvoice(r, true));
  const earned = db.prepare("SELECT currency, COALESCE(SUM(total_minor), 0) total FROM switch_fee_invoices WHERE status = 'paid' GROUP BY currency").all() as any[];
  return { accrued: accrued.map((a) => ({ period: a.period, currency: a.currency, count: a.c, total: a.total, merchants: a.merchants })), invoices, earned };
}
