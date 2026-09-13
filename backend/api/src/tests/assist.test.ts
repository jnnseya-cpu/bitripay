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

/** A regular account holder who funded a wallet and accepted the per-question pricing (nothing is paid up front). */
const subscriber = async (overrides: Record<string, unknown> = {}) => {
  const u = await registerUser(app, overrides);
  await fund(app, u.user.id, '10.00', 'USD');
  const c = await request(app).post('/api/assist/consent').set(u.auth).send({ version: 1 });
  if (c.status !== 201) throw new Error(`consent failed: ${JSON.stringify(c.body)}`);
  return { ...u, paid: 0 };
};
const usd = (minor: number) => `${(minor / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
/** Account holders never see provider / model / cost fields (rule 4); the tests read them through the administrator view. */
const run = async (auth: Record<string, string>, agent: string, input: string, context?: Record<string, unknown>) => {
  const r = await request(app).post('/api/assist/runs?wait=1').set(auth).send({ agent, input, context });
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  for (const k of ['provider', 'model', 'tokensIn', 'tokensOut', 'acu']) expect(r.body.run[k], `${k} must not reach the account holder`).toBeUndefined();
  const admin = await adminToken(app);
  const full = await request(app).get(`/api/admin/agents/runs/${r.body.run.id}`).set(admin.auth);
  return { ...r.body.run, provider: full.body.run.provider, model: full.body.run.model, acu: full.body.run.acu, tokensIn: full.body.run.tokensIn, tokensOut: full.body.run.tokensOut } as any;
};

describe('command centres', () => {
  it('offers an optional flat plan: nothing changes for account holders who do not activate it, activation is a normal ledger posting, and renewal can be cancelled', async () => {
    const admin0 = await adminToken(app);
    await request(app)
      .put('/api/admin/agents/settings')
      .set(admin0.auth)
      .send({ addon: { enabled: true }, billing: { mode: 'subscription' } });
    const u = await registerUser(app);
    await fund(app, u.user.id, '5.00', 'USD');
    const before = await request(app).get('/api/assist/agents').set(u.auth);
    expect(before.body.addon.required).toBe(true);
    expect(before.body.addon.active).toBe(false);
    expect(before.body.addon.prices.find((p: any) => p.currency === 'USD').amount).toBeGreaterThan(0);
    const blocked = await request(app).post('/api/assist/runs?wait=1').set(u.auth).send({ agent: 'chief_of_staff', input: 'What should I know today?' });
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.code).toBe('addon_required');
    // everything else keeps working exactly as before
    const w = await request(app).get('/api/wallets').set(u.auth);
    expect(w.body.items.find((x: any) => x.currency === 'USD').balance).toBe(500);
    // wrong PIN, then activation from the USD wallet
    const bad = await request(app).post('/api/assist/addon/activate').set(u.auth).send({ currency: 'USD', pin: '0000' });
    expect(bad.status).toBe(403);
    const ok = await request(app).post('/api/assist/addon/activate').set(u.auth).send({ currency: 'USD', pin: '1234' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.subscription.status).toBe('active');
    expect(ok.body.addon.active).toBe(true);
    const after = await request(app).get('/api/wallets').set(u.auth);
    expect(after.body.items.find((x: any) => x.currency === 'USD').balance).toBe(500 - ok.body.subscription.amount);
    const tx = await request(app).get('/api/wallets/transactions').set(u.auth);
    expect(tx.body.items[0].type).toBe('subscription');
    const now = await run(u.auth, 'chief_of_staff', 'What is my balance?');
    expect(now.status).toBe('completed');
    // cancelling stops renewal but keeps the paid period
    const cancel = await request(app).post('/api/assist/addon/cancel').set(u.auth);
    expect(cancel.body.subscription.autoRenew).toBe(false);
    expect(cancel.body.addon.active).toBe(true);
    // when the period ends without renewal the add-on lapses and the account is untouched
    getDb().prepare("UPDATE agent_subscriptions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE user_id = ?").run(u.user.id);
    const { renewSubscriptions } = await import('../services/assist/addon');
    expect(renewSubscriptions()).toEqual({ renewed: 0, expired: 1 });
    const lapsed = await request(app).get('/api/assist/agents').set(u.auth);
    expect(lapsed.body.addon.active).toBe(false);
    const again = await request(app).post('/api/assist/runs').set(u.auth).send({ agent: 'chief_of_staff', input: 'What should I know today?' });
    expect(again.status).toBe(402);
    // auto-renewing subscriptions are charged again from the wallet
    const r = await registerUser(app);
    await fund(app, r.user.id, '10.00', 'USD');
    await request(app).post('/api/assist/addon/activate').set(r.auth).send({ currency: 'USD', pin: '1234', autoRenew: true });
    getDb().prepare("UPDATE agent_subscriptions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE user_id = ?").run(r.user.id);
    expect(renewSubscriptions()).toEqual({ renewed: 1, expired: 0 });
    const renewed = await request(app).get('/api/assist/agents').set(r.auth);
    expect(renewed.body.addon.active).toBe(true);
    expect(renewed.body.addon.subscription.renewals).toBe(1);
    // administrators never pay; the console reports subscriptions and revenue
    const admin = await adminToken(app);
    const a = await request(app).get('/api/assist/agents').set(admin.auth);
    expect(a.body.addon.required).toBe(false);
    const report = await request(app).get('/api/admin/agents').set(admin.auth);
    expect(report.body.addon.revenue.find((x: any) => x.currency === 'USD').c).toBeGreaterThanOrEqual(3);
    await request(app)
      .put('/api/admin/agents/settings')
      .set(admin.auth)
      .send({ addon: { enabled: false }, billing: { mode: 'per_use' } });
  });

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
    const u = await subscriber();
    await fund(app, u.user.id, '120.00', 'USD');
    const r = await run(u.auth, 'chief_of_staff', 'What is my balance?');
    expect(r.status).toBe('completed');
    expect(r.provider).toBe('offline');
    expect(r.output).toContain(usd(13_000 - u.paid)); // 10.00 funded − add-on + 120.00
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
    const u = await subscriber();
    const b = await registerUser(app);
    await fund(app, u.user.id, '100.00', 'USD');
    await request(app)
      .post('/api/transfers')
      .set(u.auth)
      .send({ pin: '1234', to: `@${b.user.tag}`, amount: '30.00', currency: 'USD', note: 'School fees' });
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
    const u = await subscriber();
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
    expect(w.body.items.find((x: any) => x.currency === 'USD').balance).toBe(9_000 - u.paid);
  });

  it('keeps memories the account holder asks for, refuses secrets, and lets them delete everything', async () => {
    const u = await subscriber();
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
    const u = await subscriber();
    const admin = await adminToken(app);
    const me = await request(app).get('/api/auth/me').set(u.auth);
    expect(decide('chief_of_staff', me.body.user, 'emoney.issue').verdict).toBe('deny');
    expect(decide('chief_of_staff', me.body.user, 'transfers.send').verdict).toBe('deny');
    expect(decide('chief_of_staff', { ...me.body.user, role: 'user' } as any, 'admin.freeze_wallet').verdict).toBe('deny');
    const forbidden = await request(app).get('/api/admin/agents').set(u.auth);
    expect(forbidden.status).toBe(403);
    // A policy can narrow an agent further; publishing needs admin step-up and retires the previous version.
    const p1 = await request(app)
      .put('/api/admin/agents/policies')
      .set(admin.auth)
      .send({ scope: 'agent', scopeId: 'analyst', rules: { deny: ['transactions.list'] }, note: 'pilot', pin: admin.pin });
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
    const r = await request(app)
      .post('/api/admin/agents/run?wait=1')
      .set(admin.auth)
      .send({ agent: 'operations', input: `freeze USD wallet of ${victim.user.id} because suspicious card top-ups` });
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
    const u = await subscriber();
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
    getDb()
      .prepare("INSERT INTO agent_usage (user_id, agent_key, model, day, runs, tokens_in, tokens_out, cost_micros, acu) VALUES (?, 'analyst', 'claude-opus-5', ?, 3, 100000, 20000, 5000000, 500)")
      .run(u.user.id, new Date().toISOString().slice(0, 10));
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
    const u = await subscriber();
    const r = await run(u.auth, 'security', 'Is my account secure?');
    expect(r.actions[0].tool).toBe('profile.summary');
    const s = await request(app)
      .get(`/api/assist/runs/${r.id}/stream`)
      .set(u.auth)
      .buffer(true)
      .parse((res, cb) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => cb(null, d));
      });
    expect(s.status).toBe(200);
    expect(s.headers['content-type']).toContain('text/event-stream');
    expect(s.body).toContain('event: step');
    expect(s.body).toContain('event: done');
    const c = await request(app).post(`/api/assist/runs/${r.id}/cancel`).set(u.auth);
    expect(c.body.run.status).toBe('completed');
  });

  it('meters questions per use: disclosed prices and consent, free lookups, a free allowance for active accounts, wallet charges on completion, daily and platform caps, and a margin report', async () => {
    const admin = await adminToken(app);
    await request(app)
      .put('/api/admin/agents/settings')
      .set(admin.auth)
      .send({
        addon: { enabled: false },
        billing: { mode: 'per_use', simulateLive: true, freeRunsPerMonth: 2, dailyCapPerUser: 3, platformCapPctOfFees: 15, platformCapFloorMinor: 5_000, disclosureVersion: 1 },
      });
    const u = await registerUser(app);
    const friend = await registerUser(app);
    await fund(app, u.user.id, '10.00', 'USD');
    // consent first: nothing runs before the price is shown and accepted
    const before = await request(app).get('/api/assist/agents').set(u.auth);
    expect(before.body.billing.mode).toBe('per_use');
    expect(before.body.billing.consentRequired).toBe(true);
    expect(before.body.billing.prices[0].currency).toBe('USD');
    expect(before.body.billing.prices[0].standard).toBeGreaterThan(0);
    expect(before.body.billing.disclosure.lines.join(' ')).toContain('taken from your wallet only after the answer');
    const blocked = await request(app).post('/api/assist/runs?wait=1').set(u.auth).send({ agent: 'research', input: 'How is my balance protected?' });
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.code).toBe('consent_required');
    const stale = await request(app).post('/api/assist/consent').set(u.auth).send({ version: 99 });
    expect(stale.status).toBe(409);
    const consent = await request(app).post('/api/assist/consent').set(u.auth).send({ version: 1 });
    expect(consent.status).toBe(201);
    expect(consent.body.billing.consentRequired).toBe(false);
    // lookups from the account's own records are free even though a (simulated) model is available
    const lookup = await run(u.auth, 'analyst', 'What is my balance?');
    expect(lookup.billing.tier).toBe('free');
    expect(lookup.billing.reason).toBe('lookup');
    expect(lookup.provider).toBe('offline');
    // no free allowance until the account moved money this month
    expect((await request(app).get('/api/assist/billing').set(u.auth)).body.billing.freeRunsLeft).toBe(0);
    await request(app)
      .post('/api/transfers')
      .set(u.auth)
      .send({ pin: '1234', to: `@${friend.user.tag}`, amount: '1.00', currency: 'USD' });
    expect((await request(app).get('/api/assist/billing').set(u.auth)).body.billing.freeRunsLeft).toBe(2);
    const q1 = await run(u.auth, 'research', 'How is my balance protected?');
    expect(q1.billing.reason).toBe('allowance');
    expect(q1.billing.amount).toBe(0);
    expect(q1.provider).toBe('simulated');
    expect(q1.model).toBe('claude-sonnet-5');
    expect(q1.acu).toBeGreaterThan(0);
    const q2 = await run(u.auth, 'research', 'What documents do I need for KYC?');
    expect(q2.billing.reason).toBe('allowance');
    // the third question is charged from the wallet on completion, tax share recorded, visible on the statement
    const walletBefore = (await request(app).get('/api/wallets').set(u.auth)).body.items.find((w: any) => w.currency === 'USD').balance;
    const q3 = await run(u.auth, 'research', 'What does it cost to send money to Kinshasa?');
    expect(q3.billing.reason).toBe('charged');
    expect(q3.billing.charged).toBe(true);
    expect(q3.billing.currency).toBe('USD');
    expect(q3.billing.amount).toBe(before.body.billing.prices[0].standard);
    expect(q3.billing.tax).toBeGreaterThan(0);
    const walletAfter = (await request(app).get('/api/wallets').set(u.auth)).body.items.find((w: any) => w.currency === 'USD').balance;
    expect(walletBefore - walletAfter).toBe(q3.billing.amount);
    const tx = await request(app).get(`/api/wallets/transactions/${q3.billing.transactionId}`).set(u.auth);
    expect(tx.body.transaction.type).toBe('agent_usage');
    expect(tx.body.transaction.note).toBe('Agent question · Research');
    // daily cap on paid questions; free lookups keep working
    const capped = await request(app).post('/api/assist/runs?wait=1').set(u.auth).send({ agent: 'research', input: 'What is a corridor?' });
    expect(capped.status).toBe(429);
    expect(capped.body.error.code).toBe('daily_cap');
    const stillFree = await run(u.auth, 'analyst', 'What is my balance?');
    expect(stillFree.billing.reason).toBe('lookup');
    // deep runs are priced higher and only for the roles allowed
    const m = await registerUser(app, { role: 'merchant', businessName: 'Kiosk' });
    await fund(app, m.user.id, '10.00', 'USD');
    await request(app).post('/api/assist/consent').set(m.auth).send({ version: 1 });
    const deep = await request(app).post('/api/assist/runs?wait=1').set(m.auth).send({ agent: 'growth', input: 'How can I get more customers to pay by QR?', depth: 'deep' });
    expect(deep.status).toBe(202);
    expect(deep.body.run.billing.tier).toBe('deep');
    expect(deep.body.run.billing.amount).toBe(before.body.billing.prices[0].deep);
    expect(deep.body.run.model).toBeUndefined(); // rule 4: the merchant never sees the model
    expect((await request(app).get(`/api/admin/agents/runs/${deep.body.run.id}`).set(admin.auth)).body.run.model).toBe('claude-opus-5');
    const userDeep = await registerUser(app);
    await request(app).post('/api/assist/consent').set(userDeep.auth).send({ version: 1 });
    // an empty wallet cannot ask a paid question, and is told the price
    const broke = await request(app).post('/api/assist/runs?wait=1').set(userDeep.auth).send({ agent: 'research', input: 'How is my balance protected?', depth: 'deep' });
    expect(broke.status).toBe(402);
    expect(broke.body.error.code).toBe('insufficient_balance');
    expect(broke.body.error.message).toContain('costs');
    // the platform cap: once model spend reaches the share of fee revenue, everyone degrades to the free planner
    await request(app)
      .put('/api/admin/agents/settings')
      .set(admin.auth)
      .send({ billing: { platformCapPctOfFees: 0, platformCapFloorMinor: 0 } });
    const degraded = await run(m.auth, 'research', 'How is my balance protected?');
    expect(degraded.billing.reason).toBe('degraded');
    expect(degraded.billing.amount).toBe(0);
    expect(degraded.provider).toBe('offline');
    // margin report for the control centre
    const report = await request(app).get('/api/admin/agents').set(admin.auth);
    const b = report.body.billing;
    expect(b.revenue).toBeGreaterThan(0);
    expect(b.tax).toBeGreaterThan(0);
    expect(b.modelCost).toBeGreaterThan(0);
    expect(b.margin).toBe(b.netRevenue - b.modelCost);
    expect(b.cap.degraded).toBe(true);
    expect(b.runsByReason.map((r: any) => r.reason)).toEqual(expect.arrayContaining(['lookup', 'allowance', 'charged', 'degraded']));
    // changing a price bumps the disclosure version so everyone re-reads it
    const bump = await request(app)
      .put('/api/admin/agents/settings')
      .set(admin.auth)
      .send({ billing: { prices: { standard: 6 } } });
    expect(bump.body.settings.billing.disclosureVersion).toBe(2);
    expect((await request(app).get('/api/assist/billing').set(u.auth)).body.billing.consentRequired).toBe(true);
    await request(app)
      .put('/api/admin/agents/settings')
      .set(admin.auth)
      .send({ billing: { simulateLive: false, freeRunsPerMonth: 5, dailyCapPerUser: 20, platformCapPctOfFees: 15, platformCapFloorMinor: 5_000, prices: { standard: 5 }, disclosureVersion: 1 } });
  });
});
