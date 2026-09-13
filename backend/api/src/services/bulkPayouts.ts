/**
 * Bulk payouts (module 14): salaries, supplier runs, NGO disbursements and government collections paid out in one
 * batch. Rows come as JSON or CSV, every row is validated up front (destination, amount, operator, wallet), the batch
 * shows its totals and fees before anyone approves it, approval is four-eyes (a different account holder) or step-up
 * (PIN / passkey) for the creator, and execution runs the rows in order through the same payout and transfer engines
 * as a single payment: one ledger transaction per row, a failed row never blocks the next one, and the batch reports
 * exactly what was paid.
 */
import { getDb } from '../db';
import { now, shortCode } from '../lib/ids';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { parseJson } from '../lib/json';
import { getCurrency } from './currencies';
import { calculateFee } from './ledger';
import { getUserWallet } from './wallets';
import { heldByKind } from './finops/holds';
import { getOperator, listOperators } from './momo';
import { normalizePhone, findUserByIdentifier, findUserById, type UserRow } from './users';
import { requestWithdrawal, type WithdrawalDestination } from './withdrawals';
import { sendMoney } from './transfers';
import { emitEvent } from './webhooks';
import { recordEvent, type Actor } from './events';
import { notify } from './notifications';
import { formatMoney, COUNTRIES } from '@bitripay/shared';

export type BatchStatus = 'PENDING_APPROVAL' | 'EXECUTING' | 'EXECUTED' | 'PARTIAL' | 'FAILED' | 'CANCELLED';
export type RowStatus = 'VALID' | 'INVALID' | 'PAID' | 'FAILED' | 'SKIPPED';
export type BatchDestination =
  | { method: 'wallet'; to: string }
  | { method: 'mobile_money'; operatorId: string; phone: string; name?: string | null }
  | { method: 'bank'; bankAccountId: string }
  | { method: 'bank'; bankName: string; accountName: string; accountNumber: string; country?: string | null; swift?: string | null };
export interface BatchRowInput {
  amountMinor: number;
  destination: BatchDestination;
  reference?: string | null;
  name?: string | null;
}
export interface BatchRowView {
  id: string;
  lineNo: number;
  method: string;
  destination: Record<string, unknown>;
  amountMinor: number;
  feeMinor: number;
  reference: string | null;
  name: string | null;
  status: RowStatus;
  error: string | null;
  transactionId: string | null;
  paidAt: string | null;
}
export interface BatchView {
  id: string;
  reference: string | null;
  note: string | null;
  currency: string;
  status: BatchStatus;
  rowCount: number;
  validRows: number;
  invalidRows: number;
  paidRows: number;
  failedRows: number;
  totalMinor: number;
  feeMinor: number;
  paidMinor: number;
  skipInvalid: boolean;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  approvalMethod: string | null;
  executedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  rows?: BatchRowView[];
}

export const MAX_BATCH_ROWS = 5000;
/** CSV columns accepted (header row required, order free): method, amount, wallet, operator_id, phone, name, bank_name, account_name, account_number, country, swift, bank_account_id, reference */
export const CSV_COLUMNS = ['method', 'amount', 'wallet', 'operator_id', 'phone', 'name', 'bank_name', 'account_name', 'account_number', 'country', 'swift', 'bank_account_id', 'reference'] as const;

/** RFC 4180-style parser: quoted fields, doubled quotes, CRLF, blank lines ignored. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** Turn a CSV record into a row input; throws a per-row error message so the batch can list it. */
export function rowFromCsv(rec: Record<string, string>, currency: string): BatchRowInput {
  const cur = getCurrency(currency);
  const method = (rec.method || (rec.wallet ? 'wallet' : rec.phone ? 'mobile_money' : 'bank')).toLowerCase();
  const amountStr = rec.amount ?? '';
  if (!/^\d+(\.\d+)?$/.test(amountStr)) throw new Error(`amount "${amountStr}" is not a number`);
  const amountMinor = Math.round(Number(amountStr) * 10 ** cur.decimals);
  const reference = rec.reference || null;
  const name = rec.name || null;
  if (method === 'wallet') {
    if (!rec.wallet) throw new Error('wallet (tag, phone or email) is required');
    return { amountMinor, destination: { method: 'wallet', to: rec.wallet }, reference, name };
  }
  if (method === 'mobile_money') {
    if (!rec.phone) throw new Error('phone is required');
    return { amountMinor, destination: { method: 'mobile_money', operatorId: rec.operator_id, phone: rec.phone, name }, reference, name };
  }
  if (method === 'bank') {
    if (rec.bank_account_id) return { amountMinor, destination: { method: 'bank', bankAccountId: rec.bank_account_id }, reference, name };
    return { amountMinor, destination: { method: 'bank', bankName: rec.bank_name, accountName: rec.account_name || name || '', accountNumber: rec.account_number, country: rec.country || null, swift: rec.swift || null }, reference, name };
  }
  throw new Error(`unknown method "${method}"`);
}

