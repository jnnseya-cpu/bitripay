import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { rateLimit } from '../middleware/rateLimit';
import { requireAuth, requireMfaToken } from '../middleware/auth';
import * as auth from '../services/auth';
import { toUser } from '../services/users';
import { verifyOtp } from '../services/otp';
import { issueOtp } from '../services/otp';
import { normalizeEmail, normalizePhone, findUserByEmail, findUserByPhone } from '../services/users';
import { badRequest, conflict } from '../lib/errors';

export const authRouter = Router();
const authLimit = rateLimit({ windowMs: 15 * 60_000, max: 30, keyPrefix: 'auth' });

const registerSchema = z.object({
  fullName: z.string().min(2).max(120),
  email: z.string().email().optional().nullable(),
  phone: z.string().min(7).max(20).optional().nullable(),
  password: z.string().min(8).max(200),
  role: z.enum(['user', 'merchant', 'agent']).optional(),
  tag: z.string().min(3).max(20).optional(),
  country: z.string().length(2).optional().nullable(),
  businessName: z.string().max(120).optional().nullable(),
  referralCode: z.string().max(30).optional().nullable(),
  /** Code from /auth/otp/request with purpose "register" – marks the email/phone verified on signup. */
  otpCode: z.string().optional().nullable(),
});

authRouter.post(
  '/register',
  authLimit,
  wrap(async (req, res) => {
    const body = validate(registerSchema, req.body);
    if (!body.email && !body.phone) throw badRequest('Email or phone number is required');
    let emailVerified = false;
    let phoneVerified = false;
    if (body.otpCode) {
      const target = body.phone ? normalizePhone(body.phone)! : normalizeEmail(body.email)!;
      const ok = verifyOtp(target, 'register', body.otpCode);
      if (!ok) throw badRequest('Invalid or expired verification code', 'invalid_otp');
      if (body.phone) phoneVerified = true;
      else emailVerified = true;
    }
    const result = auth.register({ ...body, emailVerified, phoneVerified });
    res.status(201).json(result);
  }),
);

/** Pre-registration OTP (phone or email) so accounts start verified. */
authRouter.post(
  '/otp/request',
  authLimit,
  wrap(async (req, res) => {
    const body = validate(z.object({ identifier: z.string().min(3), purpose: z.enum(['register', 'login', 'reset_password']).default('login') }), req.body);
    const isEmail = body.identifier.includes('@');
    const target = isEmail ? normalizeEmail(body.identifier)! : normalizePhone(body.identifier)!;
    if (body.purpose === 'register') {
      if (isEmail ? findUserByEmail(target) : findUserByPhone(target)) throw conflict('An account with this identifier already exists', isEmail ? 'email_taken' : 'phone_taken');
      res.json(await issueOtp(isEmail ? 'email' : 'sms', target, 'register'));
    } else if (body.purpose === 'login') {
      res.json(await auth.requestOtpLogin(body.identifier));
    } else {
      res.json(await auth.requestPasswordReset(body.identifier));
    }
  }),
);

authRouter.post(
  '/otp/verify',
  authLimit,
  wrap(async (req, res) => {
    const body = validate(z.object({ identifier: z.string().min(3), code: z.string().min(4).max(8) }), req.body);
    res.json(auth.verifyOtpLogin(body.identifier, body.code));
  }),
);

authRouter.post(
  '/login',
  authLimit,
  wrap(async (req, res) => {
    const body = validate(z.object({ identifier: z.string().min(3), password: z.string().min(1) }), req.body);
    res.json(auth.login(body.identifier, body.password));
  }),
);

authRouter.post(
  '/2fa/verify',
  authLimit,
  requireMfaToken,
  wrap(async (req, res) => {
    // a 6–8 digit authenticator code or a one-time recovery code (xxxx-xxxx)
    const body = validate(z.object({ code: z.string().min(6).max(12) }), req.body);
    res.json(auth.completeTwoFactor(req.user!, body.code));
  }),
);

authRouter.post(
  '/password/forgot',
  authLimit,
  wrap(async (req, res) => {
    const body = validate(z.object({ identifier: z.string().min(3) }), req.body);
    res.json(await auth.requestPasswordReset(body.identifier));
  }),
);

authRouter.post(
  '/password/reset',
  authLimit,
  wrap(async (req, res) => {
    const body = validate(z.object({ identifier: z.string().min(3), code: z.string().min(4).max(8), password: z.string().min(8) }), req.body);
    auth.resetPassword(body.identifier, body.code, body.password);
    res.json({ ok: true });
  }),
);

authRouter.get('/me', requireAuth, (req, res) => res.json({ user: toUser(req.user!) }));
