import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { parseJson } from '../lib/json';
import { config } from '../config';
import type { Notification } from '@bitripay/shared';

export function toNotification(row: any): Notification {
  return { id: row.id, title: row.title, body: row.body, data: parseJson(row.data, {}), read: !!row.read, createdAt: row.created_at };
}

/**
 * Money events ring loud: the apps play the alarm sound and a long vibration pattern for these unless the user turned
 * loud alerts off. Anything else (chat, KYC, welcome) uses the normal notification sound.
 */
export const LOUD_KINDS = new Set([
  'payment_received',
  'payment_in',
  'transfer_in',
  'transfer',
  'deposit',
  'remittance_in',
  'remittance_pickup',
  'money_request',
  'payment_request',
  'cash_out_request',
  'route',
  'route_consent',
  'payout',
  'withdrawal',
  'adjustment',
  'distribution',
  'wallet',
  'reconciliation',
  'chargeback',
  'collection',
  'verification',
  'approval',
  'payment_failed',
]);

export function isLoud(data: Record<string, unknown>): boolean {
  if (typeof data.loud === 'boolean') return data.loud;
  return LOUD_KINDS.has(String(data.kind ?? ''));
}

export function notify(userId: string, title: string, body: string, data: Record<string, unknown> = {}) {
  const db = getDb();
  const id = uuid();
  const loud = isLoud(data) && ((db.prepare('SELECT loud_alerts FROM users WHERE id = ?').get(userId) as any)?.loud_alerts ?? 1) === 1;
  const payload = { ...data, loud };
  db.prepare('INSERT INTO notifications (id, user_id, title, body, data, read, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)').run(id, userId, title, body, JSON.stringify(payload), now());
  void sendPush(userId, title, body, payload);
  return id;
}

export function setLoudAlerts(userId: string, enabled: boolean) {
  getDb()
    .prepare('UPDATE users SET loud_alerts = ? WHERE id = ?')
    .run(enabled ? 1 : 0, userId);
}

export function listNotifications(userId: string, limit = 50): Notification[] {
  return getDb().prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit).map(toNotification);
}

export function unreadCount(userId: string): number {
  return (getDb().prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND read = 0').get(userId) as any).c;
}

export function markRead(userId: string, id?: string) {
  if (id) getDb().prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND id = ?').run(userId, id);
  else getDb().prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(userId);
}

export function registerPushToken(userId: string, token: string, platform: string) {
  getDb()
    .prepare('INSERT INTO push_tokens (id, user_id, token, platform, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform')
    .run(uuid(), userId, token, platform, now());
}

export function removePushToken(token: string) {
  getDb().prepare('DELETE FROM push_tokens WHERE token = ?').run(token);
}

/** Deliver a push notification through the Expo push service to all devices of the user. */
export async function sendPush(userId: string, title: string, body: string, data: Record<string, unknown> = {}) {
  if (config.isTest) return;
  const tokens = getDb().prepare('SELECT token FROM push_tokens WHERE user_id = ?').all(userId) as { token: string }[];
  const expoTokens = tokens.map((t) => t.token).filter((t) => t.startsWith('ExponentPushToken') || t.startsWith('ExpoPushToken'));
  if (expoTokens.length === 0) return;
  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(config.expoAccessToken ? { Authorization: `Bearer ${config.expoAccessToken}` } : {}),
      },
      // Loud alerts: custom alarm sound on the max-importance channel with a long vibration pattern (the app registers the channel).
      body: JSON.stringify(
        expoTokens.map((to) =>
          data.loud ? { to, title, body, data, sound: 'loud_alert.wav', channelId: 'bitripay-loud', priority: 'high', badge: 1 } : { to, title, body, data, sound: 'default', priority: 'high' },
        ),
      ),
    });
    if (!res.ok) console.warn('[push] expo responded', res.status);
  } catch (err) {
    console.warn('[push] failed', (err as Error).message);
  }
}

/** Broadcast a notification to every active user (optionally filtered by role). */
export function broadcast(title: string, body: string, role?: string): number {
  const db = getDb();
  const rows = db.prepare(`SELECT id FROM users WHERE is_system = 0 AND status = 'active' ${role ? 'AND role = ?' : ''}`).all(...(role ? [role] : [])) as { id: string }[];
  for (const r of rows) notify(r.id, title, body, { broadcast: true });
  return rows.length;
}
