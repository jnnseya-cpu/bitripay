import { config } from '../config';
import { getDb } from '../db';
import { parseJson } from '../lib/json';
import { now } from '../lib/ids';
import type { FeeConfig, LimitConfig } from '@bitripay/shared';
import { FEE_TYPES } from '@bitripay/shared';

export interface ReferralSettings {
  enabled: boolean;
  /** Reward per referral level in base-currency minor units: index 0 = level 1 (direct). */
  rewards: number[];
  trigger: 'registration' | 'first_deposit';
}

export interface AppSettings {
  appName: string;
  supportEmail: string;
  /** Extra margin applied on top of the mid-market rate for exchanges/remittances, in bps. */
  exchangeMarginBps: number;
  /** Default agent commission in bps of the cash-in/out amount. */
  agentCommissionBps: number;
  /** Auto-refresh rates from the provider (open exchange rate API) every N hours; 0 disables. */
  rateAutoRefreshHours: number;
  rateProvider: 'manual' | 'frankfurter' | 'open_er_api' | 'exchangerate_host' | 'openexchangerates' | 'fixer';
  /** API key for keyed providers (stored encrypted). */
  rateProviderKey: string;
  /** Automatic merchant settlement: minimum balance to auto-settle and interval in hours. */
  autoSettlement: { enabled: boolean; minAmount: number; intervalHours: number };
  maintenanceMode: boolean;
  registrationOpen: boolean;
  requireKycForWithdrawals: boolean;
  p2pFeeBps: number;
}

const DEFAULT_FEES: Record<string, FeeConfig> = Object.fromEntries(FEE_TYPES.map((t) => [t, { fixed: 0, bps: 0 }]));
Object.assign(DEFAULT_FEES, {
  transfer: { fixed: 0, bps: 50 },
  qr_payment: { fixed: 0, bps: 50 },
  merchant_payment: { fixed: 0, bps: 150 },
  card_deposit: { fixed: 30, bps: 290 },
  bank_deposit: { fixed: 0, bps: 0 },
  agent_cash_in: { fixed: 0, bps: 100 },
  agent_cash_out: { fixed: 0, bps: 150 },
  withdrawal: { fixed: 100, bps: 100 },
  remittance: { fixed: 200, bps: 100 },
  exchange: { fixed: 0, bps: 50 },
  virtual_card_funding: { fixed: 0, bps: 100 },
  gift_card: { fixed: 0, bps: 0 },
  bill_payment: { fixed: 0, bps: 50 },
  mobile_topup: { fixed: 0, bps: 0 },
});

const DEFAULT_LIMITS = {
  unverified: { perTransaction: 50_000, daily: 200_000 } as LimitConfig,
  verified: { perTransaction: 1_000_000, daily: 5_000_000 } as LimitConfig,
};

const DEFAULT_REFERRAL: ReferralSettings = { enabled: true, rewards: [500, 200, 100], trigger: 'first_deposit' };

const DEFAULT_APP: AppSettings = {
  appName: 'BitriPay',
  supportEmail: 'support@bitripay.local',
  exchangeMarginBps: 100,
  agentCommissionBps: 50,
  rateAutoRefreshHours: 0,
  rateProvider: 'manual',
  rateProviderKey: '',
  autoSettlement: { enabled: false, minAmount: 10_000, intervalHours: 24 },
  maintenanceMode: false,
  registrationOpen: true,
  requireKycForWithdrawals: false,
  p2pFeeBps: 50,
};

export interface GatewayControls {
  /** Hours an intent may wait for confirmation before it expires (nothing is credited). */
  intentExpiryHours: number;
  /** Evidence must have been received within this many hours of the intent being created. */
  evidenceWindowHours: number;
  /** Parsed-evidence confidence needed to settle automatically (0-100). */
  autoConfirmScore: number;
  /** Below this the evidence is treated as unsupported and routed to manual review. */
  reviewScore: number;
  /** Accept the legacy shared-secret SMS webhook as authoritative (device-signed evidence is the standard). */
  sharedSecretAutoConfirm: boolean;
  /** Manual settlement needs a proposer and a different approver. */
  makerChecker: boolean;
  /** Administrative approvals require a fresh biometric (passkey) or PIN step-up. */
  adminStepUp: boolean;
}
const DEFAULT_GATEWAY: GatewayControls = {
  intentExpiryHours: 48,
  evidenceWindowHours: 48,
  autoConfirmScore: 80,
  reviewScore: 50,
  sharedSecretAutoConfirm: false,
  makerChecker: true,
  adminStepUp: true,
};

