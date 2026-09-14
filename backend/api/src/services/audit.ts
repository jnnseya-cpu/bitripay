import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { findUserById, toPublicUser } from './users';
import { currentRequestContext } from '../middleware/correlation';

export type AuditResult = 'ok' | 'denied' | 'error';
export interface AuditOptions {
  /** Outcome of the audited action (default 'ok'). */
  result?: AuditResult;
  /** Why it was denied / failed. */
  reason?: string | null;
  /** Overrides for callers outside a request (jobs); otherwise taken from the request context. */
  correlationId?: string | null;
  ip?: string | null;
  device?: string | null;
}

/**
 * Append an audit entry. The correlation id, client address and device are read from the request context
 * (middleware/correlation) so every existing caller is enriched without changing its call.
 */
export function audit(adminId: string, action: string, targetType?: string, targetId?: string, details: Record<string, unknown> = {}, options: AuditOptions = {}) {
  const ctx = currentRequestContext();
  getDb()
    .prepare('INSERT INTO audit_logs (id, admin_id, action, target_type, target_id, details, correlation_id, ip, device, result, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      uuid(),
      adminId,
      action,
      targetType ?? null,
      targetId ?? null,
      JSON.stringify(details),
      options.correlationId ?? ctx?.correlationId ?? null,
      options.ip ?? ctx?.ip ?? null,
      options.device ?? ctx?.device ?? null,
      options.result ?? 'ok',
      options.reason ?? null,
      now(),
    );
}

export function listAuditLogs(page: number, pageSize: number, search?: string) {
  const db = getDb();
  const where = search ? 'WHERE action LIKE ? OR target_id LIKE ? OR correlation_id LIKE ?' : '';
  const params = search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [];
  const total = (db.prepare(`SELECT COUNT(*) c FROM audit_logs ${where}`).get(...params) as any).c;
  const rows = db.prepare(`SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as any[];
  return {
    items: rows.map((r) => ({
      id: r.id,
      adminId: r.admin_id,
      admin: findUserById(r.admin_id) ? toPublicUser(findUserById(r.admin_id)!) : null,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      details: JSON.parse(r.details || '{}'),
      correlationId: r.correlation_id ?? null,
      ip: r.ip ?? null,
      device: r.device ?? null,
      result: (r.result ?? 'ok') as AuditResult,
      reason: r.reason ?? null,
      createdAt: r.created_at,
    })),
    total,
  };
}
