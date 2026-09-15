/**
 * Wallet preferences: a person picks a main wallet (paid with by default) and an alternative, changes them at any
 * time, and every wallet and currency carries its country flag (the euro shows the EU flag, shared currencies a globe).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser } from './helpers';
import { currencyFlag, countryFlag, currencyLabel } from '@bitripay/shared';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

describe('flags', () => {
  it('maps countries and currencies to flags; euro → EU, CFA → globe', () => {
    expect(countryFlag('CD')).toBe('🇨🇩');
    expect(currencyFlag('CDF')).toBe('🇨🇩');
    expect(currencyFlag('USD')).toBe('🇺🇸');
    expect(currencyFlag('EUR')).toBe('🇪🇺');
    expect(currencyFlag('GBP')).toBe('🇬🇧');
    expect(currencyFlag('KES')).toBe('🇰🇪');
    expect(currencyFlag('XOF')).toBe('🌍');
    expect(currencyFlag('ZZZ')).toBe('🌐');
    expect(currencyLabel('cdf')).toBe('🇨🇩 CDF');
  });
});

describe('main and alternative wallets', () => {
  it('orders wallets main first, marks roles, carries flags, and the choice changes at any time', async () => {
    const u = await registerUser(app);
    const before = await request(app).get('/api/wallets').set(u.auth);
    expect(before.status).toBe(200);
    expect(before.body.items[0].flag).toBe('🇺🇸');
    expect(before.body.items.every((w: any) => w.role === null)).toBe(true);
    const set = await request(app).put('/api/wallets/preferences').set(u.auth).send({ main: 'cdf', alternative: 'USD' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.user).toMatchObject({ mainCurrency: 'CDF', alternativeCurrency: 'USD' });
    expect(set.body.items.map((w: any) => [w.currency, w.role, w.flag])).toEqual([
      ['CDF', 'main', '🇨🇩'],
      ['USD', 'alternative', '🇺🇸'],
    ]);
    const list = await request(app).get('/api/wallets').set(u.auth);
    expect(list.body.items[0]).toMatchObject({ currency: 'CDF', role: 'main' });
    const me = await request(app).get('/api/auth/me').set(u.auth);
    expect(me.body.user.mainCurrency).toBe('CDF');
    // swap them
    const swap = await request(app).put('/api/wallets/preferences').set(u.auth).send({ main: 'USD', alternative: 'CDF' });
    expect(swap.body.items.map((w: any) => w.currency)).toEqual(['USD', 'CDF']);
    // clear the alternative only
    const clear = await request(app).put('/api/wallets/preferences').set(u.auth).send({ alternative: null });
    expect(clear.body.user).toMatchObject({ mainCurrency: 'USD', alternativeCurrency: null });
    // refusals
    expect((await request(app).put('/api/wallets/preferences').set(u.auth).send({ main: 'USD', alternative: 'USD' })).body.error.code).toBe('same_currency');
    expect((await request(app).put('/api/wallets/preferences').set(u.auth).send({ main: 'ZZZ' })).status).toBeGreaterThanOrEqual(400);
    const cfg = await request(app).get('/api/config');
    expect(cfg.body.currencies.find((c: any) => c.code === 'USD').flag).toBe('🇺🇸');
  });
});