export interface FxSettings {
  /** Seconds a quoted rate stays guaranteed. */
  quoteTtlSeconds: number;
  /** Live rates older than this are stale: guaranteed conversion is disabled and the rate is labelled. */
  maxRateAgeHours: number;
  /** Offer guaranteed (locked) rates at all. */
  guaranteedQuotes: boolean;
}
const DEFAULT_FX: FxSettings = { quoteTtlSeconds: 120, maxRateAgeHours: 24, guaranteedQuotes: true };

export interface RiskSettings {
  maxTxPerHour: number;
  maxTxPerDay: number;
  /** New beneficiaries (bank accounts, recipients) cannot receive more than coolingOffAmount (base minor) for this long. */
  coolingOffMinutes: number;
  coolingOffAmount: number;
  /** Score at/above which an inbound payment is held for manual review instead of settling. */
  reviewScore: number;
  /** Score at/above which an outbound movement is blocked. */
  blockScore: number;
}
const DEFAULT_RISK: RiskSettings = { maxTxPerHour: 20, maxTxPerDay: 100, coolingOffMinutes: 60, coolingOffAmount: 50_000, reviewScore: 60, blockScore: 90 };

export interface ComplianceSettings {
  /** 'sandbox': only the sandbox processor / test rails may fund transfers – no live customer funds. 'live': real processors allowed on corridors marked live. */
  mode: 'sandbox' | 'live';
  /** Card-funded payouts wait this long before a payout account may execute them (chargeback exposure), unless the risk engine clears them. */
  cardPayoutHoldMinutes: number;
  /** Card-funded transfers at/above this base-currency amount (minor units) go to manual review before payout. */
  cardReviewAmount: number;
  /** Senders must declare source of funds at/above this base-currency amount (minor units). */
  sourceOfFundsThreshold: number;
  /** Payout devices/agents may not pay the same recipient more than this many times per day. */
  maxPayoutsPerRecipientPerDay: number;
  /** Minutes a claimed payout may stay in progress before it is released back to the queue. */
  payoutClaimMinutes: number;
}
const DEFAULT_COMPLIANCE: ComplianceSettings = {
  mode: 'sandbox',
  cardPayoutHoldMinutes: 0,
  cardReviewAmount: 100_000,
  sourceOfFundsThreshold: 500_000,
  maxPayoutsPerRecipientPerDay: 5,
  payoutClaimMinutes: 30,
};

export interface EmoneySettings {
  /** Promotional credit may cover platform fees on internal transactions; it is never money. */
  promoCoversFees: boolean;
  /** Days before an unused promotional credit expires. */
  promoExpiryDays: number;
  /** Reconciliation breaches suspend issuance for the programme automatically. */
  autoSuspendOnBreach: boolean;
  /** Hour (UTC) of the daily safeguarding reconciliation. */
  reconciliationHourUtc: number;
}
const DEFAULT_EMONEY: EmoneySettings = { promoCoversFees: true, promoExpiryDays: 90, autoSuspendOnBreach: true, reconciliationHourUtc: 2 };

