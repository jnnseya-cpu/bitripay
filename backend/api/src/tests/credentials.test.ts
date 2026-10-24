/**
 * Credential setup from the administrator account.
 *
 * The point of these is the negative assertions. An inventory that leaks a value is worse than no inventory, and a
 * form that erases a key because it posted back the mask it was shown is the kind of defect that takes a payment
 * rail down on a Friday. So: no secret ever appears in a response, the mask round-trips without destroying the
 * stored value, writes need step-up, and the audit record names the credential without naming the secret.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, adminToken } from './helpers';
import { getDb } from '../db';
import { setSetting } from '../services/settings';
import { credential, setCredentials, anthropicKey, CREDENTIAL_MASK } from '../services/credentials';
import { encrypt } from '../lib/crypto';
import { hashPassword } from '../lib/password';

let app: ReturnType<typeof setupApp>;
let admin: Awaited<ReturnType<typeof adminToken>>;
let adminId: string;

beforeAll(async () => {
  app = setupApp();
  admin = await adminToken(app);
  // By e-mail, not by creation order: the platform has a second administrator (the checker) and picking the
  // oldest row silently targeted the wrong account, which is why a PIN this test had just set did not verify.
  adminId = String((getDb().prepare("SELECT id FROM users WHERE email = 'admin@bitripay.local'").get() as any).id);
});
afterAll(() => setSetting('credentials', {}));

describe('credential setup from the admin account', () => {
  it('lists every credential with where it is set and what waits on it, and never a value', async () => {
    const res = await request(app).get('/api/admin/credentials').set(admin.auth);
    expect(res.status).toBe(200);
    const { items, summary } = res.body;
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThan(5);
    for (const i of items) {
      expect(typeof i.set, i.key).toBe('boolean');
      expect(['console', 'environment', 'unset']).toContain(i.source);
      expect(i.gates.length, `${i.key} must say what it gates`).toBeGreaterThan(20);
      expect(['gateways', 'messaging', 'whatsapp', 'settings', 'content-agent', 'credentials']).toContain(i.home);
      // The whole point: no field carries a value.
      expect(Object.keys(i)).not.toContain('value');
    }
    expect(summary.total).toBe(items.length);
    expect(Array.isArray(summary.missingRequired)).toBe(true);
    // E-mail and SMS are named even though another screen owns them, so nothing is invisible.
    expect(items.map((i: any) => i.key)).toEqual(expect.arrayContaining(['smtp', 'sms', 'ai.anthropic', 'push.expoAccessToken']));
  });

  it('stores a secret encrypted and refuses to hand it back', async () => {
    setCredentials({ 'push.expoAccessToken': 'expo-secret-token-value' }, adminId);
    expect(credential('push.expoAccessToken')).toBe('expo-secret-token-value');
    // Encrypted at rest: the plaintext is not in the settings row.
    const row = String((getDb().prepare("SELECT value FROM settings WHERE key = 'credentials'").get() as any).value);
    expect(row).not.toContain('expo-secret-token-value');
    const res = await request(app).get('/api/admin/credentials').set(admin.auth);
    expect(JSON.stringify(res.body)).not.toContain('expo-secret-token-value');
    const item = res.body.items.find((i: any) => i.key === 'push.expoAccessToken');
    expect(item.set).toBe(true);
    expect(item.source).toBe('console');
  });

  it('writing the mask back leaves the stored secret alone, and an empty value clears it', () => {
    setCredentials({ 'push.expoAccessToken': 'original-token' }, adminId);
    const res = setCredentials({ 'push.expoAccessToken': CREDENTIAL_MASK }, adminId);
    expect(res.changed).toEqual([]);
    expect(credential('push.expoAccessToken'), 'the mask must not overwrite a real key').toBe('original-token');
    const cleared = setCredentials({ 'push.expoAccessToken': '' }, adminId);
    expect(cleared.cleared).toEqual(['push.expoAccessToken']);
    expect(credential('push.expoAccessToken')).toBe('');
  });

  it('refuses an unknown credential rather than silently storing it', () => {
    expect(() => setCredentials({ 'nope.whatever': 'x' }, adminId)).toThrow(/Unknown credential/);
  });

  it('needs the settings permission, and records the change by key without the value', async () => {
    const customer = await registerUser(app);
    expect((await request(app).get('/api/admin/credentials').set(customer.auth)).status).toBe(403);

    // Pin the two things step-up depends on rather than inheriting whatever the seed left, so this asserts the
    // control and not the fixture: step-up on (which is the default) and a PIN this test knows.
    setSetting('gateway', { makerChecker: true, adminStepUp: true, intentExpiryHours: 48, evidenceWindowHours: 48, autoConfirmScore: 80, reviewScore: 50, sharedSecretAutoConfirm: false });
    getDb().prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(hashPassword('4321'), adminId);

    // Writing a credential without the administrator's PIN must not land.
    const noPin = await request(app)
      .put('/api/admin/credentials')
      .set(admin.auth)
      .send({ values: { 'push.expoAccessToken': 'audited-token' } });
    expect(noPin.status, JSON.stringify(noPin.body)).toBe(403);
    expect(['invalid_pin', 'step_up_required']).toContain(noPin.body.error.code);

    const res = await request(app)
      .put('/api/admin/credentials')
      .set(admin.auth)
      .send({ values: { 'push.expoAccessToken': 'audited-token' }, pin: '4321' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.changed).toEqual(['push.expoAccessToken']);
    const entry = getDb().prepare("SELECT action, details FROM audit_logs WHERE action = 'credentials.update' ORDER BY created_at DESC LIMIT 1").get() as any;
    expect(entry, 'the write must be audited').toBeTruthy();
    expect(String(entry.details)).toContain('push.expoAccessToken');
    expect(String(entry.details), 'the audit record must not carry the secret').not.toContain('audited-token');
  });

  it('resolves the Anthropic key from every place one has ever been stored, newest first', () => {
    // This is the defect the unified resolver fixed: the content agent's key was invisible to translation and assist
    // settings were invisible to both, because three files each had their own copy of this logic.
    expect(anthropicKey(encrypt('from-assist'), encrypt('from-agent'))).toBe('from-assist');
    expect(anthropicKey(null, encrypt('from-agent'))).toBe('from-agent');
    expect(anthropicKey(null, null)).toBe(process.env.ANTHROPIC_API_KEY || null);
    // A corrupt stored value must not throw in the middle of a request.
    expect(() => anthropicKey('not-encrypted-at-all', null)).not.toThrow();
  });
});
