import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap, parsePagination } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { initiatePayment, verifyPayment, paymentOptions, listPayments, attachBankProof, getPayment, toPaymentView } from '../services/payments';
import { getCurrency } from '../services/currencies';
import { toMinor } from '@bitripay/shared';
import { listSavedCards, setDefaultCard, deleteSavedCard } from '../services/cards';
import { notFound } from '../lib/errors';

export const depositsRouter = Router();
depositsRouter.use(requireAuth);

depositsRouter.get('/options', (req, res) => {
  const cur = getCurrency(String(req.query.currency || 'USD'));
  res.json({ currency: cur.code, methods: paymentOptions(cur.code, req.user!.country) });
});

const cardSchema = z.object({ number: z.string().min(12).max(23), expMonth: z.coerce.number().int().min(1).max(12), expYear: z.coerce.number().int().min(0).max(2100), cvc: z.string().min(3).max(4), holderName: z.string().min(2).max(120) });

depositsRouter.post(
  '/',
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        method: z.enum(['card', 'mobile_money', 'bank']),
        gateway: z.string().optional().nullable(),
        amount: z.string(),
        currency: z.string().length(3),
        card: cardSchema.optional(),
        savedCardId: z.string().optional().nullable(),
        saveCard: z.boolean().optional(),
        phone: z.string().optional().nullable(),
        returnUrl: z.string().url().optional().nullable(),
      }),
      req.body,
    );
    const cur = getCurrency(body.currency);
    const payment = await initiatePayment(req.user!, { purpose: 'deposit', ...body, amount: toMinor(body.amount, cur.decimals), currency: cur.code });
    res.status(201).json({ payment });
  }),
);

depositsRouter.get('/', (req, res) => {
  const { page, pageSize } = parsePagination(req.query);
  res.json({ ...listPayments({ userId: req.user!.id, purpose: 'deposit', status: req.query.status ? String(req.query.status) : undefined, page, pageSize }), page, pageSize });
});

depositsRouter.get(
  '/:id',
  wrap(async (req, res) => {
    const payment = getPayment(String(req.params.id));
    if (payment.user_id !== req.user!.id) throw notFound('Payment not found');
    res.json({ payment: await verifyPayment(payment.id) });
  }),
);

depositsRouter.post(
  '/:id/proof',
  wrap(async (req, res) => {
    const body = validate(z.object({ reference: z.string().max(100).optional(), note: z.string().max(500).optional(), image: z.string().max(2_000_000).optional() }), req.body);
    res.json({ payment: attachBankProof(req.user!, String(String(req.params.id)), body) });
  }),
);

export const cardsRouter = Router();
cardsRouter.use(requireAuth);
cardsRouter.get('/', (req, res) => res.json({ items: listSavedCards(req.user!.id) }));
cardsRouter.post('/:id/default', (req, res) => {
  setDefaultCard(req.user!.id, String(String(req.params.id)));
  res.json({ ok: true });
});
cardsRouter.delete('/:id', (req, res) => {
  deleteSavedCard(req.user!.id, String(String(req.params.id)));
  res.json({ ok: true });
});

export { toPaymentView };
