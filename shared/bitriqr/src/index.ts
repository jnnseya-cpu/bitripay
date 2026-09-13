/**
 * BitriQR — the BitriPay QR standard.
 *
 * EMVCo Merchant-Presented Mode TLV (any EMVCo scanner parses the base payload) with a signed proprietary
 * extension in template 80. Signature: ed25519 over the serialised tags 00–62 plus 80.00–80.04. CRC-16/CCITT-FALSE
 * over the whole payload including "6304". This package is dependency-free; signing and verification take
 * functions so the server can use Node's crypto and a client can use any ed25519 implementation.
 *
 *   00 payload format "01"            01 point of initiation "11" static · "12" dynamic
 *   26 merchant account information   00 GUI "cd.bitripay" · 01 merchant id · 02 rails mask (hex) · 03 intent ref
 *   52 MCC · 53 currency (numeric) · 54 amount (dynamic) · 58 country · 59 merchant name · 60 city
 *   62 additional data                01 bill/invoice ref · 05 reference label · 08 purpose code
 *   80 BitriQR extension              00 version · 01 key id · 02 expiry (unix, base36) · 03 offline nonce (b64)
 *                                     · 04 corridor flag ("DD" diaspora-direct)
 *   81 BitriQR signature              00 ed25519 signature (b64) over tags 00–62 + the content of 80
 *                                     (EMVCo lengths are two digits, so the 88-character signature gets its own template)
 *   63 CRC
 */

export const GUI = 'cd.bitripay';
export const VERSION = '01';

/** Rails a merchant QR accepts, as a bitmask carried in 26.02. */
export const RAILS = { wallet: 1 << 0, mpesa: 1 << 1, airtel: 1 << 2, orange: 1 << 3, card: 1 << 4, bank: 1 << 5, bitcoin: 1 << 6, diaspora: 1 << 7 } as const;
export type Rail = keyof typeof RAILS;
export function railsToMask(rails: Rail[]): number {
  return rails.reduce((m, r) => m | RAILS[r], 0);
}
export function maskToRails(mask: number): Rail[] {
  return (Object.keys(RAILS) as Rail[]).filter((r) => (mask & RAILS[r]) !== 0);
}

/** ISO 4217 numeric codes for the currencies BitriPay handles today; others pass through as given. */
export const CURRENCY_NUMERIC: Record<string, string> = {
  CDF: '976',
  USD: '840',
  EUR: '978',
  GBP: '826',
  KES: '404',
  NGN: '566',
  UGX: '800',
  XOF: '952',
  XAF: '950',
  ZAR: '710',
  TZS: '834',
  RWF: '646',
  GHS: '936',
};
export const NUMERIC_CURRENCY: Record<string, string> = Object.fromEntries(Object.entries(CURRENCY_NUMERIC).map(([a, n]) => [n, a]));

export interface BitriQrFields {
  /** static: payer enters the amount; dynamic: per-transaction with amount and expiry. */
  mode: 'static' | 'dynamic';
  merchantId: string;
  rails: Rail[];
  /** Server-side payment intent reference for dynamic codes (26.03). */
  intentRef?: string | null;
  mcc?: string | null;
  currency: string;
  /** Major-unit decimal string ("25000" or "12.50"); required when dynamic. */
  amount?: string | null;
  country: string;
  merchantName: string;
  city?: string | null;
  billRef?: string | null;
  referenceLabel?: string | null;
  purposeCode?: string | null;
  /** Extension */
  keyId?: string | null;
  expiresAt?: number | null;
  offlineNonce?: string | null;
  corridorFlag?: string | null;
}

export interface DecodedBitriQr extends BitriQrFields {
  version: string | null;
  signature: string | null;
  crc: string;
  crcValid: boolean;
  signed: boolean;
  /** The bytes the signature covers, for verification. */
  signedPayload: string;
  raw: Record<string, string | Record<string, string>>;
}

