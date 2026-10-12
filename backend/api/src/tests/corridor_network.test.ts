/**
 * Corridor network: the regulatory posture of a corridor, the counterparty sub-ledger and its settlement, treasury
 * prefunding under four eyes, ISO 20022 with a sponsor bank, daily safeguarding evidence, corridor P&L and the phase
 * gates. The module is off by default, so every test switches it on first where the public surface is involved.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, adminToken, checkerToken, registerUser } from './helpers';
import { getDb } from '../db';
import { buildXml, parseXml, childAt, childrenAt, textAt } from '../lib/xml';
import { DEFAULT_MODULES, AGGREGATOR_PERIMETER_OFF } from '../services/modules';
import { formatIsoAmount, parseIsoAmount, partyGaps } from '../services/network/iso20022';
import { windowKeyFor } from '../services/network/positions';
import { internalReconciliation, verifyResolutionChain } from '../services/network/safeguarding';

let app: ReturnType<typeof setupApp>;
let admin: Awaited<ReturnType<typeof adminToken>>;
let checker: Awaited<ReturnType<typeof checkerToken>>;

beforeAll(async () => {
  app = setupApp();
  admin = await adminToken(app);
  checker = await checkerToken(app);
});

const enableModule = async (on: boolean) => {
  const res = await request(app)
    .put('/api/admin/settings/modules')
    .set(admin.auth)
    .send({ ...DEFAULT_MODULES, corridorNetwork: on });
  if (res.status !== 200) {
    const alt = await request(app)
      .post('/api/admin/settings/modules')
      .set(admin.auth)
      .send({ ...DEFAULT_MODULES, corridorNetwork: on });
    return alt;
  }
  return res;
};

describe('corridor network · posture', () => {
  it('is switched off until an administrator switches it on, and sits inside the aggregator perimeter', () => {
    expect(DEFAULT_MODULES.corridorNetwork).toBe(false);
    expect(AGGREGATOR_PERIMETER_OFF).toContain('corridorNetwork');
  });

  it('seeds the phases, the two corridors, the counterparty slots, the gates and the open questions once', async () => {
    const res = await request(app).get('/api/admin/network/overview').set(admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.phases).toHaveLength(4);
    expect(res.body.phases.map((p: any) => p.phase)).toEqual([1, 2, 3, 4]);
    expect(res.body.corridors.map((c: any) => c.code).sort()).toEqual(['CD-CG', 'UK-CD']);
    expect(res.body.corridors.every((c: any) => c.status === 'draft')).toBe(true);
    expect(res.body.counterparties.length).toBeGreaterThanOrEqual(8);

    const gates = await request(app).get('/api/admin/network/gates').set(admin.auth);
    expect(gates.body.data.filter((g: any) => g.kind === 'kill_or_pivot').length).toBe(5);
    const questions = await request(app).get('/api/admin/network/questions').set(admin.auth);
    expect(questions.body.data).toHaveLength(11);
    expect(questions.body.data.every((q: any) => q.status === 'open')).toBe(true);

    // Seeding is idempotent: the counts do not grow when the register is read again after another boot pass.
    const before = (getDb().prepare('SELECT COUNT(*) n FROM network_questions').get() as any).n;
    const { seedGatesAndQuestions } = await import('../services/network/gates');
    const { seedCorridorNetwork } = await import('../services/network/registry');
    seedGatesAndQuestions();
    seedCorridorNetwork();
    expect((getDb().prepare('SELECT COUNT(*) n FROM network_questions').get() as any).n).toBe(before);
  });

  it('refuses to take a corridor live while its posture is incomplete, and says exactly what is missing', async () => {
    const bare = await request(app).post('/api/admin/network/corridors').set(admin.auth).send({
      code: 'TEST-BARE',
      name: 'Bare test corridor',
      sourceCountry: 'GB',
      destCountry: 'CD',
      sourceCurrency: 'GBP',
      destCurrency: 'CDF',
      settlementCurrency: 'USD',
      phase: 1,
      regulatoryMode: 'non_custodial',
    });
    expect(bare.status).toBe(201);
    const res = await request(app).post('/api/admin/network/corridors/TEST-BARE/status').set(admin.auth).send({ status: 'live' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('corridor_not_ready');
    expect(res.body.error.details).toEqual(expect.arrayContaining(['licence basis', 'at least one collection rail', 'at least one payout rail', 'per-payment limit', 'daily limit']));

    // The seeded corridors do carry a complete posture, so the gate lets them through — and they are still drafts
    // until somebody decides otherwise.
    expect((await request(app).get('/api/admin/network/corridors/UK-CD').set(admin.auth)).body.corridor.status).toBe('draft');
  });

  it('keeps a settlement mechanism that needs a decision switched off until the decision is recorded', async () => {
    const corridor = await request(app).get('/api/admin/network/corridors/CD-CG').set(admin.auth);
    expect(corridor.body.corridor.papssAllowed).toBe(false);
    expect(corridor.body.corridor.stablecoinAllowed).toBe(false);
    const refused = await request(app).post('/api/admin/network/corridors/CD-CG/settlement-flag').set(admin.auth).send({ flag: 'papss', on: true, reason: '  ' });
    expect(refused.status).toBe(400);
    const allowed = await request(app)
      .post('/api/admin/network/corridors/CD-CG/settlement-flag')
      .set(admin.auth)
      .send({ flag: 'papss', on: true, reason: 'Sponsor bank confirmed and the participation is recorded under Q-04.' });
    expect(allowed.status).toBe(200);
    expect(allowed.body.corridor.papssAllowed).toBe(true);
    const rails = await request(app).get('/api/admin/network/corridors/CD-CG').set(admin.auth);
    const token = rails.body.rails.find((r: any) => r.rail === 'settlement_token');
    expect(token.available).toBe(false);
    expect(token.reason).toMatch(/switched off|not declared/);
  });
});

describe('corridor network · counterparty sub-ledger and settlement', () => {
  let counterpartyId: string;
  let positionId: string;
  let batchId: string;

  it('records a counterparty and nets its window from the movements, keeping prefunding out of the position', async () => {
    const created = await request(app)
      .post('/api/admin/network/counterparties')
      .set(admin.auth)
      .send({ code: 'TEST-OP', name: 'Test operator', kind: 'mobile_money', country: 'CD', currencies: ['USD'], settlementWindow: 'daily', exposureLimitMinor: 1_000_000, exposureCurrency: 'USD' });
    expect(created.status).toBe(201);
    counterpartyId = created.body.counterparty.id;

    const collection = await request(app).post('/api/admin/network/movements').set(admin.auth).send({ counterpartyId, currency: 'USD', kind: 'collection', amountMinor: 50_000, reference: 'COL-1' });
    expect(collection.status).toBe(201);
    expect(collection.body.movement.amountMinor).toBe(50_000);

    const payout = await request(app).post('/api/admin/network/movements').set(admin.auth).send({ counterpartyId, currency: 'USD', kind: 'postpaid_payout', amountMinor: 20_000, reference: 'PAY-1' });
    expect(payout.body.movement.amountMinor).toBe(-20_000);

    // The same statement line twice posts once.
    const again = await request(app).post('/api/admin/network/movements').set(admin.auth).send({ counterpartyId, currency: 'USD', kind: 'collection', amountMinor: 50_000, reference: 'COL-1' });
    expect(again.body.movement.id).toBe(collection.body.movement.id);

    const positions = await request(app).get(`/api/admin/network/positions?counterparty=${counterpartyId}`).set(admin.auth);
    const position = positions.body.data[0];
    expect(position.grossInMinor).toBe(50_000);
    expect(position.grossOutMinor).toBe(20_000);
    expect(position.netMinor).toBe(30_000);
    expect(position.direction).toBe('receive');
    expect(position.entryCount).toBe(2);
    positionId = position.id;
  });

  it('settles a closed window under four eyes and refuses every step taken out of order', async () => {
    const early = await request(app).post(`/api/admin/network/positions/${positionId}/batch`).set(admin.auth).send({ rail: 'partner_network' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('position_open');

    const closed = await request(app).post(`/api/admin/network/positions/${positionId}/close`).set(admin.auth);
    expect(closed.status).toBe(200);

    const proposed = await request(app).post(`/api/admin/network/positions/${positionId}/batch`).set(admin.auth).send({ rail: 'partner_network' });
    expect(proposed.status).toBe(201);
    expect(proposed.body.batch.netMinor).toBe(30_000);
    expect(proposed.body.batch.direction).toBe('receive');
    batchId = proposed.body.batch.id;

    const selfApprove = await request(app).post(`/api/admin/network/batches/${batchId}/approve`).set(admin.auth);
    expect(selfApprove.status).toBe(400);
    expect(selfApprove.body.error.code).toBe('approver_required');

    const approved = await request(app).post(`/api/admin/network/batches/${batchId}/approve`).set(checker.auth);
    expect(approved.status).toBe(200);

    const plan = await request(app).get(`/api/admin/network/batches/${batchId}/plan`).set(admin.auth);
    expect(plan.body.plan.rail).toBe('partner_network');
    expect(plan.body.plan.steps.length).toBeGreaterThan(0);

    const instructed = await request(app).post(`/api/admin/network/batches/${batchId}/instruct`).set(admin.auth).send({ instructionRef: 'PN-000001' });
    expect(instructed.status).toBe(200);

    const earlyRecon = await request(app).post(`/api/admin/network/batches/${batchId}/reconcile`).set(admin.auth).send({ statementAmountMinor: 30_000 });
    expect(earlyRecon.status).toBe(409);

    await request(app).post(`/api/admin/network/batches/${batchId}/confirm`).set(admin.auth).send({ externalRef: 'OP-REF-77' });

    const break_ = await request(app).post(`/api/admin/network/batches/${batchId}/reconcile`).set(admin.auth).send({ statementAmountMinor: 29_900 });
    expect(break_.status).toBe(400);
    expect(break_.body.error.code).toBe('settlement_break');
    expect(break_.body.error.details.difference).toBe(-100);

    const reconciled = await request(app).post(`/api/admin/network/batches/${batchId}/reconcile`).set(admin.auth).send({ statementAmountMinor: 30_000 });
    expect(reconciled.status).toBe(200);
    expect(reconciled.body.batch.status).toBe('reconciled');

    const after = await request(app).get(`/api/admin/network/positions?counterparty=${counterpartyId}`).set(admin.auth);
    expect(after.body.data.find((p: any) => p.id === positionId).status).toBe('settled');
  });

  it('sends a movement that arrives after its window closed to the next window, never into a frozen one', async () => {
    const late = await request(app).post('/api/admin/network/movements').set(admin.auth).send({ counterpartyId, currency: 'USD', kind: 'collection', amountMinor: 7_000, reference: 'COL-LATE' });
    expect(late.status).toBe(201);
    const settled = await request(app).get(`/api/admin/network/positions?counterparty=${counterpartyId}`).set(admin.auth);
    const frozen = settled.body.data.find((p: any) => p.id === positionId);
    expect(frozen.netMinor).toBe(30_000);
    expect(frozen.entryCount).toBe(2);
    expect(settled.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('lets a window be settled again after its batch was rejected, reusing the same batch number', async () => {
    await request(app).post('/api/admin/network/movements').set(admin.auth).send({ counterpartyId, currency: 'USD', kind: 'collection', amountMinor: 4_000, reference: 'COL-REPROPOSE' });
    const open = (await request(app).get(`/api/admin/network/positions?counterparty=${counterpartyId}&status=open`).set(admin.auth)).body.data[0];
    await request(app).post(`/api/admin/network/positions/${open.id}/close`).set(admin.auth);
    const first = (await request(app).post(`/api/admin/network/positions/${open.id}/batch`).set(admin.auth).send({ rail: 'partner_network' })).body.batch;
    const rejected = await request(app).post(`/api/admin/network/batches/${first.id}/reject`).set(admin.auth).send({ reason: 'Wrong rail for this partner' });
    expect(rejected.body.batch.status).toBe('rejected');

    const second = await request(app).post(`/api/admin/network/positions/${open.id}/batch`).set(admin.auth).send({ rail: 'bank_transfer' });
    expect(second.status).toBe(201);
    expect(second.body.batch.number).toBe(first.number);
    expect(second.body.batch.status).toBe('proposed');
    expect(second.body.batch.rail).toBe('bank_transfer');
    expect(second.body.batch.failureReason).toBeNull();
    // Still four eyes on the replacement.
    expect((await request(app).post(`/api/admin/network/batches/${second.body.batch.id}/approve`).set(admin.auth)).status).toBe(400);
    expect((await request(app).post(`/api/admin/network/batches/${second.body.batch.id}/approve`).set(checker.auth)).status).toBe(200);
  });

  it('refuses a rail the corridor has not switched on, and names the corridor in the refusal', async () => {
    const movement = await request(app).post('/api/admin/network/movements').set(admin.auth).send({ counterpartyId, currency: 'USD', kind: 'collection', amountMinor: 11_000, reference: 'COL-TOKEN' });
    expect(movement.status).toBe(201);
    const open = (await request(app).get(`/api/admin/network/positions?counterparty=${counterpartyId}&status=open`).set(admin.auth)).body.data[0];
    await request(app).post(`/api/admin/network/positions/${open.id}/close`).set(admin.auth);
    const proposed = await request(app).post(`/api/admin/network/positions/${open.id}/batch`).set(admin.auth).send({ rail: 'settlement_token', corridorCode: 'CD-CG' });
    expect(proposed.status).toBe(201);
    await request(app).post(`/api/admin/network/batches/${proposed.body.batch.id}/approve`).set(checker.auth);
    const instructed = await request(app).post(`/api/admin/network/batches/${proposed.body.batch.id}/instruct`).set(admin.auth).send({ instructionRef: 'ST-000002' });
    expect(instructed.status).toBe(400);
    expect(instructed.body.error.code).toBe('settlement_rail_not_allowed');
    expect(instructed.body.error.message).toContain('CD-CG');
  });
});

describe('corridor network · treasury', () => {
  it('forecasts from what actually left the float and proposes the shortfall, executed only by a second administrator', async () => {
    const accountRes = await request(app)
      .post('/api/admin/liquidity/accounts')
      .set(admin.auth)
      .send({ rail: 'bank', country: 'CD', currency: 'USD', label: 'Treasury test float', bankName: 'Test settlement bank', accountNumber: 'TEST-FLOAT-USD-1' });
    expect([200, 201]).toContain(accountRes.status);
    const accountId = accountRes.body.id ?? accountRes.body.account?.id;
    expect(accountId).toBeTruthy();

    const cp = await request(app)
      .post('/api/admin/network/counterparties')
      .set(admin.auth)
      .send({ code: 'TEST-TREAS', name: 'Treasury test partner', kind: 'mobile_money', country: 'CD', currencies: ['USD'], payoutAccountIds: [accountId], safetyFactorBps: 15_000 });
    expect(cp.status).toBe(201);
    const activated = await request(app).post('/api/admin/network/counterparties/TEST-TREAS/status').set(admin.auth).send({ status: 'active' });
    expect(activated.status).toBe(200);

    // Two days of outflow on the float, so the forecast has something measured to project.
    const db = getDb();
    for (const [i, amount] of [14_000, 10_000].entries()) {
      db.prepare(
        'INSERT INTO liquidity_movements (id, payout_account_id, kind, amount, currency, transaction_id, reference, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?)',
      ).run(`test-move-${i}`, accountId, 'payout', -amount, 'USD', `TEST-${i}`, new Date(Date.now() - (i + 1) * 86_400_000).toISOString());
    }

    const forecast = await request(app)
      .post('/api/admin/network/treasury/forecast')
      .set(admin.auth)
      .send({ counterpartyId: cp.body.counterparty.id, currency: 'USD', horizonHours: 48, lookbackDays: 14 });
    expect(forecast.status).toBe(200);
    const f = forecast.body.data[0];
    expect(f.basis.observedOutflowMinor).toBe(24_000);
    expect(f.basis.dailyRateMinor).toBe(Math.round(24_000 / 14));
    expect(f.forecastMinor).toBe(Math.round((Math.round(24_000 / 14) * 48) / 24));
    expect(f.requiredMinor).toBe(Math.round((f.forecastMinor * 15_000) / 10_000));
    expect(f.shortfallMinor).toBe(Math.max(0, f.requiredMinor - f.balanceMinor));

    const topup = await request(app)
      .post('/api/admin/network/treasury/topups')
      .set(admin.auth)
      .send({ counterpartyId: cp.body.counterparty.id, currency: 'USD', amountMinor: 20_000, reason: 'Cover the forecast shortfall over 48 hours' });
    expect(topup.status).toBe(201);

    const executeBeforeApproval = await request(app).post(`/api/admin/network/treasury/topups/${topup.body.topup.id}/execute`).set(checker.auth);
    expect(executeBeforeApproval.status).toBe(409);

    const selfApprove = await request(app).post(`/api/admin/network/treasury/topups/${topup.body.topup.id}/approve`).set(admin.auth);
    expect(selfApprove.status).toBe(400);
    expect(selfApprove.body.error.code).toBe('approver_required');

    const approved = await request(app).post(`/api/admin/network/treasury/topups/${topup.body.topup.id}/approve`).set(checker.auth);
    expect(approved.status).toBe(200);

    const balanceBefore = (await request(app).get('/api/admin/network/counterparties/TEST-TREAS').set(admin.auth)).body.float.find((x: any) => x.currency === 'USD').balanceMinor;
    const executed = await request(app).post(`/api/admin/network/treasury/topups/${topup.body.topup.id}/execute`).set(checker.auth);
    expect(executed.status).toBe(200);
    expect(executed.body.topup.status).toBe('executed');
    const balanceAfter = (await request(app).get('/api/admin/network/counterparties/TEST-TREAS').set(admin.auth)).body.float.find((x: any) => x.currency === 'USD').balanceMinor;
    expect(balanceAfter - balanceBefore).toBe(20_000);

    // The prefund is a liquidity movement, not a counterparty position: nothing was double-counted.
    const positions = await request(app).get(`/api/admin/network/positions?counterparty=${cp.body.counterparty.id}`).set(admin.auth);
    expect(positions.body.data).toHaveLength(0);
  });
});

describe('corridor network · ISO 20022', () => {
  it('reads and writes amounts at the currency’s own exponent, and refuses more decimals than it has', () => {
    expect(formatIsoAmount(250_000, 'USD')).toBe('2500.00');
    expect(parseIsoAmount('2500.00', 'USD')).toBe(250_000);
    expect(parseIsoAmount('2500', 'USD')).toBe(250_000);
    expect(() => parseIsoAmount('2500.123', 'USD')).toThrow(/decimals/);
    expect(() => parseIsoAmount('two thousand', 'USD')).toThrow(/not an amount/);
  });

  it('names the party details a scheme requires before a message can be built', () => {
    expect(partyGaps({ name: '' })).toContain('name');
    expect(partyGaps({ name: 'Acme', country: 'CD', addressLines: ['1 Avenue'], account: 'ACC1' }, { businessPayer: true })).toEqual(['legal-entity identifier']);
    expect(partyGaps({ name: 'Acme', country: 'CD', addressLines: ['1 Avenue'], account: 'ACC1', lei: '5493001KJTIIGC8Y1R12' }, { businessPayer: true })).toEqual([]);
  });

  it('refuses a document type declaration and a malformed document rather than parsing them', () => {
    expect(() => parseXml('<!DOCTYPE foo [<!ENTITY x "y">]><Document/>')).toThrow(/document type declaration/i);
    expect(() => parseXml('<Document><A></B></Document>')).toThrow(/does not match/);
    expect(() => parseXml('<Document><A/>')).toThrow(/never closed/);
    const node = parseXml('<ns:Document xmlns:ns="urn:x"><ns:A attr="1">he &amp; she</ns:A><ns:B/></ns:Document>');
    expect(node.name).toBe('Document');
    expect(textAt(node, 'A')).toBe('he & she');
    expect(childAt(node, 'A')!.attributes.attr).toBe('1');
    expect(childrenAt(node, 'B')).toHaveLength(1);
  });

  it('builds a pacs.008 for an approved batch, then applies the sponsor’s status report and statement', async () => {
    const cp = await request(app)
      .post('/api/admin/network/counterparties')
      .set(admin.auth)
      .send({ code: 'TEST-SPONSOR', name: 'Test sponsor bank', kind: 'sponsor_bank', currencies: ['USD'], settlementWindow: 'daily' });
    expect(cp.status).toBe(201);
    await request(app).post('/api/admin/network/counterparties/TEST-SPONSOR/status').set(admin.auth).send({ status: 'active' });
    const counterpartyId = cp.body.counterparty.id;

    await request(app).post('/api/admin/network/movements').set(admin.auth).send({ counterpartyId, currency: 'USD', kind: 'postpaid_payout', amountMinor: 120_000, reference: 'SPONSOR-OUT-1' });
    const open = (await request(app).get(`/api/admin/network/positions?counterparty=${counterpartyId}&status=open`).set(admin.auth)).body.data[0];
    await request(app).post(`/api/admin/network/positions/${open.id}/close`).set(admin.auth);
    const batch = (await request(app).post(`/api/admin/network/positions/${open.id}/batch`).set(admin.auth).send({ rail: 'sponsor_iso20022', corridorCode: 'CD-CG' })).body.batch;
    expect(batch.direction).toBe('pay');
    await request(app).post(`/api/admin/network/batches/${batch.id}/approve`).set(checker.auth);

    const incomplete = await request(app)
      .post('/api/admin/network/iso20022/credit-transfer')
      .set(admin.auth)
      .send({ batchId: batch.id, debtor: { name: 'BitriPay' }, creditor: { name: 'Test sponsor bank' }, purposeCode: 'GENERAL_MERCHANT' });
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.error.code).toBe('iso20022_party_incomplete');

    const built = await request(app)
      .post('/api/admin/network/iso20022/credit-transfer')
      .set(admin.auth)
      .send({
        batchId: batch.id,
        debtor: { name: 'BitriPay', country: 'CD', addressLines: ['22 bis avenue de la Revolution'], account: 'BP-SETTLE-USD', lei: '5493001KJTIIGC8Y1R12', bic: 'BPAYCDKX' },
        creditor: { name: 'Test sponsor bank', country: 'CD', addressLines: ['1 Boulevard'], account: 'SPON-USD-1', bic: 'SPONCDKX' },
        purposeCode: 'GENERAL_MERCHANT',
        remittanceInformation: 'Settlement of the daily net',
      });
    expect(built.status).toBe(201);
    const payload = built.body.message.payload as string;
    const doc = parseXml(payload);
    expect(doc.attributes.xmlns).toContain('pacs.008');
    expect(textAt(doc, 'FIToFICstmrCdtTrf/CdtTrfTxInf/IntrBkSttlmAmt')).toBe('1200.00');
    expect(childAt(doc, 'FIToFICstmrCdtTrf/CdtTrfTxInf/IntrBkSttlmAmt')!.attributes.Ccy).toBe('USD');
    expect(textAt(doc, 'FIToFICstmrCdtTrf/CdtTrfTxInf/PmtId/EndToEndId')).toBe(`BATCH${String(batch.number).padStart(6, '0')}`);
    expect(textAt(doc, 'FIToFICstmrCdtTrf/CdtTrfTxInf/Dbtr/Id/OrgId/LEI')).toBe('5493001KJTIIGC8Y1R12');

    await request(app).post(`/api/admin/network/iso20022/${built.body.message.id}/export`).set(admin.auth);
    await request(app)
      .post(`/api/admin/network/batches/${batch.id}/instruct`)
      .set(admin.auth)
      .send({ instructionRef: `BATCH${String(batch.number).padStart(6, '0')}`, messageId: built.body.message.msgId });

    const statusReport = buildXml({
      name: 'Document',
      attributes: { xmlns: 'urn:iso:std:iso:20022:tech:xsd:pacs.002.001.10' },
      children: [
        {
          name: 'FIToFIPmtStsRpt',
          children: [
            { name: 'GrpHdr', children: [{ name: 'MsgId', text: 'SPONSOR-STS-1' }] },
            {
              name: 'TxInfAndSts',
              children: [
                { name: 'OrgnlEndToEndId', text: `BATCH${String(batch.number).padStart(6, '0')}` },
                { name: 'TxSts', text: 'ACSC' },
                { name: 'OrgnlTxId', text: 'SCHEME-REF-9' },
              ],
            },
          ],
        },
      ],
    });
    const imported = await request(app).post('/api/admin/network/iso20022/import').set(admin.auth).send({ xml: statusReport, fileName: 'pacs002.xml' });
    expect(imported.status).toBe(201);
    expect(imported.body.applied.join(' ')).toContain('confirmed');
    expect((await request(app).get(`/api/admin/network/batches/${batch.id}`).set(admin.auth)).body.batch.status).toBe('confirmed');

    // Importing the same file twice applies nothing twice.
    const twice = await request(app).post('/api/admin/network/iso20022/import').set(admin.auth).send({ xml: statusReport });
    expect(twice.body.applied).toEqual([]);
    expect(twice.body.warnings.join(' ')).toContain('already imported');

    const statement = buildXml({
      name: 'Document',
      attributes: { xmlns: 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.08' },
      children: [
        {
          name: 'BkToCstmrStmt',
          children: [
            { name: 'GrpHdr', children: [{ name: 'MsgId', text: 'SPONSOR-STMT-1' }] },
            {
              name: 'Stmt',
              children: [
                { name: 'Acct', children: [{ name: 'Ccy', text: 'USD' }] },
                {
                  name: 'Ntry',
                  children: [
                    { name: 'Amt', attributes: { Ccy: 'USD' }, text: '300.00' },
                    { name: 'CdtDbtInd', text: 'CRDT' },
                    { name: 'NtryRef', text: 'STMT-LINE-1' },
                    { name: 'BookgDt', children: [{ name: 'Dt', text: '2026-10-12' }] },
                  ],
                },
                {
                  name: 'Ntry',
                  children: [
                    { name: 'Amt', attributes: { Ccy: 'USD' }, text: '50.00' },
                    { name: 'CdtDbtInd', text: 'DBIT' },
                    { name: 'NtryRef', text: 'STMT-LINE-2' },
                  ],
                },
                {
                  name: 'Ntry',
                  children: [
                    { name: 'Amt', attributes: { Ccy: 'USD' }, text: '9.99' },
                    { name: 'CdtDbtInd', text: 'CRDT' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const stmt = await request(app).post('/api/admin/network/iso20022/import').set(admin.auth).send({ xml: statement, counterpartyId });
    expect(stmt.status).toBe(201);
    expect(stmt.body.applied).toHaveLength(2);
    expect(stmt.body.warnings.join(' ')).toContain('without any reference');
    const movements = await request(app).get(`/api/admin/network/movements?counterparty=${counterpartyId}`).set(admin.auth);
    const byRef = Object.fromEntries(movements.body.data.map((m: any) => [m.reference, m.amountMinor]));
    expect(byRef['STMT-LINE-1']).toBe(30_000);
    expect(byRef['STMT-LINE-2']).toBe(-5_000);
  });
});

describe('corridor network · safeguarding', () => {
  it('reconciles the customer wallets against their own postings and records the day', async () => {
    const user = await registerUser(app, { email: 'safeguard.holder@example.com' });
    expect(user.user.id).toBeTruthy();
    const internal = internalReconciliation('USD');
    expect(internal.mismatched).toEqual([]);
    expect(internal.walletSumMinor).toBe(internal.postedSumMinor);

    const run = await request(app).post('/api/admin/network/safeguarding/run').set(admin.auth).send({ currency: 'USD' });
    expect(run.status).toBe(200);
    const check = run.body.data[0];
    expect(check.currency).toBe('USD');
    expect(check.internalOk).toBe(true);
    expect(check.detail.walletSumMinor).toBe(check.detail.postedSumMinor);
  });

  it('finds a shortfall when the designated accounts hold less than customers are owed, and refuses the release gate', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const short = await request(app).post('/api/admin/network/safeguarding/run').set(admin.auth).send({ currency: 'USD', externalMinor: 0 });
    const check = short.body.data[0];
    if (check.liabilityMinor > 0) {
      expect(check.shortfallMinor).toBe(check.liabilityMinor);
      expect(check.status).toBe('shortfall');
      const { assertSafeguardingHealthy } = await import('../services/network/safeguarding');
      expect(() => assertSafeguardingHealthy(day)).toThrow(/short/i);
    } else {
      expect(check.shortfallMinor).toBe(0);
    }
    // Put the day back to the measured position so the rest of the suite sees the truth, not the probe.
    await request(app).post('/api/admin/network/safeguarding/run').set(admin.auth).send({ currency: 'USD' });
  });

  it('generates a hash-chained resolution pack whose chain verifies', async () => {
    const first = await request(app).post('/api/admin/network/safeguarding/packs').set(admin.auth).send({ day: '2026-10-10' });
    expect(first.status).toBe(201);
    const second = await request(app).post('/api/admin/network/safeguarding/packs').set(admin.auth).send({ day: '2026-10-11' });
    expect(second.body.pack.prevHash).toBe(first.body.pack.hash);
    expect(verifyResolutionChain()).toEqual({ ok: true, checked: 2, broken: [] });

    const content = await request(app).get('/api/admin/network/safeguarding/packs/2026-10-11').set(admin.auth);
    expect(content.body.pack.procedure.length).toBeGreaterThan(3);
    expect(content.body.pack).toHaveProperty('holders');

    // Tampering with a stored pack breaks the chain, which is the whole point of chaining it.
    getDb().prepare("UPDATE network_resolution_packs SET content = ? WHERE day = '2026-10-10'").run('{"day":"2026-10-10","tampered":true}');
    const broken = verifyResolutionChain();
    expect(broken.ok).toBe(false);
    expect(broken.broken).toContain('2026-10-10');
  });

  it('produces the monthly return from the ledger, not from a spreadsheet', async () => {
    const res = await request(app).get('/api/admin/network/safeguarding/return?month=2026-10&currency=USD').set(admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.return.month).toBe('2026-10');
    expect(res.body.return.currency).toBe('USD');
    expect(typeof res.body.return.daysChecked).toBe('number');
    const bad = await request(app).get('/api/admin/network/safeguarding/return?month=October&currency=USD').set(admin.auth);
    expect(bad.status).toBe(400);
  });
});

describe('corridor network · P&L, gates and the public surface', () => {
  it('returns an unknown line as unknown rather than as zero, and withholds the contribution until every line is known', async () => {
    const res = await request(app).get('/api/admin/network/pnl?corridor=UK-CD').set(admin.auth);
    expect(res.status).toBe(200);
    const pnl = res.body.data[0];
    expect(pnl.corridor).toBe('UK-CD');
    expect(pnl.unknownLines.length).toBeGreaterThan(0);
    expect(pnl.contributionMinor).toBeNull();
    const funding = pnl.lines.find((l: any) => l.key === 'funding');
    expect(funding.amountMinor).toBeNull();
    expect(funding.note).toContain('no funding cost is configured'.replace('no', 'No'));
  });

  it('requires a measurement and its evidence before a gate may be called met', async () => {
    const bare = await request(app).post('/api/admin/network/gates/G1-MERCHANTS').set(admin.auth).send({ status: 'met' });
    expect(bare.status).toBe(400);
    expect(bare.body.error.code).toBe('measurement_required');
    const noEvidence = await request(app).post('/api/admin/network/gates/G1-MERCHANTS').set(admin.auth).send({ status: 'met', measured: '63' });
    expect(noEvidence.body.error.code).toBe('evidence_required');
    const met = await request(app)
      .post('/api/admin/network/gates/G1-MERCHANTS')
      .set(admin.auth)
      .send({ status: 'met', measured: '63', evidence: 'Merchant register, external accounts only, 12 October 2026' });
    expect(met.status).toBe(200);
    expect(met.body.gate.status).toBe('met');
  });

  it('holds a phase back while its questions are unanswered and the previous phase has gates outstanding', async () => {
    const res = await request(app).get('/api/admin/network/readiness').set(admin.auth);
    const phase2 = res.body.phases.find((p: any) => p.phase === 2);
    expect(phase2.clearToFund).toBe(false);
    expect(phase2.blockedBy.some((b: string) => b.startsWith('Phase 1 gate not met'))).toBe(true);
    expect(phase2.blockedBy.some((b: string) => b.startsWith('Q-'))).toBe(true);

    const answered = await request(app)
      .post('/api/admin/network/questions/Q-04/answer')
      .set(admin.auth)
      .send({ answer: 'Confirmed in writing on 12 October 2026; two candidate sponsor banks identified.' });
    expect(answered.status).toBe(200);
    expect(answered.body.question.status).toBe('answered');
    const after = await request(app).get('/api/admin/network/readiness').set(admin.auth);
    expect(after.body.phases.find((p: any) => p.phase === 2).blockedBy.some((b: string) => b.startsWith('Q-04'))).toBe(false);
  });

  it('publishes /v1/corridors only when the module is on, and never names a partner', async () => {
    const merchant = await registerUser(app, { email: 'corridor.merchant@example.com', role: 'merchant' });
    const auth = { Authorization: `Bearer ${merchant.token}` };

    const off = await request(app).get('/v1/corridors').set(auth);
    expect(off.status).toBe(422);
    expect(off.body.error.code).toBe('module_disabled');

    await enableModule(true);
    const on = await request(app).get('/v1/corridors').set(auth);
    expect(on.status).toBe(200);
    // A draft corridor is never published, however complete its posture is.
    expect(on.body.data.map((c: any) => c.code)).not.toContain('UK-CD');

    await request(app).post('/api/admin/network/corridors/UK-CD/status').set(admin.auth).send({ status: 'sandbox' });
    const sandboxed = await request(app).get('/v1/corridors').set(auth);
    const corridor = sandboxed.body.data.find((c: any) => c.code === 'UK-CD');
    expect(corridor).toBeTruthy();
    expect(corridor.payout_rails).toContain('mobile_money');
    // The rail names are part of the integration; who holds the licence and who the partner is are not.
    const posture = (await request(app).get('/api/admin/network/corridors/UK-CD').set(admin.auth)).body.corridor;
    expect(posture.licenceBasis).toBeTruthy();
    expect(JSON.stringify(corridor)).not.toContain(posture.licenceBasis);
    expect(corridor).not.toHaveProperty('licenceBasis');
    expect(corridor).not.toHaveProperty('principalName');
    expect(corridor).not.toHaveProperty('regulatoryMode');
    for (const cp of (await request(app).get('/api/admin/network/counterparties').set(admin.auth)).body.data) {
      expect(JSON.stringify(corridor)).not.toContain(cp.name);
    }
    await enableModule(false);
  });

  it('keeps a window key stable for a cadence', () => {
    const at = new Date('2026-10-12T14:35:00.000Z');
    expect(windowKeyFor('daily', at)).toBe('2026-10-12');
    expect(windowKeyFor('hourly', at)).toBe('2026-10-12T14');
    expect(windowKeyFor('weekly', at)).toBe('2026-W42');
    expect(windowKeyFor('manual', at)).toBe('manual');
  });
});
