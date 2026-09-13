/**
 * Gateway API v1 — account and money endpoints from the operating-system contract (§14): wallets, transfer quotes
 * ranked by the smart router, wallet transfers, remittances, bulk payout batches and metered agent calls. Every route
 * accepts an API key with the matching scope or a merchant session; money-moving POSTs honour Idempotency-Key.
 */
import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { requireAuth, requireRole, requireScope } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { badRequest, notFound } from '../lib/errors';
import { getCurrency } from '../services/currencies';
import { listWallets, toWallet } from '../services/wallets';
import { availableBalance, heldByKind } from '../services/finops/holds';
import {
  quoteRoute,
  createRoute,
  listRoutes,
  refreshRoute,
  cancelRoute,
  routeReceipt,
  payoutCurrencyOptions,
  defaultTargetCurrency,
  previewDestination,
  type RouteDestination,
  type RouteSource,
} from '../services/routing';
import { listRails, scoreConnectors, type RoutePolicy } from '../services/rails';
import { sendMoney } from '../services/transfers';
import { toTransaction, getTransaction } from '../services/ledger';
import { usersById } from '../services/users';
import { assertPin } from '../services/auth';
import { riskContext } from '../services/risk';
import { sendRemittance, listRemittances, getRemittance, quoteRemittance } from '../services/remittance';
import { createBatch, approveBatch, cancelBatch, getBatch, listBatches, batchReadiness, CSV_COLUMNS, MAX_BATCH_ROWS } from '../services/bulkPayouts';
import { startRun, getRun, publicRunView } from '../services/assist/runtime';
import { agentForAlias } from '../services/assist/registry';
import { getDb } from '../db';
import { createPlan, listPlans, getPlan, archivePlan, listSubscriptions, getSubscription, recordUsage, cancelSubscription, listInvoices, billingOverview } from '../services/billing';
import { readinessForLender } from '../services/creditReadiness';

export const v1ExtRouter = Router();
const merchantOnly = [requireAuth, requireRole('merchant', 'admin')];
const writeLimit = rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'v1x' });
const idem = (req: { headers: Record<string, unknown> }) => (req.headers['idempotency-key'] as string | undefined) ?? null;
const actorOf = (req: any) => ({ type: req.user!.role === 'admin' ? 'admin' : 'merchant', id: req.user!.id }) as const;

// ---------------------------------------------------------------- wallets
v1ExtRouter.get('/wallets', requireAuth, requireScope('wallets:read', 'balance:read'), (req, res) => {
  const data = listWallets(req.user!.id).map((w) => {
    const v = toWallet(w, req.user);
    const held = heldByKind(w.id);
    const heldTotal = Object.values(held).reduce((a, b) => a + b, 0);
    return {
      id: v.id,
      currency: v.currency,
      balance_minor: v.balance,
      available_minor: availableBalance(w),
      held_minor: heldTotal,
      held_by_kind: held,
      promo_minor: v.promoBalance ?? 0,
      frozen: v.frozen,
      created_at: v.createdAt,
    };
  });
  res.json({ data });
});