/** Validate one row against the live directories; returns the normalised destination or an error message. */
function validateRow(user: UserRow, row: BatchRowInput, currency: string): { ok: true; destination: BatchDestination; fee: number; method: string; name: string | null } | { ok: false; error: string; method: string } {
  const d = row.destination;
  const method = d?.method ?? 'unknown';
  if (!Number.isInteger(row.amountMinor) || row.amountMinor <= 0) return { ok: false, error: 'amount must be a positive whole number of minor units', method };
  try {
    if (d.method === 'wallet') {
      const r = findUserByIdentifier(d.to);
      if (!r || r.is_system) return { ok: false, error: `no BitriPay account for "${d.to}"`, method };
      if (r.id === user.id) return { ok: false, error: 'cannot pay yourself', method };
      if (r.status !== 'active') return { ok: false, error: 'recipient account is not active', method };
      const type = r.role === 'merchant' ? 'merchant_payment' : 'transfer';
      return { ok: true, destination: { method: 'wallet', to: d.to }, fee: type === 'transfer' ? calculateFee('transfer', row.amountMinor, currency, null, { userId: user.id }) : 0, method, name: row.name ?? r.full_name };
    }
    if (d.method === 'mobile_money') {
      const phone = normalizePhone(d.phone);
      if (!phone) return { ok: false, error: `"${d.phone}" is not a valid mobile money number`, method };
      let op;
      if (d.operatorId) op = getOperator(d.operatorId);
      else {
        // operator inferred from the number's country code when exactly one payout-enabled operator serves it
        const cands = listOperators({ currency }).filter((o) => o.payoutEnabled && o.enabled && phoneCountryMatches(phone, o.country));
        if (cands.length !== 1) return { ok: false, error: cands.length === 0 ? 'operator_id is required (no operator matches this number)' : `operator_id is required (${cands.map((c) => c.id).join(', ')} all match)`, method };
        op = cands[0];
      }
      if (!op.enabled || !op.payoutEnabled) return { ok: false, error: `payouts to ${op.name} are unavailable`, method };
      return { ok: true, destination: { method: 'mobile_money', operatorId: op.id, phone, name: row.name ?? d.name ?? null }, fee: calculateFee('withdrawal', row.amountMinor, currency, null, { userId: user.id }), method, name: row.name ?? d.name ?? null };
    }
    if (d.method === 'bank') {
      if ('bankAccountId' in d && d.bankAccountId) {
        const bank = getDb().prepare('SELECT * FROM bank_accounts WHERE id = ? AND user_id = ?').get(d.bankAccountId, user.id) as any;
        if (!bank) return { ok: false, error: `bank account ${d.bankAccountId} not found`, method };
        if (bank.currency !== currency) return { ok: false, error: `bank account receives ${bank.currency}, batch is in ${currency}`, method };
        return { ok: true, destination: { method: 'bank', bankAccountId: d.bankAccountId }, fee: calculateFee('withdrawal', row.amountMinor, currency, null, { userId: user.id }), method, name: row.name ?? bank.account_name };
      }
      if (!('bankName' in d) || !d.bankName || !d.accountNumber) return { ok: false, error: 'bank_name and account_number are required', method };
      if (!d.accountName) return { ok: false, error: 'account_name is required', method };
      return { ok: true, destination: { method: 'bank', bankName: d.bankName, accountName: d.accountName, accountNumber: d.accountNumber, country: d.country ?? null, swift: d.swift ?? null }, fee: calculateFee('withdrawal', row.amountMinor, currency, null, { userId: user.id }), method, name: row.name ?? d.accountName };
    }
    return { ok: false, error: `unknown method "${method}"`, method };
  } catch (err) {
    return { ok: false, error: (err as Error).message, method };
  }
}

