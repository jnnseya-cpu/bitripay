import nodemailer from 'nodemailer';
import { config } from '../config';
import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { getSetting } from './settings';
import { renderTemplate, type TemplateChannel } from './notifications';

export interface SmtpSettings {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  secure: boolean;
}

export function getSmtpSettings(): SmtpSettings {
  const stored = getSetting<Partial<SmtpSettings>>('smtp', {});
  return {
    host: stored.host || config.smtp.host,
    port: Number(stored.port || config.smtp.port),
    user: stored.user || config.smtp.user,
    pass: stored.pass || config.smtp.pass,
    from: stored.from || config.smtp.from,
    secure: stored.secure ?? Number(stored.port || config.smtp.port) === 465,
  };
}

export const outbox: { channel: 'email' | 'sms'; to: string; subject?: string; body: string; at: string }[] = [];

/** An event key plus placeholder values: the admin-editable template for the channel replaces the literal text. */
export interface TemplatedMessage {
  key: string;
  vars?: Record<string, unknown>;
  lang?: string | null;
}
function applyTemplate(channel: TemplateChannel, template: TemplatedMessage | undefined, fallback: { subject?: string; body: string }) {
  if (!template) return fallback;
  const r = renderTemplate(template.key, channel, template.lang, template.vars ?? {});
  return r ? { subject: r.subject ?? fallback.subject, body: r.body } : fallback;
}

export async function sendEmail(to: string, subject: string, text: string, html?: string, template?: TemplatedMessage): Promise<{ delivered: boolean; via: string }> {
  const smtp = getSmtpSettings();
  const rendered = applyTemplate('email', template, { subject, body: text });
  subject = rendered.subject ?? subject;
  text = rendered.body;
  outbox.push({ channel: 'email', to, subject, body: text, at: new Date().toISOString() });
  if (outbox.length > 200) outbox.shift();
  if (!smtp.host) {
    if (!config.isTest) console.log(`[email → ${to}] ${subject}\n${text}`);
    return { delivered: false, via: 'console' };
  }
  try {
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    });
    await transport.sendMail({ from: smtp.from, to, subject, text, html: html || `<pre style="font-family:sans-serif">${text}</pre>` });
    return { delivered: true, via: 'smtp' };
  } catch (err) {
    console.error('[email] delivery failed', (err as Error).message);
    return { delivered: false, via: 'smtp_error' };
  }
}

export interface SmsSettings {
  provider?: string;
  twilioSid?: string;
  twilioToken?: string;
  twilioFrom?: string;
  africasTalkingUsername?: string;
  africasTalkingApiKey?: string;
  africasTalkingFrom?: string;
}

/** The SMS provider in force and its credentials: the console settings first, the environment as fallback. */
export function smsProvider(): { provider: string; twilio: { sid: string; token: string; from: string } | null; africasTalking: { username: string; apiKey: string; from: string } | null } {
  const sms = getSetting<SmsSettings>('sms', {});
  const provider = sms.provider || config.sms.provider;
  const sid = sms.twilioSid || config.sms.twilioSid;
  const token = sms.twilioToken || config.sms.twilioToken;
  const from = sms.twilioFrom || config.sms.twilioFrom;
  const username = sms.africasTalkingUsername || config.sms.africasTalkingUsername;
  const apiKey = sms.africasTalkingApiKey || config.sms.africasTalkingApiKey;
  return {
    provider,
    twilio: sid && token && from ? { sid, token, from } : null,
    africasTalking: username && apiKey ? { username, apiKey, from: sms.africasTalkingFrom || config.sms.africasTalkingFrom } : null,
  };
}

/** Africa's Talking messaging endpoint: the sandbox host for the "sandbox" username, the live host otherwise. */
export const africasTalkingUrl = (username: string) => `https://api.${username === 'sandbox' ? 'sandbox.' : ''}africastalking.com/version1/messaging`;