export interface AssistSettings {
  /** Master switch for every command centre. */
  enabled: boolean;
  provider: 'anthropic';
  /** Model for reasoning, drafting and multi-step work. */
  model: string;
  /** Cheaper model for classification and short answers (used by the model router for simple prompts). */
  fastModel: string;
  /** Encrypted API key; falls back to the content agent key and then ANTHROPIC_API_KEY. */
  apiKey: string;
  /** Hard budgets enforced by the run controller. */
  maxStepsPerRun: number;
  maxTokensPerRun: number;
  /** Monthly Agent Compute Unit allowance per role (1 ACU = one US cent of model spend at list price; 0 = unlimited). */
  allowances: Record<string, number>;
  /** List prices in USD per million tokens, editable so billing follows the provider's price list. */
  pricing: Record<string, { input: number; output: number }>;
  /** Agents an administrator paused; runs are refused while paused. */
  paused: string[];
  /** Global kill switch. */
  killSwitch: boolean;
  /** Run the scheduled system agents (operations, compliance, system health) for administrators each morning. */
  scheduledSystemAgents: boolean;
  /**
   * The command centres are an optional add-on. When enabled, account holders pay a small fee from their wallet to
   * activate them for a period; everyone else keeps using BitriPay exactly as before. Administrators never pay.
   */
  /**
   * Per-use metering. Prices are disclosed before first use (consent), shown on every question, charged from the
   * wallet only when a run completes, and only when the balance covers them. Caps keep model spend inside a share of
   * fee revenue so the platform can never lose money on agents.
   */
  billing: {
    /** per_use: pay per question (recommended). included: free for everyone. subscription: the flat plan only. */
    mode: 'per_use' | 'included' | 'subscription';
    priceCurrency: string;
    /** Tax-inclusive prices per run tier in the price currency (minor units). free runs cost nothing. */
    prices: { standard: number; deep: number };
    /** VAT / digital-services tax included in the price, in basis points (2000 = 20%). */
    taxRateBps: number;
    /** Free standard questions per month for accounts that moved money this month. */
    freeRunsPerMonth: number;
    freeRunsRequireActivity: boolean;
    /** Live (model-backed) runs per account per day. */
    dailyCapPerUser: number;
    /** Platform model spend this month may not exceed this share of last month's net fee revenue… */
    platformCapPctOfFees: number;
    /** …but never below this floor (price currency, minor units) so a young platform still works. */
    platformCapFloorMinor: number;
    /** Who may request deep (main-model) runs. */
    deepRoles: string[];
    /** Bump when the disclosure text or prices change; account holders re-accept before the next question. */
    disclosureVersion: number;
    /** Sandbox: without a model key, bill and meter as if the fast model answered (synthetic tokens). */
    simulateLive: boolean;
  };
  addon: {
    enabled: boolean;
    /** Price in the price currency (minor units); shown in each wallet currency at the platform rate. */
    priceCurrency: string;
    priceMinor: number;
    periodDays: number;
    /** Free runs per month before activation is required (0 = none). */
    freeRuns: number;
    /** Renew automatically from the wallet while the account holder has not cancelled. */
    autoRenew: boolean;
  };
}

export interface WebhookSettings {
  /** Seconds to wait before each retry; the number of entries is the number of retries (default: 10s, 30s, 2m, 10m, 30m, then every 2h for 24h). */
  retryScheduleSeconds: number[];
  /** ±jitter applied to every delay so retries from many endpoints spread out. */
  jitterPct: number;
  /** Consecutive failed deliveries after which an endpoint is disabled and the merchant notified. */
  disableAfterConsecutiveFailures: number;
  /** Signature timestamp tolerance for receivers (documented; enforced by the receiver). */
  toleranceSeconds: number;
  /** Delivery timeout. */
  timeoutMs: number;
  /** Allow http:// and private/loopback destinations (development only; production always refuses them). */
  allowInsecureTargets: boolean;
  /** Bytes of the endpoint's response kept for the delivery log. */
  responseBodyBytes: number;
}

export interface GatewayProductSettings {
  /** Scan-to-Verify (KODA): free lookups per merchant per calendar month, then a per-lookup price charged to the merchant wallet. */
  koda: { freePerMonth: number; priceMinor: number; priceCurrency: string; windowHours: number };
  checkout: { defaultMinutes: number; maxMinutes: number };
  links: { defaultDays: number };
  /** Allow `POST /v1/sandbox/simulate` (never in production with live keys). */
  sandboxSimulation: boolean;
}

export interface ChannelSettings {
  ussd: {
    enabled: boolean;
    /** Short code shown in help text, e.g. *384*247#. */
    serviceCode: string;
    /** africastalking: form fields sessionId/phoneNumber/text and CON/END replies; generic: JSON in, JSON out. */
    provider: 'africastalking' | 'generic';
    /** Ceiling per USSD transaction, in the price/base currency minor units, converted per wallet currency. */
    maxPerTransaction: number;
    maxPerTransactionCurrency: string;
    sessionTtlMinutes: number;
    /** Shared secret the aggregator must send as X-Channel-Secret (or ?secret=) when set. */
    secret: string;
    allowRegistration: boolean;
  };
  sms: {
    enabled: boolean;
    /** Shared secret for the inbound webhook when set. */
    secret: string;
    /** Reply format for synchronous webhooks: plain text, TwiML (Twilio) or JSON. */
    replyFormat: 'plain' | 'twiml' | 'json';
    maxPerTransaction: number;
    maxPerTransactionCurrency: string;
    allowRegistration: boolean;
  };
  lite: { enabled: boolean };
}

