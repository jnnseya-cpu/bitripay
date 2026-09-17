/**
 * Opening accounts where the SMS provider does not deliver (the Democratic Republic of the Congo among them): an
 * administrator creates the customer and the acceptor from the console, with their handle and their transaction PIN;
 * the account starts verified and the person signs in with the password at once, no verification code anywhere. And a
 * keyed SMS provider that refuses or is not configured never makes a message disappear: it is queued for an enrolled
 * phone, which sends it from its own SIM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { setupApp, adminToken } from './helpers';
import { getDb } from '../db';
import { setSetting } from '../services/settings';
import { sendSms, listSmsOutbox } from '../services/messaging';

let app: ReturnType<typeof setupApp>;
let admin: Awaited<ReturnType<typeof adminToken>>;
beforeAll(async () => {
  app = setupApp();
  admin = await adminToken(app);
});
afterAll(() => setSetting('sms', {}));

describe('accounts opened from the console, without a verification code', () => {
  it('creates a customer and an acceptor with their handle, PIN and country; both sign in at once and are verified', async () => {
    const customer = await request(app)
      .post('/api/admin/users')
      .set(admin.auth)
      .send({ fullName: 'Cliente Démo', phone: '+243810000101', password: 'Password123!', role: 'user', country: 'CD', pin: '1234' });
    expect(customer.status, JSON.stringify(customer.body)).toBe(201);
    const merchant = await request(app)
      .post('/api/admin/users')
      .set(admin.auth)
      .send({ fullName: 'Kiosque Démo Owner', phone: '+243810000102', password: 'Password123!', role: 'merchant', businessName: 'Kiosque Démo', country: 'CD', tag: 'kiosquedemo', pin: '5678' });
    expect(merchant.status, JSON.stringify(merchant.body)).toBe(201);
    expect(merchant.body.user.tag).toBe('kiosquedemo');
    expect(merchant.body.user.businessName).toBe('Kiosque Démo');

    // verified without any code: the row carries both flags and a PIN hash
    for (const id of [customer.body.user.id, merchant.body.user.id]) {
      const row = getDb().prepare('SELECT email_verified, phone_verified, pin_hash FROM users WHERE id = ?').get(id) as any;
      expect(row.phone_verified).toBe(1);
      expect(row.email_verified).toBe(1);
      expect(row.pin_hash).toBeTruthy();
    }
    // each of them signs in with the password, no OTP step
    for (const phone of ['+243810000101', '+243810000102']) {
      const login = await request(app).post('/api/auth/login').send({ identifier: phone, password: 'Password123!' });
      expect(login.status, phone).toBe(200);
      expect(login.body.token).toBeTruthy();
      expect(login.body.requiresTwoFactor).toBeFalsy();
    }
    // the acceptor can open a sale straight away with the PIN the administrator set
    const merchantLogin = await request(app).post('/api/auth/login').send({ identifier: '+243810000102', password: 'Password123!' });
    const sale = await request(app)
      .post('/api/payment-requests')
      .set({ Authorization: `Bearer ${merchantLogin.body.token}` })
      .send({ amount: '5.00', currency: 'CDF', note: 'Première vente' });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    // the console records who opened the account and how
    const logs = await request(app).get('/api/admin/audit-logs?limit=10').set(admin.auth);
    expect(JSON.stringify(logs.body)).toContain('user.create');
    expect(JSON.stringify(logs.body)).toContain('administrator');
    // a bad PIN is refused
    const bad = await request(app).post('/api/admin/users').set(admin.auth).send({ fullName: 'X Y', phone: '+243810000103', password: 'Password123!', role: 'user', pin: '12' });
    expect(bad.status).toBe(400);
  });

  it('queues the message for an enrolled phone when the keyed SMS provider refuses or is not configured', async () => {
    setSetting('sms', { provider: 'twilio' }); // no credentials: the message must not be lost
    const before = listSmsOutbox().length;
    const r = await sendSms('+243810000104', 'Votre code BitriPay est 123456.');
    expect(r.delivered).toBe(true);
    expect(r.via).toBe('twilio_unconfigured_to_device');
    const queued = listSmsOutbox();
    expect(queued.length).toBe(before + 1);
    expect(queued[0].to).toBe('+243810000104'); // newest first
    expect(queued[0].status).toBe('queued');
  });
});
