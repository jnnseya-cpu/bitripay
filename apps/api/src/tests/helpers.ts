import request from 'supertest';
import { createApp, bootstrap } from '../app';
import { openDatabase, setDb, closeDb } from '../db';

export function setupApp() {
  closeDb();
  setDb(openDatabase(':memory:'));
  bootstrap();
  return createApp();
}

export async function registerUser(app: ReturnType<typeof createApp>, overrides: Record<string, unknown> = {}) {
  const n = Math.floor(Math.random() * 1e9);
  const res = await request(app)
    .post('/api/auth/register')
    .send({ fullName: `User ${n}`, email: `user${n}@test.local`, password: 'Password123!', ...overrides });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  const token = res.body.token as string;
  await request(app).post('/api/account/pin').set('Authorization', `Bearer ${token}`).send({ pin: '1234' });
  return { token, user: res.body.user as any, auth: { Authorization: `Bearer ${token}` } };
}

export async function adminToken(app: ReturnType<typeof createApp>) {
  const res = await request(app).post('/api/auth/login').send({ identifier: 'admin@bitripay.local', password: 'Admin123!' });
  return { token: res.body.token as string, auth: { Authorization: `Bearer ${res.body.token}` } };
}

export async function fund(app: ReturnType<typeof createApp>, userId: string, amount: string, currency = 'USD') {
  const admin = await adminToken(app);
  const res = await request(app).post(`/api/admin/users/${userId}/adjust`).set(admin.auth).send({ direction: 'credit', amount, currency, reason: 'test funding' });
  if (res.status !== 201) throw new Error(`fund failed: ${JSON.stringify(res.body)}`);
}
