import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { optionalAuth, requireAuth } from '../middleware/auth';
import { checkoutInfo, getPaymentRequestByCode, payWithWallet, toPaymentRequest, markPaidByGateway } from '../services/paymentRequests';
import { initiatePayment, verifyPayment, paymentOptions, authenticatePayment } from '../services/payments';
import { describeFunding } from '../services/railCatalog';
import { chargeVirtualCard } from '../services/virtualCards';
import { assertPin } from '../services/auth';
import { toTransaction } from '../services/ledger';
import { findUserById } from '../services/users';
import { AppError, badRequest, conflict } from '../lib/errors';
import { aggregatorPerimeterApplied, MODULE_OFF_MESSAGE } from '../services/modules';
import { rateLimit } from '../middleware/rateLimit';
import { dispatchWebhook } from '../services/webhooks';
import { parseJson } from '../lib/json';
import { calculateFee } from '../services/ledger';
import { fxDisclosure } from '../services/fx';
import { getGatewaySettings } from '../services/users';
import { getCurrency } from '../services/currencies';
import { POSITIONING } from '../content/positioning';
import { isMerchantRole } from '../services/users';

/** Hosted checkout – used by the web checkout page, mobile apps and the WooCommerce plugin. Guest-friendly. */
export const checkoutRouter = Router();

export interface CheckoutDisclosure {
  /** Platform fee on this payment in minor units of the request currency (null for open-amount requests). */
  feeMinor: number | null;
  /** Who bears the fee: merchant payments are charged to the receiver, so the payer pays the face amount. */
  feeFrom: 'receiver' | 'sender';
  /** Effective customer rate (1 payer unit = fxRate receiver units); 1 when the currencies match. */
  fxRate: number;
  fxMidRate: number;
  fxMarginBps: number;
  fxProvider: string;
  receiverCurrency: string;
  /** Exactly what the receiver is credited, in minor units of the receiver currency (null for open-amount requests). */
  receiverAmountMinor: number | null;
  /** The total the payer pays in minor units of the request currency (null for open-amount requests). */
  totalMinor: number | null;
  /** Expected completion per offered method, from the rail catalogue. */
  etaByMethod: Record<string, string>;
  /** Trust statement shown before the payer confirms. */
  trust: string;
}

/**
 * Everything a payer must see before confirming: fee, FX rate and margin when the receiver settles in another
 * currency, the receiver's currency and exact credited amount, the payer's total and an ETA per method. Reuses the
 * fee schedule, the FX disclosure and the rail catalogue – no pricing logic of its own.
 */
export function checkoutDisclosure(code: string, methods: string[]): CheckoutDisclosure {
  const row = getPaymentRequestByCode(code);
  const requester = findUserById(row.requester_user_id)!;
  const source = getCurrency(row.currency, false);
  const settings = getGatewaySettings(requester);
  const receiverCurrency = (isMerchantRole(requester.role) && settings.settlementCurrency) || source.code;
  const target = getCurrency(receiverCurrency, false);
  const fx = fxDisclosure(source.code, target.code, null, false);
  const feeType = isMerchantRole(requester.role) ? 'merchant_payment' : row.kind === 'request' ? 'transfer' : 'qr_payment';
  const feeFrom: 'receiver' | 'sender' = feeType === 'merchant_payment' ? 'receiver' : 'sender';
  const amount = row.amount ?? null;
  const feeMinor = amount ? calculateFee(feeType, amount, source.code, null, { userId: requester.id }) : null;
  const toReceiver = (minor: number) => Math.round((minor / 10 ** source.decimals) * fx.rate * 10 ** target.decimals);
  const receiverAmountMinor = amount ? toReceiver(feeFrom === 'receiver' ? amount - (feeMinor ?? 0) : amount) : null;
  const totalMinor = amount ? (feeFrom === 'sender' ? amount + (feeMinor ?? 0) : amount) : null;
  const etaByMethod: Record<string, string> = {};
  for (const m of methods) {
    if (m === 'wallet') etaByMethod[m] = 'Instant';
    else if (m === 'virtual_card') etaByMethod[m] = 'Seconds';
    else etaByMethod[m] = describeFunding(m as 'card' | 'mobile_money' | 'bank', { currency: source.code }).expectedCompletion;
  }
  return {
    feeMinor,
    feeFrom,
    fxRate: fx.rate,
    fxMidRate: fx.midRate,
    fxMarginBps: fx.markupBps,
    fxProvider: fx.providerLabel,
    receiverCurrency: target.code,
    receiverAmountMinor,
    totalMinor,
    etaByMethod,
    trust: POSITIONING.notProof,
  };
}

checkoutRouter.get('/:code', (req, res) => {
  const info = checkoutInfo(String(req.params.code));
  res.json({ ...info, options: paymentOptions(info.paymentRequest.currency, undefined, 'checkout'), disclosure: checkoutDisclosure(String(req.params.code), info.methods) });
});

