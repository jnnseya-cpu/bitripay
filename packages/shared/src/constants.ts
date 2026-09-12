export const ROLES = ['user', 'merchant', 'agent', 'admin'] as const;
export type Role = (typeof ROLES)[number];

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
] as const;
export type FeeType = (typeof FEE_TYPES)[number];

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
};
