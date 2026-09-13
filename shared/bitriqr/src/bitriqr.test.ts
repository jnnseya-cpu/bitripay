import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify as nodeVerify } from 'node:crypto';
import { crc16, encodeUnsigned, encodeSigned, decode, verify, railsToMask, maskToRails, isBitriQr, intentUri, parseIntentUri } from './index.ts';

// EMVCo reference vector: the CRC of the well-known sample payload prefix.
test('crc16 ccitt-false matches the EMVCo reference', () => {
  assert.equal(crc16('123456789'), '29B1');
});

test('rails mask round-trips', () => {
  const m = railsToMask(['wallet', 'mpesa', 'airtel', 'orange', 'card']);
  assert.equal(m, 0x1f);
  assert.deepEqual(maskToRails(m), ['wallet', 'mpesa', 'airtel', 'orange', 'card']);
});

const merchant = { merchantId: 'BMRC-7F3K9Q', rails: ['wallet', 'mpesa', 'airtel', 'orange', 'card'] as any, mcc: '5411', currency: 'CDF', country: 'CD', merchantName: 'PHARMACIE LIMETE', city: 'KINSHASA' };

test('static unsigned QR encodes, decodes and carries basic trust', async () => {
  const payload = encodeUnsigned({ mode: 'static', ...merchant });
  assert.ok(payload.startsWith('000201'));
  assert.ok(payload.includes('0111')); // static point of initiation
  assert.ok(isBitriQr(payload));
  const d = decode(payload);
  assert.equal(d.mode, 'static');
  assert.equal(d.merchantId, 'BMRC-7F3K9Q');
  assert.equal(d.currency, 'CDF');
  assert.equal(d.amount, null);
  assert.equal(d.crcValid, true);
  assert.equal(d.signed, false);
  const v = await verify(d, () => true);
  assert.deepEqual(v, { valid: true, trust: 'basic', reasons: [] });
});

test('dynamic signed QR verifies with the merchant key and fails when tampered', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const exp = Math.floor(Date.now() / 1000) + 300;
  const payload = await encodeSigned({ mode: 'dynamic', ...merchant, amount: '25000', intentRef: 'pi_9f3k', billRef: 'INV-2026-0912', purposeCode: 'HEALTH', keyId: 'a1b2c3d4', expiresAt: exp }, (p) => new Uint8Array(sign(null, Buffer.from(p), privateKey)));
  const d = decode(payload);
  assert.equal(d.mode, 'dynamic');
  assert.equal(d.amount, '25000');
  assert.equal(d.intentRef, 'pi_9f3k');
  assert.equal(d.purposeCode, 'HEALTH');
  assert.equal(d.keyId, 'a1b2c3d4');
  assert.equal(d.expiresAt, exp);
  assert.equal(d.signed, true);
  const verifier = (p: string, s: Uint8Array) => nodeVerify(null, Buffer.from(p), publicKey, Buffer.from(s));
  const ok = await verify(d, verifier);
  assert.deepEqual(ok, { valid: true, trust: 'verified', reasons: [] });
  // change the amount: CRC and signature both fail
  const tampered = payload.replace('540525000', '540599000');
  const dt = decode(tampered);
  const bad = await verify(dt, verifier);
  assert.equal(bad.valid, false);
  assert.ok(bad.reasons.includes('crc_mismatch'));
  // a valid-looking CRC over tampered content still fails the signature
  const body = tampered.slice(0, tampered.length - 4);
  const reCrc = body + crc16(body);
  const dr = decode(reCrc);
  const bad2 = await verify(dr, verifier);
  assert.deepEqual(bad2.reasons, ['bad_signature']);
  // expired
  const late = await verify(d, verifier, exp + 10);
  assert.deepEqual(late.reasons, ['expired']);
});

test('dynamic codes must be signed and need amount and expiry', async () => {
  assert.throws(() => encodeUnsigned({ mode: 'dynamic', ...merchant } as any), /amount/);
  const unsignedDynamic = encodeUnsigned({ mode: 'dynamic', ...merchant, amount: '10', expiresAt: Math.floor(Date.now() / 1000) + 60 });
  const v = await verify(decode(unsignedDynamic), () => true);
  assert.deepEqual(v.reasons, ['dynamic_unsigned']);
});

test('intent URIs', () => {
  assert.equal(intentUri('pi_01J'), 'bitripay://pay/pi_01J');
  assert.equal(parseIntentUri('bitripay://pay/pi_01J?x=1'), 'pi_01J');
  assert.equal(parseIntentUri('https://example.com'), null);
});
