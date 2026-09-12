/**
 * Lifecycle of a cross-rail transfer ("route"):
 *   CREATED → QUOTED → BIOMETRIC_APPROVAL_REQUIRED → FUNDING_PENDING → FUNDS_CONFIRMED
 *   → PAYOUT_QUEUED → PAYOUT_IN_PROGRESS → EVIDENCE_RECEIVED → VERIFYING → SETTLED
 * Exceptions: EXPIRED · FAILED · MISMATCHED · DUPLICATE · LIQUIDITY_UNAVAILABLE · MANUAL_REVIEW · DISPUTED · REVERSED · REFUNDED
 * Kept free of imports from routing/payouts so both can use it without cycles.
 */
import { getDb } from '../db';
import { now } from '../lib/ids';
import { conflict } from '../lib/errors';
import { recordEvent, type Actor } from './events';

export const ROUTE_STAGES = ['CREATED', 'QUOTED', 'BIOMETRIC_APPROVAL_REQUIRED', 'FUNDING_PENDING', 'FUNDS_CONFIRMED', 'PAYOUT_QUEUED', 'PAYOUT_IN_PROGRESS', 'EVIDENCE_RECEIVED', 'VERIFYING', 'SETTLED', 'EXPIRED', 'FAILED', 'MISMATCHED', 'DUPLICATE', 'LIQUIDITY_UNAVAILABLE', 'MANUAL_REVIEW', 'DISPUTED', 'REVERSED', 'REFUNDED'] as const;
export type RouteStage = (typeof ROUTE_STAGES)[number];

export const ROUTE_TERMINAL: RouteStage[] = ['SETTLED', 'EXPIRED', 'FAILED', 'REVERSED', 'REFUNDED'];
/** Funds are in the sender's wallet / escrow and nothing has left the platform yet. */
export const ROUTE_REFUNDABLE: RouteStage[] = ['FUNDS_CONFIRMED', 'PAYOUT_QUEUED', 'LIQUIDITY_UNAVAILABLE', 'MANUAL_REVIEW', 'FAILED'];

const T: Record<RouteStage, RouteStage[]> = {
  CREATED: ['QUOTED', 'FAILED', 'EXPIRED'],
  QUOTED: ['BIOMETRIC_APPROVAL_REQUIRED', 'FUNDING_PENDING', 'FUNDS_CONFIRMED', 'FAILED', 'EXPIRED'],
  BIOMETRIC_APPROVAL_REQUIRED: ['FUNDING_PENDING', 'FUNDS_CONFIRMED', 'FAILED', 'EXPIRED'],
  FUNDING_PENDING: ['FUNDS_CONFIRMED', 'FAILED', 'EXPIRED', 'MANUAL_REVIEW', 'DISPUTED'],
  FUNDS_CONFIRMED: ['PAYOUT_QUEUED', 'PAYOUT_IN_PROGRESS', 'SETTLED', 'LIQUIDITY_UNAVAILABLE', 'MANUAL_REVIEW', 'FAILED', 'DISPUTED', 'REFUNDED'],
  PAYOUT_QUEUED: ['PAYOUT_IN_PROGRESS', 'LIQUIDITY_UNAVAILABLE', 'MANUAL_REVIEW', 'EXPIRED', 'FAILED', 'DISPUTED', 'REFUNDED', 'SETTLED'],
  PAYOUT_IN_PROGRESS: ['EVIDENCE_RECEIVED', 'PAYOUT_QUEUED', 'MANUAL_REVIEW', 'FAILED', 'DISPUTED', 'SETTLED'],
  EVIDENCE_RECEIVED: ['VERIFYING', 'MISMATCHED', 'DUPLICATE', 'MANUAL_REVIEW'],
  VERIFYING: ['SETTLED', 'MISMATCHED', 'DUPLICATE', 'MANUAL_REVIEW', 'FAILED'],
  SETTLED: ['DISPUTED', 'REVERSED'],
  EXPIRED: ['MANUAL_REVIEW', 'REFUNDED'],
  FAILED: ['PAYOUT_QUEUED', 'MANUAL_REVIEW', 'REFUNDED'],
  MISMATCHED: ['VERIFYING', 'MANUAL_REVIEW', 'PAYOUT_IN_PROGRESS', 'FAILED'],
  DUPLICATE: ['VERIFYING', 'MANUAL_REVIEW', 'PAYOUT_IN_PROGRESS', 'FAILED'],
  LIQUIDITY_UNAVAILABLE: ['PAYOUT_QUEUED', 'MANUAL_REVIEW', 'FAILED', 'REFUNDED', 'EXPIRED'],
  MANUAL_REVIEW: ['PAYOUT_QUEUED', 'PAYOUT_IN_PROGRESS', 'FUNDS_CONFIRMED', 'VERIFYING', 'SETTLED', 'FAILED', 'REFUNDED', 'REVERSED'],
  DISPUTED: ['REVERSED', 'SETTLED', 'MANUAL_REVIEW', 'REFUNDED'],
  REVERSED: [],
  REFUNDED: [],
};

