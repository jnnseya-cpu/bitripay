import { badRequest, unprocessable } from '../lib/errors';
import { formatMoney } from '@bitripay/shared';
import { calculateFee, enforceLimits, postTransaction, type TransactionRow } from './ledger';
import { getCurrency, convertWithMargin } from './currencies';
import { resolveQuote } from './fx';
import { enforceOutboundRisk } from './risk';
import { getUserWallet, ensureWallet } from './wallets';
import { findUserByIdentifier, type UserRow } from './users';
import { notify } from './notifications';
import { getModules } from './modules';
import { getDb } from '../db';
import { isMerchantRole } from './users';

export interface TransferInput {
  to: string;
  amount: number;
  currency: string;
  note?: string | null;
  idempotencyKey?: string | null;
  type?: 'transfer' | 'qr_payment' | 'merchant_payment';
  /** The request carried a valid step-up token (passkey / 2FA); required when the policy asks for step-up. */
  stepUpVerified?: boolean;
  deviceHash?: string | null;
  ipCountry?: string | null;
}

export function sendMoney(sender: UserRow, input: TransferInput): TransactionRow {
  const recipient = findUserByIdentifier(input.to);
  if (!recipient || recipient.is_system) throw badRequest('Recipient not found', 'recipient_not_found');
  if (recipient.id === sender.id) throw badRequest('You cannot send money to yourself', 'self_transfer');
  if (recipient.status !== 'active') throw unprocessable('Recipient account is not active', 'recipient_inactive');
  const currency = getCurrency(input.currency);
  const type = input.type ?? (isMerchantRole(recipient.role) ? 'merchant_payment' : 'transfer');
  const modules = getModules();
  if (type === 'transfer' && !modules.transfers) throw unprocessable('Transfers are currently disabled', 'module_disabled');
  const fee = calculateFee(type, input.amount, currency.code, null, { userId: sender.id });
  enforceLimits(sender, input.amount, currency.code);
  const firstToRecipient = !getDb().prepare("SELECT 1 FROM transactions WHERE sender_user_id = ? AND receiver_user_id = ? AND status = 'completed' LIMIT 1").get(sender.id, recipient.id);
  enforceOutboundRisk({
    userId: sender.id,
    kind: 'transfer',
    amount: input.amount,
    currency: currency.code,
    subjectType: 'transfer',
    counterparty: { name: recipient.full_name, phone: recipient.phone, email: recipient.email, country: recipient.country },
    method: 'wallet',
    recipientUserId: recipient.id,
    newBeneficiary: firstToRecipient,
    stepUpVerified: input.stepUpVerified ?? false,
    deviceHash: input.deviceHash ?? null,
    ipCountry: input.ipCountry ?? null,
  });
  const fromWallet = getUserWallet(sender.id, currency.code);
  const toWallet = ensureWallet(recipient.id, currency.code);
  const tx = postTransaction({
    type,
    amount: input.amount,
    fee,
    currency: currency.code,
    fromWalletId: fromWallet.id,
    toWalletId: toWallet.id,
    senderUserId: sender.id,
    receiverUserId: recipient.id,
    note: input.note ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    feeFrom: type === 'merchant_payment' ? 'receiver' : 'sender',
  });
  notify(recipient.id, 'Money received', `${sender.full_name} (@${sender.tag}) sent you ${formatMoney(input.amount, currency)}${input.note ? ` – "${input.note}"` : ''}.`, {
    kind: 'transfer_in',
    transactionId: tx.id,
  });
  notify(sender.id, 'Money sent', `You sent ${formatMoney(input.amount, currency)} to ${recipient.full_name} (@${recipient.tag}).`, { kind: 'transfer_out', transactionId: tx.id });
  return tx;
}

/** Exchange between the user's own wallets at the platform rate (mid-market minus margin). */
export function exchange(
  user: UserRow,
  fromCurrency: string,
  toCurrency: string,
  amount: number,
  opts: { quoteId?: string | null } = {},
): { tx: TransactionRow; rate: number; received: number; quoteId: string | null; guaranteed: boolean } {
  if (!getModules().exchange) throw unprocessable('Currency exchange is currently disabled', 'module_disabled');
  const from = getCurrency(fromCurrency);
  const to = getCurrency(toCurrency);
  if (from.code === to.code) throw badRequest('Choose two different currencies');
  const fee = calculateFee('exchange', amount, from.code);
  const live = convertWithMargin(amount, from.code, to.code);
  const locked = resolveQuote(opts.quoteId, user.id, from.code, to.code);
  // A guaranteed, unexpired quote fixes the customer rate; otherwise the current disclosed rate applies.
  const quote = locked ? { amount: Math.round((amount / 10 ** from.decimals) * locked.rate * 10 ** to.decimals), rate: locked.rate, midRate: locked.midRate, marginBps: locked.markupBps } : live;
  if (quote.amount <= 0) throw badRequest('Amount too small to convert');
  const fromWallet = getUserWallet(user.id, from.code);
  const toWallet = ensureWallet(user.id, to.code);
  const tx = postTransaction({
    type: 'exchange',
    amount,
    fee,
    currency: from.code,
    receiveAmount: quote.amount,
    receiveCurrency: to.code,
    fromWalletId: fromWallet.id,
    toWalletId: toWallet.id,
    senderUserId: user.id,
    receiverUserId: user.id,
    note: `Exchange ${from.code} → ${to.code}`,
    metadata: { rate: quote.rate, midRate: quote.midRate, marginBps: quote.marginBps, quoteId: locked?.id ?? null, guaranteed: !!locked, provider: locked?.provider ?? null },
  });
  return { tx, rate: quote.rate, received: quote.amount, quoteId: locked?.id ?? null, guaranteed: !!locked };
}
