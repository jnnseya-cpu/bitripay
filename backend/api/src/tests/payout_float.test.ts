/**
 * Demonstration payout float: a transfer to mobile money waits for liquidity until a prefunded payout account exists
 * for that operator; `ensurePayoutFloat` creates the account for the SIM, adds the float and re-queues the waiting
 * transfer; running it again only tops up; refused outside sandbox compliance mode.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, fund } from './helpers';
import { ensurePayoutFloat } from '../services/payoutFloat';
import { getSetting, setSetting } from '../services/settings';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

describe('demonstration payout float', () => {
  it('creates the operator SIM account, prefunds it and releases the transfer that was waiting for liquidity', async () => {
    const sender = await registerUser(app);
    await fund(app, sender.user.id, '100.00', 'USD');
    const opened = await request(app)
      .post('/api/money')
      .set(sender.auth)
      .send({
        source: { method: 'wallet' },
        destination: { method: 'mobile_money', operatorId: 'orange_cd', phone: '+243812345678', name: 'Test Recipient' },
        amount: '3',
        currency: 'USD',
        targetCurrency: 'CDF',
        pin: '1234',
      });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(opened.body.route.stage).toBe('INSUFFICIENT_LIQUIDITY');
    expect(opened.body.route.payout.stage).toBe('INSUFFICIENT_LIQUIDITY');

    const first = ensurePayoutFloat({ operatorId: 'orange_cd', msisdn: '+243 99 000 0001', amountMinor: 100_000_000 });
    expect(first.created).toBe(true);
    expect(first.account.msisdn).toBe('+243990000001');
    expect(first.account.currency).toBe('CDF');
    expect(first.account.balance).toBe(100_000_000);
    expect(first.requeued).toBe(1);

    const after = await request(app).get(`/api/money/${opened.body.route.id}`).set(sender.auth);
    expect(after.body.route.payout.stage).toBe('QUEUED');
    expect(after.body.route.payout.payoutAccountId).toBe(first.account.id);

    const again = ensurePayoutFloat({ operatorId: 'orange_cd', msisdn: '+243990000001', amountMinor: 50_000_000 });
    expect(again.created).toBe(false);
    expect(again.account.id).toBe(first.account.id);
    expect(again.account.balance).toBe(150_000_000); // the queued payout is reserved against the float and debited only when it settles
    expect(again.requeued).toBe(0);
  });

  it('refuses a short SIM number, a zero amount, and any mode other than sandbox', () => {
    expect(() => ensurePayoutFloat({ operatorId: 'orange_cd', msisdn: '+243', amountMinor: 100 })).toThrow(/full SIM number/);
    expect(() => ensurePayoutFloat({ operatorId: 'orange_cd', msisdn: '+243990000002', amountMinor: 0 })).toThrow(/greater than zero/);
    const before = getSetting<any>('compliance', { mode: 'sandbox' });
    setSetting('compliance', { ...before, mode: 'live' });
    try {
      expect(() => ensurePayoutFloat({ operatorId: 'orange_cd', msisdn: '+243990000002', amountMinor: 100 })).toThrow(/sandbox compliance mode only/);
    } finally {
      setSetting('compliance', before);
    }
  });
});
