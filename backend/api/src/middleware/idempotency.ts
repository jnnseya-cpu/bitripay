import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db';
import { sha256 } from '../lib/crypto';
import { now } from '../lib/ids';

/**
 * Idempotency keys for every mutating request. Clients send `Idempotency-Key: <unique>`; a repeat
 * with the same key and body replays the stored response (header `Idempotent-Replayed: true`), a
 * repeat with a different body is refused. Keys are scoped to the caller's credential so one user
 * can never replay another user's response.
 */
export function idempotency(req: Request, res: Response, next: NextFunction) {
  const key = req.header('idempotency-key');
  if (!key || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  // National switch payments keep their own financial tombstones (never released by TTL, IDM-007) and answer with the
  // scheme's business codes; the 24-hour response cache must not sit in front of them.
  if (/^\/(api\/)?v1\/payments(\/|$)/.test(req.path)) return next();
  if (key.length > 200) return res.status(400).json({ error: { code: 'invalid_idempotency_key', message: 'Idempotency-Key is too long' } });
  const scope = sha256(`${req.header('authorization') || req.ip || ''}`);
  const requestHash = sha256(`${req.method} ${req.originalUrl}\n${JSON.stringify(req.body ?? {})}`);
  const db = getDb();
  const existing = db.prepare('SELECT * FROM idempotency_keys WHERE scope = ? AND key = ?').get(scope, key) as any;
  if (existing) {
    if (existing.request_hash !== requestHash) return res.status(422).json({ error: { code: 'idempotency_key_reused', message: 'This Idempotency-Key was already used with a different request' } });
    if (existing.status_code === null) return res.status(409).json({ error: { code: 'request_in_progress', message: 'A request with this Idempotency-Key is still being processed' } });
    res.setHeader('Idempotent-Replayed', 'true');
    // an identical repeat of a creation returns the same resource with 200 (it already exists); other statuses replay as stored
    return res
      .status(existing.status_code === 201 ? 200 : existing.status_code)
      .type('application/json')
      .send(existing.response);
  }
  db.prepare('INSERT INTO idempotency_keys (scope, key, request_hash, status_code, response, created_at) VALUES (?, ?, ?, NULL, NULL, ?)').run(scope, key, requestHash, now());
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    try {
      db.prepare('UPDATE idempotency_keys SET status_code = ?, response = ? WHERE scope = ? AND key = ?').run(res.statusCode, JSON.stringify(body), scope, key);
    } catch {
      /* never fail the request because of the cache */
    }
    return originalJson(body);
  }) as Response['json'];
  res.on('finish', () => {
    // A handler that ended without res.json (e.g. an error thrown before responding) must not pin the key forever.
    const row = db.prepare('SELECT status_code FROM idempotency_keys WHERE scope = ? AND key = ?').get(scope, key) as any;
    if (row && row.status_code === null) db.prepare('DELETE FROM idempotency_keys WHERE scope = ? AND key = ?').run(scope, key);
  });
  next();
}
