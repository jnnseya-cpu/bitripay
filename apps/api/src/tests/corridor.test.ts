/**
 * Operating model acceptance: UK debit card → Orange Money DRC, with prefunded liquidity, an approved
 * Android payout device with a merchant SIM, signed operator SMS confirmation and the full route
 * lifecycle – plus the failure modes: no liquidity, unregistered SIM, duplicate confirmation,
 * chargeback exposure hold, compliance gate, refund before payout, chargeback after payout.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { generateKeyPairSync, sign, randomUUID, createHash } from 'node:crypto';
import { setupApp, registerUser, adminToken, checkerToken, fund } from './helpers';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey };
}
const canonical = (f: { deviceId: string; nonce: string; receivedAt: string; from: string; operatorId?: string | null; text: string }) => [f.deviceId, f.nonce, f.receivedAt, f.from, f.operatorId ?? '', f.text].join('\n');
const signEv = (pk: import('node:crypto').KeyObject, f: Parameters<typeof canonical>[0]) => sign(null, Buffer.from(canonical(f)), pk).toString('base64');
const deviceHeaders = (pk: import('node:crypto').KeyObject, deviceId: string, method: string, path: string) => {
  const ts = new Date().toISOString();
  return { 'X-Device-Id': deviceId, 'X-Device-Timestamp': ts, 'X-Device-Signature': sign(null, Buffer.from([deviceId, ts, method, path].join('\n')), pk).toString('base64') };
};

async function corridorSetup() {
  const admin = await adminToken(app);
  const checker = await checkerToken(app);
  // Currency GBP must be enabled for the UK sender; CDF for the DRC recipient.
  for (const code of ['GBP', 'CDF']) {
    const cur = await request(app).get('/api/admin/currencies').set(admin.auth);
    const c = cur.body.items.find((x: any) => x.code === code);
    await request(app).put(`/api/admin/currencies/${code}`).set(admin.auth).send({ ...c, enabled: true });
  }
  const corridor = await request(app).put('/api/admin/corridors/new').set(admin.auth).send({ sourceCountry: 'GB', sourceCurrency: 'GBP', destCountry: 'CD', destCurrency: 'CDF', operatorId: 'orange_cd', rail: 'mobile_money', estimatedPayoutMinutes: 30 });
  expect(corridor.status, JSON.stringify(corridor.body)).toBe(200);
  const agent = await registerUser(app, { role: 'agent', businessName: 'Kinshasa Payout Point', country: 'CD', phone: `+24381${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}` });
  const { getDb } = await import('../db');
  getDb().prepare("UPDATE users SET kyc_status = 'verified' WHERE id = ?").run(agent.user.id);
  // Each scenario gets its own SIM + device; earlier ones are paused so routing is deterministic.
  for (const a of (await request(app).get('/api/admin/liquidity').set(admin.auth)).body.items) await request(app).patch(`/api/admin/liquidity/accounts/${a.id}`).set(admin.auth).send({ status: 'paused' });
  const acc = await request(app).post('/api/admin/liquidity/accounts').set(admin.auth).send({ rail: 'mobile_money', operatorId: 'orange_cd', country: 'CD', currency: 'CDF', label: 'Orange Money DRC SIM 1', msisdn: '+243890000100', simIccid: '8924300000000000100', agentUserId: agent.user.id });
  expect(acc.status, JSON.stringify(acc.body)).toBe(201);
  const k = keys();
  const dev = await request(app).post('/api/admin/evidence/devices').set(admin.auth).send({ name: 'Android payout device Kinshasa', publicKey: k.pem, operatorIds: ['orange_cd'], kind: 'payout', simMsisdn: '+243890000100', simIccid: '8924300000000000100', agentUserId: agent.user.id, payoutAccountId: acc.body.account.id });
  expect(dev.status, JSON.stringify(dev.body)).toBe(201);
  return { admin, checker, agent, accountId: acc.body.account.id as string, deviceId: dev.body.device.id as string, privateKey: k.privateKey, corridorId: corridor.body.corridor.id as string };
}
const card = { number: '4242424242424242', expMonth: 12, expYear: 2030, cvc: '123', holderName: 'Sam Sender' };
/** A KYC-verified UK sender (unverified senders are held before payout by the chargeback-exposure rule). */
async function ukSender() {
  const u = await registerUser(app, { country: 'GB' });
  const { getDb } = await import('../db');
  getDb().prepare("UPDATE users SET kyc_status = 'verified' WHERE id = ?").run(u.user.id);
  return u;
}
async function sendUkToDrc(auth: Record<string, string>, amount = '20', extra: Record<string, unknown> = {}) {
  return request(app).post('/api/money').set(auth).send({ source: { method: 'card', card }, destination: { method: 'mobile_money', operatorId: 'orange_cd', phone: '+243990000123', name: 'Marie Kabila' }, amount, currency: 'GBP', targetCurrency: 'CDF', pin: '1234', ...extra });
}

