import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../lib/errors';
import { getClientIp } from '../lib/http';
import { config } from '../config';

interface Bucket {
  count: number;
  resetAt: number;
}

/** Simple fixed-window in-memory rate limiter (per IP + route). Swap for Redis in a multi-instance deploy. */
export function rateLimit(options: { windowMs: number; max: number; keyPrefix?: string }) {
  const buckets = new Map<string, Bucket>();
  return (req: Request, res: Response, next: NextFunction) => {
    if (config.isTest) return next();
    const key = `${options.keyPrefix ?? req.path}:${getClientIp(req)}`;
    const nowMs = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < nowMs) {
      bucket = { count: 0, resetAt: nowMs + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    res.setHeader('X-RateLimit-Limit', options.max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, options.max - bucket.count));
    if (bucket.count > options.max) {
      return next(new AppError(429, 'rate_limited', 'Too many requests. Please slow down.'));
    }
    if (buckets.size > 10000) {
      for (const [k, b] of buckets) if (b.resetAt < nowMs) buckets.delete(k);
    }
    next();
  };
}
