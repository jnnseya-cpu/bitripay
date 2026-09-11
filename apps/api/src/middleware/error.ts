import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../lib/errors';
import { config } from '../config';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  const anyErr = err as any;
  if (anyErr?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body too large' } });
    return;
  }
  if (anyErr?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'invalid_json', message: 'Malformed JSON body' } });
    return;
  }
  if (!config.isTest) console.error('[error]', err);
  res.status(500).json({ error: { code: 'internal_error', message: config.isProduction ? 'Something went wrong' : String(anyErr?.message ?? err) } });
}
