import { useState } from 'react';
import { tr } from '../lib/i18n';
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
  const status = useAsync(() => api.get<any>('/api/admin/currencies/rate-status'), [refreshing]);
  const [key, setKey] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('EUR=0.92\nGBP=0.79\nKES=129.4');
  const [importNote, setImportNote] = useState('');
  const save = async (c: any) => {
    try {
      await api.put(`/api/admin/currencies/${c.code}`, {
        name: c.name,
        symbol: c.symbol,
        decimals: Number(c.decimals),
        rateToBase: Number(c.rateToBase),
        enabled: !!c.enabled,
        sortOrder: Number(c.sortOrder ?? 0),
      });
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
      toast(`Updated ${r.updated.length} rates from ${r.provider} (snapshot v${r.snapshotId})${r.skipped.length ? ` · ${r.skipped.length} not available` : ''}`, 'success');
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
    toast(tr('Saved'), 'success');
  };
  const items = (list.data?.items ?? []).filter((c) => (filter === 'all' || c.enabled) && (!q || c.code.includes(q.toUpperCase()) || c.name.toLowerCase().includes(q.toLowerCase())));
  const base = list.data?.items.find((c) => c.isBase);
  return (
    <div>
      <PageHeader
        title={tr('Currencies & exchange rates')}
        subtitle={`All ${list.data?.items.length ?? 0} ISO currencies are available. Base currency: ${base?.code ?? ''}. Rates are units per 1 ${base?.code ?? 'base'}.`}
        actions={
          <Button loading={refreshing} onClick={refreshRates}>
            ↻ Refresh live rates
          </Button>
        }
      />
      {settings.data && (
        <div className="card mb">
          <h4>{tr('Exchange rate management')}</h4>
          <div className="grid cols-3">
            <Field label={tr('Rate provider (automatic updates)')}>
              <Select value={settings.data.app.rateProvider} onChange={(e) => saveApp({ rateProvider: e.target.value })}>
                <option value="manual">{tr('Manual only (administrator-approved rates)')}</option>
                {(status.data?.providers ?? []).map((p: any) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            {(status.data?.providers ?? []).find((p: any) => p.id === settings.data.app.rateProvider)?.keyed && (
              <Field label={tr('Provider API key')} hint={settings.data.app.rateProviderKey ? tr('Configured (encrypted) – enter a new value to rotate') : tr('Required for this provider')}>
                <div className="row">
                  <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={settings.data.app.rateProviderKey ? '••••••••' : tr('API key')} />
                  <Button variant="secondary" disabled={!key} onClick={() => saveApp({ rateProviderKey: key }).then(() => setKey(''))}>
                    {tr('Save')}
                  </Button>
                </div>
              </Field>
            )}
            <Field label={tr('Auto-refresh every (hours, 0 = off)')}>
              <Input type="number" defaultValue={settings.data.app.rateAutoRefreshHours} onBlur={(e) => saveApp({ rateAutoRefreshHours: Number(e.target.value) })} />
            </Field>
            <Field label={tr('Exchange margin (bps) applied on conversions')}>
              <Input type="number" defaultValue={settings.data.app.exchangeMarginBps} onBlur={(e) => saveApp({ exchangeMarginBps: Number(e.target.value) })} />
            </Field>
          </div>
          {status.data && (
            <div className="mt">
              {status.data.freshness.live && status.data.freshness.fresh ? (
                <Alert kind="success">
                  {tr('Live rates from {0}; oldest update {1}. Guaranteed quotes are enabled.', {
                    0: status.data.freshness.source,
                    1: new Date(status.data.freshness.oldestUpdatedAt).toLocaleString(),
                  })}
                </Alert>
              ) : (
                <Alert kind="warning">
                  {tr('Rates in use are')} <b>not live</b> ({status.data.freshness.source || 'none'}). Customers see them labelled as test / administrator rates and no rate is guaranteed.{' '}
                  {status.data.status.lastError ? (
                    <>
                      <br />
                      {tr('Last refresh error (')}
                      {status.data.status.consecutiveFailures}×): {status.data.status.lastError}
                    </>
                  ) : null}
                </Alert>
              )}
              <div className="row wrap">
                <span className="small muted">Last success: {status.data.status.lastSuccessAt ? new Date(status.data.status.lastSuccessAt).toLocaleString() : 'never'}</span>
                <Button size="sm" variant="secondary" onClick={() => setImportOpen(true)}>
                  {tr('Import a versioned rate batch')}
                </Button>
              </div>
              {status.data.snapshots.length > 0 && (
                <div className="tiny muted mt-sm">
                  Snapshots:{' '}
                  {status.data.snapshots
                    .slice(0, 8)
                    .map((s: any) => `v${s.id} ${s.source === 'live' ? s.provider : 'import'} ${new Date(s.fetchedAt).toLocaleDateString()}`)
                    .join(' · ')}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <Modal open={importOpen} onClose={() => setImportOpen(false)} title={tr('Import a versioned rate batch (non-live)')}>
        <Alert kind="warning">
          {tr(
            'Use this when the API cannot reach a rate provider. The batch is stored as a numbered snapshot and every quote built on it is labelled as an administrator-imported, non-live rate; guaranteed quotes stay disabled.',
          )}
        </Alert>
        <Field label={`One rate per line: CODE=units per 1 ${base?.code ?? 'base'}`}>
          <textarea className="input" rows={6} value={importText} onChange={(e) => setImportText(e.target.value)} />
        </Field>
        <Field label={tr('Note (source, desk, date)')}>
          <Input value={importNote} onChange={(e) => setImportNote(e.target.value)} />
        </Field>
        <Button
          onClick={() => {
            const rates: Record<string, number> = {};
            importText.split(/\n|,/).forEach((l) => {
              const [c, v] = l.split('=');
              if (c && v && Number(v) > 0) rates[c.trim().toUpperCase()] = Number(v);
            });
            api
              .post<any>('/api/admin/currencies/import', { rates, note: importNote || null })
              .then((r) => {
                toast(`Imported ${r.updated.length} rates as snapshot v${r.snapshotId}`, 'success');
                setImportOpen(false);
                list.reload();
                status.reload();
              })
              .catch((e) => toast(e.message, 'error'));
          }}
        >
          {tr('Import')}
        </Button>
      </Modal>
      <div className="card">
        <div className="row wrap mb">
          <Input placeholder={tr('Search code or name')} value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 240 }} />
          <Chip kind={filter === 'enabled' ? 'primary' : undefined} onClick={() => setFilter('enabled')}>
            {tr('Enabled')}
          </Chip>
          <Chip kind={filter === 'all' ? 'primary' : undefined} onClick={() => setFilter('all')}>
            {tr('All currencies')}
          </Chip>
        </div>
        <Table
          head={[tr('Code'), tr('Name'), tr('Symbol'), tr('Decimals'), `Rate (per 1 ${base?.code ?? ''})`, tr('Source'), tr('Enabled'), '']}
          rows={items.map((c) => [
            <b>
              {c.code}
              {c.isBase && <Chip kind="primary">base</Chip>}
            </b>,
            c.name,
            c.symbol,
            c.decimals,
            c.isBase ? '1' : c.rateToBase,
            <span className="small muted">
              {c.rateSource}
              <br />
              {c.rateUpdatedAt ? new Date(c.rateUpdatedAt).toLocaleDateString() : ''}
            </span>,
            <Switch on={c.enabled} onChange={(v) => save({ ...c, enabled: v })} />,
            <Button size="sm" variant="secondary" onClick={() => setEdit({ ...c })}>
              {tr('Edit')}
            </Button>,
          ])}
        />
      </div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={`Edit ${edit?.code}`}>
        {edit && (
          <>
            {edit.isBase && <Alert kind="info">{tr('This is the base currency; its rate is always 1.')}</Alert>}
            <Field label={tr('Name')}>
              <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </Field>
            <div className="grid cols-3">
              <Field label={tr('Symbol')}>
                <Input value={edit.symbol} onChange={(e) => setEdit({ ...edit, symbol: e.target.value })} />
              </Field>
              <Field label={tr('Decimals')}>
                <Input type="number" value={edit.decimals} onChange={(e) => setEdit({ ...edit, decimals: e.target.value })} />
              </Field>
              <Field label={tr('Sort order')}>
                <Input type="number" value={edit.sortOrder} onChange={(e) => setEdit({ ...edit, sortOrder: e.target.value })} />
              </Field>
            </div>
            <Field label={`Rate: 1 ${base?.code} = ? ${edit.code}`}>
              <Input value={edit.rateToBase} onChange={(e) => setEdit({ ...edit, rateToBase: e.target.value })} disabled={edit.isBase} />
            </Field>
            <Switch on={!!edit.enabled} onChange={(v) => setEdit({ ...edit, enabled: v })} label={tr('Enabled for users')} />
            <div className="mt">
              <Button onClick={() => save(edit)}>{tr('Save')}</Button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
