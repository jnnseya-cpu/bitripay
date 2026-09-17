import { Link } from 'react-router-dom';
import { tr } from '../lib/i18n';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { PageHeader, useAsync, Loading, Table, StatusBadge, fmtDate } from '../components/ui';
import { TRANSACTION_TYPE_LABELS } from '@bitripay/shared';
import { areaChart } from '@bitripay/charts';
import { Chart } from '@bitripay/charts/react';
import { tickMoney } from './Analytics';

export function Dashboard() {
  const { money, config } = useStore();
  const stats = useAsync(() => api.get<any>('/api/admin/stats'), []);
  const s = stats.data;
  if (!s) return <Loading />;
  const base = config?.baseCurrency ?? 'USD';
  const queues = [
    ['Withdrawals', s.pending.withdrawals, '/approvals?tab=withdrawals'],
    ['Bank deposits', s.pending.bankDeposits, '/approvals?tab=deposits'],
    ['Remittances', s.pending.remittances, '/approvals?tab=remittances'],
    ['KYC', s.pending.kyc, '/kyc'],
    ['Tickets', s.pending.tickets, '/support'],
    ['Live chats', s.pending.chats, '/chat'],
    ['P2P disputes', s.pending.disputes, '/p2p'],
  ];
  const daily = (s.daily as any[]).filter((d) => d.currency === base);
  return (
    <div>
      <PageHeader title={tr('Analytics dashboard')} subtitle={tr('Real-time overview of users, volume, revenue and pending work')} />
      <div className="grid cols-4">
        <div className="card">
          <div className="stat">
            <span className="label">{tr('Users')}</span>
            <span className="value">{s.users.user ?? 0}</span>
            <span className="small muted">{tr('+{0} accounts in 30 days', { 0: s.newUsers30d })}</span>
          </div>
        </div>
        <div className="card">
          <div className="stat">
            <span className="label">{tr('Merchants')}</span>
            <span className="value">{s.users.merchant ?? 0}</span>
          </div>
        </div>
        <div className="card">
          <div className="stat">
            <span className="label">{tr('Agents')}</span>
            <span className="value">{s.users.agent ?? 0}</span>
          </div>
        </div>
        <div className="card">
          <div className="stat">
            <span className="label">{tr('Admins')}</span>
            <span className="value">{s.users.admin ?? 0}</span>
          </div>
        </div>
      </div>
      <div className="grid cols-3 mt">
        <div className="card">
          <h4>{tr('Today')}</h4>
          {(s.today as any[]).length === 0 && <div className="muted small">{tr('No completed transactions today')}</div>}
          {(s.today as any[]).map((t) => (
            <div key={t.currency} className="kv">
              <span className="k">
                {t.currency} · {t.c} tx
              </span>
              <span className="v">
                {money(t.volume, t.currency)} <span className="muted small">fees {money(t.fees, t.currency)}</span>
              </span>
            </div>
          ))}
        </div>
        <div className="card">
          <h4>{tr('Customer balances (liabilities)')}</h4>
          {(s.balances as any[]).map((b) => (
            <div key={b.currency} className="kv">
              <span className="k">{b.currency}</span>
              <span className="v">{money(b.total, b.currency)}</span>
            </div>
          ))}
        </div>
        <div className="card">
          <h4>{tr('Platform revenue (fees)')}</h4>
          {(s.revenue as any[]).length === 0 && <div className="muted small">{tr('No fees collected yet')}</div>}
          {(s.revenue as any[]).map((b) => (
            <div key={b.currency} className="kv">
              <span className="k">{b.currency}</span>
              <span className="v" style={{ color: 'var(--success)' }}>
                {money(b.balance, b.currency)}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="grid cols-3 mt">
        <div className="card" style={{ gridColumn: 'span 2' }}>
          <div className="row between">
            <h4>{tr('Daily volume · {0} (30 days)', { 0: base })}</h4>
            <Link to="/analytics" className="small">
              {tr('All charts →')}
            </Link>
          </div>
          {daily.length === 0 ? (
            <div className="muted small">{tr('No data')}</div>
          ) : (
            <Chart
              scene={areaChart(
                daily.map((d) => String(d.day).slice(5)),
                [
                  { name: 'Volume', values: daily.map((d) => d.volume) },
                  { name: 'Fees', values: daily.map((d) => d.fees ?? 0) },
                ],
                { format: tickMoney(money, base), height: 200 },
              )}
            />
          )}
        </div>
        <div className="card">
          <h4>{tr('Pending work')}</h4>
          {queues.map(([label, n, to]) => (
            <Link key={label as string} to={to as string} className="kv" style={{ color: 'inherit', textDecoration: 'none' }}>
              <span className="k">{label}</span>
              <span className={`chip ${Number(n) > 0 ? 'warning' : ''}`}>{n}</span>
            </Link>
          ))}
        </div>
      </div>
      <div className="card mt">
        <h4>{tr('Volume by type (30 days)')}</h4>
        <Table
          head={[tr('Type'), tr('Currency'), tr('Count'), tr('Volume'), tr('Fees')]}
          rows={(s.txByType as any[]).map((t) => [
            tr(TRANSACTION_TYPE_LABELS[t.type as keyof typeof TRANSACTION_TYPE_LABELS] ?? t.type),
            t.currency,
            t.c,
            money(t.volume, t.currency),
            money(t.fees, t.currency),
          ])}
        />
      </div>
      <div className="card mt">
        <div className="card-title">
          <h4>{tr('Latest transactions')}</h4>
          <Link to="/transactions" className="small">
            {tr('All →')}
          </Link>
        </div>
        <Table
          head={[tr('Reference'), tr('Type'), tr('Amount'), tr('Status'), tr('When')]}
          rows={(s.recent as any[]).map((t) => [
            <Link to={`/transactions?search=${t.reference}`}>{t.reference}</Link>,
            tr(TRANSACTION_TYPE_LABELS[t.type as keyof typeof TRANSACTION_TYPE_LABELS]),
            money(t.amount, t.currency),
            <StatusBadge status={t.status} />,
            fmtDate(t.createdAt),
          ])}
        />
      </div>
    </div>
  );
}
