/**
 * Payment intent lifecycle. Every gateway payment moves through:
 *   CREATED → AUTHENTICATION_REQUIRED → INSTRUCTION_ISSUED → PAYMENT_SENT → EVIDENCE_RECEIVED → VERIFYING → CONFIRMED → SETTLED
 * with exception states EXPIRED · REJECTED · MISMATCHED · DUPLICATE · DISPUTED · REVERSED · MANUAL_REVIEW.
 * Stage changes are validated against the transition table and appended to the immutable event log.
 * The legacy `status` column (initiated/pending/succeeded/failed/cancelled) is derived from the stage.
 */
import { getDb } from '../db';
import { now } from '../lib/ids';
import { conflict } from '../lib/errors';
import { recordEvent, type Actor } from './events';

export const PAYMENT_STAGES = ['CREATED', 'AUTHENTICATION_REQUIRED', 'INSTRUCTION_ISSUED', 'PAYMENT_SENT', 'EVIDENCE_RECEIVED', 'VERIFYING', 'CONFIRMED', 'SETTLED', 'EXPIRED', 'REJECTED', 'MISMATCHED', 'DUPLICATE', 'DISPUTED', 'REVERSED', 'MANUAL_REVIEW'] as const;
export type PaymentStage = (typeof PAYMENT_STAGES)[number];

export const TERMINAL_STAGES: PaymentStage[] = ['SETTLED', 'EXPIRED', 'REJECTED', 'REVERSED'];
/** Stages in which new evidence or a manual decision may still move the intent forward. */
export const OPEN_STAGES: PaymentStage[] = ['INSTRUCTION_ISSUED', 'PAYMENT_SENT', 'EVIDENCE_RECEIVED', 'VERIFYING', 'MANUAL_REVIEW', 'MISMATCHED', 'DUPLICATE', 'DISPUTED'];

const TRANSITIONS: Record<PaymentStage, PaymentStage[]> = {
  CREATED: ['AUTHENTICATION_REQUIRED', 'INSTRUCTION_ISSUED', 'REJECTED', 'EXPIRED'],
  AUTHENTICATION_REQUIRED: ['INSTRUCTION_ISSUED', 'REJECTED', 'EXPIRED'],
  INSTRUCTION_ISSUED: ['PAYMENT_SENT', 'EVIDENCE_RECEIVED', 'VERIFYING', 'REJECTED', 'EXPIRED', 'MANUAL_REVIEW', 'MISMATCHED', 'DUPLICATE'],
  PAYMENT_SENT: ['EVIDENCE_RECEIVED', 'VERIFYING', 'REJECTED', 'EXPIRED', 'MANUAL_REVIEW', 'MISMATCHED', 'DUPLICATE', 'DISPUTED'],
  EVIDENCE_RECEIVED: ['VERIFYING', 'MANUAL_REVIEW', 'MISMATCHED', 'DUPLICATE', 'REJECTED'],
  VERIFYING: ['CONFIRMED', 'MANUAL_REVIEW', 'MISMATCHED', 'DUPLICATE', 'REJECTED'],
  CONFIRMED: ['SETTLED', 'MANUAL_REVIEW', 'REJECTED'],
  SETTLED: ['DISPUTED', 'REVERSED'],
  MANUAL_REVIEW: ['VERIFYING', 'REJECTED', 'EXPIRED', 'EVIDENCE_RECEIVED'],
  MISMATCHED: ['VERIFYING', 'MANUAL_REVIEW', 'REJECTED', 'EXPIRED', 'EVIDENCE_RECEIVED'],
  DUPLICATE: ['VERIFYING', 'MANUAL_REVIEW', 'REJECTED', 'EXPIRED', 'EVIDENCE_RECEIVED'],
  DISPUTED: ['VERIFYING', 'MANUAL_REVIEW', 'REVERSED', 'SETTLED', 'REJECTED'],
  EXPIRED: [],
  REJECTED: [],
  REVERSED: [],
};

