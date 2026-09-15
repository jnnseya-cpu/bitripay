export const ROLES = ['user', 'merchant', 'agent', 'admin', 'corporate', 'ngo', 'government', 'developer'] as const;
export type Role = (typeof ROLES)[number];

/** Merchant-class account types: each runs an organisation (legal entity), accepts payments and uses the merchant surfaces. */
export const MERCHANT_CLASS_ROLES = ['merchant', 'corporate', 'ngo', 'government', 'developer'] as const;
export type MerchantClassRole = (typeof MERCHANT_CLASS_ROLES)[number];
/** True for every account type that accepts payments as a business (merchant, corporate, NGO, government, developer). */
export const isMerchantClass = (role: string | null | undefined): boolean => (MERCHANT_CLASS_ROLES as readonly string[]).includes(role ?? '');

/**
 * Account types that own an organisation and can therefore let other people work in it with their own login and an
 * assigned role: every merchant-class account and agents (counter staff, branch cashiers). Personal accounts own none;
 * platform administrators are individual accounts with console permissions.
 */
export const ORGANISATION_OWNER_ROLES = [...MERCHANT_CLASS_ROLES, 'agent'] as const;
export const canOwnOrganisation = (role: string | null | undefined): boolean => (ORGANISATION_OWNER_ROLES as readonly string[]).includes(role ?? '');