const tlv = (tag: string, value: string) => {
  if (value.length > 99) throw new Error(`Value for tag ${tag} exceeds 99 characters`);
  return `${tag}${String(value.length).padStart(2, '0')}${value}`;
};
const template = (tag: string, fields: [string, string | null | undefined][]) =>
  tlv(
    tag,
    fields
      .filter(([, v]) => v != null && v !== '')
      .map(([t, v]) => tlv(t, String(v)))
      .join(''),
  );

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) as used by EMVCo, over the UTF-8 bytes. */
export function crc16(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function normaliseAmount(a: string): string {
  const s = String(a).trim().replace(',', '.');
  if (!/^\d+(\.\d{1,8})?$/.test(s)) throw new Error('Amount must be a decimal string in major units');
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** Serialise the base (unsigned) part: tags 00–62 plus 80.00–80.04. This is what gets signed. */
export function serialiseUnsigned(f: BitriQrFields): { base: string; ext: string } {
  if (f.mode === 'dynamic' && !f.amount) throw new Error('Dynamic QR needs an amount');
  if (f.mode === 'dynamic' && !f.expiresAt) throw new Error('Dynamic QR needs an expiry');
  const currencyNum = CURRENCY_NUMERIC[f.currency.toUpperCase()] ?? f.currency;
  const base =
    tlv('00', '01') +
    tlv('01', f.mode === 'static' ? '11' : '12') +
    template('26', [
      ['00', GUI],
      ['01', f.merchantId],
      ['02', railsToMask(f.rails).toString(16).toUpperCase().padStart(2, '0')],
      ['03', f.intentRef],
    ]) +
    (f.mcc ? tlv('52', f.mcc) : '') +
    tlv('53', currencyNum) +
    (f.mode === 'dynamic' && f.amount ? tlv('54', normaliseAmount(f.amount)) : '') +
    tlv('58', f.country.toUpperCase()) +
    tlv('59', f.merchantName.slice(0, 25)) +
    (f.city ? tlv('60', f.city.slice(0, 15)) : '') +
    (f.billRef || f.referenceLabel || f.purposeCode
      ? template('62', [
          ['01', f.billRef],
          ['05', f.referenceLabel],
          ['08', f.purposeCode],
        ])
      : '');
  const ext = [
    tlv('00', VERSION),
    f.keyId ? tlv('01', f.keyId) : '',
    f.expiresAt ? tlv('02', Math.floor(f.expiresAt).toString(36)) : '',
    f.offlineNonce ? tlv('03', f.offlineNonce) : '',
    f.corridorFlag ? tlv('04', f.corridorFlag) : '',
  ].join('');
  return { base, ext };
}

/** Encode without a signature (basic trust) — recommended only for static codes. */
export function encodeUnsigned(f: BitriQrFields): string {
  const { base, ext } = serialiseUnsigned(f);
  const body = `${base}${tlv('80', ext)}6304`;
  return `${body}${crc16(body)}`;
}

/** Encode and sign: `sign(payloadUtf8)` returns the raw 64-byte ed25519 signature. */
export function encodeSigned(f: BitriQrFields, sign: (payload: string) => Uint8Array | Promise<Uint8Array>): string | Promise<string> {
  if (!f.keyId) throw new Error('A signed QR needs a keyId');
  const { base, ext } = serialiseUnsigned(f);
  const signedPayload = base + ext;
  const finish = (sig: Uint8Array) => {
    const body = `${base}${tlv('80', ext)}${tlv('81', tlv('00', toBase64(sig)))}6304`;
    return `${body}${crc16(body)}`;
  };
  const r = sign(signedPayload);
  return r instanceof Promise ? r.then(finish) : finish(r);
}

function readTlv(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i + 4 <= s.length) {
    const tag = s.slice(i, i + 2);
    const len = Number(s.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(tag) || Number.isNaN(len)) throw new Error(`Malformed TLV at ${i}`);
    out[tag] = s.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  if (i !== s.length) throw new Error('Trailing bytes in TLV');
  return out;
}

export function isBitriQr(content: string): boolean {
  return /^000201/.test(content.trim()) && content.includes(GUI);
}

/** Parse a payload. Never throws on a bad signature: `signed`/`crcValid` and the caller's verify decide trust. */
export function decode(content: string): DecodedBitriQr {
  const s = content.trim();
  if (!s.startsWith('000201')) throw new Error('Not an EMVCo payload');
  const crcIdx = s.lastIndexOf('6304');
  if (crcIdx < 0 || crcIdx + 8 !== s.length) throw new Error('Missing CRC');
  const crc = s.slice(crcIdx + 4);
  const crcValid = crc16(s.slice(0, crcIdx + 4)).toUpperCase() === crc.toUpperCase();
  const top = readTlv(s.slice(0, crcIdx));
  const mai = top['26'] ? readTlv(top['26']) : {};
  if (mai['00'] !== GUI) throw new Error('Not a BitriQR payload');
  const add = top['62'] ? readTlv(top['62']) : {};
  const ext = top['80'] ? readTlv(top['80']) : {};
  const sigT = top['81'] ? readTlv(top['81']) : {};
  const extContent = top['80'] ?? '';
  // the signed bytes: everything before template 80, plus the content of 80
  const marker = '80' + String(extContent.length).padStart(2, '0') + extContent;
  const baseEnd = top['80'] != null ? s.indexOf(marker) : -1;
  const base = baseEnd > 0 ? s.slice(0, baseEnd) : s.slice(0, crcIdx);
  return {
    mode: top['01'] === '12' ? 'dynamic' : 'static',
    merchantId: mai['01'] ?? '',
    rails: maskToRails(parseInt(mai['02'] ?? '0', 16) || 0),
    intentRef: mai['03'] ?? null,
    mcc: top['52'] ?? null,
    currency: NUMERIC_CURRENCY[top['53'] ?? ''] ?? top['53'] ?? '',
    amount: top['54'] ?? null,
    country: top['58'] ?? '',
    merchantName: top['59'] ?? '',
    city: top['60'] ?? null,
    billRef: add['01'] ?? null,
    referenceLabel: add['05'] ?? null,
    purposeCode: add['08'] ?? null,
    keyId: ext['01'] ?? null,
    expiresAt: ext['02'] ? parseInt(ext['02'], 36) : null,
    offlineNonce: ext['03'] ?? null,
    corridorFlag: ext['04'] ?? null,
    version: ext['00'] ?? null,
    signature: sigT['00'] ?? null,
    crc,
    crcValid,
    signed: !!sigT['00'],
    signedPayload: base + extContent,
    raw: { ...top, '26': mai, '62': add, '80': ext, '81': sigT },
  };
}

export interface VerifyResult {
  valid: boolean;
  trust: 'verified' | 'basic' | 'invalid';
  reasons: string[];
}
/** Verify CRC, expiry and (when present) the signature via `verify(payload, signature)`; `now` in unix seconds. */
export async function verify(d: DecodedBitriQr, verifySig: (payload: string, signature: Uint8Array) => boolean | Promise<boolean>, now = Math.floor(Date.now() / 1000)): Promise<VerifyResult> {
  const reasons: string[] = [];
  if (!d.crcValid) reasons.push('crc_mismatch');
  if (d.expiresAt && d.expiresAt < now) reasons.push('expired');
  if (d.mode === 'dynamic' && !d.signed) reasons.push('dynamic_unsigned');
  if (d.offlineNonce && !d.signed) reasons.push('offline_unsigned');
  if (d.signed) {
    if (!d.keyId) reasons.push('missing_key_id');
    else {
      const ok = await verifySig(d.signedPayload, fromBase64(d.signature!));
      if (!ok) reasons.push('bad_signature');
    }
  }
  if (reasons.length) return { valid: false, trust: 'invalid', reasons };
  return { valid: true, trust: d.signed ? 'verified' : 'basic', reasons: [] };
}

/** The short URI a dynamic QR may also carry for camera apps: bitripay://pay/<intent>. */
export const URI_SCHEME = 'bitripay://pay/';
export function intentUri(intentRef: string): string {
  return `${URI_SCHEME}${intentRef}`;
}
export function parseIntentUri(content: string): string | null {
  const m = content.trim().match(/^bitripay:\/\/pay\/([A-Za-z0-9_.-]+)/);
  return m ? m[1] : null;
}

export function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function fromBase64(s: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
