/**
 * WhatsApp channel on the Meta Cloud API. Inbound messages arrive on the webhook (`GET /api/whatsapp` for the
 * verification handshake, `POST /api/whatsapp` signed with `X-Hub-Signature-256`) and run through the same command
 * grammar as SMS (`BAL <PIN>`, `SEND …`, `PAY …`, `CASH …`, `STMT`, `CODE`, `REG`, `HELP`) via `smsHandle`. A message
 * that carries a BitriPay payment link, checkout URL or link code gets an interactive **pay card** (`cta_url` with the
 * amount, the merchant and a "Pay" button to the hosted checkout) instead of the text handler. Replies go out through
 * the Cloud API `messages` endpoint when an access token is configured; in tests, and whenever the channel is not
 * fully configured, they are recorded in an in-memory outbox so operators (and tests) can inspect exactly what would
 * have been sent. `sendWhatsApp` and `sendWhatsAppTemplate` are exported so notifications can use the channel.
 */
import { getDb } from '../../db';
import { config } from '../../config';
import { uuid, now } from '../../lib/ids';
import { encrypt, decrypt, hmacSha256, safeEqual } from '../../lib/crypto';
import { getSetting, setSetting } from '../settings';
import { findUserById, findUserByPhone, normalizePhone } from '../users';
import { getPaymentRequestByCode, toPaymentRequest } from '../paymentRequests';
import { getCheckoutSession } from '../gateway';
import { getQr } from '../qrcodes';
import { formatMinor } from '../currencies';
import { smsHandle } from './sms';

export interface WhatsAppSettings {
  /** Master switch: when off the webhook acknowledges Meta (200) but ignores every message. */
  enabled: boolean;
  /** Token Meta echoes during the `hub.mode=subscribe` verification handshake. */
  verifyToken: string;
  /** Meta app secret: `X-Hub-Signature-256` is HMAC-SHA256 over the raw body with it. Stored encrypted. */
  appSecret: string;
  /** System-user access token for the Cloud API. Stored encrypted; masked when read. */
  accessToken: string;
  /** The WhatsApp Business phone number id that sends replies. */
  phoneNumberId: string;
  /** Graph API version and host (kept editable for future Meta releases and test doubles). */
  apiVersion: string;
  graphUrl: string;
  /** Label of the pay-card button and the footer line under the card. */
  payButtonText: string;
  footer: string;
}

export const DEFAULT_WHATSAPP: WhatsAppSettings = {
  enabled: true,
  verifyToken: '',
  appSecret: '',
  accessToken: '',
  phoneNumberId: '',
  apiVersion: 'v20.0',
  graphUrl: 'https://graph.facebook.com',
  payButtonText: 'Pay',
  footer: 'Secured by BitriPay',
};

/** Fields kept encrypted at rest and masked on read. */
export const WHATSAPP_SECRET_FIELDS = ['appSecret', 'accessToken'] as const;
export const MASK = '••••••••';

/** Encrypted values are `iv.tag.data` (base64url); anything else is treated as a legacy plain value. */
function unseal(value: string): string {
  if (!value) return '';
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(value)) {
    try {
      return decrypt(value);
    } catch {
      return value;
    }
  }
  return value;
}

/** Settings with secrets decrypted, ready for use by the webhook and the sender. */
export function getWhatsAppSettings(): WhatsAppSettings {
  const stored = getSetting<Partial<WhatsAppSettings>>('whatsapp', {});
  const merged: WhatsAppSettings = { ...DEFAULT_WHATSAPP, ...stored };
  for (const f of WHATSAPP_SECRET_FIELDS) merged[f] = unseal(String(merged[f] ?? ''));
  return merged;
}

/** Settings safe to show an administrator: secrets replaced by the mask when set. */
export function maskWhatsAppSettings(s: WhatsAppSettings): WhatsAppSettings {
  const out = { ...s };
  for (const f of WHATSAPP_SECRET_FIELDS) out[f] = s[f] ? MASK : '';
  return out;
}

/**
 * Apply an administrator's patch: unknown keys are dropped, secrets sent back as the mask (or omitted) keep their
 * current value, new secret values are encrypted before they are stored.
 */