// ---------------------------------------------------------------- transfers
const destinationSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('wallet'), to: z.string().min(2).max(80) }),
  z.object({ method: z.literal('qr'), data: z.string().min(3).max(2000) }),
  z.object({ method: z.literal('mobile_money'), operator_id: z.string(), phone: z.string().min(6).max(20), name: z.string().max(120).optional().nullable() }),
  z.object({
    method: z.literal('bank'),
    bank_account_id: z.string().optional().nullable(),
    bank_name: z.string().optional().nullable(),
    account_name: z.string().optional().nullable(),
    account_number: z.string().optional().nullable(),
    country: z.string().length(2).optional().nullable(),
    swift: z.string().optional().nullable(),
    currency: z.string().length(3).optional().nullable(),
  }),
  z.object({ method: z.literal('agent'), agent: z.string().min(2) }),
  z.object({ method: z.literal('keep') }),
]);
function toDest(d: z.output<typeof destinationSchema>): RouteDestination {
  if (d.method === 'wallet') return { method: 'wallet', to: d.to };
  if (d.method === 'qr') return { method: 'qr', data: d.data };
  if (d.method === 'agent') return { method: 'agent', agent: d.agent };
  if (d.method === 'keep') return { method: 'keep' };
  if (d.method === 'mobile_money') return { method: 'mobile_money', operatorId: d.operator_id, phone: d.phone, name: d.name ?? null } as RouteDestination;
  if (d.bank_account_id) return { method: 'bank', bankAccountId: d.bank_account_id } as RouteDestination;
  return {
    method: 'bank',
    bankName: d.bank_name ?? '',
    accountName: d.account_name ?? '',
    accountNumber: d.account_number ?? '',
    country: d.country ?? null,
    currency: d.currency ?? null,
  } as RouteDestination;
}
/** Funding leg of a cross-border route: the account's wallet, or a card / mobile money / bank payment through a processor. */
const cardSchema = z.object({
  number: z.string().min(12).max(23),
  exp_month: z.coerce.number().int().min(1).max(12),
  exp_year: z.coerce.number().int().min(0).max(2100),
  cvc: z.string().min(3).max(4),
  holder_name: z.string().min(2).max(120),
});
const sourceSchema = z.object({
  method: z.enum(['wallet', 'card', 'bank', 'mobile_money']),
  gateway: z.string().optional().nullable(),
  operator_id: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  card: cardSchema.optional(),
  saved_card_id: z.string().optional().nullable(),
  return_url: z.string().url().optional().nullable(),
});
function toSource(s: z.output<typeof sourceSchema>): RouteSource {
  return {
    method: s.method,
    gateway: s.gateway ?? null,
    operatorId: s.operator_id ?? null,
    phone: s.phone ?? null,
    card: s.card ? { number: s.card.number, expMonth: s.card.exp_month, expYear: s.card.exp_year, cvc: s.card.cvc, holderName: s.card.holder_name } : undefined,
    savedCardId: s.saved_card_id ?? null,
    returnUrl: s.return_url ?? null,
  };
}
const routeAuth = (req: any) => (req.authVia === 'api_key' ? { apiKeyId: req.apiKeyId ?? 'key', req } : { pin: req.body?.pin ?? null, req });
/** RouteOptimiser: the disclosed quote plus every usable rail ranked by the smart router for the requested policy. */
v1ExtRouter.post('/transfers/quote', requireAuth, requireScope('transfers:write', 'transfers:read'), (req, res) => {
  const b = validate(
    z.object({
      amount_minor: z.number().int().positive(),
      currency: z.string().length(3),
      target_currency: z.string().length(3).optional().nullable(),
      destination: destinationSchema.optional(),
      source_method: z.enum(['wallet', 'card', 'mobile_money', 'bank']).optional(),
      policy: z.enum(['smart', 'cheapest', 'fastest', 'most_reliable']).optional(),
      country: z.string().length(2).optional().nullable(),
    }),
    req.body,
  );
  const cur = getCurrency(b.currency);
  const target = getCurrency(b.target_currency ?? cur.code);
  const dest = b.destination ? toDest(b.destination) : undefined;
  const quote = quoteRoute(b.amount_minor, cur.code, target.code, b.source_method ?? 'wallet', dest, {
    userId: req.user!.id,
    country: b.country ?? req.user!.country ?? null,
    operatorId: b.destination?.method === 'mobile_money' ? b.destination.operator_id : null,
    persistQuote: true,
  });
  const method = dest?.method === 'mobile_money' ? 'mobile_money' : dest?.method === 'bank' ? 'bank' : 'wallet';
  const rails = method === 'wallet' ? [] : listRails({ method, currency: target.code, country: b.country ?? null }).filter((r) => r.enabled);
  const ranked = scoreConnectors(
    rails.map((r, i) => ({ id: r.id, method, costBps: r.costBps, preferenceRank: i })),
    (b.policy ?? 'smart') as RoutePolicy,
  ).map((s) => {
    const r = rails.find((x) => x.id === s.id)!;
    return {
      rail_id: s.id,
      name: r.name,
      provider: r.provider,
      score: s.score,
      usable: s.usable,
      reason: s.reason,
      cost_bps: r.costBps,
      estimated_minutes: quote.estimatedDeliveryMinutes,
      components: s.components,
    };
  });
  res.json({ quote, routes: ranked, policy: b.policy ?? 'smart' });
});
v1ExtRouter.post(
  '/transfers',
  requireAuth,
  requireScope('transfers:write'),
  writeLimit,
  wrap(async (req, res) => {
    const b = validate(
      z.object({
        to: z.string().min(2).max(80),
        amount_minor: z.number().int().positive(),
        currency: z.string().length(3),
        note: z.string().max(200).optional().nullable(),
        pin: z.string().optional(),
      }),
      req.body,
    );
    if (req.authVia !== 'api_key') assertPin(req.user!, b.pin, req);
    const cur = getCurrency(b.currency);
    const key = idem(req);
    const tx = sendMoney(req.user!, {
      to: b.to,
      amount: b.amount_minor,
      currency: cur.code,
      note: b.note ?? null,
      idempotencyKey: key ? `v1:${key}` : null,
      ...riskContext(req),
      stepUpVerified: req.authVia === 'api_key' ? true : riskContext(req).stepUpVerified,
    });
    res.status(201).json({ transfer: toTransaction(tx, req.user!.id, usersById([tx.receiver_user_id!])) });
  }),
);
v1ExtRouter.get('/transfers/:id', requireAuth, requireScope('transfers:read', 'transfers:write'), (req, res) => {
  const tx = getTransaction(String(req.params.id));
  if (!tx || (tx.sender_user_id !== req.user!.id && tx.receiver_user_id !== req.user!.id)) throw notFound('Transfer not found', 'transfer_not_found');
  res.json({ transfer: toTransaction(tx, req.user!.id) });
});