/** Legacy `status` column kept for older clients. */
export function routeStageToStatus(stage: RouteStage): string {
  switch (stage) {
    case 'BIOMETRIC_APPROVAL_REQUIRED':
      return 'authentication_required';
    case 'FUNDING_PENDING':
      return 'funding';
    case 'FUNDS_CONFIRMED':
      return 'funded';
    case 'SETTLED':
      return 'completed';
    case 'EXPIRED':
    case 'FAILED':
      return 'failed';
    case 'REVERSED':
    case 'REFUNDED':
      return 'refunded';
    default:
      return 'pending';
  }
}

export const ROUTE_STAGE_LABELS: Record<RouteStage, { label: string; group: 'initiated' | 'funded' | 'paying' | 'settled' | 'exception'; description: string }> = {
  CREATED: { label: 'Created', group: 'initiated', description: 'Transfer created. No money has moved.' },
  QUOTED: { label: 'Quoted', group: 'initiated', description: 'Rate, fees and recipient amount quoted.' },
  BIOMETRIC_APPROVAL_REQUIRED: { label: 'Approval required', group: 'initiated', description: 'Approve with Face ID, fingerprint, passkey or PIN.' },
  FUNDING_PENDING: { label: 'Funding pending', group: 'initiated', description: 'Waiting for the card processor, bank or operator to confirm the funds.' },
  FUNDS_CONFIRMED: { label: 'Funds confirmed', group: 'funded', description: 'Funding confirmed and held. The payout is being prepared.' },
  PAYOUT_QUEUED: { label: 'Payout queued', group: 'paying', description: 'Queued for a prefunded payout account or an approved local agent.' },
  PAYOUT_IN_PROGRESS: { label: 'Payout in progress', group: 'paying', description: 'The payout is being executed from the local account (USSD / operator app).' },
  EVIDENCE_RECEIVED: { label: 'Evidence received', group: 'paying', description: 'The operator confirmation was received and is being checked.' },
  VERIFYING: { label: 'Verifying', group: 'paying', description: 'Recipient, amount, reference, operator and timestamp are being matched.' },
  SETTLED: { label: 'Settled', group: 'settled', description: 'The recipient received the money and the ledger is posted.' },
  EXPIRED: { label: 'Expired', group: 'exception', description: 'The transfer expired before it could complete.' },
  FAILED: { label: 'Failed', group: 'exception', description: 'The transfer failed. Held funds are returned or refundable.' },
  MISMATCHED: { label: 'Mismatched', group: 'exception', description: 'The operator confirmation did not match. Under review.' },
  DUPLICATE: { label: 'Duplicate', group: 'exception', description: 'The confirmation was already used. Under review.' },
  LIQUIDITY_UNAVAILABLE: { label: 'Liquidity unavailable', group: 'exception', description: 'No prefunded local account can pay this right now. Funds are safe; the payout resumes once liquidity is available.' },
  MANUAL_REVIEW: { label: 'Manual review', group: 'exception', description: 'A verifier must review this transfer before the payout continues.' },
  DISPUTED: { label: 'Disputed', group: 'exception', description: 'The funding is disputed (chargeback).' },
  REVERSED: { label: 'Reversed', group: 'exception', description: 'The transfer was reversed.' },
  REFUNDED: { label: 'Refunded', group: 'exception', description: 'The sender was refunded.' },
};

export function routeStage(id: string): RouteStage {
  const r = getDb().prepare('SELECT stage FROM money_routes WHERE id = ?').get(id) as { stage: RouteStage } | undefined;
  if (!r) throw conflict('Route not found', 'route_not_found');
  return r.stage;
}

export function canRouteTransition(from: RouteStage, to: RouteStage) {
  return T[from]?.includes(to) ?? false;
}

export function transitionRoute(id: string, to: RouteStage, actor: Actor, details: Record<string, unknown> = {}): boolean {
  const db = getDb();
  return db.transaction(() => {
    const from = routeStage(id);
    if (from === to) return false;
    if (!canRouteTransition(from, to)) throw conflict(`Transfer cannot move from ${from} to ${to}`, 'invalid_stage_transition');
    db.prepare('UPDATE money_routes SET stage = ?, status = ?, updated_at = ? WHERE id = ?').run(to, routeStageToStatus(to), now(), id);
    recordEvent('route', id, `route.${to.toLowerCase()}`, actor, { from, to, ...details });
    return true;
  })();
}

/** Best-effort transition: skips silently when not allowed from the current stage. */
export function tryTransitionRoute(id: string, to: RouteStage, actor: Actor, details: Record<string, unknown> = {}) {
  try {
    return transitionRoute(id, to, actor, details);
  } catch {
    return false;
  }
}
