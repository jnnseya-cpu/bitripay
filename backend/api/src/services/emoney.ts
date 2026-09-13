/**
 * E-MONEY ISSUANCE ENGINE.
 *
 * BitriPay balances are a redeemable claim on the authorised issuer, never bank deposit money. Every unit of
 * customer-facing e-money must be backed 1:1 by cleared safeguarded funds in the same currency:
 *
 *     issuable ≤ cleared safeguarded funds − redemptions pending − reserved exposure − e-money already outstanding
 *
 * Programmes describe who the legal issuer is per currency and jurisdiction (BitriPay's own authorisation or a
 * licensed bank / EMI partner). Reserve movements record cleared funding, redemptions and liquidity transfers with
 * maker-checker confirmation. Distribution pools move already-issued e-money down the hierarchy
 * (issuer → treasury → country pool → institution / master agent → agent / merchant → user); they never create it.
 * Reconciliation compares reserves with liabilities and suspends issuance on a breach.
 *
 * Sandbox programmes exist so the flow can be demonstrated; their balances are labelled and carry no real-world value.
 */
import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { parseJson } from '../lib/json';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { getCurrency } from './currencies';
import { getComplianceSettings, getEmoneySettings } from './settings';
import { recordEvent, type Actor } from './events';
import { createUser, findUserById, toPublicUser, type UserRow } from './users';
import { ensureWallet, getUserWallet, getWallet, type WalletRow } from './wallets';
import { postTransaction, type TransactionRow } from './ledger';
import { notify } from './notifications';
import { formatMoney } from '@bitripay/shared';

export type IssuerModel = 'own_authorisation' | 'partner_issuer' | 'sandbox';
export type ProgrammeStatus = 'sandbox' | 'live' | 'suspended';
export type ReserveKind = 'funding' | 'redemption' | 'liquidity_transfer' | 'processor_settlement' | 'adjustment';
export type PoolLevel = 'country' | 'institution' | 'master_agent' | 'agent' | 'merchant';

export interface Programme {
  id: string;
  currency: string;
  jurisdiction: string;
  issuerModel: IssuerModel;
  issuerName: string | null;
  licenceRef: string | null;
  regulator: string | null;
  safeguardingBank: string | null;
  safeguardingAccountRef: string | null;
  status: ProgrammeStatus;
  suspendedReason: string | null;
  reservedExposure: number;
  limits: { maxIssuancePerRequest?: number; dailyIssuanceLimit?: number; maxHolderBalance?: number };
  position: ReservePosition;
  readiness: { ready: boolean; missing: string[] };
  createdAt: string;
  updatedAt: string;
}

/** Live reserve position of a programme in minor units of its currency. */
export interface ReservePosition {
  clearedReserves: number;
  pendingInflows: number;
  pendingRedemptions: number;
  reservedExposure: number;
  /** E-money outstanding: balances of users, merchants, agents and distribution pools (redeemable claims). */
  liabilities: number;
  poolBalances: number;
  /** Ledger mirror of money already moved into prefunded payout accounts – an asset, not a liability. */
  payoutFloat: number;
  /** Cleared reserves − pending redemptions − reserved exposure − liabilities. New issuance may not exceed this. */
  headroom: number;
  /** Coverage including pending processor settlements (receivables). */
  coverage: number;
  status: 'ok' | 'warning' | 'breach';
  sandbox: boolean;
}

export interface ReserveMovement {
  id: string;
  programmeId: string;
  kind: ReserveKind;
  direction: 'in' | 'out';
  amount: number;
  currency: string;
  status: 'pending' | 'cleared' | 'reversed';
  reference: string | null;
  evidence: Record<string, unknown> | null;
  proposedBy: string | null;
  clearedBy: string | null;
  verificationId: string | null;
  transactionId: string | null;
  note: string | null;
  createdAt: string;
  clearedAt: string | null;
}

export interface Pool {
  id: string;
  programmeId: string;
  name: string;
  level: PoolLevel;
  parentId: string | null;
  owner: ReturnType<typeof toPublicUser> | null;
  country: string | null;
  currency: string;
  walletUserId: string;
  balance: number;
  status: string;
  limits: Record<string, number>;
  createdAt: string;
}

// ---------------------------------------------------------------------------------------------
// Programmes
// ---------------------------------------------------------------------------------------------
function programmeReadiness(r: any): { ready: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!r.issuer_model || r.issuer_model === 'sandbox') missing.push('Issuer model: BitriPay authorisation or a licensed partner issuer');
  if (!r.issuer_name) missing.push('Legal issuer name');
  if (!r.licence_ref) missing.push('E-money authorisation / licence reference');
  if (!r.regulator) missing.push('Regulator');
  if (!r.safeguarding_bank || !r.safeguarding_account_ref) missing.push('Safeguarding account (bank and account reference)');
  return { ready: missing.length === 0, missing };
}