// ---------------------------------------------------------------- cross-border routes: any source → any destination, any recipient currency
/**
 * A route is one money movement with two legs: funding (wallet, or any card / bank / mobile money through a licensed
 * processor) and delivery (a BitriPay wallet, a QR code, a bank account or a mobile money number anywhere, an agent,
 * or the account's own wallet in another currency). The recipient receives in the currency chosen at quote time —
 * the disclosed rate, margin and every fee are fixed on the quote — and the route reports every stage from quote to
 * settlement. This is the partner-API form of Move money and Remittance in the apps.
 */
v1ExtRouter.post('/routes/quote', requireAuth, requireScope('routes:write', 'routes:read'), (req, res) => {
  const b = validate(
    z.object({
      amount_minor: z.number().int().positive(),
      currency: z.string().length(3),
      target_currency: z.string().length(3).optional().nullable(),
      source: sourceSchema.optional(),
      destination: destinationSchema,
    }),
    req.body,
  );
  const cur = getCurrency(b.currency);
  const dest = toDest(b.destination);
  const target = getCurrency((b.target_currency ?? defaultTargetCurrency(dest, cur.code)).toUpperCase());
  const quote = quoteRoute(b.amount_minor, cur.code, target.code, b.source?.method ?? 'wallet', dest, {
    userId: req.user!.id,
    country: req.user!.country ?? null,
    operatorId: b.source?.operator_id ?? null,
    gateway: b.source?.gateway ?? null,
    persistQuote: true,
  } as any);
  res.json({ destination: previewDestination(dest), quote, receiving_currencies: quote.receivingCurrencies, declaration: (quote as any).declaration ?? null, fx: (quote as any).fx ?? null });
});
v1ExtRouter.post('/routes/payout-currencies', requireAuth, requireScope('routes:write', 'routes:read'), (req, res) => {
  const b = validate(
    z.object({ amount_minor: z.number().int().positive(), currency: z.string().length(3), destination: destinationSchema, requested: z.string().length(3).optional().nullable() }),
    req.body,
  );
  res.json(payoutCurrencyOptions(toDest(b.destination), getCurrency(b.currency).code, b.amount_minor, { requested: b.requested ?? null }));
});
v1ExtRouter.post(
  '/routes',
  requireAuth,
  requireScope('routes:write'),
  writeLimit,
  wrap(async (req, res) => {
    const b = validate(
      z.object({
        amount_minor: z.number().int().positive(),
        currency: z.string().length(3),
        target_currency: z.string().length(3).optional().nullable(),
        source: sourceSchema.default({ method: 'wallet' }),
        destination: destinationSchema,
        note: z.string().max(200).optional().nullable(),
        quote_id: z.string().optional().nullable(),
        source_of_funds: z.string().max(120).optional().nullable(),
        pin: z.string().optional(),
      }),
      req.body,
    );
    if (b.source.method === 'wallet' && req.authVia !== 'api_key') assertPin(req.user!, b.pin, req);
    const cur = getCurrency(b.currency);
    const key = idem(req);
    if (key) {
      const existing = getDb().prepare("SELECT id FROM money_routes WHERE user_id = ? AND json_extract(source_details, '$.idempotencyKey') = ?").get(req.user!.id, key) as any;
      if (existing) return res.status(200).json({ route: await refreshRoute(req.user!.id, existing.id) });
    }
    const route = await createRoute(
      req.user!,
      {
        source: toSource(b.source),
        destination: toDest(b.destination),
        amount: b.amount_minor,
        currency: cur.code,
        targetCurrency: b.target_currency?.toUpperCase() ?? null,
        note: b.note ?? null,
        quoteId: b.quote_id ?? null,
        sourceOfFunds: b.source_of_funds ?? null,
      },
      routeAuth(req),
    );
    if (key) getDb().prepare("UPDATE money_routes SET source_details = json_set(source_details, '$.idempotencyKey', ?) WHERE id = ?").run(key, route.id);
    res.status(201).json({ route });
  }),
);
v1ExtRouter.get('/routes', requireAuth, requireScope('routes:read', 'routes:write'), (req, res) => res.json({ data: listRoutes(req.user!.id).slice(0, Number(req.query.limit) || 50) }));
v1ExtRouter.get(
  '/routes/:id',
  requireAuth,
  requireScope('routes:read', 'routes:write'),
  wrap(async (req, res) => res.json({ route: await refreshRoute(req.user!.id, String(req.params.id)) })),
);
v1ExtRouter.get('/routes/:id/receipt', requireAuth, requireScope('routes:read', 'routes:write'), (req, res) => res.json(routeReceipt(req.user!.id, String(req.params.id))));
v1ExtRouter.post(
  '/routes/:id/cancel',
  requireAuth,
  requireScope('routes:write'),
  writeLimit,
  wrap(async (req, res) => {
    const b = validate(z.object({ reason: z.string().max(200).optional().nullable(), pin: z.string().optional() }), req.body ?? {});
    if (req.authVia !== 'api_key') assertPin(req.user!, b.pin, req);
    res.json({ route: await cancelRoute(req.user!, String(req.params.id), b.reason ?? undefined) });
  }),
);

