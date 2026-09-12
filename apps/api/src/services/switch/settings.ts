/** Settings for the National Switch Gateway (settings key `switch`). Every number is a BitriPay design choice, not a published scheme characteristic. */
import { getSetting } from '../settings';

export interface SwitchSettings {
  /** Registry older than this (hours since the last approved change/attestation) refuses new emissions (RTE-005). */
  registryToleranceHours: number;
  /** Seconds after a send without a persisted response before the emission is treated as uncertain. */
  uncertainTimeoutSeconds: number;
  /** Delays between successive inquiries for an uncertain emission. */
  inquiryDelaysSeconds: number[];
  /** After this many inquiries without a definitive answer a LOCAL_ONLY case is opened; the payment stays UNKNOWN. */
  maxInquiries: number;
  /** Versioned tariff used to detect FEES_MISMATCH. */
  feeBps: number;
  /** Merchant velocity limit before emission (payments per rolling hour). */
  velocityPerHour: number;
  defaultCurrency: string;
  /** Product ceilings in minor units, per currency (empty = capability ceiling only). */
  productCeilings: Record<string, Record<string, number>>;
  /** Report sources whose absence means incomplete coverage. */
  expectedReportSources: string[];
  businessTimezone: string;
  dispatcherLeaseSeconds: number;
  /** Refuse new initiations while the connection link is down (19.1 default). */
  refuseWhenLinkDown: boolean;
  /** Days before certificate expiry at which alerts are raised. */
  certificateAlertDays: number[];
}

const DEFAULT_SWITCH: SwitchSettings = {
  registryToleranceHours: 24 * 14,
  uncertainTimeoutSeconds: 30,
  inquiryDelaysSeconds: [10, 30, 120, 600, 1800, 3600, 7200, 14400],
  maxInquiries: 8,
  feeBps: 50,
  velocityPerHour: 300,
  defaultCurrency: 'CDF',
  productCeilings: { MERCHANT_PAYMENT: { CDF: 5_000_000_00, USD: 5_000_00 } },
  expectedReportSources: ['SWITCH', 'INSTITUTION'],
  businessTimezone: 'Africa/Kinshasa',
  dispatcherLeaseSeconds: 30,
  refuseWhenLinkDown: true,
  certificateAlertDays: [60, 30, 14, 7],
};

export const getSwitchSettings = (): SwitchSettings => {
  const s = getSetting<Partial<SwitchSettings>>('switch', {});
  return { ...DEFAULT_SWITCH, ...s, productCeilings: { ...DEFAULT_SWITCH.productCeilings, ...(s.productCeilings ?? {}) } };
};

/** Business date in the configured operational timezone (never derived from a browser clock). */
export function businessDate(at: Date = new Date(), timeZone = getSwitchSettings().businessTimezone): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
