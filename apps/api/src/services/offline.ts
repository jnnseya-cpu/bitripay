/**
 * Offline-signed QR protocol (innovation I-2). When the network is down a merchant device shows a signed dynamic
 * BitriQR that carries an offline nonce; the payer's device signs a *promise* (merchant, payer, amount, currency,
 * nonce, expiry and a monotonic device counter) with its 72-hour offline subkey; both signatures, the nonce and the
 * counter travel to the platform when either side is back online. The platform, and only the platform, turns a
 * promise into money: it verifies both signatures against the key registry, refuses replayed nonces (72h registry),
 * out-of-order or reused counters, expired promises, amounts above the offline ceilings, sanctions and fraud
 * policy hits, and insufficient balance — then posts an ordinary QR payment. A rejected item is reported back so
 * the device restores its local balance, and every outcome is idempotent on the promise hash. An offline payment
 * is never presented as final before this authoritative confirmation (rule 14).
 */
import { randomBytes, createPublicKey, verify as nodeVerify } from 'node:crypto';
import * as bitriqr from '@bitripay/bitriqr';
import { getDb } from '../db';
import { now, uuid } from '../lib/ids';
import { sha256 } from '../lib/crypto';
import { parseJson } from '../lib/json';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { getSetting } from './settings';
import { getCurrency, toBase } from './currencies';
import { findUserById, findUserByIdentifier, type UserRow } from './users';
import { ensureWallet, getUserWallet } from './wallets';
import { calculateFee, postTransaction, type TransactionRow } from './ledger';
import { registerDeviceKey, getKey, merchantSigningKey, signWithKey, verifyWithKey, platformSigningKey, DEVICE_KEY_HOURS } from './keys';
import { assessRisk } from './risk';
import { assertMoneyMovementAllowed } from './guardian';
import { recordEvent } from './events';
import { notify } from './notifications';
import { emitEvent } from './webhooks';
import { publish } from './bus';
import { merchantCode } from './qrcodes';

export interface OfflineSettings {
  enabled: boolean;
  /** Ceilings in base-currency minor units. */
  maxPerPromiseBase: number;
  maxOutstandingPerDeviceBase: number;
  /** A promise must reach the platform within this many hours of being signed (matches the device key validity). */
  promiseValidityHours: number;
  qrTtlSeconds: number;
}
const DEFAULT: OfflineSettings = { enabled: true, maxPerPromiseBase: 20_000, maxOutstandingPerDeviceBase: 100_000, promiseValidityHours: 72, qrTtlSeconds: 900 };
export const getOfflineSettings = (): OfflineSettings => ({ ...DEFAULT, ...getSetting<Partial<OfflineSettings>>('offline', {}) });

export const PROMISE_VERSION = 'v1';
/** The exact bytes both devices sign. Deterministic, pipe-separated, no JSON ambiguity. */
export function promiseCanonical(p: { merchantId: string; payerId: string; amountMinor: number; currency: string; nonce: string; expiresAt: string; counter: number; reference?: string | null }): string {
  return ['BITRIQR-OFFLINE', PROMISE_VERSION, p.merchantId, p.payerId, String(p.amountMinor), p.currency.toUpperCase(), p.nonce, p.expiresAt, String(p.counter), p.reference ?? ''].join('|');
}
export const promiseHash = (canonical: string) => sha256(canonical);

// ---------------------------------------------------------------------------------------------------------------------
// Devices and keys
// ---------------------------------------------------------------------------------------------------------------------
export interface OfflineDevice {
  deviceId: string;
  userId: string;
  keyId: string;
  label: string | null;
  lastCounter: number;
  registeredAt: string;
  lastSyncAt: string | null;
  keyNotAfter: string;
}
const toDevice = (r: any): OfflineDevice => ({ deviceId: r.device_id, userId: r.user_id, keyId: r.key_id, label: r.label, lastCounter: r.last_counter, registeredAt: r.registered_at, lastSyncAt: r.last_sync_at, keyNotAfter: getKey(r.key_id).notAfter });

