import { useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, Field, Input, Modal, PageHeader, Select, Switch, Table, useAsync, Alert, Chip } from '../components/ui';

export function Currencies() {
  const { toast, refresh } = useStore();
  const list = useAsync(() => api.get<{ items: any[] }>('/api/admin/currencies'), []);
  const settings = useAsync(() => api.get<any>('/api/admin/settings'), []);
  const [filter, setFilter] = useState<'enabled' | 'all'>('enabled');
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<any>(null);
  const [refreshing, setRefreshing] = useState(false);
  const save = async (c: any) => {
    try {
      await api.put(`/api/admin/currencies/${c.code}`, { name: c.name, symbol: c.symbol, decimals: Number(c.decimals), rateToBase: Number(c.rateToBase), enabled: !!c.enabled, sortOrder: Number(c.sortOrder ?? 0) });
      toast(`${c.code} saved`, 'success');
      setEdit(null);
      list.reload();
      refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const refreshRates = async () => {
    setRefreshing(true);
    try {
      const r = await api.post<any>('/api/admin/currencies/refresh', { provider: settings.data?.app?.rateProvider === 'manual' ? 'open_er_api' : undefined });
      toast(`Updated ${r.updated.length} rates from ${r.provider}${r.skipped.length ? ` (${r.skipped.length} not available)` : ''}`, 'success');
      list.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setRefreshing(false);
    }
  };
  const saveApp = async (patch: any) => {
    await api.put('/api/admin/settings/app', { value: { ...settings.data.app, ...patch } });
    settings.reload();
    toast('Saved', 'success');
  };
  const items = (list.data?.items ?? []).filter((c) => (filter === 'all' || c.enabled) && (!q || c.code.includes(q.toUpperCase()) || c.name.toLowerCase().includes(q.toLowerCase())));
  const base = list.data?.items.find((c) => c.isBase);
  return (
    <div>
      <PageHeader title="Currencies & exchange rates" subtitle={`All ${list.data?.items.length ?? 0} ISO currencies are available. Base currency: ${base?.code ?? ''}. Rates are units per 1 ${base?.code ?? 'base'}.`} actions={<Button loading={refreshing} onClick={refreshRates}>↻ Refresh live rates</Button>} />
      {settings.data && (
        <div className="card mb">
          <h4>Exchange rate management</h4>
          <div className="grid cols-3">
            <Field label="Rate provider (automatic updates)"><Select value={settings.data.app.rateProvider} onChange={(e) => saveApp({ rateProvider: e.target.value })}><option value="manual">Manual only</option><option value="open_er_api">open.er-api.com (free, 160+ currencies)</option><option value="frankfurter">Frankfurter (ECB reference rates)</option></Select></Field>
            <Field label="Auto-refresh every (hours, 0 = off)"><Input type="number" defaultValue={settings.data.app.rateAutoRefreshHours} onBlur={(e) => saveApp({ rateAutoRefreshHours: Number(e.target.value) })} /></Field>
            <Field label="Exchange margin (bps) applied on conversions"><Input type="number" defaultValue={settings.data.app.exchangeMarginBps} onBlur={(e) => saveApp({ exchangeMarginBps: Number(e.target.value) })} /></Field>
          </div>
        </div>
      )}
      <div className="card">
        <div className="row wrap mb"><Input placeholder="Search code or name" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 240 }} /><Chip kind={filter === 'enabled' ? 'primary' : undefined} onClick={() => setFilter('enabled')}>Enabled</Chip><Chip kind={filter === 'all' ? 'primary' : undefined} onClick={() => setFilter('all')}>All currencies</Chip></div>
        <Table head={['Code', 'Name', 'Symbol', 'Decimals', `Rate (per 1 ${base?.code ?? ''})`, 'Source', 'Enabled', '']} rows={items.map((c) => [
          <b>{c.code}{c.isBase && <Chip kind="primary">base</Chip>}</b>, c.name, c.symbol, c.decimals, c.isBase ? '1' : c.rateToBase, <span className="small muted">{c.rateSource}<br />{c.rateUpdatedAt ? new Date(c.rateUpdatedAt).toLocaleDateString() : ''}</span>,
          <Switch on={c.enabled} onChange={(v) => save({ ...c, enabled: v })} />, <Button size="sm" variant="secondary" onClick={() => setEdit({ ...c })}>Edit</Button>,
        ])} />
      </div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={`Edit ${edit?.code}`}>
        {edit && (
          <>
            {edit.isBase && <Alert kind="info">This is the base currency; its rate is always 1.</Alert>}
            <Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <div className="grid cols-3">
              <Field label="Symbol"><Input value={edit.symbol} onChange={(e) => setEdit({ ...edit, symbol: e.target.value })} /></Field>
              <Field label="Decimals"><Input type="number" value={edit.decimals} onChange={(e) => setEdit({ ...edit, decimals: e.target.value })} /></Field>
              <Field label="Sort order"><Input type="number" value={edit.sortOrder} onChange={(e) => setEdit({ ...edit, sortOrder: e.target.value })} /></Field>
            </div>
            <Field label={`Rate: 1 ${base?.code} = ? ${edit.code}`}><Input value={edit.rateToBase} onChange={(e) => setEdit({ ...edit, rateToBase: e.target.value })} disabled={edit.isBase} /></Field>
            <Switch on={!!edit.enabled} onChange={(v) => setEdit({ ...edit, enabled: v })} label="Enabled for users" />
            <div className="mt"><Button onClick={() => save(edit)}>Save</Button></div>
          </>
        )}
      </Modal>
    </div>
  );
}
