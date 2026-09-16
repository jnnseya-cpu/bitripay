/**
 * Value-added services: bill payments, mobile top-ups and gift cards.
 * Catalogs are admin-managed; fulfilment is recorded locally (plug a provider like Reloadly / Flutterwave Bills
 * into `fulfil*` hooks for live delivery).
 */
import { getDb } from '../db';
import { uuid, now, shortCode, numericCode } from '../lib/ids';
import { encrypt, decrypt } from '../lib/crypto';
import { badRequest, notFound, unprocessable } from '../lib/errors';
import { parseJson } from '../lib/json';
import { applyBps, formatMoney } from '@bitripay/shared';
import { getCurrency } from './currencies';
import { calculateFee, enforceLimits, postTransaction, transactionStatusHooks } from './ledger';
import { createPayoutInstruction } from './payouts';
import { ensureWallet, getUserWallet } from './wallets';
import { getSystemUser, type UserRow } from './users';
import { notify } from './notifications';
import { getModules } from './modules';

// ---------- Billers ----------
export function toBiller(r: any) {
  return {
    id: r.id,
    category: r.category,
    name: r.name,
    country: r.country,
    currency: r.currency,
    minAmount: r.min_amount,
    maxAmount: r.max_amount,
    feeBps: r.fee_bps,
    accountLabel: r.account_label,
    enabled: !!r.enabled,
    color: r.color,
  };
}
export function listBillers(onlyEnabled = true, country?: string | null) {
  const where = [onlyEnabled ? 'enabled = 1' : '1=1'];
  const params: unknown[] = [];
  if (country) {
    where.push('country = ?');
    params.push(country.toUpperCase());
  }
  return getDb()
    .prepare(`SELECT * FROM billers WHERE ${where.join(' AND ')} ORDER BY category, name`)
    .all(...params)
    .map(toBiller);
}
export function upsertBiller(input: {
  id?: string;
  category: string;
  name: string;
  country: string;
  currency: string;
  minAmount: number;
  maxAmount: number;
  feeBps: number;
  accountLabel: string;
  enabled: boolean;
  color?: string;
}) {
  const id = input.id || uuid();
  getDb()
    .prepare(
      `INSERT INTO billers (id, category, name, country, currency, min_amount, max_amount, fee_bps, account_label, enabled, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET category = excluded.category, name = excluded.name, country = excluded.country, currency = excluded.currency, min_amount = excluded.min_amount, max_amount = excluded.max_amount, fee_bps = excluded.fee_bps, account_label = excluded.account_label, enabled = excluded.enabled, color = excluded.color`,
    )
    .run(
      id,
      input.category,
      input.name,
      input.country.toUpperCase(),
      input.currency.toUpperCase(),
      input.minAmount,
      input.maxAmount,
      input.feeBps,
      input.accountLabel,
      input.enabled ? 1 : 0,
      input.color || '#0ea5e9',
      now(),
    );
  return toBiller(getDb().prepare('SELECT * FROM billers WHERE id = ?').get(id));
}
export function deleteBiller(id: string) {
  getDb().prepare('DELETE FROM billers WHERE id = ?').run(id);
}

