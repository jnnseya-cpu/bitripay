import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../lib/jwt';
import { forbidden, unauthorized } from '../lib/errors';
import { findUserById, type UserRow } from '../services/users';
import { getDb } from '../db';
import { sha256 } from '../lib/crypto';
import { now } from '../lib/ids';
import { getAppSettings } from '../services/settings';
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
