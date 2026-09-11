/**
 * Foreign exchange disclosure and rate locking. Before a customer authorises a conversion they see
 * the reference (mid-market) rate, where it came from and when, the platform markup, the effective
 * rate, and until when the quote is guaranteed. Live rates that are stale, or administrator-entered
 * rates, are labelled and never presented as guaranteed.
 */
import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { badRequest } from '../lib/errors';
import { exchangeRate } from '@bitripay/shared';
import { getCurrency } from './currencies';
import { getAppSettings, getFxSettings } from './settings';

export interface FxDisclosure {
  sourceCurrency: string;
  targetCurrency: string;
  /** Mid-market reference rate (1 source = midRate target). */
  midRate: number;
  /** Effective customer rate after markup. */
  rate: number;
  markupBps: number;
  /** 'frankfurter' / 'open_er_api' (live) or 'administrator-approved' (manual). */
  provider: string;
  providerLabel: string;
  rateTimestamp: string | null;
  /** True when the rate is not live (manual) or older than fx.maxRateAgeHours. */
  stale: boolean;
  /** Guaranteed until expiresAt when a live, fresh rate is available and guaranteed quotes are enabled. */
  guaranteed: boolean;
  expiresAt: string | null;
  quoteId: string | null;
}

export function fxDisclosure(from: string, to: string, userId?: string | null, persist = true): FxDisclosure {
  const f = getCurrency(from, false);
  const t = getCurrency(to, false);
  const app = getAppSettings();
  const fx = getFxSettings();
  if (f.code === t.code) return { sourceCurrency: f.code, targetCurrency: t.code, midRate: 1, rate: 1, markupBps: 0, provider: 'none', providerLabel: 'Same currency', rateTimestamp: null, stale: false, guaranteed: true, expiresAt: null, quoteId: null };
  const midRate = exchangeRate(f, t);
  const markupBps = app.exchangeMarginBps;
  const rate = midRate * (1 - markupBps / 10000);
  // The rate for a pair is only as fresh as the older of the two legs.
  const legs = [f, t].filter((c) => !c.isBase);
  const manual = legs.some((c) => c.rateSource === 'manual');
  const timestamps = legs.map((c) => c.rateUpdatedAt).filter(Boolean) as string[];
  const oldest = timestamps.length ? timestamps.map((x) => new Date(x).getTime()).reduce((a, b) => Math.min(a, b)) : null;
  const tooOld = oldest !== null && Date.now() - oldest > fx.maxRateAgeHours * 3600_000;
  const stale = manual || tooOld;
  const provider = manual ? 'administrator-approved' : legs[0]?.rateSource ?? 'manual';
  const providerLabel = manual ? 'Administrator-approved rate (not a live market rate)' : tooOld ? `Live rate from ${provider} (stale)` : `Live rate from ${provider}`;
  const guaranteed = !stale && fx.guaranteedQuotes;
  const expiresAt = guaranteed ? new Date(Date.now() + fx.quoteTtlSeconds * 1000).toISOString() : null;
  let quoteId: string | null = null;
  if (persist) {
    quoteId = uuid();
    getDb()
      .prepare('INSERT INTO fx_quotes (id, user_id, from_currency, to_currency, mid_rate, rate, markup_bps, provider, rate_timestamp, guaranteed, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(quoteId, userId ?? null, f.code, t.code, midRate, rate, markupBps, provider, oldest ? new Date(oldest).toISOString() : null, guaranteed ? 1 : 0, expiresAt ?? new Date(Date.now() + fx.quoteTtlSeconds * 1000).toISOString(), now());
  }
  return { sourceCurrency: f.code, targetCurrency: t.code, midRate, rate, markupBps, provider, providerLabel, rateTimestamp: oldest ? new Date(oldest).toISOString() : null, stale, guaranteed, expiresAt, quoteId };
}

export interface LockedQuote {
  id: string;
  rate: number;
  midRate: number;
  markupBps: number;
  provider: string;
  guaranteed: boolean;
}

/** Resolve a quote for execution: a guaranteed, unexpired quote locks its rate; anything else falls back to the live rate. */
export function resolveQuote(quoteId: string | null | undefined, userId: string | null, from: string, to: string): LockedQuote | null {
  if (!quoteId) return null;
  const row = getDb().prepare('SELECT * FROM fx_quotes WHERE id = ?').get(quoteId) as any;
  if (!row) throw badRequest('Unknown exchange quote', 'unknown_quote');
  if (row.user_id && userId && row.user_id !== userId) throw badRequest('Quote belongs to another user', 'unknown_quote');
  if (row.from_currency !== from || row.to_currency !== to) throw badRequest('Quote is for a different currency pair', 'quote_mismatch');
  if (!row.guaranteed) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) throw badRequest('The guaranteed rate has expired. Request a new quote.', 'quote_expired');
  return { id: row.id, rate: row.rate, midRate: row.mid_rate, markupBps: row.markup_bps, provider: row.provider, guaranteed: true };
}
