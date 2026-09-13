/**
 * Declared payment routes. Each logical route says how it is initiated, how the external leg is
 * confirmed, how value actually settles, how long it takes, which fees apply, how a refund works and
 * whether processing is automatic, assisted (human verifier confirms evidence) or manual.
 *
 * The shared ledger coordinates the legs, but external value transfer always depends on the sender
 * and recipient using their own bank, mobile money operator or a licensed processor.
 */
import { availableGateways } from '../payments';
import { getOperator } from './momo';

export type RouteSourceKind = 'wallet' | 'qr' | 'card' | 'bank' | 'mobile_money';
export type RouteDestKind = 'wallet' | 'qr' | 'bank' | 'mobile_money' | 'agent' | 'keep' | 'merchant';
export type ProcessingMode = 'automatic' | 'assisted' | 'manual';

export interface LegDeclaration {
  kind: string;
  initiation: string;
  confirmation: string;
  settlement: string;
  expectedCompletion: string;
  processing: ProcessingMode;
  refundMethod: string;
  feeType: string | null;
  regulatedRail: boolean;
  /** Provider that actually carries the leg (processor id, 'direct_rail', 'internal', 'treasury'). */
  carrier: string;
  /** Declared confirmation method: what independent evidence settles this leg. */
  confirmationMethod: ConfirmationMethod;
}

export type ConfirmationMethod = 'PROCESSOR_WEBHOOK' | 'SIGNED_SMS_FORWARDER' | 'SECURED_DEVICE_CONFIRMATION' | 'AGENT_WITH_EVIDENCE' | 'ADMIN_MAKER_CHECKER' | 'INTERNAL_LEDGER';
export const CONFIRMATION_METHODS: Record<ConfirmationMethod, { label: string; description: string }> = {
  PROCESSOR_WEBHOOK: { label: 'Processor webhook', description: 'A licensed card / payment processor confirms the funds by signed webhook (replay-protected) before the ledger is credited.' },
  SIGNED_SMS_FORWARDER: {
    label: 'Signed SMS forwarder',
    description: 'A registered device forwards the operator SMS signed with its Ed25519 key; reference, amount, currency, sender and timing must match.',
  },
  SECURED_DEVICE_CONFIRMATION: {
    label: 'Secured payout device',
    description: 'The Android payout device that executed the USSD payout forwards the operator confirmation signed with its key and SIM identity.',
  },
  AGENT_WITH_EVIDENCE: {
    label: 'Agent with evidence',
    description: 'An approved local agent executes the payout and submits the operator reference; a second administrator confirms (maker-checker).',
  },
  ADMIN_MAKER_CHECKER: { label: 'Administrator maker-checker', description: 'Treasury executes the transfer and two administrators confirm against documentary evidence (bank / operator statement).' },
  INTERNAL_LEDGER: { label: 'Internal ledger', description: 'Both sides are BitriPay balances; settlement is a double-entry posting with no external confirmation needed.' },
};

function fundingMethod(leg: Omit<LegDeclaration, 'confirmationMethod'>): ConfirmationMethod {
  if (leg.carrier === 'internal') return 'INTERNAL_LEDGER';
  if (leg.carrier === 'direct_rail' || leg.carrier === 'manual_momo') return 'SIGNED_SMS_FORWARDER';
  if (leg.carrier === 'manual_bank' || leg.carrier === 'treasury') return 'ADMIN_MAKER_CHECKER';
  return 'PROCESSOR_WEBHOOK';
}
function payoutMethod(leg: Omit<LegDeclaration, 'confirmationMethod'>, override?: string | null): ConfirmationMethod {
  if (override && override in CONFIRMATION_METHODS) return override as ConfirmationMethod;
  if (leg.carrier === 'internal') return 'INTERNAL_LEDGER';
  if (leg.kind === 'mobile_money') return 'SECURED_DEVICE_CONFIRMATION';
  if (leg.kind === 'agent') return 'AGENT_WITH_EVIDENCE';
  return 'ADMIN_MAKER_CHECKER';
}

