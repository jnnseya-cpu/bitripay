export interface CurrencyInfo {
  code: string;
  name: string;
  symbol: string;
  decimals: number;
  /** How many units of this currency equal 1 unit of the platform base currency. */
  rateToBase: number;
  enabled?: boolean;
  isBase?: boolean;
}

/** Currencies enabled by default on a fresh install (the full ISO 4217 list is in ALL_CURRENCIES; admins can enable more). */
export const DEFAULT_CURRENCY_CODES = ['USD', 'EUR', 'GBP', 'NGN', 'KES', 'GHS', 'ZAR', 'INR', 'BDT', 'PHP', 'PKR', 'AED', 'CAD', 'AUD', 'JPY', 'CNY', 'BRL', 'MXN', 'TRY', 'XOF', 'XAF', 'UGX', 'TZS', 'RWF', 'EGP', 'MAD', 'SAR', 'IDR', 'VND', 'CHF'];

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
