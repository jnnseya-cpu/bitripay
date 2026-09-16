/**
 * Nothing external needs an API key, except the assistant functions:
 *  - a bill is paid from a prefunded BitriPay payout SIM and settles only on the operator's confirmation (or maker-checker);
 *    the customer's money stays held until then and comes back if the payment fails;
 *  - a mobile top-up is an airtime purchase from any SIM of the country, the operator's own first;
 *  - outbound SMS (codes, receipts) leave through an enrolled payout phone's own SIM from a queue, retried three times;
 *  - the official reference rate entered by the treasury counts as a live, fresh rate for go-live.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import request from 'supertest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { setupApp, registerUser, adminToken, checkerToken, fund } from './helpers';
import { ensurePayoutFloat } from '../services/payoutFloat';
import { getSetting, setSetting } from '../services/settings';
import { sendSms, listSmsOutbox, smsOutboxSummary } from '../services/messaging';
import { channelStatus } from '../services/comms/engine';
import { rateFreshness, listCurrencies } from '../services/currencies';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});
afterEach(() => {
  setSetting('sms', { provider: 'console' });
});

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey };
}
const deviceHeaders = (pk: import('node:crypto').KeyObject, deviceId: string, method: string, path: string) => {
  const ts = new Date().toISOString();
  return { 'X-Device-Id': deviceId, 'X-Device-Timestamp': ts, 'X-Device-Signature': sign(null, Buffer.from([deviceId, ts, method, path].join('\n')), pk).toString('base64') };
};

/** The home market: CDF enabled, the DRC billers and operators, a customer in Kinshasa funded in CDF. */
async function drcCustomer(cdf: string) {
  const admin = await adminToken(app);
  const cur = (await request(app).get('/api/admin/currencies').set(admin.auth)).body.items.find((x: any) => x.code === 'CDF');
  await request(app)
    .put('/api/admin/currencies/CDF')
    .set(admin.auth)
    .send({ ...cur, enabled: true });
  const { ensureDrcCatalogs } = await import('../seedDefaults');
  ensureDrcCatalogs();
  const a = await registerUser(app, { country: 'CD', phone: `+24381${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}` });
  await fund(app, a.user.id, cdf, 'CDF');
  return { admin, a };
}

async function approve(verificationId: string) {
  const checker = await checkerToken(app);
  const ok = await request(app).post(`/api/admin/verifications/${verificationId}/approve`).set(checker.auth).send({ pin: checker.pin });
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  return ok.body;
}

