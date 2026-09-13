import type { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { badRequest } from './errors';

export function validate<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  try {
    return schema.parse(data);
  } catch (err) {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const path = first?.path?.length ? `${first.path.join('.')}: ` : '';
      throw badRequest(`${path}${first?.message ?? 'Invalid input'}`, 'validation_error', err.issues);
    }
    throw err;
  }
}

export function parsePagination(query: Request['query'], defaultSize = 20, maxSize = 100) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, Number(query.pageSize) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export type Handler = (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown;

/** Express 5 forwards rejected promises to error handlers; this wrapper keeps Express 4 compatibility. */
export const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export function getClientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
