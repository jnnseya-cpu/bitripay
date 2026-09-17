/**
 * Pay from your own institution (aggregator perimeter): the customer, signed in or a guest on the hosted checkout,
 * pays the acceptor's QR / link from the account they hold at a participating bank or mobile-money operator, through
 * the national switch. BitriPay holds nothing; the payer's institution authorises its customer.
 */
import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap, getClientIp } from '../lib/http';
import { optionalAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { badRequest } from '../lib/errors';
import { getIntentRow } from '../services/intents';
import { getPaymentRequestByCode } from '../services/paymentRequests';
import { getQr } from '../services/qrcodes';
import { getCurrency } from '../services/currencies';
import { toMinor } from '@bitripay/shared';
import { customerPaymentState, institutionsFor, payFromInstitution } from '../services/switch/customerPayment';

export const payRouter = Router();
const payLimit = rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'pay_inst' });

/** The institutions the customer can pay this acceptor from: by intent, by payment code (hosted checkout, point of sale) or by static QR. */
payRouter.get(
  '/institutions',
  optionalAuth,
  rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'pay_inst_list' }),
  wrap(async (req, res) => {
    const q = validate(z.object({ intent: z.string().optional(), code: z.string().optional(), qr: z.string().optional(), currency: z.string().length(3).optional() }), req.query);
    let merchantUserId: string;
    let currency: string;
    if (q.intent) {
      const i = getIntentRow(q.intent);
      merchantUserId = i.merchant_user_id;
      currency = i.currency;
    } else if (q.code) {
      const r = getPaymentRequestByCode(q.code);
      merchantUserId = r.requester_user_id;
      currency = r.currency;
    } else if (q.qr) {
      const qr = getQr(q.qr);
      merchantUserId = qr.merchantId;
      currency = (q.currency ?? qr.currency).toUpperCase();
    } else throw badRequest('Give an intent, a payment code or a QR', 'target_required');
    res.json(institutionsFor(merchantUserId, currency));
  }),
);

/** Create and dispatch the payment; the institution's answer (or its pending state) comes back in `payment`. */
payRouter.post(
  '/institution',
  optionalAuth,
  payLimit,
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        intent_id: z.string().max(80).optional().nullable(),
        code: z.string().max(40).optional().nullable(),
        qr_id: z.string().max(80).optional().nullable(),
        amount: z.string().max(30).optional().nullable(),
        participant_id: z.string().min(1).max(40),
        account_token: z.string().min(4).max(64),
      }),
      req.body,
    );
    let amountMinor: number | null = null;
    if (body.qr_id && body.amount) amountMinor = toMinor(body.amount, getCurrency(getQr(body.qr_id).currency).decimals);
    const r = await payFromInstitution(
      req.user ?? null,
      { intentId: body.intent_id ?? null, paymentRequestCode: body.code ?? null, qrId: body.qr_id ?? null, amountMinor, participantId: body.participant_id, accountToken: body.account_token },
      { ip: getClientIp(req), channel: req.user ? 'customer_app' : 'hosted_checkout' },
    );
    res.status(201).json(r);
  }),
);

/** Poll the state of a payment the customer started (pending answers on a certified connection). */
payRouter.get('/institution/:id', optionalAuth, rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'pay_inst_state' }), (req, res) => {
  const q = validate(z.object({ intent: z.string().min(1) }), req.query);
  res.json(customerPaymentState(String(req.params.id), q.intent));
});
