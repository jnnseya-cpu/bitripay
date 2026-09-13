import { getDb } from '../db';
import { uuid, now, txReference } from '../lib/ids';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { parseJson } from '../lib/json';
import { applyBps, formatMoney } from '@bitripay/shared';
import { getCurrency } from './currencies';
import { postTransaction, completeTransaction, reverseTransaction } from './ledger';
import { ensureWallet, getUserWallet } from './wallets';
import { findUserById, getSystemUser, toPublicUser, type UserRow } from './users';
import { notify } from './notifications';
import { getAppSettings } from './settings';
import { getModules } from './modules';

/*
 * P2P marketplace model
 *  - An ad is "sell" (owner sells `currency` for `price_currency`) or "buy" (owner buys `currency` paying `price_currency`).
 *  - A trade opens from an ad with an initial offer (amount + rate). Either party can counter until one accepts.
 *  - Once accepted, the SELLER's `currency` is locked in escrow (a pending transaction to the buyer).
 *      payment_method = wallet   → the buyer pays price_amount from their wallet immediately and the escrow releases at once.
 *      payment_method = external → the buyer pays outside the platform, marks "paid"; the seller releases escrow (or opens a dispute).
 *  - Admin resolves disputes by releasing to the buyer or refunding the seller.
 */

function assertP2p() {
  if (!getModules().p2p) throw unprocessable('P2P trading is currently disabled', 'module_disabled');
}

export function toAd(r: any) {
  return {
    id: r.id,
    userId: r.user_id,
    side: r.side as 'buy' | 'sell',
    currency: r.currency,
    priceCurrency: r.price_currency,
    rate: r.rate,
    minAmount: r.min_amount,
    maxAmount: r.max_amount,
    availableAmount: r.available_amount,
    paymentMethods: parseJson<string[]>(r.payment_methods, ['wallet']),
    terms: r.terms,
    status: r.status,
    createdAt: r.created_at,
    user: findUserById(r.user_id) ? { ...toPublicUser(findUserById(r.user_id)!), stats: traderStats(r.user_id) } : null,
  };
}

export function toTrade(r: any, withDetails = false) {
  const base: any = {
    id: r.id,
    reference: r.reference,
    adId: r.ad_id,
    buyerId: r.buyer_id,
    sellerId: r.seller_id,
    initiatorId: r.initiator_id,
    amount: r.amount,
    currency: r.currency,
    priceAmount: r.price_amount,
    priceCurrency: r.price_currency,
    rate: r.rate,
    paymentMethod: r.payment_method,
    status: r.status,
    disputeReason: r.dispute_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
    buyer: findUserById(r.buyer_id) ? toPublicUser(findUserById(r.buyer_id)!) : null,
    seller: findUserById(r.seller_id) ? toPublicUser(findUserById(r.seller_id)!) : null,
  };
  if (withDetails) {
    const db = getDb();
    base.offers = (db.prepare('SELECT * FROM p2p_offers WHERE trade_id = ? ORDER BY created_at ASC').all(r.id) as any[]).map((o) => ({
      id: o.id,
      fromUserId: o.from_user_id,
      amount: o.amount,
      rate: o.rate,
      priceAmount: o.price_amount,
      message: o.message,
      status: o.status,
      createdAt: o.created_at,
    }));
    base.messages = (db.prepare('SELECT * FROM p2p_messages WHERE trade_id = ? ORDER BY created_at ASC').all(r.id) as any[]).map((m) => ({
      id: m.id,
      senderId: m.sender_id,
      body: m.body,
      createdAt: m.created_at,
    }));
    const ad = db.prepare('SELECT * FROM p2p_ads WHERE id = ?').get(r.ad_id);
    base.ad = ad ? toAd(ad) : null;
  }
  return base;
}

