/**
 * Organisations (§43) and merchant RBAC (§44): the legal entity behind every merchant-class account, intents stamped
 * with it, members acting for the organisation with their own session under the permission matrix (cashier limits
 * and denials, finance managers), business units linked to locations, and the merchant-class account types.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, fund } from './helpers';
import { getDb } from '../db';
import { getIntentRow } from '../services/intents';
import { ORG_PERMISSIONS, ORG_ROLES, orgRoleHasPermission } from '@bitripay/shared';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

/** A merchant-class account with a funded payer and a paid intent ready to be refunded. */
async function paidIntent(m: Awaited<ReturnType<typeof registerUser>>, amountMinor: number, extra: Record<string, unknown> = {}) {
  const payer = await registerUser(app);
  await fund(app, payer.user.id, '500.00', 'USD');
  await fund(app, m.user.id, '5.00', 'USD'); // refunds return the principal; the platform fee stays with the platform
  const pi = await request(app)
    .post('/api/v1/payment_intents')
    .set(m.auth)
    .send({ currency: 'USD', amount_minor: amountMinor, ...extra });
  expect(pi.status, JSON.stringify(pi.body)).toBe(201);
  const paid = await request(app).post(`/api/v1/payment_intents/${pi.body.id}/pay/wallet`).set(payer.auth).send({ pin: '1234' });
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  return { intent: pi.body, payer };
}

async function invite(owner: Awaited<ReturnType<typeof registerUser>>, role: string, overrides: Record<string, unknown> = {}) {
  const person = await registerUser(app, overrides);
  const res = await request(app).post('/api/organisations/members').set(owner.auth).send({ identifier: person.user.email, role });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.role).toBe(role);
  expect(res.body.userId).toBe(person.user.id);
  return person;
}

describe('organisations: the legal entity behind a merchant account', () => {
  it('registering a merchant creates an organisation with the merchant as owner member', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Kin Bakery', country: 'CD' });
    const org = getDb().prepare('SELECT * FROM organisations WHERE owner_user_id = ?').get(m.user.id) as any;
    expect(org).toBeTruthy();
    expect(org.name).toBe('Kin Bakery');
    expect(org.kind).toBe('merchant');
    expect(org.country).toBe('CD');
    const me = await request(app).get('/api/organisations/me').set(m.auth);
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body.organisation.id).toBe(org.id);
    expect(me.body.membership).toMatchObject({ userId: m.user.id, role: 'owner', permissions: ['*'] });
    expect(me.body.members).toHaveLength(1);
    expect(me.body.members[0]).toMatchObject({ userId: m.user.id, role: 'owner', user: { id: m.user.id } });
    expect(me.body.businessUnits).toEqual([]);
    expect(me.body.roles).toEqual(ORG_ROLES);
    expect(me.body.permissions.cashier).toEqual(ORG_PERMISSIONS.cashier);
  });

  it('upgrading a personal account to a merchant creates its organisation', async () => {
    const u = await registerUser(app);
    expect(getDb().prepare('SELECT COUNT(*) c FROM organisations WHERE owner_user_id = ?').get(u.user.id)).toEqual({ c: 0 });
    const up = await request(app).post('/api/merchant/apply').set(u.auth).send({ businessName: 'Upgraded Shop' });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const org = getDb().prepare('SELECT * FROM organisations WHERE owner_user_id = ?').get(u.user.id) as any;
    expect(org?.name).toBe('Upgraded Shop');
    expect(getDb().prepare('SELECT role FROM organisation_members WHERE organisation_id = ? AND user_id = ?').get(org.id, u.user.id)).toEqual({ role: 'owner' });
  });

  it('every payment intent is stamped with the organisation at creation and the view exposes it', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Stamp Co', country: 'CD' });
    const org = getDb().prepare('SELECT id FROM organisations WHERE owner_user_id = ?').get(m.user.id) as any;
    const pi = await request(app).post('/api/v1/payment_intents').set(m.auth).send({ currency: 'USD', amount_minor: 2500 });
    expect(pi.status, JSON.stringify(pi.body)).toBe(201);
    expect(getIntentRow(pi.body.id).organisation_id).toBe(org.id);
    expect(pi.body.organisationId).toBe(org.id);
    expect(pi.body.businessUnitId).toBeNull();
    const link = await request(app).post('/api/v1/payment_links').set(m.auth).send({ currency: 'USD', amount_minor: 900, title: 'Link' });
    expect(link.status).toBe(201);
    expect(getDb().prepare('SELECT COUNT(*) c FROM payment_intents WHERE merchant_user_id = ? AND organisation_id IS NULL').get(m.user.id)).toEqual({ c: 0 });
  });

  it('a merchant that predates organisations gets one lazily on first use', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Legacy Traders', country: 'CD' });
    const db = getDb();
    const before = db.prepare('SELECT id FROM organisations WHERE owner_user_id = ?').get(m.user.id) as any;
    db.prepare('DELETE FROM organisation_members WHERE organisation_id = ?').run(before.id);
    db.prepare('DELETE FROM organisations WHERE id = ?').run(before.id);
    const pi = await request(app).post('/api/v1/payment_intents').set(m.auth).send({ currency: 'USD', amount_minor: 100 });
    expect(pi.status, JSON.stringify(pi.body)).toBe(201);
    const after = db.prepare('SELECT * FROM organisations WHERE owner_user_id = ?').get(m.user.id) as any;
    expect(after).toBeTruthy();
    expect(after.id).not.toBe(before.id);
    expect(after.name).toBe('Legacy Traders');
    expect(getIntentRow(pi.body.id).organisation_id).toBe(after.id);
    expect((await request(app).get('/api/organisations/me').set(m.auth)).body.members[0].role).toBe('owner');
  });
});

