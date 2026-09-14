import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { optionalAuth, requireAuth } from '../middleware/auth';
import { qrContent, qrDataUrl, qrSvg, decodeQr } from '../services/qr';
import { findUserByTag, toPublicUser } from '../services/users';
import { getPaymentRequestByCode, toPaymentRequest, checkoutInfo } from '../services/paymentRequests';
import { badRequest, notFound } from '../lib/errors';
import { getCurrency } from '../services/currencies';
import { toMinor } from '@bitripay/shared';
import { resolveScan } from '../services/qrcodes';
import { getClientIp } from '../lib/http';
import { rateLimit, keyByDevice, keyByQrId } from '../middleware/rateLimit';

export const qrRouter = Router();

/** My static receive QR (optionally pre-filled with amount/currency/note). */
qrRouter.get(
  '/me',
  requireAuth,
  wrap(async (req, res) => {
    const user = req.user!;
    const type = user.role === 'merchant' ? 'm' : user.role === 'agent' ? 'ag' : 'u';
    const payload: any = { type, id: user.tag };
    if (req.query.amount && req.query.currency) {
      const cur = getCurrency(String(req.query.currency));
      toMinor(String(req.query.amount), cur.decimals); // validate
      payload.amount = String(req.query.amount);
      payload.currency = cur.code;
    }
    if (req.query.note) payload.note = String(req.query.note).slice(0, 120);
    const content = qrContent(payload);
    res.json({ payload, content: content.link, native: content.native, image: await qrDataUrl(content.link), user: toPublicUser(user) });
  }),
);

/** Render any QR content as SVG (used by the web/mobile apps and the WooCommerce plugin). */
qrRouter.get(
  '/image.svg',
  wrap(async (req, res) => {
    const data = String(req.query.data || '');
    if (!data || data.length > 1000) throw badRequest('data is required');
    res.type('image/svg+xml').send(await qrSvg(data));
  }),
);

/** Resolve scanned QR content into a payable target. Limited per client address, per device and per QR id. */
qrRouter.post(
  '/resolve',
  rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'qr_resolve' }),
  rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'qr_resolve_device', keyBy: keyByDevice }),
  rateLimit({ windowMs: 60_000, max: 240, keyPrefix: 'qr_resolve_qr', keyBy: keyByQrId }),
  optionalAuth,
  wrap(async (req, res) => {
    const body = validate(z.object({ data: z.string().min(1).max(2000) }), req.body);
    // Short codes and `/q/<code>` links (reusable payment links, printed stickers) resolve through the registry too.
    const shortCode = body.data.match(/(?:^|\/q\/)([A-Za-z0-9]{6,12})\/?(?:[?#].*)?$/)?.[1] ?? null;
    const payload = decodeQr(body.data) ?? (shortCode ? { type: 'bq' as const, id: shortCode } : null);
    if (!payload) throw badRequest('This is not a BitriPay QR code', 'invalid_qr');
    if (payload.type === 'pi' || payload.type === 'bq') {
      // BitriQR (EMVCo) or intent URI: verified through the key registry; intents are paid as payment requests.
      const r = await resolveScan(shortCode && !decodeQr(body.data) ? shortCode : body.data, { payer: req.user ?? null, ip: getClientIp(req), channel: 'app', country: req.user?.country ?? null });
      if (r.kind === 'invalid') throw badRequest(`This QR code cannot be used: ${r.reasons.join(', ')}`, 'invalid_qr');
      if (r.kind === 'intent' && r.intent?.paymentRequestCode) {
        const row = getPaymentRequestByCode(r.intent.paymentRequestCode);
        const info = checkoutInfo(row.code);
        return res.json({
          kind: 'payment_request',
          payload,
          paymentRequest: toPaymentRequest(row),
          merchant: { ...info.merchant, verified: r.merchant?.verified ?? false, location: r.merchant?.location ?? null },
          methods: info.methods,
          trust: r.trust,
          intent: { id: r.intent.id, status: r.intent.status, purposeCode: r.purposeCode, reference: r.reference, expiresAt: r.expiresAt },
          disclosures: r.disclosures,
        });
      }
      const merchant = findUserByTag(r.merchant!.tag);
      if (!merchant) throw notFound('Merchant not found', 'user_not_found');
      return res.json({
        kind: 'bitriqr',
        payload,
        user: { ...toPublicUser(merchant), verified: r.merchant?.verified ?? false, location: r.merchant?.location ?? null },
        qrId: r.qr?.id ?? null,
        amount: r.amount != null && r.currency ? String(r.amount / 10 ** getCurrency(r.currency, false).decimals) : null,
        currency: r.currency,
        note: r.reference ?? null,
        purposeCode: r.purposeCode,
        trust: r.trust,
        disclosures: r.disclosures,
      });
    }
    if (payload.type === 'pr') {
      const row = getPaymentRequestByCode(payload.id);
      const info = checkoutInfo(row.code);
      return res.json({ kind: 'payment_request', payload, paymentRequest: toPaymentRequest(row), merchant: info.merchant, methods: info.methods });
    }
    const user = findUserByTag(payload.id);
    if (!user || user.is_system || user.status !== 'active') throw notFound('User not found', 'user_not_found');
    res.json({
      kind: payload.type === 'ag' ? 'agent' : payload.type === 'm' ? 'merchant' : 'user',
      payload,
      user: toPublicUser(user),
      amount: payload.amount ?? null,
      currency: payload.currency ?? null,
      note: payload.note ?? null,
    });
  }),
);
