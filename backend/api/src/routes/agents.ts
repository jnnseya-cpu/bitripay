import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { requireAuth, requireAgent, requireOrgPermission } from '../middleware/auth';
import { listAgents, agentCashIn, createCashOutRequest, listCashRequests, confirmCashOut, cancelCashRequest, agentStats } from '../services/agents';
import { payoutCashPickup, getRemittance } from '../services/remittance';
import { assertPin } from '../services/auth';
import { getCurrency } from '../services/currencies';
import { toMinor } from '@bitripay/shared';
import { toTransaction } from '../services/ledger';
import { usersById } from '../services/users';

export const agentsRouter = Router();
agentsRouter.use(requireAuth);

/**
 * Agent surfaces run as the agent account (the float, the commissions and every cash operation are keyed on it);
 * when a member of the agent's team is at the till, `req.actor` is that person: they confirm with their own PIN and
 * every transaction records them as the operator.
 */
const operatorOf = (req: import('express').Request) => req.actor ?? req.user!;

agentsRouter.get('/', (req, res) => res.json({ items: listAgents(req.query.q ? String(req.query.q) : undefined, req.query.country ? String(req.query.country) : null) }));

/** Customer side: request cash-out from an agent. */
agentsRouter.post(
  '/cash-out',
  wrap(async (req, res) => {
    const body = validate(z.object({ agent: z.string().min(2), amount: z.string(), currency: z.string().length(3), pin: z.string().optional() }), req.body);
    assertPin(req.user!, body.pin, req);
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
agentsRouter.get('/me/stats', ...requireAgent, requireOrgPermission('agent:view'), (req, res) => res.json(agentStats(req.user!)));
/** The cash-out requests made to this agent (a team member sees the agent's queue here, their own requests under /cash-requests). */
agentsRouter.get('/me/cash-requests', ...requireAgent, requireOrgPermission('agent:view'), (req, res) => res.json({ items: listCashRequests(req.user!) }));
agentsRouter.post(
  '/me/cash-in',
  requireAgent,
  requireOrgPermission('agent:cash_in'),
  wrap(async (req, res) => {
    const body = validate(
      z.object({ customer: z.string().min(2), amount: z.string(), currency: z.string().length(3), note: z.string().max(200).optional().nullable(), pin: z.string().optional() }),
      req.body,
    );
    assertPin(operatorOf(req), body.pin, req);
    const cur = getCurrency(body.currency);
    const tx = agentCashIn(req.user!, { customer: body.customer, amount: toMinor(body.amount, cur.decimals), currency: cur.code, note: body.note, operator: req.actor });
    res.status(201).json({ transaction: toTransaction(tx, req.user!.id, usersById([tx.receiver_user_id!])) });
  }),
);
agentsRouter.post(
  '/me/cash-out/confirm',
  requireAgent,
  requireOrgPermission('agent:cash_out'),
  wrap(async (req, res) => {
    const body = validate(z.object({ code: z.string().min(4), pin: z.string().optional() }), req.body);
    assertPin(operatorOf(req), body.pin, req);
    const tx = confirmCashOut(req.user!, body.code, req.actor);
    res.status(201).json({ transaction: toTransaction(tx, req.user!.id, usersById([tx.sender_user_id!])) });
  }),
);
agentsRouter.get('/me/pickups/:code', ...requireAgent, requireOrgPermission('agent:pickups'), (req, res) => {
  const r = getRemittance(String(req.params.code));
  res.json({ remittance: { ...r, recipient: { name: (r.recipient as any).name, country: (r.recipient as any).country } } });
});
agentsRouter.post(
  '/me/pickups/:code/payout',
  requireAgent,
  requireOrgPermission('agent:pickups'),
  wrap(async (req, res) => {
    const body = validate(z.object({ recipientIdNumber: z.string().optional(), pin: z.string().optional() }), req.body);
    assertPin(operatorOf(req), body.pin, req);
    res.json({ remittance: payoutCashPickup(req.user!, String(String(req.params.code)), body.recipientIdNumber, req.actor) });
  }),
);
