import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../lib/jwt';
import { forbidden, unauthorized } from '../lib/errors';
import { findUserById, type UserRow } from '../services/users';
import { getDb } from '../db';
import { sha256 } from '../lib/crypto';
import { now } from '../lib/ids';
import { getAppSettings } from '../services/settings';
import type { Role } from '@bitripay/shared';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRow;
      apiKeyId?: string;
      authVia?: 'jwt' | 'api_key';
    }
  }
}

function resolveBearer(req: Request): UserRow | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  // Merchant API keys: bp_live_xxx / bp_test_xxx
  if (token.startsWith('bp_live_') || token.startsWith('bp_test_')) {
    const row = getDb().prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL').get(sha256(token)) as any;
    if (!row) throw unauthorized('Invalid API key', 'invalid_api_key');
    getDb().prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), row.id);
    req.apiKeyId = row.id;
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
