import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { badRequest, forbidden, notFound, unprocessable } from '../lib/errors';
import { formatMoney, type BankAccount } from '@bitripay/shared';
import { getCurrency } from './currencies';
import { calculateFee, completeTransaction, enforceLimits, postTransaction, reverseTransaction, type TransactionRow } from './ledger';
import { getUserWallet } from './wallets';
import type { UserRow } from './users';
import { notify } from './notifications';
import { getAppSettings } from './settings';
import { getModules } from './modules';

export function toBankAccount(row: any): BankAccount {
  return { id: row.id, bankName: row.bank_name, accountName: row.account_name, accountNumber: row.account_number, currency: row.currency, country: row.country, isDefault: !!row.is_default };
}

export function listBankAccounts(userId: string): BankAccount[] {
  return getDb().prepare('SELECT * FROM bank_accounts WHERE user_id = ? ORDER BY is_default DESC, created_at DESC').all(userId).map(toBankAccount);
}

export function addBankAccount(userId: string, input: { bankName: string; accountName: string; accountNumber: string; currency: string; country?: string | null; swift?: string | null }): BankAccount {
  const db = getDb();
  getCurrency(input.currency);
  const count = (db.prepare('SELECT COUNT(*) c FROM bank_accounts WHERE user_id = ?').get(userId) as any).c;
  const id = uuid();
  db.prepare('INSERT INTO bank_accounts (id, user_id, bank_name, account_name, account_number, currency, country, swift, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    userId,
    input.bankName.trim(),
    input.accountName.trim(),
    input.accountNumber.trim(),
    input.currency.toUpperCase(),
    input.country ?? null,
    input.swift ?? null,
    count === 0 ? 1 : 0,
    now(),
  );
  return toBankAccount(db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(id));
}

export function deleteBankAccount(userId: string, id: string) {
  const res = getDb().prepare('DELETE FROM bank_accounts WHERE id = ? AND user_id = ?').run(id, userId);
  if (res.changes === 0) throw notFound('Bank account not found');
}

/** Request a withdrawal to a bank account. Funds are held until an admin marks the payout as sent. */
export function requestWithdrawal(user: UserRow, input: { amount: number; currency: string; bankAccountId: string; note?: string | null }): TransactionRow {
  if (!getModules().withdrawals) throw unprocessable('Withdrawals are currently disabled', 'module_disabled');
  if (getAppSettings().requireKycForWithdrawals && user.kyc_status !== 'verified') throw forbidden('Complete KYC verification before withdrawing', 'kyc_required');
  const bank = getDb().prepare('SELECT * FROM bank_accounts WHERE id = ? AND user_id = ?').get(input.bankAccountId, user.id) as any;
  if (!bank) throw notFound('Bank account not found');
  const cur = getCurrency(input.currency);
  if (bank.currency !== cur.code) throw badRequest(`This bank account receives ${bank.currency}; choose a matching wallet or add another account`);
  const fee = calculateFee('withdrawal', input.amount, cur.code);
  enforceLimits(user, input.amount, cur.code);
  const wallet = getUserWallet(user.id, cur.code);
  const tx = postTransaction({
    type: 'withdrawal',
    amount: input.amount,
    fee,
    currency: cur.code,
    fromWalletId: wallet.id,
    toWalletId: null,
    senderUserId: user.id,
    receiverUserId: null,
    status: 'pending',
    note: input.note ?? `Withdrawal to ${bank.bank_name} •••• ${String(bank.account_number).slice(-4)}`,
    metadata: { bankAccount: toBankAccount(bank), method: 'bank' },
  });
  notify(user.id, 'Withdrawal requested', `Your withdrawal of ${formatMoney(input.amount, cur)} is being processed.`, { kind: 'withdrawal', transactionId: tx.id });
  return tx;
}

export function approveWithdrawal(id: string, adminId: string, payoutReference?: string): TransactionRow {
  const tx = completeTransaction(id, { approvedBy: adminId, payoutReference: payoutReference ?? null });
  notify(tx.sender_user_id!, 'Withdrawal completed', `Your withdrawal ${tx.reference} has been paid out.`, { kind: 'withdrawal', transactionId: tx.id });
  return tx;
}

export function rejectWithdrawal(id: string, adminId: string, reason: string): TransactionRow {
  const tx = reverseTransaction(id, 'rejected', reason);
  notify(tx.sender_user_id!, 'Withdrawal rejected', `Your withdrawal ${tx.reference} was rejected: ${reason}. Funds were returned to your wallet.`, { kind: 'withdrawal', transactionId: tx.id });
  return tx;
}
