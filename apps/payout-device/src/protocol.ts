/**
 * BitriPay payout-device protocol (pure TypeScript, no React Native imports so it can be unit-tested in Node
 * against the API's verifier).
 *
 *  - Ed25519 device key pair; the public key is registered as an evidence device (SPKI PEM)
 *  - Request authentication: `X-Device-Signature` = sign("deviceId\ntimestamp\nMETHOD\npath")
 *  - Evidence signature: sign("deviceId\nnonce\nreceivedAt\nfrom\noperatorId\ntext")
 *  - clientHash = sha256(text) so the server can detect alteration in transit
 */
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

// @noble/ed25519 v2 needs a synchronous SHA-512 for sync signing.
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const SPKI_PREFIX = hexToBytes('302a300506032b6570032100');

export interface DeviceKeyPair {
  privateKeyHex: string;
  publicKeyHex: string;
  publicKeyPem: string;
}

/** `randomBytes` is injected so React Native can supply expo-crypto and Node its crypto module. */
export function generateDeviceKeys(randomBytes: (n: number) => Uint8Array): DeviceKeyPair {
  const priv = randomBytes(32);
  const pub = ed.getPublicKey(priv);
  return { privateKeyHex: bytesToHex(priv), publicKeyHex: bytesToHex(pub), publicKeyPem: publicKeyToPem(pub) };
}

export function publicKeyToPem(pub: Uint8Array): string {
  const der = new Uint8Array(SPKI_PREFIX.length + pub.length);
  der.set(SPKI_PREFIX);
  der.set(pub, SPKI_PREFIX.length);
  const b64 = base64(der);
  return `-----BEGIN PUBLIC KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

export function base64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += chars[(triple >> 18) & 63] + chars[(triple >> 12) & 63] + (i + 1 < bytes.length ? chars[(triple >> 6) & 63] : '=') + (i + 2 < bytes.length ? chars[triple & 63] : '=');
  }
  return out;
}

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

function signString(privateKeyHex: string, message: string): string {
  return base64(ed.sign(utf8ToBytes(message), hexToBytes(privateKeyHex)));
}

/** Headers that authenticate a queue / claim / release call. */
export function signRequest(privateKeyHex: string, deviceId: string, method: string, path: string, timestamp = new Date().toISOString()): Record<string, string> {
  return { 'X-Device-Id': deviceId, 'X-Device-Timestamp': timestamp, 'X-Device-Signature': signString(privateKeyHex, [deviceId, timestamp, method.toUpperCase(), path].join('\n')) };
}

export interface EvidenceFields {
  deviceId: string;
  nonce: string;
  receivedAt: string;
  from: string;
  operatorId?: string | null;
  text: string;
}

export function evidenceCanonical(f: EvidenceFields): string {
  return [f.deviceId, f.nonce, f.receivedAt, f.from, f.operatorId ?? '', f.text].join('\n');
}

/** Full signed evidence payload for POST /api/payouts/device/:id/evidence or /api/evidence/sms. */
export function buildEvidence(privateKeyHex: string, f: EvidenceFields, extra: { simIdentity?: string | null; deviceTimestamp?: string } = {}) {
  return { ...f, operatorId: f.operatorId ?? null, signature: signString(privateKeyHex, evidenceCanonical(f)), clientHash: sha256Hex(f.text), deviceTimestamp: extra.deviceTimestamp ?? new Date().toISOString(), simIdentity: extra.simIdentity ?? null };
}

export function randomNonce(randomBytes: (n: number) => Uint8Array): string {
  return bytesToHex(randomBytes(16));
}

/** Ed25519 self-check used at enrolment so a broken RNG / storage never produces unverifiable evidence. */
export function selfTest(keys: DeviceKeyPair): boolean {
  const msg = utf8ToBytes('bitripay-self-test');
  return ed.verify(ed.sign(msg, hexToBytes(keys.privateKeyHex)), msg, hexToBytes(keys.publicKeyHex));
}
