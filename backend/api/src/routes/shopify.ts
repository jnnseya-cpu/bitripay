/**
 * Shopify via link redirect. A Shopify store (a Shopify app, a Shopify Function or a manual payment method that links
 * to the store's own server) calls `POST /api/shopify/start` with its merchant API key and the order; BitriPay creates
 * a payment intent + hosted checkout session through the gateway services (the same objects as
 * `POST /v1/checkout_sessions`) tagged with `metadata.shopify = { shop, orderId }`, and answers with the hosted
 * checkout URL to send the shopper to. When the shopper finishes, the hosted checkout sends them to
 * `GET /api/shopify/return`, which redirects (302) back to the store's `return_url` with
 * `?bitripay_status=paid|pending|failed&session=cs_…&order_id=…`. The store confirms the order from the status
 * (and, for anything that matters, from the `checkout.session.completed` webhook or `GET /v1/checkout_sessions/:id`).
 */
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { getDb } from '../db';
import { shortCode } from '../lib/ids';
import { validate } from '../lib/http';
import { badRequest, notFound } from '../lib/errors';
import { requireAuth, requireRole, requireScope } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { createCheckoutSession, getCheckoutSession, type CheckoutSessionView } from '../services/gateway';
import { MERCHANT_ROLES } from '../services/users';

export const shopifyRouter = Router();
const startLimit = rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'shopify_start' });
const returnLimit = rateLimit({ windowMs: 60_000, max: 600, keyPrefix: 'shopify_return' });

export interface ShopifyMetadata {
  shop: string;
  orderId: string;
  orderName: string | null;
  /** Opaque reference the hosted checkout carries back to `/api/shopify/return` (the session id is not known before creation). */
  ref: string;
  returnUrl: string;
}

const startSchema = z.object({
  /** The store's domain, e.g. `kiosk-deux.myshopify.com` (or its custom domain). */
  shop: z
    .string()
    .min(3)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i, 'shop must be a domain name such as store.myshopify.com'),
  order_id: z.union([z.string().min(1).max(64), z.number().int().positive()]).transform((v) => String(v)),
  /** Shopify's display name for the order (`#1001`), shown on the checkout. */
  order_name: z.string().max(40).optional().nullable(),
  amount_minor: z.number().int().positive(),
  currency: z.string().length(3),
  /** Where the shopper lands after checkout; BitriPay appends `bitripay_status`, `session` and `order_id`. */
  return_url: z.string().url(),
  description: z.string().max(200).optional().nullable(),
  customer: z
    .object({ email: z.string().email().optional().nullable(), phone: z.string().max(20).optional().nullable(), name: z.string().max(120).optional().nullable() })
    .optional()
    .nullable(),
  expires_in_minutes: z.number().int().min(5).max(1440).optional().nullable(),
  allowed_methods: z.array(z.string()).optional(),
});

/** The checkout page sends the shopper back here; `bitripay_status` tells the store whether to mark the order paid. */
export function shopifyStatus(session: CheckoutSessionView): 'paid' | 'pending' | 'failed' {
  if (session.status === 'complete') return 'paid';
  if (session.status === 'expired') return 'failed';
  return ['FAILED', 'CANCELLED', 'EXPIRED', 'REVERSED'].includes(session.paymentIntent.status) ? 'failed' : 'pending';
}

function shopifyMeta(session: CheckoutSessionView): ShopifyMetadata | null {
  const m = (session.paymentIntent.metadata as { shopify?: Partial<ShopifyMetadata> } | undefined)?.shopify;
  if (!m || typeof m.returnUrl !== 'string' || typeof m.shop !== 'string') return null;
  return { shop: m.shop, orderId: String(m.orderId ?? ''), orderName: m.orderName ?? null, ref: String(m.ref ?? ''), returnUrl: m.returnUrl };
}

