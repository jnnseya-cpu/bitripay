import type { Request, Response, NextFunction } from 'express';
import { forbidden } from '../lib/errors';
import { parseJson } from '../lib/json';

export const ADMIN_PERMISSIONS = [
  'users',
  'transactions',
  'approvals',
  'kyc',
  'settings',
  'gateways',
  'catalogs',
  'cms',
  'support',
  'p2p',
  'reports',
  'admins',
  'issuance',
  'treasury',
  'agents',
  /** Payment Operations: investigate switch payments, request inquiries, open incidents (never alter amounts, evidence or finality). */
  'switch',
  /** Reconciliation Analyst: import reports, match evidence, propose resolutions (never approve own closure). */
  'reconciliation',
  /** Security Administrator: identities, keys, certificates, security incidents. */
  'security',
  /** Compliance Officer: case review, restrictions, authorised reports. */
  'compliance',
] as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

/** Super admins (empty permissions list, or "*") can do everything; staff admins get explicit permissions. */
export function hasPermission(user: { permissions?: string; tag?: string } | undefined, permission: AdminPermission): boolean {
  if (!user) return false;
  const perms = parseJson<string[]>((user as any).permissions, []);
  if (perms.length === 0 || perms.includes('*')) return true;
  return perms.includes(permission);
}

export function requirePermission(permission: AdminPermission) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!hasPermission(req.user as any, permission)) return next(forbidden(`Missing admin permission: ${permission}`, 'permission_denied'));
    next();
  };
}
