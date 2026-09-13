/**
 * Offline protocol and Diaspora-Direct for account holders and merchants. Mounted at /api/v1 and /v1.
 */
import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { requireAuth, requireRole, requireScope } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { assertPin } from '../services/auth';
import { getCurrency } from '../services/currencies';
import { toMinor } from '@bitripay/shared';
import { registerOfflineDevice, listOfflineDevices, offlineQr, syncPromises, listPromises, getOfflineSettings, promiseCanonical, promiseHash, issueOfflineNonce } from '../services/offline';
import {
  listRateCards,
  createQuote,
  getQuote,
  listQuotes,
  payQuote,
  listInstitutions,
  registerInstitution,
  getInstitution,
  institutionQr,
  purposeCatalogue,
  RESTRICTED_PURPOSES,
} from '../services/diaspora';
import { riskContext } from '../services/risk';
import { openApiDocument } from '../docs/openapi';

export const intelligenceRouter = Router();
/** Machine-readable description of the whole v1 surface (cached for an hour). */
intelligenceRouter.get('/openapi.json', (_req, res) => res.setHeader('Cache-Control', 'public, max-age=3600').json(openApiDocument()));
const r = intelligenceRouter;
const writeLimit = rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'intel' });

// ---------------------------------------------------------------- offline protocol
r.get('/offline/settings', requireAuth, (_req, res) =>
  res.json({ ...getOfflineSettings(), promiseVersion: 'v1', canonical: 'BITRIQR-OFFLINE|v1|merchantId|payerId|amountMinor|CURRENCY|nonce|expiresAt|counter|reference' }),
);
r.get('/offline/devices', requireAuth, (req, res) => res.json({ data: listOfflineDevices(req.user!.id) }));
r.post('/offline/devices', requireAuth, writeLimit, (req, res) => {
  const b = validate(z.object({ deviceId: z.string().min(6).max(80), publicKey: z.string().min(40).max(200), label: z.string().max(80).optional().nullable() }), req.body);
  res.status(201).json(registerOfflineDevice(req.user!, b));
});
r.post('/offline/nonces', requireAuth, requireRole('merchant', 'admin'), writeLimit, (req, res) => {
  const b = validate(z.object({ count: z.number().int().min(1).max(50).default(10) }), req.body ?? {});
  res.status(201).json({ data: Array.from({ length: b.count }, () => issueOfflineNonce(req.user!.id)) });
});
r.post('/offline/qr', requireAuth, requireRole('merchant', 'admin'), requireScope('qr_codes:write', 'qr:create'), writeLimit, (req, res) => {
  const b = validate(
    z.object({
      amount: z.string().optional(),
      amount_minor: z.number().int().positive().optional(),
      currency: z.string().length(3),
      reference: z.string().max(40).optional().nullable(),
      ttl_seconds: z.number().int().min(60).max(3600).optional().nullable(),
    }),
    req.body,
  );
  const cur = getCurrency(b.currency);
  const amountMinor = b.amount_minor ?? (b.amount ? toMinor(b.amount, cur.decimals) : 0);
  res.status(201).json(offlineQr(req.user!, { amountMinor, currency: cur.code, reference: b.reference ?? null, ttlSeconds: b.ttl_seconds ?? null }));
});
const promiseSchema = z.object({
  merchantId: z.string(),
  payerId: z.string(),
  payerDeviceId: z.string(),
  merchantKeyId: z.string(),
  payerKeyId: z.string(),
  amountMinor: z.number().int().positive(),
  currency: z.string().length(3),
  nonce: z.string().min(8).max(64),
  expiresAt: z.string(),
  counter: z.number().int().min(1),
  reference: z.string().max(40).optional().nullable(),
  merchantSig: z.string().default(''),
  payerSig: z.string().min(40),
  promisedAt: z.string(),
  qrPayload: z.string().max(4000).optional().nullable(),
});
r.post(
  '/offline/sync',
  requireAuth,
  rateLimit({ windowMs: 60_000, max: 30, keyPrefix: 'offline-sync' }),
  wrap(async (req, res) => {
    const b = validate(z.object({ promises: z.array(promiseSchema).min(1).max(200) }), req.body);
    res.json(await syncPromises(req.user!, b.promises));
  }),
);
r.post('/offline/hash', requireAuth, (req, res) => {
  const b = validate(promiseSchema.pick({ merchantId: true, payerId: true, amountMinor: true, currency: true, nonce: true, expiresAt: true, counter: true, reference: true }), req.body);
  const canonical = promiseCanonical(b);
  res.json({ canonical, hash: promiseHash(canonical) });
});
r.get('/offline/promises', requireAuth, (req, res) =>
  res.json({ data: listPromises(req.user!.id, { state: req.query.state ? String(req.query.state) : null, limit: Number(req.query.limit) || 100 }) }),
);

