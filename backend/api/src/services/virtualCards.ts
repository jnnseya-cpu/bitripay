import { getDb } from '../db';
import { uuid, now, numericCode } from '../lib/ids';
import { encrypt, decrypt, sha256, hmacSha256, safeEqual } from '../lib/crypto';
import { config } from '../config';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { BITRIPAY_CARD_PREFIX, luhnCheckDigit, formatMoney, type VirtualCard } from '@bitripay/shared';
import { getCurrency } from './currencies';
import { calculateFee, postTransaction } from './ledger';
import { ensureWallet, getUserWallet } from './wallets';
import { getSystemUser, findUserById, type UserRow } from './users';
import { notify } from './notifications';
import { getModules } from './modules';
import { resolveFeeRule } from './finops/fees';
import { fromBase } from './currencies';

export function toVirtualCard(row: any): VirtualCard {
  return {
    id: row.id,
    currency: row.currency,
    balance: row.balance,
    maskedNumber: `•••• •••• •••• ${row.last4}`,
    expMonth: row.exp_month,
    expYear: row.exp_year,
    holderName: row.holder_name,
    status: row.status,
    createdAt: row.created_at,
  };
}

/**
 * The CVV is never stored. It is derived from what the card already is – its PAN hash and expiry – under APP_SECRET:
 * HMAC-SHA256(APP_SECRET, pan_hash + exp_month + exp_year + 'cvv') reduced to three digits. Cards issued before
 * this scheme keep their encrypted CVV and are verified against it.
 */
export function deriveCvv(panHash: string, expMonth: number, expYear: number): string {
  const digest = hmacSha256(config.appSecret, `${panHash}${expMonth}${expYear}cvv`);
  return String(parseInt(digest.slice(0, 12), 16) % 1000).padStart(3, '0');
}

function cardCvv(row: { pan_hash: string; exp_month: number; exp_year: number; cvv_encrypted: string | null }): string {
  return row.cvv_encrypted ? decrypt(row.cvv_encrypted) : deriveCvv(row.pan_hash, Number(row.exp_month), Number(row.exp_year));
}

function generatePan(): string {
  let pan = '';
  do {
    const body = BITRIPAY_CARD_PREFIX + numericCode(9);
    pan = body + luhnCheckDigit(body);
  } while (getDb().prepare('SELECT 1 FROM virtual_cards WHERE pan_hash = ?').get(sha256(pan)));
  return pan;
}

export function listVirtualCards(userId: string): VirtualCard[] {
  return getDb().prepare("SELECT * FROM virtual_cards WHERE user_id = ? AND status != 'closed' ORDER BY created_at DESC").all(userId).map(toVirtualCard);
}

function getCardRow(userId: string, id: string) {
  const row = getDb().prepare('SELECT * FROM virtual_cards WHERE id = ? AND user_id = ?').get(id, userId) as any;
  if (!row) throw notFound('Card not found', 'card_not_found');
  return row;
}

/** The first load a new card must carry under the tariff (minimum amount of the issue operation), in minor units of `currency`. */
export function virtualCardMinimumLoad(currency: string): number {
  const rule = resolveFeeRule('virtual_card_issue')?.rule;
  return rule?.minAmount ? fromBase(rule.minAmount, currency) : 0;
}

/**
 * Issue a card. The tariff prices the issue as a fixed fee plus a percentage of the first load, with a minimum first
 * load; the wallet is debited first load + fee in one transaction and the card starts with the first load.
 */
