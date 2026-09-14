/**
 * Launch-audit fixes: sessions issued before a password change or a sign-out-everywhere are refused; an account can be
 * closed only with nothing outstanding and is then anonymised with its ledger intact; merchant redirect URLs must be
 * https (never javascript:); browsers get no credentialed CORS; an administrator can close an account on a lawful
 * request with step-up.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, adminToken, registerUser, fund } from './helpers';
import { getDb } from '../db';
import { verifyEventChain } from '../services/events';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('sessions', () => {
  it('a password change and a sign-out-everywhere invalidate every earlier token', async () => {
    const a = await registerUser(app);
    expect((await request(app).get('/api/auth/me').set(a.auth)).status).toBe(200);
    await wait(1100); // JWT iat has second resolution
    const changed = await request(app).post('/api/account/password').set(a.auth).send({ currentPassword: 'Password123!', newPassword: 'NewPassword456!' });
    expect(changed.status).toBe(200);
    const stale = await request(app).get('/api/auth/me').set(a.auth);
    expect(stale.status).toBe(401);
    expect(stale.body.error.code).toBe('invalid_token');
    const oldLogin = await request(app).post('/api/auth/login').send({ identifier: a.user.email, password: 'Password123!' });
    expect(oldLogin.status).toBe(401);
    const fresh = await request(app).post('/api/auth/login').send({ identifier: a.user.email, password: 'NewPassword456!' });
    expect(fresh.status).toBe(200);
    const auth2 = { Authorization: `Bearer ${fresh.body.token}` };
    expect((await request(app).get('/api/auth/me').set(auth2)).status).toBe(200);
    await wait(1100);
    expect((await request(app).post('/api/account/sessions/revoke').set(auth2)).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set(auth2)).status).toBe(401);
  });

  it('tampered and foreign-secret tokens are refused', async () => {
    const a = await registerUser(app);
    const [h, p] = a.token.split('.');
    const forged = `${h}.${p}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    expect(
      (
        await request(app)
          .get('/api/auth/me')
          .set({ Authorization: `Bearer ${forged}` })
      ).status,
    ).toBe(401);
    expect((await request(app).get('/api/admin/stats').set(a.auth)).status).toBe(403);
    expect((await request(app).get('/api/admin/stats')).status).toBe(401);
  });
});

describe('account closure (right to erasure)', () => {
  it('refuses while money or holds are outstanding, then anonymises and keeps the ledger', async () => {
    const a = await registerUser(app, { tag: 'closing1' });
    const b = await registerUser(app, { tag: 'closing2' });
    await fund(app, a.user.id, '20.00');
    const blocked = await request(app).delete('/api/account').set(a.auth).send({ password: 'Password123!', pin: '1234', confirm: 'CLOSE' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('closure_blocked');
    expect((await request(app).get('/api/account/closure').set(a.auth)).body.blockers[0].code).toBe('balance_not_zero');
    // empty the balance: send it all (fee comes out of the amount the recipient gets? no: sender pays fee), so send what is left after the fee
    const fee = (await request(app).get('/api/transfers/fee?amount=19.85&currency=USD').set(a.auth)).body.fee as number;
    const tx = await request(app)
      .post('/api/transfers')
      .set(a.auth)
      .send({ to: '@closing2', amount: ((2000 - fee) / 100).toFixed(2), currency: 'USD', pin: '1234' });
    expect(tx.status, JSON.stringify(tx.body)).toBe(201);
    expect((await request(app).get('/api/wallets').set(a.auth)).body.items[0].balance).toBe(0);
    const wrongPin = await request(app).delete('/api/account').set(a.auth).send({ password: 'Password123!', pin: '0000', confirm: 'CLOSE' });
    expect(wrongPin.status).toBe(403);
    const closed = await request(app).delete('/api/account').set(a.auth).send({ password: 'Password123!', pin: '1234', confirm: 'CLOSE', reason: 'leaving' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const row = getDb().prepare('SELECT full_name, email, phone, tag, status, closed_at, password_hash FROM users WHERE id = ?').get(a.user.id) as any;
    expect(row.status).toBe('closed');
    expect(row.email).toBeNull();
    expect(row.phone).toBeNull();
    expect(row.full_name).toBe('Closed account');
    expect(row.tag).toMatch(/^closed_/);
    expect(row.password_hash).toBeNull();
    // sessions and sign-in are gone, the recipient still sees the money and the ledger still chains
    expect((await request(app).get('/api/auth/me').set(a.auth)).status).toBe(403);
    expect((await request(app).post('/api/auth/login').send({ identifier: a.user.email, password: 'Password123!' })).status).toBe(401);
    expect((await request(app).get('/api/wallets').set(b.auth)).body.items[0].balance).toBe(2000 - fee);
    expect(getDb().prepare('SELECT COUNT(*) c FROM transactions WHERE sender_user_id = ?').get(a.user.id)).toEqual({ c: 1 });
    expect(verifyEventChain().ok).toBe(true);
    const again = await request(app).delete('/api/account').set(a.auth).send({ password: 'x', confirm: 'CLOSE' });
    expect(again.status).toBe(403);
  });

  it('an administrator closes an account on a lawful request with step-up, never an administrator account', async () => {
    const admin = await adminToken(app);
    const u = await registerUser(app);
    const blockers = await request(app).get(`/api/admin/users/${u.user.id}/closure`).set(admin.auth);
    expect(blockers.body.blockers).toEqual([]);
    const noPin = await request(app).post(`/api/admin/users/${u.user.id}/close`).set(admin.auth).send({ reason: 'Erasure request #42' });
    expect(noPin.status).toBe(403);
    const ok = await request(app).post(`/api/admin/users/${u.user.id}/close`).set(admin.auth).send({ reason: 'Erasure request #42', pin: admin.pin });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.user.status).toBe('closed');
    const log = await request(app).get('/api/admin/audit-logs?action=user.closed').set(admin.auth);
    expect(log.body.items.some((l: any) => l.targetId === u.user.id)).toBe(true);
    const self = (await request(app).get('/api/auth/me').set(admin.auth)).body.user;
    expect((await request(app).post(`/api/admin/users/${self.id}/close`).set(admin.auth).send({ reason: 'oops', pin: admin.pin })).status).toBe(400);
  });
});

describe('redirect URLs and CORS', () => {
  it('refuses javascript:, data: and plain-http redirect targets on payment links and checkout sessions', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Redirect Shop' });
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'http://evil.example/steal']) {
      const r = await request(app).post('/api/v1/checkout_sessions').set(m.auth).send({ currency: 'USD', amount_minor: 1000, success_url: bad, cancel_url: 'https://shop.example/cancel' });
      expect(r.status, bad).toBe(400);
    }
    const ok = await request(app)
      .post('/api/v1/checkout_sessions')
      .set(m.auth)
      .send({ currency: 'USD', amount_minor: 1000, success_url: 'https://shop.example/ok', cancel_url: 'http://localhost:3000/cancel' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const link = await request(app).post('/api/payment-requests').set(m.auth).send({ kind: 'link', amount: '5.00', currency: 'USD', successUrl: 'javascript:alert(1)' });
    expect(link.status).toBe(400);
  });

  it('answers cross-origin requests without credentials', async () => {
    const r = await request(app).get('/api/config').set('Origin', 'https://evil.example');
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('input hygiene', () => {
  it('an idempotency key reused with a different body is a conflict, control characters never reach a note, markdown links keep safe schemes only', async () => {
    const a = await registerUser(app, { tag: 'hygiene1' });
    const b = await registerUser(app, { tag: 'hygiene2' });
    await fund(app, a.user.id, '30.00');
    const first = await request(app).post('/api/transfers').set(a.auth).send({ to: '@hygiene2', amount: '2.00', currency: 'USD', pin: '1234', idempotencyKey: 'same-key-1' });
    expect(first.status).toBe(201);
    const replay = await request(app).post('/api/transfers').set(a.auth).send({ to: '@hygiene2', amount: '2.00', currency: 'USD', pin: '1234', idempotencyKey: 'same-key-1' });
    expect(replay.body.transaction.id).toBe(first.body.transaction.id);
    const reuse = await request(app).post('/api/transfers').set(a.auth).send({ to: '@hygiene2', amount: '3.00', currency: 'USD', pin: '1234', idempotencyKey: 'same-key-1' });
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe('idempotency_key_reused');
    expect((await request(app).get('/api/wallets').set(b.auth)).body.items[0].balance).toBe(200);
    const noted = await request(app).post('/api/transfers').set(a.auth).send({ to: '@hygiene2', amount: '1.00', currency: 'USD', pin: '1234', note: 'Mbote \u0000\u202e <b>x</b>' });
    expect(noted.status).toBe(201);
    expect(noted.body.transaction.note).toBe('Mbote  <b>x</b>');
    const bad = await request(app).post('/api/transfers').set(a.auth).send({ to: '@hygiene2', amount: 'abc', currency: 'USD', pin: '1234' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_amount');
    const { renderMarkdown } = await import('../services/markdown');
    const html = renderMarkdown('[x](javascript:alert(1)) [y](https://ok.example) ![i](data:text/html,x) <script>alert(1)</script>').html;
    expect(html).toContain('href="#"');
    expect(html).toContain('href="https://ok.example"');
    expect(html).toContain('src="#"');
    expect(html).not.toContain('<script>');
  });
});

describe('sign-in throttling', () => {
  it('throttles repeated failures per account, independently of the client address', async () => {
    const a = await registerUser(app);
    let limited = null;
    for (let i = 0; i < 12; i += 1) {
      const r = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', `10.0.0.${i + 1}`)
        .send({ identifier: a.user.email, password: `wrong${i}` });
      if (r.status === 429) {
        limited = i + 1;
        break;
      }
    }
    expect(limited).not.toBeNull();
    expect(limited).toBeLessThanOrEqual(11);
  });
});
