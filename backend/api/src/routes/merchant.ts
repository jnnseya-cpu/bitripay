import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap, parsePagination } from '../lib/http';
import { requireAuth, requireMerchant } from '../middleware/auth';
import {
  listApiKeys,
  createApiKey,
  revokeApiKey,
  updateGatewaySettings,
  setWebhook,
  rotateWebhookSecret,
  listWebhookDeliveries,
  merchantStats,
  listSettlements,
  upgradeToMerchant,
} from '../services/merchant';
import { getGatewaySettings, toUser } from '../services/users';
import { createPaymentRequest, getPaymentRequestByCode, listPaymentRequests, toPaymentRequest, cancelPaymentRequest } from '../services/paymentRequests';
import { getCurrency } from '../services/currencies';
import { toMinor } from '@bitripay/shared';
import { listTransactions, getTransaction, toTransaction, refundTransaction } from '../services/ledger';
import { listWallets, toWallet } from '../services/wallets';
import { forbidden, notFound } from '../lib/errors';
import { qrDataUrl } from '../services/qr';
import { assertPin } from '../services/auth';
import { verifyPayment, getPayment, toPaymentView } from '../services/payments';
import { setMerchantBitcoinPolicy } from '../services/gateway';
import { merchantBitcoinPolicy } from '../services/capabilities';

/** Merchant dashboard endpoints (JWT). */
export const merchantRouter = Router();
merchantRouter.post(
  '/apply',
  requireAuth,
  wrap(async (req, res) => {
    const body = validate(z.object({ businessName: z.string().min(2).max(120) }), req.body);
    res.json({ user: toUser(upgradeToMerchant(req.user!, body.businessName)) });
  }),
);
merchantRouter.use(...requireMerchant);
merchantRouter.get('/stats', (req, res) => res.json(merchantStats(req.user!)));
merchantRouter.get('/gateway', (req, res) => res.json({ settings: getGatewaySettings(req.user!), webhookUrl: req.user!.webhook_url, webhookSecret: req.user!.webhook_secret }));
merchantRouter.put(
  '/gateway',
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        methods: z.array(z.enum(['wallet', 'card', 'mobile_money', 'bank', 'virtual_card'])).optional(),
        bitcoin: z.boolean().optional(),
        bitcoinSettlement: z.enum(['btc', 'fiat']).optional(),
        settlementCurrency: z.string().length(3).optional().nullable(),
        autoSettle: z.boolean().optional(),
        successUrl: z.string().url().optional().nullable(),
        cancelUrl: z.string().url().optional().nullable(),
        brandColor: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional(),
        logoUrl: z.string().max(500_000).optional().nullable(),
        testMode: z.boolean().optional(),
      }),
      req.body,
    );
    const { bitcoin, bitcoinSettlement, ...gatewayPatch } = body;
    if (bitcoin !== undefined || bitcoinSettlement !== undefined) setMerchantBitcoinPolicy(req.user!, { bitcoin, bitcoinSettlement });
    res.json({ settings: { ...updateGatewaySettings(req.user!, gatewayPatch), ...merchantBitcoinPolicy(req.user!) } });
  }),
);
merchantRouter.get('/api-keys', (req, res) => res.json({ items: listApiKeys(req.user!.id) }));
merchantRouter.post(
  '/api-keys',
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        label: z.string().max(60).default('API key'),
        mode: z.enum(['live', 'test']).default('live'),
        kind: z.enum(['secret', 'publishable', 'restricted']).default('secret'),
        scopes: z.array(z.string()).optional(),
        ipAllowlist: z.array(z.string().max(45)).max(20).optional().nullable(),
      }),
      req.body,
    );
    res.status(201).json({ apiKey: createApiKey(req.user!, body.label, body.mode, { kind: body.kind, scopes: body.scopes, ipAllowlist: body.ipAllowlist ?? null }) });
  }),
);
merchantRouter.delete('/api-keys/:id', (req, res) => {
  revokeApiKey(req.user!.id, String(String(req.params.id)));
  res.json({ ok: true });
});
merchantRouter.put(
  '/webhook',
  wrap(async (req, res) => {
    const body = validate(z.object({ url: z.string().url().optional().nullable() }), req.body);
    res.json(setWebhook(req.user!, body.url ?? null));
  }),
);
merchantRouter.post('/webhook/rotate', (req, res) => res.json(rotateWebhookSecret(req.user!)));
merchantRouter.get('/webhook/deliveries', (req, res) => res.json({ items: listWebhookDeliveries(req.user!.id) }));
merchantRouter.get('/settlements', (req, res) => res.json({ items: listSettlements(req.user!.id) }));
merchantRouter.post(
  '/transactions/:id/refund',
  wrap(async (req, res) => {
    const body = validate(z.object({ pin: z.string().optional(), refundFee: z.boolean().optional() }), req.body);
    assertPin(req.user!, body.pin, req);
    const tx = getTransaction(String(req.params.id));
    if (!tx || tx.receiver_user_id !== req.user!.id) throw notFound('Transaction not found');
    res.json({ transaction: toTransaction(refundTransaction(tx.id, { refundFee: body.refundFee }), req.user!.id) });
  }),
);

