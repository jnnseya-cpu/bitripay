/**
 * Launch-audit finding: signing out only dropped the token in the browser; the server kept honouring it for seven
 * days. `POST /api/auth/logout` now revokes the one token in hand (its session id) until its own expiry, other
 * devices keep their sessions, sign-out-everywhere still works, and API keys have no session to sign out of.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser } from './helpers';
import { getDb } from '../db';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

describe('sign-out revokes the token on the server', () => {
  it('refuses the signed-out token, keeps the same person signed in elsewhere, and is idempotent', async () => {
    const a = await registerUser(app);
    const second = await request(app).post('/api/auth/login').send({ identifier: a.user.email, password: 'Password123!' });
    expect(second.status).toBe(200);
    const other = { Authorization: `Bearer ${second.body.token}` };
    expect((await request(app).get('/api/auth/me').set(a.auth)).status).toBe(200);

    const out = await request(app).post('/api/auth/logout').set(a.auth);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true, revoked: true });

    const reuse = await request(app).get('/api/auth/me').set(a.auth);
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('invalid_token');
    // The other device is untouched.
    expect((await request(app).get('/api/auth/me').set(other)).status).toBe(200);
    // Signing out twice with the same token: the token is already refused.
    expect((await request(app).post('/api/auth/logout').set(a.auth)).status).toBe(401);
    // A fresh sign-in issues a new session id and works.
    const again = await request(app).post('/api/auth/login').send({ identifier: a.user.email, password: 'Password123!' });
    expect(again.status).toBe(200);
    expect(
      (
        await request(app)
          .get('/api/auth/me')
          .set({ Authorization: `Bearer ${again.body.token}` })
      ).status,
    ).toBe(200);
    const row = getDb().prepare('SELECT user_id, expires_at FROM revoked_sessions').all() as { user_id: string; expires_at: string }[];
    expect(row).toHaveLength(1);
    expect(row[0].user_id).toBe(a.user.id);
    expect(Date.parse(row[0].expires_at)).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);
  });

  it('sign-out-everywhere still invalidates every session, and an API key cannot sign out', async () => {
    const m = await registerUser(app, { role: 'merchant', businessName: 'Sign-out shop' });
    const key = await request(app).post('/api/v1/api_keys').set(m.auth).send({ label: 'k', mode: 'test' });
    expect(key.status).toBe(201);
    const viaKey = await request(app)
      .post('/api/auth/logout')
      .set({ Authorization: `Bearer ${key.body.secret ?? key.body.key ?? key.body.token}` });
    expect(viaKey.status).toBe(400);
    expect(viaKey.body.error.code).toBe('no_session');
    await new Promise((r) => setTimeout(r, 1100)); // JWT iat has second resolution
    expect((await request(app).post('/api/account/sessions/revoke').set(m.auth)).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set(m.auth)).status).toBe(401);
  });
});
