/**
 * Language and currency resolution chains (§12). Nothing is hard-coded to one country: the chains read the account
 * holder's explicit preference, the device (Accept-Language), the IP country and finally a regional default —
 * French for francophone Africa, English elsewhere; USD globally, CDF in the DRC, EUR in the euro area, GBP in
 * the UK — and only ever return languages and currencies the platform has enabled.
 */
import { COUNTRIES } from '@bitripay/shared';
import { listLanguages } from './cms';
import { listCurrencies, getBaseCurrency } from './currencies';
import { listWallets } from './wallets';
import { getDb } from '../db';

const FRANCOPHONE = new Set(['CD', 'CG', 'CM', 'CI', 'SN', 'ML', 'BF', 'NE', 'TD', 'GA', 'BJ', 'TG', 'GN', 'CF', 'MG', 'BI', 'RW', 'DJ', 'KM', 'FR', 'BE', 'LU', 'MC', 'HT']);
const LUSOPHONE = new Set(['AO', 'MZ', 'GW', 'CV', 'ST', 'PT', 'BR']);
const ARABIC = new Set(['AE', 'SA', 'EG', 'MA', 'DZ', 'TN', 'LY', 'SD', 'MR', 'QA', 'KW', 'BH', 'OM', 'JO', 'LB', 'IQ', 'SY', 'YE', 'PS']);
const SWAHILI = new Set(['KE', 'TZ', 'UG']);
const HINDI = new Set(['IN']);
const BENGALI = new Set(['BD']);
const SPANISH = new Set(['ES', 'MX', 'AR', 'CO', 'CL', 'PE', 'VE', 'EC', 'GT', 'CU', 'BO', 'DO', 'HN', 'PY', 'SV', 'NI', 'CR', 'PA', 'UY', 'GQ']);
const EURO = new Set(['AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK']);

