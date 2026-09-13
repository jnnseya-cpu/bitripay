import { useState } from 'react';
import { API_BASE, api, getToken } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Field, Input, KV, PageHeader, Select, useAsync } from '../components/ui';

/**
 * Bank-grade account statements: opening / closing balance, every ledger posting with running balance, holds,
 * promotional credit, statement number and integrity hash. Available to every account holder (users, merchants, agents).
 */
export function Statements() {
  const { wallets, money, toast } = useStore();
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 8)}01`;
  const [currency, setCurrency] = useState(wallets[0]?.currency ?? 'USD');
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [statement, setStatement] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const history = useAsync(() => api.get<{ items: any[] }>('/api/wallets/statements'), [statement?.id]);

  const generate = async () => {
    setLoading(true);
    try {
      const r = await api.get<{ statement: any }>(`/api/wallets/statement?currency=${currency}&from=${from}&to=${to}`);
      setStatement(r.statement);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };
  const download = async (format: 'csv' | 'pdf') => {
    try {
      const res = await fetch(`${API_BASE}/api/wallets/statement?currency=${currency}&from=${from}&to=${to}&format=${format}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bitripay-statement-${currency}-${from}-${to}.${format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      history.reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const quick = (months: number) => {
    const d = new Date();
    d.setMonth(d.getMonth() - months);
    setFrom(d.toISOString().slice(0, 10));
    setTo(today);
  };

  return (
    <div>
      <PageHeader title="Account statements" subtitle="Numbered, hashed statements generated from the immutable ledger. Download as PDF or CSV for your bank, accountant or regulator." />
      <div className="grid cols-3">
        <div className="card" style={{ gridColumn: 'span 2' }}>
          <div className="grid cols-3">
            <Field label="Account">
              <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {wallets.map((w) => (
                  <option key={w.id} value={w.currency}>
                    {w.currency} · {money(w.balance, w.currency)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="From">
              <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To">
              <Input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>
          <div className="row wrap mb">
            <Button variant="ghost" size="sm" onClick={() => quick(1)}>
              Last month
            </Button>
            <Button variant="ghost" size="sm" onClick={() => quick(3)}>
              Last 3 months
            </Button>
            <Button variant="ghost" size="sm" onClick={() => quick(12)}>
              Last 12 months
            </Button>
            <span style={{ flex: 1 }} />
            <Button loading={loading} onClick={generate}>
              Generate statement
            </Button>
            <Button variant="secondary" onClick={() => download('pdf')}>
              ⬇ PDF
            </Button>
            <Button variant="secondary" onClick={() => download('csv')}>
              ⬇ CSV
            </Button>
          </div>
          {statement && (
            <div>
              <div className="card soft compact mb">
                <div className="grid cols-2">
                  <div>
                    <KV k="Statement" v={<b>{statement.number}</b>} />
                    <KV k="Account" v={<span className="mono">{statement.account.iban}</span>} />
                    <KV k="Holder" v={`${statement.holder.businessName ? `${statement.holder.businessName} · ` : ''}${statement.holder.name} (@${statement.holder.tag})`} />
                    <KV k="Period" v={`${statement.period.from} → ${statement.period.to}`} />
                  </div>
                  <div>
                    <KV k="Opening balance" v={money(statement.opening, currency)} />
                    <KV k="Total credits" v={<span style={{ color: 'var(--success)' }}>{money(statement.totalCredits, currency)}</span>} />
                    <KV k="Total debits" v={<span style={{ color: 'var(--danger)' }}>{money(statement.totalDebits, currency)}</span>} />
                    <KV k="Closing balance" v={<b>{money(statement.closing, currency)}</b>} />
                  </div>
                </div>
                <div className="tiny muted mt-sm">
                  Balance type: {statement.account.classification}. Integrity hash <span className="mono">{statement.hash.slice(0, 24)}…</span> ·{' '}
                  <a href={statement.verifyUrl} target="_blank" rel="noreferrer">
                    verify
                  </a>
                </div>
              </div>
              {statement.disclaimer?.includes('SANDBOX') && <Alert kind="warning">{statement.disclaimer}</Alert>}
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Reference</th>
                      <th>Description</th>
                      <th className="right">Debit</th>
                      <th className="right">Credit</th>
                      <th className="right">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statement.lines.length === 0 && (
                      <tr>
                        <td colSpan={6} className="muted center">
                          No transactions in this period.
                        </td>
                      </tr>
                    )}
                    {statement.lines.map((l: any, i: number) => (
                      <tr key={i}>
                        <td className="tiny">{new Date(l.date).toLocaleString()}</td>
                        <td className="mono tiny">{l.reference}</td>
                        <td>
                          <div>{l.description}</div>
                          {l.counterparty && <div className="tiny muted">{l.counterparty}</div>}
                        </td>
                        <td className="right">{l.debit ? money(l.debit, currency) : ''}</td>
                        <td className="right" style={{ color: 'var(--success)' }}>
                          {l.credit ? money(l.credit, currency) : ''}
                        </td>
                        <td className="right bold">{money(l.balance, currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(statement.promo.movements.length > 0 || statement.promo.closing > 0) && (
                <div className="card soft compact mt">
                  <div className="small bold">Promotional credit (not money – covers BitriPay fees only)</div>
                  {statement.promo.movements.map((m: any, i: number) => (
                    <KV key={i} k={`${m.date.slice(0, 10)} · ${m.description}`} v={money(m.amount, currency)} />
                  ))}
                  <KV k="Promotional credit balance" v={money(statement.promo.closing, currency)} />
                </div>
              )}
            </div>
          )}
        </div>
        <div className="card">
          <h3>Generated statements</h3>
          <p className="tiny muted">Every statement is numbered and its hash is registered; anyone holding a copy can verify it without seeing your data.</p>
          {(history.data?.items ?? []).slice(0, 15).map((s: any) => (
            <div key={s.id} className="list-item">
              <div>
                <b>{s.number}</b> · {s.currency}
                <div className="tiny muted">
                  {s.period.from} → {s.period.to} · {s.entryCount} entries
                </div>
              </div>
              <a className="tiny" href={`${API_BASE}/api/statements/verify/${s.id}`} target="_blank" rel="noreferrer">
                verify
              </a>
            </div>
          ))}
          {history.data && history.data.items.length === 0 && <div className="muted tiny">None yet.</div>}
        </div>
      </div>
    </div>
  );
}
