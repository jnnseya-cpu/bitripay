import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../lib/http';
import { requirePermission } from '../../middleware/permissions';
import { audit } from '../../services/audit';
import { getDb } from '../../db';
import { getSetting, setSetting } from '../../services/settings';
import { getForwardSettings, runForwards, checkFxAlerts, runSweepRules, settleForward } from '../../services/fxTools';
import { runReadinessBatch } from '../../services/creditReadiness';
import { runBilling, listSubscriptions, listInvoices } from '../../services/billing';

/** Platform view of the FX forward book, alert and rule activity, credit readiness batches and merchant billing. */
export const adminGrowthRouter = Router();
const r = adminGrowthRouter;
r.get('/fx', requirePermission('treasury'), (_req, res) => {
  const db = getDb();
  const book = db.prepare("SELECT from_currency, to_currency, COUNT(*) n, SUM(amount_minor) amount, SUM(receive_minor) receive, MIN(settle_on) next_settle FROM fx_forwards WHERE status = 'LOCKED' GROUP BY from_currency, to_currency").all();
  const forwards = db.prepare("SELECT f.*, u.full_name, u.tag FROM fx_forwards f JOIN users u ON u.id = f.user_id ORDER BY f.created_at DESC LIMIT 200").all();
  const alerts = db.prepare('SELECT status, COUNT(*) c FROM fx_alerts GROUP BY status').all();
  const rules = db.prepare('SELECT kind, status, COUNT(*) c, SUM(converted_minor) converted FROM fx_auto_rules GROUP BY kind, status').all();
  res.json({ settings: getForwardSettings(), book, forwards, alerts, rules });
});
r.put('/fx/settings', requirePermission('settings'), (req, res) => {
  const b = validate(z.object({ enabled: z.boolean().optional(), forwardBps: z.number().int().min(0).max(2000).optional(), maxTenorDays: z.number().int().min(1).max(365).optional(), maxPerForwardBase: z.number().int().min(0).optional(), maxOpenPerAccountBase: z.number().int().min(0).optional(), maxOpenTotalBase: z.number().int().min(0).optional(), graceDays: z.number().int().min(0).max(30).optional() }), req.body);
  setSetting('fxForwards', { ...getSetting<any>('fxForwards', {}), ...b });
  audit(req.user!.id, 'fx.forwards.settings', 'settings', 'fxForwards', b);
  res.json({ settings: getForwardSettings() });
});
r.post('/fx/forwards/:id/settle', requirePermission('treasury'), (req, res) => {
  const f = settleForward(String(req.params.id), { type: 'admin', id: req.user!.id }, { force: true });
  audit(req.user!.id, 'fx.forward.settle', 'fx_forward', f.id, { early: true });
  res.json({ forward: f });
});
r.post('/fx/run', requirePermission('treasury'), (req, res) => {
  const out = { alerts: checkFxAlerts(), sweeps: runSweepRules(), forwards: runForwards() };
  audit(req.user!.id, 'fx.run', 'jobs', 'fx', out);
  res.json(out);
});
r.post('/credit/run', requirePermission('compliance'), (req, res) => {
  const out = runReadinessBatch();
  audit(req.user!.id, 'credit.readiness.batch', 'jobs', 'credit', out);
  res.json(out);
});
r.get('/billing', requirePermission('transactions'), (req, res) => res.json({ subscriptions: listSubscriptions({ status: req.query.status ? String(req.query.status) : null, limit: 200 }), invoices: listInvoices({ limit: 200 }) }));
r.post('/billing/run', requirePermission('transactions'), (req, res) => {
  const out = runBilling();
  audit(req.user!.id, 'billing.run', 'jobs', 'billing', out);
  res.json(out);
});
