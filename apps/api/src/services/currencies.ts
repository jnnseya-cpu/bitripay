import { getDb } from '../db';
import { config } from '../config';
import { badRequest } from '../lib/errors';
import { ALL_CURRENCIES, DEFAULT_CURRENCY_CODES, convertMinor, exchangeRate, type CurrencyInfo } from '@bitripay/shared';
import { getAppSettings } from './settings';
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
  const insert = db.prepare(
    'INSERT INTO currencies (code, name, symbol, decimals, rate_to_base, enabled, is_base, rate_source, rate_updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
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

/**
 * Refresh exchange rates from a public provider. Returns the number of currencies updated.
 * Providers: frankfurter (ECB data) and open.er-api.com (broad coverage). Both are keyless.
 */
export async function refreshRatesFromProvider(provider?: string): Promise<{ updated: string[]; skipped: string[]; provider: string }> {
  const settings = getAppSettings();
  const which = provider || settings.rateProvider;
  if (which === 'manual') return { updated: [], skipped: [], provider: 'manual' };
  const base = getBaseCurrency();
  const url =
    which === 'frankfurter'
      ? `https://api.frankfurter.app/latest?from=${base.code}`
      : `https://open.er-api.com/v6/latest/${base.code}`;
  const res = await fetch(url);
  if (!res.ok) throw badRequest(`Rate provider responded with ${res.status}`, 'rate_provider_error');
  const json: any = await res.json();
  const rates: Record<string, number> = json.rates || {};
  const updated: string[] = [];
  const skipped: string[] = [];
  const stmt = getDb().prepare("UPDATE currencies SET rate_to_base = ?, rate_source = ?, rate_updated_at = ? WHERE code = ? AND is_base = 0");
  for (const c of listCurrencies()) {
    if (c.isBase) continue;
    const r = rates[c.code];
    if (typeof r === 'number' && r > 0) {
      stmt.run(r, which, now(), c.code);
      updated.push(c.code);
    } else {
      skipped.push(c.code);
    }
  }
  return { updated, skipped, provider: which };
}
