import { getDb } from '../db';
import { uuid, now, shortCode } from '../lib/ids';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { parseJson } from '../lib/json';
import { formatMoney } from '@bitripay/shared';
import { convertWithMargin, getCurrency } from './currencies';
import { calculateFee, completeTransaction, enforceLimits, postTransaction, reverseTransaction } from './ledger';
import { ensureWallet, getUserWallet } from './wallets';
import { findUserByIdentifier, findUserById, toPublicUser, type UserRow } from './users';
import { notify } from './notifications';
import { getModules } from './modules';
import { getSystemUser } from './users';

export type PayoutMethod = 'wallet' | 'bank' | 'cash_pickup';

export interface RemittanceQuote {
  sourceAmount: number;
  sourceCurrency: string;
  targetAmount: number;
  targetCurrency: string;
  rate: number;
  fee: number;
  total: number;
}

export function quoteRemittance(sourceAmount: number, sourceCurrency: string, targetCurrency: string): RemittanceQuote {
  const from = getCurrency(sourceCurrency);
  const to = getCurrency(targetCurrency);
  const fee = calculateFee('remittance', sourceAmount, from.code);
  const q = convertWithMargin(sourceAmount, from.code, to.code);
  return { sourceAmount, sourceCurrency: from.code, targetAmount: q.amount, targetCurrency: to.code, rate: q.rate, fee, total: sourceAmount + fee };
}

export interface RecipientInput {
  name: string;
  country?: string | null;
  phone?: string | null;
  email?: string | null;
  tag?: string | null;
  bankName?: string | null;
  accountNumber?: string | null;
  swift?: string | null;
  address?: string | null;
  idNumber?: string | null;
}

export function toRemittance(row: any) {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    senderUserId: row.sender_user_id,
    recipientUserId: row.recipient_user_id,
    recipient: parseJson(row.recipient, {}),
    payoutMethod: row.payout_method as PayoutMethod,
    sourceAmount: row.source_amount,
    sourceCurrency: row.source_currency,
    targetAmount: row.target_amount,
    targetCurrency: row.target_currency,
    rate: row.rate,
    fee: row.fee,
    status: row.status,
    pickupCode: row.pickup_code,
    pickupAgentId: row.pickup_agent_id,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    sender: findUserById(row.sender_user_id) ? toPublicUser(findUserById(row.sender_user_id)!) : null,
  };
}

