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

export const ADMIN_PIN = '9999';
export const CHECKER_PIN = '2222';

/** Seeded super admin. Sets a transaction PIN once so administrative step-up works in tests. */
export async function adminToken(app: ReturnType<typeof createApp>) {
  const res = await request(app).post('/api/auth/login').send({ identifier: 'admin@bitripay.local', password: 'Admin123!' });
  const auth = { Authorization: `Bearer ${res.body.token}` };
  await request(app).post('/api/account/pin').set(auth).send({ pin: ADMIN_PIN }); // no-op once set
  return { token: res.body.token as string, auth, pin: ADMIN_PIN };
}

/** A second administrator (the "checker") for maker-checker approvals. */
export async function checkerToken(app: ReturnType<typeof createApp>) {
  const admin = await adminToken(app);
  const login = async () => request(app).post('/api/auth/login').send({ identifier: 'checker@bitripay.local', password: 'Checker123!' });
  let res = await login();
  if (res.status !== 200) {
    const created = await request(app).post('/api/admin/users').set(admin.auth).send({ fullName: 'Checker Admin', email: 'checker@bitripay.local', password: 'Checker123!', role: 'admin', permissions: [] });
    if (created.status !== 201) throw new Error(`checker create failed: ${JSON.stringify(created.body)}`);
    res = await login();
  }
  const auth = { Authorization: `Bearer ${res.body.token}` };
  await request(app).post('/api/account/pin').set(auth).send({ pin: CHECKER_PIN });
  return { token: res.body.token as string, auth, pin: CHECKER_PIN, user: res.body.user as any };
}

/** Administrative payout decision (maker-checker): admin proposes with documentary evidence, checker approves under PIN step-up. */
export async function decideWithdrawal(app: ReturnType<typeof createApp>, txId: string, outcome: 'approve' | 'reject', ref = 'OPREF-12345') {
  const admin = await adminToken(app);
  const checker = await checkerToken(app);
  const proposed = await request(app).post(`/api/admin/withdrawals/${txId}/${outcome}`).set(admin.auth).send(outcome === 'approve' ? { payoutReference: ref, note: 'Operator statement line checked by treasury' } : { reason: 'bad account' });
  if (proposed.status !== 200) throw new Error(`propose failed: ${JSON.stringify(proposed.body)}`);
  const approved = await request(app).post(`/api/admin/verifications/${proposed.body.verification.id}/approve`).set(checker.auth).send({ pin: checker.pin });
  if (approved.status !== 200) throw new Error(`approve failed: ${JSON.stringify(approved.body)}`);
  const tx = await request(app).get(`/api/admin/transactions/${txId}`).set(admin.auth);
  return { verification: approved.body.verification, transaction: tx.body.transaction ?? null };
}

/** Maker-checker manual confirmation of an external payment: the admin proposes, the checker approves under PIN step-up. */
export async function manualConfirm(app: ReturnType<typeof createApp>, paymentId: string) {
  const admin = await adminToken(app);
  const checker = await checkerToken(app);
  const proposed = await request(app).post(`/api/admin/payments/${paymentId}/confirm`).set(admin.auth).send({ note: 'Seen on statement' });
  if (proposed.status !== 200) throw new Error(`propose failed: ${JSON.stringify(proposed.body)}`);
  const approved = await request(app).post(`/api/admin/verifications/${proposed.body.verification.id}/approve`).set(checker.auth).send({ pin: checker.pin });
  if (approved.status !== 200) throw new Error(`approve failed: ${JSON.stringify(approved.body)}`);
  return approved.body as { verification: any; payment: any };
}

/** E-money is created by administrators only, under maker-checker: one admin proposes the credit, a different one approves it with step-up. */
export async function fund(app: ReturnType<typeof createApp>, userId: string, amount: string, currency = 'USD') {
  const admin = await adminToken(app);
  const res = await request(app).post(`/api/admin/users/${userId}/adjust`).set(admin.auth).send({ direction: 'credit', amount, currency, reason: 'test funding' });
  if (res.status !== 201) throw new Error(`fund failed: ${JSON.stringify(res.body)}`);
  const checker = await checkerToken(app);
  const ok = await request(app).post(`/api/admin/verifications/${res.body.verification.id}/approve`).set(checker.auth).send({ pin: checker.pin });
  if (ok.status !== 200) throw new Error(`fund approve failed: ${JSON.stringify(ok.body)}`);
}
