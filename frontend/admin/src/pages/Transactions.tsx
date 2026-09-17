import { useState } from 'react';
import { tr } from '../lib/i18n';
import { useSearchParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, ConfirmButton, Input, KV, Modal, PageHeader, Pager, Select, StatusBadge, Table, UserCell, fmtDate, useAsync, useDebounce } from '../components/ui';
import { TRANSACTION_TYPES, TRANSACTION_TYPE_LABELS } from '@bitripay/shared';

export function Transactions() {
  const [params] = useSearchParams();
  const { money, config, toast } = useStore();
  const [f, setF] = useState({ search: params.get('search') || '', type: '', status: '', currency: '', from: '', to: '', page: 1 });
  const search = useDebounce(f.search, 300);
  const data = useAsync(() => api.get<any>(`/api/admin/transactions${qs({ ...f, search, pageSize: 25 })}`), [search, f.type, f.status, f.currency, f.from, f.to, f.page]);
  const [sel, setSel] = useState<any>(null);
  const open = async (id: string) => setSel(await api.get<any>(`/api/admin/transactions/${id}`));
  return (
    <div>
      <PageHeader
        title={tr('All transactions')}
        subtitle={tr('Complete ledger of every transaction for auditing and troubleshooting')}
        actions={
          <a
            className="btn secondary"
            href={`/api/admin/reports/transactions?format=csv${f.currency ? `&currency=${f.currency}` : ''}`}
            onClick={(e) => {
              e.preventDefault();
              downloadCsv(f.currency);
            }}
          >
            {tr('Export CSV')}
          </a>
        }
      />
      <div className="card">
        <div className="row wrap mb">
          <Input placeholder={tr('Reference or note')} value={f.search} onChange={(e) => setF({ ...f, search: e.target.value, page: 1 })} style={{ maxWidth: 220 }} />
          <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, page: 1 })} style={{ width: 200 }}>
            <option value="">{tr('All types')}</option>
            {TRANSACTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {tr(TRANSACTION_TYPE_LABELS[t])}
              </option>
            ))}
          </Select>
          <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })} style={{ width: 140 }}>
            <option value="">{tr('All statuses')}</option>
            {['pending', 'completed', 'failed', 'rejected', 'cancelled', 'reversed'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
          <Select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value, page: 1 })} style={{ width: 110 }}>
            <option value="">{tr('All')}</option>
            {(config?.currencies ?? []).map((c: any) => (
              <option key={c.code} value={c.code}>
                {c.code}
              </option>
            ))}
          </Select>
          <Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value ? new Date(e.target.value).toISOString() : '', page: 1 })} style={{ width: 160 }} />
          <Input type="date" onChange={(e) => setF({ ...f, to: e.target.value ? new Date(e.target.value + 'T23:59:59').toISOString() : '', page: 1 })} style={{ width: 160 }} />
        </div>
        <Table
          head={[tr('Reference'), tr('Type'), 'From', 'To', tr('Amount'), tr('Fee'), tr('Status'), tr('When'), '']}
          rows={(data.data?.items ?? []).map((t: any) => [
            <span className="mono small">{t.reference}</span>,
            tr(TRANSACTION_TYPE_LABELS[t.type as keyof typeof TRANSACTION_TYPE_LABELS]),
            <UserCell user={t.sender} />,
            <UserCell user={t.receiver} />,
            <b>
              {money(t.amount, t.currency)}
              {t.receiveCurrency && t.receiveCurrency !== t.currency ? <span className="muted small"> → {money(t.receiveAmount, t.receiveCurrency)}</span> : null}
            </b>,
            money(t.fee, t.currency),
            <StatusBadge status={t.status} />,
            <span className="small">{fmtDate(t.createdAt)}</span>,
            <Button size="sm" variant="secondary" onClick={() => open(t.id)}>
              {tr('View')}
            </Button>,
          ])}
        />
        <Pager page={f.page} total={data.data?.total ?? 0} pageSize={25} onPage={(p) => setF({ ...f, page: p })} />
      </div>
      <Modal open={!!sel} onClose={() => setSel(null)} title={sel?.transaction.reference} wide>
        {sel && (
          <div className="grid cols-2">
            <div>
              <KV k={tr('Type')} v={tr(TRANSACTION_TYPE_LABELS[sel.transaction.type as keyof typeof TRANSACTION_TYPE_LABELS])} />
              <KV k={tr('Status')} v={<StatusBadge status={sel.transaction.status} />} />
              <KV k={tr('Amount')} v={money(sel.transaction.amount, sel.transaction.currency)} />
              <KV k={tr('Fee')} v={money(sel.transaction.fee, sel.transaction.currency)} />
              {sel.transaction.receiveCurrency && <KV k={tr('Received')} v={money(sel.transaction.receiveAmount, sel.transaction.receiveCurrency)} />}
              <KV k="From" v={<UserCell user={sel.sender} />} />
              <KV k="To" v={<UserCell user={sel.receiver} />} />
              <KV k={tr('Note')} v={sel.transaction.note ?? '—'} />
              <KV k={tr('Created')} v={fmtDate(sel.transaction.createdAt)} />
              <KV k={tr('Completed')} v={fmtDate(sel.transaction.completedAt)} />
              {sel.transaction.status === 'completed' && (
                <div className="mt">
                  <ConfirmButton
                    variant="danger"
                    size="sm"
                    onConfirm={() =>
                      api
                        .post(`/api/admin/transactions/${sel.transaction.id}/refund`, { refundFee: true })
                        .then(() => {
                          toast(tr('Refunded'), 'success');
                          setSel(null);
                          data.reload();
                        })
                        .catch((e) => toast(e.message, 'error'))
                    }
                  >
                    {tr('Refund (incl. fee)')}
                  </ConfirmButton>
                </div>
              )}
            </div>
            <div>
              <h4>{tr('Metadata')}</h4>
              <pre className="card soft compact tiny" style={{ overflowX: 'auto' }}>
                {JSON.stringify(sel.transaction.metadata, null, 2)}
              </pre>
              <h4>{tr('Ledger entries')}</h4>
              {sel.entries.map((e: any, i: number) => (
                <KV
                  key={i}
                  k={`${e.direction} · ${e.currency} wallet of ${e.user_id.slice(0, 8)}…`}
                  v={`${e.direction === 'debit' ? '-' : '+'}${money(e.amount, e.currency)} → ${money(e.balance_after, e.currency)}`}
                />
              ))}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

async function downloadCsv(currency: string) {
  const res = await fetch(`/api/admin/reports/transactions?format=csv${currency ? `&currency=${currency}` : ''}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('bitripay.admin.token')}` },
  });
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = 'transactions.csv';
  a.click();
  URL.revokeObjectURL(url);
}
