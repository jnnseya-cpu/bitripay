/**
 * Phase 6 — risk, compliance and agents: the versioned policy engine, fraud scoring with step-up / review / block
 * bands and BP error codes, compliance cases with SAR drafts and four-eyes closure, the ledger-level sanctions
 * guard, KYC tiers with per-country limits, KYB, settlement-destination change protection, sanctions list sources,
 * the AML monitor, and agent float forecasts, trust scores, dynamic commissions, float requests and onboarding.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, adminToken, checkerToken, fund } from './helpers';
import { getDb } from '../db';
import { issueStepUpToken } from '../services/webauthn';
import { findUserById } from '../services/users';
import { runAmlScan } from '../services/risk/compliance';
import { computeTrustScore } from '../services/risk/agentIntel';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});
const balanceOf = async (auth: Record<string, string>, currency = 'USD') => ((await request(app).get('/api/wallets').set(auth)).body.items.find((w: any) => w.currency === currency)?.balance ?? 0) as number;
const setFraud = async (admin: Awaited<ReturnType<typeof adminToken>>, body: Record<string, unknown>) => {
  const r = await request(app).put('/api/admin/risk/fraud/settings').set(admin.auth).send(body);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};

describe('policy engine and fraud bands', () => {
  it('seeds the default bands, explains every decision, and only activates a policy approved by someone other than its author', async () => {
    const admin = await adminToken(app);
    const checker = await checkerToken(app);
    const list = await request(app).get('/api/admin/risk/policies').set(admin.auth);
    expect(list.status).toBe(200);
    expect(list.body.items[0].status).toBe('ACTIVE');
    expect(list.body.items[0].rules.map((r: any) => r.id)).toEqual(['SAN-001', 'BEN-001', 'FRD-004', 'FRD-003', 'FRD-002', 'FRD-001']);
    const sim = await request(app).post('/api/admin/risk/policies/simulate').set(admin.auth).send({ kind: 'transfer', baseMinor: 1000, score: 45 });
    expect(sim.body.action).toBe('step_up');
    expect(sim.body.rule.id).toBe('FRD-002');
    const sanctioned = await request(app).post('/api/admin/risk/policies/simulate').set(admin.auth).send({ kind: 'transfer', baseMinor: 1000, score: 0, flags: ['sanctions:name:X'] });
    expect(sanctioned.body.action).toBe('block');
    expect(sanctioned.body.rule.id).toBe('SAN-001');
    const bad = await request(app).post('/api/admin/risk/policies').set(admin.auth).send({ name: 'No allow', rules: [{ id: 'FRD-001', description: 'block all', when: { minScore: 0 }, action: 'block', reason: 'x' }] });
    expect(bad.status).toBe(400);
    const draft = await request(app).post('/api/admin/risk/policies').set(admin.auth).send({ name: 'Stricter', rules: [{ id: 'SAN-001', description: 'sanctions', when: { flags: ['sanctions:'] }, action: 'block', reason: 'sanctions_hit' }, { id: 'FRD-002', description: 'score 70+', when: { minScore: 70 }, action: 'block', reason: 'fraud_block' }, { id: 'FRD-001', description: 'rest', when: { maxScore: 69 }, action: 'allow', reason: 'clear' }] });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body.version).toBe(2);
    expect((await request(app).post(`/api/admin/risk/policies/${draft.body.id}/approve`).set(admin.auth)).status).toBe(409);
    expect((await request(app).post(`/api/admin/risk/policies/${draft.body.id}/activate`).set(admin.auth)).status).toBe(409);
    expect((await request(app).post(`/api/admin/risk/policies/${draft.body.id}/approve`).set(checker.auth)).body.status).toBe('APPROVED');
    const active = await request(app).post(`/api/admin/risk/policies/${draft.body.id}/activate`).set(admin.auth);
    expect(active.body.status).toBe('ACTIVE');
    const after = await request(app).get('/api/admin/risk/policies').set(admin.auth);
    expect(after.body.active).toBe(draft.body.id);
    expect(after.body.items.find((p: any) => p.version === 1).status).toBe('RETIRED');
    expect((await request(app).post('/api/admin/risk/policies/simulate').set(admin.auth).send({ kind: 'transfer', baseMinor: 1000, score: 75 })).body.action).toBe('block');
    // put the default bands back for the rest of the file
    const back = await request(app).post('/api/admin/risk/policies').set(admin.auth).send({ name: 'Default bands', rules: list.body.items[0].rules });
    await request(app).post(`/api/admin/risk/policies/${back.body.id}/approve`).set(checker.auth);
    await request(app).post(`/api/admin/risk/policies/${back.body.id}/activate`).set(admin.auth);
  });

  it('asks for step-up on a mid score, blocks a high score with a compliance case and SAR draft, and returns BP codes', async () => {
    const admin = await adminToken(app);
    const checker = await checkerToken(app);
    const a = await registerUser(app);
    const b = await registerUser(app);
    await fund(app, a.user.id, '100.00');
    // 35 points for the wallet method puts every transfer in the step-up band
    await setFraud(admin, { methodRisk: { wallet: 35 } });
    const needs = await request(app).post('/api/transfers').set(a.auth).send({ to: b.user.tag, amount: '10.00', currency: 'USD', pin: '1234' });
    expect(needs.status).toBe(403);
    expect(needs.body.error.code).toBe('step_up_required');
    expect(needs.body.error.bp).toBe('BP-1010');
    expect(needs.body.error.details.rule).toBe('FRD-002');
    expect(needs.body.error.details.factors).toContain('method_risk');
    const token = issueStepUpToken(findUserById(a.user.id)!).stepUpToken;
    const ok = await request(app).post('/api/transfers').set(a.auth).set('x-step-up-token', token).send({ to: b.user.tag, amount: '10.00', currency: 'USD' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const scores = await request(app).get('/api/admin/risk/fraud').set(admin.auth).query({ user: a.user.id });
    expect(scores.body.items[0].band).toBe('step_up');
    expect(scores.body.items[0].policyRule).toBe('FRD-002');
    expect(scores.body.byBand.step_up).toBeGreaterThanOrEqual(2);
    // 85 points → block, case with a SAR draft, four-eyes closure
    await setFraud(admin, { methodRisk: { wallet: 85 } });
    const blocked = await request(app).post('/api/transfers').set(a.auth).send({ to: b.user.tag, amount: '10.00', currency: 'USD', pin: '1234' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('risk_blocked');
    expect(blocked.body.error.bp).toBe('BP-5001');
    const cases = await request(app).get('/api/admin/risk/cases').set(admin.auth).query({ user: a.user.id });
    expect(cases.status).toBe(200);
    const c = cases.body.items.find((x: any) => x.kind === 'FRAUD');
    expect(c).toBeTruthy();
    expect(c.severity).toBe('critical');
    expect(c.sarDraft).toContain('SUSPICIOUS ACTIVITY REPORT');
    expect(c.sarDraft).toContain(a.user.fullName);
    expect(c.indicators.some((i: string) => i.startsWith('method_risk'))).toBe(true);
    expect(cases.body.sarDrafts).toBeGreaterThanOrEqual(1);
    expect((await request(app).post(`/api/admin/risk/cases/${c.id}/assign`).set(admin.auth).send({})).body.status).toBe('ASSIGNED');
    const edited = await request(app).put(`/api/admin/risk/cases/${c.id}/sar`).set(admin.auth).send({ text: `${c.sarDraft}\n\n6. Officer note\n   Reviewed.` });
    expect(edited.body.sarDraft).toContain('Officer note');
    expect((await request(app).post(`/api/admin/risk/cases/${c.id}/decide`).set(admin.auth).send({ decision: 'SAR_FILED', reason: 'Pattern confirmed' })).status).toBe(400); // needs the filing reference
    const decided = await request(app).post(`/api/admin/risk/cases/${c.id}/decide`).set(admin.auth).send({ decision: 'SAR_FILED', reason: 'Pattern confirmed', sarReference: 'CENAREF-2026-0042' });
    expect(decided.body.status).toBe('DECIDED');
    expect((await request(app).post(`/api/admin/risk/cases/${c.id}/close`).set(admin.auth)).status).toBe(409);
    expect((await request(app).post(`/api/admin/risk/cases/${c.id}/close`).set(checker.auth)).body.status).toBe('CLOSED');
    await setFraud(admin, { methodRisk: { wallet: 0 } });
  });

  it('refuses to post money for a listed party even on a path with no outbound risk check (ledger pre-commit guard)', async () => {
    const admin = await adminToken(app);
    const checker = await checkerToken(app);
    const listed = await registerUser(app, { fullName: 'Listed Person Zed' });
    const sanction = await request(app).post('/api/admin/sanctions').set(admin.auth).send({ kind: 'name', value: 'Listed Person Zed', note: 'test' });
    expect(sanction.status).toBe(201);
    const proposed = await request(app).post(`/api/admin/users/${listed.user.id}/adjust`).set(admin.auth).send({ direction: 'credit', amount: '10.00', currency: 'USD', reason: 'test funding' });
    expect(proposed.status).toBe(201);
    const approve = await request(app).post(`/api/admin/verifications/${proposed.body.verification.id}/approve`).set(checker.auth).send({ pin: checker.pin });
    expect(approve.status).toBe(403);
    expect(approve.body.error.code).toBe('sanctions_hit');
    expect(approve.body.error.bp).toBe('BP-5008');
    expect(await balanceOf(listed.auth)).toBe(0);
    const cases = await request(app).get('/api/admin/risk/cases').set(admin.auth).query({ user: listed.user.id, kind: 'SANCTIONS' });
    expect(cases.body.items.length).toBeGreaterThanOrEqual(1);
    await request(app).delete(`/api/admin/sanctions/${sanction.body.entry?.id ?? sanction.body.id}`).set(admin.auth);
  });
});

describe('KYC tiers, KYB and per-country limits', () => {
  it('applies tier limits server-side per country at the live rate, upgrades tiers on review, and gates business volume on KYB', async () => {
    const admin = await adminToken(app);
    const u = await registerUser(app, { country: 'CD' });
    const peer = await registerUser(app);
    await fund(app, u.user.id, '300.00');
    let v = await request(app).get('/api/risk/verification').set(u.auth);
    expect(v.body.tier).toBe(0);
    expect(v.body.limits).toBeNull();
    // Tier 1 self-activation needs a verified contact
    const t1 = await request(app).post('/api/risk/verification/tier1').set(u.auth);
    expect(t1.status).toBe(422);
    expect(t1.body.error.code).toBe('contact_unverified');
    const set1 = await request(app).put(`/api/admin/risk/kyc/users/${u.user.id}/tier`).set(admin.auth).send({ tier: 1, reason: 'agent onboarding verified by phone' });
    expect(set1.status, JSON.stringify(set1.body)).toBe(200);
    expect(set1.body.limits).toEqual({ perTransaction: 5_000, daily: 5_000, monthly: 20_000 });
    const over = await request(app).post('/api/transfers').set(u.auth).send({ to: peer.user.tag, amount: '60.00', currency: 'USD', pin: '1234' });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('kyc_tier_limit');
    expect(over.body.error.bp).toBe('BP-5005');
    expect(over.body.error.details.label).toBe('Tier 1 · Basic');
    expect((await request(app).post('/api/transfers').set(u.auth).send({ to: peer.user.tag, amount: '30.00', currency: 'USD', pin: '1234' })).status).toBe(201);
    const daily = await request(app).post('/api/transfers').set(u.auth).send({ to: peer.user.tag, amount: '30.00', currency: 'USD', pin: '1234' });
    expect(daily.status).toBe(422);
    expect(daily.body.error.code).toBe('daily_limit_exceeded');
    // a country override raises Tier 1 in the DRC without touching anyone else
    const cfg = await request(app).put('/api/admin/risk/kyc/tiers').set(admin.auth).send({ countries: { CD: { '1': { perTransaction: 20_000, daily: 100_000, monthly: 1_000_000 } } } });
    expect(cfg.status).toBe(200);
    expect((await request(app).post('/api/transfers').set(u.auth).send({ to: peer.user.tag, amount: '60.00', currency: 'USD', pin: '1234' })).status).toBe(201);
    v = await request(app).get('/api/risk/verification').set(u.auth);
    expect(v.body.limits.perTransaction).toBe(20_000);
    expect(v.body.usage.daily).toBeGreaterThanOrEqual(9_000);
    // a KYC submission with a fresh proof of address asks for Tier 3; review grants it
    const stale = await request(app).post('/api/kyc').set(u.auth).send({ docType: 'national_id', docNumber: 'CD-123', fullName: u.user.fullName, proofOfAddress: 'data:image/png;base64,AAAA', addressDocDate: new Date(Date.now() - 200 * 86_400_000).toISOString() });
    expect(stale.status).toBe(400);
    expect(stale.body.error.code).toBe('address_doc_too_old');
    const sub = await request(app).post('/api/kyc').set(u.auth).send({ docType: 'national_id', docNumber: 'CD-123', fullName: u.user.fullName, selfie: 'data:image/png;base64,AAAA', liveness: true, proofOfAddress: 'data:image/png;base64,AAAA', addressDocDate: new Date(Date.now() - 10 * 86_400_000).toISOString() });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    expect(sub.body.submission.requestedTier).toBe(3);
    expect(sub.body.submission.liveness).toBe(true);
    const review = await request(app).post(`/api/admin/kyc/${sub.body.submission.id}/review`).set(admin.auth).send({ decision: 'verified' });
    expect(review.status, JSON.stringify(review.body)).toBe(200);
    v = await request(app).get('/api/risk/verification').set(u.auth);
    expect(v.body.tier).toBe(3);
    expect(v.body.limits).toEqual({ perTransaction: 500_000, daily: 500_000, monthly: 2_000_000 });

    // KYB: directors need Tier 2; verification grants Tier 4; volume above the threshold requires it
    const m = await registerUser(app, { role: 'merchant', businessName: 'Kin Wholesale', country: 'CD' });
    const director = await registerUser(app);
    const needsKyc = await request(app).post('/api/risk/kyb').set(m.auth).send({ legalName: 'Kin Wholesale SARL', registrationNumber: 'CD/KIN/RCCM/24-B-1234', country: 'CD', address: '12 Avenue du Commerce, Gombe, Kinshasa', expectedMonthlyVolume: 5_000_000, directors: [{ name: director.user.fullName, userId: director.user.id, role: 'Gérant' }] });
    expect(needsKyc.status).toBe(422);
    expect(needsKyc.body.error.code).toBe('director_kyc_required');
    await request(app).put(`/api/admin/risk/kyc/users/${director.user.id}/tier`).set(admin.auth).send({ tier: 2, reason: 'verified' });
    const kyb = await request(app).post('/api/risk/kyb').set(m.auth).send({ legalName: 'Kin Wholesale SARL', registrationNumber: 'CD/KIN/RCCM/24-B-1234', country: 'CD', address: '12 Avenue du Commerce, Gombe, Kinshasa', mcc: '5311', expectedMonthlyVolume: 5_000_000, licenceRef: 'BCC-AGG-2026-07', directors: [{ name: director.user.fullName, userId: director.user.id, role: 'Gérant' }], documents: [{ kind: 'registration', ref: 'rccm.pdf' }] });
    expect(kyb.status, JSON.stringify(kyb.body)).toBe(201);
    expect(kyb.body.submission.status).toBe('pending');
    const reviewed = await request(app).post(`/api/admin/risk/kyb/${kyb.body.submission.id}/review`).set(admin.auth).send({ decision: 'verified', note: 'Registry checked' });
    expect(reviewed.body.status).toBe('verified');
    expect((await request(app).get('/api/risk/verification').set(m.auth)).body.tier).toBe(4);
    expect((await request(app).get('/api/risk/verification').set(m.auth)).body.kybStatus).toBe('verified');
    // an unverified merchant above the monthly threshold cannot open new intents
    const m2 = await registerUser(app, { role: 'merchant', businessName: 'Big Unverified', country: 'CD' });
    const payer = await registerUser(app);
    await fund(app, payer.user.id, '100.00');
    const intent = await request(app).post('/api/v1/payment_intents').set(m2.auth).send({ amount_minor: 5000, currency: 'USD' });
    expect(intent.status).toBe(201);
    expect((await request(app).post(`/api/v1/payment_intents/${intent.body.id}/pay/wallet`).set(payer.auth).send({ pin: '1234' })).status).toBe(201);
    await request(app).put('/api/admin/risk/kyc/tiers').set(admin.auth).send({ kybMonthlyVolumeThreshold: 4000 });
    const refused = await request(app).post('/api/v1/payment_intents').set(m2.auth).send({ amount_minor: 100, currency: 'USD' });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('kyb_required');
    expect(refused.body.error.bp).toBe('BP-5007');
    await request(app).put('/api/admin/risk/kyc/tiers').set(admin.auth).send({ kybMonthlyVolumeThreshold: 1_000_000 });
  });
});

describe('settlement-account change protection', () => {
  it('records and announces destination changes, cools off large payouts, lets the holder revoke, and locks changes after a password change', async () => {
    const admin = await adminToken(app);
    const u = await registerUser(app);
    await fund(app, u.user.id, '200.00');
    await request(app).put('/api/admin/settings/risk').set(admin.auth).send({ value: { coolingOffMinutes: 0 } }); // isolate the destination rule from the legacy beneficiary cooling-off
    await request(app).put('/api/admin/settings/accountProtection').set(admin.auth).send({ value: { coolingAmountBase: 1_000, coolingOffHours: 24 } });
    const bank = await request(app).post('/api/bank-accounts').set(u.auth).send({ bankName: 'Rawbank', accountName: u.user.fullName, accountNumber: '00998877', currency: 'USD', pin: '1234' });
    expect(bank.status).toBe(201);
    const changes = await request(app).get('/api/risk/destination-changes').set(u.auth);
    expect(changes.body.items).toHaveLength(1);
    expect(changes.body.items[0].status).toBe('COOLING');
    expect(changes.body.items[0].next.accountNumber).toBe('00998877');
    const notif = await request(app).get('/api/account/notifications').set(u.auth);
    expect(notif.body.items.some((n: any) => n.title === 'Payout destination changed')).toBe(true);
    const small = await request(app).post('/api/withdrawals').set(u.auth).send({ amount: '5.00', currency: 'USD', bankAccountId: bank.body.bankAccount.id, pin: '1234' });
    expect(small.status, JSON.stringify(small.body)).toBe(201);
    const big = await request(app).post('/api/withdrawals').set(u.auth).send({ amount: '40.00', currency: 'USD', bankAccountId: bank.body.bankAccount.id, pin: '1234' });
    expect(big.status, JSON.stringify(big.body)).toBe(403);
    expect(big.body.error.code).toBe('destination_cooling');
    expect(big.body.error.bp).toBe('BP-5010');
    const approved = await request(app).post(`/api/admin/risk/destination-changes/${changes.body.items[0].id}/approve`).set(admin.auth);
    expect(approved.body.status).toBe('APPROVED');
    expect((await request(app).post('/api/withdrawals').set(u.auth).send({ amount: '40.00', currency: 'USD', bankAccountId: bank.body.bankAccount.id, pin: '1234' })).status).toBe(201);
    // "this wasn't me"
    const bank2 = await request(app).post('/api/bank-accounts').set(u.auth).send({ bankName: 'Other Bank', accountName: 'Someone Else', accountNumber: '11112222', currency: 'USD', pin: '1234' });
    const change2 = (await request(app).get('/api/risk/destination-changes').set(u.auth)).body.items.find((c: any) => c.refId === bank2.body.bankAccount.id);
    const revoked = await request(app).post(`/api/risk/destination-changes/${change2.id}/revoke`).set(u.auth);
    expect(revoked.body.status).toBe('REVOKED');
    const locked = await request(app).post('/api/withdrawals').set(u.auth).send({ amount: '1.00', currency: 'USD', bankAccountId: bank2.body.bankAccount.id, pin: '1234' });
    expect(locked.status, JSON.stringify(locked.body)).toBe(403);
    expect(locked.body.error.code).toBe('destination_locked');
    const cases = await request(app).get('/api/admin/risk/cases').set(admin.auth).query({ user: u.user.id, kind: 'DESTINATION' });
    expect(cases.body.items[0].severity).toBe('critical');
    // after a password change no destination can be added for a day
    const pw = await request(app).post('/api/account/password').set(u.auth).send({ currentPassword: 'Password123!', newPassword: 'NewPassword456!' });
    expect(pw.status, JSON.stringify(pw.body)).toBe(200);
    const blocked = await request(app).post('/api/bank-accounts').set(u.auth).send({ bankName: 'Third Bank', accountName: 'Third Holder', accountNumber: '33334444', currency: 'USD', pin: '1234' });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(403);
    expect(blocked.body.error.code).toBe('destination_locked');
    expect(blocked.body.error.bp).toBe('BP-5011');
    await request(app).put('/api/admin/settings/risk').set(admin.auth).send({ value: { coolingOffMinutes: 60 } });
    await request(app).put('/api/admin/settings/accountProtection').set(admin.auth).send({ value: { coolingAmountBase: null } });
  });
});

describe('sanctions sources and the AML monitor', () => {
  it('imports a versioned list, screens against it, replaces it on the next version, and opens AML cases for structuring and PEPs', async () => {
    const admin = await adminToken(app);
    const src = await request(app).put('/api/admin/risk/sanctions/sources/ofac_sdn').set(admin.auth).send({ name: 'OFAC SDN (test)', format: 'csv', kind: 'sanctions' });
    expect(src.status).toBe(200);
    const csv = ['36,"AEROCARIBBEAN AIRLINES",-0-,CUBA', '173,"BANCO NACIONAL DE CUBA",-0-,CUBA', '999,"Sanctioned Tester Nine",individual,-0-'].join('\n');
    const imp = await request(app).post('/api/admin/risk/sanctions/sources/ofac_sdn/import').set(admin.auth).send({ version: '2026-09-11', csv });
    expect(imp.status, JSON.stringify(imp.body)).toBe(200);
    expect(imp.body.imported).toBe(3);
    const entries = await request(app).get('/api/admin/risk/sanctions/sources').set(admin.auth).query({ source: 'ofac_sdn' });
    expect(entries.body.entries).toHaveLength(3);
    expect(entries.body.items[0].lastVersion).toBe('2026-09-11');
    const sender = await registerUser(app);
    const target = await registerUser(app, { fullName: 'Sanctioned Tester Nine' });
    await fund(app, sender.user.id, '50.00');
    const blocked = await request(app).post('/api/transfers').set(sender.auth).send({ to: target.user.tag, amount: '1.00', currency: 'USD', pin: '1234' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('risk_blocked');
    const next = await request(app).post('/api/admin/risk/sanctions/sources/ofac_sdn/import').set(admin.auth).send({ version: '2026-09-12', rows: [{ kind: 'name', value: 'AEROCARIBBEAN AIRLINES', externalId: '36' }] });
    expect(next.body.replaced).toBe(3);
    expect(next.body.imported).toBe(1);
    expect((await request(app).post('/api/transfers').set(sender.auth).send({ to: target.user.tag, amount: '1.00', currency: 'USD', pin: '1234' })).status).toBe(201);
    expect((await request(app).post('/api/admin/risk/sanctions/sources/ofac_sdn/import').set(admin.auth).send({ version: 'v3', rows: [] })).status).toBe(400);

    // structuring: three movements at 80–100% of the per-transaction limit inside a day
    await request(app).put('/api/admin/risk/kyc/tiers').set(admin.auth).send({ countries: { KE: { '1': { perTransaction: 5_000, daily: 100_000, monthly: 1_000_000 } } } });
    const s = await registerUser(app, { country: 'KE' });
    const peer = await registerUser(app);
    await fund(app, s.user.id, '500.00');
    await request(app).put(`/api/admin/risk/kyc/users/${s.user.id}/tier`).set(admin.auth).send({ tier: 1, reason: 'test' });
    for (let i = 0; i < 3; i += 1) expect((await request(app).post('/api/transfers').set(s.auth).send({ to: peer.user.tag, amount: '45.00', currency: 'USD', pin: '1234' })).status).toBe(201);
    // PEP: raises the score and gets a case, never a block by itself
    const pepSrc = await request(app).put('/api/admin/risk/sanctions/sources/pep_list').set(admin.auth).send({ name: 'PEP register (test)', kind: 'pep' });
    expect(pepSrc.body.kind).toBe('pep');
    const pep = await registerUser(app, { fullName: 'Honourable Deputy Mwamba' });
    await fund(app, pep.user.id, '50.00');
    await request(app).post('/api/admin/risk/sanctions/sources/pep_list/import').set(admin.auth).send({ version: '1', rows: [{ kind: 'pep', value: 'Honourable Deputy Mwamba' }] });
    const pepTransfer = await request(app).post('/api/transfers').set(peer.auth).send({ to: pep.user.tag, amount: '1.00', currency: 'USD', pin: '1234' });
    expect(pepTransfer.status, JSON.stringify(pepTransfer.body)).toBe(403); // 45 points → step-up, not a block
    expect(pepTransfer.body.error.code).toBe('step_up_required');
    const scan = runAmlScan();
    expect(scan.findings.some((f) => f.pattern === 'structuring' && f.userId === s.user.id)).toBe(true);
    expect(scan.findings.some((f) => f.pattern === 'pep' && f.userId === pep.user.id)).toBe(true);
    const amlCases = await request(app).get('/api/admin/risk/cases').set(admin.auth).query({ kind: 'AML' });
    const structuring = amlCases.body.items.find((c: any) => c.userId === s.user.id);
    expect(structuring.severity).toBe('high');
    expect(structuring.sarDraft).toContain('near-limit');
    // running again the same day does not duplicate the cases
    const again = runAmlScan();
    expect(again.opened).toBe(0);
  });
});

describe('agent intelligence', () => {
  it('forecasts float, scores trust, pays dynamic commissions, routes float requests through maker-checker and onboards customers to Tier 1', async () => {
    const admin = await adminToken(app);
    const checker = await checkerToken(app);
    const agent = await registerUser(app, { role: 'agent', tag: 'intelagent', businessName: 'Intel Agent', country: 'CD' });
    await registerUser(app, { tag: 'intelcust1' });
    await fund(app, agent.user.id, '100.00');
    for (const amt of ['30.00', '30.00']) expect((await request(app).post('/api/agents/me/cash-in').set(agent.auth).send({ customer: 'intelcust1', amount: amt, currency: 'USD', pin: '1234' })).status).toBe(201);
    const float = await request(app).get('/api/risk/agents/me/float').set(agent.auth);
    expect(float.status).toBe(200);
    const usd = float.body.forecasts.find((f: any) => f.currency === 'USD');
    expect(usd.balanceMinor).toBe(10_000 - 6_000 + 30); // float out, 0.5% commission in
    expect(usd.window.cashIns).toBe(2);
    expect(usd.avgDailyOutflowMinor).toBeGreaterThan(0);
    expect(usd.runwayDays).toBeGreaterThan(0);
    expect(['ok', 'low', 'critical']).toContain(usd.status);
    // trust: a brand-new agent is 'new' and earns the base commission only
    const trust = await request(app).get('/api/risk/agents/me/trust').set(agent.auth);
    expect(trust.body.band).toBe('new');
    expect(trust.body.factors.reliability.points).toBe(20);
    expect(trust.body.commission.cashIn.base).toBe(50);
    expect(trust.body.commission.cashIn.trustBonus).toBe(0);
    // with tenure waived, the score decides the band and the bonus flows into the next commission
    await request(app).put('/api/admin/risk/agents/settings').set(admin.auth).send({ minTenureDays: 0, bonusByBand: { bronze: 7 }, liquidityBonusBps: 0 });
    const scored = computeTrustScore(agent.user.id, true);
    expect(scored.band).not.toBe('new');
    const bonus = scored.commissionBonusBps;
    const before = await balanceOf(agent.auth);
    await request(app).post('/api/agents/me/cash-in').set(agent.auth).send({ customer: 'intelcust1', amount: '10.00', currency: 'USD', pin: '1234' });
    const fee = 10; // 1% of 10.00
    const expectedCommission = Math.min(fee, Math.round((1000 * (50 + bonus)) / 10_000));
    expect((await balanceOf(agent.auth)) - before).toBe(-1000 + expectedCommission);
    const overview = await request(app).get('/api/admin/risk/agents/overview').set(admin.auth);
    expect(overview.body.agents.find((a: any) => a.id === agent.user.id).band).toBe(scored.band);
    // float replenishment through the issuance maker-checker
    const fr = await request(app).post('/api/risk/agents/me/float/requests').set(agent.auth).send({ currency: 'USD', amount: '50.00', method: 'cash_deposit', reference: 'DEP-001' });
    expect(fr.status, JSON.stringify(fr.body)).toBe(201);
    expect((await request(app).post('/api/risk/agents/me/float/requests').set(agent.auth).send({ currency: 'USD', amount: '5.00', method: 'cash_deposit' })).status).toBe(409);
    const fulfil = await request(app).post(`/api/admin/risk/agents/float-requests/${fr.body.id}/fulfil`).set(admin.auth).send({ note: 'Cash counted at the Gombe office, receipt DEP-001' });
    expect(fulfil.status, JSON.stringify(fulfil.body)).toBe(200);
    expect(fulfil.body.status).toBe('PROPOSED');
    const balBefore = await balanceOf(agent.auth);
    const ok = await request(app).post(`/api/admin/verifications/${fulfil.body.verificationId}/approve`).set(checker.auth).send({ pin: checker.pin });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await balanceOf(agent.auth)) - balBefore).toBe(5_000);
    expect((await request(app).get('/api/admin/risk/agents/float-requests').set(admin.auth).query({ agent: agent.user.id })).body.items[0].status).toBe('FULFILLED');
    // assisted onboarding: Tier 1 account, temporary PIN, onboarding commission accrued
    const onboarded = await request(app).post('/api/risk/agents/me/onboard').set(agent.auth).send({ fullName: 'Marie Kabila', phone: '+243991234567', country: 'CD', livePhoto: 'data:image/png;base64,AAAA', pin: '1234' });
    expect(onboarded.status, JSON.stringify(onboarded.body)).toBe(201);
    expect(onboarded.body.tier).toBe(1);
    expect(onboarded.body.temporaryPin).toMatch(/^\d{4}$/);
    expect(onboarded.body.commission).toBe(200);
    const newUser = findUserById(onboarded.body.user.id) as any;
    expect(newUser.kyc_tier).toBe(1);
    expect(newUser.phone_verified).toBe(1);
    const st = await request(app).get(`/api/admin/finops/commissions/${agent.user.id}`).set(admin.auth);
    expect(st.body.entries.some((e: any) => e.kind === 'onboarding' && e.status === 'ACCRUED' && e.amountMinor === 200)).toBe(true);
    expect(getDb().prepare("SELECT requested_tier FROM kyc_submissions WHERE user_id = ?").pluck().get(newUser.id)).toBe(2);
  });
});