/** Roles a person can hold inside an organisation (specification §44). The owner is the account that registered the organisation. */
export const ORG_ROLES = ['owner', 'administrator', 'finance_manager', 'operations_manager', 'developer', 'analyst', 'cashier', 'support', 'compliance_reviewer', 'read_only'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** Everything an organisation member can be allowed to do; `requireOrgPermission` on the API checks these. */
export const ORG_PERMISSION_KEYS = [
  'org:manage_members',
  'org:manage_units',
  'org:settings',
  'payments:create',
  'payments:view',
  'refunds:issue',
  'refunds:unrestricted',
  'settlement:view',
  'settlement:change',
  'api_keys:view',
  'api_keys:manage',
  'webhooks:manage',
  'payouts:create',
  'statements:view',
  'customers:export',
  'disputes:respond',
  'compliance:review',
  // Agent organisations (counter staff acting for an agent with their own login)
  'agent:view',
  'agent:cash_in',
  'agent:cash_out',
  'agent:pickups',
  'agent:onboard',
  'agent:float',
  'agent:payouts',
] as const;
export type OrgPermission = (typeof ORG_PERMISSION_KEYS)[number];

/** The agent-side permission keys (`agent:*`): what counter staff of an agent organisation may do at the till. */
export const AGENT_ORG_PERMISSION_KEYS = ORG_PERMISSION_KEYS.filter((k) => k.startsWith('agent:'));

/**
 * Permission matrix per organisation role. `*` is every permission. A cashier issues refunds only up to the
 * organisation's cashier limit (`refunds:issue` without `refunds:unrestricted`), never touches settlement
 * instructions, API secrets or customer exports. API keys act with the organisation's full permissions.
 * In an agent organisation the same roles apply to the till: a cashier serves customers (cash-in, cash-out,
 * pickups, assisted onboarding) with the agent's float but never requests float or handles payout claims; an
 * operations manager runs the whole counter; analysts and read-only members only see the figures.
 */
export const ORG_PERMISSIONS: Record<OrgRole, readonly (OrgPermission | '*')[]> = {
  owner: ['*'],
  administrator: [...ORG_PERMISSION_KEYS],
  finance_manager: [
    'payments:view',
    'refunds:issue',
    'refunds:unrestricted',
    'settlement:view',
    'settlement:change',
    'payouts:create',
    'statements:view',
    'customers:export',
    'disputes:respond',
    'agent:view',
    'agent:float',
  ],
  operations_manager: [
    'org:manage_units',
    'payments:create',
    'payments:view',
    'refunds:issue',
    'settlement:view',
    'statements:view',
    'disputes:respond',
    'agent:view',
    'agent:cash_in',
    'agent:cash_out',
    'agent:pickups',
    'agent:onboard',
    'agent:float',
    'agent:payouts',
  ],
  developer: ['api_keys:view', 'api_keys:manage', 'webhooks:manage', 'payments:create', 'payments:view'],
  analyst: ['payments:view', 'settlement:view', 'statements:view', 'agent:view'],
  cashier: ['payments:create', 'payments:view', 'refunds:issue', 'agent:view', 'agent:cash_in', 'agent:cash_out', 'agent:pickups', 'agent:onboard'],
  support: ['payments:view', 'refunds:issue', 'disputes:respond', 'agent:view'],
  compliance_reviewer: ['payments:view', 'statements:view', 'compliance:review', 'disputes:respond', 'agent:view'],
  read_only: ['payments:view', 'settlement:view', 'statements:view', 'agent:view'],
};

/** Whether a role (plus any extra per-member grants) holds a permission. */
export function orgRoleHasPermission(role: OrgRole, permission: OrgPermission, extra: readonly string[] = []): boolean {
  const held = ORG_PERMISSIONS[role] ?? [];
  return held.includes('*') || held.includes(permission) || extra.includes('*') || extra.includes(permission);
}

export const TRANSACTION_TYPES = [
  'transfer',
  'qr_payment',
  'merchant_payment',
  'money_request',
  'card_deposit',
  'bank_deposit',
  'mobile_money_deposit',
  'agent_cash_in',
  'agent_cash_out',
  'withdrawal',
  'remittance',
  'exchange',
  'virtual_card_funding',
  'gift_card',
  'bill_payment',
  'mobile_topup',
  'referral_reward',
  'admin_adjustment',
  'refund',
  'payout',
  'liquidity_prefund',
  'liquidity_adjustment',
  'emoney_mint',
  'emoney_burn',
  'distribution',
  'promo_credit',
  'subscription',
  'agent_usage',
  'verification',
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_STATUSES = ['pending', 'completed', 'failed', 'rejected', 'cancelled', 'reversed'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const KYC_STATUSES = ['none', 'pending', 'verified', 'rejected'] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

export const PAYMENT_REQUEST_STATUSES = ['open', 'paid', 'declined', 'cancelled', 'expired'] as const;
export type PaymentRequestStatus = (typeof PAYMENT_REQUEST_STATUSES)[number];

/** Transaction types that can carry a configurable platform fee. */
export const FEE_TYPES = [
  'transfer',
  /** Aggregation fee on a payment routed through the national switch (charged to the merchant, never taken from the interbank flow). */
  'switch_payment',
  'qr_payment',
  'merchant_payment',
  'card_deposit',
  'bank_deposit',
  'mobile_money_deposit',
  'agent_cash_in',
  'agent_cash_out',
  'withdrawal',
  'remittance',
  'exchange',
  'virtual_card_funding',
  'gift_card',
  'bill_payment',
  'mobile_topup',
  'money_request',
  'payment_link',
  'virtual_card_issue',
] as const;
export type FeeType = (typeof FEE_TYPES)[number];
/** Names used on the tariff grid (admin console, statements, developer portal). */
export const FEE_TYPE_LABELS: Record<FeeType, string> = {
  transfer: 'Transfer money (P2P)',
  qr_payment: 'QR payment (merchant)',
  merchant_payment: 'Merchant payment (make payment)',
  switch_payment: 'National switch payment (aggregation fee, invoiced to the merchant)',
  money_request: 'Request money',
  payment_link: 'Payment link (Pay-Link)',
  card_deposit: 'Money in · card',
  bank_deposit: 'Money in · bank transfer',
  mobile_money_deposit: 'Money in · mobile money',
  agent_cash_in: 'Money in · agent cash-in',
  agent_cash_out: 'Money out · agent cash-out',
  withdrawal: 'Money out · withdrawal',
  remittance: 'Remittance (international)',
  exchange: 'Money exchange',
  virtual_card_issue: 'Virtual card · issue',
  virtual_card_funding: 'Virtual card · reload',
  gift_card: 'Gift card',
  bill_payment: 'Bill pay',
  mobile_topup: 'Mobile top-up',
};

export const TRANSACTION_TYPE_LABELS: Record<TransactionType, string> = {
  transfer: 'Transfer',
  qr_payment: 'QR Payment',
  merchant_payment: 'Merchant Payment',
  money_request: 'Money Request',
  card_deposit: 'Add Money (Card)',
  bank_deposit: 'Add Money (Bank)',
  mobile_money_deposit: 'Add Money (Mobile Money)',
  agent_cash_in: 'Agent Cash In',
  agent_cash_out: 'Agent Cash Out',
  withdrawal: 'Withdrawal',
  remittance: 'Remittance',
  exchange: 'Currency Exchange',
  virtual_card_funding: 'Virtual Card Funding',
  gift_card: 'Gift Card',
  bill_payment: 'Bill Payment',
  mobile_topup: 'Mobile Top-Up',
  referral_reward: 'Referral Reward',
  admin_adjustment: 'Admin Adjustment',
  refund: 'Refund',
  payout: 'Payout (external)',
  liquidity_prefund: 'Liquidity Prefund',
  liquidity_adjustment: 'Liquidity Adjustment',
  emoney_mint: 'E-money Issued',
  emoney_burn: 'E-money Redeemed',
  distribution: 'Distribution',
  promo_credit: 'Promotional Credit',
  subscription: 'Subscription',
  agent_usage: 'Agent question',
  verification: 'Payment verification',
};
