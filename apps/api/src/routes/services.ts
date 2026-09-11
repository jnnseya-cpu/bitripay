import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { listBillers, payBill, listBillPayments, listOperators, mobileTopup, listTopups, listGiftProducts, buyGiftCard, listGiftCards } from '../services/services';
import { assertPin } from '../services/auth';
import { getCurrency } from '../services/currencies';
import { toMinor } from '@bitripay/shared';
import { toTransaction } from '../services/ledger';
import { getDb } from '../db';

export const billsRouter = Router();
billsRouter.use(requireAuth);
billsRouter.get('/billers', (req, res) => res.json({ items: listBillers(true, req.query.country ? String(req.query.country) : null) }));
billsRouter.get('/', (req, res) => res.json({ items: listBillPayments(req.user!.id) }));
billsRouter.post(
  '/',
  wrap(async (req, res) => {
    const body = validate(z.object({ billerId: z.string(), accountNumber: z.string().min(2).max(60), amount: z.string(), pin: z.string().optional() }), req.body);
    assertPin(req.user!, body.pin);
    const biller = getDb().prepare('SELECT currency FROM billers WHERE id = ?').get(body.billerId) as any;
    const cur = getCurrency(biller?.currency ?? 'USD');
    const result = payBill(req.user!, { ...body, amount: toMinor(body.amount, cur.decimals) });
    res.status(201).json({ ...result, transaction: toTransaction(result.transaction, req.user!.id) });
  }),
);

export const topupRouter = Router();
topupRouter.use(requireAuth);
topupRouter.get('/operators', (req, res) => res.json({ items: listOperators(true, req.query.country ? String(req.query.country) : null) }));
topupRouter.get('/', (req, res) => res.json({ items: listTopups(req.user!.id) }));
topupRouter.post(
  '/',
  wrap(async (req, res) => {
    const body = validate(z.object({ operatorId: z.string(), phone: z.string().min(7).max(20), amount: z.string(), pin: z.string().optional() }), req.body);
    assertPin(req.user!, body.pin);
    const op = getDb().prepare('SELECT currency FROM topup_operators WHERE id = ?').get(body.operatorId) as any;
    const cur = getCurrency(op?.currency ?? 'USD');
    const result = mobileTopup(req.user!, { ...body, amount: toMinor(body.amount, cur.decimals) });
    res.status(201).json({ ...result, transaction: toTransaction(result.transaction, req.user!.id) });
  }),
);

export const giftCardsRouter = Router();
giftCardsRouter.use(requireAuth);
giftCardsRouter.get('/products', (_req, res) => res.json({ items: listGiftProducts() }));
giftCardsRouter.get('/', (req, res) => res.json({ items: listGiftCards(req.user!.id) }));
giftCardsRouter.post(
  '/',
  wrap(async (req, res) => {
    const body = validate(z.object({ productId: z.string(), amount: z.string(), recipientEmail: z.string().email().optional().nullable(), pin: z.string().optional() }), req.body);
    assertPin(req.user!, body.pin);
    const product = getDb().prepare('SELECT currency FROM gift_card_products WHERE id = ?').get(body.productId) as any;
    const cur = getCurrency(product?.currency ?? 'USD');
    const result = buyGiftCard(req.user!, { ...body, amount: toMinor(body.amount, cur.decimals) });
    res.status(201).json({ ...result, transaction: toTransaction(result.transaction, req.user!.id) });
  }),
);
