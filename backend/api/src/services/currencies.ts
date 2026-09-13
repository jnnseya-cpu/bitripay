import { getDb } from '../db';
import { config } from '../config';
import { badRequest } from '../lib/errors';
import { ALL_CURRENCIES, DEFAULT_CURRENCY_CODES, convertMinor, exchangeRate, formatMoney, type CurrencyInfo } from '@bitripay/shared';
import { getAppSettings, getSetting, setSetting, getFxSettings } from './settings';
import { decrypt } from '../lib/crypto';
import { now } from '../lib/ids';

export interface CurrencyRow extends CurrencyInfo {
  rateSource: string;
  rateUpdatedAt: string | null;
  sortOrder: number;
}

function mapRow(r: any): CurrencyRow {
  return {
    code: r.code,
    name: r.name,
    symbol: r.symbol,
    decimals: r.decimals,
    rateToBase: r.rate_to_base,
    enabled: !!r.enabled,
    isBase: !!r.is_base,
    rateSource: r.rate_source,
    rateUpdatedAt: r.rate_updated_at,
    sortOrder: r.sort_order,
  };
}

/** Bundled approximate rates are versioned test rates – never presented as live. */
export const TEST_RATES_VERSION = 'test_rates_v1';

/** Seed every ISO 4217 currency; only the default set is enabled until an admin turns more on. */
export function ensureDefaultCurrencies() {
  const db = getDb();
  const existing = new Set((db.prepare('SELECT code FROM currencies').all() as any[]).map((r) => r.code));
  const insert = db.prepare('INSERT INTO currencies (code, name, symbol, decimals, rate_to_base, enabled, is_base, rate_source, rate_updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const base = config.baseCurrency.toUpperCase();
  const hasBase = existing.size > 0 && !!db.prepare('SELECT 1 FROM currencies WHERE is_base = 1').get();
  db.transaction(() => {
    ALL_CURRENCIES.forEach((c) => {
      if (existing.has(c.code)) return;
      const isBase = !hasBase && c.code === base;
      const enabled = isBase || DEFAULT_CURRENCY_CODES.includes(c.code);
      const order = DEFAULT_CURRENCY_CODES.indexOf(c.code);
      insert.run(c.code, c.name, c.symbol, c.decimals, isBase ? 1 : c.rateToBase, enabled ? 1 : 0, isBase ? 1 : 0, TEST_RATES_VERSION, now(), order >= 0 ? order : 1000);
    });
  })();
}

export function listCurrencies(onlyEnabled = false): CurrencyRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM currencies ${onlyEnabled ? 'WHERE enabled = 1' : ''} ORDER BY is_base DESC, sort_order ASC, code ASC`)
    .all();
  return rows.map(mapRow);
}

export function getCurrency(code: string, requireEnabled = true): CurrencyRow {
  const row = getDb().prepare('SELECT * FROM currencies WHERE code = ?').get(code?.toUpperCase());
  if (!row) throw badRequest(`Unsupported currency: ${code}`, 'unsupported_currency');
  const cur = mapRow(row);
  if (requireEnabled && !cur.enabled) throw badRequest(`Currency ${code} is currently disabled`, 'currency_disabled');
  return cur;
}

/** Human-readable amount for messages and receipts; never throws on an unknown code. */
export function formatMinor(minor: number, code: string): string {
  try {
    return formatMoney(minor, getCurrency(code, false));
  } catch {
    return `${minor} ${code}`;
  }
}

export function getBaseCurrency(): CurrencyRow {
  const row = getDb().prepare('SELECT * FROM currencies WHERE is_base = 1').get();
  if (!row) throw new Error('Base currency not configured');
  return mapRow(row);
}

/** Convert minor units from `from` currency into `to` currency at mid-market rate. */
export function convert(amountMinor: number, from: string, to: string): number {
  if (from === to) return amountMinor;
  return convertMinor(amountMinor, getCurrency(from, false), getCurrency(to, false));
}

/** Convert with the platform's configured exchange margin applied against the customer. */
export function convertWithMargin(amountMinor: number, from: string, to: string): { amount: number; rate: number; midRate: number; marginBps: number } {
  const f = getCurrency(from, false);
  const t = getCurrency(to, false);
  const marginBps = from === to ? 0 : getAppSettings().exchangeMarginBps;
  const midRate = exchangeRate(f, t);
  const rate = midRate * (1 - marginBps / 10000);
  const amount = Math.round((amountMinor / 10 ** f.decimals) * rate * 10 ** t.decimals);
  return { amount, rate, midRate, marginBps };
}

/** Convert a base-currency amount (e.g. fixed fee, limits) into `to` currency. */
export function fromBase(amountMinor: number, to: string): number {
  const base = getBaseCurrency();
  if (base.code === to) return amountMinor;
  return convertMinor(amountMinor, base, getCurrency(to, false));
}

export function toBase(amountMinor: number, from: string): number {
  const base = getBaseCurrency();
  if (base.code === from) return amountMinor;
  return convertMinor(amountMinor, getCurrency(from, false), base);
}

export function upsertCurrency(input: { code: string; name: string; symbol: string; decimals: number; rateToBase: number; enabled: boolean; sortOrder?: number }) {
  const db = getDb();
  const base = getBaseCurrency();
  const isBase = input.code === base.code;
  db.prepare(
    `INSERT INTO currencies (code, name, symbol, decimals, rate_to_base, enabled, is_base, rate_source, rate_updated_at, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)
     ON CONFLICT(code) DO UPDATE SET name = excluded.name, symbol = excluded.symbol, decimals = excluded.decimals,
       rate_to_base = excluded.rate_to_base, enabled = excluded.enabled,
       rate_source = CASE WHEN currencies.rate_to_base = excluded.rate_to_base THEN currencies.rate_source ELSE 'manual' END,
       rate_updated_at = CASE WHEN currencies.rate_to_base = excluded.rate_to_base THEN currencies.rate_updated_at ELSE excluded.rate_updated_at END,
       sort_order = excluded.sort_order`,
  ).run(input.code.toUpperCase(), input.name, input.symbol, input.decimals, isBase ? 1 : input.rateToBase, input.enabled ? 1 : 0, isBase ? 1 : 0, now(), input.sortOrder ?? 0);
  return getCurrency(input.code, false);
}

export interface RateProviderInfo {
  id: string;
  name: string;
  keyed: boolean;
  url: (base: string, key: string) => string;
  /** Extract {code: rate} (1 base = rate quote) from the provider's JSON. */
  parse: (json: any, base: string) => Record<string, number>;
}
export const RATE_PROVIDERS: RateProviderInfo[] = [
  { id: 'frankfurter', name: 'Frankfurter (ECB reference rates, keyless)', keyed: false, url: (base) => `https://api.frankfurter.app/latest?from=${base}`, parse: (j) => j.rates ?? {} },
  { id: 'open_er_api', name: 'open.er-api.com (keyless, 160+ currencies)', keyed: false, url: (base) => `https://open.er-api.com/v6/latest/${base}`, parse: (j) => j.rates ?? {} },
  {
    id: 'exchangerate_host',
    name: 'exchangerate.host (API key)',
    keyed: true,
    url: (base, key) => `https://api.exchangerate.host/live?access_key=${encodeURIComponent(key)}&source=${base}`,
    parse: (j, base) => Object.fromEntries(Object.entries(j.quotes ?? {}).map(([k, v]) => [String(k).slice(base.length), Number(v)])),
  },
  {
    id: 'openexchangerates',
    name: 'Open Exchange Rates (app id)',
    keyed: true,
    url: (base, key) => `https://openexchangerates.org/api/latest.json?app_id=${encodeURIComponent(key)}&base=${base}`,
    parse: (j) => j.rates ?? {},
  },
  {
    id: 'fixer',
    name: 'Fixer / apilayer (access key)',
    keyed: true,
    url: (base, key) => `https://data.fixer.io/api/latest?access_key=${encodeURIComponent(key)}&base=${base}`,
    parse: (j) => j.rates ?? {},
  },
];

