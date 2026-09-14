/**
 * Service-level objective measurement. Every response is timed and classified into a route class (intent creation,
 * QR resolution, KODA verification, money posting, national switch, other). Samples go into a per-class ring buffer
 * (the last 10 000 samples, with timestamps) and are rolled up per minute into `slo_samples`; requests authenticated
 * with an API key are counted per key in `slo_api_usage`; error codes per minute in `slo_error_codes`.
 *
 * Targets (product baseline): intent create p99 < 300 ms · scan-to-confirmation p95 < 2 s · KODA verify p95 < 5 s ·
 * ledger write p99 < 50 ms · switch availability 99.95 %. The report says whether each target is met over the last
 * hour and the last 24 hours; without traffic a target is neither met nor missed (`met: null`), never assumed.
 */
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db';

export const SLO_CLASSES = ['intent_create', 'qr_resolve', 'koda_verify', 'money_post', 'switch', 'other'] as const;
export type SloClass = (typeof SLO_CLASSES)[number];

export interface SloTarget {
  /** Which percentile the target applies to. */
  percentile: 'p50' | 'p95' | 'p99';
  /** Latency ceiling in milliseconds. */
  maxMs: number;
  label: string;
}
export const SLO_TARGETS: Record<SloClass, SloTarget | null> = {
  intent_create: { percentile: 'p99', maxMs: 300, label: 'Intent create p99 < 300 ms' },
  qr_resolve: { percentile: 'p95', maxMs: 2000, label: 'Scan-to-confirmation p95 < 2 s' },
  koda_verify: { percentile: 'p95', maxMs: 5000, label: 'KODA verify p95 < 5 s' },
  money_post: { percentile: 'p99', maxMs: 50, label: 'Ledger write p99 < 50 ms' },
  switch: null,
  other: null,
};
/** National switch availability target (fraction of switch requests that did not fail server-side). */
export const SWITCH_AVAILABILITY_TARGET = 0.9995;
export const RING_SIZE = 10_000;

// ---------------------------------------------------------------------------------------------------------------------
// Ring buffers and per-minute accumulators
// ---------------------------------------------------------------------------------------------------------------------
interface Ring {
  latency: Float64Array;
  at: Float64Array;
  next: number;
  size: number;
}
interface MinuteAcc {
  minute: string;
  samples: number[];
  errors: number;
  clientErrors: number;
  rateLimited: number;
}
interface KeyAcc {
  minute: string;
  count: number;
  errors: number;
  rateLimited: number;
}

const rings = new Map<string, Ring>();
const minuteAcc = new Map<string, MinuteAcc>();
const keyAcc = new Map<string, KeyAcc>();
const codeAcc = new Map<string, { minute: string; count: number }>();

const ringFor = (cls: string): Ring => {
  let r = rings.get(cls);
  if (!r) {
    r = { latency: new Float64Array(RING_SIZE), at: new Float64Array(RING_SIZE), next: 0, size: 0 };
    rings.set(cls, r);
  }
  return r;
};

/** `YYYY-MM-DDTHH:MM` in UTC. */
export const minuteOf = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 16);

function pushRing(cls: string, latencyMs: number, atMs: number) {
  const r = ringFor(cls);
  r.latency[r.next] = latencyMs;
  r.at[r.next] = atMs;
  r.next = (r.next + 1) % RING_SIZE;
  if (r.size < RING_SIZE) r.size += 1;
}

/** Nearest-rank percentile over a sorted array (null when empty). */
export function percentileOf(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[rank] * 100) / 100;
}

function flushMinute(cls: string, acc: MinuteAcc) {
  if (!acc.samples.length && !acc.errors && !acc.rateLimited && !acc.clientErrors) return;
  const sorted = [...acc.samples].sort((a, b) => a - b);
  getDb()
    .prepare(
      `INSERT INTO slo_samples (class, minute, count, p50_ms, p95_ms, p99_ms, errors, client_errors, rate_limited) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(class, minute) DO UPDATE SET
         p50_ms = (COALESCE(slo_samples.p50_ms, 0) * slo_samples.count + COALESCE(excluded.p50_ms, 0) * excluded.count) / MAX(1, slo_samples.count + excluded.count),
         p95_ms = MAX(COALESCE(slo_samples.p95_ms, 0), COALESCE(excluded.p95_ms, 0)),
         p99_ms = MAX(COALESCE(slo_samples.p99_ms, 0), COALESCE(excluded.p99_ms, 0)),
         count = slo_samples.count + excluded.count,
         errors = slo_samples.errors + excluded.errors,
         client_errors = slo_samples.client_errors + excluded.client_errors,
         rate_limited = slo_samples.rate_limited + excluded.rate_limited`,
    )
    .run(cls, acc.minute, acc.samples.length, percentileOf(sorted, 50), percentileOf(sorted, 95), percentileOf(sorted, 99), acc.errors, acc.clientErrors, acc.rateLimited);
}

