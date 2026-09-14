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
  CD: {
    wallet: true,
    cardCollection: true,
    bankPayout: true,
    mobileMoney: true,
    agentCashOut: true,
    crossBorder: true,
    bitcoin: false,
    stablecoin: false,
    settlementCurrencies: ['CDF', 'USD'],
    collectionCurrencies: ['CDF', 'USD'],
    requiredDisclosures: ['fees', 'fx_rate', 'safeguarding'],
    nationalSwitch: { required: true, connector: 'NATIONAL_SWITCH_CD' },
    licencePhase: 'aggregator',
  },
  KE: { wallet: true, cardCollection: true, bankPayout: true, mobileMoney: true, agentCashOut: true, crossBorder: true, settlementCurrencies: ['KES', 'USD'], collectionCurrencies: ['KES'] },
  NG: { wallet: true, cardCollection: true, bankPayout: true, mobileMoney: false, agentCashOut: true, crossBorder: true, settlementCurrencies: ['NGN', 'USD'], collectionCurrencies: ['NGN'] },
  UG: { wallet: true, cardCollection: true, bankPayout: true, mobileMoney: true, agentCashOut: true, crossBorder: true, settlementCurrencies: ['UGX', 'USD'], collectionCurrencies: ['UGX'] },
  GB: {
    wallet: true,
    cardCollection: true,
    bankPayout: true,
    mobileMoney: false,
    agentCashOut: false,
    crossBorder: true,
    settlementCurrencies: ['GBP', 'EUR', 'USD'],
    collectionCurrencies: ['GBP'],
    requiredDisclosures: ['fees', 'fx_rate', 'safeguarding', 'complaints'],
  },
  FR: {
    wallet: true,
    cardCollection: true,
    bankPayout: true,
    mobileMoney: false,
    agentCashOut: false,
    crossBorder: true,
    settlementCurrencies: ['EUR'],
    collectionCurrencies: ['EUR'],
    requiredDisclosures: ['fees', 'fx_rate', 'safeguarding', 'complaints'],
  },
};
const BASE: CountryCapabilities = {
  country: '',
  wallet: true,
  cardCollection: false,
  bankPayout: false,
  mobileMoney: false,
  agentCashOut: false,
  crossBorder: false,
  bitcoin: false,
  stablecoin: false,
  kycProvider: null,
  settlementCurrencies: [],
  collectionCurrencies: [],
  maxPerTransaction: 0,
  requiredDisclosures: ['fees'],
  purposeCodes: [...PURPOSE_CODES],
  nationalSwitch: { required: false, connector: null },
  licencePhase: 'full',
  notes: null,
};

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
  getDb()
    .prepare('INSERT INTO country_capabilities (country, config, updated_at) VALUES (?, ?, ?) ON CONFLICT(country) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at')
    .run(code, JSON.stringify(next), now());
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

// ---------------------------------------------------------------------------------------------------------------------
// Bitcoin rail eligibility: jurisdiction (the capability matrix) AND merchant policy
// ---------------------------------------------------------------------------------------------------------------------
/**
 * Merchant-level Bitcoin policy, kept in the merchant's gateway settings JSON next to the accepted methods:
 *   bitcoin            – the merchant opted in to receive Bitcoin / Lightning (default false)
 *   bitcoinSettlement  – 'fiat': convert to the intent currency at capture (default); 'btc': keep a BTC wallet balance
 */
export interface MerchantBitcoinPolicy {
  bitcoin: boolean;
  bitcoinSettlement: 'btc' | 'fiat';
}
export const DEFAULT_BITCOIN_POLICY: MerchantBitcoinPolicy = { bitcoin: false, bitcoinSettlement: 'fiat' };
export function merchantBitcoinPolicy(row: { gateway_settings?: string | null } | null | undefined): MerchantBitcoinPolicy {
  const stored = parseJson<Partial<MerchantBitcoinPolicy>>(row?.gateway_settings ?? '{}', {});
  return { ...DEFAULT_BITCOIN_POLICY, ...(stored.bitcoin === true ? { bitcoin: true } : {}), ...(stored.bitcoinSettlement === 'btc' ? { bitcoinSettlement: 'btc' as const } : {}) };
}

/**
 * Countries where the Bitcoin rail may be offered: the administrator-editable `bitcoin` flag of the capability matrix
 * (`PUT /api/admin/capabilities/:country { bitcoin: true }`). Nothing is enabled by default, and aggregator-phase
 * countries stay off whatever the flag says (Bitcoin is a full-licence service).
 */
export function bitcoinCountries(): string[] {
  return listCountryCapabilities()
    .filter((c) => c.bitcoin && c.licencePhase !== 'aggregator')
    .map((c) => c.country);
}

export interface BitcoinEligibility {
  eligible: boolean;
  country: string | null;
  countryAllowed: boolean;
  /** null when no merchant policy applies (a customer topping up their own balance). */
  merchantOptedIn: boolean | null;
  reason: string | null;
}
/**
 * The Bitcoin rail is available only where jurisdiction AND merchant policy allow: the country must be in the
 * capability list and, for a merchant payment, the merchant must have opted in. Without a merchant policy (a wallet
 * top-up) the jurisdiction check alone decides.
 */
export function bitcoinEligible(input: { country: string | null | undefined; merchantPolicy?: Partial<MerchantBitcoinPolicy> | null }): BitcoinEligibility {
  const country = input.country ? input.country.toUpperCase() : null;
  const countryAllowed = !!country && serviceAllowed(country, 'bitcoin');
  const merchantOptedIn = input.merchantPolicy === undefined || input.merchantPolicy === null ? null : input.merchantPolicy.bitcoin === true;
  let reason: string | null = null;
  if (!country) reason = 'country unknown';
  else if (!countryAllowed) reason = `Bitcoin is not enabled in ${country}`;
  else if (merchantOptedIn === false) reason = 'the merchant has not opted in to Bitcoin';
  return { eligible: countryAllowed && merchantOptedIn !== false, country, countryAllowed, merchantOptedIn, reason };
}
