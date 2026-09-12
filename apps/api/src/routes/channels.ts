/**
 * Feature-phone channels: the USSD webhook (Africa's Talking form fields or generic JSON) and the inbound SMS
 * webhook (Twilio, Africa's Talking or generic field names) with a synchronous reply in the aggregator's format.
 */
import { Router } from 'express';
import { rateLimit } from '../middleware/rateLimit';
import { forbidden } from '../lib/errors';
import { wrap } from '../lib/http';
import { getChannelSettings } from '../services/settings';
import { ussdRequest } from '../services/channels/ussd';
import { smsInbound } from '../services/channels/sms';

export const channelsRouter = Router();
const limit = rateLimit({ windowMs: 60_000, max: 600, keyPrefix: 'channels' });

function checkSecret(req: any, secret: string) {
  if (!secret) return;
  const given = (req.headers['x-channel-secret'] as string | undefined) || String(req.query.secret ?? req.body?.secret ?? '');
  if (given !== secret) throw forbidden('Invalid channel secret', 'channel_secret');
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** USSD: body {sessionId, serviceCode, phoneNumber, text} (Africa's Talking) or {sessionId, phone, input} (generic). */
channelsRouter.post('/ussd', limit, (req, res) => {
  const s = getChannelSettings().ussd;
  checkSecret(req, s.secret);
  const b = req.body ?? {};
  const sessionId = String(b.sessionId ?? b.session_id ?? b.SessionId ?? req.query.sessionId ?? '');
  const phone = String(b.phoneNumber ?? b.phone ?? b.msisdn ?? b.MSISDN ?? b.from ?? '');
  const text = String(b.text ?? b.input ?? b.ussdString ?? b.USSD_STRING ?? '');
  if (!sessionId || !phone) return res.status(400).type('text/plain').send('END Missing session or phone');
  const format = String(req.query.format ?? (b.input !== undefined || b.phone !== undefined ? 'json' : s.provider === 'generic' ? 'json' : 'text'));
  const provider = String(req.query.provider ?? (format === 'json' ? 'generic' : 'africastalking'));
  const reply = ussdRequest({ sessionId, phone, text, provider, fullPath: b.text !== undefined && provider === 'africastalking' });
  if (format === 'json') return res.json({ sessionId, text: reply.text, end: reply.end, action: reply.end ? 'end' : 'continue' });
  return res.type('text/plain').send(`${reply.end ? 'END' : 'CON'} ${reply.text}`);
});

/** SMS: body {From, Body} (Twilio), {from, text} (Africa's Talking) or {phone, message}. Reply as plain text, TwiML or JSON. */
channelsRouter.post(
  '/sms/inbound',
  limit,
  wrap(async (req, res) => {
    const s = getChannelSettings().sms;
    checkSecret(req, s.secret);
    const b = req.body ?? {};
    const phone = String(b.From ?? b.from ?? b.phone ?? b.msisdn ?? b.phoneNumber ?? '');
    const body = String(b.Body ?? b.text ?? b.message ?? b.body ?? '');
    if (!phone) return res.status(400).type('text/plain').send('Missing sender');
    const reply = await smsInbound(phone, body);
    const format = String(req.query.format ?? (b.From !== undefined ? 'twiml' : s.replyFormat));
    if (format === 'twiml') return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${esc(reply)}</Message></Response>`);
    if (format === 'json') return res.json({ to: phone, reply });
    return res.type('text/plain').send(reply);
  }),
);
