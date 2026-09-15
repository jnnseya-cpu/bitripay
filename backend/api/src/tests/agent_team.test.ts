/**
 * Agent teams: an agent account owns an organisation like a merchant does, so counter staff sign in with their own
 * credentials and work at the agent's till with an assigned role. The float, the commissions and every cash
 * operation stay on the agent account; the person at the till confirms with their own PIN and is recorded as the
 * operator on the transaction; roles without the right permission are refused with the API's own message.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, fund } from './helpers';
import { getDb } from '../db';
import { ORG_PERMISSIONS, AGENT_ORG_PERMISSION_KEYS, orgRoleHasPermission } from '@bitripay/shared';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

async function agentWithFloat(name: string) {
  const agent = await registerUser(app, { role: 'agent', businessName: name, country: 'CD' });
  await fund(app, agent.user.id, '500.00', 'USD');
  return agent;
}

async function invite(owner: Awaited<ReturnType<typeof registerUser>>, role: string) {
  const person = await registerUser(app);
  const res = await request(app).post('/api/organisations/members').set(owner.auth).send({ identifier: person.user.email, role });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return person;
}

describe('agent organisations', () => {
  it('registering an agent creates its organisation with the agent as owner; the session lists the membership', async () => {
    const agent = await registerUser(app, { role: 'agent', businessName: 'Matadi Counter', country: 'CD' });
    const org = getDb().prepare('SELECT * FROM organisations WHERE owner_user_id = ?').get(agent.user.id) as any;
    expect(org).toBeTruthy();
    expect(org.kind).toBe('agent');
    expect(org.name).toBe('Matadi Counter');
    const me = await request(app).get('/api/organisations/me').set(agent.auth);
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body.membership).toMatchObject({ userId: agent.user.id, role: 'owner', permissions: ['*'] });
    const session = await request(app).get('/api/auth/me').set(agent.auth);
    expect(session.body.memberships).toEqual([{ organisationId: org.id, name: 'Matadi Counter', kind: 'agent', role: 'owner', owner: true }]);
  });

  it('personal accounts own no organisation and are still refused on the agent surfaces', async () => {
    const u = await registerUser(app);
    const org = await request(app).get('/api/organisations/me').set(u.auth);
    expect(org.status).toBe(403);
    const stats = await request(app).get('/api/agents/me/stats').set(u.auth);
    expect(stats.status).toBe(403);
    expect(stats.body.error.code).toBe('role_required');
    const session = await request(app).get('/api/auth/me').set(u.auth);
    expect(session.body.memberships).toEqual([]);
  });

  it('every role holds agent:view and only till roles hold the cash permissions', () => {
    // every people-facing role sees the till figures; the developer role is an API role and has no place at the till
    for (const role of Object.keys(ORG_PERMISSIONS).filter((r) => r !== 'developer')) expect(orgRoleHasPermission(role as any, 'agent:view'), role).toBe(true);
    expect(orgRoleHasPermission('cashier', 'agent:cash_in')).toBe(true);
    expect(orgRoleHasPermission('cashier', 'agent:float')).toBe(false);
    expect(orgRoleHasPermission('cashier', 'agent:payouts')).toBe(false);
    expect(orgRoleHasPermission('operations_manager', 'agent:float')).toBe(true);
    expect(orgRoleHasPermission('read_only', 'agent:cash_in')).toBe(false);
    expect(orgRoleHasPermission('developer', 'agent:view')).toBe(false);
    expect(AGENT_ORG_PERMISSION_KEYS).toEqual(['agent:view', 'agent:cash_in', 'agent:cash_out', 'agent:pickups', 'agent:onboard', 'agent:float', 'agent:payouts']);
  });
});

describe('counter staff at the agent till', () => {
  it('a cashier serves customers with the agent float, confirms with their own PIN and is recorded as the operator', async () => {
    const agent = await agentWithFloat('Kin Counter');
    const customer = await registerUser(app);
    // The cashier has an account but no transaction PIN yet: the till must ask for THEIR PIN, never the agent owner's.
    const n = Math.floor(Math.random() * 1e9);
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ fullName: `Cashier ${n}`, email: `cashier${n}@test.local`, password: 'Password123!' });
    expect(reg.status).toBe(201);
    const cashier = { user: reg.body.user, auth: { Authorization: `Bearer ${reg.body.token}` } };
    const inv = await request(app).post('/api/organisations/members').set(agent.auth).send({ identifier: cashier.user.email, role: 'cashier' });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);

    const session = await request(app).get('/api/auth/me').set(cashier.auth);
    expect(session.body.user.id).toBe(cashier.user.id); // members stay themselves outside the till
    expect(session.body.memberships).toMatchObject([{ kind: 'agent', role: 'cashier', owner: false }]);

    const stats = await request(app).get('/api/agents/me/stats').set(cashier.auth);
    expect(stats.status, JSON.stringify(stats.body)).toBe(200);
    expect(stats.body.agent.id).toBe(agent.user.id);
    expect(stats.body.float).toEqual([{ currency: 'USD', balance: 50_000 }]);
    expect(stats.body.teamSize).toBe(2);

    const noPin = await request(app).post('/api/agents/me/cash-in').set(cashier.auth).send({ customer: customer.user.tag, amount: '20.00', currency: 'USD', pin: '1234' });
    expect(noPin.status).toBe(400);
    expect(noPin.body.error.code).toBe('pin_required');
    await request(app).post('/api/account/pin').set(cashier.auth).send({ pin: '5678' });
    const wrong = await request(app).post('/api/agents/me/cash-in').set(cashier.auth).send({ customer: customer.user.tag, amount: '20.00', currency: 'USD', pin: '1234' });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('invalid_pin');

    const ok = await request(app).post('/api/agents/me/cash-in').set(cashier.auth).send({ customer: customer.user.tag, amount: '20.00', currency: 'USD', pin: '5678' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const tx = getDb().prepare('SELECT * FROM transactions WHERE id = ?').get(ok.body.transaction.id) as any;
    expect(tx.sender_user_id).toBe(agent.user.id);
    expect(tx.receiver_user_id).toBe(customer.user.id);
    const meta = JSON.parse(tx.metadata);
    expect(meta.agentId).toBe(agent.user.id);
    expect(meta.operatorUserId).toBe(cashier.user.id);
    expect(meta.operatorTag).toBe(cashier.user.tag);
    // The float moved on the agent account (less the cash-in, plus the agent's commission share of the fee); the cashier's own wallet never held a cent of it.
    const agentWallet = getDb().prepare("SELECT balance FROM wallets WHERE user_id = ? AND currency = 'USD'").get(agent.user.id) as any;
    expect(agentWallet.balance).toBe(50_000 - 2_000 + meta.commission);
    const own = getDb().prepare('SELECT COALESCE(SUM(balance), 0) b FROM wallets WHERE user_id = ?').get(cashier.user.id) as any;
    expect(own.b).toBe(0);
    // The agent's queue of cash-out requests is what the cashier sees at the till; their personal list stays theirs.
    const till = await request(app).get('/api/agents/me/cash-requests').set(cashier.auth);
    expect(till.status).toBe(200);
  });

  it('a cashier confirms cash-out for the agent and is recorded as the operator on the transaction and the commission', async () => {
    const agent = await agentWithFloat('Goma Counter');
    const cashier = await invite(agent, 'cashier');
    const customer = await registerUser(app);
    await fund(app, customer.user.id, '100.00', 'USD');
    const req = await request(app).post('/api/agents/cash-out').set(customer.auth).send({ agent: agent.user.tag, amount: '30.00', currency: 'USD', pin: '1234' });
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    const done = await request(app).post('/api/agents/me/cash-out/confirm').set(cashier.auth).send({ code: req.body.request.code, pin: '1234' });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    const tx = getDb().prepare('SELECT * FROM transactions WHERE id = ?').get(done.body.transaction.id) as any;
    expect(tx.receiver_user_id).toBe(agent.user.id);
    expect(JSON.parse(tx.metadata).operatorUserId).toBe(cashier.user.id);
    const commission = getDb().prepare('SELECT metadata FROM commission_entries WHERE transaction_id = ?').get(tx.id) as any;
    expect(commission, 'commission entry recorded').toBeTruthy();
    expect(JSON.parse(commission.metadata).operatorUserId).toBe(cashier.user.id);
  });

  it('roles are enforced at the till: read-only cannot cash in, a cashier cannot request float or manage members, an operations manager can', async () => {
    const agent = await agentWithFloat('Bukavu Counter');
    const customer = await registerUser(app);
    const viewer = await invite(agent, 'read_only');
    const cashier = await invite(agent, 'cashier');
    const ops = await invite(agent, 'operations_manager');

    const denied = await request(app).post('/api/agents/me/cash-in').set(viewer.auth).send({ customer: customer.user.tag, amount: '20.00', currency: 'USD', pin: '1234' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('org_permission_denied');
    expect(denied.body.error.message).toContain('read only');
    const stats = await request(app).get('/api/agents/me/stats').set(viewer.auth);
    expect(stats.status).toBe(200); // read-only still sees the figures

    const floatByCashier = await request(app).post('/api/risk/agents/me/float/requests').set(cashier.auth).send({ currency: 'USD', amount: '100.00', method: 'cash_deposit' });
    expect(floatByCashier.status).toBe(403);
    expect(floatByCashier.body.error.code).toBe('org_permission_denied');
    const floatByOps = await request(app).post('/api/risk/agents/me/float/requests').set(ops.auth).send({ currency: 'USD', amount: '100.00', method: 'cash_deposit' });
    expect(floatByOps.status, JSON.stringify(floatByOps.body)).toBe(201);

    const inviteByCashier = await request(app).post('/api/organisations/members').set(cashier.auth).send({ identifier: customer.user.email, role: 'cashier' });
    expect(inviteByCashier.status).toBe(403);
    expect(inviteByCashier.body.error.code).toBe('org_permission_denied');
    const members = await request(app).get('/api/organisations/members').set(cashier.auth);
    expect(members.status).toBe(200);
    expect(members.body.data.map((m: any) => m.role).sort()).toEqual(['cashier', 'operations_manager', 'owner', 'read_only']);

    // The owner demotes and removes with the usual member endpoints; the removed person is a plain customer again.
    const demote = await request(app).patch(`/api/organisations/members/${ops.user.id}`).set(agent.auth).send({ role: 'analyst' });
    expect(demote.status).toBe(200);
    const floatAfter = await request(app).post('/api/risk/agents/me/float/requests').set(ops.auth).send({ currency: 'USD', amount: '100.00', method: 'cash_deposit' });
    expect(floatAfter.status).toBe(403);
    const removed = await request(app).delete(`/api/organisations/members/${cashier.user.id}`).set(agent.auth);
    expect(removed.status).toBe(200);
    const gone = await request(app).get('/api/agents/me/stats').set(cashier.auth);
    expect(gone.status).toBe(403);
    expect(gone.body.error.code).toBe('role_required');
  });

  it('a person who is both a shop cashier and an agent counter clerk lands in the right organisation per surface', async () => {
    const shop = await registerUser(app, { role: 'merchant', businessName: 'Both Shop' });
    const agent = await agentWithFloat('Both Counter');
    const person = await registerUser(app);
    for (const owner of [shop, agent]) {
      const res = await request(app).post('/api/organisations/members').set(owner.auth).send({ identifier: person.user.email, role: 'cashier' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    const stats = await request(app).get('/api/agents/me/stats').set(person.auth);
    expect(stats.status, JSON.stringify(stats.body)).toBe(200);
    expect(stats.body.agent.id).toBe(agent.user.id);
    const balance = await request(app).get('/api/v1/balance').set(person.auth);
    expect(balance.status, JSON.stringify(balance.body)).toBe(200);
    const session = await request(app).get('/api/auth/me').set(person.auth);
    expect(session.body.memberships.map((m: any) => m.kind).sort()).toEqual(['agent', 'merchant']);
    // The header still picks explicitly; a foreign organisation is refused.
    const shopOrg = session.body.memberships.find((m: any) => m.kind === 'merchant').organisationId;
    const picked = await request(app).get('/api/organisations/me').set(person.auth).set('X-Organisation-Id', shopOrg);
    expect(picked.body.organisation.id).toBe(shopOrg);
    const foreign = await request(app).get('/api/organisations/me').set(person.auth).set('X-Organisation-Id', 'org_nope');
    expect(foreign.status).toBe(403);
  });
});