describe('members and the permission matrix', () => {
  it('the matrix is documented: owners hold everything, cashiers cannot touch settlement, API secrets, unrestricted refunds or exports', () => {
    expect(ORG_ROLES).toEqual(['owner', 'administrator', 'finance_manager', 'operations_manager', 'developer', 'analyst', 'cashier', 'support', 'compliance_reviewer', 'read_only']);
    expect(ORG_PERMISSIONS.owner).toEqual(['*']);
    for (const role of ORG_ROLES) expect(Array.isArray(ORG_PERMISSIONS[role])).toBe(true);
    expect(orgRoleHasPermission('cashier', 'refunds:issue')).toBe(true);
    for (const denied of ['settlement:change', 'api_keys:view', 'api_keys:manage', 'refunds:unrestricted', 'customers:export', 'org:manage_members'] as const) {
      expect(orgRoleHasPermission('cashier', denied), denied).toBe(false);
    }
    expect(orgRoleHasPermission('finance_manager', 'refunds:unrestricted')).toBe(true);
    expect(orgRoleHasPermission('finance_manager', 'settlement:change')).toBe(true);
    expect(orgRoleHasPermission('finance_manager', 'api_keys:view')).toBe(false);
    expect(orgRoleHasPermission('read_only', 'payments:create')).toBe(false);
    expect(orgRoleHasPermission('cashier', 'refunds:unrestricted', ['refunds:unrestricted'])).toBe(true); // per-member grant
  });

  it('a cashier invited by email acts for the organisation with their own session: sees its payments, refunds up to the cashier limit, is refused above it', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Till Co', country: 'CD' });
    const cashier = await invite(m, 'cashier');
    // outside the merchant surfaces the cashier stays themselves
    const self = await request(app).get('/api/auth/me').set(cashier.auth);
    expect(self.body.user.id).toBe(cashier.user.id);
    expect(self.body.user.role).toBe('user');
    // on the merchant surfaces they act for the organisation
    const me = await request(app).get('/api/organisations/me').set(cashier.auth);
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body.organisation.ownerUserId).toBe(m.user.id);
    expect(me.body.membership).toMatchObject({ userId: cashier.user.id, role: 'cashier' });
    expect(me.body.membership.permissions).toEqual(ORG_PERMISSIONS.cashier);
    const { intent } = await paidIntent(m, 20_000);
    const seen = await request(app).get('/api/v1/payment_intents').set(cashier.auth);
    expect(seen.status).toBe(200);
    expect(seen.body.data.map((i: any) => i.id)).toContain(intent.id);
    // within the default cashier limit (5000 minor units)
    const small = await request(app).post('/api/v1/refunds').set(cashier.auth).send({ payment_intent: intent.id, amount_minor: 4000, reason: 'wrong size' });
    expect(small.status, JSON.stringify(small.body)).toBe(201);
    expect(small.body.status).toBe('SUCCEEDED');
    // above it, and a full refund (no amount) are refused with the limit in the message
    const big = await request(app).post('/api/v1/refunds').set(cashier.auth).send({ payment_intent: intent.id, amount_minor: 6000 });
    expect(big.status).toBe(403);
    expect(big.body.error.code).toBe('refund_limit_exceeded');
    expect(big.body.error.message).toMatch(/5000/);
    const full = await request(app).post('/api/v1/refunds').set(cashier.auth).send({ payment_intent: intent.id });
    expect(full.status).toBe(403);
    expect(full.body.error.code).toBe('refund_limit_exceeded');
    expect((await request(app).get(`/api/v1/payment_intents/${intent.id}/refundable`).set(m.auth)).body.refundable).toBe(16_000);
  });

  it('cashier denials: settlement instructions, API secrets, statements, customer export and member management', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Deny Co', country: 'CD' });
    const cashier = await invite(m, 'cashier');
    const profile = await request(app)
      .post('/api/v1/settlement_profiles')
      .set(cashier.auth)
      .send({ currency: 'USD', schedule: 'manual', destination: { method: 'wallet' } });
    expect(profile.status).toBe(403);
    expect(profile.body.error.code).toBe('org_permission_denied');
    expect(profile.body.error.message).toMatch(/cashier/);
    expect(profile.body.error.message).toMatch(/settlement:change/);
    expect(getDb().prepare('SELECT COUNT(*) c FROM settlement_profiles WHERE user_id = ?').get(m.user.id)).toEqual({ c: 0 });
    const keys = await request(app).get('/api/v1/api_keys').set(cashier.auth);
    expect(keys.status).toBe(403);
    expect(keys.body.error.code).toBe('org_permission_denied');
    const mint = await request(app).post('/api/v1/api_keys').set(cashier.auth).send({ label: 'till', mode: 'test' });
    expect(mint.status).toBe(403);
    expect(getDb().prepare('SELECT COUNT(*) c FROM api_keys WHERE user_id = ?').get(m.user.id)).toEqual({ c: 0 });
    const statement = await request(app).get('/api/v1/settlement_cycles/cyc_none/statement').set(cashier.auth);
    expect(statement.status).toBe(403);
    expect(statement.body.error.code).toBe('org_permission_denied');
    const exp = await request(app).get('/api/organisations/customers/export').set(cashier.auth);
    expect(exp.status).toBe(403);
    expect(exp.body.error.code).toBe('org_permission_denied');
    const someone = await registerUser(app);
    const add = await request(app).post('/api/organisations/members').set(cashier.auth).send({ identifier: someone.user.email, role: 'cashier' });
    expect(add.status).toBe(403);
    const unit = await request(app).post('/api/organisations/business-units').set(cashier.auth).send({ name: 'Bar' });
    expect(unit.status).toBe(403);
    const webhook = await request(app).post('/api/v1/webhook_endpoints').set(cashier.auth).send({ url: 'https://example.com/hook' });
    expect(webhook.status).toBe(403);
    // the legacy merchant surface is owner-only: a member cannot mint keys there either
    const legacy = await request(app).post('/api/merchant/api-keys').set(cashier.auth).send({ label: 'x' });
    expect(legacy.status).toBe(403);
    // reads the cashier holds keep working
    expect((await request(app).get('/api/v1/balance').set(cashier.auth)).status).toBe(200);
  });

  it('a finance manager changes settlement instructions, refunds above the cashier limit and exports customers, but never sees API keys', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Finance Co', country: 'CD' });
    const fm = await invite(m, 'finance_manager');
    const profile = await request(app)
      .post('/api/v1/settlement_profiles')
      .set(fm.auth)
      .send({ currency: 'USD', schedule: 'manual', destination: { method: 'wallet' } });
    expect(profile.status, JSON.stringify(profile.body)).toBe(201);
    const { intent, payer } = await paidIntent(m, 20_000, { customer_msisdn: '+243810000001', customer_country: 'CD' });
    const refund = await request(app).post('/api/v1/refunds').set(fm.auth).send({ payment_intent: intent.id, amount_minor: 12_000, reason: 'goodwill' });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    expect(refund.body.status).toBe('SUCCEEDED');
    const exp = await request(app).get('/api/organisations/customers/export').set(fm.auth);
    expect(exp.status).toBe(200);
    expect(exp.body.data.some((r: any) => r.customerUserId === payer.user.id && r.msisdn === '+243810000001')).toBe(true);
    const csv = await request(app).get('/api/organisations/customers/export?format=csv').set(fm.auth);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\n')[0]).toBe('customer_user_id,msisdn,country,payments,total_minor,currency,first_seen,last_seen');
    expect(csv.text).toContain('+243810000001');
    const keys = await request(app).get('/api/v1/api_keys').set(fm.auth);
    expect(keys.status).toBe(403);
    // API keys act with the organisation's full permissions
    const sk = await request(app).post('/api/v1/api_keys').set(m.auth).send({ label: 'server', mode: 'test' });
    expect(sk.status, JSON.stringify(sk.body)).toBe(201);
    const viaKey = await request(app)
      .get('/api/v1/api_keys')
      .set({ Authorization: `Bearer ${sk.body.secret}` });
    expect(viaKey.status).toBe(403); // a key can never manage keys (session_required), regardless of permissions
    expect(viaKey.body.error.code).toBe('session_required');
    const keyRefund = await request(app)
      .post('/api/v1/refunds')
      .set({ Authorization: `Bearer ${sk.body.secret}` })
      .send({ payment_intent: intent.id, amount_minor: 7000 });
    expect(keyRefund.status, JSON.stringify(keyRefund.body)).toBe(201);
  });

  it('the cashier refund limit is configurable per organisation by the owner; a developer manages keys and webhooks but not refunds', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Limit Co', country: 'CD' });
    const cashier = await invite(m, 'cashier');
    const dev = await invite(m, 'developer');
    const set = await request(app).patch('/api/organisations/me').set(m.auth).send({ cashierRefundLimitMinor: 1000 });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.organisation.settings.cashierRefundLimitMinor).toBe(1000);
    const { intent } = await paidIntent(m, 3000);
    const over = await request(app).post('/api/v1/refunds').set(cashier.auth).send({ payment_intent: intent.id, amount_minor: 1500 });
    expect(over.status).toBe(403);
    expect(over.body.error.message).toMatch(/1000/);
    const ok = await request(app).post('/api/v1/refunds').set(cashier.auth).send({ payment_intent: intent.id, amount_minor: 900 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    // a cashier cannot change the limit
    expect((await request(app).patch('/api/organisations/me').set(cashier.auth).send({ cashierRefundLimitMinor: 999_999 })).status).toBe(403);
    // the developer: keys (with their own PIN for the live step-up) and webhooks yes, refunds no
    const key = await request(app).post('/api/v1/api_keys').set(dev.auth).send({ label: 'integration', mode: 'live', pin: '1234' });
    expect(key.status, JSON.stringify(key.body)).toBe(201);
    expect(key.body.secret).toMatch(/^sk_live_/);
    expect((await request(app).get('/api/v1/api_keys').set(dev.auth)).body.data).toHaveLength(1);
    const hook = await request(app).post('/api/v1/webhook_endpoints').set(dev.auth).send({ url: 'https://example.com/hook' });
    expect(hook.status, JSON.stringify(hook.body)).toBe(201);
    const devRefund = await request(app).post('/api/v1/refunds').set(dev.auth).send({ payment_intent: intent.id, amount_minor: 100 });
    expect(devRefund.status).toBe(403);
    expect(devRefund.body.error.code).toBe('org_permission_denied');
  });

  it('one developer integrates several clients: keys are created in each client workspace and stay with the client after removal', async () => {
    const dev = await registerUser(app, { role: 'developer', businessName: 'Kin Software' });
    const clientA = await registerUser(app, { role: 'merchant', businessName: 'Client A' });
    const clientB = await registerUser(app, { role: 'ngo', businessName: 'Client B' });
    for (const client of [clientA, clientB]) {
      const res = await request(app).post('/api/organisations/members').set(client.auth).send({ identifier: dev.user.email, role: 'developer' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    const session = await request(app).get('/api/auth/me').set(dev.auth);
    expect(session.body.memberships.map((m: any) => [m.name, m.role, m.owner])).toEqual([
      ['Kin Software', 'owner', true],
      ['Client A', 'developer', false],
      ['Client B', 'developer', false],
    ]);
    const orgA = session.body.memberships[1].organisationId;
    const orgB = session.body.memberships[2].organisationId;
    // Without a workspace header a developer account acts for its own organisation; the header selects a client.
    const own = await request(app).post('/api/v1/api_keys').set(dev.auth).send({ label: 'my product', mode: 'test' });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    const forA = await request(app).post('/api/v1/api_keys').set(dev.auth).set('X-Organisation-Id', orgA).send({ label: 'shop integration', mode: 'test' });
    expect(forA.status, JSON.stringify(forA.body)).toBe(201);
    const forB = await request(app).post('/api/v1/api_keys').set(dev.auth).set('X-Organisation-Id', orgB).send({ label: 'donations page', mode: 'test' });
    expect(forB.status, JSON.stringify(forB.body)).toBe(201);
    expect((await request(app).get('/api/v1/api_keys').set(dev.auth)).body.data.map((k: any) => k.label)).toEqual(['my product']);
    expect((await request(app).get('/api/v1/api_keys').set(clientA.auth)).body.data.map((k: any) => k.label)).toEqual(['shop integration']);
    expect((await request(app).get('/api/v1/api_keys').set(clientB.auth)).body.data.map((k: any) => k.label)).toEqual(['donations page']);
    // The client's key is the client's: an intent created with it belongs to client A, not to the developer.
    const pi = await request(app).post('/api/v1/payment_intents').set('Authorization', `Bearer ${forA.body.secret}`).send({ currency: 'USD', amount_minor: 2500 });
    expect(pi.status, JSON.stringify(pi.body)).toBe(201);
    expect(getIntentRow(pi.body.id)!.merchant_user_id).toBe(clientA.user.id);
    // Hand-over: client A removes the developer; the key keeps working and the developer can no longer reach that workspace.
    expect((await request(app).delete(`/api/organisations/members/${dev.user.id}`).set(clientA.auth)).status).toBe(200);
    expect((await request(app).get('/api/v1/api_keys').set(dev.auth).set('X-Organisation-Id', orgA)).status).toBe(403);
    expect((await request(app).post('/api/v1/payment_intents').set('Authorization', `Bearer ${forA.body.secret}`).send({ currency: 'USD', amount_minor: 100 })).status).toBe(201);
  });

  it('roles change and members are removed; the owner is immutable; administrators manage members', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Team Co', country: 'CD' });
    const person = await invite(m, 'read_only');
    const denied = await request(app).post('/api/v1/payment_intents').set(person.auth).send({ currency: 'USD', amount_minor: 100 });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('org_permission_denied');
    const promoted = await request(app).patch(`/api/organisations/members/${person.user.id}`).set(m.auth).send({ role: 'operations_manager' });
    expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
    expect(promoted.body.role).toBe('operations_manager');
    const allowed = await request(app).post('/api/v1/payment_intents').set(person.auth).send({ currency: 'USD', amount_minor: 100 });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    // the owner cannot be demoted, removed or duplicated
    expect((await request(app).patch(`/api/organisations/members/${m.user.id}`).set(m.auth).send({ role: 'cashier' })).status).toBe(403);
    expect((await request(app).delete(`/api/organisations/members/${m.user.id}`).set(m.auth)).status).toBe(403);
    expect((await request(app).post('/api/organisations/members').set(m.auth).send({ identifier: person.user.email, role: 'owner' })).status).toBe(400);
    expect((await request(app).post('/api/organisations/members').set(m.auth).send({ identifier: person.user.email, role: 'cashier' })).body.error.code).toBe('already_member');
    expect((await request(app).post('/api/organisations/members').set(m.auth).send({ identifier: 'nobody@nowhere.test', role: 'cashier' })).status).toBe(404);
    // an administrator invites by @tag and removes people
    const admin = await invite(m, 'administrator');
    const byTag = await registerUser(app);
    const added = await request(app)
      .post('/api/organisations/members')
      .set(admin.auth)
      .send({ identifier: `@${byTag.user.tag}`, role: 'support' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect((await request(app).get('/api/organisations/members').set(m.auth)).body.data.map((x: any) => x.role).sort()).toEqual(['administrator', 'operations_manager', 'owner', 'support']);
    const removed = await request(app).delete(`/api/organisations/members/${person.user.id}`).set(admin.auth);
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ removed: true, userId: person.user.id });
    // once removed, the person is a plain personal account again on the merchant surfaces
    const gone = await request(app).get('/api/v1/payment_intents').set(person.auth);
    expect(gone.status).toBe(403);
    expect(gone.body.error.code).toBe('role_required');
    expect((await request(app).get('/api/organisations/me').set(person.auth)).status).toBe(403);
  });
});

