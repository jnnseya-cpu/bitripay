import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { conflict, notFound } from '../lib/errors';
import { updateUser, type UserRow, toPublicUser, findUserById } from './users';
import { notify } from './notifications';

export function toKyc(r: any, includeDocs = false) {
  return {
    id: r.id,
    userId: r.user_id,
    docType: r.doc_type,
    docNumber: r.doc_number,
    fullName: r.full_name,
    dob: r.dob,
    address: r.address,
    status: r.status,
    note: r.note,
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
    ...(includeDocs ? { docFront: r.doc_front, docBack: r.doc_back, selfie: r.selfie } : { hasDocFront: !!r.doc_front, hasDocBack: !!r.doc_back, hasSelfie: !!r.selfie }),
    user: findUserById(r.user_id) ? toPublicUser(findUserById(r.user_id)!) : null,
  };
}

export function submitKyc(user: UserRow, input: { docType: string; docNumber: string; fullName: string; dob?: string | null; address?: string | null; docFront?: string | null; docBack?: string | null; selfie?: string | null }) {
  const db = getDb();
  if (user.kyc_status === 'verified') throw conflict('Your identity is already verified');
  const pending = db.prepare("SELECT id FROM kyc_submissions WHERE user_id = ? AND status = 'pending'").get(user.id);
  if (pending) throw conflict('You already have a submission under review', 'kyc_pending');
  const id = uuid();
  db.prepare('INSERT INTO kyc_submissions (id, user_id, doc_type, doc_number, full_name, dob, address, doc_front, doc_back, selfie, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    user.id,
    input.docType,
    input.docNumber,
    input.fullName,
    input.dob ?? null,
    input.address ?? null,
    input.docFront ?? null,
    input.docBack ?? null,
    input.selfie ?? null,
    'pending',
    now(),
  );
  updateUser(user.id, { kyc_status: 'pending' });
  return toKyc(db.prepare('SELECT * FROM kyc_submissions WHERE id = ?').get(id));
}

export function latestKyc(userId: string) {
  const row = getDb().prepare('SELECT * FROM kyc_submissions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(userId);
  return row ? toKyc(row) : null;
}

export function listKyc(status?: string, page = 1, pageSize = 20) {
  const db = getDb();
  const where = status ? 'WHERE status = ?' : '';
  const params = status ? [status] : [];
  const total = (db.prepare(`SELECT COUNT(*) c FROM kyc_submissions ${where}`).get(...params) as any).c;
  const rows = db.prepare(`SELECT * FROM kyc_submissions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
  return { items: rows.map((r) => toKyc(r)), total };
}

export function getKyc(id: string) {
  const row = getDb().prepare('SELECT * FROM kyc_submissions WHERE id = ?').get(id);
  if (!row) throw notFound('Submission not found');
  return toKyc(row, true);
}

export function reviewKyc(id: string, adminId: string, decision: 'verified' | 'rejected', note?: string) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM kyc_submissions WHERE id = ?').get(id) as any;
  if (!row) throw notFound('Submission not found');
  if (row.status !== 'pending') throw conflict('Submission already reviewed');
  db.prepare('UPDATE kyc_submissions SET status = ?, note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?').run(decision, note ?? null, adminId, now(), id);
  updateUser(row.user_id, { kyc_status: decision });
  notify(row.user_id, decision === 'verified' ? 'Identity verified' : 'Verification rejected', decision === 'verified' ? 'Your KYC verification was approved. Higher limits are now active.' : `Your KYC submission was rejected${note ? `: ${note}` : ''}. You can submit again.`, { kind: 'kyc' });
  return toKyc(db.prepare('SELECT * FROM kyc_submissions WHERE id = ?').get(id));
}