/** The session behind a return reference: the intent carries `metadata.shopify.ref`, which SQLite can index into. */
function sessionByRef(ref: string): CheckoutSessionView {
  const row = getDb()
    .prepare("SELECT cs.id FROM checkout_sessions cs JOIN payment_intents pi ON pi.id = cs.intent_id WHERE json_extract(pi.metadata, '$.shopify.ref') = ? ORDER BY cs.created_at DESC LIMIT 1")
    .get(ref) as { id: string } | undefined;
  if (!row) throw notFound('Shopify checkout not found', 'shopify_checkout_not_found');
  return getCheckoutSession(null, row.id);
}

export function shopifyRedirectUrl(session: CheckoutSessionView, meta: ShopifyMetadata): string {
  const target = new URL(meta.returnUrl);
  target.searchParams.set('bitripay_status', shopifyStatus(session));
  target.searchParams.set('session', session.id);
  if (meta.orderId) target.searchParams.set('order_id', meta.orderId);
  return target.toString();
}

/**
 * Start a Shopify checkout. Authentication is the merchant API key (`sk_…`, or `rk_…` with `checkout_sessions:write`;
 * a publishable `pk_…` key cannot create sessions) or a merchant session. Returns `{ redirect_url, session }`.
 */
shopifyRouter.post('/start', startLimit, requireAuth, requireRole(...MERCHANT_ROLES, 'admin'), requireScope('checkout_sessions:write'), (req, res) => {
  const b = validate(startSchema, req.body);
  if (!/^https?:\/\//.test(b.return_url)) throw badRequest('return_url must be an absolute http(s) URL', 'invalid_url');
  const ref = `shp_${shortCode(16).toLowerCase()}`;
  const returnBase = `${config.apiUrl}/api/shopify/return?ref=${ref}`;
  const shop = b.shop.toLowerCase();
  const shopify: ShopifyMetadata = { shop, orderId: b.order_id, orderName: b.order_name ?? null, ref, returnUrl: b.return_url };
  const session = createCheckoutSession(req.user!, {
    amountMinor: b.amount_minor,
    currency: b.currency.toUpperCase(),
    successUrl: returnBase,
    cancelUrl: `${returnBase}&cancelled=1`,
    customer: b.customer ?? null,
    reference: `shopify:${b.order_id}`.slice(0, 64),
    description: b.description ?? `Shopify order ${b.order_name ?? b.order_id} · ${shop}`,
    metadata: { shopify },
    expiresInMinutes: b.expires_in_minutes ?? null,
    allowedMethods: b.allowed_methods,
    idemKey: (req.headers['idempotency-key'] as string | undefined) ?? null,
  });
  res.status(201).json({ redirect_url: session.url, return_url: returnBase, session });
});

/** Where the hosted checkout sends the shopper afterwards: 302 to the store with the outcome in the query string. */
shopifyRouter.get('/return', returnLimit, (req, res) => {
  const sessionId = req.query.session ? String(req.query.session) : '';
  const ref = req.query.ref ? String(req.query.ref) : '';
  if (!sessionId && !ref) throw badRequest('session or ref is required', 'shopify_reference_required');
  const session = sessionId ? getCheckoutSession(null, sessionId) : sessionByRef(ref);
  const meta = shopifyMeta(session);
  if (!meta) throw notFound('This checkout session did not start from Shopify', 'shopify_checkout_not_found');
  res.redirect(302, shopifyRedirectUrl(session, meta));
});

/** JSON view of the outcome for stores that poll from their server instead of trusting the redirect. */
shopifyRouter.get('/status', returnLimit, requireAuth, requireRole(...MERCHANT_ROLES, 'admin'), requireScope('checkout_sessions:write', 'payment_intents:read'), (req, res) => {
  const sessionId = req.query.session ? String(req.query.session) : '';
  if (!sessionId) throw badRequest('session is required', 'shopify_reference_required');
  const session = getCheckoutSession(req.user!.id, sessionId);
  const meta = shopifyMeta(session);
  if (!meta) throw notFound('This checkout session did not start from Shopify', 'shopify_checkout_not_found');
  res.json({ bitripay_status: shopifyStatus(session), session_id: session.id, order_id: meta.orderId, shop: meta.shop, session });
});
