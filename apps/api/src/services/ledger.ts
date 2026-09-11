import { getDb } from '../db';
import { uuid, now, txReference } from '../lib/ids';
import { badRequest, conflict, unprocessable } from '../lib/errors';
import { parseJson } from '../lib/json';
import type { Transaction, TransactionStatus, TransactionType, PublicUser } from '@bitripay/shared';
import { applyBps } from '@bitripay/shared';
import { getFees, getLimits } from './settings';
import { fromBase, toBase } from './currencies';
import { getSystemUser, usersById, type UserRow } from './users';
import { ensureWallet, getWallet, type WalletRow } from './wallets';

export interface TransactionRow {
  id: string;
  reference: string;
  type: TransactionType;
  status: TransactionStatus;
  amount: number;
  fee: number;
  currency: string;
  receive_amount: number | null;
  receive_currency: string | null;
  sender_user_id: string | null;
  receiver_user_id: string | null;
  sender_wallet_id: string | null;
  receiver_wallet_id: string | null;
  note: string | null;
  metadata: string;
  idempotency_key: string | null;
  created_at: string;
  completed_at: string | null;
}

export function toTransaction(row: TransactionRow, viewerId?: string, users?: Map<string, PublicUser>): Transaction {
  let direction: Transaction['direction'] = 'neutral';
  if (viewerId) {
    if (row.sender_user_id === viewerId && row.receiver_user_id === viewerId) direction = 'neutral';
    else if (row.sender_user_id === viewerId) direction = 'out';
    else if (row.receiver_user_id === viewerId) direction = 'in';
  }
  const counterpartyId = viewerId ? (direction === 'out' ? row.receiver_user_id : direction === 'in' ? row.sender_user_id : null) : null;
  return {
    id: row.id,
    reference: row.reference,
    type: row.type,
    status: row.status,
    amount: row.amount,
    fee: row.fee,
    currency: row.currency,
    receiveAmount: row.receive_amount,
    receiveCurrency: row.receive_currency,
    senderUserId: row.sender_user_id,
    receiverUserId: row.receiver_user_id,
    senderWalletId: row.sender_wallet_id,
    receiverWalletId: row.receiver_wallet_id,
    note: row.note,
    metadata: parseJson(row.metadata, {}),
    createdAt: row.created_at,
    completedAt: row.completed_at,
    direction,
    counterparty: counterpartyId && users ? users.get(counterpartyId) ?? null : null,
  };
}

/** Compute the platform fee for a transaction type and amount (minor units of `currency`). */
export function calculateFee(type: string, amount: number, currency: string, overrideBps?: number | null): number {
  const fees = getFees();
  const cfg = fees[type];
  if (!cfg) return 0;
  const bps = overrideBps ?? cfg.bps;
  const fixed = cfg.fixed ? fromBase(cfg.fixed, currency) : 0;
  return Math.max(0, Math.round(fixed + applyBps(amount, bps)));
}

/** Enforce per-transaction and daily limits (in base currency) for outgoing money movements. */
export function enforceLimits(user: UserRow, amount: number, currency: string) {
  if (user.is_system) return;
  const limits = getLimits();
  const tier = user.kyc_status === 'verified' ? limits.verified : limits.unverified;
  const baseAmount = toBase(amount, currency);
  if (tier.perTransaction && baseAmount > tier.perTransaction) {
    throw unprocessable(
      user.kyc_status === 'verified' ? 'Amount exceeds your per-transaction limit' : 'Amount exceeds the limit for unverified accounts. Complete KYC to increase your limits.',
      'limit_exceeded',
    );
  }
  if (tier.daily) {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const rows = getDb()
      .prepare("SELECT amount, currency FROM transactions WHERE sender_user_id = ? AND status IN ('pending','completed') AND created_at >= ? AND type NOT IN ('exchange')")
      .all(user.id, since) as { amount: number; currency: string }[];
    const usedBase = rows.reduce((sum, r) => sum + toBase(r.amount, r.currency), 0);
    if (usedBase + baseAmount > tier.daily) {
      throw unprocessable('This transaction would exceed your daily limit', 'daily_limit_exceeded');
    }
  }
}

