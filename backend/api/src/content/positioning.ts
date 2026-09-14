/**
 * Positioning and trust copy shared by the server-rendered site, the hosted checkout, the developer portal and the
 * web app (through the shared locale packs). One source so the exact phrases never drift between surfaces.
 */
export const POSITIONING = {
  /** Brand taglines: identical in every language (they are the product name in words). */
  oneQr: 'ONE QR. ONE GATEWAY. EVERY ELIGIBLE RAIL.',
  payLocal: 'Pay Local. Fund Global. Settle Your Way.',
  /** Trust statement shown before a payer confirms and on every receipt / lifecycle view. */
  notProof: 'A successful screen is not proof of payment; your receipt is issued when the ledger posts.',
  notProofShort: 'A successful screen is not proof of payment.',
  /** No-custody wording for the About and policy pages. */
  noCustody: 'BitriPay never holds funds it is not licensed to hold; e-money balances are safeguarded 1:1.',
  /** DRC national switch: the instruction the aggregator phase is run under. */
  drcInstruction: 'Instruction n°58',
  drcSwitch:
    'In the Democratic Republic of the Congo, domestic interoperability payments are routed through the Switch Monétique National under Instruction n°58 of the Banque Centrale du Congo; BitriPay initiates, orchestrates, normalises and reports, and licensed institutions hold and settle the funds.',
  /** Standards cited wherever signatures and tokens are explained. */
  rfc: {
    http: 'RFC 9110',
    jwt: 'RFC 7519',
    ed25519: 'RFC 8032',
  },
  rfcSentence: 'HTTP semantics, status codes and idempotent methods follow RFC 9110; bearer tokens are JSON Web Tokens (RFC 7519); webhook and QR signatures use Ed25519 (RFC 8032).',
  /** National switch: customer wording when the link is down, timed out or the circuit is open. */
  switchUnavailable: { fr: 'Service temporairement indisponible. Réessayez plus tard.', en: 'Service temporarily unavailable. Try again later.' },
} as const;

/** Every phrase that must appear verbatim on the public site (checked by the contract tests and the smoke run). */
export const POSITIONING_PHRASES = [POSITIONING.oneQr, POSITIONING.payLocal] as const;
