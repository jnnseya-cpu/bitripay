import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db';
import { sha256 } from '../lib/crypto';
import { now } from '../lib/ids';

/**
 * Idempotency keys for every mutating request. Clients send `Idempotency-Key: <unique>`; a repeat
 * with the same key and body replays the stored response (header `Idempotent-Replayed: true`), a
 * repeat with a different body, or on a different endpoint, is refused with 409 `idempotency_key_reused`.
 * Keys are scoped to the caller's credential so one user can never replay another user's response, and
 * they expire 24 hours after creation (expired rows are purged lazily, at most once a minute).
 */
export const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
const PURGE_INTERVAL_MS = 60_000;
let lastPurgeAt = 0;

/** Path template of a request: method plus the path with resource identifiers replaced by `{id}`. */
export function idempotencyEndpoint(method: string, path: string): string {
  const template = path
    .split('/')
    .map((seg) => (/^[a-z]{1,4}_[A-Za-z0-9_-]+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || (/\d/.test(seg) && seg.length >= 6) ? '{id}' : seg))
    .join('/');
  return `${method.toUpperCase()} ${template}`;
}

/** Delete keys past their TTL; cheap enough to run inline because it is throttled to once a minute per process. */
export function purgeExpiredIdempotencyKeys(force = false): number {
  const at = Date.now();
  if (!force && at - lastPurgeAt < PURGE_INTERVAL_MS) return 0;
  lastPurgeAt = at;
  return getDb().prepare('DELETE FROM idempotency_keys WHERE expires_at IS NOT NULL AND expires_at < ?').run(now()).changes;
}

export function idempotency(req: Request, res: Response, next: NextFunction) {
  const key = req.header('idempotency-key');
  if (!key || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  // National switch payments keep their own financial tombstones (never released by TTL, IDM-007) and answer with the
  // scheme's business codes; the 24-hour response cache must not sit in front of them.
  if (/^\/(api\/)?v1\/payments(\/|$)/.test(req.path)) return next();
  if (key.length > 200) return res.status(400).json({ error: { code: 'invalid_idempotency_key', message: 'Idempotency-Key is too long' } });
  const scope = sha256(`${req.header('authorization') || req.ip || ''}`);
  const endpoint = idempotencyEndpoint(req.method, req.path);
  const requestHash = sha256(`${req.method} ${req.originalUrl}\n${JSON.stringify(req.body ?? {})}`);
  const db = getDb();
  purgeExpiredIdempotencyKeys();
  let existing = db.prepare('SELECT * FROM idempotency_keys WHERE scope = ? AND key = ?').get(scope, key) as any;
  if (existing && existing.expires_at && existing.expires_at < now()) {
    // past its TTL: the key may be used again as if it had never been seen
    db.prepare('DELETE FROM idempotency_keys WHERE scope = ? AND key = ?').run(scope, key);
    existing = undefined;
  }
  if (existing) {
    if (existing.endpoint && existing.endpoint !== endpoint)
      return res.status(409).json({
        error: { code: 'idempotency_key_reused', message: 'This Idempotency-Key was already used on a different endpoint', details: { endpoint: existing.endpoint } },
      });
    if (existing.request_hash !== requestHash) return res.status(409).json({ error: { code: 'idempotency_key_reused', message: 'This Idempotency-Key was already used with a different request' } });
    if (existing.status_code === null) return res.status(409).json({ error: { code: 'request_in_progress', message: 'A request with this Idempotency-Key is still being processed' } });
    res.setHeader('Idempotent-Replayed', 'true');
    // an identical repeat of a creation returns the same resource with 200 (it already exists); other statuses replay as stored
    return res
      .status(existing.status_code === 201 ? 200 : existing.status_code)
      .type('application/json')
      .send(existing.response);
  }
  db.prepare('INSERT INTO idempotency_keys (scope, key, request_hash, status_code, response, created_at, endpoint, expires_at) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)').run(
    scope,
    key,
    requestHash,
    now(),
    endpoint,
    new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString(),
  );
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
