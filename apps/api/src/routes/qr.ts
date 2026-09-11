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

/** Resolve scanned QR content into a payable target. */
qrRouter.post(
  '/resolve',
  optionalAuth,
  wrap(async (req, res) => {
    const body = validate(z.object({ data: z.string().min(1).max(2000) }), req.body);
    const payload = decodeQr(body.data);
    if (!payload) throw badRequest('This is not a BitriPay QR code', 'invalid_qr');
    if (payload.type === 'pr') {
      const row = getPaymentRequestByCode(payload.id);
      const info = checkoutInfo(row.code);
      return res.json({ kind: 'payment_request', payload, paymentRequest: toPaymentRequest(row), merchant: info.merchant, methods: info.methods });
    }
    const user = findUserByTag(payload.id);
    if (!user || user.is_system || user.status !== 'active') throw notFound('User not found', 'user_not_found');
    res.json({ kind: payload.type === 'ag' ? 'agent' : payload.type === 'm' ? 'merchant' : 'user', payload, user: toPublicUser(user), amount: payload.amount ?? null, currency: payload.currency ?? null, note: payload.note ?? null });
  }),
);
