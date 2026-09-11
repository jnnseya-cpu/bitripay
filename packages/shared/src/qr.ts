/**
 * BitriPay QR payload codec.
 *
 * A QR code can hold either the native URI scheme (`bitripay://pay?...`) or an
 * https link to the web app (`https://app.example.com/q?...`). Both encode the
 * same query parameters so any camera app can open the payment page while the
 * mobile/web apps decode the payload directly.
 *
 *   t   type: "u" (user / static receive QR), "pr" (payment request / dynamic QR),
 *              "m" (merchant static QR), "ag" (agent QR for cash in/out)
 *   id  user tag, merchant tag, agent tag or payment request code
 *   a   optional amount as decimal string
 *   c   optional currency code
 *   n   optional note / description
 */
export type QrType = 'u' | 'pr' | 'm' | 'ag';

export interface QrPayload {
  type: QrType;
  id: string;
  amount?: string;
  currency?: string;
  note?: string;
}

export const QR_SCHEME = 'bitripay://pay';

function buildQuery(payload: QrPayload): string {
  const params = new URLSearchParams();
  params.set('v', '1');
  params.set('t', payload.type);
  params.set('id', payload.id);
  if (payload.amount) params.set('a', payload.amount);
  if (payload.currency) params.set('c', payload.currency);
  if (payload.note) params.set('n', payload.note.slice(0, 120));
  return params.toString();
}

/** Encode a payload as the native scheme. */
export function encodeQr(payload: QrPayload): string {
  return `${QR_SCHEME}?${buildQuery(payload)}`;
}

/** Encode a payload as a web link that resolves to the same payment page. */
export function encodeQrLink(payload: QrPayload, webBaseUrl: string): string {
  const base = webBaseUrl.replace(/\/+$/, '');
  return `${base}/q?${buildQuery(payload)}`;
}

/** Decode any supported QR content; returns null if it isn't a BitriPay QR. */
export function decodeQr(content: string): QrPayload | null {
  if (!content) return null;
  const text = content.trim();
  let query: string | null = null;

  if (text.toLowerCase().startsWith(QR_SCHEME)) {
    const idx = text.indexOf('?');
    query = idx >= 0 ? text.slice(idx + 1) : '';
  } else if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      if (url.pathname === '/q' || url.pathname.endsWith('/q')) {
        query = url.search.slice(1);
      } else {
        // Accept hosted checkout / profile links: /pay/<code>, /checkout/<code>, /u/<tag>
        const m = url.pathname.match(/\/(pay|checkout|u|agent)\/([A-Za-z0-9_\-]+)\/?$/);
        if (m) {
          const type: QrType = m[1] === 'u' ? 'u' : m[1] === 'agent' ? 'ag' : 'pr';
          const payload: QrPayload = { type, id: m[2] };
          const a = url.searchParams.get('a');
          const c = url.searchParams.get('c');
          const n = url.searchParams.get('n');
          if (a) payload.amount = a;
          if (c) payload.currency = c;
          if (n) payload.note = n;
          return payload;
        }
        return null;
      }
    } catch {
      return null;
    }
  } else if (/^@[a-z0-9_]{3,30}$/i.test(text)) {
    return { type: 'u', id: text.slice(1).toLowerCase() };
  } else {
    return null;
  }

  const params = new URLSearchParams(query);
  const t = params.get('t') as QrType | null;
  const id = params.get('id');
  if (!t || !id || !['u', 'pr', 'm', 'ag'].includes(t)) return null;
  const payload: QrPayload = { type: t, id };
  const a = params.get('a');
  const c = params.get('c');
  const n = params.get('n');
  if (a && /^\d+(\.\d+)?$/.test(a)) payload.amount = a;
  if (c && /^[A-Z]{3}$/.test(c)) payload.currency = c;
  if (n) payload.note = n;
  return payload;
}
