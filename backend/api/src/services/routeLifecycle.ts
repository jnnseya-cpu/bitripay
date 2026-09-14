/**
 * Lifecycle of a cross-rail transfer ("route"):
 *   CREATED → QUOTED → BIOMETRIC_APPROVAL_REQUIRED → BIOMETRICALLY_APPROVED → FUNDING_PENDING → FUNDED
 *   → FX_RESERVED → PAYOUT_ROUTED → PAYOUT_SENT → EVIDENCE_RECEIVED → VERIFYING → VERIFIED → SETTLED
 * Exceptions: INSUFFICIENT_LIQUIDITY · AWAITING_CONFIRMATION · MISMATCHED · DUPLICATE · MANUAL_REVIEW · FAILED · EXPIRED · DISPUTED · REVERSED · REFUNDED
 * Kept free of imports from routing/payouts so both can use it without cycles.
 */
import { getDb } from '../db';
import { now } from '../lib/ids';
import { conflict } from '../lib/errors';
import { recordEvent, type Actor } from './events';

export const ROUTE_STAGES = [
  'CREATED',
  'QUOTED',
  'BIOMETRIC_APPROVAL_REQUIRED',
  'BIOMETRICALLY_APPROVED',
  'FUNDING_PENDING',
  'FUNDED',
  'FX_RESERVED',
  'AWAITING_CONFIRMATION',
  'PAYOUT_ROUTED',
  'PAYOUT_SENT',
  'EVIDENCE_RECEIVED',
  'VERIFYING',
  'VERIFIED',
  'SETTLED',
  'EXPIRED',
  'FAILED',
  'MISMATCHED',
  'DUPLICATE',
  'INSUFFICIENT_LIQUIDITY',
  'MANUAL_REVIEW',
  'DISPUTED',
  'REVERSED',
  'REFUNDED',
] as const;
export type RouteStage = (typeof ROUTE_STAGES)[number];

export const ROUTE_TERMINAL: RouteStage[] = ['SETTLED', 'EXPIRED', 'FAILED', 'REVERSED', 'REFUNDED'];
/** Funds are in the sender's wallet / escrow and nothing has left the platform yet. */
export const ROUTE_REFUNDABLE: RouteStage[] = ['FUNDED', 'FX_RESERVED', 'AWAITING_CONFIRMATION', 'PAYOUT_ROUTED', 'INSUFFICIENT_LIQUIDITY', 'MANUAL_REVIEW', 'FAILED'];

const T: Record<RouteStage, RouteStage[]> = {
  CREATED: ['QUOTED', 'FAILED', 'EXPIRED'],
  QUOTED: ['BIOMETRIC_APPROVAL_REQUIRED', 'BIOMETRICALLY_APPROVED', 'FUNDING_PENDING', 'FUNDED', 'FAILED', 'EXPIRED'],
  BIOMETRIC_APPROVAL_REQUIRED: ['BIOMETRICALLY_APPROVED', 'FUNDING_PENDING', 'FUNDED', 'FAILED', 'EXPIRED'],
  BIOMETRICALLY_APPROVED: ['FUNDING_PENDING', 'FUNDED', 'FAILED', 'EXPIRED', 'MANUAL_REVIEW'],
  FUNDING_PENDING: ['FUNDED', 'FAILED', 'EXPIRED', 'MANUAL_REVIEW', 'DISPUTED'],
  FUNDED: ['FX_RESERVED', 'AWAITING_CONFIRMATION', 'PAYOUT_ROUTED', 'PAYOUT_SENT', 'SETTLED', 'INSUFFICIENT_LIQUIDITY', 'MANUAL_REVIEW', 'FAILED', 'DISPUTED', 'REFUNDED'],
  FX_RESERVED: ['PAYOUT_ROUTED', 'PAYOUT_SENT', 'SETTLED', 'INSUFFICIENT_LIQUIDITY', 'MANUAL_REVIEW', 'FAILED', 'DISPUTED', 'REFUNDED'],
  AWAITING_CONFIRMATION: ['FUNDED', 'FX_RESERVED', 'PAYOUT_ROUTED', 'MANUAL_REVIEW', 'FAILED', 'REFUNDED', 'EXPIRED', 'DISPUTED'],
  PAYOUT_ROUTED: ['PAYOUT_SENT', 'INSUFFICIENT_LIQUIDITY', 'MANUAL_REVIEW', 'EXPIRED', 'FAILED', 'DISPUTED', 'REFUNDED', 'SETTLED'],
  PAYOUT_SENT: ['EVIDENCE_RECEIVED', 'AWAITING_CONFIRMATION', 'PAYOUT_ROUTED', 'MANUAL_REVIEW', 'FAILED', 'DISPUTED', 'SETTLED'],
  EVIDENCE_RECEIVED: ['VERIFYING', 'VERIFIED', 'MISMATCHED', 'DUPLICATE', 'MANUAL_REVIEW'],
  VERIFYING: ['VERIFIED', 'SETTLED', 'MISMATCHED', 'DUPLICATE', 'MANUAL_REVIEW', 'FAILED'],
  VERIFIED: ['SETTLED', 'MANUAL_REVIEW'],
  SETTLED: ['DISPUTED', 'REVERSED'],
  EXPIRED: ['MANUAL_REVIEW', 'REFUNDED'],
  FAILED: ['PAYOUT_ROUTED', 'MANUAL_REVIEW', 'REFUNDED'],
  MISMATCHED: ['VERIFYING', 'MANUAL_REVIEW', 'PAYOUT_SENT', 'FAILED'],
  DUPLICATE: ['VERIFYING', 'MANUAL_REVIEW', 'PAYOUT_SENT', 'FAILED'],
  INSUFFICIENT_LIQUIDITY: ['PAYOUT_ROUTED', 'MANUAL_REVIEW', 'FAILED', 'REFUNDED', 'EXPIRED'],
  MANUAL_REVIEW: ['PAYOUT_ROUTED', 'PAYOUT_SENT', 'FUNDED', 'FX_RESERVED', 'VERIFYING', 'VERIFIED', 'SETTLED', 'FAILED', 'REFUNDED', 'REVERSED'],
  DISPUTED: ['REVERSED', 'SETTLED', 'MANUAL_REVIEW', 'REFUNDED'],
  REVERSED: [],
  REFUNDED: [],
};

