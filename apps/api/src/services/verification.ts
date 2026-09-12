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
import { getPayout, getPayoutByTransaction, settlePayout, failPayout } from './payouts';
import { approveWithdrawal, rejectWithdrawal } from './withdrawals';
import { releaseRoute, refundRoute, getRouteRow } from './routing';
import { badRequest } from '../lib/errors';
import { hasPermission } from '../middleware/permissions';
import { executeIssuance, validateIssuanceRequest, clearReserveMovement, type IssuancePayload } from './emoney';

import { listEvents } from './events';

export type VerificationSubject = 'payment' | 'payout' | 'withdrawal' | 'route_release' | 'route_refund' | 'issuance' | 'reserve_funding';
export interface VerificationView {
  id: string;
  /** Id of the payment, payout instruction, withdrawal transaction or route being decided. */
  paymentId: string;
  subjectType: VerificationSubject;
  externalRef: string | null;
  payload: Record<string, unknown> | null;
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
  return { id: r.id, paymentId: r.payment_id, subjectType: r.subject_type ?? 'payment', externalRef: r.external_ref ?? null, payload: r.payload ? JSON.parse(r.payload) : null, action: r.action, note: r.note, evidenceId: r.evidence_id, proposedBy: pub(r.proposed_by), proposedAt: r.proposed_at, approvedBy: pub(r.approved_by), approvedAt: r.approved_at, declinedBy: pub(r.declined_by), declinedAt: r.declined_at, declineReason: r.decline_reason, status: r.status };
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

export function proposeVerification(user: UserRow, paymentId: string, input: { action: 'confirm' | 'reject'; note?: string | null; evidenceId?: string | null; subjectType?: VerificationSubject; externalRef?: string | null; payload?: Record<string, unknown> | null }): VerificationView {
  const subjectType: VerificationSubject = input.subjectType ?? 'payment';
  const db = getDb();
  if (subjectType === 'payment') {
    const payment = getPayment(paymentId);
    if (!OPEN_STAGES.includes(payment.stage as PaymentStage)) throw conflict(`Payment is ${payment.stage.toLowerCase()} and cannot be verified manually`, 'invalid_stage_transition');
  } else if (subjectType === 'payout' || subjectType === 'withdrawal') {
    const p = subjectType === 'payout' ? getPayout(paymentId) : getPayoutByTransaction(paymentId);
    if (!p) throw badRequest('No payout instruction for this transaction');
    if (['SETTLED', 'CANCELLED'].includes(p.stage)) throw conflict(`Payout is ${p.stage.toLowerCase()}`, 'invalid_stage_transition');
    // Administrative settlement requires documentary evidence: the operator / bank reference and what was checked.
    if (input.action === 'confirm' && (!input.externalRef || !input.note || input.note.trim().length < 8)) throw badRequest('Administrative settlement needs the operator/bank transaction reference and a note describing the documentary evidence checked', 'documentary_evidence_required');
  } else if (subjectType === 'issuance') {
    // Creating (or destroying) e-money by hand: only administrators holding the issuance permission may propose, and the payload must be complete.
    if (user.role !== 'admin' || !hasPermission(user as any, 'issuance')) throw forbidden('Only administrators with the issuance permission can create e-money', 'permission_denied');
    const p = input.payload as IssuancePayload | undefined;
    if (!p || !['credit', 'debit'].includes(p.direction) || !Number.isInteger(p.amount) || p.amount <= 0 || !p.currency || !p.reason) throw badRequest('Issuance payload needs direction, amount, currency and reason', 'validation_error');
    if (!p.poolId) findUserById(paymentId) ?? (() => { throw badRequest('Target user not found'); })();
    // The reserve rule is checked when the request is made and again when it is executed: a maker cannot queue an unbacked amount.
    validateIssuanceRequest(p);
  } else if (subjectType === 'reserve_funding') {
    if (user.role !== 'admin' || !hasPermission(user as any, 'treasury')) throw forbidden('Only treasury administrators can confirm safeguarded reserve funding', 'permission_denied');
    const m = db.prepare('SELECT * FROM reserve_movements WHERE id = ?').get(paymentId) as any;
    if (!m) throw badRequest('Reserve movement not found');
    if (m.status !== 'pending') throw conflict(`Reserve movement is already ${m.status}`, 'invalid_status');
  } else {
    getRouteRow(paymentId);
  }
  const open = db.prepare("SELECT id FROM manual_verifications WHERE payment_id = ? AND status = 'proposed'").get(paymentId);
  if (open) throw conflict('A decision is already awaiting approval for this item', 'verification_pending');
  if (input.evidenceId) getEvidence(input.evidenceId);
  const id = uuid();
  db.prepare('INSERT INTO manual_verifications (id, payment_id, action, note, evidence_id, proposed_by, proposed_at, status, subject_type, external_ref, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, paymentId, input.action, input.note ?? null, input.evidenceId ?? null, user.id, now(), 'proposed', subjectType, input.externalRef ?? null, input.payload ? JSON.stringify(input.payload) : null);
  recordEvent('approval', paymentId, 'verification.proposed', actorOf(user), { verificationId: id, subjectType, action: input.action, note: input.note ?? null, evidenceId: input.evidenceId ?? null, externalRef: input.externalRef ?? null });
  if (subjectType === 'payment' && getPayment(paymentId).stage !== 'VERIFYING') transitionStage(paymentId, 'VERIFYING', actorOf(user), { verificationId: id, action: input.action });
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
    if (row.subject_type === 'issuance' && !hasPermission(user as any, 'issuance')) throw forbidden('Approving e-money issuance requires the issuance permission', 'permission_denied');
    if (row.subject_type === 'reserve_funding' && !hasPermission(user as any, 'treasury')) throw forbidden('Confirming reserve funding requires the treasury permission', 'permission_denied');
    assertAdminStepUp(user, pin, req);
  }
  const db = getDb();
  db.prepare("UPDATE manual_verifications SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?").run(user.id, now(), id);
  recordEvent('approval', row.payment_id, 'verification.approved', actorOf(user), { verificationId: id, subjectType: row.subject_type, action: row.action, proposedBy: row.proposed_by, stepUp: !skipChecks });
  const subject: VerificationSubject = row.subject_type ?? 'payment';
  const actor = actorOf(user);
  if (subject === 'payment') {
    const payment = getPayment(row.payment_id);
    if (row.action === 'confirm') confirmAndSettle(payment, { actor, source: 'manual', verificationId: id, evidenceId: row.evidence_id, details: { proposedBy: row.proposed_by, approvedBy: user.id, note: row.note } });
    else rejectPayment(payment.id, actor, row.note || 'Rejected after manual verification');
  } else if (subject === 'payout') {
    if (row.action === 'confirm') settlePayout(row.payment_id, actor, { source: 'manual', externalRef: row.external_ref, verificationId: id, evidenceId: row.evidence_id, note: row.note });
    else failPayout(row.payment_id, actor, row.note || 'Rejected after manual verification', { verificationId: id });
  } else if (subject === 'withdrawal') {
    if (row.action === 'confirm') approveWithdrawal(row.payment_id, user.id, row.external_ref, id);
    else rejectWithdrawal(row.payment_id, user.id, row.note || 'Rejected after manual verification', id);
  } else if (subject === 'route_release') {
    releaseRoute(row.payment_id, actor, id, row.action === 'confirm');
  } else if (subject === 'route_refund') {
    if (row.action === 'confirm') void refundRoute(row.payment_id, actor, row.note || 'Refund approved', id);
  } else if (subject === 'issuance') {
    if (row.action === 'confirm') executeIssuance(row.payment_id, JSON.parse(row.payload), user, row.proposed_by, id);
  } else if (subject === 'reserve_funding') {
    if (row.action === 'confirm') clearReserveMovement(row.payment_id, user, id);
  }
  return getVerification(id);
}

export function declineVerification(user: UserRow, id: string, reason: string): VerificationView {
  const row = getDb().prepare('SELECT * FROM manual_verifications WHERE id = ?').get(id) as any;
  if (!row) throw notFound('Verification not found');
  if (row.status !== 'proposed') throw conflict(`Verification is already ${row.status}`, 'invalid_status');
  getDb().prepare("UPDATE manual_verifications SET status = 'declined', declined_by = ?, declined_at = ?, decline_reason = ? WHERE id = ?").run(user.id, now(), reason, id);
  recordEvent('approval', row.payment_id, 'verification.declined', actorOf(user), { verificationId: id, reason });
  if ((row.subject_type ?? 'payment') === 'payment') {
    const payment = getPayment(row.payment_id);
    if (payment.stage === 'VERIFYING') transitionStage(payment.id, 'MANUAL_REVIEW', actorOf(user), { verificationId: id, reason });
  }
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