function toProgramme(r: any): Programme {
  return {
    id: r.id, currency: r.currency, jurisdiction: r.jurisdiction, issuerModel: r.issuer_model, issuerName: r.issuer_name, licenceRef: r.licence_ref, regulator: r.regulator, safeguardingBank: r.safeguarding_bank, safeguardingAccountRef: r.safeguarding_account_ref,
    status: r.status, suspendedReason: r.suspended_reason, reservedExposure: r.reserved_exposure, limits: parseJson(r.limits, {}), position: reservePosition(r), readiness: programmeReadiness(r), createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function listProgrammes(): Programme[] {
  return (getDb().prepare('SELECT * FROM emoney_programmes ORDER BY currency, jurisdiction').all() as any[]).map(toProgramme);
}
export function getProgramme(id: string): Programme {
  const r = getDb().prepare('SELECT * FROM emoney_programmes WHERE id = ?').get(id);
  if (!r) throw notFound('E-money programme not found', 'programme_not_found');
  return toProgramme(r);
}
function programmeRow(id: string): any {
  const r = getDb().prepare('SELECT * FROM emoney_programmes WHERE id = ?').get(id);
  if (!r) throw notFound('E-money programme not found', 'programme_not_found');
  return r;
}

/**
 * The programme that governs a currency. In sandbox compliance mode a labelled sandbox programme is created on
 * demand so development flows work; in live mode a currency without a live programme cannot be issued at all.
 */
export function programmeForCurrency(currency: string, jurisdiction?: string | null): any | null {
  const db = getDb();
  const code = currency.toUpperCase();
  const rows = db.prepare('SELECT * FROM emoney_programmes WHERE currency = ? ORDER BY CASE status WHEN \'live\' THEN 0 WHEN \'suspended\' THEN 1 ELSE 2 END').all(code) as any[];
  if (jurisdiction) {
    const j = rows.find((r) => r.jurisdiction === jurisdiction.toUpperCase());
    if (j) return j;
  }
  if (rows.length) return rows[0];
  if (getComplianceSettings().mode !== 'sandbox') return null;
  return upsertProgrammeRow({ currency: code, jurisdiction: 'SANDBOX', issuerModel: 'sandbox', status: 'sandbox' }, { type: 'system' });
}

function upsertProgrammeRow(input: { id?: string; currency: string; jurisdiction: string; issuerModel?: IssuerModel; issuerName?: string | null; licenceRef?: string | null; regulator?: string | null; safeguardingBank?: string | null; safeguardingAccountRef?: string | null; status?: ProgrammeStatus; reservedExposure?: number; limits?: Record<string, number> }, actor: Actor, createdBy?: string | null): any {
  const db = getDb();
  getCurrency(input.currency, false);
  const existing = input.id ? programmeRow(input.id) : (db.prepare('SELECT * FROM emoney_programmes WHERE currency = ? AND jurisdiction = ?').get(input.currency.toUpperCase(), input.jurisdiction.toUpperCase()) as any);
  const id = existing?.id ?? uuid();
  const model = input.issuerModel ?? existing?.issuer_model ?? 'sandbox';
  const status = input.status ?? existing?.status ?? (model === 'sandbox' ? 'sandbox' : 'sandbox');
  db.prepare(
    `INSERT INTO emoney_programmes (id, currency, jurisdiction, issuer_model, issuer_name, licence_ref, regulator, safeguarding_bank, safeguarding_account_ref, status, suspended_reason, reserved_exposure, limits, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET issuer_model = excluded.issuer_model, issuer_name = excluded.issuer_name, licence_ref = excluded.licence_ref, regulator = excluded.regulator, safeguarding_bank = excluded.safeguarding_bank, safeguarding_account_ref = excluded.safeguarding_account_ref, reserved_exposure = excluded.reserved_exposure, limits = excluded.limits, updated_at = excluded.updated_at`,
  ).run(id, input.currency.toUpperCase(), input.jurisdiction.toUpperCase(), model, input.issuerName ?? existing?.issuer_name ?? null, input.licenceRef ?? existing?.licence_ref ?? null, input.regulator ?? existing?.regulator ?? null, input.safeguardingBank ?? existing?.safeguarding_bank ?? null, input.safeguardingAccountRef ?? existing?.safeguarding_account_ref ?? null, status, existing?.suspended_reason ?? null, input.reservedExposure ?? existing?.reserved_exposure ?? 0, JSON.stringify(input.limits ?? parseJson(existing?.limits, {})), createdBy ?? existing?.created_by ?? null, existing?.created_at ?? now(), now());
  recordEvent('issuance', id, existing ? 'programme.updated' : 'programme.created', actor, { currency: input.currency.toUpperCase(), jurisdiction: input.jurisdiction.toUpperCase(), issuerModel: model, status });
  return programmeRow(id);
}

export function upsertProgramme(input: Parameters<typeof upsertProgrammeRow>[0], admin: UserRow): Programme {
  if (input.status) throw badRequest('Programme status is changed through the go-live / suspend actions', 'validation_error');
  return toProgramme(upsertProgrammeRow(input, { type: 'admin', id: admin.id }, admin.id));
}

/** Going live: the arrangements must be on record, the platform must be out of sandbox mode and the reserve position clean. */
export function setProgrammeStatus(id: string, status: ProgrammeStatus, admin: UserRow, reason?: string | null): Programme {
  const r = programmeRow(id);
  if (status === 'live') {
    const readiness = programmeReadiness(r);
    if (!readiness.ready) throw badRequest(`This programme cannot issue live e-money yet: ${readiness.missing.join('; ')}`, 'programme_arrangements_required', readiness);
    if (getComplianceSettings().mode !== 'live') throw forbidden('Switch the platform out of sandbox mode (go-live checklist) before a programme can issue live e-money', 'go_live_blocked');
    const pos = reservePosition({ ...r, status: 'live' });
    if (pos.status === 'breach') throw unprocessable(`Outstanding balances (${pos.liabilities}) exceed the cleared safeguarded reserves (${pos.clearedReserves}); fund the safeguarding account first`, 'reserve_breach', pos);
  }
  getDb().prepare('UPDATE emoney_programmes SET status = ?, suspended_reason = ?, updated_at = ? WHERE id = ?').run(status, status === 'suspended' ? reason ?? 'Suspended by administrator' : null, now(), id);
  recordEvent('issuance', id, `programme.${status}`, { type: 'admin', id: admin.id }, { reason: reason ?? null });
  return getProgramme(id);
}

// ---------------------------------------------------------------------------------------------
// Reserve position
// ---------------------------------------------------------------------------------------------
function sum(sql: string, ...params: unknown[]): number {
  return ((getDb().prepare(sql).get(...params) as any)?.s as number) ?? 0;
}

/** Outstanding e-money in a currency = every balance that is a redeemable claim (users + distribution pools). */
export function outstandingLiabilities(currency: string): { users: number; pools: number } {
  const users = sum("SELECT COALESCE(SUM(w.balance), 0) s FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.is_system = 0 AND w.currency = ?", currency);
  const pools = sum("SELECT COALESCE(SUM(w.balance), 0) s FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.is_system = 1 AND u.tag LIKE 'pool_%' AND w.currency = ?", currency);
  return { users, pools };
}

export function reservePosition(r: any): ReservePosition {
  const cur = r.currency as string;
  const clearedIn = sum("SELECT COALESCE(SUM(amount), 0) s FROM reserve_movements WHERE programme_id = ? AND status = 'cleared' AND direction = 'in'", r.id);
  const clearedOut = sum("SELECT COALESCE(SUM(amount), 0) s FROM reserve_movements WHERE programme_id = ? AND status = 'cleared' AND direction = 'out'", r.id);
  const pendingInflows = sum("SELECT COALESCE(SUM(amount), 0) s FROM reserve_movements WHERE programme_id = ? AND status = 'pending' AND direction = 'in'", r.id);
  const pendingRedemptions = sum("SELECT COALESCE(SUM(amount + fee), 0) s FROM transactions WHERE type = 'withdrawal' AND status = 'pending' AND currency = ?", cur) + sum("SELECT COALESCE(SUM(amount), 0) s FROM reserve_movements WHERE programme_id = ? AND status = 'pending' AND direction = 'out'", r.id);
  const liab = outstandingLiabilities(cur);
  const payoutFloat = sum("SELECT COALESCE(SUM(w.balance), 0) s FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.is_system = 1 AND u.tag LIKE 'payout_%' AND w.currency = ?", cur);
  const clearedReserves = clearedIn - clearedOut;
  const liabilities = liab.users + liab.pools;
  const reservedExposure = r.reserved_exposure ?? 0;
  const headroom = clearedReserves - pendingRedemptions - reservedExposure - liabilities;
  const coverage = clearedReserves + pendingInflows - pendingRedemptions - reservedExposure - liabilities;
  const sandbox = r.status === 'sandbox';
  const status: ReservePosition['status'] = sandbox ? 'ok' : coverage < 0 ? 'breach' : headroom < 0 ? 'warning' : 'ok';
  return { clearedReserves, pendingInflows, pendingRedemptions, reservedExposure, liabilities, poolBalances: liab.pools, payoutFloat, headroom, coverage, status, sandbox };
}

/**
 * The core acceptance rule, enforced before any administrative issuance:
 * spendable e-money must never exceed verified safeguarded reserves.
 */
export function assertIssuable(programme: any, amount: number): ReservePosition {
  if (programme.status === 'suspended') throw forbidden(`Issuance is suspended for ${programme.currency}: ${programme.suspended_reason ?? 'reconciliation failure'}`, 'issuance_suspended');
  const pos = reservePosition(programme);
  const limits = parseJson<Programme['limits']>(programme.limits, {});
  if (limits.maxIssuancePerRequest && amount > limits.maxIssuancePerRequest) throw unprocessable('Amount exceeds the per-request issuance limit of this programme', 'issuance_limit');
  if (limits.dailyIssuanceLimit) {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const today = sum("SELECT COALESCE(SUM(COALESCE(receive_amount, amount)), 0) s FROM transactions WHERE issuance_authority = 'admin' AND status = 'completed' AND COALESCE(receive_currency, currency) = ? AND created_at >= ?", programme.currency, since);
    if (today + amount > limits.dailyIssuanceLimit) throw unprocessable('Amount exceeds the daily issuance limit of this programme', 'issuance_limit');
  }
  if (programme.status === 'sandbox') return pos;
  if (amount > pos.headroom) throw unprocessable(`Only ${pos.headroom} ${programme.currency} of cleared safeguarded funds are available for issuance (requested ${amount}); confirm more reserve funding first`, 'reserve_insufficient', pos);
  return pos;
}

// ---------------------------------------------------------------------------------------------
// Reserve movements
// ---------------------------------------------------------------------------------------------
function toMovement(r: any): ReserveMovement {
  return { id: r.id, programmeId: r.programme_id, kind: r.kind, direction: r.direction, amount: r.amount, currency: r.currency, status: r.status, reference: r.reference, evidence: parseJson(r.evidence, null), proposedBy: r.proposed_by, clearedBy: r.cleared_by, verificationId: r.verification_id, transactionId: r.transaction_id, note: r.note, createdAt: r.created_at, clearedAt: r.cleared_at };
}

export function listReserveMovements(programmeId?: string | null, limit = 100): ReserveMovement[] {
  const rows = programmeId
    ? getDb().prepare('SELECT * FROM reserve_movements WHERE programme_id = ? ORDER BY created_at DESC LIMIT ?').all(programmeId, limit)
    : getDb().prepare('SELECT * FROM reserve_movements ORDER BY created_at DESC LIMIT ?').all(limit);
  return (rows as any[]).map(toMovement);
}

export function recordReserveMovement(input: { programmeId: string; kind: ReserveKind; direction: 'in' | 'out'; amount: number; status: 'pending' | 'cleared'; reference?: string | null; evidence?: Record<string, unknown> | null; proposedBy?: string | null; clearedBy?: string | null; verificationId?: string | null; transactionId?: string | null; note?: string | null }, actor: Actor): ReserveMovement {
  const p = programmeRow(input.programmeId);
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw badRequest('Amount must be a positive integer');
  const id = uuid();
  getDb().prepare('INSERT INTO reserve_movements (id, programme_id, kind, direction, amount, currency, status, reference, evidence, proposed_by, cleared_by, verification_id, transaction_id, note, created_at, cleared_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, p.id, input.kind, input.direction, input.amount, p.currency, input.status, input.reference ?? null, input.evidence ? JSON.stringify(input.evidence) : null, input.proposedBy ?? null, input.clearedBy ?? null, input.verificationId ?? null, input.transactionId ?? null, input.note ?? null, now(), input.status === 'cleared' ? now() : null);
  recordEvent('issuance', p.id, `reserve.${input.kind}.${input.status}`, actor, { movementId: id, direction: input.direction, amount: input.amount, currency: p.currency, reference: input.reference ?? null, verificationId: input.verificationId ?? null });
  return toMovement(getDb().prepare('SELECT * FROM reserve_movements WHERE id = ?').get(id));
}

/** Second administrator confirms that safeguarded funds have cleared (bank statement / partner confirmation). */
export function clearReserveMovement(id: string, admin: UserRow, verificationId?: string | null): ReserveMovement {
  const r = getDb().prepare('SELECT * FROM reserve_movements WHERE id = ?').get(id) as any;
  if (!r) throw notFound('Reserve movement not found');
  if (r.status !== 'pending') throw conflict(`Reserve movement is already ${r.status}`, 'invalid_status');
  getDb().prepare("UPDATE reserve_movements SET status = 'cleared', cleared_by = ?, cleared_at = ?, verification_id = COALESCE(?, verification_id) WHERE id = ?").run(admin.id, now(), verificationId ?? null, id);
  recordEvent('issuance', r.programme_id, `reserve.${r.kind}.cleared`, { type: 'admin', id: admin.id }, { movementId: id, amount: r.amount, currency: r.currency, verificationId: verificationId ?? null });
  return toMovement(getDb().prepare('SELECT * FROM reserve_movements WHERE id = ?').get(id));
}

export function reverseReserveMovement(id: string, admin: UserRow, reason: string): ReserveMovement {
  const r = getDb().prepare('SELECT * FROM reserve_movements WHERE id = ?').get(id) as any;
  if (!r) throw notFound('Reserve movement not found');
  if (r.status === 'reversed') throw conflict('Already reversed', 'invalid_status');
  getDb().prepare("UPDATE reserve_movements SET status = 'reversed', note = COALESCE(note || ' · ', '') || ? WHERE id = ?").run(`Reversed: ${reason}`, id);
  recordEvent('issuance', r.programme_id, `reserve.${r.kind}.reversed`, { type: 'admin', id: admin.id }, { movementId: id, reason });
  return toMovement(getDb().prepare('SELECT * FROM reserve_movements WHERE id = ?').get(id));
}

/** Hooks called by the ledger / liquidity engine so reserves follow money leaving or entering the safeguarding account. */
export const reserveHooks = {
  /** External funding (processor-confirmed deposit): the processor owes the safeguarding account until it settles. */
  externalFunding(tx: TransactionRow) {
    const p = liveProgramme(tx.receive_currency ?? tx.currency);
    if (!p) return;
    recordReserveMovement({ programmeId: p.id, kind: 'processor_settlement', direction: 'in', amount: tx.receive_amount ?? tx.amount, status: 'pending', reference: tx.reference, transactionId: tx.id, note: 'Processor settlement receivable' }, { type: 'system' });
  },
  /** A completed withdrawal / external payout redeems e-money: safeguarded cash leaves to pay the holder. */
  redemption(tx: TransactionRow) {
    const p = liveProgramme(tx.currency);
    if (!p) return;
    recordReserveMovement({ programmeId: p.id, kind: 'redemption', direction: 'out', amount: tx.amount + tx.fee, status: 'cleared', reference: tx.reference, transactionId: tx.id, note: `Redemption (${tx.type})` }, { type: 'system' });
  },
  /** Treasury prefunds a payout float: cash moves from safeguarding to the operator / bank account. */
  liquidityTransfer(tx: TransactionRow, adminId: string) {
    const p = liveProgramme(tx.currency);
    if (!p) return;
    recordReserveMovement({ programmeId: p.id, kind: 'liquidity_transfer', direction: 'out', amount: tx.amount, status: 'cleared', reference: tx.reference, transactionId: tx.id, clearedBy: adminId, note: 'Prefunded payout liquidity' }, { type: 'admin', id: adminId });
  },
};

function liveProgramme(currency: string): any | null {
  return (getDb().prepare("SELECT * FROM emoney_programmes WHERE currency = ? AND status IN ('live', 'suspended') ORDER BY CASE status WHEN 'live' THEN 0 ELSE 1 END LIMIT 1").get(currency.toUpperCase()) as any) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Issuance (called only after maker-checker approval)
// ---------------------------------------------------------------------------------------------
export interface IssuancePayload {
  direction: 'credit' | 'debit';
  amount: number;
  currency: string;
  reason: string;
  /** Target: a user wallet or a distribution pool. */
  poolId?: string | null;
  programmeId?: string | null;
  jurisdiction?: string | null;
}

/** Validate an issuance request before it is proposed, so a maker cannot even queue an unbacked amount. */
export function validateIssuanceRequest(payload: IssuancePayload): { programme: any; position: ReservePosition } {
  const cur = getCurrency(payload.currency);
  const programme = payload.programmeId ? programmeRow(payload.programmeId) : programmeForCurrency(cur.code, payload.jurisdiction);
  if (!programme) throw forbidden(`No e-money programme governs ${cur.code}; register the authorised issuer and safeguarding account before issuing`, 'programme_required');
  if (programme.currency !== cur.code) throw badRequest('Programme currency does not match', 'validation_error');
  const position = payload.direction === 'credit' ? assertIssuable(programme, payload.amount) : reservePosition(programme);
  return { programme, position };
}

/** The only code path that creates or destroys e-money by administrative decision: after the checker approved it. */
export function executeIssuance(targetId: string, payload: IssuancePayload, approver: UserRow, proposerId: string, verificationId: string): TransactionRow {
  const cur = getCurrency(payload.currency);
  const { programme, position } = validateIssuanceRequest(payload);
  const credit = payload.direction === 'credit';
  const pool = payload.poolId ? getPool(payload.poolId) : null;
  const walletUserId = pool ? pool.walletUserId : targetId;
  if (pool && pool.currency !== cur.code) throw badRequest('Pool currency does not match', 'validation_error');
  const wallet = ensureWallet(walletUserId, cur.code);
  const tx = postTransaction({
    type: pool ? (credit ? 'emoney_mint' : 'emoney_burn') : 'admin_adjustment',
    amount: payload.amount,
    currency: cur.code,
    fromWalletId: credit ? null : wallet.id,
    toWalletId: credit ? wallet.id : null,
    senderUserId: credit ? null : walletUserId,
    receiverUserId: credit ? walletUserId : null,
    note: payload.reason,
    metadata: { direction: payload.direction, proposedBy: proposerId, approvedBy: approver.id, verificationId, programmeId: programme.id, programmeStatus: programme.status, poolId: pool?.id ?? null, sandbox: programme.status === 'sandbox', headroomBefore: position.headroom },
    issuance: credit ? { authority: 'admin', adminId: approver.id, verificationId, reference: `${programme.status === 'sandbox' ? 'SANDBOX ' : ''}${payload.reason}` } : undefined,
    allowNegativeSender: !credit,
  });
  recordEvent('issuance', programme.id, credit ? 'emoney.minted' : 'emoney.burned', { type: 'admin', id: approver.id }, { amount: payload.amount, currency: cur.code, transactionId: tx.id, verificationId, proposedBy: proposerId, target: pool ? { pool: pool.id } : { user: targetId }, sandbox: programme.status === 'sandbox' });
  if (!pool) notify(targetId, credit ? 'Balance credited' : 'Balance debited', `${formatMoney(payload.amount, cur)} was ${credit ? 'added to' : 'deducted from'} your wallet: ${payload.reason}`, { kind: 'adjustment', transactionId: tx.id, loud: credit });
  return tx;
}

// ---------------------------------------------------------------------------------------------
// Distribution pools
// ---------------------------------------------------------------------------------------------
function toPool(r: any): Pool {
  const w = getDb().prepare('SELECT balance FROM wallets WHERE user_id = ? AND currency = ?').get(r.wallet_user_id, r.currency) as any;
  const owner = r.owner_user_id ? findUserById(r.owner_user_id) : null;
  return { id: r.id, programmeId: r.programme_id, name: r.name, level: r.level, parentId: r.parent_id, owner: owner ? toPublicUser(owner) : null, country: r.country, currency: r.currency, walletUserId: r.wallet_user_id, balance: w?.balance ?? 0, status: r.status, limits: parseJson(r.limits, {}), createdAt: r.created_at };
}
export function listPools(filter: { programmeId?: string | null; ownerUserId?: string | null } = {}): Pool[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.programmeId) { where.push('programme_id = ?'); params.push(filter.programmeId); }
  if (filter.ownerUserId) { where.push('owner_user_id = ?'); params.push(filter.ownerUserId); }
  return (getDb().prepare(`SELECT * FROM distribution_pools ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY level, name`).all(...params) as any[]).map(toPool);
}
export function getPool(id: string): Pool {
  const r = getDb().prepare('SELECT * FROM distribution_pools WHERE id = ?').get(id);
  if (!r) throw notFound('Distribution pool not found', 'pool_not_found');
  return toPool(r);
}

const LEVEL_ORDER: PoolLevel[] = ['country', 'institution', 'master_agent', 'agent', 'merchant'];

export function createPool(input: { programmeId: string; name: string; level: PoolLevel; parentId?: string | null; ownerUserId?: string | null; country?: string | null; limits?: Record<string, number> }, admin: UserRow): Pool {
  const p = programmeRow(input.programmeId);
  if (input.parentId) {
    const parent = getPool(input.parentId);
    if (parent.programmeId !== p.id) throw badRequest('Parent pool belongs to another programme');
    if (LEVEL_ORDER.indexOf(input.level) <= LEVEL_ORDER.indexOf(parent.level)) throw badRequest(`A ${input.level} pool cannot sit under a ${parent.level} pool`, 'validation_error');
  }
  if (input.ownerUserId) {
    const owner = findUserById(input.ownerUserId);
    if (!owner || owner.is_system) throw badRequest('Owner user not found');
  }
  const id = uuid();
  const sys = createUser({ fullName: `Distribution pool · ${input.name}`, tag: `pool_${id.slice(0, 8)}`, role: 'admin', isSystem: true, email: `pool_${id.slice(0, 8)}@system.local`, emailVerified: true });
  getDb().prepare("UPDATE users SET status = 'active', is_system = 1 WHERE id = ?").run(sys.id);
  ensureWallet(sys.id, p.currency);
  getDb().prepare('INSERT INTO distribution_pools (id, programme_id, name, level, parent_id, owner_user_id, country, currency, wallet_user_id, status, limits, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, p.id, input.name, input.level, input.parentId ?? null, input.ownerUserId ?? null, input.country?.toUpperCase() ?? null, p.currency, sys.id, 'active', JSON.stringify(input.limits ?? {}), admin.id, now(), now());
  recordEvent('issuance', p.id, 'pool.created', { type: 'admin', id: admin.id }, { poolId: id, name: input.name, level: input.level, parentId: input.parentId ?? null, ownerUserId: input.ownerUserId ?? null });
  return getPool(id);
}

/**
 * Move already-issued e-money down (or back up) the distribution hierarchy. Nothing is created: the sending pool
 * must hold the balance. Treasury → pool is minting and goes through the issuance workflow instead.
 */
export function allocate(input: { fromPoolId: string; toPoolId?: string | null; toUserId?: string | null; amount: number; reason: string }, admin: UserRow): { transaction: TransactionRow; from: Pool; to: Pool | ReturnType<typeof toPublicUser> } {
  const from = getPool(input.fromPoolId);
  if (from.status !== 'active') throw forbidden('This pool is not active', 'pool_inactive');
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw badRequest('Amount must be greater than zero');
  if (!input.toPoolId && !input.toUserId) throw badRequest('Choose a destination pool or user');
  const fromWallet = getUserWallet(from.walletUserId, from.currency);
  if (fromWallet.balance < input.amount) throw unprocessable(`The ${from.name} pool holds only ${fromWallet.balance}; distribution moves existing e-money and never creates it`, 'insufficient_funds');
  let toWallet: WalletRow;
  let to: Pool | ReturnType<typeof toPublicUser>;
  if (input.toPoolId) {
    const pool = getPool(input.toPoolId);
    if (pool.currency !== from.currency) throw badRequest('Pools must share a currency');
    toWallet = ensureWallet(pool.walletUserId, pool.currency);
    to = pool;
  } else {
    const user = findUserById(input.toUserId!);
    if (!user || user.is_system) throw badRequest('Destination user not found');
    const w = ensureWallet(user.id, from.currency);
    const limits = from.limits;
    if (limits.maxHolderBalance && w.balance + input.amount > limits.maxHolderBalance) throw unprocessable('Destination balance would exceed the holder limit of this pool', 'holder_limit');
    toWallet = w;
    to = toPublicUser(user);
  }
  const tx = postTransaction({ type: 'distribution', amount: input.amount, currency: from.currency, fromWalletId: fromWallet.id, toWalletId: toWallet.id, senderUserId: from.walletUserId, receiverUserId: toWallet.user_id, note: input.reason, metadata: { fromPoolId: from.id, toPoolId: input.toPoolId ?? null, toUserId: input.toUserId ?? null, adminId: admin.id } });
  recordEvent('issuance', from.programmeId, 'pool.allocated', { type: 'admin', id: admin.id }, { fromPoolId: from.id, toPoolId: input.toPoolId ?? null, toUserId: input.toUserId ?? null, amount: input.amount, currency: from.currency, transactionId: tx.id });
  if (input.toUserId) notify(input.toUserId, 'Balance allocated', `${formatMoney(input.amount, getCurrency(from.currency, false))} was allocated to your wallet from ${from.name}: ${input.reason}`, { kind: 'distribution', transactionId: tx.id, loud: true });
  return { transaction: tx, from: getPool(from.id), to };
}

// ---------------------------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------------------------
export interface Reconciliation extends ReservePosition {
  id: string;
  programmeId: string;
  currency: string;
  details: Record<string, unknown>;
  runBy: string | null;
  createdAt: string;
}

function toRecon(r: any): Reconciliation {
  return { id: r.id, programmeId: r.programme_id, currency: r.currency, clearedReserves: r.cleared_reserves, pendingInflows: r.pending_inflows, pendingRedemptions: r.pending_redemptions, reservedExposure: r.reserved_exposure, liabilities: r.liabilities, poolBalances: r.pool_balances, payoutFloat: r.payout_float, headroom: r.headroom, coverage: r.cleared_reserves + r.pending_inflows - r.pending_redemptions - r.reserved_exposure - r.liabilities, status: r.status, sandbox: parseJson<any>(r.details, {}).sandbox ?? false, details: parseJson(r.details, {}), runBy: r.run_by, createdAt: r.created_at };
}

/** Daily (and on-demand) 1:1 reserve-to-liability reconciliation. A breach on a live programme suspends issuance and alerts administrators. */
export function reconcileReserves(runBy?: string | null): Reconciliation[] {
  const db = getDb();
  const out: Reconciliation[] = [];
  const settings = getEmoneySettings();
  for (const r of db.prepare('SELECT * FROM emoney_programmes').all() as any[]) {
    const pos = reservePosition(r);
    const id = uuid();
    const details = { sandbox: pos.sandbox, issuerModel: r.issuer_model, programmeStatus: r.status };
    db.prepare('INSERT INTO reserve_reconciliations (id, programme_id, currency, cleared_reserves, pending_inflows, pending_redemptions, reserved_exposure, liabilities, pool_balances, payout_float, headroom, status, details, run_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, r.id, r.currency, pos.clearedReserves, pos.pendingInflows, pos.pendingRedemptions, pos.reservedExposure, pos.liabilities, pos.poolBalances, pos.payoutFloat, pos.headroom, pos.status, JSON.stringify(details), runBy ?? null, now());
    recordEvent('issuance', r.id, `reconciliation.${pos.status}`, runBy ? { type: 'admin', id: runBy } : { type: 'system' }, { reconciliationId: id, ...pos });
    if (pos.status === 'breach' && r.status === 'live' && settings.autoSuspendOnBreach) {
      const reason = `Safeguarding reconciliation failed: outstanding e-money ${pos.liabilities} exceeds coverage ${pos.clearedReserves + pos.pendingInflows - pos.pendingRedemptions - pos.reservedExposure} ${r.currency}`;
      db.prepare("UPDATE emoney_programmes SET status = 'suspended', suspended_reason = ?, updated_at = ? WHERE id = ?").run(reason, now(), r.id);
      recordEvent('issuance', r.id, 'programme.suspended', { type: 'system' }, { reason, reconciliationId: id });
      for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin' AND is_system = 0 AND status = 'active'").all() as { id: string }[]) notify(a.id, `Issuance suspended: ${r.currency}`, reason, { kind: 'reconciliation', programmeId: r.id, loud: true });
    }
    out.push(toRecon(db.prepare('SELECT * FROM reserve_reconciliations WHERE id = ?').get(id)));
  }
  return out;
}

export function listReconciliations(programmeId?: string | null, limit = 30): Reconciliation[] {
  const rows = programmeId ? getDb().prepare('SELECT * FROM reserve_reconciliations WHERE programme_id = ? ORDER BY created_at DESC LIMIT ?').all(programmeId, limit) : getDb().prepare('SELECT * FROM reserve_reconciliations ORDER BY created_at DESC LIMIT ?').all(limit);
  return (rows as any[]).map(toRecon);
}

// ---------------------------------------------------------------------------------------------
// Wallet freezes & balance classification
// ---------------------------------------------------------------------------------------------
export function freezeWallet(userId: string, currency: string, admin: UserRow, reason: string, freeze = true): WalletRow {
  const w = ensureWallet(userId, currency);
  getDb().prepare('UPDATE wallets SET frozen_at = ?, frozen_reason = ?, frozen_by = ? WHERE id = ?').run(freeze ? now() : null, freeze ? reason : null, freeze ? admin.id : null, w.id);
  recordEvent('issuance', w.id, freeze ? 'wallet.frozen' : 'wallet.released', { type: 'admin', id: admin.id }, { userId, currency: w.currency, reason });
  notify(userId, freeze ? 'Balance frozen' : 'Balance released', freeze ? `Your ${w.currency} balance is frozen: ${reason}. Contact support for help.` : `Your ${w.currency} balance is available again.`, { kind: 'wallet', currency: w.currency, loud: true });
  return getWallet(w.id);
}

export type BalanceClass = 'emoney' | 'merchant' | 'agent_float' | 'sandbox';

export interface BalanceClassification {
  class: BalanceClass;
  label: string;
  redeemable: boolean;
  transferable: boolean;
  backing: string;
  issuer: string | null;
  programmeStatus: ProgrammeStatus | null;
}

/** What a balance legally is – shown next to every balance so promotional and sandbox value is never mistaken for money. */
export function classifyBalance(user: { role: string }, currency: string): BalanceClassification {
  const compliance = getComplianceSettings();
  const p = (getDb().prepare("SELECT * FROM emoney_programmes WHERE currency = ? ORDER BY CASE status WHEN 'live' THEN 0 WHEN 'suspended' THEN 1 ELSE 2 END LIMIT 1").get(currency.toUpperCase()) as any) ?? null;
  const sandbox = compliance.mode === 'sandbox' || !p || p.status === 'sandbox';
  if (sandbox) return { class: 'sandbox', label: 'Sandbox balance – no real-world value', redeemable: false, transferable: true, backing: 'Test environment only', issuer: null, programmeStatus: p?.status ?? null };
  const issuer = p.issuer_model === 'partner_issuer' ? `${p.issuer_name} (BitriPay as distributor)` : p.issuer_name ?? 'BitriPay';
  if (user.role === 'agent') return { class: 'agent_float', label: 'Agent float', redeemable: true, transferable: false, backing: 'Reconciled prefunded liquidity, 1:1 safeguarded', issuer, programmeStatus: p.status };
  if (user.role === 'merchant') return { class: 'merchant', label: 'Merchant balance', redeemable: true, transferable: true, backing: 'Regulated e-money, subject to settlement rules', issuer, programmeStatus: p.status };
  return { class: 'emoney', label: 'BitriPay e-money', redeemable: true, transferable: true, backing: '1:1 cleared safeguarded funds', issuer, programmeStatus: p.status };
}

// ---------------------------------------------------------------------------------------------
// Promotional credit – a marketing liability, never money
// ---------------------------------------------------------------------------------------------
export interface PromoCredit {
  id: string;
  userId: string;
  currency: string;
  amount: number;
  remaining: number;
  programme: string;
  reason: string | null;
  expiresAt: string | null;
  status: string;
  createdAt: string;
}
const toPromo = (r: any): PromoCredit => ({ id: r.id, userId: r.user_id, currency: r.currency, amount: r.amount, remaining: r.remaining, programme: r.programme, reason: r.reason, expiresAt: r.expires_at, status: r.status, createdAt: r.created_at });

export function grantPromoCredit(userId: string, currency: string, amount: number, programme: string, reason: string, opts: { referenceId?: string | null; expiresInDays?: number | null } = {}): PromoCredit {
  if (!Number.isInteger(amount) || amount <= 0) throw badRequest('Amount must be greater than zero');
  const cur = getCurrency(currency);
  const w = ensureWallet(userId, cur.code);
  const days = opts.expiresInDays ?? getEmoneySettings().promoExpiryDays;
  const id = uuid();
  const db = getDb();
  db.transaction(() => {
    db.prepare('INSERT INTO promo_credits (id, user_id, wallet_id, currency, amount, remaining, programme, reason, reference_id, expires_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, userId, w.id, cur.code, amount, amount, programme, reason, opts.referenceId ?? null, days ? new Date(Date.now() + days * 86_400_000).toISOString() : null, 'active', now(), now());
    db.prepare('UPDATE wallets SET promo_balance = promo_balance + ? WHERE id = ?').run(amount, w.id);
  })();
  recordEvent('issuance', id, 'promo.granted', { type: 'system' }, { userId, currency: cur.code, amount, programme, reason });
  return toPromo(db.prepare('SELECT * FROM promo_credits WHERE id = ?').get(id));
}

export function listPromoCredits(userId: string): PromoCredit[] {
  return (getDb().prepare('SELECT * FROM promo_credits WHERE user_id = ? ORDER BY created_at DESC').all(userId) as any[]).map(toPromo);
}

/** Consume promotional credit (oldest first) up to `amount`; returns what was actually covered. Called inside the ledger transaction. */
export function consumePromoCredit(wallet: WalletRow, amount: number, transactionId: string): number {
  if (amount <= 0 || (wallet.promo_balance ?? 0) <= 0) return 0;
  const db = getDb();
  let remaining = Math.min(amount, wallet.promo_balance ?? 0);
  let covered = 0;
  for (const c of db.prepare("SELECT * FROM promo_credits WHERE wallet_id = ? AND status = 'active' AND remaining > 0 AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at ASC").all(wallet.id, now()) as any[]) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, c.remaining);
    db.prepare("UPDATE promo_credits SET remaining = remaining - ?, status = CASE WHEN remaining - ? <= 0 THEN 'used' ELSE 'active' END, updated_at = ? WHERE id = ?").run(take, take, now(), c.id);
    remaining -= take;
    covered += take;
  }
  if (covered > 0) {
    db.prepare('UPDATE wallets SET promo_balance = promo_balance - ? WHERE id = ?').run(covered, wallet.id);
    recordEvent('issuance', wallet.id, 'promo.applied', { type: 'system' }, { transactionId, amount: covered, currency: wallet.currency });
  }
  return covered;
}

/** Expire lapsed promotional credit and write the wallet's promo balance down. */
export function expirePromoCredits(): number {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM promo_credits WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?").all(now()) as any[];
  for (const c of rows) {
    db.prepare("UPDATE promo_credits SET status = 'expired', updated_at = ? WHERE id = ?").run(now(), c.id);
    db.prepare('UPDATE wallets SET promo_balance = MAX(0, promo_balance - ?) WHERE id = ?').run(c.remaining, c.wallet_id);
    recordEvent('issuance', c.id, 'promo.expired', { type: 'system' }, { userId: c.user_id, amount: c.remaining, currency: c.currency });
  }
  return rows.length;
}

/** In sandbox mode every enabled currency gets a labelled sandbox programme so the console and flows can be demonstrated. */
export function ensureSandboxProgrammes(): number {
  if (getComplianceSettings().mode !== 'sandbox') return 0;
  let created = 0;
  // Only currencies actually in circulation (some wallet holds them) – not every enabled ISO currency.
  for (const c of getDb().prepare('SELECT DISTINCT currency code FROM wallets').all() as { code: string }[]) {
    if (!getDb().prepare('SELECT 1 FROM emoney_programmes WHERE currency = ?').get(c.code)) {
      programmeForCurrency(c.code);
      created++;
    }
  }
  return created;
}

/** Overview for the treasury console. */
export function emoneyOverview() {
  ensureSandboxProgrammes();
  const programmes = listProgrammes();
  const pools = listPools();
  const promo = getDb().prepare("SELECT currency, COALESCE(SUM(remaining), 0) total FROM promo_credits WHERE status = 'active' GROUP BY currency").all() as { currency: string; total: number }[];
  return { programmes, pools, promotionalLiability: promo, compliance: getComplianceSettings().mode, lastReconciliation: listReconciliations(null, programmes.length || 1) };
}

export function poolsForOwner(user: UserRow): Pool[] {
  return listPools({ ownerUserId: user.id });
}
