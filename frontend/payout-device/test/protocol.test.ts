/**
 * Interop test: the device protocol (pure TS, @noble) must produce signatures that Node's WebCrypto/crypto Ed25519
 * verifier – the same one the BitriPay API uses – accepts, over exactly the canonical strings the API rebuilds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomBytes as nodeRandom, verify as cryptoVerify } from 'node:crypto';
import { buildEvidence, evidenceCanonical, generateDeviceKeys, publicKeyToPem, randomNonce, selfTest, sha256Hex, signRequest } from '../src/protocol';
import { hexToBytes } from '@noble/hashes/utils';

const rb = (n: number) => new Uint8Array(nodeRandom(n));
const b64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

test('generated key pair is Ed25519, self-tests and exports a SPKI PEM Node can parse', () => {
  const keys = generateDeviceKeys(rb);
  assert.equal(keys.privateKeyHex.length, 64);
  assert.equal(keys.publicKeyHex.length, 64);
  assert.ok(selfTest(keys));
  const ko = createPublicKey(keys.publicKeyPem);
  assert.equal(ko.asymmetricKeyType, 'ed25519');
  // PEM re-derived from the raw key must match the exported one byte for byte
  assert.equal(publicKeyToPem(hexToBytes(keys.publicKeyHex)), keys.publicKeyPem);
  assert.equal(ko.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'), keys.publicKeyHex);
});

test('request headers verify against the API canonical `deviceId\\ntimestamp\\nMETHOD\\npath`', () => {
  const keys = generateDeviceKeys(rb);
  const pub = createPublicKey(keys.publicKeyPem);
  const deviceId = 'dev_' + randomNonce(rb);
  const h = signRequest(keys.privateKeyHex, deviceId, 'get', '/api/payouts/device/queue');
  assert.equal(h['X-Device-Id'], deviceId);
  assert.ok(!Number.isNaN(Date.parse(h['X-Device-Timestamp'])));
  const canonical = [deviceId, h['X-Device-Timestamp'], 'GET', '/api/payouts/device/queue'].join('\n');
  assert.ok(cryptoVerify(null, Buffer.from(canonical), pub, b64(h['X-Device-Signature'])));
  // a different path (e.g. another payout id) must not verify with the same signature
  assert.ok(!cryptoVerify(null, Buffer.from([deviceId, h['X-Device-Timestamp'], 'GET', '/api/payouts/device/queue?x=1'].join('\n')), pub, b64(h['X-Device-Signature'])));
});

test('evidence payload verifies, hashes the text and cannot be altered', () => {
  const keys = generateDeviceKeys(rb);
  const pub = createPublicKey(keys.publicKeyPem);
  const fields = {
    deviceId: 'dev_' + randomNonce(rb),
    nonce: randomNonce(rb),
    receivedAt: new Date().toISOString(),
    from: 'OrangeMoney',
    operatorId: 'orange_cd',
    text: 'Vous avez envoye 25000 CDF a 0899000001. Ref: PP7X9K2. Frais: 250 CDF. Nouveau solde: 1,200,000 CDF.',
  };
  const ev = buildEvidence(keys.privateKeyHex, fields, { simIdentity: '+243890000100' });
  const serverCanonical = [ev.deviceId, ev.nonce, ev.receivedAt, ev.from, ev.operatorId ?? '', ev.text].join('\n');
  assert.equal(evidenceCanonical(fields), serverCanonical);
  assert.ok(cryptoVerify(null, Buffer.from(serverCanonical), pub, b64(ev.signature)));
  assert.equal(ev.clientHash, createHash('sha256').update(ev.text).digest('hex'));
  assert.equal(sha256Hex(ev.text), ev.clientHash);
  assert.equal(ev.simIdentity, '+243890000100');
  assert.ok(!Number.isNaN(Date.parse(ev.deviceTimestamp)));
  // tampering with the amount in transit breaks the signature
  const tampered = serverCanonical.replace('25000', '250000');
  assert.ok(!cryptoVerify(null, Buffer.from(tampered), pub, b64(ev.signature)));
  // a null operator signs as an empty field, exactly as the API rebuilds it
  const ev2 = buildEvidence(keys.privateKeyHex, { ...fields, operatorId: null });
  assert.ok(cryptoVerify(null, Buffer.from([ev2.deviceId, ev2.nonce, ev2.receivedAt, ev2.from, '', ev2.text].join('\n')), pub, b64(ev2.signature)));
  assert.equal(ev2.operatorId, null);
});

test('nonces are unique per message', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) seen.add(randomNonce(rb));
  assert.equal(seen.size, 500);
});
