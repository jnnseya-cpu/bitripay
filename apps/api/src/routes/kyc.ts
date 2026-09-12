import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { submitKyc, latestKyc } from '../services/kyc';

export const kycRouter = Router();
kycRouter.use(requireAuth);
kycRouter.get('/', (req, res) => res.json({ submission: latestKyc(req.user!.id), status: req.user!.kyc_status }));
kycRouter.post(
  '/',
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        docType: z.enum(['passport', 'national_id', 'drivers_license', 'voter_card', 'other']),
        docNumber: z.string().min(3).max(60),
        fullName: z.string().min(2).max(120),
        dob: z.string().max(20).optional().nullable(),
        address: z.string().max(300).optional().nullable(),
        docFront: z.string().max(4_000_000).optional().nullable(),
        docBack: z.string().max(4_000_000).optional().nullable(),
        selfie: z.string().max(4_000_000).optional().nullable(),
        proofOfAddress: z.string().max(4_000_000).optional().nullable(),
        addressDocDate: z.string().max(40).optional().nullable(),
        liveness: z.boolean().optional().nullable(),
      }),
      req.body,
    );
    res.status(201).json({ submission: submitKyc(req.user!, body) });
  }),
);
