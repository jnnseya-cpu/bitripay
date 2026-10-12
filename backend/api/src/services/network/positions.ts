/**
 * Counterparty positions and settlement batches.
 *
 * This is not the merchant settlement engine (`services/finops/settlement.ts`), which closes a merchant's cycle and
 * pays what BitriPay owes that merchant. This is the other side: what BitriPay and each counterparty owe each other.
 *
 * Two movements are deliberately kept apart, because mixing them is how a corridor's books stop balancing:
 *   · a **position** nets what a counterparty received for BitriPay (a collection it holds) against what it paid for
 *     BitriPay out of its own funds (a post-paid payout). It settles as a batch.
 *   · **prefunding** — BitriPay placing its own liquidity at a partner — is a treasury movement on the liquidity
 *     account (`services/network/treasury.ts`). It never appears in a position; counting it in both would double it.
 *
 * A window is a key, not a timer: `2026-10-12` for a daily window, `2026-10-12T14` for an hourly one, `2026-W41` for
 * a weekly one. Closing a window freezes its movements; a movement that arrives late opens the next window instead.
 */
import { getDb } from '../../db';
import { uuid, now } from '../../lib/ids';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { recordEvent } from '../events';
import { getCounterparty, listCounterparties, type NetworkCounterparty, type SettlementWindow } from './registry';
import { planInstruction, settlementAdapter, type InstructionPlan } from './adapters';
import type { UserRow } from '../users';

export const MOVEMENT_KINDS = ['collection', 'postpaid_payout', 'fee', 'return', 'adjustment'] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

/** Which way a movement points by default: a collection is owed to BitriPay, a payout the partner funded is owed by it. */
const MOVEMENT_SIGN: Record<MovementKind, 1 | -1 | 0> = { collection: 1, postpaid_payout: -1, fee: -1, return: -1, adjustment: 0 };

export type PositionStatus = 'open' | 'closed' | 'settled';
export type BatchStatus = 'proposed' | 'approved' | 'instructed' | 'confirmed' | 'reconciled' | 'rejected' | 'failed';
export type BatchDirection = 'receive' | 'pay';

export interface CounterpartyMovement {
  id: string;
  counterpartyId: string;
  currency: string;
  kind: MovementKind;
  amountMinor: number;
  occurredAt: string;
  windowKey: string;
  reference: string | null;
  paymentId: string | null;
  statementMessageId: string | null;
  positionId: string | null;
  note: string | null;
  createdAt: string;
}

export interface NetworkPosition {
  id: string;
  counterpartyId: string;
  counterpartyName: string;
  currency: string;
  windowKey: string;
  grossInMinor: number;
  grossOutMinor: number;
  netMinor: number;
  entryCount: number;
  status: PositionStatus;
  direction: BatchDirection;
  openedAt: string;
  closedAt: string | null;
  batchId: string | null;
}

export interface SettlementBatch {
  id: string;
  number: number;
  counterpartyId: string;
  counterpartyName: string;
  currency: string;
  windowKey: string;
  netMinor: number;
  direction: BatchDirection;
  rail: string;
  corridorCode: string | null;
  status: BatchStatus;
  externalRef: string | null;
  instructionRef: string | null;
  messageId: string | null;
  failureReason: string | null;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  instructedAt: string | null;
  confirmedAt: string | null;
  reconciledAt: string | null;
  createdAt: string;
}

/** The window a moment belongs to, for a counterparty's cadence. */
export function windowKeyFor(cadence: SettlementWindow, at: Date = new Date()): string {
  const iso = at.toISOString();
  if (cadence === 'hourly') return iso.slice(0, 13);
  if (cadence === 'weekly') {
    const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
    const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }
  if (cadence === 'manual') return 'manual';
  return iso.slice(0, 10);
}

/**
 * The window a movement may actually be added to. A movement that arrives after its window was closed never reopens
 * it — and on a daily cadence "the next window" is not simply tomorrow, because the day is not over. It goes into a
 * supplementary window of the same period (`2026-10-12.1`), which closes and settles like any other.
 */
