import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCheckoutUrl, parseCheckoutMessage, originOf, CHECKOUT_MESSAGE_TYPE, BitriPay } from './index.ts';

test('buildCheckoutUrl: full URL is kept, embed adds embed=1 and the encoded origin after existing query parameters', () => {
  const url = 'https://pay.example.com/pay/ABCD1234?cs=cs_abc123';
  assert.equal(buildCheckoutUrl({ url }), url);
  assert.equal(buildCheckoutUrl({ url, embed: true, origin: 'https://shop.example:8443' }), `${url}&embed=1&origin=${encodeURIComponent('https://shop.example:8443')}`);
  assert.equal(
    buildCheckoutUrl({ url: 'https://pay.example.com/pay/ABCD1234', embed: true, origin: 'https://shop.example', locale: 'fr' }),
    'https://pay.example.com/pay/ABCD1234?embed=1&origin=https%3A%2F%2Fshop.example&locale=fr',
  );
  // a fragment stays at the end
  assert.equal(buildCheckoutUrl({ url: 'https://pay.example.com/pay/X1#top', embed: true, origin: 'https://a.b' }), 'https://pay.example.com/pay/X1?embed=1&origin=https%3A%2F%2Fa.b#top');
});

test('buildCheckoutUrl: session id + apiBase resolves to /checkout/<id>; bad input throws', () => {
  assert.equal(buildCheckoutUrl({ sessionId: 'cs_abc123', apiBase: 'https://pay.example.com/' }), 'https://pay.example.com/checkout/cs_abc123');
  assert.throws(() => buildCheckoutUrl({ sessionId: 'cs_abc123' }), /apiBase is required/);
  assert.throws(() => buildCheckoutUrl({ sessionId: 'pi_123', apiBase: 'https://pay.example.com' }), /checkout session id/);
  assert.throws(() => buildCheckoutUrl({}), /url or sessionId/);
  assert.throws(() => buildCheckoutUrl({ url: '/pay/relative' }), /absolute/);
});

test('originOf extracts scheme://host[:port]', () => {
  assert.equal(originOf('https://Pay.Example.com:8443/pay/x?y=1'), 'https://pay.example.com:8443');
  assert.equal(originOf('http://localhost:5173/checkout/cs_1'), 'http://localhost:5173');
  assert.equal(originOf('mailto:x@y'), null);
});

test('parseCheckoutMessage accepts a well-formed message from the expected origin only', () => {
  const data = { type: CHECKOUT_MESSAGE_TYPE, status: 'succeeded', sessionId: 'cs_abc', paymentIntentId: 'pi_1' };
  const ok = parseCheckoutMessage({ origin: 'https://pay.example.com', data }, 'https://pay.example.com');
  assert.deepEqual(ok, { type: 'bitripay:checkout', status: 'succeeded', sessionId: 'cs_abc', paymentIntentId: 'pi_1' });
  // origin comparison is case-insensitive but exact
  assert.ok(parseCheckoutMessage({ origin: 'https://PAY.example.com', data }, 'https://pay.example.com'));
  assert.equal(parseCheckoutMessage({ origin: 'https://evil.example.com', data }, 'https://pay.example.com'), null);
  assert.equal(parseCheckoutMessage({ origin: 'https://pay.example.com.evil.net', data }, 'https://pay.example.com'), null);
  // JSON strings are accepted; unrelated or malformed messages are ignored
  assert.equal(parseCheckoutMessage({ origin: 'https://pay.example.com', data: JSON.stringify({ ...data, status: 'closed', sessionId: '' }) }, 'https://pay.example.com')?.status, 'closed');
  assert.equal(parseCheckoutMessage({ origin: 'https://pay.example.com', data: JSON.stringify({ ...data, sessionId: '' }) }, 'https://pay.example.com')?.sessionId, null);
  assert.equal(parseCheckoutMessage({ origin: 'https://pay.example.com', data: 'not json' }, 'https://pay.example.com'), null);
  assert.equal(parseCheckoutMessage({ origin: 'https://pay.example.com', data: { type: 'other', status: 'succeeded' } }, 'https://pay.example.com'), null);
  assert.equal(parseCheckoutMessage({ origin: 'https://pay.example.com', data: { type: CHECKOUT_MESSAGE_TYPE, status: 'maybe' } }, 'https://pay.example.com'), null);
  assert.equal(parseCheckoutMessage({ data }, 'https://pay.example.com'), null);
});

test('the BitriPay namespace exposes the browser entry points', () => {
  assert.equal(typeof BitriPay.checkout, 'function');
  assert.equal(typeof BitriPay.mountPayButton, 'function');
  assert.equal(BitriPay.buildCheckoutUrl, buildCheckoutUrl);
  // no window in node: checkout refuses instead of crashing
  assert.throws(() => BitriPay.checkout({ url: 'https://pay.example.com/pay/x' }), /browser window/);
});