function phoneCountryMatches(phone: string, country: string): boolean {
  const dial = COUNTRIES.find((c) => c.code === country)?.dialCode;
  return !!dial && phone.startsWith(dial.startsWith('+') ? dial : `+${dial}`);
}
function rowView(r: any): BatchRowView {
  return { id: r.id, lineNo: r.line_no, method: r.method, destination: parseJson(r.destination, {}), amountMinor: r.amount_minor, feeMinor: r.fee_minor, reference: r.reference, name: r.name, status: r.status, error: r.error, transactionId: r.transaction_id, paidAt: r.paid_at };
}
function batchView(b: any, withRows = false): BatchView {
  const v: BatchView = { id: b.id, reference: b.reference, note: b.note, currency: b.currency, status: b.status, rowCount: b.row_count, validRows: b.valid_rows, invalidRows: b.invalid_rows, paidRows: b.paid_rows, failedRows: b.failed_rows, totalMinor: b.total_minor, feeMinor: b.fee_minor, paidMinor: b.paid_minor, skipInvalid: !!b.skip_invalid, createdBy: b.created_by, approvedBy: b.approved_by, approvedAt: b.approved_at, approvalMethod: b.approval_method, executedAt: b.executed_at, cancelledAt: b.cancelled_at, createdAt: b.created_at, updatedAt: b.updated_at };
  if (withRows) v.rows = (getDb().prepare('SELECT * FROM payout_batch_rows WHERE batch_id = ? ORDER BY line_no').all(b.id) as any[]).map(rowView);
  return v;
}
function loadBatch(userId: string, id: string): any {
  const b = getDb().prepare('SELECT * FROM payout_batches WHERE id = ? AND user_id = ?').get(id, userId);
  if (!b) throw notFound('Payout batch not found', 'batch_not_found');
  return b;
}