describe('business units', () => {
  it('units are created, listed, updated and linked to locations; intents from a linked location carry the unit; a unit in use cannot be deleted', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Units Co', country: 'CD' });
    const created = await request(app).post('/api/organisations/business-units').set(m.auth).send({ name: 'Gombe branch' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ name: 'Gombe branch', code: 'GOMBE_BRANCH', settlementProfileId: null, locations: 0 });
    expect(created.body.id).toMatch(/^bu_/);
    expect((await request(app).post('/api/organisations/business-units').set(m.auth).send({ name: 'Gombe Branch' })).body.error.code).toBe('code_taken');
    const second = await request(app).post('/api/organisations/business-units').set(m.auth).send({ name: 'Online store', code: 'web' });
    expect(second.body.code).toBe('WEB');
    expect((await request(app).get('/api/organisations/business-units').set(m.auth)).body.data.map((u: any) => u.code)).toEqual(['GOMBE_BRANCH', 'WEB']);
    // a settlement profile can be attached to a unit; an unknown one is refused
    const profile = await request(app)
      .post('/api/v1/settlement_profiles')
      .set(m.auth)
      .send({ currency: 'USD', schedule: 'manual', destination: { method: 'wallet' } });
    expect(profile.status).toBe(201);
    const updated = await request(app).patch(`/api/organisations/business-units/${created.body.id}`).set(m.auth).send({ settlementProfileId: profile.body.id, name: 'Gombe' });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body).toMatchObject({ name: 'Gombe', code: 'GOMBE_BRANCH', settlementProfileId: profile.body.id });
    expect((await request(app).patch(`/api/organisations/business-units/${created.body.id}`).set(m.auth).send({ settlementProfileId: 'sp_nope' })).status).toBe(404);
    // link a location
    const loc = await request(app).post('/api/v1/locations').set(m.auth).send({ name: 'Gombe shop', city: 'Kinshasa' });
    expect(loc.status).toBe(201);
    const linked = await request(app).patch(`/api/organisations/locations/${loc.body.id}`).set(m.auth).send({ businessUnitId: created.body.id });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(linked.body.businessUnitId).toBe(created.body.id);
    const org = getDb().prepare('SELECT id FROM organisations WHERE owner_user_id = ?').get(m.user.id) as any;
    expect(getDb().prepare('SELECT business_unit_id, organisation_id FROM merchant_locations WHERE id = ?').get(loc.body.id)).toEqual({ business_unit_id: created.body.id, organisation_id: org.id });
    expect((await request(app).get(`/api/organisations/business-units/${created.body.id}`).set(m.auth)).body.locations).toBe(1);
    // an intent created at that location carries the unit (read-only join) and the organisation
    const pi = await request(app).post('/api/v1/payment_intents').set(m.auth).send({ currency: 'USD', amount_minor: 1500, location_id: loc.body.id });
    expect(pi.status, JSON.stringify(pi.body)).toBe(201);
    expect(pi.body.businessUnitId).toBe(created.body.id);
    expect(pi.body.organisationId).toBe(org.id);
    expect((await request(app).get(`/api/v1/payment_intents/${pi.body.id}`).set(m.auth)).body.businessUnitId).toBe(created.body.id);
    // in use → cannot be deleted; unlink, then delete
    const inUse = await request(app).delete(`/api/organisations/business-units/${created.body.id}`).set(m.auth);
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.code).toBe('business_unit_in_use');
    expect((await request(app).patch(`/api/organisations/locations/${loc.body.id}`).set(m.auth).send({ businessUnitId: null })).body.businessUnitId).toBeNull();
    expect((await request(app).delete(`/api/organisations/business-units/${created.body.id}`).set(m.auth)).body).toEqual({ deleted: true, id: created.body.id });
    expect((await request(app).get(`/api/v1/payment_intents/${pi.body.id}`).set(m.auth)).body.businessUnitId).toBeNull();
    // another merchant's location cannot be linked
    const other = await registerUser(app, { role: 'merchant', businessName: 'Other', country: 'CD' });
    expect((await request(app).patch(`/api/organisations/locations/${loc.body.id}`).set(other.auth).send({ businessUnitId: null })).status).toBe(404);
  });

  it('an operations manager manages units; a read-only member only lists them', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Ops Co', country: 'CD' });
    const ops = await invite(m, 'operations_manager');
    const ro = await invite(m, 'read_only');
    const created = await request(app).post('/api/organisations/business-units').set(ops.auth).send({ name: 'Depot' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await request(app).get('/api/organisations/business-units').set(ro.auth)).body.data).toHaveLength(1);
    const denied = await request(app).post('/api/organisations/business-units').set(ro.auth).send({ name: 'Nope' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toMatch(/read only/);
  });
});

