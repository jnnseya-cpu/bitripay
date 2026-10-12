/**
 * The corridor-network build specification as data: the four phases and what each one changes, the two corridors of
 * phase 2, the counterparty kinds, the gates that decide whether the next phase is funded, the kill-or-pivot
 * criteria, and the questions that must be answered before a phase is built. The console reads and edits these rows;
 * seeding only ever inserts what is missing, so an administrator's edits and answers are never overwritten.
 *
 * Owners are roles, not people: the register is for the platform, not an address book.
 */

export type RegulatoryMode = 'non_custodial' | 'partner_custody' | 'own_licence' | 'network_operator';

export interface PhaseDefinition {
  phase: 1 | 2 | 3 | 4;
  name: string;
  window: string;
  role: string;
  /** Whether BitriPay itself holds customer funds in this phase. */
  holdsCustomerFunds: 'no' | 'partner_float_only' | 'yes_safeguarded' | 'settlement_agent_by_mandate';
  regulatoryMode: RegulatoryMode;
  summary: string;
}

export const NETWORK_PHASES: PhaseDefinition[] = [
  {
    phase: 1,
    name: 'Orchestrator',
    window: 'Months 0–12',
    role: 'Non-custodial aggregator in the DRC; agent of an authorised electronic-money institution for the United Kingdom leg',
    holdsCustomerFunds: 'no',
    regulatoryMode: 'non_custodial',
    summary:
      'One API collects and pays out across the mobile-money operators in USD and CDF and reaches other markets through partners. Money sits at the operator or the partner; BitriPay instructs, records and reconciles, and never holds customer funds.',
  },
  {
    phase: 2,
    name: 'Corridor owner',
    window: 'Months 12–30',
    role: 'Runs two corridors end to end on partner licences, reaching a regional scheme through a sponsor bank',
    holdsCustomerFunds: 'partner_float_only',
    regulatoryMode: 'partner_custody',
    summary:
      'BitriPay sets the price, places its own prefunded liquidity at payout partners and settles its own net positions instead of reselling a partner corridor. The licences are still the partners’.',
  },
  {
    phase: 3,
    name: 'Licensed issuer',
    window: 'Year 3 onwards',
    role: 'Own electronic-money authorisation in the DRC and in the United Kingdom',
    holdsCustomerFunds: 'yes_safeguarded',
    regulatoryMode: 'own_licence',
    summary:
      'BitriPay issues and safeguards customer wallets itself. Every wallet credit is matched the same business day by a credit to a safeguarding account, checked daily, with a resolution pack an administrator could act on.',
  },
  {
    phase: 4,
    name: 'Network role',
    window: 'Year 4 onwards',
    role: 'Operator or technology provider to a regional scheme, a development bank or a central bank, by mandate',
    holdsCustomerFunds: 'settlement_agent_by_mandate',
    regulatoryMode: 'network_operator',
    summary:
      'The stack is offered to institutions as a participant connector, an interoperability hub, a collections platform or a corridor operator. BitriPay connects participants to the existing schemes; it does not build a competing one.',
  },
];

export const REGULATORY_MODES: Record<RegulatoryMode, { label: string; custody: string; description: string }> = {
  non_custodial: {
    label: 'Non-custodial',
    custody: 'None',
    description: 'Funds stay at the operator, the merchant or the principal. BitriPay instructs and records; the ledger still books what each side owes.',
  },
  partner_custody: {
    label: 'Partner custody, BitriPay float',
    custody: 'Prefunded float at partners only',
    description: 'BitriPay places its own liquidity at payout partners and settles its net positions. Customer funds are still held under a partner’s licence.',
  },
  own_licence: {
    label: 'Own authorisation',
    custody: 'Customer funds, safeguarded',
    description: 'BitriPay issues the electronic money, holds the customer liability and safeguards it in designated accounts, reconciled daily.',
  },
  network_operator: {
    label: 'Network operator by mandate',
    custody: 'Settlement agent only, under the mandate',
    description: 'BitriPay operates infrastructure for institutions. Any settlement position it carries exists only because a mandate says so.',
  },
};

export interface SeedCorridor {
  code: string;
  name: string;
  sourceCountry: string;
  destCountry: string;
  sourceCurrency: string;
  destCurrency: string;
  settlementCurrency: string;
  phase: number;
  regulatoryMode: RegulatoryMode;
  licenceBasis: string;
  collectionRails: string[];
  payoutRails: string[];
  settlementRails: string[];
  limits: { perPaymentMinor: number; perDayMinor: number; perMonthMinor: number; currency: string };
  notes: string;
}

