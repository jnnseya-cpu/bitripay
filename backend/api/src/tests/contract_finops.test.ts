/**
 * Financial-operations contract: settlement currency vs collection currency (conversion posted through the ledger at
 * the platform rate with the disclosed margin), intents routed to a settlement profile, statements with the provider
 * fee, the BitriPay fee and the tax on it as separate lines, refunds allocated back across split recipients (pro rata
 * or absorbed by the merchant) from the domain bus, the specification stage aliases, the §62 domain events and the
 * promotional / pending balance classes in the e-money reconciliation.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, adminToken, fund } from './helpers';
import { getDb } from '../db';
import { convertWithMargin } from '../services/currencies';
import { getAppSettings } from '../services/settings';
import { subscribe, publish, DOMAIN_EVENT_TYPES, domainEventTypesUnique, type DomainEvent } from '../services/bus';
import { allocateRefundAcrossSplits, listSplitRefundAllocations } from '../services/finops/splits';
import { splitFeeTax } from '../services/finops/fees';
import { postTransaction } from '../services/ledger';
import { getUserWallet, ensureWallet } from '../services/wallets';
import { grantPromoCredit, classifyWalletParts, classifyBalance, reservePosition } from '../services/emoney';
import { ROUTE_STAGES, STAGE_ALIASES, ROUTE_STAGE_LABELS, stageAlias, stageFromAlias, withStageAlias, type RouteStage } from '../services/routeLifecycle';
import { openApiDocument } from '../docs/openapi';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

const walletBalance = async (auth: Record<string, string>, currency: string) =>
  ((await request(app).get('/api/wallets').set(auth)).body.items.find((w: any) => w.currency === currency)?.balance ?? 0) as number;

/** A merchant is paid from a customer wallet; returns the intent id and the ledger transaction that settled it. */
async function payMerchant(merchant: Awaited<ReturnType<typeof registerUser>>, payer: Awaited<ReturnType<typeof registerUser>>, amountMinor: number, extra: Record<string, unknown> = {}) {
  const intent = await request(app)
    .post('/api/v1/payment_intents')
    .set(merchant.auth)
    .send({ amount_minor: amountMinor, currency: 'USD', description: 'Order', ...extra });
  expect(intent.status, JSON.stringify(intent.body)).toBe(201);
  const paid = await request(app).post(`/api/v1/payment_intents/${intent.body.id}/pay/wallet`).set(payer.auth).send({ pin: '1234' });
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  const row = getDb().prepare('SELECT id, status, transaction_id FROM payment_intents WHERE id = ?').get(intent.body.id) as any;
  return { intentId: intent.body.id as string, transactionId: row.transaction_id as string, status: row.status as string };
}

/** Collect the domain events of one type published while `fn` runs. */
async function captured<T>(type: string, fn: () => Promise<T>): Promise<{ result: T; events: DomainEvent[] }> {
  const events: DomainEvent[] = [];
  const off = subscribe(`test-${type}`, [type], (ev) => {
    events.push(ev);
  });
  try {
    const result = await fn();
    return { result, events };
  } finally {
    off();
  }
}