export function stageToStatus(stage: PaymentStage): 'initiated' | 'pending' | 'succeeded' | 'failed' | 'cancelled' {
  switch (stage) {
    case 'CREATED':
    case 'AUTHENTICATION_REQUIRED':
      return 'initiated';
    case 'SETTLED':
      return 'succeeded';
    case 'EXPIRED':
    case 'REJECTED':
      return 'failed';
    case 'REVERSED':
      return 'cancelled';
    default:
      return 'pending';
  }
}

/** Human labels that make the difference between initiated, confirmed and settled explicit. */
export const STAGE_LABELS: Record<PaymentStage, { label: string; group: 'initiated' | 'confirmed' | 'settled' | 'exception'; description: string }> = {
  CREATED: { label: 'Created', group: 'initiated', description: 'Payment intent created. No money has moved.' },
  AUTHENTICATION_REQUIRED: { label: 'Authentication required', group: 'initiated', description: 'Confirm with biometrics or your PIN to continue.' },
  INSTRUCTION_ISSUED: { label: 'Instructions issued', group: 'initiated', description: 'Follow the payment instructions. Nothing is credited until the payment is confirmed.' },
  PAYMENT_SENT: { label: 'Reported as sent', group: 'initiated', description: 'You told us the payment was sent. We are waiting for independent confirmation.' },
  EVIDENCE_RECEIVED: { label: 'Evidence received', group: 'initiated', description: 'A payment notification was received and is being checked.' },
  VERIFYING: { label: 'Verifying', group: 'initiated', description: 'Reference, amount, currency, sender and timing are being matched.' },
  CONFIRMED: { label: 'Confirmed', group: 'confirmed', description: 'The external payment was independently confirmed. Ledger posting is in progress.' },
  SETTLED: { label: 'Settled', group: 'settled', description: 'Funds are posted to the ledger and available.' },
  EXPIRED: { label: 'Expired', group: 'exception', description: 'No confirmation arrived in time. Nothing was credited.' },
  REJECTED: { label: 'Rejected', group: 'exception', description: 'The payment was rejected. Nothing was credited.' },
  MISMATCHED: { label: 'Mismatched', group: 'exception', description: 'The evidence did not match the reference, amount, currency or sender. Under review.' },
  DUPLICATE: { label: 'Duplicate', group: 'exception', description: 'The evidence was already used for another payment. Under review.' },
  DISPUTED: { label: 'Disputed', group: 'exception', description: 'This payment is disputed.' },
  REVERSED: { label: 'Reversed', group: 'exception', description: 'The settled amount was reversed.' },
  MANUAL_REVIEW: { label: 'Manual review', group: 'exception', description: 'A verifier must review this payment before it can settle.' },
};

export function canTransition(from: PaymentStage, to: PaymentStage): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function currentStage(paymentId: string): PaymentStage {
  const row = getDb().prepare('SELECT stage FROM gateway_payments WHERE id = ?').get(paymentId) as { stage: PaymentStage } | undefined;
  if (!row) throw conflict('Payment not found', 'payment_not_found');
  return row.stage;
}

/**
 * Move an intent to a new stage. Throws on an illegal transition. Records the event with the actor.
 * Returns false (without throwing) when `to` equals the current stage.
 */
export function transitionStage(paymentId: string, to: PaymentStage, actor: Actor, details: Record<string, unknown> = {}): boolean {
  const db = getDb();
  return db.transaction(() => {
    const from = currentStage(paymentId);
    if (from === to) return false;
    if (!canTransition(from, to)) throw conflict(`Payment cannot move from ${from} to ${to}`, 'invalid_stage_transition');
    db.prepare('UPDATE gateway_payments SET stage = ?, status = ?, updated_at = ? WHERE id = ?').run(to, stageToStatus(to), now(), paymentId);
    recordEvent('payment', paymentId, `payment.${to.toLowerCase()}`, actor, { from, to, ...details });
    return true;
  })();
}

/** Walk through several stages in order (e.g. a processor confirmation compresses EVIDENCE_RECEIVED → VERIFYING → CONFIRMED). */
export function advanceThrough(paymentId: string, stages: PaymentStage[], actor: Actor, details: Record<string, unknown> = {}) {
  for (const s of stages) {
    const cur = currentStage(paymentId);
    if (cur === s) continue;
    if (!canTransition(cur, s)) continue;
    transitionStage(paymentId, s, actor, details);
  }
}
