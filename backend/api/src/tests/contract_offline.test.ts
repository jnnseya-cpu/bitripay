/**
 * Offline payment lifecycle (specification §28): OFFLINE_CREATED → OFFLINE_ACCEPTED_LOCALLY → SYNC_PENDING →
 * ONLINE_VALIDATING → CONFIRMED | REJECTED, "Pending confirmation" receipts until the platform confirms, and
 * counter-gap evidence when a device skips promise counters.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { setupApp, registerUser, fund } from './helpers';
import { promiseCanonical, OFFLINE_STATES, offlineLifecycle, PENDING_CONFIRMATION_TEXT } from '../services/offline';
import { getDb } from '../db';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});
const deviceKey = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    sign: (payload: string) => Buffer.from(nodeSign(null, Buffer.from(payload), privateKey)).toString('base64'),
  };
};

describe('offline lifecycle §28', () => {
  it('exposes the lifecycle states and the pending-confirmation wording', async () => {
    expect([...OFFLINE_STATES]).toEqual(['OFFLINE_CREATED', 'OFFLINE_ACCEPTED_LOCALLY', 'SYNC_PENDING', 'ONLINE_VALIDATING', 'CONFIRMED', 'REJECTED']);
    expect(offlineLifecycle('SETTLED')).toBe('CONFIRMED');
    expect(offlineLifecycle('REJECTED')).toBe('REJECTED');
    expect(offlineLifecycle('PENDING_SYNC')).toBe('SYNC_PENDING');
    const m = await registerUser(app, { role: 'merchant', businessName: 'Kiosk §28', country: 'CD' });
    const settings = await request(app).get('/api/v1/offline/settings').set(m.auth);
    expect(settings.body.lifecycle).toEqual([...OFFLINE_STATES]);
    expect(settings.body.pendingConfirmationText).toMatch(/^Pending confirmation/);
    const qr = await request(app).post('/api/v1/offline/qr').set(m.auth).send({ amount: '4.00', currency: 'USD' });
    expect(qr.status, JSON.stringify(qr.body)).toBe(201);
    expect(qr.body.lifecycle).toBe('OFFLINE_CREATED');
    expect(qr.body.receipt).toEqual({ status: 'PENDING_CONFIRMATION', text: PENDING_CONFIRMATION_TEXT });
  });

  it('confirms in order, reports the lifecycle on every outcome and records counter gaps without refusing the money', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Kiosk Gaps', country: 'CD' });
    const payer = await registerUser(app);
    await fund(app, payer.user.id, '100.00');
    const mk = deviceKey();
    const pk = deviceKey();
    const mDev = await request(app).post('/api/v1/offline/devices').set(m.auth).send({ deviceId: 'kiosk-gap-01', publicKey: mk.publicKey });
    const pDev = await request(app).post('/api/v1/offline/devices').set(payer.auth).send({ deviceId: 'payer-gap-01', publicKey: pk.publicKey });
    expect(pDev.status, JSON.stringify(pDev.body)).toBe(201);
    expect(pDev.body.counterGaps).toBe(0);
    const nonces = (await request(app).post('/api/v1/offline/nonces').set(m.auth).send({ count: 4 })).body.data as { nonce: string; expiresAt: string }[];
    const promise = (counter: number, n: { nonce: string; expiresAt: string }, amountMinor = 500) => {
      const base = { merchantId: m.user.id, payerId: payer.user.id, amountMinor, currency: 'USD', nonce: n.nonce, expiresAt: n.expiresAt, counter, reference: `C${counter}` };
      const canonical = promiseCanonical(base);
      return {
        ...base,
        payerDeviceId: 'payer-gap-01',
        merchantKeyId: mDev.body.keyId,
        payerKeyId: pDev.body.keyId,
        merchantSig: mk.sign(canonical),
        payerSig: pk.sign(canonical),
        promisedAt: new Date().toISOString(),
      };
    };
    // counter 1 then counter 3: the gap (2) is evidence, not a refusal
    const sync = await request(app)
      .post('/api/v1/offline/sync')
      .set(payer.auth)
      .send({ promises: [promise(1, nonces[0]), promise(3, nonces[1])] });
    expect(sync.status, JSON.stringify(sync.body)).toBe(200);
    expect(sync.body.results.map((r: any) => r.lifecycle)).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect(sync.body.results[0].counterGap ?? null).toBeNull();
    expect(sync.body.results[1].counterGap).toEqual({ expected: 2, received: 3 });
    expect(sync.body.settled).toBe(2);
    // the gap is visible on the device and through the gaps endpoint
    const devices = await request(app).get('/api/v1/offline/devices').set(payer.auth);
    expect(devices.body.data.find((d: any) => d.deviceId === 'payer-gap-01').counterGaps).toBe(1);
    const gaps = await request(app).get('/api/v1/offline/devices/payer-gap-01/gaps').set(payer.auth);
    expect(gaps.status).toBe(200);
    expect(gaps.body.data[0]).toMatchObject({ deviceId: 'payer-gap-01', expected: 2, received: 3 });
    expect((await request(app).get('/api/v1/offline/devices/payer-gap-01/gaps').set(m.auth)).status).toBe(404); // not the merchant's device
    // a rejected promise carries lifecycle REJECTED; a replay carries CONFIRMED (already settled)
    const rejected = await request(app)
      .post('/api/v1/offline/sync')
      .set(payer.auth)
      .send({ promises: [promise(2, nonces[2])] });
    expect(rejected.body.results[0]).toMatchObject({ state: 'REJECTED', lifecycle: 'REJECTED', reason: 'counter_not_monotonic' });
    const replay = await request(app)
      .post('/api/v1/offline/sync')
      .set(payer.auth)
      .send({ promises: [promise(1, nonces[0])] });
    expect(replay.body.results[0]).toMatchObject({ state: 'DUPLICATE', lifecycle: 'CONFIRMED' });
    // the promise list shows the lifecycle next to the stored state
    const list = await request(app).get('/api/v1/offline/promises').set(payer.auth);
    expect(list.body.data.every((p: any) => ['CONFIRMED', 'REJECTED'].includes(p.lifecycle))).toBe(true);
    expect((getDb().prepare('SELECT COUNT(*) c FROM offline_counter_gaps').get() as any).c).toBe(1);
  });
});