/** The two corridors the specification takes end to end in phase 2. Both start as drafts: nothing is live until an administrator says so. */
export const SEED_CORRIDORS: SeedCorridor[] = [
  {
    code: 'UK-CD',
    name: 'United Kingdom and Europe to the DRC',
    sourceCountry: 'GB',
    destCountry: 'CD',
    sourceCurrency: 'GBP',
    destCurrency: 'CDF',
    settlementCurrency: 'USD',
    phase: 1,
    regulatoryMode: 'non_custodial',
    licenceBasis: 'Agent of an authorised electronic-money institution for the collection leg; aggregator perimeter for the payout leg',
    collectionRails: ['open_banking', 'card', 'emi_principal'],
    payoutRails: ['mobile_money', 'bank'],
    settlementRails: ['partner_network'],
    limits: { perPaymentMinor: 500_000, perDayMinor: 2_000_000, perMonthMinor: 20_000_000, currency: 'USD' },
    notes: 'Diaspora remittance, school fees and supplier payments. The principal is the regulated entity on the collection leg and is named in the customer terms.',
  },
  {
    code: 'CD-CG',
    name: 'DRC and the CEMAC region, Congo-Brazzaville first',
    sourceCountry: 'CD',
    destCountry: 'CG',
    sourceCurrency: 'CDF',
    destCurrency: 'XAF',
    settlementCurrency: 'USD',
    phase: 1,
    regulatoryMode: 'non_custodial',
    licenceBasis: 'Aggregator perimeter on the DRC side; payout under a partner’s licence in the destination country',
    collectionRails: ['mobile_money', 'bank', 'national_switch'],
    payoutRails: ['mobile_money', 'bank'],
    settlementRails: ['partner_network'],
    limits: { perPaymentMinor: 300_000, perDayMinor: 1_500_000, perMonthMinor: 15_000_000, currency: 'USD' },
    notes:
      'Cross-river trade, supplier payments between small businesses and family transfers. A regional scheme reached through a sponsor bank is one of the settlement options, once the sponsor and the participation are confirmed.',
  },
];

export interface SeedCounterparty {
  code: string;
  name: string;
  kind: string;
  country: string | null;
  currencies: string[];
  settlementWindow: 'hourly' | 'daily' | 'weekly' | 'manual';
  notes: string;
}

/**
 * The counterparty slots a corridor needs filled. Each one is a role in the corridor, named after the function and
 * not after a company: the company is a commercial decision an administrator records against the slot.
 */
export const SEED_COUNTERPARTIES: SeedCounterparty[] = [
  {
    code: 'MM-CD-A',
    name: 'DRC mobile-money operator A',
    kind: 'mobile_money',
    country: 'CD',
    currencies: ['USD', 'CDF'],
    settlementWindow: 'daily',
    notes: 'Collection and payout in both currencies; terms, sandbox and settlement timing confirmed at contracting.',
  },
  {
    code: 'MM-CD-B',
    name: 'DRC mobile-money operator B',
    kind: 'mobile_money',
    country: 'CD',
    currencies: ['USD', 'CDF'],
    settlementWindow: 'daily',
    notes: 'Second operator, so a single operator outage never closes the corridor.',
  },
  {
    code: 'MM-CD-C',
    name: 'DRC mobile-money operator C',
    kind: 'mobile_money',
    country: 'CD',
    currencies: ['USD', 'CDF'],
    settlementWindow: 'daily',
    notes: 'Third operator. Whatever its contract allows becomes its declared capabilities; the router never assumes a flow exists.',
  },
  {
    code: 'BANK-CD',
    name: 'DRC commercial bank',
    kind: 'bank',
    country: 'CD',
    currencies: ['USD', 'CDF'],
    settlementWindow: 'daily',
    notes: 'Bank payouts and the collection account for the aggregator perimeter.',
  },
  {
    code: 'EMI-UK',
    name: 'United Kingdom electronic-money principal',
    kind: 'emi_principal',
    country: 'GB',
    currencies: ['GBP', 'EUR'],
    settlementWindow: 'daily',
    notes: 'Holds and safeguards the funds on the collection leg in phase 1; BitriPay is its appointed agent and appears as such on the public register.',
  },
  {
    code: 'XB-PARTNER',
    name: 'Cross-border payout partner',
    kind: 'aggregator',
    country: null,
    currencies: ['USD', 'XAF'],
    settlementWindow: 'daily',
    notes: 'Reaches the destination markets BitriPay does not integrate directly, under the partner’s own licences.',
  },
  {
    code: 'SPONSOR-BANK',
    name: 'Regional-scheme sponsor bank',
    kind: 'sponsor_bank',
    country: null,
    currencies: ['USD', 'XAF'],
    settlementWindow: 'daily',
    notes: 'Sponsors BitriPay as an indirect participant of a regional scheme and holds the scheme settlement position. Messages are exchanged as ISO 20022 files.',
  },
  {
    code: 'SETTLE-TOKEN',
    name: 'Regulated settlement-token provider',
    kind: 'token_provider',
    country: null,
    currencies: ['USD'],
    settlementWindow: 'hourly',
    notes:
      'Settlement leg between BitriPay and its own partners only, never a customer-facing product, and only where the flag is switched on for the corridor after legal sign-off. BitriPay never custodies keys.',
  },
];

