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
  rateProvider: 'manual' | 'frankfurter' | 'open_er_api';
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
  autoSettlement: { enabled: false, minAmount: 10_000, intervalHours: 24 },
  maintenanceMode: false,
  registrationOpen: true,
  requireKycForWithdrawals: false,
  p2pFeeBps: 50,
};

const DEFAULTS: Record<string, unknown> = {
  fees: DEFAULT_FEES,
  limits: DEFAULT_LIMITS,
  referral: DEFAULT_REFERRAL,
  app: DEFAULT_APP,
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
