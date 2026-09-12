/**
 * BitriPay Gateway API v1: payment intents, QR codes, locations, method discovery, the public scan resolver and the
 * signing-key registry. Merchants authenticate with API keys (bp_live_/bp_test_) or a merchant session; every
 * money-moving POST carries an Idempotency-Key. Payers use the resolver and the wallet-pay endpoint from the apps.
 */
import { Router } from 'express';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { validate, wrap, getClientIp } from '../lib/http';
import { requireAuth, optionalAuth, requireRole } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { badRequest, forbidden } from '../lib/errors';
import { getCurrency } from '../services/currencies';
import { toMinor } from '@bitripay/shared';
import { createIntent, getIntentRow, intentView, cancelIntent, listIntents, discoverMethods, intentTimeline, verifyClientSecret, setIntentAmount, startAttempt, type CreateIntentInput } from '../services/intents';
import { createStaticQr, createDynamicQr, getQr, listQrs, revokeQr, qrAnalytics, resolveScan, intentFromStaticQr, createLocation, listLocations, getLocation, createTerminal } from '../services/qrcodes';
import { publicKeyRegistry } from '../services/keys';
import { PURPOSE_CODES, countryCapabilities } from '../services/capabilities';
import { payWithWallet, getPaymentRequestByCode } from '../services/paymentRequests';
import { assertPin } from '../services/auth';
import { toTransaction } from '../services/ledger';
import { listWallets, toWallet } from '../services/wallets';
import { getOperatingState } from '../services/guardian';
import { getDb } from '../db';

export const v1Router = Router();
const merchantOnly = [requireAuth, requireRole('merchant', 'admin')];
const writeLimit = rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'v1w' });
const publicLimit = rateLimit({ windowMs: 60_000, max: 300, keyPrefix: 'v1p' });

const intentSchema = z.object({
  amount: z.number().int().positive().optional().nullable(),
  amount_minor: z.number().int().positive().optional().nullable(),
  currency: z.string().length(3),
  rails: z.array(z.string()).optional(),
  capture_method: z.enum(['automatic', 'manual']).optional(),
  payment_method_policy: z.enum(['smart', 'cheapest', 'fastest', 'most_reliable']).optional(),
  reference: z.string().max(64).optional().nullable(),
  description: z.string().max(200).optional().nullable(),
  purpose_code: z.enum(PURPOSE_CODES).optional().nullable(),
  expires_in_minutes: z.number().int().min(1).max(60 * 24 * 30).optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  customer_msisdn: z.string().max(20).optional().nullable(),
  customer_country: z.string().length(2).optional().nullable(),
  location_id: z.string().optional().nullable(),
  terminal_id: z.string().optional().nullable(),
  success_url: z.string().url().optional().nullable(),
  cancel_url: z.string().url().optional().nullable(),
  qr: z.boolean().optional(),
  qr_ttl_seconds: z.number().int().min(30).max(3600).optional(),
});

function toInput(b: z.output<typeof intentSchema>, idemKey: string | null, source: CreateIntentInput['source']): CreateIntentInput {
  return { amountMinor: b.amount_minor ?? b.amount ?? null, currency: b.currency, rails: b.rails, captureMethod: b.capture_method, methodPolicy: b.payment_method_policy, reference: b.reference ?? null, description: b.description ?? null, purposeCode: b.purpose_code ?? null, expiresInMinutes: b.expires_in_minutes ?? null, metadata: b.metadata, customerMsisdn: b.customer_msisdn ?? null, customerCountry: b.customer_country ?? null, locationId: b.location_id ?? null, terminalId: b.terminal_id ?? null, successUrl: b.success_url ?? null, cancelUrl: b.cancel_url ?? null, source, idemKey };
}

/** Public-facing intent object (Stripe-shaped keys next to the canonical view). */
function publicIntent(view: ReturnType<typeof intentView>, clientSecret?: string | null) {
  return { ...view, ...(clientSecret ? { client_secret: clientSecret } : {}), qr_payload: view.qrPayload, checkout_url: view.checkoutUrl };
}

