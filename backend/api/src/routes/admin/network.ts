/**
 * Corridor-network console API, mounted at /api/admin/network.
 *
 * Permissions follow what the action is, not where it sits: the posture of a corridor and the counterparty register
 * are `settings`; positions, settlement batches and prefunding are `treasury`; safeguarding, the phase gates and the
 * register of open questions are `compliance`. Every state change is audited, and the ones that move money or
 * commit the platform keep author and approver apart.
 */
import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../../lib/http';
import { requirePermission } from '../../middleware/permissions';
import { audit } from '../../services/audit';
import {
  COUNTERPARTY_KINDS,
  counterpartyFloat,
  getCounterparty,
  getNetworkCorridor,
  listCounterparties,
  listNetworkCorridors,
  networkOverview,
  setCorridorSettlementFlag,
  setCorridorStatus,
  setCounterpartyStatus,
  upsertCounterparty,
  upsertNetworkCorridor,
} from '../../services/network/registry';
import { railsForCorridor, settlementCapabilities, SETTLEMENT_RAILS } from '../../services/network/adapters';
import {
  MOVEMENT_KINDS,
  approveBatch,
  closeDuePositions,
  closePosition,
  confirmBatch,
  failBatch,
  getBatch,
  instructionPlan,
  listBatches,
  listMovements,
  listPositions,
  markInstructed,
  proposeBatch,
  recordCounterpartyMovement,
  reconcileBatch,
  rejectBatch,
  settlementOverview,
} from '../../services/network/positions';
import {
  approveTopup,
  executeTopup,
  forecastAll,
  forecastCounterparty,
  listForecasts,
  listTopups,
  proposeTopup,
  proposeTopupsForShortfalls,
  rejectTopup,
  treasuryReport,
} from '../../services/network/treasury';
import { buildCreditTransfer, getIsoMessage, importIsoMessage, listIsoMessages, markExported, partyFromCounterparty, partyGaps } from '../../services/network/iso20022';
import {
  confirmRemedy,
  generateResolutionPack,
  listResolutionPacks,
  monthlyReturn,
  remedyShortfall,
  resolutionPackContent,
  runDailySafeguarding,
  runSafeguardingCheck,
  safeguardingOverview,
} from '../../services/network/safeguarding';
import { corridorPnl, networkPnl } from '../../services/network/pnl';
import { addQuestion, answerQuestion, listGates, listQuestions, phaseReadiness, recordGate, setQuestionStatus } from '../../services/network/gates';
import { NETWORK_PHASES, REGULATORY_MODES } from '../../content/corridorNetwork';

export const adminNetworkRouter = Router();
const r = adminNetworkRouter;

const settings = requirePermission('settings');
const treasury = requirePermission('treasury');
const compliance = requirePermission('compliance');

const currency = z.string().length(3).toUpperCase();
const minor = z.number().int();
const positiveMinor = z.number().int().positive();

// ------------------------------------------------------------------ posture

r.get('/overview', settings, (_req, res) => res.json({ ...networkOverview(), settlementRails: settlementCapabilities() }));
r.get('/phases', settings, (_req, res) => res.json({ phases: NETWORK_PHASES, regulatoryModes: REGULATORY_MODES }));

r.get('/corridors', settings, (req, res) => res.json({ data: listNetworkCorridors({ status: (req.query.status as any) ?? null, phase: req.query.phase ? Number(req.query.phase) : null }) }));
r.get('/corridors/:code', settings, (req, res) => res.json({ corridor: getNetworkCorridor(String(req.params.code)), rails: railsForCorridor(String(req.params.code)) }));

