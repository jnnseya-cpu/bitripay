import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { assertPin } from '../services/auth';
import { getCurrency } from '../services/currencies';
import { toMinor } from '@bitripay/shared';
import {
  createRoute,
  getRoute,
  listRoutes,
  previewDestination,
  quoteRoute,
  refreshRoute,
  retryRoute,
  cancelRoute,
  routeReceipt,
  payoutCurrencyOptions,
  confirmPayoutCurrency,
  defaultTargetCurrency,
} from '../services/routing';
import { listCorridors } from '../services/corridors';
import { getComplianceSettings } from '../services/settings';
import { ROUTE_STAGE_LABELS } from '../services/routeLifecycle';
import { listOperators } from '../services/momo';
import { routeCatalog, describeRoute, CONFIRMATION_METHODS } from '../services/railCatalog';

const cardSchema = z.object({
  number: z.string().min(12).max(23),
  expMonth: z.coerce.number().int().min(1).max(12),
  expYear: z.coerce.number().int().min(0).max(2100),
  cvc: z.string().min(3).max(4),
  holderName: z.string().min(2).max(120),
});
const destinationSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('wallet'), to: z.string().min(2), note: z.string().max(200).optional().nullable() }),
  z.object({ method: z.literal('qr'), data: z.string().min(3).max(2000), note: z.string().max(200).optional().nullable() }),
  z.object({
    method: z.literal('bank'),
    bankAccountId: z.string().optional().nullable(),
    bankName: z.string().max(120).optional().nullable(),
    accountName: z.string().max(120).optional().nullable(),
    accountNumber: z.string().max(40).optional().nullable(),
    country: z.string().length(2).optional().nullable(),
    currency: z.string().length(3).optional().nullable(),
  }),
  z.object({ method: z.literal('mobile_money'), operatorId: z.string(), phone: z.string().min(6).max(20), name: z.string().max(120).optional().nullable() }),
  z.object({ method: z.literal('agent'), agent: z.string().min(2) }),
  z.object({ method: z.literal('keep') }),
]);
const sourceSchema = z.object({
  method: z.enum(['wallet', 'card', 'bank', 'mobile_money']),
  gateway: z.string().optional().nullable(),
  operatorId: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  card: cardSchema.optional(),
  savedCardId: z.string().optional().nullable(),
  saveCard: z.boolean().optional(),
  returnUrl: z.string().url().optional().nullable(),
});

/** Any → any money movement: fund from card / bank / mobile money / wallet, deliver to wallet / QR / bank / mobile money / agent. */
export const routingRouter = Router();
routingRouter.use(requireAuth);

/** Every declared logical route (initiation, confirmation, settlement, timing, fees, refund, processing mode). */
routingRouter.get('/catalog', (req, res) => {
  const cur = getCurrency(String(req.query.currency || 'USD'));
  res.json({ currency: cur.code, items: routeCatalog({ currency: cur.code, country: req.user!.country }) });
});
/** Supported corridors and their authorisation status – nothing is hidden about what is sandbox-only. */
routingRouter.get('/corridors', (_req, res) =>
  res.json({
    compliance: { mode: getComplianceSettings().mode },
    items: listCorridors()
      .filter((c) => c.enabled)
      .map((c) => ({
        id: c.id,
        sourceCurrency: c.sourceCurrency,
        destCountry: c.destCountry,
        destCurrency: c.destCurrency,
        operatorId: c.operatorId,
        rail: c.rail,
        status: c.status,
        estimatedPayoutMinutes: c.estimatedPayoutMinutes,
        payoutCurrencies: c.payoutCurrencies,
        beneficiaryConsent: c.beneficiaryConsent,
        payoutConfirmation: c.payoutConfirmation,
      })),
    stages: ROUTE_STAGE_LABELS,
    confirmationMethods: CONFIRMATION_METHODS,
  }),
);
routingRouter.get('/operators', (req, res) =>
  res.json({ items: listOperators({ country: req.query.country ? String(req.query.country) : null, currency: req.query.currency ? String(req.query.currency) : null }) }),
);