export interface SeedGate {
  code: string;
  phase: number;
  kind: 'gate' | 'kill_or_pivot';
  criterion: string;
  target: string;
  unit: string | null;
  owner: string;
}

export const SEED_GATES: SeedGate[] = [
  { code: 'G1-MERCHANTS', phase: 1, kind: 'gate', criterion: 'External merchants live on the public API, excluding group ventures', target: '50', unit: 'merchants', owner: 'Product manager' },
  {
    code: 'G1-CORRIDOR-MARGIN',
    phase: 1,
    kind: 'gate',
    criterion: 'Corridor contribution margin after partner cost, for each live corridor',
    target: 'positive',
    unit: 'margin',
    owner: 'Product manager',
  },
  { code: 'G1-RECON', phase: 1, kind: 'gate', criterion: 'Reconciliation breaks as a share of settled value, four-week average', target: '≤ 0.5', unit: '% of value', owner: 'Head of compliance' },
  { code: 'G1-REMITTANCE', phase: 1, kind: 'gate', criterion: 'Remittance corridor live with the electronic-money principal', target: 'live', unit: 'state', owner: 'Partnerships' },
  { code: 'G1-AVAILABILITY', phase: 1, kind: 'gate', criterion: 'Public API availability over the quarter', target: '≥ 99.9', unit: '%', owner: 'Tech lead' },
  { code: 'G2-TWO-CORRIDORS', phase: 2, kind: 'gate', criterion: 'Corridors run end to end on BitriPay prefunding and settlement', target: '2', unit: 'corridors', owner: 'Tech lead' },
  {
    code: 'G2-PREFUND-TURN',
    phase: 2,
    kind: 'gate',
    criterion: 'Prefunding turns per month, so liquidity cost per payment is known and falling',
    target: '≥ 4',
    unit: 'turns/month',
    owner: 'Treasury',
  },
  { code: 'G2-SETTLEMENT-BREAKS', phase: 2, kind: 'gate', criterion: 'Counterparty settlement batches reconciled without a break', target: '≥ 99', unit: '% of batches', owner: 'Head of compliance' },
  {
    code: 'G3-CAPITAL',
    phase: 3,
    kind: 'gate',
    criterion: 'Capital and prefunding in place for the authorisations applied for',
    target: 'confirmed with the regulators',
    unit: 'state',
    owner: 'Head of compliance',
  },
  {
    code: 'G3-SAFEGUARDING-AUDIT',
    phase: 3,
    kind: 'gate',
    criterion: 'Independent safeguarding audit passed before any customer balance is held',
    target: 'passed',
    unit: 'state',
    owner: 'Head of compliance',
  },
  {
    code: 'G3-DAILY-CHECK',
    phase: 3,
    kind: 'gate',
    criterion: 'Daily safeguarding check with no unremedied shortfall, over the quarter before go-live',
    target: '100',
    unit: '% of days',
    owner: 'Treasury',
  },
  { code: 'G4-MANDATE', phase: 4, kind: 'gate', criterion: 'A signed mandate from a scheme, a development bank or a central bank', target: '≥ 1', unit: 'mandate', owner: 'Partnerships' },
  {
    code: 'K1-NO-PRINCIPAL',
    phase: 1,
    kind: 'kill_or_pivot',
    criterion: 'No signed electronic-money principal by month 9',
    target: 'drop the United Kingdom leg for now and run the DRC side only',
    unit: null,
    owner: 'Partnerships',
  },
  {
    code: 'K1-OPERATOR-REFUSAL',
    phase: 1,
    kind: 'kill_or_pivot',
    criterion: 'An operator refuses interface access in both currencies',
    target: 'launch without it and re-scope routing around the operators that did agree',
    unit: null,
    owner: 'Tech lead',
  },
  {
    code: 'K1-NEGATIVE-MARGIN',
    phase: 1,
    kind: 'kill_or_pivot',
    criterion: 'Corridor margin still negative after twelve months live',
    target: 'exit that corridor rather than subsidise it',
    unit: null,
    owner: 'Product manager',
  },
  {
    code: 'K1-REGULATOR',
    phase: 1,
    kind: 'kill_or_pivot',
    criterion: 'The central bank objects to the aggregator model',
    target: 'pause new merchants and resolve before any further spend',
    unit: null,
    owner: 'Head of compliance',
  },
  {
    code: 'K1-RECON-BREAKS',
    phase: 1,
    kind: 'kill_or_pivot',
    criterion: 'Reconciliation breaks above 0.5 % of value for two consecutive weeks',
    target: 'freeze growth until the breaks are cleared',
    unit: null,
    owner: 'Head of compliance',
  },
];

