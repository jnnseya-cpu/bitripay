/**
 * Go-live profile: the launch records applied from one JSON document, idempotently, on behalf of an administrator;
 * the human-only steps (PINs, 2FA, reserve clearing, Go live, device enrolment) are reported, never performed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { setupApp, adminToken } from './helpers';
import { applyGoLiveProfileDocument } from '../services/goLiveProfile';
import { findUserByEmail } from '../services/users';
import { config } from '../config';
import { getGateway } from '../payments';
import { listCurrencies } from '../services/currencies';
import { listOperators } from '../services/momo';
import { listProgrammes } from '../services/emoney';
import { listPayoutAccounts } from '../services/liquidity';
import { listCorridors } from '../services/corridors';
import { getSmtpSettings } from '../services/messaging';
import { goLiveChecklist } from '../services/goLive';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});
const example = () => JSON.parse(readFileSync(path.resolve(__dirname, '../../../../deploy/go-live.profile.example.json'), 'utf8'));

describe('go-live profile', () => {
  it('applies every section from the example file, idempotently, and reports what stays human', () => {
    const admin = findUserByEmail(config.admin.email)!;
    const first = applyGoLiveProfileDocument(example(), admin);
    const by = (section: string) => first.lines.filter((l) => l.section === section);
    expect(by('bankTransfer')[0].action).toBe('created');
    expect(getGateway('manual_bank')!.configuredKeys).toContain('accountNumber');
    expect(listCurrencies(false).find((c) => c.code === 'CDF')!.enabled).toBe(true);
    expect(listCurrencies(false).find((c) => c.code === 'INR')!.enabled).toBe(false);
    expect(listOperators({ onlyDirect: true }).map((o) => o.id)).toEqual(expect.arrayContaining(['orange_cd', 'mpesa_cd']));
    const usd = listProgrammes().find((p) => p.currency === 'USD' && p.jurisdiction === 'CD')!;
    expect(usd.readiness.ready).toBe(true);
    expect(usd.issuerModel).toBe('partner_issuer');
    const account = listPayoutAccounts().find((a) => a.label === 'Orange Money Kinshasa SIM 1')!;
    expect(account.currency).toBe('CDF');
    expect(account.balance).toBe(0);
    const corridor = listCorridors().find((c) => c.sourceCurrency === 'GBP' && c.destCountry === 'CD' && c.operatorId === 'orange_cd')!;
    expect(corridor.status).toBe('sandbox');
    expect(corridor.readiness.missing).toEqual([]);
    expect(corridor.compliance.licenceNumber).toBe('000000');
    const approver = findUserByEmail('approver@bitripay.com')!;
    expect(approver.role).toBe('admin');
    expect(JSON.parse((approver as any).permissions)).toContain('issuance');
    expect(first.generatedPasswords).toEqual([{ email: 'approver@bitripay.com', password: expect.any(String) }]);
    expect(getSmtpSettings().host).toBe('smtp.example.com');
    expect(first.remaining.join('\n')).toMatch(/approver@bitripay.com: sign in, set up two-factor/);
    expect(first.remaining.join('\n')).toMatch(/Corridor GBP→CD: press Go live/);
    expect(first.remaining.join('\n')).toMatch(/reserve funding/);
    expect(first.remaining.join('\n')).toMatch(/prefund the float/);

    // second run: nothing is duplicated, nothing new is created
    const second = applyGoLiveProfileDocument(example(), admin);
    expect(second.lines.filter((l) => l.action === 'created')).toEqual([]);
    expect(second.generatedPasswords).toEqual([]);
    expect(listPayoutAccounts().filter((a) => a.label === 'Orange Money Kinshasa SIM 1')).toHaveLength(1);
    expect(listCorridors().filter((c) => c.sourceCurrency === 'GBP' && c.destCountry === 'CD')).toHaveLength(1);

    // the checklist reflects the records; the corridor still waits for the human Go live with a PIN
    const items = goLiveChecklist().items;
    expect(items.find((i) => i.id === 'digital_rail')!.detail).toMatch(/2 collection numbers/);
    expect(items.find((i) => i.id === 'corridor_live')!.ok).toBe(false);
    expect(items.find((i) => i.id === 'emoney_issuer')!.detail).toMatch(/USD\/CD: partner_issuer/);
  });

  it('is applied from the console under step-up and rejects an invalid document', async () => {
    const admin = await adminToken(app);
    const bad = await request(app)
      .post('/api/admin/go-live/profile')
      .set(admin.auth)
      .send({ profile: { corridors: [{ sourceCurrency: 'GBP' }] }, pin: admin.pin });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('go_live_profile_invalid');
    const noPin = await request(app)
      .post('/api/admin/go-live/profile')
      .set(admin.auth)
      .send({ profile: { smtp: { host: 'mail.bitripay.com', from: 'BitriPay <no-reply@bitripay.com>' } } });
    expect(noPin.status).toBeGreaterThanOrEqual(400);
    const ok = await request(app)
      .post('/api/admin/go-live/profile')
      .set(admin.auth)
      .send({ profile: JSON.stringify({ smtp: { host: 'mail.bitripay.com', from: 'BitriPay <no-reply@bitripay.com>' }, currencies: { enable: ['CDF'] } }), pin: admin.pin });
    expect(ok.status).toBe(200);
    expect(ok.body.lines.find((l: any) => l.section === 'smtp').subject).toBe('mail.bitripay.com:587');
    expect(ok.body.checklist.items.some((i: any) => i.id === 'smtp' && i.ok)).toBe(true);
  });
});
