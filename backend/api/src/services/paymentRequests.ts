import { getDb } from '../db';
import { uuid, now, shortCode } from '../lib/ids';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { parseJson } from '../lib/json';
import { formatMoney, type PaymentRequest } from '@bitripay/shared';
import { getCurrency } from './currencies';
import { calculateFee, enforceLimits, postTransaction, type TransactionRow } from './ledger';
import { ensureWallet, getUserWallet } from './wallets';
import { findUserByIdentifier, findUserById, getGatewaySettings, toPublicUser, usersById, type UserRow } from './users';
import { notify } from './notifications';
import { dispatchWebhook } from './webhooks';
import { onRequestPaid } from './intents';
import { qrContent } from './qr';
import { getModules } from './modules';
import { config } from '../config';

export interface PaymentRequestRow {
  intent_id?: string | null;
  id: string;
  code: string;
  kind: PaymentRequest['kind'];
  requester_user_id: string;
  payer_user_id: string | null;
  amount: number | null;
  currency: string;
  description: string | null;
  status: PaymentRequest['status'];
  expires_at: string | null;
  paid_transaction_id: string | null;
  success_url: string | null;
  cancel_url: string | null;
  allowed_methods: string;
  metadata: string;
  created_at: string;
}

export function toPaymentRequest(row: PaymentRequestRow, users?: Map<string, ReturnType<typeof toPublicUser>>): PaymentRequest {
  const requester = users?.get(row.requester_user_id) ?? (findUserById(row.requester_user_id) ? toPublicUser(findUserById(row.requester_user_id)!) : undefined);
  const payer = row.payer_user_id ? users?.get(row.payer_user_id) ?? (findUserById(row.payer_user_id) ? toPublicUser(findUserById(row.payer_user_id)!) : null) : null;
  const qr = qrContent({ type: 'pr', id: row.code });
  return {
    id: row.id,
    code: row.code,
    kind: row.kind,
    requesterUserId: row.requester_user_id,
    payerUserId: row.payer_user_id,
    amount: row.amount,
    currency: row.currency,
    description: row.description,
    status: effectiveStatus(row),
    expiresAt: row.expires_at,
    paidTransactionId: row.paid_transaction_id,
    successUrl: row.success_url,
    cancelUrl: row.cancel_url,
    metadata: parseJson(row.metadata, {}),
    createdAt: row.created_at,
    requester,
    payer,
    qr: qr.native,
    link: `${config.webUrl}/pay/${row.code}`,
  };
}

function effectiveStatus(row: PaymentRequestRow): PaymentRequest['status'] {
  if (row.status === 'open' && row.expires_at && row.expires_at < now()) return 'expired';
  return row.status;
}

export interface CreatePaymentRequestInput {
  kind: PaymentRequest['kind'];
  amount?: number | null;
  currency: string;
  description?: string | null;
  payer?: string | null;
  expiresInMinutes?: number | null;
  successUrl?: string | null;
  cancelUrl?: string | null;
  metadata?: Record<string, unknown>;
  allowedMethods?: string[];
}