export interface SeedQuestion {
  ref: string;
  area: string;
  phase: number;
  question: string;
  owner: string;
  blocks: string;
}

/** Every one of these can change scope or cost; each is answered of record in the console before the work it blocks starts. */
export const SEED_QUESTIONS: SeedQuestion[] = [
  {
    ref: 'Q-01',
    area: 'Central bank',
    phase: 1,
    question: 'Does the aggregator perimeter cover cross-border payouts and quoting a USD/CDF rate, or is a further authorisation needed?',
    owner: 'Head of compliance',
    blocks: 'Cross-border payout rails on the DRC side',
  },
  {
    ref: 'Q-02',
    area: 'Central bank',
    phase: 3,
    question: 'What is the current minimum capital and the full requirement list for an electronic-money authorisation?',
    owner: 'Head of compliance',
    blocks: 'Phase 3 budget and application',
  },
  {
    ref: 'Q-03',
    area: 'Central bank',
    phase: 1,
    question: 'What are the data-localisation rules for customer data and transaction records, and where may each rest?',
    owner: 'Tech lead',
    blocks: 'Where customer data is stored and backed up',
  },
  {
    ref: 'Q-04',
    area: 'Regional scheme',
    phase: 2,
    question: 'Is the country a participant of the regional scheme, and which local banks could sponsor an indirect participation?',
    owner: 'Partnerships',
    blocks: 'The sponsor-bank settlement rail',
  },
  {
    ref: 'Q-05',
    area: 'Central bank',
    phase: 2,
    question: 'What is the position on a settlement-token leg between licensed partners, as a settlement mechanism and not a customer product?',
    owner: 'Head of compliance',
    blocks: 'The settlement-token rail flag per corridor',
  },
  {
    ref: 'Q-06',
    area: 'Operators',
    phase: 1,
    question: 'For each mobile-money operator: collection and payout availability in both currencies, test access, pricing and settlement timing.',
    owner: 'Partnerships',
    blocks: 'Declared capabilities of each operator rail',
  },
  {
    ref: 'Q-07',
    area: 'United Kingdom',
    phase: 1,
    question: 'Which authorised institutions would appoint BitriPay as an agent for this corridor, and what is their risk appetite and onboarding standard?',
    owner: 'Partnerships',
    blocks: 'The United Kingdom collection leg',
  },
  {
    ref: 'Q-08',
    area: 'Partners',
    phase: 1,
    question: 'Which cross-border partner for the destination markets, on what minimum volumes and fees?',
    owner: 'Partnerships',
    blocks: 'The cross-border payout rail',
  },
  {
    ref: 'Q-09',
    area: 'Partners',
    phase: 2,
    question: 'Which payout partners for wallets and banks in the destination country of the second corridor?',
    owner: 'Partnerships',
    blocks: 'The second corridor going live',
  },
  {
    ref: 'Q-10',
    area: 'Legal',
    phase: 1,
    question: 'Which BitriPay legal entity contracts with which partner in each country?',
    owner: 'Head of compliance',
    blocks: 'Every partner contract signature',
  },
  {
    ref: 'Q-11',
    area: 'Naming',
    phase: 1,
    question: 'Which product names must be retired or renamed so that nothing can be confused with a central bank’s own scheme?',
    owner: 'Product manager',
    blocks: 'External use of the proposals that carry those names',
  },
];
