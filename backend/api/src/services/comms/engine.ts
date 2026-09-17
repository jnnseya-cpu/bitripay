/**
 * Communication event engine: one `emit()` fans a catalogue event out across email, in-app, SMS, push and WhatsApp,
 * honours the recipient's opt-outs (mandatory notices bypass them), renders administrator-edited templates first and
 * the catalogue text otherwise, brands every email with the site's logo, colour and contact details, and records every
 * event × channel × recipient attempt with its delivery status. Legacy `notify(userId, title, body, { template })`
 * calls are routed here by notifications.ts, so every existing notice fans out the same way without touching its call
 * site.
 */
import { getDb } from '../../db';
import { uuid, now } from '../../lib/ids';
import { config } from '../../config';
import { parseJson } from '../../lib/json';
import { escapeHtml } from '../markdown';
import { getSiteSettings } from '../cms';
import { getSmtpSettings, sendEmail, sendSms, smsProvider } from '../messaging';
import { listDevices } from '../evidence';
import { fillPlaceholders, renderTemplate, insertNotification, sendPush, registerTemplatedNotifyHandler } from '../notifications';
import { deliverWhatsApp, getWhatsAppSettings, toWaId } from '../channels/whatsapp';
import { COMMS_CATEGORIES, COMMS_CHANNELS, COMMS_EVENTS, getCommsEvent, type CommsChannel, type CommsEvent } from './catalogue';
import { translate } from '@bitripay/shared';

export type DeliveryStatus = 'sent' | 'logged' | 'failed' | 'skipped_opted_out' | 'skipped_no_contact' | 'skipped_no_device';

export interface Delivery {
  id: string;
  eventId: string;
  category: string;
  channel: CommsChannel;
  userId: string | null;
  recipient: string | null;
  subject: string | null;
  status: DeliveryStatus;
  via: string | null;
  error: string | null;
  mandatory: boolean;
  test: boolean;
  createdAt: string;
}

/** Per-user opt-outs: `{ [categoryId]: { [channel]: false } }`; anything absent is on. */
export type CommsPrefs = Record<string, Partial<Record<CommsChannel, boolean>>>;

export interface EmitOptions {
  /** Recipient account; email/phone are read from it unless overridden below. */
  userId?: string | null;
  /** Direct contact for recipients without an account (a registration code, a pickup notice to a phone). */
  email?: string | null;
  phone?: string | null;
  lang?: string | null;
  vars?: Record<string, unknown>;
  /** Extra data carried by the in-app notification and push payload (kind, ids for deep links). */
  data?: Record<string, unknown>;
  /** Restrict to these channels (still intersected with the event's defaults unless `force`). */
  channels?: CommsChannel[];
  /** Ignore opt-outs and channel defaults (admin test sends). */
  force?: boolean;
  test?: boolean;
}

const toDelivery = (r: any): Delivery => ({
  id: r.id,
  eventId: r.event_id,
  category: r.category,
  channel: r.channel,
  userId: r.user_id ?? null,
  recipient: r.recipient ?? null,
  subject: r.subject ?? null,
  status: r.status,
  via: r.via ?? null,
  error: r.error ?? null,
  mandatory: !!r.mandatory,
  test: !!r.test,
  createdAt: r.created_at,
});

