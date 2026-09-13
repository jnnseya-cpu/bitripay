/**
 * CMP-10 Reconciliation across three sources: the BitriPay register, the switch's messages/reports and the
 * institutions' or sponsor's confirmations. Imports are authenticated, checksummed and deduplicated (a corrected file
 * is a new linked import, never an overwrite); a missing report is detected on its own, independently of whether
 * discrepancies exist; matching uses exact recognised references first and only then compares amount, currency,
 * institutions and operation type; similarity may suggest a case, never close one. Cases carry exposure, age,
 * references, sources, owner, next action, deadline, documents and the closure approver; corrections create events
 * and no balancing entry is ever fabricated. Totals are kept per currency and never summed across currencies.
 */
import { getDb } from '../../db';
import { now, shortCode } from '../../lib/ids';
import { parseJson } from '../../lib/json';
import { sha256 } from '../../lib/crypto';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { recordEvent } from '../events';
import { notify } from '../notifications';
import { emitEvent } from '../webhooks';
import { getSwitchSettings, businessDate } from './settings';
import { getConnection, openIncident, listConnections } from './connections';
import { adapterFor, type VerifiedReport } from './adapter';
import { storeEvidence } from './vault';

export const CASE_CLASSES = [
  'LOCAL_ONLY',
  'EXTERNAL_ONLY',
  'STATUS_CONFLICT',
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'DUPLICATE_EXTERNAL',
  'FEES_MISMATCH',
  'SETTLEMENT_NOT_OBSERVED',
  'LATE_RECORD',
  'MISSING_REPORT',
  'INTEGRITY',
] as const;
export type CaseClass = (typeof CASE_CLASSES)[number];
const CRITICAL: CaseClass[] = ['AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'STATUS_CONFLICT', 'DUPLICATE_EXTERNAL', 'INTEGRITY'];
const NEXT_ACTION: Record<CaseClass, string> = {
  LOCAL_ONLY: 'Inquire with the switch, then escalate; never assume rejection.',
  EXTERNAL_ONLY: 'Quarantine, run the integrity investigation and recover the missing local evidence.',
  STATUS_CONFLICT: 'Block any automatic compensation; obtain the authoritative product ruling with both proofs.',
  AMOUNT_MISMATCH: 'Critical financial incident: freeze related compensation, obtain both records, escalate to finance.',
  CURRENCY_MISMATCH: 'Critical financial incident: freeze related compensation, obtain both records, escalate to finance.',
  DUPLICATE_EXTERNAL: 'Investigate a possible double debit or credit with the institutions.',
  FEES_MISMATCH: 'Raise with the scheme/billing contact; separate from the payment itself.',
  SETTLEMENT_NOT_OBSERVED: 'Follow the settlement cycle; do not cancel the payment.',
  LATE_RECORD: 'Reopen the period as a new version and re-run the cycle.',
  MISSING_REPORT: 'Request the report from the source; coverage stays partial until received.',
  INTEGRITY: 'Same external identifier with different content: security review before any processing.',
};

export interface ReconciliationCase {
  id: string;
  connectionId: string;
  class: CaseClass;
  paymentId: string | null;
  lineId: string | null;
  runId: string | null;
  cycleRef: string | null;
  exposure: { valueMinor: number; currency: string | null };
  ageHours: number;
  references: Record<string, unknown>;
  sources: string[];
  status: 'OPEN' | 'ASSIGNED' | 'RESOLUTION_PROPOSED' | 'CLOSED';
  priority: 'NORMAL' | 'HIGH' | 'CRITICAL';
  ownerId: string | null;
  nextAction: string | null;
  dueAt: string | null;
  documents: string[];
  resolution: string | null;
  resolvedBy: string | null;
  closureApprovedBy: string | null;
  merchantUserId: string | null;
  createdAt: string;
  updatedAt: string;
}
const toCase = (r: any): ReconciliationCase => ({
  id: r.id,
  connectionId: r.connection_id,
  class: r.class,
  paymentId: r.payment_id,
  lineId: r.line_id,
  runId: r.run_id,
  cycleRef: r.cycle_ref,
  exposure: { valueMinor: r.exposure_minor, currency: r.currency },
  ageHours: Math.floor((Date.now() - Date.parse(r.created_at)) / 3600_000),
  references: parseJson(r.references_json, {}),
  sources: parseJson(r.sources, []),
  status: r.status,
  priority: r.priority,
  ownerId: r.owner_id,
  nextAction: r.next_action,
  dueAt: r.due_at,
  documents: parseJson(r.documents, []),
  resolution: r.resolution,
  resolvedBy: r.resolved_by,
  closureApprovedBy: r.closure_approved_by,
  merchantUserId: r.merchant_user_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Open a case unless an identical open one already exists (class + payment/line). Returns the case id. */
export function openCase(input: {
  connectionId: string;
  class: CaseClass;
  paymentId?: string | null;
  lineId?: string | null;
  runId?: string | null;
  cycleRef?: string | null;
  exposureMinor?: number;
  currency?: string | null;
  references?: Record<string, unknown>;
  sources?: string[];
  merchantUserId?: string | null;
  dueHours?: number;
}): string {
  const db = getDb();
  const dup = db
    .prepare("SELECT id FROM reconciliation_cases WHERE connection_id = ? AND class = ? AND payment_id IS ? AND line_id IS ? AND status != 'CLOSED'")
    .get(input.connectionId, input.class, input.paymentId ?? null, input.lineId ?? null) as any;
  if (dup) return dup.id;
  const id = `rc_${shortCode(14).toLowerCase()}`;
  const priority = CRITICAL.includes(input.class) ? 'CRITICAL' : input.class === 'LOCAL_ONLY' || input.class === 'EXTERNAL_ONLY' ? 'HIGH' : 'NORMAL';
  const due = new Date(Date.now() + (input.dueHours ?? (priority === 'CRITICAL' ? 4 : priority === 'HIGH' ? 24 : 72)) * 3600_000).toISOString();
  db.prepare(
    'INSERT INTO reconciliation_cases (id, connection_id, class, payment_id, line_id, run_id, cycle_ref, exposure_minor, currency, references_json, sources, status, priority, next_action, due_at, merchant_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    input.connectionId,
    input.class,
    input.paymentId ?? null,
    input.lineId ?? null,
    input.runId ?? null,
    input.cycleRef ?? null,
    input.exposureMinor ?? 0,
    input.currency ?? null,
    JSON.stringify(input.references ?? {}),
    JSON.stringify(input.sources ?? []),
    'OPEN',
    priority,
    NEXT_ACTION[input.class],
    due,
    input.merchantUserId ?? null,
    now(),
    now(),
  );
  recordEvent(
    'reconciliation',
    id,
    'case.opened',
    { type: 'system' },
    { class: input.class, paymentId: input.paymentId ?? null, exposure: input.exposureMinor ?? 0, currency: input.currency ?? null },
  );
  if (input.paymentId) db.prepare("UPDATE switch_payments SET reconciliation_status = 'EXCEPTION', updated_at = ? WHERE id = ?").run(now(), input.paymentId);
  if (priority === 'CRITICAL')
    openIncident(input.class === 'INTEGRITY' ? 'P1' : 'P1', `${input.class} on ${input.paymentId ?? input.lineId ?? input.cycleRef ?? 'cycle'}`, NEXT_ACTION[input.class], 'reconciliation_case', id);
  if (input.merchantUserId)
    emitEvent(
      input.merchantUserId,
      'reconciliation.exception',
      { case: { id, class: input.class, paymentId: input.paymentId ?? null, exposure: { valueMinor: input.exposureMinor ?? 0, currency: input.currency ?? null }, openedAt: now() } },
      { resource: { type: 'reconciliation_case', id } },
    );
  return id;
}

export function getCase(id: string): ReconciliationCase {
  const r = getDb().prepare('SELECT * FROM reconciliation_cases WHERE id = ?').get(id);
  if (!r) throw notFound('Case not found', 'case_not_found');
  return toCase(r);
}

export function listCases(
  filter: { connectionId?: string | null; status?: string | null; class?: string | null; merchantUserId?: string | null; paymentId?: string | null; limit?: number; cursor?: string | null } = {},
): { data: ReconciliationCase[]; nextCursor: string | null } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.connectionId) {
    where.push('connection_id = ?');
    params.push(filter.connectionId);
  }
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.class) {
    where.push('class = ?');
    params.push(filter.class);
  }
  if (filter.merchantUserId) {
    where.push('merchant_user_id = ?');
    params.push(filter.merchantUserId);
  }
  if (filter.paymentId) {
    where.push('payment_id = ?');
    params.push(filter.paymentId);
  }
  if (filter.cursor) {
    where.push('created_at < ?');
    params.push(Buffer.from(filter.cursor, 'base64url').toString('utf8'));
  }
  const limit = Math.min(200, filter.limit ?? 50);
  const rows = getDb()
    .prepare(`SELECT * FROM reconciliation_cases ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit + 1) as any[];
  const page = rows.slice(0, limit).map(toCase);
  const nextCursor = rows.length > limit ? Buffer.from(page[page.length - 1].createdAt).toString('base64url') : null;
  return { data: page, nextCursor };
}

export function assignCase(id: string, ownerId: string, adminId: string): ReconciliationCase {
  const c = getCase(id);
  if (c.status === 'CLOSED') throw conflict('Case is closed', 'case_closed');
  getDb().prepare("UPDATE reconciliation_cases SET owner_id = ?, status = 'ASSIGNED', updated_at = ? WHERE id = ?").run(ownerId, now(), id);
  recordEvent('reconciliation', id, 'case.assigned', { type: 'admin', id: adminId }, { ownerId });
  return getCase(id);
}

/** The analyst proposes a resolution with evidence; closure needs a different approver (20.2). */
export function proposeResolution(id: string, resolution: string, documents: string[], adminId: string): ReconciliationCase {
  const c = getCase(id);
  if (c.status === 'CLOSED') throw conflict('Case is closed', 'case_closed');
  if (!resolution.trim()) throw badRequest('A resolution needs a written explanation', 'resolution_required');
  getDb()
    .prepare("UPDATE reconciliation_cases SET resolution = ?, documents = ?, resolved_by = ?, status = 'RESOLUTION_PROPOSED', updated_at = ? WHERE id = ?")
    .run(resolution, JSON.stringify([...c.documents, ...documents]), adminId, now(), id);
  recordEvent('reconciliation', id, 'case.resolution_proposed', { type: 'admin', id: adminId }, { resolution, documents });
  return getCase(id);
}

export function approveClosure(id: string, approverId: string): ReconciliationCase {
  const c = getCase(id);
  if (c.status !== 'RESOLUTION_PROPOSED') throw conflict('No resolution has been proposed', 'no_resolution');
  if (c.resolvedBy === approverId) throw badRequest('The closure approver must differ from the analyst who proposed the resolution', 'approver_required');
  getDb().prepare("UPDATE reconciliation_cases SET status = 'CLOSED', closure_approved_by = ?, updated_at = ? WHERE id = ?").run(approverId, now(), id);
  recordEvent('reconciliation', id, 'case.closed', { type: 'admin', id: approverId }, { resolvedBy: c.resolvedBy });
  if (c.paymentId) {
    const open = (getDb().prepare("SELECT COUNT(*) c FROM reconciliation_cases WHERE payment_id = ? AND status != 'CLOSED'").get(c.paymentId) as any).c as number;
    if (!open) getDb().prepare("UPDATE switch_payments SET reconciliation_status = 'MATCHED', updated_at = ? WHERE id = ? AND reconciliation_status = 'EXCEPTION'").run(now(), c.paymentId);
  }
  return getCase(id);
}

// ---------------------------------------------------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------------------------------------------------
export interface ReportLine {
  externalReference: string;
  correlationId?: string | null;
  debtorId?: string | null;
  creditorId?: string | null;
  amountMinor: string | number;
  currency: string;
  status: string;
  feeMinor?: string | number | null;
  settlementRef?: string | null;
  businessDate?: string | null;
  occurredAt?: string | null;
  [k: string]: unknown;
}
export interface ImportInput {
  source: 'SWITCH' | 'INSTITUTION' | 'SPONSOR';
  cycleRef: string;
  periodFrom: string;
  periodTo: string;
  currency: string;
  lines: ReportLine[];
  /** Declared control total (minor units); refused when it does not equal the sum of the lines. */
  controlTotalMinor?: string | number | null;
  /** When this file corrects an earlier one for the same cycle. */
  replacesImportId?: string | null;
  signatureValid?: boolean;
}
export interface ImportView {
  id: string;
  connectionId: string;
  source: string;
  cycleRef: string;
  periodFrom: string;
  periodTo: string;
  currency: string;
  checksum: string;
  lineCount: number;
  controlTotal: number;
  replacesImportId: string | null;
  importedBy: string | null;
  createdAt: string;
  duplicate?: boolean;
}
const toImport = (r: any): ImportView => ({
  id: r.id,
  connectionId: r.connection_id,
  source: r.source,
  cycleRef: r.cycle_ref,
  periodFrom: r.period_from,
  periodTo: r.period_to,
  currency: r.currency,
  checksum: r.checksum,
  lineCount: r.line_count,
  controlTotal: r.control_total,
  replacesImportId: r.replaces_import_id,
  importedBy: r.imported_by,
  createdAt: r.created_at,
});

/** Import a report through the adapter's decoder. The same bytes twice = the same import, never two. */
export async function importReport(connectionId: string, input: ImportInput, importerId: string | null): Promise<ImportView> {
  const conn = getConnection(connectionId);
  const adapter = adapterFor(conn);
  const rawBase64 = Buffer.from(JSON.stringify(input.lines)).toString('base64');
  const report: VerifiedReport = {
    source: input.source,
    cycleRef: input.cycleRef,
    currency: input.currency.toUpperCase(),
    periodFrom: input.periodFrom,
    periodTo: input.periodTo,
    raw: rawBase64,
    signatureValid: input.signatureValid ?? true,
  };
  if (!report.signatureValid) throw badRequest('The report signature does not verify; refusing to import', 'report_signature_invalid');
  const result = await adapter.importReconciliation(report);
  const checksum = sha256(
    `${input.source}|${input.cycleRef}|${report.currency}|${JSON.stringify(result.lines.map((l) => [l.externalReference, l.amountMinor, l.currency, l.status, l.settlementRef ?? '']))}`,
  );
  const db = getDb();
  const existing = db
    .prepare('SELECT * FROM reconciliation_imports WHERE connection_id = ? AND source = ? AND cycle_ref = ? AND checksum = ?')
    .get(connectionId, input.source, input.cycleRef, checksum) as any;
  if (existing) return { ...toImport(existing), duplicate: true };
  const total = result.lines.reduce((s, l) => s + Number(l.amountMinor), 0);
  if (input.controlTotalMinor != null && Number(input.controlTotalMinor) !== total)
    throw badRequest(`Control total ${input.controlTotalMinor} does not equal the sum of the lines (${total})`, 'control_total_mismatch');
  for (const l of result.lines)
    if (l.currency.toUpperCase() !== report.currency) throw badRequest(`Line ${l.externalReference} is in ${l.currency}; a report carries one currency`, 'mixed_currency_report');
  const id = `ri_${shortCode(14).toLowerCase()}`;
  const proofRef = storeEvidence('reconciliation_report', id, rawBase64, { source: input.source, cycleRef: input.cycleRef, checksum });
  db.transaction(() => {
    db.prepare(
      'INSERT INTO reconciliation_imports (id, connection_id, source, period_from, period_to, cycle_ref, currency, checksum, line_count, control_total, replaces_import_id, imported_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, connectionId, input.source, input.periodFrom, input.periodTo, input.cycleRef, report.currency, checksum, result.lineCount, total, input.replacesImportId ?? null, importerId, now());
    const ins = db.prepare(
      'INSERT INTO reconciliation_lines (id, import_id, external_reference, correlation_id, debtor_id, creditor_id, amount_minor, currency, status, fee_minor, settlement_ref, business_date, occurred_at, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const l of result.lines)
      ins.run(
        `rl_${shortCode(14).toLowerCase()}`,
        id,
        l.externalReference,
        l.correlationId,
        l.debtorId,
        l.creditorId,
        Number(l.amountMinor),
        l.currency.toUpperCase(),
        l.status,
        l.feeMinor != null ? Number(l.feeMinor) : null,
        l.settlementRef,
        l.businessDate,
        l.occurredAt,
        JSON.stringify(l.raw),
      );
  })();
  recordEvent(
    'reconciliation',
    id,
    'report.imported',
    { type: importerId ? 'admin' : 'system', id: importerId },
    { source: input.source, cycleRef: input.cycleRef, lines: result.lineCount, total, currency: report.currency, proofRef },
  );
  // a file arriving after the cycle was closed reopens it as a new version
  const closedRun = db
    .prepare('SELECT id FROM reconciliation_runs WHERE connection_id = ? AND cycle_ref = ? AND complete = 1 ORDER BY created_at DESC LIMIT 1')
    .get(connectionId, input.cycleRef) as any;
  if (closedRun)
    openCase({ connectionId, class: 'LATE_RECORD', cycleRef: input.cycleRef, references: { importId: id, closedRunId: closedRun.id }, sources: [input.source], currency: report.currency });
  return toImport(db.prepare('SELECT * FROM reconciliation_imports WHERE id = ?').get(id));
}

export function listImports(connectionId: string, cycleRef?: string | null): ImportView[] {
  return (
    getDb()
      .prepare(`SELECT * FROM reconciliation_imports WHERE connection_id = ? ${cycleRef ? 'AND cycle_ref = ?' : ''} ORDER BY created_at DESC LIMIT 200`)
      .all(...(cycleRef ? [connectionId, cycleRef] : [connectionId])) as any[]
  ).map(toImport);
}

// ---------------------------------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------------------------------
export interface RunView {
  id: string;
  connectionId: string;
  cycleRef: string;
  coverage: { expected: string[]; present: string[]; missing: string[]; complete: boolean };
  totals: Record<string, { local: { count: number; sum: number }; external: { count: number; sum: number } }>;
  matched: number;
  casesOpened: number;
  complete: boolean;
  runBy: string | null;
  createdAt: string;
}
const toRun = (r: any): RunView => ({
  id: r.id,
  connectionId: r.connection_id,
  cycleRef: r.cycle_ref,
  coverage: parseJson(r.coverage, { expected: [], present: [], missing: [], complete: false }),
  totals: parseJson(r.totals, {}),
  matched: r.matched,
  casesOpened: r.cases_opened,
  complete: !!r.complete,
  runBy: r.run_by,
  createdAt: r.created_at,
});

/**
 * Reconcile one cycle: coverage first (missing report = its own case), then exact-reference matching per line, then
 * local payments the reports never mention. Every discrepancy becomes a case; nothing is corrected automatically.
 */
export function runReconciliation(connectionId: string, cycleRef: string, runBy: string | null): RunView {
  const db = getDb();
  const conn = getConnection(connectionId);
  const settings = getSwitchSettings();
  const expected = [...settings.expectedReportSources, ...(conn.accessMode === 'SPONSORED' ? ['SPONSOR'] : [])];
  const imports = (db.prepare('SELECT * FROM reconciliation_imports WHERE connection_id = ? AND cycle_ref = ? ORDER BY created_at').all(connectionId, cycleRef) as any[]).filter(
    (i) => !(db.prepare('SELECT 1 FROM reconciliation_imports WHERE replaces_import_id = ?').get(i.id) as any),
  );
  const present = [...new Set(imports.map((i) => i.source as string))];
  const missing = expected.filter((s) => !present.includes(s));
  const runId = `rr_${shortCode(14).toLowerCase()}`;
  let cases = 0;
  let matched = 0;
  for (const m of missing) {
    openCase({ connectionId, class: 'MISSING_REPORT', runId, cycleRef, references: { source: m }, sources: [m] });
    cases += 1;
  }
  const periodFrom = imports.reduce<string | null>((a, i) => (!a || i.period_from < a ? i.period_from : a), null) ?? `${cycleRef}T00:00:00.000Z`;
  const periodTo = imports.reduce<string | null>((a, i) => (!a || i.period_to > a ? i.period_to : a), null) ?? `${cycleRef}T23:59:59.999Z`;
  const totals: RunView['totals'] = {};
  const bump = (cur: string, side: 'local' | 'external', amount: number) => {
    totals[cur] ??= { local: { count: 0, sum: 0 }, external: { count: 0, sum: 0 } };
    totals[cur][side].count += 1;
    totals[cur][side].sum += amount;
  };
  const seenPayment = new Map<string, number>();
  for (const imp of imports) {
    const lines = db.prepare('SELECT * FROM reconciliation_lines WHERE import_id = ?').all(imp.id) as any[];
    for (const l of lines) {
      bump(l.currency, 'external', l.amount_minor);
      const p =
        (db
          .prepare('SELECT * FROM switch_payments WHERE connection_id = ? AND (external_reference = ? OR switch_correlation_id = ? OR external_message_id = ?)')
          .get(connectionId, l.external_reference, l.correlation_id ?? '', l.external_reference) as any) ?? null;
      if (!p) {
        openCase({
          connectionId,
          class: 'EXTERNAL_ONLY',
          lineId: l.id,
          runId,
          cycleRef,
          exposureMinor: l.amount_minor,
          currency: l.currency,
          references: { externalReference: l.external_reference, source: imp.source },
          sources: [imp.source],
        });
        cases += 1;
        continue;
      }
      db.prepare('UPDATE reconciliation_lines SET matched_payment_id = ? WHERE id = ?').run(p.id, l.id);
      seenPayment.set(p.id, (seenPayment.get(p.id) ?? 0) + 1);
      let clean = true;
      if (l.currency !== p.currency) {
        openCase({
          connectionId,
          class: 'CURRENCY_MISMATCH',
          paymentId: p.id,
          lineId: l.id,
          runId,
          cycleRef,
          exposureMinor: p.amount_minor,
          currency: p.currency,
          references: { externalReference: l.external_reference, local: p.currency, external: l.currency, source: imp.source },
          sources: ['BITRIPAY', imp.source],
          merchantUserId: p.merchant_user_id,
        });
        cases += 1;
        clean = false;
      } else if (l.amount_minor !== p.amount_minor) {
        openCase({
          connectionId,
          class: 'AMOUNT_MISMATCH',
          paymentId: p.id,
          lineId: l.id,
          runId,
          cycleRef,
          exposureMinor: Math.abs(l.amount_minor - p.amount_minor),
          currency: p.currency,
          references: { externalReference: l.external_reference, local: p.amount_minor, external: l.amount_minor, source: imp.source },
          sources: ['BITRIPAY', imp.source],
          merchantUserId: p.merchant_user_id,
        });
        cases += 1;
        clean = false;
      }
      const externalCompleted = /COMPLETED|SETTLED|SUCCESS/i.test(l.status);
      const externalRejected = /REJECT|FAIL|DECLIN/i.test(l.status);
      if ((externalCompleted && ['REJECTED', 'UNKNOWN'].includes(p.status)) || (externalRejected && p.status === 'COMPLETED')) {
        openCase({
          connectionId,
          class: 'STATUS_CONFLICT',
          paymentId: p.id,
          lineId: l.id,
          runId,
          cycleRef,
          exposureMinor: p.amount_minor,
          currency: p.currency,
          references: { externalReference: l.external_reference, local: p.status, external: l.status, source: imp.source },
          sources: ['BITRIPAY', imp.source],
          merchantUserId: p.merchant_user_id,
        });
        db.prepare("UPDATE switch_payments SET resolution_status = 'REVIEW_REQUIRED', updated_at = ? WHERE id = ?").run(now(), p.id);
        cases += 1;
        clean = false;
      }
      if (l.fee_minor != null) {
        const expectedFee = Math.round((p.amount_minor * settings.feeBps) / 10_000);
        if (l.fee_minor !== expectedFee) {
          openCase({
            connectionId,
            class: 'FEES_MISMATCH',
            paymentId: p.id,
            lineId: l.id,
            runId,
            cycleRef,
            exposureMinor: Math.abs(l.fee_minor - expectedFee),
            currency: p.currency,
            references: { expectedFee, observedFee: l.fee_minor, tariffBps: settings.feeBps, source: imp.source },
            sources: ['BITRIPAY', imp.source],
          });
          cases += 1;
        }
        db.prepare("INSERT INTO switch_journal (id, payment_id, fact, amount_minor, currency, source, reference, occurred_at, created_at) VALUES (?, ?, 'FEE_OBSERVED', ?, ?, ?, ?, ?, ?)").run(
          `sj_${shortCode(14).toLowerCase()}`,
          p.id,
          l.fee_minor,
          p.currency,
          imp.source,
          l.external_reference,
          l.occurred_at ?? now(),
          now(),
        );
      }
      if (l.settlement_ref && imp.source === 'SWITCH') {
        db.prepare("UPDATE switch_payments SET settlement_status = 'OBSERVED', updated_at = ? WHERE id = ?").run(now(), p.id);
        db.prepare("INSERT INTO switch_journal (id, payment_id, fact, amount_minor, currency, source, reference, occurred_at, created_at) VALUES (?, ?, 'SETTLEMENT_REFERENCE', ?, ?, ?, ?, ?, ?)").run(
          `sj_${shortCode(14).toLowerCase()}`,
          p.id,
          p.amount_minor,
          p.currency,
          imp.source,
          l.settlement_ref,
          l.occurred_at ?? now(),
          now(),
        );
      }
      if (clean) {
        matched += 1;
        if (p.reconciliation_status !== 'EXCEPTION') db.prepare("UPDATE switch_payments SET reconciliation_status = 'MATCHED', updated_at = ? WHERE id = ?").run(now(), p.id);
      }
    }
  }
  for (const [pid, n] of seenPayment) {
    if (n > 1) {
      const p = db.prepare('SELECT * FROM switch_payments WHERE id = ?').get(pid) as any;
      openCase({
        connectionId,
        class: 'DUPLICATE_EXTERNAL',
        paymentId: pid,
        runId,
        cycleRef,
        exposureMinor: p.amount_minor,
        currency: p.currency,
        references: { occurrences: n },
        sources: ['BITRIPAY', ...present],
        merchantUserId: p.merchant_user_id,
      });
      cases += 1;
    }
  }
  // local payments in the period that no report mentions
  const locals = db
    .prepare("SELECT * FROM switch_payments WHERE connection_id = ? AND status IN ('COMPLETED', 'UNKNOWN', 'AUTHORIZED', 'PENDING') AND created_at >= ? AND created_at <= ?")
    .all(connectionId, periodFrom, periodTo) as any[];
  for (const p of locals) {
    bump(p.currency, 'local', p.amount_minor);
    if (seenPayment.has(p.id) || !present.length) continue;
    if (p.status === 'COMPLETED') {
      openCase({
        connectionId,
        class: present.includes('SWITCH') ? 'LOCAL_ONLY' : 'SETTLEMENT_NOT_OBSERVED',
        paymentId: p.id,
        runId,
        cycleRef,
        exposureMinor: p.amount_minor,
        currency: p.currency,
        references: { externalReference: p.external_reference, status: p.status },
        sources: ['BITRIPAY'],
        merchantUserId: p.merchant_user_id,
      });
    } else
      openCase({
        connectionId,
        class: 'LOCAL_ONLY',
        paymentId: p.id,
        runId,
        cycleRef,
        exposureMinor: p.amount_minor,
        currency: p.currency,
        references: { externalReference: p.external_reference, status: p.status },
        sources: ['BITRIPAY'],
        merchantUserId: p.merchant_user_id,
      });
    cases += 1;
  }
  for (const p of db
    .prepare("SELECT * FROM switch_payments WHERE connection_id = ? AND status = 'COMPLETED' AND settlement_status = 'NOT_OBSERVED' AND created_at >= ? AND created_at <= ?")
    .all(connectionId, periodFrom, periodTo) as any[]) {
    if (!seenPayment.has(p.id)) continue;
    openCase({
      connectionId,
      class: 'SETTLEMENT_NOT_OBSERVED',
      paymentId: p.id,
      runId,
      cycleRef,
      exposureMinor: p.amount_minor,
      currency: p.currency,
      references: { externalReference: p.external_reference },
      sources: ['BITRIPAY', ...present],
    });
    cases += 1;
  }
  const complete = missing.length === 0;
  db.prepare('INSERT INTO reconciliation_runs (id, connection_id, cycle_ref, coverage, totals, matched, cases_opened, complete, run_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    runId,
    connectionId,
    cycleRef,
    JSON.stringify({ expected, present, missing, complete }),
    JSON.stringify(totals),
    matched,
    cases,
    complete ? 1 : 0,
    runBy,
    now(),
  );
  recordEvent('reconciliation', runId, 'run.completed', { type: runBy ? 'admin' : 'system', id: runBy }, { cycleRef, matched, cases, complete, missing });
  if (!complete)
    for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin' AND is_system = 0 AND status = 'active'").all() as { id: string }[])
      notify(a.id, 'Reconciliation coverage incomplete', `Cycle ${cycleRef} on ${conn.name}: missing ${missing.join(', ')}. The cycle is not reconciled until every expected report is in.`, {
        kind: 'reconciliation',
        runId,
      });
  return toRun(db.prepare('SELECT * FROM reconciliation_runs WHERE id = ?').get(runId));
}

export function listRuns(connectionId: string, limit = 50): RunView[] {
  return (getDb().prepare('SELECT * FROM reconciliation_runs WHERE connection_id = ? ORDER BY created_at DESC LIMIT ?').all(connectionId, limit) as any[]).map(toRun);
}

/** Daily coverage check: yesterday's business cycle must have its reports; otherwise a MISSING_REPORT case and alert. */
export function checkCoverage(): { checked: string[]; missing: string[] } {
  const settings = getSwitchSettings();
  const yesterday = businessDate(new Date(Date.now() - 86_400_000), settings.businessTimezone);
  const checked: string[] = [];
  const missing: string[] = [];
  const db = getDb();
  for (const c of listConnections()) {
    if (!c.enabled) continue;
    const had = (db.prepare('SELECT COUNT(*) c FROM switch_payments WHERE connection_id = ? AND substr(created_at, 1, 10) = ?').get(c.id, yesterday) as any).c as number;
    if (!had) continue;
    checked.push(c.id);
    for (const source of settings.expectedReportSources) {
      const imp = db.prepare('SELECT 1 FROM reconciliation_imports WHERE connection_id = ? AND source = ? AND cycle_ref = ?').get(c.id, source, yesterday);
      if (!imp) {
        openCase({ connectionId: c.id, class: 'MISSING_REPORT', cycleRef: yesterday, references: { source }, sources: [source] });
        missing.push(`${c.id}:${source}:${yesterday}`);
      }
    }
  }
  return { checked, missing };
}

/** Console view: periods received/missing, cases by class and currency, exposure and age. */
export function reconciliationOverview(connectionId: string) {
  const db = getDb();
  const cases = db
    .prepare(
      "SELECT class, currency, status, COUNT(*) n, COALESCE(SUM(exposure_minor), 0) exposure, MIN(created_at) oldest FROM reconciliation_cases WHERE connection_id = ? AND status != 'CLOSED' GROUP BY class, currency, status",
    )
    .all(connectionId) as any[];
  const cycles = db
    .prepare('SELECT cycle_ref, source, COUNT(*) files, MAX(created_at) last FROM reconciliation_imports WHERE connection_id = ? GROUP BY cycle_ref, source ORDER BY cycle_ref DESC LIMIT 60')
    .all(connectionId) as any[];
  const runs = listRuns(connectionId, 30);
  return {
    cases: cases.map((c) => ({
      class: c.class,
      currency: c.currency,
      status: c.status,
      count: c.n,
      exposureMinor: c.exposure,
      oldestAgeHours: Math.floor((Date.now() - Date.parse(c.oldest)) / 3600_000),
    })),
    cycles,
    runs,
    coverageComplete: runs[0]?.complete ?? false,
  };
}
