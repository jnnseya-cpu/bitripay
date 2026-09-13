/**
 * Merchant subscriptions and billing (module 16): plans with intervals, trials, tax and metered usage; a customer
 * subscribes with a mandate confirmed under PIN or passkey; invoices are raised per period and collected from the
 * customer's wallet as merchant payments (the ledger sees an ordinary merchant payment with the invoice number);
 * failed collections enter dunning (retries after 1, 3 and 7 days, the subscription goes PAST_DUE, then cancels)
 * with a notification at every step. Usage is recorded by the merchant during the period and billed with it.
 */
import { getDb } from '../db';
import { now, shortCode } from '../lib/ids';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { getCurrency } from './currencies';
import { sendMoney } from './transfers';
import { findUserById, type UserRow } from './users';
import { notify } from './notifications';
import { recordEvent, type Actor } from './events';
import { emitEvent } from './webhooks';
import { publish } from './bus';
import { formatMoney } from '@bitripay/shared';
import { getUserWallet } from './wallets';
import { heldByKind } from './finops/holds';
import { topUpFromMandate } from './openBanking';

export type PlanInterval = 'day' | 'week' | 'month' | 'year';
export const DUNNING_DAYS = [1, 3, 7];
export interface Plan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  currency: string;
  amountMinor: number;
  interval: PlanInterval;
  intervalCount: number;
  trialDays: number;
  taxBps: number;
  taxLabel: string | null;
  usageUnit: string | null;
  usagePriceMinor: number;
  status: 'ACTIVE' | 'ARCHIVED';
  merchantId: string;
  createdAt: string;
}
const planView = (r: any): Plan => ({
  id: r.id,
  code: r.code,
  name: r.name,
  description: r.description,
  currency: r.currency,
  amountMinor: r.amount_minor,
  interval: r.interval,
  intervalCount: r.interval_count,
  trialDays: r.trial_days,
  taxBps: r.tax_bps,
  taxLabel: r.tax_label,
  usageUnit: r.usage_unit,
  usagePriceMinor: r.usage_price_minor,
  status: r.status,
  merchantId: r.merchant_user_id,
  createdAt: r.created_at,
});
export interface Subscription {
  id: string;
  planId: string;
  plan: Plan;
  merchantId: string;
  customerId: string;
  status: 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'ENDED';
  currentPeriodStart: string;
  currentPeriodEnd: string;
  nextChargeAt: string;
  usageQty: number;
  dunningAttempts: number;
  lastError: string | null;
  cancelAtPeriodEnd: boolean;
  reference: string | null;
  createdAt: string;
}
export interface Invoice {
  id: string;
  number: string;
  subscriptionId: string;
  merchantId: string;
  customerId: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  subtotalMinor: number;
  usageQty: number;
  usageMinor: number;
  taxMinor: number;
  totalMinor: number;
  status: 'OPEN' | 'PAID' | 'FAILED' | 'VOID';
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  transactionId: string | null;
  paidAt: string | null;
  createdAt: string;
}
const invoiceView = (r: any): Invoice => ({
  id: r.id,
  number: r.number,
  subscriptionId: r.subscription_id,
  merchantId: r.merchant_user_id,
  customerId: r.customer_user_id,
  periodStart: r.period_start,
  periodEnd: r.period_end,
  currency: r.currency,
  subtotalMinor: r.subtotal_minor,
  usageQty: r.usage_qty,
  usageMinor: r.usage_minor,
  taxMinor: r.tax_minor,
  totalMinor: r.total_minor,
  status: r.status,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  lastError: r.last_error,
  transactionId: r.transaction_id,
  paidAt: r.paid_at,
  createdAt: r.created_at,
});

function addInterval(iso: string, interval: PlanInterval, count: number): string {
  const d = new Date(iso);
  if (interval === 'day') d.setUTCDate(d.getUTCDate() + count);
  else if (interval === 'week') d.setUTCDate(d.getUTCDate() + 7 * count);
  else if (interval === 'month') d.setUTCMonth(d.getUTCMonth() + count);
  else d.setUTCFullYear(d.getUTCFullYear() + count);
  return d.toISOString();
}