const corridorInput = z.object({
  code: z
    .string()
    .min(2)
    .max(24)
    .regex(/^[A-Z0-9-]+$/, 'A corridor code is upper-case letters, digits and hyphens'),
  name: z.string().min(3).max(120),
  sourceCountry: z.string().length(2).toUpperCase(),
  destCountry: z.string().length(2).toUpperCase(),
  sourceCurrency: currency,
  destCurrency: currency,
  settlementCurrency: currency,
  phase: z.number().int().min(1).max(4),
  regulatoryMode: z.enum(['non_custodial', 'partner_custody', 'own_licence', 'network_operator']),
  licenceBasis: z.string().max(400).optional().nullable(),
  principalName: z.string().max(160).optional().nullable(),
  collectionRails: z.array(z.string().max(40)).max(20).optional(),
  payoutRails: z.array(z.string().max(40)).max(20).optional(),
  settlementRails: z.array(z.enum(SETTLEMENT_RAILS)).max(10).optional(),
  limits: z.object({ perPaymentMinor: minor.nonnegative(), perDayMinor: minor.nonnegative(), perMonthMinor: minor.nonnegative(), currency }).partial().optional(),
  corridorId: z.string().max(64).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

r.post(
  '/corridors',
  settings,
  wrap(async (req, res) => {
    const body = validate(corridorInput, req.body);
    const corridor = upsertNetworkCorridor(body, req.user!);
    audit(req.user!.id, 'network.corridor.upsert', 'network_corridor', corridor.id, { code: corridor.code, phase: corridor.phase });
    res.status(201).json({ corridor });
  }),
);

r.post(
  '/corridors/:code/status',
  settings,
  wrap(async (req, res) => {
    const body = validate(z.object({ status: z.enum(['draft', 'sandbox', 'live', 'suspended']), reason: z.string().max(400).optional().nullable() }), req.body);
    const corridor = setCorridorStatus(String(req.params.code), body.status, req.user!, body.reason);
    audit(req.user!.id, 'network.corridor.status', 'network_corridor', corridor.id, { code: corridor.code, status: body.status });
    res.json({ corridor });
  }),
);

r.post(
  '/corridors/:code/settlement-flag',
  settings,
  wrap(async (req, res) => {
    const body = validate(z.object({ flag: z.enum(['stablecoin', 'papss']), on: z.boolean(), reason: z.string().min(3).max(400) }), req.body);
    const corridor = setCorridorSettlementFlag(String(req.params.code), body.flag, body.on, req.user!, body.reason);
    audit(req.user!.id, 'network.corridor.settlement_flag', 'network_corridor', corridor.id, { code: corridor.code, flag: body.flag, on: body.on });
    res.json({ corridor });
  }),
);

// ----------------------------------------------------------- counterparties

r.get('/counterparties', settings, (req, res) => res.json({ data: listCounterparties({ kind: (req.query.kind as string) ?? null, status: (req.query.status as any) ?? null }) }));
r.get('/counterparties/:code', settings, (req, res) => {
  const cp = getCounterparty(String(req.params.code));
  const { party, gaps } = partyFromCounterparty(cp);
  return res.json({ counterparty: cp, float: counterpartyFloat(cp.id), iso20022: { party, gaps } });
});

r.post(
  '/counterparties',
  settings,
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        code: z
          .string()
          .min(2)
          .max(24)
          .regex(/^[A-Z0-9-]+$/),
        name: z.string().min(2).max(160),
        kind: z.enum(COUNTERPARTY_KINDS),
        country: z.string().length(2).toUpperCase().optional().nullable(),
        currencies: z.array(currency).min(1).max(10),
        settlementWindow: z.enum(['hourly', 'daily', 'weekly', 'manual']).optional(),
        exposureLimitMinor: minor.nonnegative().optional(),
        exposureCurrency: currency.optional().nullable(),
        safetyFactorBps: z.number().int().min(10_000).max(50_000).optional(),
        payoutAccountIds: z.array(z.string().max(64)).max(20).optional(),
        notes: z.string().max(2000).optional().nullable(),
      }),
      req.body,
    );
    const cp = upsertCounterparty(body, req.user!);
    audit(req.user!.id, 'network.counterparty.upsert', 'network_counterparty', cp.id, { code: cp.code, kind: cp.kind });
    res.status(201).json({ counterparty: cp });
  }),
);

r.post(
  '/counterparties/:code/status',
  settings,
  wrap(async (req, res) => {
    const body = validate(z.object({ status: z.enum(['draft', 'active', 'suspended']), reason: z.string().max(400).optional().nullable() }), req.body);
    const cp = setCounterpartyStatus(String(req.params.code), body.status, req.user!, body.reason);
    audit(req.user!.id, 'network.counterparty.status', 'network_counterparty', cp.id, { code: cp.code, status: body.status });
    res.json({ counterparty: cp });
  }),
);

// ------------------------------------------------- positions and settlement

