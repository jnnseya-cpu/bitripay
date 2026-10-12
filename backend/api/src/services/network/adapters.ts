/**
 * Settlement rails: how a settlement batch actually leaves.
 *
 * Every rail sits behind one interface, so a counterparty can be moved from a partner network to a sponsored scheme
 * participation, or to a settlement token, without a line of business logic changing. What an adapter may do is
 * declared, not assumed: `capabilities()` says whether it can carry a direction, a currency and an amount, and the
 * batch is refused before anything is instructed if it cannot.
 *
 * No adapter here opens a connection. The platform settles the way it collects and pays out — by instruction and
 * evidence, not by holding a partner's credentials — so instructing a batch produces a reference and an instruction
 * an operator can carry out, and the answer comes back as a file, a statement line or an administrator's entry with
 * the counterparty's own reference. A rail that one day offers an interface changes how the same instruction
 * travels, not what it says.
 */
import { badRequest } from '../../lib/errors';
import { getNetworkCorridor, findNetworkCorridor } from './registry';
import type { BatchDirection, SettlementBatch } from './positions';

export const SETTLEMENT_RAILS = ['partner_network', 'bank_transfer', 'sponsor_iso20022', 'settlement_token'] as const;
export type SettlementRail = (typeof SETTLEMENT_RAILS)[number];

export interface RailCapabilities {
  rail: SettlementRail;
  label: string;
  directions: BatchDirection[];
  currencies: 'any' | string[];
  /** Largest amount this rail may carry in one batch, in minor units; 0 means no declared ceiling. */
  maxBatchMinor: number;
  /** True when a corridor must switch the rail on explicitly before it may be used. */
  requiresCorridorFlag: boolean;
  /** How the answer comes back, in the words an operator would use. */
  confirmation: string;
  description: string;
}

export interface InstructionPlan {
  rail: SettlementRail;
  /** The reference BitriPay puts on the instruction; the counterparty answers with its own. */
  instructionRef: string;
  /** What a person or a system has to do next for the money to move. */
  steps: string[];
  /** Built when the rail carries an ISO 20022 document; the caller builds and exports it. */
  buildsMessage: boolean;
}

export interface SettlementRailAdapter {
  readonly rail: SettlementRail;
  capabilities(): RailCapabilities;
  /** Refuse early and readably: anything this rail cannot carry is said here, not discovered after approval. */
  assertCanCarry(batch: SettlementBatch): void;
  plan(batch: SettlementBatch): InstructionPlan;
}

const reference = (batch: SettlementBatch, prefix: string): string => `${prefix}-${String(batch.number).padStart(6, '0')}`;

function assertCorridorFlag(batch: SettlementBatch, flag: 'papssAllowed' | 'stablecoinAllowed', railLabel: string): void {
  if (!batch.corridorCode) throw badRequest(`${railLabel} is used on a declared corridor; this batch names none.`, 'corridor_required');
  const corridor = findNetworkCorridor(batch.corridorCode);
  if (!corridor) throw badRequest(`Corridor ${batch.corridorCode} is not declared.`, 'corridor_not_found');
  if (!corridor[flag]) {
    throw badRequest(`${railLabel} is switched off on corridor ${corridor.code}. An administrator switches it on against the decision that allows it.`, 'settlement_rail_not_allowed');
  }
}

class PartnerNetworkAdapter implements SettlementRailAdapter {
  readonly rail = 'partner_network' as const;
  capabilities(): RailCapabilities {
    return {
      rail: this.rail,
      label: 'Partner network',
      directions: ['receive', 'pay'],
      currencies: 'any',
      maxBatchMinor: 0,
      requiresCorridorFlag: false,
      confirmation: 'The partner’s own reference, then its statement.',
      description: 'The partner moves the money under its own licences. BitriPay records the instruction, the partner’s reference and the statement line that matches it.',
    };
  }
  assertCanCarry(): void {}
  plan(batch: SettlementBatch): InstructionPlan {
    return {
      rail: this.rail,
      instructionRef: reference(batch, 'PN'),
      buildsMessage: false,
      steps: [
        `Send the partner the net for ${batch.windowKey}: ${batch.direction === 'receive' ? 'they remit to BitriPay' : 'BitriPay remits to them'}.`,
        'Record the reference the partner gives back.',
        'Reconcile against the partner statement for the same window.',
      ],
    };
  }
}

class BankTransferAdapter implements SettlementRailAdapter {
  readonly rail = 'bank_transfer' as const;
  capabilities(): RailCapabilities {
    return {
      rail: this.rail,
      label: 'Bank transfer',
      directions: ['receive', 'pay'],
      currencies: 'any',
      maxBatchMinor: 0,
      requiresCorridorFlag: false,
      confirmation: 'The bank’s transaction reference, then the account statement.',
      description: 'An ordinary transfer between the two sides’ bank accounts, instructed by whoever holds the mandate and reconciled from the statement.',
    };
  }
  assertCanCarry(): void {}
  plan(batch: SettlementBatch): InstructionPlan {
    return {
      rail: this.rail,
      instructionRef: reference(batch, 'BT'),
      buildsMessage: false,
      steps: [`Instruct the transfer for ${batch.windowKey} under the mandate, quoting the reference.`, 'Record the bank’s transaction reference.', 'Reconcile against the account statement.'],
    };
  }
}