function insertLedgerEntry(txId: string, wallet: WalletRow, direction: 'debit' | 'credit', amount: number) {
  const db = getDb();
  if (amount === 0) return;
  const newBalance = direction === 'debit' ? wallet.balance - amount : wallet.balance + amount;
  db.prepare('UPDATE wallets SET balance = ? WHERE id = ?').run(newBalance, wallet.id);
  db.prepare('INSERT INTO ledger_entries (id, transaction_id, wallet_id, direction, amount, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    uuid(),
    txId,
    wallet.id,
    direction,
    amount,
    newBalance,
    now(),
  );
  wallet.balance = newBalance;
}

export interface PostTransactionInput {
  type: TransactionType;
  amount: number;
  fee?: number;
  currency: string;
  /** Wallet to debit (amount + fee). Null for external money in (deposits) which debit the treasury. */
  fromWalletId?: string | null;
  /** Wallet to credit. Null for external money out (withdrawals) which credit the treasury. */
  toWalletId?: string | null;
  /** Amount credited to toWallet when it differs from amount (currency conversion). Defaults to amount. */
  receiveAmount?: number | null;
  receiveCurrency?: string | null;
  senderUserId?: string | null;
  receiverUserId?: string | null;
  note?: string | null;
  metadata?: Record<string, unknown>;
  status?: TransactionStatus;
  idempotencyKey?: string | null;
  /** Optional additional credits (e.g. agent commission) taken from the fee. */
  feeSplits?: { walletId: string; amount: number }[];
  allowNegativeSender?: boolean;
  /**
   * Who bears the fee. 'sender' (default): the sender is debited amount + fee and the receiver gets amount.
   * 'receiver': the sender is debited amount and the receiver gets amount - fee (merchant payments, deposits, agent cash-in).
   */
  feeFrom?: 'sender' | 'receiver';
}

function heldAmount(tx: TransactionRow): number {
  const meta = parseJson<{ feeFrom?: string }>(tx.metadata, {});
  return tx.amount + (meta.feeFrom === 'receiver' ? 0 : tx.fee);
}

/**
 * Atomically posts a transaction and its ledger entries.
 * Money always balances: sender debit = receiver credit + fee credit (fee to revenue / splits).
 * For pending transactions, the sender is debited immediately (funds are held) and the
 * receiver is credited when the transaction completes (see completeTransaction).
 */