r.get('/settlement', treasury, (_req, res) => res.json({ ...settlementOverview(), rails: settlementCapabilities() }));
r.get('/movements', treasury, (req, res) =>
  res.json({
    data: listMovements({
      counterpartyId: (req.query.counterparty as string) ?? null,
      currency: (req.query.currency as string) ?? null,
      windowKey: (req.query.window as string) ?? null,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }),
  }),
);

r.post(
  '/movements',
  treasury,
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        counterpartyId: z.string().min(1),
        currency,
        kind: z.enum(MOVEMENT_KINDS),
        amountMinor: minor,
        occurredAt: z.string().datetime().optional(),
        reference: z.string().max(140).optional().nullable(),
        paymentId: z.string().max(64).optional().nullable(),
        note: z.string().max(400).optional().nullable(),
      }),
      req.body,
    );
    const movement = recordCounterpartyMovement(body, req.user!.id);
    audit(req.user!.id, 'network.movement.recorded', 'network_counterparty', body.counterpartyId, { kind: body.kind, currency: body.currency, amount: movement.amountMinor });
    res.status(201).json({ movement });
  }),
);

r.get('/positions', treasury, (req, res) =>
  res.json({ data: listPositions({ counterpartyId: (req.query.counterparty as string) ?? null, status: (req.query.status as any) ?? null, currency: (req.query.currency as string) ?? null }) }),
);

r.post(
  '/positions/:id/close',
  treasury,
  wrap(async (req, res) => {
    const position = closePosition(String(req.params.id), req.user!);
    audit(req.user!.id, 'network.position.closed', 'network_position', position.id, { counterparty: position.counterpartyName, window: position.windowKey, net: position.netMinor });
    res.json({ position });
  }),
);

r.post(
  '/positions/close-due',
  treasury,
  wrap(async (req, res) => {
    const result = closeDuePositions();
    audit(req.user!.id, 'network.positions.close_due', 'network_position', undefined, result);
    res.json(result);
  }),
);

r.post(
  '/positions/:id/batch',
  treasury,
  wrap(async (req, res) => {
    const body = validate(z.object({ rail: z.enum(SETTLEMENT_RAILS), corridorCode: z.string().max(24).optional().nullable() }), req.body);
    const batch = proposeBatch(String(req.params.id), body, req.user!);
    audit(req.user!.id, 'network.batch.proposed', 'network_batch', batch.id, { number: batch.number, rail: batch.rail, net: batch.netMinor });
    res.status(201).json({ batch });
  }),
);

r.get('/batches', treasury, (req, res) => res.json({ data: listBatches({ counterpartyId: (req.query.counterparty as string) ?? null, status: (req.query.status as any) ?? null }) }));
r.get('/batches/:id', treasury, (req, res) => res.json({ batch: getBatch(String(req.params.id)), messages: listIsoMessages({ batchId: String(req.params.id) }) }));
r.get('/batches/:id/plan', treasury, (req, res) => res.json({ plan: instructionPlan(String(req.params.id)) }));

r.post(
  '/batches/:id/approve',
  treasury,
  wrap(async (req, res) => {
    const batch = approveBatch(String(req.params.id), req.user!);
    audit(req.user!.id, 'network.batch.approved', 'network_batch', batch.id, { number: batch.number, net: batch.netMinor });
    res.json({ batch });
  }),
);

r.post(
  '/batches/:id/reject',
  treasury,
  wrap(async (req, res) => {
    const body = validate(z.object({ reason: z.string().min(3).max(400) }), req.body);
    const batch = rejectBatch(String(req.params.id), body.reason, req.user!);
    audit(req.user!.id, 'network.batch.rejected', 'network_batch', batch.id, { number: batch.number, reason: body.reason });
    res.json({ batch });
  }),
);

r.post(
  '/batches/:id/instruct',
  treasury,
  wrap(async (req, res) => {
    const body = validate(z.object({ instructionRef: z.string().min(1).max(64), messageId: z.string().max(64).optional().nullable() }), req.body);
    const batch = markInstructed(String(req.params.id), body, req.user!);
    audit(req.user!.id, 'network.batch.instructed', 'network_batch', batch.id, { number: batch.number, instructionRef: body.instructionRef });
    res.json({ batch });
  }),
);