// ---------------------------------------------------------------- remittances
const recipientSchema = z.object({
  name: z.string().min(2).max(120),
  country: z.string().length(2).optional().nullable(),
  phone: z.string().max(20).optional().nullable(),
  email: z.string().email().optional().nullable(),
  tag: z.string().max(30).optional().nullable(),
  bank_name: z.string().max(120).optional().nullable(),
  account_number: z.string().max(40).optional().nullable(),
  swift: z.string().max(20).optional().nullable(),
  address: z.string().max(200).optional().nullable(),
  id_number: z.string().max(40).optional().nullable(),
});
v1ExtRouter.get('/remittances/quote', requireAuth, requireScope('remittances:write', 'remittances:read'), (req, res) => {
  const from = getCurrency(String(req.query.currency || 'USD'));
  res.json(quoteRemittance(Number(req.query.amount_minor) || 0, from.code, String(req.query.target_currency || from.code).toUpperCase()));
});
/**
 * Remittance: wallet-funded transfers to a wallet, bank account or cash pickup in the recipient's currency. With a
 * `source` other than the wallet (any card, bank or mobile money through a processor) and a `mobile_money` or
 * `bank` destination, the remittance runs as a cross-border route (see /routes) and the response carries the route.
 */
v1ExtRouter.post(
  '/remittances',
  requireAuth,
  requireScope('remittances:write'),
  writeLimit,
  wrap(async (req, res) => {
    const b = validate(
      z.object({
        amount_minor: z.number().int().positive(),
        currency: z.string().length(3),
        target_currency: z.string().length(3),
        payout_method: z.enum(['wallet', 'bank', 'cash_pickup', 'mobile_money']),
        recipient: recipientSchema.extend({ operator_id: z.string().optional().nullable(), bank_account_id: z.string().optional().nullable() }),
        source: sourceSchema.optional(),
        note: z.string().max(200).optional().nullable(),
        pin: z.string().optional(),
      }),
      req.body,
    );
    if (req.authVia !== 'api_key') assertPin(req.user!, b.pin, req);
    const key = idem(req);
    if ((b.source && b.source.method !== 'wallet') || b.payout_method === 'mobile_money') {
      const r = b.recipient;
      const dest: RouteDestination =
        b.payout_method === 'mobile_money'
          ? { method: 'mobile_money', operatorId: r.operator_id ?? '', phone: r.phone ?? '', name: r.name }
          : b.payout_method === 'bank'
            ? r.bank_account_id
              ? { method: 'bank', bankAccountId: r.bank_account_id }
              : { method: 'bank', bankName: r.bank_name ?? '', accountName: r.name, accountNumber: r.account_number ?? '', country: r.country ?? null, currency: b.target_currency.toUpperCase() }
            : b.payout_method === 'wallet'
              ? { method: 'wallet', to: r.tag ?? r.phone ?? r.email ?? '' }
              : { method: 'agent', agent: r.tag ?? '' };
      if (b.payout_method === 'cash_pickup') throw badRequest('Cash pickup is funded from the wallet; fund the wallet first or choose a bank or mobile money destination', 'cash_pickup_wallet_only');
      const route = await createRoute(
        req.user!,
        {
          source: toSource(b.source ?? { method: 'wallet' }),
          destination: dest,
          amount: b.amount_minor,
          currency: getCurrency(b.currency).code,
          targetCurrency: b.target_currency.toUpperCase(),
          note: b.note ?? null,
        },
        routeAuth(req),
      );
      return res.status(201).json({ remittance: null, route });
    }
    if (key) {
      const existing = getDb()
        .prepare('SELECT r.id FROM remittances r JOIN transactions t ON t.id = r.transaction_id WHERE t.sender_user_id = ? AND t.idempotency_key = ?')
        .get(req.user!.id, `v1rem:${key}`) as any;
      if (existing) return res.status(200).json({ remittance: getRemittance(existing.id) });
    }
    const from = getCurrency(b.currency);
    const r = b.recipient;
    const result = sendRemittance(req.user!, {
      amount: b.amount_minor,
      sourceCurrency: from.code,
      targetCurrency: b.target_currency.toUpperCase(),
      payoutMethod: b.payout_method,
      note: b.note ?? null,
      recipient: {
        name: r.name,
        country: r.country ?? null,
        phone: r.phone ?? null,
        email: r.email ?? null,
        tag: r.tag ?? null,
        bankName: r.bank_name ?? null,
        accountNumber: r.account_number ?? null,
        swift: r.swift ?? null,
        address: r.address ?? null,
        idNumber: r.id_number ?? null,
      },
    });
    if (key) getDb().prepare('UPDATE transactions SET idempotency_key = ? WHERE id = ?').run(`v1rem:${key}`, result.transaction.id);
    res.status(201).json({ remittance: result, transaction: toTransaction(result.transaction, req.user!.id) });
  }),
);
v1ExtRouter.get('/remittances', requireAuth, requireScope('remittances:read', 'remittances:write'), (req, res) => res.json({ data: listRemittances(req.user!.id) }));

