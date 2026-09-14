import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../lib/errors';
import { bpCode } from '../lib/bpCodes';
import { config } from '../config';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, bp: bpCode(err.code, err.status), message: err.message, details: err.details } });
    return;
  }
  const anyErr = err as any;
  if (anyErr?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'payload_too_large', bp: 'BP-2000', message: 'Request body too large' } });
    return;
  }
  // Money parsing (shared `toMinor`) rejects malformed amounts with a plain Error: that is the caller's input, never a fault.
  if (typeof anyErr?.message === 'string' && /^(Invalid amount|Amount supports at most \d+ decimal places|Amount too large)$/.test(anyErr.message)) {
    res.status(400).json({ error: { code: 'invalid_amount', bp: bpCode('invalid_amount', 400), message: anyErr.message } });
    return;
  }
  if (anyErr?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'invalid_json', bp: 'BP-2004', message: 'Malformed JSON body' } });
    return;
  }
  if (!config.isTest) console.error('[error]', err);
  res.status(500).json({ error: { code: 'internal_error', bp: 'BP-9000', message: config.isProduction ? 'Something went wrong' : String(anyErr?.message ?? err) } });
}
