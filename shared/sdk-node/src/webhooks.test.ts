import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Webhooks, BitriPay } from './index.ts';

test('verifies a BitriPay-Signature header and rejects tampering', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const ev = Webhooks.verify(body, `t=${t},v1=${v1}`, secret);
  assert.equal(ev.type, 'payment_intent.succeeded');
  assert.throws(() => Webhooks.verify(body + ' ', `t=${t},v1=${v1}`, secret), /does not match/);
  assert.throws(() => Webhooks.verify(body, `t=${t - 1000},v1=${v1}`, secret), /tolerance/);
});
test('sends the key, idempotency header and raises typed errors', async () => {
  const calls: any[] = [];
  const f = (async (url: any, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ error: { code: 'insufficient_funds', bp: 'BP-3001', message: 'Insufficient balance' } }), { status: 422, headers: { 'content-type': 'application/json' } }); }) as any;
  const bp = new BitriPay({ apiKey: 'sk_test_x', baseUrl: 'http://localhost:4000', fetch: f });
  await assert.rejects(() => bp.paymentIntents.create({ amount_minor: 100, currency: 'USD' }, { idempotencyKey: 'k1' }), (e: any) => e.code === 'insufficient_funds' && e.bp === 'BP-3001' && e.status === 422);
  assert.equal(calls[0].url, 'http://localhost:4000/v1/payment_intents');
  assert.equal(calls[0].init.headers['idempotency-key'], 'k1');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk_test_x');
});