describe('settlement currency and conversion', () => {
  it('a profile carries settlementCurrency and autoConvert; the preview discloses the conversion (rate, mid rate, margin) next to the fee lines', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Euro Shop', country: 'CD' });
    const payer = await registerUser(app);
    await fund(app, payer.user.id, '300.00');
    const profile = await request(app)
      .post('/api/v1/settlement_profiles')
      .set(m.auth)
      .send({ currency: 'USD', schedule: 'manual', destination: { method: 'wallet' }, settlement_currency: 'eur', auto_convert: true });
    expect(profile.status, JSON.stringify(profile.body)).toBe(201);
    expect(profile.body.settlementCurrency).toBe('EUR');
    expect(profile.body.autoConvert).toBe(true);
    expect((await request(app).get(`/api/v1/settlement_profiles/${profile.body.id}`).set(m.auth)).body.settlementCurrency).toBe('EUR');
    await payMerchant(m, payer, 10_000); // fee 150
    const preview = await request(app).get(`/api/v1/settlement_profiles/${profile.body.id}/preview`).set(m.auth);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.collectionCurrency).toBe('USD');
    expect(preview.body.settlementCurrency).toBe('EUR');
    expect(preview.body.wouldSkip).toBe(false);
    expect(preview.body.totals.gross).toBe(10_000);
    expect(preview.body.totals.fees).toBe(150);
    expect(preview.body.totals.platformFees + preview.body.totals.feeTax).toBe(150);
    expect(preview.body.totals.net).toBe(9_850);
    const quote = convertWithMargin(9_850, 'USD', 'EUR');
    expect(quote.marginBps).toBe(getAppSettings().exchangeMarginBps);
    expect(preview.body.settlement).toMatchObject({ currency: 'EUR', amountMinor: quote.amount, convertsAt: 'close' });
    expect(preview.body.settlement.conversion).toMatchObject({
      fromCurrency: 'USD',
      toCurrency: 'EUR',
      fromMinor: 9_850,
      toMinor: quote.amount,
      rate: quote.rate,
      midRate: quote.midRate,
      marginBps: quote.marginBps,
      transactionId: null,
    });
    expect(preview.body.settlement.conversion.rate).toBeCloseTo(quote.midRate * (1 - quote.marginBps / 10_000), 10);
    expect(preview.body.items).toHaveLength(1);
    expect(preview.body.items[0]).toMatchObject({ amountMinor: 10_000, feeMinor: 150 });
    // another merchant cannot preview it
    const other = await registerUser(app, { role: 'merchant', businessName: 'Other', country: 'CD' });
    expect((await request(app).get(`/api/v1/settlement_profiles/${profile.body.id}/preview`).set(other.auth)).status).toBe(404);
  });

  it('closing the cycle converts the obligation through the ledger at the disclosed rate and publishes settlement.closed; paying it publishes settlement.paid in the currency actually paid', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Converted Shop', country: 'CD' });
    const payer = await registerUser(app);
    await fund(app, payer.user.id, '300.00');
    await request(app)
      .post('/api/v1/settlement_profiles')
      .set(m.auth)
      .send({ currency: 'USD', schedule: 'manual', destination: { method: 'wallet' }, settlement_currency: 'EUR', auto_convert: true });
    await payMerchant(m, payer, 10_000);
    const usdBefore = await walletBalance(m.auth, 'USD');
    const quote = convertWithMargin(9_850, 'USD', 'EUR');
    const { result: cycle, events } = await captured('settlement.closed', async () => (await request(app).post('/api/v1/settlement_cycles').set(m.auth).send({ currency: 'USD' })).body);
    expect(cycle.status).toBe('CLOSED');
    expect(cycle.netMinor).toBe(9_850);
    expect(cycle.settlementCurrency).toBe('EUR');
    expect(cycle.settlementAmountMinor).toBe(quote.amount);
    expect(cycle.conversion.transactionId).toBeTruthy();
    expect(cycle.conversion.convertedAt).toBeTruthy();
    expect(cycle.conversion.error).toBeNull();
    // the conversion is a real exchange posting: the USD wallet lost the net, the EUR wallet received the converted amount
    const tx = getDb().prepare('SELECT * FROM transactions WHERE id = ?').get(cycle.conversion.transactionId) as any;
    expect(tx.type).toBe('exchange');
    expect(tx.amount).toBe(9_850);
    expect(tx.receive_currency).toBe('EUR');
    expect(tx.receive_amount).toBe(quote.amount);
    expect(JSON.parse(tx.metadata)).toMatchObject({ settlementCycleId: cycle.id, settlementConversion: true, marginBps: quote.marginBps, rate: quote.rate });
    expect(await walletBalance(m.auth, 'USD')).toBe(usdBefore - 9_850);
    expect(await walletBalance(m.auth, 'EUR')).toBe(quote.amount);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ userId: m.user.id, cycleId: cycle.id, currency: 'USD', amountMinor: 9_850, settlementCurrency: 'EUR', settlementAmountMinor: quote.amount });
    expect(events[0].tenantId).toBe(m.user.id);
    // the statement discloses the conversion in every format
    const stmt = await request(app).get(`/api/v1/settlement_cycles/${cycle.id}/statement`).set(m.auth);
    expect(stmt.body.settlement).toMatchObject({ currency: 'EUR', amountMinor: quote.amount });
    expect(stmt.body.settlement.conversion.transactionId).toBe(cycle.conversion.transactionId);
    const csv = await request(app).get(`/api/v1/settlement_cycles/${cycle.id}/statement`).set(m.auth).query({ format: 'csv' });
    expect(csv.text).toContain('# Settlement:');
    expect(csv.text).toContain(`margin ${quote.marginBps} bps`);
    expect(csv.text).toContain(`posted ${cycle.conversion.transactionId}`);
    const paid = await captured('settlement.paid', async () => (await request(app).post(`/api/v1/settlement_cycles/${cycle.id}/pay`).set(m.auth).send({})).body);
    expect(paid.result.status).toBe('PAID');
    expect(paid.events).toHaveLength(1);
    expect(paid.events[0].payload).toMatchObject({ userId: m.user.id, cycleId: cycle.id, currency: 'EUR', amountMinor: quote.amount, method: 'wallet' });
  });

  it('with auto-convert off the close only quotes the conversion; it is posted when the cycle is paid', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Deferred Shop', country: 'CD' });
    const payer = await registerUser(app);
    await fund(app, payer.user.id, '100.00');
    await request(app)
      .post('/api/v1/settlement_profiles')
      .set(m.auth)
      .send({ currency: 'USD', schedule: 'manual', destination: { method: 'wallet' }, settlement_currency: 'EUR', auto_convert: false });
    await payMerchant(m, payer, 5_000); // fee 75
    const quote = convertWithMargin(4_925, 'USD', 'EUR');
    const cycle = (await request(app).post('/api/v1/settlement_cycles').set(m.auth).send({ currency: 'USD' })).body;
    expect(cycle.status).toBe('CLOSED');
    expect(cycle.conversion).toMatchObject({ toMinor: quote.amount, transactionId: null, convertedAt: null });
    expect(cycle.settlementAmountMinor).toBe(quote.amount);
    expect(await walletBalance(m.auth, 'EUR')).toBe(0);
    const preview = (await request(app).get(`/api/v1/settlement_profiles/${cycle.profileId}/preview`).set(m.auth)).body;
    expect(preview.settlement.convertsAt).toBeNull(); // nothing left to settle right now
    expect(preview.wouldSkip).toBe(true);
    const paid = (await request(app).post(`/api/v1/settlement_cycles/${cycle.id}/pay`).set(m.auth).send({})).body;
    expect(paid.status).toBe('PAID');
    expect(paid.conversion.transactionId).toBeTruthy();
    expect(await walletBalance(m.auth, 'EUR')).toBe(quote.amount);
    expect(await walletBalance(m.auth, 'USD')).toBe(0);
  });

  it('an administrator toggles auto-convert (and the settlement currency) with an audit trail', async () => {
    const admin = await adminToken(app);
    const m = await registerUser(app, { role: 'merchant', businessName: 'Toggled Shop', country: 'CD' });
    const profile = (
      await request(app)
        .post('/api/v1/settlement_profiles')
        .set(m.auth)
        .send({ currency: 'USD', schedule: 'T1', destination: { method: 'wallet' } })
    ).body;
    expect(profile.settlementCurrency).toBe('USD');
    expect(profile.autoConvert).toBe(false);
    const on = await request(app).post(`/api/admin/finops/settlement_profiles/${profile.id}/auto_convert`).set(admin.auth).send({ enabled: true, settlementCurrency: 'gbp' });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body).toMatchObject({ id: profile.id, autoConvert: true, settlementCurrency: 'GBP' });
    const off = await request(app).post(`/api/admin/finops/settlement_profiles/${profile.id}/auto_convert`).set(admin.auth).send({ enabled: false });
    expect(off.body).toMatchObject({ autoConvert: false, settlementCurrency: 'GBP' });
    expect((await request(app).get(`/api/v1/settlement_profiles/${profile.id}`).set(m.auth)).body).toMatchObject({ autoConvert: false, settlementCurrency: 'GBP' });
    const audits = getDb().prepare("SELECT details FROM audit_logs WHERE action = 'settlements.profile.auto_convert' AND target_id = ? ORDER BY created_at").all(profile.id) as any[];
    expect(audits).toHaveLength(2);
    expect(JSON.parse(audits[0].details)).toMatchObject({ enabled: true, settlementCurrency: 'GBP', previous: { enabled: false, settlementCurrency: 'USD' } });
    const events = getDb().prepare("SELECT COUNT(*) c FROM event_log WHERE subject_id = ? AND event = 'settlement_profile.auto_convert'").get(profile.id) as any;
    expect(events.c).toBe(2);
    expect((await request(app).get(`/api/admin/finops/settlement_profiles/${profile.id}/preview`).set(admin.auth)).body.settlementCurrency).toBe('GBP');
    expect((await request(app).post('/api/admin/finops/settlement_profiles/sp_missing/auto_convert').set(admin.auth).send({ enabled: true })).status).toBe(404);
  });

  it('an intent assigned to a settlement profile is settled in that profile’s cycle, not the default one', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Routed Shop', country: 'CD' });
    const payer = await registerUser(app);
    await fund(app, payer.user.id, '100.00');
    const dflt = (
      await request(app)
        .post('/api/v1/settlement_profiles')
        .set(m.auth)
        .send({ currency: 'USD', schedule: 'manual', destination: { method: 'wallet' } })
    ).body;
    const card = (
      await request(app)
        .post('/api/v1/settlement_profiles')
        .set(m.auth)
        .send({ rail: 'card', currency: 'USD', schedule: 'manual', destination: { method: 'wallet' } })
    ).body;
    expect(card.id).not.toBe(dflt.id);
    const a = await payMerchant(m, payer, 1_000);
    const b = await payMerchant(m, payer, 2_000);
    getDb().prepare('UPDATE payment_intents SET settlement_profile_id = ? WHERE id = ?').run(card.id, b.intentId);
    expect((await request(app).get(`/api/v1/settlement_profiles/${dflt.id}/preview`).set(m.auth)).body.items.map((i: any) => i.intentId)).toEqual([a.intentId]);
    expect((await request(app).get(`/api/v1/settlement_profiles/${card.id}/preview`).set(m.auth)).body.items.map((i: any) => i.intentId)).toEqual([b.intentId]);
    const first = (await request(app).post('/api/v1/settlement_cycles').set(m.auth).send({ currency: 'USD' })).body;
    expect(first.profileId).toBe(dflt.id);
    expect(first.grossMinor).toBe(1_000);
    expect(first.itemCount).toBe(1);
    const second = (await request(app).post('/api/v1/settlement_cycles').set(m.auth).send({ currency: 'USD', rail: 'card' })).body;
    expect(second.profileId).toBe(card.id);
    expect(second.grossMinor).toBe(2_000);
    const items = getDb().prepare('SELECT intent_id, cycle_id FROM settlement_items WHERE intent_id IN (?, ?)').all(a.intentId, b.intentId) as any[];
    expect(items.find((i) => i.intent_id === a.intentId).cycle_id).toBe(first.id);
    expect(items.find((i) => i.intent_id === b.intentId).cycle_id).toBe(second.id);
  });
});

