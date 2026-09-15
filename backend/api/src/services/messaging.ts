import nodemailer from 'nodemailer';
import { config } from '../config';
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
