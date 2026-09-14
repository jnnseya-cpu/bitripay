/**
 * Merchant-facing financial operations (Phase 5): settlement profiles, cycles and statements, the settlement
 * calendar, disputes (respond with evidence, withdraw your own), the fee schedule that applies to you, split
 * payouts. Mounted at /api/v1 and /v1 next to the gateway API; API keys need the matching scope.
 */
import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { requireAuth, requireRole, requireScope } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import {
  upsertProfile,
  listProfiles,
  getProfile,
  listCycles,
  getCycle,
  cycleItems,
  cycleStatement,
  cycleStatementCsv,
  cycleStatementPdf,
  settlementCalendar,
  closeCycle,
  payCycle,
  previewProfile,
  settlementView,
} from '../services/finops/settlement';
import { listDisputes, getDispute, merchantRespond, addEvidence, withdrawDispute, openDispute, disputeChronology, getDisputeSettings } from '../services/finops/disputes';
import { effectiveFees } from '../services/finops/fees';
import { listSplitPayouts, retrySplits, listSplitRefundAllocations, retrySplitRefundAllocations } from '../services/finops/splits';
import { listHolds } from '../services/finops/holds';
import { getDb } from '../db';
import { forbidden } from '../lib/errors';

export const finopsRouter = Router();
const merchantOnly = [requireAuth, requireRole('merchant', 'admin')];
const writeLimit = rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'finops' });

// ---------------------------------------------------------------- settlement profiles
const profileSchema = z.object({
  rail: z.string().min(2).max(40).optional(),
  currency: z.string().length(3),
  schedule: z.enum(['T0', 'T1', 'T2', 'weekly', 'manual']),
  cutoff_hour_utc: z.number().int().min(0).max(23).optional(),
  destination: z
    .union([
      z.object({ method: z.literal('wallet') }),
      z.object({ method: z.literal('bank'), bankAccountId: z.string() }),
      z.object({
        method: z.literal('bank'),
        bankName: z.string(),
        accountName: z.string(),
        accountNumber: z.string(),
        country: z.string().optional().nullable(),
        swift: z.string().optional().nullable(),
      }),
      z.object({ method: z.literal('mobile_money'), operatorId: z.string(), phone: z.string(), name: z.string().optional().nullable() }),
    ])
    .optional(),
  min_amount: z.number().int().min(0).optional(),
  auto: z.boolean().optional(),
  active: z.boolean().optional(),
  /** Currency the merchant is paid in; when it differs from `currency` the obligation is converted at the platform rate with the disclosed margin. */
  settlement_currency: z.string().length(3).optional().nullable(),
  /** Convert at close (true) or only when the cycle is paid (false). */
  auto_convert: z.boolean().optional(),
});
finopsRouter.get('/settlement_profiles', ...merchantOnly, requireScope('settlements:read', 'settlements:write'), (req, res) => res.json({ data: listProfiles(req.user!.id) }));
finopsRouter.post('/settlement_profiles', ...merchantOnly, requireScope('settlements:write'), writeLimit, (req, res) => {
  const b = validate(profileSchema, req.body);
  const p = upsertProfile(req.user!, {
    rail: b.rail,
    currency: b.currency,
    schedule: b.schedule,
    cutoffHourUtc: b.cutoff_hour_utc,
    destination: b.destination as any,
    minAmount: b.min_amount,
    auto: b.auto,
    active: b.active,
    settlementCurrency: b.settlement_currency ? b.settlement_currency.toUpperCase() : null,
    autoConvert: b.auto_convert,
  });
  res.status(201).json(p);
});
finopsRouter.get('/settlement_profiles/:id', ...merchantOnly, requireScope('settlements:read', 'settlements:write'), (req, res) => res.json(getProfile(req.user!.id, String(req.params.id))));
/** What the next cycle of this profile would settle right now: collection currency totals, the fee lines, and the conversion into the settlement currency disclosed. */
finopsRouter.get('/settlement_profiles/:id/preview', ...merchantOnly, requireScope('settlements:read', 'settlements:write'), (req, res) =>
  res.json(previewProfile(req.user!.id, String(req.params.id))),
);

