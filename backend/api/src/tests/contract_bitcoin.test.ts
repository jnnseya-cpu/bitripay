/**
 * Bitcoin rail (specification §55, §56): the adapter contract (sandbox invoices, expiry, BTCPay webhook signatures,
 * Greenfield state mapping, manual refunds, health check), eligibility by jurisdiction AND merchant policy (off by
 * default, method absent; enabled country + opted-in merchant lists it on the intent), and the end-to-end sandbox
 * payment of an intent over the Bitcoin rail landing in CAPTURED with a balanced ledger posting and the FX disclosure,
 * settled in fiat (default) or kept as a BTC wallet balance (merchant policy).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, adminToken } from './helpers';
import { getDb } from '../db';
import { now } from '../lib/ids';
import { PROVIDERS, getGateway, upsertGateway, getGatewayCredentials } from '../payments';
import {
  bitcoinProvider,
  sandboxInvoice,
  mapInvoiceStatus,
  markSandboxInvoice,
  signBtcpayWebhook,
  verifyBtcpaySignature,
  setBitcoinCurrencyEnabled,
  bitcoinRate,
  satsFor,
  bitcoinMode,
  SANDBOX_BTC_RATE_SOURCE,
  BITCOIN_CAPABILITIES,
  BITCOIN_FEE_BPS,
} from '../payments/bitcoin';
import type { GatewayPaymentRow, InitiateContext } from '../payments/types';
import { bitcoinCountries, bitcoinEligible, merchantBitcoinPolicy } from '../services/capabilities';
import { setMerchantBitcoinPolicy, intentRailsFor } from '../services/gateway';
import { initiatePayment, providerRefund, getPayment, settleSandboxBitcoinInvoice, paymentOptions } from '../services/payments';
import { findUserById } from '../services/users';
import { getIntentRow } from '../services/intents';
import { importRates } from '../services/currencies';
import { getAppSettings } from '../services/settings';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

const row = (over: Partial<GatewayPaymentRow> = {}): GatewayPaymentRow => ({
  id: 'pay_btc_test',
  gateway: 'bitcoin',
  provider_ref: null,
  method: 'bitcoin',
  purpose: 'checkout',
  user_id: null,
  payment_request_id: null,
  amount: 1234,
  currency: 'USD',
  fee: 0,
  status: 'pending',
  stage: 'INSTRUCTION_ISSUED',
  expires_at: null,
  authenticated_at: null,
  auth_method: null,
  payer_email: null,
  payer_phone: null,
  payer_name: null,
  saved_card_id: null,
  metadata: '{}',
  transaction_id: null,
  created_at: now(),
  updated_at: now(),
  ...over,
});
const ctx = (idempotencyKey?: string, credentials: Record<string, string> = {}): InitiateContext => ({
  payment: row(),
  idempotencyKey,
  amountMinor: 1234,
  amountMajor: 12.34,
  currency: 'USD',
  decimals: 2,
  method: 'bitcoin',
  payer: { email: 'payer@example.com', phone: null, name: 'Payer', userId: null },
  returnUrl: 'http://localhost/return',
  callbackUrl: 'http://localhost/api/webhooks/bitcoin',
  credentials,
  description: 'Test invoice',
});
const webhookReq = (body: unknown, headers: Record<string, string>) => {
  const raw = JSON.stringify(body);
  return { headers, body: JSON.parse(raw), rawBody: Buffer.from(raw) } as any;
};
const enableBitcoinGateway = () => upsertGateway({ id: 'bitcoin', name: 'Bitcoin / Lightning', provider: 'bitcoin', enabled: true, methods: ['bitcoin'], currencies: [], sortOrder: 9 });

describe('Bitcoin adapter contract', () => {
  it('registers as a disabled default gateway with the bitcoin method and BTCPay credential fields', () => {
    expect(PROVIDERS.bitcoin).toBe(bitcoinProvider);
    expect(bitcoinProvider.supportedMethods).toEqual(['bitcoin']);
    expect(bitcoinProvider.credentialFields.map((f) => f.key)).toEqual(expect.arrayContaining(['mode', 'serverUrl', 'storeId', 'apiKey', 'webhookSecret', 'confirmations']));
    const g = getGateway('bitcoin')!;
    expect(g.enabled).toBe(false);
    expect(g.provider).toBe('bitcoin');
    expect(g.mode).toBe('test'); // no credentials = sandbox mode
    expect(bitcoinMode(getGatewayCredentials('bitcoin'))).toBe('sandbox');
    expect(bitcoinProvider.capabilities!({})).toEqual(BITCOIN_CAPABILITIES);
    expect(BITCOIN_CAPABILITIES.refunds).toBe(false);
    const btc = getDb().prepare('SELECT * FROM currencies WHERE code = ?').get('BTC') as any;
    expect(btc).toMatchObject({ decimals: 8, enabled: 0, rate_source: SANDBOX_BTC_RATE_SOURCE });
  });

  it('issues sandbox invoices deterministically from the idempotency key, with a disclosed sandbox rate, expiry and confirmation policy', async () => {
    const first = await bitcoinProvider.initiate(ctx('pay_1'));
    const again = await bitcoinProvider.initiate(ctx('pay_1'));
    const other = await bitcoinProvider.initiate(ctx('pay_2'));
    expect(first.status).toBe('pending');
    expect(first.providerRef).toBe(again.providerRef);
    expect(first.providerRef).toMatch(/^btcsbx_/);
    expect(other.providerRef).not.toBe(first.providerRef);
    expect(first.next.type).toBe('bitcoin_invoice');
    const inv = first.next.invoice!;
    expect(inv).toMatchObject({ mode: 'sandbox', sandbox: true, network: 'regtest', fiat: { amountMinor: 1234, currency: 'USD' } });
    expect(inv.lightning).toMatch(/^lnbcrt\d+n1p/);
    expect(inv.address).toMatch(/^bcrt1q[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38}$/);
    expect(again.next.invoice!.lightning).toBe(inv.lightning);
    expect(inv.bip21).toContain(`bitcoin:${inv.address}?amount=${inv.amountBtc}`);
    // rate: sandbox, margin disclosed and applied against the payer (more sats than the mid rate)
    const rate = bitcoinRate('USD');
    expect(inv.rate).toMatchObject({ fiatCurrency: 'USD', sandbox: true, rateSource: SANDBOX_BTC_RATE_SOURCE, marginBps: getAppSettings().exchangeMarginBps });
    expect(inv.rate.label).toMatch(/NOT a live market rate/);
    expect(inv.rate.rate).toBeGreaterThan(inv.rate.midRate);
    expect(inv.amountSats).toBe(satsFor(1234, 'USD', rate));
    expect(inv.amountSats).toBe(Math.ceil(12.34 * rate.rate * 1e8));
    expect(inv.amountBtc).toBe((inv.amountSats / 1e8).toFixed(8));
    expect(inv.confirmations).toEqual({ lightning: 'settled_on_payment', onChain: 1 });
    const ttl = new Date(inv.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);
    expect(first.next.instructions!['Lightning invoice']).toBe(inv.lightning);
    // configurable confirmation policy and expiry
    const strict = await bitcoinProvider.initiate(ctx('pay_3', { confirmations: '3', invoiceExpiryMinutes: '60' }));
    expect(strict.next.invoice!.confirmations.onChain).toBe(3);
    expect(new Date(strict.next.invoice!.expiresAt).getTime() - Date.now()).toBeGreaterThan(59 * 60_000);
    // quote: fiat → BTC with the margin disclosed
    const q = await bitcoinProvider.quote!({ amountMinor: 1234, currency: 'USD', method: 'bitcoin', credentials: {} });
    expect(q).toMatchObject({ currency: 'USD', targetCurrency: 'BTC', feeBps: BITCOIN_FEE_BPS, feeMinor: 12, fxRate: rate.rate, etaSeconds: 600 });
    expect(q.disclosure).toMatchObject({ sandbox: true, marginBps: rate.marginBps });
  });

  it('verifies sandbox invoices: pending until paid, failed once expired, succeeded after the simulator paid it', async () => {
    const inv = sandboxInvoice({ key: 'verify_1', amountMinor: 500, currency: 'USD', credentials: {} });
    const open = row({ provider_ref: inv.invoiceId, metadata: JSON.stringify({ next: { type: 'bitcoin_invoice', invoice: inv } }) });
    expect(await bitcoinProvider.verify(open, {})).toMatchObject({ status: 'pending' });
    const expired = row({ metadata: JSON.stringify({ next: { type: 'bitcoin_invoice', invoice: { ...inv, expiresAt: new Date(Date.now() - 1000).toISOString() } } }) });
    expect(await bitcoinProvider.verify(expired, {})).toMatchObject({ status: 'failed', failureReason: expect.stringMatching(/expired/i) });
    const paid = row({ metadata: JSON.stringify({ next: { type: 'bitcoin_invoice', invoice: inv }, ...markSandboxInvoice('{}', 'paid', { type: 'system' }) }) });
    expect(await bitcoinProvider.verify(paid, {})).toMatchObject({ status: 'succeeded' });
    const invalid = row({ metadata: JSON.stringify({ next: { type: 'bitcoin_invoice', invoice: inv }, ...markSandboxInvoice('{}', 'invalid', { type: 'system' }) }) });
    expect(await bitcoinProvider.verify(invalid, {})).toMatchObject({ status: 'failed' });
    // cancel archives an open invoice and refuses a final one
    expect(await bitcoinProvider.cancel!(open, {})).toMatchObject({ status: 'cancelled' });
    expect(await bitcoinProvider.cancel!(row({ status: 'succeeded' }), {})).toMatchObject({ status: 'not_cancellable' });
  });

  it('accepts BTCPay webhooks only with a valid BTCPay-Sig HMAC-SHA256 over the raw body', async () => {
    const creds = { mode: 'btcpay', webhookSecret: 'whsec_btcpay_test' };
    const settled = { type: 'InvoiceSettled', invoiceId: 'inv_1', storeId: 'store', timestamp: 1 };
    const raw = JSON.stringify(settled);
    const sig = signBtcpayWebhook(creds.webhookSecret, raw);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyBtcpaySignature(creds.webhookSecret, raw, sig)).toBe(true);
    expect(verifyBtcpaySignature('other', raw, sig)).toBe(false);
    expect(verifyBtcpaySignature(creds.webhookSecret, raw, undefined)).toBe(false);
    expect(await bitcoinProvider.parseWebhook!(webhookReq(settled, { 'btcpay-sig': sig }), creds)).toEqual([{ providerRef: 'inv_1', status: 'succeeded', reason: 'InvoiceSettled', raw: settled }]);
    await expect(bitcoinProvider.parseWebhook!(webhookReq(settled, { 'btcpay-sig': 'sha256=' + '0'.repeat(64) }), creds)).rejects.toThrow(/Invalid BTCPay signature/);
    await expect(bitcoinProvider.parseWebhook!(webhookReq(settled, {}), creds)).rejects.toThrow(/Invalid BTCPay signature/);
    await expect(bitcoinProvider.parseWebhook!(webhookReq(settled, { 'btcpay-sig': sig }), { mode: 'btcpay' })).rejects.toThrow(/webhook secret/);
    // event types: processing is pending, expired is failed, an expired invoice that received money is unknown, created is ignored
    const ev = async (body: Record<string, unknown>) => bitcoinProvider.parseWebhook!(webhookReq(body, { 'btcpay-sig': signBtcpayWebhook(creds.webhookSecret, JSON.stringify(body)) }), creds);
    expect((await ev({ type: 'InvoiceProcessing', invoiceId: 'inv_2' }))[0].status).toBe('pending');
    expect((await ev({ type: 'InvoiceExpired', invoiceId: 'inv_3', partiallyPaid: false }))[0].status).toBe('failed');
    expect((await ev({ type: 'InvoiceExpired', invoiceId: 'inv_4', partiallyPaid: true }))[0].status).toBe('unknown');
    expect((await ev({ type: 'InvoiceInvalid', invoiceId: 'inv_5', manuallyMarked: true }))[0].status).toBe('failed');
    expect(await ev({ type: 'InvoiceCreated', invoiceId: 'inv_6' })).toEqual([]);
    // the generic provider webhook route serves the adapter: a bad signature is a 400, never a state change
    upsertGateway({
      id: 'bitcoin',
      name: 'Bitcoin / Lightning',
      provider: 'bitcoin',
      enabled: false,
      methods: ['bitcoin'],
      currencies: [],
      sortOrder: 9,
      credentials: { webhookSecret: creds.webhookSecret },
    });
    const bad = await request(app).post('/api/webhooks/bitcoin').set('BTCPay-Sig', 'sha256=deadbeef').send(settled);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/signature/i);
    const unknownInvoice = await request(app).post('/api/webhooks/bitcoin').set('BTCPay-Sig', sig).send(settled);
    expect(unknownInvoice.body).toMatchObject({ received: true, handled: 0 });
    upsertGateway({ id: 'bitcoin', name: 'Bitcoin / Lightning', provider: 'bitcoin', enabled: false, methods: ['bitcoin'], currencies: [], sortOrder: 9, credentials: { webhookSecret: '' } });
  });

  it('maps Greenfield invoice states to platform outcomes', () => {
    expect(mapInvoiceStatus('New')).toMatchObject({ status: 'pending' });
    expect(mapInvoiceStatus('Processing')).toMatchObject({ status: 'pending' });
    expect(mapInvoiceStatus('Settled')).toMatchObject({ status: 'succeeded' });
    expect(mapInvoiceStatus('Expired')).toMatchObject({ status: 'failed' });
    expect(mapInvoiceStatus('Expired', 'PaidPartial')).toMatchObject({ status: 'unknown' });
    expect(mapInvoiceStatus('Expired', 'PaidLate')).toMatchObject({ status: 'unknown' });
    expect(mapInvoiceStatus('Invalid', 'Marked')).toMatchObject({ status: 'failed', failureReason: expect.stringMatching(/marked invalid/i) });
    expect(mapInvoiceStatus('Invalid')).toMatchObject({ status: 'failed' });
    expect(mapInvoiceStatus('Weird')).toMatchObject({ status: 'unknown' });
  });

  it('health check: sandbox is always ok in test mode; BTCPay mode needs the Greenfield credentials; key mode follows the network', async () => {
    expect(await bitcoinProvider.healthCheck!({})).toMatchObject({ ok: true, mode: 'test' });
    expect(await bitcoinProvider.healthCheck!({ mode: 'btcpay' })).toMatchObject({ ok: false, message: expect.stringMatching(/serverUrl, storeId and apiKey/) });
    expect(bitcoinProvider.keyMode!({ mode: 'btcpay', network: 'testnet' })).toBe('test');
    expect(bitcoinProvider.keyMode!({ mode: 'btcpay', network: 'mainnet' })).toBe('live');
    expect(bitcoinProvider.keyMode!({ mode: 'btcpay' })).toBe('live');
    expect(bitcoinProvider.keyMode!({ mode: 'sandbox', network: 'mainnet' })).toBe('test');
    const admin = await adminToken(app);
    const test = await request(app).post('/api/admin/gateways/bitcoin/test').set(admin.auth);
    expect(test.status, JSON.stringify(test.body)).toBe(200);
    expect(test.body).toMatchObject({ ok: true, mode: 'test' });
    expect(test.body.webhookUrl).toMatch(/\/api\/webhooks\/bitcoin$/);
    expect(getGateway('bitcoin')!.lastHealth?.ok).toBe(true);
  });

  it('refunds are manual: no automatic refund on chain', async () => {
    const r = await bitcoinProvider.refund!(row({ provider_ref: 'btcsbx_x', status: 'succeeded', stage: 'SETTLED' }), 500, 'customer request', {});
    expect(r.status).toBe('manual');
    expect(r.message).toMatch(/not refunded automatically/i);
  });
});

describe('Bitcoin eligibility: jurisdiction AND merchant policy', () => {
  it('is off everywhere by default: no country listed, the method is absent from options and intents, a top-up is refused', async () => {
    expect(bitcoinCountries()).toEqual([]);
    expect(bitcoinEligible({ country: 'RW', merchantPolicy: { bitcoin: true } })).toMatchObject({ eligible: false, countryAllowed: false, reason: 'Bitcoin is not enabled in RW' });
    expect(bitcoinEligible({ country: null })).toMatchObject({ eligible: false, reason: 'country unknown' });
    const u = await registerUser(app, { country: 'RW' });
    const options = await request(app).get('/api/deposits/options?currency=USD').set(u.auth);
    expect(options.body.methods.map((m: any) => m.method)).not.toContain('bitcoin');
    const refused = await request(app).post('/api/deposits').set(u.auth).send({ pin: '1234', method: 'bitcoin', amount: '10', currency: 'USD' });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('bitcoin_not_eligible');
    const m = await registerUser(app, { role: 'merchant', businessName: 'Nairobi Books', country: 'RW' });
    expect(merchantBitcoinPolicy(findUserById(m.user.id))).toEqual({ bitcoin: false, bitcoinSettlement: 'fiat' });
    const cs = await request(app).post('/api/v1/checkout_sessions').set(m.auth).send({ currency: 'USD', amount_minor: 1000 });
    expect(cs.status, JSON.stringify(cs.body)).toBe(201);
    expect(cs.body.paymentIntent.rails).not.toContain('bitcoin');
    const methods = await request(app).get(`/api/v1/payment_intents/${cs.body.intentId}/methods`);
    expect(methods.body.data.map((x: any) => x.methodClass)).not.toContain('bitcoin');
  });

  it('an administrator enables the country and the merchant opts in: the intent lists bitcoin; a merchant who did not opt in does not', async () => {
    const admin = await adminToken(app);
    const caps = await request(app).put('/api/admin/capabilities/RW').set(admin.auth).send({ bitcoin: true });
    expect(caps.status, JSON.stringify(caps.body)).toBe(200);
    expect(bitcoinCountries()).toEqual(['RW']);
    enableBitcoinGateway();
    // aggregator-phase countries stay off whatever the flag says (Bitcoin is a full-licence service)
    await request(app).put('/api/admin/capabilities/CD').set(admin.auth).send({ bitcoin: true });
    expect(bitcoinCountries()).toEqual(['RW']);
    expect(bitcoinEligible({ country: 'CD', merchantPolicy: { bitcoin: true } }).eligible).toBe(false);
    await request(app).put('/api/admin/capabilities/CD').set(admin.auth).send({ bitcoin: false });

    const optedIn = await registerUser(app, { role: 'merchant', businessName: 'Mombasa Coffee', country: 'RW' });
    expect(setMerchantBitcoinPolicy(findUserById(optedIn.user.id)!, { bitcoin: true })).toEqual({ bitcoin: true, bitcoinSettlement: 'fiat' });
    expect(() => setMerchantBitcoinPolicy(findUserById(optedIn.user.id)!, { bitcoinSettlement: 'gold' as any })).toThrow();
    const merchant = findUserById(optedIn.user.id)!;
    expect(bitcoinEligible({ country: merchant.country, merchantPolicy: merchantBitcoinPolicy(merchant) })).toMatchObject({ eligible: true, countryAllowed: true, merchantOptedIn: true });
    expect(intentRailsFor(merchant)).toContain('bitcoin');
    expect(intentRailsFor(merchant, ['wallet', 'card'])).toEqual(['wallet', 'card', 'bitcoin']);
    const cs = await request(app).post('/api/v1/checkout_sessions').set(optedIn.auth).send({ currency: 'USD', amount_minor: 1500 });
    expect(cs.status, JSON.stringify(cs.body)).toBe(201);
    expect(cs.body.paymentIntent.rails).toContain('bitcoin');
    const methods = await request(app).get(`/api/v1/payment_intents/${cs.body.intentId}/methods?country=RW`);
    const btc = methods.body.data.find((x: any) => x.methodClass === 'bitcoin');
    expect(btc).toMatchObject({ label: 'Bitcoin / Lightning', available: true });
    // checkout options for this merchant carry the bitcoin method with its rate disclosure
    const opts = paymentOptions('USD', 'RW', 'checkout', { merchant });
    const option = opts.find((o) => o.method === 'bitcoin')!;
    expect(option.gateways.map((g) => g.id)).toEqual(['bitcoin']);
    expect(option.bitcoin?.rate.sandbox).toBe(true);
    expect(option.bitcoin?.eligibility.eligible).toBe(true);

    const notOptedIn = await registerUser(app, { role: 'merchant', businessName: 'Kisumu Tools', country: 'RW' });
    const other = findUserById(notOptedIn.user.id)!;
    expect(intentRailsFor(other, ['wallet', 'bitcoin'])).toEqual(['wallet']);
    expect(intentRailsFor(other)).toBeUndefined();
    const cs2 = await request(app)
      .post('/api/v1/checkout_sessions')
      .set(notOptedIn.auth)
      .send({ currency: 'USD', amount_minor: 1500, rails: ['wallet', 'bitcoin'] });
    expect(cs2.status, JSON.stringify(cs2.body)).toBe(201);
    expect(cs2.body.paymentIntent.rails).not.toContain('bitcoin');
    expect(paymentOptions('USD', 'RW', 'checkout', { merchant: other }).map((o) => o.method)).not.toContain('bitcoin');
    expect(paymentOptions('USD', 'RW', 'checkout').map((o) => o.method)).not.toContain('bitcoin'); // unknown merchant policy: never listed
    const rejected = await initiatePayment(null, { purpose: 'checkout', method: 'bitcoin', paymentRequestCode: cs2.body.paymentIntent.paymentRequestCode }).catch((e) => e);
    expect(rejected.code).toBe('bitcoin_not_eligible');
    expect(rejected.message).toMatch(/has not opted in/);
    // a customer in an enabled country sees the rail on the top-up screen (jurisdiction only)
    const u = await registerUser(app, { country: 'RW' });
    const options = await request(app).get('/api/deposits/options?currency=USD').set(u.auth);
    const dep = options.body.methods.find((m: any) => m.method === 'bitcoin');
    expect(dep.gateways[0].provider).toBe('bitcoin');
    expect(dep.bitcoin.rate.label).toMatch(/NOT a live market rate/);
  });
});

describe('Bitcoin rail end to end (sandbox)', () => {
  it('a merchant intent paid over the sandbox Bitcoin rail lands in CAPTURED with a ledger posting and the FX disclosure, settled in fiat by default', async () => {
    const admin = await adminToken(app);
    await request(app).put('/api/admin/capabilities/RW').set(admin.auth).send({ bitcoin: true });
    enableBitcoinGateway();
    const m = await registerUser(app, { role: 'merchant', businessName: 'Lamu Sails', country: 'RW' });
    setMerchantBitcoinPolicy(findUserById(m.user.id)!, { bitcoin: true });
    const cs = await request(app).post('/api/v1/checkout_sessions').set(m.auth).send({ currency: 'USD', amount_minor: 2500, reference: 'SAIL-1' });
    expect(cs.status, JSON.stringify(cs.body)).toBe(201);
    const code = cs.body.paymentIntent.paymentRequestCode as string;
    const payment = await initiatePayment(null, { purpose: 'checkout', method: 'bitcoin', paymentRequestCode: code, name: 'Guest payer', email: 'guest@example.com' });
    expect(payment.status).toBe('pending');
    expect(payment.stage).toBe('INSTRUCTION_ISSUED');
    expect(payment.gateway).toBe('bitcoin');
    expect(payment.next?.type).toBe('bitcoin_invoice');
    const invoice = payment.next!.invoice!;
    expect(invoice.fiat).toEqual({ amountMinor: 2500, currency: 'USD' });
    expect(invoice.rate).toMatchObject({ sandbox: true, fiatCurrency: 'USD', marginBps: getAppSettings().exchangeMarginBps });
    expect(getIntentRow(cs.body.intentId).status).toBe('REQUIRES_CUSTOMER_ACTION');
    // the same intent, the same sandbox simulator: `succeed` pays the invoice
    const sim = await request(app).post('/api/v1/sandbox/simulate').set(m.auth).send({ payment_intent: cs.body.intentId, outcome: 'succeed' });
    expect(sim.status, JSON.stringify(sim.body)).toBe(200);
    expect(sim.body.rail).toBe('bitcoin');
    expect(sim.body.payment.status).toBe('succeeded');
    expect(sim.body.payment.stage).toBe('SETTLED');
    // captured (automatic capture) and handed straight to the settlement cycle, exactly like every other rail
    expect(sim.body.paymentIntent.status).toBe('SETTLEMENT_PENDING');
    expect(sim.body.paymentIntent.succeededAt).toBeTruthy();
    const transitions = (getDb().prepare('SELECT details FROM event_log WHERE subject_id = ? ORDER BY seq').all(cs.body.intentId) as { details: string }[]).map((e) => JSON.parse(e.details).to);
    expect(transitions).toContain('CAPTURED');
    expect(transitions.indexOf('CAPTURED')).toBeLessThan(transitions.indexOf('SETTLEMENT_PENDING'));
    expect(sim.body.attempts.at(-1)).toMatchObject({ methodClass: 'bitcoin', connector: 'bitcoin', status: 'CAPTURED' });
    const settled = getPayment(payment.id);
    expect(settled.transaction_id).toBeTruthy();
    const tx = getDb().prepare('SELECT * FROM transactions WHERE id = ?').get(settled.transaction_id) as any;
    expect(tx.type).toBe('merchant_payment');
    expect(tx.currency).toBe('USD');
    expect(tx.receive_currency).toBe('USD');
    const meta = JSON.parse(tx.metadata);
    expect(meta.method).toBe('bitcoin');
    expect(meta.bitcoin).toMatchObject({ requested: 'fiat', applied: 'fiat', invoiceId: invoice.invoiceId, amountSats: invoice.amountSats });
    expect(meta.bitcoin.rate).toMatchObject({ sandbox: true, rateSource: SANDBOX_BTC_RATE_SOURCE });
    const wallet = getDb().prepare("SELECT balance FROM wallets WHERE user_id = ? AND currency = 'USD'").get(m.user.id) as any;
    expect(wallet.balance).toBe(2500 - settled.fee);
    const done = await request(app).get(`/api/v1/checkout_sessions/${cs.body.id}`).set(m.auth);
    expect(done.body.status).toBe('complete');
    const intent = await request(app).get(`/api/v1/payment_intents/${cs.body.intentId}`).set(m.auth);
    expect(intent.body.status).toBe('SETTLEMENT_PENDING');
    expect(intent.body.transactionId).toBe(settled.transaction_id);
    // the ledger stays balanced
    const recon = await request(app).get('/api/admin/reconcile').set(admin.auth);
    expect(recon.body.ledger.ok, JSON.stringify(recon.body.ledger)).toBe(true);
    // refunds of a bitcoin payment are manual through the processor path
    const refund = await providerRefund(settled, 1000, 'one sail short', { type: 'merchant', id: m.user.id });
    expect(refund.status).toBe('manual');
    // a paid invoice cannot be paid twice
    await expect(settleSandboxBitcoinInvoice(payment.id, 'paid', { type: 'admin', id: 'x' })).rejects.toMatchObject({ code: 'invalid_stage_transition' });
  });

  it("merchant policy 'btc' keeps the BTC balance: the merchant BTC wallet is credited in sats through balanced conversion legs", async () => {
    const admin = await adminToken(app);
    await request(app).put('/api/admin/capabilities/RW').set(admin.auth).send({ bitcoin: true });
    enableBitcoinGateway();
    const m = await registerUser(app, { role: 'merchant', businessName: 'Diani Dive', country: 'RW' });
    setMerchantBitcoinPolicy(findUserById(m.user.id)!, { bitcoin: true, bitcoinSettlement: 'btc' });
    const pi = await request(app)
      .post('/api/v1/payment_intents')
      .set(m.auth)
      .send({ currency: 'USD', amount_minor: 1000, rails: ['wallet', 'bitcoin'] });
    expect(pi.status, JSON.stringify(pi.body)).toBe(201);
    // BTC settlement needs the BTC currency enabled by the administrator; until then the payment settles in fiat with the reason recorded
    setBitcoinCurrencyEnabled(false);
    const fiatFallback = await initiatePayment(null, { purpose: 'checkout', method: 'bitcoin', paymentRequestCode: pi.body.paymentRequestCode });
    const paidFiat = await request(app).post(`/api/deposits/${fiatFallback.id}/bitcoin/simulate`).set(m.auth).send({ outcome: 'paid' });
    expect(paidFiat.status, JSON.stringify(paidFiat.body)).toBe(200);
    expect(paidFiat.body.payment.stage).toBe('SETTLED');
    const fb = JSON.parse(getPayment(fiatFallback.id).metadata);
    expect(fb.bitcoinSettlement).toMatchObject({ requested: 'btc', applied: 'fiat', reason: expect.stringMatching(/not enabled/) });
    expect(getIntentRow(pi.body.id).status).toBe('SETTLEMENT_PENDING');

    setBitcoinCurrencyEnabled(true);
    const pi2 = await request(app)
      .post('/api/v1/payment_intents')
      .set(m.auth)
      .send({ currency: 'USD', amount_minor: 1000, rails: ['wallet', 'bitcoin'] });
    const payment = await initiatePayment(null, { purpose: 'checkout', method: 'bitcoin', paymentRequestCode: pi2.body.paymentRequestCode });
    const invoice = payment.next!.invoice!;
    const paid = await request(app).post(`/api/deposits/${payment.id}/bitcoin/simulate`).set(m.auth).send({ outcome: 'paid' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.payment.stage).toBe('SETTLED');
    const settled = getPayment(payment.id);
    const tx = getDb().prepare('SELECT * FROM transactions WHERE id = ?').get(settled.transaction_id) as any;
    const expectedSats = Math.round((invoice.amountSats * (1000 - settled.fee)) / 1000);
    expect(tx).toMatchObject({ currency: 'USD', receive_currency: 'BTC', receive_amount: expectedSats });
    expect(JSON.parse(tx.metadata).bitcoin).toMatchObject({ requested: 'btc', applied: 'btc', receiveSats: expectedSats });
    const btcWallet = getDb().prepare("SELECT balance FROM wallets WHERE user_id = ? AND currency = 'BTC'").get(m.user.id) as any;
    expect(btcWallet.balance).toBe(expectedSats);
    expect(getIntentRow(pi2.body.id).status).toBe('SETTLEMENT_PENDING');
    expect(getIntentRow(pi2.body.id).transaction_id).toBe(settled.transaction_id);
    const recon = await request(app).get('/api/admin/reconcile').set(admin.auth);
    expect(recon.body.ledger.ok, JSON.stringify(recon.body.ledger)).toBe(true);
    setBitcoinCurrencyEnabled(false);
  });

  it('a customer tops up over Bitcoin through the deposits API; only the payer, the merchant or an admin may drive the sandbox invoice', async () => {
    const admin = await adminToken(app);
    await request(app).put('/api/admin/capabilities/RW').set(admin.auth).send({ bitcoin: true });
    enableBitcoinGateway();
    const u = await registerUser(app, { country: 'RW' });
    const dep = await request(app).post('/api/deposits').set(u.auth).send({ pin: '1234', method: 'bitcoin', amount: '20', currency: 'USD' });
    expect(dep.status, JSON.stringify(dep.body)).toBe(201);
    expect(dep.body.payment.next.type).toBe('bitcoin_invoice');
    expect(dep.body.payment.next.invoice.fiat).toEqual({ amountMinor: 2000, currency: 'USD' });
    expect(dep.body.declaration).toMatchObject({ kind: 'bitcoin', confirmationMethod: 'PROCESSOR_WEBHOOK', carrier: 'bitcoin_sandbox' });
    const stranger = await registerUser(app, { country: 'RW' });
    const denied = await request(app).post(`/api/deposits/${dep.body.payment.id}/bitcoin/simulate`).set(stranger.auth).send({ outcome: 'paid' });
    expect(denied.status).toBe(403);
    const paid = await request(app).post(`/api/deposits/${dep.body.payment.id}/bitcoin/simulate`).set(u.auth).send({ outcome: 'paid' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.payment.status).toBe('succeeded');
    const wallets = await request(app).get('/api/wallets').set(u.auth);
    const usd = wallets.body.items.find((w: any) => w.currency === 'USD');
    expect(usd.balance).toBe(2000 - paid.body.payment.fee);
    // an invoice marked invalid fails cleanly and credits nothing
    const dep2 = await request(app).post('/api/deposits').set(u.auth).send({ pin: '1234', method: 'bitcoin', amount: '5', currency: 'USD' });
    const invalid = await request(app).post(`/api/deposits/${dep2.body.payment.id}/bitcoin/simulate`).set(u.auth).send({ outcome: 'invalid' });
    expect(invalid.body.payment.status).toBe('failed');
    expect((await request(app).get('/api/wallets').set(u.auth)).body.items.find((w: any) => w.currency === 'USD').balance).toBe(usd.balance);
    // the sandbox simulator never touches a BTCPay-mode gateway
    const dep3 = await request(app).post('/api/deposits').set(u.auth).send({ pin: '1234', method: 'bitcoin', amount: '5', currency: 'USD' });
    upsertGateway({
      id: 'bitcoin',
      name: 'Bitcoin / Lightning',
      provider: 'bitcoin',
      enabled: true,
      methods: ['bitcoin'],
      currencies: [],
      sortOrder: 9,
      credentials: { mode: 'btcpay', serverUrl: 'https://btcpay.example', storeId: 'store', apiKey: 'key' },
    });
    const refused = await request(app).post(`/api/deposits/${dep3.body.payment.id}/bitcoin/simulate`).set(u.auth).send({ outcome: 'paid' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('sandbox_only');
    upsertGateway({
      id: 'bitcoin',
      name: 'Bitcoin / Lightning',
      provider: 'bitcoin',
      enabled: true,
      methods: ['bitcoin'],
      currencies: [],
      sortOrder: 9,
      credentials: { mode: '', serverUrl: '', storeId: '', apiKey: '' },
    });
  });

  it('BTC rates flow through the existing rate-import mechanism and stop being labelled sandbox', async () => {
    const admin = await adminToken(app);
    const before = bitcoinRate('USD');
    expect(before.sandbox).toBe(true);
    const imported = importRates({ id: 'admin' }, { BTC: 0.00002 }, 'treasury desk BTC sheet');
    expect(imported.updated).toContain('BTC');
    const after = bitcoinRate('USD');
    expect(after.rateSource).toBe(`import_v${imported.snapshotId}`);
    expect(after.sandbox).toBe(false);
    expect(after.label).toMatch(/Administrator-imported rate batch/);
    expect(after.midRate).toBeCloseTo(0.00002, 10);
    expect(after.rate).toBeCloseTo(0.00002 * (1 + after.marginBps / 10_000), 10);
    const status = await request(app).get('/api/admin/currencies').set(admin.auth);
    expect(status.body.items.find((c: any) => c.code === 'BTC')).toMatchObject({ decimals: 8, rateSource: after.rateSource });
  });
});