function flushKey(apiKeyId: string, acc: KeyAcc) {
  getDb()
    .prepare(
      `INSERT INTO slo_api_usage (api_key_id, minute, count, errors, rate_limited) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(api_key_id, minute) DO UPDATE SET count = slo_api_usage.count + excluded.count, errors = slo_api_usage.errors + excluded.errors, rate_limited = slo_api_usage.rate_limited + excluded.rate_limited`,
    )
    .run(apiKeyId, acc.minute, acc.count, acc.errors, acc.rateLimited);
}

function flushCode(code: string, acc: { minute: string; count: number }) {
  getDb()
    .prepare('INSERT INTO slo_error_codes (code, minute, count) VALUES (?, ?, ?) ON CONFLICT(code, minute) DO UPDATE SET count = slo_error_codes.count + excluded.count')
    .run(code, acc.minute, acc.count);
}

/** Write every pending accumulator to the database (called when a minute rolls over, on the idle timer, and by tests). */
export function flushSlo(): { classes: number; keys: number; codes: number } {
  let classes = 0;
  let keys = 0;
  let codes = 0;
  for (const [cls, acc] of minuteAcc) {
    flushMinute(cls, acc);
    minuteAcc.delete(cls);
    classes += 1;
  }
  for (const [k, acc] of keyAcc) {
    flushKey(k, acc);
    keyAcc.delete(k);
    keys += 1;
  }
  for (const [c, acc] of codeAcc) {
    flushCode(c, acc);
    codeAcc.delete(c);
    codes += 1;
  }
  return { classes, keys, codes };
}

let flushTimer: NodeJS.Timeout | null = null;
function ensureTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    try {
      const current = minuteOf();
      for (const [cls, acc] of minuteAcc)
        if (acc.minute !== current) {
          flushMinute(cls, acc);
          minuteAcc.delete(cls);
        }
      for (const [k, acc] of keyAcc)
        if (acc.minute !== current) {
          flushKey(k, acc);
          keyAcc.delete(k);
        }
      for (const [c, acc] of codeAcc)
        if (acc.minute !== current) {
          flushCode(c, acc);
          codeAcc.delete(c);
        }
    } catch {
      /* the next tick retries; measurement never breaks a request */
    }
  }, 15_000);
  flushTimer.unref();
}

export interface SloSample {
  className: string;
  latencyMs: number;
  statusCode: number;
  apiKeyId?: string | null;
  errorCode?: string | null;
  at?: number;
}

/** Record one sample: the ring buffer, the per-minute accumulator, the API-key counter and the error-code counter. */
export function recordSlo(sample: SloSample): void {
  const at = sample.at ?? Date.now();
  const minute = minuteOf(at);
  const isServerError = sample.statusCode >= 500;
  const isClientError = sample.statusCode >= 400 && sample.statusCode < 500;
  const isRateLimited = sample.statusCode === 429;
  pushRing(sample.className, sample.latencyMs, at);
  let acc = minuteAcc.get(sample.className);
  if (acc && acc.minute !== minute) {
    flushMinute(sample.className, acc);
    acc = undefined;
  }
  if (!acc) {
    acc = { minute, samples: [], errors: 0, clientErrors: 0, rateLimited: 0 };
    minuteAcc.set(sample.className, acc);
  }
  acc.samples.push(sample.latencyMs);
  if (isServerError) acc.errors += 1;
  if (isClientError) acc.clientErrors += 1;
  if (isRateLimited) acc.rateLimited += 1;
  if (sample.apiKeyId) {
    let k = keyAcc.get(sample.apiKeyId);
    if (k && k.minute !== minute) {
      flushKey(sample.apiKeyId, k);
      k = undefined;
    }
    if (!k) {
      k = { minute, count: 0, errors: 0, rateLimited: 0 };
      keyAcc.set(sample.apiKeyId, k);
    }
    k.count += 1;
    if (isServerError || isClientError) k.errors += 1;
    if (isRateLimited) k.rateLimited += 1;
  }
  if (sample.errorCode) {
    let c = codeAcc.get(sample.errorCode);
    if (c && c.minute !== minute) {
      flushCode(sample.errorCode, c);
      c = undefined;
    }
    if (!c) {
      c = { minute, count: 0 };
      codeAcc.set(sample.errorCode, c);
    }
    c.count += 1;
  }
  ensureTimer();
}

