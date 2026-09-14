/**
 * Communication event engine: one emit fans out across channels, mandatory notices bypass opt-outs, legacy notify()
 * calls with a template key are routed through the engine, every attempt is logged, and the console can preview a
 * branded email and send a test to the signed-in administrator.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, adminToken, registerUser } from './helpers';
import { COMMS_CATEGORIES, COMMS_CHANNELS, COMMS_EVENTS, getCommsEvent } from '../services/comms/catalogue';
import { emit, listDeliveries, commsOverview, previewEvent, setCommsPrefs } from '../services/comms/engine';
import { notify } from '../services/notifications';
import { getDb } from '../db';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('communication event catalogue', () => {
  it('is consistent: unique ids, known categories and channels, every placeholder has a sample value', () => {
    expect(COMMS_EVENTS.length).toBeGreaterThanOrEqual(170);
    expect(COMMS_CATEGORIES).toHaveLength(15);
    const ids = new Set<string>();
    for (const e of COMMS_EVENTS) {
      expect(ids.has(e.id), `duplicate ${e.id}`).toBe(false);
      ids.add(e.id);
      expect(
        COMMS_CATEGORIES.some((c) => c.id === e.category),
        `${e.id} category`,
      ).toBe(true);
      expect(e.channels.length).toBeGreaterThan(0);
      for (const ch of e.channels) expect(COMMS_CHANNELS).toContain(ch);
      for (const m of `${e.subject} ${e.body}`.matchAll(/\{\{(\w+)\}\}/g)) expect(e.sample[m[1]] !== undefined, `${e.id} needs sample for ${m[1]}`).toBe(true);
    }
    // every legacy template key is a catalogue event so administrator-edited templates keep applying
    for (const key of ['otp', 'welcome', 'payment.received', 'payout.paid', 'kyc.approved', 'remittance.sent', 'virtual_card.issued', 'recovery_code.used', 'destination.changed'])
      expect(getCommsEvent(key)).toBeTruthy();
    expect(COMMS_EVENTS.filter((e) => e.mandatory).length).toBeGreaterThanOrEqual(25);
  });
});

describe('communication engine', () => {
  it('fans one event out across its channels, logs every attempt, and reports coverage', async () => {
    const u = await registerUser(app, { phone: '+243890000123' });
    const d = await emit('transfer.received', { userId: u.user.id, vars: { sender: 'Amina K.', amount: 'USD 25.00', currency: 'USD', note: '' } });
    expect(d.map((x) => x.channel).sort()).toEqual(['inapp', 'push', 'sms', 'whatsapp']);
    expect(d.find((x) => x.channel === 'inapp')!.status).toBe('sent');
    expect(d.find((x) => x.channel === 'push')!.status).toBe('skipped_no_device');
    expect(d.find((x) => x.channel === 'sms')!.status).toBe('logged'); // no Twilio in tests
    expect(d.find((x) => x.channel === 'sms')!.recipient).toBe('…0123');
    const inbox = await request(app).get('/api/account/notifications').set(u.auth);
    expect(inbox.body.items[0].title).toBe('Amina K. sent you USD 25.00');
    const overview = commsOverview();
    expect(overview.events).toBe(COMMS_EVENTS.length);
    expect(overview.coverage.find((c) => c.channel === 'inapp')!.events).toBe(COMMS_EVENTS.filter((e) => e.channels.includes('inapp')).length);
    expect(overview.coverage.find((c) => c.channel === 'inapp')!.wired).toBe(true);
    expect(listDeliveries({ userId: u.user.id }).length).toBeGreaterThanOrEqual(4);
  });

  it('honours opt-outs per category and channel, except for mandatory notices', async () => {
    const u = await registerUser(app, { phone: '+243890000124' });
    const prefs = await request(app).get('/api/account/notifications/preferences').set(u.auth);
    expect(prefs.body.categories.map((c: any) => c.id)).toContain('wallet');
    const saved = await request(app)
      .put('/api/account/notifications/preferences')
      .set(u.auth)
      .send({ prefs: { wallet: { sms: false, whatsapp: false, inapp: true }, security: { email: false, sms: false } } });
    expect(saved.status).toBe(200);
    expect(saved.body.prefs).toEqual({ wallet: { sms: false, whatsapp: false }, security: { email: false, sms: false } });
    const d = await emit('transfer.received', { userId: u.user.id, vars: { sender: 'A', amount: 'USD 1.00', currency: 'USD', note: '' } });
    expect(d.find((x) => x.channel === 'sms')!.status).toBe('skipped_opted_out');
    expect(d.find((x) => x.channel === 'inapp')!.status).toBe('sent');
    // password.changed is mandatory: the security opt-out does not apply
    const m = await emit('password.changed', { userId: u.user.id, vars: { time: '14:03 UTC' } });
    expect(m.find((x) => x.channel === 'sms')!.status).toBe('logged');
    expect(m.find((x) => x.channel === 'email')!.status).toBe('logged');
    expect(m.every((x) => x.mandatory)).toBe(true);
  });

  it('routes legacy notify() calls with a template key through the engine and logs plain notices', async () => {
    const u = await registerUser(app, { phone: '+243890000125' });
    notify(u.user.id, 'Payout delivered', 'fallback', {
      template: 'payout.paid',
      vars: { amount: 'KES 5,000.00', recipient: 'Joseph O.', rail: 'M-PESA', reference: 'BP-7Y2K', senderName: 'Amina K.' },
      kind: 'payout',
    });
    await wait(50);
    const rows = listDeliveries({ userId: u.user.id, eventId: 'payout.paid' });
    expect(rows.map((r) => r.channel).sort()).toEqual(['inapp', 'push', 'sms', 'whatsapp']);
    expect(rows.find((r) => r.channel === 'inapp')!.status).toBe('sent');
    expect(rows.find((r) => r.channel === 'sms')!.status).toBe('logged');
    notify(u.user.id, 'Plain notice', 'Nothing templated here', { kind: 'system' });
    await wait(20);
    const plain = listDeliveries({ userId: u.user.id, eventId: 'notice.generic' });
    expect(plain.map((r) => r.channel).sort()).toEqual(['inapp', 'push']);
    // security events emitted from the account routes
    await request(app).post('/api/account/password').set(u.auth).send({ currentPassword: 'Password123!', newPassword: 'Password456!' });
    await wait(50);
    expect(listDeliveries({ userId: u.user.id, eventId: 'password.changed' }).length).toBeGreaterThanOrEqual(3);
  });

  it('previews the branded email and sends a test to the administrator from the console', async () => {
    const admin = await adminToken(app);
    getDb().prepare("UPDATE users SET phone = '+243890000126' WHERE email = 'admin@bitripay.local'").run();
    const p = previewEvent('remittance.delivered');
    expect(p.html).toContain('<!doctype html>');
    expect(p.html).toContain('support@bitripay.com');
    expect(p.channels.email.subject).toBe('Remittance delivered');
    const catalogue = await request(app).get('/api/admin/comms').set(admin.auth);
    expect(catalogue.status).toBe(200);
    expect(catalogue.body.overview.categories).toBe(15);
    expect(catalogue.body.overview.channelsWired).toBeGreaterThanOrEqual(2);
    const preview = await request(app).post('/api/admin/comms/preview').set(admin.auth).send({ eventId: 'welcome' });
    expect(preview.body.html).toContain('Welcome to BitriPay!');
    const test = await request(app).post('/api/admin/comms/test').set(admin.auth).send({ eventId: 'auth.login.suspicious' });
    expect(test.status).toBe(200);
    expect(test.body.deliveries.map((d: any) => d.channel).sort()).toEqual(['email', 'inapp', 'sms']);
    expect(test.body.deliveries.every((d: any) => d.test)).toBe(true);
    const log = await request(app).get('/api/admin/comms/deliveries?eventId=auth.login.suspicious').set(admin.auth);
    expect(log.body.items.length).toBeGreaterThanOrEqual(3);
    const bad = await request(app).post('/api/admin/comms/preview').set(admin.auth).send({ eventId: 'no.such.event' });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    // preferences never silence mandatory notices even for the administrator
    const adminId = (getDb().prepare("SELECT id FROM users WHERE email = 'admin@bitripay.local'").get() as { id: string }).id;
    setCommsPrefs(adminId, { security: { email: false } });
    const forced = await emit('security.alert', { userId: adminId, vars: { detail: 'test' } });
    expect(forced.find((d) => d.channel === 'email')!.status).not.toBe('skipped_opted_out');
  });
});

describe('home-market catalogues', () => {
  it('adds the DRC billers, top-up operators and vouchers by name, idempotently, on an already seeded database', async () => {
    const { ensureDrcCatalogs } = await import('../seedDefaults');
    const { listBillers, listOperators, listGiftProducts } = await import('../services/services');
    ensureDrcCatalogs();
    ensureDrcCatalogs();
    const billers = listBillers(true, 'CD');
    expect(billers.map((b: any) => b.name)).toEqual(expect.arrayContaining(["SNEL (Société nationale d'électricité)", 'REGIDESO', 'Canal+ Afrique']));
    expect(billers.filter((b: any) => b.name === 'REGIDESO')).toHaveLength(1);
    expect(billers.every((b: any) => b.currency === 'CDF')).toBe(true);
    const ops = listOperators(true, 'CD').map((o: any) => o.name);
    expect(ops).toEqual(expect.arrayContaining(['Vodacom', 'Orange', 'Airtel', 'Africell']));
    expect(listOperators(true, 'CD').filter((o: any) => o.name === 'Orange')).toHaveLength(1);
    expect(listGiftProducts(true).some((p: any) => p.brand === 'SNEL' && p.currency === 'CDF')).toBe(true);
  });
});