export function setWhatsAppSettings(patch: Partial<WhatsAppSettings>): WhatsAppSettings {
  const current = getWhatsAppSettings();
  const next: WhatsAppSettings = { ...current };
  for (const key of Object.keys(DEFAULT_WHATSAPP) as (keyof WhatsAppSettings)[]) {
    if (!(key in patch) || patch[key] === undefined) continue;
    const given = patch[key];
    if (key === 'enabled') next.enabled = Boolean(given);
    else if ((WHATSAPP_SECRET_FIELDS as readonly string[]).includes(key)) {
      if (given !== MASK) next[key as (typeof WHATSAPP_SECRET_FIELDS)[number]] = String(given ?? '');
    } else (next as any)[key] = String(given ?? '').trim();
  }
  next.apiVersion = next.apiVersion || DEFAULT_WHATSAPP.apiVersion;
  next.graphUrl = (next.graphUrl || DEFAULT_WHATSAPP.graphUrl).replace(/\/+$/, '');
  const stored: Record<string, unknown> = { ...next };
  for (const f of WHATSAPP_SECRET_FIELDS) stored[f] = next[f] ? encrypt(next[f]) : '';
  setSetting('whatsapp', stored);
  return next;
}

// ---------------------------------------------------------------------------------------------------------------------
// Webhook security
// ---------------------------------------------------------------------------------------------------------------------

/** `hub.mode=subscribe` + matching `hub.verify_token` → the challenge to echo; otherwise null. */
export function verifyHandshake(query: Record<string, unknown>, settings = getWhatsAppSettings()): string | null {
  const mode = String(query['hub.mode'] ?? '');
  const token = String(query['hub.verify_token'] ?? '');
  const challenge = query['hub.challenge'];
  if (!settings.enabled || mode !== 'subscribe' || !settings.verifyToken || !safeEqual(token, settings.verifyToken) || challenge === undefined) return null;
  return String(challenge);
}

/**
 * `X-Hub-Signature-256: sha256=<hex>` over the exact request bytes with the app secret. The app keeps `req.rawBody`
 * for every JSON request, so the HMAC is computed over the bytes Meta signed, not a re-serialisation.
 */
export function verifySignature(rawBody: Buffer | string | undefined, header: string | undefined, appSecret: string): boolean {
  if (!appSecret) return false;
  if (!header || !rawBody) return false;
  const [scheme, given] = header.trim().split('=');
  if (scheme !== 'sha256' || !given) return false;
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  return safeEqual(given.toLowerCase(), hmacSha256(appSecret, body));
}

// ---------------------------------------------------------------------------------------------------------------------
// Outbound: text, interactive pay cards and templates through the Cloud API (or the outbox)
// ---------------------------------------------------------------------------------------------------------------------

export type WhatsAppPayload =
  | { messaging_product: 'whatsapp'; recipient_type?: 'individual'; to: string; type: 'text'; text: { body: string; preview_url?: boolean } }
  | { messaging_product: 'whatsapp'; recipient_type?: 'individual'; to: string; type: 'interactive'; interactive: PayCard }
  | { messaging_product: 'whatsapp'; recipient_type?: 'individual'; to: string; type: 'template'; template: { name: string; language: { code: string }; components?: unknown[] } };

export interface PayCard {
  type: 'cta_url';
  header?: { type: 'text'; text: string };
  body: { text: string };
  footer?: { text: string };
  action: { name: 'cta_url'; parameters: { display_text: string; url: string } };
}

export interface WhatsAppOutboxEntry {
  id: string;
  to: string;
  type: WhatsAppPayload['type'];
  /** Plain text for text messages, the card body for interactive ones, the template name for templates. */
  summary: string;
  payload: WhatsAppPayload;
  delivered: boolean;
  via: 'outbox' | 'meta' | 'meta_error';
  messageId: string | null;
  at: string;
}

/** Last 200 outbound messages, newest last. Everything is recorded here, delivered or not. */
export const whatsappOutbox: WhatsAppOutboxEntry[] = [];

