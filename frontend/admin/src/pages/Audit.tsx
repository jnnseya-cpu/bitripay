import { useState } from 'react';
import { tr } from '../lib/i18n';
import { api, qs } from '../lib/api';
import { Input, PageHeader, Pager, Table, UserCell, fmtDate, useAsync, useDebounce } from '../components/ui';

export function Audit() {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebounce(search, 300);
  const data = useAsync(() => api.get<any>(`/api/admin/audit-logs${qs({ search: q, page, pageSize: 50 })}`), [q, page]);
  return (
    <div>
      <PageHeader title={tr('Audit logs')} subtitle={tr('Every administrative action, with who did it and the details')} />
      <div className="card">
        <Input
          placeholder={tr('Filter by action or target')}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          style={{ maxWidth: 300 }}
          className="mb"
        />
        <Table
          head={[tr('When'), tr('Admin'), tr('Action'), tr('Target'), tr('Details')]}
          rows={(data.data?.items ?? []).map((l: any) => [
            fmtDate(l.createdAt),
            <UserCell user={l.admin} />,
            <span className="mono small">{l.action}</span>,
            <span className="small">
              {l.targetType} {l.targetId ? <span className="mono tiny">{String(l.targetId).slice(0, 12)}…</span> : ''}
            </span>,
            <span className="tiny mono">{JSON.stringify(l.details).slice(0, 160)}</span>,
          ])}
        />
        <Pager page={page} total={data.data?.total ?? 0} pageSize={50} onPage={setPage} />
      </div>
    </div>
  );
}
