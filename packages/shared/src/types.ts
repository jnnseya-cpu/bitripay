import type { KycStatus, Role, TransactionStatus, TransactionType, PaymentRequestStatus } from './constants';
import type { CurrencyInfo } from './money';

export interface PublicUser {
  id: string;
  tag: string;
  fullName: string;
  role: Role;
  avatarColor: string;
  businessName?: string | null;
  country?: string | null;
}

export interface User extends PublicUser {
  email: string | null;
  phone: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  kycStatus: KycStatus;
  status: 'active' | 'suspended';
  hasPin: boolean;
  twoFactorEnabled: boolean;
  referralCode: string;
  referredBy?: string | null;
  agentCommissionBps?: number | null;
  webhookUrl?: string | null;
  createdAt: string;
}

export interface Wallet {
  id: string;
  userId: string;
  currency: string;
  balance: number;
  createdAt: string;
}

export interface Transaction {
  id: string;
  reference: string;
  type: TransactionType;
  status: TransactionStatus;
  amount: number;
  fee: number;
  currency: string;
  /** Amount credited to the receiver, in the receiver's currency (differs for exchange / remittance). */
  receiveAmount?: number | null;
  receiveCurrency?: string | null;
  senderUserId: string | null;
  receiverUserId: string | null;
  senderWalletId: string | null;
  receiverWalletId: string | null;
  note: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  completedAt: string | null;
  /** Direction relative to the requesting user. */
  direction?: 'in' | 'out' | 'neutral';
  counterparty?: PublicUser | null;
}

export interface PaymentRequest {
  id: string;
  code: string;
  kind: 'qr' | 'link' | 'request' | 'api';
  requesterUserId: string;
  payerUserId: string | null;
  amount: number | null;
  currency: string;
  description: string | null;
  status: PaymentRequestStatus;
  expiresAt: string | null;
  paidTransactionId: string | null;
  successUrl?: string | null;
  cancelUrl?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  requester?: PublicUser;
  payer?: PublicUser | null;
  qr?: string;
  link?: string;
}

export interface FeeConfig {
  fixed: number; // in base currency minor units
  bps: number; // basis points
}

export interface LimitConfig {
  perTransaction: number; // base currency minor units
  daily: number;
}

export interface AppConfig {
  appName: string;
  baseCurrency: string;
  currencies: CurrencyInfo[];
  fees: Record<string, FeeConfig>;
  limits: { unverified: LimitConfig; verified: LimitConfig };
  features: {
    stripe: boolean;
    stripePublishableKey: string | null;
    sandboxPayments: boolean;
    emailOtp: boolean;
    smsOtp: boolean;
  };
  webUrl: string;
  agentCommissionBps: number;
  referral: { enabled: boolean; rewards: number[]; trigger: 'registration' | 'first_deposit' };
}

export interface Notification {
  id: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

export interface SavedCard {
  id: string;
  provider: 'sandbox' | 'stripe';
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  holderName: string;
  isDefault: boolean;
}

export interface VirtualCard {
  id: string;
  currency: string;
  balance: number;
  maskedNumber: string;
  expMonth: number;
  expYear: number;
  holderName: string;
  status: 'active' | 'frozen' | 'closed';
  createdAt: string;
}

export interface ApiKey {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface BankAccount {
  id: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  currency: string;
  country: string | null;
  isDefault: boolean;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
