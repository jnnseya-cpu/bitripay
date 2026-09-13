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
export type QrType = 'u' | 'pr' | 'm' | 'ag' | 'pi' | 'bq';

export interface QrPayload {
  type: QrType;
  id: string;
  amount?: string;
  currency?: string;
  note?: string;
  /** BitriQR (EMVCo) payloads carry the merchant id and, when dynamic, the intent reference. */
  merchantId?: string;
  intentRef?: string | null;
  raw?: string;
}

/**
 * Lightweight BitriQR (EMVCo TLV) reader for the apps: enough to recognise a BitriPay merchant QR and hand the
 * payload to the server resolver, which verifies the signature. Full codec lives in @bitripay/bitriqr.
 */
export function parseBitriQrLite(content: string): QrPayload | null {
  const s = content.trim();
  if (!s.startsWith('000201') || !s.includes('cd.bitripay')) return null;
  const read = (str: string) => {
    const out: Record<string, string> = {};
    let i = 0;
    while (i + 4 <= str.length) {
      const tag = str.slice(i, i + 2);
      const len = Number(str.slice(i + 2, i + 4));
      if (Number.isNaN(len)) return out;
      out[tag] = str.slice(i + 4, i + 4 + len);
      i += 4 + len;
    }
    return out;
  };
  const top = read(s.slice(0, Math.max(0, s.lastIndexOf('6304'))));
  const mai = top['26'] ? read(top['26']) : {};
  if (mai['00'] !== 'cd.bitripay') return null;
  const numeric: Record<string, string> = {
    '976': 'CDF',
    '840': 'USD',
    '978': 'EUR',
    '826': 'GBP',
    '404': 'KES',
    '566': 'NGN',
    '800': 'UGX',
    '952': 'XOF',
    '950': 'XAF',
    '710': 'ZAR',
    '834': 'TZS',
    '646': 'RWF',
    '936': 'GHS',
  };
  return {
    type: mai['03'] ? 'pi' : 'bq',
    id: mai['03'] ?? mai['01'] ?? '',
    merchantId: mai['01'],
    intentRef: mai['03'] ?? null,
    amount: top['54'],
    currency: numeric[top['53'] ?? ''] ?? top['53'],
    note: top['59'],
    raw: s,
  };
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
  const emv = parseBitriQrLite(text);
  if (emv) return emv;
  const pi = text.match(/^bitripay:\/\/pay\/([A-Za-z0-9_.-]+)/);
  if (pi) return { type: 'pi', id: pi[1], intentRef: pi[1], raw: text };
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
        const m = url.pathname.match(/\/(pay|checkout|u|agent)\/([A-Za-z0-9_-]+)\/?$/);
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
