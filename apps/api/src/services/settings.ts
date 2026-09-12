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

const DEFAULT_FEES: Record<string, FeeConfig> = Object.fromEntries(
  FEE_TYPES.map((t) => [t, { fixed: 0, bps: 0 }]),
);
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
const DEFAULT_GATEWAY: GatewayControls = { intentExpiryHours: 48, evidenceWindowHours: 48, autoConfirmScore: 80, reviewScore: 50, sharedSecretAutoConfirm: false, makerChecker: true, adminStepUp: true };

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
const DEFAULT_COMPLIANCE: ComplianceSettings = { mode: 'sandbox', cardPayoutHoldMinutes: 0, cardReviewAmount: 100_000, sourceOfFundsThreshold: 500_000, maxPayoutsPerRecipientPerDay: 5, payoutClaimMinutes: 30 };

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
  defaultDescription: 'Send, receive and accept money with a QR code. Wallets, virtual cards, mobile money, bank transfers, agents and remittance that work for market traders, moto-taxi riders and businesses alike.',
  ogImage: null,
  twitterHandle: '@bitripay',
  languages: ['en', 'fr', 'sw', 'ln'],
  organization: { legalName: 'BitriPay', foundingCountry: 'CD', email: 'hello@bitripay.app', phone: '', address: '', sameAs: [] },
  indexNowKey: '',
  agent: { enabled: true, provider: 'anthropic', model: 'claude-opus-5', apiKey: '', autoPublish: false, postsPerWeek: 2, topics: ['How mobile money agents keep cash flowing in markets', 'QR code payments for street food vendors: a practical guide', 'Sending money from the UK to Congo: fees, speed and safety compared', 'What safeguarding means for your e-money balance', 'Virtual cards for online shopping without a bank card', 'How moto-taxi riders can get paid without cash'], audience: 'Everyday people, market traders, moto-taxi riders, small merchants, agents and diaspora senders in Africa and their families abroad', tone: 'Plain, warm, concrete and honest. Short sentences. No hype.', languages: ['en'], markets: ['CD', 'KE', 'NG', 'SN', 'UG', 'GB', 'FR'] },
};

const DEFAULTS: Record<string, unknown> = {
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
/** Site settings without importing the CMS module (used by the SEO renderer). */
export const getSiteSettingsSafe = () => getSetting<any>('site', null) as { siteName?: string; logoUrl?: string | null; contactEmail?: string; social?: Record<string, string>; appUrls?: Record<string, string> } | null;
