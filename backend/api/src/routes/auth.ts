import { Router } from 'express';
import { AppError } from '../lib/errors';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { rateLimit } from '../middleware/rateLimit';
import { requireAuth, requireMfaToken } from '../middleware/auth';
import * as auth from '../services/auth';
import { toUser } from '../services/users';
import { verifyOtp } from '../services/otp';
import { issueOtp } from '../services/otp';
import { normalizeEmail, normalizePhone, findUserByEmail, findUserByPhone, isMerchantRole } from '../services/users';
import { onMerchantClassRegistered } from '../services/organisations';
import { signToken } from '../lib/jwt';
import { badRequest, conflict } from '../lib/errors';

export const authRouter = Router();
const authLimit = rateLimit({ windowMs: 15 * 60_000, max: 30, keyPrefix: 'auth' });
/**
 * Per-account throttle on sign-in failures: credential stuffing spread across many addresses still meets a wall per
 * identifier (10 failures in 15 minutes); a successful sign-in clears the count. In memory, like the client limiter.
 */
const LOGIN_FAILURES = new Map<string, number[]>();
const LOGIN_FAIL_MAX = 10;
const LOGIN_FAIL_WINDOW_MS = 15 * 60_000;
function loginFailureKey(identifier: string) {
  return identifier.trim().toLowerCase();
}
function assertAccountNotThrottled(identifier: string) {
  const since = Date.now() - LOGIN_FAIL_WINDOW_MS;
  const stamps = (LOGIN_FAILURES.get(loginFailureKey(identifier)) ?? []).filter((t) => t > since);
  if (stamps.length >= LOGIN_FAIL_MAX)
    throw new AppError(429, 'rate_limited', 'Too many failed sign-in attempts for this account. Try again later or reset your password.', {
      retryAfterSeconds: Math.ceil((stamps[0] + LOGIN_FAIL_WINDOW_MS - Date.now()) / 1000),
      scope: 'auth_account',
    });
}
function recordLoginFailure(identifier: string) {
  const key = loginFailureKey(identifier);
  const since = Date.now() - LOGIN_FAIL_WINDOW_MS;
  const stamps = (LOGIN_FAILURES.get(key) ?? []).filter((t) => t > since);
  stamps.push(Date.now());
  LOGIN_FAILURES.set(key, stamps);
  if (LOGIN_FAILURES.size > 50_000) LOGIN_FAILURES.clear();
}

const registerSchema = z.object({
  fullName: z.string().min(2).max(120),
  email: z.string().email().optional().nullable(),
  phone: z.string().min(7).max(20).optional().nullable(),
  password: z.string().min(8).max(200),
  /** Personal, agent or one of the merchant-class account types (merchant, corporate, ngo, government, developer); merchant-class sign-ups own an organisation. */
  role: z.enum(['user', 'merchant', 'agent', 'corporate', 'ngo', 'government', 'developer']).optional(),
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
    // merchant-class account types register as merchants, then take their class and organisation (§43)
    const result = auth.register({ ...body, role: body.role && isMerchantRole(body.role) ? 'merchant' : body.role, emailVerified, phoneVerified });
    if (body.role && isMerchantRole(body.role)) {
      const user = onMerchantClassRegistered(result.user.id, body.role);
      res.status(201).json({ ...result, token: signToken({ sub: user.id, role: user.role }), user: toUser(user) });
      return;
    }
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
    assertAccountNotThrottled(body.identifier);
    try {
      res.json(auth.login(body.identifier, body.password));
    } catch (err) {
      if (err instanceof AppError && err.status === 401) recordLoginFailure(body.identifier);
      throw err;
    }
    LOGIN_FAILURES.delete(loginFailureKey(body.identifier));
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
