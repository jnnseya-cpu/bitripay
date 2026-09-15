/**
 * Test accounts for a demonstration: customer, merchant and agent created on the platform with verified KYC, a PIN,
 * their organisation (merchant, agent) and sandbox balances; idempotent; refused outside sandbox compliance mode and
 * without a contact for the person who will use the account.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp } from './helpers';
import { createDemoAccounts } from '../services/demoAccounts';
import { getSetting, setSetting } from '../services/settings';
import { getDb } from '../db';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

describe('demonstration test accounts', () => {
  it('creates the three accounts with PIN, KYC, organisation and sandbox balances, and signs each in', async () => {
    const n = Math.floor(Math.random() * 1e6);
    const results = createDemoAccounts([
      { role: 'customer', phone: `+24381${String(n).padStart(7, '0')}`, tag: `client${n}`, password: 'ClientTest123!' },
      { role: 'merchant', email: `marche${n}@test.local`, tag: `marche${n}`, businessName: 'Pharmacie Test', pin: '2468' },
      { role: 'agent', phone: `+24389${String(n).padStart(7, '0')}`, email: `agent${n}@test.local`, tag: `agent${n}` },
    ]);
    expect(results.map((r) => [r.role, r.created])).toEqual([
      ['customer', true],
      ['merchant', true],
      ['agent', true],
    ]);
    const [customer, merchant, agent] = results;
    expect(customer.password).toBe('ClientTest123!');
    expect(customer.pin).toBe('1234');
    expect(merchant.pin).toBe('2468');
    expect(merchant.businessName).toBe('Pharmacie Test');
    expect(agent.password).toMatch(/^Test-/);
    for (const r of results) {
      expect(r.balances.map((b) => b.currency).sort()).toEqual(['CDF', 'USD']);
      expect(r.balances.every((b) => b.balance > 0)).toBe(true);
      const row = getDb().prepare('SELECT role, kyc_status, kyc_tier, country FROM users WHERE id = ?').get(r.id) as any;
      expect(row.kyc_status).toBe('verified');
      expect(row.kyc_tier).toBe(2);
      expect(row.country).toBe('CD');
    }
    expect(getDb().prepare('SELECT COUNT(*) c FROM organisations WHERE owner_user_id IN (?, ?)').get(merchant.id, agent.id)).toEqual({ c: 2 });
    expect(getDb().prepare('SELECT COUNT(*) c FROM organisations WHERE owner_user_id = ?').get(customer.id)).toEqual({ c: 0 });
    // each account signs in with the printed credentials and its PIN works for a transfer
    const login = await request(app).post('/api/auth/login').send({ identifier: customer.phone, password: 'ClientTest123!' });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    const send = await request(app).post('/api/transfers').set('Authorization', `Bearer ${login.body.token}`).send({ to: merchant.tag, amount: '5.00', currency: 'USD', pin: '1234' });
    expect(send.status, JSON.stringify(send.body)).toBe(201);
    const mLogin = await request(app).post('/api/auth/login').send({ identifier: merchant.email, password: merchant.password });
    expect(mLogin.status).toBe(200);
    expect(mLogin.body.user.role).toBe('merchant');
    const aLogin = await request(app).post('/api/auth/login').send({ identifier: agent.email, password: agent.password });
    expect(aLogin.body.user.role).toBe('agent');
    // idempotent: a second run reports the existing accounts and adds no money
    const again = createDemoAccounts([{ role: 'customer', phone: customer.phone, tag: customer.tag }]);
    expect(again[0].created).toBe(false);
    expect(again[0].password).toBeNull();
    const sent = getDb().prepare('SELECT amount, fee, sender_user_id FROM transactions WHERE id = ?').get(send.body.transaction.id) as any;
    expect(sent.sender_user_id).toBe(customer.id);
    const usdBefore = customer.balances.find((b) => b.currency === 'USD')!.balance;
    const usdAfter = again[0].balances.find((b) => b.currency === 'USD')!.balance;
    expect(usdAfter).toBeLessThan(usdBefore);
    expect(usdBefore - usdAfter).toBeGreaterThanOrEqual(sent.amount);
    expect(usdBefore - usdAfter).toBeLessThanOrEqual(sent.amount + sent.fee);
  });

  it('repairs a half-made account on rerun and refuses a placeholder phone number', () => {
    const n = Math.floor(Math.random() * 1e6);
    expect(() => createDemoAccounts([{ role: 'customer', phone: '+243XXXXXXXXX', tag: `ph${n}` }])).toThrow(/full phone number/);
    // an account created without funding (an interrupted earlier run) is funded and re-contacted on the next run
    const first = createDemoAccounts([{ role: 'agent', email: `first${n}@test.local`, tag: `repair${n}` }])[0];
    getDb().prepare('UPDATE wallets SET balance = 0 WHERE user_id = ?').run(first.id);
    const again = createDemoAccounts([{ role: 'agent', phone: `+24382${String(n).padStart(7, '0')}`, tag: `repair${n}` }])[0];
    expect(again.created).toBe(false);
    expect(again.phone).toBe(`+24382${String(n).padStart(7, '0')}`);
    expect(again.balances.every((b) => b.balance > 0)).toBe(true);
  });

  it('refuses without a contact and outside sandbox compliance mode', () => {
    expect(() => createDemoAccounts([{ role: 'customer', tag: 'nocontact' }])).toThrow(/phone number or email/);
    const before = getSetting<any>('compliance', { mode: 'sandbox' });
    setSetting('compliance', { ...before, mode: 'live' });
    try {
      expect(() => createDemoAccounts([{ role: 'agent', phone: '+243890000999', tag: 'livemode' }])).toThrow(/sandbox compliance mode only/);
    } finally {
      setSetting('compliance', before);
    }
  });
});