export interface RouteDeclaration {
  source: RouteSourceKind;
  destination: RouteDestKind;
  funding: LegDeclaration;
  payout: LegDeclaration;
  exchange: { feeType: 'exchange'; note: string } | null;
  processing: ProcessingMode;
  expectedCompletion: string;
  settlementMechanism: string;
  refundMethod: string;
  /** Plain-language statement of what this route can and cannot do. */
  disclosure: string;
}

const modeRank: Record<ProcessingMode, number> = { automatic: 0, assisted: 1, manual: 2 };
const slower = (a: ProcessingMode, b: ProcessingMode) => (modeRank[a] >= modeRank[b] ? a : b);

export function describeFunding(source: RouteSourceKind, opts: { currency?: string | null; country?: string | null; operatorId?: string | null; gateway?: string | null } = {}): LegDeclaration {
  const leg = describeFundingLeg(source, opts);
  return { ...leg, confirmationMethod: fundingMethod(leg) };
}
function describeFundingLeg(
  source: RouteSourceKind,
  opts: { currency?: string | null; country?: string | null; operatorId?: string | null; gateway?: string | null } = {},
): Omit<LegDeclaration, 'confirmationMethod'> {
  if (source === 'wallet' || source === 'qr') {
    return {
      kind: source,
      initiation: 'Internal wallet debit after biometric or PIN approval',
      confirmation: 'Immediate (internal ledger)',
      settlement: 'Double-entry ledger posting',
      expectedCompletion: 'Instant',
      processing: 'automatic',
      refundMethod: 'Ledger reversal to the wallet',
      feeType: null,
      regulatedRail: false,
      carrier: 'internal',
    };
  }
  const gateways = opts.currency ? availableGateways(source, opts.currency, opts.country ?? undefined) : [];
  if (source === 'card') {
    const g = (opts.gateway ? gateways.find((x) => x.id === opts.gateway) : null) ?? gateways.find((x) => x.provider !== 'sandbox') ?? gateways[0];
    const sandbox = !g || g.provider === 'sandbox';
    return {
      kind: 'card',
      initiation: sandbox ? 'Card charged through the sandbox processor (test only)' : `Card charged through ${g!.name} (licensed acquiring processor)`,
      confirmation: sandbox ? 'Sandbox authorisation result' : 'Processor authorisation and signed webhook',
      settlement: sandbox ? 'No real funds move in sandbox' : 'Processor settles card funds to the platform account; ledger credited on authorisation',
      expectedCompletion: 'Seconds',
      processing: 'automatic',
      refundMethod: sandbox ? 'Sandbox refund' : 'Refund through the processor to the original card',
      feeType: 'card_deposit',
      regulatedRail: true,
      carrier: g?.id ?? 'none',
    };
  }
  if (source === 'mobile_money') {
    const op = opts.operatorId ? safeOperator(opts.operatorId) : null;
    const api = gateways.find(
      (g) =>
        g.provider !== 'manual_momo' &&
        g.provider !== 'sandbox' &&
        (!op || ((g.countries.length === 0 || g.countries.includes(op.country)) && (g.currencies.length === 0 || g.currencies.includes(op.currency)))),
    );
    if (api) {
      return {
        kind: 'mobile_money',
        initiation: `${api.name} sends a payment prompt to the customer's phone`,
        confirmation: 'Operator API callback / status query',
        settlement: 'Operator settles collections to the platform account; ledger credited on confirmation',
        expectedCompletion: 'Under a minute',
        processing: 'automatic',
        refundMethod: 'Operator API refund or payout to the same number',
        feeType: 'mobile_money_deposit',
        regulatedRail: true,
        carrier: api.id,
      };
    }
    const direct = op?.collectionNumber ? 'direct_rail' : gateways.find((g) => g.provider === 'sandbox') ? 'sandbox' : 'none';
    if (direct === 'sandbox') {
      return {
        kind: 'mobile_money',
        initiation: 'Sandbox mobile money prompt (test only)',
        confirmation: 'Simulated approval',
        settlement: 'No real funds move in sandbox',
        expectedCompletion: 'Seconds',
        processing: 'automatic',
        refundMethod: 'Sandbox',
        feeType: 'mobile_money_deposit',
        regulatedRail: false,
        carrier: 'sandbox',
      };
    }
    return {
      kind: 'mobile_money',
      initiation: `Customer sends money from their own ${op?.name ?? 'mobile money'} account (USSD/app) to the platform collection number with the payment reference`,
      confirmation: 'Signed receipt SMS from the collection phone (SMS-forwarder app); otherwise an authorised verifier confirms against the operator statement',
      settlement: 'Funds land in the platform collection account; the ledger is credited only after independent confirmation',
      expectedCompletion: 'Minutes with SMS evidence; up to 1 business day with manual verification',
      processing: 'assisted',
      refundMethod: 'Payout back to the sender number after verification',
      feeType: 'mobile_money_deposit',
      regulatedRail: true,
      carrier: direct,
    };
  }
  // bank
  const api = gateways.find((g) => g.provider !== 'manual_bank' && g.provider !== 'sandbox');
  if (api) {
    return {
      kind: 'bank',
      initiation: `Bank transfer / open-banking through ${api.name}`,
      confirmation: 'Processor webhook',
      settlement: 'Processor settles to the platform account; ledger credited on confirmation',
      expectedCompletion: 'Minutes to 1 business day',
      processing: 'automatic',
      refundMethod: 'Refund through the processor',
      feeType: 'bank_deposit',
      regulatedRail: true,
      carrier: api.id,
    };
  }
  return {
    kind: 'bank',
    initiation: 'Customer makes a transfer from their own bank to the platform collection account using the payment reference',
    confirmation: 'Bank notification SMS/e-mail evidence, or an authorised verifier confirms against the bank statement (maker-checker)',
    settlement: 'Funds arrive in the platform bank account; the ledger is credited only after independent confirmation',
    expectedCompletion: 'Same day to 2 business days',
    processing: 'assisted',
    refundMethod: 'Bank payout back to the sender account after verification',
    feeType: 'bank_deposit',
    regulatedRail: true,
    carrier: 'direct_rail',
  };
}

