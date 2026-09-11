import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { parseJson } from '../lib/json';
import { config } from '../config';
import type { Notification } from '@bitripay/shared';

export function toNotification(row: any): Notification {
  return { id: row.id, title: row.title, body: row.body, data: parseJson(row.data, {}), read: !!row.read, createdAt: row.created_at };
}

export function notify(userId: string, title: string, body: string, data: Record<string, unknown> = {}) {
  const db = getDb();
  const id = uuid();
  db.prepare('INSERT INTO notifications (id, user_id, title, body, data, read, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)').run(id, userId, title, body, JSON.stringify(data), now());
  void sendPush(userId, title, body, data);
  return id;
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
      body: JSON.stringify(expoTokens.map((to) => ({ to, title, body, data, sound: 'default' }))),
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
