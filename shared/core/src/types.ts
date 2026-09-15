import type { KycStatus, Role, TransactionStatus, TransactionType, PaymentRequestStatus, OrgRole, OrgPermission } from './constants';
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
  status: 'active' | 'suspended' | 'closed';
  hasPin: boolean;
  twoFactorEnabled: boolean;
  /** Loud sound + vibration for money events (default on). */
  loudAlerts?: boolean;
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
  /** Promotional credit – a marketing liability that can cover fees; never withdrawable or transferable as money. */
  promoBalance?: number;
  frozen?: boolean;
  frozenReason?: string | null;
  /** What this balance legally is (regulated e-money, merchant balance, agent float or sandbox money). */
  classification?: {
    class: 'emoney' | 'merchant' | 'agent_float' | 'sandbox';
    label: string;
    redeemable: boolean;
    transferable: boolean;
    backing: string;
    issuer: string | null;
    programmeStatus: string | null;
  };
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
  /** Payment intent behind the request when it was created through the gateway (checkout sessions, links). */
  intentId?: string | null;
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
  /** Amount band for this operation in base-currency minor units (0 or absent = no bound). */
  minAmount?: number;
  maxAmount?: number;
  /** Agent commission on this operation in basis points of the amount, paid out of the BitriPay fee (absent = platform default). */
  agentBps?: number;
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
  /** The administration console (separate host name); the sign-in page links to it. */
  adminUrl?: string;
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

/** A legal entity that accepts payments: the merchant-class account that registered it is its owner. */
export interface Organisation {
  id: string;
  name: string;
  kind: string;
  ownerUserId: string;
  country: string | null;
  status: string;
  kybStatus: string;
  settings: { cashierRefundLimitMinor: number };
  createdAt: string;
  updatedAt: string;
}

/** One line per organisation a signed-in person can act for (`GET /api/auth/me`): their own or one they were invited to. */
export interface MembershipSummary {
  organisationId: string;
  name: string;
  /** `agent` for an agent's team; a merchant-class role (merchant, corporate, ngo, government, developer) for a shop. */
  kind: string;
  role: OrgRole;
  owner: boolean;
}

export interface OrganisationMember {
  organisationId: string;
  userId: string;
  role: OrgRole;
  permissions: (OrgPermission | '*')[];
  user: PublicUser | null;
  invitedBy: string | null;
  createdAt: string;
}

/** A department, branch or programme inside an organisation; locations, terminals and QRs may belong to one. */
export interface BusinessUnit {
  id: string;
  organisationId: string;
  name: string;
  code: string;
  settlementProfileId: string | null;
  locations: number;
  createdAt: string;
  updatedAt: string;
}
