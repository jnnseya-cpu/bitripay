import { getDb } from '../db';
import { config } from '../config';
import { encrypt, decrypt } from '../lib/crypto';
import { parseJson } from '../lib/json';
import { now } from '../lib/ids';
import { recordEvent } from '../services/events';
import { sandboxProvider } from './sandbox';
import { stripeProvider } from './stripe';
import { paystackProvider } from './paystack';
import { flutterwaveProvider } from './flutterwave';
import { mtnMomoProvider } from './mtnMomo';
import { mpesaProvider } from './mpesa';
import { manualBankProvider } from './manualBank';
import { manualMomoProvider } from './manualMomo';
import { openBankingProvider } from './openBanking';
import { bitcoinProvider, bitcoinMode, ensureBitcoinCurrency } from './bitcoin';
import type { GatewayProvider, GatewayProviderId, PaymentMethod, GatewayMode, HealthResult } from './types';
import { getSetting } from '../services/settings';

export const PROVIDERS: Record<GatewayProviderId, GatewayProvider> = {
  sandbox: sandboxProvider,
  stripe: stripeProvider,
  paystack: paystackProvider,
  flutterwave: flutterwaveProvider,
  mtn_momo: mtnMomoProvider,
  mpesa: mpesaProvider,
  manual_bank: manualBankProvider,
  manual_momo: manualMomoProvider,
  open_banking: openBankingProvider,
  bitcoin: bitcoinProvider,
};

export interface GatewayConfig {
  id: string;
  name: string;
  provider: GatewayProviderId;
  enabled: boolean;
  methods: PaymentMethod[];
  currencies: string[];
  countries: string[];
  config: Record<string, unknown>;
  sortOrder: number;
  /** Which credential keys are set (never the values). */
  configuredKeys: string[];
  credentialFields: GatewayProvider['credentialFields'];
  /** test | live | unknown – derived from the stored keys (sandbox and direct rails are always 'test'-safe). */
  mode: GatewayMode;
  /** Result of the last admin connectivity test. */
  lastHealth: (HealthResult & { at: string }) | null;
  updatedAt: string;
}

/** Environment-provided credentials act as defaults; admin-entered credentials (encrypted at rest) override them. */
function envCredentials(provider: GatewayProviderId): Record<string, string> {
  switch (provider) {
    case 'stripe':
      return { secretKey: config.stripe.secretKey, publishableKey: config.stripe.publishableKey, webhookSecret: config.stripe.webhookSecret };
    case 'paystack':
      return { secretKey: config.paystack.secretKey };
    case 'flutterwave':
      return { secretKey: config.flutterwave.secretKey, webhookHash: config.flutterwave.webhookHash };
    case 'mtn_momo':
      return { subscriptionKey: config.mtnMomo.subscriptionKey, apiUser: config.mtnMomo.apiUser, apiKey: config.mtnMomo.apiKey, env: config.mtnMomo.env };
    case 'mpesa':
      return { consumerKey: config.mpesa.consumerKey, consumerSecret: config.mpesa.consumerSecret, shortcode: config.mpesa.shortcode, passkey: config.mpesa.passkey, env: config.mpesa.env };
    case 'bitcoin':
      return config.btcpay.serverUrl && config.btcpay.storeId && config.btcpay.apiKey
        ? {
            mode: 'btcpay',
            serverUrl: config.btcpay.serverUrl,
            storeId: config.btcpay.storeId,
            apiKey: config.btcpay.apiKey,
            webhookSecret: config.btcpay.webhookSecret,
            network: config.btcpay.network,
          }
        : {};
    default:
      return {};
  }
}

export function getGatewayCredentials(gatewayId: string): Record<string, string> {
  const row = getDb().prepare('SELECT provider, credentials_encrypted FROM gateways WHERE id = ?').get(gatewayId) as any;
  if (!row) return {};
  const stored = row.credentials_encrypted ? parseJson<Record<string, string>>(decrypt(row.credentials_encrypted), {}) : {};
  const merged = { ...envCredentials(row.provider) };
  for (const [k, v] of Object.entries(stored)) if (v) merged[k] = v;
  const cfg = parseJson<Record<string, unknown>>((getDb().prepare('SELECT config FROM gateways WHERE id = ?').get(gatewayId) as any)?.config, {});
  if (cfg.threeDSecure) merged.threeDSecure = String(cfg.threeDSecure);
  return merged;
}

