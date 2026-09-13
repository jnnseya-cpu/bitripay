import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { badRequest, forbidden, notFound, unprocessable } from '../lib/errors';
import { formatMoney, type BankAccount } from '@bitripay/shared';
import { getCurrency, toBase } from './currencies';
import { calculateFee, completeTransaction, enforceLimits, postTransaction, reverseTransaction, getTransaction, type TransactionRow } from './ledger';
import { createPayoutInstruction, getPayoutByTransaction, settlePayout, failPayout } from './payouts';
import { enforceOutboundRisk } from './risk';
import { getUserWallet } from './wallets';
import type { UserRow } from './users';
import { notify } from './notifications';
import { getAppSettings } from './settings';
import { getModules } from './modules';
import { getOperator } from './momo';
import { normalizePhone } from './users';
import { registerDestinationChange, assertDestinationUsable } from './risk/accountProtection';
import { findUserById } from './users';

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
  const account = toBankAccount(db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(id));
  const owner = findUserById(userId);
  if (owner)
    registerDestinationChange(
      owner,
      { kind: 'bank_account', refId: id, previous: null, next: { bankName: account.bankName, accountNumber: account.accountNumber, currency: account.currency } },
      { type: 'user', id: userId },
    );
  return account;
}

export function deleteBankAccount(userId: string, id: string) {
  const res = getDb().prepare('DELETE FROM bank_accounts WHERE id = ? AND user_id = ?').run(id, userId);
  if (res.changes === 0) throw notFound('Bank account not found');
}

export type WithdrawalDestination =
  | { method: 'bank'; bankAccountId: string }
  | { method: 'bank'; bankName: string; accountName: string; accountNumber: string; country?: string | null; swift?: string | null }
  | { method: 'mobile_money'; operatorId: string; phone: string; name?: string | null };

/**
 * Request a payout from the wallet to a bank account or ANY mobile money number (world operator directory).
 * Funds are held until an admin (or an agent with float for that operator) marks the payout as sent –
 * no operator API is required.
 */
