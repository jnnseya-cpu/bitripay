/**
 * Merchant acceptance score (specification §27): one 0–100 number that says how well a merchant's payments get
 * accepted, built from seven components over a window (30 days by default). Every component is a plain ratio
 * from the merchant's own intents, attempts, refunds, disputes and settlement cycles; the recommendations are
 * deterministic sentences derived from the weakest components (no model call). A daily snapshot per merchant is
 * kept in merchant_acceptance_scores (snapshotAcceptanceScores, to be scheduled by the job runner).
 *
 * Weights (sum 100): checkout conversion 20, QR conversion 15, provider failure exposure 15, refund rate 15,
 * dispute rate 15, settlement stability 10, customer return rate 10. A component without any sample in the window
 * is reported with `sample: 0` and left out of the weighted average (the remaining weights are renormalised); a
 * merchant with no sample at all scores 0.
 */
import { getDb } from '../db';
import { now, shortCode } from '../lib/ids';
import { parseJson } from '../lib/json';

export const ACCEPTANCE_WEIGHTS = {
  checkoutConversion: 20,
  qrConversion: 15,
  providerFailureExposure: 15,
  refundRate: 15,
  disputeRate: 15,
  settlementStability: 10,
  customerReturnRate: 10,
} as const;
export type AcceptanceComponentKey = keyof typeof ACCEPTANCE_WEIGHTS;

export interface AcceptanceComponent {
  key: AcceptanceComponentKey;
  /** 0–100 contribution before weighting. */
  score: number;
  weight: number;
  /** Observations the component is based on (0 = no data in the window). */
  sample: number;
  /** The underlying ratio the score was derived from (conversion, exposure, rate…). */
  ratio: number | null;
  detail: string;
}
export interface AcceptanceScore {
  merchantUserId: string;
  score: number;
  window: { days: number; from: string; to: string };
  components: Record<AcceptanceComponentKey, AcceptanceComponent>;
  recommendations: { component: AcceptanceComponentKey; score: number; action: string }[];
  weights: typeof ACCEPTANCE_WEIGHTS;
  computedAt: string;
}

const SUCCEEDED_STATES = "('CAPTURED', 'SETTLEMENT_PENDING', 'SETTLED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'AUTHORISED')";
const LOST_STATES = "('FAILED', 'EXPIRED', 'CANCELLED')";
const CHECKOUT_SOURCES = "('checkout', 'link', 'api', 'invoice')";
const QR_SOURCES = "('qr', 'pos', 'ussd')";
const CONNECTOR_FAULTS = "('provider_unavailable', 'timeout_before_send')";

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const pct = (r: number) => `${Math.round(r * 1000) / 10}%`;

/** Deterministic advice per weak component: the weakest components (score below 70) produce at most three actions. */
const ADVICE: Record<AcceptanceComponentKey, (c: AcceptanceComponent) => string> = {
  checkoutConversion: (c) =>
    `Only ${pct(c.ratio ?? 0)} of hosted checkout and link payments complete: enable wallet and mobile money on checkout, shorten the expiry only where customers abandon, and pre-fill the payer's MSISDN.`,
  qrConversion: (c) =>
    `${pct(c.ratio ?? 0)} of QR and POS payments complete: print signed BitriQR codes with a fixed amount where prices are known and keep the terminal online so scans resolve instantly.`,
  providerFailureExposure: (c) => `${pct(c.ratio ?? 0)} of attempts failed on the provider side: let Smart Route fall back to a second connector and offer the wallet rail as the default alternative.`,
  refundRate: (c) => `${pct(c.ratio ?? 0)} of captured volume was refunded: review order descriptions and delivery promises; partial refunds cost less than full reversals.`,
  disputeRate: (c) => `${pct(c.ratio ?? 0)} of captured payments were disputed: attach delivery evidence on every order and answer disputes before the deadline to keep the reserve low.`,
  settlementStability: (c) => `${pct(c.ratio ?? 0)} of settlement cycles were paid on time: keep the payout destination verified and the balance above the reserve so cycles are not held.`,
  customerReturnRate: (c) => `${pct(c.ratio ?? 0)} of customers came back: issue a reusable payment link or static QR per customer and enable saved payers on checkout.`,
};

function component(key: AcceptanceComponentKey, score: number, sample: number, ratio: number | null, detail: string): AcceptanceComponent {
  return { key, score: sample > 0 ? clamp(score) : 0, weight: ACCEPTANCE_WEIGHTS[key], sample, ratio: ratio === null ? null : Math.round(ratio * 10_000) / 10_000, detail };
}