function mapGateway(row: any): GatewayConfig {
  const provider = PROVIDERS[row.provider as GatewayProviderId];
  const creds = getGatewayCredentials(row.id);
  const cfg = parseJson<Record<string, any>>(row.config, {});
  const mode: GatewayMode = ['sandbox', 'manual_bank', 'manual_momo'].includes(row.provider)
    ? 'test'
    : provider?.keyMode
      ? provider.keyMode(creds)
      : ['mtn_momo', 'mpesa'].includes(row.provider)
        ? creds.env === 'production'
          ? 'live'
          : creds.env
            ? 'test'
            : 'unknown'
        : 'unknown';
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    enabled: !!row.enabled,
    methods: parseJson(row.methods, []),
    currencies: parseJson(row.currencies, []),
    countries: parseJson(row.countries, []),
    config: parseJson(row.config, {}),
    sortOrder: row.sort_order,
    configuredKeys: Object.entries(creds)
      .filter(([, v]) => !!v)
      .map(([k]) => k),
    credentialFields: provider?.credentialFields ?? [],
    mode,
    lastHealth: cfg.lastHealth ?? null,
    updatedAt: row.updated_at,
  };
}

export function listGateways(): GatewayConfig[] {
  return getDb().prepare('SELECT * FROM gateways ORDER BY sort_order ASC, name ASC').all().map(mapGateway);
}

export function getGateway(id: string): GatewayConfig | undefined {
  const row = getDb().prepare('SELECT * FROM gateways WHERE id = ?').get(id);
  return row ? mapGateway(row) : undefined;
}

export function isGatewayReady(g: GatewayConfig): boolean {
  if (!g.enabled) return false;
  const provider = PROVIDERS[g.provider];
  if (!provider) return false;
  if (g.provider === 'manual_momo' || g.provider === 'manual_bank' || g.provider === 'sandbox') return true;
  if (g.provider === 'open_banking') return true; // the sandbox bank needs no credentials; live providers are keyed per link
  if (g.provider === 'bitcoin') {
    // Sandbox invoices need no credentials; BTCPay mode needs the Greenfield server, store and API key.
    const creds = getGatewayCredentials(g.id);
    return bitcoinMode(creds) === 'sandbox' || !!(creds.serverUrl && creds.storeId && creds.apiKey);
  }
  const required = provider.credentialFields.filter((f) => f.secret || ['secretKey', 'consumerKey', 'apiUser', 'subscriptionKey'].includes(f.key));
  const creds = getGatewayCredentials(g.id);
  return required.every((f) => !!creds[f.key]);
}

/** Gateways a payer can use for a given method + currency, in admin sort order. */
export function availableGateways(method: PaymentMethod, currency: string, country?: string | null): GatewayConfig[] {
  return listGateways().filter((g) => {
    if (!isGatewayReady(g)) return false;
    if (!g.methods.includes(method)) return false;
    if (g.currencies.length && !g.currencies.includes(currency)) return false;
    if (country && g.countries.length && !g.countries.includes(country.toUpperCase())) return false;
    if (g.provider === 'sandbox' && config.isProduction && !g.config.allowInProduction) return false;
    // A sandbox-mode Bitcoin rail is a simulator too: never offered to real payers in production unless explicitly allowed.
    if (g.provider === 'bitcoin' && config.isProduction && !g.config.allowInProduction && bitcoinMode(getGatewayCredentials(g.id)) === 'sandbox') return false;
    // Compliance gate: live processor keys are never usable while the platform is in sandbox mode.
    if (g.mode === 'live' && getSetting<{ mode: string }>('compliance').mode !== 'live') return false;
    return true;
  });
}

