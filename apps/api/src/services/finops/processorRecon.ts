/**
 * Three-way reconciliation for processors and bank rails: the ledger (transactions), the gateway records
 * (gateway_payments with the provider reference) and the processor's or bank's statement. Reuses the reconciliation
 * import/case machinery of the switch (imports keyed by `gateway:<id>`), so the operations workbench shows every rail
 * the same way: coverage, matched items, exceptions by class with exposure and age, never an automatic correction.
 */
import { getDb } from '../../db';
import { now, shortCode } from '../../lib/ids';
import { sha256 } from '../../lib/crypto';
import { badRequest } from '../../lib/errors';
import { recordEvent } from '../events';
import { getGateway } from '../../payments';
import { calculateFee } from '../ledger';
import { openCase, listCases } from '../switch/reconciliation';
import { storeEvidence } from '../switch/vault';

export interface ProcessorLine {
  reference: string;
  amountMinor: number | string;
  currency: string;
  status: string;
  feeMinor?: number | string | null;
  settlementRef?: string | null;
  occurredAt?: string | null;
}

export function importProcessorStatement(gatewayId: string, input: { source: 'PROCESSOR' | 'BANK'; cycleRef: string; currency: string; lines: ProcessorLine[]; controlTotalMinor?: number | string | null; periodFrom?: string | null; periodTo?: string | null }, importerId: string | null) {
  const gw = getGateway(gatewayId);
  if (!gw) throw badRequest('Unknown gateway', 'unknown_gateway');
  if (!input.lines.length) throw badRequest('The statement has no lines', 'empty_statement');
  const connectionId = `gateway:${gatewayId}`;
  const currency = input.currency.toUpperCase();
  for (const l of input.lines) if (l.currency.toUpperCase() !== currency) throw badRequest(`Line ${l.reference} is in ${l.currency}; a statement carries one currency`, 'mixed_currency_report');
  const total = input.lines.reduce((s, l) => s + Number(l.amountMinor), 0);
  if (input.controlTotalMinor != null && Number(input.controlTotalMinor) !== total) throw badRequest(`Control total ${input.controlTotalMinor} does not equal the sum of the lines (${total})`, 'control_total_mismatch');
  const checksum = sha256(`${input.source}|${input.cycleRef}|${currency}|${JSON.stringify(input.lines.map((l) => [l.reference, String(l.amountMinor), l.status, l.settlementRef ?? '']))}`);
  const db = getDb();
  const existing = db.prepare('SELECT * FROM reconciliation_imports WHERE connection_id = ? AND source = ? AND cycle_ref = ? AND checksum = ?').get(connectionId, input.source, input.cycleRef, checksum) as any;
  if (existing) return { id: existing.id, duplicate: true, lineCount: existing.line_count, controlTotal: existing.control_total };
  const id = `ri_${shortCode(14).toLowerCase()}`;
  const proofRef = storeEvidence('processor_statement', id, Buffer.from(JSON.stringify(input.lines)).toString('base64'), { gatewayId, source: input.source, cycleRef: input.cycleRef, checksum });
  db.transaction(() => {
    db.prepare('INSERT INTO reconciliation_imports (id, connection_id, source, period_from, period_to, cycle_ref, currency, checksum, line_count, control_total, imported_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, connectionId, input.source, input.periodFrom ?? `${input.cycleRef}T00:00:00.000Z`, input.periodTo ?? `${input.cycleRef}T23:59:59.999Z`, input.cycleRef, currency, checksum, input.lines.length, total, importerId, now());
    const ins = db.prepare('INSERT INTO reconciliation_lines (id, import_id, external_reference, amount_minor, currency, status, fee_minor, settlement_ref, occurred_at, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const l of input.lines) ins.run(`rl_${shortCode(14).toLowerCase()}`, id, l.reference, Number(l.amountMinor), currency, l.status, l.feeMinor != null ? Number(l.feeMinor) : null, l.settlementRef ?? null, l.occurredAt ?? null, JSON.stringify(l));
  })();
  recordEvent('reconciliation', id, 'processor_statement.imported', { type: importerId ? 'admin' : 'system', id: importerId }, { gatewayId, source: input.source, cycleRef: input.cycleRef, lines: input.lines.length, total, proofRef });
  return { id, duplicate: false, lineCount: input.lines.length, controlTotal: total };
}

/** Match statement lines to gateway payments (provider reference) and their ledger transactions; open cases for every discrepancy. */
export function runProcessorReconciliation(gatewayId: string, cycleRef: string, runBy: string | null) {
  const db = getDb();
  const connectionId = `gateway:${gatewayId}`;
  const imports = db.prepare('SELECT * FROM reconciliation_imports WHERE connection_id = ? AND cycle_ref = ? ORDER BY created_at').all(connectionId, cycleRef) as any[];
  const present = [...new Set(imports.map((i) => i.source as string))];
  const expected = ['PROCESSOR'];
  const missing = expected.filter((s) => !present.includes(s));
  const runId = `rr_${shortCode(14).toLowerCase()}`;
  let matched = 0;
  let cases = 0;
  for (const m of missing) {
    openCase({ connectionId, class: 'MISSING_REPORT', runId, cycleRef, references: { source: m, gatewayId }, sources: [m] });
    cases += 1;
  }
  const seen = new Map<string, number>();
  const totals: Record<string, { local: { count: number; sum: number }; external: { count: number; sum: number } }> = {};
  const bump = (cur: string, side: 'local' | 'external', amount: number) => {
    totals[cur] ??= { local: { count: 0, sum: 0 }, external: { count: 0, sum: 0 } };
    totals[cur][side].count += 1;
    totals[cur][side].sum += amount;
  };
  let periodFrom = `${cycleRef}T00:00:00.000Z`;
  let periodTo = `${cycleRef}T23:59:59.999Z`;
  for (const imp of imports) {
    periodFrom = imp.period_from < periodFrom ? imp.period_from : periodFrom;
    periodTo = imp.period_to > periodTo ? imp.period_to : periodTo;
    for (const l of db.prepare('SELECT * FROM reconciliation_lines WHERE import_id = ?').all(imp.id) as any[]) {
      bump(l.currency, 'external', l.amount_minor);
      const gp = db.prepare('SELECT * FROM gateway_payments WHERE gateway = ? AND provider_ref = ?').get(gatewayId, l.external_reference) as any;
      if (!gp) {
        openCase({ connectionId, class: 'EXTERNAL_ONLY', lineId: l.id, runId, cycleRef, exposureMinor: l.amount_minor, currency: l.currency, references: { reference: l.external_reference, source: imp.source, gatewayId }, sources: [imp.source] });
        cases += 1;
        continue;
      }
      db.prepare('UPDATE reconciliation_lines SET matched_payment_id = ? WHERE id = ?').run(gp.id, l.id);
      seen.set(gp.id, (seen.get(gp.id) ?? 0) + 1);
      let clean = true;
      if (l.currency !== gp.currency) {
        openCase({ connectionId, class: 'CURRENCY_MISMATCH', paymentId: gp.id, lineId: l.id, runId, cycleRef, exposureMinor: gp.amount, currency: gp.currency, references: { reference: l.external_reference, local: gp.currency, external: l.currency }, sources: ['BITRIPAY', imp.source], merchantUserId: gp.user_id });
        cases += 1;
        clean = false;
      } else if (l.amount_minor !== gp.amount) {
        openCase({ connectionId, class: 'AMOUNT_MISMATCH', paymentId: gp.id, lineId: l.id, runId, cycleRef, exposureMinor: Math.abs(l.amount_minor - gp.amount), currency: gp.currency, references: { reference: l.external_reference, local: gp.amount, external: l.amount_minor }, sources: ['BITRIPAY', imp.source] });
        cases += 1;
        clean = false;
      }
      const extOk = /SETTLED|SUCCESS|COMPLETED|PAID/i.test(l.status);
      const extBad = /FAIL|DECLIN|REJECT|REVERS|CHARGEBACK/i.test(l.status);
      if ((extOk && !['SETTLED', 'DISPUTED'].includes(gp.stage)) || (extBad && gp.stage === 'SETTLED')) {
        openCase({ connectionId, class: 'STATUS_CONFLICT', paymentId: gp.id, lineId: l.id, runId, cycleRef, exposureMinor: gp.amount, currency: gp.currency, references: { reference: l.external_reference, local: gp.stage, external: l.status }, sources: ['BITRIPAY', imp.source] });
        cases += 1;
        clean = false;
      }
      // the ledger leg: a settled gateway payment must have exactly one completed transaction of the same amount
      if (gp.stage === 'SETTLED') {
        const tx = gp.transaction_id ? (db.prepare('SELECT amount, status, currency FROM transactions WHERE id = ?').get(gp.transaction_id) as any) : null;
        if (!tx || tx.status !== 'completed' || tx.amount !== gp.amount) {
          openCase({ connectionId, class: 'LOCAL_ONLY', paymentId: gp.id, lineId: l.id, runId, cycleRef, exposureMinor: gp.amount, currency: gp.currency, references: { reference: l.external_reference, ledger: tx ? { amount: tx.amount, status: tx.status } : null }, sources: ['BITRIPAY'] });
          cases += 1;
          clean = false;
        }
      }
      if (l.fee_minor != null) {
        const expectedFee = calculateFee(gp.purpose === 'checkout' ? 'merchant_payment' : gp.method === 'card' ? 'card_deposit' : gp.method === 'mobile_money' ? 'mobile_money_deposit' : 'bank_deposit', gp.amount, gp.currency);
        const tolerance = Math.max(1, Math.round(expectedFee * 0.02));
        if (Math.abs(l.fee_minor - expectedFee) > tolerance && Math.abs(l.fee_minor - gp.fee) > tolerance) {
          openCase({ connectionId, class: 'FEES_MISMATCH', paymentId: gp.id, lineId: l.id, runId, cycleRef, exposureMinor: Math.abs(l.fee_minor - gp.fee), currency: gp.currency, references: { reference: l.external_reference, expected: gp.fee, observed: l.fee_minor }, sources: ['BITRIPAY', imp.source] });
          cases += 1;
        }
      }
      if (clean) matched += 1;
    }
  }
  for (const [pid, n] of seen) {
    if (n > 1) {
      const gp = db.prepare('SELECT amount, currency FROM gateway_payments WHERE id = ?').get(pid) as any;
      openCase({ connectionId, class: 'DUPLICATE_EXTERNAL', paymentId: pid, runId, cycleRef, exposureMinor: gp.amount, currency: gp.currency, references: { occurrences: n }, sources: present });
      cases += 1;
    }
  }
  // settled gateway payments in the period that the statement does not mention
  if (present.length) {
    const locals = db.prepare("SELECT * FROM gateway_payments WHERE gateway = ? AND stage = 'SETTLED' AND updated_at >= ? AND updated_at <= ?").all(gatewayId, periodFrom, periodTo) as any[];
    for (const gp of locals) {
      bump(gp.currency, 'local', gp.amount);
      if (seen.has(gp.id)) continue;
      openCase({ connectionId, class: 'SETTLEMENT_NOT_OBSERVED', paymentId: gp.id, runId, cycleRef, exposureMinor: gp.amount, currency: gp.currency, references: { providerRef: gp.provider_ref }, sources: ['BITRIPAY'], merchantUserId: gp.user_id });
      cases += 1;
    }
  }
  const complete = missing.length === 0;
  db.prepare('INSERT INTO reconciliation_runs (id, connection_id, cycle_ref, coverage, totals, matched, cases_opened, complete, run_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(runId, connectionId, cycleRef, JSON.stringify({ expected, present, missing, complete }), JSON.stringify(totals), matched, cases, complete ? 1 : 0, runBy, now());
  recordEvent('reconciliation', runId, 'processor_run.completed', { type: runBy ? 'admin' : 'system', id: runBy }, { gatewayId, cycleRef, matched, cases, complete });
  return { id: runId, gatewayId, cycleRef, coverage: { expected, present, missing, complete }, totals, matched, casesOpened: cases, complete };
}

/** Operations workbench: every rail's open exceptions, exposure per currency and age, in one list. */
export function workbenchSummary() {
  const db = getDb();
  const byConn = db.prepare("SELECT connection_id, class, currency, COUNT(*) n, COALESCE(SUM(exposure_minor), 0) exposure, MIN(created_at) oldest FROM reconciliation_cases WHERE status != 'CLOSED' GROUP BY connection_id, class, currency ORDER BY exposure DESC").all() as any[];
  const runs = db.prepare('SELECT * FROM reconciliation_runs ORDER BY created_at DESC LIMIT 20').all() as any[];
  return {
    exceptions: byConn.map((r) => ({ connectionId: r.connection_id, class: r.class, currency: r.currency, count: r.n, exposureMinor: r.exposure, oldestAgeHours: Math.floor((Date.now() - Date.parse(r.oldest)) / 3600_000) })),
    recentRuns: runs.map((r) => ({ id: r.id, connectionId: r.connection_id, cycleRef: r.cycle_ref, matched: r.matched, casesOpened: r.cases_opened, complete: !!r.complete, createdAt: r.created_at })),
    openCases: listCases({ status: 'OPEN', limit: 100 }).data,
  };
}
