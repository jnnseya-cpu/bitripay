/**
 * National Switch Gateway — merchant API (§11). Mounted at /api/v1 and /v1 next to the gateway router.
 * Tenant and merchant come from the credential, never from the body; routing fields in the body are rejected
 * (RTE-002); errors use the business codes of §11.3.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { requireAuth, requireRole, requireScope } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { assertPin } from '../services/auth';
import { merchantAggregationFees, payInvoiceFromWallet } from '../services/switch/fees';
import { AppError, forbidden } from '../lib/errors';
import {
  createPayment,
  getPayment,
  listPayments,
  cancelPayment,
  attachConsent,
  createLinkedRefund,
  listLinkedOperations,
  refundable,
  createBinding,
  listBindings,
  getBinding,
  recordConsent,
  paymentTimeline,
} from '../services/switch/payments';
import { listParticipants, listPairs } from '../services/switch/participants';
import { connectionForCountry } from '../services/switch/connections';
import { listCases } from '../services/switch/reconciliation';
import { createEndpoint } from '../services/webhooks';
import { createIntent, intentView, getIntentRow } from '../services/intents';
import { createDynamicQr } from '../services/qrcodes';
import { PURPOSE_CODES } from '../services/capabilities';
import { MERCHANT_ROLES } from '../services/users';

export const switchRouter = Router();
const merchantOnly = [requireAuth, requireRole(...MERCHANT_ROLES, 'admin')];
const writeLimit = rateLimit({ windowMs: 60_000, max: 240, keyPrefix: 'sw' });

const amountSchema = z.object({ currency: z.string().length(3), value_minor: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]) });
const createSchema = z
  .object({
    merchant_id: z.string().optional(),
    merchant_order_id: z.string().min(1).max(64),
    product: z.string().min(1).max(40),
    amount: amountSchema,
    payer: z.object({ participant_id: z.string().min(1), account_token: z.string().max(200).optional().nullable() }),
    beneficiary_binding_id: z.string().min(1),
    consent_reference: z.string().max(120).optional().nullable(),
    expires_at: z.string().datetime({ offset: true }).optional().nullable(),
    description: z.string().max(200).optional().nullable(),
    channel: z.enum(['api', 'qr', 'ussd']).optional(),
    /** An existing intent of this merchant (a QR intent, a POS sale) that this switch payment settles. */
    intent_id: z.string().max(80).optional().nullable(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const actor = (req: Request) => ({ type: req.user!.role === 'admin' ? ('admin' as const) : ('merchant' as const), id: req.user!.id });

switchRouter.post('/payments', ...merchantOnly, requireScope('payments:create'), writeLimit, (req, res) => {
  const body = validate(createSchema, req.body);
  if (body.merchant_id && body.merchant_id !== req.user!.id) throw new AppError(403, 'SCOPE_DENIED', 'merchant_id must be your own merchant identity (tenant is derived from the credential)');
  const r = createPayment(req.user!, req.apiKeyId ?? null, body as any, (req.headers['idempotency-key'] as string | undefined) ?? null);
  res.status(r.created ? 201 : 200).json(r.payment);
});
switchRouter.get('/payments', ...merchantOnly, requireScope('payments:read'), (req, res) =>
  res.json({ data: listPayments({ merchantUserId: req.user!.id, status: req.query.status ? String(req.query.status) : null, limit: Number(req.query.limit) || 50 }) }),
);
switchRouter.get('/payments/:id', ...merchantOnly, requireScope('payments:read'), (req, res) => res.json(getPayment(req.user!.id, String(req.params.id))));
switchRouter.get('/payments/:id/timeline', ...merchantOnly, requireScope('payments:read'), (req, res) => {
  getPayment(req.user!.id, String(req.params.id));
  const t = paymentTimeline(String(req.params.id));
  // merchants see the business timeline, never raw proofs or participant identifiers beyond their own view
  res.json({
    payment: t.payment,
    events: t.events.map((e) => ({ seq: e.seq, type: e.type, source: e.source, from: e.from, to: e.to, occurredAt: e.occurredAt, receivedAt: e.receivedAt })),
    journal: t.journal.map((j) => ({ fact: j.fact, amountMinor: j.amountMinor, currency: j.currency, occurredAt: j.occurredAt })),
    linkedOperations: t.linkedOperations,
    webhooks: t.webhooks,
  });
});
switchRouter.post('/payments/:id/cancel', ...merchantOnly, requireScope('payments:cancel'), writeLimit, (req, res) =>
  res.json(cancelPayment(req.user!, String(req.params.id), actor(req), req.body?.reason ? String(req.body.reason) : null)),
);
switchRouter.post('/payments/:id/consent', ...merchantOnly, requireScope('payments:create'), writeLimit, (req, res) => {
  const body = validate(z.object({ consent_reference: z.string().min(1).max(120) }), req.body);
  res.json(attachConsent(req.user!, String(req.params.id), body.consent_reference));
});
switchRouter.post('/payments/:id/refunds', ...merchantOnly, requireScope('refunds:create'), writeLimit, (req, res) => {
  const body = validate(
    z.object({
      amount_minor: z
        .union([z.string().regex(/^\d+$/), z.number().int().positive()])
        .optional()
        .nullable(),
      reason: z.string().min(1).max(200),
    }),
    req.body,
  );
  res
    .status(201)
    .json(
      createLinkedRefund(
        req.user!,
        String(req.params.id),
        { amountMinor: body.amount_minor != null ? Number(body.amount_minor) : null, reason: body.reason, idemKey: (req.headers['idempotency-key'] as string | undefined) ?? null },
        actor(req),
      ),
    );
});
switchRouter.get('/payments/:id/refunds', ...merchantOnly, requireScope('refunds:create', 'payments:read'), (req, res) => {
  getPayment(req.user!.id, String(req.params.id));
  res.json({ data: listLinkedOperations(String(req.params.id)), ...refundable(String(req.params.id)) });
});

/** Capabilities actually usable by this tenant: active participants of the merchant's country with their open pairs. */
/** Aggregation fees: what the merchant owes on switch payments, invoices per period, and paying an invoice from the wallet. */
switchRouter.get('/fees/aggregation', ...merchantOnly, requireScope('payments:read'), (req, res) => res.json(merchantAggregationFees(req.user!.id)));
switchRouter.post(
  '/fees/invoices/:id/pay',
  ...merchantOnly,
  requireScope('payments:create'),
  writeLimit,
  wrap(async (req, res) => {
    const body = validate(z.object({ pin: z.string().optional() }), req.body ?? {});
    assertPin(req.user!, body.pin, req);
    res.json({ invoice: payInvoiceFromWallet(req.user!, String(req.params.id)) });
  }),
);
switchRouter.get('/participants', ...merchantOnly, requireScope('participants:read'), (req, res) => {
  const country = (req.user!.country ?? 'CD').toUpperCase();
  const conn = connectionForCountry(country);
  const pairs = conn ? listPairs(conn.id).filter((p) => p.status === 'OPEN') : [];
  const data = listParticipants({ country, status: 'ACTIVE' }).map((p) => ({
    participant_id: p.id,
    name: p.name,
    kind: p.kind,
    currencies: p.currencies,
    services: p.services,
    channels: p.channels,
    valid_from: p.validFrom,
    valid_to: p.validTo,
    source: p.source,
    open_pairs: pairs.filter((x) => x.debtorId === p.id).map((x) => ({ creditor_id: x.creditorId, currency: x.currency, product: x.product, channel: x.channel })),
  }));
  res.json({
    data,
    connection: conn ? { id: conn.id, scheme_id: conn.schemeId, access_mode: conn.accessMode, environment: conn.environment, simulation: conn.simulation, link_state: conn.linkState } : null,
  });
});

/** §11 `POST /v1/qr-intents`: an intent with a fixed amount and a signed dynamic QR, or an accepted static profile. */
switchRouter.post('/qr-intents', ...merchantOnly, requireScope('qr:create', 'payment_intents:write'), writeLimit, (req, res) => {
  const b = validate(
    z.object({
      amount: amountSchema,
      reference: z.string().max(64).optional().nullable(),
      description: z.string().max(200).optional().nullable(),
      purpose_code: z.enum(PURPOSE_CODES).optional().nullable(),
      ttl_seconds: z.number().int().min(30).max(300).optional(),
      location_id: z.string().optional().nullable(),
      terminal_id: z.string().optional().nullable(),
    }),
    req.body,
  );
  const { row, clientSecret } = createIntent(req.user!, {
    amountMinor: Number(b.amount.value_minor),
    currency: b.amount.currency,
    reference: b.reference ?? null,
    description: b.description ?? null,
    purposeCode: b.purpose_code ?? null,
    source: 'qr',
    locationId: b.location_id ?? null,
    terminalId: b.terminal_id ?? null,
    idemKey: (req.headers['idempotency-key'] as string | undefined) ?? null,
    expiresInMinutes: Math.max(1, Math.ceil((b.ttl_seconds ?? 300) / 60)),
  });
  const qr = createDynamicQr(req.user!, row, b.ttl_seconds ?? 300);
  const view = intentView(getIntentRow(row.id));
  res.status(201).json({
    intent_id: view.id,
    status: view.status,
    amount: { currency: view.amount.currency, value_minor: String(view.amount.valueMinor) },
    qr: { id: qr.id, payload: qr.payload, uri: qr.uri, expires_at: qr.expiresAt, signed: qr.signed, key_id: qr.keyId },
    checkout_url: view.checkoutUrl,
    client_secret: clientSecret,
    expires_at: view.expiresAt,
  });
});

/** §11 `POST /v1/webhook-endpoints` (hyphenated alias of the gateway endpoint object). */
switchRouter.post(
  '/webhook-endpoints',
  ...merchantOnly,
  requireScope('webhooks:manage'),
  writeLimit,
  wrap(async (req, res) => {
    const b = validate(z.object({ url: z.string().url(), events: z.array(z.string().max(60)).max(50).optional(), description: z.string().max(200).optional().nullable() }), req.body);
    res.status(201).json(await createEndpoint(req.user!.id, { url: b.url, events: b.events, description: b.description ?? null }));
  }),
);

switchRouter.get('/reconciliation/cases', ...merchantOnly, requireScope('reconciliation:read'), (req, res) => {
  const r = listCases({
    merchantUserId: req.user!.id,
    status: req.query.status ? String(req.query.status) : null,
    class: req.query.class ? String(req.query.class) : null,
    limit: Number(req.query.limit) || 50,
    cursor: req.query.cursor ? String(req.query.cursor) : null,
  });
  res.json({
    data: r.data.map((c) => ({
      case_id: c.id,
      class: c.class,
      payment_id: c.paymentId,
      status: c.status,
      priority: c.priority,
      exposure: { currency: c.exposure.currency, value_minor: String(c.exposure.valueMinor) },
      age_hours: c.ageHours,
      next_action: c.nextAction,
      due_at: c.dueAt,
      opened_at: c.createdAt,
      updated_at: c.updatedAt,
    })),
    next_cursor: r.nextCursor,
  });
});

// Beneficiary bindings (CMP-02): requested by the merchant, verified and activated by operations under dual approval.
const bindingSchema = z.object({
  participant_id: z.string().min(1),
  account_token: z.string().min(4).max(200),
  account_name: z.string().min(2).max(120),
  replaces_id: z.string().optional().nullable(),
});
for (const path of ['/beneficiary_bindings', '/beneficiary-bindings']) {
  switchRouter.post(path, ...merchantOnly, requireScope('bindings:manage'), writeLimit, (req, res) => {
    const b = validate(bindingSchema, req.body);
    res.status(201).json(createBinding(req.user!, { participantId: b.participant_id, accountToken: b.account_token, accountName: b.account_name, replacesId: b.replaces_id ?? null }));
  });
  switchRouter.get(path, ...merchantOnly, requireScope('bindings:manage', 'payments:read'), (req, res) => res.json({ data: listBindings(req.user!.id) }));
  switchRouter.get(`${path}/:id`, ...merchantOnly, requireScope('bindings:manage', 'payments:read'), (req, res) => res.json(getBinding(req.user!.id, String(req.params.id))));
}

/**
 * Consent evidence. In production it is produced by the payer's institution through the certified channel; while a
 * country runs on the simulator, the merchant (or an administrator) can record the simulated institution's proof.
 */
switchRouter.post('/consents', ...merchantOnly, writeLimit, (req, res) => {
  const b = validate(
    z.object({
      participant_id: z.string().min(1),
      beneficiary_binding_id: z.string().optional().nullable(),
      amount: amountSchema,
      account_token: z.string().max(200).optional().nullable(),
      ttl_seconds: z.number().int().min(30).max(3600).optional(),
      proof: z.string().min(1).max(4000),
    }),
    req.body,
  );
  const conn = connectionForCountry(req.user!.country ?? 'CD');
  if (!conn?.simulation && req.user!.role !== 'admin') throw forbidden('Consent evidence comes from the payer institution through the certified channel', 'SCOPE_DENIED');
  res.status(201).json(
    recordConsent({
      participantId: b.participant_id,
      audience: 'bitripay',
      merchantUserId: req.user!.id,
      bindingId: b.beneficiary_binding_id ?? null,
      amountMinor: Number(b.amount.value_minor),
      currency: b.amount.currency,
      accountToken: b.account_token ?? null,
      ttlSeconds: b.ttl_seconds,
      proof: b.proof,
    }),
  );
});

// 429s carry Retry-After (§11.3)
switchRouter.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (err?.status === 429) res.setHeader('Retry-After', '60');
  next(err);
});
