/**
 * Published tariff grid: percentage fees with no fixed part (except the virtual-card issue), amount bands, the agent
 * commission per operation, the Pay-Link and request-money fee types, the card issue with a first load, and the
 * go-live profile applying a grid to a running platform.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, adminToken, registerUser, fund } from './helpers';
import { calculateFee, grossUpForFee } from '../services/ledger';
import { getFees } from '../services/settings';
import { dynamicCommissionBps } from '../services/risk/agentIntel';
import { findUserById, findUserByEmail } from '../services/users';
import { applyGoLiveProfileDocument } from '../services/goLiveProfile';
import { FEE_TYPES, FEE_TYPE_LABELS } from '@bitripay/shared';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

describe('tariff grid', () => {
  it('ships the published grid: percentages, no fixed fee except the card issue, bands and agent commissions', () => {
    const fees = getFees();
    for (const t of FEE_TYPES) expect(FEE_TYPE_LABELS[t], `label for ${t}`).toBeTruthy();
    expect(fees.transfer).toMatchObject({ bps: 75, fixed: 0, minAmount: 100, maxAmount: 1_000_000, agentBps: 50 });
    expect(fees.bill_payment).toMatchObject({ bps: 50, fixed: 0, agentBps: 20 });
    expect(fees.mobile_topup).toMatchObject({ bps: 75, fixed: 0, minAmount: 1_500, maxAmount: 10_000, agentBps: 50 });
    expect(fees.merchant_payment).toMatchObject({ bps: 80, fixed: 0 });
    expect(fees.money_request).toMatchObject({ bps: 80, fixed: 0 });
    expect(fees.payment_link).toMatchObject({ bps: 70, fixed: 0 });
    for (const t of ['mobile_money_deposit', 'bank_deposit', 'agent_cash_in', 'withdrawal', 'agent_cash_out']) expect(fees[t], t).toMatchObject({ bps: 70, fixed: 0, agentBps: 40 });
    expect(fees.remittance).toMatchObject({ bps: 100, fixed: 0, agentBps: 40 });
    expect(fees.virtual_card_issue).toMatchObject({ bps: 200, fixed: 200, minAmount: 10_000 });
    expect(fees.virtual_card_funding).toMatchObject({ bps: 100, fixed: 0 });
    expect(fees.gift_card).toMatchObject({ bps: 100, fixed: 0 });
    expect(fees.exchange).toMatchObject({ bps: 80, fixed: 0, agentBps: 50 });
    expect(calculateFee('transfer', 10_000, 'USD')).toBe(75);
    expect(calculateFee('remittance', 10_000, 'USD')).toBe(100);
    expect(calculateFee('virtual_card_issue', 10_000, 'USD')).toBe(200 + 200);
  });

  it('enforces the amount bands with explicit error codes and can price without the band', () => {
    expect(() => calculateFee('transfer', 99, 'USD')).toThrow(/minimum amount/i);
    try {
      calculateFee('transfer', 1_000_001, 'USD');
      throw new Error('should have refused');
    } catch (e: any) {
      expect(e.code).toBe('amount_above_maximum');
    }
    try {
      calculateFee('mobile_topup', 1_000, 'USD');
      throw new Error('should have refused');
    } catch (e: any) {
      expect(e.code).toBe('amount_below_minimum');
    }
    // bands are stored in the base currency and converted: 1.00 USD is 129.00 KES
    expect(() => calculateFee('transfer', 12_899, 'KES')).toThrow(/minimum/);
    expect(calculateFee('transfer', 12_900, 'KES')).toBe(97);
    expect(calculateFee('virtual_card_issue', 0, 'USD', null, { band: false })).toBe(200);
    // grossing up money in: what must be collected so that the net lands in the wallet
    const draw = grossUpForFee('bank_deposit', 10_000, 'USD');
    expect(draw - calculateFee('bank_deposit', draw, 'USD')).toBeGreaterThanOrEqual(10_000);
    expect(draw).toBeLessThan(10_100);
  });

  it('pays agents the commission of the operation unless a contract overrides it', async () => {
    const agent = await registerUser(app, { role: 'agent', businessName: 'Tariff Agent', tag: 'tariffagent' });
    const row = findUserById(agent.user.id)!;
    expect(dynamicCommissionBps(row, 'cash_in', 'agent_cash_in').base).toBe(40);
    expect(dynamicCommissionBps(row, 'other', 'transfer').base).toBe(50);
    expect(dynamicCommissionBps(row, 'other', 'bill_payment').base).toBe(20);
    expect(dynamicCommissionBps(row, 'other').base).toBe(50); // platform default when the operation is not on the grid
    const admin = await adminToken(app);
    const set = await request(app).patch(`/api/admin/users/${agent.user.id}`).set(admin.auth).send({ agentCommissionBps: 90 });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(dynamicCommissionBps(findUserById(agent.user.id)!, 'cash_in', 'agent_cash_in').base).toBe(90);
  });

  it('prices a payment link as Pay-Link and a money request as request money; issues a card with its first load', async () => {
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'Link Shop' });
    const link = await request(app).post('/api/payment-requests').set(merchant.auth).send({ kind: 'link', amount: '50.00', currency: 'USD' });
    expect(link.status, JSON.stringify(link.body)).toBe(201);
    const pay = await request(app)
      .post(`/api/checkout/${link.body.paymentRequest.code}/pay`)
      .send({ method: 'card', card: { number: '4242424242424242', expMonth: 12, expYear: 2031, cvc: '123', holderName: 'Guest' }, email: 'guest@example.com' });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    expect(pay.body.payment.fee).toBe(35); // 0.7% of 50.00
    const requester = await registerUser(app, { tag: 'tariffreq' });
    const payer = await registerUser(app);
    await fund(app, payer.user.id, '100.00');
    const req = await request(app)
      .post('/api/payment-requests')
      .set(requester.auth)
      .send({ kind: 'request', amount: '20.00', currency: 'USD', payer: '@' + payer.user.tag });
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    const paid = await request(app).post(`/api/payment-requests/${req.body.paymentRequest.code}/pay`).set(payer.auth).send({ pin: '1234' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.transaction.fee).toBe(16); // 0.8% of 20.00
    // virtual card: first load 150.00, issue fee 2.00 + 2% = 5.00; below the 100.00 minimum is refused
    const holder = await registerUser(app);
    await fund(app, holder.user.id, '200.00');
    const low = await request(app).post('/api/virtual-cards').set(holder.auth).send({ currency: 'USD', amount: '50.00', pin: '1234' });
    expect(low.status).toBe(422);
    expect(low.body.error.code).toBe('amount_below_minimum');
    const card = await request(app).post('/api/virtual-cards').set(holder.auth).send({ currency: 'USD', amount: '150.00', pin: '1234' });
    expect(card.status, JSON.stringify(card.body)).toBe(201);
    expect(card.body.card.balance).toBe(15_000);
    const wallets = await request(app).get('/api/wallets').set(holder.auth);
    expect(wallets.body.items[0].balance).toBe(20_000 - 15_000 - 500);
  });

  it('applies a tariff grid from the go-live profile and reports each line', async () => {
    await adminToken(app);
    const admin = findUserByEmail('admin@bitripay.local')!;
    const report = applyGoLiveProfileDocument(
      { fees: { transfer: { bps: 60, fixed: 0, minAmount: 100, maxAmount: 1_000_000, agentBps: 50 }, gift_card: { bps: 100, fixed: 0 } }, pricing: { p2pFeeBps: 70 } },
      admin,
    );
    expect(report.lines.find((l) => l.section === 'fees' && l.subject === 'transfer')?.action).toBe('updated');
    expect(report.lines.find((l) => l.section === 'fees' && l.subject === 'gift_card')?.action).toBe('unchanged');
    expect(calculateFee('transfer', 10_000, 'USD')).toBe(60);
    expect(getFees().remittance.bps).toBe(100); // untouched types keep their rule
    applyGoLiveProfileDocument({ fees: { transfer: { bps: 75, fixed: 0, minAmount: 100, maxAmount: 1_000_000, agentBps: 50 } }, pricing: { p2pFeeBps: 80 } }, admin);
  });
});
