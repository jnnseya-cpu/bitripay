/**
 * Government QR infrastructure (specification §105, §106). Mounted at /api/government: agency operators manage
 * services and issue citizen references (agents issue them at the counter), citizens look a reference up by its
 * reconciliation code, and operators read the dashboard and the audit export. Agencies and operators are created
 * by administrators under /api/admin/insights/government.
 */
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { forbidden } from '../lib/errors';
import { getCurrency } from '../services/currencies';
import { toMinor } from '@bitripay/shared';
import {
  agenciesFor,
  assertOperator,
  listServices,
  createService,
  getService,
  createReference,
  getReference,
  listReferences,
  agencyDashboard,
  auditExportCsv,
  canReadReference,
  GOV_PURPOSES,
} from '../services/government';

export const governmentRouter = Router();
governmentRouter.use(requireAuth);
const writeLimit = rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'government' });
const range = (q: Record<string, unknown>) => ({ agencyId: q.agencyId ? String(q.agencyId) : null, from: q.from ? String(q.from) : null, to: q.to ? String(q.to) : null });

governmentRouter.get('/agencies', (req, res) => res.json({ items: agenciesFor(req.user!) }));
governmentRouter.get('/agencies/:id/services', (req, res) => res.json({ items: listServices(assertOperator(req.user!, String(req.params.id)).id) }));
governmentRouter.post('/agencies/:id/services', writeLimit, (req, res) => {
  const b = validate(
    z.object({
      name: z.string().min(2).max(120),
      revenueCode: z.string().min(2).max(40),
      purposeCode: z.enum(GOV_PURPOSES).optional().nullable(),
      currency: z.string().length(3),
      fixedAmount: z.string().optional().nullable(),
      reusable: z.boolean().optional(),
      referenceTtlMinutes: z
        .number()
        .int()
        .min(5)
        .max(60 * 24 * 90)
        .optional()
        .nullable(),
    }),
    req.body,
  );
  const cur = getCurrency(b.currency);
  res.status(201).json({
    service: createService(req.user!, String(req.params.id), {
      name: b.name,
      revenueCode: b.revenueCode,
      purposeCode: b.purposeCode ?? null,
      currency: cur.code,
      fixedAmountMinor: b.fixedAmount ? toMinor(b.fixedAmount, cur.decimals) : null,
      reusable: b.reusable ?? false,
      referenceTtlMinutes: b.referenceTtlMinutes ?? null,
    }),
  });
});
governmentRouter.post('/services/:id/references', writeLimit, (req, res) => {
  const b = validate(
    z.object({
      citizenRef: z.string().min(2).max(80),
      amount: z.string().optional().nullable(),
      region: z.string().max(80).optional().nullable(),
      expiresInMinutes: z.number().int().min(5).optional().nullable(),
    }),
    req.body,
  );
  const amountMinor = b.amount ? toMinor(b.amount, getCurrency(getService(String(req.params.id)).currency).decimals) : null;
  res.status(201).json(createReference(req.user!, String(req.params.id), { citizenRef: b.citizenRef, amountMinor, region: b.region ?? null, expiresInMinutes: b.expiresInMinutes ?? null }));
});
governmentRouter.get('/references', (req, res) => {
  const f = range(req.query as Record<string, unknown>);
  const agencies = f.agencyId ? [assertOperator(req.user!, f.agencyId)] : agenciesFor(req.user!);
  res.json({ items: agencies.flatMap((a) => listReferences({ agencyId: a.id, status: req.query.status ? String(req.query.status) : null, from: f.from, to: f.to, limit: 200 })) });
});
governmentRouter.get('/references/:code', (req, res) => {
  const ref = getReference(String(req.params.code));
  if (!canReadReference(req.user!, ref)) throw forbidden('You cannot read this reference', 'not_agency_operator');
  res.json({ reference: ref });
});
governmentRouter.get('/dashboard', (req, res) => res.json(agencyDashboard(req.user!, range(req.query as Record<string, unknown>))));
governmentRouter.get('/audit-export.csv', (req, res) => {
  const csv = auditExportCsv(req.user!, range(req.query as Record<string, unknown>));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="bitripay-government-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});