export function regionalLanguage(country: string | null | undefined): string {
  const c = (country ?? '').toUpperCase();
  if (FRANCOPHONE.has(c)) return 'fr';
  if (LUSOPHONE.has(c)) return 'pt';
  if (ARABIC.has(c)) return 'ar';
  if (SWAHILI.has(c)) return 'sw';
  if (HINDI.has(c)) return 'hi';
  if (BENGALI.has(c)) return 'bn';
  if (SPANISH.has(c)) return 'es';
  return 'en';
}
/** The currency a country implies, or null when the country is unknown (the chain then falls through to the global default). */
export function regionalCurrency(country: string | null | undefined): string | null {
  const c = (country ?? '').toUpperCase();
  if (!c) return null;
  if (c === 'CD') return 'CDF';
  if (c === 'GB') return 'GBP';
  if (EURO.has(c)) return 'EUR';
  return COUNTRIES.find((x) => x.code === c)?.currency ?? null;
}
/** USD is the global default currency; the platform base currency stands in when USD is not enabled. */
export const GLOBAL_DEFAULT_CURRENCY = 'USD';
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [tag, q] = p.split(';q=');
      return { tag: tag.trim().toLowerCase(), q: q ? Number(q) : 1 };
    })
    .sort((a, b) => b.q - a.q)
    .map((x) => x.tag.split('-')[0]);
}
export interface LocaleInput {
  explicitLanguage?: string | null;
  acceptLanguage?: string | null;
  ipCountry?: string | null;
  userId?: string | null;
  browserCurrency?: string | null;
  explicitCurrency?: string | null;
}
export interface ResolvedLocale {
  language: string;
  languageSource: 'explicit' | 'device' | 'ip_country' | 'default';
  rtl: boolean;
  currency: string;
  currencySource: 'explicit' | 'wallet' | 'ip_country' | 'browser' | 'default';
  country: string | null;
  chain: { languages: string[]; currencies: string[] };
}
export function resolveLocale(input: LocaleInput): ResolvedLocale {
  const enabledLangs = listLanguages().filter((l) => l.enabled);
  const langOk = (code: string | null | undefined) => !!code && enabledLangs.some((l) => l.code === code.toLowerCase());
  const rtlOf = (code: string) => !!enabledLangs.find((l) => l.code === code)?.rtl;
  const country = input.ipCountry ? input.ipCountry.toUpperCase().slice(0, 2) : null;
  const device = parseAcceptLanguage(input.acceptLanguage);
  const stored = input.userId ? ((getDb().prepare('SELECT language, country FROM users WHERE id = ?').get(input.userId) as any) ?? null) : null;
  const explicitLang = input.explicitLanguage ?? (stored?.language && stored.language !== 'en' ? stored.language : null);
  let language: string;
  let languageSource: ResolvedLocale['languageSource'];
  if (langOk(explicitLang)) {
    language = explicitLang!.toLowerCase();
    languageSource = 'explicit';
  } else if (device.find(langOk)) {
    language = device.find(langOk)!;
    languageSource = 'device';
  } else if (country && langOk(regionalLanguage(country))) {
    language = regionalLanguage(country);
    languageSource = 'ip_country';
  } else {
    const d = regionalLanguage(stored?.country ?? country);
    language = langOk(d) ? d : 'en';
    languageSource = 'default';
  }
  const enabledCur = listCurrencies(true).map((c) => c.code);
  const curOk = (code: string | null | undefined) => !!code && enabledCur.includes(code.toUpperCase());
  let currency: string;
  let currencySource: ResolvedLocale['currencySource'];
  const walletPrimary = input.userId
    ? (() => {
        const ws = listWallets(input.userId!);
        if (!ws.length) return null;
        const usage = getDb()
          .prepare('SELECT currency, COUNT(*) n FROM transactions WHERE (sender_user_id = ? OR receiver_user_id = ?) AND created_at >= ? GROUP BY currency ORDER BY n DESC LIMIT 1')
          .get(input.userId, input.userId, new Date(Date.now() - 90 * 86_400_000).toISOString()) as any;
        return usage?.currency ?? [...ws].sort((a, b) => b.balance - a.balance)[0].currency;
      })()
    : null;
  if (curOk(input.explicitCurrency)) {
    currency = input.explicitCurrency!.toUpperCase();
    currencySource = 'explicit';
  } else if (curOk(walletPrimary)) {
    currency = walletPrimary!;
    currencySource = 'wallet';
  } else if (country && curOk(regionalCurrency(country))) {
    currency = regionalCurrency(country)!;
    currencySource = 'ip_country';
  } else if (curOk(input.browserCurrency)) {
    currency = input.browserCurrency!.toUpperCase();
    currencySource = 'browser';
  } else {
    const d = regionalCurrency(stored?.country ?? country);
    currency = curOk(d) ? d! : curOk(GLOBAL_DEFAULT_CURRENCY) ? GLOBAL_DEFAULT_CURRENCY : getBaseCurrency().code;
    currencySource = 'default';
  }
  return {
    language,
    languageSource,
    rtl: rtlOf(language),
    currency,
    currencySource,
    country: country ?? stored?.country ?? null,
    chain: { languages: ['explicit', 'device', 'ip_country', 'default'], currencies: ['explicit', 'wallet', 'ip_country', 'browser', 'default'] },
  };
}
export function localeFromRequest(req: { headers: Record<string, unknown>; query?: Record<string, unknown>; user?: { id: string } | null }): ResolvedLocale {
  const h = (k: string) => (req.headers[k] as string | undefined) ?? null;
  const country = h('x-ip-country') || h('cf-ipcountry') || h('x-country') || null;
  // `?lang=` and `?currency=` are explicit choices made on the page; `x-language` / `x-currency` are hints the client derived from the device.
  return resolveLocale({
    explicitLanguage: (req.query?.lang as string) ?? null,
    acceptLanguage: [h('x-language'), h('accept-language')].filter(Boolean).join(',') || null,
    ipCountry: country,
    userId: req.user?.id ?? null,
    explicitCurrency: (req.query?.currency as string) ?? null,
    browserCurrency: h('x-currency'),
  });
}