/** Provision (or re-provision) a device's offline subkey. Online only, by definition. */
export function registerOfflineDevice(user: UserRow, input: { deviceId: string; publicKey: string; label?: string | null }): OfflineDevice {
  if (!getOfflineSettings().enabled) throw unprocessable('Offline payments are switched off', 'module_disabled');
  if (!/^[A-Za-z0-9._:-]{6,80}$/.test(input.deviceId)) throw badRequest('deviceId must be 6–80 characters', 'validation_error');
  const db = getDb();
  const existing = db.prepare('SELECT * FROM offline_devices WHERE device_id = ?').get(input.deviceId) as any;
  if (existing && existing.user_id !== user.id) throw forbidden('This device is registered to another account', 'device_taken');
  const key = registerDeviceKey(`${user.id}:${input.deviceId}`, input.publicKey, DEVICE_KEY_HOURS);
  if (existing) db.prepare('UPDATE offline_devices SET key_id = ?, label = COALESCE(?, label) WHERE device_id = ?').run(key.keyId, input.label ?? null, input.deviceId);
  else db.prepare('INSERT INTO offline_devices (device_id, user_id, key_id, label, last_counter, registered_at) VALUES (?, ?, ?, ?, 0, ?)').run(input.deviceId, user.id, key.keyId, input.label ?? null, now());
  recordEvent('auth', user.id, 'offline.device_registered', { type: user.role === 'merchant' ? 'merchant' : 'user', id: user.id }, { deviceId: input.deviceId, keyId: key.keyId, notAfter: key.notAfter });
  return toDevice(db.prepare('SELECT * FROM offline_devices WHERE device_id = ?').get(input.deviceId));
}
export function listOfflineDevices(userId: string): OfflineDevice[] {
  return (getDb().prepare('SELECT * FROM offline_devices WHERE user_id = ? ORDER BY registered_at DESC').all(userId) as any[]).map(toDevice);
}

// ---------------------------------------------------------------------------------------------------------------------
// Offline QR (merchant side, server-signed while online; devices sign the same fields with their own key offline)
// ---------------------------------------------------------------------------------------------------------------------
export function issueOfflineNonce(userId: string, hours = getOfflineSettings().promiseValidityHours): { nonce: string; expiresAt: string } {
  const nonce = randomBytes(16).toString('base64url');
  const expiresAt = new Date(Date.now() + hours * 3600_000).toISOString();
  getDb().prepare('INSERT INTO offline_nonces (nonce, issued_to, expires_at) VALUES (?, ?, ?)').run(nonce, userId, expiresAt);
  return { nonce, expiresAt };
}
export function offlineQr(merchant: UserRow, input: { amountMinor: number; currency: string; reference?: string | null; ttlSeconds?: number | null }): { payload: string; nonce: string; expiresAt: string; keyId: string; amountMinor: number; currency: string } {
  const s = getOfflineSettings();
  if (!s.enabled) throw unprocessable('Offline payments are switched off', 'module_disabled');
  const cur = getCurrency(input.currency);
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) throw badRequest('Amount must be a positive integer in minor units', 'invalid_amount');
  if (toBase(input.amountMinor, cur.code) > s.maxPerPromiseBase) throw unprocessable('Amount exceeds the offline ceiling', 'offline_ceiling');
  const ttl = Math.min(s.qrTtlSeconds, Math.max(60, input.ttlSeconds ?? s.qrTtlSeconds));
  const { nonce } = issueOfflineNonce(merchant.id);
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  const key = merchantSigningKey(merchant.id);
  const payload = bitriqr.encodeSigned({ mode: 'dynamic', merchantId: merchantCode(merchant), merchantName: merchant.business_name || merchant.full_name, country: merchant.country ?? 'CD', currency: cur.code, amount: (input.amountMinor / 10 ** cur.decimals).toFixed(cur.decimals), rails: ['wallet'], intentRef: null, keyId: key.keyId, expiresAt, offlineNonce: nonce, billRef: input.reference ?? null, referenceLabel: null, purposeCode: null, mcc: null, city: null, corridorFlag: null } as any, (p) => signWithKey(key.keyId, p)) as string;
  return { payload, nonce, expiresAt: new Date(expiresAt * 1000).toISOString(), keyId: key.keyId, amountMinor: input.amountMinor, currency: cur.code };
}