function record(d: Omit<Delivery, 'id' | 'createdAt'>): Delivery {
  const id = uuid();
  const at = now();
  getDb()
    .prepare(
      'INSERT INTO comms_deliveries (id, event_id, category, channel, user_id, recipient, subject, status, via, error, mandatory, test, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, d.eventId, d.category, d.channel, d.userId, d.recipient, d.subject, d.status, d.via, d.error, d.mandatory ? 1 : 0, d.test ? 1 : 0, at);
  return { ...d, id, createdAt: at };
}

/** Contact details never leave the log in full. */
const maskContact = (v: string | null | undefined): string | null => {
  if (!v) return null;
  if (v.includes('@')) {
    const [local, domain] = v.split('@');
    return `${local.slice(0, 2)}…@${domain}`;
  }
  return `…${v.slice(-4)}`;
};

// ---------------------------------------------------------------- preferences
export function getCommsPrefs(userId: string): CommsPrefs {
  const row = getDb().prepare('SELECT comms_prefs FROM users WHERE id = ?').get(userId) as { comms_prefs?: string } | undefined;
  return parseJson<CommsPrefs>(row?.comms_prefs ?? '{}', {});
}
export function setCommsPrefs(userId: string, prefs: CommsPrefs): CommsPrefs {
  const clean: CommsPrefs = {};
  for (const cat of COMMS_CATEGORIES) {
    const p = prefs[cat.id];
    if (!p) continue;
    const entry: Partial<Record<CommsChannel, boolean>> = {};
    for (const ch of COMMS_CHANNELS) if (p[ch] === false) entry[ch] = false;
    if (Object.keys(entry).length) clean[cat.id] = entry;
  }
  getDb().prepare('UPDATE users SET comms_prefs = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(clean), now(), userId);
  return clean;
}
const optedOut = (prefs: CommsPrefs, category: string, channel: CommsChannel) => prefs[category]?.[channel] === false;

// ---------------------------------------------------------------- rendering
export function renderEvent(event: CommsEvent, channel: CommsChannel, vars: Record<string, unknown>, lang?: string | null): { subject: string; body: string } {
  const merged = { appName: config.appName, supportEmail: getSiteSettings().contactEmail, ...vars };
  // administrator-edited templates (Messaging → Templates) win; the catalogue text is the shipped default
  const templateChannel = channel === 'inapp' ? 'push' : channel;
  const edited = renderTemplate(event.id, templateChannel, lang, merged);
  if (edited) return { subject: edited.subject ?? fillPlaceholders(event.subject, merged), body: edited.body };
  // shipped text in the person's language (phrase packs), placeholders filled afterwards
  const l = lang || 'en';
  return { subject: fillPlaceholders(translate(l, event.subject), merged), body: fillPlaceholders(translate(l, event.body), merged) };
}

/** Branded HTML email: the site logo (or name), primary colour, the message, an optional call-to-action, contact footer. */
export function renderBrandedEmail(subject: string, body: string, vars: Record<string, unknown> = {}): string {
  const site = getSiteSettings();
  const colour = /^#[0-9a-f]{6}$/i.test(site.primaryColor) ? site.primaryColor : '#2563eb';
  const link = typeof vars.link === 'string' && /^https?:\/\//.test(vars.link) ? vars.link : null;
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.55;color:#1c1f24">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const logo = site.logoUrl
    ? `<img src="${escapeHtml(site.logoUrl)}" alt="${escapeHtml(site.siteName)}" style="height:36px;max-width:180px">`
    : `<span style="font-size:20px;font-weight:700;color:#fff">${escapeHtml(site.siteName)}</span>`;
  const cta = link
    ? `<p style="margin:22px 0 6px"><a href="${escapeHtml(link)}" style="display:inline-block;background:${colour};color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">Open ${escapeHtml(site.siteName)}</a></p>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px 12px;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="600" style="max-width:600px;width:100%;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
<tr><td style="background:${colour};padding:18px 24px">${logo}</td></tr>
<tr><td style="padding:26px 24px 8px"><h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#111827">${escapeHtml(subject)}</h1>${paragraphs}${cta}</td></tr>
<tr><td style="padding:16px 24px 24px;font-size:12px;line-height:1.5;color:#6b7280;border-top:1px solid #f3f4f6">
${escapeHtml(site.siteName)}${site.tagline ? ` · ${escapeHtml(site.tagline)}` : ''}<br>
${site.address ? `${escapeHtml(site.address)}<br>` : ''}
Questions? <a href="mailto:${escapeHtml(site.contactEmail)}" style="color:${colour}">${escapeHtml(site.contactEmail)}</a><br>
You receive this because you have a ${escapeHtml(site.siteName)} account. Security and legal notices are always sent; everything else can be adjusted under Settings → Notifications.
</td></tr></table></td></tr></table></body></html>`;
}

// ---------------------------------------------------------------- channel readiness
export function channelStatus(): Record<CommsChannel, { wired: boolean; detail: string }> {
  const smtp = getSmtpSettings();
  const smsCfg = smsProvider();
  // "device": the enrolled payout phones send from their own SIM (no SMS API key); wired as soon as one active payout device exists
  const smsPhones = smsCfg.provider === 'device' ? listDevices().filter((d) => d.kind === 'payout' && d.status === 'active').length : 0;
  const smsWired = (smsCfg.provider === 'twilio' && !!smsCfg.twilio) || (smsCfg.provider === 'africastalking' && !!smsCfg.africasTalking) || smsPhones > 0;
  const smsDetail = smsWired
    ? smsCfg.provider === 'twilio'
      ? 'Twilio'
      : smsCfg.provider === 'device'
        ? `Enrolled phone SIM (${smsPhones} payout device${smsPhones === 1 ? '' : 's'}, no SMS API key)`
        : `Africa's Talking (${smsCfg.africasTalking!.username === 'sandbox' ? 'sandbox' : 'live'}${smsCfg.africasTalking!.from ? `, sender ${smsCfg.africasTalking!.from}` : ''})`
    : smsCfg.provider === 'device'
      ? 'Enrolled phone SIM: no active payout device yet, SMS wait in the outbox'
      : smsCfg.provider === 'console'
        ? 'No SMS provider selected: SMS are logged, not sent'
        : `${smsCfg.provider}: credentials missing, SMS wait in the outbox for an enrolled phone`;
  const wa = getWhatsAppSettings();
  return {
    email: { wired: !!smtp.host, detail: smtp.host ? `SMTP ${smtp.host}:${smtp.port} as ${smtp.from}` : 'No SMTP host: emails are logged, not sent' },
    inapp: { wired: true, detail: 'Notification centre in the web app and phone app' },
    sms: { wired: smsWired, detail: smsDetail },
    push: { wired: true, detail: config.expoAccessToken ? 'Expo push service (access token set)' : 'Expo push service (no access token; fine for most volumes)' },
    whatsapp: { wired: !!(wa.accessToken && wa.phoneNumberId), detail: wa.accessToken && wa.phoneNumberId ? 'WhatsApp Cloud API' : 'Not connected: Admin → Channels → WhatsApp' },
  };
}

// ---------------------------------------------------------------- emit
export async function emit(eventId: string, opts: EmitOptions = {}): Promise<Delivery[]> {
  const event = getCommsEvent(eventId);
  if (!event) throw new Error(`Unknown communication event: ${eventId}`);
  const db = getDb();
  const user = opts.userId
    ? (db.prepare('SELECT id, email, phone, language, full_name FROM users WHERE id = ?').get(opts.userId) as
        { id: string; email: string | null; phone: string | null; language: string | null; full_name: string } | undefined)
    : undefined;
  const email = opts.email ?? user?.email ?? null;
  const phone = opts.phone ?? user?.phone ?? null;
  const lang = opts.lang ?? user?.language ?? null;
  const vars = { name: user?.full_name?.split(' ')[0] ?? '', ...(opts.vars ?? {}) };
  const prefs = user && !opts.force ? getCommsPrefs(user.id) : {};
  const channels: CommsChannel[] = opts.force ? (opts.channels ?? event.channels) : opts.channels ? event.channels.filter((c) => opts.channels!.includes(c)) : event.channels;
  const out: Delivery[] = [];
  const base = { eventId: event.id, category: event.category, userId: user?.id ?? null, mandatory: event.mandatory, test: !!opts.test };

  for (const channel of channels) {
    const { subject, body } = renderEvent(event, channel, vars, lang);
    if (!event.mandatory && !opts.force && optedOut(prefs, event.category, channel)) {
      out.push(record({ ...base, channel, recipient: null, subject, status: 'skipped_opted_out', via: null, error: null }));
      continue;
    }
    try {
      if (channel === 'inapp') {
        if (!user) {
          out.push(record({ ...base, channel, recipient: null, subject, status: 'skipped_no_contact', via: null, error: 'no account' }));
          continue;
        }
        insertNotification(user.id, subject, body, { ...(opts.data ?? {}), event: event.id, severity: event.severity, category: event.category });
        out.push(record({ ...base, channel, recipient: user.id, subject, status: 'sent', via: 'inapp', error: null }));
      } else if (channel === 'push') {
        if (!user) {
          out.push(record({ ...base, channel, recipient: null, subject, status: 'skipped_no_contact', via: null, error: 'no account' }));
          continue;
        }
        const tokens = (db.prepare('SELECT COUNT(*) c FROM push_tokens WHERE user_id = ?').get(user.id) as { c: number }).c;
        if (!tokens) {
          out.push(record({ ...base, channel, recipient: user.id, subject, status: 'skipped_no_device', via: null, error: null }));
          continue;
        }
        await sendPush(user.id, subject, body, { ...(opts.data ?? {}), event: event.id, severity: event.severity });
        out.push(record({ ...base, channel, recipient: user.id, subject, status: config.isTest ? 'logged' : 'sent', via: 'expo', error: null }));
      } else if (channel === 'email') {
        if (!email) {
          out.push(record({ ...base, channel, recipient: null, subject, status: 'skipped_no_contact', via: null, error: 'no email address' }));
          continue;
        }
        const r = await sendEmail(email, subject, body, renderBrandedEmail(subject, body, vars));
        out.push(
          record({
            ...base,
            channel,
            recipient: maskContact(email),
            subject,
            status: r.delivered ? 'sent' : r.via === 'console' ? 'logged' : 'failed',
            via: r.via,
            error: r.delivered || r.via === 'console' ? null : r.via,
          }),
        );
      } else if (channel === 'sms') {
        if (!phone) {
          out.push(record({ ...base, channel, recipient: null, subject, status: 'skipped_no_contact', via: null, error: 'no phone number' }));
          continue;
        }
        const r = await sendSms(phone, body);
        out.push(
          record({
            ...base,
            channel,
            recipient: maskContact(phone),
            subject,
            status: r.delivered ? 'sent' : r.via === 'console' ? 'logged' : 'failed',
            via: r.via,
            error: r.delivered || r.via === 'console' ? null : r.via,
          }),
        );
      } else if (channel === 'whatsapp') {
        if (!phone) {
          out.push(record({ ...base, channel, recipient: null, subject, status: 'skipped_no_contact', via: null, error: 'no phone number' }));
          continue;
        }
        const entry = await deliverWhatsApp({ messaging_product: 'whatsapp', recipient_type: 'individual', to: toWaId(phone), type: 'text', text: { body } }, user?.id ?? null);
        out.push(
          record({
            ...base,
            channel,
            recipient: maskContact(phone),
            subject,
            status: entry.delivered ? 'sent' : entry.via === 'outbox' ? 'logged' : 'failed',
            via: entry.via,
            error: entry.via === 'meta_error' ? 'meta_error' : null,
          }),
        );
      }
    } catch (err) {
      out.push(record({ ...base, channel, recipient: null, subject, status: 'failed', via: null, error: (err as Error).message }));
    }
  }
  return out;
}

/** Fire-and-forget from synchronous code paths; failures are recorded per channel, never thrown. */
export function emitAsync(eventId: string, opts: EmitOptions = {}): void {
  void emit(eventId, opts).catch((err) => console.error(`[comms] ${eventId} failed`, (err as Error).message));
}

// ---------------------------------------------------------------- legacy notify() routing
// notify() has already written the in-app row and pushed; the engine records both and fans the event out to the
// channels the catalogue adds (email, SMS, WhatsApp) for templated notices. Plain notices are logged under notice.generic.
registerTemplatedNotifyHandler((userId, title, body, data, _notificationId, pushed) => {
  const { template, vars, ...rest } = data as { template?: unknown; vars?: unknown } & Record<string, unknown>;
  const event = (typeof template === 'string' && getCommsEvent(template)) || getCommsEvent('notice.generic')!;
  const base = { eventId: event.id, category: event.category, userId, mandatory: event.mandatory, test: false };
  record({ ...base, channel: 'inapp', recipient: userId, subject: title, status: 'sent', via: 'inapp', error: null });
  record({ ...base, channel: 'push', recipient: userId, subject: title, status: pushed ? (config.isTest ? 'logged' : 'sent') : 'skipped_no_device', via: pushed ? 'expo' : null, error: null });
  const remaining = event.channels.filter((c) => c !== 'inapp' && c !== 'push');
  if (!remaining.length) return;
  const v = event.id === 'notice.generic' ? { title, body, ...((vars ?? {}) as Record<string, unknown>) } : ((vars ?? {}) as Record<string, unknown>);
  emitAsync(event.id, { userId, vars: v, data: rest, channels: remaining });
});

// ---------------------------------------------------------------- reporting
export function listDeliveries(filter: { eventId?: string | null; channel?: string | null; userId?: string | null; limit?: number } = {}): Delivery[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.eventId) {
    where.push('event_id = ?');
    params.push(filter.eventId);
  }
  if (filter.channel) {
    where.push('channel = ?');
    params.push(filter.channel);
  }
  if (filter.userId) {
    where.push('user_id = ?');
    params.push(filter.userId);
  }
  return (
    getDb()
      .prepare(`SELECT * FROM comms_deliveries ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, Math.min(500, filter.limit ?? 50)) as any[]
  ).map(toDelivery);
}

export function commsOverview() {
  const db = getDb();
  const byChannel = db.prepare("SELECT channel, SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) sent, COUNT(*) attempted FROM comms_deliveries GROUP BY channel").all() as {
    channel: CommsChannel;
    sent: number;
    attempted: number;
  }[];
  const totals = db.prepare("SELECT SUM(CASE WHEN status IN ('sent','logged') THEN 1 ELSE 0 END) delivered, COUNT(*) attempted FROM comms_deliveries WHERE status NOT LIKE 'skipped%'").get() as {
    delivered: number | null;
    attempted: number;
  };
  const status = channelStatus();
  const coverage = COMMS_CHANNELS.map((channel) => ({
    channel,
    events: COMMS_EVENTS.filter((e) => e.channels.includes(channel)).length,
    sent: byChannel.find((b) => b.channel === channel)?.sent ?? 0,
    attempted: byChannel.find((b) => b.channel === channel)?.attempted ?? 0,
    wired: status[channel].wired,
    detail: status[channel].detail,
  }));
  return {
    events: COMMS_EVENTS.length,
    categories: COMMS_CATEGORIES.length,
    mandatory: COMMS_EVENTS.filter((e) => e.mandatory).length,
    delivered: totals.delivered ?? 0,
    attempted: totals.attempted,
    channelsWired: coverage.filter((c) => c.wired).length,
    coverage,
  };
}

/** Rendered preview for the console: every channel's text plus the branded email HTML, from the event's sample values. */
export function previewEvent(eventId: string, vars?: Record<string, unknown>, lang?: string | null) {
  const event = getCommsEvent(eventId);
  if (!event) throw new Error(`Unknown communication event: ${eventId}`);
  const v = { ...event.sample, ...(vars ?? {}) };
  const channels = Object.fromEntries(COMMS_CHANNELS.map((c) => [c, renderEvent(event, c, v, lang)]));
  const email = channels.email as { subject: string; body: string };
  return { event, vars: v, channels, html: renderBrandedEmail(email.subject, email.body, v) };
}

/** Deliveries older than the retention window are pruned by the daily job. */
export function pruneDeliveries(days = 90): number {
  return getDb()
    .prepare('DELETE FROM comms_deliveries WHERE created_at < ?')
    .run(new Date(Date.now() - days * 86_400_000).toISOString()).changes;
}