describe('statements with separate fee and tax lines', () => {
  it('JSON, CSV and PDF statements show the provider fee, the BitriPay fee and the tax on it per line and in the totals', async () => {
    const admin = await adminToken(app);
    const tax = await request(app).put('/api/admin/finops/fees/tax').set(admin.auth).send({ feeTaxRateBps: 1800, feeTaxLabel: 'VAT' });
    expect(tax.status, JSON.stringify(tax.body)).toBe(200);
    expect(tax.body).toEqual({ feeTaxRateBps: 1800, feeTaxLabel: 'VAT' });
    expect((await request(app).get('/api/admin/finops/fees/tax').set(admin.auth)).body.feeTaxRateBps).toBe(1800);
    expect(splitFeeTax(150, 1800)).toEqual({ platformFeeMinor: 127, feeTaxMinor: 23, taxRateBps: 1800 });
    expect(splitFeeTax(150, 0)).toEqual({ platformFeeMinor: 150, feeTaxMinor: 0, taxRateBps: 0 });
    try {
      const m = await registerUser(app, { role: 'merchant', businessName: 'Taxed Shop', country: 'CD' });
      const payer = await registerUser(app);
      await fund(app, payer.user.id, '200.00');
      await request(app)
        .post('/api/v1/settlement_profiles')
        .set(m.auth)
        .send({ currency: 'USD', schedule: 'manual', destination: { method: 'wallet' } });
      const p1 = await payMerchant(m, payer, 10_000); // fee 150 → 127 + 23
      const p2 = await payMerchant(m, payer, 4_000); // fee 60 → 51 + 9
      // the connector recorded what the rail charged for the first collection
      getDb().prepare("UPDATE transactions SET metadata = json_set(metadata, '$.providerFeeMinor', 40) WHERE id = ?").run(p1.transactionId);
      const cycle = (await request(app).post('/api/v1/settlement_cycles').set(m.auth).send({ currency: 'USD' })).body;
      expect(cycle).toMatchObject({ grossMinor: 14_000, feesMinor: 210, providerFeesMinor: 40, platformFeesMinor: 178, feeTaxMinor: 32, netMinor: 14_000 - 210 });
      const view = await request(app).get(`/api/v1/settlements/${cycle.id}`).set(m.auth);
      expect(view.status, JSON.stringify(view.body)).toBe(200);
      expect(view.body.statement.number).toMatch(/^SET-\d{8}-/);
      expect(view.body.statement.totals).toMatchObject({ gross: 14_000, fees: 210, providerFees: 40, platformFees: 178, feeTax: 32, taxRateBps: 1800, taxLabel: 'VAT', net: 13_790 });
      expect(view.body.statement.totals.formatted.feeTax).toBeTruthy();
      const byIntent = Object.fromEntries(view.body.items.map((i: any) => [i.intentId, i]));
      expect(byIntent[p1.intentId]).toMatchObject({ amountMinor: 10_000, feeMinor: 150, providerFeeMinor: 40, platformFeeMinor: 127, feeTaxMinor: 23 });
      expect(byIntent[p2.intentId]).toMatchObject({ amountMinor: 4_000, feeMinor: 60, providerFeeMinor: 0, platformFeeMinor: 51, feeTaxMinor: 9 });
      // the existing columns are all still there
      expect(view.body).toMatchObject({ id: cycle.id, grossMinor: 14_000, feesMinor: 210, refundsMinor: 0, splitsMinor: 0, holdsMinor: 0, hash: cycle.hash });
      const csv = await request(app).get(`/api/v1/settlement_cycles/${cycle.id}/statement`).set(m.auth).query({ format: 'csv' });
      expect(csv.text).toContain('Date,Reference,Kind,Description,Amount,Fee,Provider fee,BitriPay fee,Tax on BitriPay fee');
      expect(csv.text).toContain('# Provider fee 0.40 · BitriPay fee 1.78 · Tax on BitriPay fee 0.32 (VAT 18%)');
      expect(csv.text).toContain(',10000.00,1.50,0.40,1.27,0.23'.replace('10000.00', '100.00'));
      const pdf = await request(app)
        .get(`/api/v1/settlement_cycles/${cycle.id}/statement`)
        .set(m.auth)
        .query({ format: 'pdf' })
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      expect((pdf.body as Buffer).length).toBeGreaterThan(1000);
      // ownership: another merchant gets 404, the administrator sees the same view
      const other = await registerUser(app, { role: 'merchant', businessName: 'Nosy', country: 'CD' });
      expect((await request(app).get(`/api/v1/settlements/${cycle.id}`).set(other.auth)).status).toBe(404);
      expect((await request(app).get(`/api/admin/finops/settlements/${cycle.id}`).set(admin.auth)).body.statement.totals.feeTax).toBe(32);
    } finally {
      await request(app).put('/api/admin/finops/fees/tax').set(admin.auth).send({ feeTaxRateBps: 0 });
    }
    expect((await request(app).put('/api/admin/finops/fees/tax').set(admin.auth).send({ feeTaxRateBps: 20_000 })).status).toBe(400);
  });
});