export interface RateStatus {
  provider: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastSnapshotId: number | null;
  consecutiveFailures: number;
}
export const getRateStatus = () =>
  getSetting<RateStatus>('rateStatus', { provider: 'manual', lastAttemptAt: null, lastSuccessAt: null, lastError: null, lastSnapshotId: null, consecutiveFailures: 0 });

function recordSnapshot(provider: string, source: 'live' | 'manual_import', base: string, rates: Record<string, number>, createdBy: string | null, note: string | null): number {
  const r = getDb()
    .prepare('INSERT INTO rate_snapshots (provider, source, base, rates, fetched_at, created_by, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(provider, source, base, JSON.stringify(rates), now(), createdBy, note);
  return Number(r.lastInsertRowid);
}

function applyRates(rates: Record<string, number>, source: string): { updated: string[]; skipped: string[] } {
  const updated: string[] = [];
  const skipped: string[] = [];
  const stmt = getDb().prepare('UPDATE currencies SET rate_to_base = ?, rate_source = ?, rate_updated_at = ? WHERE code = ? AND is_base = 0');
  for (const c of listCurrencies()) {
    if (c.isBase) continue;
    const r = rates[c.code];
    if (typeof r === 'number' && Number.isFinite(r) && r > 0) {
      stmt.run(r, source, now(), c.code);
      updated.push(c.code);
    } else skipped.push(c.code);
  }
  return { updated, skipped };
}

async function fetchWithRetry(url: string, attempts = 3): Promise<any> {
  let lastErr: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'BitriPay/1.0 rates' } });
      clearTimeout(timer);
      if (res.status === 403 || res.status === 407)
        throw new Error(`HTTP ${res.status} – outbound access to the rate provider is blocked (proxy / firewall). Allow the host or import a versioned rate batch manually.`);
      if (res.status === 401) throw new Error('HTTP 401 – the provider rejected the API key');
      if (res.status === 429) throw new Error('HTTP 429 – rate provider quota exceeded');
      if (!res.ok) throw new Error(`HTTP ${res.status} from the rate provider`);
      const json: any = await res.json();
      if (json.success === false || json.result === 'error') throw new Error(json.error?.info || json['error-type'] || 'Provider returned an error');
      return json;
    } catch (err) {
      lastErr = err as Error;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw lastErr ?? new Error('Rate provider unreachable');
}

