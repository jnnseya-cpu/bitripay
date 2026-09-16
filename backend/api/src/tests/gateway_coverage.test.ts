/** Deposit / payment gateways → Coverage by country: what serves the DRC rail by rail (direct operators, banks, national switch, keyed APIs). */
import { it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, adminToken } from './helpers';

let app: ReturnType<typeof setupApp>;
let admin: Awaited<ReturnType<typeof adminToken>>;
beforeAll(async () => {
  app = setupApp();
  admin = await adminToken(app);
});

it('lists the DRC operators on the direct rail, the banks, the national switch participants and the keyed APIs in scope', async () => {
  const r = await request(app).get('/api/admin/gateways/coverage?country=cd').set(admin.auth);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.country).toBe('CD');
  const ops = r.body.mobileMoney.operators.map((o: any) => o.id);
  for (const id of ['orange_cd', 'airtel_cd', 'mpesa_cd', 'africell_cd']) expect(ops).toContain(id);
  expect(r.body.mobileMoney.operators.find((o: any) => o.id === 'mpesa_cd').name).toContain('Vodacom');
  expect(r.body.banks.transfer).toBe(true);
  expect(r.body.banks.institutions.map((i: any) => i.name)).toEqual(expect.arrayContaining([expect.stringContaining('Rawbank'), expect.stringContaining('Equity BCDC')]));
  expect(r.body.switch.id).toBe('NATIONAL_SWITCH_CD');
  expect(r.body.switch.simulation).toBe(true);
  expect(r.body.switch.participants.map((p: any) => p.id)).toEqual(expect.arrayContaining(['DEMO_BANK_A', 'DEMO_MMO_B']));
  // the Kenyan M-Pesa API is not in the DRC scope: its currency is KES and its name says so; the sandbox gateway is never listed
  const keyed = r.body.gateways.filter((g: any) => g.keyed);
  expect(keyed.find((g: any) => g.id === 'mpesa').name).toContain('Kenya');
  expect(r.body.gateways.some((g: any) => g.provider === 'sandbox')).toBe(false);
  expect(typeof r.body.aggregatorPerimeter).toBe('boolean');
});