// ---------------------------------------------------------------------------------------------------------------------
// Payment intents (merchant)
// ---------------------------------------------------------------------------------------------------------------------
v1Router.post('/payment_intents', ...merchantOnly, writeLimit, wrap(async (req, res) => {
  const body = validate(intentSchema, req.body);
  const idem = (req.headers['idempotency-key'] as string | undefined) ?? null;
  const { row, clientSecret } = createIntent(req.user!, toInput(body, idem, 'api'));
  let view = intentView(row);
  if ((body.qr ?? true) && row.amount_minor && !row.qr_id) {
    createDynamicQr(req.user!, row, body.qr_ttl_seconds ?? 300);
    view = intentView(getIntentRow(row.id));
  }
  res.status(201).json(publicIntent(view, clientSecret));
}));
v1Router.get('/payment_intents', ...merchantOnly, (req, res) => res.json({ data: listIntents({ merchantUserId: req.user!.role === 'admin' && req.query.merchant ? String(req.query.merchant) : req.user!.id, status: req.query.status ? String(req.query.status) : null, limit: Math.min(200, Number(req.query.limit) || 50) }).map((v) => publicIntent(v)) }));
v1Router.get('/payment_intents/:id', optionalAuth, (req, res) => {
  const row = getIntentRow(String(req.params.id));
  const secret = String(req.query.client_secret ?? req.headers['x-client-secret'] ?? '');
  const owner = req.user && (req.user.id === row.merchant_user_id || req.user.role === 'admin' || req.user.id === row.customer_user_id);
  if (!owner && !verifyClientSecret(row, secret)) throw forbidden('Not your payment intent', 'forbidden');
  res.json(publicIntent(intentView(row)));
});
v1Router.get('/payment_intents/:id/timeline', ...merchantOnly, (req, res) => {
  const row = getIntentRow(String(req.params.id));
  if (row.merchant_user_id !== req.user!.id && req.user!.role !== 'admin') throw forbidden('Not your payment intent', 'forbidden');
  res.json(intentTimeline(row.id));
});
v1Router.post('/payment_intents/:id/cancel', ...merchantOnly, writeLimit, (req, res) => {
  const row = getIntentRow(String(req.params.id));
  if (row.merchant_user_id !== req.user!.id && req.user!.role !== 'admin') throw forbidden('Not your payment intent', 'forbidden');
  res.json(publicIntent(intentView(cancelIntent(row.id, { type: req.user!.role === 'admin' ? 'admin' : 'merchant', id: req.user!.id }, String(req.body?.reason ?? '') || null))));
});
/** Refresh the dynamic QR (new expiry, new signature) for an open intent. */
v1Router.post('/payment_intents/:id/qr', ...merchantOnly, writeLimit, (req, res) => {
  const row = getIntentRow(String(req.params.id));
  if (row.merchant_user_id !== req.user!.id && req.user!.role !== 'admin') throw forbidden('Not your payment intent', 'forbidden');
  const qr = createDynamicQr(req.user!, row, Number(req.body?.ttl_seconds) || 300);
  res.status(201).json({ qr, payment_intent: publicIntent(intentView(getIntentRow(row.id))) });
});
v1Router.get('/payment_intents/:id/methods', optionalAuth, (req, res) => {
  const row = getIntentRow(String(req.params.id));
  res.json({ data: discoverMethods(row, req.user ?? null, req.query.country ? String(req.query.country) : null) });
});
v1Router.get('/payment_methods/available', optionalAuth, (req, res) => {
  const currency = getCurrency(String(req.query.currency ?? 'USD'));
  const caps = countryCapabilities(req.query.country ? String(req.query.country) : null);
  res.json({ currency: currency.code, capabilities: caps });
});

