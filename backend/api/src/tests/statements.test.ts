/** Bank-grade statements: opening/closing balances, running balance per ledger entry, numbering, hash verification, CSV and PDF. */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, fund } from './helpers';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

describe('transaction statements', () => {
  it('produces a numbered, hashed statement with running balances in JSON, CSV and PDF for any account holder', async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await fund(app, a.user.id, '100.00', 'USD');
    const t = await request(app)
      .post('/api/transfers')
      .set(a.auth)
      .send({ pin: '1234', to: `@${b.user.tag}`, amount: '25.00', currency: 'USD', note: 'Rent share' });
    expect(t.status).toBe(201);
    const today = new Date().toISOString().slice(0, 10);
    const s = await request(app).get('/api/wallets/statement').set(a.auth).query({ currency: 'USD', from: '2020-01-01', to: today });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const st = s.body.statement;
    expect(st.number).toMatch(/^ST-\d{8}$/);
    expect(st.opening).toBe(0);
    expect(st.lines.length).toBe(2);
    expect(st.lines[0].credit).toBe(10_000);
    expect(st.lines[0].balance).toBe(10_000);
    expect(st.lines[1].debit).toBe(2_500 + t.body.transaction.fee);
    expect(st.lines[1].counterparty).toContain(`@${b.user.tag}`);
    expect(st.lines[1].description).toContain('Rent share');
    expect(st.closing).toBe(10_000 - 2_500 - t.body.transaction.fee);
    expect(st.opening + st.totalCredits - st.totalDebits).toBe(st.closing);
    expect(st.account.iban).toMatch(/^BP-USD-/);
    expect(st.hash).toHaveLength(64);
    expect(st.disclaimer).toContain('SANDBOX');
    // the recipient's statement shows the incoming credit with the sender as counterparty
    const sb = await request(app).get('/api/wallets/statement').set(b.auth).query({ currency: 'USD', from: today, to: today });
    expect(sb.body.statement.lines[0].credit).toBe(2_500);
    expect(sb.body.statement.lines[0].counterparty).toContain(`@${a.user.tag}`);
    // a later period opens with the previous closing balance
    const later = await request(app).get('/api/wallets/statement').set(a.auth).query({ currency: 'USD', from: '2099-01-01', to: '2099-01-31' });
    expect(later.body.statement.opening).toBe(st.closing);
    expect(later.body.statement.lines).toEqual([]);
    // public verification returns the registered hash and no personal data
    const v = await request(app).get(`/api/statements/verify/${st.id}`);
    expect(v.status).toBe(200);
    expect(v.body.statement.hash).toBe(st.hash);
    expect(v.body.statement.number).toBe(st.number);
    // a phone or desktop browser following the verify link gets a readable page, not raw JSON
    const page = await request(app).get(`/api/statements/verify/${st.number}`).set('Accept', 'text/html,application/xhtml+xml,*/*;q=0.8');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.text).toContain(`Statement ${st.number} is registered`);
    expect(page.text).toContain(st.hash);
    expect(page.text).not.toContain(a.user.fullName);
    const missing = await request(app).get('/api/statements/verify/ST-99999999').set('Accept', 'text/html');
    expect(missing.status).toBe(404);
    expect(missing.text).toContain('No statement found');
    expect((await request(app).get('/api/statements/verify/ST-99999999')).status).toBe(404);
    expect(JSON.stringify(v.body)).not.toContain(a.user.email);
    const list = await request(app).get('/api/wallets/statements').set(a.auth);
    expect(list.body.items.map((x: any) => x.number)).toContain(st.number);
    // CSV and PDF downloads
    const csv = await request(app).get('/api/wallets/statement').set(a.auth).query({ currency: 'USD', from: '2020-01-01', to: today, format: 'csv' });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Date,Reference,Type,Description');
    expect(csv.text).toContain('Rent share');
    const pdf = await request(app)
      .get('/api/wallets/statement')
      .set(a.auth)
      .query({ currency: 'USD', from: '2020-01-01', to: today, format: 'pdf' })
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    const body = pdf.body as Buffer;
    expect(body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(body.toString('latin1')).toContain('%%EOF');
    expect(body.toString('latin1')).toContain('Account statement');
    const bad = await request(app).get('/api/wallets/statement').set(a.auth).query({ currency: 'USD', from: today, to: '2020-01-01' });
    expect(bad.status).toBe(400);
  });
});