export function issueVirtualCard(user: UserRow, currency: string, label?: string | null, firstLoad?: number | null): VirtualCard {
  if (!getModules().virtualCards) throw unprocessable('Virtual cards are currently disabled', 'module_disabled');
  if (user.kyc_status !== 'verified' && listVirtualCards(user.id).length >= 1) throw forbidden('Complete KYC verification to issue more than one virtual card', 'kyc_required');
  const cur = getCurrency(currency);
  const load = firstLoad ?? virtualCardMinimumLoad(cur.code);
  if (!Number.isInteger(load) || load < 0) throw badRequest('Invalid first load', 'invalid_amount');
  const fee = calculateFee('virtual_card_issue', load, cur.code, null, { userId: user.id, band: load > 0 });
  const pan = generatePan();
  const exp = new Date();
  exp.setFullYear(exp.getFullYear() + 3);
  const id = uuid();
  getDb()
    .prepare(
      'INSERT INTO virtual_cards (id, user_id, currency, balance, pan_encrypted, pan_hash, last4, exp_month, exp_year, cvv_encrypted, holder_name, label, status, created_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, user.id, cur.code, encrypt(pan), sha256(pan), pan.slice(-4), exp.getMonth() + 1, exp.getFullYear(), null, user.full_name.toUpperCase(), label ?? null, 'active', now());
  if (load > 0 || fee > 0) {
    const wallet = getUserWallet(user.id, cur.code);
    const treasury = ensureWallet(getSystemUser('treasury').id, cur.code);
    // A card with no first load still pays the fixed issue fee: the fee is the whole debit and nothing lands on the card.
    postTransaction({
      type: 'virtual_card_funding',
      amount: load > 0 ? load : fee,
      fee: load > 0 ? fee : 0,
      currency: cur.code,
      fromWalletId: wallet.id,
      toWalletId: treasury.id,
      senderUserId: user.id,
      receiverUserId: user.id,
      note: `Issue virtual card •••• ${pan.slice(-4)}`,
      metadata: { cardId: id, direction: 'issue', firstLoad: load, issueFee: fee },
    });
    if (load > 0) getDb().prepare('UPDATE virtual_cards SET balance = balance + ? WHERE id = ?').run(load, id);
  }
  notify(user.id, 'Virtual card issued', `Your new ${cur.code} virtual card ending in ${pan.slice(-4)} is ready.`, {
    kind: 'virtual_card',
    cardId: id,
    template: 'virtual_card.issued',
    vars: { currency: cur.code, last4: pan.slice(-4) },
  });
  return toVirtualCard(getCardRow(user.id, id));
}

/** Reveal full card details (PIN-protected at the route level). */
export function revealVirtualCard(userId: string, id: string) {
  const row = getCardRow(userId, id);
  return { ...toVirtualCard(row), number: decrypt(row.pan_encrypted), cvv: cardCvv(row) };
}

export function setVirtualCardStatus(userId: string, id: string, status: 'active' | 'frozen' | 'closed') {
  const row = getCardRow(userId, id);
  if (status === 'closed' && row.balance > 0) {
    // return remaining balance to the wallet before closing
    withdrawFromVirtualCard(findUserById(userId)!, id, row.balance);
  }
  getDb().prepare('UPDATE virtual_cards SET status = ? WHERE id = ?').run(status, id);
  return toVirtualCard(getCardRow(userId, id));
}

/** Move money from the wallet onto the card (card float is held by the treasury). */
export function fundVirtualCard(user: UserRow, id: string, amount: number): VirtualCard {
  const db = getDb();
  return db.transaction(() => {
    const row = getCardRow(user.id, id);
    if (row.status !== 'active') throw conflict('Card is not active', 'card_inactive');
    const fee = calculateFee('virtual_card_funding', amount, row.currency, null, { userId: user.id });
    const wallet = getUserWallet(user.id, row.currency);
    const treasury = ensureWallet(getSystemUser('treasury').id, row.currency);
    postTransaction({
      type: 'virtual_card_funding',
      amount,
      fee,
      currency: row.currency,
      fromWalletId: wallet.id,
      toWalletId: treasury.id,
      senderUserId: user.id,
      receiverUserId: user.id,
      note: `Fund virtual card •••• ${row.last4}`,
      metadata: { cardId: id, direction: 'fund' },
    });
    db.prepare('UPDATE virtual_cards SET balance = balance + ? WHERE id = ?').run(amount, id);
    return toVirtualCard(getCardRow(user.id, id));
  })();
}

export function withdrawFromVirtualCard(user: UserRow, id: string, amount: number): VirtualCard {
  const db = getDb();
  return db.transaction(() => {
    const row = getCardRow(user.id, id);
    if (row.balance < amount) throw unprocessable('Insufficient card balance', 'insufficient_funds');
    const wallet = ensureWallet(user.id, row.currency);
    const treasury = ensureWallet(getSystemUser('treasury').id, row.currency);
    postTransaction({
      type: 'virtual_card_funding',
      amount,
      currency: row.currency,
      fromWalletId: treasury.id,
      toWalletId: wallet.id,
      senderUserId: user.id,
      receiverUserId: user.id,
      note: `Withdraw from virtual card •••• ${row.last4}`,
      metadata: { cardId: id, direction: 'withdraw' },
    });
    db.prepare('UPDATE virtual_cards SET balance = balance - ? WHERE id = ?').run(amount, id);
    return toVirtualCard(getCardRow(user.id, id));
  })();
}

/**
 * Charge a BitriPay virtual card at a merchant checkout. Validates PAN/expiry/CVV, debits the card
 * balance and posts a merchant payment from the treasury (which holds the card float).
 */
export function chargeVirtualCard(
  card: { number: string; expMonth: number; expYear: number; cvc: string },
  amount: number,
  currency: string,
  merchant: UserRow,
  note: string,
  metadata: Record<string, unknown>,
) {
  const db = getDb();
  return db.transaction(() => {
    const pan = card.number.replace(/\D/g, '');
    const row = db.prepare('SELECT * FROM virtual_cards WHERE pan_hash = ?').get(sha256(pan)) as any;
    if (!row) throw badRequest('Card declined: unknown card', 'card_declined');
    if (row.status !== 'active') throw badRequest('Card declined: card is frozen or closed', 'card_declined');
    if (row.exp_month !== Number(card.expMonth) || row.exp_year !== (Number(card.expYear) < 100 ? 2000 + Number(card.expYear) : Number(card.expYear)))
      throw badRequest('Card declined: invalid expiry', 'card_declined');
    if (!safeEqual(cardCvv(row), String(card.cvc ?? '').trim())) throw badRequest('Card declined: invalid security code', 'card_declined');
    if (row.currency !== currency) throw badRequest(`Card declined: this card is denominated in ${row.currency}`, 'card_declined');
    if (row.balance < amount) throw unprocessable('Card declined: insufficient balance', 'insufficient_funds');
    const owner = findUserById(row.user_id)!;
    const fee = calculateFee('merchant_payment', amount, currency, null, { userId: merchant.id });
    const treasury = ensureWallet(getSystemUser('treasury').id, currency);
    const merchantWallet = ensureWallet(merchant.id, currency);
    const tx = postTransaction({
      type: 'merchant_payment',
      amount,
      fee,
      currency,
      fromWalletId: treasury.id,
      toWalletId: merchantWallet.id,
      senderUserId: owner.id,
      receiverUserId: merchant.id,
      note,
      metadata: { ...metadata, method: 'virtual_card', cardId: row.id, cardLast4: row.last4 },
      feeFrom: 'receiver',
      // The card balance was funded out of the holder's wallet earlier (virtual_card_funding); charging releases that held value, it creates nothing.
      issuance: {
        authority: 'internal_release',
        originTransactionId:
          (db.prepare("SELECT id FROM transactions WHERE type = 'virtual_card_funding' AND metadata LIKE ? ORDER BY created_at DESC LIMIT 1").get(`%${row.id}%`) as any)?.id ?? row.id,
        reference: `virtual_card:${row.id}`,
      },
    });
    db.prepare('UPDATE virtual_cards SET balance = balance - ? WHERE id = ?').run(amount, row.id);
    notify(owner.id, 'Card payment', `${formatMoney(amount, getCurrency(currency, false))} was charged to your virtual card •••• ${row.last4} at ${merchant.business_name || merchant.full_name}.`, {
      kind: 'virtual_card_charge',
      transactionId: tx.id,
      template: 'virtual_card.charged',
      vars: { amount: formatMoney(amount, getCurrency(currency, false)), last4: row.last4, merchantName: merchant.business_name || merchant.full_name },
    });
    return { tx, owner };
  })();
}

export function virtualCardTransactions(userId: string, id: string) {
  getCardRow(userId, id);
  return getDb().prepare('SELECT * FROM transactions WHERE metadata LIKE ? ORDER BY created_at DESC LIMIT 100').all(`%"cardId":"${id}"%`) as any[];
}
