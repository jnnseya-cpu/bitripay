import type { Request } from 'express';

export type PaymentMethod = 'card' | 'mobile_money' | 'bank' | 'wallet' | 'virtual_card';
export type GatewayProviderId = 'sandbox' | 'stripe' | 'paystack' | 'flutterwave' | 'mtn_momo' | 'mpesa' | 'manual_bank' | 'manual_momo';

export interface GatewayPaymentRow {
  id: string;
  gateway: string;
  provider_ref: string | null;
  method: PaymentMethod;
  purpose: 'deposit' | 'checkout';
  user_id: string | null;
  payment_request_id: string | null;
  amount: number;
  currency: string;
  fee: number;
  status: 'initiated' | 'pending' | 'succeeded' | 'failed' | 'cancelled';
  /** Lifecycle stage (see services/lifecycle.ts). `status` is derived from it. */
  stage: string;
  expires_at: string | null;
  authenticated_at: string | null;
  auth_method: string | null;
  payer_email: string | null;
  payer_phone: string | null;
  payer_name: string | null;
  saved_card_id: string | null;
  metadata: string;
  transaction_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CardInput {
  number: string;
  expMonth: number;
  expYear: number;
  cvc: string;
  holderName: string;
}

export interface InitiateContext {
  payment: GatewayPaymentRow;
  amountMajor: number;
  amountMinor: number;
  currency: string;
  decimals: number;
  method: PaymentMethod;
  payer: { email: string | null; phone: string | null; name: string | null; userId: string | null };
  card?: CardInput;
  /** Provider token of a previously saved card (e.g. Stripe payment method id, Paystack authorization code). */
  savedCardToken?: string | null;
  saveCard?: boolean;
  /** Where the provider should send the customer back after a hosted flow. */
  returnUrl: string;
  callbackUrl: string;
  credentials: Record<string, string>;
  description: string;
  /** Mobile money operator chosen by the payer (direct rail / routing hints). */
  operatorId?: string | null;
}

export interface NextAction {
  type: 'none' | 'redirect' | 'stripe_payment_intent' | 'prompt' | 'bank_instructions';
  url?: string;
  clientSecret?: string;
  publishableKey?: string;
  message?: string;
  instructions?: Record<string, string>;
}

export interface InitiateResult {
  providerRef: string;
  status: 'pending' | 'succeeded' | 'failed';
  next: NextAction;
  failureReason?: string;
  /** If the provider tokenized the card for reuse. */
  savedCard?: { token: string; brand: string; last4: string; expMonth: number; expYear: number };
  raw?: unknown;
}

export interface VerifyResult {
  status: 'pending' | 'succeeded' | 'failed';
  failureReason?: string;
  raw?: unknown;
  savedCard?: InitiateResult['savedCard'];
}

export interface WebhookEvent {
  providerRef: string;
  status: 'succeeded' | 'failed' | 'pending' | 'disputed' | 'refunded';
  reason?: string | null;
  raw?: unknown;
}

export interface RefundResult {
  status: 'succeeded' | 'pending' | 'manual';
  providerRef?: string | null;
  message?: string;
}

export interface GatewayProvider {
  id: GatewayProviderId;
  name: string;
  supportedMethods: PaymentMethod[];
  /** Credentials keys this provider needs; used by the admin UI form. */
  credentialFields: { key: string; label: string; secret?: boolean }[];
  initiate(ctx: InitiateContext): Promise<InitiateResult>;
  verify(payment: GatewayPaymentRow, credentials: Record<string, string>): Promise<VerifyResult>;
  /** Parse + authenticate an incoming webhook, returning status updates for provider refs. */
  parseWebhook?(req: Request, credentials: Record<string, string>): Promise<WebhookEvent[]>;
  /** Refund (part of) a settled charge back to the original instrument. Providers without an API return status 'manual'. */
  refund?(payment: GatewayPaymentRow, amountMinor: number, reason: string, credentials: Record<string, string>): Promise<RefundResult>;
  /** Whether the stored credentials are test or live keys, without calling the provider. */
  keyMode?(credentials: Record<string, string>): GatewayMode;
  /** Call the provider with the stored credentials to prove they work (onboarding). */
  healthCheck?(credentials: Record<string, string>): Promise<HealthResult>;
}

export type GatewayMode = 'test' | 'live' | 'unknown';
export interface HealthResult {
  ok: boolean;
  mode: GatewayMode;
  message: string;
  details?: Record<string, unknown>;
}