export function describePayout(destination: RouteDestKind, opts: { operatorId?: string | null; payoutConfirmation?: string | null } = {}): LegDeclaration {
  const leg = describePayoutLeg(destination, opts);
  return { ...leg, confirmationMethod: payoutMethod(leg, opts.payoutConfirmation) };
}
function describePayoutLeg(destination: RouteDestKind, opts: { operatorId?: string | null } = {}): Omit<LegDeclaration, 'confirmationMethod'> {
  switch (destination) {
    case 'wallet':
    case 'qr':
    case 'merchant':
    case 'keep':
      return {
        kind: destination,
        initiation: destination === 'keep' ? 'Funds stay in the wallet' : 'Internal wallet credit to the recipient (user, merchant or QR target)',
        confirmation: 'Immediate (internal ledger)',
        settlement: 'Double-entry ledger posting',
        expectedCompletion: 'Instant',
        processing: 'automatic',
        refundMethod: 'Ledger reversal',
        feeType: destination === 'merchant' || destination === 'keep' ? null : 'transfer',
        regulatedRail: false,
        carrier: 'internal',
      };
    case 'mobile_money': {
      const op = opts.operatorId ? safeOperator(opts.operatorId) : null;
      return {
        kind: 'mobile_money',
        initiation: `Payout instruction routed to a prefunded ${op?.name ?? 'operator'} payout account; funds held in escrow`,
        confirmation: 'The secured Android payout device (or approved agent) executes the USSD transfer; the operator confirmation SMS is signed and verified before settlement',
        settlement: 'Operator transfer from the prefunded local account (merchant SIM) to the recipient number',
        expectedCompletion: 'Minutes to a few hours during business hours',
        processing: 'manual',
        refundMethod: 'Escrow released back to the wallet if the payout is rejected',
        feeType: 'withdrawal',
        regulatedRail: true,
        carrier: 'treasury',
      };
    }
    case 'bank':
      return {
        kind: 'bank',
        initiation: 'Payout request to the bank account; funds held in escrow',
        confirmation: 'Treasury operator executes a bank transfer and records the bank reference; approval is maker-checker',
        settlement: 'Bank transfer from the platform account',
        expectedCompletion: 'Same day to 2 business days',
        processing: 'manual',
        refundMethod: 'Escrow released back to the wallet if the payout is rejected',
        feeType: 'withdrawal',
        regulatedRail: true,
        carrier: 'treasury',
      };
    case 'agent':
      return {
        kind: 'agent',
        initiation: 'Cash-out code issued; funds held in escrow',
        confirmation: 'Agent confirms the code and hands over cash (biometric/PIN on the agent app)',
        settlement: 'Escrow released to the agent float',
        expectedCompletion: 'When the customer visits the agent (code expires otherwise)',
        processing: 'assisted',
        refundMethod: 'Escrow released back to the wallet when the code expires or is cancelled',
        feeType: 'agent_cash_out',
        regulatedRail: false,
        carrier: 'agent',
      };
  }
}

