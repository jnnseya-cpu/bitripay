import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { requireAuth, requireOrgPermission, requireRole } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { verifyDeviceRequest, type EvidenceDevice } from '../services/evidence';
import { queueFor, claimPayout, releasePayout, submitPayoutEvidence, getPayout, listPayouts } from '../services/payouts';
import { proposeVerification } from '../services/verification';
import { forbidden } from '../lib/errors';
import { getPayoutAccount, listPayoutAccounts } from '../services/liquidity';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      device?: EvidenceDevice;
    }
  }
}

/** Android payout devices authenticate every call with their registered key (X-Device-Id / X-Device-Timestamp / X-Device-Signature). */
function deviceAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    req.device = verifyDeviceRequest(req.headers as Record<string, unknown>, req.method, req.baseUrl + req.path);
    next();
  } catch (err) {
    next(err);
  }
}

const evidenceSchema = z.object({
  nonce: z.string().min(8).max(128),
  receivedAt: z.string().datetime({ offset: true }),
  from: z.string().max(40),
  operatorId: z.string().max(60).optional().nullable(),
  text: z.string().min(5).max(2000),
  signature: z.string().min(40).max(512),
  simIdentity: z.string().max(40).optional().nullable(),
  deviceTimestamp: z.string().datetime({ offset: true }).optional().nullable(),
  clientHash: z.string().max(80).optional().nullable(),
});

/**
 * Payout execution API.
 *   Device:  GET /api/payouts/device/queue · POST /api/payouts/device/:id/claim · /release · /evidence
 *   Agent:   GET /api/payouts/agent/queue · POST /api/payouts/agent/:id/claim · /release · /evidence (manual → maker-checker)
 */
export const payoutsRouter = Router();

payoutsRouter.get('/device/queue', deviceAuth, (req, res) =>
  res.json({ device: { id: req.device!.id, name: req.device!.name, payoutAccountId: req.device!.payoutAccountId }, items: queueFor({ device: req.device }) }),
);
payoutsRouter.post('/device/:id/claim', deviceAuth, (req, res) => res.json({ payout: claimPayout(String(req.params.id), { device: req.device }) }));
payoutsRouter.post('/device/:id/release', deviceAuth, (req, res) => {
  const body = validate(z.object({ reason: z.string().min(2).max(300) }), req.body);
  res.json({ payout: releasePayout(String(req.params.id), { device: req.device }, body.reason) });
});
/** The signed operator confirmation SMS for an executed payout. Device-authenticated by the evidence signature itself. */
payoutsRouter.post(
  '/device/:id/evidence',
  rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'payout-evidence' }),
  wrap(async (req, res) => {
    const body = validate(evidenceSchema.extend({ deviceId: z.string().min(8) }), req.body);
    const r = submitPayoutEvidence(String(req.params.id), { source: 'signed_device', ...body, actor: { type: 'device', id: body.deviceId } });
    res.status(201).json({ payout: getPayout(r.payout.id, false), evidence: { id: r.evidenceId, outcome: r.outcome, reasons: r.reasons } });
  }),
);

// The agent, an administrator, or a member of the agent's team (`agent:view` to look, `agent:payouts` to claim, release and attest).
payoutsRouter.use('/agent', requireAuth, requireRole('agent', 'admin'), requireOrgPermission('agent:view', 'agent:payouts'));
const canHandle = requireOrgPermission('agent:payouts');
payoutsRouter.get('/agent/queue', (req, res) => res.json({ items: queueFor({ agent: req.user }) }));
/** Payout accounts this agent operates – the device app picks one at enrolment. */
payoutsRouter.get('/agent/accounts', (req, res) =>
  res.json({
    items: listPayoutAccounts({ status: null })
      .filter((a) => a.agent?.id === req.user!.id || req.user!.role === 'admin')
      .map((a) => ({
        id: a.id,
        label: a.label,
        rail: a.rail,
        operatorId: a.operatorId,
        operatorName: a.operatorName,
        country: a.country,
        currency: a.currency,
        msisdn: a.msisdn,
        simIccid: a.simIccid,
        deviceId: a.deviceId,
        status: a.status,
      })),
  }),
);
payoutsRouter.get('/agent/history', (req, res) => res.json(listPayouts({ agentUserId: req.user!.id, pageSize: 50 })));
payoutsRouter.post('/agent/:id/claim', canHandle, (req, res) => res.json({ payout: claimPayout(String(req.params.id), { agent: req.user }) }));
payoutsRouter.post('/agent/:id/release', canHandle, (req, res) => {
  const body = validate(z.object({ reason: z.string().min(2).max(300) }), req.body);
  res.json({ payout: releasePayout(String(req.params.id), { agent: req.user }, body.reason) });
});
/** Agent types the operator confirmation by hand: recorded as manual evidence and routed to maker-checker – never settles on its own. */
payoutsRouter.post('/agent/:id/evidence', canHandle, (req, res) => {
  const body = validate(z.object({ text: z.string().min(5).max(2000), externalRef: z.string().max(60).optional().nullable(), operatorId: z.string().max(60).optional().nullable() }), req.body);
  const p = getPayout(String(req.params.id));
  const acc = p.payoutAccountId ? getPayoutAccount(p.payoutAccountId) : null;
  if (p.agent?.id !== req.user!.id && acc?.agent?.id !== req.user!.id && req.user!.role !== 'admin') throw forbidden('This payout is not assigned to you', 'payout_not_yours');
  const r = submitPayoutEvidence(p.id, {
    source: 'manual',
    text: body.text,
    operatorId: body.operatorId ?? p.operatorId,
    from: 'agent',
    receivedAt: new Date().toISOString(),
    actor: { type: 'agent', id: req.user!.id },
  });
  let verification = null;
  if (body.externalRef)
    verification = proposeVerification(req.user!, p.id, {
      subjectType: 'payout',
      action: 'confirm',
      note: `Agent-entered confirmation: ${body.text.slice(0, 200)}`,
      externalRef: body.externalRef,
      evidenceId: r.evidenceId,
    });
  res.status(201).json({ payout: getPayout(p.id), evidence: { id: r.evidenceId, outcome: r.outcome, reasons: r.reasons }, verification });
});