export function requestWithdrawal(
  user: UserRow,
  input: {
    amount: number;
    currency: string;
    bankAccountId?: string | null;
    destination?: WithdrawalDestination;
    note?: string | null;
    routeId?: string | null;
    sourceCurrency?: string | null;
    stepUpVerified?: boolean;
    deviceHash?: string | null;
    ipCountry?: string | null;
  },
): TransactionRow {
  if (!getModules().withdrawals) throw unprocessable('Withdrawals are currently disabled', 'module_disabled');
  if (getAppSettings().requireKycForWithdrawals && user.kyc_status !== 'verified') throw forbidden('Complete KYC verification before withdrawing', 'kyc_required');
  const cur = getCurrency(input.currency);
  const dest: WithdrawalDestination = input.destination ?? { method: 'bank', bankAccountId: input.bankAccountId ?? '' };
  let note = input.note ?? null;
  let metadata: Record<string, unknown>;
  if (dest.method === 'mobile_money') {
    const op = getOperator(dest.operatorId);
    if (!op.enabled || !op.payoutEnabled) throw unprocessable(`Payouts to ${op.name} are currently unavailable`, 'payout_unavailable');
    const phone = normalizePhone(dest.phone);
    if (!phone) throw badRequest('Enter a valid mobile money number');
    metadata = { method: 'mobile_money', operator: { id: op.id, name: op.name, country: op.country, currency: op.currency }, phone, recipientName: dest.name ?? null };
    note = note ?? `Payout to ${op.name} ${phone}`;
  } else if ('bankAccountId' in dest && dest.bankAccountId) {
    const bank = getDb().prepare('SELECT * FROM bank_accounts WHERE id = ? AND user_id = ?').get(dest.bankAccountId, user.id) as any;
    if (!bank) throw notFound('Bank account not found');
    if (bank.currency !== cur.code) throw badRequest(`This bank account receives ${bank.currency}; choose a matching wallet or add another account`);
    metadata = { bankAccount: toBankAccount(bank), method: 'bank' };
    note = note ?? `Withdrawal to ${bank.bank_name} •••• ${String(bank.account_number).slice(-4)}`;
  } else if ('bankName' in dest) {
    if (!dest.bankName || !dest.accountNumber) throw badRequest('Bank name and account number are required');
    metadata = {
      bankAccount: { bankName: dest.bankName, accountName: dest.accountName, accountNumber: dest.accountNumber, country: dest.country ?? null, swift: dest.swift ?? null, currency: cur.code },
      method: 'bank',
    };
    note = note ?? `Bank transfer to ${dest.bankName} •••• ${String(dest.accountNumber).slice(-4)}`;
  } else {
    throw badRequest('Choose a payout destination');
  }
  const fee = calculateFee('withdrawal', input.amount, cur.code, null, { userId: user.id });
  enforceLimits(user, input.amount, cur.code);
  // New beneficiaries cool off: a bank account added minutes ago, or a mobile money number never paid before.
  const beneficiaryCreatedAt = (() => {
    if (metadata.method === 'bank' && 'bankAccountId' in dest && dest.bankAccountId)
      return (getDb().prepare('SELECT created_at FROM bank_accounts WHERE id = ?').get(dest.bankAccountId) as any)?.created_at ?? now();
    if (metadata.method === 'mobile_money') {
      const prior = getDb()
        .prepare("SELECT created_at FROM transactions WHERE sender_user_id = ? AND type = 'withdrawal' AND status = 'completed' AND metadata LIKE ? ORDER BY created_at ASC LIMIT 1")
        .get(user.id, `%${(metadata as any).phone}%`) as any;
      return prior?.created_at ?? now();
    }
    return now(); // free-form bank details are always a brand-new beneficiary
  })();
  const counterparty =
    metadata.method === 'mobile_money'
      ? { name: (metadata as any).recipientName, phone: (metadata as any).phone, country: (metadata as any).operator?.country }
      : { name: (metadata as any).bankAccount?.accountName, country: (metadata as any).bankAccount?.country };
  const risk = enforceOutboundRisk({
    userId: user.id,
    kind: 'withdrawal',
    amount: input.amount,
    currency: cur.code,
    subjectType: 'withdrawal',
    counterparty,
    beneficiaryCreatedAt,
    method: metadata.method as string,
    newBeneficiary: Date.now() - Date.parse(beneficiaryCreatedAt) < 60_000,
    stepUpVerified: input.stepUpVerified ?? false,
    deviceHash: input.deviceHash ?? null,
    ipCountry: input.ipCountry ?? null,
  });
  if (risk.action === 'review') metadata = { ...metadata, riskFlags: risk.flags, riskScore: risk.score };
  if (metadata.method === 'bank' && 'bankAccountId' in dest && dest.bankAccountId) assertDestinationUsable(user, 'bank_account', dest.bankAccountId, toBase(input.amount, cur.code));
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
    note,
    metadata,
  });
  // Every external payout becomes a payout instruction routed to a prefunded local account / approved agent.
  const md = metadata as any;
  const bankDetails = md.bankAccount
    ? {
        bankName: md.bankAccount.bankName,
        accountName: md.bankAccount.accountName,
        accountNumber: md.bankAccount.accountNumber,
        country: md.bankAccount.country ?? null,
        swift: md.bankAccount.swift ?? null,
      }
    : null;
  const payout = createPayoutInstruction(
    {
      transactionId: tx.id,
      userId: user.id,
      routeId: input.routeId ?? null,
      rail: md.method === 'mobile_money' ? 'mobile_money' : 'bank',
      operatorId: md.method === 'mobile_money' ? md.operator.id : null,
      recipientMsisdn: md.method === 'mobile_money' ? md.phone : null,
      recipientName: md.method === 'mobile_money' ? md.recipientName : (bankDetails?.accountName ?? null),
      bankDetails,
      country: md.method === 'mobile_money' ? md.operator.country : (bankDetails?.country ?? user.country),
      amount: input.amount,
      currency: cur.code,
      sourceCurrency: input.sourceCurrency ?? cur.code,
      sourceCountry: user.country,
    },
    { type: 'user', id: user.id },
  );
  getDb()
    .prepare('UPDATE transactions SET metadata = ? WHERE id = ?')
    .run(JSON.stringify({ ...JSON.parse(tx.metadata), payoutId: payout.id, payoutReference: payout.reference, payoutStage: payout.stage }), tx.id);
  notify(
    user.id,
    'Payout requested',
    payout.stage === 'QUEUED'
      ? `Your payout of ${formatMoney(input.amount, cur)} is queued for execution from a local payout account.`
      : `Your payout of ${formatMoney(input.amount, cur)} is waiting for local liquidity; your funds are held safely.`,
    { kind: 'withdrawal', transactionId: tx.id, payoutId: payout.id },
  );
  return getTransaction(tx.id)!;
}

/**
 * Administrative settlement is the exception: it needs independent maker-checker approval with
 * documentary evidence (operator / bank reference). These helpers are invoked by the verification
 * service once a second administrator has approved; they are never reachable from a single admin call.
 */
export function approveWithdrawal(id: string, adminId: string, payoutReference: string | null, verificationId: string): TransactionRow {
  const payout = getPayoutByTransaction(id);
  if (payout) {
    settlePayout(payout.id, { type: 'admin', id: adminId }, { source: 'manual', externalRef: payoutReference ?? null, verificationId });
    return getTransaction(id)!;
  }
  const tx = completeTransaction(id, { approvedBy: adminId, payoutReference: payoutReference ?? null, verificationId });
  notify(tx.sender_user_id!, 'Withdrawal completed', `Your withdrawal ${tx.reference} has been paid out.`, { kind: 'withdrawal', transactionId: tx.id });
  return tx;
}

export function rejectWithdrawal(id: string, adminId: string, reason: string, verificationId: string): TransactionRow {
  const payout = getPayoutByTransaction(id);
  if (payout) {
    failPayout(payout.id, { type: 'admin', id: adminId }, reason, { verificationId });
    return getTransaction(id)!;
  }
  const tx = reverseTransaction(id, 'rejected', reason);
  notify(tx.sender_user_id!, 'Withdrawal rejected', `Your withdrawal ${tx.reference} was rejected: ${reason}. Funds were returned to your wallet.`, { kind: 'withdrawal', transactionId: tx.id });
  return tx;
}
