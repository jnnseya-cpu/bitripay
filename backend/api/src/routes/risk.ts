/**
 * Account-holder side of risk and compliance: verification level and limits, Tier 1 self-activation, business
 * verification (KYB), payout-destination changes ("not me" revocation), and the agent's float forecast, trust
 * score, float requests and assisted onboarding.
 */
import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { requireAuth, requireAgent, requireOrgPermission, requireRole } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { assertPin } from '../services/auth';
import { getCurrency } from '../services/currencies';
import { toMinor } from '@bitripay/shared';
import { tierStatus, activateTier1, submitKyb, latestKyb, getKycTierSettings, TIER_LABELS } from '../services/risk/kycTiers';
import { listDestinationChanges, revokeDestinationChange, getDestinationChange } from '../services/risk/accountProtection';
import { floatForecast, computeTrustScore, latestTrustScore, requestFloat, listFloatRequests, onboardCustomer, dynamicCommissionBps, getAgentIntelSettings } from '../services/risk/agentIntel';
import { forbidden } from '../lib/errors';
import { MERCHANT_ROLES } from '../services/users';

export const riskRouter = Router();
riskRouter.use(requireAuth);
const writeLimit = rateLimit({ windowMs: 60_000, max: 30, keyPrefix: 'risk' });

// ---------------------------------------------------------------- verification level
riskRouter.get('/verification', (req, res) => {
  const s = getKycTierSettings();
  const cc = (req.user!.country ?? '').toUpperCase();
  res.json({
    ...tierStatus(req.user! as any),
    tiers: [1, 2, 3, 4].map((t) => ({ tier: t, label: TIER_LABELS[t], limits: (cc && s.countries[cc]?.[String(t)]) ?? s.default[String(t)] ?? null })),
    kyb: latestKyb(req.user!.id),
  });
});
riskRouter.post('/verification/tier1', writeLimit, (req, res) => res.json(tierStatus(activateTier1(req.user!) as any)));
riskRouter.post('/kyb', ...[requireRole(...MERCHANT_ROLES, 'agent')], writeLimit, (req, res) => {
  const b = validate(
    z.object({
      legalName: z.string().min(2).max(160),
      registrationNumber: z.string().min(2).max(80),
      country: z.string().length(2),
      address: z.string().min(5).max(300),
      mcc: z.string().max(8).optional().nullable(),
      expectedMonthlyVolume: z.number().int().min(0),
      licenceRef: z.string().max(80).optional().nullable(),
      directors: z
        .array(z.object({ name: z.string().min(2).max(120), userId: z.string().optional().nullable(), role: z.string().max(60).optional().nullable() }))
        .min(1)
        .max(20),
      /** Dossier documents (RCCM extract, national identification, statutes, director ID, proof of address): a reference and/or the file as a data URL (max 4 MB each). */
      documents: z
        .array(
          z
            .object({ kind: z.string().min(2).max(40), ref: z.string().max(300).optional().nullable(), data: z.string().max(4_000_000).optional().nullable() })
            .refine((d) => !!(d.ref && d.ref.trim()) || !!d.data, { message: 'Each document needs a reference or a file' }),
        )
        .max(20)
        .optional(),
    }),
    req.body,
  );
  res.status(201).json({ submission: submitKyb(req.user!, b) });
});
riskRouter.get('/kyb', (req, res) => res.json({ submission: latestKyb(req.user!.id), status: (req.user! as any).kyb_status ?? 'none' }));

// ---------------------------------------------------------------- payout destination changes
riskRouter.get('/destination-changes', (req, res) => res.json({ items: listDestinationChanges({ userId: req.user!.id, limit: 50 }) }));
riskRouter.post('/destination-changes/:id/revoke', writeLimit, (req, res) => {
  const c = getDestinationChange(String(req.params.id));
  if (c.userId !== req.user!.id) throw forbidden('Not your change', 'not_owner');
  res.json(revokeDestinationChange(c.id, { type: 'user', id: req.user!.id }));
});

// ---------------------------------------------------------------- agents
riskRouter.get('/agents/me/float', ...requireAgent, requireOrgPermission('agent:view'), (req, res) =>
  res.json({
    forecasts: floatForecast(req.user!.id),
    settings: { targetDays: getAgentIntelSettings().targetDays, alertDays: getAgentIntelSettings().alertDays },
    requests: listFloatRequests({ agentId: req.user!.id, limit: 20 }),
  }),
);
riskRouter.post('/agents/me/float/requests', ...requireAgent, requireOrgPermission('agent:float'), writeLimit, (req, res) => {
  const b = validate(
    z.object({
      currency: z.string().length(3),
      amount: z.string(),
      method: z.enum(['cash_deposit', 'bank_transfer', 'mobile_money']),
      reference: z.string().max(80).optional().nullable(),
      note: z.string().max(300).optional().nullable(),
    }),
    req.body,
  );
  const cur = getCurrency(b.currency);
  res.status(201).json(requestFloat(req.user!, { currency: cur.code, amountMinor: toMinor(b.amount, cur.decimals), method: b.method, reference: b.reference, note: b.note }));
});
riskRouter.get('/agents/me/trust', ...requireAgent, requireOrgPermission('agent:view'), (req, res) => {
  const latest = latestTrustScore(req.user!.id) ?? computeTrustScore(req.user!.id, true);
  res.json({ ...latest, commission: { cashIn: dynamicCommissionBps(req.user!, 'cash_in'), cashOut: dynamicCommissionBps(req.user!, 'cash_out') } });
});
riskRouter.post(
  '/agents/me/onboard',
  ...requireAgent,
  requireOrgPermission('agent:onboard'),
  writeLimit,
  wrap(async (req, res) => {
    const b = validate(
      z.object({
        fullName: z.string().min(2).max(120),
        phone: z.string().min(6).max(20),
        country: z.string().length(2),
        idPhoto: z.string().max(4_000_000).optional().nullable(),
        livePhoto: z.string().max(4_000_000).optional().nullable(),
        address: z.string().max(300).optional().nullable(),
        pin: z.string().optional(),
      }),
      req.body,
    );
    assertPin(req.actor ?? req.user!, b.pin, req); // a team member at the till confirms with their own PIN
    res.status(201).json(onboardCustomer(req.user!, b));
  }),
);