export function sendRemittance(sender: UserRow, input: { amount: number; sourceCurrency: string; targetCurrency: string; payoutMethod: PayoutMethod; recipient: RecipientInput; savedRecipientId?: string | null; note?: string | null; saveRecipient?: boolean }) {
  if (!getModules().remittance) throw unprocessable('Remittance is currently disabled', 'module_disabled');
  const db = getDb();
  const quote = quoteRemittance(input.amount, input.sourceCurrency, input.targetCurrency);
  enforceLimits(sender, input.amount, quote.sourceCurrency);
  const fromWallet = getUserWallet(sender.id, quote.sourceCurrency);
  const remittanceId = uuid();
  const recipient = { ...input.recipient };

  return db.transaction(() => {
    let recipientUser: UserRow | undefined;
    if (input.payoutMethod === 'wallet') {
      const identifier = input.recipient.tag || input.recipient.email || input.recipient.phone;
      if (!identifier) throw badRequest('Provide the recipient tag, email or phone for wallet payout');
      recipientUser = findUserByIdentifier(identifier);
      if (!recipientUser || recipientUser.is_system) throw notFound('Recipient wallet not found', 'recipient_not_found');
      if (recipientUser.id === sender.id) throw badRequest('You cannot send a remittance to yourself');
    } else if (input.payoutMethod === 'bank') {
      if (!input.recipient.bankName || !input.recipient.accountNumber) throw badRequest('Bank name and account number are required');
    }
    const instant = input.payoutMethod === 'wallet';
    const toWallet = instant ? ensureWallet(recipientUser!.id, quote.targetCurrency) : null;
    const tx = postTransaction({
      type: 'remittance',
      amount: quote.sourceAmount,
      fee: quote.fee,
      currency: quote.sourceCurrency,
      receiveAmount: quote.targetAmount,
      receiveCurrency: quote.targetCurrency,
      fromWalletId: fromWallet.id,
      toWalletId: toWallet?.id ?? ensureWallet(getSystemUser('treasury').id, quote.targetCurrency).id,
      senderUserId: sender.id,
      receiverUserId: recipientUser?.id ?? null,
      status: instant ? 'completed' : 'pending',
      note: input.note ?? `Remittance to ${input.recipient.name}`,
      metadata: { remittanceId, payoutMethod: input.payoutMethod, rate: quote.rate, recipientName: input.recipient.name, recipientCountry: input.recipient.country ?? null },
    });
    const pickupCode = input.payoutMethod === 'cash_pickup' ? `${shortCode(4)}-${shortCode(4)}` : null;
    db.prepare(
      `INSERT INTO remittances (id, transaction_id, sender_user_id, recipient_user_id, saved_recipient_id, recipient, payout_method, source_amount, source_currency, target_amount, target_currency, rate, fee, status, pickup_code, pickup_agent_id, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      remittanceId,
      tx.id,
      sender.id,
      recipientUser?.id ?? null,
      input.savedRecipientId ?? null,
      JSON.stringify(recipient),
      input.payoutMethod,
      quote.sourceAmount,
      quote.sourceCurrency,
      quote.targetAmount,
      quote.targetCurrency,
      quote.rate,
      quote.fee,
      instant ? 'completed' : input.payoutMethod === 'cash_pickup' ? 'ready_for_pickup' : 'pending',
      pickupCode,
      now(),
      instant ? now() : null,
    );
    if (input.saveRecipient) saveRecipient(sender.id, { ...input.recipient, payoutMethod: input.payoutMethod, currency: quote.targetCurrency });
    const target = getCurrency(quote.targetCurrency);
    if (recipientUser) {
      notify(recipientUser.id, 'Remittance received', `${sender.full_name} sent you ${formatMoney(quote.targetAmount, target)} from abroad.`, { kind: 'remittance_in', transactionId: tx.id });
    }
    notify(sender.id, 'Remittance sent', instant ? `Your remittance of ${formatMoney(quote.targetAmount, target)} was delivered instantly.` : `Your remittance of ${formatMoney(quote.targetAmount, target)} is being processed${pickupCode ? `. Pickup code: ${pickupCode}` : ''}.`, {
      kind: 'remittance_out',
      transactionId: tx.id,
      remittanceId,
    });
    return { ...toRemittance(db.prepare('SELECT * FROM remittances WHERE id = ?').get(remittanceId)), transaction: tx };
  })();
}

export function listRemittances(userId: string) {
  return (getDb().prepare('SELECT * FROM remittances WHERE sender_user_id = ? OR recipient_user_id = ? ORDER BY created_at DESC LIMIT 100').all(userId, userId) as any[]).map(toRemittance);
}

export function getRemittance(id: string) {
  const row = getDb().prepare('SELECT * FROM remittances WHERE id = ? OR pickup_code = ?').get(id, id.toUpperCase());
  if (!row) throw notFound('Remittance not found');
  return toRemittance(row);
}

/** Agent pays out a cash pickup: verifies the code, gets the target amount credited to their float. */
export function payoutCashPickup(agent: UserRow, pickupCode: string, recipientIdNumber?: string) {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM remittances WHERE pickup_code = ?').get(pickupCode.trim().toUpperCase()) as any;
    if (!row) throw notFound('No remittance found for this pickup code', 'pickup_not_found');
    if (row.status !== 'ready_for_pickup') throw conflict(`This remittance is ${row.status.replace(/_/g, ' ')}`);
    const recipient = parseJson<any>(row.recipient, {});
    if (recipient.idNumber && recipientIdNumber && recipient.idNumber.replace(/\s/g, '').toLowerCase() !== recipientIdNumber.replace(/\s/g, '').toLowerCase()) {
      throw forbidden('Recipient ID number does not match', 'id_mismatch');
    }
    const agentWallet = ensureWallet(agent.id, row.target_currency);
    // Move the held target amount: pending tx receiver wallet is treasury; complete it to treasury then pay the agent from treasury.
    completeTransaction(row.transaction_id, { pickupAgentId: agent.id, paidOutAt: now() });
    const treasury = ensureWallet(getSystemUser('treasury').id, row.target_currency);
    postTransaction({
      type: 'agent_cash_out',
      amount: row.target_amount,
      currency: row.target_currency,
      fromWalletId: treasury.id,
      toWalletId: agentWallet.id,
      senderUserId: row.sender_user_id,
      receiverUserId: agent.id,
      note: `Cash pickup payout ${row.pickup_code}`,
      metadata: { remittanceId: row.id, method: 'cash_pickup' },
      // Releases the sender's held remittance (completed into the treasury just above) to the agent who paid the cash – not new money.
      issuance: { authority: 'internal_release', originTransactionId: row.transaction_id, reference: `remittance:${row.id}` },
    });
    db.prepare("UPDATE remittances SET status = 'completed', pickup_agent_id = ?, completed_at = ? WHERE id = ?").run(agent.id, now(), row.id);
    notify(row.sender_user_id, 'Cash picked up', `${recipient.name} collected ${formatMoney(row.target_amount, getCurrency(row.target_currency, false))} at agent ${agent.business_name || agent.full_name}.`, { kind: 'remittance_pickup', remittanceId: row.id });
    return toRemittance(db.prepare('SELECT * FROM remittances WHERE id = ?').get(row.id));
  })();
}

/** Admin marks a bank payout as completed or rejects it (refunding the sender). */
export function settleRemittance(id: string, adminId: string, outcome: 'completed' | 'rejected', reason?: string) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM remittances WHERE id = ?').get(id) as any;
  if (!row) throw notFound('Remittance not found');
  if (!['pending', 'ready_for_pickup', 'processing'].includes(row.status)) throw conflict(`Remittance is ${row.status}`);
  if (outcome === 'completed') {
    completeTransaction(row.transaction_id, { settledBy: adminId });
    db.prepare("UPDATE remittances SET status = 'completed', completed_at = ? WHERE id = ?").run(now(), id);
    notify(row.sender_user_id, 'Remittance delivered', `Your remittance to ${parseJson<any>(row.recipient, {}).name} has been paid out.`, { kind: 'remittance_out', remittanceId: id });
  } else {
    reverseTransaction(row.transaction_id, 'rejected', reason);
    db.prepare("UPDATE remittances SET status = 'rejected' WHERE id = ?").run(id);
    notify(row.sender_user_id, 'Remittance refunded', `Your remittance was cancelled${reason ? `: ${reason}` : ''}. Funds returned to your wallet.`, { kind: 'remittance_out', remittanceId: id });
  }
  return toRemittance(db.prepare('SELECT * FROM remittances WHERE id = ?').get(id));
}

export function listSavedRecipients(userId: string) {
  return (getDb().prepare('SELECT * FROM saved_recipients WHERE user_id = ? ORDER BY created_at DESC').all(userId) as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    country: r.country,
    phone: r.phone,
    email: r.email,
    tag: r.tag,
    payoutMethod: r.payout_method,
    bankName: r.bank_name,
    accountNumber: r.account_number,
    currency: r.currency,
    createdAt: r.created_at,
  }));
}

export function saveRecipient(userId: string, input: RecipientInput & { payoutMethod: PayoutMethod; currency?: string | null }) {
  const id = uuid();
  getDb()
    .prepare('INSERT INTO saved_recipients (id, user_id, name, country, phone, email, tag, payout_method, bank_name, account_number, currency, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, input.name, input.country ?? null, input.phone ?? null, input.email ?? null, input.tag ?? null, input.payoutMethod, input.bankName ?? null, input.accountNumber ?? null, input.currency ?? null, now());
  return listSavedRecipients(userId).find((r) => r.id === id)!;
}

export function deleteSavedRecipient(userId: string, id: string) {
  const res = getDb().prepare('DELETE FROM saved_recipients WHERE id = ? AND user_id = ?').run(id, userId);
  if (res.changes === 0) throw notFound('Recipient not found');
}