/**
 * Public merchant API v1 (API key auth: Authorization: Bearer sk_live_...).
 * Used by the WooCommerce plugin and any custom integration.
 */
export const v1Router = Router();
v1Router.use(requireAuth, (req, _res, next) => {
  if (req.user!.role !== 'merchant' && req.user!.role !== 'admin') return next(forbidden('API access requires a merchant account'));
  next();
});
v1Router.get('/me', (req, res) => res.json({ merchant: toUser(req.user!), wallets: listWallets(req.user!.id).map((w) => toWallet(w)) }));
v1Router.post(
  '/payment-requests',
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        amount: z.string(),
        currency: z.string().length(3),
        description: z.string().max(300).optional().nullable(),
        successUrl: z.string().url().optional().nullable(),
        cancelUrl: z.string().url().optional().nullable(),
        customerEmail: z.string().email().optional().nullable(),
        metadata: z.record(z.unknown()).optional(),
        expiresInMinutes: z.number().int().positive().optional().nullable(),
        allowedMethods: z.array(z.enum(['wallet', 'card', 'mobile_money', 'bank', 'virtual_card'])).optional(),
      }),
      req.body,
    );
    const cur = getCurrency(body.currency);
    const row = createPaymentRequest(req.user!, {
      kind: 'api',
      amount: toMinor(body.amount, cur.decimals),
      currency: cur.code,
      description: body.description,
      successUrl: body.successUrl,
      cancelUrl: body.cancelUrl,
      expiresInMinutes: body.expiresInMinutes ?? 24 * 60,
      metadata: { ...(body.metadata ?? {}), customerEmail: body.customerEmail ?? null },
      allowedMethods: body.allowedMethods,
    });
    const view = toPaymentRequest(row);
    res.status(201).json({ paymentRequest: view, checkoutUrl: view.link, qrImage: await qrDataUrl(view.link!) });
  }),
);
v1Router.get('/payment-requests', (req, res) => {
  const { page, pageSize } = parsePagination(req.query);
  res.json({ ...listPaymentRequests(req.user!.id, { role: 'requester', status: req.query.status ? String(req.query.status) : undefined, page, pageSize }), page, pageSize });
});
v1Router.get('/payment-requests/:code', (req, res) => {
  const row = getPaymentRequestByCode(String(req.params.code));
  if (row.requester_user_id !== req.user!.id) throw notFound('Payment request not found');
  const view = toPaymentRequest(row);
  const tx = row.paid_transaction_id ? getTransaction(row.paid_transaction_id) : null;
  res.json({ paymentRequest: view, transaction: tx ? toTransaction(tx) : null });
});
v1Router.post('/payment-requests/:code/cancel', (req, res) => res.json({ paymentRequest: toPaymentRequest(cancelPaymentRequest(req.user!, String(String(req.params.code)))) }));
v1Router.get('/transactions', (req, res) => {
  const { page, pageSize } = parsePagination(req.query);
  res.json({ ...listTransactions({ userId: req.user!.id, direction: 'in', page, pageSize, status: req.query.status ? String(req.query.status) : undefined }), page, pageSize });
});
v1Router.get('/transactions/:id', (req, res) => {
  const tx = getTransaction(String(req.params.id));
  if (!tx || (tx.receiver_user_id !== req.user!.id && tx.sender_user_id !== req.user!.id)) throw notFound('Transaction not found');
  res.json({ transaction: toTransaction(tx, req.user!.id) });
});
v1Router.get(
  '/payments/:id',
  wrap(async (req, res) => {
    const p = getPayment(String(req.params.id));
    const pr = p.payment_request_id ? getPaymentRequestByCode(p.payment_request_id) : null;
    if (!pr || pr.requester_user_id !== req.user!.id) throw notFound('Payment not found');
    res.json({ payment: await verifyPayment(p.id) });
  }),
);
export { toPaymentView };