describe('UK card → Orange Money DRC (sandbox)', () => {
  it('quotes, approves biometrically, funds through the processor, routes to a prefunded SIM, and settles on signed operator evidence', async () => {
    const s = await corridorSetup();
    const sender = await ukSender();
    // 1-2. quote: sender amount, recipient amount, rate, margin, fees, ETA, expiry, refund conditions – and the corridor status.
    const q = await request(app).post('/api/money/preview').set(sender.auth).send({ destination: { method: 'mobile_money', operatorId: 'orange_cd', phone: '+243990000123' }, sourceMethod: 'card', amount: '20', currency: 'GBP', targetCurrency: 'CDF' });
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    expect(q.body.quote.senderAmount).toBe(2000);
    expect(q.body.quote.recipientAmount).toBeGreaterThan(0);
    expect(q.body.quote.cardFee).toBeGreaterThan(0);
    expect(q.body.fx.markupBps).toBe(100);
    expect(q.body.fx.providerLabel).toContain('NOT live');
    expect(q.body.quote.estimatedPayoutTime).toContain('30 min');
    expect(q.body.quote.quoteExpiresAt).toBeTruthy();
    expect(q.body.quote.refundConditions).toContain('before the local payout');
    expect(q.body.quote.corridor.status).toBe('sandbox');
    expect(q.body.declaration.payout.processing).toBe('manual');

    // Without liquidity the transfer waits (funds held), nothing leaves the platform.
    const empty = await sendUkToDrc(sender.auth);
    expect(empty.status, JSON.stringify(empty.body)).toBe(201);
    expect(empty.body.route.stage).toBe('LIQUIDITY_UNAVAILABLE');
    expect(empty.body.route.payout.stage).toBe('LIQUIDITY_UNAVAILABLE');
    const liq = await request(app).get('/api/admin/liquidity').set(s.admin.auth);
    expect(liq.body.items[0].shortfall).toBeGreaterThan(0);
    // Treasury prefunds the SIM (step-up): waiting payouts are re-queued.
    const pre = await request(app).post(`/api/admin/liquidity/accounts/${s.accountId}/prefund`).set(s.admin.auth).send({ amount: '5000000', reference: 'CASHIN-001', pin: s.admin.pin });
    expect(pre.status, JSON.stringify(pre.body)).toBe(200);
    expect(pre.body.requeued).toBe(1);
    const queued = await request(app).get(`/api/money/${empty.body.route.id}`).set(sender.auth);
    expect(queued.body.route.stage).toBe('PAYOUT_QUEUED');

    // 3-6. a second transfer now routes straight to the prefunded account
    const r = await sendUkToDrc(sender.auth, '20');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const route = r.body.route;
    expect(route.stage).toBe('PAYOUT_QUEUED');
    expect(route.payment.stage).toBe('SETTLED');
    expect(route.payment.authMethod).toBe('pin');
    expect(route.payout.payoutAccountId).toBe(s.accountId);
    expect(route.payout.recipientMsisdn).toBeNull(); // masked for the sender
    expect(route.payout.recipientMasked).toMatch(/•+0123$/);
    const events = await request(app).get(`/api/money/${route.id}/receipt`).set(sender.auth);
    const seq = events.body.events.map((e: any) => e.event);
    // The sandbox processor confirms synchronously, so FUNDING_PENDING is skipped; a hosted processor passes through it.
    expect(seq.slice(0, 4)).toEqual(['route.created', 'route.quoted', 'route.funds_confirmed', 'route.payout_queued']);

    // 7. the Android payout device fetches its queue, claims the payout and gets USSD instructions with the full recipient number
    const badAuth = await request(app).get('/api/payouts/device/queue').set({ 'X-Device-Id': s.deviceId, 'X-Device-Timestamp': new Date().toISOString(), 'X-Device-Signature': 'AAAA' });
    expect(badAuth.status).toBe(401);
    const queue = await request(app).get('/api/payouts/device/queue').set(deviceHeaders(s.privateKey, s.deviceId, 'GET', '/api/payouts/device/queue'));
    expect(queue.status, JSON.stringify(queue.body)).toBe(200);
    expect(queue.body.items.length).toBe(2);
    const p = queue.body.items.find((x: any) => x.routeId === route.id);
    expect(p.instructions.ussd).toBe('#144#');
    expect(p.recipientMsisdn).toBe('+243990000123');
    const claim = await request(app).post(`/api/payouts/device/${p.id}/claim`).set(deviceHeaders(s.privateKey, s.deviceId, 'POST', `/api/payouts/device/${p.id}/claim`));
    expect(claim.body.payout.stage).toBe('IN_PROGRESS');
    expect((await request(app).get(`/api/money/${route.id}`).set(sender.auth)).body.route.stage).toBe('PAYOUT_IN_PROGRESS');

    // 8-10. operator SMS on the payout device, signed and forwarded; verification matches recipient, amount, reference, operator and timing
    const amountMajor = (p.amount / 100).toFixed(2);
    const text = `Transfert de ${amountMajor} CDF vers Marie Kabila 243990000123 effectue. ID: PP240912.1015.C77812. Solde: 4,990,000.00 CDF`;
    const base = { deviceId: s.deviceId, receivedAt: new Date().toISOString(), from: 'OrangeMoney', operatorId: 'orange_cd', text };
    const wrongSim = { ...base, nonce: randomUUID() };
    const rejectedSim = await request(app).post(`/api/payouts/device/${p.id}/evidence`).send({ ...wrongSim, signature: signEv(s.privateKey, wrongSim), simIdentity: '+243899999999', clientHash: createHash('sha256').update(text).digest('hex') });
    expect(rejectedSim.status).toBe(201);
    expect(rejectedSim.body.evidence.outcome, JSON.stringify(rejectedSim.body.evidence)).toBe('review');
    expect(rejectedSim.body.evidence.reasons).toContain('unregistered_sim');
    expect(rejectedSim.body.payout.stage).toBe('MANUAL_REVIEW');
    // an administrator puts it back to the queue → in progress again for the device
    await request(app).post(`/api/admin/payouts/${p.id}/requeue`).set(s.admin.auth);
    await request(app).post(`/api/payouts/device/${p.id}/claim`).set(deviceHeaders(s.privateKey, s.deviceId, 'POST', `/api/payouts/device/${p.id}/claim`));
    const good = { ...base, nonce: randomUUID(), text: text.replace('C77812', 'C77813') };
    const ok = await request(app).post(`/api/payouts/device/${p.id}/evidence`).send({ ...good, signature: signEv(s.privateKey, good), simIdentity: '+243890000100', deviceTimestamp: new Date().toISOString(), clientHash: createHash('sha256').update(good.text).digest('hex') });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.evidence.outcome, JSON.stringify(ok.body.evidence)).toBe('settled');
    expect(ok.body.payout.stage).toBe('SETTLED');
    // 11. SETTLED: sender's held CDF released, float debited, ledger balanced, both parties notified
    const after = await request(app).get(`/api/money/${route.id}`).set(sender.auth);
    expect(after.body.route.stage).toBe('SETTLED');
    expect(after.body.route.status).toBe('completed');
    const acc = await request(app).get('/api/admin/liquidity').set(s.admin.auth);
    const sim = acc.body.items.find((a: any) => a.id === s.accountId);
    expect(sim.balance).toBe(500000000 - p.amount);
    const rec = await request(app).get('/api/admin/reconcile').set(s.admin.auth);
    expect(rec.body.ledger.ok, JSON.stringify(rec.body.ledger)).toBe(true);
    const notes = await request(app).get('/api/account/notifications').set(sender.auth);
    expect(notes.body.items.some((n: any) => n.title === 'Payout delivered')).toBe(true);
    const receipt = await request(app).get(`/api/money/${route.id}/receipt`).set(sender.auth);
    expect(receipt.body.evidence.find((e: any) => e.outcome === 'settled').operatorReference).toBe('PP240912.1015.C77813');

    // A replay of the same confirmation cannot settle anything twice.
    const replay = await request(app).post(`/api/payouts/device/${p.id}/evidence`).send({ ...good, signature: signEv(s.privateKey, good), simIdentity: '+243890000100' });
    expect(replay.status).toBe(401);
    // The same operator transaction id presented for the other queued payout is a duplicate → held, not paid.
    const other = queue.body.items.find((x: any) => x.id !== p.id);
    await request(app).post(`/api/payouts/device/${other.id}/claim`).set(deviceHeaders(s.privateKey, s.deviceId, 'POST', `/api/payouts/device/${other.id}/claim`));
    const dupText = `Transfert de ${(other.amount / 100).toFixed(2)} CDF vers Marie Kabila 243990000123 effectue. ID: PP240912.1015.C77813. Solde: 4,000,000.00 CDF`;
    const dup = { ...base, nonce: randomUUID(), text: dupText };
    const dupRes = await request(app).post(`/api/payouts/device/${other.id}/evidence`).send({ ...dup, signature: signEv(s.privateKey, dup), simIdentity: '+243890000100' });
    expect(dupRes.body.evidence.outcome).toBe('duplicate');
    expect(dupRes.body.payout.stage).toBe('DUPLICATE');
    const simAfter = (await request(app).get('/api/admin/liquidity').set(s.admin.auth)).body.items.find((a: any) => a.id === s.accountId);
    expect(simAfter.balance).toBe(sim.balance);
    // Wrong recipient / amount is mismatched.
    await request(app).post(`/api/admin/payouts/${other.id}/requeue`).set(s.admin.auth);
    await request(app).post(`/api/payouts/device/${other.id}/claim`).set(deviceHeaders(s.privateKey, s.deviceId, 'POST', `/api/payouts/device/${other.id}/claim`));
    const bad = { ...base, nonce: randomUUID(), text: `Transfert de 1.00 CDF vers Jean 243990000999 effectue. ID: PP240912.1016.A1. Solde: 4,000,000.00 CDF` };
    const badRes = await request(app).post(`/api/payouts/device/${other.id}/evidence`).send({ ...bad, signature: signEv(s.privateKey, bad), simIdentity: '+243890000100' });
    expect(badRes.body.evidence.outcome).toBe('mismatched');
    expect(badRes.body.evidence.reasons).toEqual(expect.arrayContaining(['amount_mismatch', 'recipient_mismatch']));
    // Administrative settlement is the exception: documentary evidence + a second admin.
    const noDocs = await request(app).post(`/api/admin/payouts/${other.id}/settle`).set(s.admin.auth).send({ externalRef: 'PP1', note: 'x' });
    expect(noDocs.status).toBe(400);
    const proposed = await request(app).post(`/api/admin/payouts/${other.id}/settle`).set(s.admin.auth).send({ externalRef: 'PP240912.1020.Z9', note: 'Checked on the Orange Money merchant portal, statement line 88' });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
    const approved = await request(app).post(`/api/admin/verifications/${proposed.body.verification.id}/approve`).set(s.checker.auth).send({ pin: s.checker.pin });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await request(app).get(`/api/money/${empty.body.route.id}`).set(sender.auth)).body.route.stage).toBe('SETTLED');
  });

  it('holds card-funded payouts for review when chargeback exposure is high, and refunds before payout', async () => {
    const s = await corridorSetup();
    const admin = s.admin;
    await request(app).post(`/api/admin/liquidity/accounts/${s.accountId}/prefund`).set(admin.auth).send({ amount: '9000000', reference: 'CASHIN-002', pin: admin.pin });
    await request(app).put('/api/admin/settings/compliance').set(admin.auth).send({ value: { cardReviewAmount: 1_000 } }); // base USD: 1000 minor = $10
    const sender = await ukSender();
    const held = await sendUkToDrc(sender.auth, '40');
    expect(held.status, JSON.stringify(held.body)).toBe(201);
    expect(held.body.route.stage).toBe('MANUAL_REVIEW');
    expect(held.body.route.payout).toBeNull(); // nothing queued to any device
    expect(held.body.route.error).toContain('card_funded');
    // A verifier releases it: propose + second admin approves → queued.
    const rel = await request(app).post(`/api/admin/money-routes/${held.body.route.id}/release`).set(admin.auth).send({ approve: true, note: 'KYC verified, low risk' });
    expect(rel.status, JSON.stringify(rel.body)).toBe(200);
    const relOk = await request(app).post(`/api/admin/verifications/${rel.body.verification.id}/approve`).set(s.checker.auth).send({ pin: s.checker.pin });
    expect(relOk.status, JSON.stringify(relOk.body)).toBe(200);
    const released = await request(app).get(`/api/money/${held.body.route.id}`).set(sender.auth);
    expect(released.body.route.stage).toBe('PAYOUT_QUEUED');
    // The sender cancels before execution: payout cancelled, card refunded at the (sandbox) processor.
    const cancel = await request(app).post(`/api/money/${held.body.route.id}/cancel`).set(sender.auth).send({ pin: '1234', reason: 'Changed my mind' });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(cancel.body.route.stage).toBe('REFUNDED');
    expect(cancel.body.route.payout.stage).toBe('CANCELLED');
    const pay = await request(app).get(`/api/deposits/${held.body.route.paymentId}`).set(sender.auth);
    expect(pay.body.payment.stage).toBe('REVERSED');
    const rec = await request(app).get('/api/admin/reconcile').set(admin.auth);
    expect(rec.body.ledger.ok, JSON.stringify(rec.body.ledger)).toBe(true);
    await request(app).put('/api/admin/settings/compliance').set(admin.auth).send({ value: { cardReviewAmount: 100_000 } });
  });

  it('a processor dispute cancels an unexecuted payout and reverses the funding; after payout it becomes a chargeback case', async () => {
    const s = await corridorSetup();
    await request(app).post(`/api/admin/liquidity/accounts/${s.accountId}/prefund`).set(s.admin.auth).send({ amount: '9000000', reference: 'CASHIN-003', pin: s.admin.pin });
    const sender = await ukSender();
    const r = await sendUkToDrc(sender.auth, '15');
    expect(r.body.route.stage).toBe('PAYOUT_QUEUED');
    const cb = await request(app).post('/api/admin/chargebacks').set(s.admin.auth).send({ paymentId: r.body.route.paymentId, reason: 'fraudulent', pin: s.admin.pin });
    expect(cb.status, JSON.stringify(cb.body)).toBe(201);
    expect(cb.body.chargeback.status).toBe('reversed_before_payout');
    const after = await request(app).get(`/api/money/${r.body.route.id}`).set(sender.auth);
    expect(after.body.route.stage).toBe('REVERSED');
    expect(after.body.route.payout.stage).toBe('CANCELLED');
    // The full funding was clawed back; the FX round-trip cost is the customer's (small negative balance).
    const gbp0 = (await request(app).get('/api/wallets').set(sender.auth)).body.items.find((w: any) => w.currency === 'GBP');
    expect(gbp0.balance).toBeLessThanOrEqual(0);
    // Paid-out transfer (fresh sender): dispute stays open; losing it books the customer's debt.
    const sender2 = await ukSender();
    const r2 = await sendUkToDrc(sender2.auth, '15');
    const p = r2.body.route.payout;
    await request(app).post(`/api/payouts/device/${p.id}/claim`).set(deviceHeaders(s.privateKey, s.deviceId, 'POST', `/api/payouts/device/${p.id}/claim`));
    const ev = { deviceId: s.deviceId, nonce: randomUUID(), receivedAt: new Date().toISOString(), from: 'OrangeMoney', operatorId: 'orange_cd', text: `Transfert de ${(p.amount / 100).toFixed(2)} CDF vers Marie Kabila 243990000123 effectue. ID: PP240912.1100.Q1. Solde: 1.00 CDF` };
    const ok = await request(app).post(`/api/payouts/device/${p.id}/evidence`).send({ ...ev, signature: signEv(s.privateKey, ev), simIdentity: '8924300000000000100' });
    expect(ok.body.payout?.stage, JSON.stringify(ok.body)).toBe('SETTLED');
    const cb2 = await request(app).post('/api/admin/chargebacks').set(s.admin.auth).send({ paymentId: r2.body.route.paymentId, reason: 'not recognised', pin: s.admin.pin });
    expect(cb2.body.chargeback.status).toBe('open');
    expect((await request(app).get(`/api/money/${r2.body.route.id}`).set(sender2.auth)).body.route.stage).toBe('DISPUTED');
    const lost = await request(app).post(`/api/admin/chargebacks/${cb2.body.chargeback.id}/resolve`).set(s.admin.auth).send({ outcome: 'lost', pin: s.admin.pin });
    expect(lost.body.chargeback.status).toBe('lost');
    const gbp = (await request(app).get('/api/wallets').set(sender2.auth)).body.items.find((w: any) => w.currency === 'GBP');
    expect(gbp.balance).toBeLessThan(0); // the customer owes the reversed amount
    const rec = await request(app).get('/api/admin/reconcile').set(s.admin.auth);
    expect(rec.body.ledger.ok).toBe(true);
  });

  it('refuses live customer funds until the platform and the corridor are authorised', async () => {
    const s = await corridorSetup();
    const admin = s.admin;
    // A real processor configured for GBP while the platform is in sandbox mode → refused before any charge.
    await request(app).put('/api/admin/gateways/stripe_gbp').set(admin.auth).send({ name: 'Stripe (GBP)', provider: 'stripe', enabled: true, methods: ['card'], currencies: ['GBP'], credentials: { secretKey: 'sk_test_x', publishableKey: 'pk_test_x', webhookSecret: 'whsec_x' } });
    const sender = await registerUser(app, { country: 'GB' });
    const blocked = await sendUkToDrc(sender.auth, '20', { source: { method: 'card', gateway: 'stripe_gbp', card } });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('compliance_sandbox_mode');
    // Switching the platform live through the API is refused until the go-live checklist passes.
    const blockedSwitch = await request(app).put('/api/admin/settings/compliance').set(admin.auth).send({ value: { mode: 'live' }, pin: admin.pin });
    expect(blockedSwitch.status).toBe(400);
    expect(blockedSwitch.body.error.code).toBe('go_live_blocked');
    // Simulate an operator that has completed the checklist: live mode, corridor still sandbox → still refused.
    const { setSetting } = await import('../services/settings');
    setSetting('compliance', { ...(await import('../services/settings')).getComplianceSettings(), mode: 'live' });
    const blocked2 = await sendUkToDrc(sender.auth, '20', { source: { method: 'card', gateway: 'stripe_gbp', card } });
    expect(blocked2.body.error.code).toBe('corridor_not_live');
    // Going live needs the arrangements on record and an admin step-up.
    const noArr = await request(app).post(`/api/admin/corridors/${s.corridorId}/status`).set(admin.auth).send({ status: 'live', pin: admin.pin });
    expect(noArr.status).toBe(400);
    // Partners and a licence reference alone are not enough: the structured arrangements are mandatory.
    const partial = await request(app).post(`/api/admin/corridors/${s.corridorId}/status`).set(admin.auth).send({ status: 'live', collectionPartner: 'Stripe Payments UK Ltd (EMI)', payoutPartner: 'Orange Money RDC – super-agent contract', licenceRef: 'FCA-PI-123456', pin: admin.pin });
    expect(partial.status).toBe(400);
    expect(partial.body.error.details.missing).toEqual(expect.arrayContaining(['Licence number', 'Licence expiry date']));
    const live = await request(app).post(`/api/admin/corridors/${s.corridorId}/status`).set(admin.auth).send({ status: 'live', collectionPartner: 'Stripe Payments UK Ltd (EMI)', payoutPartner: 'Orange Money RDC – super-agent contract', licenceRef: 'FCA-PI-123456', licenceExpiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString(), compliance: { regulator: 'FCA', licenceType: 'Authorised Payment Institution', licenceNumber: '123456', safeguardingAccount: 'Barclays safeguarding 12-34-56 00000001', amlProgrammeRef: 'AML-POL-2026-01' }, pin: admin.pin });
    expect(live.status, JSON.stringify(live.body)).toBe(200);
    expect(live.body.corridor.readiness.ready).toBe(true);
    expect(live.body.corridor.status).toBe('live');
    expect(live.body.corridor.approvedBy).toBeTruthy();
    const corridors = await request(app).get('/api/money/corridors').set(sender.auth);
    expect(corridors.body.items.find((c: any) => c.id === s.corridorId).status).toBe('live');
    // An expired licence suspends the corridor automatically.
    const { getDb } = await import('../db');
    getDb().prepare('UPDATE corridors SET licence_expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), s.corridorId);
    const { enforceLicenceExpiry } = await import('../services/corridors');
    expect(enforceLicenceExpiry().suspended).toContain(s.corridorId);
    const suspended = await sendUkToDrc(sender.auth, '20', { source: { method: 'card', gateway: 'stripe_gbp', card } });
    expect(suspended.body.error.code).toBe('corridor_suspended');
    await request(app).put('/api/admin/settings/compliance').set(admin.auth).send({ value: { mode: 'sandbox' } });
    await request(app).delete('/api/admin/gateways/stripe_gbp').set(admin.auth);
  });
});