describe('bills and top-ups through the payout SIM (no biller or operator API)', () => {
  it('holds the customer money, queues a bill instruction on a prefunded SIM of the country and completes it on settlement', async () => {
    const { admin, a } = await drcCustomer('100000'); // 100 000 CDF
    const billers = await request(app).get('/api/bills/billers?country=CD').set(a.auth);
    const snel = billers.body.items.find((b: any) => b.id === 'drc_snel');
    expect(snel.currency).toBe('CDF');
    // no prefunded SIM yet: accepted, but waiting for liquidity
    const waiting = await request(app).post('/api/bills').set(a.auth).send({ billerId: snel.id, accountNumber: 'METER-77', amount: '20000', pin: '1234' });
    expect(waiting.status, JSON.stringify(waiting.body)).toBe(201);
    expect(waiting.body.status).toBe('processing');
    expect(waiting.body.payoutId).toBeTruthy();
    expect(waiting.body.transaction.status).toBe('pending');
    expect(waiting.body.transaction.amount).toBe(2_000_000);
    const w1 = await request(app).get(`/api/admin/payouts/${waiting.body.payoutId}`).set(admin.auth);
    expect(w1.body.payout.rail).toBe('bill');
    expect(w1.body.payout.stage).toBe('INSUFFICIENT_LIQUIDITY');

    // a prefunded Orange Money SIM in the DRC (any operator qualifies for a bill) releases it
    const sim = ensurePayoutFloat({ operatorId: 'orange_cd', msisdn: '+243990000701', amountMinor: 100_000_000 });
    expect(sim.requeued).toBe(1);
    const w2 = await request(app).get(`/api/admin/payouts/${waiting.body.payoutId}`).set(admin.auth);
    expect(w2.body.payout.stage).toBe('QUEUED');
    expect(w2.body.payout.payoutAccountId).toBe(sim.account.id);
    expect(w2.body.payout.instructions.steps.join(' ')).toContain('SNEL');
    expect(w2.body.payout.instructions.steps.join(' ')).toContain('METER-77');

    // the money is held, not gone: wallet shows the hold, the bill row is processing
    const before = await request(app).get('/api/wallets').set(a.auth);
    const cdfWallet = (r: any) => r.body.items.find((w: any) => w.currency === 'CDF');
    expect(cdfWallet(before).balance).toBe(10_000_000 - 2_000_000 - waiting.body.transaction.fee);
    const mine = await request(app).get('/api/bills').set(a.auth);
    expect(mine.body.items[0].status).toBe('processing');

    // settled by maker-checker on the operator's receipt → completed and the customer is told
    const proposed = await request(app)
      .post(`/api/admin/payouts/${waiting.body.payoutId}/settle`)
      .set(admin.auth)
      .send({ externalRef: 'BILL-OP-000123', note: 'Operator confirmation SMS matched on the payout phone' });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
    await approve(proposed.body.verification.id);
    const done = await request(app).get('/api/bills').set(a.auth);
    expect(done.body.items[0].status).toBe('completed');
    const tx = await request(app).get(`/api/wallets/transactions/${waiting.body.transaction.id}`).set(a.auth);
    expect(tx.body.transaction.status).toBe('completed');
    const notes = await request(app).get('/api/account/notifications').set(a.auth);
    const titles = notes.body.items.map((n: any) => n.title);
    expect(titles).toContain('Bill payment accepted');
    expect(titles).toContain('Bill paid');
    // the SIM float was debited by the bill amount
    const acc = await request(app).get(`/api/admin/liquidity`).set(admin.auth);
    expect(acc.body.items.find((x: any) => x.id === sim.account.id).balance).toBe(100_000_000 - 2_000_000);
  });

  it('returns the held money and marks the bill failed when the payout fails', async () => {
    const admin = await adminToken(app);
    const a = await registerUser(app);
    await fund(app, a.user.id, '50.00');
    const billers = await request(app).get('/api/bills/billers').set(a.auth);
    const usd = billers.body.items.find((b: any) => b.currency === 'USD');
    const bill = await request(app).post('/api/bills').set(a.auth).send({ billerId: usd.id, accountNumber: 'METER-78', amount: '10.00', pin: '1234' });
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    const failed = await request(app).post(`/api/admin/payouts/${bill.body.payoutId}/fail`).set(admin.auth).send({ reason: 'Biller menu refused the meter number' });
    expect(failed.status, JSON.stringify(failed.body)).toBe(200);
    await approve(failed.body.verification.id);
    const mine = await request(app).get('/api/bills').set(a.auth);
    expect(mine.body.items[0].status).toBe('failed');
    const wallet = await request(app).get('/api/wallets').set(a.auth);
    expect(wallet.body.items[0].balance).toBe(5_000);
    const notes = await request(app).get('/api/account/notifications').set(a.auth);
    expect(notes.body.items.map((n: any) => n.title)).toContain('Bill payment failed');
  });

  it('buys airtime from the payout SIM: rail airtime, operator name in the instructions, completed on settlement', async () => {
    const { admin, a } = await drcCustomer('200000'); // 200 000 CDF
    const ops = await request(app).get('/api/topups/operators?country=CD').set(a.auth);
    const op = ops.body.items.find((o: any) => o.id === 'drc_orange');
    expect(op.currency).toBe('CDF');
    const top = await request(app).post('/api/topups').set(a.auth).send({ operatorId: op.id, phone: '+243812223344', amount: '50000', pin: '1234' });
    expect(top.status, JSON.stringify(top.body)).toBe(201);
    expect(top.body.status).toBe('processing');
    expect(top.body.payoutId).toBeTruthy();
    const p = await request(app).get(`/api/admin/payouts/${top.body.payoutId}`).set(admin.auth);
    expect(p.body.payout.rail).toBe('airtime');
    expect(p.body.payout.recipientMsisdn).toBe('+243812223344');
    if (p.body.payout.stage === 'INSUFFICIENT_LIQUIDITY') expect(ensurePayoutFloat({ operatorId: 'orange_cd', msisdn: '+243990000701', amountMinor: 100_000_000 }).requeued).toBeGreaterThanOrEqual(1);
    const queued = await request(app).get(`/api/admin/payouts/${top.body.payoutId}`).set(admin.auth);
    expect(queued.body.payout.stage).toBe('QUEUED');
    expect(queued.body.payout.instructions.steps.join(' ')).toContain('Orange');
    expect(queued.body.payout.instructions.steps.join(' ')).toContain('+243812223344');
    const proposed = await request(app)
      .post(`/api/admin/payouts/${top.body.payoutId}/settle`)
      .set(admin.auth)
      .send({ externalRef: 'AIRTIME-000456', note: 'Operator confirmation SMS matched on the payout phone' });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
    await approve(proposed.body.verification.id);
    const mine = await request(app).get('/api/topups').set(a.auth);
    expect(mine.body.items[0].status).toBe('completed');
    const notes = await request(app).get('/api/account/notifications').set(a.auth);
    const titles = notes.body.items.map((n: any) => n.title);
    expect(titles).toContain('Top-up accepted');
    expect(titles).toContain('Top-up successful');
  });
});

