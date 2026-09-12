/**
 * Command centres: agents per role, offline runs through the tool gateway, proposals instead of money movement,
 * memories, policies, forbidden capabilities, maker-checker approvals for administrative actions, pause and budgets.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, fund, adminToken, checkerToken } from './helpers';
import { decide } from '../services/assist/policy';
import { getDb } from '../db';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

const run = async (auth: Record<string, string>, agent: string, input: string, context?: Record<string, unknown>) => {
  const r = await request(app).post('/api/assist/runs?wait=1').set(auth).send({ agent, input, context });
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  return r.body.run as any;
};

describe('command centres', () => {
  it('lists the agents each role can use, with tools filtered by role and permission', async () => {
    const u = await registerUser(app);
    const m = await registerUser(app, { role: 'merchant', businessName: 'Mama Chantal Foods' });
    const admin = await adminToken(app);
    const ru = await request(app).get('/api/assist/agents').set(u.auth);
    expect(ru.status).toBe(200);
    const keys = ru.body.agents.map((a: any) => a.key);
    expect(keys).toEqual(expect.arrayContaining(['chief_of_staff', 'analyst', 'research', 'automation', 'security', 'knowledge']));
    expect(keys).not.toContain('growth');
    expect(keys).not.toContain('operations');
    expect(ru.body.runtime.mode).toBe('offline');
    expect(ru.body.usage.allowance).toBe(500);
    const chief = ru.body.agents.find((a: any) => a.key === 'chief_of_staff');
    expect(chief.tools).not.toContain('admin.routes_stuck');
    expect(chief.tools).not.toContain('merchant.stats');
    const rm = await request(app).get('/api/assist/agents').set(m.auth);
    expect(rm.body.agents.map((a: any) => a.key)).toContain('growth');
    expect(rm.body.agents.find((a: any) => a.key === 'chief_of_staff').tools).toContain('merchant.stats');
    const ra = await request(app).get('/api/assist/agents').set(admin.auth);
    expect(ra.body.agents.map((a: any) => a.key)).toEqual(expect.arrayContaining(['operations', 'compliance', 'system_health']));
    expect(ra.body.usage.unlimited).toBe(true);
    const tools = await request(app).get('/api/assist/tools').set(u.auth);
    expect(tools.body.tools.map((t: any) => t.name)).not.toContain('admin.freeze_wallet');
  });

  it('answers a balance question by reading the ledger through the tool gateway and logs every step', async () => {
    const u = await registerUser(app);
    await fund(app, u.user.id, '120.00', 'USD');
    const r = await run(u.auth, 'chief_of_staff', 'What is my balance?');
    expect(r.status).toBe('completed');
    expect(r.provider).toBe('offline');
    expect(r.output).toContain('120.00 USD');
    expect(r.actions.map((a: any) => a.tool)).toContain('wallets.balances');
    expect(r.actions.every((a: any) => a.outcome === 'executed')).toBe(true);
    expect(r.acu).toBe(0);
    const list = await request(app).get('/api/assist/runs').set(u.auth);
    expect(list.body.items[0].id).toBe(r.id);
    const other = await registerUser(app);
    const hidden = await request(app).get(`/api/assist/runs/${r.id}`).set(other.auth);
    expect(hidden.status).toBe(404);
  });

  it('explains spending and builds a statement from the same data the statements module uses', async () => {
    const u = await registerUser(app);
    const b = await registerUser(app);
    await fund(app, u.user.id, '100.00', 'USD');
    await request(app).post('/api/transfers').set(u.auth).send({ pin: '1234', to: `@${b.user.tag}`, amount: '30.00', currency: 'USD', note: 'School fees' });
    const spent = await run(u.auth, 'analyst', 'How much did I spend this month?');
    expect(spent.actions[0].tool).toBe('transactions.list');
    expect(spent.actions[0].input.direction).toBe('out');
    expect(spent.output).toContain('School fees');
    const st = await run(u.auth, 'analyst', 'Build my USD statement for this month');
    expect(st.actions[0].tool).toBe('statements.build');
    expect(st.output).toMatch(/Statement ST-\d{8}/);
    expect(st.output).toContain('closing');
  });

  it('never moves money: a send request becomes a proposal the account holder confirms in the app', async () => {
    const u = await registerUser(app);
    const b = await registerUser(app);
    await fund(app, u.user.id, '80.00', 'USD');
    const r = await run(u.auth, 'automation', `Send 25 USD to @${b.user.tag} for rent`);
    expect(r.status).toBe('completed');
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0].type).toBe('send');
    expect(r.proposals[0].link).toContain('/app/send?');
    expect(r.proposals[0].link).toContain(`to=%40${b.user.tag}`);
    expect(r.output).toContain('nothing has been sent');
    const w = await request(app).get('/api/wallets').set(u.auth);
    expect(w.body.items.find((x: any) => x.currency === 'USD').balance).toBe(8_000);
  });

  it('keeps memories the account holder asks for, refuses secrets, and lets them delete everything', async () => {
    const u = await registerUser(app);
    const r = await run(u.auth, 'knowledge', 'Remember that I prefer receipts on WhatsApp');
    expect(r.actions[0].tool).toBe('memory.remember');
    expect(r.output).toContain('WhatsApp');
    const secret = await run(u.auth, 'knowledge', 'Remember that my PIN is 4321');
    expect(secret.actions[0].result.error).toBe('refused');
    const recall = await run(u.auth, 'knowledge', 'What do you remember about me?');
    expect(recall.output).toContain('receipts on WhatsApp');
    const mem = await request(app).get('/api/assist/memories').set(u.auth);
    expect(mem.body.items).toHaveLength(1);
    const del = await request(app).delete('/api/assist/memories').set(u.auth);
    expect(del.body.deleted).toBe(1);
  });

  it('denies capabilities that are not tools, tools outside the role, and tools removed by a published policy', async () => {
    const u = await registerUser(app);
    const admin = await adminToken(app);
    const me = await request(app).get('/api/auth/me').set(u.auth);
    expect(decide('chief_of_staff', me.body.user, 'emoney.issue').verdict).toBe('deny');
    expect(decide('chief_of_staff', me.body.user, 'transfers.send').verdict).toBe('deny');
    expect(decide('chief_of_staff', { ...me.body.user, role: 'user' } as any, 'admin.freeze_wallet').verdict).toBe('deny');
    const forbidden = await request(app).get('/api/admin/agents').set(u.auth);
    expect(forbidden.status).toBe(403);
    // A policy can narrow an agent further; publishing needs admin step-up and retires the previous version.
    const p1 = await request(app).put('/api/admin/agents/policies').set(admin.auth).send({ scope: 'agent', scopeId: 'analyst', rules: { deny: ['transactions.list'] }, note: 'pilot', pin: admin.pin });
    expect(p1.status, JSON.stringify(p1.body)).toBe(201);
    const denied = await run(u.auth, 'analyst', 'How much did I spend this month?');
    expect(denied.actions[0].outcome).toBe('denied');
    expect(denied.output).toContain('not allowed');
    const p2 = await request(app).put('/api/admin/agents/policies').set(admin.auth).send({ scope: 'agent', scopeId: 'analyst', rules: {}, pin: admin.pin });
    expect(p2.body.policy.version).toBe(2);
    const pols = await request(app).get('/api/admin/agents/policies?all=1').set(admin.auth);
    expect(pols.body.items.filter((p: any) => p.scopeId === 'analyst').map((p: any) => p.status)).toEqual(['live', 'retired']);
    const ok = await run(u.auth, 'analyst', 'How much did I spend this month?');
    expect(ok.actions[0].outcome).toBe('executed');
  });

  it('routes administrative actions through maker-checker: the agent queues a freeze, a different administrator approves it under step-up', async () => {
    const admin = await adminToken(app);
    const checker = await checkerToken(app);
    const victim = await registerUser(app);
    await fund(app, victim.user.id, '10.00', 'USD');
    const r = await request(app).post('/api/admin/agents/run?wait=1').set(admin.auth).send({ agent: 'operations', input: `freeze USD wallet of ${victim.user.id} because suspicious card top-ups` });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.run.status).toBe('awaiting_approval');
    const action = r.body.run.actions[0];
    expect(action.tool).toBe('admin.freeze_wallet');
    expect(action.outcome).toBe('awaiting_approval');
    const pending = await request(app).get('/api/admin/agents/approvals?status=proposed').set(admin.auth);
    const approval = pending.body.items.find((a: any) => a.runId === r.body.run.id);
    expect(approval.summary).toContain('Freeze USD wallet');
    // the wallet is untouched until a checker decides
    let wallets = await request(app).get(`/api/admin/users/${victim.user.id}`).set(admin.auth);
    expect(wallets.body.wallets.find((w: any) => w.currency === 'USD').frozen).toBe(false);
    const self = await request(app).post(`/api/admin/agents/approvals/${approval.id}/approve`).set(admin.auth).send({ pin: admin.pin });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('maker_checker');
    const ok = await request(app).post(`/api/admin/agents/approvals/${approval.id}/approve`).set(checker.auth).send({ pin: checker.pin, reason: 'Confirmed on the risk report' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.approval.status).toBe('approved');
    expect(ok.body.run.status).toBe('completed');
    expect(ok.body.run.actions[0].outcome).toBe('executed');
    wallets = await request(app).get(`/api/admin/users/${victim.user.id}`).set(admin.auth);
    expect(wallets.body.wallets.find((w: any) => w.currency === 'USD').frozen).toBe(true);
    // the scheduled operations report works end to end for administrators
    const ops = await request(app).post('/api/admin/agents/run?wait=1').set(admin.auth).send({ agent: 'operations', input: 'Run the morning operations check' });
    expect(ops.body.run.status).toBe('completed');
    expect(ops.body.run.actions.map((a: any) => a.tool)).toEqual(expect.arrayContaining(['admin.routes_stuck', 'admin.liquidity', 'admin.emoney_overview']));
  });

  it('lets administrators pause an agent, trip the kill switch and cap allowances; users see their usage', async () => {
    const admin = await adminToken(app);
    const u = await registerUser(app);
    const paused = await request(app).post('/api/admin/agents/research/pause').set(admin.auth);
    expect(paused.body.paused).toContain('research');
    const refused = await request(app).post('/api/assist/runs?wait=1').set(u.auth).send({ agent: 'research', input: 'How is my balance protected?' });
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('agent_paused');
    await request(app).post('/api/admin/agents/research/resume').set(admin.auth);
    const okRun = await run(u.auth, 'research', 'How is my balance protected?');
    expect(okRun.actions[0].tool).toBe('knowledge.search');
    expect(okRun.output).toContain("From BitriPay's guides");
    expect(okRun.output).toContain('/legal/');
    const kill = await request(app).post('/api/admin/agents/kill-switch').set(admin.auth).send({ on: true, pin: admin.pin });
    expect(kill.status).toBe(200);
    const stopped = await request(app).post('/api/assist/runs').set(u.auth).send({ agent: 'research', input: 'hello there' });
    expect(stopped.body.error.code).toBe('assist_paused');
    await request(app).post('/api/admin/agents/kill-switch').set(admin.auth).send({ on: false, pin: admin.pin });
    // allowance: pretend the account already spent its month
    getDb().prepare("INSERT INTO agent_usage (user_id, agent_key, model, day, runs, tokens_in, tokens_out, cost_micros, acu) VALUES (?, 'analyst', 'claude-opus-5', ?, 3, 100000, 20000, 5000000, 500)").run(u.user.id, new Date().toISOString().slice(0, 10));
    const usage = await request(app).get('/api/assist/usage').set(u.auth);
    expect(usage.body.usage.remaining).toBe(0);
    const over = await request(app).post('/api/assist/runs?wait=1').set(u.auth).send({ agent: 'analyst', input: 'What is my balance?' });
    expect(over.body.run.status).toBe('budget_exhausted');
    const registry = await request(app).get('/api/admin/agents').set(admin.auth);
    expect(registry.body.agents.find((a: any) => a.key === 'analyst').runs30d).toBeGreaterThan(0);
    expect(registry.body.forbidden).toContain('emoney.issue');
    expect(registry.body.settings.apiKey).toBe('');
  });

  it('streams a finished run over server-sent events and cancels a run cleanly', async () => {
    const u = await registerUser(app);
    const r = await run(u.auth, 'security', 'Is my account secure?');
    expect(r.actions[0].tool).toBe('profile.summary');
    const s = await request(app).get(`/api/assist/runs/${r.id}/stream`).set(u.auth).buffer(true).parse((res, cb) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => cb(null, d)); });
    expect(s.status).toBe(200);
    expect(s.headers['content-type']).toContain('text/event-stream');
    expect(s.body).toContain('event: step');
    expect(s.body).toContain('event: done');
    const c = await request(app).post(`/api/assist/runs/${r.id}/cancel`).set(u.auth);
    expect(c.body.run.status).toBe('completed');
  });
});