// ---------------------------------------------------------------- settlement cycles, obligations, statements
finopsRouter.get('/settlement_calendar', ...merchantOnly, requireScope('settlements:read', 'settlements:write'), (req, res) => res.json(settlementCalendar(req.user!.id)));
finopsRouter.get('/settlement_cycles', ...merchantOnly, requireScope('settlements:read', 'settlements:write'), (req, res) =>
  res.json({
    data: listCycles({
      userId: req.user!.id,
      status: req.query.status ? String(req.query.status) : null,
      currency: req.query.currency ? String(req.query.currency).toUpperCase() : null,
      limit: Math.min(200, Number(req.query.limit) || 50),
    }),
  }),
);
/** Merchant-initiated close of the running period (manual schedule, or an early cut-off). */
finopsRouter.post('/settlement_cycles', ...merchantOnly, requireScope('settlements:write'), writeLimit, (req, res) => {
  const b = validate(z.object({ currency: z.string().length(3), rail: z.string().min(2).max(40).optional(), pay: z.boolean().optional() }), req.body);
  let c = closeCycle(req.user!.id, b.currency.toUpperCase(), b.rail ?? 'default', { actor: { type: 'merchant', id: req.user!.id } });
  if (b.pay && c.status === 'CLOSED') c = payCycle(c.id, { type: 'merchant', id: req.user!.id });
  res.status(201).json(c);
});
finopsRouter.get('/settlement_cycles/:id', ...merchantOnly, requireScope('settlements:read', 'settlements:write'), (req, res) => {
  const c = getCycle(req.user!.id, String(req.params.id));
  res.json({ ...c, items: cycleItems(c.id) });
});
/** A settlement (cycle) with its items and the statement summary: provider fee, BitriPay fee and tax as separate lines, plus the conversion when the settlement currency differs. */
finopsRouter.get('/settlements/:id', ...merchantOnly, requireScope('settlements:read', 'settlements:write'), (req, res) => res.json(settlementView(req.user!.id, String(req.params.id))));
finopsRouter.post('/settlement_cycles/:id/pay', ...merchantOnly, requireScope('settlements:write'), writeLimit, (req, res) => {
  const c = getCycle(req.user!.id, String(req.params.id));
  const b = validate(z.object({ destination: profileSchema.shape.destination }), req.body ?? {});
  const dest = b.destination && b.destination.method !== 'wallet' ? b.destination : null;
  res.json(payCycle(c.id, { type: 'merchant', id: req.user!.id }, dest as any));
});
finopsRouter.get('/settlement_cycles/:id/statement', ...merchantOnly, requireScope('settlements:read', 'settlements:write'), (req, res) => {
  const c = getCycle(req.user!.id, String(req.params.id));
  const format = String(req.query.format ?? 'json');
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="settlement-${c.businessDate}-${c.id}.csv"`);
    return res.send(cycleStatementCsv(c.id));
  }
  if (format === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="settlement-${c.businessDate}-${c.id}.pdf"`);
    return res.send(cycleStatementPdf(c.id));
  }
  res.json(cycleStatement(c.id));
});

// ---------------------------------------------------------------- holds (read-only for the merchant)
finopsRouter.get('/holds', ...merchantOnly, requireScope('balance:read'), (req, res) =>
  res.json({ data: listHolds({ userId: req.user!.id, status: req.query.status ? String(req.query.status) : 'ACTIVE', limit: Math.min(200, Number(req.query.limit) || 50) }) }),
);

