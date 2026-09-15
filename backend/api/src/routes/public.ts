import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { config } from '../config';
import { listCurrencies, getBaseCurrency } from '../services/currencies';
import { currencyFlag } from '@bitripay/shared';
import { getAppSettings, getFees, getLimits, getReferralSettings, getSetting } from '../services/settings';
import { getModules } from '../services/modules';
import { getSiteSettings, listPages, getPage, submitContact, subscribeNewsletter, listLanguages, getTranslationOverrides } from '../services/cms';
import { listGateways, isGatewayReady, getGatewayCredentials } from '../payments';
import { getSmtpSettings } from '../services/messaging';
import { COUNTRIES } from '@bitripay/shared';
import { rateLimit } from '../middleware/rateLimit';
import { consentView, confirmPayoutCurrency } from '../services/routing';
import { verifyStatement } from '../services/statements';
import { statementVerifyPage } from '../site/render';
import { AppError } from '../lib/errors';
import { listOperators as listMomoOperators } from '../services/momo';
import { localeFromRequest } from '../services/locale';
import { optionalAuth } from '../middleware/auth';

export const publicRouter = Router();

publicRouter.get('/locale', optionalAuth, (req, res) =>
  res.json(localeFromRequest({ headers: req.headers as Record<string, unknown>, query: req.query as Record<string, unknown>, user: req.user ?? null })),
);
publicRouter.get('/config', (_req, res) => {
  const app = getAppSettings();
  const stripe = listGateways().find((g) => g.provider === 'stripe' && isGatewayReady(g));
  const sandbox = listGateways().find((g) => g.provider === 'sandbox' && isGatewayReady(g));
  res.json({
    appName: config.appName,
    baseCurrency: getBaseCurrency().code,
    currencies: listCurrencies(true).map((c) => ({ ...c, flag: currencyFlag(c.code) })),
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
    adminUrl: config.adminUrl,
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
/** Verify a statement's number and integrity hash (no personal data is returned). */
/** Anyone holding a statement can check it. A browser gets a readable page; API clients (no Accept header, or JSON first) get JSON. */
publicRouter.get('/statements/verify/:id', rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'stmt' }), (req, res) => {
  const id = String(req.params.id);
  const wantsHtml = req.accepts(['json', 'html']) === 'html';
  if (!wantsHtml) return res.json({ statement: verifyStatement(id) });
  try {
    return res.type('html').send(statementVerifyPage(verifyStatement(id), id));
  } catch (err) {
    if (err instanceof AppError && err.status === 404) return res.status(404).type('html').send(statementVerifyPage(null, id));
    throw err;
  }
});
/** Beneficiary currency confirmation (regulated corridors): the recipient opens the link, sees what is offered and confirms. */
publicRouter.get('/routes/consent/:token', rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'consent' }), (req, res) => res.json(consentView(String(req.params.token))));
publicRouter.post(
  '/routes/consent/:token',
  rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'consent' }),
  wrap(async (req, res) => {
    const body = validate(z.object({ accept: z.boolean(), currency: z.string().length(3).optional().nullable() }), req.body);
    const route = confirmPayoutCurrency(String(req.params.token), { accept: body.accept, currency: body.currency }, { type: 'user', id: null });
    res.json({ ok: true, stage: route.stage, currency: route.targetCurrency });
  }),
);
publicRouter.get('/mobile-money-operators', (req, res) => res.json({ items: listMomoOperators({ country: req.query.country ? String(req.query.country) : null }) }));
publicRouter.get('/currencies', (req, res) => res.json({ items: listCurrencies(req.query.all !== '1').map((c) => ({ ...c, flag: currencyFlag(c.code) })) }));
publicRouter.get('/pages', (_req, res) => res.json({ items: listPages().map(({ content: _content, ...p }) => p) }));
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
