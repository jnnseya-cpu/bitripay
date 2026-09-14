/**
 * Regulatory supervision: every ledger transaction appears in the normalised journal with pseudonymous parties,
 * exports carry an integrity manifest whose hash matches the file, the supervisory report reflects live activity,
 * and the console endpoints need the reports permission.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { setupApp, adminToken, registerUser, fund } from './helpers';
import { supervisoryJournal, journalCsv, journalExport, supervisoryReport, pseudonym, JOURNAL_COLUMNS } from '../services/supervision';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

describe('regulatory supervision', () => {
  it('normalises transactions into one journal record shape with pseudonymous, KYC-tagged parties', async () => {
    const a = await registerUser(app, { country: 'CD' });
    const b = await registerUser(app, { tag: 'supervised1' });
    await fund(app, a.user.id, '50.00');
    const tx = await request(app).post('/api/transfers').set(a.auth).send({ to: '@supervised1', amount: '12.50', currency: 'USD', pin: '1234' });
    expect(tx.status).toBe(201);
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const journal = supervisoryJournal({ from, to });
    const rec = journal.find((r) => r.reference === tx.body.transaction.reference)!;
    expect(rec).toBeTruthy();
    expect(rec.type).toBe('transfer');
    expect(rec.channel).toBe('wallet');
    expect(rec.amount).toBe(1250);
    expect(rec.payer).toBe(pseudonym(a.user.id));
    expect(rec.payer).toMatch(/^P-[0-9A-F]{16}$/);
    expect(rec.payer).not.toContain(a.user.id);
    expect(rec.payee).toBe(pseudonym(b.user.id));
    expect(rec.payerCountry).toBe('CD');
    expect(typeof rec.payerKycTier).toBe('number');
    // the administrator credit that funded the sender is in the journal too
    expect(journal.some((r) => r.payee === pseudonym(a.user.id) && r.amount === 5000)).toBe(true);
    const csv = journalCsv(journal);
    expect(csv.split('\n')[0]).toBe(JOURNAL_COLUMNS.join(','));
    expect(csv.split('\n')).toHaveLength(journal.length + 1);
  });

  it('exports with a manifest whose SHA-256 matches the body and reports the event-chain state', () => {
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    for (const format of ['csv', 'json'] as const) {
      const { body, manifest } = journalExport({ from, to }, format);
      expect(manifest.sha256).toBe(createHash('sha256').update(body).digest('hex'));
      expect(manifest.records).toBeGreaterThan(0);
      expect(manifest.eventChain.ok).toBe(true);
      expect(manifest.complianceMode).toBe('sandbox');
      expect(manifest.columns).toEqual(JOURNAL_COLUMNS);
      if (format === 'json') expect(JSON.parse(body)).toHaveLength(manifest.records);
    }
  });

  it('produces the real-time supervisory report', () => {
    const r = supervisoryReport(new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() + 60_000).toISOString());
    expect(r.transactions.total).toBeGreaterThan(0);
    expect(r.transactions.channels.wallet.count).toBeGreaterThan(0);
    expect(r.transactions.byTypeStatus.some((x) => x.type === 'transfer' && x.status === 'completed')).toBe(true);
    expect(r.accounts.kyc.length).toBeGreaterThan(0);
    expect(r.accounts.kyc[0].tierLabel).toBeTruthy();
    expect(r.integrity.eventChain.ok).toBe(true);
    expect(r.integrity.guardian.mode).toBe('normal');
    expect(Array.isArray(r.emoney)).toBe(true);
    expect(Array.isArray(r.corridors)).toBe(true);
  });

  it('serves the console: report, CSV journal with integrity headers, manifest-only, integrity; and refuses non-administrators', async () => {
    const admin = await adminToken(app);
    const report = await request(app).get('/api/admin/supervision/report').set(admin.auth);
    expect(report.status).toBe(200);
    expect(report.body.transactions.total).toBeGreaterThan(0);
    const csv = await request(app).get('/api/admin/supervision/journal?format=csv').set(admin.auth);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('bitripay-journal-');
    expect(csv.headers['x-bitripay-journal-sha256']).toBe(createHash('sha256').update(csv.text).digest('hex'));
    expect(csv.headers['x-bitripay-event-chain']).toBe('ok');
    const manifest = await request(app).get('/api/admin/supervision/journal?format=json&manifest=only').set(admin.auth);
    expect(manifest.status).toBe(200);
    expect(manifest.body.manifest.sha256).toHaveLength(64);
    const withBody = await request(app).get('/api/admin/supervision/journal?format=json&manifest=with').set(admin.auth);
    expect(withBody.body.records).toHaveLength(withBody.body.manifest.records);
    const integrity = await request(app).get('/api/admin/supervision/integrity').set(admin.auth);
    expect(integrity.body.eventChain.ok).toBe(true);
    expect(integrity.body.ledger.ok).toBe(true);
    const audit = await request(app).get('/api/admin/audit-logs?action=supervision.journal_export').set(admin.auth);
    expect(audit.status).toBe(200);
    const user = await registerUser(app);
    const denied = await request(app).get('/api/admin/supervision/report').set(user.auth);
    expect(denied.status).toBe(403);
  });
});