export function createPaymentRequest(requester: UserRow, input: CreatePaymentRequestInput): PaymentRequestRow {
  const modules = getModules();
  if (input.kind === 'link' && !modules.paymentLinks) throw unprocessable('Payment links are disabled', 'module_disabled');
  if (input.kind === 'request' && !modules.moneyRequests) throw unprocessable('Money requests are disabled', 'module_disabled');
  const currency = getCurrency(input.currency);
  if (input.amount != null && (!Number.isInteger(input.amount) || input.amount <= 0)) throw badRequest('Amount must be greater than zero');
  if (input.kind === 'request' && !input.amount) throw badRequest('Money requests need an amount');
  let payerId: string | null = null;
  if (input.payer) {
    const payer = findUserByIdentifier(input.payer);
    if (!payer || payer.is_system) throw badRequest('User not found', 'recipient_not_found');
    if (payer.id === requester.id) throw badRequest('You cannot request money from yourself');
    payerId = payer.id;
  }
  ensureWallet(requester.id, currency.code);
  const id = uuid();
  const code = shortCode(10);
  const expiresAt = input.expiresInMinutes ? new Date(Date.now() + input.expiresInMinutes * 60_000).toISOString() : input.kind === 'qr' ? new Date(Date.now() + 30 * 60_000).toISOString() : null;
  getDb()
    .prepare(
      `INSERT INTO payment_requests (id, code, kind, requester_user_id, payer_user_id, amount, currency, description, status, expires_at, success_url, cancel_url, allowed_methods, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      code,
      input.kind,
      requester.id,
      payerId,
      input.amount ?? null,
      currency.code,
      input.description ?? null,
      expiresAt,
      input.successUrl ?? null,
      input.cancelUrl ?? null,
      JSON.stringify(input.allowedMethods ?? []),
      JSON.stringify(input.metadata ?? {}),
      now(),
    );
  const row = getPaymentRequestByCode(code);
  if (payerId) {
    notify(payerId, 'Money request', `${requester.full_name} (@${requester.tag}) requested ${formatMoney(input.amount!, currency)}${input.description ? ` for "${input.description}"` : ''}.`, {
      kind: 'money_request',
      code,
    });
  }
  if (input.kind === 'api' || input.kind === 'link') void dispatchWebhook(requester.id, 'payment_request.created', { paymentRequest: toPaymentRequest(row) });
  return row;
}

export function getPaymentRequestByCode(code: string): PaymentRequestRow {
  const row = getDb().prepare('SELECT * FROM payment_requests WHERE code = ? OR id = ?').get(code, code) as PaymentRequestRow | undefined;
  if (!row) throw notFound('Payment request not found', 'payment_request_not_found');
  return row;
}

export function listPaymentRequests(userId: string, filter: { role: 'requester' | 'payer'; status?: string; kind?: string; page: number; pageSize: number }) {
  const db = getDb();
  const where = [filter.role === 'requester' ? 'requester_user_id = ?' : 'payer_user_id = ?'];
  const params: unknown[] = [userId];
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.kind) {
    where.push('kind = ?');
    params.push(filter.kind);
  }
  const total = (db.prepare(`SELECT COUNT(*) c FROM payment_requests WHERE ${where.join(' AND ')}`).get(...params) as any).c;
  const rows = db.prepare(`SELECT * FROM payment_requests WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, filter.pageSize, (filter.page - 1) * filter.pageSize) as PaymentRequestRow[];
  const users = usersById(rows.flatMap((r) => [r.requester_user_id, r.payer_user_id!]));
  return { items: rows.map((r) => toPaymentRequest(r, users)), total };
}

/** Pay a request from the payer's wallet. `amount` is required for open-amount requests. */
export function payWithWallet(payer: UserRow, code: string, amount?: number | null, note?: string | null): { tx: TransactionRow; request: PaymentRequestRow } {
  const db = getDb();
  return db.transaction(() => {
    const row = getPaymentRequestByCode(code);
    if (effectiveStatus(row) !== 'open') throw conflict(`This payment request is ${effectiveStatus(row)}`, 'request_not_open');
    if (row.payer_user_id && row.payer_user_id !== payer.id) throw forbidden('This request is addressed to another user');
    if (row.requester_user_id === payer.id) throw badRequest('You cannot pay your own request');
    const finalAmount = row.amount ?? amount ?? 0;
    if (!Number.isInteger(finalAmount) || finalAmount <= 0) throw badRequest('Enter an amount to pay', 'amount_required');
    const currency = getCurrency(row.currency);
    const requester = findUserById(row.requester_user_id)!;
    const type = requester.role === 'merchant' ? 'merchant_payment' : row.kind === 'request' ? 'money_request' : 'qr_payment';
    const fee = type === 'money_request' ? calculateFee('transfer', finalAmount, currency.code, null, { userId: payer.id }) : calculateFee(type, finalAmount, currency.code, null, { userId: requester.id });
    enforceLimits(payer, finalAmount, currency.code);
    const fromWallet = getUserWallet(payer.id, currency.code);
    const toWallet = ensureWallet(requester.id, currency.code);
    const tx = postTransaction({
      type,
      amount: finalAmount,
      fee,
      currency: currency.code,
      fromWalletId: fromWallet.id,
      toWalletId: toWallet.id,
      senderUserId: payer.id,
      receiverUserId: requester.id,
      note: note ?? row.description ?? null,
      metadata: { paymentRequestId: row.id, paymentRequestCode: row.code, kind: row.kind, method: 'wallet', ...parseJson(row.metadata, {}) },
      feeFrom: type === 'merchant_payment' ? 'receiver' : 'sender',
    });
    db.prepare("UPDATE payment_requests SET status = 'paid', paid_transaction_id = ?, payer_user_id = ? WHERE id = ?").run(tx.id, payer.id, row.id);
    const updated = getPaymentRequestByCode(code);
    if (updated.intent_id) onRequestPaid(updated, tx.id, 'wallet', { type: 'user', id: payer.id });
    notify(requester.id, 'Payment received', `${payer.full_name} (@${payer.tag}) paid ${formatMoney(finalAmount, currency)}${row.description ? ` for "${row.description}"` : ''}.`, {
      kind: 'payment_received',
      transactionId: tx.id,
      code: row.code,
    });
    void dispatchWebhook(requester.id, 'payment.completed', { paymentRequest: toPaymentRequest(updated), transaction: { id: tx.id, reference: tx.reference, amount: tx.amount, fee: tx.fee, currency: tx.currency, method: 'wallet' } });
    return { tx, request: updated };
  })();
}