// ---------------------------------------------------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------------------------------------------------
export interface OfflinePromiseInput {
  merchantId: string;
  payerId: string;
  payerDeviceId: string;
  merchantKeyId: string;
  payerKeyId: string;
  amountMinor: number;
  currency: string;
  nonce: string;
  expiresAt: string;
  counter: number;
  reference?: string | null;
  merchantSig: string;
  payerSig: string;
  promisedAt: string;
}
export interface SyncOutcome {
  hash: string;
  state: 'SETTLED' | 'REJECTED' | 'DUPLICATE';
  reason?: string | null;
  transactionId?: string | null;
  receipt?: { hash: string; transactionId: string; amountMinor: number; currency: string; keyId: string; signature: string } | null;
  /** The payer's device should restore this amount to its local balance when the promise is rejected. */
  restoreMinor?: number;
}
function verifySig(keyId: string, payload: string, sigB64: string): boolean {
  try {
    return verifyWithKey(keyId, payload, new Uint8Array(Buffer.from(sigB64, 'base64')));
  } catch {
    return false;
  }
}
/** Verify a device key even after its 72h validity when the promise itself was signed while the key was valid. */
function verifyDeviceSigAt(keyId: string, payload: string, sigB64: string, at: string): boolean {
  const r = getDb().prepare('SELECT * FROM signing_keys WHERE key_id = ?').get(keyId) as any;
  if (!r || r.revoked_at || r.scope !== 'DEVICE_OFFLINE') return false;
  if (at < r.not_before || at > r.not_after) return false;
  try {
    const pub = createPublicKey({ key: Buffer.from(r.public_key, 'base64'), format: 'der', type: 'spki' });
    return nodeVerify(null, Buffer.from(payload), pub, Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}

function receiptFor(hash: string, tx: TransactionRow) {
  const key = platformSigningKey();
  const payload = `BITRIQR-RECEIPT|${hash}|${tx.id}|${tx.amount}|${tx.currency}`;
  return { hash, transactionId: tx.id, amountMinor: tx.amount, currency: tx.currency, keyId: key.keyId, signature: Buffer.from(signWithKey(key.keyId, payload)).toString('base64') };
}

/** Process one promise. Idempotent on the hash; never throws (the outcome carries the reason). */
export function settlePromise(submitter: UserRow, p: OfflinePromiseInput): SyncOutcome {
  const db = getDb();
  const s = getOfflineSettings();
  const canonical = promiseCanonical({ merchantId: p.merchantId, payerId: p.payerId, amountMinor: p.amountMinor, currency: p.currency, nonce: p.nonce, expiresAt: p.expiresAt, counter: p.counter, reference: p.reference ?? null });
  const hash = promiseHash(canonical);
  const prior = db.prepare('SELECT * FROM offline_promises WHERE intent_hash = ?').get(hash) as any;
  if (prior) return { hash, state: 'DUPLICATE', reason: prior.sync_state === 'SETTLED' ? 'already_settled' : `already_${String(prior.sync_state).toLowerCase()}`, transactionId: prior.transaction_id, receipt: prior.transaction_id && prior.receipt_sig ? { ...parseJson(prior.receipt_sig, {}) } as any : null };
  const reject = (reason: string, extra: Record<string, unknown> = {}): SyncOutcome => {
    db.prepare('INSERT INTO offline_promises (intent_hash, merchant_user_id, payer_user_id, payer_device_id, merchant_key_id, payer_key_id, amount_minor, currency, nonce, reference, merchant_sig, payer_sig, payer_device_counter, promised_at, expires_at, submitted_by, sync_state, reject_reason, synced_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(hash, p.merchantId, p.payerId, p.payerDeviceId, p.merchantKeyId, p.payerKeyId, p.amountMinor, p.currency.toUpperCase(), p.nonce, p.reference ?? null, p.merchantSig, p.payerSig, p.counter, p.promisedAt, p.expiresAt, submitter.id, 'REJECTED', reason, now(), now());
    recordEvent('payment', hash, 'offline.promise_rejected', { type: 'system' }, { reason, merchantId: p.merchantId, payerId: p.payerId, amount: p.amountMinor, currency: p.currency, ...extra });
    publish('offline.promise_rejected', { hash, reason, payerId: p.payerId, merchantId: p.merchantId, amountMinor: p.amountMinor, currency: p.currency }, { aggregateId: hash });
    const payer = findUserById(p.payerId);
    if (payer) notify(payer.id, 'Offline payment not completed', `Your offline payment of ${p.amountMinor / 100} ${p.currency} could not be completed (${reason.replace(/_/g, ' ')}). The amount is back in your balance.`, { kind: 'payment_failed', hash });
    return { hash, state: 'REJECTED', reason, restoreMinor: p.amountMinor };
  };
  if (!s.enabled) return reject('offline_disabled');
  const merchant = findUserById(p.merchantId);
  const payer = findUserById(p.payerId);
  if (!merchant || !payer) return reject('unknown_party');
  if (submitter.id !== merchant.id && submitter.id !== payer.id && submitter.role !== 'admin') return reject('submitter_not_party');
  if (merchant.status !== 'active' || payer.status !== 'active') return reject('party_inactive');
  if (!Number.isInteger(p.amountMinor) || p.amountMinor <= 0) return reject('invalid_amount');
  let cur;
  try {
    cur = getCurrency(p.currency);
  } catch {
    return reject('currency_not_enabled');
  }
  if (Date.parse(p.expiresAt) < Date.now()) return reject('promise_expired');
  if (Date.now() - Date.parse(p.promisedAt) > s.promiseValidityHours * 3600_000) return reject('promise_too_old');
  // signatures: the merchant key (platform-managed or device offline subkey) and the payer's device subkey
  const merchantKey = (() => {
    try {
      return getKey(p.merchantKeyId);
    } catch {
      return null;
    }
  })();
  if (!merchantKey) return reject('merchant_key_unknown');
  const merchantOk = merchantKey.scope === 'DEVICE_OFFLINE' ? verifyDeviceSigAt(p.merchantKeyId, canonical, p.merchantSig, p.promisedAt) : verifySig(p.merchantKeyId, canonical, p.merchantSig);
  if (!merchantOk || (merchantKey.scope === 'MERCHANT' && merchantKey.partyId !== merchant.id) || (merchantKey.scope === 'DEVICE_OFFLINE' && !merchantKey.partyId.startsWith(`${merchant.id}:`))) return reject('merchant_signature_invalid');
  const device = db.prepare('SELECT * FROM offline_devices WHERE device_id = ? AND user_id = ?').get(p.payerDeviceId, payer.id) as any;
  if (!device) return reject('payer_device_unknown');
  const payerKey = (() => {
    try {
      return getKey(p.payerKeyId);
    } catch {
      return null;
    }
  })();
  if (!payerKey || payerKey.scope !== 'DEVICE_OFFLINE' || payerKey.partyId !== `${payer.id}:${p.payerDeviceId}`) return reject('payer_key_invalid');
  if (!verifyDeviceSigAt(p.payerKeyId, canonical, p.payerSig, p.promisedAt)) return reject('payer_signature_invalid');
  // replay and ordering
  const nonce = db.prepare('SELECT * FROM offline_nonces WHERE nonce = ?').get(p.nonce) as any;
  if (nonce?.used_at) return reject('nonce_replayed', { usedBy: nonce.used_by });
  if (nonce && nonce.expires_at < now()) return reject('nonce_expired');
  if (nonce && nonce.issued_to && nonce.issued_to !== merchant.id) return reject('nonce_not_merchants');
  if (p.counter <= device.last_counter) return reject('counter_not_monotonic', { lastCounter: device.last_counter });
  // ceilings, guardian, sanctions and fraud policy
  const base = toBase(p.amountMinor, cur.code);
  if (base > s.maxPerPromiseBase) return reject('offline_ceiling');
  const outstanding = (db.prepare("SELECT COALESCE(SUM(amount_minor), 0) s FROM offline_promises WHERE payer_device_id = ? AND sync_state = 'SETTLED' AND synced_at >= ?").get(p.payerDeviceId, new Date(Date.now() - 86_400_000).toISOString()) as any).s as number;
  if (outstanding + p.amountMinor > s.maxOutstandingPerDeviceBase) return reject('device_daily_ceiling');
  try {
    assertMoneyMovementAllowed('offline');
  } catch (err) {
    return reject('guardian_halt', { error: (err as Error).message });
  }
  const risk = assessRisk({ userId: payer.id, kind: 'transfer', amount: p.amountMinor, currency: cur.code, subjectType: 'offline_promise', subjectId: hash, counterparty: { name: merchant.full_name, phone: merchant.phone, email: merchant.email, country: merchant.country }, method: 'offline', recipientUserId: merchant.id });
  if (risk.action === 'block') return reject('risk_blocked', { score: risk.score });
  if (risk.action === 'review') return reject('risk_review', { score: risk.score });
  // post the payment
  const fee = calculateFee('qr_payment', p.amountMinor, cur.code, null, { userId: merchant.id });
  let tx: TransactionRow;
  try {
    const from = getUserWallet(payer.id, cur.code);
    const to = ensureWallet(merchant.id, cur.code);
    tx = db.transaction(() => {
      const t = postTransaction({ type: 'qr_payment', amount: p.amountMinor, fee, currency: cur.code, fromWalletId: from.id, toWalletId: to.id, feeFrom: 'receiver', senderUserId: payer.id, receiverUserId: merchant.id, note: p.reference ?? `Offline payment to ${merchant.business_name || merchant.full_name}`, metadata: { method: 'offline', offline: true, promiseHash: hash, nonce: p.nonce, deviceId: p.payerDeviceId, counter: p.counter, promisedAt: p.promisedAt }, idempotencyKey: `offline:${hash}` });
      if (nonce) db.prepare('UPDATE offline_nonces SET used_by = ?, used_at = ? WHERE nonce = ?').run(hash, now(), p.nonce);
      else db.prepare('INSERT INTO offline_nonces (nonce, issued_to, used_by, used_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(p.nonce, merchant.id, hash, now(), p.expiresAt);
      db.prepare('UPDATE offline_devices SET last_counter = ?, last_sync_at = ? WHERE device_id = ?').run(p.counter, now(), p.payerDeviceId);
      return t;
    })();
  } catch (err: any) {
    return reject(err?.code === 'insufficient_funds' ? 'insufficient_funds' : err?.code ?? 'posting_failed', { error: String(err?.message ?? err) });
  }
  const receipt = receiptFor(hash, tx);
  db.prepare('INSERT INTO offline_promises (intent_hash, merchant_user_id, payer_user_id, payer_device_id, merchant_key_id, payer_key_id, amount_minor, currency, nonce, reference, merchant_sig, payer_sig, payer_device_counter, promised_at, expires_at, submitted_by, sync_state, transaction_id, receipt_sig, synced_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(hash, merchant.id, payer.id, p.payerDeviceId, p.merchantKeyId, p.payerKeyId, p.amountMinor, cur.code, p.nonce, p.reference ?? null, p.merchantSig, p.payerSig, p.counter, p.promisedAt, p.expiresAt, submitter.id, 'SETTLED', tx.id, JSON.stringify(receipt), now(), now());
  recordEvent('payment', hash, 'offline.promise_settled', { type: 'system' }, { transactionId: tx.id, merchantId: merchant.id, payerId: payer.id, amount: p.amountMinor, currency: cur.code, counter: p.counter });
  emitEvent(merchant.id, 'payment.completed', { transaction: { id: tx.id, amount: p.amountMinor, currency: cur.code, method: 'offline', promiseHash: hash } }, { resource: { type: 'transaction', id: tx.id } });
  notify(merchant.id, 'Offline payment confirmed', `${p.amountMinor / 10 ** cur.decimals} ${cur.code} from ${payer.full_name} is now in your wallet.`, { kind: 'payment_received', transactionId: tx.id });
  return { hash, state: 'SETTLED', transactionId: tx.id, receipt };
}

/** Submit a batch in the order the device recorded it. */
export function syncPromises(submitter: UserRow, items: OfflinePromiseInput[]): { results: SyncOutcome[]; settled: number; rejected: number; duplicates: number } {
  if (items.length > 200) throw badRequest('Sync at most 200 promises per call', 'validation_error');
  const results = items.map((p) => settlePromise(submitter, p));
  return { results, settled: results.filter((r) => r.state === 'SETTLED').length, rejected: results.filter((r) => r.state === 'REJECTED').length, duplicates: results.filter((r) => r.state === 'DUPLICATE').length };
}

export function listPromises(userId: string, filter: { state?: string | null; limit?: number } = {}) {
  return (getDb().prepare(`SELECT * FROM offline_promises WHERE (merchant_user_id = ? OR payer_user_id = ?) ${filter.state ? 'AND sync_state = ?' : ''} ORDER BY created_at DESC LIMIT ?`).all(...(filter.state ? [userId, userId, filter.state] : [userId, userId]), Math.min(500, filter.limit ?? 100)) as any[]).map((r) => ({ hash: r.intent_hash, merchantId: r.merchant_user_id, payerId: r.payer_user_id, deviceId: r.payer_device_id, amountMinor: r.amount_minor, currency: r.currency, reference: r.reference, counter: r.payer_device_counter, promisedAt: r.promised_at, expiresAt: r.expires_at, state: r.sync_state, rejectReason: r.reject_reason, transactionId: r.transaction_id, receipt: r.receipt_sig ? parseJson(r.receipt_sig, null) : null, syncedAt: r.synced_at }));
}

/** Housekeeping: drop nonces past their validity window (replays after that cannot verify anyway: the keys are gone). */
export function purgeOfflineNonces(): number {
  return getDb().prepare('DELETE FROM offline_nonces WHERE expires_at < ? AND used_at IS NULL').run(new Date(Date.now() - 24 * 3600_000).toISOString()).changes;
}
export function resolveMerchant(identifier: string): UserRow | undefined {
  return findUserByIdentifier(identifier) ?? findUserById(identifier);
}
export { uuid as offlineId };