export function upsertGateway(input: {
  id: string;
  name: string;
  provider: GatewayProviderId;
  enabled: boolean;
  methods: PaymentMethod[];
  currencies: string[];
  countries?: string[];
  credentials?: Record<string, string>;
  config?: Record<string, unknown>;
  sortOrder?: number;
}): GatewayConfig {
  const db = getDb();
  const existing = db.prepare('SELECT credentials_encrypted FROM gateways WHERE id = ?').get(input.id) as any;
  let credentialsEncrypted: string | null = existing?.credentials_encrypted ?? null;
  if (input.credentials) {
    const current = credentialsEncrypted ? parseJson<Record<string, string>>(decrypt(credentialsEncrypted), {}) : {};
    for (const [k, v] of Object.entries(input.credentials)) {
      if (v === '') delete current[k];
      else if (v != null) current[k] = v;
    }
    credentialsEncrypted = encrypt(JSON.stringify(current));
  }
  db.prepare(
    `INSERT INTO gateways (id, name, provider, enabled, methods, currencies, countries, credentials_encrypted, config, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, provider = excluded.provider, enabled = excluded.enabled, methods = excluded.methods, currencies = excluded.currencies,
       countries = excluded.countries, credentials_encrypted = excluded.credentials_encrypted, config = excluded.config, sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
  ).run(
    input.id,
    input.name,
    input.provider,
    input.enabled ? 1 : 0,
    JSON.stringify(input.methods),
    JSON.stringify(input.currencies),
    JSON.stringify(input.countries ?? []),
    credentialsEncrypted,
    JSON.stringify(input.config ?? {}),
    input.sortOrder ?? 0,
    now(),
    now(),
  );
  return getGateway(input.id)!;
}

/** Onboarding: prove the stored credentials work and remember the result on the gateway. */
export async function testGateway(id: string): Promise<HealthResult & { at: string; webhookUrl: string }> {
  const g = getGateway(id);
  if (!g) throw new Error('Gateway not found');
  const provider = PROVIDERS[g.provider];
  const creds = getGatewayCredentials(id);
  let result: HealthResult;
  if (provider.healthCheck) result = await provider.healthCheck({ ...creds, ...(g.config.threeDSecure ? { threeDSecure: String(g.config.threeDSecure) } : {}) });
  else result = { ok: isGatewayReady(g), mode: g.mode, message: isGatewayReady(g) ? 'Credentials present (provider has no connectivity test)' : 'Missing credentials' };
  const at = now();
  getDb()
    .prepare('UPDATE gateways SET config = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify({ ...g.config, lastHealth: { ...result, at } }), at, id);
  return { ...result, at, webhookUrl: `${config.apiUrl}/api/webhooks/${id}` };
}

export function deleteGateway(id: string) {
  getDb().prepare('DELETE FROM gateways WHERE id = ?').run(id);
}

/** The Bitcoin rail ships registered but disabled: an administrator enables it per country (capability matrix) and per merchant policy. */
const BITCOIN_GATEWAY = { id: 'bitcoin', name: 'Bitcoin / Lightning', provider: 'bitcoin' as const, enabled: false, methods: ['bitcoin'] as PaymentMethod[], currencies: [], sortOrder: 9 };

/** Seed the default aggregator entries so admins can just toggle + add keys. */
export function ensureDefaultGateways() {
  ensureBitcoinCurrency();
  const count = (getDb().prepare('SELECT COUNT(*) c FROM gateways').get() as any).c;
  if (count > 0) {
    if (!getGateway('bitcoin')) upsertGateway(BITCOIN_GATEWAY);
    if (!getGateway('manual_momo'))
      upsertGateway({ id: 'manual_momo', name: 'Mobile money (direct, all operators)', provider: 'manual_momo', enabled: true, methods: ['mobile_money'], currencies: [], sortOrder: 7 });
    if (!getGateway('open_banking'))
      upsertGateway({ id: 'open_banking', name: 'Pay by bank (open banking)', provider: 'open_banking', enabled: true, methods: ['bank'], currencies: [], sortOrder: 8 });
    return;
  }
  upsertGateway({ id: 'sandbox', name: 'Sandbox (test)', provider: 'sandbox', enabled: !config.isProduction, methods: ['card', 'mobile_money', 'bank'], currencies: [], sortOrder: 0 });
  upsertGateway({ id: 'stripe', name: 'Stripe', provider: 'stripe', enabled: !!config.stripe.secretKey, methods: ['card'], currencies: [], sortOrder: 1 });
  upsertGateway({
    id: 'paystack',
    name: 'Paystack',
    provider: 'paystack',
    enabled: !!config.paystack.secretKey,
    methods: ['card', 'mobile_money', 'bank'],
    currencies: ['NGN', 'GHS', 'KES', 'ZAR', 'USD'],
    sortOrder: 2,
  });
  upsertGateway({ id: 'flutterwave', name: 'Flutterwave', provider: 'flutterwave', enabled: !!config.flutterwave.secretKey, methods: ['card', 'mobile_money', 'bank'], currencies: [], sortOrder: 3 });
  upsertGateway({
    id: 'mtn_momo',
    name: 'MTN Mobile Money',
    provider: 'mtn_momo',
    enabled: !!config.mtnMomo.apiKey,
    methods: ['mobile_money'],
    currencies: ['GHS', 'UGX', 'XAF', 'XOF', 'RWF', 'ZMW', 'EUR'],
    sortOrder: 4,
  });
  upsertGateway({ id: 'mpesa', name: 'M-Pesa', provider: 'mpesa', enabled: !!config.mpesa.consumerKey, methods: ['mobile_money'], currencies: ['KES'], sortOrder: 5 });
  upsertGateway({ id: 'manual_bank', name: 'Bank transfer', provider: 'manual_bank', enabled: true, methods: ['bank'], currencies: [], sortOrder: 6 });
  upsertGateway({ id: 'manual_momo', name: 'Mobile money (direct, all operators)', provider: 'manual_momo', enabled: true, methods: ['mobile_money'], currencies: [], sortOrder: 7 });
  upsertGateway({ id: 'open_banking', name: 'Pay by bank (open banking)', provider: 'open_banking', enabled: true, methods: ['bank'], currencies: [], sortOrder: 8 });
  upsertGateway(BITCOIN_GATEWAY);
}

/** Providers whose credentials can arrive through the environment (see backend/api/.env.example). */
export const ENV_PROVISIONABLE_PROVIDERS: GatewayProviderId[] = ['stripe', 'paystack', 'flutterwave', 'mtn_momo', 'mpesa', 'bitcoin'];

export interface RailProvisionResult {
  gatewayId: string;
  provider: GatewayProviderId;
  /** 'configured' = credentials present, 'enabled' = passed its check and switched on, 'failed' = check failed, 'skipped' = nothing in the environment. */
  outcome: 'configured' | 'enabled' | 'failed' | 'skipped';
  mode: GatewayMode;
  message: string;
}

/**
 * Provision every rail whose credentials are present in the environment: the credentials become the gateway's
 * defaults, the provider's connectivity check runs, and (unless RAILS_AUTO_ENABLE=0) a gateway that passes is enabled
 * with a system event so the activation is traceable. Nothing is invented: a rail without credentials stays exactly as
 * it was, and a failing check never enables a rail. Safe to run at every start-up.
 */
export async function provisionRailsFromEnvironment(opts: { credentials?: Partial<Record<GatewayProviderId, Record<string, string>>>; autoEnable?: boolean } = {}): Promise<RailProvisionResult[]> {
  const results: RailProvisionResult[] = [];
  const autoEnable = opts.autoEnable ?? config.railsAutoEnable;
  for (const provider of ENV_PROVISIONABLE_PROVIDERS) {
    const creds = opts.credentials?.[provider] ?? envCredentials(provider);
    const present = provider === 'bitcoin' ? creds.mode === 'btcpay' : Object.entries(creds).some(([k, v]) => k !== 'env' && !!v);
    const g = listGateways().find((x) => x.provider === provider);
    if (!g) continue;
    if (!present) {
      results.push({ gatewayId: g.id, provider, outcome: 'skipped', mode: g.mode, message: 'No credentials in the environment' });
      continue;
    }
    // environment credentials are defaults for getGatewayCredentials(); the stored record only needs the mode for bitcoin
    // explicit credentials (tests, operator dry runs) are stored on the record; environment credentials stay defaults
    if (opts.credentials?.[provider]) upsertGateway({ ...g, credentials: creds });
    else if (provider === 'bitcoin') upsertGateway({ ...g, credentials: { mode: 'btcpay', network: config.btcpay.network } });
    const health = await testGateway(g.id);
    const fresh = getGateway(g.id)!;
    if (!health.ok) {
      results.push({ gatewayId: g.id, provider, outcome: 'failed', mode: health.mode, message: health.message });
      continue;
    }
    if (!fresh.enabled && autoEnable) {
      getDb().prepare('UPDATE gateways SET enabled = 1, updated_at = ? WHERE id = ?').run(now(), g.id);
      recordEvent('admin', g.id, 'gateway.enabled_from_environment', { type: 'system' }, { provider, mode: health.mode, message: health.message });
      results.push({ gatewayId: g.id, provider, outcome: 'enabled', mode: health.mode, message: health.message });
    } else results.push({ gatewayId: g.id, provider, outcome: 'configured', mode: health.mode, message: health.message });
  }
  return results;
}