// ---------------------------------------------------------------- Diaspora-Direct
r.get('/diaspora/rate-cards', (_req, res) =>
  res.json({
    data: listRateCards().map((c) => ({
      id: c.id,
      sourceCurrency: c.sourceCurrency,
      destCurrency: c.destCurrency,
      customerRate: c.customerRate,
      validFrom: c.validFrom,
      validUntil: c.validUntil,
      keyId: c.keyId,
      signature: c.signature,
    })),
    purposes: purposeCatalogue(),
    restricted: RESTRICTED_PURPOSES,
  }),
);
r.get('/institutions', (req, res) =>
  res.json({
    data: listInstitutions({
      status: 'verified',
      country: req.query.country ? String(req.query.country) : null,
      purposeCode: req.query.purpose ? String(req.query.purpose) : null,
      q: req.query.q ? String(req.query.q) : null,
    }).map((i) => ({ userId: i.userId, kind: i.kind, name: i.name, purposeCodes: i.purposeCodes, country: i.country, tag: i.user?.tag ?? null })),
  }),
);
r.post('/institutions', requireAuth, requireRole('merchant', 'admin'), writeLimit, (req, res) => {
  const b = validate(
    z.object({
      kind: z.string(),
      name: z.string().min(2).max(160),
      registryRef: z.string().max(80).optional().nullable(),
      purposeCodes: z.array(z.string()).min(1).max(12),
      country: z.string().length(2).optional().nullable(),
    }),
    req.body,
  );
  res.status(201).json(registerInstitution(req.user!, b));
});
r.get('/institutions/me', requireAuth, (req, res) => res.json(getInstitution(req.user!.id)));
r.post('/institutions/me/qr', requireAuth, requireRole('merchant', 'admin'), writeLimit, (req, res) => {
  const b = validate(
    z.object({ purposeCode: z.string(), currency: z.string().length(3), reference: z.string().max(40).optional().nullable(), amount_minor: z.number().int().positive().optional().nullable() }),
    req.body,
  );
  res.status(201).json(institutionQr(req.user!, { purposeCode: b.purposeCode, currency: b.currency, reference: b.reference ?? null, amountMinor: b.amount_minor ?? null }));
});
r.post('/diaspora/quotes', requireAuth, writeLimit, (req, res) => {
  const b = validate(
    z.object({
      beneficiary: z.string().min(2),
      sourceCurrency: z.string().length(3),
      destCurrency: z.string().length(3).optional().nullable(),
      sourceMinor: z.number().int().positive().optional().nullable(),
      destMinor: z.number().int().positive().optional().nullable(),
      purposeCode: z.string(),
      reference: z.string().max(80).optional().nullable(),
    }),
    req.body,
  );
  res.status(201).json(createQuote(req.user!, b));
});
r.get('/diaspora/quotes', requireAuth, (req, res) => res.json({ data: listQuotes(req.user!.id, Number(req.query.limit) || 50) }));
r.get('/diaspora/quotes/:id', requireAuth, (req, res) => res.json(getQuote(req.user!.id, String(req.params.id))));
r.post(
  '/diaspora/quotes/:id/pay',
  requireAuth,
  writeLimit,
  wrap(async (req, res) => {
    const b = validate(z.object({ pin: z.string().optional() }), req.body ?? {});
    assertPin(req.user!, b.pin, req);
    res.json(payQuote(req.user!, String(req.params.id), riskContext(req)));
  }),
);