export async function sendSms(to: string, body: string, template?: TemplatedMessage): Promise<{ delivered: boolean; via: string }> {
  body = applyTemplate('sms', template, { body }).body;
  outbox.push({ channel: 'sms', to, body, at: new Date().toISOString() });
  if (outbox.length > 200) outbox.shift();
  const { provider, twilio, africasTalking } = smsProvider();
  if (provider === 'device') {
    // no SMS API: the message waits in the outbox until an enrolled phone sends it from its own SIM
    queueSmsForDevice(to, body);
    return { delivered: true, via: 'device' };
  }
  if (provider === 'twilio' && twilio) {
    try {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilio.sid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${twilio.sid}:${twilio.token}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: twilio.from, Body: body }).toString(),
      });
      return { delivered: res.ok, via: 'twilio' };
    } catch (err) {
      console.error('[sms] twilio failed', (err as Error).message);
      return { delivered: false, via: 'twilio_error' };
    }
  }
  if (provider === 'africastalking' && africasTalking) {
    // Africa's Talking answers 201 with one status per recipient: 100 Processed, 101 Sent, 102 Queued are deliveries.
    try {
      const params = new URLSearchParams({ username: africasTalking.username, to, message: body });
      if (africasTalking.from) params.set('from', africasTalking.from);
      const res = await fetch(africasTalkingUrl(africasTalking.username), {
        method: 'POST',
        headers: { apiKey: africasTalking.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const json = (await res.json().catch(() => ({}))) as { SMSMessageData?: { Message?: string; Recipients?: { statusCode?: number; status?: string }[] } };
      const recipients = json.SMSMessageData?.Recipients ?? [];
      const delivered = res.ok && recipients.some((r) => [100, 101, 102].includes(Number(r.statusCode)));
      if (!delivered) console.error('[sms] africastalking refused', json.SMSMessageData?.Message ?? `HTTP ${res.status}`, recipients.map((r) => r.status).join(', '));
      return { delivered, via: 'africastalking' };
    } catch (err) {
      console.error('[sms] africastalking failed', (err as Error).message);
      return { delivered: false, via: 'africastalking_error' };
    }
  }
  if (!config.isTest) console.log(`[sms → ${to}] ${body}`);
  return { delivered: false, via: 'console' };
}

// ---------------------------------------------------------------------------------------------------------------------
// SMS outbox for the enrolled phones (SMS_PROVIDER=device or console → Email, SMS & push → "Enrolled phone SIM")
// ---------------------------------------------------------------------------------------------------------------------
export interface SmsOutboxItem {
  id: string;
  to: string;
  body: string;
  status: 'queued' | 'sending' | 'sent' | 'failed';
  deviceId: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}
const SMS_MAX_ATTEMPTS = 3;
const SMS_SENDING_STALE_MS = 10 * 60_000;
const toOutbox = (r: any): SmsOutboxItem => ({
  id: r.id,
  to: r.to_msisdn,
  body: r.body,
  status: r.status,
  deviceId: r.device_id,
  attempts: r.attempts,
  lastError: r.last_error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  sentAt: r.sent_at,
});

export function queueSmsForDevice(to: string, body: string): SmsOutboxItem {
  const id = uuid();
  getDb().prepare("INSERT INTO sms_outbox (id, to_msisdn, body, status, attempts, created_at, updated_at) VALUES (?, ?, ?, 'queued', 0, ?, ?)").run(id, to, body, now(), now());
  return toOutbox(getDb().prepare('SELECT * FROM sms_outbox WHERE id = ?').get(id));
}

/** A device takes the oldest queued messages; a message stuck in "sending" for ten minutes goes back to the queue first. */
export function claimSmsOutbox(deviceId: string, limit = 10): SmsOutboxItem[] {
  const db = getDb();
  return db.transaction(() => {
    const stale = new Date(Date.now() - SMS_SENDING_STALE_MS).toISOString();
    db.prepare("UPDATE sms_outbox SET status = 'queued', device_id = NULL, updated_at = ? WHERE status = 'sending' AND updated_at < ?").run(now(), stale);
    const rows = db.prepare("SELECT * FROM sms_outbox WHERE status = 'queued' ORDER BY created_at LIMIT ?").all(Math.max(1, Math.min(50, limit))) as any[];
    const mark = db.prepare("UPDATE sms_outbox SET status = 'sending', device_id = ?, updated_at = ? WHERE id = ?");
    for (const r of rows) mark.run(deviceId, now(), r.id);
    return rows.map((r) => toOutbox({ ...r, status: 'sending', device_id: deviceId }));
  })();
}

/** The device reports the outcome; a failure is retried up to three times, then the message is marked failed for the console. */
export function reportSmsOutbox(id: string, deviceId: string, ok: boolean, error: string | null): SmsOutboxItem {
  const db = getDb();
  const r = db.prepare('SELECT * FROM sms_outbox WHERE id = ?').get(id) as any;
  if (!r) throw new Error('Outbox message not found');
  if (r.device_id !== deviceId || r.status !== 'sending') throw new Error('This message is not being sent by this device');
  if (ok) db.prepare("UPDATE sms_outbox SET status = 'sent', sent_at = ?, updated_at = ?, last_error = NULL WHERE id = ?").run(now(), now(), id);
  else {
    const attempts = r.attempts + 1;
    const status = attempts >= SMS_MAX_ATTEMPTS ? 'failed' : 'queued';
    db.prepare('UPDATE sms_outbox SET status = ?, attempts = ?, device_id = NULL, last_error = ?, updated_at = ? WHERE id = ?').run(status, attempts, error ?? 'send failed', now(), id);
  }
  return toOutbox(db.prepare('SELECT * FROM sms_outbox WHERE id = ?').get(id));
}

export function listSmsOutbox(opts: { status?: string | null; limit?: number } = {}): SmsOutboxItem[] {
  const rows = opts.status
    ? getDb().prepare('SELECT * FROM sms_outbox WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(opts.status, opts.limit ?? 100)
    : getDb().prepare('SELECT * FROM sms_outbox ORDER BY created_at DESC LIMIT ?').all(opts.limit ?? 100);
  return (rows as any[]).map(toOutbox);
}

export function smsOutboxSummary(): { queued: number; sending: number; failed: number; sent24h: number } {
  const db = getDb();
  const count = (status: string) => (db.prepare('SELECT COUNT(*) c FROM sms_outbox WHERE status = ?').get(status) as { c: number }).c;
  const since = new Date(Date.now() - 86_400_000).toISOString();
  return { queued: count('queued'), sending: count('sending'), failed: count('failed'), sent24h: (db.prepare("SELECT COUNT(*) c FROM sms_outbox WHERE status = 'sent' AND sent_at >= ?").get(since) as { c: number }).c };
}
