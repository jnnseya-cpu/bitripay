import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { parseJson } from '../lib/json';
import { config } from '../config';
import { badRequest } from '../lib/errors';
import { translate, type Notification } from '@bitripay/shared';

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

// ---------------------------------------------------------------------------------------------------------------------
// Notification templates: admin-editable text per event key, channel and language with {{placeholders}}.
// ---------------------------------------------------------------------------------------------------------------------
export const TEMPLATE_CHANNELS = ['sms', 'whatsapp', 'email', 'push'] as const;
export type TemplateChannel = (typeof TEMPLATE_CHANNELS)[number];
export interface NotificationTemplate {
  id: string;
  key: string;
  channel: TemplateChannel;
  lang: string;
  subject: string | null;
  body: string;
  updatedBy: string | null;
  updatedAt: string;
  /** True while the stored text still equals the shipped default. */
  isDefault: boolean;
}
interface TemplateSeed {
  key: string;
  channel: TemplateChannel;
  subject?: string;
  body: string;
}
/** Event catalogue: what each key means and the placeholders it receives (also used for previews in the admin). */
export const TEMPLATE_EVENTS: Record<string, { description: string; sample: Record<string, string> }> = {
  otp: { description: 'One-time verification code (login, registration, password reset, contact verification)', sample: { appName: config.appName, code: '482913', minutes: '10' } },
  welcome: { description: 'Account created', sample: { appName: config.appName, name: 'Amina' } },
  'payment.received': { description: 'A merchant or requester received a payment', sample: { payerName: 'Amina K.', amount: '$25.00', description: ' for "Order 1042"' } },
  'payment.rejected': { description: 'An external payment was refused', sample: { reason: 'Card declined by the issuer' } },
  'deposit.completed': { description: 'Money added to a wallet', sample: { amount: '$100.00', currency: 'USD' } },
  'payout.paid': { description: 'A payout was delivered to its recipient', sample: { amount: 'KES 5,000.00', recipient: 'Joseph O.', rail: 'M-PESA', reference: 'BP-7Y2K', senderName: 'Amina K.' } },
  'payout.failed': { description: 'A payout could not be executed; funds returned', sample: { reason: 'Operator unavailable' } },
  'kyc.approved': { description: 'Identity verification approved', sample: {} },
  'kyc.rejected': { description: 'Identity verification rejected', sample: { reason: ': document unreadable' } },
  'remittance.sent': { description: 'Remittance sent (sender side)', sample: { amount: 'NGN 150,000.00', status: 'was delivered instantly', pickupCode: '' } },
  'remittance.received': { description: 'Remittance received in a wallet', sample: { senderName: 'Amina K.', amount: 'NGN 150,000.00' } },
  'remittance.delivered': { description: 'Bank remittance paid out', sample: { recipientName: 'Family' } },
  'remittance.refunded': { description: 'Remittance cancelled and refunded', sample: { reason: ': account closed' } },
  'remittance.pickup': { description: 'Cash pickup collected at an agent', sample: { recipientName: 'Cousin', amount: '$50.00', agentName: 'Kinshasa Point' } },
  'virtual_card.issued': { description: 'A virtual card was issued', sample: { currency: 'USD', last4: '4821' } },
  'virtual_card.charged': { description: 'A virtual card was charged', sample: { amount: '$25.00', last4: '4821', merchantName: 'Shop' } },
  'recovery_code.used': { description: 'A 2FA recovery code was used to sign in', sample: { remaining: '7', hint: '' } },
  'destination.changed': { description: 'A payout destination (bank account, mobile money, recipient) was added or changed', sample: { destination: 'bank account ••••8877', hours: '24' } },
};
const DEFAULT_TEMPLATES: TemplateSeed[] = [
  { key: 'otp', channel: 'sms', body: 'Your {{appName}} verification code is {{code}}. It expires in {{minutes}} minutes.' },
  { key: 'otp', channel: 'whatsapp', body: 'Your {{appName}} verification code is {{code}}. It expires in {{minutes}} minutes.' },
  { key: 'otp', channel: 'email', subject: '{{appName}} verification code', body: 'Your {{appName}} verification code is {{code}}. It expires in {{minutes}} minutes.' },
  { key: 'welcome', channel: 'push', subject: 'Welcome to {{appName}}!', body: 'Your wallet is ready. Add money to get started.' },
  { key: 'payment.received', channel: 'push', subject: 'Payment received', body: '{{payerName}} paid {{amount}}{{description}}.' },
  { key: 'payment.received', channel: 'sms', body: '{{appName}}: {{payerName}} paid you {{amount}}{{description}}.' },
  { key: 'payment.received', channel: 'email', subject: 'Payment received: {{amount}}', body: '{{payerName}} paid {{amount}}{{description}}.' },
  { key: 'payment.rejected', channel: 'push', subject: 'Payment rejected', body: '{{reason}}' },
  { key: 'deposit.completed', channel: 'push', subject: 'Money added', body: '{{amount}} was added to your {{currency}} wallet.' },
  { key: 'payout.paid', channel: 'push', subject: 'Payout delivered', body: '{{amount}} was delivered to {{recipient}} ({{rail}}). Operator reference {{reference}}.' },
  { key: 'payout.paid', channel: 'sms', body: '{{appName}}: {{amount}} was sent to you by {{senderName}}. Ref {{reference}}.' },
  { key: 'payout.paid', channel: 'whatsapp', body: '{{appName}}: {{amount}} was sent to you by {{senderName}}. Ref {{reference}}.' },
  { key: 'payout.failed', channel: 'push', subject: 'Payout failed', body: '{{reason}}. The funds are back in your wallet.' },
  { key: 'kyc.approved', channel: 'push', subject: 'Identity verified', body: 'Your KYC verification was approved. Higher limits are now active.' },
  { key: 'kyc.rejected', channel: 'push', subject: 'Verification rejected', body: 'Your KYC submission was rejected{{reason}}. You can submit again.' },
  { key: 'remittance.sent', channel: 'push', subject: 'Remittance sent', body: 'Your remittance of {{amount}} {{status}}{{pickupCode}}.' },
  { key: 'remittance.received', channel: 'push', subject: 'Remittance received', body: '{{senderName}} sent you {{amount}} from abroad.' },
  { key: 'remittance.delivered', channel: 'push', subject: 'Remittance delivered', body: 'Your remittance to {{recipientName}} has been paid out.' },
  { key: 'remittance.refunded', channel: 'push', subject: 'Remittance refunded', body: 'Your remittance was cancelled{{reason}}. Funds returned to your wallet.' },
  { key: 'remittance.pickup', channel: 'push', subject: 'Cash picked up', body: '{{recipientName}} collected {{amount}} at agent {{agentName}}.' },
  { key: 'virtual_card.issued', channel: 'push', subject: 'Virtual card issued', body: 'Your new {{currency}} virtual card ending in {{last4}} is ready.' },
  { key: 'virtual_card.charged', channel: 'push', subject: 'Card payment', body: '{{amount}} was charged to your virtual card •••• {{last4}} at {{merchantName}}.' },
  { key: 'recovery_code.used', channel: 'push', subject: 'Recovery code used', body: 'A recovery code was used to sign in to your account. {{remaining}} left{{hint}}.' },
  {
    key: 'destination.changed',
    channel: 'push',
    subject: 'Payout destination changed',
    body: '{{destination}} was added to your account. Large payouts to it start after {{hours}} hours. Not you? Revoke it now in Security.',
  },
];
const DEFAULT_LANG = 'en';
const seededDbs = new WeakSet<object>();