describe('split refund allocation', () => {
  it('pro rata: each recipient gives back the refunded proportion of its share through reverse ledger legs, once per refund', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Market', country: 'CD' });
    const p1 = await registerUser(app, { tag: 'prorata1' });
    const p2 = await registerUser(app, { tag: 'prorata2' });
    const payer = await registerUser(app);
    await fund(app, payer.user.id, '100.00');
    // fee 60 → received 3940; fixed 500 first, then 50% of 3440 = 1720
    const paid = await payMerchant(m, payer, 4_000, {
      splits: [
        { recipient: 'prorata1', bps: 5000 },
        { recipient: 'prorata2', fixed_minor: 500 },
      ],
    });
    expect(await walletBalance(p1.auth, 'USD')).toBe(1_720);
    expect(await walletBalance(p2.auth, 'USD')).toBe(500);
    const merchantBefore = await walletBalance(m.auth, 'USD');
    const out = allocateRefundAcrossSplits(paid.intentId, 'rf_direct_1', 2_000, { type: 'system' });
    expect(out).toHaveLength(2);
    const byUser = Object.fromEntries(out.map((a) => [a.recipientUserId, a]));
    expect(byUser[p1.user.id]).toMatchObject({ amountMinor: 860, policy: 'pro_rata', status: 'RECOVERED', currency: 'USD', refundId: 'rf_direct_1' });
    expect(byUser[p2.user.id]).toMatchObject({ amountMinor: 250, policy: 'pro_rata', status: 'RECOVERED' });
    expect(await walletBalance(p1.auth, 'USD')).toBe(860);
    expect(await walletBalance(p2.auth, 'USD')).toBe(250);
    expect(await walletBalance(m.auth, 'USD')).toBe(merchantBefore + 1_110);
    const tx = getDb().prepare('SELECT * FROM transactions WHERE id = ?').get(byUser[p1.user.id].transactionId!) as any;
    expect(tx).toMatchObject({ type: 'distribution', amount: 860, sender_user_id: p1.user.id, receiver_user_id: m.user.id, status: 'completed' });
    expect(JSON.parse(tx.metadata)).toMatchObject({ intentId: paid.intentId, split: true, splitRefund: true, refundId: 'rf_direct_1', policy: 'pro_rata' });
    expect((getDb().prepare('SELECT COUNT(*) c FROM ledger_entries WHERE transaction_id = ?').get(tx.id) as any).c).toBe(2);
    // idempotent per refund; a second refund recovers from what is left
    expect(allocateRefundAcrossSplits(paid.intentId, 'rf_direct_1', 2_000, { type: 'system' })).toHaveLength(2);
    expect(listSplitRefundAllocations(paid.intentId)).toHaveLength(2);
    const rest = allocateRefundAcrossSplits(paid.intentId, 'rf_direct_2', 4_000, { type: 'system' });
    expect(rest.find((a) => a.recipientUserId === p1.user.id)!.amountMinor).toBe(860); // capped by the share not yet given back
    expect(await walletBalance(p1.auth, 'USD')).toBe(0);
    const listed = await request(app).get(`/api/v1/payment_intents/${paid.intentId}/split_refunds`).set(m.auth).query({ refund: 'rf_direct_2' });
    expect(listed.body.data).toHaveLength(2);
    expect((await request(app).get(`/api/v1/payment_intents/${paid.intentId}/split_refunds`).set(m.auth)).body.data).toHaveLength(4);
    expect((await request(app).get(`/api/v1/payment_intents/${paid.intentId}/split_refunds`).set(p1.auth)).status).toBe(403);
    expect(() => allocateRefundAcrossSplits(paid.intentId, 'rf_bad', 0, { type: 'system' })).toThrow();
  });

  it('merchant_absorbs: the recipient keeps its share and the allocation is recorded as ABSORBED', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Absorbing Market', country: 'CD' });
    const p = await registerUser(app, { tag: 'absorbed1' });
    const payer = await registerUser(app);
    await fund(app, payer.user.id, '100.00');
    const paid = await payMerchant(m, payer, 4_000, { splits: [{ recipient: 'absorbed1', bps: 5000, label: 'Chef' }] });
    const row = getDb().prepare('SELECT metadata FROM payment_intents WHERE id = ?').get(paid.intentId) as any;
    const meta = JSON.parse(row.metadata);
    meta.splits[0].refundPolicy = 'merchant_absorbs';
    getDb().prepare('UPDATE payment_intents SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), paid.intentId);
    const before = await walletBalance(p.auth, 'USD');
    expect(before).toBe(1_970);
    const out = allocateRefundAcrossSplits(paid.intentId, 'rf_absorb_1', 4_000, { type: 'system' });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ policy: 'merchant_absorbs', status: 'ABSORBED', amountMinor: 0, transactionId: null });
    expect(await walletBalance(p.auth, 'USD')).toBe(before);
    const ev = getDb().prepare("SELECT details FROM event_log WHERE subject_id = ? AND event = 'splits.refund_allocated'").get(paid.intentId) as any;
    expect(JSON.parse(ev.details)).toMatchObject({ refundId: 'rf_absorb_1', recovered: 0, absorbed: 1, failed: 0 });
  });

  it('a refund.succeeded event on the domain bus allocates the refund; a redelivery changes nothing', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Bus Market', country: 'CD' });
    const p = await registerUser(app, { tag: 'busrecipient' });
    const payer = await registerUser(app);
    await fund(app, payer.user.id, '100.00');
    const paid = await payMerchant(m, payer, 4_000, { splits: [{ recipient: 'busrecipient', bps: 5000 }] });
    const payload = { intentId: paid.intentId, refundId: 'rf_bus_1', amountMinor: 1_000, currency: 'USD', merchantUserId: m.user.id, merchantId: m.user.id };
    const ev = publish('refund.succeeded', payload, { aggregateId: paid.intentId, tenantId: m.user.id });
    expect(ev.type).toBe('refund.succeeded');
    const handled = getDb().prepare('SELECT handled FROM domain_events WHERE event_id = ?').get(ev.eventId) as any;
    expect(JSON.parse(handled.handled)).toContain('splits-refund-allocation');
    const allocations = listSplitRefundAllocations(paid.intentId, 'rf_bus_1');
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({ amountMinor: Math.round(1_970 * 0.25), status: 'RECOVERED', recipientUserId: p.user.id });
    expect(await walletBalance(p.auth, 'USD')).toBe(1_970 - Math.round(1_970 * 0.25));
    publish('refund.succeeded', payload, { aggregateId: paid.intentId, tenantId: m.user.id });
    expect(listSplitRefundAllocations(paid.intentId)).toHaveLength(1);
    // an event without the contract fields is ignored, never thrown
    publish('refund.succeeded', { refundId: 'rf_bus_2' }, { tenantId: m.user.id });
    expect(listSplitRefundAllocations(paid.intentId)).toHaveLength(1);
  });

  it('a refund executed through the gateway claws the shares back end to end', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'E2E Market', country: 'CD' });
    const p = await registerUser(app, { tag: 'e2erecipient' });
    const payer = await registerUser(app);
    await fund(app, payer.user.id, '100.00');
    await fund(app, m.user.id, '50.00'); // the refund principal leaves the merchant wallet first
    const paid = await payMerchant(m, payer, 4_000, { splits: [{ recipient: 'e2erecipient', bps: 5000 }] });
    const refund = await request(app).post('/api/v1/refunds').set(m.auth).set('Idempotency-Key', 'rf-e2e-1').send({ payment_intent: paid.intentId, amount_minor: 2_000, reason: 'half returned' });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    expect(refund.body.refundTransactionId).toBeTruthy();
    const allocations = listSplitRefundAllocations(paid.intentId, refund.body.id);
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({ amountMinor: 985, status: 'RECOVERED', recipientUserId: p.user.id });
    expect(await walletBalance(p.auth, 'USD')).toBe(1_970 - 985);
    const bus = getDb().prepare("SELECT payload FROM domain_events WHERE type = 'refund.succeeded' AND aggregate_id = ?").all(paid.intentId) as any[];
    expect(bus.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(bus[0].payload)).toMatchObject({ intentId: paid.intentId, refundId: refund.body.id, amountMinor: 2_000, currency: 'USD', merchantUserId: m.user.id });
  });

  it('a recipient that cannot cover its part is recorded FAILED and recovered on retry', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Retry Market', country: 'CD' });
    const p = await registerUser(app, { tag: 'brokerecipient' });
    const sink = await registerUser(app);
    const payer = await registerUser(app);
    await fund(app, payer.user.id, '100.00');
    const paid = await payMerchant(m, payer, 4_000, { splits: [{ recipient: 'brokerecipient', bps: 5000 }] });
    // the recipient has already moved most of its share on
    postTransaction({
      type: 'transfer',
      amount: 1_900,
      currency: 'USD',
      fromWalletId: getUserWallet(p.user.id, 'USD').id,
      toWalletId: ensureWallet(sink.user.id, 'USD').id,
      senderUserId: p.user.id,
      receiverUserId: sink.user.id,
    });
    const out = allocateRefundAcrossSplits(paid.intentId, 'rf_retry_1', 4_000, { type: 'system' });
    expect(out[0]).toMatchObject({ amountMinor: 1_970, status: 'FAILED' });
    expect(out[0].error).toBeTruthy();
    await fund(app, p.user.id, '20.00');
    const retried = await request(app).post(`/api/v1/payment_intents/${paid.intentId}/split_refunds/retry`).set(m.auth).send({});
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.data[0]).toMatchObject({ status: 'RECOVERED', error: null });
    expect(retried.body.data[0].transactionId).toBeTruthy();
    const admin = await adminToken(app);
    expect((await request(app).get(`/api/admin/finops/splits/${paid.intentId}/refunds`).set(admin.auth)).body.items[0].status).toBe('RECOVERED');
  });
});