// ---------------------------------------------------------------------------------------------------------------------
// Route classification
// ---------------------------------------------------------------------------------------------------------------------
const V1 = /^\/(?:api\/)?v1/;
/** Map a method + path to its SLO class. Partner paths are served at both /api/v1 and /v1. */
export function classifyRoute(method: string, path: string): SloClass {
  const m = method.toUpperCase();
  const p = path.replace(/\/+$/, '') || '/';
  if (V1.test(p)) {
    const rest = p.replace(V1, '');
    if (m === 'POST' && (rest === '/payment_intents' || rest === '/qr-intents' || /^\/qr\/[^/]+\/intent$/.test(rest))) return 'intent_create';
    if (rest === '/resolve' || rest.startsWith('/resolve/') || rest === '/payment_resolution') return 'qr_resolve';
    if (m === 'POST' && rest === '/verifications') return 'koda_verify';
    if (/^\/(payments|consents|participants)(\/|$)/.test(rest)) return 'switch';
    return 'other';
  }
  if (p.startsWith('/api/qr')) return 'qr_resolve';
  if (m === 'POST' && p.startsWith('/api/money')) return 'money_post';
  return 'other';
}

/** Express middleware: time every response and record it under its route class. Mounted right after the correlation id. */
export function sloMiddleware(req: Request, res: Response, next: NextFunction) {
  const started = process.hrtime.bigint();
  let errorCode: string | null = null;
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    const err = (body as { error?: { code?: unknown } } | null)?.error;
    if (err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string') errorCode = (err as { code: string }).code;
    return originalJson(body);
  }) as Response['json'];
  res.once('finish', () => {
    try {
      const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
      const path = (req.originalUrl || req.url || '/').split('?')[0];
      recordSlo({
        className: classifyRoute(req.method, path),
        latencyMs,
        statusCode: res.statusCode,
        apiKeyId: req.apiKeyId ?? null,
        errorCode: res.statusCode >= 400 ? (errorCode ?? `http_${res.statusCode}`) : null,
      });
    } catch {
      /* measurement never breaks a request */
    }
  });
  next();
}

