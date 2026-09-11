import { useState } from 'react';
import { api, qs } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Chip, ConfirmButton, Field, Input, Modal, PageHeader, Select, StatusBadge, Switch, Table, Tabs, Textarea, UserCell, fmtDate, useAsync, useDebounce } from '../components/ui';

export function MobileMoney() {
  const { toast, config, money } = useStore();
  const [tab, setTab] = useState<'operators' | 'routes'>('operators');
  const [country, setCountry] = useState('');
  const [q, setQ] = useState('');
  const [onlyDirect, setOnlyDirect] = useState(false);
  const dq = useDebounce(q, 250);
  const list = useAsync(() => api.get<{ items: any[] }>(`/api/admin/momo-operators${qs({ country })}`), [country, tab]);
  const routes = useAsync(() => api.get<any>('/api/admin/money-routes?pageSize=50'), [tab]);
  const gateway = useAsync(() => api.get<{ items: any[] }>('/api/admin/gateways'), []);
  const direct = gateway.data?.items.find((g) => g.provider === 'manual_momo');
  const [edit, setEdit] = useState<any>(null);
  const [secret, setSecret] = useState('');
  const save = async () => {
    try {
      await api.put(`/api/admin/momo-operators/${edit.id}`, { name: edit.name, brand: edit.brand, country: edit.country, currency: edit.currency, ussd: edit.ussd || null, color: edit.color, collectionNumber: edit.collectionNumber || null, collectionName: edit.collectionName || null, instructions: edit.instructions || null, payoutEnabled: !!edit.payoutEnabled, enabled: !!edit.enabled, sortOrder: Number(edit.sortOrder ?? 0) });
      toast('Operator saved', 'success');
      setEdit(null);
      list.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const items = (list.data?.items ?? []).filter((o) => (!onlyDirect || o.directRail) && (!dq || `${o.name} ${o.brand} ${o.country} ${o.currency}`.toLowerCase().includes(dq.toLowerCase())));
  const configured = (list.data?.items ?? []).filter((o) => o.directRail).length;
  return (
    <div>
      <PageHeader title="Mobile money – all world operators" subtitle={`${list.data?.items.length ?? 0} operators across ${new Set((list.data?.items ?? []).map((o) => o.country)).size} countries. Add your collection number to accept an operator directly – no operator API required.`} actions={<Button onClick={() => setEdit({ id: '', name: '', brand: '', country: 'GH', currency: 'GHS', ussd: '', color: '#6366f1', collectionNumber: '', collectionName: '', instructions: '', payoutEnabled: true, enabled: true, sortOrder: 0 })}>+ Add operator</Button>} />
      <Tabs tabs={[{ id: 'operators', label: 'Operators & collection numbers' }, { id: 'routes', label: 'Any-to-any money routes' }]} value={tab} onChange={(v) => setTab(v as any)} />
      {tab === 'operators' && (
        <>
          <div className="card mb">
            <h4>How the direct rail works</h4>
            <p className="small muted">1. Register a merchant / collection number with each operator you want to accept (your normal business mobile money account). 2. Enter it below. 3. Customers pay from their own mobile money app or USSD to that number with the reference we show them. 4. The payment is confirmed automatically when the operator's receipt SMS is forwarded to the webhook below (any SMS-forwarder app on the collection phone works), or manually in Approvals → Bank / manual deposits. Payouts to any mobile money number are queued in Approvals → Withdrawals for your team or an agent to pay from the operator float.</p>
            <div className="grid cols-2">
              <div><KVLine k="SMS auto-confirm webhook" v={<code>POST {config?.apiUrl}/api/webhooks/manual_momo</code>} /><KVLine k="Body" v={<code>{'{"secret":"<smsSecret>","text":"<forwarded SMS>"}'}</code>} /><KVLine k="Gateway status" v={direct ? <StatusBadge status={direct.enabled ? 'active' : 'pending'} /> : '—'} /><KVLine k="Configured operators" v={`${configured} with a collection number`} /></div>
              <div>
                <Field label="SMS webhook shared secret" hint={direct?.configuredKeys?.includes('smsSecret') ? 'Configured – enter a new value to rotate' : 'Not configured – auto-confirm disabled until set'}>
                  <div className="row"><Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="long random string" /><Button variant="secondary" disabled={!secret} onClick={() => api.put('/api/admin/gateways/manual_momo', { name: direct?.name ?? 'Mobile money (direct, all operators)', provider: 'manual_momo', enabled: true, methods: ['mobile_money'], currencies: [], credentials: { smsSecret: secret } }).then(() => { toast('Secret saved', 'success'); setSecret(''); gateway.reload(); }).catch((e) => toast(e.message, 'error'))}>Save</Button></div>
                </Field>
              </div>
            </div>
          </div>
          <div className="card">
            <div className="row wrap mb">
              <Input placeholder="Search operator, brand, country" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />
              <Select value={country} onChange={(e) => setCountry(e.target.value)} style={{ width: 220 }}><option value="">All countries</option>{(config?.countries ?? []).map((c: any) => <option key={c.code} value={c.code}>{c.name}</option>)}</Select>
              <Chip kind={onlyDirect ? 'primary' : undefined} onClick={() => setOnlyDirect(!onlyDirect)}>Only configured</Chip>
            </div>
            <Table head={['Operator', 'Country', 'Currency', 'USSD', 'Collection number', 'Payouts', 'Enabled', '']} rows={items.map((o) => [
              <span className="row"><span className="chip" style={{ background: o.color, color: '#fff' }}>{o.brand}</span><b>{o.name}</b></span>, o.country, o.currency, o.ussd ?? '—',
              o.collectionNumber ? <span className="mono">{o.collectionNumber}<br /><span className="tiny muted">{o.collectionName}</span></span> : <span className="muted small">not set</span>,
              <Switch on={o.payoutEnabled} onChange={(v) => api.put(`/api/admin/momo-operators/${o.id}`, { ...o, payoutEnabled: v }).then(list.reload)} />,
              <Switch on={o.enabled} onChange={(v) => api.put(`/api/admin/momo-operators/${o.id}`, { ...o, enabled: v }).then(list.reload)} />,
              <div className="row"><Button size="sm" variant="secondary" onClick={() => setEdit({ ...o })}>Configure</Button><ConfirmButton size="sm" variant="ghost" onConfirm={() => api.del(`/api/admin/momo-operators/${o.id}`).then(list.reload)}>Delete</ConfirmButton></div>,
            ])} empty="No operators match" />
          </div>
        </>
      )}
      {tab === 'routes' && (
        <div className="card">
          <Alert kind="info">Every any-to-any movement (card → mobile money, mobile money → bank, bank → QR…). Funding legs settle through gateways or the direct rails; payout legs to bank / mobile money appear in Approvals → Withdrawals.</Alert>
          <Table head={['User', 'From', 'To', 'Amount', 'Deliver in', 'Status', 'Created', 'Error']} rows={(routes.data?.items ?? []).map((r: any) => [<UserCell user={r.user} />, r.source.replace('_', ' '), <span>{r.destination.replace('_', ' ')}<br /><span className="tiny muted">{r.destinationDetails?.to || r.destinationDetails?.phone || r.destinationDetails?.accountNumber || r.destinationDetails?.agent || ''}</span></span>, money(r.amount, r.currency), r.targetCurrency, <StatusBadge status={r.status} />, fmtDate(r.createdAt), <span className="small" style={{ color: 'var(--danger)' }}>{r.error ?? ''}</span>])} empty="No routes yet" />
        </div>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Configure ${edit.name}` : 'Add operator'}>
        {edit && (
          <>
            {!edit.id && <Field label="ID (lowercase, e.g. mtn_gh)"><Input value={edit.id} onChange={(e) => setEdit({ ...edit, id: e.target.value })} /></Field>}
            <div className="grid cols-2">
              <Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
              <Field label="Brand"><Input value={edit.brand} onChange={(e) => setEdit({ ...edit, brand: e.target.value })} /></Field>
              <Field label="Country"><Select value={edit.country} onChange={(e) => setEdit({ ...edit, country: e.target.value })}>{(config?.countries ?? []).map((c: any) => <option key={c.code} value={c.code}>{c.name}</option>)}</Select></Field>
              <Field label="Currency"><Input value={edit.currency} onChange={(e) => setEdit({ ...edit, currency: e.target.value.toUpperCase() })} /></Field>
              <Field label="USSD code"><Input value={edit.ussd ?? ''} onChange={(e) => setEdit({ ...edit, ussd: e.target.value })} /></Field>
              <Field label="Color"><Input type="color" value={edit.color} onChange={(e) => setEdit({ ...edit, color: e.target.value })} /></Field>
            </div>
            <Alert kind="success">Direct rail: customers pay to this number with a reference. Leave blank to route this operator only through API gateways (or the sandbox in development).</Alert>
            <div className="grid cols-2">
              <Field label="Your collection / merchant number"><Input value={edit.collectionNumber ?? ''} onChange={(e) => setEdit({ ...edit, collectionNumber: e.target.value })} placeholder="0244000000" /></Field>
              <Field label="Account name shown to payers"><Input value={edit.collectionName ?? ''} onChange={(e) => setEdit({ ...edit, collectionName: e.target.value })} placeholder="BitriPay Ltd" /></Field>
            </div>
            <Field label="Custom instructions (optional)"><Textarea value={edit.instructions ?? ''} onChange={(e) => setEdit({ ...edit, instructions: e.target.value })} /></Field>
            <Switch on={!!edit.payoutEnabled} onChange={(v) => setEdit({ ...edit, payoutEnabled: v })} label="Allow payouts to this operator" />
            <div className="mt-sm"><Switch on={!!edit.enabled} onChange={(v) => setEdit({ ...edit, enabled: v })} label="Enabled" /></div>
            <div className="mt"><Button onClick={save} disabled={!edit.id || !edit.name}>Save</Button></div>
          </>
        )}
      </Modal>
    </div>
  );
}

function KVLine({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="kv"><span className="k">{k}</span><span className="v">{v}</span></div>;
}
