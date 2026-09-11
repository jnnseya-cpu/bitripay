import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap, parsePagination } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { listWallets, toWallet, ensureWallet } from '../services/wallets';
import { getTransaction, listTransactions, toTransaction , calculateFee } from '../services/ledger';
import { exchange } from '../services/transfers';
import { getCurrency, listCurrencies } from '../services/currencies';
import { fxDisclosure } from '../services/fx';
import { toMinor } from '@bitripay/shared';
import { assertPin } from '../services/auth';
import { notFound } from '../lib/errors';
import { usersById } from '../services/users';
import { getDb } from '../db';

export const walletsRouter = Router();
walletsRouter.use(requireAuth);

walletsRouter.get('/', (req, res) => res.json({ items: listWallets(req.user!.id).map(toWallet) }));

walletsRouter.post(
  '/',
  wrap(async (req, res) => {
    const body = validate(z.object({ currency: z.string().length(3) }), req.body);
    res.status(201).json({ wallet: toWallet(ensureWallet(req.user!.id, body.currency.toUpperCase())) });
  }),
);

/** FX disclosure before authorising a conversion: reference rate, provider + timestamp, markup, effective rate, expiry. */
walletsRouter.get('/exchange/quote', (req, res) => {
  const from = getCurrency(String(req.query.from || ''));
  const to = getCurrency(String(req.query.to || ''));
  const amount = toMinor(String(req.query.amount || '0'), from.decimals);
  const fx = fxDisclosure(from.code, to.code, req.user!.id);
  // The exchange fee is charged on top of the converted amount (see transfers.exchange).
  const fee = calculateFee('exchange', amount, from.code);
  const receive = Math.round((amount / 10 ** from.decimals) * fx.rate * 10 ** to.decimals);
  res.json({ from: from.code, to: to.code, amount, fee, receive, estimatedReceive: receive, rate: fx.rate, midRate: fx.midRate, marginBps: fx.markupBps, fx, targetCurrency: to.code });
});

walletsRouter.post(
  '/exchange',
  wrap(async (req, res) => {
    const body = validate(z.object({ from: z.string().length(3), to: z.string().length(3), amount: z.string(), pin: z.string().optional(), quoteId: z.string().optional().nullable() }), req.body);
    assertPin(req.user!, body.pin, req);
    const from = getCurrency(body.from);
    const result = exchange(req.user!, from.code, body.to.toUpperCase(), toMinor(body.amount, from.decimals), { quoteId: body.quoteId });
    res.status(201).json({ transaction: toTransaction(result.tx, req.user!.id), rate: result.rate, received: result.received, quoteId: result.quoteId, guaranteed: result.guaranteed });
  }),
);

walletsRouter.get('/rates', (_req, res) => res.json({ items: listCurrencies(true) }));

walletsRouter.get('/transactions', (req, res) => {
  const { page, pageSize } = parsePagination(req.query);
  const result = listTransactions({
    userId: req.user!.id,
    type: req.query.type ? String(req.query.type) : undefined,
    status: req.query.status ? String(req.query.status) : undefined,
    currency: req.query.currency ? String(req.query.currency).toUpperCase() : undefined,
    search: req.query.search ? String(req.query.search) : undefined,
    from: req.query.from ? String(req.query.from) : undefined,
    to: req.query.to ? String(req.query.to) : undefined,
    direction: req.query.direction === 'in' || req.query.direction === 'out' ? req.query.direction : undefined,
    page,
    pageSize,
  });
  res.json({ ...result, page, pageSize });
});

walletsRouter.get('/transactions/:id', (req, res) => {
  const tx = getTransaction(String(req.params.id));
  if (!tx || (tx.sender_user_id !== req.user!.id && tx.receiver_user_id !== req.user!.id && req.user!.role !== 'admin')) throw notFound('Transaction not found');
  const users = usersById([tx.sender_user_id!, tx.receiver_user_id!]);
  const ledger = getDb().prepare('SELECT * FROM ledger_entries WHERE transaction_id = ? ORDER BY created_at').all(tx.id) as any[];
  const mine = listWallets(req.user!.id).map((w) => w.id);
  res.json({
    transaction: toTransaction(tx, req.user!.id, users),
    sender: users.get(tx.sender_user_id!) ?? null,
    receiver: users.get(tx.receiver_user_id!) ?? null,
    entries: ledger.filter((e) => mine.includes(e.wallet_id) || req.user!.role === 'admin').map((e) => ({ direction: e.direction, amount: e.amount, balanceAfter: e.balance_after, walletId: e.wallet_id, createdAt: e.created_at })),
  });
});

/** Summary for dashboards: balances, 30-day in/out per currency. */
walletsRouter.get('/summary', (req, res) => {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const db = getDb();
  const inflow = db.prepare("SELECT currency, COALESCE(SUM(COALESCE(receive_amount, amount)),0) s, COUNT(*) c FROM transactions WHERE receiver_user_id = ? AND sender_user_id != receiver_user_id AND status = 'completed' AND created_at >= ? GROUP BY currency").all(req.user!.id, since);
  const outflow = db.prepare("SELECT currency, COALESCE(SUM(amount + fee),0) s, COUNT(*) c FROM transactions WHERE sender_user_id = ? AND sender_user_id != receiver_user_id AND status IN ('completed','pending') AND created_at >= ? GROUP BY currency").all(req.user!.id, since);
  const daily = db.prepare("SELECT substr(created_at,1,10) day, SUM(CASE WHEN receiver_user_id = ? THEN COALESCE(receive_amount, amount) ELSE 0 END) inflow, SUM(CASE WHEN sender_user_id = ? THEN amount + fee ELSE 0 END) outflow, currency FROM transactions WHERE (sender_user_id = ? OR receiver_user_id = ?) AND status = 'completed' AND created_at >= ? GROUP BY day, currency ORDER BY day").all(req.user!.id, req.user!.id, req.user!.id, req.user!.id, since);
  res.json({ wallets: listWallets(req.user!.id).map(toWallet), inflow, outflow, daily });
});