// ---------------------------------------------------------------- disputes
finopsRouter.get('/disputes', ...merchantOnly, requireScope('disputes:read', 'disputes:write'), (req, res) =>
  res.json({
    data: listDisputes({ merchantId: req.user!.id, status: req.query.status ? String(req.query.status) : null, limit: Math.min(200, Number(req.query.limit) || 50) }),
    settings: { responseDays: getDisputeSettings().responseDays, reasonCodes: getDisputeSettings().reasonCodes },
  }),
);
/** A merchant can open a dispute against a payment it received (for example on a customer's complaint made in person). */
finopsRouter.post('/disputes', ...merchantOnly, requireScope('disputes:write'), writeLimit, (req, res) => {
  const b = validate(
    z.object({
      payment_intent: z.string().optional().nullable(),
      transaction_id: z.string().optional().nullable(),
      reason_code: z.string().min(2),
      reason: z.string().max(1000).optional().nullable(),
      amount_minor: z.number().int().positive().optional().nullable(),
      evidence: z.string().max(4000).optional().nullable(),
    }),
    req.body,
  );
  if (!b.payment_intent && !b.transaction_id) throw forbidden('payment_intent or transaction_id is required', 'validation_error');
  if (b.payment_intent) {
    const i = getDb().prepare('SELECT merchant_user_id FROM payment_intents WHERE id = ?').get(b.payment_intent) as any;
    if (!i || i.merchant_user_id !== req.user!.id) throw forbidden('That payment intent is not yours', 'not_owner');
  }
  const d = openDispute(
    {
      intentId: b.payment_intent ?? null,
      transactionId: b.transaction_id ?? null,
      openedBy: 'merchant',
      reasonCode: b.reason_code,
      reason: b.reason ?? null,
      amountMinor: b.amount_minor ?? null,
      evidenceText: b.evidence ?? null,
    },
    { type: 'merchant', id: req.user!.id },
  );
  if (d.merchantId !== req.user!.id) throw forbidden('That payment was not received by you', 'not_owner');
  res.status(201).json(d);
});
finopsRouter.get('/disputes/:id', ...merchantOnly, requireScope('disputes:read', 'disputes:write'), (req, res) => {
  const d = getDispute(req.user!.id, String(req.params.id));
  res.json({ ...d, chronology: disputeChronology(d.id).events });
});
finopsRouter.post('/disputes/:id/respond', ...merchantOnly, requireScope('disputes:write'), writeLimit, (req, res) => {
  const b = validate(z.object({ response: z.string().min(1).max(8000), files: z.array(z.string().max(300)).max(20).optional() }), req.body);
  res.json(merchantRespond(req.user!, String(req.params.id), b.response, b.files ?? []));
});
finopsRouter.post('/disputes/:id/evidence', ...merchantOnly, requireScope('disputes:write'), writeLimit, (req, res) => {
  const d = getDispute(req.user!.id, String(req.params.id));
  const b = validate(z.object({ text: z.string().max(8000).optional().default(''), files: z.array(z.string().max(300)).max(20).optional() }), req.body);
  res.json(addEvidence(d.id, { id: req.user!.id, role: 'merchant' }, b.text, b.files ?? []));
});
finopsRouter.post('/disputes/:id/withdraw', ...merchantOnly, requireScope('disputes:write'), writeLimit, (req, res) => {
  const d = getDispute(req.user!.id, String(req.params.id));
  if (d.openedBy !== 'merchant') throw forbidden('Only the party that opened the dispute can withdraw it', 'not_opener');
  res.json(withdrawDispute(d.id, { type: 'merchant', id: req.user!.id }));
});

// ---------------------------------------------------------------- fees that apply to me, split payouts
finopsRouter.get('/fee_schedule', ...merchantOnly, requireScope('balance:read'), (req, res) =>
  res.json({ data: effectiveFees({ userId: req.user!.id }), tier: (getDb().prepare('SELECT fee_tier FROM users WHERE id = ?').get(req.user!.id) as any)?.fee_tier ?? null }),
);
finopsRouter.get('/payment_intents/:id/splits', ...merchantOnly, requireScope('payment_intents:read', 'payment_intents:write'), (req, res) => {
  const i = getDb().prepare('SELECT merchant_user_id FROM payment_intents WHERE id = ?').get(String(req.params.id)) as any;
  if (!i || i.merchant_user_id !== req.user!.id) throw forbidden('That payment intent is not yours', 'not_owner');
  res.json({ data: listSplitPayouts(String(req.params.id)) });
});
/** What each split recipient gave back on the refunds of this intent (pro rata) or kept (merchant absorbs). */
finopsRouter.get('/payment_intents/:id/split_refunds', ...merchantOnly, requireScope('payment_intents:read', 'payment_intents:write'), (req, res) => {
  const i = getDb().prepare('SELECT merchant_user_id FROM payment_intents WHERE id = ?').get(String(req.params.id)) as any;
  if (!i || i.merchant_user_id !== req.user!.id) throw forbidden('That payment intent is not yours', 'not_owner');
  res.json({ data: listSplitRefundAllocations(String(req.params.id), req.query.refund ? String(req.query.refund) : null) });
});
finopsRouter.post('/payment_intents/:id/split_refunds/retry', ...merchantOnly, requireScope('payment_intents:write'), writeLimit, (req, res) => {
  const i = getDb().prepare('SELECT merchant_user_id FROM payment_intents WHERE id = ?').get(String(req.params.id)) as any;
  if (!i || i.merchant_user_id !== req.user!.id) throw forbidden('That payment intent is not yours', 'not_owner');
  res.json({ data: retrySplitRefundAllocations(String(req.params.id)) });
});
finopsRouter.post(
  '/payment_intents/:id/splits/retry',
  ...merchantOnly,
  requireScope('payment_intents:write'),
  writeLimit,
  wrap(async (req, res) => {
    const i = getDb().prepare('SELECT merchant_user_id FROM payment_intents WHERE id = ?').get(String(req.params.id)) as any;
    if (!i || i.merchant_user_id !== req.user!.id) throw forbidden('That payment intent is not yours', 'not_owner');
    res.json({ data: retrySplits(String(req.params.id)) });
  }),
);