describe('merchant-class account types', () => {
  it('corporate, ngo, government and developer accounts register, own an organisation of their kind and use the merchant surfaces', async () => {
    for (const role of ['corporate', 'ngo', 'government', 'developer'] as const) {
      const a = await registerUser(app, { role, businessName: `${role} entity`, country: 'CD' });
      expect(a.user.role).toBe(role);
      const me = await request(app).get('/api/auth/me').set(a.auth);
      expect(me.body.user.role).toBe(role);
      const org = await request(app).get('/api/organisations/me').set(a.auth);
      expect(org.status, JSON.stringify(org.body)).toBe(200);
      expect(org.body.organisation.kind).toBe(role);
      expect(org.body.organisation.name).toBe(`${role} entity`);
      expect(org.body.membership.role).toBe('owner');
      const pi = await request(app).post('/api/v1/payment_intents').set(a.auth).send({ currency: 'USD', amount_minor: 1000 });
      expect(pi.status, JSON.stringify(pi.body)).toBe(201);
      expect(pi.body.organisationId).toBe(org.body.organisation.id);
      expect((await request(app).get('/api/merchant/stats').set(a.auth)).status).toBe(200);
      expect((await request(app).get('/api/v1/api_keys').set(a.auth)).status).toBe(200);
    }
    // a personal account still is not merchant-class
    const u = await registerUser(app);
    expect((await request(app).get('/api/v1/api_keys').set(u.auth)).body.error.code).toBe('role_required');
    expect(
      (
        await request(app)
          .post('/api/auth/register')
          .send({ fullName: 'Bad Role', email: `bad${Date.now()}@test.local`, password: 'Password123!', role: 'admin' })
      ).status,
    ).toBe(400);
  });
});
