import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMinor, fromMinor, formatMoney, convertMinor, applyBps } from './money.ts';
import { encodeQr, decodeQr, encodeQrLink } from './qr.ts';
import { luhnCheck, luhnCheckDigit, detectCardBrand, isExpiryValid } from './cards.ts';

test('money conversion round trips', () => {
  assert.equal(toMinor('12.50', 2), 1250);
  assert.equal(toMinor('12', 2), 1200);
  assert.equal(toMinor('1,000.5', 2), 100050);
  assert.equal(toMinor('150', 0), 150);
  assert.throws(() => toMinor('12.505', 2));
  assert.throws(() => toMinor('abc', 2));
  assert.equal(fromMinor(1250, 2), '12.50');
  assert.equal(fromMinor(5, 2), '0.05');
  assert.equal(fromMinor(-1250, 2), '-12.50');
  assert.equal(fromMinor(150, 0), '150');
  assert.equal(formatMoney(123456789, { code: 'USD', symbol: '$', decimals: 2 }), '$1,234,567.89');
  assert.equal(applyBps(10000, 150), 150);
});

test('currency conversion', () => {
  const usd = { code: 'USD', name: '', symbol: '$', decimals: 2, rateToBase: 1 };
  const ngn = { code: 'NGN', name: '', symbol: '₦', decimals: 2, rateToBase: 1500 };
  assert.equal(convertMinor(100, usd, ngn), 150000);
  assert.equal(convertMinor(150000, ngn, usd), 100);
});

test('qr codec', () => {
  const p = { type: 'pr' as const, id: 'ABC123', amount: '10.00', currency: 'USD', note: 'Coffee' };
  const encoded = encodeQr(p);
  assert.ok(encoded.startsWith('bitripay://pay?'));
  assert.deepEqual(decodeQr(encoded), p);
  const link = encodeQrLink({ type: 'u', id: 'alice' }, 'https://pay.example.com/');
  assert.equal(link, 'https://pay.example.com/q?v=1&t=u&id=alice');
  assert.deepEqual(decodeQr(link), { type: 'u', id: 'alice' });
  assert.deepEqual(decodeQr('https://pay.example.com/pay/XYZ'), { type: 'pr', id: 'XYZ' });
  assert.deepEqual(decodeQr('@Alice'), { type: 'u', id: 'alice' });
  assert.equal(decodeQr('https://google.com'), null);
  assert.equal(decodeQr('hello'), null);
});

test('card helpers', () => {
  assert.ok(luhnCheck('4242424242424242'));
  assert.ok(!luhnCheck('4242424242424241'));
  const partial = '627311000000001';
  assert.ok(luhnCheck(partial + luhnCheckDigit(partial)));
  assert.equal(detectCardBrand('4242424242424242'), 'visa');
  assert.equal(detectCardBrand('5555555555554444'), 'mastercard');
  assert.equal(detectCardBrand('378282246310005'), 'amex');
  assert.equal(detectCardBrand('6273110000000012'), 'bitripay');
  assert.ok(isExpiryValid(12, 2099));
  assert.ok(!isExpiryValid(1, 2000));
});