const toTemplate = (r: any): NotificationTemplate => {
  const seed = DEFAULT_TEMPLATES.find((d) => d.key === r.key && d.channel === r.channel);
  return {
    id: r.id,
    key: r.key,
    channel: r.channel,
    lang: r.lang,
    subject: r.subject ?? null,
    body: r.body,
    updatedBy: r.updated_by ?? null,
    updatedAt: r.updated_at,
    isDefault: !!seed && r.lang === DEFAULT_LANG && (seed.subject ?? null) === (r.subject ?? null) && seed.body === r.body,
  };
};

/** Seeds the shipped English defaults once per database; rows an administrator edited are never touched. */
export function ensureNotificationTemplates() {
  const db = getDb();
  if (seededDbs.has(db)) return;
  const ins = db.prepare('INSERT OR IGNORE INTO notification_templates (id, key, channel, lang, subject, body, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)');
  db.transaction(() => {
    for (const d of DEFAULT_TEMPLATES) ins.run(uuid(), d.key, d.channel, DEFAULT_LANG, d.subject ?? null, d.body, now());
  })();
  seededDbs.add(db);
}

export function listNotificationTemplates(filter: { key?: string | null; channel?: string | null; lang?: string | null } = {}): NotificationTemplate[] {
  ensureNotificationTemplates();
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.key) {
    where.push('key = ?');
    params.push(filter.key);
  }
  if (filter.channel) {
    where.push('channel = ?');
    params.push(filter.channel);
  }
  if (filter.lang) {
    where.push('lang = ?');
    params.push(filter.lang);
  }
  return (
    getDb()
      .prepare(`SELECT * FROM notification_templates ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY key, channel, lang`)
      .all(...params) as any[]
  ).map(toTemplate);
}

