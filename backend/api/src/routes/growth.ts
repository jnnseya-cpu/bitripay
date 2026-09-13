/**
 * Account-holder routes for the FX engine tools (alerts, auto-convert rules, forwards), credit readiness with
 * consented lender access, and merchant subscriptions from the customer's side.
 */
import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { assertPin } from '../services/auth';
import { riskContext } from '../services/risk';
import { getCurrency } from '../services/currencies';
import { toMinor } from '@bitripay/shared';
import {
  fxOverview,
  createAlert,
  cancelAlert,
  createAutoRule,
  setAutoRuleStatus,
  deleteAutoRule,
  quoteForward,
  lockForward,
  listForwards,
  getForward,
  settleForward,
  cancelForward,
} from '../services/fxTools';
import { getReadiness, grantConsent, listConsents, revokeConsent } from '../services/creditReadiness';
import { getPlan, subscribe, listSubscriptions, getSubscription, cancelSubscription, listInvoices } from '../services/billing';

export const fxToolsRouter = Router();
fxToolsRouter.use(requireAuth);
fxToolsRouter.get('/', (req, res) => res.json(fxOverview(req.user!)));
fxToolsRouter.post('/alerts', (req, res) => {
  const b = validate(
    z.object({
      baseCurrency: z.string().length(3),
      quoteCurrency: z.string().length(3),
      direction: z.enum(['above', 'below']),
      targetRate: z.number().positive(),
      note: z.string().max(120).optional().nullable(),
    }),
    req.body,
  );
  res.status(201).json({ alert: createAlert(req.user!, b) });
});
fxToolsRouter.delete('/alerts/:id', (req, res) => res.json({ alert: cancelAlert(req.user!.id, String(req.params.id)) }));
fxToolsRouter.post('/rules', (req, res) => {
  const b = validate(
    z.object({
      fromCurrency: z.string().length(3),
      toCurrency: z.string().length(3),
      kind: z.enum(['on_receipt', 'sweep']),
      shareBps: z.number().int().min(1).max(10_000).optional().nullable(),
      keep: z.string().optional().nullable(),
      minRate: z.number().positive().optional().nullable(),
      pin: z.string().optional(),
    }),
    req.body,
  );
  // creating a standing instruction to convert money is step-up protected
  assertPin(req.user!, b.pin, req);
  const keepMinor = b.keep ? toMinor(b.keep, getCurrency(b.fromCurrency).decimals) : 0;
  res
    .status(201)
    .json({ rule: createAutoRule(req.user!, { fromCurrency: b.fromCurrency, toCurrency: b.toCurrency, kind: b.kind, shareBps: b.shareBps ?? null, keepMinor, minRate: b.minRate ?? null }) });
});
fxToolsRouter.post('/rules/:id/:action', (req, res) => {
  const action = String(req.params.action);
  if (action === 'pause') return res.json({ rule: setAutoRuleStatus(req.user!.id, String(req.params.id), 'PAUSED') });
  if (action === 'resume') return res.json({ rule: setAutoRuleStatus(req.user!.id, String(req.params.id), 'ACTIVE') });
  deleteAutoRule(req.user!.id, String(req.params.id));
  res.json({ ok: true });
});
fxToolsRouter.get('/forwards/quote', (req, res) => {
  const from = getCurrency(String(req.query.from || 'USD'));
  res.json(quoteForward(from.code, String(req.query.to || ''), toMinor(String(req.query.amount || '0'), from.decimals), String(req.query.settleOn || '')));
});
fxToolsRouter.post(
  '/forwards',
  wrap(async (req, res) => {
    const b = validate(z.object({ fromCurrency: z.string().length(3), toCurrency: z.string().length(3), amount: z.string(), settleOn: z.string(), pin: z.string().optional() }), req.body);
    assertPin(req.user!, b.pin, req);
    const from = getCurrency(b.fromCurrency);
    res.status(201).json({
      forward: lockForward(req.user!, { fromCurrency: from.code, toCurrency: b.toCurrency, amountMinor: toMinor(b.amount, from.decimals), settleOn: b.settleOn }, { type: 'user', id: req.user!.id }),
    });
  }),
);
fxToolsRouter.get('/forwards', (req, res) => res.json({ items: listForwards(req.user!.id) }));
fxToolsRouter.get('/forwards/:id', (req, res) => res.json({ forward: getForward(req.user!.id, String(req.params.id)) }));
fxToolsRouter.post('/forwards/:id/settle', (req, res) => {
  getForward(req.user!.id, String(req.params.id));
  res.json({ forward: settleForward(String(req.params.id), { type: 'user', id: req.user!.id }) });
});
fxToolsRouter.post('/forwards/:id/cancel', (req, res) => res.json({ forward: cancelForward(req.user!.id, String(req.params.id), { type: 'user', id: req.user!.id }) }));

export const creditRouter = Router();
creditRouter.use(requireAuth);
creditRouter.get('/', (req, res) => res.json({ readiness: getReadiness(req.user!.id, { recompute: req.query.refresh === '1' }), consents: listConsents(req.user!.id) }));
creditRouter.post('/consents', (req, res) => {
  const b = validate(
    z.object({ lenderName: z.string().min(2).max(120), purpose: z.string().max(200).optional().nullable(), days: z.number().int().min(1).max(365).optional().nullable(), pin: z.string().optional() }),
    req.body,
  );
  assertPin(req.user!, b.pin, req); // sharing a signal about you is step-up protected
  res.status(201).json({ consent: grantConsent(req.user!, b, { type: 'user', id: req.user!.id }) });
});
creditRouter.delete('/consents/:id', (req, res) => res.json({ consent: revokeConsent(req.user!, String(req.params.id), { type: 'user', id: req.user!.id }) }));

export const billingRouter = Router();
billingRouter.use(requireAuth);
billingRouter.get('/plans/:code', (req, res) => {
  const p = getPlan(String(req.params.code));
  res.json({ plan: p.status === 'ACTIVE' ? p : { ...p, description: null } });
});
billingRouter.get('/subscriptions', (req, res) => res.json({ items: listSubscriptions({ customerId: req.user!.id }), invoices: listInvoices({ customerId: req.user!.id, limit: 50 }) }));
billingRouter.post(
  '/subscriptions',
  wrap(async (req, res) => {
    const b = validate(z.object({ plan: z.string().min(2), reference: z.string().max(80).optional().nullable(), pin: z.string().optional() }), req.body);
    const ctx = riskContext(req);
    if (!ctx.stepUpVerified) assertPin(req.user!, b.pin, req);
    res.status(201).json(await subscribe(req.user!, b.plan, { reference: b.reference ?? null, mandateConfirmed: true }));
  }),
);
billingRouter.get('/subscriptions/:id', (req, res) => {
  const s = getSubscription(String(req.params.id));
  if (s.customerId !== req.user!.id) return res.status(404).json({ error: { code: 'subscription_not_found', message: 'Subscription not found' } });
  res.json({ subscription: s, invoices: listInvoices({ subscriptionId: s.id }) });
});
billingRouter.post('/subscriptions/:id/cancel', (req, res) => res.json({ subscription: cancelSubscription(req.user!, String(req.params.id), { immediately: !!req.body?.immediately }) }));