// ---------------------------------------------------------------- plans
export function createPlan(
  merchant: UserRow,
  input: {
    name: string;
    description?: string | null;
    currency: string;
    amountMinor: number;
    interval: PlanInterval;
    intervalCount?: number | null;
    trialDays?: number | null;
    taxBps?: number | null;
    taxLabel?: string | null;
    usageUnit?: string | null;
    usagePriceMinor?: number | null;
    code?: string | null;
  },
): Plan {
  if (merchant.role !== 'merchant' && merchant.role !== 'admin') throw forbidden('Only merchant accounts create plans', 'merchant_required');
  const cur = getCurrency(input.currency);
  if (!Number.isInteger(input.amountMinor) || input.amountMinor < 0) throw badRequest('Amount must be a whole number of minor units', 'invalid_amount');
  if ((input.intervalCount ?? 1) < 1 || (input.intervalCount ?? 1) > 12) throw badRequest('Interval count must be between 1 and 12');
  if ((input.taxBps ?? 0) < 0 || (input.taxBps ?? 0) > 5000) throw badRequest('Tax must be between 0% and 50%');
  const code = (
    input.code ??
    `${input.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24)}-${shortCode(4).toLowerCase()}`
  ).trim();
  if (getDb().prepare('SELECT 1 FROM merchant_plans WHERE code = ?').get(code)) throw conflict('A plan with this code already exists', 'plan_code_taken');
  const id = `plan_${shortCode(10).toLowerCase()}`;
  getDb()
    .prepare(
      'INSERT INTO merchant_plans (id, merchant_user_id, code, name, description, currency, amount_minor, interval, interval_count, trial_days, tax_bps, tax_label, usage_unit, usage_price_minor, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      id,
      merchant.id,
      code,
      input.name.trim(),
      input.description ?? null,
      cur.code,
      input.amountMinor,
      input.interval,
      input.intervalCount ?? 1,
      input.trialDays ?? 0,
      input.taxBps ?? 0,
      input.taxLabel ?? null,
      input.usageUnit ?? null,
      input.usagePriceMinor ?? 0,
      'ACTIVE',
      now(),
      now(),
    );
  recordEvent('payment', id, 'billing.plan_created', { type: 'merchant', id: merchant.id }, { code, amount: input.amountMinor, currency: cur.code, interval: input.interval });
  return getPlan(id);
}
export function getPlan(id: string): Plan {
  const r = getDb().prepare('SELECT * FROM merchant_plans WHERE id = ? OR code = ?').get(id, id);
  if (!r) throw notFound('Plan not found', 'plan_not_found');
  return planView(r);
}
export function listPlans(merchantId: string, includeArchived = false): Plan[] {
  return (
    getDb()
      .prepare(`SELECT * FROM merchant_plans WHERE merchant_user_id = ? ${includeArchived ? '' : "AND status = 'ACTIVE'"} ORDER BY created_at DESC`)
      .all(merchantId) as any[]
  ).map(planView);
}
export function archivePlan(merchant: UserRow, id: string): Plan {
  const p = getPlan(id);
  if (p.merchantId !== merchant.id) throw notFound('Plan not found', 'plan_not_found');
  getDb().prepare("UPDATE merchant_plans SET status = 'ARCHIVED', updated_at = ? WHERE id = ?").run(now(), p.id);
  return getPlan(p.id);
}

