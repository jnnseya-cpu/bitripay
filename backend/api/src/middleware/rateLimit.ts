import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../lib/errors';
import { getClientIp } from '../lib/http';
import { config } from '../config';

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyPrefix?: string;
  /**
   * Subject to limit instead of the client address (device id, MSISDN, QR id, API key, account …). When it returns
   * nothing the request is not counted by this limiter (the request has no such subject; stack an IP limiter for it).
   */
  keyBy?: (req: Request) => string | null | undefined;
  /** Only count these HTTP methods (e.g. write methods on a router-level limiter). */
  methods?: string[];
  /** Tests skip limiters by default so fixtures can hammer the API; set to prove a limiter in a test. */
  enforceInTests?: boolean;
  message?: string;
}

const MAX_TRACKED_KEYS = 10_000;

const digits = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[^0-9]/g, '') : '');
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : typeof v === 'number' ? String(v) : null);

/** Key helpers: device id header, MSISDN in the body, QR id in params/body, the signed-in account, the client address. */
export const keyByDevice = (req: Request) => str(req.headers['x-device-id']);
export const keyByMsisdn = (req: Request) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const d = digits(b.msisdn ?? b.phone ?? b.customer_msisdn ?? b.customerMsisdn);
  return d.length >= 6 ? d : null;
};
export const keyByQrId = (req: Request) => str(req.params?.id) ?? str((req.body ?? {})?.qr_id) ?? str((req.body ?? {})?.qrId);
export const keyByUser = (req: Request) => (req.user ? `user:${req.user.id}` : null);
export const keyByIp = (req: Request) => getClientIp(req);

/**
 * Sliding-window in-memory rate limiter: every hit is a timestamp under its key; a request is refused when `max` hits
 * already fall inside the trailing window. Keyed per client address and route prefix by default, or by the subject
 * `keyBy` extracts (device, MSISDN, QR id, account). Swap for Redis in a multi-instance deploy.
 */
export function rateLimit(options: RateLimitOptions) {
  const hits = new Map<string, number[]>();
  const methods = options.methods?.map((m) => m.toUpperCase()) ?? null;
  return (req: Request, res: Response, next: NextFunction) => {
    if (config.isTest && !options.enforceInTests) return next();
    if (methods && !methods.includes(req.method.toUpperCase())) return next();
    const subject = options.keyBy ? options.keyBy(req) : getClientIp(req);
    if (!subject) return next();
    const key = `${options.keyPrefix ?? req.path}:${subject}`;
    const nowMs = Date.now();
    const since = nowMs - options.windowMs;
    let stamps = hits.get(key);
    if (!stamps) {
      stamps = [];
      hits.set(key, stamps);
    }
    while (stamps.length && stamps[0] <= since) stamps.shift();
    res.setHeader('X-RateLimit-Limit', options.max);
    if (stamps.length >= options.max) {
      const retryAfter = Math.max(1, Math.ceil((stamps[0] + options.windowMs - nowMs) / 1000));
      res.setHeader('X-RateLimit-Remaining', 0);
      res.setHeader('Retry-After', retryAfter);
      return next(new AppError(429, 'rate_limited', options.message ?? 'Too many requests. Please slow down.', { retryAfterSeconds: retryAfter, scope: options.keyPrefix ?? req.path }));
    }
    stamps.push(nowMs);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, options.max - stamps.length));
    if (hits.size > MAX_TRACKED_KEYS) {
      for (const [k, s] of hits) if (!s.length || s[s.length - 1] <= since) hits.delete(k);
    }
    next();
  };
}

/** Money-moving partner endpoints (routes/v1.ts): refunds and payouts, per signed-in account or key, else per address. */
export const refundLimit = rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'v1refund', keyBy: (req) => keyByUser(req) ?? keyByIp(req) });
export const payoutLimit = rateLimit({ windowMs: 60_000, max: 30, keyPrefix: 'v1payout', keyBy: (req) => keyByUser(req) ?? keyByIp(req) });
