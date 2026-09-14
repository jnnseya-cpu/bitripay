/**
 * Offline-signed QR payments on the phone (the same protocol as the web and the API): an Ed25519 device subkey
 * generated on the device and kept in the secure store, a monotonic counter, prefetched merchant nonces, a queue of
 * signed promises in local storage, and an in-order sync when the network is back. Nothing here needs the server
 * to sign a payment; the server validates every promise (double spend, replay, ceilings) when it syncs.
 *
 * The queue is encrypted at rest (XSalsa20-Poly1305 with a key that lives in the secure store) so a copied phone
 * backup never exposes who paid whom. Every queued item carries its specification §28 lifecycle state and reads
 * "Pending confirmation" until the platform confirms it online.
 */
import nacl from 'tweetnacl';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as bitriqr from '@bitripay/bitriqr';
import { api } from './api';
import { sha256Hex, utf8, fromUtf8 } from './sha256';

nacl.setPRNG((x, n) => {
  x.set(Crypto.getRandomBytes(n));
});

const KEY_SECRET = 'bitripay.offline.secret';
const KEY_DEVICE = 'bitripay.offline.device';
const KEY_COUNTER = 'bitripay.offline.counter';
const KEY_NONCES = 'bitripay.offline.nonces';
const KEY_QUEUE = 'bitripay.offline.queue';
const KEY_LASTSYNC = 'bitripay.offline.lastSync';
const KEY_QUEUE_KEY = 'bitripay.offline.queueKey';

export const OFFLINE_STATES = ['OFFLINE_CREATED', 'OFFLINE_ACCEPTED_LOCALLY', 'SYNC_PENDING', 'ONLINE_VALIDATING', 'CONFIRMED', 'REJECTED'] as const;
export type OfflineState = (typeof OFFLINE_STATES)[number];
export const PENDING_CONFIRMATION_TEXT = 'Pending confirmation — this payment is final only once BitriPay confirms it online.';

const b64 = (u: Uint8Array) => {
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return (globalThis as any).btoa(s) as string;
};
const fromB64 = (s: string) => {
  const bin = (globalThis as any).atob(s) as string;
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
};
/** SubjectPublicKeyInfo wrapper for a raw Ed25519 public key (what the API registers). */
const SPKI_PREFIX = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
const spki = (pub: Uint8Array) => {
  const out = new Uint8Array(SPKI_PREFIX.length + pub.length);
  out.set(SPKI_PREFIX);
  out.set(pub, SPKI_PREFIX.length);
  return out;
};

export interface DeviceRecord {
  deviceId: string;
  keyId: string;
  keyNotAfter: string;
  publicKey: string;
  userId: string;
}
export interface QueuedPromise {
  hash: string;
  body: Record<string, unknown>;
  amountMinor: number;
  currency: string;
  merchantName: string;
  queuedAt: string;
  /** §28 lifecycle: OFFLINE_ACCEPTED_LOCALLY once signed on this phone, SYNC_PENDING while waiting for the network. */
  state: OfflineState;
  /** What the local receipt says until the platform confirms. */
  receiptText: string;
}
export interface SyncResultItem {
  hash: string;
  state: 'SETTLED' | 'REJECTED' | 'DUPLICATE';
  lifecycle: OfflineState;
  reason?: string | null;
  transactionId?: string | null;
  restoreMinor?: number;
  counterGap?: { expected: number; received: number } | null;
  receipt?: { transactionId: string; signature: string; keyId: string } | null;
}
export interface OfflineQr {
  payload: string;
  nonce: string;
  expiresAt: string;
  keyId: string;
}

async function getJson<T>(key: string): Promise<T | null> {
  const v = await AsyncStorage.getItem(key);
  return v ? (JSON.parse(v) as T) : null;
}
async function setJson(key: string, value: unknown): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(value));
}
/** Symmetric key for the queue, created once and kept in the secure store (never in AsyncStorage). */
async function queueKey(): Promise<Uint8Array> {
  const existing = await SecureStore.getItemAsync(KEY_QUEUE_KEY);
  if (existing) return fromB64(existing);
  const k = Crypto.getRandomBytes(nacl.secretbox.keyLength);
  await SecureStore.setItemAsync(KEY_QUEUE_KEY, b64(k));
  return k;
}
const ENC_PREFIX = 'enc1:';
async function readQueue(): Promise<QueuedPromise[]> {
  const raw = await AsyncStorage.getItem(KEY_QUEUE);
  if (!raw) return [];
  if (!raw.startsWith(ENC_PREFIX)) {
    // queue written before encryption: migrate it in place
    const legacy = JSON.parse(raw) as QueuedPromise[];
    await writeQueue(legacy);
    return legacy.map(withState);
  }
  const [nonceB64, boxB64] = raw.slice(ENC_PREFIX.length).split('.');
  const opened = nacl.secretbox.open(fromB64(boxB64), fromB64(nonceB64), await queueKey());
  if (!opened) throw new Error('The offline queue on this phone cannot be read (wrong key)');
  return (JSON.parse(fromUtf8(opened)) as QueuedPromise[]).map(withState);
}
async function writeQueue(items: QueuedPromise[]): Promise<void> {
  const nonce = Crypto.getRandomBytes(nacl.secretbox.nonceLength);
  const box = nacl.secretbox(utf8(JSON.stringify(items)), nonce, await queueKey());
  await AsyncStorage.setItem(KEY_QUEUE, `${ENC_PREFIX}${b64(nonce)}.${b64(box)}`);
}
const withState = (q: QueuedPromise): QueuedPromise => ({ ...q, state: q.state ?? 'SYNC_PENDING', receiptText: q.receiptText ?? PENDING_CONFIRMATION_TEXT });
const nowIso = () => new Date().toISOString();