// ---------------------------------------------------------------- subscriptions
function subView(r: any): Subscription {
  return {
    id: r.id,
    planId: r.plan_id,
    plan: getPlan(r.plan_id),
    merchantId: r.merchant_user_id,
    customerId: r.customer_user_id,
    status: r.status,
    currentPeriodStart: r.current_period_start,
    currentPeriodEnd: r.current_period_end,
    nextChargeAt: r.next_charge_at,
    usageQty: r.usage_qty,
    dunningAttempts: r.dunning_attempts,
    lastError: r.last_error,
    cancelAtPeriodEnd: !!r.cancel_at_period_end,
    reference: r.reference,
    createdAt: r.created_at,
  };
}
/** The customer subscribes: the mandate is the step-up (PIN / passkey) confirmed by the caller; the first period is charged now unless there is a trial. */
export async function subscribe(
  customer: UserRow,
  planIdOrCode: string,
  opts: { reference?: string | null; mandateConfirmed: boolean },
): Promise<{ subscription: Subscription; invoice: Invoice | null }> {
  if (!opts.mandateConfirmed) throw forbidden('Confirm the mandate with your PIN or passkey', 'step_up_required');
  const plan = getPlan(planIdOrCode);
  if (plan.status !== 'ACTIVE') throw unprocessable('This plan is no longer offered', 'plan_archived');
  if (plan.merchantId === customer.id) throw badRequest('You cannot subscribe to your own plan', 'self_subscription');
  const merchant = findUserById(plan.merchantId);
  if (!merchant || merchant.status !== 'active') throw unprocessable('The merchant account is not active', 'merchant_inactive');
  const existing = getDb()
    .prepare("SELECT id FROM merchant_subscriptions WHERE plan_id = ? AND customer_user_id = ? AND status IN ('TRIALING', 'ACTIVE', 'PAST_DUE')")
    .get(plan.id, customer.id) as any;
  if (existing) throw conflict(`You already have this subscription (${existing.id})`, 'already_subscribed');
  const start = now();
  const trialEnd = plan.trialDays > 0 ? new Date(Date.now() + plan.trialDays * 86_400_000).toISOString() : null;
  const periodEnd = trialEnd ?? addInterval(start, plan.interval, plan.intervalCount);
  const id = `sub_${shortCode(10).toLowerCase()}`;
  getDb()
    .prepare(
      'INSERT INTO merchant_subscriptions (id, plan_id, merchant_user_id, customer_user_id, status, current_period_start, current_period_end, next_charge_at, mandate_confirmed_at, reference, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, plan.id, plan.merchantId, customer.id, trialEnd ? 'TRIALING' : 'ACTIVE', start, periodEnd, trialEnd ?? start, start, opts.reference ?? null, start, start);
  recordEvent('payment', id, 'billing.subscribed', { type: 'user', id: customer.id }, { plan: plan.code, trial: !!trialEnd });
  emitEvent(
    plan.merchantId,
    'subscription.created',
    { subscription: subView(getDb().prepare('SELECT * FROM merchant_subscriptions WHERE id = ?').get(id)) },
    { resource: { type: 'subscription', id } },
  );
  let invoice: Invoice | null = null;
  if (!trialEnd) invoice = await collectWithMandate(id, { type: 'user', id: customer.id });
  else
    notify(
      customer.id,
      `Trial started: ${plan.name}`,
      `Your ${plan.trialDays}-day trial with ${merchant.business_name || merchant.full_name} ends on ${trialEnd.slice(0, 10)}; the first charge of ${formatMoney(plan.amountMinor, getCurrency(plan.currency))} follows then.`,
      { kind: 'wallet', subscriptionId: id },
    );
  return { subscription: getSubscription(id), invoice };
}
export function getSubscription(id: string): Subscription {
  const r = getDb().prepare('SELECT * FROM merchant_subscriptions WHERE id = ?').get(id);
  if (!r) throw notFound('Subscription not found', 'subscription_not_found');
  return subView(r);
}
export function listSubscriptions(filter: { merchantId?: string | null; customerId?: string | null; status?: string | null; limit?: number }): Subscription[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.merchantId) {
    where.push('merchant_user_id = ?');
    params.push(filter.merchantId);
  }
  if (filter.customerId) {
    where.push('customer_user_id = ?');
    params.push(filter.customerId);
  }
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  return (
    getDb()
      .prepare(`SELECT * FROM merchant_subscriptions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, Math.min(500, filter.limit ?? 100)) as any[]
  ).map(subView);
}
export function listInvoices(filter: { subscriptionId?: string | null; merchantId?: string | null; customerId?: string | null; limit?: number }): Invoice[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.subscriptionId) {
    where.push('subscription_id = ?');
    params.push(filter.subscriptionId);
  }
  if (filter.merchantId) {
    where.push('merchant_user_id = ?');
    params.push(filter.merchantId);
  }
  if (filter.customerId) {
    where.push('customer_user_id = ?');
    params.push(filter.customerId);
  }
  return (
    getDb()
      .prepare(`SELECT * FROM merchant_invoices ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, Math.min(500, filter.limit ?? 100)) as any[]
  ).map(invoiceView);
}
/** Metered usage recorded by the merchant during the period; billed with the next invoice. */
export function recordUsage(merchant: UserRow, subscriptionId: string, qty: number, note?: string | null): Subscription {
  const s = getSubscription(subscriptionId);
  if (s.merchantId !== merchant.id) throw notFound('Subscription not found', 'subscription_not_found');
  if (!s.plan.usageUnit) throw badRequest('This plan has no metered usage', 'no_usage_unit');
  if (!Number.isInteger(qty) || qty <= 0) throw badRequest('Quantity must be a positive whole number', 'invalid_qty');
  if (!['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(s.status)) throw conflict('The subscription is not active', 'subscription_inactive');
  getDb().prepare('UPDATE merchant_subscriptions SET usage_qty = usage_qty + ?, updated_at = ? WHERE id = ?').run(qty, now(), s.id);
  recordEvent('payment', s.id, 'billing.usage', { type: 'merchant', id: merchant.id }, { qty, note: note ?? null });
  return getSubscription(s.id);
}
export function cancelSubscription(actor: UserRow, id: string, opts: { immediately?: boolean } = {}): Subscription {
  const s = getSubscription(id);
  if (s.customerId !== actor.id && s.merchantId !== actor.id && actor.role !== 'admin') throw notFound('Subscription not found', 'subscription_not_found');
  if (['CANCELLED', 'ENDED'].includes(s.status)) return s;
  const db = getDb();
  if (opts.immediately || s.status === 'PAST_DUE' || s.status === 'TRIALING') {
    db.prepare("UPDATE merchant_subscriptions SET status = 'CANCELLED', cancelled_at = ?, ended_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), now(), id);
    db.prepare("UPDATE merchant_invoices SET status = 'VOID', updated_at = ? WHERE subscription_id = ? AND status IN ('OPEN', 'FAILED')").run(now(), id);
  } else db.prepare('UPDATE merchant_subscriptions SET cancel_at_period_end = 1, cancelled_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id);
  recordEvent('payment', id, 'billing.cancelled', { type: actor.role === 'admin' ? 'admin' : actor.id === s.merchantId ? 'merchant' : 'user', id: actor.id }, { immediately: !!opts.immediately });
  const after = getSubscription(id);
  emitEvent(s.merchantId, 'subscription.cancelled', { subscription: after }, { resource: { type: 'subscription', id } });
  notify(
    s.customerId,
    'Subscription cancelled',
    after.status === 'CANCELLED' ? `${s.plan.name} ended today.` : `${s.plan.name} stays active until ${s.currentPeriodEnd.slice(0, 10)} and then stops.`,
    { kind: 'wallet', subscriptionId: id },
  );
  return after;
}

// ---------------------------------------------------------------- invoices and collection
function raiseInvoice(s: any): any {
  const plan = getPlan(s.plan_id);
  const subtotal = plan.amountMinor;
  const usageMinor = s.usage_qty * plan.usagePriceMinor;
  const tax = Math.round(((subtotal + usageMinor) * plan.taxBps) / 10_000);
  const total = subtotal + usageMinor + tax;
  const id = `inv_${shortCode(10).toLowerCase()}`;
  const number = `INV-${new Date().toISOString().slice(0, 7).replace('-', '')}-${shortCode(6).toUpperCase()}`;
  getDb()
    .prepare(
      'INSERT INTO merchant_invoices (id, subscription_id, merchant_user_id, customer_user_id, number, period_start, period_end, currency, subtotal_minor, usage_qty, usage_minor, tax_minor, total_minor, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, s.id, s.merchant_user_id, s.customer_user_id, number, s.current_period_start, s.current_period_end, plan.currency, subtotal, s.usage_qty, usageMinor, tax, total, 'OPEN', now(), now());
  return getDb().prepare('SELECT * FROM merchant_invoices WHERE id = ?').get(id);
}
/** Raise (or reuse) the invoice for the current period and collect it from the customer's wallet. */
/**
 * Collection with a bank fallback: when the wallet is short and the customer holds a billing mandate on a linked bank
 * account, the shortfall is drawn under the mandate first (an ordinary pay-by-bank deposit), then the invoice is
 * collected from the wallet as usual.
 */
export async function collectWithMandate(subscriptionId: string, actor: Actor): Promise<Invoice> {
  const s = getDb().prepare('SELECT * FROM merchant_subscriptions WHERE id = ?').get(subscriptionId) as any;
  if (s) {
    const plan = getPlan(s.plan_id);
    const total = plan.amountMinor + s.usage_qty * plan.usagePriceMinor;
    const withTax = total + Math.round((total * plan.taxBps) / 10_000);
    try {
      const wallet = getUserWallet(s.customer_user_id, plan.currency);
      const held = Object.values(heldByKind(wallet.id)).reduce((a, b) => a + b, 0);
      const shortfall = withTax - (wallet.balance - held);
      if (shortfall > 0) {
        const topUp = await topUpFromMandate(s.customer_user_id, plan.currency, shortfall, 'billing', `${plan.name} invoice`);
        if (topUp.ok) recordEvent('payment', s.id, 'billing.mandate_topup', actor, { paymentId: topUp.paymentId, amount: shortfall });
      }
    } catch {
      /* no wallet yet: the collection below reports the shortfall */
    }
  }
  return collectInner(subscriptionId, actor);
}
function collectInner(subscriptionId: string, actor: Actor): Invoice {
  const db = getDb();
  const s = db.prepare('SELECT * FROM merchant_subscriptions WHERE id = ?').get(subscriptionId) as any;
  if (!s) throw notFound('Subscription not found', 'subscription_not_found');
  const plan = getPlan(s.plan_id);
  let inv = db.prepare("SELECT * FROM merchant_invoices WHERE subscription_id = ? AND period_start = ? AND status IN ('OPEN', 'FAILED')").get(s.id, s.current_period_start) as any;
  if (!inv) inv = raiseInvoice(s);
  const customer = findUserById(s.customer_user_id)!;
  const merchant = findUserById(s.merchant_user_id)!;
  const cur = getCurrency(plan.currency);
  try {
    let txId: string | null = null;
    if (inv.total_minor > 0) {
      const tx = sendMoney(customer, {
        to: merchant.tag,
        amount: inv.total_minor,
        currency: plan.currency,
        type: 'merchant_payment',
        note: `${plan.name} · ${inv.number}`,
        idempotencyKey: `inv:${inv.id}`,
        stepUpVerified: true,
      });
      txId = tx.id;
    }
    const nextStart = s.current_period_end;
    const nextEnd = addInterval(nextStart, plan.interval, plan.intervalCount);
    db.transaction(() => {
      db.prepare("UPDATE merchant_invoices SET status = 'PAID', transaction_id = ?, paid_at = ?, attempts = attempts + 1, last_error = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ?").run(
        txId,
        now(),
        now(),
        inv.id,
      );
      // the paid period is the current one; the next charge falls at its end
      db.prepare(
        "UPDATE merchant_subscriptions SET status = CASE WHEN cancel_at_period_end = 1 THEN 'CANCELLED' ELSE 'ACTIVE' END, ended_at = CASE WHEN cancel_at_period_end = 1 THEN ? ELSE NULL END, next_charge_at = ?, usage_qty = 0, dunning_attempts = 0, last_error = NULL, updated_at = ? WHERE id = ?",
      ).run(s.current_period_end, s.current_period_end, now(), s.id);
      void nextStart;
      void nextEnd;
    })();
    recordEvent('payment', inv.id, 'billing.invoice_paid', actor, { subscriptionId: s.id, total: inv.total_minor, transactionId: txId });
    const paid = invoiceView(db.prepare('SELECT * FROM merchant_invoices WHERE id = ?').get(inv.id));
    emitEvent(s.merchant_user_id, 'invoice.paid', { invoice: paid }, { resource: { type: 'invoice', id: inv.id } });
    notify(
      s.customer_user_id,
      `${plan.name} paid`,
      `${formatMoney(inv.total_minor, cur)} for ${inv.period_start.slice(0, 10)} → ${inv.period_end.slice(0, 10)}${inv.tax_minor ? ` (includes ${formatMoney(inv.tax_minor, cur)} ${plan.taxLabel ?? 'tax'})` : ''}. Invoice ${inv.number}.`,
      { kind: 'wallet', invoiceId: inv.id, transactionId: txId },
    );
    publish(
      'subscription.charged',
      { subscriptionId: s.id, invoiceId: inv.id, merchantId: s.merchant_user_id, customerId: s.customer_user_id, amountMinor: inv.total_minor, currency: plan.currency },
      { aggregateId: s.id, tenantId: s.merchant_user_id },
    );
    return paid;
  } catch (err) {
    const attempts = (inv.attempts ?? 0) + 1;
    const message = (err as any)?.message ?? String(err);
    const retryDays = DUNNING_DAYS[attempts - 1];
    const nextAttempt = retryDays ? new Date(Date.now() + retryDays * 86_400_000).toISOString() : null;
    db.prepare("UPDATE merchant_invoices SET status = 'FAILED', attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?").run(attempts, message, nextAttempt, now(), inv.id);
    if (nextAttempt) {
      db.prepare("UPDATE merchant_subscriptions SET status = 'PAST_DUE', dunning_attempts = ?, last_error = ?, next_charge_at = ?, updated_at = ? WHERE id = ?").run(
        attempts,
        message,
        nextAttempt,
        now(),
        s.id,
      );
      notify(
        s.customer_user_id,
        `${plan.name}: payment failed`,
        `${formatMoney(inv.total_minor, cur)} could not be collected (${message}). We will try again on ${nextAttempt.slice(0, 10)}; add money to keep the service.`,
        { kind: 'wallet', invoiceId: inv.id },
      );
    } else {
      db.prepare("UPDATE merchant_subscriptions SET status = 'CANCELLED', dunning_attempts = ?, last_error = ?, cancelled_at = ?, ended_at = ?, updated_at = ? WHERE id = ?").run(
        attempts,
        message,
        now(),
        now(),
        now(),
        s.id,
      );
      db.prepare("UPDATE merchant_invoices SET status = 'VOID', updated_at = ? WHERE id = ?").run(now(), inv.id);
      notify(s.customer_user_id, `${plan.name} cancelled`, `After ${attempts} failed collection attempts the subscription was cancelled. Subscribe again once your balance allows.`, {
        kind: 'wallet',
        subscriptionId: s.id,
      });
      emitEvent(s.merchant_user_id, 'subscription.cancelled', { subscription: getSubscription(s.id), reason: 'dunning_exhausted' }, { resource: { type: 'subscription', id: s.id } });
    }
    recordEvent('payment', inv.id, 'billing.invoice_failed', actor, { subscriptionId: s.id, attempt: attempts, error: message, nextAttempt });
    const failed = invoiceView(db.prepare('SELECT * FROM merchant_invoices WHERE id = ?').get(inv.id));
    emitEvent(s.merchant_user_id, 'invoice.payment_failed', { invoice: failed, attempt: attempts, nextAttemptAt: nextAttempt }, { resource: { type: 'invoice', id: inv.id } });
    return failed;
  }
}
/** Job: every due subscription (period ended, trial ended, dunning retry due) is collected; cancel-at-period-end subscriptions end instead. */
export async function runBilling(at: Date = new Date()): Promise<{ collected: number; failed: number; ended: number }> {
  const db = getDb();
  const due = db.prepare("SELECT * FROM merchant_subscriptions WHERE status IN ('TRIALING', 'ACTIVE', 'PAST_DUE') AND next_charge_at <= ? ORDER BY next_charge_at").all(at.toISOString()) as any[];
  let collected = 0;
  let failed = 0;
  let ended = 0;
  for (const s of due) {
    if (s.status === 'ACTIVE' || s.status === 'TRIALING') {
      if (s.cancel_at_period_end) {
        db.prepare("UPDATE merchant_subscriptions SET status = 'ENDED', ended_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), s.id);
        ended += 1;
        continue;
      }
      // a new period starts where the last one ended
      const plan = getPlan(s.plan_id);
      const start = s.current_period_end;
      db.prepare('UPDATE merchant_subscriptions SET current_period_start = ?, current_period_end = ?, updated_at = ? WHERE id = ?').run(
        start,
        addInterval(start, plan.interval, plan.intervalCount),
        now(),
        s.id,
      );
    }
    const inv = await collectWithMandate(s.id, { type: 'system' });
    if (inv.status === 'PAID') collected += 1;
    else failed += 1;
  }
  return { collected, failed, ended };
}
export function billingOverview(merchantId: string) {
  const db = getDb();
  const subs = db.prepare('SELECT status, COUNT(*) c FROM merchant_subscriptions WHERE merchant_user_id = ? GROUP BY status').all(merchantId) as any[];
  const mrr = db
    .prepare(
      "SELECT p.currency, SUM(CASE p.interval WHEN 'day' THEN p.amount_minor * 30 / p.interval_count WHEN 'week' THEN p.amount_minor * 4 / p.interval_count WHEN 'month' THEN p.amount_minor / p.interval_count ELSE p.amount_minor / (12 * p.interval_count) END) m FROM merchant_subscriptions s JOIN merchant_plans p ON p.id = s.plan_id WHERE s.merchant_user_id = ? AND s.status IN ('ACTIVE', 'PAST_DUE') GROUP BY p.currency",
    )
    .all(merchantId) as any[];
  const collected = db
    .prepare("SELECT currency, COALESCE(SUM(total_minor), 0) s, COUNT(*) n FROM merchant_invoices WHERE merchant_user_id = ? AND status = 'PAID' AND paid_at >= ? GROUP BY currency")
    .all(merchantId, new Date(Date.now() - 30 * 86_400_000).toISOString()) as any[];
  return {
    byStatus: Object.fromEntries(subs.map((s) => [s.status, s.c])),
    monthlyRecurring: mrr.map((m) => ({ currency: m.currency, minor: Math.round(m.m) })),
    collected30d: collected.map((c) => ({ currency: c.currency, minor: c.s, invoices: c.n })),
    dunningDays: DUNNING_DAYS,
  };
}
