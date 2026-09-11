import type { Request } from 'express';

export type PaymentMethod = 'card' | 'mobile_money' | 'bank' | 'wallet' | 'virtual_card';
export type GatewayProviderId = 'sandbox' | 'stripe' | 'paystack' | 'flutterwave' | 'mtn_momo' | 'mpesa' | 'manual_bank';

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
  status: 'succeeded' | 'failed' | 'pending';
  raw?: unknown;
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
}
