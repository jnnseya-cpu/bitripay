import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { hmacSha256 } from '../lib/crypto';
import { findUserById } from './users';
import { config } from '../config';

/**
 * Deliver a signed webhook to a merchant's configured URL.
 * Signature: X-BitriPay-Signature: sha256=<hmac of raw body using the merchant's webhook secret>
 */
export async function dispatchWebhook(userId: string, event: string, data: Record<string, unknown>) {
  const user = findUserById(userId);
  if (!user?.webhook_url || !user.webhook_secret) return;
  const db = getDb();
  const id = uuid();
  const payload = JSON.stringify({ id, event, createdAt: now(), data });
  db.prepare('INSERT INTO webhook_deliveries (id, user_id, event, payload, url, status_code, success, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, 0, 0, ?, ?)').run(
    id,
    userId,
    event,
    payload,
    user.webhook_url,
    now(),
    now(),
  );
  if (config.isTest) return;
  void attemptDelivery(id);
}

export async function attemptDelivery(deliveryId: string): Promise<void> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(deliveryId) as any;
  if (!row) return;
  const user = findUserById(row.user_id);
  if (!user?.webhook_secret) return;
  const signature = `sha256=${hmacSha256(user.webhook_secret, row.payload)}`;
  let statusCode: number | null = null;
  let success = 0;
  let lastError: string | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(row.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BitriPay-Signature': signature, 'X-BitriPay-Event': row.event, 'User-Agent': 'BitriPay-Webhooks/1.0' },
      body: row.payload,
      signal: controller.signal,
    });
    clearTimeout(timer);
    statusCode = res.status;
    success = res.ok ? 1 : 0;
    if (!res.ok) lastError = `HTTP ${res.status}`;
  } catch (err) {
    lastError = (err as Error).message;
  }
  db.prepare('UPDATE webhook_deliveries SET status_code = ?, success = ?, attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?').run(statusCode, success, lastError, now(), deliveryId);
  if (!success && row.attempts + 1 < 5) {
    const delay = Math.min(60_000 * 2 ** row.attempts, 30 * 60_000);
    setTimeout(() => void attemptDelivery(deliveryId), delay).unref();
  }
}