// ---------------------------------------------------------------- bulk payouts (module 14)
const batchRowSchema = z.object({
  amount_minor: z.number().int().positive(),
  destination: destinationSchema,
  reference: z.string().max(80).optional().nullable(),
  name: z.string().max(120).optional().nullable(),
});
v1ExtRouter.get('/payouts/batches/columns', requireAuth, (_req, res) =>
  res.json({
    columns: CSV_COLUMNS,
    max_rows: MAX_BATCH_ROWS,
    example: 'method,amount,wallet,operator_id,phone,name,reference\nwallet,25.00,@amina,,,Amina K,SAL-0925\nmobile_money,40.00,,orange_cd,+243810000001,Jean M,SAL-0926',
  }),
);
v1ExtRouter.post('/payouts/batches', ...merchantOnly, requireScope('payouts:write'), writeLimit, (req, res) => {
  const b = validate(
    z.object({
      currency: z.string().length(3),
      rows: z.array(batchRowSchema).max(MAX_BATCH_ROWS).optional(),
      csv: z.string().max(2_000_000).optional().nullable(),
      reference: z.string().max(80).optional().nullable(),
      note: z.string().max(200).optional().nullable(),
      skip_invalid: z.boolean().optional(),
    }),
    req.body,
  );
  if (!b.rows?.length && !b.csv) throw badRequest('Provide rows or a csv', 'batch_empty');
  const batch = createBatch(
    req.user!,
    {
      currency: b.currency,
      rows: b.rows?.map((r) => ({ amountMinor: r.amount_minor, destination: toDest(r.destination) as any, reference: r.reference ?? null, name: r.name ?? null })),
      csv: b.csv ?? null,
      reference: b.reference ?? null,
      note: b.note ?? null,
      skipInvalid: b.skip_invalid ?? false,
      idemKey: idem(req),
      via: req.authVia === 'api_key' ? 'api_key' : 'session',
    },
    actorOf(req),
  );
  res.status(201).json({ batch, readiness: batchReadiness(req.user!, batch.id) });
});
v1ExtRouter.get('/payouts/batches', ...merchantOnly, requireScope('payouts:read', 'payouts:write'), (req, res) =>
  res.json({ data: listBatches(req.user!.id, { status: req.query.status ? String(req.query.status) : null, limit: Number(req.query.limit) || 50 }) }),
);
v1ExtRouter.get('/payouts/batches/:id', ...merchantOnly, requireScope('payouts:read', 'payouts:write'), (req, res) =>
  res.json({ batch: getBatch(req.user!.id, String(req.params.id)), readiness: batchReadiness(req.user!, String(req.params.id)) }),
);
/**
 * Approval and execution. Four-eyes: a different person (an administrator acting on the account) approves without
 * step-up; the creator approves with a PIN or passkey. An API key is the same person as the account and cannot pass
 * step-up, so a key never approves alone: it uploads, a person approves.
 */