function traderStats(userId: string) {
  const db = getDb();
  const total = (db.prepare("SELECT COUNT(*) c FROM p2p_trades WHERE (buyer_id = ? OR seller_id = ?) AND status IN ('completed','cancelled','refunded')").get(userId, userId) as any).c;
  const completed = (db.prepare("SELECT COUNT(*) c FROM p2p_trades WHERE (buyer_id = ? OR seller_id = ?) AND status = 'completed'").get(userId, userId) as any).c;
  return { trades: completed, completionRate: total ? Math.round((completed / total) * 100) : 100 };
}

function priceFor(amount: number, rate: number, currency: string, priceCurrency: string) {
  const c = getCurrency(currency, false);
  const p = getCurrency(priceCurrency, false);
  return Math.round((amount / 10 ** c.decimals) * rate * 10 ** p.decimals);
}

export function createAd(
  user: UserRow,
  input: {
    side: 'buy' | 'sell';
    currency: string;
    priceCurrency: string;
    rate: number;
    minAmount: number;
    maxAmount: number;
    availableAmount: number;
    paymentMethods: string[];
    terms?: string | null;
  },
) {
  assertP2p();
  const cur = getCurrency(input.currency);
  const price = getCurrency(input.priceCurrency);
  if (cur.code === price.code) throw badRequest('Choose two different currencies');
  if (input.rate <= 0) throw badRequest('Rate must be positive');
  if (input.minAmount <= 0 || input.maxAmount < input.minAmount) throw badRequest('Invalid amount range');
  if (input.availableAmount < input.maxAmount) throw badRequest('Available amount must be at least the maximum trade size');
  if (input.side === 'sell') {
    const wallet = getUserWallet(user.id, cur.code);
    if (wallet.balance < input.availableAmount) throw unprocessable(`You need at least ${formatMoney(input.availableAmount, cur)} in your ${cur.code} wallet to publish this ad`, 'insufficient_funds');
  }
  const id = uuid();
  getDb()
    .prepare(
      'INSERT INTO p2p_ads (id, user_id, side, currency, price_currency, rate, min_amount, max_amount, available_amount, payment_methods, terms, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      id,
      user.id,
      input.side,
      cur.code,
      price.code,
      input.rate,
      input.minAmount,
      input.maxAmount,
      input.availableAmount,
      JSON.stringify(input.paymentMethods.length ? input.paymentMethods : ['wallet']),
      input.terms ?? null,
      'active',
      now(),
      now(),
    );
  return toAd(getDb().prepare('SELECT * FROM p2p_ads WHERE id = ?').get(id));
}

export function listAds(filter: { side?: string; currency?: string; priceCurrency?: string; userId?: string; includeInactive?: boolean }) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!filter.includeInactive) where.push("status = 'active'");
  if (filter.side) {
    where.push('side = ?');
    params.push(filter.side);
  }
  if (filter.currency) {
    where.push('currency = ?');
    params.push(filter.currency.toUpperCase());
  }
  if (filter.priceCurrency) {
    where.push('price_currency = ?');
    params.push(filter.priceCurrency.toUpperCase());
  }
  if (filter.userId) {
    where.push('user_id = ?');
    params.push(filter.userId);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return getDb()
    .prepare(`SELECT * FROM p2p_ads ${whereSql} ORDER BY created_at DESC LIMIT 200`)
    .all(...params)
    .map(toAd);
}