checkoutRouter.post(
  '/:code/wallet',
  requireAuth,
  wrap(async (req, res) => {
    const body = validate(z.object({ pin: z.string().optional(), amount: z.string().optional().nullable() }), req.body);
    if (aggregatorPerimeterApplied()) throw new AppError(422, 'module_disabled', MODULE_OFF_MESSAGE, { method: 'wallet', available: ['national_switch'] });
    assertPin(req.user!, body.pin, req);
    const row = getPaymentRequestByCode(String(req.params.code));
    const { getCurrency } = await import('../services/currencies');
    const { toMinor } = await import('@bitripay/shared');
    const result = payWithWallet(req.user!, row.code, body.amount ? toMinor(body.amount, getCurrency(row.currency).decimals) : null);
    res.status(201).json({ transaction: toTransaction(result.tx, req.user!.id), paymentRequest: toPaymentRequest(result.request) });
  }),
);

const cardSchema = z.object({
  number: z.string().min(12).max(23),
  expMonth: z.coerce.number().int().min(1).max(12),
  expYear: z.coerce.number().int().min(0).max(2100),
  cvc: z.string().min(3).max(4),
  holderName: z.string().min(2).max(120),
});

checkoutRouter.post(
  '/:code/pay',
  optionalAuth,
  rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'checkout' }),
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        method: z.enum(['card', 'mobile_money', 'bank', 'virtual_card', 'bitcoin']),
        gateway: z.string().optional().nullable(),
        card: cardSchema.optional(),
        savedCardId: z.string().optional().nullable(),
        saveCard: z.boolean().optional(),
        phone: z.string().optional().nullable(),
        operatorId: z.string().optional().nullable(),
        email: z.string().email().optional().nullable(),
        name: z.string().optional().nullable(),
        returnUrl: z.string().url().optional().nullable(),
        pin: z.string().optional().nullable(),
      }),
      req.body,
    );
    const row = getPaymentRequestByCode(String(req.params.code));
    const view = toPaymentRequest(row);
    if (view.status !== 'open') throw conflict(`This payment request is ${view.status}`, 'request_not_open');
    // Aggregator perimeter: cards, mobile money or bank transfers to a platform account would put funds in BitriPay's hands; only the switch rail (`/api/pay/institution`) is open.
    if (aggregatorPerimeterApplied()) throw new AppError(422, 'module_disabled', MODULE_OFF_MESSAGE, { method: body.method, available: ['national_switch'] });
    if (!row.amount) throw badRequest('This request has no fixed amount; pay it from a BitriPay wallet');
    if (body.method === 'virtual_card') {
      if (!body.card) throw badRequest('Card details are required');
      const merchant = findUserById(row.requester_user_id)!;
      const { tx, owner } = chargeVirtualCard(body.card, row.amount, row.currency, merchant, row.description ?? 'Virtual card payment', {
        paymentRequestId: row.id,
        paymentRequestCode: row.code,
        ...parseJson(row.metadata, {}),
      });
      const updated = markPaidByGateway(row.code, tx.id, owner.id);
      void dispatchWebhook(merchant.id, 'payment.completed', {
        paymentRequest: toPaymentRequest(updated),
        transaction: { id: tx.id, reference: tx.reference, amount: tx.amount, fee: tx.fee, currency: tx.currency, method: 'virtual_card' },
      });
      return res.status(201).json({ status: 'succeeded', transaction: toTransaction(tx), paymentRequest: toPaymentRequest(updated) });
    }
    const { pin, ...rest } = body;
    const payment = await initiatePayment(req.user ?? null, { purpose: 'checkout', paymentRequestCode: row.code, ...rest }, { pin, req });
    res.status(201).json({
      payment,
      paymentRequest: toPaymentRequest(getPaymentRequestByCode(row.code)),
      declaration: describeFunding(rest.method as 'card' | 'mobile_money' | 'bank', { currency: row.currency, operatorId: body.operatorId, gateway: body.gateway }),
    });
  }),
);

/** Signed-in payers who started a checkout without biometrics/PIN complete it here. */
checkoutRouter.post(
  '/:code/payments/:paymentId/authenticate',
  requireAuth,
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
    const payment = await authenticatePayment(req.user!, String(req.params.paymentId), body, req);
    res.json({ payment, paymentRequest: toPaymentRequest(getPaymentRequestByCode(String(req.params.code))) });
  }),
);

checkoutRouter.get(
  '/:code/payments/:paymentId',
  wrap(async (req, res) => {
    const payment = await verifyPayment(String(req.params.paymentId));
    res.json({ payment, paymentRequest: toPaymentRequest(getPaymentRequestByCode(String(req.params.code))) });
  }),
);
