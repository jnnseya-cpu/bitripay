import nodemailer from 'nodemailer';
import { config } from '../config';
import { getSetting } from './settings';

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

export async function sendEmail(to: string, subject: string, text: string, html?: string): Promise<{ delivered: boolean; via: string }> {
  const smtp = getSmtpSettings();
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

export async function sendSms(to: string, body: string): Promise<{ delivered: boolean; via: string }> {
  outbox.push({ channel: 'sms', to, body, at: new Date().toISOString() });
  if (outbox.length > 200) outbox.shift();
  const sms = getSetting<{ provider?: string; twilioSid?: string; twilioToken?: string; twilioFrom?: string }>('sms', {});
  const provider = sms.provider || config.sms.provider;
  if (provider === 'twilio') {
    const sid = sms.twilioSid || config.sms.twilioSid;
    const token = sms.twilioToken || config.sms.twilioToken;
    const from = sms.twilioFrom || config.sms.twilioFrom;
    if (sid && token && from) {
      try {
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
        });
        return { delivered: res.ok, via: 'twilio' };
      } catch (err) {
        console.error('[sms] twilio failed', (err as Error).message);
        return { delivered: false, via: 'twilio_error' };
      }
    }
  }
  if (!config.isTest) console.log(`[sms → ${to}] ${body}`);
  return { delivered: false, via: 'console' };
}
