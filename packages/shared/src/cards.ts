export type CardBrand = 'visa' | 'mastercard' | 'amex' | 'discover' | 'verve' | 'bitripay' | 'unknown';

/** Luhn checksum validation for card numbers. */
export function luhnCheck(number: string): boolean {
  const digits = number.replace(/\D/g, '');
  if (digits.length < 12) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Compute the Luhn check digit for a partial number. */
export function luhnCheckDigit(partial: string): string {
  const digits = partial.replace(/\D/g, '');
  let sum = 0;
  let alt = true;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return String((10 - (sum % 10)) % 10);
}

/** BitriPay virtual cards are issued with this IIN prefix. */
export const BITRIPAY_CARD_PREFIX = '627311';

export function detectCardBrand(number: string): CardBrand {
  const n = number.replace(/\D/g, '');
  if (n.startsWith(BITRIPAY_CARD_PREFIX)) return 'bitripay';
  if (/^4/.test(n)) return 'visa';
  if (/^(5[1-5]|2[2-7])/.test(n)) return 'mastercard';
  if (/^3[47]/.test(n)) return 'amex';
  if (/^6(011|5)/.test(n)) return 'discover';
  if (/^(5061|6500|507[0-9])/.test(n)) return 'verve';
  return 'unknown';
}

export function maskCardNumber(number: string): string {
  const n = number.replace(/\D/g, '');
  return `•••• •••• •••• ${n.slice(-4)}`;
}

export function formatCardNumber(number: string): string {
  return number.replace(/\D/g, '').replace(/(.{4})/g, '$1 ').trim();
}

export function isExpiryValid(month: number, year: number, now = new Date()): boolean {
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  const fullYear = year < 100 ? 2000 + year : year;
  const exp = new Date(fullYear, month, 1); // first day of next month
  return exp > now;
}
