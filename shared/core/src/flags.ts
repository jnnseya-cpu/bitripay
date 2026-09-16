/**
 * Flags for countries and currencies, as emoji so every surface (web, phone apps, server-rendered pages, chat) shows
 * them without an image. A currency shows the flag of the country that issues it; the euro shows the European Union
 * flag (never one member state); the CFA francs and other shared currencies that have no country show a globe.
 */
import { COUNTRIES } from './countries';

/** 🇨🇩 for CD, 🇪🇺 for EU: the regional-indicator pair of an ISO 3166-1 alpha-2 code. */
export function countryFlag(code: string | null | undefined): string {
  const c = (code ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return '🌐';
  return String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65, 0x1f1e6 + c.charCodeAt(1) - 65);
}

/** Currencies whose flag is not simply "the first country that uses it". */
const CURRENCY_FLAG_OVERRIDES: Record<string, string> = {
  EUR: '🇪🇺',
  USD: '🇺🇸',
  GBP: '🇬🇧',
  AUD: '🇦🇺',
  CAD: '🇨🇦',
  CHF: '🇨🇭',
  NZD: '🇳🇿',
  INR: '🇮🇳',
  ZAR: '🇿🇦',
  XOF: '🌍', // West African CFA franc (eight countries)
  XAF: '🌍', // Central African CFA franc (six countries)
  XCD: '🌎', // East Caribbean dollar
  XPF: '🌏', // CFP franc
  XDR: '🌐',
  BTC: '₿',
};

const byCurrency = new Map<string, string>();
for (const c of COUNTRIES) if (!byCurrency.has(c.currency)) byCurrency.set(c.currency, c.code);

/** 🇨🇩 for CDF, 🇺🇸 for USD, 🇪🇺 for EUR, 🌍 for XOF. */
export function currencyFlag(code: string | null | undefined): string {
  const c = (code ?? '').trim().toUpperCase();
  if (!c) return '🌐';
  if (CURRENCY_FLAG_OVERRIDES[c]) return CURRENCY_FLAG_OVERRIDES[c];
  const country = byCurrency.get(c);
  return country ? countryFlag(country) : '🌐';
}

/** "🇨🇩 CDF": the label to show wherever a currency is picked or listed. */
export const currencyLabel = (code: string): string => `${currencyFlag(code)} ${code.toUpperCase()}`;

/** "🇨🇩 Congo (DRC)" or, without a name, "🇨🇩 CD": the label to show wherever a country is listed or named. */
export function countryLabel(code: string | null | undefined, name?: string | null): string {
  const c = (code ?? '').trim().toUpperCase();
  if (!c) return name ?? '—';
  return `${countryFlag(c)} ${name ?? c}`;
}
