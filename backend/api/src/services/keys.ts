/**
 * Signing-key registry for BitriQR. Merchant keys (scope MERCHANT) are platform-managed: generated server-side,
 * private half encrypted at rest with the platform key (KMS at scale), public half published for verifiers,
 * rotated every 90 days with an overlap. Device offline subkeys (scope DEVICE_OFFLINE) are generated on the device;
 * only the public key is registered, valid 72 hours, provisioned online only.
 */
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify, randomBytes } from 'node:crypto';
import { getDb } from '../db';
import { now } from '../lib/ids';
import { encrypt, decrypt } from '../lib/crypto';
import { badRequest, notFound } from '../lib/errors';

export type KeyScope = 'MERCHANT' | 'DEVICE_OFFLINE' | 'PLATFORM';
export interface SigningKey {
  keyId: string;
  partyType: 'user' | 'device' | 'platform';
  partyId: string;
  scope: KeyScope;
  publicKey: string;
  notBefore: string;
  notAfter: string;
  revokedAt: string | null;
  createdAt: string;
}
const toKey = (r: any): SigningKey => ({
  keyId: r.key_id,
  partyType: r.party_type,
  partyId: r.party_id,
  scope: r.scope,
  publicKey: r.public_key,
  notBefore: r.not_before,
  notAfter: r.not_after,
  revokedAt: r.revoked_at,
  createdAt: r.created_at,
});

export const MERCHANT_KEY_DAYS = 90;
export const DEVICE_KEY_HOURS = 72;
/** Rotate when less than this many days remain so verifiers can cache both keys. */
const ROTATE_BEFORE_DAYS = 7;

function newKeyId(): string {
  return randomBytes(4).toString('hex');
}

/** The merchant's current signing key, generated or rotated as needed. */
export function merchantSigningKey(merchantUserId: string): SigningKey {
  const db = getDb();
  const current = db
    .prepare("SELECT * FROM signing_keys WHERE party_type = 'user' AND party_id = ? AND scope = 'MERCHANT' AND revoked_at IS NULL AND not_after > ? ORDER BY not_after DESC LIMIT 1")
    .get(merchantUserId, now()) as any;
  if (current && new Date(current.not_after).getTime() - Date.now() > ROTATE_BEFORE_DAYS * 86400_000) return toKey(current);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyId = newKeyId();
  const notAfter = new Date(Date.now() + MERCHANT_KEY_DAYS * 86400_000).toISOString();
  db.prepare('INSERT INTO signing_keys (key_id, party_type, party_id, scope, public_key, private_key_enc, not_before, not_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    keyId,
    'user',
    merchantUserId,
    'MERCHANT',
    publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    encrypt(privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')),
    now(),
    notAfter,
    now(),
  );
  return toKey(db.prepare('SELECT * FROM signing_keys WHERE key_id = ?').get(keyId));
}

/** The platform's own key (scope PLATFORM): signs webhook deliveries and platform-issued receipts. Rotated yearly with a 7-day overlap. */
export const PLATFORM_KEY_DAYS = 365;
export function platformSigningKey(): SigningKey {
  const db = getDb();
  const current = db
    .prepare("SELECT * FROM signing_keys WHERE party_type = 'platform' AND scope = 'PLATFORM' AND revoked_at IS NULL AND not_after > ? ORDER BY not_after DESC LIMIT 1")
    .get(now()) as any;
  if (current && new Date(current.not_after).getTime() - Date.now() > ROTATE_BEFORE_DAYS * 86400_000) return toKey(current);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyId = newKeyId();
  const notAfter = new Date(Date.now() + PLATFORM_KEY_DAYS * 86400_000).toISOString();
  db.prepare('INSERT INTO signing_keys (key_id, party_type, party_id, scope, public_key, private_key_enc, not_before, not_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    keyId,
    'platform',
    'platform',
    'PLATFORM',
    publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    encrypt(privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')),
    now(),
    notAfter,
    now(),
  );
  return toKey(db.prepare('SELECT * FROM signing_keys WHERE key_id = ?').get(keyId));
}

/** Register a device-held offline subkey (public half only). */
export function registerDeviceKey(deviceId: string, publicKeySpkiB64: string, hours = DEVICE_KEY_HOURS): SigningKey {
  try {
    createPublicKey({ key: Buffer.from(publicKeySpkiB64, 'base64'), format: 'der', type: 'spki' });
  } catch {
    throw badRequest('Public key must be an ed25519 SPKI DER, base64', 'invalid_public_key');
  }
  const keyId = newKeyId();
  getDb()
    .prepare('INSERT INTO signing_keys (key_id, party_type, party_id, scope, public_key, private_key_enc, not_before, not_after, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)')
    .run(keyId, 'device', deviceId, 'DEVICE_OFFLINE', publicKeySpkiB64, now(), new Date(Date.now() + hours * 3600_000).toISOString(), now());
  return getKey(keyId);
}

export function getKey(keyId: string): SigningKey {
  const r = getDb().prepare('SELECT * FROM signing_keys WHERE key_id = ?').get(keyId);
  if (!r) throw notFound('Unknown signing key', 'key_not_found');
  return toKey(r);
}
export function revokeKey(keyId: string) {
  getDb().prepare('UPDATE signing_keys SET revoked_at = ? WHERE key_id = ? AND revoked_at IS NULL').run(now(), keyId);
}
export function listKeys(partyId: string): SigningKey[] {
  return (getDb().prepare('SELECT * FROM signing_keys WHERE party_id = ? ORDER BY created_at DESC').all(partyId) as any[]).map(toKey);
}

/** Sign with a platform-managed key. */
export function signWithKey(keyId: string, payload: string): Uint8Array {
  const r = getDb().prepare('SELECT * FROM signing_keys WHERE key_id = ?').get(keyId) as any;
  if (!r || !r.private_key_enc) throw notFound('Key cannot sign on the platform', 'key_not_signing');
  if (r.revoked_at || r.not_after < now()) throw badRequest('Key is no longer valid', 'key_expired');
  const priv = createPrivateKey({ key: Buffer.from(decrypt(r.private_key_enc), 'base64'), format: 'der', type: 'pkcs8' });
  return new Uint8Array(nodeSign(null, Buffer.from(payload), priv));
}

/** Verify against the registry: unknown, revoked or expired keys fail. */
export function verifyWithKey(keyId: string, payload: string, signature: Uint8Array): boolean {
  const r = getDb().prepare('SELECT * FROM signing_keys WHERE key_id = ?').get(keyId) as any;
  if (!r || r.revoked_at) return false;
  const t = now();
  if (r.not_after < t || r.not_before > t) return false;
  try {
    const pub = createPublicKey({ key: Buffer.from(r.public_key, 'base64'), format: 'der', type: 'spki' });
    return nodeVerify(null, Buffer.from(payload), pub, Buffer.from(signature));
  } catch {
    return false;
  }
}

/** Public registry view (cacheable; the route sets an ETag from updated keys). */
export function publicKeyRegistry(keyId?: string | null) {
  const rows = keyId
    ? [getDb().prepare('SELECT * FROM signing_keys WHERE key_id = ?').get(keyId)].filter(Boolean)
    : getDb().prepare('SELECT * FROM signing_keys WHERE revoked_at IS NULL AND not_after > ? ORDER BY created_at DESC LIMIT 500').all(now());
  return (rows as any[]).map((r) => ({ keyId: r.key_id, scope: r.scope, publicKey: r.public_key, algorithm: 'ed25519', notBefore: r.not_before, notAfter: r.not_after, revoked: !!r.revoked_at }));
}
