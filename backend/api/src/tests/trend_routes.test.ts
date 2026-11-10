/**
 * The console API, end to end over HTTP.
 *
 * The service tests prove the pipeline; these prove the controls an administrator actually meets. The module switch
 * has to close the whole surface, approving a brief has to require a second administrator under step-up and has to
 * bind to the payload hash the console was shown, and the claim registry has to sit behind `compliance` rather than
 * behind whoever can edit content — because what this platform asserts about itself is not a marketing decision.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import request from 'supertest';
import { setupApp, adminToken } from './helpers';
import { setSetting } from '../services/settings';
import { DEFAULT_MODULES } from '../services/modules';

let app: ReturnType<typeof setupApp>;
let admin: Awaited<ReturnType<typeof adminToken>>;
/** A second administrator who holds `cms`: approving a growth brief is a content act, under four eyes. */
let approver: { auth: Record<string, string>; pin: string; email: string };

const on = () => setSetting('modules', { ...DEFAULT_MODULES, trendIntelligence: true });

beforeAll(async () => {
  app = setupApp();
  admin = await adminToken(app);
  on();

  const email = 'brief.approver@bitripay.local';
  const created = await request(app)
    .post('/api/admin/users')
    .set(admin.auth)
    .send({ fullName: 'Brief Approver', email, password: 'Approver123!', role: 'admin', permissions: ['cms'] });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ identifier: email, password: 'Approver123!' });
  const auth = { Authorization: `Bearer ${login.body.token}` };
  await request(app).post('/api/account/pin').set(auth).send({ pin: '3333' });
  approver = { auth, pin: '3333', email };
});
afterEach(on);

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const INTENT = 'ouvrir un compte marchand';