export function setAdStatus(user: UserRow, id: string, status: 'active' | 'paused' | 'closed') {
  const row = getDb().prepare('SELECT * FROM p2p_ads WHERE id = ?').get(id) as any;
  if (!row) throw notFound('Ad not found');
  if (row.user_id !== user.id && user.role !== 'admin') throw forbidden();
  getDb().prepare('UPDATE p2p_ads SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
  return toAd(getDb().prepare('SELECT * FROM p2p_ads WHERE id = ?').get(id));
}

/** Open a trade on an ad with an initial offer (the ad's rate, or a proposed rate for negotiation). */
export function openTrade(user: UserRow, input: { adId: string; amount: number; rate?: number | null; paymentMethod?: string; message?: string | null }) {
  assertP2p();
  const db = getDb();
  const ad = db.prepare("SELECT * FROM p2p_ads WHERE id = ? AND status = 'active'").get(input.adId) as any;
  if (!ad) throw notFound('Ad not found or no longer active');
  if (ad.user_id === user.id) throw badRequest('You cannot trade on your own ad');
  if (input.amount < ad.min_amount || input.amount > ad.max_amount) throw badRequest(`Amount must be between ${ad.min_amount} and ${ad.max_amount} (minor units)`);
  if (input.amount > ad.available_amount) throw badRequest('Amount exceeds what is available on this ad');
  const methods = parseJson<string[]>(ad.payment_methods, ['wallet']);
  const method = input.paymentMethod || methods[0];
  if (!methods.includes(method)) throw badRequest('Payment method not accepted on this ad');
  const rate = input.rate ?? ad.rate;
  const buyerId = ad.side === 'sell' ? user.id : ad.user_id;
  const sellerId = ad.side === 'sell' ? ad.user_id : user.id;
  const priceAmount = priceFor(input.amount, rate, ad.currency, ad.price_currency);
  const id = uuid();
  const ts = now();
  db.prepare(
    `INSERT INTO p2p_trades (id, reference, ad_id, buyer_id, seller_id, initiator_id, amount, currency, price_amount, price_currency, rate, payment_method, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'negotiating', ?, ?)`,
  ).run(id, txReference('P2P'), ad.id, buyerId, sellerId, user.id, input.amount, ad.currency, priceAmount, ad.price_currency, rate, method === 'wallet' ? 'wallet' : 'external', ts, ts);
  db.prepare("INSERT INTO p2p_offers (id, trade_id, from_user_id, amount, rate, price_amount, message, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)").run(
    uuid(),
    id,
    user.id,
    input.amount,
    rate,
    priceAmount,
    input.message ?? null,
    ts,
  );
  const counterpart = ad.user_id;
  notify(
    counterpart,
    'New trade offer',
    `${user.full_name} wants to ${ad.side === 'sell' ? 'buy' : 'sell'} ${formatMoney(input.amount, getCurrency(ad.currency, false))} at ${rate} ${ad.price_currency}.`,
    { kind: 'p2p_offer', tradeId: id },
  );
  return toTrade(db.prepare('SELECT * FROM p2p_trades WHERE id = ?').get(id), true);
}

function getTradeRow(id: string) {
  const row = getDb().prepare('SELECT * FROM p2p_trades WHERE id = ? OR reference = ?').get(id, id) as any;
  if (!row) throw notFound('Trade not found');
  return row;
}

function assertParty(trade: any, user: UserRow) {
  if (trade.buyer_id !== user.id && trade.seller_id !== user.id && user.role !== 'admin') throw forbidden('You are not part of this trade');
}

export function counterOffer(user: UserRow, tradeId: string, input: { amount: number; rate: number; message?: string | null }) {
  const db = getDb();
  const trade = getTradeRow(tradeId);
  assertParty(trade, user);
  if (trade.status !== 'negotiating') throw conflict('This trade is no longer negotiable');
  db.prepare("UPDATE p2p_offers SET status = 'superseded' WHERE trade_id = ? AND status = 'pending'").run(trade.id);
  const priceAmount = priceFor(input.amount, input.rate, trade.currency, trade.price_currency);
  db.prepare("INSERT INTO p2p_offers (id, trade_id, from_user_id, amount, rate, price_amount, message, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)").run(
    uuid(),
    trade.id,
    user.id,
    input.amount,
    input.rate,
    priceAmount,
    input.message ?? null,
    now(),
  );
  db.prepare('UPDATE p2p_trades SET amount = ?, rate = ?, price_amount = ?, updated_at = ? WHERE id = ?').run(input.amount, input.rate, priceAmount, now(), trade.id);
  const other = trade.buyer_id === user.id ? trade.seller_id : trade.buyer_id;
  notify(other, 'Counter-offer received', `${user.full_name} proposed ${input.rate} ${trade.price_currency} for ${formatMoney(input.amount, getCurrency(trade.currency, false))}.`, {
    kind: 'p2p_offer',
    tradeId: trade.id,
  });
  return toTrade(getTradeRow(trade.id), true);
}

/** Accept the current pending offer: lock the seller's funds in escrow; settle immediately for wallet payments. */
export function acceptOffer(user: UserRow, tradeId: string) {
  const db = getDb();
  return db.transaction(() => {
    const trade = getTradeRow(tradeId);
    assertParty(trade, user);
    if (trade.status !== 'negotiating') throw conflict('This trade is no longer negotiable');
    const offer = db.prepare("SELECT * FROM p2p_offers WHERE trade_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(trade.id) as any;
    if (!offer) throw conflict('No pending offer');
    if (offer.from_user_id === user.id) throw badRequest('Wait for the other party to respond to your offer');
    db.prepare("UPDATE p2p_offers SET status = 'accepted' WHERE id = ?").run(offer.id);
    const seller = findUserById(trade.seller_id)!;
    const buyer = findUserById(trade.buyer_id)!;
    const sellerWallet = getUserWallet(seller.id, trade.currency);
    const buyerWallet = ensureWallet(buyer.id, trade.currency);
    const feeBps = getAppSettings().p2pFeeBps;
    const fee = applyBps(trade.amount, feeBps);
    // Escrow: seller → buyer pending (funds held in escrow account until release)
    const escrowTx = postTransaction({
      type: 'exchange',
      amount: trade.amount,
      fee,
      currency: trade.currency,
      fromWalletId: sellerWallet.id,
      toWalletId: buyerWallet.id,
      senderUserId: seller.id,
      receiverUserId: buyer.id,
      status: 'pending',
      note: `P2P trade ${trade.reference}`,
      metadata: { p2pTradeId: trade.id, role: 'escrow' },
    });
    db.prepare("UPDATE p2p_trades SET status = 'escrowed', escrow_transaction_id = ?, updated_at = ? WHERE id = ?").run(escrowTx.id, now(), trade.id);
    db.prepare('UPDATE p2p_ads SET available_amount = MAX(0, available_amount - ?), updated_at = ? WHERE id = ?').run(trade.amount, now(), trade.ad_id);
    if (trade.payment_method === 'wallet') {
      // Buyer pays from wallet now; both legs settle atomically.
      const buyerPriceWallet = getUserWallet(buyer.id, trade.price_currency);
      const sellerPriceWallet = ensureWallet(seller.id, trade.price_currency);
      const payTx = postTransaction({
        type: 'exchange',
        amount: trade.price_amount,
        currency: trade.price_currency,
        fromWalletId: buyerPriceWallet.id,
        toWalletId: sellerPriceWallet.id,
        senderUserId: buyer.id,
        receiverUserId: seller.id,
        note: `P2P trade ${trade.reference} payment`,
        metadata: { p2pTradeId: trade.id, role: 'payment' },
      });
      releaseEscrow(trade.id, payTx.id);
    } else {
      notify(
        buyer.id,
        'Trade accepted – pay now',
        `Pay ${formatMoney(trade.price_amount, getCurrency(trade.price_currency, false))} to the seller using the agreed method, then mark the trade as paid.`,
        { kind: 'p2p_trade', tradeId: trade.id },
      );
      notify(seller.id, 'Trade accepted – funds in escrow', `${formatMoney(trade.amount, getCurrency(trade.currency, false))} is held in escrow until you confirm payment.`, {
        kind: 'p2p_trade',
        tradeId: trade.id,
      });
    }
    return toTrade(getTradeRow(trade.id), true);
  })();
}

function releaseEscrow(tradeId: string, settlementTxId?: string | null) {
  const db = getDb();
  const trade = getTradeRow(tradeId);
  completeTransaction(trade.escrow_transaction_id);
  db.prepare("UPDATE p2p_trades SET status = 'completed', settlement_transaction_id = COALESCE(?, settlement_transaction_id), updated_at = ?, completed_at = ? WHERE id = ?").run(
    settlementTxId ?? null,
    now(),
    now(),
    trade.id,
  );
  notify(trade.buyer_id, 'Trade completed', `${formatMoney(trade.amount, getCurrency(trade.currency, false))} has been released to your wallet.`, { kind: 'p2p_trade', tradeId: trade.id });
  notify(trade.seller_id, 'Trade completed', `Trade ${trade.reference} is complete.`, { kind: 'p2p_trade', tradeId: trade.id });
}

export function markPaid(user: UserRow, tradeId: string) {
  const trade = getTradeRow(tradeId);
  if (trade.buyer_id !== user.id) throw forbidden('Only the buyer can mark a trade as paid');
  if (trade.status !== 'escrowed') throw conflict('Trade is not awaiting payment');
  getDb().prepare("UPDATE p2p_trades SET status = 'paid', updated_at = ? WHERE id = ?").run(now(), trade.id);
  notify(trade.seller_id, 'Buyer marked as paid', `Confirm you received ${formatMoney(trade.price_amount, getCurrency(trade.price_currency, false))} to release the escrow.`, {
    kind: 'p2p_trade',
    tradeId: trade.id,
  });
  return toTrade(getTradeRow(trade.id), true);
}

export function release(user: UserRow, tradeId: string) {
  const trade = getTradeRow(tradeId);
  if (trade.seller_id !== user.id && user.role !== 'admin') throw forbidden('Only the seller can release escrow');
  if (!['escrowed', 'paid', 'disputed'].includes(trade.status)) throw conflict('Nothing to release');
  releaseEscrow(trade.id);
  return toTrade(getTradeRow(trade.id), true);
}

export function cancelTrade(user: UserRow, tradeId: string, reason?: string) {
  const db = getDb();
  const trade = getTradeRow(tradeId);
  assertParty(trade, user);
  if (trade.status === 'negotiating') {
    db.prepare("UPDATE p2p_trades SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now(), trade.id);
  } else if (trade.status === 'escrowed' && (trade.buyer_id === user.id || user.role === 'admin')) {
    reverseTransaction(trade.escrow_transaction_id, 'cancelled', reason);
    db.prepare("UPDATE p2p_trades SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now(), trade.id);
    db.prepare('UPDATE p2p_ads SET available_amount = available_amount + ? WHERE id = ?').run(trade.amount, trade.ad_id);
  } else {
    throw conflict('This trade cannot be cancelled at this stage; open a dispute instead');
  }
  const other = trade.buyer_id === user.id ? trade.seller_id : trade.buyer_id;
  notify(other, 'Trade cancelled', `Trade ${trade.reference} was cancelled${reason ? `: ${reason}` : ''}.`, { kind: 'p2p_trade', tradeId: trade.id });
  return toTrade(getTradeRow(trade.id), true);
}

export function dispute(user: UserRow, tradeId: string, reason: string) {
  const trade = getTradeRow(tradeId);
  assertParty(trade, user);
  if (!['escrowed', 'paid'].includes(trade.status)) throw conflict('Only active trades can be disputed');
  getDb().prepare("UPDATE p2p_trades SET status = 'disputed', dispute_reason = ?, updated_at = ? WHERE id = ?").run(reason, now(), trade.id);
  const other = trade.buyer_id === user.id ? trade.seller_id : trade.buyer_id;
  notify(other, 'Trade disputed', `${user.full_name} opened a dispute on trade ${trade.reference}. Support will review it.`, { kind: 'p2p_trade', tradeId: trade.id });
  return toTrade(getTradeRow(trade.id), true);
}

/** Admin resolution: release to buyer or refund seller. */
export function resolveDispute(admin: UserRow, tradeId: string, outcome: 'release' | 'refund', note?: string) {
  const db = getDb();
  const trade = getTradeRow(tradeId);
  if (trade.status !== 'disputed') throw conflict('Trade is not disputed');
  if (outcome === 'release') releaseEscrow(trade.id);
  else {
    reverseTransaction(trade.escrow_transaction_id, 'cancelled', note);
    db.prepare("UPDATE p2p_trades SET status = 'refunded', updated_at = ? WHERE id = ?").run(now(), trade.id);
    db.prepare('UPDATE p2p_ads SET available_amount = available_amount + ? WHERE id = ?').run(trade.amount, trade.ad_id);
    notify(trade.seller_id, 'Dispute resolved', `Escrow for ${trade.reference} was refunded to you.`, { kind: 'p2p_trade', tradeId: trade.id });
    notify(trade.buyer_id, 'Dispute resolved', `Trade ${trade.reference} was refunded to the seller.`, { kind: 'p2p_trade', tradeId: trade.id });
  }
  db.prepare('UPDATE p2p_trades SET resolved_by = ? WHERE id = ?').run(admin.id, trade.id);
  return toTrade(getTradeRow(trade.id), true);
}

export function listTrades(user: UserRow, filter: { status?: string; all?: boolean }) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!(filter.all && user.role === 'admin')) {
    where.push('(buyer_id = ? OR seller_id = ?)');
    params.push(user.id, user.id);
  }
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return getDb()
    .prepare(`SELECT * FROM p2p_trades ${whereSql} ORDER BY updated_at DESC LIMIT 200`)
    .all(...params)
    .map((r) => toTrade(r));
}

export function getTrade(user: UserRow, id: string) {
  const trade = getTradeRow(id);
  assertParty(trade, user);
  return toTrade(trade, true);
}

export function sendTradeMessage(user: UserRow, tradeId: string, body: string) {
  const trade = getTradeRow(tradeId);
  assertParty(trade, user);
  const id = uuid();
  getDb().prepare('INSERT INTO p2p_messages (id, trade_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)').run(id, trade.id, user.id, body.trim().slice(0, 2000), now());
  const other = trade.buyer_id === user.id ? trade.seller_id : trade.buyer_id;
  if (user.id !== other) notify(other, 'New trade message', body.trim().slice(0, 100), { kind: 'p2p_message', tradeId: trade.id });
  return { id, senderId: user.id, body: body.trim(), createdAt: now() };
}

export function tradeMessages(user: UserRow, tradeId: string, since?: string | null) {
  const trade = getTradeRow(tradeId);
  assertParty(trade, user);
  const rows = since
    ? getDb().prepare('SELECT * FROM p2p_messages WHERE trade_id = ? AND created_at > ? ORDER BY created_at ASC').all(trade.id, since)
    : getDb().prepare('SELECT * FROM p2p_messages WHERE trade_id = ? ORDER BY created_at ASC LIMIT 500').all(trade.id);
  return (rows as any[]).map((m) => ({ id: m.id, senderId: m.sender_id, body: m.body, createdAt: m.created_at }));
}

export function marketplaceStats() {
  const db = getDb();
  const ads = (db.prepare("SELECT COUNT(*) c FROM p2p_ads WHERE status = 'active'").get() as any).c;
  const trades = db.prepare('SELECT status, COUNT(*) c FROM p2p_trades GROUP BY status').all() as any[];
  const volume = db.prepare("SELECT currency, COALESCE(SUM(amount),0) v FROM p2p_trades WHERE status = 'completed' GROUP BY currency").all();
  return { activeAds: ads, tradesByStatus: Object.fromEntries(trades.map((t) => [t.status, t.c])), volume, escrowAccount: toPublicUser(getSystemUser('escrow')) };
}
