/**
 * Regulatory supervision console (administrators with the reports permission): the real-time supervisory report,
 * the normalised operations journal as CSV or JSON with its integrity manifest, and the integrity check on its own.
 * Read-only. Every export is written to the audit log with the manifest hash so a file handed to the supervisor can
 * be tied back to the moment it was produced.
 */
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../lib/http';
import { requirePermission } from '../../middleware/permissions';
import { audit } from '../../services/audit';
import { verifyEventChain } from '../../services/events';
import { reconcileLedger } from '../../services/ledger';
import { getOperatingState } from '../../services/guardian';
import { journalExport, supervisoryReport, JOURNAL_COLUMNS } from '../../services/supervision';

export const adminSupervisionRouter = Router();
adminSupervisionRouter.use(requirePermission('reports'));

const period = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

adminSupervisionRouter.get('/report', (req, res) => {
  const q = validate(period, req.query);
  res.json(supervisoryReport(q.from ?? null, q.to ?? null));
});

const journalQuery = period.extend({
  currency: z.string().length(3).optional(),
  type: z.string().max(40).optional(),
  format: z.enum(['csv', 'json']).default('csv'),
  /** `manifest=only` returns the manifest alone (JSON) without the export body. */
  manifest: z.enum(['only', 'with']).optional(),
  limit: z.coerce.number().int().min(1).max(200_000).optional(),
});

adminSupervisionRouter.get('/journal', (req, res) => {
  const q = validate(journalQuery, req.query);
  const from = q.from ?? new Date(Date.now() - 30 * 86400_000).toISOString();
  const to = q.to ?? new Date().toISOString();
  const { body, manifest } = journalExport({ from, to, currency: q.currency ?? null, type: q.type ?? null, limit: q.limit }, q.format);
  audit(req.user!.id, 'supervision.journal_export', 'journal', undefined, { from, to, format: q.format, records: manifest.records, sha256: manifest.sha256 });
  if (q.manifest === 'only') return res.json({ manifest });
  if (q.manifest === 'with') return res.json({ manifest, records: q.format === 'json' ? JSON.parse(body) : undefined, body: q.format === 'csv' ? body : undefined });
  const stamp = `${from.slice(0, 10)}_${to.slice(0, 10)}`;
  res.setHeader('X-BitriPay-Journal-SHA256', manifest.sha256);
  res.setHeader('X-BitriPay-Journal-Records', String(manifest.records));
  res.setHeader('X-BitriPay-Event-Chain', manifest.eventChain.ok ? 'ok' : `broken_at_${manifest.eventChain.brokenAt}`);
  res.setHeader('Content-Disposition', `attachment; filename="bitripay-journal-${stamp}.${q.format}"`);
  res.type(q.format === 'csv' ? 'text/csv' : 'application/json').send(body);
});

adminSupervisionRouter.get('/journal/columns', (_req, res) => res.json({ columns: JOURNAL_COLUMNS }));

/** Integrity on its own: hash chain of the event log, ledger reconciliation and the Guardian operating state. */
adminSupervisionRouter.get('/integrity', (_req, res) => res.json({ eventChain: verifyEventChain(), ledger: reconcileLedger(), guardian: getOperatingState(), checkedAt: new Date().toISOString() }));