/** Mark a request paid by an external (gateway) payment that already credited the merchant. */
export function markPaidByGateway(code: string, transactionId: string, payerUserId: string | null) {
  const db = getDb();
  const row = getPaymentRequestByCode(code);
  if (row.status !== 'open') throw conflict('Payment request already settled', 'request_not_open');
  db.prepare("UPDATE payment_requests SET status = 'paid', paid_transaction_id = ?, payer_user_id = COALESCE(?, payer_user_id) WHERE id = ?").run(transactionId, payerUserId, row.id);
  const updated = getPaymentRequestByCode(code);
  if (updated.intent_id) onRequestPaid(updated, transactionId, 'gateway', { type: 'system' });
  const requester = findUserById(row.requester_user_id)!;
  notify(requester.id, 'Payment received', `A payment of ${formatMoney(updated.amount ?? 0, getCurrency(updated.currency))} was received${row.description ? ` for "${row.description}"` : ''}.`, {
    kind: 'payment_received',
    transactionId,
    code: row.code,
  });
  return updated;
}

export function cancelPaymentRequest(user: UserRow, code: string): PaymentRequestRow {
  const row = getPaymentRequestByCode(code);
  if (row.requester_user_id !== user.id && user.role !== 'admin') throw forbidden();
  if (row.status !== 'open') throw conflict(`Request is already ${row.status}`, 'request_not_open');
  getDb().prepare("UPDATE payment_requests SET status = 'cancelled' WHERE id = ?").run(row.id);
  return getPaymentRequestByCode(code);
}

export function declinePaymentRequest(user: UserRow, code: string): PaymentRequestRow {
  const row = getPaymentRequestByCode(code);
  if (row.payer_user_id !== user.id) throw forbidden('This request is not addressed to you');
  if (row.status !== 'open') throw conflict(`Request is already ${row.status}`, 'request_not_open');
  getDb().prepare("UPDATE payment_requests SET status = 'declined' WHERE id = ?").run(row.id);
  notify(row.requester_user_id, 'Request declined', `${user.full_name} declined your money request.`, { kind: 'money_request_declined', code });
  return getPaymentRequestByCode(code);
}

/** Public checkout payload: what a payer (guest or user) can see, plus accepted methods. */
export function checkoutInfo(code: string) {
  const row = getPaymentRequestByCode(code);
  const requester = findUserById(row.requester_user_id)!;
  const gateway = getGatewaySettings(requester);
  const allowed = parseJson<string[]>(row.allowed_methods, []);
  const methods = requester.role === 'merchant' ? gateway.methods.filter((m) => allowed.length === 0 || allowed.includes(m)) : ['wallet'];
  return {
    paymentRequest: toPaymentRequest(row),
    currency: getCurrency(row.currency, false),
    merchant: { ...toPublicUser(requester), brandColor: gateway.brandColor, logoUrl: gateway.logoUrl, testMode: gateway.testMode },
    methods,
  };
}