function conversion(db: ReturnType<typeof getDb>, merchantId: string, sources: string, since: string): { won: number; lost: number } {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN status IN ${SUCCEEDED_STATES} THEN 1 ELSE 0 END), 0) won, COALESCE(SUM(CASE WHEN status IN ${LOST_STATES} THEN 1 ELSE 0 END), 0) lost FROM payment_intents WHERE merchant_user_id = ? AND source IN ${sources} AND created_at >= ?`,
    )
    .get(merchantId, since) as { won: number; lost: number };
  return r;
}

export function computeAcceptanceScore(merchantUserId: string, days = 30): AcceptanceScore {
  const db = getDb();
  const windowDays = Math.max(1, Math.min(365, Math.floor(days)));
  const to = now();
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const components = {} as Record<AcceptanceComponentKey, AcceptanceComponent>;

  const checkout = conversion(db, merchantUserId, CHECKOUT_SOURCES, since);
  const checkoutDecided = checkout.won + checkout.lost;
  components.checkoutConversion = component(
    'checkoutConversion',
    checkoutDecided ? (checkout.won / checkoutDecided) * 100 : 0,
    checkoutDecided,
    checkoutDecided ? checkout.won / checkoutDecided : null,
    `${checkout.won} of ${checkoutDecided} decided checkout, link and API intents were captured`,
  );
  const qr = conversion(db, merchantUserId, QR_SOURCES, since);
  const qrDecided = qr.won + qr.lost;
  components.qrConversion = component(
    'qrConversion',
    qrDecided ? (qr.won / qrDecided) * 100 : 0,
    qrDecided,
    qrDecided ? qr.won / qrDecided : null,
    `${qr.won} of ${qrDecided} decided QR, POS and USSD intents were captured`,
  );

  const attempts = db
    .prepare(
      `SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN a.failure_category IN ${CONNECTOR_FAULTS} OR a.status = 'UNKNOWN' THEN 1 ELSE 0 END), 0) faults FROM payment_attempts a JOIN payment_intents i ON i.id = a.intent_id WHERE i.merchant_user_id = ? AND a.started_at >= ? AND a.status IN ('CAPTURED', 'AUTHORISED', 'FAILED', 'UNKNOWN')`,
    )
    .get(merchantUserId, since) as { total: number; faults: number };
  const exposure = attempts.total ? attempts.faults / attempts.total : 0;
  components.providerFailureExposure = component(
    'providerFailureExposure',
    (1 - exposure) * 100,
    attempts.total,
    attempts.total ? exposure : null,
    `${attempts.faults} of ${attempts.total} attempts failed or hung on the provider side`,
  );

  const captured = db
    .prepare(
      `SELECT COUNT(*) c, COALESCE(SUM(COALESCE(captured_amount_minor, amount_minor)), 0) s FROM payment_intents WHERE merchant_user_id = ? AND status IN ${SUCCEEDED_STATES} AND created_at >= ?`,
    )
    .get(merchantUserId, since) as { c: number; s: number };
  const refunded = db
    .prepare("SELECT COUNT(*) c, COALESCE(SUM(amount), 0) s FROM refunds WHERE merchant_user_id = ? AND status NOT IN ('FAILED', 'CANCELLED') AND created_at >= ?")
    .get(merchantUserId, since) as { c: number; s: number };
  const refundRate = captured.s > 0 ? Math.min(1, refunded.s / captured.s) : 0;
  // each percentage point of refunded volume costs five points (20 % refunded = 0)
  components.refundRate = component('refundRate', 100 - refundRate * 500, captured.c, captured.c ? refundRate : null, `${refunded.c} refund(s) returned ${pct(refundRate)} of captured volume`);

  const disputes = (db.prepare('SELECT COUNT(*) c FROM disputes WHERE merchant_user_id = ? AND created_at >= ?').get(merchantUserId, since) as { c: number }).c;
  const disputeRate = captured.c > 0 ? Math.min(1, disputes / captured.c) : 0;
  // each dispute per hundred captured payments costs twenty points (5 % disputed = 0)
  components.disputeRate = component('disputeRate', 100 - disputeRate * 2000, captured.c, captured.c ? disputeRate : null, `${disputes} dispute(s) on ${captured.c} captured payment(s)`);

  const cycles = db
    .prepare(
      "SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN status = 'PAID' AND (paid_at IS NULL OR due_at IS NULL OR paid_at <= due_at) THEN 1 ELSE 0 END), 0) on_time FROM settlement_cycles WHERE user_id = ? AND due_at IS NOT NULL AND due_at <= ? AND created_at >= ?",
    )
    .get(merchantUserId, to, since) as { total: number; on_time: number };
  const stability = cycles.total ? cycles.on_time / cycles.total : 0;
  components.settlementStability = component(
    'settlementStability',
    stability * 100,
    cycles.total,
    cycles.total ? stability : null,
    `${cycles.on_time} of ${cycles.total} due settlement cycles were paid on time`,
  );

  const customers = db
    .prepare(
      `SELECT COALESCE(i.customer_user_id, t.sender_user_id, i.customer_msisdn) customer, COUNT(*) n FROM payment_intents i LEFT JOIN transactions t ON t.id = i.transaction_id WHERE i.merchant_user_id = ? AND i.status IN ${SUCCEEDED_STATES} AND i.created_at >= ? GROUP BY 1`,
    )
    .all(merchantUserId, since) as { customer: string | null; n: number }[];
  const known = customers.filter((c) => c.customer);
  const returning = known.filter((c) => c.n >= 2).length;
  const returnRate = known.length ? returning / known.length : 0;
  // half of the customers coming back earns full marks
  components.customerReturnRate = component(
    'customerReturnRate',
    returnRate * 200,
    known.length,
    known.length ? returnRate : null,
    `${returning} of ${known.length} identified customers paid more than once`,
  );

  const active = Object.values(components).filter((c) => c.sample > 0);
  const weightSum = active.reduce((a, c) => a + c.weight, 0);
  const score = weightSum ? clamp(active.reduce((a, c) => a + c.score * c.weight, 0) / weightSum) : 0;
  const recommendations = active
    .filter((c) => c.score < 70)
    .sort((a, b) => a.score - b.score || b.weight - a.weight)
    .slice(0, 3)
    .map((c) => ({ component: c.key, score: c.score, action: ADVICE[c.key](c) }));
  if (!active.length)
    recommendations.push({
      component: 'checkoutConversion',
      score: 0,
      action: 'No payments in the window yet: create a payment link or a static BitriQR code and take the first payment to start the score.',
    });
  return { merchantUserId, score, window: { days: windowDays, from: since, to }, components, recommendations, weights: ACCEPTANCE_WEIGHTS, computedAt: to };
}

/** Daily snapshot for every merchant: one row per merchant and day, replaced when recomputed the same day. */
export function snapshotAcceptanceScores(days = 30): { snapped: number; day: string } {
  const db = getDb();
  const day = now().slice(0, 10);
  let snapped = 0;
  const upsert = db.prepare(
    'INSERT INTO merchant_acceptance_scores (id, merchant_user_id, day, score, window_days, components, recommendations, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(merchant_user_id, day) DO UPDATE SET score = excluded.score, window_days = excluded.window_days, components = excluded.components, recommendations = excluded.recommendations, computed_at = excluded.computed_at',
  );
  for (const m of db.prepare("SELECT id FROM users WHERE role = 'merchant' AND is_system = 0 AND status = 'active'").all() as { id: string }[]) {
    const s = computeAcceptanceScore(m.id, days);
    upsert.run(`mas_${shortCode(12).toLowerCase()}`, m.id, day, s.score, s.window.days, JSON.stringify(s.components), JSON.stringify(s.recommendations), s.computedAt);
    snapped += 1;
  }
  return { snapped, day };
}

export interface AcceptanceSnapshot {
  day: string;
  score: number;
  windowDays: number;
  components: Record<AcceptanceComponentKey, AcceptanceComponent>;
  recommendations: AcceptanceScore['recommendations'];
  computedAt: string;
}
export function listAcceptanceSnapshots(merchantUserId: string, limit = 90): AcceptanceSnapshot[] {
  return (getDb().prepare('SELECT * FROM merchant_acceptance_scores WHERE merchant_user_id = ? ORDER BY day DESC LIMIT ?').all(merchantUserId, Math.min(365, limit)) as any[]).map((r) => ({
    day: r.day,
    score: r.score,
    windowDays: r.window_days,
    components: parseJson(r.components, {} as Record<AcceptanceComponentKey, AcceptanceComponent>),
    recommendations: parseJson(r.recommendations, []),
    computedAt: r.computed_at,
  }));
}