r.post(
  '/batches/:id/confirm',
  treasury,
  wrap(async (req, res) => {
    const body = validate(z.object({ externalRef: z.string().min(1).max(140) }), req.body);
    const batch = confirmBatch(String(req.params.id), body.externalRef, req.user!.id);
    audit(req.user!.id, 'network.batch.confirmed', 'network_batch', batch.id, { number: batch.number, externalRef: body.externalRef });
    res.json({ batch });
  }),
);

r.post(
  '/batches/:id/fail',
  treasury,
  wrap(async (req, res) => {
    const body = validate(z.object({ reason: z.string().min(3).max(400) }), req.body);
    const batch = failBatch(String(req.params.id), body.reason, req.user!.id);
    audit(req.user!.id, 'network.batch.failed', 'network_batch', batch.id, { number: batch.number, reason: body.reason });
    res.json({ batch });
  }),
);

r.post(
  '/batches/:id/reconcile',
  treasury,
  wrap(async (req, res) => {
    const body = validate(z.object({ statementAmountMinor: minor, statementRef: z.string().max(140).optional().nullable() }), req.body);
    const result = reconcileBatch(String(req.params.id), body, req.user!);
    audit(req.user!.id, 'network.batch.reconciled', 'network_batch', result.batch.id, { number: result.batch.number, net: result.batch.netMinor });
    res.json(result);
  }),
);

// ------------------------------------------------------------------ treasury

r.get('/treasury', treasury, (_req, res) => res.json(treasuryReport()));
r.get('/treasury/forecasts', treasury, (req, res) => res.json({ data: listForecasts({ counterpartyId: (req.query.counterparty as string) ?? null }) }));

r.post(
  '/treasury/forecast',
  treasury,
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        counterpartyId: z.string().optional().nullable(),
        currency: currency.optional().nullable(),
        horizonHours: z.number().int().min(1).max(720).optional(),
        lookbackDays: z.number().int().min(1).max(180).optional(),
      }),
      req.body ?? {},
    );
    const data = body.counterpartyId && body.currency ? [forecastCounterparty(body.counterpartyId, body.currency, body)] : forecastAll(body);
    audit(req.user!.id, 'network.treasury.forecast', 'network_counterparty', body.counterpartyId ?? undefined, { count: data.length });
    res.json({ data });
  }),
);

r.get('/treasury/topups', treasury, (req, res) => res.json({ data: listTopups({ status: (req.query.status as any) ?? null, counterpartyId: (req.query.counterparty as string) ?? null }) }));

r.post(
  '/treasury/topups',
  treasury,
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        counterpartyId: z.string().min(1),
        currency,
        amountMinor: positiveMinor,
        reason: z.string().min(3).max(400),
        payoutAccountId: z.string().max(64).optional().nullable(),
        forecastId: z.string().max(64).optional().nullable(),
      }),
      req.body,
    );
    const topup = proposeTopup(body, req.user!);
    audit(req.user!.id, 'network.topup.proposed', 'network_topup', topup.id, { counterparty: topup.counterpartyName, amount: topup.amountMinor, currency: topup.currency });
    res.status(201).json({ topup });
  }),
);

r.post(
  '/treasury/topups/auto',
  treasury,
  wrap(async (req, res) => {
    const body = validate(z.object({ horizonHours: z.number().int().min(1).max(720).optional(), lookbackDays: z.number().int().min(1).max(180).optional() }), req.body ?? {});
    const data = proposeTopupsForShortfalls(req.user!, body);
    audit(req.user!.id, 'network.topups.auto', 'network_topup', undefined, { proposed: data.length });
    res.status(201).json({ data });
  }),
);

for (const [action, fn] of [
  ['approve', approveTopup],
  ['execute', executeTopup],
] as const) {
  r.post(
    `/treasury/topups/:id/${action}`,
    treasury,
    wrap(async (req, res) => {
      const topup = fn(String(req.params.id), req.user!);
      audit(req.user!.id, `network.topup.${action}d`, 'network_topup', topup.id, { counterparty: topup.counterpartyName, amount: topup.amountMinor });
      res.json({ topup });
    }),
  );
}