export interface SeoSettings {
  siteName: string;
  /** Public web origin used for canonical URLs, sitemaps and structured data. */
  siteUrl: string;
  defaultTitle: string;
  titleSuffix: string;
  defaultDescription: string;
  ogImage: string | null;
  twitterHandle: string;
  /** Languages the site is published in (hreflang). */
  languages: string[];
  organization: { legalName: string; foundingCountry: string; email: string; phone: string; address: string; sameAs: string[] };
  /** IndexNow key (Bing, Yandex, Seznam, Naver): published at /<key>.txt and used to ping on every publish. */
  indexNowKey: string;
  agent: {
    enabled: boolean;
    provider: 'anthropic';
    model: string;
    /** Encrypted at rest; masked when read. */
    apiKey: string;
    /** Agent drafts go to review unless autoPublish is on. */
    autoPublish: boolean;
    /** Posts the agent writes per week from the topic backlog (0 = manual only). */
    postsPerWeek: number;
    /** Topic backlog the scheduler works through. */
    topics: string[];
    audience: string;
    tone: string;
    languages: string[];
    /** Countries and corridors the content focuses on. */
    markets: string[];
  };
}
const DEFAULT_SEO: SeoSettings = {
  siteName: 'BitriPay',
  siteUrl: '',
  defaultTitle: 'BitriPay – QR code payments, mobile money, cards and remittance for everyone',
  titleSuffix: ' · BitriPay',
  defaultDescription:
    'Send, receive and accept money with a QR code. Wallets, virtual cards, mobile money, bank transfers, agents and remittance that work for market traders, moto-taxi riders and businesses alike.',
  ogImage: null,
  twitterHandle: '@bitripay',
  languages: ['en', 'fr', 'sw', 'ln'],
  organization: { legalName: 'BitriPay', foundingCountry: 'CD', email: 'hello@bitripay.app', phone: '', address: '', sameAs: [] },
  indexNowKey: '',
  agent: {
    enabled: true,
    provider: 'anthropic',
    model: 'claude-opus-5',
    apiKey: '',
    autoPublish: false,
    postsPerWeek: 2,
    topics: [
      'How mobile money agents keep cash flowing in markets',
      'QR code payments for street food vendors: a practical guide',
      'Sending money from the UK to Congo: fees, speed and safety compared',
      'What safeguarding means for your e-money balance',
      'Virtual cards for online shopping without a bank card',
      'How moto-taxi riders can get paid without cash',
    ],
    audience: 'Everyday people, market traders, moto-taxi riders, small merchants, agents and diaspora senders in Africa and their families abroad',
    tone: 'Plain, warm, concrete and honest. Short sentences. No hype.',
    languages: ['en'],
    markets: ['CD', 'KE', 'NG', 'SN', 'UG', 'GB', 'FR'],
  },
};

const DEFAULT_ASSIST: AssistSettings = {
  enabled: true,
  provider: 'anthropic',
  model: 'claude-opus-5',
  fastModel: 'claude-sonnet-5',
  apiKey: '',
  maxStepsPerRun: 8,
  maxTokensPerRun: 60_000,
  allowances: { user: 500, merchant: 2_000, agent: 1_000, admin: 0 },
  pricing: { 'claude-opus-5': { input: 15, output: 75 }, 'claude-sonnet-5': { input: 3, output: 15 }, 'claude-haiku-4-5-20251001': { input: 1, output: 5 } },
  paused: [],
  killSwitch: false,
  scheduledSystemAgents: true,
  billing: {
    mode: 'per_use',
    priceCurrency: config.baseCurrency,
    prices: { standard: 5, deep: 90 },
    taxRateBps: 2000,
    freeRunsPerMonth: 5,
    freeRunsRequireActivity: true,
    dailyCapPerUser: 20,
    platformCapPctOfFees: 15,
    platformCapFloorMinor: 5_000,
    deepRoles: ['merchant', 'agent', 'admin'],
    disclosureVersion: 1,
    simulateLive: false,
  },
  addon: { enabled: false, priceCurrency: config.baseCurrency, priceMinor: 299, periodDays: 30, freeRuns: 0, autoRenew: true },
};

const DEFAULT_CHANNELS: ChannelSettings = {
  ussd: {
    enabled: true,
    serviceCode: '*149*01#',
    provider: 'africastalking',
    maxPerTransaction: 20_000,
    maxPerTransactionCurrency: config.baseCurrency,
    sessionTtlMinutes: 1.5,
    secret: '',
    allowRegistration: true,
  },
  sms: { enabled: true, secret: '', replyFormat: 'plain', maxPerTransaction: 10_000, maxPerTransactionCurrency: config.baseCurrency, allowRegistration: true },
  lite: { enabled: true },
};

const DEFAULT_GATEWAY_PRODUCTS: GatewayProductSettings = {
  koda: { freePerMonth: 30, priceMinor: 25, priceCurrency: config.baseCurrency, windowHours: 72 },
  checkout: { defaultMinutes: 30, maxMinutes: 1440 },
  links: { defaultDays: 7 },
  sandboxSimulation: true,
};

