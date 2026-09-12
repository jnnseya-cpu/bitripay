import { getDb } from '../db';
import { consumePromoCredit, reserveHooks } from './emoney';

/** Pre-commit guards run inside every posting before any ledger entry is written (sanctions screen registers here). */
export const preCommitHooks: ((ctx: { input: PostTransactionInput; fromUser: UserRow | null; toUser: UserRow | null }) => void)[] = [];
/** Listeners notified after a pending transaction settles or reverses (payout webhooks register here; avoids import cycles). */
export const transactionStatusHooks: ((tx: TransactionRow, outcome: 'completed' | 'rejected' | 'cancelled' | 'failed') => void)[] = [];
import { getEmoneySettings } from './settings';

/** Internal transaction types whose platform fee may be covered by promotional credit. */
const PROMO_FEE_TYPES = new Set(['transfer', 'qr_payment', 'merchant_payment', 'bill_payment', 'airtime', 'gift_card', 'exchange']);
import { uuid, now, txReference } from '../lib/ids';
import { badRequest, conflict, forbidden, unprocessable } from '../lib/errors';
import { parseJson } from '../lib/json';
import type { Transaction, TransactionStatus, TransactionType, PublicUser } from '@bitripay/shared';
import { applyBps } from '@bitripay/shared';
import { getFees, getLimits } from './settings';
import { fromBase, toBase } from './currencies';
import { resolveFeeRule, type FeeContext } from './finops/fees';
import { enforceTierLimits } from './risk/kycTiers';
import { findUserById, getSystemUser, usersById, type UserRow } from './users';
import { ensureWallet, getWallet, type WalletRow } from './wallets';
import { recordEvent } from './events';
import { publish } from './bus';

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
  /** Payment intent the transaction settled (gateway payments). */
  intent_id?: string | null;
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

/**
 * Compute the platform fee for a transaction type and amount (minor units of `currency`). The rule comes from the
 * versioned fee schedules (merchant > tier > country > platform) and falls back to the flat `fees` setting; `ctx`
 * identifies whose schedule applies. Fixed parts, floors and caps are stored in base currency and converted here.
 */
export function calculateFee(type: string, amount: number, currency: string, overrideBps?: number | null, ctx: FeeContext = {}): number {
  const resolved = resolveFeeRule(type, ctx);
  if (!resolved) return 0;
  const rule = resolved.rule;
  const bps = overrideBps ?? rule.bps;
  const fixed = rule.fixed ? fromBase(rule.fixed, currency) : 0;
  let fee = Math.round(fixed + applyBps(amount, bps));
  if (rule.min) fee = Math.max(fee, fromBase(rule.min, currency));
  if (rule.max) fee = Math.min(fee, fromBase(rule.max, currency));
  return Math.max(0, fee);
}