function openWindowKey(cp: NetworkCounterparty, currency: string, baseKey: string): string {
  const db = getDb();
  for (let suffix = 0; suffix < 100; suffix++) {
    const key = suffix === 0 ? baseKey : `${baseKey}.${suffix}`;
    const row = db.prepare('SELECT status FROM network_positions WHERE counterparty_id = ? AND currency = ? AND window_key = ?').get(cp.id, currency, key) as { status: string } | undefined;
    if (!row || row.status === 'open') return key;
  }
  throw conflict(`Every window of ${baseKey} for ${cp.name} in ${currency} is already settled; settle the supplementary windows before adding more.`, 'no_open_window');
}

function movementRow(r: any): CounterpartyMovement {
  return {
    id: r.id,
    counterpartyId: r.counterparty_id,
    currency: r.currency,
    kind: r.kind,
    amountMinor: r.amount_minor,
    occurredAt: r.occurred_at,
    windowKey: r.window_key,
    reference: r.reference ?? null,
    paymentId: r.payment_id ?? null,
    statementMessageId: r.statement_message_id ?? null,
    positionId: r.position_id ?? null,
    note: r.note ?? null,
    createdAt: r.created_at,
  };
}

function positionRow(r: any, name: string): NetworkPosition {
  return {
    id: r.id,
    counterpartyId: r.counterparty_id,
    counterpartyName: name,
    currency: r.currency,
    windowKey: r.window_key,
    grossInMinor: r.gross_in_minor,
    grossOutMinor: r.gross_out_minor,
    netMinor: r.net_minor,
    entryCount: r.entry_count,
    status: r.status,
    direction: r.net_minor >= 0 ? 'receive' : 'pay',
    openedAt: r.opened_at,
    closedAt: r.closed_at ?? null,
    batchId: r.batch_id ?? null,
  };
}

function batchRow(r: any, name: string): SettlementBatch {
  return {
    id: r.id,
    number: r.number,
    counterpartyId: r.counterparty_id,
    counterpartyName: name,
    currency: r.currency,
    windowKey: r.window_key,
    netMinor: r.net_minor,
    direction: r.direction,
    rail: r.rail,
    corridorCode: r.corridor_code ?? null,
    status: r.status,
    externalRef: r.external_ref ?? null,
    instructionRef: r.instruction_ref ?? null,
    messageId: r.message_id ?? null,
    failureReason: r.failure_reason ?? null,
    createdBy: r.created_by,
    approvedBy: r.approved_by ?? null,
    approvedAt: r.approved_at ?? null,
    instructedAt: r.instructed_at ?? null,
    confirmedAt: r.confirmed_at ?? null,
    reconciledAt: r.reconciled_at ?? null,
    createdAt: r.created_at,
  };
}

const nameOf = (id: string): string => {
  try {
    return getCounterparty(id).name;
  } catch {
    return id;
  }
};

// ------------------------------------------------------------- the sub-ledger

export interface MovementInput {
  counterpartyId: string;
  currency: string;
  kind: MovementKind;
  /** Always positive; the kind decides the sign, except for `adjustment`, where a signed amount is required. */
  amountMinor: number;
  occurredAt?: string;
  reference?: string | null;
  paymentId?: string | null;
  statementMessageId?: string | null;
  note?: string | null;
}

/**
 * Post one movement to a counterparty's sub-ledger. Idempotent per counterparty, currency, kind and reference: the
 * same statement line imported twice posts once, which is what makes a statement import safe to re-run.
 */
