/**
 * Payout engine (no operator API). A payout instruction is created for every external destination
 * (mobile money number, bank account). The routing engine assigns a prefunded payout account; an
 * approved Android payout device – or the agent who operates the merchant SIM – claims it, executes
 * the local transfer with USSD / SIM Toolkit / the operator app, and the device forwards the
 * operator's confirmation SMS, signed. The verification engine matches recipient, amount, reference,
 * operator, SIM and timestamps, rejects replays and duplicates, and only then settles: the sender's
 * held funds are released and the float wallet is debited. Administrative settlement is the exception
 * and goes through maker-checker with documentary evidence.
 */
import { getDb } from '../db';
import { uuid, now, shortCode } from '../lib/ids';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { parseJson } from '../lib/json';
import { sha256 } from '../lib/crypto';
import { formatMoney, toMinor } from '@bitripay/shared';
import { getCurrency } from './currencies';
import { completeTransaction, getTransaction, reverseTransaction, type TransactionRow } from './ledger';
import { findUserById, toPublicUser, type UserRow } from './users';
import { notify } from './notifications';
import { sendSms } from './messaging';
import { getOperator } from './momo';
import { getComplianceSettings, getGatewayControls } from './settings';
import { recordEvent, listEvents, type Actor } from './events';
import { authenticateDevice, bumpDeviceRisk, getDevice, parseEvidenceText, storeEvidence, listEvidence, type EvidenceDevice, type IngestInput } from './evidence';
import { selectPayoutAccount, getPayoutAccount, debitFloatForPayout, type PayoutAccount } from './liquidity';
import { ensureCorridor, type Corridor } from './corridors';
import { normalizePhoneDigits } from './risk';
import { tryTransitionRoute } from './routeLifecycle';

export const PAYOUT_STAGES = ['QUEUED', 'IN_PROGRESS', 'EVIDENCE_RECEIVED', 'VERIFYING', 'SETTLED', 'FAILED', 'MISMATCHED', 'DUPLICATE', 'LIQUIDITY_UNAVAILABLE', 'MANUAL_REVIEW', 'EXPIRED', 'CANCELLED'] as const;
export type PayoutStage = (typeof PAYOUT_STAGES)[number];
const OPEN: PayoutStage[] = ['QUEUED', 'IN_PROGRESS', 'EVIDENCE_RECEIVED', 'VERIFYING', 'MISMATCHED', 'DUPLICATE', 'LIQUIDITY_UNAVAILABLE', 'MANUAL_REVIEW'];

export interface PayoutView {
  id: string;
  reference: string;
  routeId: string | null;
  transactionId: string;
  userId: string;
  corridorId: string | null;
  payoutAccountId: string | null;
  payoutAccount: { id: string; label: string; msisdn: string | null; operatorName: string | null } | null;
  agent: ReturnType<typeof toPublicUser> | null;
  rail: 'mobile_money' | 'bank';
  operatorId: string | null;
  operatorName: string | null;
  recipientMsisdn: string | null;
  recipientMasked: string | null;
  recipientName: string | null;
  bankDetails: Record<string, unknown> | null;
  amount: number;
  currency: string;
  stage: PayoutStage;
  claimedByDeviceId: string | null;
  claimedByUserId: string | null;
  claimedAt: string | null;
  evidenceId: string | null;
  externalRef: string | null;
  attempts: number;
  riskFlags: string[];
  error: string | null;
  expiresAt: string | null;
  /** What the device / agent must do. */
  instructions: { ussd: string | null; steps: string[] } | null;
  createdAt: string;
  updatedAt: string;
}

function mask(msisdn: string | null) {
  if (!msisdn) return null;
  const d = msisdn.replace(/\D/g, '');
  return d.length > 4 ? `${'•'.repeat(Math.max(0, d.length - 4))}${d.slice(-4)}` : msisdn;
}