/** Enforce per-transaction and daily limits (in base currency) for outgoing money movements. */
export function enforceLimits(user: UserRow, amount: number, currency: string) {
  if (user.is_system) return;
  // Tiered accounts (KYC tiers 1–4) are limited per tier and country; untiered accounts keep the legacy limits below.
  if (enforceTierLimits(user, amount, currency)) return;
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

/**
 * Every transaction must balance: total debits == total credits across its ledger entries.
 * Called at the end of every posting; a violation aborts the surrounding database transaction.
 */
export function assertLedgerBalanced(txId: string) {
  // Balanced per currency: a conversion is two balanced legs (source currency and target currency) through the treasury.
  const rows = getDb().prepare("SELECT w.currency, COALESCE(SUM(CASE WHEN e.direction = 'debit' THEN e.amount ELSE 0 END), 0) d, COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount ELSE 0 END), 0) c FROM ledger_entries e JOIN wallets w ON w.id = e.wallet_id WHERE e.transaction_id = ? GROUP BY w.currency").all(txId) as { currency: string; d: number; c: number }[];
  for (const r of rows) if (r.d !== r.c) throw new Error(`Ledger imbalance on ${txId} (${r.currency}): debits ${r.d} != credits ${r.c}`);
  return { d: rows.reduce((a, r) => a + r.d, 0), c: rows.reduce((a, r) => a + r.c, 0), currencies: rows.map((r) => r.currency) };
}

/** Whole-ledger check used by reconciliation: every wallet balance equals the sum of its entries and every transaction balances. */
export function reconcileLedger(): { ok: boolean; transactionsChecked: number; unbalancedTransactions: string[]; walletMismatches: { walletId: string; balance: number; computed: number }[] } {
  const db = getDb();
  const unbalanced = db.prepare("SELECT DISTINCT transaction_id id FROM (SELECT e.transaction_id, w.currency FROM ledger_entries e JOIN wallets w ON w.id = e.wallet_id GROUP BY e.transaction_id, w.currency HAVING SUM(CASE WHEN e.direction = 'debit' THEN e.amount ELSE -e.amount END) != 0)").all() as { id: string }[];
  const wallets = db.prepare("SELECT w.id, w.balance, COALESCE((SELECT SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END) FROM ledger_entries e WHERE e.wallet_id = w.id), 0) computed FROM wallets w").all() as { id: string; balance: number; computed: number }[];
  const mismatches = wallets.filter((w) => w.balance !== w.computed).map((w) => ({ walletId: w.id, balance: w.balance, computed: w.computed }));
  const total = (db.prepare('SELECT COUNT(DISTINCT transaction_id) c FROM ledger_entries').get() as any).c as number;
  return { ok: unbalanced.length === 0 && mismatches.length === 0, transactionsChecked: total, unbalancedTransactions: unbalanced.map((u) => u.id), walletMismatches: mismatches };
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
  /**
   * Required whenever money enters circulation (the treasury is the sender). E-money is created only:
   *  - external_funding: a processor / evidence-confirmed deposit (paymentId required)
   *  - admin: an explicit administrator issuance approved by a second administrator (verificationId + adminId required)
   *  - liquidity: treasury prefunding a payout float account (adminId required; the float is a system wallet)
   *  - programme: an administrator-configured programme such as referral rewards (programme name required)
   *  - internal_release: money returning to circulation from a platform-held float it was moved into earlier (origin transaction required) – never new money
   */
  issuance?: Issuance;
}

export type IssuanceAuthority = 'external_funding' | 'admin' | 'liquidity' | 'programme' | 'internal_release';
export interface Issuance {
  authority: IssuanceAuthority;
  paymentId?: string | null;
  verificationId?: string | null;
  adminId?: string | null;
  programme?: string | null;
  reference?: string | null;
  /** internal_release: the earlier transaction that moved this money out of circulation into a platform-held float (virtual card balance, remittance escrow). */
  originTransactionId?: string | null;
}

/** Validate that a creation of e-money is authorised. Users, agents and merchants can never create balance. */
export function assertIssuanceAuthorised(issuance: Issuance | undefined, type: string): Issuance {
  if (!issuance) throw forbidden(`E-money cannot be created by a ${type} posting without an issuance authority; only confirmed external funding, administrator issuance, liquidity prefunding or an administrator-configured programme may create balance`, 'issuance_unauthorised');
  switch (issuance.authority) {
    case 'external_funding':
      if (!issuance.paymentId) throw forbidden('External funding issuance needs the confirmed payment id', 'issuance_unauthorised');
      break;
    case 'admin':
      if (!issuance.verificationId || !issuance.adminId) throw forbidden('Administrator issuance requires maker-checker approval (verification id) and the approving administrator', 'issuance_unauthorised');
      break;
    case 'liquidity':
      if (!issuance.adminId) throw forbidden('Liquidity prefunding must be performed by an administrator', 'issuance_unauthorised');
      break;
    case 'programme':
      if (!issuance.programme) throw forbidden('Programme issuance must name the administrator-configured programme', 'issuance_unauthorised');
      break;
    case 'internal_release':
      if (!issuance.originTransactionId) throw forbidden('Internal release must reference the transaction that took the money out of circulation', 'issuance_unauthorised');
      break;
    default:
      throw forbidden('Unknown issuance authority', 'issuance_unauthorised');
  }
  return issuance;
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
    // Money entering circulation from the treasury = e-money creation → must be authorised.
    const creates = isSenderSystem && !!input.toWalletId && toWallet.user_id !== treasury.id;
    const issuance = creates ? assertIssuanceAuthorised(input.issuance, input.type) : null;
    if (!isSenderSystem && fromWallet.frozen_at) throw forbidden(`This ${fromWallet.currency} balance is frozen: ${fromWallet.frozen_reason ?? 'contact support'}`, 'wallet_frozen');
    if (preCommitHooks.length) {
      const fromUser = isSenderSystem ? null : findUserById(fromWallet.user_id) ?? null;
      const toUser = toWallet.user_id === treasury.id ? null : findUserById(toWallet.user_id) ?? null;
      for (const h of preCommitHooks) h({ input, fromUser, toUser });
    }
    // Promotional credit may cover platform fees on completed internal transactions – it never becomes money.
    const promoCover = status === 'completed' && feeFrom === 'sender' && fee > 0 && !isSenderSystem && PROMO_FEE_TYPES.has(input.type) && getEmoneySettings().promoCoversFees ? Math.min(fee, fromWallet.promo_balance ?? 0) : 0;
    const totalDebit = (feeFrom === 'receiver' ? input.amount : input.amount + fee) - promoCover;
    if (!isSenderSystem && !input.allowNegativeSender && fromWallet.balance < totalDebit) {
      throw unprocessable('Insufficient balance', 'insufficient_funds');
    }
    const id = uuid();
    const ts = now();
    db.prepare(
      `INSERT INTO transactions (id, reference, type, status, amount, fee, currency, receive_amount, receive_currency, sender_user_id, receiver_user_id, sender_wallet_id, receiver_wallet_id, note, metadata, idempotency_key, created_at, completed_at, issuance_authority)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      JSON.stringify({ ...(input.metadata ?? {}), feeFrom, ...(promoCover ? { promoFeeCover: promoCover } : {}), ...(issuance ? { issuance } : {}) }),
      input.idempotencyKey ?? null,
      ts,
      status === 'completed' ? ts : null,
      issuance?.authority ?? null,
    );
    if (issuance) recordEvent('issuance', id, `issuance.${issuance.authority}`, issuance.authority === 'admin' || issuance.authority === 'liquidity' ? { type: 'admin', id: issuance.adminId ?? null } : { type: 'system' }, { type: input.type, amount: receiveAmount, currency: receiveCurrency, receiverUserId: input.receiverUserId ?? toWallet.user_id, paymentId: issuance.paymentId ?? null, verificationId: issuance.verificationId ?? null, programme: issuance.programme ?? null, reference: issuance.reference ?? null });
    // Debit sender (held even while pending)
    insertLedgerEntry(id, fromWallet, 'debit', totalDebit);
    if (promoCover > 0) {
      // The covered part of the fee is paid by the platform's marketing budget (treasury → revenue), booked as a programme issuance.
      consumePromoCredit(fromWallet, promoCover, id);
      insertLedgerEntry(id, ensureWallet(treasury.id, input.currency), 'debit', promoCover);
      recordEvent('issuance', id, 'issuance.programme', { type: 'system' }, { type: input.type, amount: promoCover, currency: input.currency, programme: 'promo_fee_cover', receiverUserId: revenue.id });
    }
    if (status === 'completed') {
      insertLedgerEntry(id, toWallet, 'credit', receiveAmount);
      creditFees(id, fee, input.currency, revenue.id, input.feeSplits);
      if (receiveCurrency !== input.currency) postConversionLegs(id, input.currency, feeFrom === 'receiver' ? input.amount - fee : input.amount, receiveCurrency, receiveAmount, treasury.id);
    } else {
      // Hold: park the funds (amount in sender currency + fee) in the escrow account until completion.
      const escrow = ensureWallet(getSystemUser('escrow').id, input.currency);
      insertLedgerEntry(id, escrow, 'credit', totalDebit);
    }
    const balance = assertLedgerBalanced(id);
    recordEvent('ledger', id, `ledger.posted.${status}`, { type: 'system' }, { type: input.type, amount: input.amount, fee, currency: input.currency, debits: balance.d, credits: balance.c, senderUserId: input.senderUserId ?? null, receiverUserId: input.receiverUserId ?? null });
    const posted = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as TransactionRow;
    if (issuance?.authority === 'external_funding' && status === 'completed') reserveHooks.externalFunding(posted);
    publish('transaction.created', { transactionId: id, type: input.type, status, amountMinor: input.amount, currency: input.currency, senderUserId: input.senderUserId ?? null, receiverUserId: input.receiverUserId ?? null }, { aggregateId: id, tenantId: input.receiverUserId ?? input.senderUserId ?? 'platform' });
    return posted;
  })();
}

/**
 * Currency conversion is booked as two balanced legs through the treasury's FX position:
 * the treasury receives the source-currency amount and gives out the target-currency amount.
 */
function postConversionLegs(txId: string, fromCurrency: string, fromAmount: number, toCurrency: string, toAmount: number, treasuryUserId: string) {
  insertLedgerEntry(txId, ensureWallet(treasuryUserId, fromCurrency), 'credit', fromAmount);
  insertLedgerEntry(txId, ensureWallet(treasuryUserId, toCurrency), 'debit', toAmount);
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
    if (tx.receive_currency && tx.receive_currency !== tx.currency) postConversionLegs(tx.id, tx.currency, heldAmount(tx) - tx.fee, tx.receive_currency, tx.receive_amount ?? tx.amount, getSystemUser('treasury').id);
    const metadata = { ...parseJson(tx.metadata, {}), ...(extraMetadata ?? {}) };
    db.prepare("UPDATE transactions SET status = 'completed', completed_at = ?, metadata = ? WHERE id = ?").run(now(), JSON.stringify(metadata), tx.id);
    const balance = assertLedgerBalanced(tx.id);
    recordEvent('ledger', tx.id, 'ledger.completed', { type: 'system' }, { debits: balance.d, credits: balance.c, ...(extraMetadata ?? {}) });
    const done = getTransaction(tx.id)!;
    // E-money redeemed: a holder's balance left the platform through the treasury (withdrawal / external payout).
    if (toWallet.user_id === getSystemUser('treasury').id && done.sender_user_id && !findUserById(done.sender_user_id)?.is_system) reserveHooks.redemption(done);
    for (const h of transactionStatusHooks) h(done, 'completed');
    publish('transaction.settled', { transactionId: done.id, type: done.type, amountMinor: done.amount, currency: done.currency, senderUserId: done.sender_user_id, receiverUserId: done.receiver_user_id }, { aggregateId: done.id, tenantId: done.receiver_user_id ?? done.sender_user_id ?? 'platform' });
    return done;
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
    const balance = assertLedgerBalanced(tx.id);
    recordEvent('ledger', tx.id, `ledger.${status}`, { type: 'system' }, { reason: reason ?? null, debits: balance.d, credits: balance.c });
    const done = getTransaction(tx.id)!;
    for (const h of transactionStatusHooks) h(done, status);
    return done;
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
    assertLedgerBalanced(refund.id);
    recordEvent('ledger', tx.id, 'ledger.reversed', { type: 'system' }, { refundTransactionId: refund.id, refundFee: !!options.refundFee });
    return refund;
  })();
}

/** Outstanding e-money per currency (balances held by non-system users) and how it was issued. */
export function emoneySupply() {
  const db = getDb();
  const outstanding = db.prepare("SELECT w.currency, SUM(w.balance) total, COUNT(*) wallets FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.is_system = 0 GROUP BY w.currency ORDER BY w.currency").all() as { currency: string; total: number; wallets: number }[];
  const issued = db.prepare("SELECT COALESCE(receive_currency, currency) currency, issuance_authority authority, SUM(COALESCE(receive_amount, amount)) total, COUNT(*) count FROM transactions WHERE issuance_authority IS NOT NULL AND status = 'completed' GROUP BY 1, 2").all() as { currency: string; authority: string; total: number; count: number }[];
  const floats = db.prepare("SELECT w.currency, SUM(w.balance) total FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.is_system = 1 AND u.tag LIKE 'payout_%' GROUP BY w.currency").all() as { currency: string; total: number }[];
  return outstanding.map((o) => ({ currency: o.currency, outstanding: o.total, wallets: o.wallets, issued: issued.filter((i) => i.currency === o.currency).map((i) => ({ authority: i.authority, total: i.total, count: i.count })), payoutFloat: floats.find((f) => f.currency === o.currency)?.total ?? 0 }));
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
