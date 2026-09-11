/**
 * Manual verification console with maker-checker: one authorised person proposes a settlement
 * decision after checking the operator/bank statement, a different authorised person approves it
 * under a fresh biometric/PIN step-up. Only an approved "confirm" can settle; every step is logged.
 */
import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { conflict, forbidden, notFound } from '../lib/errors';
import { getGatewayControls } from './settings';
import { recordEvent, type Actor } from './events';
import { OPEN_STAGES, transitionStage, type PaymentStage } from './lifecycle';
import { confirmAndSettle, getPayment, rejectPayment, toPaymentView } from './payments';
import { assertPin } from './auth';
import { findUserById, toPublicUser, type UserRow } from './users';
import { getEvidence, listEvidence } from './evidence';
import { listEvents } from './events';

export interface VerificationView {
  id: string;
  paymentId: string;
  action: 'confirm' | 'reject';
  note: string | null;
  evidenceId: string | null;
  proposedBy: ReturnType<typeof toPublicUser> | null;
  proposedAt: string;
  approvedBy: ReturnType<typeof toPublicUser> | null;
  approvedAt: string | null;
  declinedBy: ReturnType<typeof toPublicUser> | null;
  declinedAt: string | null;
  declineReason: string | null;
  status: 'proposed' | 'approved' | 'declined';
}

function pub(id: string | null) {
  const u = id ? findUserById(id) : null;
  return u ? toPublicUser(u) : null;
}
function toView(r: any): VerificationView {
  return { id: r.id, paymentId: r.payment_id, action: r.action, note: r.note, evidenceId: r.evidence_id, proposedBy: pub(r.proposed_by), proposedAt: r.proposed_at, approvedBy: pub(r.approved_by), approvedAt: r.approved_at, declinedBy: pub(r.declined_by), declinedAt: r.declined_at, declineReason: r.decline_reason, status: r.status };
}

function actorOf(user: UserRow): Actor {
  return { type: user.role === 'admin' ? 'admin' : 'agent', id: user.id };
}

/** Administrative approvals need a fresh passkey step-up or the admin's PIN (configurable). */
export function assertAdminStepUp(user: UserRow, pin: string | undefined, req: { headers?: Record<string, unknown>; body?: any }) {
  if (!getGatewayControls().adminStepUp) return;
  try {
    assertPin(user, pin, req);
  } catch (err: any) {
    if (err?.code === 'pin_required') throw forbidden('Administrative approvals require biometric step-up or a PIN. Set one in your security settings.', 'step_up_required');
    throw err;
  }
}