describe('stage aliases', () => {
  const SPEC_NAMES = ['QUOTED', 'FUNDS_RECEIVED', 'INSTRUCTION_ISSUED', 'PAYMENT_SENT', 'CONFIRMED', 'RELEASED', 'REFUNDED', 'FAILED', 'EXPIRED', 'UNDER_REVIEW'];

  it('every specification stage name maps to a real built stage and aliases round-trip both ways', async () => {
    for (const name of SPEC_NAMES) {
      const built = stageFromAlias(name);
      expect(built, name).not.toBeNull();
      expect(ROUTE_STAGES, name).toContain(built);
      expect(STAGE_ALIASES[name]).toBe(built);
      expect(stageAlias(built!), name).toBe(name);
    }
    expect(stageFromAlias('FUNDS_RECEIVED')).toBe('FUNDED');
    expect(stageFromAlias('INSTRUCTION_ISSUED')).toBe('PAYOUT_ROUTED');
    expect(stageFromAlias('PAYMENT_SENT')).toBe('PAYOUT_SENT');
    expect(stageFromAlias('CONFIRMED')).toBe('VERIFIED');
    expect(stageFromAlias('RELEASED')).toBe('SETTLED');
    expect(stageFromAlias('UNDER_REVIEW')).toBe('MANUAL_REVIEW');
    // every built stage renders under exactly one alias that resolves back to it
    for (const stage of ROUTE_STAGES) expect(stageFromAlias(stageAlias(stage)), stage).toBe(stage);
    expect(new Set(ROUTE_STAGES.map(stageAlias)).size).toBe(ROUTE_STAGES.length);
    // built names and loose spellings resolve too; unknown names do not
    expect(stageFromAlias('PAYOUT_SENT')).toBe('PAYOUT_SENT');
    expect(stageFromAlias('funds received')).toBe('FUNDED');
    expect(stageFromAlias('under-review')).toBe('MANUAL_REVIEW');
    expect(stageFromAlias('NOT_A_STAGE')).toBeNull();
    expect(stageFromAlias('')).toBeNull();
    // route views carry the alias next to the built stage, and the labels expose it to clients
    expect(withStageAlias({ stage: 'FUNDED' as RouteStage, id: 'r1' })).toEqual({ stage: 'FUNDED', id: 'r1', stageAlias: 'FUNDS_RECEIVED' });
    expect(ROUTE_STAGE_LABELS.SETTLED.alias).toBe('RELEASED');
    expect(ROUTE_STAGE_LABELS.MANUAL_REVIEW.alias).toBe('UNDER_REVIEW');
    const u = await registerUser(app);
    const corridors = await request(app).get('/api/money/corridors').set(u.auth);
    expect(corridors.status).toBe(200);
    expect(corridors.body.stages.FUNDED.alias).toBe('FUNDS_RECEIVED');
    expect(corridors.body.stages.PAYOUT_ROUTED.alias).toBe('INSTRUCTION_ISSUED');
  });
});

