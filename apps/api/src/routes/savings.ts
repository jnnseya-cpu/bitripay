import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { getCurrency } from '../services/currencies';
import { toMinor } from '@bitripay/shared';
import { savingsOverview, updateSavingsSettings, createGoal, getGoal, contribute, withdrawFromGoal, closeGoal, goalMovements, wellbeing } from '../services/savings';

export const savingsRouter = Router();
savingsRouter.use(requireAuth);
savingsRouter.get('/', (req, res) => res.json(savingsOverview(req.user!)));
savingsRouter.get('/wellbeing', (req, res) => res.json(wellbeing(req.user!.id)));
savingsRouter.put('/settings', (req, res) => {
  const b = validate(z.object({ autoAnchor: z.boolean().optional(), anchorBps: z.number().int().optional(), roundUps: z.boolean().optional(), roundToMinor: z.number().int().min(1).optional(), defaultGoalId: z.string().optional().nullable() }), req.body);
  res.json(updateSavingsSettings(req.user!, b));
});
savingsRouter.post('/goals', (req, res) => {
  const b = validate(z.object({ name: z.string().min(2).max(80), currency: z.string().length(3), target: z.string().optional().nullable(), targetMinor: z.number().int().min(0).optional().nullable(), deadline: z.string().optional().nullable(), makeDefault: z.boolean().optional() }), req.body);
  const cur = getCurrency(b.currency);
  res.status(201).json(createGoal(req.user!, { name: b.name, currency: cur.code, targetMinor: b.targetMinor ?? (b.target ? toMinor(b.target, cur.decimals) : 0), deadline: b.deadline ?? null, makeDefault: b.makeDefault }));
});
savingsRouter.get('/goals/:id', (req, res) => res.json({ goal: getGoal(req.user!.id, String(req.params.id)), movements: goalMovements(req.user!.id, String(req.params.id)) }));
savingsRouter.post('/goals/:id/contribute', (req, res) => {
  const g = getGoal(req.user!.id, String(req.params.id));
  const b = validate(z.object({ amount: z.string().optional(), amountMinor: z.number().int().positive().optional() }), req.body);
  const amount = b.amountMinor ?? toMinor(b.amount ?? '0', getCurrency(g.currency).decimals);
  res.json(contribute(req.user!.id, g.id, amount, 'manual', { type: 'user', id: req.user!.id }));
});
savingsRouter.post('/goals/:id/withdraw', (req, res) => {
  const g = getGoal(req.user!.id, String(req.params.id));
  const b = validate(z.object({ amount: z.string().optional(), amountMinor: z.number().int().positive().optional() }), req.body);
  const amount = b.amountMinor ?? toMinor(b.amount ?? '0', getCurrency(g.currency).decimals);
  res.json(withdrawFromGoal(req.user!.id, g.id, amount, { type: 'user', id: req.user!.id }));
});
savingsRouter.delete('/goals/:id', (req, res) => res.json(closeGoal(req.user!.id, String(req.params.id), { type: 'user', id: req.user!.id })));
