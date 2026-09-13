/**
 * Country capability matrix: what BitriPay may offer in each country, administratively configured, enforced
 * server-side by the policy and routing layers. Never assume a capability from one country applies elsewhere.
 */
import { getDb } from '../db';
import { now } from '../lib/ids';
import { parseJson } from '../lib/json';

export interface CountryCapabilities {
  country: string;
  wallet: boolean;
  cardCollection: boolean;
  bankPayout: boolean;
  mobileMoney: boolean;
  agentCashOut: boolean;
  crossBorder: boolean;
  bitcoin: boolean;
  stablecoin: boolean;
  kycProvider: string | null;
  settlementCurrencies: string[];
  collectionCurrencies: string[];
  /** Per-transaction ceiling in the country's main currency minor units (0 = policy limits only). */
  maxPerTransaction: number;
  requiredDisclosures: string[];
  /** Purpose codes accepted by institution QR in this country. */
  purposeCodes: string[];
  /**
   * National payment switch: when required, every domestic interoperability transaction (a payer on one
   * institution paying a merchant on another) is routed through the named switch connector; closed-loop wallet
   * payments stay internal. Mandatory in DRC (Switch Monétique National).
   */
  nationalSwitch: { required: boolean; connector: string | null };
  /**
   * Licence phase per country. 'aggregator': BitriPay initiates, orchestrates, normalises and reports; funds are held
   * and settled by licensed institutions through the national switch, so wallet balances and extended services are
   * off until the full licence. 'full': every authorised service.
   */
  licencePhase: 'aggregator' | 'full';
  notes: string | null;
}
export const PURPOSE_CODES = ['GENERAL_MERCHANT', 'SCHOOL', 'HEALTH', 'RENT', 'UTILITY', 'CONSTRUCTION', 'GOVERNMENT_FEE', 'TAX', 'DONATION', 'REMITTANCE', 'TRANSPORT', 'MARKET'] as const;

const DEFAULTS: Record<string, Partial<CountryCapabilities>> = {
  CD: { wallet: true, cardCollection: true, bankPayout: true, mobileMoney: true, agentCashOut: true, crossBorder: true, bitcoin: false, stablecoin: false, settlementCurrencies: ['CDF', 'USD'], collectionCurrencies: ['CDF', 'USD'], requiredDisclosures: ['fees', 'fx_rate', 'safeguarding'], nationalSwitch: { required: true, connector: 'NATIONAL_SWITCH_CD' }, licencePhase: 'aggregator' },
  KE: { wallet: true, cardCollection: true, bankPayout: true, mobileMoney: true, agentCashOut: true, crossBorder: true, settlementCurrencies: ['KES', 'USD'], collectionCurrencies: ['KES'] },
  NG: { wallet: true, cardCollection: true, bankPayout: true, mobileMoney: false, agentCashOut: true, crossBorder: true, settlementCurrencies: ['NGN', 'USD'], collectionCurrencies: ['NGN'] },
  UG: { wallet: true, cardCollection: true, bankPayout: true, mobileMoney: true, agentCashOut: true, crossBorder: true, settlementCurrencies: ['UGX', 'USD'], collectionCurrencies: ['UGX'] },
  GB: { wallet: true, cardCollection: true, bankPayout: true, mobileMoney: false, agentCashOut: false, crossBorder: true, settlementCurrencies: ['GBP', 'EUR', 'USD'], collectionCurrencies: ['GBP'], requiredDisclosures: ['fees', 'fx_rate', 'safeguarding', 'complaints'] },
  FR: { wallet: true, cardCollection: true, bankPayout: true, mobileMoney: false, agentCashOut: false, crossBorder: true, settlementCurrencies: ['EUR'], collectionCurrencies: ['EUR'], requiredDisclosures: ['fees', 'fx_rate', 'safeguarding', 'complaints'] },
};
const BASE: CountryCapabilities = { country: '', wallet: true, cardCollection: false, bankPayout: false, mobileMoney: false, agentCashOut: false, crossBorder: false, bitcoin: false, stablecoin: false, kycProvider: null, settlementCurrencies: [], collectionCurrencies: [], maxPerTransaction: 0, requiredDisclosures: ['fees'], purposeCodes: [...PURPOSE_CODES], nationalSwitch: { required: false, connector: null }, licencePhase: 'full', notes: null };

export function countryCapabilities(country: string | null | undefined): CountryCapabilities {
  const code = (country ?? '').toUpperCase();
  const row = code ? (getDb().prepare('SELECT config FROM country_capabilities WHERE country = ?').get(code) as any) : null;
  const stored = row ? parseJson<Partial<CountryCapabilities>>(row.config, {}) : {};
  return { ...BASE, ...(DEFAULTS[code] ?? {}), ...stored, country: code };
}
export function setCountryCapabilities(country: string, patch: Partial<CountryCapabilities>): CountryCapabilities {
  const code = country.toUpperCase();
  const current = countryCapabilities(code);
  const next = { ...current, ...patch, country: code };
  getDb().prepare('INSERT INTO country_capabilities (country, config, updated_at) VALUES (?, ?, ?) ON CONFLICT(country) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at').run(code, JSON.stringify(next), now());
  return next;
}
export function listCountryCapabilities(): CountryCapabilities[] {
  const stored = (getDb().prepare('SELECT country FROM country_capabilities').all() as { country: string }[]).map((r) => r.country);
  const codes = Array.from(new Set([...Object.keys(DEFAULTS), ...stored])).sort();
  return codes.map(countryCapabilities);
}

/** Services that need the full licence; in aggregator phase they are hidden for the country. */
export const FULL_LICENCE_SERVICES = ['wallet', 'virtualCards', 'remittance', 'agentCashOut', 'bitcoin', 'stablecoin'] as const;
export function serviceAllowed(country: string | null | undefined, service: (typeof FULL_LICENCE_SERVICES)[number] | 'cardCollection' | 'mobileMoney' | 'bankPayout' | 'crossBorder'): boolean {
  const c = countryCapabilities(country);
  if (c.licencePhase === 'aggregator' && (FULL_LICENCE_SERVICES as readonly string[]).includes(service)) return false;
  return (c as any)[service] !== false;
}