describe('domain events (§62)', () => {
  it('the specification events are catalogued exactly once', () => {
    expect(domainEventTypesUnique()).toBe(true);
    for (const t of [
      'payment.captured',
      'payment.settled',
      'payment.refunded',
      'payment.disputed',
      'payout.created',
      'payout.executed',
      'settlement.closed',
      'settlement.paid',
      'wallet.credited',
      'wallet.debited',
      'kyc.tier_changed',
      'agent.float_low',
      'rail.state_changed',
      'refund.succeeded',
    ])
      expect(DOMAIN_EVENT_TYPES, t).toContain(t);
    expect(DOMAIN_EVENT_TYPES.filter((t) => t === 'settlement.closed')).toHaveLength(1);
  });

  it('the OpenAPI document describes the settlement contract routes', () => {
    const doc = openApiDocument();
    expect(doc.paths['/settlements/{id}'].get).toBeTruthy();
    expect(doc.paths['/settlement_profiles/{id}/preview'].get).toBeTruthy();
    expect(doc.paths['/settlement_profiles/{id}'].get).toBeTruthy();
    expect(doc.paths['/payment_intents/{id}/split_refunds'].get).toBeTruthy();
    expect((doc.paths['/settlements/{id}'].get as any)['x-scope']).toBe('settlements:read');
  });
});