export function recordCounterpartyMovement(input: MovementInput, actorId: string | null): CounterpartyMovement {
  const cp = getCounterparty(input.counterpartyId);
  if (!MOVEMENT_KINDS.includes(input.kind)) throw badRequest(`Unknown movement kind "${input.kind}"`);
  if (!cp.currencies.includes(input.currency)) throw badRequest(`${cp.name} does not settle in ${input.currency}.`, 'unsupported_currency');
  if (!Number.isInteger(input.amountMinor) || input.amountMinor === 0) throw badRequest('Amount must be a non-zero integer in minor units', 'invalid_amount');
  const sign = MOVEMENT_SIGN[input.kind];
  if (sign !== 0 && input.amountMinor < 0) throw badRequest(`A ${input.kind} is recorded as a positive amount; its direction comes from its kind.`, 'invalid_amount');
  const amount = sign === 0 ? input.amountMinor : sign * Math.abs(input.amountMinor);
  const occurredAt = input.occurredAt ?? now();

  if (input.reference) {
    const existing = getDb()
      .prepare('SELECT * FROM network_counterparty_movements WHERE counterparty_id = ? AND currency = ? AND kind = ? AND reference = ?')
      .get(cp.id, input.currency, input.kind, input.reference) as any;
    if (existing) return movementRow(existing);
  }

  const windowKey = openWindowKey(cp, input.currency, windowKeyFor(cp.settlementWindow, new Date(occurredAt)));

  const id = uuid();
  getDb()
    .prepare(
      `INSERT INTO network_counterparty_movements (id, counterparty_id, currency, kind, amount_minor, occurred_at, window_key, reference, payment_id, statement_message_id, position_id, note, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(id, cp.id, input.currency, input.kind, amount, occurredAt, windowKey, input.reference ?? null, input.paymentId ?? null, input.statementMessageId ?? null, input.note ?? null, actorId, now());
  refreshPosition(cp, input.currency, windowKey);
  return movementRow(getDb().prepare('SELECT * FROM network_counterparty_movements WHERE id = ?').get(id));
}

export function listMovements(filter: { counterpartyId?: string | null; currency?: string | null; windowKey?: string | null; limit?: number } = {}): CounterpartyMovement[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.counterpartyId) {
    where.push('counterparty_id = ?');
    args.push(filter.counterpartyId);
  }
  if (filter.currency) {
    where.push('currency = ?');
    args.push(filter.currency);
  }
  if (filter.windowKey) {
    where.push('window_key = ?');
    args.push(filter.windowKey);
  }
  const sql = `SELECT * FROM network_counterparty_movements ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY occurred_at DESC LIMIT ?`;
  return (
    getDb()
      .prepare(sql)
      .all(...args, Math.min(filter.limit ?? 200, 1000)) as any[]
  ).map(movementRow);
}

// ---------------------------------------------------------------- positions

/** Rebuild one window's position from its movements. Derived, never edited: the sub-ledger is the truth. */
function refreshPosition(cp: NetworkCounterparty, currency: string, windowKey: string): NetworkPosition {
  const db = getDb();
  const agg = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN amount_minor > 0 THEN amount_minor ELSE 0 END), 0) gin,
              COALESCE(SUM(CASE WHEN amount_minor < 0 THEN -amount_minor ELSE 0 END), 0) gout,
              COUNT(*) n
         FROM network_counterparty_movements WHERE counterparty_id = ? AND currency = ? AND window_key = ?`,
    )
    .get(cp.id, currency, windowKey) as { gin: number; gout: number; n: number };
  const existing = db.prepare('SELECT * FROM network_positions WHERE counterparty_id = ? AND currency = ? AND window_key = ?').get(cp.id, currency, windowKey) as any;
  const net = agg.gin - agg.gout;
  if (existing) {
    if (existing.status !== 'open') return positionRow(existing, cp.name);
    db.prepare('UPDATE network_positions SET gross_in_minor = ?, gross_out_minor = ?, net_minor = ?, entry_count = ? WHERE id = ?').run(agg.gin, agg.gout, net, agg.n, existing.id);
  } else {
    db.prepare(
      `INSERT INTO network_positions (id, counterparty_id, currency, window_key, gross_in_minor, gross_out_minor, net_minor, entry_count, status, opened_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    ).run(uuid(), cp.id, currency, windowKey, agg.gin, agg.gout, net, agg.n, now());
  }
  const row = db.prepare('SELECT * FROM network_positions WHERE counterparty_id = ? AND currency = ? AND window_key = ?').get(cp.id, currency, windowKey) as any;
  return positionRow(row, cp.name);
}

export function listPositions(filter: { counterpartyId?: string | null; status?: PositionStatus | null; currency?: string | null } = {}): NetworkPosition[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.counterpartyId) {
    where.push('counterparty_id = ?');
    args.push(filter.counterpartyId);
  }
  if (filter.status) {
    where.push('status = ?');
    args.push(filter.status);
  }
  if (filter.currency) {
    where.push('currency = ?');
    args.push(filter.currency);
  }
  const sql = `SELECT * FROM network_positions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY window_key DESC, counterparty_id`;
  return (
    getDb()
      .prepare(sql)
      .all(...args) as any[]
  ).map((r) => positionRow(r, nameOf(r.counterparty_id)));
}

export function getPosition(id: string): NetworkPosition {
  const r = getDb().prepare('SELECT * FROM network_positions WHERE id = ?').get(id) as any;
  if (!r) throw notFound('Unknown position', 'position_not_found');
  return positionRow(r, nameOf(r.counterparty_id));
}

/** Freeze a window. Nothing more may be added to it; a later movement opens the current window instead. */
export function closePosition(id: string, admin: UserRow): NetworkPosition {
  const p = getPosition(id);
  if (p.status !== 'open') throw conflict(`This position is already ${p.status}.`, 'position_not_open');
  getDb().prepare("UPDATE network_positions SET status = 'closed', closed_at = ? WHERE id = ?").run(now(), id);
  recordEvent('network', id, 'network.position.closed', { type: 'admin', id: admin.id }, { counterparty: p.counterpartyName, currency: p.currency, window: p.windowKey, net: p.netMinor });
  return getPosition(id);
}

/** Close every open window whose cadence says it is over, so positions never sit open because nobody clicked. */
export function closeDuePositions(at = new Date()): { closed: number } {
  let closed = 0;
  for (const cp of listCounterparties({ status: 'active' })) {
    if (cp.settlementWindow === 'manual') continue;
    const current = windowKeyFor(cp.settlementWindow, at);
    const rows = getDb().prepare("SELECT id FROM network_positions WHERE counterparty_id = ? AND status = 'open' AND window_key < ?").all(cp.id, current) as { id: string }[];
    for (const r of rows) {
      getDb().prepare("UPDATE network_positions SET status = 'closed', closed_at = ? WHERE id = ?").run(now(), r.id);
      closed += 1;
    }
  }
  return { closed };
}

// ----------------------------------------------------------------- batches

function nextBatchNumber(): number {
  const row = getDb().prepare('SELECT COALESCE(MAX(number), 0) n FROM network_settlement_batches').get() as { n: number };
  return row.n + 1;
}

export function listBatches(filter: { counterpartyId?: string | null; status?: BatchStatus | null; limit?: number } = {}): SettlementBatch[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.counterpartyId) {
    where.push('counterparty_id = ?');
    args.push(filter.counterpartyId);
  }
  if (filter.status) {
    where.push('status = ?');
    args.push(filter.status);
  }
  const sql = `SELECT * FROM network_settlement_batches ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY number DESC LIMIT ?`;
  return (
    getDb()
      .prepare(sql)
      .all(...args, Math.min(filter.limit ?? 100, 500)) as any[]
  ).map((r) => batchRow(r, nameOf(r.counterparty_id)));
}

export function getBatch(id: string): SettlementBatch {
  const r = getDb().prepare('SELECT * FROM network_settlement_batches WHERE id = ?').get(id) as any;
  if (!r) throw notFound('Unknown settlement batch', 'batch_not_found');
  return batchRow(r, nameOf(r.counterparty_id));
}

/** Turn a closed position into a settlement instruction. One batch per counterparty, currency and window, ever. */
export function proposeBatch(positionId: string, input: { rail: string; corridorCode?: string | null }, admin: UserRow): SettlementBatch {
  const p = getPosition(positionId);
  if (p.status === 'open') throw conflict('Close the window before settling it.', 'position_open');
  if (p.status === 'settled') throw conflict('This window is already settled.', 'position_settled');
  if (p.netMinor === 0) throw badRequest('This window nets to zero: there is nothing to settle.', 'nothing_to_settle');
  if (!input.rail.trim()) throw badRequest('Say which settlement rail carries this batch.');
  settlementAdapter(input.rail);
  const existing = getDb().prepare('SELECT * FROM network_settlement_batches WHERE counterparty_id = ? AND currency = ? AND window_key = ?').get(p.counterpartyId, p.currency, p.windowKey) as any;
  if (existing && existing.status !== 'rejected' && existing.status !== 'failed') return batchRow(existing, p.counterpartyName);
  if (existing) {
    // A window whose batch was rejected or failed is still unsettled. Re-proposing reuses the row, and therefore its
    // number, so the event log reads as one batch that was refused and re-made rather than two unrelated ones.
    getDb()
      .prepare(
        `UPDATE network_settlement_batches SET net_minor = ?, direction = ?, rail = ?, corridor_code = ?, status = 'proposed', failure_reason = NULL,
           external_ref = NULL, instruction_ref = NULL, message_id = NULL, approved_by = NULL, approved_at = NULL, instructed_at = NULL, confirmed_at = NULL,
           created_by = ?, created_at = ? WHERE id = ?`,
      )
      .run(Math.abs(p.netMinor), p.direction, input.rail, input.corridorCode ?? null, admin.id, now(), existing.id);
    getDb().prepare('UPDATE network_positions SET batch_id = ? WHERE id = ?').run(existing.id, p.id);
    recordEvent(
      'network',
      existing.id,
      'network.batch.proposed',
      { type: 'admin', id: admin.id },
      { number: existing.number, counterparty: p.counterpartyName, currency: p.currency, net: p.netMinor, direction: p.direction, rail: input.rail, replaces: existing.status },
    );
    return getBatch(existing.id);
  }
  const id = uuid();
  const number = nextBatchNumber();
  getDb()
    .prepare(
      `INSERT INTO network_settlement_batches (id, number, counterparty_id, currency, window_key, net_minor, direction, rail, corridor_code, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
    )
    .run(id, number, p.counterpartyId, p.currency, p.windowKey, Math.abs(p.netMinor), p.direction, input.rail, input.corridorCode ?? null, admin.id, now());
  getDb().prepare('UPDATE network_positions SET batch_id = ? WHERE id = ?').run(id, p.id);
  recordEvent(
    'network',
    id,
    'network.batch.proposed',
    { type: 'admin', id: admin.id },
    { number, counterparty: p.counterpartyName, currency: p.currency, net: p.netMinor, direction: p.direction, rail: input.rail },
  );
  return getBatch(id);
}

/** Four eyes: whoever proposed a batch may not approve it. */
export function approveBatch(id: string, admin: UserRow): SettlementBatch {
  const b = getBatch(id);
  if (b.status !== 'proposed') throw conflict(`This batch is ${b.status}.`, 'batch_not_proposed');
  if (b.createdBy === admin.id) throw badRequest('A settlement batch is approved by a second administrator.', 'approver_required');
  getDb().prepare("UPDATE network_settlement_batches SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?").run(admin.id, now(), id);
  recordEvent('network', id, 'network.batch.approved', { type: 'admin', id: admin.id }, { number: b.number, net: b.netMinor });
  return getBatch(id);
}

export function rejectBatch(id: string, reason: string, admin: UserRow): SettlementBatch {
  const b = getBatch(id);
  if (b.status !== 'proposed' && b.status !== 'approved') throw conflict(`This batch is ${b.status}.`, 'batch_not_pending');
  if (!reason.trim()) throw badRequest('Say why the batch is rejected.');
  getDb().prepare("UPDATE network_settlement_batches SET status = 'rejected', failure_reason = ? WHERE id = ?").run(reason, id);
  getDb().prepare('UPDATE network_positions SET batch_id = NULL WHERE batch_id = ?').run(id);
  recordEvent('network', id, 'network.batch.rejected', { type: 'admin', id: admin.id }, { number: b.number, reason });
  return getBatch(id);
}

/** What the rail requires before this batch can be instructed, and what the operator has to do. */
export function instructionPlan(id: string): InstructionPlan {
  return planInstruction(getBatch(id));
}

/**
 * Record that the instruction left on its rail. The rail is checked here and not only when the batch was proposed:
 * a corridor flag can be switched off between proposal and instruction, and a batch must never leave on a rail the
 * corridor no longer allows.
 */
export function markInstructed(id: string, input: { instructionRef: string; messageId?: string | null }, admin: UserRow): SettlementBatch {
  const b = getBatch(id);
  if (b.status !== 'approved') throw conflict('A batch is instructed only after a second administrator has approved it.', 'batch_not_approved');
  planInstruction(b);
  getDb()
    .prepare("UPDATE network_settlement_batches SET status = 'instructed', instruction_ref = ?, message_id = ?, instructed_at = ? WHERE id = ?")
    .run(input.instructionRef, input.messageId ?? null, now(), id);
  recordEvent('network', id, 'network.batch.instructed', { type: 'admin', id: admin.id }, { number: b.number, instructionRef: input.instructionRef });
  return getBatch(id);
}

/** The counterparty or the rail confirmed the movement. */
export function confirmBatch(id: string, externalRef: string, actorId: string | null): SettlementBatch {
  const b = getBatch(id);
  if (b.status !== 'instructed') throw conflict(`A batch is confirmed after it is instructed; this one is ${b.status}.`, 'batch_not_instructed');
  getDb().prepare("UPDATE network_settlement_batches SET status = 'confirmed', external_ref = ?, confirmed_at = ? WHERE id = ?").run(externalRef, now(), id);
  recordEvent('network', id, 'network.batch.confirmed', { type: actorId ? 'admin' : 'system', id: actorId }, { number: b.number, externalRef });
  return getBatch(id);
}

export function failBatch(id: string, reason: string, actorId: string | null): SettlementBatch {
  const b = getBatch(id);
  if (b.status === 'reconciled') throw conflict('A reconciled batch cannot be failed.', 'batch_reconciled');
  getDb().prepare("UPDATE network_settlement_batches SET status = 'failed', failure_reason = ? WHERE id = ?").run(reason, id);
  recordEvent('network', id, 'network.batch.failed', { type: actorId ? 'admin' : 'system', id: actorId }, { number: b.number, reason });
  return getBatch(id);
}

/**
 * The batch matched the counterparty's own statement. Only then is the window settled, and only then does the
 * position stop counting against the exposure the treasury watches.
 */
export function reconcileBatch(id: string, input: { statementAmountMinor: number; statementRef?: string | null }, admin: UserRow): { batch: SettlementBatch; difference: number } {
  const b = getBatch(id);
  if (b.status !== 'confirmed') throw conflict(`A batch is reconciled after it is confirmed; this one is ${b.status}.`, 'batch_not_confirmed');
  const difference = input.statementAmountMinor - b.netMinor;
  if (difference !== 0) {
    recordEvent('network', id, 'network.batch.break', { type: 'admin', id: admin.id }, { number: b.number, expected: b.netMinor, statement: input.statementAmountMinor, difference });
    throw badRequest(
      `The statement says ${input.statementAmountMinor} and the batch says ${b.netMinor}: a difference of ${difference} minor units. Post an adjustment before reconciling.`,
      'settlement_break',
      {
        expected: b.netMinor,
        statement: input.statementAmountMinor,
        difference,
      },
    );
  }
  getDb()
    .prepare("UPDATE network_settlement_batches SET status = 'reconciled', reconciled_at = ?, external_ref = COALESCE(?, external_ref) WHERE id = ?")
    .run(now(), input.statementRef ?? null, id);
  getDb().prepare("UPDATE network_positions SET status = 'settled' WHERE batch_id = ?").run(id);
  recordEvent('network', id, 'network.batch.reconciled', { type: 'admin', id: admin.id }, { number: b.number, net: b.netMinor });
  return { batch: getBatch(id), difference };
}

/** What is open with every counterparty right now, and what is waiting on a person. */
export function settlementOverview() {
  const positions = listPositions();
  const batches = listBatches({ limit: 200 });
  const open = positions.filter((p) => p.status === 'open');
  const unsettled = positions.filter((p) => p.status === 'closed');
  const byCurrency = new Map<string, { currency: string; openNetMinor: number; unsettledNetMinor: number }>();
  for (const p of positions) {
    const e = byCurrency.get(p.currency) ?? { currency: p.currency, openNetMinor: 0, unsettledNetMinor: 0 };
    if (p.status === 'open') e.openNetMinor += p.netMinor;
    if (p.status === 'closed') e.unsettledNetMinor += p.netMinor;
    byCurrency.set(p.currency, e);
  }
  return {
    positions,
    batches,
    totals: [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    waiting: {
      openWindows: open.length,
      closedNotSettled: unsettled.length,
      awaitingApproval: batches.filter((b) => b.status === 'proposed').length,
      awaitingInstruction: batches.filter((b) => b.status === 'approved').length,
      awaitingConfirmation: batches.filter((b) => b.status === 'instructed').length,
      awaitingReconciliation: batches.filter((b) => b.status === 'confirmed').length,
    },
  };
}
