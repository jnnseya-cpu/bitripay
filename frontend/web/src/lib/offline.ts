/**
 * Offline protocol on the web: an Ed25519 device subkey in WebCrypto (private half never leaves the browser; it is
 * stored non-extractable in IndexedDB), prefetched merchant nonces, locally signed offline QR codes, a signed
 * promise queue that syncs in order when the network returns, and a "last synced" marker for the shell.
 *
 * The queue is encrypted at rest (AES-GCM with a non-extractable key kept in IndexedDB) and every item carries its
 * specification §28 lifecycle state; the local receipt reads "Pending confirmation" until the platform confirms.
 */
import * as bitriqr from '@bitripay/bitriqr';
import { api } from './api';

const DB = 'bitripay-offline';
function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('queue')) d.createObjectStore('queue', { keyPath: 'hash' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function kvGet<T>(key: string): Promise<T | undefined> {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const r = d.transaction('kv').objectStore('kv').get(key);
    r.onsuccess = () => resolve(r.result as T | undefined);
    r.onerror = () => reject(r.error);
  });
}
async function kvSet(key: string, value: unknown): Promise<void> {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export const OFFLINE_STATES = ['OFFLINE_CREATED', 'OFFLINE_ACCEPTED_LOCALLY', 'SYNC_PENDING', 'ONLINE_VALIDATING', 'CONFIRMED', 'REJECTED'] as const;
export type OfflineState = (typeof OFFLINE_STATES)[number];
export const PENDING_CONFIRMATION_TEXT = 'Pending confirmation — this payment is final only once BitriPay confirms it online.';

/** AES-GCM key for the queue: generated once, non-extractable, stored as a CryptoKey object in IndexedDB. */
async function queueKey(): Promise<CryptoKey> {
  const existing = await kvGet<CryptoKey>('queueKey');
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await kvSet('queueKey', key);
  return key;
}
interface StoredQueueItem {
  hash: string;
  iv?: ArrayBuffer;
  enc?: ArrayBuffer;
  /** Items written before encryption existed are read once and re-encrypted on the next write. */
  legacy?: QueuedPromise;
}
async function sealItem(item: QueuedPromise): Promise<StoredQueueItem> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await queueKey(), new TextEncoder().encode(JSON.stringify(item)));
  return { hash: item.hash, iv: iv.buffer, enc };
}
async function openItem(row: StoredQueueItem & Partial<QueuedPromise>): Promise<QueuedPromise> {
  if (row.enc && row.iv) {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(row.iv) }, await queueKey(), row.enc);
    return withState(JSON.parse(new TextDecoder().decode(plain)) as QueuedPromise);
  }
  return withState(row as unknown as QueuedPromise); // legacy plaintext row
}
const withState = (q: QueuedPromise): QueuedPromise => ({ ...q, state: q.state ?? 'SYNC_PENDING', receiptText: q.receiptText ?? PENDING_CONFIRMATION_TEXT });
async function writeItems(items: QueuedPromise[]): Promise<void> {
  const db = await idb();
  const sealed = await Promise.all(items.map(sealItem));
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('queue', 'readwrite');
    for (const s of sealed) tx.objectStore('queue').put(s);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64url = (buf: ArrayBuffer) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

interface DeviceRecord {
  deviceId: string;
  keyId: string;
  keyNotAfter: string;
  publicKey: string;
  userId: string;
}
export const offlineDevice = {
  supported(): boolean {
    return typeof crypto !== 'undefined' && !!crypto.subtle && typeof indexedDB !== 'undefined';
  },
  async status() {
    const rec = await kvGet<DeviceRecord>('device');
    const nonces = (await kvGet<{ nonce: string; expiresAt: string }[]>('nonces')) ?? [];
    return {
      supported: this.supported(),
      deviceId: rec?.deviceId ?? null,
      keyId: rec?.keyId ?? null,
      keyNotAfter: rec?.keyNotAfter ?? null,
      nonces: nonces.filter((n) => n.expiresAt > new Date().toISOString()).length,
    };
  },
  /** Generate the subkey, register its public half (online), keep the private half in IndexedDB. */
  async provision(label: string): Promise<DeviceRecord> {
    if (!this.supported()) throw new Error('This browser cannot generate an Ed25519 key');
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' } as any, false, ['sign', 'verify'])) as CryptoKeyPair;
    const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
    const existing = await kvGet<DeviceRecord>('device');
    const deviceId = existing?.deviceId ?? `web-${b64url(crypto.getRandomValues(new Uint8Array(9)).buffer)}`;
    const me = await api.get<{ user: { id: string } }>('/api/auth/me');
    const reg = await api.post<{ deviceId: string; keyId: string; keyNotAfter: string }>('/api/v1/offline/devices', { deviceId, publicKey: b64(spki), label });
    const rec: DeviceRecord = { deviceId: reg.deviceId, keyId: reg.keyId, keyNotAfter: reg.keyNotAfter, publicKey: b64(spki), userId: me.user.id };
    await kvSet('device', rec);
    await kvSet('privateKey', pair.privateKey);
    await kvSet('counter', (await kvGet<number>('counter')) ?? 0);
    return rec;
  },
  async sign(payload: string): Promise<string> {
    const key = await kvGet<CryptoKey>('privateKey');
    if (!key) throw new Error('Provision this device first');
    return b64(await crypto.subtle.sign({ name: 'Ed25519' } as any, key, new TextEncoder().encode(payload)));
  },
  async nextCounter(): Promise<number> {
    const c = ((await kvGet<number>('counter')) ?? 0) + 1;
    await kvSet('counter', c);
    return c;
  },
  async prefetchNonces(count = 20): Promise<number> {
    const r = await api.post<{ data: { nonce: string; expiresAt: string }[] }>('/api/v1/offline/nonces', { count });
    const current = ((await kvGet<{ nonce: string; expiresAt: string }[]>('nonces')) ?? []).filter((n) => n.expiresAt > new Date().toISOString());
    await kvSet('nonces', [...current, ...r.data]);
    return current.length + r.data.length;
  },
  /** Merchant side, no network needed: a signed dynamic BitriQR with a stored nonce and this device's key. */
  async localOfflineQr(input: {
    merchantCode: string;
    merchantName: string;
    country: string;
    currency: string;
    amount: string;
    reference?: string | null;
    ttlSeconds?: number;
  }): Promise<{ payload: string; nonce: string; expiresAt: string; keyId: string }> {
    const rec = await kvGet<DeviceRecord>('device');
    if (!rec) throw new Error('Provision this device first');
    const nonces = ((await kvGet<{ nonce: string; expiresAt: string }[]>('nonces')) ?? []).filter((n) => n.expiresAt > new Date().toISOString());
    const n = nonces.shift();
    if (!n) throw new Error('No offline codes left on this device; prefetch some while online');
    await kvSet('nonces', nonces);
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
      async (p: string) => new Uint8Array(Buffer_from(await this.sign(p))),
    );
    return { payload, nonce: n.nonce, expiresAt: new Date(expiresAt * 1000).toISOString(), keyId: rec.keyId };
  },
};
function Buffer_from(b64s: string): ArrayBuffer {
  const bin = atob(b64s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export interface QueuedPromise {
  hash: string;
  body: Record<string, unknown>;
  amountMinor: number;
  currency: string;
  merchantName: string;
  queuedAt: string;
  /** §28 lifecycle: OFFLINE_ACCEPTED_LOCALLY when signed here, SYNC_PENDING while waiting, ONLINE_VALIDATING during a sync. */
  state: OfflineState;
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
}
export const offlineQueue = {
  async count(): Promise<number> {
    const d = await idb();
    return new Promise((resolve, reject) => {
      const r = d.transaction('queue').objectStore('queue').count();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  },
  async list(): Promise<QueuedPromise[]> {
    const d = await idb();
    return new Promise((resolve, reject) => {
      const r = d.transaction('queue').objectStore('queue').getAll();
      r.onsuccess = () => {
        Promise.all((r.result as StoredQueueItem[]).map(openItem))
          .then((items) => resolve(items.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))))
          .catch(reject);
      };
      r.onerror = () => reject(r.error);
    });
  },
  /** The receipt a payer can show before the sync: explicit about not being final. */
  localReceipt(q: QueuedPromise): { title: string; status: OfflineState; text: string } {
    return { title: `${q.merchantName} · ${q.currency} ${(q.amountMinor / 100).toFixed(2)}`, status: q.state, text: q.receiptText };
  },
  /** Payer side: decode the merchant's offline QR, sign the promise with this device's key and queue it. */
  async promiseFor(qrPayload: string, payerId: string, merchantId: string): Promise<QueuedPromise> {
    const rec = await kvGet<DeviceRecord>('device');
    if (!rec) throw new Error('Provision this device for offline payments first');
    const d = bitriqr.decode(qrPayload);
    if (!d.offlineNonce || !d.keyId || !d.amount) throw new Error('This code is not an offline code');
    const amountMinor = Math.round(parseFloat(d.amount) * 100);
    const counter = await offlineDevice.nextCounter();
    const expiresAt = new Date((d.expiresAt ?? Math.floor(Date.now() / 1000) + 900) * 1000).toISOString();
    const canonical = ['BITRIQR-OFFLINE', 'v1', merchantId, payerId, String(amountMinor), d.currency.toUpperCase(), d.offlineNonce, expiresAt, String(counter), d.billRef ?? ''].join('|');
    const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    const hash = [...new Uint8Array(hashBuf)].map((x) => x.toString(16).padStart(2, '0')).join('');
    const payerSig = await offlineDevice.sign(canonical);
    // the merchant's signature over the same fields travels inside the QR only for the base payload; the promise
    // itself is countersigned by the merchant device when both are online, or by the merchant when it syncs first
    const body = {
      merchantId,
      payerId,
      payerDeviceId: rec.deviceId,
      merchantKeyId: d.keyId,
      payerKeyId: rec.keyId,
      amountMinor,
      currency: d.currency.toUpperCase(),
      nonce: d.offlineNonce,
      expiresAt,
      counter,
      reference: d.billRef ?? null,
      merchantSig: d.signature ?? '',
      payerSig,
      promisedAt: new Date().toISOString(),
      qrPayload,
    };
    const item: QueuedPromise = {
      hash,
      body,
      amountMinor,
      currency: d.currency.toUpperCase(),
      merchantName: d.merchantName,
      queuedAt: new Date().toISOString(),
      state: 'OFFLINE_ACCEPTED_LOCALLY',
      receiptText: PENDING_CONFIRMATION_TEXT,
    };
    await writeItems([{ ...item, state: 'SYNC_PENDING' }]);
    return item;
  },
  async sync(): Promise<{ settled: number; rejected: number; duplicates: number; results: SyncResultItem[] }> {
    const items = await this.list();
    if (!items.length) return { settled: 0, rejected: 0, duplicates: 0, results: [] };
    await writeItems(items.map((q) => ({ ...q, state: 'ONLINE_VALIDATING' })));
    let r: { settled: number; rejected: number; duplicates: number; results: SyncResultItem[] };
    try {
      r = await api.post('/api/v1/offline/sync', { promises: items.map((i) => i.body) });
    } catch (e) {
      await writeItems(items.map((q) => ({ ...q, state: 'SYNC_PENDING' }))); // nothing was confirmed: still pending
      throw e;
    }
    const db = await idb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('queue', 'readwrite');
      for (const i of items) tx.objectStore('queue').delete(i.hash);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await kvSet('lastSync', new Date().toISOString());
    return r;
  },
  async lastSync(): Promise<string | null> {
    return (await kvGet<string>('lastSync')) ?? null;
  },
};