/** Creates or replaces the template for (key, channel, lang); `reset` restores the shipped default text. */
export function upsertNotificationTemplate(
  input: { key: string; channel: TemplateChannel; lang?: string | null; subject?: string | null; body?: string | null; reset?: boolean },
  adminId: string | null,
) {
  ensureNotificationTemplates();
  const key = input.key.trim();
  const lang = (input.lang || DEFAULT_LANG).trim().toLowerCase();
  if (!TEMPLATE_EVENTS[key]) throw badRequest(`Unknown template key: ${key}`, 'validation_error');
  if (!TEMPLATE_CHANNELS.includes(input.channel)) throw badRequest('Unknown channel', 'validation_error');
  const seed = DEFAULT_TEMPLATES.find((d) => d.key === key && d.channel === input.channel);
  const subject = input.reset ? (seed?.subject ?? null) : (input.subject?.trim() ?? null) || null;
  const body = input.reset ? (seed?.body ?? '') : (input.body ?? '').trim();
  if (!body) throw badRequest('Template body is required', 'validation_error');
  getDb()
    .prepare(
      'INSERT INTO notification_templates (id, key, channel, lang, subject, body, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key, channel, lang) DO UPDATE SET subject = excluded.subject, body = excluded.body, updated_by = excluded.updated_by, updated_at = excluded.updated_at',
    )
    .run(uuid(), key, input.channel, lang, subject, body, adminId, now());
  return listNotificationTemplates({ key, channel: input.channel, lang })[0];
}

/** `{{name}}` → vars.name (missing placeholders render empty, never as raw braces). */
export function fillPlaceholders(text: string, vars: Record<string, unknown>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, name: string) => {
    const v = name === 'appName' && vars[name] === undefined ? config.appName : vars[name];
    return v === undefined || v === null ? '' : String(v);
  });
}

/**
 * Renders the template for an event on a channel: the requested language, then English, then the shipped default
 * text. Returns null only for a key nobody has defined, so callers keep their own wording as the last fallback.
 */
export function renderTemplate(key: string, channel: TemplateChannel, lang: string | null | undefined, vars: Record<string, unknown> = {}): { subject: string | null; body: string } | null {
  ensureNotificationTemplates();
  const db = getDb();
  const want = (lang || DEFAULT_LANG).toLowerCase();
  const pick = db.prepare('SELECT subject, body FROM notification_templates WHERE key = ? AND channel = ? AND lang = ?');
  const row = (pick.get(key, channel, want) ?? (want !== DEFAULT_LANG ? pick.get(key, channel, DEFAULT_LANG) : undefined)) as { subject: string | null; body: string } | undefined;
  const seed = row ?? DEFAULT_TEMPLATES.find((d) => d.key === key && d.channel === channel);
  if (!seed) return null;
  return { subject: seed.subject ? fillPlaceholders(seed.subject, vars) : null, body: fillPlaceholders(seed.body, vars) };
}

/**
 * Stores an in-app notification and pushes it. `data.template` (an event key) with `data.vars` renders the title and
 * body from the admin-editable template in the user's language; the caller's title/body stay as the fallback.
 * The `loud` flag follows the kind (or an explicit data.loud) and the user's loud-alert preference.
 */
/** Everything after the in-app row: the communication engine registers itself here and fans the notice out to the other channels. */
export type TemplatedNotifyHandler = (userId: string, title: string, body: string, data: Record<string, unknown>, notificationId: string, pushed: boolean) => void;
let templatedNotifyHandler: TemplatedNotifyHandler | null = null;
export function registerTemplatedNotifyHandler(handler: TemplatedNotifyHandler | null) {
  templatedNotifyHandler = handler;
}

/** The in-app notification row alone (notification centre + badge); loud alerts follow the user's preference. */
export function insertNotification(userId: string, title: string, body: string, payload: Record<string, unknown> = {}): { id: string; loud: boolean } {
  const db = getDb();
  const id = uuid();
  const prefs = db.prepare('SELECT loud_alerts FROM users WHERE id = ?').get(userId) as { loud_alerts?: number } | undefined;
  const loud = isLoud(payload) && (prefs?.loud_alerts ?? 1) === 1;
  db.prepare('INSERT INTO notifications (id, user_id, title, body, data, read, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)').run(id, userId, title, body, JSON.stringify({ ...payload, loud }), now());
  return { id, loud };
}

export function notify(userId: string, title: string, body: string, data: Record<string, unknown> = {}) {
  const db = getDb();
  const prefs = db.prepare('SELECT language FROM users WHERE id = ?').get(userId) as { language?: string } | undefined;
  const { template, vars, ...rest } = data as { template?: unknown; vars?: unknown } & Record<string, unknown>;
  if (typeof template === 'string') {
    const rendered = renderTemplate(template, 'push', prefs?.language, (vars ?? {}) as Record<string, unknown>);
    if (rendered) {
      title = rendered.subject ?? title;
      body = rendered.body || body;
    }
  }
  // the person's language: titles and fixed bodies come from the phrase packs, template bodies keep their variables
  const lang = prefs?.language || 'en';
  title = translate(lang, title);
  body = translate(lang, body);
  const { id, loud } = insertNotification(userId, title, body, rest);
  const payload = { ...rest, loud };
  const pushed = (db.prepare('SELECT COUNT(*) c FROM push_tokens WHERE user_id = ?').get(userId) as { c: number }).c > 0;
  if (pushed) void sendPush(userId, title, body, payload);
  templatedNotifyHandler?.(userId, title, body, data, id, pushed);
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
