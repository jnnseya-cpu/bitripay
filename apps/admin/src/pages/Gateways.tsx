import { useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Chip, ConfirmButton, Field, Input, Modal, PageHeader, Select, Switch, Table, useAsync } from '../components/ui';

export function Gateways() {
  const { toast, config } = useStore();
  const data = useAsync(() => api.get<{ items: any[]; providers: any[] }>('/api/admin/gateways'), []);
  const [edit, setEdit] = useState<any>(null);
  const [creds, setCreds] = useState<Record<string, string>>({});
  const providers = data.data?.providers ?? [];
  const provider = providers.find((p) => p.id === edit?.provider);
  const startEdit = (g: any) => {
    setEdit({ ...g, currencies: g.currencies.join(','), countries: g.countries.join(',') });
    setCreds({});
  };
  const startNew = () => {
    setEdit({ id: '', name: '', provider: 'stripe', enabled: false, methods: ['card'], currencies: '', countries: '', config: {}, sortOrder: 10, configuredKeys: [] });
    setCreds({});
  };
  const save = async () => {
    try {
      const id = edit.id || edit.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      await api.put(`/api/admin/gateways/${id}`, {
        name: edit.name,
        provider: edit.provider,
        enabled: edit.enabled,
        methods: edit.methods,
        currencies: edit.currencies.split(',').map((s: string) => s.trim().toUpperCase()).filter(Boolean),
        countries: edit.countries.split(',').map((s: string) => s.trim().toUpperCase()).filter(Boolean),
        credentials: Object.keys(creds).length ? creds : undefined,
        config: edit.config,
        sortOrder: Number(edit.sortOrder),
      });
      toast('Gateway saved', 'success');
      setEdit(null);
      data.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <div>
      <PageHeader title="Deposit & payment gateways (aggregator)" subtitle="Route cards, mobile money and bank transfers through multiple providers. Credentials are encrypted at rest; environment variables act as defaults." actions={<Button onClick={startNew}>+ Add gateway</Button>} />
      <Alert kind="info">The <b>sandbox</b> gateway simulates every method for testing. Enable real providers by adding their keys. Order determines which gateway is used first for a method/currency.</Alert>
      <div className="card">
        <Table head={['Gateway', 'Provider', 'Methods', 'Currencies', 'Countries', 'Keys', 'Enabled', '']} rows={(data.data?.items ?? []).map((g) => [
          <b>{g.name}<br /><span className="tiny muted mono">{g.id}</span></b>, g.provider, <span className="row wrap">{g.methods.map((m: string) => <Chip key={m}>{m.replace('_', ' ')}</Chip>)}</span>, g.currencies.length ? g.currencies.join(', ') : <span className="muted">all</span>, g.countries.length ? g.countries.join(', ') : <span className="muted">all</span>,
          <span className="small">{g.credentialFields.length === 0 ? '—' : `${g.configuredKeys.length}/${g.credentialFields.length}`}</span>,
          <Switch on={g.enabled} onChange={(v) => api.put(`/api/admin/gateways/${g.id}`, { name: g.name, provider: g.provider, enabled: v, methods: g.methods, currencies: g.currencies, countries: g.countries, config: g.config, sortOrder: g.sortOrder }).then(data.reload)} />,
          <div className="row"><Button size="sm" variant="secondary" onClick={() => startEdit(g)}>Configure</Button><ConfirmButton size="sm" variant="ghost" onConfirm={() => api.del(`/api/admin/gateways/${g.id}`).then(data.reload)}>Delete</ConfirmButton></div>,
        ])} />
      </div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Configure ${edit.name}` : 'New gateway'} wide>
        {edit && (
          <div className="grid cols-2">
            <div>
              <Field label="Display name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
              <Field label="Provider"><Select value={edit.provider} onChange={(e) => { const p = providers.find((x) => x.id === e.target.value); setEdit({ ...edit, provider: e.target.value, methods: p?.methods ?? [] }); }} disabled={!!edit.id}>{providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
              <Field label="Methods"><div className="row wrap">{(provider?.methods ?? []).map((m: string) => <Chip key={m} kind={edit.methods.includes(m) ? 'primary' : undefined} onClick={() => setEdit({ ...edit, methods: edit.methods.includes(m) ? edit.methods.filter((x: string) => x !== m) : [...edit.methods, m] })}>{m.replace('_', ' ')}</Chip>)}</div></Field>
              <Field label="Currencies (comma separated, blank = all)" hint={`Enabled: ${(config?.currencies ?? []).map((c: any) => c.code).join(', ')}`}><Input value={edit.currencies} onChange={(e) => setEdit({ ...edit, currencies: e.target.value })} placeholder="USD,EUR,NGN" /></Field>
              <Field label="Countries (ISO codes, blank = all)"><Input value={edit.countries} onChange={(e) => setEdit({ ...edit, countries: e.target.value })} placeholder="NG,GH,KE" /></Field>
              <Field label="Sort order (lower = preferred)"><Input type="number" value={edit.sortOrder} onChange={(e) => setEdit({ ...edit, sortOrder: e.target.value })} /></Field>
              <Switch on={edit.enabled} onChange={(v) => setEdit({ ...edit, enabled: v })} label="Enabled" />
              {edit.provider === 'sandbox' && <div className="mt"><Switch on={!!edit.config?.allowInProduction} onChange={(v) => setEdit({ ...edit, config: { ...edit.config, allowInProduction: v } })} label="Allow sandbox in production (not recommended)" /></div>}
            </div>
            <div>
              <h4>Credentials</h4>
              {(provider?.credentialFields ?? []).length === 0 && <div className="muted small">This provider needs no credentials.</div>}
              {(provider?.credentialFields ?? []).map((f: any) => (
                <Field key={f.key} label={f.label} hint={edit.configuredKeys?.includes(f.key) ? 'Configured – leave blank to keep, type to replace' : 'Not configured'}>
                  <Input type={f.secret ? 'password' : 'text'} value={creds[f.key] ?? ''} onChange={(e) => setCreds({ ...creds, [f.key]: e.target.value })} placeholder={edit.configuredKeys?.includes(f.key) ? '••••••••' : ''} />
                </Field>
              ))}
              {edit.provider !== 'sandbox' && edit.provider !== 'manual_bank' && <Alert kind="info">Webhook URL for this provider: <code>{config?.apiUrl}/api/webhooks/{edit.id || '<id>'}</code></Alert>}
              <Button onClick={save} disabled={!edit.name}>Save gateway</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