/** Meta wants E.164 digits without the plus sign. */
export function toWaId(phone: string): string {
  return (normalizePhone(phone) ?? phone).replace(/[^0-9]/g, '');
}
/** Inbound `from` is digits only; the platform keys accounts by `+`-prefixed E.164. */
export function fromWaId(waId: string): string {
  const digits = String(waId).replace(/[^0-9]/g, '');
  return normalizePhone(`+${digits}`) ?? `+${digits}`;
}

function summarise(payload: WhatsAppPayload): string {
  if (payload.type === 'text') return payload.text.body;
  if (payload.type === 'interactive') return payload.interactive.body.text;
  return `template:${payload.template.name}`;
}

/** Deliver through the Cloud API when configured (never in tests); always record in the outbox and the channel log. */
export async function deliverWhatsApp(payload: WhatsAppPayload, userId: string | null = null): Promise<WhatsAppOutboxEntry> {
  const s = getWhatsAppSettings();
  const entry: WhatsAppOutboxEntry = {
    id: uuid(),
    to: payload.to,
    type: payload.type,
    summary: summarise(payload),
    payload,
    delivered: false,
    via: 'outbox',
    messageId: null,
    at: now(),
  };
  const configured = !!(s.accessToken && s.phoneNumberId);
  if (configured && !config.isTest) {
    try {
      const res = await fetch(`${s.graphUrl}/${s.apiVersion}/${s.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${s.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json: any = await res.json().catch(() => ({}));
      entry.delivered = res.ok;
      entry.via = res.ok ? 'meta' : 'meta_error';
      entry.messageId = json?.messages?.[0]?.id ?? null;
      if (!res.ok) console.error('[whatsapp] send failed', res.status, JSON.stringify(json).slice(0, 300));
    } catch (err) {
      entry.via = 'meta_error';
      console.error('[whatsapp] send failed', (err as Error).message);
    }
  } else if (!config.isTest) console.log(`[whatsapp → ${payload.to}] ${entry.summary}`);
  whatsappOutbox.push(entry);
  if (whatsappOutbox.length > 200) whatsappOutbox.shift();
  logMessage('out', `+${payload.to}`, entry.summary, userId);
  return entry;
}

/** Plain text message. Available to notifications: `sendWhatsApp(user.phone, 'You received …')`. */
export function sendWhatsApp(to: string, text: string, userId: string | null = null): Promise<WhatsAppOutboxEntry> {
  return deliverWhatsApp({ messaging_product: 'whatsapp', recipient_type: 'individual', to: toWaId(to), type: 'text', text: { body: text.slice(0, 4096), preview_url: false } }, userId);
}

/** Pre-approved template message (needed to start a conversation outside the 24-hour customer-service window). */
export function sendWhatsAppTemplate(to: string, templateName: string, lang = 'en', components: unknown[] = [], userId: string | null = null): Promise<WhatsAppOutboxEntry> {
  return deliverWhatsApp(
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toWaId(to),
      type: 'template',
      template: { name: templateName, language: { code: lang }, ...(components.length ? { components } : {}) },
    },
    userId,
  );
}

export function sendWhatsAppInteractive(to: string, interactive: PayCard, userId: string | null = null): Promise<WhatsAppOutboxEntry> {
  return deliverWhatsApp({ messaging_product: 'whatsapp', recipient_type: 'individual', to: toWaId(to), type: 'interactive', interactive }, userId);
}

// ---------------------------------------------------------------------------------------------------------------------
// WhatsApp checkout: payment links in a message become a pay card
// ---------------------------------------------------------------------------------------------------------------------

export interface PaymentReference {
  kind: 'checkout_session' | 'payment_request' | 'qr';
  code: string;
  /** The URL as written in the message when it was one, so the card keeps any `?cs=` session parameter. */
  url: string | null;
}

/**
 * Find the first BitriPay payment reference in a message: `…/pay/<code>[?cs=cs_…]`, `…/checkout/<code>`,
 * `…/q/<code>` (reusable link), a bare `cs_…` checkout-session id or a `bp_<code>` link code. Pure: no lookups.
 */
export function extractPaymentReference(text: string): PaymentReference | null {
  const urlMatch = /https?:\/\/[^\s<>"']+/gi;
  for (const m of text.match(urlMatch) ?? []) {
    let u: URL;
    try {
      u = new URL(m.replace(/[.,;:!?)]+$/, ''));
    } catch {
      continue;
    }
    const path = u.pathname.match(/\/(pay|checkout|q)\/([A-Za-z0-9_-]{4,40})\/?$/);
    if (!path) continue;
    const cs = u.searchParams.get('cs');
    if (cs && /^cs_[a-z0-9]+$/i.test(cs)) return { kind: 'checkout_session', code: cs, url: u.toString() };
    const code = path[2].replace(/^bp_/i, '');
    if (/^cs_/i.test(code)) return { kind: 'checkout_session', code, url: u.toString() };
    return { kind: path[1] === 'q' ? 'qr' : 'payment_request', code, url: u.toString() };
  }
  const bare = text.match(/(?:^|\s)(cs_[a-z0-9]{6,40}|bp_[A-Za-z0-9]{4,40})(?=$|\s|[.,;:!?)])/i);
  if (bare) {
    const token = bare[1];
    if (/^cs_/i.test(token)) return { kind: 'checkout_session', code: token, url: null };
    return { kind: 'payment_request', code: token.replace(/^bp_/i, ''), url: null };
  }
  return null;
}

export interface ResolvedPayment {
  url: string;
  amountMinor: number | null;
  currency: string;
  merchantName: string;
  description: string | null;
  status: string;
}

function merchantLabel(userId: string): string {
  const u = findUserById(userId);
  return u?.business_name || u?.full_name || 'BitriPay merchant';
}

/** Look the reference up: open checkout session, payment request (single-use link) or reusable QR link. Throws notFound when unknown. */
export function resolvePaymentReference(ref: PaymentReference): ResolvedPayment {
  if (ref.kind === 'checkout_session') {
    const s = getCheckoutSession(null, ref.code);
    return {
      url: s.url,
      amountMinor: s.amount.valueMinor,
      currency: s.amount.currency,
      merchantName: merchantLabel(s.paymentIntent.merchantId),
      description: s.paymentIntent.description,
      status: s.status,
    };
  }
  if (ref.kind === 'qr') {
    const q = getQr(ref.code);
    return { url: q.link, amountMinor: q.amount, currency: q.currency, merchantName: merchantLabel(q.merchantId), description: q.reference, status: q.status };
  }
  const row = getPaymentRequestByCode(ref.code);
  const pr = toPaymentRequest(row);
  return {
    url: ref.url && ref.url.startsWith(config.webUrl) ? ref.url : `${config.webUrl}/pay/${row.code}`,
    amountMinor: pr.amount,
    currency: pr.currency,
    merchantName: merchantLabel(row.requester_user_id),
    description: pr.description,
    status: pr.status,
  };
}

/** The interactive card: merchant as header, amount and description in the body, a single "Pay" button to the hosted checkout. */
export function buildPayCard(p: ResolvedPayment, settings = getWhatsAppSettings()): PayCard {
  const amount = p.amountMinor != null ? formatMinor(p.amountMinor, p.currency) : `any amount in ${p.currency}`;
  const closed = !['open', 'pending', 'active'].includes(p.status);
  const lines = [closed ? `This payment request is ${p.status}.` : `Pay ${amount} to ${p.merchantName}.`];
  if (p.description) lines.push(p.description.slice(0, 200));
  if (!closed) lines.push('Tap Pay to open the secure BitriPay checkout: wallet, mobile money, card or bank.');
  return {
    type: 'cta_url',
    header: { type: 'text', text: p.merchantName.slice(0, 60) },
    body: { text: lines.join('\n').slice(0, 1024) },
    footer: { text: settings.footer.slice(0, 60) },
    action: { name: 'cta_url', parameters: { display_text: (settings.payButtonText || 'Pay').slice(0, 20), url: p.url } },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Inbound processing
// ---------------------------------------------------------------------------------------------------------------------

export interface InboundMessage {
  id: string;
  from: string;
  text: string;
  type: string;
  timestamp: string | null;
  contactName: string | null;
}

/** Flatten a Cloud API webhook body into the messages we can act on (text, quick-reply buttons, interactive replies). */
export function parseInbound(body: any): InboundMessage[] {
  const out: InboundMessage[] = [];
  if (!body || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return out;
  for (const entry of body.entry) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      if (!value || change.field !== 'messages' || !Array.isArray(value.messages)) continue;
      const names = new Map<string, string>();
      for (const c of value.contacts ?? []) if (c?.wa_id) names.set(String(c.wa_id), String(c.profile?.name ?? ''));
      for (const m of value.messages) {
        if (!m?.from || !m?.id) continue;
        let text = '';
        if (m.type === 'text') text = String(m.text?.body ?? '');
        else if (m.type === 'button') text = String(m.button?.text ?? m.button?.payload ?? '');
        else if (m.type === 'interactive') text = String(m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? m.interactive?.button_reply?.id ?? '');
        else continue;
        out.push({ id: String(m.id), from: String(m.from), text, type: String(m.type), timestamp: m.timestamp ? String(m.timestamp) : null, contactName: names.get(String(m.from)) || null });
      }
    }
  }
  return out;
}

function logMessage(direction: 'in' | 'out', phone: string, body: string, userId: string | null) {
  getDb()
    .prepare('INSERT INTO channel_messages (id, channel, direction, phone, body, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(uuid(), 'whatsapp', direction, phone, body.slice(0, 500), userId, now());
}

/** Meta redelivers until it sees a 200; a message id seen recently is acknowledged without being processed twice. */
const seenMessageIds = new Set<string>();
function seenBefore(id: string): boolean {
  if (seenMessageIds.has(id)) return true;
  seenMessageIds.add(id);
  if (seenMessageIds.size > 2000) {
    const first = seenMessageIds.values().next().value;
    if (first !== undefined) seenMessageIds.delete(first);
  }
  return false;
}

export interface HandledMessage {
  from: string;
  text: string;
  kind: 'pay_card' | 'text';
  reply: WhatsAppOutboxEntry;
}

/**
 * One inbound message → one reply. A payment reference yields a pay card (or a text explaining why it cannot be
 * paid); everything else runs the SMS command grammar. Both legs are logged in `channel_messages`.
 */
export async function whatsappHandle(fromWa: string, text: string): Promise<HandledMessage> {
  const phone = fromWaId(fromWa);
  const user = findUserByPhone(phone);
  logMessage('in', phone, text, user?.id ?? null);
  const ref = extractPaymentReference(text);
  if (ref) {
    try {
      const card = buildPayCard(resolvePaymentReference(ref));
      return { from: phone, text, kind: 'pay_card', reply: await sendWhatsAppInteractive(phone, card, user?.id ?? null) };
    } catch {
      return { from: phone, text, kind: 'text', reply: await sendWhatsApp(phone, 'That BitriPay payment link was not found or has expired. Ask the merchant for a new one.', user?.id ?? null) };
    }
  }
  const reply = smsHandle(phone, text.trim() ? text : 'HELP');
  return { from: phone, text, kind: 'text', reply: await sendWhatsApp(phone, reply, user?.id ?? null) };
}

/** Process a whole webhook body; returns what was handled so the route can acknowledge Meta. */
export async function whatsappInbound(body: unknown): Promise<{ received: number; handled: HandledMessage[]; duplicates: number }> {
  const messages = parseInbound(body);
  const handled: HandledMessage[] = [];
  let duplicates = 0;
  for (const m of messages) {
    if (seenBefore(m.id)) {
      duplicates += 1;
      continue;
    }
    handled.push(await whatsappHandle(m.from, m.text));
  }
  return { received: messages.length, handled, duplicates };
}

/** The channel log (both directions), newest first — the WhatsApp counterpart of `recentSms`. */
export function recentWhatsApp(limit = 40) {
  return (getDb().prepare("SELECT * FROM channel_messages WHERE channel = 'whatsapp' ORDER BY created_at DESC LIMIT ?").all(limit) as any[]).map((r) => ({
    id: r.id,
    direction: r.direction,
    phone: r.phone,
    body: r.body,
    userId: r.user_id,
    createdAt: r.created_at,
  }));
}

/** Outbound payloads exactly as (or as they would be) sent to Meta, newest first. */
export function recentWhatsAppOutbox(limit = 20): WhatsAppOutboxEntry[] {
  return [...whatsappOutbox].reverse().slice(0, limit);
}
