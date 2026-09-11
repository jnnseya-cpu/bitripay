import { getDb } from '../db';
import { config } from '../config';
import { encrypt, decrypt } from '../lib/crypto';
import { parseJson } from '../lib/json';
import { now } from '../lib/ids';
import { sandboxProvider } from './sandbox';
import { stripeProvider } from './stripe';
import { paystackProvider } from './paystack';
import { flutterwaveProvider } from './flutterwave';
import { mtnMomoProvider } from './mtnMomo';
import { mpesaProvider } from './mpesa';
import { manualBankProvider } from './manualBank';
import { manualMomoProvider } from './manualMomo';
import type { GatewayProvider, GatewayProviderId, PaymentMethod } from './types';

export const PROVIDERS: Record<GatewayProviderId, GatewayProvider> = {
  sandbox: sandboxProvider,
  stripe: stripeProvider,
  paystack: paystackProvider,
  flutterwave: flutterwaveProvider,
  mtn_momo: mtnMomoProvider,
  mpesa: mpesaProvider,
  manual_bank: manualBankProvider,
  manual_momo: manualMomoProvider,
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
  return merged;
}

function mapGateway(row: any): GatewayConfig {
  const provider = PROVIDERS[row.provider as GatewayProviderId];
  const creds = getGatewayCredentials(row.id);
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
    configuredKeys: Object.entries(creds).filter(([, v]) => !!v).map(([k]) => k),
    credentialFields: provider?.credentialFields ?? [],
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

export function deleteGateway(id: string) {
  getDb().prepare('DELETE FROM gateways WHERE id = ?').run(id);
}

/** Seed the default aggregator entries so admins can just toggle + add keys. */
export function ensureDefaultGateways() {
  const count = (getDb().prepare('SELECT COUNT(*) c FROM gateways').get() as any).c;
  if (count > 0) {
    if (!getGateway('manual_momo')) upsertGateway({ id: 'manual_momo', name: 'Mobile money (direct, all operators)', provider: 'manual_momo', enabled: true, methods: ['mobile_money'], currencies: [], sortOrder: 7 });
    return;
  }
  upsertGateway({ id: 'sandbox', name: 'Sandbox (test)', provider: 'sandbox', enabled: !config.isProduction, methods: ['card', 'mobile_money', 'bank'], currencies: [], sortOrder: 0 });
  upsertGateway({ id: 'stripe', name: 'Stripe', provider: 'stripe', enabled: !!config.stripe.secretKey, methods: ['card'], currencies: [], sortOrder: 1 });
  upsertGateway({ id: 'paystack', name: 'Paystack', provider: 'paystack', enabled: !!config.paystack.secretKey, methods: ['card', 'mobile_money', 'bank'], currencies: ['NGN', 'GHS', 'KES', 'ZAR', 'USD'], sortOrder: 2 });
  upsertGateway({ id: 'flutterwave', name: 'Flutterwave', provider: 'flutterwave', enabled: !!config.flutterwave.secretKey, methods: ['card', 'mobile_money', 'bank'], currencies: [], sortOrder: 3 });
  upsertGateway({ id: 'mtn_momo', name: 'MTN Mobile Money', provider: 'mtn_momo', enabled: !!config.mtnMomo.apiKey, methods: ['mobile_money'], currencies: ['GHS', 'UGX', 'XAF', 'XOF', 'RWF', 'ZMW', 'EUR'], sortOrder: 4 });
  upsertGateway({ id: 'mpesa', name: 'M-Pesa', provider: 'mpesa', enabled: !!config.mpesa.consumerKey, methods: ['mobile_money'], currencies: ['KES'], sortOrder: 5 });
  upsertGateway({ id: 'manual_bank', name: 'Bank transfer', provider: 'manual_bank', enabled: true, methods: ['bank'], currencies: [], sortOrder: 6 });
  upsertGateway({ id: 'manual_momo', name: 'Mobile money (direct, all operators)', provider: 'manual_momo', enabled: true, methods: ['mobile_money'], currencies: [], sortOrder: 7 });
}