// ---------------------------------------------------------------------------------------------------------------------
// Payer actions (apps): pay an intent from the wallet, set the amount on a static-QR intent
// ---------------------------------------------------------------------------------------------------------------------
v1Router.post('/payment_intents/:id/pay/wallet', requireAuth, writeLimit, wrap(async (req, res) => {
  const body = validate(z.object({ pin: z.string().optional(), amount: z.string().optional().nullable() }), req.body);
  let row = getIntentRow(String(req.params.id));
  if (!row.amount_minor) {
    if (!body.amount) throw badRequest('Enter an amount', 'amount_required');
    row = setIntentAmount(row.id, toMinor(body.amount, getCurrency(row.currency).decimals), { type: 'user', id: req.user!.id });
  }
  assertPin(req.user!, body.pin, req);
  const attempt = startAttempt(row.id, { methodClass: 'wallet', rail: 'wallet', connector: 'wallet' }, { type: 'user', id: req.user!.id });
  try {
    const request = getPaymentRequestByCode((getDb().prepare('SELECT code FROM payment_requests WHERE id = ?').get(row.payment_request_id!) as any).code);
    const result = payWithWallet(req.user!, request.code, row.amount_minor);
    res.status(201).json({ payment_intent: publicIntent(intentView(getIntentRow(row.id))), transaction: toTransaction(result.tx, req.user!.id), attempt_id: attempt.id });
  } catch (e) {
    const { finishAttempt } = await import('../services/intents');
    finishAttempt(attempt.id, 'FAILED', { failureCategory: (e as any)?.code === 'insufficient_funds' ? 'insufficient_funds' : 'declined', error: (e as Error).message }, { type: 'user', id: req.user!.id });
    throw e;
  }
}));
v1Router.post('/qr/:id/intent', optionalAuth, writeLimit, (req, res) => {
  const body = validate(z.object({ amount: z.string(), description: z.string().max(120).optional().nullable() }), req.body);
  const qr = getQr(String(req.params.id));
  const view = intentFromStaticQr(qr.id, toMinor(body.amount, getCurrency(qr.currency).decimals), req.user ?? null, { description: body.description ?? null });
  res.status(201).json(publicIntent(view));
});

// ---------------------------------------------------------------------------------------------------------------------
// Resolver and key registry (public)
// ---------------------------------------------------------------------------------------------------------------------
v1Router.post('/resolve', optionalAuth, publicLimit, wrap(async (req, res) => {
  const body = validate(z.object({ content: z.string().min(3).max(2000), channel: z.string().max(20).optional(), country: z.string().length(2).optional().nullable() }), req.body);
  res.json(await resolveScan(body.content, { payer: req.user ?? null, ip: getClientIp(req), channel: body.channel ?? 'app', country: body.country ?? req.user?.country ?? null }));
}));
v1Router.get('/resolve/:ref', optionalAuth, publicLimit, wrap(async (req, res) => res.json(await resolveScan(String(req.params.ref), { payer: req.user ?? null, ip: getClientIp(req), channel: String(req.query.channel ?? 'web'), country: req.query.country ? String(req.query.country) : req.user?.country ?? null }))));
function etagOf(data: unknown) {
  return `"${createHash('sha1').update(JSON.stringify(data)).digest('hex').slice(0, 20)}"`;
}
v1Router.get('/keys', publicLimit, (req, res) => {
  const data = publicKeyRegistry();
  const etag = etagOf(data);
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.setHeader('ETag', etag).setHeader('Cache-Control', 'public, max-age=300').json({ algorithm: 'ed25519', keys: data });
});
v1Router.get('/keys/:keyId', publicLimit, (req, res) => {
  const data = publicKeyRegistry(String(req.params.keyId));
  if (!data.length) return res.status(404).json({ error: { code: 'key_not_found', message: 'Unknown key' } });
  const etag = etagOf(data[0]);
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.setHeader('ETag', etag).setHeader('Cache-Control', 'public, max-age=300').json(data[0]);
});
v1Router.get('/status', publicLimit, (_req, res) => res.json({ mode: getOperatingState().mode, time: new Date().toISOString() }));

