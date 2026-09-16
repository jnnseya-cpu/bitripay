import { useState } from 'react';
import { tr } from '../lib/i18n';
import { api, qs } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, Field, Input, PageHeader, Select, StatusBadge, Table, UserCell, useAsync } from '../components/ui';
import { TRANSACTION_TYPE_LABELS } from '@bitripay/shared';

export function Reports() {
  const { money, config } = useStore();
  const [f, setF] = useState({ from: new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10), currency: '' });
  const data = useAsync(
    () => api.get<any>(`/api/admin/reports/transactions${qs({ from: new Date(f.from).toISOString(), to: new Date(f.to + 'T23:59:59').toISOString(), currency: f.currency })}`),
    [f],
  );
  const d = data.data;
  const csv = async () => {
    const res = await fetch(`/api/admin/reports/transactions${qs({ from: new Date(f.from).toISOString(), to: new Date(f.to + 'T23:59:59').toISOString(), currency: f.currency, format: 'csv' })}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('bitripay.admin.token')}` },
    });
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `transactions-${f.from}-${f.to}.csv`;
    a.click();
  };
  return (
    <div>
      <PageHeader
        title={tr('Detailed reporting')}
        subtitle={tr('Multi-currency transaction reports with CSV export')}
        actions={
          <Button variant="secondary" onClick={csv}>
            {tr('Export CSV')}
          </Button>
        }
      />
      <div className="card mb">
        <div className="row wrap">
          <Field label="From">
            <Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
          </Field>
          <Field label="To">
            <Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
          </Field>
          <Field label={tr('Currency')}>
            <Select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>
              <option value="">{tr('All')}</option>
              {(config?.currencies ?? []).map((c: any) => (
                <option key={c.code} value={c.code}>
                  {c.code}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
      {d && (
        <>
          <div className="grid cols-3">
            {d.byCurrency.map((c: any) => (
              <div key={c.currency} className="card">
                <div className="stat">
                  <span className="label">
                    {c.currency} · {c.c} completed
                  </span>
                  <span className="value">{money(c.volume, c.currency)}</span>
                  <span className="small muted">{tr('Fees {0}', { 0: money(c.fees, c.currency) })}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="card mt">
            <h4>{tr('By type & status')}</h4>
            <Table
              head={[tr('Type'), tr('Status'), tr('Currency'), tr('Count'), tr('Volume'), tr('Fees')]}
              rows={d.byType.map((t: any) => [
                TRANSACTION_TYPE_LABELS[t.type as keyof typeof TRANSACTION_TYPE_LABELS] ?? t.type,
                <StatusBadge status={t.status} />,
                t.currency,
                t.c,
                money(t.volume, t.currency),
                money(t.fees, t.currency),
              ])}
            />
          </div>
          <div className="grid cols-2 mt">
            <div className="card">
              <h4>{tr('Top merchants')}</h4>
              <Table head={[tr('Merchant'), tr('Payments'), tr('Volume')]} rows={d.topMerchants.map((m: any) => [<UserCell user={m.user} />, m.c, money(m.volume, m.currency)])} />
            </div>
            <div className="card">
              <h4>{tr('Top agents (cash-in)')}</h4>
              <Table head={[tr('Agent'), tr('Cash-ins'), tr('Volume')]} rows={d.topAgents.map((m: any) => [<UserCell user={m.user} />, m.c, money(m.volume, m.currency)])} />
            </div>
          </div>
          <div className="card mt">
            <h4>{tr('Daily')}</h4>
            <Table
              head={[tr('Day'), tr('Currency'), tr('Count'), tr('Volume'), tr('Fees')]}
              rows={d.byDay.map((x: any) => [x.day, x.currency, x.c, money(x.volume, x.currency), money(x.fees, x.currency)])}
            />
          </div>
        </>
      )}
    </div>
  );
}
