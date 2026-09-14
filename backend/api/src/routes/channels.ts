/**
 * Feature-phone channels: the USSD webhook (Africa's Talking form fields or generic JSON) and the inbound SMS
 * webhook (Twilio, Africa's Talking or generic field names) with a synchronous reply in the aggregator's format, and the
 * WhatsApp (Meta Cloud API) webhook: the verification handshake and signed inbound messages.
 */
import { Router } from 'express';
import { rateLimit } from '../middleware/rateLimit';
import { forbidden } from '../lib/errors';
import { wrap } from '../lib/http';
import { getChannelSettings } from '../services/settings';
import { ussdRequest } from '../services/channels/ussd';
import { smsInbound } from '../services/channels/sms';
import { getWhatsAppSettings, verifyHandshake, verifySignature, whatsappInbound } from '../services/channels/whatsapp';

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

/**
 * WhatsApp verification handshake (Meta calls it once when the webhook URL is saved): `hub.mode=subscribe` with the
 * configured `hub.verify_token` → echo `hub.challenge` as plain text; anything else is refused with 403.
 */
channelsRouter.get('/whatsapp', limit, (req, res) => {
  const challenge = verifyHandshake(req.query as Record<string, unknown>);
  if (challenge === null) throw forbidden('WhatsApp verification failed', 'whatsapp_verify_failed');
  res.type('text/plain').send(challenge);
});

/**
 * WhatsApp inbound webhook. `X-Hub-Signature-256` is checked over the raw request bytes (`req.rawBody`, captured by the
 * JSON parser in app.ts) with the app secret before anything is processed; a channel that is switched off still
 * answers 200 so Meta does not retry, but ignores the payload. Replies are sent asynchronously through the Cloud API
 * (or the outbox when no access token is configured) and Meta receives a small acknowledgement.
 */
channelsRouter.post(
  '/whatsapp',
  limit,
  wrap(async (req, res) => {
    const s = getWhatsAppSettings();
    if (!s.enabled) return res.json({ enabled: false, received: 0, handled: [], duplicates: 0 });
    const raw: Buffer | string | undefined = (req as any).rawBody ?? (req.body ? JSON.stringify(req.body) : undefined);
    if (!verifySignature(raw, req.headers['x-hub-signature-256'] as string | undefined, s.appSecret)) throw forbidden('Invalid WhatsApp signature', 'whatsapp_signature');
    const result = await whatsappInbound(req.body);
    res.json({
      enabled: true,
      received: result.received,
      duplicates: result.duplicates,
      handled: result.handled.map((h) => ({ from: h.from, kind: h.kind, replyType: h.reply.type, replyId: h.reply.id, via: h.reply.via })),
    });
  }),
);