// ---------------------------------------------------------------------------------------------------------------------
// QR codes, locations, terminals (merchant)
// ---------------------------------------------------------------------------------------------------------------------
v1Router.post('/qr_codes', ...merchantOnly, writeLimit, (req, res) => {
  const body = validate(z.object({ location_id: z.string().optional().nullable(), terminal_id: z.string().optional().nullable(), rails: z.array(z.string()).optional(), currency: z.string().length(3), purpose_code: z.enum(PURPOSE_CODES).optional().nullable(), reference: z.string().max(40).optional().nullable(), kind: z.enum(['merchant', 'invoice', 'p2p', 'agent', 'cross_border', 'refund', 'mandate', 'institution']).optional(), sign: z.boolean().optional(), asset_ref: z.string().max(60).optional().nullable() }), req.body);
  res.status(201).json(createStaticQr(req.user!, { locationId: body.location_id ?? null, terminalId: body.terminal_id ?? null, rails: body.rails, currency: body.currency, purposeCode: body.purpose_code ?? null, reference: body.reference ?? null, kind: body.kind, sign: body.sign, assetRef: body.asset_ref ?? null }));
});
v1Router.get('/qr_codes', ...merchantOnly, (req, res) => res.json({ data: listQrs(req.user!.id, { locationId: req.query.location_id ? String(req.query.location_id) : null, mode: req.query.mode ? String(req.query.mode).toUpperCase() : null, status: req.query.status ? String(req.query.status) : null }) }));
v1Router.get('/qr_codes/analytics', ...merchantOnly, (req, res) => res.json(qrAnalytics(req.user!.id, Number(req.query.days) || 30)));
v1Router.get('/qr_codes/:id', ...merchantOnly, (req, res) => {
  const qr = getQr(String(req.params.id));
  if (qr.merchantId !== req.user!.id && req.user!.role !== 'admin') throw forbidden('Not your QR code', 'forbidden');
  res.json(qr);
});
v1Router.post('/qr_codes/:id/revoke', ...merchantOnly, writeLimit, (req, res) => {
  const body = validate(z.object({ reason: z.enum(['lost', 'stolen', 'tampered', 'replaced', 'retired']).default('retired') }), req.body ?? {});
  res.json(revokeQr(req.user!, String(req.params.id), body.reason));
});
v1Router.post('/locations', ...merchantOnly, writeLimit, (req, res) => {
  const body = validate(z.object({ name: z.string().min(2).max(80), address: z.string().max(160).optional().nullable(), city: z.string().max(60).optional().nullable(), country: z.string().length(2).optional().nullable(), mcc: z.string().regex(/^\d{4}$/).optional().nullable(), lat: z.number().optional().nullable(), lng: z.number().optional().nullable() }), req.body);
  res.status(201).json(createLocation(req.user!, body));
});
v1Router.get('/locations', ...merchantOnly, (req, res) => res.json({ data: listLocations(req.user!.id) }));
v1Router.get('/locations/:id', ...merchantOnly, (req, res) => res.json(getLocation(req.user!.id, String(req.params.id))));
v1Router.post('/locations/:id/terminals', ...merchantOnly, writeLimit, (req, res) => {
  const body = validate(z.object({ label: z.string().min(1).max(60), device_ref: z.string().max(80).optional().nullable() }), req.body);
  res.status(201).json(createTerminal(req.user!, String(req.params.id), { label: body.label, deviceRef: body.device_ref ?? null }));
});

// ---------------------------------------------------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------------------------------------------------
v1Router.get('/balance', ...merchantOnly, (req, res) => {
  // Balance classes computed from the ledger and open objects: what can actually be withdrawn, what is on its way in,
  // what is reserved by open cash-out codes, what was captured and awaits the settlement run, what is frozen.
  const db = getDb();
  const uid = req.user!.id;
  const wallets = listWallets(uid).map((w) => toWallet(w, req.user!));
  const data = listWallets(uid).map((w) => {
    const pending = (db.prepare("SELECT COALESCE(SUM(amount_minor), 0) s FROM payment_intents WHERE merchant_user_id = ? AND currency = ? AND status IN ('PROCESSING', 'AUTHORISED', 'AMBIGUOUS', 'UNKNOWN_PROVIDER_STATE', 'REQUIRES_CUSTOMER_ACTION')").get(uid, w.currency) as any).s as number;
    const reserved = (db.prepare("SELECT COALESCE(SUM(amount), 0) s FROM cash_requests WHERE user_id = ? AND currency = ? AND status = 'pending' AND expires_at > ?").get(uid, w.currency, new Date().toISOString()) as any).s as number;
    const settlementPending = (db.prepare("SELECT COALESCE(SUM(amount_minor), 0) s FROM payment_intents WHERE merchant_user_id = ? AND currency = ? AND status = 'SETTLEMENT_PENDING'").get(uid, w.currency) as any).s as number;
    const disputed = (db.prepare("SELECT COALESCE(SUM(t.amount), 0) s FROM chargebacks c JOIN gateway_payments p ON p.id = c.payment_id JOIN transactions t ON t.id = p.transaction_id WHERE p.user_id = ? AND t.currency = ? AND c.status = 'open'").get(uid, w.currency) as any)?.s ?? 0;
    const frozen = w.frozen_at ? w.balance : 0;
    return { currency: w.currency, balance: w.balance, available: Math.max(0, frozen ? 0 : w.balance - reserved - disputed), pending, reserved, settlement_pending: settlementPending, disputed, frozen, classification: wallets.find((x) => x.currency === w.currency)?.classification ?? null };
  });
  res.json({ wallets, data });
});