export function createBatch(user: UserRow, input: { currency: string; rows?: BatchRowInput[]; csv?: string | null; reference?: string | null; note?: string | null; skipInvalid?: boolean; idemKey?: string | null; via?: 'session' | 'api_key' }, actor: Actor): BatchView {
  const db = getDb();
  if (input.idemKey) {
    const existing = db.prepare('SELECT * FROM payout_batches WHERE user_id = ? AND idempotency_key = ?').get(user.id, input.idemKey);
    if (existing) return batchView(existing, true);
  }
  const cur = getCurrency(input.currency);
  const rows: { input: BatchRowInput | null; error: string | null; lineNo: number }[] = [];
  if (input.csv) {
    const recs = parseCsv(input.csv);
    if (recs.length === 0) throw badRequest('The CSV has no data rows (a header row is required)', 'csv_empty');
    recs.forEach((rec, i) => {
      try { rows.push({ input: rowFromCsv(rec, cur.code), error: null, lineNo: i + 1 }); } catch (err) { rows.push({ input: { amountMinor: 0, destination: { method: (rec.method || 'unknown') as any, to: '' }, reference: rec.reference || null, name: rec.name || null }, error: (err as Error).message, lineNo: i + 1 }); }
    });
  }
  (input.rows ?? []).forEach((r, i) => rows.push({ input: r, error: null, lineNo: rows.length + i + 1 }));
  if (rows.length === 0) throw badRequest('A batch needs at least one row', 'batch_empty');
  if (rows.length > MAX_BATCH_ROWS) throw badRequest(`A batch holds at most ${MAX_BATCH_ROWS} rows`, 'batch_too_large');
  const id = `pb_${shortCode(12).toLowerCase()}`;
  let total = 0;
  let fees = 0;
  let valid = 0;
  let invalid = 0;
  db.transaction(() => {
    db.prepare('INSERT INTO payout_batches (id, user_id, reference, note, currency, status, skip_invalid, created_by, created_via, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, user.id, input.reference ?? null, input.note ?? null, cur.code, 'PENDING_APPROVAL', input.skipInvalid ? 1 : 0, actor.id ?? user.id, input.via ?? 'session', input.idemKey ?? null, now(), now());
    const ins = db.prepare('INSERT INTO payout_batch_rows (id, batch_id, line_no, method, destination, amount_minor, fee_minor, reference, name, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of rows) {
      const v = r.error || !r.input ? ({ ok: false, error: r.error ?? 'invalid row', method: r.input?.destination?.method ?? 'unknown' } as const) : validateRow(user, r.input, cur.code);
      if (v.ok) {
        valid += 1;
        total += r.input!.amountMinor;
        fees += v.fee;
        ins.run(`pr_${shortCode(12).toLowerCase()}`, id, r.lineNo, v.method, JSON.stringify(v.destination), r.input!.amountMinor, v.fee, r.input!.reference ?? null, v.name, 'VALID', null, now());
      } else {
        invalid += 1;
        ins.run(`pr_${shortCode(12).toLowerCase()}`, id, r.lineNo, v.method, JSON.stringify(r.input?.destination ?? {}), r.input?.amountMinor ?? 0, 0, r.input?.reference ?? null, r.input?.name ?? null, 'INVALID', v.error, now());
      }
    }
    db.prepare('UPDATE payout_batches SET row_count = ?, valid_rows = ?, invalid_rows = ?, total_minor = ?, fee_minor = ?, updated_at = ? WHERE id = ?').run(rows.length, valid, invalid, total, fees, now(), id);
  })();
  recordEvent('payout', id, 'payout_batch.created', actor, { rows: rows.length, valid, invalid, total, fees, currency: cur.code });
  const view = batchView(db.prepare('SELECT * FROM payout_batches WHERE id = ?').get(id), true);
  emitEvent(user.id, 'payout_batch.created', { batch: { ...view, rows: undefined } }, { resource: { type: 'payout_batch', id } });
  return view;
}

/** What the batch needs before it can run: funds and (for the creator) step-up; a second account holder approves without it. */
export function batchReadiness(user: UserRow, id: string) {
  const b = loadBatch(user.id, id);
  const wallet = getUserWallet(user.id, b.currency);
  const held = Object.values(heldByKind(wallet.id)).reduce((a, b) => a + b, 0);
  const available = wallet.balance - held;
  const needed = b.total_minor + b.fee_minor;
  return { batchId: id, status: b.status as BatchStatus, available, needed, shortfallMinor: Math.max(0, needed - available), invalidRows: b.invalid_rows, blockedByInvalidRows: b.invalid_rows > 0 && !b.skip_invalid, fourEyes: 'a different account holder approves without step-up; the creator approves with PIN or passkey' };
}

/**
 * Approve and execute. Four-eyes: an approver other than the creator needs no step-up; the creator must have passed
 * step-up (PIN or passkey token). Rows run in order; each is its own ledger transaction with an idempotency key so a
 * retried execution never pays a row twice.
 */
export function approveBatch(user: UserRow, id: string, opts: { stepUpVerified: boolean; approverId?: string | null; deviceHash?: string | null; ipCountry?: string | null }, actor: Actor): BatchView {
  const db = getDb();
  const b = loadBatch(user.id, id);
  if (b.status === 'CANCELLED') throw conflict('This batch was cancelled', 'batch_cancelled');
  if (b.status !== 'PENDING_APPROVAL' && b.status !== 'PARTIAL' && b.status !== 'FAILED') throw conflict(`This batch is already ${b.status.toLowerCase()}`, 'batch_not_pending');
  if (b.invalid_rows > 0 && !b.skip_invalid) throw unprocessable(`${b.invalid_rows} row(s) are invalid; fix the file or create the batch with skip_invalid`, 'batch_has_invalid_rows', { invalidRows: b.invalid_rows });
  const approverId = opts.approverId ?? user.id;
  const fourEyes = approverId !== b.created_by;
  if (!fourEyes && !opts.stepUpVerified) throw forbidden('The creator of a batch approves it with a PIN or passkey; another account holder can approve without step-up', 'step_up_required');
  const readiness = batchReadiness(user, id);
  if (readiness.shortfallMinor > 0) throw unprocessable(`Insufficient available balance: ${formatMoney(readiness.shortfallMinor, getCurrency(b.currency))} short`, 'insufficient_funds', { available: readiness.available, needed: readiness.needed });
  db.prepare("UPDATE payout_batches SET status = 'EXECUTING', approved_by = ?, approved_at = ?, approval_method = ?, updated_at = ? WHERE id = ?").run(approverId, now(), fourEyes ? 'four_eyes' : 'step_up', now(), id);
  recordEvent('payout', id, 'payout_batch.approved', actor, { approverId, method: fourEyes ? 'four_eyes' : 'step_up' });
  const rows = db.prepare("SELECT * FROM payout_batch_rows WHERE batch_id = ? AND status IN ('VALID', 'FAILED') ORDER BY line_no").all(id) as any[];
  let paid = 0;
  let failed = 0;
  let paidMinor = 0;
  for (const r of rows) {
    const dest = parseJson<BatchDestination>(r.destination, null as any);
    try {
      let txId: string;
      if (dest.method === 'wallet') {
        const tx = sendMoney(user, { to: dest.to, amount: r.amount_minor, currency: b.currency, note: r.reference ?? b.reference ?? `Batch ${id}`, idempotencyKey: `batch:${r.id}`, stepUpVerified: true, deviceHash: opts.deviceHash ?? null, ipCountry: opts.ipCountry ?? null });
        txId = tx.id;
      } else {
        const existing = db.prepare("SELECT id FROM transactions WHERE sender_user_id = ? AND idempotency_key = ?").get(user.id, `batch:${r.id}`) as any;
        if (existing) txId = existing.id;
        else {
          const tx = requestWithdrawal(user, { amount: r.amount_minor, currency: b.currency, destination: dest as WithdrawalDestination, note: r.reference ?? b.reference ?? `Batch ${id}`, stepUpVerified: true, deviceHash: opts.deviceHash ?? null, ipCountry: opts.ipCountry ?? null });
          db.prepare('UPDATE transactions SET idempotency_key = ? WHERE id = ?').run(`batch:${r.id}`, tx.id);
          txId = tx.id;
        }
      }
      db.prepare("UPDATE payout_batch_rows SET status = 'PAID', error = NULL, transaction_id = ?, paid_at = ? WHERE id = ?").run(txId, now(), r.id);
      paid += 1;
      paidMinor += r.amount_minor;
    } catch (err) {
      failed += 1;
      db.prepare("UPDATE payout_batch_rows SET status = 'FAILED', error = ? WHERE id = ?").run((err as any)?.message ?? String(err), r.id);
    }
  }
  const already = (db.prepare("SELECT COUNT(*) c, COALESCE(SUM(amount_minor), 0) s FROM payout_batch_rows WHERE batch_id = ? AND status = 'PAID'").get(id) as any);
  if (b.skip_invalid) db.prepare("UPDATE payout_batch_rows SET status = 'SKIPPED' WHERE batch_id = ? AND status = 'INVALID'").run(id);
  const status: BatchStatus = failed === 0 ? 'EXECUTED' : already.c > 0 ? 'PARTIAL' : 'FAILED';
  db.prepare('UPDATE payout_batches SET status = ?, paid_rows = ?, failed_rows = ?, paid_minor = ?, executed_at = ?, updated_at = ? WHERE id = ?').run(status, already.c, failed, already.s, now(), now(), id);
  recordEvent('payout', id, 'payout_batch.executed', actor, { status, paid, failed, paidMinor });
  const view = batchView(db.prepare('SELECT * FROM payout_batches WHERE id = ?').get(id), true);
  emitEvent(user.id, 'payout_batch.executed', { batch: { ...view, rows: undefined } }, { resource: { type: 'payout_batch', id } });
  notify(user.id, status === 'EXECUTED' ? 'Batch paid' : status === 'PARTIAL' ? 'Batch partly paid' : 'Batch failed', `${already.c} of ${b.row_count} rows paid (${formatMoney(already.s, getCurrency(b.currency))})${failed ? `; ${failed} failed — open the batch to see why` : ''}.`, { kind: 'withdrawal', batchId: id });
  return view;
}

export function cancelBatch(user: UserRow, id: string, actor: Actor): BatchView {
  const b = loadBatch(user.id, id);
  if (b.status !== 'PENDING_APPROVAL') throw conflict('Only a batch awaiting approval can be cancelled', 'batch_not_pending');
  getDb().prepare("UPDATE payout_batches SET status = 'CANCELLED', cancelled_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), id);
  recordEvent('payout', id, 'payout_batch.cancelled', actor, {});
  return batchView(getDb().prepare('SELECT * FROM payout_batches WHERE id = ?').get(id), true);
}
export function getBatch(userId: string, id: string): BatchView {
  return batchView(loadBatch(userId, id), true);
}
export function listBatches(userId: string, filter: { status?: string | null; limit?: number } = {}): BatchView[] {
  return (getDb().prepare(`SELECT * FROM payout_batches WHERE user_id = ? ${filter.status ? 'AND status = ?' : ''} ORDER BY created_at DESC LIMIT ?`).all(...(filter.status ? [userId, filter.status] : [userId]), Math.min(200, filter.limit ?? 50)) as any[]).map((b) => batchView(b, false));
}
/** Admin view across merchants. */
export function listAllBatches(filter: { status?: string | null; limit?: number } = {}) {
  return (getDb().prepare(`SELECT b.*, u.full_name, u.business_name FROM payout_batches b JOIN users u ON u.id = b.user_id ${filter.status ? 'WHERE b.status = ?' : ''} ORDER BY b.created_at DESC LIMIT ?`).all(...(filter.status ? [filter.status] : []), Math.min(500, filter.limit ?? 100)) as any[]).map((b) => ({ ...batchView(b, false), owner: { id: b.user_id, name: b.business_name || b.full_name, userId: findUserById(b.user_id)?.id ?? b.user_id } }));
}