/** Time an in-process span (a ledger posting, a KODA lookup, a switch emission) under `className`. Sync or async. */
export function measure<T>(className: string, fn: () => T): T {
  const started = process.hrtime.bigint();
  const done = (ok: boolean) => recordSlo({ className, latencyMs: Number(process.hrtime.bigint() - started) / 1e6, statusCode: ok ? 200 : 500 });
  let result: T;
  try {
    result = fn();
  } catch (err) {
    done(false);
    throw err;
  }
  if (result && typeof (result as unknown as Promise<unknown>).then === 'function') {
    return (result as unknown as Promise<unknown>).then(
      (v) => {
        done(true);
        return v;
      },
      (err) => {
        done(false);
        throw err;
      },
    ) as unknown as T;
  }
  done(true);
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------------------------------
export interface SloWindow {
  hours: number;
  /** Requests in the window (database roll-ups plus the current minute). */
  count: number;
  /** Samples the percentiles were computed from (the ring buffer keeps the last 10 000 per class). */
  sampled: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  errors: number;
  clientErrors: number;
  rateLimited: number;
  errorRate: number | null;
  /** Fraction of requests that did not fail server-side. */
  availability: number | null;
  /** true / false against the class target; null when there is no target or no traffic. */
  met: boolean | null;
}
export interface SloClassReport {
  class: string;
  target: SloTarget | null;
  windows: { '1h': SloWindow; '24h': SloWindow };
}
export interface SloReport {
  generatedAt: string;
  classes: SloClassReport[];
  switchAvailability: { target: number; '1h': { availability: number | null; met: boolean | null; requests: number }; '24h': { availability: number | null; met: boolean | null; requests: number } };
  summary: { met: number; missed: number; noTraffic: number };
}

function windowFor(cls: string, hours: number, nowMs: number): SloWindow {
  const since = nowMs - hours * 3600_000;
  const r = rings.get(cls);
  const values: number[] = [];
  if (r) for (let i = 0; i < r.size; i += 1) if (r.at[i] >= since) values.push(r.latency[i]);
  values.sort((a, b) => a - b);
  const sinceMinute = minuteOf(since);
  const row = getDb()
    .prepare('SELECT COALESCE(SUM(count), 0) c, COALESCE(SUM(errors), 0) e, COALESCE(SUM(client_errors), 0) ce, COALESCE(SUM(rate_limited), 0) rl FROM slo_samples WHERE class = ? AND minute >= ?')
    .get(cls, sinceMinute) as { c: number; e: number; ce: number; rl: number };
  const pending = minuteAcc.get(cls);
  const count = row.c + (pending && pending.minute >= sinceMinute ? pending.samples.length : 0);
  const errors = row.e + (pending && pending.minute >= sinceMinute ? pending.errors : 0);
  const clientErrors = row.ce + (pending && pending.minute >= sinceMinute ? pending.clientErrors : 0);
  const rateLimited = row.rl + (pending && pending.minute >= sinceMinute ? pending.rateLimited : 0);
  const p50Ms = percentileOf(values, 50);
  const p95Ms = percentileOf(values, 95);
  const p99Ms = percentileOf(values, 99);
  const target = (SLO_TARGETS as Record<string, SloTarget | null>)[cls] ?? null;
  const measured = target ? (target.percentile === 'p50' ? p50Ms : target.percentile === 'p95' ? p95Ms : p99Ms) : null;
  return {
    hours,
    count,
    sampled: values.length,
    p50Ms,
    p95Ms,
    p99Ms,
    errors,
    clientErrors,
    rateLimited,
    errorRate: count ? Math.round(((errors + clientErrors) / count) * 10000) / 10000 : null,
    availability: count ? Math.round(((count - errors) / count) * 1_000_000) / 1_000_000 : null,
    met: target && measured != null ? measured < target.maxMs : null,
  };
}

/** Per-class latency and error report for the last hour and the last 24 hours, plus national switch availability. */
export function sloReport(nowMs = Date.now()): SloReport {
  const known = new Set<string>([...SLO_CLASSES, ...rings.keys(), ...(getDb().prepare('SELECT DISTINCT class FROM slo_samples').all() as { class: string }[]).map((r) => r.class)]);
  const classes: SloClassReport[] = [...known].map((cls) => ({
    class: cls,
    target: (SLO_TARGETS as Record<string, SloTarget | null>)[cls] ?? null,
    windows: { '1h': windowFor(cls, 1, nowMs), '24h': windowFor(cls, 24, nowMs) },
  }));
  const sw = classes.find((c) => c.class === 'switch')!;
  const avail = (w: SloWindow) => ({ availability: w.availability, met: w.availability == null ? null : w.availability >= SWITCH_AVAILABILITY_TARGET, requests: w.count });
  const summary = { met: 0, missed: 0, noTraffic: 0 };
  for (const c of classes) {
    if (!c.target) continue;
    const m = c.windows['24h'].met;
    if (m === true) summary.met += 1;
    else if (m === false) summary.missed += 1;
    else summary.noTraffic += 1;
  }
  const sa = { target: SWITCH_AVAILABILITY_TARGET, '1h': avail(sw.windows['1h']), '24h': avail(sw.windows['24h']) };
  if (sa['24h'].met === true) summary.met += 1;
  else if (sa['24h'].met === false) summary.missed += 1;
  else summary.noTraffic += 1;
  return { generatedAt: new Date(nowMs).toISOString(), classes, switchAvailability: sa, summary };
}

/** Forget every in-memory sample (tests). Database roll-ups are untouched. */
export function resetSloMemory() {
  rings.clear();
  minuteAcc.clear();
  keyAcc.clear();
  codeAcc.clear();
}