r.post(
  '/treasury/topups/:id/reject',
  treasury,
  wrap(async (req, res) => {
    const body = validate(z.object({ reason: z.string().min(3).max(400) }), req.body);
    const topup = rejectTopup(String(req.params.id), body.reason, req.user!);
    audit(req.user!.id, 'network.topup.rejected', 'network_topup', topup.id, { reason: body.reason });
    res.json({ topup });
  }),
);

// ----------------------------------------------------------------- ISO 20022

r.get('/iso20022', treasury, (req, res) => res.json({ data: listIsoMessages({ kind: (req.query.kind as any) ?? null, batchId: (req.query.batch as string) ?? null }) }));
r.get('/iso20022/:id', treasury, (req, res) => res.json({ message: getIsoMessage(String(req.params.id)) }));

const partySchema = z.object({
  name: z.string().min(1).max(140),
  country: z.string().length(2).toUpperCase().optional().nullable(),
  addressLines: z.array(z.string().max(70)).max(7).optional(),
  lei: z.string().length(20).optional().nullable(),
  account: z.string().max(34).optional().nullable(),
  bic: z.string().min(8).max(11).optional().nullable(),
});

r.post(
  '/iso20022/party-check',
  treasury,
  wrap(async (req, res) => {
    const body = validate(z.object({ party: partySchema, businessPayer: z.boolean().optional() }), req.body);
    res.json({ gaps: partyGaps(body.party, { businessPayer: body.businessPayer }) });
  }),
);

r.post(
  '/iso20022/credit-transfer',
  treasury,
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        batchId: z.string().min(1),
        debtor: partySchema,
        creditor: partySchema,
        purposeCode: z.string().min(2).max(40),
        settlementDate: z.string().max(10).optional(),
        remittanceInformation: z.string().max(140).optional().nullable(),
      }),
      req.body,
    );
    const message = buildCreditTransfer(body, req.user!);
    audit(req.user!.id, 'network.iso20022.built', 'network_iso_message', message.id, { kind: message.kind, msgId: message.msgId, batchId: body.batchId });
    res.status(201).json({ message });
  }),
);

r.post(
  '/iso20022/:id/export',
  treasury,
  wrap(async (req, res) => {
    const message = markExported(String(req.params.id), req.user!);
    audit(req.user!.id, 'network.iso20022.exported', 'network_iso_message', message.id, { msgId: message.msgId });
    res.json({ message });
  }),
);

r.post(
  '/iso20022/import',
  treasury,
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        xml: z
          .string()
          .min(20)
          .max(8 * 1024 * 1024),
        fileName: z.string().max(200).optional().nullable(),
        counterpartyId: z.string().max(64).optional().nullable(),
      }),
      req.body,
    );
    const result = importIsoMessage(body.xml, body, req.user!);
    audit(req.user!.id, 'network.iso20022.imported', 'network_iso_message', result.message.id, { kind: result.kind, msgId: result.message.msgId, applied: result.applied.length });
    res.status(201).json(result);
  }),
);

// ------------------------------------------------------------- safeguarding

r.get('/safeguarding', compliance, (_req, res) => res.json(safeguardingOverview()));

r.post(
  '/safeguarding/run',
  compliance,
  wrap(async (req, res) => {
    const body = validate(z.object({ currency: currency.optional().nullable(), day: z.string().length(10).optional(), externalMinor: minor.nonnegative().optional().nullable() }), req.body ?? {});
    const data = body.currency
      ? [runSafeguardingCheck(body.currency, { day: body.day, externalMinor: body.externalMinor, actorId: req.user!.id })]
      : runDailySafeguarding({ day: body.day, actorId: req.user!.id });
    audit(req.user!.id, 'network.safeguarding.run', 'network_safeguarding', undefined, { checks: data.length, shortfalls: data.filter((c) => c.shortfallMinor > 0).length });
    res.json({ data });
  }),
);

r.post(
  '/safeguarding/remedy',
  compliance,
  wrap(async (req, res) => {
    const body = validate(z.object({ day: z.string().length(10), currency, note: z.string().max(400).optional().nullable() }), req.body);
    const check = remedyShortfall(body.day, body.currency, req.user!, body.note);
    audit(req.user!.id, 'network.safeguarding.remedy', 'network_safeguarding', check.id, { day: body.day, currency: body.currency, amount: check.toppedUpMinor });
    res.json({ check });
  }),
);