describe('SMS from an enrolled phone SIM (no SMS API)', () => {
  it('queues messages for the payout device, hands them out signed, retries a failure three times and reports to the console', async () => {
    const admin = await adminToken(app);
    // without any payout device the channel is honest about it
    setSetting('sms', { provider: 'device' });
    expect(channelStatus().sms.wired).toBe(false);
    expect(channelStatus().sms.detail).toContain('no active payout device');

    const agent = await registerUser(app, { role: 'agent', businessName: 'SMS Point', country: 'CD', phone: '+243817000001' });
    const { getDb } = await import('../db');
    getDb().prepare("UPDATE users SET kyc_status = 'verified' WHERE id = ?").run(agent.user.id);
    const acc = await request(app).post('/api/admin/liquidity/accounts').set(admin.auth).send({
      rail: 'mobile_money',
      operatorId: 'orange_cd',
      country: 'CD',
      currency: 'CDF',
      label: 'Orange SIM (SMS)',
      msisdn: '+243890000900',
      simIccid: '8924300000000000900',
      agentUserId: agent.user.id,
    });
    expect(acc.status, JSON.stringify(acc.body)).toBe(201);
    const k = keys();
    const dev = await request(app)
      .post('/api/admin/evidence/devices')
      .set(admin.auth)
      .send({
        name: 'Payout phone (SMS sender)',
        publicKey: k.pem,
        operatorIds: ['orange_cd'],
        kind: 'payout',
        simMsisdn: '+243890000900',
        simIccid: '8924300000000000900',
        agentUserId: agent.user.id,
        payoutAccountId: acc.body.account.id,
      });
    expect(dev.status, JSON.stringify(dev.body)).toBe(201);
    const deviceId = dev.body.device.id as string;
    expect(channelStatus().sms).toEqual({ wired: true, detail: 'Enrolled phone SIM (1 payout device, no SMS API key)' });

    // a code is queued, not sent by any API
    const r = await sendSms('+243810000777', 'Your BitriPay code is 246810');
    expect(r).toEqual({ delivered: true, via: 'device' });
    expect(listSmsOutbox({ status: 'queued' }).some((m) => m.to === '+243810000777')).toBe(true);

    // a device without a valid signature gets nothing
    const bad = await request(app).get('/api/payouts/device/sms-outbox').set({ 'X-Device-Id': deviceId, 'X-Device-Timestamp': new Date().toISOString(), 'X-Device-Signature': 'AAAA' });
    expect(bad.status).toBe(401);
    const claim = await request(app)
      .get('/api/payouts/device/sms-outbox')
      .set(deviceHeaders(k.privateKey, deviceId, 'GET', '/api/payouts/device/sms-outbox'));
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);
    const msg = claim.body.items.find((m: any) => m.to === '+243810000777');
    expect(msg.status).toBe('sending');
    expect(msg.body).toContain('246810');
    // claimed messages are not handed out twice
    const again = await request(app)
      .get('/api/payouts/device/sms-outbox')
      .set(deviceHeaders(k.privateKey, deviceId, 'GET', '/api/payouts/device/sms-outbox'));
    expect(again.body.items.find((m: any) => m.id === msg.id)).toBeUndefined();

    // two failures go back to the queue, the third marks it failed
    for (let i = 1; i <= 3; i++) {
      const re = await request(app)
        .get('/api/payouts/device/sms-outbox')
        .set(deviceHeaders(k.privateKey, deviceId, 'GET', '/api/payouts/device/sms-outbox'));
      const item = i === 1 ? msg : re.body.items.find((m: any) => m.id === msg.id);
      expect(item, `attempt ${i}`).toBeTruthy();
      const rep = await request(app)
        .post(`/api/payouts/device/sms-outbox/${msg.id}`)
        .set(deviceHeaders(k.privateKey, deviceId, 'POST', `/api/payouts/device/sms-outbox/${msg.id}`))
        .send({ ok: false, error: 'RESULT_ERROR_NO_SERVICE' });
      expect(rep.status, JSON.stringify(rep.body)).toBe(200);
      expect(rep.body.message.status).toBe(i < 3 ? 'queued' : 'failed');
      expect(rep.body.message.attempts).toBe(i);
    }
    expect(listSmsOutbox({ status: 'failed' }).map((m) => m.id)).toContain(msg.id);

    // a successful send is recorded with its time
    await sendSms('+243810000778', 'Receipt BILL-1 paid');
    const c2 = await request(app)
      .get('/api/payouts/device/sms-outbox')
      .set(deviceHeaders(k.privateKey, deviceId, 'GET', '/api/payouts/device/sms-outbox'));
    const m2 = c2.body.items.find((m: any) => m.to === '+243810000778');
    const sent = await request(app)
      .post(`/api/payouts/device/sms-outbox/${m2.id}`)
      .set(deviceHeaders(k.privateKey, deviceId, 'POST', `/api/payouts/device/sms-outbox/${m2.id}`))
      .send({ ok: true });
    expect(sent.body.message.status).toBe('sent');
    expect(sent.body.message.sentAt).toBeTruthy();
    const summary = smsOutboxSummary();
    expect(summary.sent24h).toBeGreaterThanOrEqual(1);
    expect(summary.failed).toBeGreaterThanOrEqual(1);
    const console_ = await request(app).get('/api/admin/messaging/sms-outbox').set(admin.auth);
    expect(console_.status).toBe(200);
    expect(console_.body.summary.sent24h).toBe(summary.sent24h);
    expect(console_.body.items.some((m: any) => m.id === m2.id && m.status === 'sent')).toBe(true);
  });
});

describe('official reference rate entered by the treasury (no rate API)', () => {
  it('counts as live and fresh for the go-live checklist once every enabled currency carries it', async () => {
    const admin = await adminToken(app);
    const before = rateFreshness();
    expect(before.live).toBe(false); // bundled test rates
    for (const c of listCurrencies(true).filter((x) => !x.isBase)) {
      const put = await request(app)
        .put(`/api/admin/currencies/${c.code}`)
        .set(admin.auth)
        .send({ name: c.name, symbol: c.symbol, decimals: c.decimals, rateToBase: c.rateToBase * 1.01, enabled: true, sortOrder: c.sortOrder });
      expect(put.status, JSON.stringify(put.body)).toBe(200);
    }
    const after = rateFreshness();
    expect(after).toMatchObject({ live: true, fresh: true, manual: true, source: 'manual' });
    const goLive = await request(app).get('/api/admin/go-live').set(admin.auth);
    const rates = goLive.body.items.find((i: any) => i.id === 'rates');
    expect(rates.ok, JSON.stringify(rates)).toBe(true);
    expect(rates.label).toContain('official reference rate');
    // the app settings do not need a rate provider key for that
    expect(getSetting<any>('app', {}).rateProviderKey ?? '').toBe('');
  });
});