/** Register a family and send it a history through the API, exactly as an operator or an importer would. */
async function seedFamily(id: string, family: string, history: number[], current: number) {
  const src = await request(app).post('/api/admin/trend/sources').set(admin.auth).send({ id, name: id, family, accessPath: 'first_party', quality: 90, staleAfterHours: 48 });
  expect(src.status, JSON.stringify(src.body)).toBe(201);
  const items = [...history, current].map((value, i) => ({
    sourceId: id,
    sourceRecordId: `${id}-${i}`,
    observedAt: hoursAgo((history.length - i) * 24 + 1),
    windowStart: hoursAgo((history.length - i) * 24 + 25),
    windowEnd: hoursAgo((history.length - i) * 24 + 1),
    term: INTENT,
    metric: 'searches',
    value,
    market: 'CD',
  }));
  const res = await request(app).post('/api/admin/trend/observations').set(admin.auth).send({ items });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

/** A topic scored into the brief band, through the routes. */
async function eligible() {
  await seedFamily('src_fp', 'first_party', [20, 21, 20, 19, 20, 21], 80);
  await seedFamily('src_crm', 'crm', [20, 20, 21, 20, 20, 19], 85);
  const topic = await request(app)
    .post('/api/admin/trend/topics')
    .set(admin.auth)
    .send({ label: INTENT, market: 'CD', locale: 'fr-CD', terms: [INTENT] });
  expect(topic.status, JSON.stringify(topic.body)).toBe(201);
  const snap = await request(app).post(`/api/admin/trend/topics/${topic.body.topic.id}/snapshot`).set(admin.auth).send({ fit: 95, commercialIntent: 85, timing: 90, readiness: 80 });
  expect(snap.status, JSON.stringify(snap.body)).toBe(201);
  expect(snap.body.snapshot.band).toBe('brief');
  return { topicId: topic.body.topic.id, opportunityId: snap.body.snapshot.id };
}

const proposeBody = (ids: { topicId: string; opportunityId: string }, over: Record<string, unknown> = {}) => ({
  ...ids,
  market: 'CD',
  locale: 'fr-CD',
  audience: 'Commerçantes de marché à Kinshasa',
  intent: INTENT,
  objective: 'comptes marchands ouverts par session éligible',
  allowedChannels: ['seo', 'content'],
  ...over,
});

describe('the trend console API', () => {
  it('closes the entire surface when the module is switched off', async () => {
    setSetting('modules', { ...DEFAULT_MODULES, trendIntelligence: false });
    for (const [method, path] of [
      ['get', '/api/admin/trend/overview'],
      ['get', '/api/admin/trend/sources'],
      ['get', '/api/admin/trend/opportunities'],
      ['get', '/api/admin/trend/briefs'],
      ['post', '/api/admin/trend/sources'],
      ['post', '/api/admin/trend/observations'],
      ['post', '/api/admin/trend/briefs'],
    ] as const) {
      const res = await request(app)[method](path).set(admin.auth).send({});
      expect(res.status, `${method} ${path}: ${JSON.stringify(res.body)}`).toBe(422);
      expect(res.body.error.code).toBe('module_disabled');
      expect(res.body.error.details.module).toBe('trendIntelligence');
    }
  });

  it('reports per record on ingestion rather than failing the whole batch', async () => {
    await seedFamily('src_batch', 'first_party', [10, 11], 12);
    const base = { observedAt: hoursAgo(2), windowStart: hoursAgo(26), windowEnd: hoursAgo(2), term: 'x', metric: 'searches', value: 5, market: 'CD' };
    const res = await request(app)
      .post('/api/admin/trend/observations')
      .set(admin.auth)
      .send({
        items: [
          { ...base, sourceId: 'src_batch', sourceRecordId: 'ok-1' },
          { ...base, sourceId: 'src_missing', sourceRecordId: 'no-1' },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.accepted).toBe(1);
    expect(res.body.rejected).toEqual([{ index: 1, reason: expect.stringContaining('unregistered source') }]);
  });

  it('requires a second administrator, a PIN and the displayed hash to approve a brief', async () => {
    const ids = await eligible();
    const draft = await request(app).post('/api/admin/trend/briefs').set(admin.auth).send(proposeBody(ids));
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const id = draft.body.brief.id;

    const listed = await request(app).get('/api/admin/trend/briefs').set(admin.auth);
    const shown = listed.body.data.find((b: any) => b.id === id);
    expect(shown.payloadHash).toHaveLength(64);

    // A draft steers nothing.
    const before = await request(app).get('/api/admin/trend/briefs/effective?market=CD&channel=seo').set(admin.auth);
    expect(before.body.brief).toBeNull();

    // No PIN: step-up refuses before anything else is considered.
    const noPin = await request(app).post(`/api/admin/trend/briefs/${id}/approve`).set(approver.auth).send({ payloadHash: shown.payloadHash });
    expect(noPin.status, JSON.stringify(noPin.body)).toBe(403);
    expect(noPin.body.error.code).toBe('invalid_pin');

    // The maker cannot approve their own brief, even with their own PIN accepted.
    const self = await request(app).post(`/api/admin/trend/briefs/${id}/approve`).set(admin.auth).send({ payloadHash: shown.payloadHash, pin: admin.pin });
    expect(self.status, JSON.stringify(self.body)).toBe(403);
    expect(self.body.error.code, 'self-approval must be refused as self-approval, not as a bad PIN').toBe('self_approval');

    // A stale hash is refused: an approval covers the exact payload its approver read.
    const stale = await request(app)
      .post(`/api/admin/trend/briefs/${id}/approve`)
      .set(approver.auth)
      .send({ payloadHash: 'f'.repeat(64), pin: approver.pin });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('payload_hash_conflict');

    const ok = await request(app).post(`/api/admin/trend/briefs/${id}/approve`).set(approver.auth).send({ payloadHash: shown.payloadHash, pin: approver.pin });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.brief.status).toBe('approved');

    const after = await request(app).get('/api/admin/trend/briefs/effective?market=CD&channel=seo').set(admin.auth);
    expect(after.body.brief.briefId).toBe(id);

    // And the overview says the content agent is now steered by it.
    const overview = await request(app).get('/api/admin/trend/overview').set(admin.auth);
    expect(overview.body.steering.source).toBe('brief');
    expect(overview.body.steering.briefId).toBe(id);

    // Revoking stops it, under step-up, and the agent returns to its backlog.
    const revoked = await request(app).post(`/api/admin/trend/briefs/${id}/revoke`).set(admin.auth).send({ reason: 'claim withdrawn', pin: admin.pin });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    const gone = await request(app).get('/api/admin/trend/briefs/effective?market=CD&channel=seo').set(admin.auth);
    expect(gone.body.brief).toBeNull();
    expect((await request(app).get('/api/admin/trend/overview').set(admin.auth)).body.steering.source).toBe('backlog');
  });

  it('refuses a brief on a snapshot the scorer did not put in the brief band', async () => {
    await seedFamily('src_weak', 'public_feed', [20, 20, 20, 20, 20, 20], 21);
    const topic = await request(app)
      .post('/api/admin/trend/topics')
      .set(admin.auth)
      .send({ label: 'sujet faible', market: 'CD', terms: [INTENT] });
    const snap = await request(app).post(`/api/admin/trend/topics/${topic.body.topic.id}/snapshot`).set(admin.auth).send({ fit: 30, commercialIntent: 30, timing: 30, readiness: 30 });
    expect(snap.body.snapshot.band).not.toBe('brief');
    const res = await request(app)
      .post('/api/admin/trend/briefs')
      .set(admin.auth)
      .send(proposeBody({ topicId: topic.body.topic.id, opportunityId: snap.body.snapshot.id }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('not_eligible');
  });

  it('records a source the platform cannot reach as unavailable with its reason, and never asks for a key', async () => {
    await request(app).post('/api/admin/trend/sources').set(admin.auth).send({ id: 'src_locked', name: 'locked feed', family: 'public_feed', accessPath: 'public_keyless' });
    const res = await request(app).post('/api/admin/trend/sources/src_locked/unavailable').set(admin.auth).send({ reason: 'needs a credential this platform does not hold' });
    expect(res.status).toBe(200);
    expect(res.body.source.enabled).toBe(0);
    expect(res.body.source.unavailable_reason).toContain('credential');
    const sources = await request(app).get('/api/admin/trend/sources').set(admin.auth);
    expect(JSON.stringify(sources.body)).not.toMatch(/apiKey|api_key|token/i);
  });

  it('keeps the claim registry behind compliance, not behind content', async () => {
    const limited = await request(app)
      .post('/api/admin/users')
      .set(admin.auth)
      .send({ fullName: 'Content Editor', email: `editor${Date.now()}@bitripay.local`, password: 'Editor123!', role: 'admin', permissions: ['cms'] });
    expect(limited.status, JSON.stringify(limited.body)).toBe(201);
    const login = await request(app).post('/api/auth/login').send({ identifier: limited.body.user.email, password: 'Editor123!' });
    const editor = { Authorization: `Bearer ${login.body.token}` };

    // The editor can read opportunities and propose, but cannot register what the platform asserts.
    expect((await request(app).get('/api/admin/trend/opportunities').set(editor)).status).toBe(200);
    const claim = await request(app).post('/api/admin/trend/claims').set(editor).send({ code: 'fee_shown', text: 'Fees are shown before every payment.' });
    expect(claim.status).toBe(403);

    const allowed = await request(app)
      .post('/api/admin/trend/claims')
      .set(admin.auth)
      .send({ code: 'fee_shown', text: 'Fees are shown before every payment.', evidence: 'The fee line is rendered on every confirmation screen.' });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    expect(allowed.body.claim.revision).toBe(1);
  });

  it('refuses a brief citing a claim the platform does not hold', async () => {
    const ids = await eligible();
    const res = await request(app)
      .post('/api/admin/trend/briefs')
      .set(admin.auth)
      .send(proposeBody(ids, { approvedClaimIds: ['claim_nope'] }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('unknown_claim');
  });
});