/** Legacy `status` column kept for older clients. */
export function routeStageToStatus(stage: RouteStage): string {
  switch (stage) {
    case 'BIOMETRIC_APPROVAL_REQUIRED':
      return 'authentication_required';
    case 'BIOMETRICALLY_APPROVED':
      return 'approved';
    case 'FX_RESERVED':
    case 'AWAITING_CONFIRMATION':
      return 'funded';
    case 'FUNDING_PENDING':
      return 'funding';
    case 'FUNDED':
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

// ---------------------------------------------------------------------------------------------------------------------
// Specification stage names (message 4). The built stages are finer-grained; every spec name is an alias of exactly
// one built stage, and every built stage can be rendered under its spec name for clients that speak the spec.
// ---------------------------------------------------------------------------------------------------------------------
export const STAGE_ALIASES: Record<string, RouteStage> = {
  CREATED: 'CREATED',
  QUOTED: 'QUOTED',
  APPROVAL_REQUIRED: 'BIOMETRIC_APPROVAL_REQUIRED',
  APPROVED: 'BIOMETRICALLY_APPROVED',
  FUNDING_PENDING: 'FUNDING_PENDING',
  FUNDS_RECEIVED: 'FUNDED',
  FX_RESERVED: 'FX_RESERVED',
  AWAITING_CONFIRMATION: 'AWAITING_CONFIRMATION',
  INSTRUCTION_ISSUED: 'PAYOUT_ROUTED',
  PAYMENT_SENT: 'PAYOUT_SENT',
  EVIDENCE_RECEIVED: 'EVIDENCE_RECEIVED',
  VERIFYING: 'VERIFYING',
  CONFIRMED: 'VERIFIED',
  RELEASED: 'SETTLED',
  EXPIRED: 'EXPIRED',
  FAILED: 'FAILED',
  MISMATCHED: 'MISMATCHED',
  DUPLICATE: 'DUPLICATE',
  INSUFFICIENT_LIQUIDITY: 'INSUFFICIENT_LIQUIDITY',
  UNDER_REVIEW: 'MANUAL_REVIEW',
  DISPUTED: 'DISPUTED',
  REVERSED: 'REVERSED',
  REFUNDED: 'REFUNDED',
};

/** The spec name of every built stage (the first alias that maps to it); a stage without an alias keeps its own name. */
export const STAGE_ALIAS_OF: Record<RouteStage, string> = Object.fromEntries(
  ROUTE_STAGES.map((stage) => [stage, Object.entries(STAGE_ALIASES).find(([, built]) => built === stage)?.[0] ?? stage]),
) as Record<RouteStage, string>;

/** Spec name for a built stage (`FUNDED` → `FUNDS_RECEIVED`, `SETTLED` → `RELEASED`, `MANUAL_REVIEW` → `UNDER_REVIEW`). */
export function stageAlias(stage: RouteStage): string {
  return STAGE_ALIAS_OF[stage] ?? stage;
}

/** Resolve a spec alias or a built stage name (case-insensitive) to the built stage; null when neither. */
export function stageFromAlias(name: string): RouteStage | null {
  const key = String(name ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  if (!key) return null;
  if (STAGE_ALIASES[key]) return STAGE_ALIASES[key];
  return (ROUTE_STAGES as readonly string[]).includes(key) ? (key as RouteStage) : null;
}

/** Decorate a route view with `stageAlias` next to `stage` (used by the route view builder). */
export function withStageAlias<T extends { stage: RouteStage }>(view: T): T & { stageAlias: string } {
  return { ...view, stageAlias: stageAlias(view.stage) };
}

type StageLabel = { label: string; group: 'initiated' | 'funded' | 'paying' | 'settled' | 'exception'; description: string };
/** Adds the specification alias to every stage label so clients see both names. */
function withAliases(labels: Record<RouteStage, StageLabel>): Record<RouteStage, StageLabel & { alias: string }> {
  return Object.fromEntries(Object.entries(labels).map(([stage, l]) => [stage, { ...l, alias: stageAlias(stage as RouteStage) }])) as Record<RouteStage, StageLabel & { alias: string }>;
}
export const ROUTE_STAGE_LABELS: Record<RouteStage, StageLabel & { alias: string }> = withAliases({
  CREATED: { label: 'Created', group: 'initiated', description: 'Transfer created. No money has moved.' },
  QUOTED: { label: 'Quoted', group: 'initiated', description: 'Rate, fees and recipient amount quoted.' },
  BIOMETRIC_APPROVAL_REQUIRED: { label: 'Approval required', group: 'initiated', description: 'Approve with Face ID, fingerprint, passkey or PIN.' },
  FUNDING_PENDING: { label: 'Funding pending', group: 'initiated', description: 'Waiting for the card processor, bank or operator to confirm the funds.' },
  BIOMETRICALLY_APPROVED: { label: 'Biometrically approved', group: 'initiated', description: 'Approved with biometrics / passkey / PIN. Funding is being collected.' },
  FUNDED: { label: 'Funded', group: 'funded', description: 'Funding confirmed and held in safeguarded e-money. The payout is being prepared.' },
  FX_RESERVED: { label: 'FX reserved', group: 'funded', description: 'The exchange rate is locked and local liquidity reserved at the disclosed rate.' },
  AWAITING_CONFIRMATION: {
    label: 'Awaiting confirmation',
    group: 'exception',
    description: 'Waiting for the recipient to confirm the payout currency (required in this corridor) or for the operator confirmation.',
  },
  PAYOUT_ROUTED: { label: 'Payout routed', group: 'paying', description: 'Routed to a prefunded payout account or an approved local agent.' },
  PAYOUT_SENT: { label: 'Payout sent', group: 'paying', description: 'The payout is being executed from the local account (USSD / operator app).' },
  EVIDENCE_RECEIVED: { label: 'Evidence received', group: 'paying', description: 'The operator confirmation was received and is being checked.' },
  VERIFYING: { label: 'Verifying', group: 'paying', description: 'Recipient, amount, reference, operator and timestamp are being matched.' },
  VERIFIED: { label: 'Verified', group: 'paying', description: 'The operator confirmation matched every field. Settling.' },
  SETTLED: { label: 'Settled', group: 'settled', description: 'The recipient received the money and the ledger is posted.' },
  EXPIRED: { label: 'Expired', group: 'exception', description: 'The transfer expired before it could complete.' },
  FAILED: { label: 'Failed', group: 'exception', description: 'The transfer failed. Held funds are returned or refundable.' },
  MISMATCHED: { label: 'Mismatched', group: 'exception', description: 'The operator confirmation did not match. Under review.' },
  DUPLICATE: { label: 'Duplicate', group: 'exception', description: 'The confirmation was already used. Under review.' },
  INSUFFICIENT_LIQUIDITY: {
    label: 'Insufficient liquidity',
    group: 'exception',
    description: 'No prefunded local account can pay this right now. Funds are safe; the payout resumes once liquidity is available.',
  },
  MANUAL_REVIEW: { label: 'Manual review', group: 'exception', description: 'A verifier must review this transfer before the payout continues.' },
  DISPUTED: { label: 'Disputed', group: 'exception', description: 'The funding is disputed (chargeback).' },
  REVERSED: { label: 'Reversed', group: 'exception', description: 'The transfer was reversed.' },
  REFUNDED: { label: 'Refunded', group: 'exception', description: 'The sender was refunded.' },
});

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