export const offlineDevice = {
  async status() {
    const rec = await getJson<DeviceRecord>(KEY_DEVICE);
    const nonces = ((await getJson<{ nonce: string; expiresAt: string }[]>(KEY_NONCES)) ?? []).filter((n) => n.expiresAt > nowIso());
    const queue = await readQueue();
    return {
      deviceId: rec?.deviceId ?? null,
      keyId: rec?.keyId ?? null,
      keyNotAfter: rec?.keyNotAfter ?? null,
      nonces: nonces.length,
      queued: queue.length,
      lastSync: await AsyncStorage.getItem(KEY_LASTSYNC),
    };
  },
  /** Generate the subkey on the phone, register its public half while online, keep the secret half in the secure store. */
  async provision(label: string): Promise<DeviceRecord> {
    const pair = nacl.sign.keyPair();
    const existing = await getJson<DeviceRecord>(KEY_DEVICE);
    const deviceId = existing?.deviceId ?? `phone-${b64(Crypto.getRandomBytes(9)).replace(/[+/=]/g, '').slice(0, 12)}`;
    const me = await api.get<{ user: { id: string } }>('/api/auth/me');
    const publicKey = b64(spki(pair.publicKey));
    const reg = await api.post<{ deviceId: string; keyId: string; keyNotAfter: string }>('/api/v1/offline/devices', { deviceId, publicKey, label });
    const rec: DeviceRecord = { deviceId: reg.deviceId, keyId: reg.keyId, keyNotAfter: reg.keyNotAfter, publicKey, userId: me.user.id };
    await SecureStore.setItemAsync(KEY_SECRET, b64(pair.secretKey));
    await setJson(KEY_DEVICE, rec);
    if (!(await AsyncStorage.getItem(KEY_COUNTER))) await AsyncStorage.setItem(KEY_COUNTER, '0');
    return rec;
  },
  async record(): Promise<DeviceRecord | null> {
    return getJson<DeviceRecord>(KEY_DEVICE);
  },
  async sign(payload: string): Promise<string> {
    const secret = await SecureStore.getItemAsync(KEY_SECRET);
    if (!secret) throw new Error('Set this phone up for offline payments first');
    return b64(nacl.sign.detached(utf8(payload), fromB64(secret)));
  },
  async nextCounter(): Promise<number> {
    const c = Number((await AsyncStorage.getItem(KEY_COUNTER)) ?? '0') + 1;
    await AsyncStorage.setItem(KEY_COUNTER, String(c));
    return c;
  },
  async prefetchNonces(count = 20): Promise<number> {
    const r = await api.post<{ data: { nonce: string; expiresAt: string }[] }>('/api/v1/offline/nonces', { count });
    const current = ((await getJson<{ nonce: string; expiresAt: string }[]>(KEY_NONCES)) ?? []).filter((n) => n.expiresAt > nowIso());
    await setJson(KEY_NONCES, [...current, ...r.data]);
    return current.length + r.data.length;
  },
  /** Merchant side, no network: a signed dynamic BitriQR carrying a stored nonce, signed with this phone's key. */
  async localOfflineQr(input: { merchantCode: string; merchantName: string; country: string; currency: string; amount: string; reference?: string | null; ttlSeconds?: number }): Promise<OfflineQr> {
    const rec = await getJson<DeviceRecord>(KEY_DEVICE);
    if (!rec) throw new Error('Set this phone up for offline payments first');
    const nonces = ((await getJson<{ nonce: string; expiresAt: string }[]>(KEY_NONCES)) ?? []).filter((n) => n.expiresAt > nowIso());
    const n = nonces.shift();
    if (!n) throw new Error('No offline codes left on this phone; fetch some while online');
    await setJson(KEY_NONCES, nonces);
    const expiresAt = Math.floor(Date.now() / 1000) + (input.ttlSeconds ?? 900);
    const payload = await bitriqr.encodeSigned(
      {
        mode: 'dynamic',
        merchantId: input.merchantCode,
        merchantName: input.merchantName,
        country: input.country,
        currency: input.currency,
        amount: input.amount,
        rails: ['wallet'],
        intentRef: null,
        keyId: rec.keyId,
        expiresAt,
        offlineNonce: n.nonce,
        billRef: input.reference ?? null,
        referenceLabel: null,
        purposeCode: null,
        mcc: null,
        city: null,
        corridorFlag: null,
      } as any,
      async (p: string) => fromB64(await this.sign(p)),
    );
    return { payload, nonce: n.nonce, expiresAt: new Date(expiresAt * 1000).toISOString(), keyId: rec.keyId };
  },
};

