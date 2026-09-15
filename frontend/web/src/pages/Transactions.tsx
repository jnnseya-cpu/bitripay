import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useStore } from '../lib/store';
import { useT, tr } from '../lib/i18n';
import { Avatar, Button, Empty, Input, KV, Loading, PageHeader, Select, StatusBadge, TxRow, useAsync, useDebounce } from '../components/ui';
import { TRANSACTION_TYPES, TRANSACTION_TYPE_LABELS, type Transaction, type PublicUser, type Sale, currencyFlag } from '@bitripay/shared';
import { SaleReceipt } from './Merchant';

export function Transactions() {
  const t = useT();
  const nav = useNavigate();
  const { config } = useStore();
  const [filter, setFilter] = useState({ type: '', status: '', currency: '', search: '', direction: '', page: 1 });
  const search = useDebounce(filter.search, 300);
  const data = useAsync(
    () => api.get<{ items: Transaction[]; total: number; pageSize: number }>(`/api/wallets/transactions${qs({ ...filter, search, pageSize: 25 })}`),
    [filter.type, filter.status, filter.currency, filter.direction, filter.page, search],
  );
  const pages = data.data ? Math.max(1, Math.ceil(data.data.total / data.data.pageSize)) : 1;
  return (
    <div>
      <PageHeader title={t('nav.transactions')} subtitle={tr('Detailed log of every movement on your wallets')} />
      <div className="card">
        <div className="row wrap mb">
          <Input placeholder={t('common.search')} value={filter.search} onChange={(e) => setFilter({ ...filter, search: e.target.value, page: 1 })} style={{ maxWidth: 220 }} />
          <Select value={filter.direction} onChange={(e) => setFilter({ ...filter, direction: e.target.value, page: 1 })} style={{ width: 130 }}>
            <option value="">{tr('In & out')}</option>
            <option value="in">{t('tx.in')}</option>
            <option value="out">{t('tx.out')}</option>
          </Select>
          <Select value={filter.type} onChange={(e) => setFilter({ ...filter, type: e.target.value, page: 1 })} style={{ width: 200 }}>
            <option value="">{t('common.all')} types</option>
            {TRANSACTION_TYPES.map((ty) => (
              <option key={ty} value={ty}>
                {TRANSACTION_TYPE_LABELS[ty]}
              </option>
            ))}
          </Select>
          <Select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value, page: 1 })} style={{ width: 140 }}>
            <option value="">{t('common.all')} statuses</option>
            {['pending', 'completed', 'failed', 'rejected', 'cancelled', 'reversed'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <Select value={filter.currency} onChange={(e) => setFilter({ ...filter, currency: e.target.value, page: 1 })} style={{ width: 110 }}>
            <option value="">{t('common.all')}</option>
            {(config?.currencies ?? []).map((c) => (
              <option key={c.code} value={c.code}>
                {currencyFlag(c.code)} {c.code}
              </option>
            ))}
          </Select>
        </div>
        {data.loading && !data.data && <Loading />}
        {data.data?.items.length === 0 && <Empty icon="📜" />}
        <div className="list">
          {data.data?.items.map((tx) => (
            <TxRow key={tx.id} tx={tx} onClick={() => nav(`/app/transactions/${tx.id}`)} />
          ))}
        </div>
        <div className="row between mt">
          <span className="small muted">{data.data?.total ?? 0} transactions</span>
          <div className="row">
            <Button size="sm" variant="secondary" disabled={filter.page <= 1} onClick={() => setFilter({ ...filter, page: filter.page - 1 })}>
              ←
            </Button>
            <span className="small">
              {filter.page} / {pages}
            </span>
            <Button size="sm" variant="secondary" disabled={filter.page >= pages} onClick={() => setFilter({ ...filter, page: filter.page + 1 })}>
              →
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function TransactionDetail() {
  const { id } = useParams();
  const t = useT();
  const { money, user } = useStore();
  const data = useAsync(() => api.get<{ transaction: Transaction; sender: PublicUser | null; receiver: PublicUser | null; entries: any[] }>(`/api/wallets/transactions/${id}`), [id]);
  if (data.error)
    return (
      <div className="card">
        <Empty icon="❓" text={data.error} />
        <Link to="/app/transactions">{tr('Back')}</Link>
      </div>
    );
  if (!data.data) return <Loading />;
  const { transaction: tx, sender, receiver } = data.data;
  const meta = tx.metadata as any;
  const isIn = tx.direction === 'in';
  return (
    <div style={{ maxWidth: 640 }}>
      <PageHeader
        title={TRANSACTION_TYPE_LABELS[tx.type]}
        subtitle={tx.reference}
        actions={
          <Link to="/app/transactions" className="btn secondary">
            {tr('← All transactions')}
          </Link>
        }
      />
      <div className="card center">
        <div style={{ fontSize: '2.2rem', fontWeight: 800 }} className={`amount ${isIn ? 'in' : 'out'}`}>
          {isIn ? '+' : tx.direction === 'out' ? '-' : ''}
          {money(isIn ? (tx.receiveAmount ?? tx.amount) : tx.amount, isIn ? (tx.receiveCurrency ?? tx.currency) : tx.currency)}
        </div>
        <StatusBadge status={tx.status} />
        <p className="muted small mt-sm">{new Date(tx.createdAt).toLocaleString()}</p>
      </div>
      <div className="card mt">
        {sender && (
          <KV
            k="From"
            v={
              <span className="row" style={{ justifyContent: 'flex-end' }}>
                <Avatar user={sender} size="sm" /> {sender.businessName || sender.fullName} (@{sender.tag})
              </span>
            }
          />
        )}
        {receiver && (
          <KV
            k="To"
            v={
              <span className="row" style={{ justifyContent: 'flex-end' }}>
                <Avatar user={receiver} size="sm" /> {receiver.businessName || receiver.fullName} (@{receiver.tag})
              </span>
            }
          />
        )}
        <KV k="Amount" v={money(tx.amount, tx.currency)} />
        {tx.receiveCurrency && tx.receiveCurrency !== tx.currency && <KV k="Received" v={money(tx.receiveAmount ?? 0, tx.receiveCurrency)} />}
        <KV k="Fee" v={`${money(tx.fee, tx.currency)}${meta?.feeFrom === 'receiver' ? ' (paid by receiver)' : ''}`} />
        {tx.note && <KV k="Note" v={tx.note} />}
        {meta?.method && <KV k="Method" v={String(meta.method).replace('_', ' ')} />}
        {meta?.gateway && <KV k="Gateway" v={String(meta.gateway)} />}
        {meta?.providerRef && <KV k="Provider ref" v={<span className="mono small">{String(meta.providerRef)}</span>} />}
        {meta?.receiptNo && <KV k="Receipt" v={String(meta.receiptNo)} />}
        {meta?.sale?.items && <SaleReceipt sale={meta.sale as Sale} currency={tx.currency} money={money} reference={String(meta.paymentRequestCode ?? '')} />}
        {meta?.rate && <KV k="Rate" v={String(meta.rate)} />}
        {meta?.reason && <KV k="Reason" v={String(meta.reason)} />}
        {meta?.bankAccount && <KV k="Bank" v={`${meta.bankAccount.bankName} •••• ${String(meta.bankAccount.accountNumber).slice(-4)}`} />}
        <KV k="Reference" v={<span className="mono">{tx.reference}</span>} />
        <KV k="Completed" v={tx.completedAt ? new Date(tx.completedAt).toLocaleString() : '—'} />
      </div>
      {user && data.data.entries.length > 0 && (
        <div className="card mt">
          <h4>{tr('Ledger entries')}</h4>
          {data.data.entries.map((e, i) => (
            <KV key={i} k={`${e.direction} · balance after ${money(e.balanceAfter, tx.currency)}`} v={money(e.amount, tx.currency)} />
          ))}
        </div>
      )}
      <p className="tiny muted mt" data-testid="receipt-trust">
        {t('trust.notProof')}
      </p>
      <div className="row mt">
        <Button variant="secondary" onClick={() => window.print()}>
          {tr('Print receipt')}
        </Button>
        {receiver && tx.direction === 'out' && (
          <Link className="btn ghost" to={`/app/send?to=${receiver.tag}`}>
            {tr('Send again')}
          </Link>
        )}
      </div>
    </div>
  );
}