class SponsorIso20022Adapter implements SettlementRailAdapter {
  readonly rail = 'sponsor_iso20022' as const;
  capabilities(): RailCapabilities {
    return {
      rail: this.rail,
      label: 'Sponsored scheme participation (ISO 20022)',
      directions: ['pay', 'receive'],
      currencies: 'any',
      maxBatchMinor: 0,
      requiresCorridorFlag: true,
      confirmation: 'A pacs.002 status report, then the camt.053 statement; a pacs.004 if it is returned.',
      description: 'BitriPay is an indirect participant: the sponsoring bank holds the scheme position. A pacs.008 is built and handed to the sponsor, and the sponsor’s answer is imported back.',
    };
  }
  assertCanCarry(batch: SettlementBatch): void {
    assertCorridorFlag(batch, 'papssAllowed', 'A sponsored scheme participation');
  }
  plan(batch: SettlementBatch): InstructionPlan {
    return {
      rail: this.rail,
      instructionRef: `BATCH${String(batch.number).padStart(6, '0')}`,
      buildsMessage: true,
      steps: [
        'Build the pacs.008 for this batch with the debtor and creditor details the scheme requires.',
        'Hand the file to the sponsoring bank and mark it exported.',
        'Import the pacs.002 the sponsor returns; a rejection fails the batch with its reason.',
        'Import the camt.053 for the day and reconcile.',
      ],
    };
  }
}

class SettlementTokenAdapter implements SettlementRailAdapter {
  readonly rail = 'settlement_token' as const;
  capabilities(): RailCapabilities {
    return {
      rail: this.rail,
      label: 'Regulated settlement token',
      directions: ['pay', 'receive'],
      currencies: ['USD'],
      maxBatchMinor: 0,
      requiresCorridorFlag: true,
      confirmation: 'The provider’s own transfer reference, then its statement.',
      description:
        'A settlement leg between BitriPay’s own accounts at two partners, moved by a regulated provider that custodies throughout. It is never offered to a customer, and it is off on every corridor until the decision that allows it is recorded.',
    };
  }
  assertCanCarry(batch: SettlementBatch): void {
    assertCorridorFlag(batch, 'stablecoinAllowed', 'A settlement-token leg');
    const caps = this.capabilities();
    if (caps.currencies !== 'any' && !caps.currencies.includes(batch.currency)) {
      throw badRequest(`A settlement-token leg carries ${(caps.currencies as string[]).join(', ')}, not ${batch.currency}.`, 'unsupported_currency');
    }
  }
  plan(batch: SettlementBatch): InstructionPlan {
    return {
      rail: this.rail,
      instructionRef: reference(batch, 'ST'),
      buildsMessage: false,
      steps: [
        'Instruct the regulated provider to move the net between BitriPay’s accounts at the two partners.',
        'Record the provider’s transfer reference. BitriPay holds no keys and custodies nothing.',
        'Reconcile against the provider’s statement, and book the on-ramp and off-ramp conversions so the true cost of the corridor stays visible.',
      ],
    };
  }
}

const ADAPTERS: Record<SettlementRail, SettlementRailAdapter> = {
  partner_network: new PartnerNetworkAdapter(),
  bank_transfer: new BankTransferAdapter(),
  sponsor_iso20022: new SponsorIso20022Adapter(),
  settlement_token: new SettlementTokenAdapter(),
};

export function settlementAdapter(rail: string): SettlementRailAdapter {
  const adapter = ADAPTERS[rail as SettlementRail];
  if (!adapter) throw badRequest(`Unknown settlement rail "${rail}". Known rails: ${SETTLEMENT_RAILS.join(', ')}.`, 'unknown_settlement_rail');
  return adapter;
}

export function settlementCapabilities(): RailCapabilities[] {
  return SETTLEMENT_RAILS.map((rail) => ADAPTERS[rail].capabilities());
}

/** Check a batch against its rail and return what has to happen next. Called before a batch is instructed. */
export function planInstruction(batch: SettlementBatch): InstructionPlan {
  const adapter = settlementAdapter(batch.rail);
  const caps = adapter.capabilities();
  if (!caps.directions.includes(batch.direction)) throw badRequest(`${caps.label} does not carry a "${batch.direction}" settlement.`, 'direction_not_supported');
  if (caps.maxBatchMinor && batch.netMinor > caps.maxBatchMinor) throw badRequest(`${caps.label} carries at most ${caps.maxBatchMinor} minor units in one batch.`, 'limit_exceeded');
  adapter.assertCanCarry(batch);
  return adapter.plan(batch);
}

/** The rails a corridor may actually use right now, with the reason a rail is unavailable. */
export function railsForCorridor(codeOrId: string): { rail: SettlementRail; label: string; available: boolean; reason: string | null }[] {
  const corridor = getNetworkCorridor(codeOrId);
  return SETTLEMENT_RAILS.map((rail) => {
    const caps = ADAPTERS[rail].capabilities();
    const declared = corridor.settlementRails.includes(rail);
    const flagged = rail === 'sponsor_iso20022' ? corridor.papssAllowed : rail === 'settlement_token' ? corridor.stablecoinAllowed : true;
    const reason = !declared ? 'not declared on this corridor' : !flagged ? 'switched off until the decision that allows it is recorded' : null;
    return { rail, label: caps.label, available: declared && flagged, reason };
  });
}
