import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { config } from '../config';
import { listCurrencies, getBaseCurrency } from '../services/currencies';
import { getAppSettings, getFees, getLimits, getReferralSettings, getSetting } from '../services/settings';
import { getModules } from '../services/modules';
import { getSiteSettings, listPages, getPage, submitContact, subscribeNewsletter, listLanguages, getTranslationOverrides } from '../services/cms';
import { listGateways, isGatewayReady, getGatewayCredentials } from '../payments';
import { getSmtpSettings } from '../services/messaging';
import { COUNTRIES } from '@bitripay/shared';
import { rateLimit } from '../middleware/rateLimit';
import { listOperators as listMomoOperators } from '../services/momo';

export const publicRouter = Router();

publicRouter.get('/config', (_req, res) => {
  const app = getAppSettings();
  const stripe = listGateways().find((g) => g.provider === 'stripe' && isGatewayReady(g));
  const sandbox = listGateways().find((g) => g.provider === 'sandbox' && isGatewayReady(g));
  res.json({
    appName: config.appName,
    baseCurrency: getBaseCurrency().code,
    currencies: listCurrencies(true),
    fees: getFees(),
    limits: getLimits(),
    features: {
      stripe: !!stripe,
      stripePublishableKey: stripe ? getGatewayCredentials(stripe.id).publishableKey || null : null,
      sandboxPayments: !!sandbox,
      emailOtp: true,
      smsOtp: true,
      smtpConfigured: !!getSmtpSettings().host,
      passkeys: true,
      directMobileMoney: true,
      signedSmsEvidence: true,
      complianceMode: getSetting('compliance', { mode: 'sandbox' }).mode,
      corridors: true,
      makerChecker: true,
      idempotencyKeys: true,
    },
    webUrl: config.webUrl,
    apiUrl: config.apiUrl,
    agentCommissionBps: app.agentCommissionBps,
    referral: getReferralSettings(),
    modules: getModules(),
    maintenanceMode: app.maintenanceMode,
    registrationOpen: app.registrationOpen,
    site: getSiteSettings(),
    languages: listLanguages().filter((l) => l.enabled),
    exchangeMarginBps: app.exchangeMarginBps,
    countries: COUNTRIES,
  });
});

publicRouter.get('/countries', (_req, res) => res.json({ items: COUNTRIES }));
publicRouter.get('/mobile-money-operators', (req, res) => res.json({ items: listMomoOperators({ country: req.query.country ? String(req.query.country) : null }) }));
publicRouter.get('/currencies', (req, res) => res.json({ items: listCurrencies(req.query.all !== '1') }));
publicRouter.get('/pages', (_req, res) => res.json({ items: listPages().map(({ content, ...p }) => p) }));
publicRouter.get('/pages/:slug', (req, res) => res.json(getPage(String(req.params.slug))));
publicRouter.get('/translations/:lang', (req, res) => res.json({ lang: String(String(req.params.lang)), overrides: getTranslationOverrides(String(req.params.lang)) }));

publicRouter.post(
  '/contact',
  rateLimit({ windowMs: 60_000, max: 5, keyPrefix: 'contact' }),
  wrap(async (req, res) => {
    const body = validate(z.object({ name: z.string().min(1).max(120), email: z.string().email(), subject: z.string().min(1).max(200), message: z.string().min(1).max(5000) }), req.body);
    res.status(201).json(submitContact(body));
  }),
);

publicRouter.post(
  '/newsletter',
  rateLimit({ windowMs: 60_000, max: 5, keyPrefix: 'newsletter' }),
  wrap(async (req, res) => {
    const body = validate(z.object({ email: z.string().email() }), req.body);
    subscribeNewsletter(body.email);
    res.json({ ok: true });
  }),
);

publicRouter.get('/health', (_req, res) => res.json({ ok: true, app: config.appName, time: new Date().toISOString() }));
