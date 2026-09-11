import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap, parsePagination } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { createPaymentRequest, listPaymentRequests, getPaymentRequestByCode, toPaymentRequest, payWithWallet, cancelPaymentRequest, declinePaymentRequest } from '../services/paymentRequests';
import { getCurrency } from '../services/currencies';
import { toMinor } from '@bitripay/shared';
import { assertPin } from '../services/auth';
import { toTransaction } from '../services/ledger';
import { qrDataUrl } from '../services/qr';
import { usersById } from '../services/users';

export const paymentRequestsRouter = Router();
paymentRequestsRouter.use(requireAuth);

const createSchema = z.object({
  kind: z.enum(['qr', 'link', 'request']).default('link'),
  amount: z.string().optional().nullable(),
  currency: z.string().length(3),
  description: z.string().max(300).optional().nullable(),
  payer: z.string().optional().nullable(),
  expiresInMinutes: z.number().int().positive().max(60 * 24 * 90).optional().nullable(),
  successUrl: z.string().url().optional().nullable(),
  cancelUrl: z.string().url().optional().nullable(),
  metadata: z.record(z.unknown()).optional(),
  allowedMethods: z.array(z.enum(['wallet', 'card', 'mobile_money', 'bank', 'virtual_card'])).optional(),
});

paymentRequestsRouter.post(
  '/',
  wrap(async (req, res) => {
    const body = validate(createSchema, req.body);
    const cur = getCurrency(body.currency);
    const row = createPaymentRequest(req.user!, {
      ...body,
      amount: body.amount ? toMinor(body.amount, cur.decimals) : null,
      currency: cur.code,
    });
    const view = toPaymentRequest(row);
    res.status(201).json({ paymentRequest: view, qrImage: await qrDataUrl(view.link!) });
  }),
);

paymentRequestsRouter.get('/', (req, res) => {
  const { page, pageSize } = parsePagination(req.query);
  const role = req.query.role === 'payer' ? 'payer' : 'requester';
  res.json({ ...listPaymentRequests(req.user!.id, { role, status: req.query.status ? String(req.query.status) : undefined, kind: req.query.kind ? String(req.query.kind) : undefined, page, pageSize }), page, pageSize });
});

paymentRequestsRouter.get(
  '/:code',
  wrap(async (req, res) => {
    const row = getPaymentRequestByCode(String(req.params.code));
    const view = toPaymentRequest(row);
    res.json({ paymentRequest: view, qrImage: await qrDataUrl(view.link!) });
  }),
);

paymentRequestsRouter.post(
  '/:code/pay',
  wrap(async (req, res) => {
    const body = validate(z.object({ amount: z.string().optional().nullable(), note: z.string().max(200).optional().nullable(), pin: z.string().optional() }), req.body);
    assertPin(req.user!, body.pin);
    const row = getPaymentRequestByCode(String(req.params.code));
    const cur = getCurrency(row.currency);
    const result = payWithWallet(req.user!, row.code, body.amount ? toMinor(body.amount, cur.decimals) : null, body.note);
    res.status(201).json({ transaction: toTransaction(result.tx, req.user!.id, usersById([result.tx.receiver_user_id!])), paymentRequest: toPaymentRequest(result.request) });
  }),
);

paymentRequestsRouter.post('/:code/cancel', (req, res) => res.json({ paymentRequest: toPaymentRequest(cancelPaymentRequest(req.user!, String(String(req.params.code)))) }));
paymentRequestsRouter.post('/:code/decline', (req, res) => res.json({ paymentRequest: toPaymentRequest(declinePaymentRequest(req.user!, String(String(req.params.code)))) }));
