import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { requireAuth, requireAgent } from '../middleware/auth';
import { listAgents, agentCashIn, createCashOutRequest, listCashRequests, confirmCashOut, cancelCashRequest, agentStats } from '../services/agents';
import { payoutCashPickup, getRemittance } from '../services/remittance';
import { assertPin } from '../services/auth';
import { getCurrency } from '../services/currencies';
import { toMinor } from '@bitripay/shared';
import { toTransaction } from '../services/ledger';
import { usersById } from '../services/users';

export const agentsRouter = Router();
agentsRouter.use(requireAuth);

agentsRouter.get('/', (req, res) => res.json({ items: listAgents(req.query.q ? String(req.query.q) : undefined, req.query.country ? String(req.query.country) : null) }));

/** Customer side: request cash-out from an agent. */
agentsRouter.post(
  '/cash-out',
  wrap(async (req, res) => {
    const body = validate(z.object({ agent: z.string().min(2), amount: z.string(), currency: z.string().length(3), pin: z.string().optional() }), req.body);
    assertPin(req.user!, body.pin);
    const cur = getCurrency(body.currency);
    res.status(201).json({ request: createCashOutRequest(req.user!, { agent: body.agent, amount: toMinor(body.amount, cur.decimals), currency: cur.code }) });
  }),
);
agentsRouter.get('/cash-requests', (req, res) => res.json({ items: listCashRequests(req.user!) }));
agentsRouter.post('/cash-requests/:code/cancel', (req, res) => {
  cancelCashRequest(req.user!, String(String(req.params.code)));
  res.json({ ok: true });
});

/** Agent side */
agentsRouter.get('/me/stats', ...requireAgent, (req, res) => res.json(agentStats(req.user!)));
agentsRouter.post(
  '/me/cash-in',
  requireAgent,
  wrap(async (req, res) => {
    const body = validate(z.object({ customer: z.string().min(2), amount: z.string(), currency: z.string().length(3), note: z.string().max(200).optional().nullable(), pin: z.string().optional() }), req.body);
    assertPin(req.user!, body.pin);
    const cur = getCurrency(body.currency);
    const tx = agentCashIn(req.user!, { customer: body.customer, amount: toMinor(body.amount, cur.decimals), currency: cur.code, note: body.note });
    res.status(201).json({ transaction: toTransaction(tx, req.user!.id, usersById([tx.receiver_user_id!])) });
  }),
);
agentsRouter.post(
  '/me/cash-out/confirm',
  requireAgent,
  wrap(async (req, res) => {
    const body = validate(z.object({ code: z.string().min(4), pin: z.string().optional() }), req.body);
    assertPin(req.user!, body.pin);
    const tx = confirmCashOut(req.user!, body.code);
    res.status(201).json({ transaction: toTransaction(tx, req.user!.id, usersById([tx.sender_user_id!])) });
  }),
);
agentsRouter.get('/me/pickups/:code', ...requireAgent, (req, res) => {
  const r = getRemittance(String(req.params.code));
  res.json({ remittance: { ...r, recipient: { name: (r.recipient as any).name, country: (r.recipient as any).country } } });
});
agentsRouter.post(
  '/me/pickups/:code/payout',
  requireAgent,
  wrap(async (req, res) => {
    const body = validate(z.object({ recipientIdNumber: z.string().optional(), pin: z.string().optional() }), req.body);
    assertPin(req.user!, body.pin);
    res.json({ remittance: payoutCashPickup(req.user!, String(String(req.params.code)), body.recipientIdNumber) });
  }),
);