r.post(
  '/safeguarding/confirm-remedy',
  compliance,
  wrap(async (req, res) => {
    const body = validate(z.object({ day: z.string().length(10), currency }), req.body);
    const check = confirmRemedy(body.day, body.currency, req.user!);
    audit(req.user!.id, 'network.safeguarding.remedy_confirmed', 'network_safeguarding', check.id, { day: body.day, currency: body.currency });
    res.json({ check });
  }),
);

r.get('/safeguarding/packs', compliance, (_req, res) => res.json({ data: listResolutionPacks() }));
r.get('/safeguarding/packs/:day', compliance, (req, res) => res.json({ pack: resolutionPackContent(String(req.params.day)) }));

r.post(
  '/safeguarding/packs',
  compliance,
  wrap(async (req, res) => {
    const body = validate(z.object({ day: z.string().length(10).optional() }), req.body ?? {});
    const pack = generateResolutionPack({ day: body.day, actorId: req.user!.id });
    audit(req.user!.id, 'network.resolution_pack.generated', 'network_safeguarding', pack.id, { day: pack.day, holders: pack.holderCount });
    res.status(201).json({ pack });
  }),
);

r.get('/safeguarding/return', compliance, (req, res) => res.json({ return: monthlyReturn(String(req.query.month ?? ''), String(req.query.currency ?? '')) }));

// ---------------------------------------------------------------------- P&L

r.get('/pnl', treasury, (req, res) => {
  const from = (req.query.from as string) ?? null;
  const to = (req.query.to as string) ?? null;
  return req.query.corridor ? res.json({ data: [corridorPnl(String(req.query.corridor), { from, to })] }) : res.json({ data: networkPnl({ from, to }) });
});

// ----------------------------------------------------- gates and questions

r.get('/readiness', compliance, (_req, res) => res.json({ phases: phaseReadiness() }));
r.get('/gates', compliance, (req, res) => res.json({ data: listGates({ phase: req.query.phase ? Number(req.query.phase) : null, kind: (req.query.kind as any) ?? null }) }));

r.post(
  '/gates/:code',
  compliance,
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        status: z.enum(['not_started', 'in_progress', 'met', 'missed']),
        measured: z.string().max(200).optional().nullable(),
        evidence: z.string().max(1000).optional().nullable(),
        owner: z.string().max(120).optional().nullable(),
      }),
      req.body,
    );
    const gate = recordGate(String(req.params.code), body, req.user!);
    audit(req.user!.id, 'network.gate.recorded', 'network_gate', gate.id, { code: gate.code, status: gate.status, measured: gate.measured });
    res.json({ gate });
  }),
);

r.get('/questions', compliance, (req, res) =>
  res.json({ data: listQuestions({ status: (req.query.status as any) ?? null, phase: req.query.phase ? Number(req.query.phase) : null, area: (req.query.area as string) ?? null }) }),
);

r.post(
  '/questions',
  compliance,
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        ref: z.string().min(2).max(24),
        area: z.string().min(2).max(60),
        question: z.string().min(10).max(1000),
        phase: z.number().int().min(1).max(4),
        owner: z.string().max(120).optional().nullable(),
        blocks: z.string().max(400).optional().nullable(),
      }),
      req.body,
    );
    const question = addQuestion(body, req.user!);
    audit(req.user!.id, 'network.question.added', 'network_question', question.id, { ref: question.ref, area: question.area });
    res.status(201).json({ question });
  }),
);

r.post(
  '/questions/:ref/answer',
  compliance,
  wrap(async (req, res) => {
    const body = validate(z.object({ answer: z.string().min(3).max(4000) }), req.body);
    const question = answerQuestion(String(req.params.ref), body.answer, req.user!);
    audit(req.user!.id, 'network.question.answered', 'network_question', question.id, { ref: question.ref });
    res.json({ question });
  }),
);

r.post(
  '/questions/:ref/status',
  compliance,
  wrap(async (req, res) => {
    const body = validate(z.object({ status: z.enum(['open', 'blocked']), note: z.string().max(400).optional().nullable() }), req.body);
    const question = setQuestionStatus(String(req.params.ref), body.status, req.user!, body.note);
    audit(req.user!.id, 'network.question.status', 'network_question', question.id, { ref: question.ref, status: body.status });
    res.json({ question });
  }),
);
