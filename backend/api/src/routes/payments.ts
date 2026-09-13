import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap, parsePagination } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { initiatePayment, verifyPayment, paymentOptions, listPayments, markPaymentSent, getPayment, toPaymentView, authenticatePayment } from '../services/payments';
import { listEvents } from '../services/events';
import { describeFunding } from '../services/railCatalog';
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

const cardSchema = z.object({
  number: z.string().min(12).max(23),
  expMonth: z.coerce.number().int().min(1).max(12),
  expYear: z.coerce.number().int().min(0).max(2100),
  cvc: z.string().min(3).max(4),
  holderName: z.string().min(2).max(120),
});

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
        operatorId: z.string().optional().nullable(),
        returnUrl: z.string().url().optional().nullable(),
        /** Transaction PIN – or send X-Step-Up-Token from a passkey/biometric check instead. */
        pin: z.string().optional().nullable(),
      }),
      req.body,
    );
    const cur = getCurrency(body.currency);
    const { pin, ...rest } = body;
    const payment = await initiatePayment(req.user!, { purpose: 'deposit', ...rest, amount: toMinor(body.amount, cur.decimals), currency: cur.code }, { pin, req });
    res.status(201).json({ payment, declaration: describeFunding(body.method, { currency: cur.code, country: req.user!.country, operatorId: body.operatorId, gateway: body.gateway }) });
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

/** Second step for intents waiting in AUTHENTICATION_REQUIRED: biometrics (X-Step-Up-Token) or PIN; card details again for card payments. */
depositsRouter.post(
  '/:id/authenticate',
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        pin: z.string().optional().nullable(),
        card: cardSchema.optional(),
        savedCardId: z.string().optional().nullable(),
        saveCard: z.boolean().optional(),
        returnUrl: z.string().url().optional().nullable(),
      }),
      req.body,
    );
    res.json({ payment: await authenticatePayment(req.user!, String(req.params.id), body, req) });
  }),
);

/** "I have sent the money": moves the intent to PAYMENT_SENT. Typed references/screenshots are supporting notes, never authoritative evidence. */
depositsRouter.post(
  '/:id/sent',
  wrap(async (req, res) => {
    const body = validate(z.object({ reference: z.string().max(100).optional(), note: z.string().max(500).optional(), image: z.string().max(2_000_000).optional() }), req.body);
    res.json({ payment: markPaymentSent(req.user!, String(req.params.id), body) });
  }),
);
depositsRouter.post(
  '/:id/proof',
  wrap(async (req, res) => {
    const body = validate(z.object({ reference: z.string().max(100).optional(), note: z.string().max(500).optional(), image: z.string().max(2_000_000).optional() }), req.body);
    res.json({ payment: markPaymentSent(req.user!, String(req.params.id), body) });
  }),
);

/** Time-stamped, attributable history of one payment intent (the customer's own). */
depositsRouter.get('/:id/events', (req, res) => {
  const payment = getPayment(String(req.params.id));
  if (payment.user_id !== req.user!.id) throw notFound('Payment not found');
  res.json({
    items: listEvents({ subjectId: payment.id, limit: 200 }).items.map((e) => ({
      id: e.id,
      event: e.event,
      actorType: e.actor.type,
      createdAt: e.createdAt,
      from: e.details.from ?? null,
      to: e.details.to ?? null,
    })),
  });
});

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
