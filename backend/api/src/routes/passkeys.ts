import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { registrationOptions, verifyRegistration, listPasskeys, deletePasskey, authenticationOptions, verifyAuthentication, issueStepUpToken } from '../services/webauthn';
import { finishLogin } from '../services/auth';
import { toUser } from '../services/users';

/** Passkey management + biometric step-up for the signed-in user. */
export const passkeysRouter = Router();
passkeysRouter.use(requireAuth);
passkeysRouter.get('/', (req, res) => res.json({ items: listPasskeys(req.user!.id) }));
passkeysRouter.post(
  '/register/options',
  wrap(async (req, res) => res.json(await registrationOptions(req.user!))),
);
passkeysRouter.post(
  '/register/verify',
  wrap(async (req, res) => {
    const body = validate(z.object({ challengeId: z.string(), response: z.any(), deviceName: z.string().max(80).optional().nullable() }), req.body);
    res.json({ items: await verifyRegistration(req.user!, body.challengeId, body.response, body.deviceName) });
  }),
);
passkeysRouter.delete('/:id', (req, res) => {
  deletePasskey(req.user!.id, String(req.params.id));
  res.json({ ok: true });
});
/** Biometric confirmation for payments: returns a 5-minute step-up token accepted instead of the PIN. */
passkeysRouter.post(
  '/step-up/options',
  wrap(async (req, res) => res.json(await authenticationOptions('step_up', req.user!))),
);
passkeysRouter.post(
  '/step-up/verify',
  wrap(async (req, res) => {
    const body = validate(z.object({ challengeId: z.string(), response: z.any() }), req.body);
    await verifyAuthentication('step_up', body.challengeId, body.response, req.user!);
    res.json(issueStepUpToken(req.user!));
  }),
);

/** Passwordless biometric sign-in (public). */
export const passkeyAuthRouter = Router();
const limit = rateLimit({ windowMs: 15 * 60_000, max: 40, keyPrefix: 'passkey-auth' });
passkeyAuthRouter.post(
  '/options',
  limit,
  wrap(async (_req, res) => res.json(await authenticationOptions('login'))),
);
passkeyAuthRouter.post(
  '/verify',
  limit,
  wrap(async (req, res) => {
    const body = validate(z.object({ challengeId: z.string(), response: z.any() }), req.body);
    const user = await verifyAuthentication('login', body.challengeId, body.response);
    // A passkey already proves possession + biometrics, so 2FA is satisfied.
    const result = finishLogin({ ...user, two_factor_enabled: 0 });
    res.json({ ...result, user: toUser(user) });
  }),
);
