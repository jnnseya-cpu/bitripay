import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { findUserById, toPublicUser } from './users';

export function audit(adminId: string, action: string, targetType?: string, targetId?: string, details: Record<string, unknown> = {}) {
  getDb().prepare('INSERT INTO audit_logs (id, admin_id, action, target_type, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(uuid(), adminId, action, targetType ?? null, targetId ?? null, JSON.stringify(details), now());
}

export function listAuditLogs(page: number, pageSize: number, search?: string) {
  const db = getDb();
  const where = search ? 'WHERE action LIKE ? OR target_id LIKE ?' : '';
  const params = search ? [`%${search}%`, `%${search}%`] : [];
  const total = (db.prepare(`SELECT COUNT(*) c FROM audit_logs ${where}`).get(...params) as any).c;
  const rows = db.prepare(`SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as any[];
  return {
    items: rows.map((r) => ({ id: r.id, adminId: r.admin_id, admin: findUserById(r.admin_id) ? toPublicUser(findUserById(r.admin_id)!) : null, action: r.action, targetType: r.target_type, targetId: r.target_id, details: JSON.parse(r.details || '{}'), createdAt: r.created_at })),
    total,
  };
}
