import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { optionalAuth, requireAuth } from '../middleware/auth';
import { checkoutInfo, getPaymentRequestByCode, payWithWallet, toPaymentRequest, markPaidByGateway } from '../services/paymentRequests';
import { initiatePayment, verifyPayment, paymentOptions } from '../services/payments';
import { chargeVirtualCard } from '../services/virtualCards';
import { assertPin } from '../services/auth';
import { toTransaction } from '../services/ledger';
import { findUserById } from '../services/users';
import { badRequest, conflict } from '../lib/errors';
import { rateLimit } from '../middleware/rateLimit';
import { dispatchWebhook } from '../services/webhooks';
import { parseJson } from '../lib/json';

/** Hosted checkout – used by the web checkout page, mobile apps and the WooCommerce plugin. Guest-friendly. */
export const checkoutRouter = Router();

checkoutRouter.get('/:code', (req, res) => {
  const info = checkoutInfo(String(req.params.code));
  res.json({ ...info, options: paymentOptions(info.paymentRequest.currency, undefined, 'checkout') });
});

checkoutRouter.post(
  '/:code/wallet',
  requireAuth,
  wrap(async (req, res) => {
    const body = validate(z.object({ pin: z.string().optional(), amount: z.string().optional().nullable() }), req.body);
    assertPin(req.user!, body.pin, req);
    const row = getPaymentRequestByCode(String(req.params.code));
    const { getCurrency } = await import('../services/currencies');
    const { toMinor } = await import('@bitripay/shared');
    const result = payWithWallet(req.user!, row.code, body.amount ? toMinor(body.amount, getCurrency(row.currency).decimals) : null);
    res.status(201).json({ transaction: toTransaction(result.tx, req.user!.id), paymentRequest: toPaymentRequest(result.request) });
  }),
);

const cardSchema = z.object({ number: z.string().min(12).max(23), expMonth: z.coerce.number().int().min(1).max(12), expYear: z.coerce.number().int().min(0).max(2100), cvc: z.string().min(3).max(4), holderName: z.string().min(2).max(120) });

checkoutRouter.post(
  '/:code/pay',
  optionalAuth,
  rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'checkout' }),
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        method: z.enum(['card', 'mobile_money', 'bank', 'virtual_card']),
        gateway: z.string().optional().nullable(),
        card: cardSchema.optional(),
        savedCardId: z.string().optional().nullable(),
        saveCard: z.boolean().optional(),
        phone: z.string().optional().nullable(),
        operatorId: z.string().optional().nullable(),
        email: z.string().email().optional().nullable(),
        name: z.string().optional().nullable(),
        returnUrl: z.string().url().optional().nullable(),
      }),
      req.body,
    );
    const row = getPaymentRequestByCode(String(req.params.code));
    const view = toPaymentRequest(row);
    if (view.status !== 'open') throw conflict(`This payment request is ${view.status}`, 'request_not_open');
    if (!row.amount) throw badRequest('This request has no fixed amount; pay it from a BitriPay wallet');
    if (body.method === 'virtual_card') {
      if (!body.card) throw badRequest('Card details are required');
      const merchant = findUserById(row.requester_user_id)!;
      const { tx, owner } = chargeVirtualCard(body.card, row.amount, row.currency, merchant, row.description ?? 'Virtual card payment', { paymentRequestId: row.id, paymentRequestCode: row.code, ...parseJson(row.metadata, {}) });
      const updated = markPaidByGateway(row.code, tx.id, owner.id);
      void dispatchWebhook(merchant.id, 'payment.completed', { paymentRequest: toPaymentRequest(updated), transaction: { id: tx.id, reference: tx.reference, amount: tx.amount, fee: tx.fee, currency: tx.currency, method: 'virtual_card' } });
      return res.status(201).json({ status: 'succeeded', transaction: toTransaction(tx), paymentRequest: toPaymentRequest(updated) });
    }
    const payment = await initiatePayment(req.user ?? null, { purpose: 'checkout', paymentRequestCode: row.code, ...body });
    res.status(201).json({ payment, paymentRequest: toPaymentRequest(getPaymentRequestByCode(row.code)) });
  }),
);

checkoutRouter.get(
  '/:code/payments/:paymentId',
  wrap(async (req, res) => {
    const payment = await verifyPayment(String(req.params.paymentId));
    res.json({ payment, paymentRequest: toPaymentRequest(getPaymentRequestByCode(String(req.params.code))) });
  }),
);