describe('balance classes: promotional and pending', () => {
  it('promotional credit is a platform liability and settlement-pending captures are not yet issued; both stay out of customer e-money', async () => {
    const admin = await adminToken(app);
    const u = await registerUser(app);
    await fund(app, u.user.id, '20.00');
    grantPromoCredit(u.user.id, 'USD', 500, 'welcome', 'Contract test');
    const parts = classifyWalletParts(getUserWallet(u.user.id, 'USD'));
    expect(parts.map((p) => p.class)).toEqual(['sandbox', 'promotional']);
    expect(parts[0]).toMatchObject({ amountMinor: 2_000, emoney: false }); // sandbox money is never e-money either
    expect(parts[1]).toMatchObject({ class: 'promotional', amountMinor: 500, emoney: false, label: 'Promotional credit – not money' });
    expect(classifyBalance(u.user, 'USD', 'promotional')).toMatchObject({ class: 'promotional', redeemable: false, transferable: false });
    expect(classifyBalance(u.user, 'USD', 'pending')).toMatchObject({ class: 'pending', redeemable: false, transferable: false });
    // a merchant with a capture announced by the rail and awaiting settlement
    const m = await registerUser(app, { role: 'merchant', businessName: 'Pending Shop', country: 'CD' });
    const intent = await request(app).post('/api/v1/payment_intents').set(m.auth).send({ amount_minor: 7_500, currency: 'USD', description: 'Card order' });
    expect(intent.status).toBe(201);
    getDb().prepare("UPDATE payment_intents SET status = 'SETTLEMENT_PENDING' WHERE id = ?").run(intent.body.id);
    const mParts = classifyWalletParts(ensureWallet(m.user.id, 'USD'), m.user);
    expect(mParts.find((p) => p.class === 'pending')).toMatchObject({ amountMinor: 7_500, emoney: false, label: 'Pending settlement' });
    const balance = await request(app).get('/api/v1/balance').set(m.auth);
    expect(balance.body.data.find((b: any) => b.currency === 'USD').settlement_pending).toBe(7_500);
    // the reconciliation reports both classes and keeps them out of the e-money liabilities
    const programme = getDb().prepare("SELECT * FROM emoney_programmes WHERE currency = 'USD'").get() as any;
    expect(programme).toBeTruthy();
    const position = reservePosition(programme);
    expect(position.promotionalLiabilities).toBeGreaterThanOrEqual(500);
    expect(position.pendingNotIssued).toBeGreaterThanOrEqual(7_500);
    const walletSum = (getDb().prepare("SELECT COALESCE(SUM(w.balance), 0) s FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.is_system = 0 AND w.currency = 'USD'").get() as any).s as number;
    expect(position.liabilities).toBeLessThanOrEqual(walletSum); // promo and pending are not in there
    const run = await request(app).post('/api/admin/emoney/reconcile').set(admin.auth);
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    const recon = getDb().prepare("SELECT details FROM reserve_reconciliations WHERE currency = 'USD' ORDER BY created_at DESC LIMIT 1").get() as any;
    expect(JSON.parse(recon.details)).toMatchObject({ promotionalLiabilities: position.promotionalLiabilities, pendingNotIssued: position.pendingNotIssued });
  });
});