v1ExtRouter.post('/payouts/batches/:id/approve', ...merchantOnly, requireScope('payouts:approve'), writeLimit, (req, res) => {
  const b = validate(z.object({ pin: z.string().optional() }), req.body ?? {});
  const ctx = riskContext(req);
  let stepUp = ctx.stepUpVerified && req.authVia !== 'api_key';
  if (!stepUp && b.pin && req.authVia !== 'api_key') {
    assertPin(req.user!, b.pin, req);
    stepUp = true;
  }
  const batch = approveBatch(req.user!, String(req.params.id), { stepUpVerified: stepUp, approverId: req.user!.id, deviceHash: ctx.deviceHash, ipCountry: ctx.ipCountry }, actorOf(req));
  res.json({ batch });
});
v1ExtRouter.post('/payouts/batches/:id/cancel', ...merchantOnly, requireScope('payouts:write'), writeLimit, (req, res) =>
  res.json({ batch: cancelBatch(req.user!, String(req.params.id), actorOf(req)) }),
);

// ---------------------------------------------------------------- agents (ACU-metered)
v1ExtRouter.post(
  '/ai/:agent',
  requireAuth,
  requireScope('ai:run'),
  rateLimit({ windowMs: 60_000, max: 30, keyPrefix: 'v1ai' }),
  wrap(async (req, res) => {
    const agent = agentForAlias(String(req.params.agent));
    if (!agent) throw notFound(`Unknown agent "${req.params.agent}"`, 'agent_not_found');
    const b = validate(
      z.object({
        input: z.string().min(1).max(4000),
        context: z.record(z.string(), z.unknown()).optional().nullable(),
        depth: z.enum(['standard', 'deep']).optional().nullable(),
        currency: z.string().length(3).optional().nullable(),
        wait: z.boolean().optional(),
      }),
      req.body,
    );
    const run = await startRun(req.user!, agent.key, b.input, { context: b.context ?? null, depth: b.depth ?? null, currency: b.currency ?? null, trigger: 'user', wait: b.wait !== false });
    res.status(b.wait === false ? 202 : 200).json({ run: publicRunView(run, req.user!.role), agent: { key: agent.key, name: agent.name, registry_id: agent.registryId ?? null } });
  }),
);
v1ExtRouter.get('/ai/runs/:id', requireAuth, requireScope('ai:run'), (req, res) => res.json({ run: publicRunView(getRun(String(req.params.id), req.user!.id), req.user!.role) }));