export function postTransaction(input: PostTransactionInput): TransactionRow {
  const db = getDb();
  const fee = input.fee ?? 0;
  const status = input.status ?? 'completed';
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw badRequest('Amount must be greater than zero', 'invalid_amount');
  if (fee < 0) throw badRequest('Invalid fee');

  return db.transaction(() => {
    if (input.idempotencyKey && input.senderUserId) {
      const existing = db.prepare('SELECT * FROM transactions WHERE sender_user_id = ? AND idempotency_key = ?').get(input.senderUserId, input.idempotencyKey) as TransactionRow | undefined;
      if (existing) return existing;
    }
    const treasury = getSystemUser('treasury');
    const revenue = getSystemUser('fees');
    const fromWallet = input.fromWalletId ? getWallet(input.fromWalletId) : ensureWallet(treasury.id, input.currency);
    const receiveCurrency = input.receiveCurrency || input.currency;
    const feeFrom = input.feeFrom ?? 'sender';
    const receiveAmount = input.receiveAmount ?? (feeFrom === 'receiver' ? input.amount - fee : input.amount);
    if (receiveAmount < 0) throw badRequest('Fee exceeds amount', 'invalid_fee');
    const toWallet = input.toWalletId ? getWallet(input.toWalletId) : ensureWallet(treasury.id, receiveCurrency);
    const isSenderSystem = !input.fromWalletId || fromWallet.user_id === treasury.id;
    const totalDebit = feeFrom === 'receiver' ? input.amount : input.amount + fee;
    if (!isSenderSystem && !input.allowNegativeSender && fromWallet.balance < totalDebit) {
      throw unprocessable('Insufficient balance', 'insufficient_funds');
    }
    const id = uuid();
    const ts = now();
    db.prepare(
      `INSERT INTO transactions (id, reference, type, status, amount, fee, currency, receive_amount, receive_currency, sender_user_id, receiver_user_id, sender_wallet_id, receiver_wallet_id, note, metadata, idempotency_key, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      txReference(),
      input.type,
      status,
      input.amount,
      fee,
      input.currency,
      receiveAmount,
      receiveCurrency,
      input.senderUserId ?? (isSenderSystem ? treasury.id : fromWallet.user_id),
      input.receiverUserId ?? (input.toWalletId ? toWallet.user_id : treasury.id),
      fromWallet.id,
      toWallet.id,
      input.note ?? null,
      JSON.stringify({ ...(input.metadata ?? {}), feeFrom }),
      input.idempotencyKey ?? null,
      ts,
      status === 'completed' ? ts : null,
    );
    // Debit sender (held even while pending)
    insertLedgerEntry(id, fromWallet, 'debit', totalDebit);
    if (status === 'completed') {
      insertLedgerEntry(id, toWallet, 'credit', receiveAmount);
      creditFees(id, fee, input.currency, revenue.id, input.feeSplits);
    } else {
      // Hold: park the funds (amount in sender currency + fee) in the escrow account until completion.
      const escrow = ensureWallet(getSystemUser('escrow').id, input.currency);
      insertLedgerEntry(id, escrow, 'credit', totalDebit);
    }
    return db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as TransactionRow;
  })();
}

function creditFees(txId: string, fee: number, currency: string, revenueUserId: string, splits?: { walletId: string; amount: number }[]) {
  if (fee <= 0) return;
  let remaining = fee;
  for (const split of splits ?? []) {
    if (split.amount <= 0) continue;
    const w = getWallet(split.walletId);
    insertLedgerEntry(txId, w, 'credit', split.amount);
    remaining -= split.amount;
  }
  if (remaining > 0) insertLedgerEntry(txId, ensureWallet(revenueUserId, currency), 'credit', remaining);
  if (remaining < 0) throw new Error('Fee splits exceed fee');
}

export function getTransaction(id: string): TransactionRow | undefined {
  return getDb().prepare('SELECT * FROM transactions WHERE id = ? OR reference = ?').get(id, id) as TransactionRow | undefined;
}

/** Complete a pending transaction: release held funds from escrow to the receiver and fees to revenue. */
export function completeTransaction(id: string, extraMetadata?: Record<string, unknown>, feeSplits?: { walletId: string; amount: number }[]): TransactionRow {
  const db = getDb();
  return db.transaction(() => {
    const tx = getTransaction(id);
    if (!tx) throw badRequest('Transaction not found');
    if (tx.status !== 'pending') throw conflict(`Transaction is already ${tx.status}`, 'invalid_status');
    const escrow = ensureWallet(getSystemUser('escrow').id, tx.currency);
    insertLedgerEntry(tx.id, escrow, 'debit', heldAmount(tx));
    const toWallet = getWallet(tx.receiver_wallet_id!);
    insertLedgerEntry(tx.id, toWallet, 'credit', tx.receive_amount ?? tx.amount);
    creditFees(tx.id, tx.fee, tx.currency, getSystemUser('fees').id, feeSplits);
    const metadata = { ...parseJson(tx.metadata, {}), ...(extraMetadata ?? {}) };
    db.prepare("UPDATE transactions SET status = 'completed', completed_at = ?, metadata = ? WHERE id = ?").run(now(), JSON.stringify(metadata), tx.id);
    return getTransaction(tx.id)!;
  })();
}

/** Reject/cancel a pending transaction: refund held funds (amount + fee) to the sender. */
export function reverseTransaction(id: string, status: 'rejected' | 'cancelled' | 'failed', reason?: string): TransactionRow {
  const db = getDb();
  return db.transaction(() => {
    const tx = getTransaction(id);
    if (!tx) throw badRequest('Transaction not found');
    if (tx.status !== 'pending') throw conflict(`Transaction is already ${tx.status}`, 'invalid_status');
    const escrow = ensureWallet(getSystemUser('escrow').id, tx.currency);
    insertLedgerEntry(tx.id, escrow, 'debit', heldAmount(tx));
    const fromWallet = getWallet(tx.sender_wallet_id!);
    insertLedgerEntry(tx.id, fromWallet, 'credit', heldAmount(tx));
    const metadata = { ...parseJson(tx.metadata, {}), reason: reason ?? null };
    db.prepare('UPDATE transactions SET status = ?, completed_at = ?, metadata = ? WHERE id = ?').run(status, now(), JSON.stringify(metadata), tx.id);
    return getTransaction(tx.id)!;
  })();
}

/** Refund a completed transaction by posting a mirror transaction from receiver back to sender (fee not refunded unless requested). */
export function refundTransaction(id: string, options: { refundFee?: boolean; note?: string } = {}): TransactionRow {
  const db = getDb();
  return db.transaction(() => {
    const tx = getTransaction(id);
    if (!tx) throw badRequest('Transaction not found');
    if (tx.status !== 'completed') throw conflict('Only completed transactions can be refunded', 'invalid_status');
    if (!tx.sender_wallet_id || !tx.receiver_wallet_id) throw badRequest('Transaction cannot be refunded');
    const refund = postTransaction({
      type: 'refund',
      amount: tx.receive_amount ?? tx.amount,
      currency: tx.receive_currency ?? tx.currency,
      fromWalletId: tx.receiver_wallet_id,
      toWalletId: tx.sender_wallet_id,
      receiveAmount: tx.amount,
      receiveCurrency: tx.currency,
      senderUserId: tx.receiver_user_id,
      receiverUserId: tx.sender_user_id,
      note: options.note ?? `Refund of ${tx.reference}`,
      metadata: { refundOf: tx.id, refundOfReference: tx.reference },
      allowNegativeSender: true,
    });
    if (options.refundFee && tx.fee > 0) {
      const revenue = ensureWallet(getSystemUser('fees').id, tx.currency);
      insertLedgerEntry(refund.id, revenue, 'debit', tx.fee);
      insertLedgerEntry(refund.id, getWallet(tx.sender_wallet_id), 'credit', tx.fee);
    }
    db.prepare("UPDATE transactions SET status = 'reversed', metadata = ? WHERE id = ?").run(JSON.stringify({ ...parseJson(tx.metadata, {}), refundTransactionId: refund.id }), tx.id);
    return refund;
  })();
}

export interface ListTransactionsOptions {
  userId?: string;
  type?: string;
  status?: string;
  currency?: string;
  search?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
  direction?: 'in' | 'out';
}

export function listTransactions(opts: ListTransactionsOptions): { items: Transaction[]; total: number } {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.userId) {
    if (opts.direction === 'in') {
      where.push('receiver_user_id = ?');
      params.push(opts.userId);
    } else if (opts.direction === 'out') {
      where.push('sender_user_id = ?');
      params.push(opts.userId);
    } else {
      where.push('(sender_user_id = ? OR receiver_user_id = ?)');
      params.push(opts.userId, opts.userId);
    }
  }
  if (opts.type) {
    where.push('type = ?');
    params.push(opts.type);
  }
  if (opts.status) {
    where.push('status = ?');
    params.push(opts.status);
  }
  if (opts.currency) {
    where.push('(currency = ? OR receive_currency = ?)');
    params.push(opts.currency, opts.currency);
  }
  if (opts.from) {
    where.push('created_at >= ?');
    params.push(opts.from);
  }
  if (opts.to) {
    where.push('created_at <= ?');
    params.push(opts.to);
  }
  if (opts.search) {
    where.push('(reference LIKE ? OR note LIKE ?)');
    params.push(`%${opts.search}%`, `%${opts.search}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) c FROM transactions ${whereSql}`).get(...params) as any).c as number;
  const rows = db
    .prepare(`SELECT * FROM transactions ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, opts.pageSize, (opts.page - 1) * opts.pageSize) as TransactionRow[];
  const users = usersById(rows.flatMap((r) => [r.sender_user_id!, r.receiver_user_id!]));
  return { items: rows.map((r) => toTransaction(r, opts.userId, users)), total };
}