/** Real-time receiving-currency availability for a destination (corridor rules, licence coverage, liquidity, recipient account). */
routingRouter.post(
  '/payout-currencies',
  wrap(async (req, res) => {
    const body = validate(z.object({ destination: destinationSchema, amount: z.string(), currency: z.string().length(3), requested: z.string().length(3).optional().nullable() }), req.body);
    const cur = getCurrency(body.currency);
    res.json({ options: payoutCurrencyOptions(body.destination, cur.code, toMinor(body.amount, cur.decimals), { requested: body.requested }), confirmationMethods: CONFIRMATION_METHODS });
  }),
);
/** The signed-in beneficiary confirms the payout currency of a transfer addressed to them. */
routingRouter.post(
  '/:id/consent',
  wrap(async (req, res) => {
    const body = validate(z.object({ accept: z.boolean(), currency: z.string().length(3).optional().nullable(), token: z.string() }), req.body);
    res.json({ route: confirmPayoutCurrency(body.token, { accept: body.accept, currency: body.currency }, { type: 'user', id: req.user!.id }) });
  }),
);
routingRouter.post(
  '/preview',
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        destination: destinationSchema,
        sourceMethod: z.enum(['wallet', 'card', 'bank', 'mobile_money']).default('wallet'),
        sourceOperatorId: z.string().optional().nullable(),
        gateway: z.string().optional().nullable(),
        amount: z.string(),
        currency: z.string().length(3),
        targetCurrency: z.string().length(3).optional().nullable(),
      }),
      req.body,
    );
    const cur = getCurrency(body.currency);
    const amount = toMinor(body.amount, cur.decimals);
    const quote = quoteRoute(amount, cur.code, (body.targetCurrency || defaultTargetCurrency(body.destination, cur.code)).toUpperCase(), body.sourceMethod, body.destination, {
      userId: req.user!.id,
      country: req.user!.country,
      operatorId: body.sourceOperatorId,
      gateway: body.gateway,
    });
    res.json({ destination: previewDestination(body.destination), quote, declaration: quote.declaration, fx: quote.fx });
  }),
);

routingRouter.post(
  '/',
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        source: sourceSchema,
        destination: destinationSchema,
        amount: z.string(),
        currency: z.string().length(3),
        targetCurrency: z.string().length(3).optional().nullable(),
        note: z.string().max(200).optional().nullable(),
        quoteId: z.string().optional().nullable(),
        sourceOfFunds: z.string().max(200).optional().nullable(),
        pin: z.string().optional(),
      }),
      req.body,
    );
    // Every route is a payment: wallet-funded routes need biometrics/PIN now; externally funded ones carry the same proof into the intent.
    if (body.source.method === 'wallet') assertPin(req.user!, body.pin, req);
    const cur = getCurrency(body.currency);
    const route = await createRoute(
      req.user!,
      {
        source: body.source,
        destination: body.destination,
        amount: toMinor(body.amount, cur.decimals),
        currency: cur.code,
        targetCurrency: body.targetCurrency?.toUpperCase() ?? null,
        note: body.note,
        quoteId: body.quoteId,
        sourceOfFunds: body.sourceOfFunds,
      },
      { pin: body.pin, req },
    );
    res.status(201).json({ route });
  }),
);

routingRouter.get('/', (req, res) => res.json({ items: listRoutes(req.user!.id) }));
routingRouter.get('/:id/receipt', (req, res) => res.json(routeReceipt(req.user!.id, String(req.params.id))));
/** Cancel before the local payout is executed (funds return; card funding is refunded through the processor where possible). */
routingRouter.post(
  '/:id/cancel',
  wrap(async (req, res) => {
    const body = validate(z.object({ reason: z.string().max(200).optional().nullable(), pin: z.string().optional() }), req.body ?? {});
    assertPin(req.user!, body.pin, req);
    res.json({ route: await cancelRoute(req.user!, String(req.params.id), body.reason ?? undefined) });
  }),
);
routingRouter.get(
  '/:id',
  wrap(async (req, res) => res.json({ route: await refreshRoute(req.user!.id, String(req.params.id)) })),
);
routingRouter.post(
  '/:id/retry',
  wrap(async (req, res) => {
    const body = validate(z.object({ destination: destinationSchema.optional(), pin: z.string().optional() }), req.body);
    assertPin(req.user!, body.pin, req);
    res.json({ route: retryRoute(req.user!, String(req.params.id), body.destination) });
  }),
);
export { getRoute, describeRoute };