const DEFAULT_WEBHOOKS: WebhookSettings = {
  // Eight attempts with exponential backoff spanning roughly 24 hours (10 s, 30 s, 2 min, 10 min, 1 h, 3 h, 8 h, 11.7 h).
  retryScheduleSeconds: [10, 30, 120, 600, 3600, 10_800, 28_800, 42_000],
  jitterPct: 10,
  disableAfterConsecutiveFailures: 50,
  toleranceSeconds: 300,
  timeoutMs: 10_000,
  allowInsecureTargets: false,
  responseBodyBytes: 2048,
};

const DEFAULTS: Record<string, unknown> = {
  webhooks: DEFAULT_WEBHOOKS,
  gateway_products: DEFAULT_GATEWAY_PRODUCTS,
  assist: DEFAULT_ASSIST,
  channels: DEFAULT_CHANNELS,
  seo: DEFAULT_SEO,
  emoney: DEFAULT_EMONEY,
  compliance: DEFAULT_COMPLIANCE,
  fees: DEFAULT_FEES,
  limits: DEFAULT_LIMITS,
  referral: DEFAULT_REFERRAL,
  app: DEFAULT_APP,
  gateway: DEFAULT_GATEWAY,
  fx: DEFAULT_FX,
  risk: DEFAULT_RISK,
};

export function getSetting<T>(key: string, fallback?: T): T {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  const def = (fallback ?? DEFAULTS[key]) as T;
  if (!row) return def;
  const parsed = parseJson<T>(row.value, def);
  // shallow-merge object settings with defaults so new keys appear automatically
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && def && typeof def === 'object') {
    return { ...(def as object), ...(parsed as object) } as T;
  }
  return parsed;
}

export function setSetting(key: string, value: unknown) {
  getDb()
    .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(key, JSON.stringify(value), now());
}

export const getFees = () => getSetting<Record<string, FeeConfig>>('fees');
export const getLimits = () => getSetting<typeof DEFAULT_LIMITS>('limits');
export const getReferralSettings = () => getSetting<ReferralSettings>('referral');
export const getAppSettings = () => getSetting<AppSettings>('app');
export const getGatewayControls = () => getSetting<GatewayControls>('gateway');
export const getFxSettings = () => getSetting<FxSettings>('fx');
export const getRiskSettings = () => getSetting<RiskSettings>('risk');
export const getComplianceSettings = () => getSetting<ComplianceSettings>('compliance');
export const getEmoneySettings = () => getSetting<EmoneySettings>('emoney');
export const getSeoSettings = () => getSetting<SeoSettings>('seo');
export const getAssistSettings = () => {
  const s = getSetting<AssistSettings>('assist');
  return {
    ...s,
    addon: { ...DEFAULT_ASSIST.addon, ...(s.addon ?? {}) },
    billing: { ...DEFAULT_ASSIST.billing, ...(s.billing ?? {}), prices: { ...DEFAULT_ASSIST.billing.prices, ...(s.billing?.prices ?? {}) } },
  };
};
export const getGatewayProductSettings = (): GatewayProductSettings => {
  const s = getSetting<Partial<GatewayProductSettings>>('gateway_products');
  return {
    ...DEFAULT_GATEWAY_PRODUCTS,
    ...s,
    koda: { ...DEFAULT_GATEWAY_PRODUCTS.koda, ...(s.koda ?? {}) },
    checkout: { ...DEFAULT_GATEWAY_PRODUCTS.checkout, ...(s.checkout ?? {}) },
    links: { ...DEFAULT_GATEWAY_PRODUCTS.links, ...(s.links ?? {}) },
  };
};
export const getWebhookSettings = (): WebhookSettings => ({ ...DEFAULT_WEBHOOKS, ...getSetting<Partial<WebhookSettings>>('webhooks') });
export const getChannelSettings = () => {
  const s = getSetting<ChannelSettings>('channels');
  return { ussd: { ...DEFAULT_CHANNELS.ussd, ...(s.ussd ?? {}) }, sms: { ...DEFAULT_CHANNELS.sms, ...(s.sms ?? {}) }, lite: { ...DEFAULT_CHANNELS.lite, ...(s.lite ?? {}) } };
};
/** Site settings without importing the CMS module (used by the SEO renderer). */
export const getSiteSettingsSafe = () =>
  getSetting<any>('site', null) as { siteName?: string; logoUrl?: string | null; contactEmail?: string; social?: Record<string, string>; appUrls?: Record<string, string> } | null;
