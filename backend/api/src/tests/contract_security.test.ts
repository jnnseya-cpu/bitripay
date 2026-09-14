/**
 * Security contract: PCI gating of raw card numbers, CVV-less virtual cards, one-time 2FA recovery codes, the 2FA
 * policy per role, KYC documents encrypted at rest, saved remittance recipients as cooling payout destinations,
 * admin-editable notification templates, per-country KYC tier seeds and the 60-second sanctions job.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, adminToken, fund } from './helpers';
import { getDb } from '../db';
import { config } from '../config';
import { encrypt, sha256 } from '../lib/crypto';
import { totpCode } from '../lib/totp';
import { assertRawCardAccepted } from '../services/payments';
import { deriveCvv } from '../services/virtualCards';
import { notify, renderTemplate, listNotificationTemplates } from '../services/notifications';
import { outbox } from '../services/messaging';
import { getSecuritySettings } from '../services/settings';
import { tierLimitsFor } from '../services/risk/kycTiers';
import { screenSanctionsTick } from '../jobs';
import * as intents from '../services/intents';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

const CARD = { number: '4242424242424242', expMonth: 12, expYear: 2030, cvc: '123', holderName: 'A B' };

describe('PCI: raw card numbers only reach the sandbox processor outside production', () => {
  it('refuses a raw PAN for a tokenising processor with raw_card_not_accepted and names the hosted path', async () => {
    const admin = await adminToken(app);
    const gw = await request(app)
      .put('/api/admin/gateways/stripe')
      .set(admin.auth)
      .send({ name: 'Stripe', provider: 'stripe', enabled: true, methods: ['card'], currencies: [], credentials: { secretKey: 'sk_test_x', publishableKey: 'pk_test_x', webhookSecret: 'whsec_x' } });
    expect(gw.status, JSON.stringify(gw.body)).toBe(200);
    const u = await registerUser(app);
    const refused = await request(app).post('/api/deposits').set(u.auth).send({ pin: '1234', method: 'card', gateway: 'stripe', amount: '10.00', currency: 'USD', card: CARD });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body.error.code).toBe('raw_card_not_accepted');
    expect(refused.body.error.message).toMatch(/Stripe Payment Element|hosted/);
    // the sandbox processor keeps accepting test cards in development
    const ok = await request(app).post('/api/deposits').set(u.auth).send({ pin: '1234', method: 'card', gateway: 'sandbox', amount: '10.00', currency: 'USD', card: CARD });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    await request(app).delete('/api/admin/gateways/stripe').set(admin.auth);
  });

  it('refuses a raw PAN even for the sandbox processor once the platform runs in production', () => {
    const sandbox = { provider: 'sandbox', name: 'Sandbox' };
    expect(() => assertRawCardAccepted(sandbox, CARD)).not.toThrow();
    expect(() => assertRawCardAccepted(sandbox, undefined)).not.toThrow();
    const was = config.isProduction;
    config.isProduction = true;
    try {
      expect(() => assertRawCardAccepted(sandbox, CARD)).toThrow(/Raw card numbers are not accepted/);
      expect(() => assertRawCardAccepted({ provider: 'paystack', name: 'Paystack' }, CARD)).toThrow(/Paystack Popup/);
    } finally {
      config.isProduction = was;
    }
  });
});

describe('virtual cards never store a CVV', () => {
  it('issues, reveals and charges a card with a derived CVV, declines a wrong CVV and stores NULL in cvv_encrypted', async () => {
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'CVV Shop' });
    const holder = await registerUser(app);
    await fund(app, holder.user.id, '100.00');
    const card = await request(app).post('/api/virtual-cards').set(holder.auth).send({ currency: 'USD', pin: '1234' });
    expect(card.status, JSON.stringify(card.body)).toBe(201);
    await request(app).post(`/api/virtual-cards/${card.body.card.id}/fund`).set(holder.auth).send({ amount: '60.00', pin: '1234' });
    const row = getDb().prepare('SELECT cvv_encrypted, pan_hash, exp_month, exp_year FROM virtual_cards WHERE id = ?').get(card.body.card.id) as any;
    expect(row.cvv_encrypted).toBeNull();
    const reveal = await request(app).post(`/api/virtual-cards/${card.body.card.id}/reveal`).set(holder.auth).send({ pin: '1234' });
    expect(reveal.body.card.cvv).toMatch(/^\d{3}$/);
    expect(reveal.body.card.cvv).toBe(deriveCvv(row.pan_hash, row.exp_month, row.exp_year));
    const details = { number: reveal.body.card.number, expMonth: reveal.body.card.expMonth, expYear: reveal.body.card.expYear, holderName: 'Card Holder' };
    const link = await request(app).post('/api/payment-requests').set(merchant.auth).send({ kind: 'link', amount: '25.00', currency: 'USD' });
    const wrongCvv = String((Number(reveal.body.card.cvv) + 1) % 1000).padStart(3, '0');
    const declined = await request(app)
      .post(`/api/checkout/${link.body.paymentRequest.code}/pay`)
      .send({ method: 'virtual_card', card: { ...details, cvc: wrongCvv } });
    expect(declined.status).toBe(400);
    expect(declined.body.error.code).toBe('card_declined');
    const paid = await request(app)
      .post(`/api/checkout/${link.body.paymentRequest.code}/pay`)
      .send({ method: 'virtual_card', card: { ...details, cvc: reveal.body.card.cvv } });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.status).toBe('succeeded');
  });

  it('derives a stable three-digit CVV per card and keeps verifying legacy cards with an encrypted CVV', async () => {
    expect(deriveCvv('abc', 12, 2030)).toBe(deriveCvv('abc', 12, 2030));
    expect(deriveCvv('abc', 12, 2030)).not.toBe(deriveCvv('abd', 12, 2030));
    expect(deriveCvv('abc', 1, 2031)).toMatch(/^\d{3}$/);
    const holder = await registerUser(app);
    const card = await request(app).post('/api/virtual-cards').set(holder.auth).send({ currency: 'USD', pin: '1234' });
    // a card issued before migration 027 carries its CVV encrypted; it is still the CVV the holder sees
    getDb().prepare('UPDATE virtual_cards SET cvv_encrypted = ? WHERE id = ?').run(encrypt('917'), card.body.card.id);
    const reveal = await request(app).post(`/api/virtual-cards/${card.body.card.id}/reveal`).set(holder.auth).send({ pin: '1234' });
    expect(reveal.body.card.cvv).toBe('917');
  });
});

async function enableTwoFactor(auth: Record<string, string>) {
  const setup = await request(app).post('/api/account/2fa/setup').set(auth);
  const enable = await request(app)
    .post('/api/account/2fa/enable')
    .set(auth)
    .send({ code: totpCode(setup.body.secret) });
  expect(enable.status, JSON.stringify(enable.body)).toBe(200);
  return { secret: setup.body.secret as string, recoveryCodes: enable.body.recoveryCodes as string[] };
}

describe('2FA recovery codes', () => {
  it('issues 8 one-time codes on enable, stores only their SHA-256, and accepts each unused code once at login', async () => {
    const { auth, user } = await registerUser(app);
    const { recoveryCodes } = await enableTwoFactor(auth);
    expect(recoveryCodes).toHaveLength(8);
    for (const c of recoveryCodes) expect(c).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}$/);
    const rows = getDb().prepare('SELECT code_hash, used_at FROM recovery_codes WHERE user_id = ?').all(user.id) as { code_hash: string; used_at: string | null }[];
    expect(rows).toHaveLength(8);
    expect(rows.map((r) => r.code_hash).sort()).toEqual(recoveryCodes.map(sha256).sort());
    expect(rows.every((r) => r.used_at === null)).toBe(true);
    const remaining = await request(app).get('/api/account/2fa/recovery-codes').set(auth);
    expect(remaining.body).toEqual({ remaining: 8, total: 8 });
    // a recovery code completes the login in place of the authenticator code
    const login = await request(app).post('/api/auth/login').send({ identifier: user.email, password: 'Password123!' });
    expect(login.body.requiresTwoFactor).toBe(true);
    const mfa = { Authorization: `Bearer ${login.body.token}` };
    const done = await request(app).post('/api/auth/2fa/verify').set(mfa).send({ code: recoveryCodes[0].toUpperCase() });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.token).toBeTruthy();
    // ...and never again
    const login2 = await request(app).post('/api/auth/login').send({ identifier: user.email, password: 'Password123!' });
    const reused = await request(app)
      .post('/api/auth/2fa/verify')
      .set({ Authorization: `Bearer ${login2.body.token}` })
      .send({ code: recoveryCodes[0] });
    expect(reused.status).toBe(401);
    expect(reused.body.error.code).toBe('invalid_2fa');
    expect((await request(app).get('/api/account/2fa/recovery-codes').set(auth)).body.remaining).toBe(7);
    const notif = await request(app).get('/api/account/notifications').set(auth);
    const used = notif.body.items.find((n: any) => n.title === 'Recovery code used');
    expect(used).toBeTruthy();
    expect(used.data.loud).toBe(true);
    expect(used.body).toContain('7 codes left');
  });

  it('regenerates a fresh set only with an authenticator code; the previous set stops working', async () => {
    const { auth, user } = await registerUser(app);
    const { secret, recoveryCodes } = await enableTwoFactor(auth);
    const viaRecovery = await request(app).post('/api/account/2fa/recovery-codes/regenerate').set(auth).send({ code: recoveryCodes[1] });
    expect(viaRecovery.status).toBe(400);
    const regen = await request(app)
      .post('/api/account/2fa/recovery-codes/regenerate')
      .set(auth)
      .send({ code: totpCode(secret) });
    expect(regen.status, JSON.stringify(regen.body)).toBe(200);
    expect(regen.body.recoveryCodes).toHaveLength(8);
    expect(regen.body.recoveryCodes).not.toContain(recoveryCodes[0]);
    const login = await request(app).post('/api/auth/login').send({ identifier: user.email, password: 'Password123!' });
    const old = await request(app)
      .post('/api/auth/2fa/verify')
      .set({ Authorization: `Bearer ${login.body.token}` })
      .send({ code: recoveryCodes[2] });
    expect(old.status).toBe(401);
    const fresh = await request(app)
      .post('/api/auth/2fa/verify')
      .set({ Authorization: `Bearer ${login.body.token}` })
      .send({ code: regen.body.recoveryCodes[0] });
    expect(fresh.status).toBe(200);
    // disabling 2FA retires every remaining code
    const off = await request(app)
      .post('/api/account/2fa/disable')
      .set(auth)
      .send({ code: totpCode(secret) });
    expect(off.status).toBe(200);
    expect((await request(app).get('/api/account/2fa/recovery-codes').set(auth)).body.remaining).toBe(0);
  });
});

describe('2FA policy per role', () => {
  it('ships opt-in outside production with a 7-day grace period and exposes the policy to the account', async () => {
    const s = getSecuritySettings();
    expect(s).toEqual({ require2fa: { merchant: false, agent: false, admin: false }, graceDays: 7 });
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'Policy Shop' });
    const policy = await request(app).get('/api/account/2fa/policy').set(merchant.auth);
    expect(policy.body).toEqual({ required: false, deadline: null, overdue: false, enabled: false });
  });

  it('refuses a merchant past the grace period without 2FA with 403 two_factor_required, except the paths needed to enable it', async () => {
    const admin = await adminToken(app);
    const set = await request(app)
      .put('/api/admin/settings/security')
      .set(admin.auth)
      .send({ value: { require2fa: { merchant: true, agent: false, admin: false }, graceDays: 7 } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.value.require2fa.merchant).toBe(true);
    try {
      const merchant = await registerUser(app, { role: 'merchant', businessName: 'Grace Shop' });
      // within the grace period the merchant works normally and sees the deadline
      expect((await request(app).get('/api/wallets').set(merchant.auth)).status).toBe(200);
      const policy = await request(app).get('/api/account/2fa/policy').set(merchant.auth);
      expect(policy.body.required).toBe(true);
      expect(policy.body.overdue).toBe(false);
      expect(policy.body.deadline).toBeTruthy();
      // an account created before the grace period is refused until it enables 2FA
      getDb()
        .prepare('UPDATE users SET created_at = ? WHERE id = ?')
        .run(new Date(Date.now() - 8 * 86_400_000).toISOString(), merchant.user.id);
      const blocked = await request(app).get('/api/wallets').set(merchant.auth);
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('two_factor_required');
      expect((await request(app).post('/api/payment-requests').set(merchant.auth).send({ kind: 'link', amount: '1.00', currency: 'USD' })).status).toBe(403);
      for (const path of ['/api/account/profile', '/api/auth/me', '/api/config', '/api/account/2fa/policy']) expect((await request(app).get(path).set(merchant.auth)).status, path).toBe(200);
      await enableTwoFactor(merchant.auth);
      expect((await request(app).get('/api/wallets').set(merchant.auth)).status).toBe(200);
      expect((await request(app).get('/api/account/2fa/policy').set(merchant.auth)).body.enabled).toBe(true);
      // the same-age account of a role the policy does not name is untouched
      const user = await registerUser(app);
      getDb()
        .prepare('UPDATE users SET created_at = ? WHERE id = ?')
        .run(new Date(Date.now() - 8 * 86_400_000).toISOString(), user.user.id);
      expect((await request(app).get('/api/wallets').set(user.auth)).status).toBe(200);
    } finally {
      await request(app)
        .put('/api/admin/settings/security')
        .set(admin.auth)
        .send({ value: { require2fa: { merchant: false, agent: false, admin: false }, graceDays: 7 } });
    }
  });
});

describe('KYC documents are encrypted at rest', () => {
  const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  it('stores no readable image in the row and hands the decrypted documents to the admin review', async () => {
    const admin = await adminToken(app);
    const u = await registerUser(app);
    const sub = await request(app).post('/api/kyc').set(u.auth).send({ docType: 'passport', docNumber: 'P-777', fullName: u.user.fullName, docFront: IMAGE, selfie: IMAGE });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    expect(sub.body.submission.hasDocFront).toBe(true);
    expect(sub.body.submission.documentsEncrypted).toBe(true);
    const row = getDb().prepare('SELECT doc_front, selfie, doc_back, documents_encrypted FROM kyc_submissions WHERE id = ?').get(sub.body.submission.id) as any;
    expect(row.documents_encrypted).toBe(1);
    expect(row.doc_front).not.toContain('base64');
    expect(row.doc_front).not.toContain('iVBORw0KGgo');
    expect(row.doc_front).not.toBe(IMAGE);
    expect(row.doc_back).toBeNull();
    const review = await request(app).get(`/api/admin/kyc/${sub.body.submission.id}`).set(admin.auth);
    expect(review.status).toBe(200);
    expect(review.body.submission.docFront).toBe(IMAGE);
    expect(review.body.submission.selfie).toBe(IMAGE);
    expect(review.body.submission.docBack).toBeNull();
  });

  it('keeps reading submissions written in plaintext before migration 027', async () => {
    const admin = await adminToken(app);
    const u = await registerUser(app);
    const id = 'kyc_legacy_plain';
    getDb()
      .prepare(
        "INSERT INTO kyc_submissions (id, user_id, doc_type, doc_number, full_name, doc_front, selfie, status, created_at, documents_encrypted) VALUES (?, ?, 'national_id', 'L-1', ?, ?, ?, 'pending', ?, 0)",
      )
      .run(id, u.user.id, u.user.fullName, IMAGE, IMAGE, new Date().toISOString());
    const review = await request(app).get(`/api/admin/kyc/${id}`).set(admin.auth);
    expect(review.status).toBe(200);
    expect(review.body.submission.documentsEncrypted).toBe(false);
    expect(review.body.submission.docFront).toBe(IMAGE);
  });
});

describe('saved remittance recipients are payout destinations', () => {
  it('records a saved beneficiary as a cooling destination change; small remittances pass, large ones wait for the cooling-off or an approval', async () => {
    const admin = await adminToken(app);
    const sender = await registerUser(app);
    const family = await registerUser(app, { tag: 'sec_family' });
    await fund(app, sender.user.id, '300.00');
    await request(app)
      .put('/api/admin/settings/risk')
      .set(admin.auth)
      .send({ value: { coolingOffMinutes: 0 } });
    await request(app)
      .put('/api/admin/settings/accountProtection')
      .set(admin.auth)
      .send({ value: { coolingAmountBase: 1_000, coolingOffHours: 24 } });
    try {
      const saved = await request(app).post('/api/recipients').set(sender.auth).send({ name: 'Family', tag: family.user.tag, payoutMethod: 'wallet', currency: 'USD', pin: '1234' });
      expect(saved.status, JSON.stringify(saved.body)).toBe(201);
      const changes = await request(app).get('/api/risk/destination-changes').set(sender.auth);
      const change = changes.body.items.find((c: any) => c.kind === 'remittance_recipient');
      expect(change).toBeTruthy();
      expect(change.status).toBe('COOLING');
      expect(change.refId).toBe(saved.body.recipient.id);
      expect(change.next.tag).toBe(family.user.tag);
      const notif = await request(app).get('/api/account/notifications').set(sender.auth);
      expect(notif.body.items.some((n: any) => n.title === 'Payout destination changed' && n.body.includes('recipient Family'))).toBe(true);
      const send = (amount: string) =>
        request(app)
          .post('/api/remittances')
          .set(sender.auth)
          .send({
            amount,
            sourceCurrency: 'USD',
            targetCurrency: 'USD',
            payoutMethod: 'wallet',
            recipient: { name: 'Family', tag: family.user.tag },
            savedRecipientId: saved.body.recipient.id,
            pin: '1234',
          });
      const small = await send('5.00');
      expect(small.status, JSON.stringify(small.body)).toBe(201);
      const big = await send('40.00');
      expect(big.status, JSON.stringify(big.body)).toBe(403);
      expect(big.body.error.code).toBe('destination_cooling');
      // the same beneficiary sent ad hoc (without the saved id) is matched by tag and cools off as well
      const adHoc = await request(app)
        .post('/api/remittances')
        .set(sender.auth)
        .send({ amount: '40.00', sourceCurrency: 'USD', targetCurrency: 'USD', payoutMethod: 'wallet', recipient: { name: 'Family', tag: family.user.tag }, pin: '1234' });
      expect(adHoc.status).toBe(403);
      const approved = await request(app).post(`/api/admin/risk/destination-changes/${change.id}/approve`).set(admin.auth);
      expect(approved.body.status).toBe('APPROVED');
      expect((await send('40.00')).status).toBe(201);
    } finally {
      await request(app)
        .put('/api/admin/settings/risk')
        .set(admin.auth)
        .send({ value: { coolingOffMinutes: 60 } });
      await request(app)
        .put('/api/admin/settings/accountProtection')
        .set(admin.auth)
        .send({ value: { coolingAmountBase: null } });
    }
  });
});

describe('notification templates', () => {
  it('seeds at least 12 defaults, lets an administrator edit and preview them, and falls back to English for other languages', async () => {
    const admin = await adminToken(app);
    const list = await request(app).get('/api/admin/messaging/templates').set(admin.auth);
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThanOrEqual(12);
    expect(list.body.channels).toEqual(['sms', 'whatsapp', 'email', 'push']);
    expect(list.body.events.some((e: any) => e.key === 'otp' && e.placeholders.includes('code'))).toBe(true);
    const rows = getDb().prepare('SELECT key, channel, lang, subject, body, updated_by, updated_at FROM notification_templates').all() as any[];
    expect(rows.length).toBe(list.body.items.length);
    expect(rows.every((r) => r.lang === 'en' && r.updated_by === null && r.updated_at)).toBe(true);
    // edit the French welcome push; English stays and Swahili falls back to English
    const put = await request(app)
      .put('/api/admin/messaging/templates')
      .set(admin.auth)
      .send({ key: 'welcome', channel: 'push', lang: 'fr', subject: 'Bienvenue sur {{appName}} !', body: 'Bonjour {{name}}, votre portefeuille est prêt.' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.template.updatedBy).toEqual(expect.any(String));
    expect(put.body.template.isDefault).toBe(false);
    expect(renderTemplate('welcome', 'push', 'fr', { name: 'Amina' })).toEqual({ subject: 'Bienvenue sur BitriPay !', body: 'Bonjour Amina, votre portefeuille est prêt.' });
    expect(renderTemplate('welcome', 'push', 'sw', { name: 'Amina' })).toEqual({ subject: 'Welcome to BitriPay!', body: 'Your wallet is ready. Add money to get started.' });
    expect(renderTemplate('no.such.event', 'push', 'en', {})).toBeNull();
    const preview = await request(app).post('/api/admin/messaging/templates/preview').set(admin.auth).send({ key: 'otp', channel: 'sms', body: 'Code {{code}} ({{minutes}} min) – {{unknown}}' });
    expect(preview.body.rendered.body).toBe('Code 482913 (10 min) – ');
    const stored = await request(app).post('/api/admin/messaging/templates/preview').set(admin.auth).send({ key: 'welcome', channel: 'push', lang: 'fr' });
    expect(stored.body.rendered.body).toBe('Bonjour Amina, votre portefeuille est prêt.');
    const unknown = await request(app).put('/api/admin/messaging/templates').set(admin.auth).send({ key: 'made.up', channel: 'push', body: 'x' });
    expect(unknown.status).toBe(400);
    const reset = await request(app).put('/api/admin/messaging/templates').set(admin.auth).send({ key: 'welcome', channel: 'push', lang: 'en', reset: true });
    expect(reset.body.template.isDefault).toBe(true);
    expect(
      listNotificationTemplates({ key: 'welcome', channel: 'push' })
        .map((t) => t.lang)
        .sort(),
    ).toEqual(['en', 'fr']);
  });

  it('sends the OTP SMS and the in-app welcome through the edited templates', async () => {
    const admin = await adminToken(app);
    await request(app).put('/api/admin/messaging/templates').set(admin.auth).send({ key: 'otp', channel: 'sms', lang: 'en', body: '{{appName}} code: {{code}} (valid {{minutes}} min)' });
    const phone = '+15559876543';
    const otp = await request(app).post('/api/auth/otp/request').send({ identifier: phone, purpose: 'register' });
    expect(otp.status).toBe(200);
    const sms = [...outbox].reverse().find((m) => m.channel === 'sms' && m.to === phone);
    expect(sms?.body).toBe(`BitriPay code: ${otp.body.devCode} (valid 10 min)`);
    await request(app).put('/api/admin/messaging/templates').set(admin.auth).send({ key: 'otp', channel: 'sms', lang: 'en', reset: true });
    await request(app)
      .put('/api/admin/messaging/templates')
      .set(admin.auth)
      .send({ key: 'welcome', channel: 'push', lang: 'en', subject: 'Karibu {{name}}', body: 'Templated welcome from {{appName}}.' });
    try {
      const u = await registerUser(app);
      const notif = await request(app).get('/api/account/notifications').set(u.auth);
      const welcome = notif.body.items.find((n: any) => n.data.kind === 'welcome');
      expect(welcome.title).toBe(`Karibu ${u.user.fullName}`);
      expect(welcome.body).toBe('Templated welcome from BitriPay.');
      expect(welcome.data.template).toBeUndefined();
    } finally {
      await request(app).put('/api/admin/messaging/templates').set(admin.auth).send({ key: 'welcome', channel: 'push', lang: 'en', reset: true });
    }
  });

  it('marks loud kinds loud in the stored payload and everything else quiet', async () => {
    const u = await registerUser(app);
    const loudId = notify(u.user.id, 'Payment received', 'Someone paid you', { kind: 'payment_received' });
    const quietId = notify(u.user.id, 'Identity verified', 'Approved', { kind: 'kyc' });
    const explicit = notify(u.user.id, 'Heads up', 'Quiet kind, loud on purpose', { kind: 'kyc', loud: true });
    const read = (id: string) => JSON.parse((getDb().prepare('SELECT data FROM notifications WHERE id = ?').get(id) as any).data);
    expect(read(loudId).loud).toBe(true);
    expect(read(quietId).loud).toBe(false);
    expect(read(explicit).loud).toBe(true);
    const items = (await request(app).get('/api/account/notifications').set(u.auth)).body.items;
    expect(items.find((n: any) => n.id === loudId).data.loud).toBe(true);
    expect(items.find((n: any) => n.id === quietId).data.loud).toBe(false);
  });
});

describe('per-country KYC tier seeds', () => {
  it('seeds CD, KE, NG, GH, SN, UG, GB, FR and US per tier and enforces the DRC tier-1 per-transaction limit while the UK tier-1 limit differs', async () => {
    const admin = await adminToken(app);
    const tiers = await request(app).get('/api/admin/risk/kyc/tiers').set(admin.auth);
    for (const cc of ['CD', 'KE', 'NG', 'GH', 'SN', 'UG', 'GB', 'FR', 'US']) {
      for (const tier of ['1', '2', '3']) expect(tiers.body.settings.countries[cc][tier].perTransaction, `${cc} tier ${tier}`).toBeGreaterThan(0);
      expect(tiers.body.settings.countries[cc]['4']).toBeNull();
      expect(tiers.body.settings.balanceCaps.countries[cc]['1']).toBeGreaterThan(0);
    }
    expect(tierLimitsFor({ kyc_tier: 1, country: 'CD' })).toEqual({ perTransaction: 5_000, daily: 5_000, monthly: 20_000 });
    expect(tierLimitsFor({ kyc_tier: 1, country: 'GB' })).toEqual({ perTransaction: 25_000, daily: 25_000, monthly: 30_000 });
    expect(tierLimitsFor({ kyc_tier: 1, country: 'GB' })).not.toEqual(tierLimitsFor({ kyc_tier: 1, country: 'CD' }));
    const peer = await registerUser(app);
    const cd = await registerUser(app, { country: 'CD' });
    const gb = await registerUser(app, { country: 'GB' });
    await fund(app, cd.user.id, '200.00');
    await fund(app, gb.user.id, '400.00');
    for (const u of [cd, gb]) {
      const set = await request(app).put(`/api/admin/risk/kyc/users/${u.user.id}/tier`).set(admin.auth).send({ tier: 1, reason: 'seed test' });
      expect(set.status, JSON.stringify(set.body)).toBe(200);
    }
    const over = await request(app).post('/api/transfers').set(cd.auth).send({ to: peer.user.tag, amount: '60.00', currency: 'USD', pin: '1234' });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('kyc_tier_limit');
    expect((await request(app).post('/api/transfers').set(cd.auth).send({ to: peer.user.tag, amount: '30.00', currency: 'USD', pin: '1234' })).status).toBe(201);
    // the same amount is fine for a UK tier-1 account (£250-equivalent schedule), which is refused only above its own limit
    expect((await request(app).post('/api/transfers').set(gb.auth).send({ to: peer.user.tag, amount: '60.00', currency: 'USD', pin: '1234' })).status).toBe(201);
    const gbOver = await request(app).post('/api/transfers').set(gb.auth).send({ to: peer.user.tag, amount: '300.00', currency: 'USD', pin: '1234' });
    expect(gbOver.status).toBe(422);
    expect(gbOver.body.error.code).toBe('kyc_tier_limit');
  });
});

describe('60-second sanctions job', () => {
  it('calls screenPendingSanctions when the intents service exports it and reports the counts', async () => {
    expect(typeof intents.screenPendingSanctions).toBe('function');
    const result = await screenSanctionsTick();
    expect(result).toEqual({ screened: expect.any(Number), hits: expect.any(Number) });
  });
});