export function proposeVerification(user: UserRow, paymentId: string, input: { action: 'confirm' | 'reject'; note?: string | null; evidenceId?: string | null }): VerificationView {
  const payment = getPayment(paymentId);
  if (!OPEN_STAGES.includes(payment.stage as PaymentStage)) throw conflict(`Payment is ${payment.stage.toLowerCase()} and cannot be verified manually`, 'invalid_stage_transition');
  const db = getDb();
  const open = db.prepare("SELECT id FROM manual_verifications WHERE payment_id = ? AND status = 'proposed'").get(paymentId);
  if (open) throw conflict('A verification decision is already awaiting approval for this payment', 'verification_pending');
  if (input.evidenceId) getEvidence(input.evidenceId);
  const id = uuid();
  db.prepare('INSERT INTO manual_verifications (id, payment_id, action, note, evidence_id, proposed_by, proposed_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, paymentId, input.action, input.note ?? null, input.evidenceId ?? null, user.id, now(), 'proposed');
  recordEvent('approval', paymentId, 'verification.proposed', actorOf(user), { verificationId: id, action: input.action, note: input.note ?? null, evidenceId: input.evidenceId ?? null });
  if (payment.stage !== 'VERIFYING') transitionStage(paymentId, 'VERIFYING', actorOf(user), { verificationId: id, action: input.action });
  const controls = getGatewayControls();
  if (!controls.makerChecker) return approveVerification(user, id, undefined, { headers: {}, body: {} }, true);
  return getVerification(id);
}

export function approveVerification(user: UserRow, id: string, pin: string | undefined, req: { headers?: Record<string, unknown>; body?: any }, skipChecks = false): VerificationView {
  const row = getDb().prepare('SELECT * FROM manual_verifications WHERE id = ?').get(id) as any;
  if (!row) throw notFound('Verification not found');
  if (row.status !== 'proposed') throw conflict(`Verification is already ${row.status}`, 'invalid_status');
  if (!skipChecks) {
    if (getGatewayControls().makerChecker && row.proposed_by === user.id) throw forbidden('Maker-checker: the person who proposed a decision cannot approve it', 'maker_checker');
    if (user.role !== 'admin') throw forbidden('Only administrators can approve manual settlement', 'role_required');
    assertAdminStepUp(user, pin, req);
  }
  const db = getDb();
  db.prepare("UPDATE manual_verifications SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?").run(user.id, now(), id);
  recordEvent('approval', row.payment_id, 'verification.approved', actorOf(user), { verificationId: id, action: row.action, proposedBy: row.proposed_by, stepUp: !skipChecks });
  const payment = getPayment(row.payment_id);
  if (row.action === 'confirm') {
    confirmAndSettle(payment, { actor: actorOf(user), source: 'manual', verificationId: id, evidenceId: row.evidence_id, details: { proposedBy: row.proposed_by, approvedBy: user.id, note: row.note } });
  } else {
    rejectPayment(payment.id, actorOf(user), row.note || 'Rejected after manual verification');
  }
  return getVerification(id);
}

export function declineVerification(user: UserRow, id: string, reason: string): VerificationView {
  const row = getDb().prepare('SELECT * FROM manual_verifications WHERE id = ?').get(id) as any;
  if (!row) throw notFound('Verification not found');
  if (row.status !== 'proposed') throw conflict(`Verification is already ${row.status}`, 'invalid_status');
  getDb().prepare("UPDATE manual_verifications SET status = 'declined', declined_by = ?, declined_at = ?, decline_reason = ? WHERE id = ?").run(user.id, now(), reason, id);
  recordEvent('approval', row.payment_id, 'verification.declined', actorOf(user), { verificationId: id, reason });
  const payment = getPayment(row.payment_id);
  if (payment.stage === 'VERIFYING') transitionStage(payment.id, 'MANUAL_REVIEW', actorOf(user), { verificationId: id, reason });
  return getVerification(id);
}

export function getVerification(id: string): VerificationView {
  const row = getDb().prepare('SELECT * FROM manual_verifications WHERE id = ?').get(id);
  if (!row) throw notFound('Verification not found');
  return toView(row);
}

export function listVerifications(filter: { status?: string | null; paymentId?: string | null } = {}): VerificationView[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.paymentId) {
    where.push('payment_id = ?');
    params.push(filter.paymentId);
  }
  const rows = getDb().prepare(`SELECT * FROM manual_verifications ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY proposed_at DESC LIMIT 200`).all(...params) as any[];
  return rows.map(toView);
}

/** Everything a verifier needs for one payment: the intent, its evidence, decisions and full event history. */
export function verificationCase(paymentId: string) {
  const payment = getPayment(paymentId);
  const user = payment.user_id ? findUserById(payment.user_id) : null;
  return {
    payment: toPaymentView(payment),
    user: user ? toPublicUser(user) : null,
    payer: { email: payment.payer_email, phone: payment.payer_phone, name: payment.payer_name },
    proof: (JSON.parse(payment.metadata || '{}') as any).proof ?? null,
    riskFlags: (JSON.parse(payment.metadata || '{}') as any).riskFlags ?? [],
    evidence: listEvidence({ paymentId }).items,
    verifications: listVerifications({ paymentId }),
    events: listEvents({ subjectId: paymentId, limit: 200 }).items,
  };
}
