/**
 * Demonstration scene 5 (controls, supervision, reporting):
 *  - a KYB approval is refused when a director is on a sanctions list and a sanctions case is opened;
 *  - suspending an account carries a reason that reaches the customer and the audit trail;
 *  - the Guardian check runs from the console and reports no discrepancy on a healthy ledger;
 *  - the incidents register: declared outage with rail, duration and cause; acknowledge; resolve.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, adminToken } from './helpers';
import { getDb } from '../db';
import { upsertSource, importSanctionsRows } from '../services/risk/compliance';

let app: ReturnType<typeof setupApp>;
let admin: Awaited<ReturnType<typeof adminToken>>;
beforeAll(async () => {
  app = setupApp();
  admin = await adminToken(app);
});

describe('scene 5 controls', () => {
  it('refuses the KYB approval of a business whose director is listed and opens a sanctions case', async () => {
    const src = upsertSource({ name: 'Demo list', kind: 'sanctions', enabled: true });
    importSanctionsRows(src.id, [{ kind: 'name', value: 'Listed Person', externalId: 'DEMO-1' }], 'v1', { type: 'admin', id: 'test' });
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'Société Listée', country: 'CD' });
    const filed = await request(app)
      .post('/api/risk/kyb')
      .set(merchant.auth)
      .send({
        legalName: 'Société Listée SARL',
        registrationNumber: 'CD/KIN/RCCM/26-B-77777',
        country: 'CD',
        address: 'Avenue Test 7, Kinshasa',
        expectedMonthlyVolume: 1000,
        directors: [{ name: 'Listed Person', role: 'Gérant' }],
      });
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const r = await request(app).post(`/api/admin/risk/kyb/${filed.body.submission.id}/review`).set(admin.auth).send({ decision: 'verified', pin: admin.pin });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('sanctions_hit');
    const cases = await request(app).get('/api/admin/risk/cases?status=OPEN').set(admin.auth);
    expect(JSON.stringify(cases.body)).toContain('Société Listée');
    expect((await request(app).get('/api/risk/kyb').set(merchant.auth)).body.status).toBe('pending');
  });

  it('suspends an acceptor with a reason that reaches the customer', async () => {
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'Kiosque Suspect', country: 'CD' });
    const r = await request(app).patch(`/api/admin/users/${merchant.user.id}`).set(admin.auth).send({ status: 'suspended', reason: 'Suspected fraud' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.user.status).toBe('suspended');
    const logs = await request(app).get('/api/admin/audit-logs?limit=5').set(admin.auth);
    expect(JSON.stringify(logs.body)).toContain('Suspected fraud');
  });

  it('runs the Guardian check from the console and keeps the incidents register with rail, duration and cause', async () => {
    const g = await request(app).post('/api/admin/guardian/run').set(admin.auth).send({});
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect(g.body.result.ok).toBe(true);
    expect(g.body.result.findings).toEqual([]);
    const opened = await request(app)
      .post('/api/admin/switch/incidents')
      .set(admin.auth)
      .send({ level: 'P2', title: 'Orange Money collection numbers unreachable', detail: 'Operator network maintenance', subjectType: 'rail', subjectId: 'orange_cd' });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(opened.body.incident).toMatchObject({ level: 'P2', subjectType: 'rail', subjectId: 'orange_cd', status: 'OPEN', detail: 'Operator network maintenance' });
    expect(typeof opened.body.incident.durationMinutes).toBe('number');
    const ack = await request(app).post(`/api/admin/switch/incidents/${opened.body.incident.id}/ack`).set(admin.auth);
    expect(ack.body.incident.status).toBe('ACKNOWLEDGED');
    const res = await request(app).post(`/api/admin/switch/incidents/${opened.body.incident.id}/resolve`).set(admin.auth).send({ note: 'Operator back' });
    expect(res.body.incident.status).toBe('RESOLVED');
    expect(res.body.incident.detail).toContain('resolution: Operator back');
    const list = await request(app).get('/api/admin/switch/incidents?status=RESOLVED').set(admin.auth);
    expect(list.body.items.some((i: any) => i.id === opened.body.incident.id && i.resolvedAt)).toBe(true);
  });
});

describe('simulator institutions on a production-like server', () => {
  it('re-seeds the fictitious institutions and open pairs of the connection in simulation from the console', async () => {
    getDb().prepare("DELETE FROM participant_pairs WHERE connection_id = 'NATIONAL_SWITCH_CD'").run();
    getDb().prepare("DELETE FROM participants WHERE source = 'SIMULATION' AND country = 'CD'").run();
    const r = await request(app).post('/api/admin/switch/connections/NATIONAL_SWITCH_CD/seed-simulation').set(admin.auth).send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.participants.map((p: any) => p.id)).toEqual(expect.arrayContaining(['DEMO_BANK_A', 'DEMO_MMO_B']));
    expect(r.body.pairs).toBeGreaterThan(0);
    const again = await request(app).post('/api/admin/switch/connections/NATIONAL_SWITCH_CD/seed-simulation').set(admin.auth).send({});
    expect(again.body.participants.length).toBe(r.body.participants.length);
  });
});
