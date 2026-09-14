import type { Request } from 'express';

/** `bitcoin`: a payment rail behind the same intent and QR (Lightning or on-chain), never a second checkout system. */
export type PaymentMethod = 'card' | 'mobile_money' | 'bank' | 'wallet' | 'virtual_card' | 'bitcoin';
export type GatewayProviderId = 'sandbox' | 'stripe' | 'paystack' | 'flutterwave' | 'mtn_momo' | 'mpesa' | 'manual_bank' | 'manual_momo' | 'open_banking' | 'bitcoin';

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
  /**
   * Connector idempotency key: the platform passes the payment / attempt id so a retried initiate never charges twice.
   * Providers that support idempotent creation send it as their idempotency header; the sandbox derives its provider
   * reference from it so the same key always yields the same reference. (Optional in the type so every existing
   * dispatcher compiles; the dispatcher in services/payments.ts should pass `payment.id`.)
   */
  idempotencyKey?: string;
}

/** Disclosed fiat → BTC rate an invoice was priced at (margin and source are always shown; sandbox rates are labelled). */
export interface BitcoinRateDisclosure {
  fiatCurrency: string;
  /** Mid rate: 1 fiat unit = midRate BTC. */
  midRate: number;
  /** Effective rate the payer gets after the platform margin (1 fiat unit = rate BTC; the margin raises the sats due). */
  rate: number;
  marginBps: number;
  /** Satoshis due per one fiat unit at the effective rate. */
  satsPerUnit: number;
  /** Where the rate came from (`sandbox_btc_rate_v1`, `import_v<n>`, a live provider id). */
  rateSource: string;
  rateUpdatedAt: string | null;
  /** True when the rate is a sandbox / test rate – never presented as a live market rate. */
  sandbox: boolean;
  label: string;
}

/** A Bitcoin invoice issued for a payment: Lightning (BOLT11) and/or an on-chain address for the same amount. */
export interface BitcoinInvoiceView {
  invoiceId: string;
  mode: 'sandbox' | 'btcpay';
  network: string;
  fiat: { amountMinor: number; currency: string };
  amountSats: number;
  amountBtc: string;
  /** BOLT11 Lightning invoice, settled the moment it is paid. */
  lightning: string | null;
  /** On-chain address, settled after `confirmations.onChain` confirmations. */
  address: string | null;
  /** BIP21 URI combining the on-chain address, the amount and (when present) the Lightning invoice. */
  bip21: string | null;
  /** Hosted BTCPay checkout page (btcpay mode). */
  checkoutUrl: string | null;
  rate: BitcoinRateDisclosure;
  expiresAt: string;
  confirmations: { lightning: 'settled_on_payment'; onChain: number };
  sandbox: boolean;
}

export interface NextAction {
  type: 'none' | 'redirect' | 'stripe_payment_intent' | 'prompt' | 'bank_instructions' | 'bitcoin_invoice';
  url?: string;
  clientSecret?: string;
  publishableKey?: string;
  message?: string;
  instructions?: Record<string, string>;
  /** Present when `type` is `bitcoin_invoice`. */
  invoice?: BitcoinInvoiceView;
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
  /** `unknown`: the provider could not say whether money moved (timeout, contradictory answer). The payment is parked for review, never retried blindly. */
  status: 'pending' | 'succeeded' | 'failed' | 'unknown';
  failureReason?: string;
  raw?: unknown;
  savedCard?: InitiateResult['savedCard'];
}

export interface WebhookEvent {
  providerRef: string;
  /** `unknown`: the provider reports money moved without a final outcome (e.g. a partially paid, expired invoice) – parked for review. */
  status: 'succeeded' | 'failed' | 'pending' | 'disputed' | 'refunded' | 'unknown';
  reason?: string | null;
  raw?: unknown;
}

export interface RefundResult {
  status: 'succeeded' | 'pending' | 'manual';
  providerRef?: string | null;
  message?: string;
}

/** What a connector can do, sourced from the provider contract and the gateway configuration. */
export interface ConnectorCapabilities {
  /** Smallest / largest amount the connector accepts, in minor units of the payment currency (0 = no limit). */
  minMinor: number;
  maxMinor: number;
  /** The connector can refund (part of) a settled charge through its API. */
  refunds: boolean;
  /** Settlement delay in days (T+n) between capture and funds availability. */
  settlementT: number;
  /** The connector pushes asynchronous status updates (webhooks). */
  webhooks: boolean;
  /** When the connector last opened its circuit (platform-observed incident), ISO timestamp or null. */
  lastIncidentAt: string | null;
}

/** Inputs for a fee / FX / ETA quote before initiate. FX is owned by the platform: the effective rate is passed in. */
export interface QuoteContext {
  amountMinor: number;
  currency: string;
  /** Currency the funds settle in when it differs from the charge currency. */
  targetCurrency?: string | null;
  method: PaymentMethod;
  country?: string | null;
  operatorId?: string | null;
  /** Platform FX rate (1 currency = fxRate targetCurrency) when currencies differ. */
  fxRate?: number | null;
  credentials: Record<string, string>;
}
export interface QuoteResult {
  feeMinor: number;
  feeBps: number;
  currency: string;
  targetCurrency: string;
  /** Rate applied between currency and targetCurrency (1 when equal, null when the provider cannot quote it). */
  fxRate: number | null;
  /** Estimated time to a final status. */
  etaSeconds: number;
  expiresAt: string | null;
  /** Rate disclosure when the quote converts into a crypto asset (Bitcoin rail). */
  disclosure?: BitcoinRateDisclosure;
}

/** One line of a provider statement, normalised for the processor reconciliation (services/finops/processorRecon). */
export interface StatementLine {
  reference: string;
  amountMinor: number;
  currency: string | null;
  status: string;
  feeMinor: number | null;
  settlementRef?: string | null;
  occurredAt?: string | null;
}

export interface CancelResult {
  /** `manual`: no API to cancel, operations must void it with the provider; `not_cancellable`: already final. */
  status: 'cancelled' | 'pending' | 'manual' | 'not_cancellable';
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
  /** Fee, FX and ETA quote before initiate (shown to the payer / used by Smart Route). */
  quote?(ctx: QuoteContext): Promise<QuoteResult>;
  /** Static capabilities of the connector for the stored credentials (limits, refunds, settlement T+n, webhooks). */
  capabilities?(credentials: Record<string, string>): Partial<ConnectorCapabilities>;
  /** Parse a provider statement (CSV or JSON export) into normalised lines for the processor reconciliation. */
  parseStatement?(csvOrJson: string, credentials: Record<string, string>): StatementLine[];
  /** Cancel / void a payment that has not reached a final state. */
  cancel?(payment: GatewayPaymentRow, credentials: Record<string, string>): Promise<CancelResult>;
}

export type GatewayMode = 'test' | 'live' | 'unknown';
export interface HealthResult {
  ok: boolean;
  mode: GatewayMode;
  message: string;
  details?: Record<string, unknown>;
}