function safeOperator(id: string) {
  try {
    return getOperator(id);
  } catch {
    return null;
  }
}

export function describeRoute(
  source: RouteSourceKind,
  destination: RouteDestKind,
  opts: {
    currency?: string | null;
    targetCurrency?: string | null;
    country?: string | null;
    operatorId?: string | null;
    destinationOperatorId?: string | null;
    gateway?: string | null;
    payoutConfirmation?: string | null;
  } = {},
): RouteDeclaration {
  const funding = describeFunding(source, { currency: opts.currency, country: opts.country, operatorId: opts.operatorId, gateway: opts.gateway });
  const payout = describePayout(destination, { operatorId: opts.destinationOperatorId, payoutConfirmation: opts.payoutConfirmation });
  const crossCurrency = !!opts.currency && !!opts.targetCurrency && opts.currency !== opts.targetCurrency;
  const processing = slower(funding.processing, payout.processing);
  const external = funding.regulatedRail || payout.regulatedRail;
  return {
    source,
    destination,
    funding,
    payout,
    exchange: crossCurrency ? { feeType: 'exchange', note: 'Converted in the platform ledger at the disclosed rate before the payout leg.' } : null,
    processing,
    expectedCompletion:
      funding.expectedCompletion === 'Instant'
        ? payout.expectedCompletion
        : payout.expectedCompletion === 'Instant'
          ? funding.expectedCompletion
          : `${funding.expectedCompletion}, then ${payout.expectedCompletion.toLowerCase()}`,
    settlementMechanism: `${funding.settlement}. ${payout.settlement}.`,
    refundMethod: payout.processing === 'automatic' ? funding.refundMethod : `${payout.refundMethod}; ${funding.refundMethod.toLowerCase()}`,
    disclosure: external
      ? 'The BitriPay ledger coordinates both legs, but the external leg(s) move money only through your own bank, mobile money operator or a licensed processor. Nothing is credited or paid out until the external payment is independently confirmed.'
      : 'Both legs are internal ledger movements and settle instantly.',
  };
}

export const ROUTE_SOURCES: RouteSourceKind[] = ['wallet', 'qr', 'card', 'bank', 'mobile_money'];
export const ROUTE_DESTINATIONS: RouteDestKind[] = ['wallet', 'qr', 'merchant', 'bank', 'mobile_money', 'agent'];

/** Full catalogue of supported logical routes for a currency/country. */
export function routeCatalog(opts: { currency?: string | null; country?: string | null } = {}): RouteDeclaration[] {
  const out: RouteDeclaration[] = [];
  for (const s of ROUTE_SOURCES) for (const d of ROUTE_DESTINATIONS) out.push(describeRoute(s, d, opts));
  return out;
}