/**
 * Refresh exchange rates from the configured provider (keyless or API-keyed), with retries.
 * Every successful fetch is stored as a versioned snapshot; the status (last success / error) is kept for alerts.
 */
export async function refreshRatesFromProvider(provider?: string): Promise<{ updated: string[]; skipped: string[]; provider: string; snapshotId: number | null }> {
  const settings = getAppSettings();
  const which = provider || settings.rateProvider;
  if (which === 'manual') return { updated: [], skipped: [], provider: 'manual', snapshotId: null };
  const info = RATE_PROVIDERS.find((p) => p.id === which);
  if (!info) throw badRequest(`Unknown rate provider ${which}`, 'rate_provider_error');
  const key = settings.rateProviderKey ? safeDecrypt(settings.rateProviderKey) : '';
  if (info.keyed && !key) throw badRequest(`${info.name} needs an API key (Currencies & rates → provider key)`, 'rate_provider_key_required');
  const base = getBaseCurrency();
  const status = getRateStatus();
  try {
    const json = await fetchWithRetry(info.url(base.code, key));
    const rates = info.parse(json, base.code);
    if (!Object.keys(rates).length) throw new Error('Provider returned no rates');
    const snapshotId = recordSnapshot(which, 'live', base.code, rates, null, null);
    const r = applyRates(rates, which);
    setSetting('rateStatus', { provider: which, lastAttemptAt: now(), lastSuccessAt: now(), lastError: null, lastSnapshotId: snapshotId, consecutiveFailures: 0 } as RateStatus);
    return { ...r, provider: which, snapshotId };
  } catch (err) {
    setSetting('rateStatus', { ...status, provider: which, lastAttemptAt: now(), lastError: (err as Error).message, consecutiveFailures: (status.consecutiveFailures ?? 0) + 1 } as RateStatus);
    throw badRequest((err as Error).message, 'rate_provider_error');
  }
}

function safeDecrypt(v: string): string {
  try {
    return decrypt(v);
  } catch {
    return v;
  }
}

/** Administrator imports a versioned rate batch (1 base = rate quote) – for environments without outbound access. Labelled non-live everywhere. */
export function importRates(admin: { id: string }, rates: Record<string, number>, note?: string | null) {
  const base = getBaseCurrency();
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(rates)) if (/^[A-Z]{3}$/.test(k.toUpperCase()) && Number.isFinite(Number(v)) && Number(v) > 0) clean[k.toUpperCase()] = Number(v);
  if (!Object.keys(clean).length) throw badRequest('No valid rates in the import', 'validation_error');
  const snapshotId = recordSnapshot('manual_import', 'manual_import', base.code, clean, admin.id, note ?? null);
  const r = applyRates(clean, `import_v${snapshotId}`);
  return { ...r, snapshotId };
}

export function listRateSnapshots(limit = 20) {
  return (getDb().prepare('SELECT id, provider, source, base, fetched_at, created_by, note, LENGTH(rates) size FROM rate_snapshots ORDER BY id DESC LIMIT ?').all(limit) as any[]).map((r) => ({
    id: r.id,
    provider: r.provider,
    source: r.source,
    base: r.base,
    fetchedAt: r.fetched_at,
    createdBy: r.created_by,
    note: r.note,
  }));
}

/** Are the rates in use live and fresh enough for guaranteed quotes? */
export function rateFreshness(): { live: boolean; fresh: boolean; source: string; oldestUpdatedAt: string | null; maxAgeHours: number } {
  const maxAgeHours = getFxSettings().maxRateAgeHours;
  const enabled = listCurrencies(true).filter((c) => !c.isBase);
  const sources = new Set(enabled.map((c) => c.rateSource));
  const live = enabled.length > 0 && [...sources].every((s) => RATE_PROVIDERS.some((p) => p.id === s));
  const oldest = enabled.map((c) => (c.rateUpdatedAt ? new Date(c.rateUpdatedAt).getTime() : 0)).reduce((a, b) => Math.min(a, b), Date.now());
  return { live, fresh: live && Date.now() - oldest < maxAgeHours * 3600_000, source: [...sources].join(', '), oldestUpdatedAt: enabled.length ? new Date(oldest).toISOString() : null, maxAgeHours };
}