// ---------------------------------------------------------------- subscriptions and billing (module 16)
v1ExtRouter.get('/plans', ...merchantOnly, requireScope('subscriptions:read', 'subscriptions:write'), (req, res) => res.json({ data: listPlans(req.user!.id, req.query.include_archived === 'true') }));
v1ExtRouter.post('/plans', ...merchantOnly, requireScope('subscriptions:write'), writeLimit, (req, res) => {
  const b = validate(
    z.object({
      name: z.string().min(2).max(80),
      description: z.string().max(400).optional().nullable(),
      currency: z.string().length(3),
      amount_minor: z.number().int().min(0),
      interval: z.enum(['day', 'week', 'month', 'year']),
      interval_count: z.number().int().min(1).max(12).optional().nullable(),
      trial_days: z.number().int().min(0).max(365).optional().nullable(),
      tax_bps: z.number().int().min(0).max(5000).optional().nullable(),
      tax_label: z.string().max(40).optional().nullable(),
      usage_unit: z.string().max(40).optional().nullable(),
      usage_price_minor: z.number().int().min(0).optional().nullable(),
      code: z
        .string()
        .min(2)
        .max(40)
        .regex(/^[a-z0-9-]+$/)
        .optional()
        .nullable(),
    }),
    req.body,
  );
  res.status(201).json({
    plan: createPlan(req.user!, {
      name: b.name,
      description: b.description ?? null,
      currency: b.currency,
      amountMinor: b.amount_minor,
      interval: b.interval,
      intervalCount: b.interval_count ?? 1,
      trialDays: b.trial_days ?? 0,
      taxBps: b.tax_bps ?? 0,
      taxLabel: b.tax_label ?? null,
      usageUnit: b.usage_unit ?? null,
      usagePriceMinor: b.usage_price_minor ?? 0,
      code: b.code ?? null,
    }),
  });
});
v1ExtRouter.get('/plans/:id', ...merchantOnly, requireScope('subscriptions:read', 'subscriptions:write'), (req, res) => {
  const p = getPlan(String(req.params.id));
  if (p.merchantId !== req.user!.id) throw notFound('Plan not found', 'plan_not_found');
  res.json({ plan: p, checkout_hint: `Customers subscribe with plan code ${p.code} from the app or POST /api/billing/subscriptions` });
});
v1ExtRouter.post('/plans/:id/archive', ...merchantOnly, requireScope('subscriptions:write'), writeLimit, (req, res) => res.json({ plan: archivePlan(req.user!, String(req.params.id)) }));
v1ExtRouter.get('/subscriptions', ...merchantOnly, requireScope('subscriptions:read', 'subscriptions:write'), (req, res) =>
  res.json({
    data: listSubscriptions({ merchantId: req.user!.id, status: req.query.status ? String(req.query.status) : null, limit: Number(req.query.limit) || 100 }),
    overview: billingOverview(req.user!.id),
  }),
);
v1ExtRouter.get('/subscriptions/:id', ...merchantOnly, requireScope('subscriptions:read', 'subscriptions:write'), (req, res) => {
  const s = getSubscription(String(req.params.id));
  if (s.merchantId !== req.user!.id) throw notFound('Subscription not found', 'subscription_not_found');
  res.json({ subscription: s, invoices: listInvoices({ subscriptionId: s.id }) });
});
v1ExtRouter.post('/subscriptions/:id/usage', ...merchantOnly, requireScope('subscriptions:write'), writeLimit, (req, res) => {
  const b = validate(z.object({ quantity: z.number().int().positive(), note: z.string().max(120).optional().nullable() }), req.body);
  res.json({ subscription: recordUsage(req.user!, String(req.params.id), b.quantity, b.note ?? null) });
});
v1ExtRouter.post('/subscriptions/:id/cancel', ...merchantOnly, requireScope('subscriptions:write'), writeLimit, (req, res) =>
  res.json({ subscription: cancelSubscription(req.user!, String(req.params.id), { immediately: !!req.body?.immediately }) }),
);
v1ExtRouter.get('/invoices', ...merchantOnly, requireScope('subscriptions:read', 'subscriptions:write'), (req, res) =>
  res.json({ data: listInvoices({ merchantId: req.user!.id, limit: Number(req.query.limit) || 100 }) }),
);

// ---------------------------------------------------------------- credit readiness for lenders (module 13): consented access only
v1ExtRouter.get('/credit_readiness/:code', requireAuth, requireScope('credit:read'), rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'v1cr' }), (req, res) =>
  res.json(readinessForLender(String(req.params.code), { id: req.apiKeyId ?? req.user!.id, label: req.user!.business_name || req.user!.full_name })),
);
