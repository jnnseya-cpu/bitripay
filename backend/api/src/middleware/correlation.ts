/**
 * Correlation id and request context. Every request carries a correlation id (the caller's `X-Correlation-Id` or
 * `X-Request-Id` when present, otherwise a fresh UUID) that is echoed back as `X-Correlation-Id` and kept in an
 * AsyncLocalStorage store for the rest of the request, so the audit trail, the event log and any service can read it
 * without threading it through every signature.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request, Response, NextFunction } from 'express';
import { uuid } from '../lib/ids';
import { getClientIp } from '../lib/http';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      correlationId?: string;
    }
  }
}

export interface RequestContext {
  correlationId: string;
  ip: string;
  /** `X-Device-Id` when the client sends one, else the user agent. */
  device: string | null;
  method: string;
  path: string;
  startedAt: number;
}

export const CORRELATION_HEADER = 'X-Correlation-Id';
const SAFE_ID = /^[A-Za-z0-9._:@/-]{1,128}$/;

const storage = new AsyncLocalStorage<RequestContext>();

/** The correlation id of the request being served, or null outside a request (jobs, tests, CLI). */
export const currentCorrelationId = (): string | null => storage.getStore()?.correlationId ?? null;
export const currentRequestContext = (): RequestContext | null => storage.getStore() ?? null;

/** Accept a caller-supplied id only when it is short and printable; anything else gets a fresh UUID. */
export function correlationIdFromHeaders(headers: Request['headers']): string {
  for (const name of ['x-correlation-id', 'x-request-id']) {
    const v = headers[name];
    const raw = Array.isArray(v) ? v[0] : v;
    if (typeof raw === 'string' && SAFE_ID.test(raw.trim())) return raw.trim();
  }
  return uuid();
}

export function deviceOf(req: Request): string | null {
  const dev = req.headers['x-device-id'];
  const d = Array.isArray(dev) ? dev[0] : dev;
  if (typeof d === 'string' && d.trim()) return d.trim().slice(0, 120);
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' && ua.trim() ? ua.trim().slice(0, 200) : null;
}

/** Express middleware: assign / echo the correlation id and run the rest of the request inside its context. */
export function correlation(req: Request, res: Response, next: NextFunction) {
  const correlationId = correlationIdFromHeaders(req.headers);
  req.correlationId = correlationId;
  res.setHeader(CORRELATION_HEADER, correlationId);
  // Browsers only read non-simple response headers the server exposes.
  res.setHeader('Access-Control-Expose-Headers', CORRELATION_HEADER);
  const ctx: RequestContext = { correlationId, ip: getClientIp(req), device: deviceOf(req), method: req.method, path: req.path, startedAt: Date.now() };
  storage.run(ctx, () => next());
}

/** Run `fn` under an explicit context (scheduled jobs, message handlers, tests). */
export function withRequestContext<T>(ctx: Partial<RequestContext> & { correlationId?: string }, fn: () => T): T {
  const full: RequestContext = {
    correlationId: ctx.correlationId ?? uuid(),
    ip: ctx.ip ?? 'internal',
    device: ctx.device ?? null,
    method: ctx.method ?? 'JOB',
    path: ctx.path ?? '',
    startedAt: ctx.startedAt ?? Date.now(),
  };
  return storage.run(full, fn);
}