function toView(r: any, full = true): PayoutView {
  const agent = r.agent_user_id ? findUserById(r.agent_user_id) : null;
  let account: PayoutView['payoutAccount'] = null;
  if (r.payout_account_id) {
    try {
      const a = getPayoutAccount(r.payout_account_id);
      account = { id: a.id, label: a.label, msisdn: a.msisdn, operatorName: a.operatorName };
    } catch {
      account = null;
    }
  }
  let operatorName: string | null = null;
  let ussd: string | null = null;
  if (r.operator_id) {
    try {
      const op = getOperator(r.operator_id);
      operatorName = op.name;
      ussd = op.ussd;
    } catch {
      operatorName = r.operator_id;
    }
  }
  const cur = getCurrency(r.currency, false);
  const amountMajor = formatMoney(r.amount, cur);
  const steps = r.rail === 'mobile_money'
    ? [`Open ${operatorName ?? 'the operator'} on the payout SIM${ussd ? ` (dial ${ussd})` : ''}`, `Send exactly ${amountMajor} to ${full ? r.recipient_msisdn : mask(r.recipient_msisdn)}${r.recipient_name ? ` (${r.recipient_name})` : ''}`, `Use ${r.reference} as the reason / note if the operator allows one`, 'Keep the confirmation SMS on the device – the forwarder submits it automatically']
    : [`Pay exactly ${amountMajor} from the treasury bank account to the recipient's bank account`, `Quote ${r.reference} as the payment reference`, 'Forward the bank confirmation / statement line as evidence'];
  return {
    id: r.id, reference: r.reference, routeId: r.route_id, transactionId: r.transaction_id, userId: r.user_id, corridorId: r.corridor_id, payoutAccountId: r.payout_account_id, payoutAccount: account, agent: agent ? toPublicUser(agent) : null, rail: r.rail, operatorId: r.operator_id, operatorName,
    recipientMsisdn: full ? r.recipient_msisdn : null, recipientMasked: mask(r.recipient_msisdn), recipientName: r.recipient_name, bankDetails: full ? parseJson(r.bank_details, null) : null,
    amount: r.amount, currency: r.currency, stage: r.stage, claimedByDeviceId: r.claimed_by_device_id, claimedByUserId: r.claimed_by_user_id, claimedAt: r.claimed_at, evidenceId: r.evidence_id, externalRef: r.external_ref, attempts: r.attempts, riskFlags: parseJson(r.risk_flags, []), error: r.error, expiresAt: r.expires_at,
    instructions: OPEN.includes(r.stage) ? { ussd, steps } : null, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function row(id: string): any {
  const r = getDb().prepare('SELECT * FROM payout_instructions WHERE id = ?').get(id);
  if (!r) throw notFound('Payout not found', 'payout_not_found');
  return r;
}
function setStage(id: string, stage: PayoutStage, actor: Actor, details: Record<string, unknown> = {}, fields: Record<string, unknown> = {}) {
  const r = row(id);
  const keys = Object.keys(fields);
  getDb().prepare(`UPDATE payout_instructions SET stage = ?, updated_at = ?${keys.map((k) => `, ${k} = ?`).join('')} WHERE id = ?`).run(stage, now(), ...keys.map((k) => fields[k]), id);
  recordEvent('payout', id, `payout.${stage.toLowerCase()}`, actor, { from: r.stage, to: stage, ...details });
}
const ROUTE_FOR: Partial<Record<PayoutStage, 'PAYOUT_QUEUED' | 'PAYOUT_IN_PROGRESS' | 'EVIDENCE_RECEIVED' | 'VERIFYING' | 'SETTLED' | 'FAILED' | 'MISMATCHED' | 'DUPLICATE' | 'LIQUIDITY_UNAVAILABLE' | 'MANUAL_REVIEW' | 'EXPIRED'>> = { QUEUED: 'PAYOUT_QUEUED', IN_PROGRESS: 'PAYOUT_IN_PROGRESS', EVIDENCE_RECEIVED: 'EVIDENCE_RECEIVED', VERIFYING: 'VERIFYING', SETTLED: 'SETTLED', FAILED: 'FAILED', MISMATCHED: 'MISMATCHED', DUPLICATE: 'DUPLICATE', LIQUIDITY_UNAVAILABLE: 'LIQUIDITY_UNAVAILABLE', MANUAL_REVIEW: 'MANUAL_REVIEW', EXPIRED: 'MANUAL_REVIEW' };
function syncRoute(r: any, stage: PayoutStage, actor: Actor, details: Record<string, unknown> = {}) {
  const target = ROUTE_FOR[stage];
  if (r.route_id && target) tryTransitionRoute(r.route_id, target, actor, { payoutId: r.id, ...details });
}

export interface CreatePayoutInput {
  transactionId: string;
  userId: string;
  routeId?: string | null;
  rail: 'mobile_money' | 'bank';
  operatorId?: string | null;
  recipientMsisdn?: string | null;
  recipientName?: string | null;
  bankDetails?: Record<string, unknown> | null;
  country?: string | null;
  amount: number;
  currency: string;
  sourceCurrency?: string | null;
  sourceCountry?: string | null;
}

/** Create and route a payout instruction. Picks a prefunded account now; LIQUIDITY_UNAVAILABLE keeps the funds safely held. */
export function createPayoutInstruction(input: CreatePayoutInput, actor: Actor = { type: 'system' }): PayoutView {
  const tx = getTransaction(input.transactionId);
  if (!tx) throw badRequest('Transaction not found');
  const op = input.operatorId ? getOperator(input.operatorId) : null;
  const country = (input.country ?? op?.country ?? '').toUpperCase();
  const corridor: Corridor | null = country ? ensureCorridor({ sourceCountry: input.sourceCountry ?? null, sourceCurrency: input.sourceCurrency ?? input.currency, destCountry: country, destCurrency: input.currency, operatorId: input.operatorId ?? null, rail: input.rail }) : null;
  const account = selectPayoutAccount({ rail: input.rail, operatorId: input.operatorId ?? null, currency: input.currency, amount: input.amount, country });
  const id = uuid();
  const reference = `PO${shortCode(8)}`;
  const stage: PayoutStage = account ? 'QUEUED' : 'LIQUIDITY_UNAVAILABLE';
  const expiresAt = new Date(Date.now() + getGatewayControls().intentExpiryHours * 3600_000).toISOString();
  getDb().prepare(
    `INSERT INTO payout_instructions (id, reference, route_id, transaction_id, user_id, corridor_id, payout_account_id, agent_user_id, rail, operator_id, recipient_msisdn, recipient_name, bank_details, amount, currency, stage, attempts, risk_flags, error, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '[]', ?, ?, ?, ?)`,
  ).run(id, reference, input.routeId ?? null, input.transactionId, input.userId, corridor?.id ?? null, account?.id ?? null, account?.agent?.id ?? null, input.rail, input.operatorId ?? null, input.recipientMsisdn ?? null, input.recipientName ?? null, input.bankDetails ? JSON.stringify(input.bankDetails) : null, input.amount, input.currency, stage, account ? null : 'No prefunded payout account with enough float for this corridor', expiresAt, now(), now());
  if (input.routeId) getDb().prepare('UPDATE money_routes SET payout_id = ?, corridor_id = COALESCE(corridor_id, ?) WHERE id = ?').run(id, corridor?.id ?? null, input.routeId);
  recordEvent('payout', id, 'payout.created', actor, { reference, rail: input.rail, operatorId: input.operatorId ?? null, amount: input.amount, currency: input.currency, corridorId: corridor?.id ?? null, payoutAccountId: account?.id ?? null, stage, recipient: mask(input.recipientMsisdn ?? null) });
  const r = row(id);
  syncRoute(r, stage, actor);
  if (!account) recordEvent('liquidity', corridor?.id ?? id, 'liquidity.unavailable', actor, { payoutId: id, rail: input.rail, operatorId: input.operatorId ?? null, currency: input.currency, amount: input.amount });
  return toView(r);
}

export function getPayout(id: string, full = true): PayoutView {
  return toView(row(id), full);
}
export function getPayoutByTransaction(transactionId: string): PayoutView | null {
  const r = getDb().prepare('SELECT * FROM payout_instructions WHERE transaction_id = ? ORDER BY created_at DESC LIMIT 1').get(transactionId);
  return r ? toView(r) : null;
}

export function listPayouts(filter: { stage?: string | null; stages?: string[]; payoutAccountId?: string | null; agentUserId?: string | null; userId?: string | null; page?: number; pageSize?: number } = {}): { items: PayoutView[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.stage) { where.push('stage = ?'); params.push(filter.stage); }
  if (filter.stages?.length) { where.push(`stage IN (${filter.stages.map(() => '?').join(',')})`); params.push(...filter.stages); }
  if (filter.payoutAccountId) { where.push('payout_account_id = ?'); params.push(filter.payoutAccountId); }
  if (filter.agentUserId) { where.push('agent_user_id = ?'); params.push(filter.agentUserId); }
  if (filter.userId) { where.push('user_id = ?'); params.push(filter.userId); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const pageSize = filter.pageSize ?? 50;
  const page = filter.page ?? 1;
  const db = getDb();
  const total = (db.prepare(`SELECT COUNT(*) c FROM payout_instructions ${whereSql}`).get(...params) as any).c as number;
  const rows = db.prepare(`SELECT * FROM payout_instructions ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as any[];
  return { items: rows.map((r) => toView(r)), total };
}

/** Work queue for one device (its payout account) or one agent. */
export function queueFor(who: { device?: EvidenceDevice | null; agent?: UserRow | null }): PayoutView[] {
  const db = getDb();
  if (who.device) {
    if (who.device.kind !== 'payout' || !who.device.payoutAccountId) throw forbidden('This device is not assigned to a payout account', 'device_not_payout');
    return (db.prepare("SELECT * FROM payout_instructions WHERE payout_account_id = ? AND stage IN ('QUEUED', 'IN_PROGRESS') ORDER BY created_at ASC LIMIT 50").all(who.device.payoutAccountId) as any[]).map((r) => toView(r));
  }
  if (who.agent) {
    return (db.prepare("SELECT p.* FROM payout_instructions p LEFT JOIN payout_accounts a ON a.id = p.payout_account_id WHERE (p.agent_user_id = ? OR a.agent_user_id = ?) AND p.stage IN ('QUEUED', 'IN_PROGRESS', 'MISMATCHED', 'DUPLICATE') ORDER BY p.created_at ASC LIMIT 50").all(who.agent.id, who.agent.id) as any[]).map((r) => toView(r));
  }
  return [];
}

function actorFor(who: { device?: EvidenceDevice | null; agent?: UserRow | null }): Actor {
  return who.device ? { type: 'device', id: who.device.id } : { type: 'agent', id: who.agent?.id ?? null };
}
function assertOwner(r: any, who: { device?: EvidenceDevice | null; agent?: UserRow | null }) {
  if (who.device) {
    if (who.device.kind !== 'payout') throw forbidden('Only payout devices can execute payouts', 'device_not_payout');
    if (!r.payout_account_id || who.device.payoutAccountId !== r.payout_account_id) throw forbidden('This payout belongs to another payout account', 'payout_not_yours');
    return;
  }
  if (who.agent) {
    const acc = r.payout_account_id ? getPayoutAccount(r.payout_account_id) : null;
    if (r.agent_user_id !== who.agent.id && acc?.agent?.id !== who.agent.id) throw forbidden('This payout is not assigned to you', 'payout_not_yours');
    return;
  }
  throw forbidden();
}

/** Claim = the device / agent is about to execute the local transfer. */
export function claimPayout(id: string, who: { device?: EvidenceDevice | null; agent?: UserRow | null }): PayoutView {
  const r = row(id);
  assertOwner(r, who);
  if (r.stage !== 'QUEUED') throw conflict(`Payout is ${r.stage.toLowerCase().replace(/_/g, ' ')}`, 'invalid_stage_transition');
  const c = getComplianceSettings();
  // Route-level holds (chargeback exposure) are enforced on the route; a queued instruction is executable.
  setStage(id, 'IN_PROGRESS', actorFor(who), {}, { claimed_by_device_id: who.device?.id ?? null, claimed_by_user_id: who.agent?.id ?? null, claimed_at: now(), attempts: r.attempts + 1, expires_at: new Date(Date.now() + c.payoutClaimMinutes * 60_000).toISOString() });
  syncRoute(r, 'IN_PROGRESS', actorFor(who));
  return getPayout(id);
}

/** Give a claimed payout back to the queue (device failed / USSD error). */
export function releasePayout(id: string, who: { device?: EvidenceDevice | null; agent?: UserRow | null } | null, reason: string, actor?: Actor): PayoutView {
  const r = row(id);
  if (who) assertOwner(r, who);
  if (r.stage !== 'IN_PROGRESS') throw conflict(`Payout is ${r.stage.toLowerCase()}`, 'invalid_stage_transition');
  setStage(id, 'QUEUED', actor ?? actorFor(who!), { reason }, { claimed_by_device_id: null, claimed_by_user_id: null, claimed_at: null, error: reason });
  syncRoute(r, 'QUEUED', actor ?? actorFor(who!));
  return getPayout(id);
}

export interface PayoutEvidenceInput extends IngestInput {
  /** SIM identity (MSISDN or ICCID) reported by the device – must match its registration. */
  simIdentity?: string | null;
  /** Device-side timestamp of submission. */
  deviceTimestamp?: string | null;
  /** sha256 of the raw text computed on the device – detects alteration in transit. */
  clientHash?: string | null;
}

/**
 * Signed operator SMS confirming the outbound transfer. Verifies the device and SIM, parses the
 * message, matches recipient / amount / currency / operator / timing, detects reuse, and settles.
 */
export function submitPayoutEvidence(id: string, input: PayoutEvidenceInput): { payout: PayoutView; evidenceId: string; outcome: string; reasons: string[] } {
  const r = row(id);
  const db = getDb();
  let device: EvidenceDevice | null = null;
  if (input.source === 'signed_device') {
    device = authenticateDevice(input);
    if (device.kind !== 'payout') throw forbidden('Only registered payout devices may submit payout evidence', 'device_not_payout');
    if (device.payoutAccountId !== r.payout_account_id) throw forbidden('This device is not assigned to the payout account of this instruction', 'payout_not_yours');
  }
  const reasons: string[] = [];
  const text = input.text;
  const rawHash = sha256(`out|${r.id}|${input.operatorId ?? ''}|${input.from ?? ''}|${text.trim()}`);
  if (input.clientHash && input.clientHash.toLowerCase() !== sha256(text).toLowerCase()) reasons.push('client_hash_mismatch');
  if (device) {
    const sims = [device.simMsisdn, device.simIccid].filter(Boolean).map((s) => String(s).replace(/\s/g, ''));
    if (!input.simIdentity) reasons.push('sim_identity_missing');
    else if (!sims.some((s) => s === input.simIdentity!.replace(/\s/g, '') || normalizePhoneDigits(s) === normalizePhoneDigits(input.simIdentity!))) reasons.push('unregistered_sim');
  }
  const parsed = parseEvidenceText(text, input.operatorId ?? r.operator_id);
  const cur = getCurrency(r.currency, false);
  let outcome: 'settled' | 'review' | 'mismatched' | 'duplicate' | 'unsupported' = 'review';

  const priorSame = db.prepare("SELECT id FROM payment_evidence WHERE raw_hash = ? AND outcome IN ('settled','review','matched')").get(rawHash);
  if (priorSame) {
    outcome = 'duplicate';
    reasons.push('duplicate_submission');
  } else if (r.stage === 'SETTLED') {
    outcome = 'duplicate';
    reasons.push('payout_already_settled');
  } else {
    if (parsed.externalRef) {
      const reused = db.prepare("SELECT id, payout_id FROM payment_evidence WHERE direction = 'out' AND external_ref = ? AND outcome = 'settled' AND payout_id != ?").get(parsed.externalRef, r.id) as any;
      if (reused) {
        outcome = 'duplicate';
        reasons.push(`external_ref_reused:${reused.payout_id}`);
      }
    }
    if (outcome !== 'duplicate') {
      const checks: string[] = [];
      if (!parsed.amount) checks.push('amount_missing');
      else if (toMinor(parsed.amount, cur.decimals) !== r.amount) checks.push('amount_mismatch');
      if (parsed.currency && parsed.currency !== r.currency) checks.push('currency_mismatch');
      if (r.rail === 'mobile_money') {
        if (!parsed.recipient) checks.push('recipient_missing');
        else if (normalizePhoneDigits(parsed.recipient) !== normalizePhoneDigits(r.recipient_msisdn ?? '')) checks.push('recipient_mismatch');
      }
      if (input.operatorId && r.operator_id && input.operatorId !== r.operator_id) checks.push('operator_mismatch');
      const received = input.receivedAt ? new Date(input.receivedAt).getTime() : Date.now();
      if (r.claimed_at && received < new Date(r.claimed_at).getTime() - 2 * 60_000) checks.push('impossible_sequence:evidence_before_claim');
      if (received < new Date(r.created_at).getTime() - 2 * 60_000) checks.push('impossible_sequence:evidence_before_instruction');
      if (received > Date.now() + 5 * 60_000) checks.push('evidence_in_future');
      if (received > new Date(r.created_at).getTime() + getGatewayControls().evidenceWindowHours * 3600_000) checks.push('outside_time_window');
      if (!parsed.externalRef) checks.push('operator_reference_missing');
      if (checks.length) {
        outcome = 'mismatched';
        reasons.push(...checks);
      } else outcome = 'settled';
    }
  }
  // Abnormal payout patterns: the same recipient hammered from one account / device, or collusion signals.
  const c = getComplianceSettings();
  if (outcome === 'settled' && r.recipient_msisdn) {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const n = (db.prepare("SELECT COUNT(*) c FROM payout_instructions WHERE recipient_msisdn = ? AND stage = 'SETTLED' AND updated_at >= ?").get(r.recipient_msisdn, since) as any).c as number;
    if (c.maxPayoutsPerRecipientPerDay && n >= c.maxPayoutsPerRecipientPerDay) reasons.push(`abnormal_pattern:recipient_${n}_payouts_24h`);
    if (r.payout_account_id) {
      const acc = getPayoutAccount(r.payout_account_id);
      if (acc.agent && r.recipient_msisdn && acc.msisdn && normalizePhoneDigits(acc.msisdn) === normalizePhoneDigits(r.recipient_msisdn)) reasons.push('collusion:payout_to_own_sim');
      const agent = acc.agent ? findUserById(acc.agent.id) : null;
      if (agent?.phone && normalizePhoneDigits(agent.phone) === normalizePhoneDigits(r.recipient_msisdn)) reasons.push('collusion:payout_to_agent_phone');
      if (acc.dailyLimit && acc.paidToday + r.amount > acc.dailyLimit) reasons.push('device_daily_limit_exceeded');
    }
  }
  const trusted = input.source === 'signed_device' && !!device && device.riskScore < 50 && !reasons.some((x) => x === 'unregistered_sim' || x === 'client_hash_mismatch' || x === 'sim_identity_missing');
  // Outbound receipts carry no platform reference, so the bar is amount + recipient + operator id (max 50) rather than the inbound score.
  const confident = parsed.confidence >= Math.min(getGatewayControls().autoConfirmScore, 45);
  const autoSettle = outcome === 'settled' && trusted && confident && !reasons.length;
  if (outcome === 'settled' && !autoSettle) {
    outcome = 'review';
    if (!trusted) reasons.push(input.source === 'manual' ? 'manual_entry_needs_approval' : 'device_not_trusted');
    if (!confident) reasons.push(`confidence_${parsed.confidence}`);
  }
  const verifier = device ? { type: 'device', id: device.id } : { type: input.actor.type, id: input.actor.id ?? null };
  const evidenceId = storeEvidence({ payoutId: r.id, direction: 'out', deviceId: device?.id ?? null, source: input.source, operatorId: input.operatorId ?? r.operator_id, sender: input.from ?? null, rawText: text, rawHash, receivedAt: input.receivedAt ?? null, parsed, outcome, reasons, nonce: input.nonce ?? null, signature: input.signature ?? null, verifier, simIdentity: input.simIdentity ?? null, operatorTimestamp: parsed.timestamp, clientHash: input.clientHash ?? null });
  recordEvent('evidence', r.id, 'payout_evidence.received', input.actor, { evidenceId, outcome, confidence: parsed.confidence, reasons, externalRef: parsed.externalRef, sim: input.simIdentity ? `…${input.simIdentity.slice(-4)}` : null });
  const actor: Actor = device ? { type: 'device', id: device.id } : input.actor;
  if (OPEN.includes(r.stage)) {
    if (autoSettle) {
      setStage(r.id, 'EVIDENCE_RECEIVED', actor, { evidenceId }, { evidence_id: evidenceId });
      syncRoute(r, 'EVIDENCE_RECEIVED', actor);
      setStage(r.id, 'VERIFYING', actor, { evidenceId });
      syncRoute(r, 'VERIFYING', actor);
      settlePayout(r.id, actor, { evidenceId, externalRef: parsed.externalRef, source: input.source });
    } else if (outcome === 'review') {
      setStage(r.id, 'MANUAL_REVIEW', actor, { evidenceId, reasons }, { evidence_id: evidenceId, risk_flags: JSON.stringify(reasons) });
      syncRoute(r, 'MANUAL_REVIEW', actor, { reasons });
    } else if (outcome === 'mismatched') {
      if (device) bumpDeviceRisk(device.id, 5);
      setStage(r.id, 'MISMATCHED', actor, { evidenceId, reasons }, { evidence_id: evidenceId, risk_flags: JSON.stringify(reasons) });
      syncRoute(r, 'MISMATCHED', actor, { reasons });
    } else if (outcome === 'duplicate' && r.stage !== 'SETTLED') {
      if (device) bumpDeviceRisk(device.id, 10);
      setStage(r.id, 'DUPLICATE', actor, { evidenceId, reasons }, { risk_flags: JSON.stringify(reasons) });
      syncRoute(r, 'DUPLICATE', actor, { reasons });
    }
  }
  return { payout: getPayout(r.id), evidenceId, outcome, reasons };
}

/** The only path to SETTLED: release the sender's held funds and debit the float. */
export function settlePayout(id: string, actor: Actor, input: { evidenceId?: string | null; externalRef?: string | null; source: string; verificationId?: string | null; note?: string | null }): PayoutView {
  const db = getDb();
  return db.transaction(() => {
    const r = row(id);
    if (r.stage === 'SETTLED') return getPayout(id);
    if (!OPEN.includes(r.stage)) throw conflict(`Payout is ${r.stage.toLowerCase()}`, 'invalid_stage_transition');
    if (input.source === 'manual' && !input.verificationId) throw forbidden('Administrative settlement requires maker-checker approval', 'maker_checker');
    const tx = getTransaction(r.transaction_id)!;
    if (tx.status !== 'pending') throw conflict(`Held transaction is ${tx.status}`, 'invalid_status');
    const account = r.payout_account_id ? getPayoutAccount(r.payout_account_id) : null;
    completeTransaction(tx.id, { payoutId: r.id, payoutReference: r.reference, externalRef: input.externalRef ?? null, payoutAccountId: account?.id ?? null, evidenceId: input.evidenceId ?? null, settledVia: input.source });
    let floatTx: TransactionRow | null = null;
    if (account) floatTx = debitFloatForPayout(account, r.amount, r.id, r.reference, input.externalRef ?? null);
    setStage(id, 'SETTLED', actor, { evidenceId: input.evidenceId ?? null, externalRef: input.externalRef ?? null, source: input.source, verificationId: input.verificationId ?? null }, { evidence_id: input.evidenceId ?? r.evidence_id, external_ref: input.externalRef ?? null, float_transaction_id: floatTx?.id ?? null, error: null });
    syncRoute(r, 'SETTLED', actor, { externalRef: input.externalRef ?? null });
    const cur = getCurrency(r.currency, false);
    const sender = findUserById(r.user_id);
    if (sender) notify(sender.id, 'Payout delivered', `${formatMoney(r.amount, cur)} was delivered to ${r.recipient_name || mask(r.recipient_msisdn) || 'the recipient'} (${r.operator_id ? getOperator(r.operator_id).name : 'bank'}). Operator reference ${input.externalRef ?? r.reference}.`, { kind: 'payout', payoutId: r.id, transactionId: tx.id });
    if (r.recipient_msisdn) void sendSms(r.recipient_msisdn, `BitriPay: ${formatMoney(r.amount, cur)} was sent to you by ${sender?.full_name ?? 'a BitriPay user'}. Ref ${r.reference}${input.externalRef ? ` / ${input.externalRef}` : ''}.`).catch(() => {});
    return getPayout(id);
  })();
}

/** Payout could not be executed: return the held funds to the sender's wallet. */
export function failPayout(id: string, actor: Actor, reason: string, input: { verificationId?: string | null } = {}): PayoutView {
  const r = row(id);
  if (!OPEN.includes(r.stage) && r.stage !== 'EXPIRED') throw conflict(`Payout is ${r.stage.toLowerCase()}`, 'invalid_stage_transition');
  if (actor.type === 'admin' && !input.verificationId) throw forbidden('Failing a payout administratively requires maker-checker approval', 'maker_checker');
  const tx = getTransaction(r.transaction_id)!;
  if (tx.status === 'pending') reverseTransaction(tx.id, actor.type === 'admin' ? 'rejected' : 'failed', reason);
  setStage(id, 'FAILED', actor, { reason, verificationId: input.verificationId ?? null }, { error: reason });
  syncRoute(r, 'FAILED', actor, { reason });
  const sender = findUserById(r.user_id);
  if (sender) notify(sender.id, 'Payout failed', `${reason}. The funds are back in your wallet.`, { kind: 'payout', payoutId: r.id });
  return getPayout(id);
}

/** Cancel before execution (refund / chargeback flows). Returns held funds to the wallet. */
export function cancelPayout(id: string, actor: Actor, reason: string): PayoutView {
  const r = row(id);
  if (!['QUEUED', 'LIQUIDITY_UNAVAILABLE', 'MANUAL_REVIEW', 'EXPIRED', 'FAILED', 'MISMATCHED', 'DUPLICATE'].includes(r.stage)) throw conflict(`Payout is ${r.stage.toLowerCase().replace(/_/g, ' ')} and cannot be cancelled`, 'invalid_stage_transition');
  const tx = getTransaction(r.transaction_id)!;
  if (tx.status === 'pending') reverseTransaction(tx.id, 'cancelled', reason);
  setStage(id, 'CANCELLED', actor, { reason }, { error: reason });
  return getPayout(id);
}

/** Retry routing (after prefunding, or after a device failure). */
export function requeuePayout(id: string, actor: Actor): PayoutView {
  const r = row(id);
  if (!['LIQUIDITY_UNAVAILABLE', 'FAILED', 'EXPIRED', 'MANUAL_REVIEW', 'MISMATCHED', 'DUPLICATE'].includes(r.stage)) throw conflict(`Payout is ${r.stage.toLowerCase()}`, 'invalid_stage_transition');
  const tx = getTransaction(r.transaction_id)!;
  if (tx.status !== 'pending') throw conflict('Held funds were already released; create a new transfer', 'invalid_status');
  const account = selectPayoutAccount({ rail: r.rail, operatorId: r.operator_id, currency: r.currency, amount: r.amount });
  if (!account) {
    if (r.stage !== 'LIQUIDITY_UNAVAILABLE') {
      setStage(id, 'LIQUIDITY_UNAVAILABLE', actor, {}, { error: 'No prefunded payout account with enough float', payout_account_id: null });
      syncRoute(r, 'LIQUIDITY_UNAVAILABLE', actor);
    }
    return getPayout(id);
  }
  setStage(id, 'QUEUED', actor, { payoutAccountId: account.id }, { payout_account_id: account.id, agent_user_id: account.agent?.id ?? null, claimed_by_device_id: null, claimed_by_user_id: null, claimed_at: null, error: null, expires_at: new Date(Date.now() + getGatewayControls().intentExpiryHours * 3600_000).toISOString() });
  syncRoute(r, 'QUEUED', actor);
  return getPayout(id);
}

/** Retry every payout waiting on liquidity for this account's rail/operator/currency (after a prefund). */
export function requeueWaiting(account: PayoutAccount, actor: Actor): number {
  const rows = getDb().prepare("SELECT id FROM payout_instructions WHERE stage = 'LIQUIDITY_UNAVAILABLE' AND rail = ? AND currency = ? AND (operator_id IS ? OR ? IS NULL) ORDER BY created_at ASC").all(account.rail, account.currency, account.operatorId, account.operatorId) as { id: string }[];
  let n = 0;
  for (const r of rows) if (requeuePayout(r.id, actor).stage === 'QUEUED') n += 1;
  return n;
}

/** Stale claims go back to the queue; queued payouts past expiry go to manual review with funds still held. */
export function expirePayouts(): { released: number; expired: number } {
  const db = getDb();
  let released = 0;
  let expired = 0;
  for (const r of db.prepare("SELECT * FROM payout_instructions WHERE stage = 'IN_PROGRESS' AND expires_at < ?").all(now()) as any[]) {
    releasePayout(r.id, null, 'Claim expired without evidence', { type: 'system' });
    released += 1;
  }
  for (const r of db.prepare("SELECT * FROM payout_instructions WHERE stage IN ('QUEUED', 'LIQUIDITY_UNAVAILABLE') AND expires_at < ?").all(now()) as any[]) {
    setStage(r.id, 'EXPIRED', { type: 'system' }, {}, { error: 'Not executed before expiry' });
    syncRoute(r, 'EXPIRED', { type: 'system' }, { reason: 'payout_expired' });
    expired += 1;
  }
  return { released, expired };
}

export function payoutCase(id: string) {
  const p = getPayout(id);
  const tx = getTransaction(p.transactionId);
  return { payout: p, transaction: tx ? { id: tx.id, reference: tx.reference, status: tx.status, amount: tx.amount, fee: tx.fee, currency: tx.currency } : null, sender: (() => { const u = findUserById(p.userId); return u ? toPublicUser(u) : null; })(), evidence: listEvidence({ payoutId: id }).items, events: listEvents({ subjectId: id, limit: 200 }).items };
}
