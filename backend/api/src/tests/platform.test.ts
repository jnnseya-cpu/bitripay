/**
 * Connected accounts (aggregator / platform model): a developer creates its customers' merchant accounts through the
 * API, takes payments for them with its own key and the BitriPay-Account header, keeps an application fee paid at
 * capture, receives the customers' events on its own webhooks with the account id, hands the account over with a
 * claim link, and loses access the moment the customer removes it. The customer is always the merchant of record.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, fund } from './helpers';
import { getDb } from '../db';
import { getIntentRow } from '../services/intents';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

async function platformWithKey(opts: Record<string, unknown> = {}) {
  const dev = await registerUser(app, { role: 'developer', businessName: 'Kin Software', ...opts });
  const key = await request(app).post('/api/v1/api_keys').set(dev.auth).send({ label: 'platform', mode: 'test' });
  expect(key.status, JSON.stringify(key.body)).toBe(201);
  return { ...dev, key: { Authorization: `Bearer ${key.body.secret}` } };
}

describe('connected accounts', () => {
  it('a platform creates a customer account, takes a payment for it with its own key and keeps the application fee', async () => {
    const platform = await platformWithKey();
    const email = `pharma${Math.floor(Math.random() * 1e9)}@test.local`;
    const created = await request(app)
      .post('/api/v1/accounts')
      .set(platform.key)
      .send({ business_name: 'Pharmacie Lumière', type: 'merchant', email, country: 'CD', application_fee_bps: 150, metadata: { crm: 'C-77' } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const acct = created.body;
    expect(acct.id).toMatch(/^acct_/);
    expect(acct).toMatchObject({
      object: 'account',
      business_name: 'Pharmacie Lumière',
      type: 'merchant',
      email,
      country: 'CD',
      status: 'active',
      kyb_status: 'none',
      application_fee_bps: 150,
      metadata: { crm: 'C-77' },
    });
    expect(acct.onboarding.claimed).toBe(false);
    const customerId = (getDb().prepare('SELECT user_id FROM connected_accounts WHERE id = ?').get(acct.id) as any).user_id;
    // the platform sits in the customer's organisation as administrator, invited by itself
    expect(getDb().prepare('SELECT role FROM organisation_members WHERE organisation_id = ? AND user_id = ?').get(acct.organisation_id, platform.user.id)).toEqual({ role: 'administrator' });
    expect((await request(app).get('/api/v1/accounts').set(platform.key)).body.data.map((a: any) => a.id)).toEqual([acct.id]);

    // A payment for the customer: the platform's key plus the account header; the fee is explicit here (default rate otherwise).
    const pi = await request(app)
      .post('/api/v1/payment_intents')
      .set(platform.key)
      .set('BitriPay-Account', acct.id)
      .set('Idempotency-Key', `inv-${Math.random()}`)
      .send({ currency: 'USD', amount_minor: 2500, description: 'Invoice 88', application_fee_minor: 100 });
    expect(pi.status, JSON.stringify(pi.body)).toBe(201);
    const row = getIntentRow(pi.body.id)!;
    expect(row.merchant_user_id).toBe(customerId);
    expect(JSON.parse(row.metadata)).toMatchObject({ account: acct.id, application_fee_minor: 100 });
    const payer = await registerUser(app);
    await fund(app, payer.user.id, '100.00', 'USD');
    const paid = await request(app).post(`/api/v1/payment_intents/${pi.body.id}/pay/wallet`).set(payer.auth).send({ pin: '1234' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const tx = getDb().prepare('SELECT * FROM transactions WHERE id = ?').get(getIntentRow(pi.body.id)!.transaction_id) as any;
    const received = tx.receive_amount ?? tx.amount - tx.fee;
    // the customer's wallet holds what it received minus the platform's fee; the platform's wallet holds exactly the fee
    expect((getDb().prepare("SELECT balance FROM wallets WHERE user_id = ? AND currency = 'USD'").get(customerId) as any).balance).toBe(received - 100);
    expect((getDb().prepare("SELECT balance FROM wallets WHERE user_id = ? AND currency = 'USD'").get(platform.user.id) as any).balance).toBe(100);
    const splits = await request(app).get(`/api/v1/payment_intents/${pi.body.id}/splits`).set(platform.key).set('BitriPay-Account', acct.id);
    expect(splits.status).toBe(200);
    expect(splits.body.data ?? splits.body.splits ?? splits.body).toMatchObject([{ recipientUserId: platform.user.id, amountMinor: 100, status: 'PAID', label: 'application_fee' }]);
    // the customer's event reached the platform's event log, tagged with the account
    const events = (getDb().prepare("SELECT data FROM webhook_events WHERE user_id = ? AND type = 'payment_intent.succeeded'").all(platform.user.id) as any[]).map((e) => JSON.parse(e.data));
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].account).toBe(acct.id);
    expect(events[0].data.account).toBe(acct.id);
    expect(getDb().prepare("SELECT COUNT(*) c FROM webhook_events WHERE user_id = ? AND type = 'account.created'").get(platform.user.id)).toEqual({ c: 1 });
    // the balance the platform reads with the header is the customer's, not its own
    const balance = await request(app).get('/api/v1/wallets').set(platform.key).set('BitriPay-Account', acct.id);
    expect(balance.status).toBe(200);
    expect(balance.body.data.find((w: any) => w.currency === 'USD').balance_minor).toBe(received - 100);
    // the default rate applies when no explicit fee is given: 150 bps of 10 000 = 150
    const pi2 = await request(app).post('/api/v1/payment_intents').set(platform.key).set('BitriPay-Account', acct.id).send({ currency: 'USD', amount_minor: 10_000 });
    expect(pi2.status, JSON.stringify(pi2.body)).toBe(201);
    expect(JSON.parse(getIntentRow(pi2.body.id)!.metadata).application_fee_minor).toBe(150);
  });

  it('the customer claims the account with a one-time link, signs in, sees the platform under Team and can remove it', async () => {
    const platform = await platformWithKey();
    const email = `owner${Math.floor(Math.random() * 1e9)}@test.local`;
    const acct = (await request(app).post('/api/v1/accounts').set(platform.key).send({ business_name: 'Salon Nzela', email, country: 'CD' })).body;
    const link = await request(app).post(`/api/v1/accounts/${acct.id}/account_links`).set(platform.key);
    expect(link.status, JSON.stringify(link.body)).toBe(201);
    expect(link.body.url).toContain('/claim/');
    const token = link.body.url.split('/claim/')[1];
    const describe = await request(app).get(`/api/auth/claim/${token}`);
    expect(describe.status).toBe(200);
    expect(describe.body).toMatchObject({ business_name: 'Salon Nzela', platform: 'Kin Software' });
    // nobody can sign in before the claim: the account has no password yet
    expect((await request(app).post('/api/auth/login').send({ identifier: email, password: 'Password123!' })).status).toBe(401);
    const claimed = await request(app).post('/api/auth/claim').send({ token, password: 'Password123!' });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect(claimed.body.user.email).toBe(email);
    expect(claimed.body.account.id).toBe(acct.id);
    // the link is one-time
    expect((await request(app).post('/api/auth/claim').send({ token, password: 'Password123!' })).status).toBe(404);
    const login = await request(app).post('/api/auth/login').send({ identifier: email, password: 'Password123!' });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    const customer = { Authorization: `Bearer ${login.body.token}` };
    expect((await request(app).get(`/api/v1/accounts/${acct.id}`).set(platform.key)).body.onboarding.claimed).toBe(true);
    const me = await request(app).get('/api/organisations/me').set(customer);
    expect(me.status).toBe(200);
    expect(me.body.membership.role).toBe('owner');
    expect(me.body.platform).toMatchObject({ accountId: acct.id, platform: { id: platform.user.id } });
    expect(me.body.members.map((m: any) => m.role).sort()).toEqual(['administrator', 'owner']);
    // the platform's keys are not the customer's keys
    expect((await request(app).get('/api/v1/api_keys').set(customer)).body.data).toEqual([]);
    // the customer removes the platform under Team: access ends, the account stays the customer's
    const removed = await request(app).delete(`/api/organisations/members/${platform.user.id}`).set(customer);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    const after = await request(app).post('/api/v1/payment_intents').set(platform.key).set('BitriPay-Account', acct.id).send({ currency: 'USD', amount_minor: 1000 });
    expect(after.status).toBe(403);
    expect(after.body.error.code).toBe('account_detached');
    expect((await request(app).get(`/api/v1/accounts/${acct.id}`).set(platform.key)).body.status).toBe('detached');
    expect((await request(app).get('/api/organisations/me').set(customer)).body.platform).toBeNull();
    expect(getDb().prepare("SELECT COUNT(*) c FROM webhook_events WHERE user_id = ? AND type = 'account.detached'").get(platform.user.id)).toEqual({ c: 1 });
    expect((await request(app).post('/api/auth/login').send({ identifier: email, password: 'Password123!' })).status).toBe(200);
  });

  it('refuses foreign accounts, fees without an account, keys without the scope, and the platform can detach itself', async () => {
    const a = await platformWithKey();
    const b = await platformWithKey({ businessName: 'Other Platform' });
    const acct = (
      await request(app)
        .post('/api/v1/accounts')
        .set(a.key)
        .send({ business_name: 'Boutique Mama', phone: `+24389${Math.floor(1000000 + Math.random() * 8999999)}` })
    ).body;
    expect(acct.id).toMatch(/^acct_/);
    const foreign = await request(app).post('/api/v1/payment_intents').set(b.key).set('BitriPay-Account', acct.id).send({ currency: 'USD', amount_minor: 1000 });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe('account_not_connected');
    expect((await request(app).get(`/api/v1/accounts/${acct.id}`).set(b.key)).status).toBe(404);
    const noAccount = await request(app).post('/api/v1/payment_intents').set(a.key).send({ currency: 'USD', amount_minor: 1000, application_fee_minor: 10 });
    expect(noAccount.status).toBe(400);
    expect(noAccount.body.error.code).toBe('application_fee_requires_account');
    const tooHigh = await request(app).post('/api/v1/payment_intents').set(a.key).set('BitriPay-Account', acct.id).send({ currency: 'USD', amount_minor: 1000, application_fee_minor: 1001 });
    expect(tooHigh.body.error.code).toBe('application_fee_too_high');
    const restricted = await request(app)
      .post('/api/v1/api_keys')
      .set(a.auth)
      .send({ label: 'narrow', mode: 'test', kind: 'restricted', scopes: ['payment_intents:write'] });
    expect(restricted.status, JSON.stringify(restricted.body)).toBe(201);
    const denied = await request(app)
      .post('/api/v1/accounts')
      .set('Authorization', `Bearer ${restricted.body.secret}`)
      .send({ business_name: 'Nope', email: `x${Math.random()}@test.local` });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('scope_denied');
    // managing accounts is always done as the platform itself
    const withHeader = await request(app)
      .post('/api/v1/accounts')
      .set(a.key)
      .set('BitriPay-Account', acct.id)
      .send({ business_name: 'Nested', email: `y${Math.random()}@test.local` });
    expect(withHeader.status).toBe(400);
    expect(withHeader.body.error.code).toBe('account_header_not_allowed');
    // a personal account cannot be a platform
    const person = await registerUser(app);
    expect(
      (
        await request(app)
          .post('/api/v1/accounts')
          .set(person.auth)
          .send({ business_name: 'Nope', email: `z${Math.random()}@test.local` })
      ).status,
    ).toBe(403);
    const detached = await request(app).post(`/api/v1/accounts/${acct.id}/detach`).set(a.key);
    expect(detached.status, JSON.stringify(detached.body)).toBe(200);
    expect(detached.body.status).toBe('detached');
    expect((await request(app).post(`/api/v1/accounts/${acct.id}/account_links`).set(a.key)).status).toBe(409);
  });
});
