/**
 * Any → any money routing. The wallet is the hub: a funding leg brings money in (card, bank,
 * mobile money, QR/wallet) and a payout leg sends it on (wallet user / QR, bank, mobile money,
 * agent cash) – end to end in one request, with no extra provider integration: external legs that
 * have no API gateway use the direct rails (collection numbers, admin/agent payouts).
 */
import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { badRequest, notFound, unprocessable } from '../lib/errors';
import { parseJson } from '../lib/json';
import { decodeQr, formatMoney } from '@bitripay/shared';
import { getCurrency, fromBase } from './currencies';
import { getFees } from './settings';
import { calculateFee } from './ledger';
import { getUserById, findUserByIdentifier, findUserByTag, toPublicUser, type UserRow } from './users';
import { getUserWallet, ensureWallet } from './wallets';
import { sendMoney, exchange } from './transfers';
import { requestWithdrawal } from './withdrawals';
import { payWithWallet, getPaymentRequestByCode } from './paymentRequests';
import { createCashOutRequest } from './agents';
import { initiatePayment, verifyPayment, type InitiatePaymentInput, type PaymentAuth, type PaymentView, toPaymentView, getPayment } from './payments';
import { fxDisclosure, type FxDisclosure } from './fx';
import { describeRoute, type RouteDeclaration } from './railCatalog';
import { recordEvent } from './events';
import { notify } from './notifications';
import { getOperator } from './momo';

export type RouteDestination =
  | { method: 'wallet'; to: string; note?: string | null }
  | { method: 'qr'; data: string; note?: string | null }
  | { method: 'bank'; bankAccountId?: string | null; bankName?: string | null; accountName?: string | null; accountNumber?: string | null; country?: string | null; currency?: string | null }
  | { method: 'mobile_money'; operatorId: string; phone: string; name?: string | null }
  | { method: 'agent'; agent: string }
  | { method: 'keep' };

export interface RouteSource {
  method: 'wallet' | 'card' | 'bank' | 'mobile_money';
  gateway?: string | null;
  operatorId?: string | null;
  phone?: string | null;
  card?: InitiatePaymentInput['card'];
  savedCardId?: string | null;
  saveCard?: boolean;
  returnUrl?: string | null;
}

export interface RouteView {
  id: string;
  source: RouteSource['method'];
  sourceDetails: Record<string, unknown>;
  destination: RouteDestination['method'];
  destinationDetails: Record<string, unknown>;
  amount: number;
  currency: string;
  targetCurrency: string;
  status: string;
  paymentId: string | null;
  fundingTransactionId: string | null;
  payoutTransactionId: string | null;
  note: string | null;
  error: string | null;
  payment?: PaymentView | null;
  createdAt: string;
  updatedAt: string;
}

