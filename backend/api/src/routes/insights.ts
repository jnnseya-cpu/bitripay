/**
 * Account-holder insights (specification §27, §58, §59). Mounted at /api/insights: the merchant acceptance score
 * and its snapshots, the merchant's aggregate view of the payment graph (never another account's identity), and
 * the agent's float outlook with the cash declaration that keeps it honest.
 */
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../lib/http';
import { requireAuth, requireRole, requireScope } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { computeAcceptanceScore, listAcceptanceSnapshots, ACCEPTANCE_WEIGHTS } from '../services/acceptanceScore';
import { merchantGraphSummary } from '../services/paymentGraph';
import { floatOutlook, agentLimitsFor, declareCash, getAgentIntelSettings } from '../services/risk/agentIntel';
import { getCurrency } from '../services/currencies';
import { toMinor } from '@bitripay/shared';
import { MERCHANT_ROLES } from '../services/users';

export const insightsRouter = Router();
insightsRouter.use(requireAuth);
const writeLimit = rateLimit({ windowMs: 60_000, max: 30, keyPrefix: 'insights' });
const windowDays = (q: unknown) => Math.max(1, Math.min(365, Number(q) || 30));

// ---------------------------------------------------------------- merchants
insightsRouter.get('/acceptance-score', requireRole(...MERCHANT_ROLES, 'admin'), requireScope('payment_intents:read'), (req, res) => {
  const days = windowDays(req.query.days);
  res.json({ ...computeAcceptanceScore(req.user!.id, days), history: listAcceptanceSnapshots(req.user!.id, 30) });
});
insightsRouter.get('/acceptance-score/weights', (_req, res) => res.json({ weights: ACCEPTANCE_WEIGHTS }));
insightsRouter.get('/graph/summary', requireRole(...MERCHANT_ROLES, 'admin'), requireScope('payment_intents:read'), (req, res) =>
  res.json(merchantGraphSummary(req.user!.id, windowDays(req.query.days))),
);

// ---------------------------------------------------------------- agents
insightsRouter.get('/float-outlook', requireRole('agent'), (req, res) => {
  const s = getAgentIntelSettings();
  res.json({
    outlooks: floatOutlook(req.user!.id, req.query.currency ? String(req.query.currency) : null),
    limits: agentLimitsFor(req.user!),
    settings: { outlookHours: s.outlookHours, depletionMediumProbability: s.depletionMediumProbability, depletionHighProbability: s.depletionHighProbability },
  });
});
insightsRouter.post('/float-outlook/cash', requireRole('agent'), writeLimit, (req, res) => {
  const b = validate(z.object({ currency: z.string().length(3), amount: z.string() }), req.body);
  const cur = getCurrency(b.currency);
  res.status(201).json({ declaration: declareCash(req.user!, { currency: cur.code, amountMinor: toMinor(b.amount, cur.decimals) }), outlooks: floatOutlook(req.user!.id, cur.code) });
});
insightsRouter.get('/float-outlook/limits', requireRole('agent'), (req, res) => res.json(agentLimitsFor(req.user!)));