export const offlineQueue = {
  async list(): Promise<QueuedPromise[]> {
    return (await readQueue()).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  },
  async count(): Promise<number> {
    return (await readQueue()).length;
  },
  /** The receipt a payer or merchant can show before the sync: explicit about not being final. */
  localReceipt(q: QueuedPromise): { title: string; status: OfflineState; text: string } {
    return { title: `${q.merchantName} · ${q.currency} ${(q.amountMinor / 100).toFixed(2)}`, status: q.state, text: q.receiptText };
  },
  /** Is this QR an offline code this phone can pay without the network? */
  decodeOffline(
    qrPayload: string,
  ): { merchantCode: string; merchantName: string; amount: string; currency: string; nonce: string; keyId: string; expiresAt: number | null; reference: string | null } | null {
    try {
      const d = bitriqr.decode(qrPayload);
      if (!d.offlineNonce || !d.keyId || !d.amount) return null;
      return {
        merchantCode: d.merchantId,
        merchantName: d.merchantName,
        amount: d.amount,
        currency: d.currency.toUpperCase(),
        nonce: d.offlineNonce,
        keyId: d.keyId,
        expiresAt: d.expiresAt ?? null,
        reference: d.billRef ?? null,
      };
    } catch {
      return null;
    }
  },
  /** Payer side: sign the promise with this phone's key and queue it; the QR itself is the merchant's leg. */
  async promiseFor(qrPayload: string, payerId: string, merchantId: string, decimals = 2): Promise<QueuedPromise> {
    const rec = await getJson<DeviceRecord>(KEY_DEVICE);
    if (!rec) throw new Error('Set this phone up for offline payments first');
    const d = this.decodeOffline(qrPayload);
    if (!d) throw new Error('This code is not an offline code');
    const amountMinor = Math.round(parseFloat(d.amount) * 10 ** decimals);
    const counter = await offlineDevice.nextCounter();
    const expiresAt = new Date((d.expiresAt ?? Math.floor(Date.now() / 1000) + 900) * 1000).toISOString();
    const canonical = ['BITRIQR-OFFLINE', 'v1', merchantId, payerId, String(amountMinor), d.currency, d.nonce, expiresAt, String(counter), d.reference ?? ''].join('|');
    const hash = sha256Hex(canonical);
    const payerSig = await offlineDevice.sign(canonical);
    const body = {
      merchantId,
      payerId,
      payerDeviceId: rec.deviceId,
      merchantKeyId: d.keyId,
      payerKeyId: rec.keyId,
      amountMinor,
      currency: d.currency,
      nonce: d.nonce,
      expiresAt,
      counter,
      reference: d.reference,
      merchantSig: '',
      payerSig,
      promisedAt: nowIso(),
      qrPayload,
    };
    const item: QueuedPromise = {
      hash,
      body,
      amountMinor,
      currency: d.currency,
      merchantName: d.merchantName,
      queuedAt: nowIso(),
      state: 'OFFLINE_ACCEPTED_LOCALLY',
      receiptText: PENDING_CONFIRMATION_TEXT,
    };
    const queue = (await readQueue()).filter((q) => q.hash !== hash);
    await writeQueue([...queue, { ...item, state: 'SYNC_PENDING' }]);
    return item;
  },
  /** Submit everything queued, in order; the server answers per promise and the queue is cleared. */
  async sync(): Promise<{ settled: number; rejected: number; duplicates: number; results: SyncResultItem[] }> {
    const items = await this.list();
    if (!items.length) return { settled: 0, rejected: 0, duplicates: 0, results: [] };
    await writeQueue(items.map((q) => ({ ...q, state: 'ONLINE_VALIDATING' })));
    let r: { settled: number; rejected: number; duplicates: number; results: SyncResultItem[] };
    try {
      r = await api.post('/api/v1/offline/sync', { promises: items.map((i) => i.body) });
    } catch (e) {
      await writeQueue(items.map((q) => ({ ...q, state: 'SYNC_PENDING' }))); // still pending: nothing was confirmed
      throw e;
    }
    // every promise now has an authoritative outcome (CONFIRMED / REJECTED / already known): the queue is empty
    await writeQueue([]);
    await AsyncStorage.setItem(KEY_LASTSYNC, nowIso());
    return r;
  },
  async remove(hash: string): Promise<void> {
    await writeQueue((await readQueue()).filter((q) => q.hash !== hash));
  },
};