function toView(r: any): RouteView {
  return {
    id: r.id,
    source: r.source_method,
    sourceDetails: parseJson(r.source_details, {}),
    destination: r.destination_method,
    destinationDetails: parseJson(r.destination_details, {}),
    amount: r.amount,
    currency: r.currency,
    targetCurrency: r.target_currency,
    status: r.status,
    paymentId: r.payment_id,
    fundingTransactionId: r.funding_transaction_id,
    payoutTransactionId: r.payout_transaction_id,
    note: r.note,
    error: r.error,
    payment: r.payment_id ? (() => { try { return toPaymentView(getPayment(r.payment_id)); } catch { return null; } })() : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function setRoute(id: string, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  getDb().prepare(`UPDATE money_routes SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]), now(), id);
}

/** Describe a destination for previews (resolves users/QR codes/operators without moving money). */
export function previewDestination(dest: RouteDestination) {
  switch (dest.method) {
    case 'wallet': {
      const u = findUserByIdentifier(dest.to);
      if (!u || u.is_system) throw notFound('Recipient not found', 'recipient_not_found');
      return { label: `${u.business_name || u.full_name} (@${u.tag})`, user: toPublicUser(u), instant: true };
    }
    case 'qr': {
      const payload = decodeQr(dest.data);
      if (!payload) throw badRequest('Not a BitriPay QR code', 'invalid_qr');
      if (payload.type === 'pr') {
        const pr = getPaymentRequestByCode(payload.id);
        const u = getUserById(pr.requester_user_id);
        return { label: `Payment request ${pr.code} · ${u.business_name || u.full_name}`, user: toPublicUser(u), amount: pr.amount, currency: pr.currency, instant: true };
      }
      const u = findUserByTag(payload.id);
      if (!u) throw notFound('User not found', 'user_not_found');
      return { label: `${u.business_name || u.full_name} (@${u.tag})`, user: toPublicUser(u), amount: payload.amount ? Number(payload.amount) : null, currency: payload.currency ?? null, instant: true };
    }
    case 'mobile_money': {
      const op = getOperator(dest.operatorId);
      return { label: `${op.name} · ${dest.phone}`, operator: op, instant: false };
    }
    case 'bank':
      return { label: dest.bankName ? `${dest.bankName} · ${dest.accountNumber}` : 'Saved bank account', instant: false };
    case 'agent': {
      const a = findUserByIdentifier(dest.agent);
      if (!a || a.role !== 'agent') throw notFound('Agent not found', 'agent_not_found');
      return { label: `Cash at ${a.business_name || a.full_name}`, user: toPublicUser(a), instant: false };
    }
    default:
      return { label: 'Keep in wallet', instant: true };
  }
}

/** Largest X such that X + fee(X) <= available (fees charged on top of the sender). */
export function maxSendable(type: string, available: number, currency: string): number {
  const cfg = getFees()[type];
  if (!cfg) return available;
  const fixed = cfg.fixed ? fromBase(cfg.fixed, currency) : 0;
  let x = Math.floor(((available - fixed) * 10000) / (10000 + cfg.bps));
  while (x > 0 && x + calculateFee(type, x, currency) > available) x -= 1;
  return Math.max(0, x);
}

function payoutFeeType(dest: RouteDestination, targetUser?: UserRow | null): string | null {
  switch (dest.method) {
    case 'wallet':
    case 'qr':
      return targetUser?.role === 'merchant' ? null : 'transfer';
    case 'bank':
    case 'mobile_money':
      return 'withdrawal';
    case 'agent':
      return 'agent_cash_out';
    default:
      return null;
  }
}

/**
 * Execute the payout leg from the user's wallet. `amount` is in `currency` (the wallet that was funded);
 * `targetCurrency` triggers an exchange first when different.
 */
export function executeDestination(user: UserRow, dest: RouteDestination, amount: number, currency: string, targetCurrency: string, note?: string | null, quoteId?: string | null): { transactionId: string | null; status: string; extra?: Record<string, unknown> } {
  let payCurrency = currency;
  let payAmount = amount;
  if (targetCurrency !== currency) {
    const ex = exchange(user, currency, targetCurrency, maxSendable('exchange', amount, currency), { quoteId });
    payCurrency = targetCurrency;
    payAmount = ex.received;
  }
  // Outbound fees are charged on top of the amount, so send the largest amount the funds allow.
  const targetUser = dest.method === 'wallet' ? findUserByIdentifier(dest.to) : dest.method === 'qr' ? (() => { const p = decodeQr(dest.data); return p?.type === 'pr' ? getUserById(getPaymentRequestByCode(p.id).requester_user_id) : p ? findUserByTag(p.id) : null; })() : null;
  const feeType = payoutFeeType(dest, targetUser);
  if (feeType) payAmount = maxSendable(feeType, payAmount, payCurrency);
  if (payAmount <= 0) throw unprocessable('Amount is too small to cover the fees', 'amount_too_small');
  switch (dest.method) {
    case 'keep':
      return { transactionId: null, status: 'completed' };
    case 'wallet': {
      const tx = sendMoney(user, { to: dest.to, amount: payAmount, currency: payCurrency, note: note ?? dest.note ?? null });
      return { transactionId: tx.id, status: 'completed' };
    }
    case 'qr': {
      const payload = decodeQr(dest.data)!;
      if (payload.type === 'pr') {
        const pr = getPaymentRequestByCode(payload.id);
        const r = payWithWallet(user, pr.code, pr.amount ?? payAmount, note ?? dest.note ?? null);
        return { transactionId: r.tx.id, status: 'completed' };
      }
      const tx = sendMoney(user, { to: payload.id, amount: payAmount, currency: payCurrency, note: note ?? payload.note ?? null });
      return { transactionId: tx.id, status: 'completed' };
    }
    case 'bank': {
      const tx = requestWithdrawal(user, { amount: payAmount, currency: payCurrency, destination: dest.bankAccountId ? { method: 'bank', bankAccountId: dest.bankAccountId } : { method: 'bank', bankName: dest.bankName ?? '', accountName: dest.accountName ?? '', accountNumber: dest.accountNumber ?? '', country: dest.country ?? null }, note });
      return { transactionId: tx.id, status: 'pending' };
    }
    case 'mobile_money': {
      const tx = requestWithdrawal(user, { amount: payAmount, currency: payCurrency, destination: { method: 'mobile_money', operatorId: dest.operatorId, phone: dest.phone, name: dest.name ?? null }, note });
      return { transactionId: tx.id, status: 'pending' };
    }
    case 'agent': {
      const req = createCashOutRequest(user, { agent: dest.agent, amount: payAmount, currency: payCurrency });
      return { transactionId: null, status: 'pending', extra: { cashOutCode: req.code, expiresAt: req.expiresAt } };
    }
  }
}

export interface RouteQuote {
  amount: number;
  currency: string;
  fundingFee: number;
  exchangeFee: number;
  rate: number;
  payoutFee: number;
  targetAmount: number;
  targetCurrency: string;
  /** Full FX disclosure (reference rate, provider, timestamp, markup, expiry) – null for same-currency routes. */
  fx: FxDisclosure | null;
  /** The declared route: initiation, confirmation, settlement, timing, refund and processing mode. */
  declaration: RouteDeclaration;
}

/** Quote how much arrives at the destination after funding fee, FX and payout fee, with the full disclosure. */
export function quoteRoute(amount: number, currency: string, targetCurrency: string, sourceMethod: RouteSource['method'] = 'wallet', dest?: RouteDestination, ctx: { userId?: string | null; country?: string | null; operatorId?: string | null; gateway?: string | null; persistQuote?: boolean } = {}): RouteQuote {
  const c = getCurrency(currency);
  const t = getCurrency(targetCurrency);
  const fundingFeeType = sourceMethod === 'card' ? 'card_deposit' : sourceMethod === 'mobile_money' ? 'mobile_money_deposit' : sourceMethod === 'bank' ? 'bank_deposit' : null;
  const fundingFee = fundingFeeType ? calculateFee(fundingFeeType, amount, c.code) : 0;
  let available = amount - fundingFee;
  let exchangeFee = 0;
  let rate = 1;
  let converted = available;
  let fx: FxDisclosure | null = null;
  if (c.code !== t.code) {
    const sendable = maxSendable('exchange', available, c.code);
    exchangeFee = available - sendable;
    fx = fxDisclosure(c.code, t.code, ctx.userId ?? null, ctx.persistQuote !== false);
    converted = Math.round((sendable / 10 ** c.decimals) * fx.rate * 10 ** t.decimals);
    rate = fx.rate;
  }
  let targetUser: UserRow | null = null;
  if (dest?.method === 'wallet') targetUser = findUserByIdentifier(dest.to) ?? null;
  const feeType = dest ? payoutFeeType(dest, targetUser) : null;
  const delivered = feeType ? maxSendable(feeType, converted, t.code) : converted;
  const destKind = dest?.method === 'wallet' && targetUser?.role === 'merchant' ? 'merchant' : dest?.method ?? 'keep';
  const declaration = describeRoute(sourceMethod, destKind as any, { currency: c.code, targetCurrency: t.code, country: ctx.country, operatorId: ctx.operatorId, destinationOperatorId: dest?.method === 'mobile_money' ? dest.operatorId : null, gateway: ctx.gateway });
  return { amount, currency: c.code, fundingFee, exchangeFee, rate, payoutFee: converted - delivered, targetAmount: delivered, targetCurrency: t.code, fx, declaration };
}

export async function createRoute(user: UserRow, input: { source: RouteSource; destination: RouteDestination; amount: number; currency: string; targetCurrency?: string | null; note?: string | null; quoteId?: string | null }, auth?: PaymentAuth): Promise<RouteView> {
  const cur = getCurrency(input.currency);
  const target = getCurrency(input.targetCurrency || input.currency);
  previewDestination(input.destination); // validates
  const id = uuid();
  getDb()
    .prepare('INSERT INTO money_routes (id, user_id, source_method, source_details, destination_method, destination_details, amount, currency, target_currency, status, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, user.id, input.source.method, JSON.stringify({ operatorId: input.source.operatorId ?? null, phone: input.source.phone ?? null, gateway: input.source.gateway ?? null, quoteId: input.quoteId ?? null }), input.destination.method, JSON.stringify(input.destination), input.amount, cur.code, target.code, 'pending', input.note ?? null, now(), now());
  recordEvent('route', id, 'route.created', { type: 'user', id: user.id }, { source: input.source.method, destination: input.destination.method, amount: input.amount, currency: cur.code, targetCurrency: target.code, quoteId: input.quoteId ?? null });

  if (input.source.method === 'wallet') {
    try {
      getUserWallet(user.id, cur.code);
      const r = executeDestination(user, input.destination, input.amount, cur.code, target.code, input.note, input.quoteId);
      setRoute(id, { status: r.status, payout_transaction_id: r.transactionId, destination_details: JSON.stringify({ ...input.destination, ...(r.extra ?? {}) }) });
    } catch (err) {
      setRoute(id, { status: 'failed', error: (err as Error).message });
      throw err;
    }
    return getRoute(user.id, id);
  }

  // External funding leg first; the payout continues automatically in continueRouteAfterFunding.
  const payment = await initiatePayment(user, {
    purpose: 'deposit',
    method: input.source.method,
    gateway: input.source.gateway,
    amount: input.amount,
    currency: cur.code,
    card: input.source.card,
    savedCardId: input.source.savedCardId,
    saveCard: input.source.saveCard,
    phone: input.source.phone,
    operatorId: input.source.operatorId,
    returnUrl: input.source.returnUrl,
    route: input.destination,
    routeId: id,
  }, auth);
  const current = getDb().prepare('SELECT status FROM money_routes WHERE id = ?').get(id) as any;
  if (current.status === 'pending') setRoute(id, { payment_id: payment.id, status: payment.status === 'failed' ? 'failed' : payment.stage === 'AUTHENTICATION_REQUIRED' ? 'authentication_required' : 'funding', error: payment.failureReason });
  else setRoute(id, { payment_id: payment.id });
  return getRoute(user.id, id);
}

/** Called by settlePayment once a deposit that carries a route has credited the wallet. */
export function continueRouteAfterFunding(routeId: string, paymentId: string, fundingTxId: string, creditedAmount: number) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM money_routes WHERE id = ?').get(routeId) as any;
  if (!row || row.payout_transaction_id || ['completed', 'failed'].includes(row.status)) return;
  db.prepare('UPDATE money_routes SET payment_id = ? WHERE id = ?').run(paymentId, routeId);
  const user = getUserById(row.user_id);
  const dest = parseJson<RouteDestination>(row.destination_details, { method: 'keep' });
  const src = parseJson<{ quoteId?: string | null }>(row.source_details, {});
  try {
    const r = executeDestination(user, dest, creditedAmount, row.currency, row.target_currency, row.note, src.quoteId ?? null);
    setRoute(row.id, { status: r.status, funding_transaction_id: fundingTxId, payout_transaction_id: r.transactionId, destination_details: JSON.stringify({ ...dest, ...(r.extra ?? {}) }) });
    notify(user.id, 'Money on its way', `${formatMoney(creditedAmount, getCurrency(row.currency, false))} arrived and was ${r.status === 'completed' ? 'delivered' : 'queued for payout'} to ${previewDestination(dest).label}.`, { kind: 'route', routeId: row.id });
  } catch (err) {
    // Funds stay safely in the user's wallet; they can retry the payout.
    setRoute(row.id, { status: 'funded', funding_transaction_id: fundingTxId, error: (err as Error).message });
    notify(user.id, 'Payout needs attention', `Your money arrived in your wallet but the onward transfer failed: ${(err as Error).message}`, { kind: 'route', routeId: row.id });
  }
}

/** Retry the payout leg of a funded route (e.g. after fixing recipient details). */
export function retryRoute(user: UserRow, id: string, destination?: RouteDestination): RouteView {
  const row = getDb().prepare('SELECT * FROM money_routes WHERE id = ? AND user_id = ?').get(id, user.id) as any;
  if (!row) throw notFound('Route not found');
  if (row.status !== 'funded') throw unprocessable(`Route is ${row.status}`);
  const dest = destination ?? parseJson<RouteDestination>(row.destination_details, { method: 'keep' });
  const r = executeDestination(user, dest, row.amount, row.currency, row.target_currency, row.note);
  setRoute(id, { status: r.status, payout_transaction_id: r.transactionId, error: null, destination_details: JSON.stringify({ ...dest, ...(r.extra ?? {}) }) });
  return getRoute(user.id, id);
}

export function getRoute(userId: string, id: string): RouteView {
  const row = getDb().prepare('SELECT * FROM money_routes WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) throw notFound('Route not found');
  return toView(row);
}

export function listRoutes(userId: string): RouteView[] {
  return (getDb().prepare('SELECT * FROM money_routes WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(userId) as any[]).map(toView);
}

/** Sync a funding-stage route with its payment (used by the client while polling). */
export async function refreshRoute(userId: string, id: string): Promise<RouteView> {
  const row = getDb().prepare('SELECT * FROM money_routes WHERE id = ? AND user_id = ?').get(id, userId) as any;
  if (!row) throw notFound('Route not found');
  if ((row.status === 'funding' || row.status === 'authentication_required') && row.payment_id) {
    const p = await verifyPayment(row.payment_id);
    if (p.status === 'failed') setRoute(id, { status: 'failed', error: p.failureReason });
    else if (row.status === 'authentication_required' && p.stage !== 'AUTHENTICATION_REQUIRED') setRoute(id, { status: 'funding' });
  }
  // ensure the wallet-source path with a withdrawal reflects final status
  const fresh = getDb().prepare('SELECT * FROM money_routes WHERE id = ?').get(id) as any;
  if (fresh.status === 'pending' && fresh.payout_transaction_id) {
    const tx = getDb().prepare('SELECT status FROM transactions WHERE id = ?').get(fresh.payout_transaction_id) as any;
    if (tx && tx.status !== 'pending') setRoute(id, { status: tx.status === 'completed' ? 'completed' : 'failed', error: tx.status === 'completed' ? null : `Payout ${tx.status}` });
  }
  return getRoute(userId, id);
}

export { ensureWallet };
