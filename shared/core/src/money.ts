export interface CurrencyInfo {
  code: string;
  name: string;
  symbol: string;
  decimals: number;
  /** How many units of this currency equal 1 unit of the platform base currency. */
  rateToBase: number;
  enabled?: boolean;
  isBase?: boolean;
  /** Emoji flag of the issuing country (🇪🇺 for the euro, a globe for shared currencies). */
  flag?: string;
}

/** Currencies enabled by default on a fresh install (the full ISO 4217 list is in ALL_CURRENCIES; admins can enable more). */
export const DEFAULT_CURRENCY_CODES = [
  'USD',
  'CDF',
  'EUR',
  'GBP',
  'NGN',
  'KES',
  'GHS',
  'ZAR',
  'INR',
  'BDT',
  'PHP',
  'PKR',
  'AED',
  'CAD',
  'AUD',
  'JPY',
  'CNY',
  'BRL',
  'MXN',
  'TRY',
  'XOF',
  'XAF',
  'UGX',
  'TZS',
  'RWF',
  'EGP',
  'MAD',
  'SAR',
  'IDR',
  'VND',
  'CHF',
];

/**
 * Parse a user-entered decimal amount ("12.50") into integer minor units (1250).
 * Throws on invalid input or too many decimal places.
 */
export function toMinor(amount: string | number, decimals: number): number {
  const str = String(amount).trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(str)) throw new Error('Invalid amount');
  const [whole, frac = ''] = str.split('.');
  if (frac.length > decimals) throw new Error(`Amount supports at most ${decimals} decimal places`);
  const paddedFrac = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const value = Number(whole + paddedFrac);
  if (!Number.isSafeInteger(value)) throw new Error('Amount too large');
  return value;
}

/** Convert integer minor units back to a decimal string with fixed decimals. */
export function fromMinor(minor: number, decimals: number): string {
  const negative = minor < 0;
  const abs = Math.abs(Math.round(minor));
  const str = abs.toString().padStart(decimals + 1, '0');
  const whole = str.slice(0, str.length - decimals) || '0';
  const frac = decimals ? '.' + str.slice(str.length - decimals) : '';
  return (negative ? '-' : '') + whole + frac;
}

/** Format minor units as a human readable string, e.g. "$1,250.00". */
export function formatMoney(minor: number, currency: Pick<CurrencyInfo, 'code' | 'symbol' | 'decimals'>): string {
  const decimal = fromMinor(minor, currency.decimals);
  const negative = decimal.startsWith('-');
  const [whole, frac] = decimal.replace('-', '').split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${currency.symbol}${grouped}${frac ? '.' + frac : ''}`;
}

/** Percent expressed in basis points (bps): 150 bps = 1.5%. */
export function applyBps(amount: number, bps: number): number {
  return Math.round((amount * bps) / 10000);
}

/**
 * Convert an amount in minor units between currencies using their rateToBase.
 * Returns minor units of the target currency (rounded).
 */
export function convertMinor(amountMinor: number, from: CurrencyInfo, to: CurrencyInfo): number {
  const fromMajor = amountMinor / 10 ** from.decimals;
  const baseMajor = fromMajor / from.rateToBase;
  const toMajor = baseMajor * to.rateToBase;
  return Math.round(toMajor * 10 ** to.decimals);
}

/** Exchange rate from one currency to another: 1 unit of `from` = rate units of `to`. */
export function exchangeRate(from: CurrencyInfo, to: CurrencyInfo): number {
  return to.rateToBase / from.rateToBase;
}

/**
 * Canonical money helpers: integers in minor units, never floats. `allocate` splits an amount into parts by weight
 * with the remainder distributed to the first parts so the parts always sum to the total (split settlement).
 */
export interface Money {
  minor: number;
  currency: string;
}
export function money(minor: number, currency: string): Money {
  if (!Number.isInteger(minor)) throw new Error('Money must be an integer in minor units');
  return { minor, currency: currency.toUpperCase() };
}
export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error(`Currency mismatch ${a.currency} vs ${b.currency}`);
  return money(a.minor + b.minor, a.currency);
}
export function subtractMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error(`Currency mismatch ${a.currency} vs ${b.currency}`);
  return money(a.minor - b.minor, a.currency);
}
/** Basis points of an amount, rounded half up, as an integer. */
export function bpsOf(minor: number, bps: number): number {
  return Math.round((minor * bps) / 10_000);
}
/** Allocate `total` across weights (e.g. [94, 3, 2, 1]) so the parts sum exactly to the total. */
export function allocate(total: number, weights: number[]): number[] {
  if (!Number.isInteger(total) || total < 0) throw new Error('Total must be a non-negative integer');
  const sum = weights.reduce((n, w) => n + w, 0);
  if (sum <= 0) throw new Error('Weights must sum to more than zero');
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  let remainder = total - parts.reduce((n, p) => n + p, 0);
  for (let i = 0; remainder > 0 && i < parts.length; i++, remainder--) parts[i] += 1;
  return parts;
}
/** Allocate fixed minor amounts first, then the rest by weight; throws when fixed parts exceed the total. */
export function allocateWithFixed(total: number, fixed: number[], weights: number[]): { fixed: number[]; weighted: number[] } {
  const fixedSum = fixed.reduce((n, f) => n + f, 0);
  if (fixedSum > total) throw new Error('Fixed allocations exceed the total');
  return { fixed, weighted: weights.length ? allocate(total - fixedSum, weights) : [] };
}
