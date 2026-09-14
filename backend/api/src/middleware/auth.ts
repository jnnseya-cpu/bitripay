import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../lib/jwt';
import { forbidden, unauthorized } from '../lib/errors';
import { findUserById, type UserRow } from '../services/users';
import { getDb } from '../db';
import { sha256 } from '../lib/crypto';
import { now } from '../lib/ids';
import { getAppSettings, getSecuritySettings } from '../services/settings';
import type { Role } from '@bitripay/shared';
import type { ApiKeyScope } from '../services/merchant';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRow;
      apiKeyId?: string;
      apiKeyKind?: 'secret' | 'publishable' | 'restricted';
      apiKeyScopes?: string[];
      apiKeyMode?: 'live' | 'test';
      authVia?: 'jwt' | 'api_key';
    }
  }
}

function resolveBearer(req: Request): UserRow | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  // Merchant API keys: sk_/rk_/pk_ (secret, restricted, publishable) in live or test mode; legacy bp_ keys are secret keys.
  if (/^(bp|sk|rk|pk)_(live|test)_/.test(token)) {
    const row = getDb().prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL').get(sha256(token)) as any;
    if (!row) throw unauthorized('Invalid API key', 'invalid_api_key');
    if (row.ip_allowlist) {
      let allowed: string[] = [];
      try {
        allowed = JSON.parse(row.ip_allowlist);
      } catch {
        allowed = [];
      }
      const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
      if (allowed.length && !allowed.includes(ip)) throw forbidden('This API key cannot be used from this IP address', 'ip_not_allowed');
    }
    getDb().prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), row.id);
    req.apiKeyId = row.id;
    req.apiKeyKind = row.kind ?? 'secret';
    req.apiKeyMode = row.mode === 'test' ? 'test' : 'live';
    try {
      req.apiKeyScopes = JSON.parse(row.scopes || '["*"]');
    } catch {
      req.apiKeyScopes = ['*'];
    }
    req.authVia = 'api_key';
    return findUserById(row.user_id) ?? null;
  }
  const payload = verifyToken(token);
  if (!payload) throw unauthorized('Session expired. Please sign in again.', 'invalid_token');
  if (payload.mfa) throw unauthorized('Two-factor authentication required', 'mfa_required');
  req.authVia = 'jwt';
  return findUserById(payload.sub) ?? null;
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const user = resolveBearer(req);
    if (user && user.status === 'active') req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const user = resolveBearer(req);
    if (!user) throw unauthorized();
    if (user.status === 'suspended') throw forbidden('Your account has been suspended', 'account_suspended');
    assertTwoFactorPolicy(req, user);
    const app = getAppSettings();
    if (app.maintenanceMode && user.role !== 'admin' && req.method !== 'GET') {
      throw forbidden('The platform is under maintenance. Please try again later.', 'maintenance');
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Paths an account that must enable 2FA may still reach: the 2FA setup itself, its own profile, sign-out and what the
 * settings page needs to render (`/api/auth/me`, `/api/config`).
 */
const TWO_FACTOR_EXEMPT: { method?: string; test: (path: string) => boolean }[] = [
  { test: (p) => p.startsWith('/api/account/2fa/') },
  { method: 'GET', test: (p) => p === '/api/account/profile' },
  { test: (p) => p === '/api/auth/logout' },
  { test: (p) => p === '/api/auth/me' },
  { test: (p) => p === '/api/config' },
];

/** Whether an account of a required role is past its grace period without 2FA (null when the policy does not apply). */
export function twoFactorDeadline(user: Pick<UserRow, 'role' | 'two_factor_enabled' | 'created_at'>): { required: boolean; deadline: string | null; overdue: boolean } {
  const s = getSecuritySettings();
  const required = user.role === 'merchant' ? s.require2fa.merchant : user.role === 'agent' ? s.require2fa.agent : user.role === 'admin' ? s.require2fa.admin : false;
  if (!required || user.two_factor_enabled) return { required, deadline: null, overdue: false };
  const deadline = new Date(Date.parse(user.created_at) + Math.max(0, s.graceDays) * 86_400_000).toISOString();
  return { required, deadline, overdue: Date.now() >= Date.parse(deadline) };
}

/**
 * 2FA policy: when the security settings require two-factor authentication for the account's role and the grace
 * period since account creation has passed, session requests are refused with 403 two_factor_required until the
 * account enables it. Machine credentials (API keys) are not human sessions and are not affected.
 */
function assertTwoFactorPolicy(req: Request, user: UserRow) {
  if (req.authVia === 'api_key') return;
  const path = (req.originalUrl || req.url || '').split('?')[0];
  if (TWO_FACTOR_EXEMPT.some((e) => (!e.method || e.method === req.method) && e.test(path))) return;
  const policy = twoFactorDeadline(user);
  if (policy.overdue) throw forbidden('Two-factor authentication is required for your account. Enable it in Settings › Security to continue.', 'two_factor_required');
}

/** Resolves the partially-authenticated user during the 2FA step of login. */
export function requireMfaToken(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next(unauthorized());
  const payload = verifyToken(header.slice(7));
  if (!payload) return next(unauthorized('Session expired', 'invalid_token'));
  const user = findUserById(payload.sub);
  if (!user) return next(unauthorized());
  req.user = user;
  next();
}

/**
 * Scope check for API-key callers. Sessions (JWT) carry every scope; secret keys carry `*`; restricted keys must list
 * the scope; publishable keys only pass for scopes they were issued with (public intent reads).
 */
export function requireScope(...scopes: ApiKeyScope[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.authVia !== 'api_key') return next();
    const held = req.apiKeyScopes ?? ['*'];
    if (held.includes('*') || scopes.some((s) => held.includes(s))) return next();
    next(forbidden(`This API key does not have the ${scopes.join(' or ')} scope`, 'scope_denied'));
  };
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden(`This action requires role: ${roles.join(' or ')}`, 'role_required'));
    next();
  };
}

export const requireAdmin = [requireAuth, requireRole('admin')];
export const requireMerchant = [requireAuth, requireRole('merchant', 'admin')];
export const requireAgent = [requireAuth, requireRole('agent', 'admin')];
