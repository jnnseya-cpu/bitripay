/**
 * Command centre API: the agents available to the signed-in account, runs (start, list, read, stream, cancel),
 * per-agent settings, memories (view and delete, for data-protection rights) and usage against the monthly allowance.
 */
import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { hasPermission } from '../middleware/permissions';
import { rateLimit } from '../middleware/rateLimit';
import { agentsAvailable, startRun, listRuns, getRun, cancelRun, subscribe, getInstance, setInstance, listMemories, addMemory, deleteMemory, usageSummary, runtimeStatus, listApprovals } from '../services/assist/runtime';
import { toolCatalogue } from '../services/assist/tools';
import { addonStatus, activateAddon, cancelAddon, setAutoRenew } from '../services/assist/addon';

export const assistRouter = Router();
assistRouter.use(requireAuth);

assistRouter.get('/agents', (req, res) => {
  const status = runtimeStatus();
  res.json({ agents: agentsAvailable(req.user!), usage: usageSummary(req.user!), addon: addonStatus(req.user!), runtime: { mode: status.mode, enabled: status.enabled, model: status.model } });
});
assistRouter.get('/tools', (req, res) => res.json({ tools: toolCatalogue(req.user!.role, (p) => hasPermission(req.user as any, p)) }));

const startSchema = z.object({ agent: z.string().min(2).max(40), input: z.string().min(1).max(4000), context: z.record(z.string(), z.unknown()).optional().nullable() });
assistRouter.post(
  '/runs',
  rateLimit({ windowMs: 60_000, max: 30, keyPrefix: 'assist' }),
  wrap(async (req, res) => {
    const body = validate(startSchema, req.body);
    const run = await startRun(req.user!, body.agent, body.input, { context: body.context ?? null, trigger: 'user', wait: req.query.wait === '1' || req.query.wait === 'true' });
    res.status(202).json({ run });
  }),
);
assistRouter.get('/runs', (req, res) => res.json({ items: listRuns({ userId: req.user!.id, agentKey: req.query.agent ? String(req.query.agent) : null, limit: Math.min(100, Number(req.query.limit) || 30) }) }));
assistRouter.get('/runs/:id', (req, res) => res.json({ run: getRun(String(req.params.id), req.user!.id) }));
assistRouter.post('/runs/:id/cancel', (req, res) => res.json({ run: cancelRun(String(req.params.id), req.user!.id) }));

/** Server-sent events: replays persisted steps, then live deltas, messages and the final run. */
assistRouter.get('/runs/:id/stream', (req, res) => {
  const id = String(req.params.id);
  const run = getRun(id, req.user!.id);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  for (const a of run.actions) send('step', { action: a });
  if (['completed', 'failed', 'cancelled', 'budget_exhausted', 'awaiting_approval'].includes(run.status)) {
    if (run.output) send('message', { text: run.output });
    send('done', { run });
    res.end();
    return;
  }
  const off = subscribe(id, (ev) => {
    if (ev.type === 'step') send('step', { action: ev.action });
    else if (ev.type === 'delta') send('delta', { text: ev.text });
    else if (ev.type === 'message') send('message', { text: ev.text });
    else if (ev.type === 'status') send('status', { status: ev.status });
    else if (ev.type === 'done') {
      send('done', { run: ev.run });
      off();
      res.end();
    }
  });
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(ping);
    off();
  });
});

assistRouter.get('/approvals', (req, res) => res.json({ items: listApprovals({ runUserId: req.user!.id, limit: 30 }) }));

assistRouter.get('/instances/:agent', (req, res) => res.json({ instance: getInstance(req.user!.id, String(req.params.agent)) }));
assistRouter.put('/instances/:agent', (req, res) => {
  const body = validate(z.object({ enabled: z.boolean().optional(), settings: z.record(z.string(), z.unknown()).optional() }), req.body);
  res.json({ instance: setInstance(req.user!.id, String(req.params.agent), body) });
});

assistRouter.get('/memories', (req, res) => res.json({ items: listMemories(req.user!.id) }));
assistRouter.post('/memories', (req, res) => {
  const body = validate(z.object({ agent: z.string().default('knowledge'), kind: z.enum(['preference', 'fact', 'outcome']).default('preference'), content: z.string().min(3).max(400) }), req.body);
  res.status(201).json({ memory: addMemory(req.user!.id, body.agent, body.kind, body.content) });
});
assistRouter.delete('/memories/:id', (req, res) => res.json({ deleted: deleteMemory(req.user!.id, String(req.params.id)) }));
assistRouter.delete('/memories', (req, res) => res.json({ deleted: deleteMemory(req.user!.id) }));

assistRouter.get('/addon', (req, res) => res.json({ addon: addonStatus(req.user!) }));
assistRouter.post('/addon/activate', rateLimit({ windowMs: 60_000, max: 10, keyPrefix: 'addon' }), (req, res) => {
  const body = validate(z.object({ currency: z.string().length(3), pin: z.string().optional(), autoRenew: z.boolean().optional() }), req.body);
  res.status(201).json({ subscription: activateAddon(req.user!, body.currency, body.pin, req, body.autoRenew), addon: addonStatus(req.user!) });
});
assistRouter.post('/addon/cancel', (req, res) => res.json({ subscription: cancelAddon(req.user!), addon: addonStatus(req.user!) }));
assistRouter.post('/addon/auto-renew', (req, res) => {
  const body = validate(z.object({ on: z.boolean() }), req.body);
  res.json({ subscription: setAutoRenew(req.user!, body.on), addon: addonStatus(req.user!) });
});
assistRouter.get('/usage', (req, res) => res.json({ usage: usageSummary(req.user!) }));