export function payBill(user: UserRow, input: { billerId: string; accountNumber: string; amount: number }) {
  if (!getModules().billPay) throw unprocessable('Bill payments are currently disabled', 'module_disabled');
  const db = getDb();
  const biller = db.prepare('SELECT * FROM billers WHERE id = ? AND enabled = 1').get(input.billerId) as any;
  if (!biller) throw notFound('Biller not found');
  if (biller.min_amount && input.amount < biller.min_amount) throw badRequest(`Minimum amount is ${formatMoney(biller.min_amount, getCurrency(biller.currency))}`);
  if (biller.max_amount && input.amount > biller.max_amount) throw badRequest(`Maximum amount is ${formatMoney(biller.max_amount, getCurrency(biller.currency))}`);
  const cur = getCurrency(biller.currency);
  const fee = calculateFee('bill_payment', input.amount, cur.code, null, { userId: user.id }) + applyBps(input.amount, biller.fee_bps);
  enforceLimits(user, input.amount, cur.code);
  const wallet = getUserWallet(user.id, cur.code);
  const treasury = ensureWallet(getSystemUser('treasury').id, cur.code);
  const receiptNo = `BILL-${shortCode(8)}`;
  return db.transaction(() => {
    // held until the payout SIM pays the biller and the operator's confirmation SMS is matched (no biller API)
    const tx = postTransaction({
      type: 'bill_payment',
      amount: input.amount,
      fee,
      currency: cur.code,
      fromWalletId: wallet.id,
      toWalletId: treasury.id,
      senderUserId: user.id,
      receiverUserId: null,
      status: 'pending',
      note: `${biller.name} – ${input.accountNumber}`,
      metadata: { billerId: biller.id, billerName: biller.name, category: biller.category, accountNumber: input.accountNumber, receiptNo },
    });
    const id = uuid();
    const payout = createPayoutInstruction(
      {
        transactionId: tx.id,
        userId: user.id,
        rail: 'bill',
        operatorId: null,
        recipientMsisdn: null,
        recipientName: biller.name,
        bankDetails: { kind: 'bill', billerId: biller.id, billerName: biller.name, category: biller.category, accountNumber: input.accountNumber, receiptNo },
        country: biller.country ?? user.country ?? null,
        amount: input.amount,
        currency: cur.code,
        sourceCurrency: cur.code,
        sourceCountry: user.country,
      },
      { type: 'user', id: user.id },
    );
    db.prepare(
      "INSERT INTO bill_payments (id, user_id, biller_id, account_number, amount, currency, status, transaction_id, receipt_no, created_at, payout_id) VALUES (?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?)",
    ).run(id, user.id, biller.id, input.accountNumber, input.amount, cur.code, tx.id, receiptNo, now(), payout.id);
    db.prepare('UPDATE transactions SET metadata = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(tx.metadata), payoutId: payout.id, payoutReference: payout.reference }), tx.id);
    notify(
      user.id,
      'Bill payment accepted',
      payout.stage === 'QUEUED'
        ? `${formatMoney(input.amount, cur)} for ${biller.name} (${input.accountNumber}) is being paid from a BitriPay payout account. Receipt ${receiptNo}; you will be told when the biller confirms.`
        : `${formatMoney(input.amount, cur)} for ${biller.name} is waiting for local liquidity; your funds are held safely. Receipt ${receiptNo}.`,
      { kind: 'bill_payment', transactionId: tx.id, payoutId: payout.id },
    );
    return { id, receiptNo, status: 'processing' as const, payoutId: payout.id, transaction: tx, biller: toBiller(biller) };
  })();
}

/** Bills and top-ups follow their held transaction: settled by the operator's receipt (or maker-checker) → completed; reversed → failed. */
transactionStatusHooks.push((tx, outcome) => {
  if (tx.type !== 'bill_payment' && tx.type !== 'mobile_topup') return;
  const db = getDb();
  const done = outcome === 'completed';
  const cur = getCurrency(tx.currency, false);
  if (tx.type === 'bill_payment') {
    const r = db.prepare('SELECT b.*, x.name AS biller_name FROM bill_payments b LEFT JOIN billers x ON x.id = b.biller_id WHERE b.transaction_id = ?').get(tx.id) as any;
    if (!r) return;
    db.prepare('UPDATE bill_payments SET status = ? WHERE id = ?').run(done ? 'completed' : 'failed', r.id);
    notify(
      r.user_id,
      done ? 'Bill paid' : 'Bill payment failed',
      done
        ? `${formatMoney(r.amount, cur)} paid to ${r.biller_name ?? 'the biller'} for ${r.account_number}. Receipt ${r.receipt_no}.`
        : `${formatMoney(r.amount, cur)} for ${r.biller_name ?? 'the biller'} could not be paid. The funds are back in your wallet.`,
      { kind: 'bill_payment', transactionId: tx.id },
    );
  } else {
    const r = db.prepare('SELECT t.*, o.name AS operator_name FROM mobile_topups t LEFT JOIN topup_operators o ON o.id = t.operator_id WHERE t.transaction_id = ?').get(tx.id) as any;
    if (!r) return;
    db.prepare('UPDATE mobile_topups SET status = ? WHERE id = ?').run(done ? 'completed' : 'failed', r.id);
    notify(
      r.user_id,
      done ? 'Top-up successful' : 'Top-up failed',
      done
        ? `${formatMoney(r.amount, cur)} ${r.operator_name ?? ''} airtime sent to ${r.phone}.`
        : `${formatMoney(r.amount, cur)} of ${r.operator_name ?? ''} airtime for ${r.phone} could not be sent. The funds are back in your wallet.`,
      { kind: 'mobile_topup', transactionId: tx.id },
    );
  }
});

export function listBillPayments(userId: string) {
  return (
    getDb()
      .prepare('SELECT b.*, l.name biller_name, l.category FROM bill_payments b LEFT JOIN billers l ON l.id = b.biller_id WHERE b.user_id = ? ORDER BY b.created_at DESC LIMIT 100')
      .all(userId) as any[]
  ).map((r) => ({
    id: r.id,
    billerId: r.biller_id,
    billerName: r.biller_name,
    category: r.category,
    accountNumber: r.account_number,
    amount: r.amount,
    currency: r.currency,
    status: r.status,
    receiptNo: r.receipt_no,
    transactionId: r.transaction_id,
    createdAt: r.created_at,
  }));
}

// ---------- Mobile top-up ----------
export function toOperator(r: any) {
  return {
    id: r.id,
    name: r.name,
    country: r.country,
    currency: r.currency,
    minAmount: r.min_amount,
    maxAmount: r.max_amount,
    denominations: parseJson<number[]>(r.denominations, []),
    enabled: !!r.enabled,
    color: r.color,
  };
}
export function listOperators(onlyEnabled = true, country?: string | null) {
  const where = [onlyEnabled ? 'enabled = 1' : '1=1'];
  const params: unknown[] = [];
  if (country) {
    where.push('country = ?');
    params.push(country.toUpperCase());
  }
  return getDb()
    .prepare(`SELECT * FROM topup_operators WHERE ${where.join(' AND ')} ORDER BY country, name`)
    .all(...params)
    .map(toOperator);
}
export function upsertOperator(input: {
  id?: string;
  name: string;
  country: string;
  currency: string;
  minAmount: number;
  maxAmount: number;
  denominations: number[];
  enabled: boolean;
  color?: string;
}) {
  const id = input.id || uuid();
  getDb()
    .prepare(
      `INSERT INTO topup_operators (id, name, country, currency, min_amount, max_amount, denominations, enabled, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, country = excluded.country, currency = excluded.currency, min_amount = excluded.min_amount, max_amount = excluded.max_amount, denominations = excluded.denominations, enabled = excluded.enabled, color = excluded.color`,
    )
    .run(
      id,
      input.name,
      input.country.toUpperCase(),
      input.currency.toUpperCase(),
      input.minAmount,
      input.maxAmount,
      JSON.stringify(input.denominations),
      input.enabled ? 1 : 0,
      input.color || '#f59e0b',
      now(),
    );
  return toOperator(getDb().prepare('SELECT * FROM topup_operators WHERE id = ?').get(id));
}
export function deleteOperator(id: string) {
  getDb().prepare('DELETE FROM topup_operators WHERE id = ?').run(id);
}

export function mobileTopup(user: UserRow, input: { operatorId: string; phone: string; amount: number }) {
  if (!getModules().mobileTopup) throw unprocessable('Mobile top-up is currently disabled', 'module_disabled');
  const db = getDb();
  const op = db.prepare('SELECT * FROM topup_operators WHERE id = ? AND enabled = 1').get(input.operatorId) as any;
  if (!op) throw notFound('Operator not found');
  const cur = getCurrency(op.currency);
  if (op.min_amount && input.amount < op.min_amount) throw badRequest(`Minimum top-up is ${formatMoney(op.min_amount, cur)}`);
  if (op.max_amount && input.amount > op.max_amount) throw badRequest(`Maximum top-up is ${formatMoney(op.max_amount, cur)}`);
  if (!/^\+?\d{7,15}$/.test(input.phone.replace(/[\s-]/g, ''))) throw badRequest('Enter a valid phone number');
  const fee = calculateFee('mobile_topup', input.amount, cur.code, null, { userId: user.id });
  enforceLimits(user, input.amount, cur.code);
  const wallet = getUserWallet(user.id, cur.code);
  const treasury = ensureWallet(getSystemUser('treasury').id, cur.code);
  return db.transaction(() => {
    // held until the payout SIM transfers the airtime and the operator's confirmation SMS is matched (no operator API)
    const tx = postTransaction({
      type: 'mobile_topup',
      amount: input.amount,
      fee,
      currency: cur.code,
      fromWalletId: wallet.id,
      toWalletId: treasury.id,
      senderUserId: user.id,
      receiverUserId: null,
      status: 'pending',
      note: `${op.name} top-up for ${input.phone}`,
      metadata: { operatorId: op.id, operatorName: op.name, phone: input.phone },
    });
    const id = uuid();
    const payout = createPayoutInstruction(
      {
        transactionId: tx.id,
        userId: user.id,
        rail: 'airtime',
        operatorId: op.id,
        recipientMsisdn: input.phone,
        recipientName: null,
        bankDetails: { kind: 'airtime', operatorId: op.id, operatorName: op.name },
        country: op.country ?? user.country ?? null,
        amount: input.amount,
        currency: cur.code,
        sourceCurrency: cur.code,
        sourceCountry: user.country,
      },
      { type: 'user', id: user.id },
    );
    db.prepare("INSERT INTO mobile_topups (id, user_id, operator_id, phone, amount, currency, status, transaction_id, created_at, payout_id) VALUES (?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?)").run(
      id,
      user.id,
      op.id,
      input.phone,
      input.amount,
      cur.code,
      tx.id,
      now(),
      payout.id,
    );
    db.prepare('UPDATE transactions SET metadata = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(tx.metadata), payoutId: payout.id, payoutReference: payout.reference }), tx.id);
    notify(
      user.id,
      'Top-up accepted',
      payout.stage === 'QUEUED'
        ? `${formatMoney(input.amount, cur)} of ${op.name} airtime for ${input.phone} is being sent from a BitriPay payout SIM; you will be told when the operator confirms.`
        : `${formatMoney(input.amount, cur)} of ${op.name} airtime for ${input.phone} is waiting for local liquidity; your funds are held safely.`,
      { kind: 'mobile_topup', transactionId: tx.id, payoutId: payout.id },
    );
    return { id, status: 'processing' as const, payoutId: payout.id, transaction: tx, operator: toOperator(op) };
  })();
}

export function listTopups(userId: string) {
  return (
    getDb()
      .prepare('SELECT t.*, o.name operator_name FROM mobile_topups t LEFT JOIN topup_operators o ON o.id = t.operator_id WHERE t.user_id = ? ORDER BY t.created_at DESC LIMIT 100')
      .all(userId) as any[]
  ).map((r) => ({
    id: r.id,
    operatorId: r.operator_id,
    operatorName: r.operator_name,
    phone: r.phone,
    amount: r.amount,
    currency: r.currency,
    status: r.status,
    transactionId: r.transaction_id,
    createdAt: r.created_at,
  }));
}

// ---------- Gift cards ----------
export function toGiftProduct(r: any) {
  return {
    id: r.id,
    brand: r.brand,
    name: r.name,
    description: r.description,
    category: r.category,
    currency: r.currency,
    denominations: parseJson<number[]>(r.denominations, []),
    color: r.color,
    enabled: !!r.enabled,
  };
}
export function listGiftProducts(onlyEnabled = true) {
  return getDb()
    .prepare(`SELECT * FROM gift_card_products ${onlyEnabled ? 'WHERE enabled = 1' : ''} ORDER BY category, brand`)
    .all()
    .map(toGiftProduct);
}
export function upsertGiftProduct(input: {
  id?: string;
  brand: string;
  name: string;
  description?: string | null;
  category: string;
  currency: string;
  denominations: number[];
  color?: string;
  enabled: boolean;
}) {
  const id = input.id || uuid();
  getDb()
    .prepare(
      `INSERT INTO gift_card_products (id, brand, name, description, category, currency, denominations, color, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET brand = excluded.brand, name = excluded.name, description = excluded.description, category = excluded.category, currency = excluded.currency, denominations = excluded.denominations, color = excluded.color, enabled = excluded.enabled`,
    )
    .run(
      id,
      input.brand,
      input.name,
      input.description ?? null,
      input.category,
      input.currency.toUpperCase(),
      JSON.stringify(input.denominations),
      input.color || '#8b5cf6',
      input.enabled ? 1 : 0,
      now(),
    );
  return toGiftProduct(getDb().prepare('SELECT * FROM gift_card_products WHERE id = ?').get(id));
}
export function deleteGiftProduct(id: string) {
  getDb().prepare('DELETE FROM gift_card_products WHERE id = ?').run(id);
}

export function buyGiftCard(user: UserRow, input: { productId: string; amount: number; recipientEmail?: string | null }) {
  if (!getModules().giftCards) throw unprocessable('Gift cards are currently disabled', 'module_disabled');
  const db = getDb();
  const product = db.prepare('SELECT * FROM gift_card_products WHERE id = ? AND enabled = 1').get(input.productId) as any;
  if (!product) throw notFound('Gift card not found');
  const denominations = parseJson<number[]>(product.denominations, []);
  if (denominations.length && !denominations.includes(input.amount)) throw badRequest('Choose one of the available denominations');
  const cur = getCurrency(product.currency);
  const fee = calculateFee('gift_card', input.amount, cur.code, null, { userId: user.id });
  enforceLimits(user, input.amount, cur.code);
  const wallet = getUserWallet(user.id, cur.code);
  const treasury = ensureWallet(getSystemUser('treasury').id, cur.code);
  return db.transaction(() => {
    const tx = postTransaction({
      type: 'gift_card',
      amount: input.amount,
      fee,
      currency: cur.code,
      fromWalletId: wallet.id,
      toWalletId: treasury.id,
      senderUserId: user.id,
      receiverUserId: null,
      note: `${product.brand} gift card`,
      metadata: { productId: product.id, brand: product.brand, recipientEmail: input.recipientEmail ?? null },
    });
    const id = uuid();
    const code = `${shortCode(4)}-${shortCode(4)}-${shortCode(4)}-${shortCode(4)}`;
    const pin = numericCode(4);
    db.prepare(
      "INSERT INTO gift_cards (id, user_id, product_id, amount, currency, code_encrypted, pin_encrypted, status, transaction_id, recipient_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)",
    ).run(id, user.id, product.id, input.amount, cur.code, encrypt(code), encrypt(pin), tx.id, input.recipientEmail ?? null, now());
    notify(user.id, 'Gift card purchased', `Your ${product.brand} gift card worth ${formatMoney(input.amount, cur)} is ready in My Gift Cards.`, { kind: 'gift_card', giftCardId: id });
    return { id, code, pin, transaction: tx, product: toGiftProduct(product) };
  })();
}

export function listGiftCards(userId: string) {
  return (
    getDb()
      .prepare('SELECT g.*, p.brand, p.name product_name, p.color FROM gift_cards g LEFT JOIN gift_card_products p ON p.id = g.product_id WHERE g.user_id = ? ORDER BY g.created_at DESC')
      .all(userId) as any[]
  ).map((r) => ({
    id: r.id,
    productId: r.product_id,
    brand: r.brand,
    productName: r.product_name,
    color: r.color,
    amount: r.amount,
    currency: r.currency,
    code: decrypt(r.code_encrypted),
    pin: decrypt(r.pin_encrypted),
    status: r.status,
    recipientEmail: r.recipient_email,
    createdAt: r.created_at,
  }));
}
