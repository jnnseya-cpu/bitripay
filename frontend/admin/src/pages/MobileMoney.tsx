import { useState } from 'react';
import { countryFlag } from '@bitripay/shared';
import { api, qs } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Chip, ConfirmButton, Field, Input, Modal, PageHeader, Select, StatusBadge, Switch, Table, Tabs, Textarea, UserCell, fmtDate, useAsync, useDebounce } from '../components/ui';

export function MobileMoney() {
  const { toast, config, money } = useStore();
  const [tab, setTab] = useState<'operators' | 'routes' | 'devices' | 'templates'>('operators');
  const devices = useAsync(() => (tab === 'devices' ? api.get<{ items: any[] }>('/api/admin/evidence/devices') : Promise.resolve(null)), [tab]);
  const templates = useAsync(() => (tab === 'templates' ? api.get<{ items: any[] }>('/api/admin/evidence/templates') : Promise.resolve(null)), [tab]);
  const [dev, setDev] = useState({ name: '', publicKey: '', operatorIds: '', kind: 'collection', simMsisdn: '', simIccid: '', payoutAccountId: '', agentUserId: '' });
  const [tpl, setTpl] = useState<any>(null);
  const [testText, setTestText] = useState('');
  const [testOut, setTestOut] = useState<any>(null);
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
      await api.put(`/api/admin/momo-operators/${edit.id}`, {
        name: edit.name,
        brand: edit.brand,
        country: edit.country,
        currency: edit.currency,
        ussd: edit.ussd || null,
        color: edit.color,
        collectionNumber: edit.collectionNumber || null,
        collectionName: edit.collectionName || null,
        instructions: edit.instructions || null,
        payoutEnabled: !!edit.payoutEnabled,
        enabled: !!edit.enabled,
        sortOrder: Number(edit.sortOrder ?? 0),
      });
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
      <PageHeader
        title="Mobile money – all world operators"
        subtitle={`${list.data?.items.length ?? 0} operators across ${new Set((list.data?.items ?? []).map((o) => o.country)).size} countries. Add your collection number to accept an operator directly – no operator API required.`}
        actions={
          <Button
            onClick={() =>
              setEdit({
                id: '',
                name: '',
                brand: '',
                country: 'GH',
                currency: 'GHS',
                ussd: '',
                color: '#6366f1',
                collectionNumber: '',
                collectionName: '',
                instructions: '',
                payoutEnabled: true,
                enabled: true,
                sortOrder: 0,
              })
            }
          >
            + Add operator
          </Button>
        }
      />
      <Tabs
        tabs={[
          { id: 'operators', label: 'Operators & collection numbers' },
          { id: 'devices', label: 'Evidence devices (SMS forwarders)' },
          { id: 'templates', label: 'SMS parsing templates' },
          { id: 'routes', label: 'Any-to-any money routes' },
        ]}
        value={tab}
        onChange={(v) => setTab(v as any)}
      />
      {tab === 'operators' && (
        <>
          <div className="card mb">
            <h4>How the direct rail works</h4>
            <p className="small muted">
              1. Register a merchant / collection number with each operator you want to accept (your normal business mobile money account). 2. Enter it below. 3. Customers authorise the intent with
              biometrics/PIN and pay from their own mobile money app or USSD to that number with the reference we show them. 4. The operator's receipt SMS is forwarded by a{' '}
              <b>registered, key-signed device</b> (Evidence devices tab); it is parsed, matched on reference / amount / currency / sender / time window, checked for replays and duplicates, and only
              then settled. Anything uncertain lands in the verification console for maker-checker approval. The legacy shared-secret webhook below is accepted as evidence but is not authoritative
              unless you enable it in Gateway controls. Payouts to any mobile money number are queued in Approvals → Withdrawals for your treasury team or an agent to pay from the operator float.
            </p>
            <div className="grid cols-2">
              <div>
                <KVLine k="Signed evidence endpoint" v={<code>POST {config?.apiUrl}/api/evidence/sms</code>} />
                <KVLine k="Legacy shared-secret webhook" v={<code>POST {config?.apiUrl}/api/webhooks/manual_momo</code>} />
                <KVLine k="Body" v={<code>{'{"secret":"<smsSecret>","text":"<forwarded SMS>"}'}</code>} />
                <KVLine k="Gateway status" v={direct ? <StatusBadge status={direct.enabled ? 'active' : 'pending'} /> : '—'} />
                <KVLine k="Configured operators" v={`${configured} with a collection number`} />
              </div>
              <div>
                <Field
                  label="SMS webhook shared secret"
                  hint={
                    direct?.configuredKeys?.includes('smsSecret')
                      ? 'Configured – enter a new value to rotate. Not authoritative unless enabled in Gateway controls.'
                      : 'Not configured – the legacy webhook is rejected until set'
                  }
                >
                  <div className="row">
                    <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="long random string" />
                    <Button
                      variant="secondary"
                      disabled={!secret}
                      onClick={() =>
                        api
                          .put('/api/admin/gateways/manual_momo', {
                            name: direct?.name ?? 'Mobile money (direct, all operators)',
                            provider: 'manual_momo',
                            enabled: true,
                            methods: ['mobile_money'],
                            currencies: [],
                            credentials: { smsSecret: secret },
                          })
                          .then(() => {
                            toast('Secret saved', 'success');
                            setSecret('');
                            gateway.reload();
                          })
                          .catch((e) => toast(e.message, 'error'))
                      }
                    >
                      Save
                    </Button>
                  </div>
                </Field>
              </div>
            </div>
          </div>
          <div className="card">
            <div className="row wrap mb">
              <Input placeholder="Search operator, brand, country" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />
              <Select value={country} onChange={(e) => setCountry(e.target.value)} style={{ width: 220 }}>
                <option value="">All countries</option>
                {(config?.countries ?? []).map((c: any) => (
                  <option key={c.code} value={c.code}>
                    {countryFlag(c.code)} {c.name}
                  </option>
                ))}
              </Select>
              <Chip kind={onlyDirect ? 'primary' : undefined} onClick={() => setOnlyDirect(!onlyDirect)}>
                Only configured
              </Chip>
            </div>
            <Table
              head={['Operator', 'Country', 'Currency', 'USSD', 'Collection number', 'Payouts', 'Enabled', '']}
              rows={items.map((o) => [
                <span className="row">
                  <span className="chip" style={{ background: o.color, color: '#fff' }}>
                    {o.brand}
                  </span>
                  <b>{o.name}</b>
                </span>,
                o.country,
                o.currency,
                o.ussd ?? '—',
                o.collectionNumber ? (
                  <span className="mono">
                    {o.collectionNumber}
                    <br />
                    <span className="tiny muted">{o.collectionName}</span>
                  </span>
                ) : (
                  <span className="muted small">not set</span>
                ),
                <Switch on={o.payoutEnabled} onChange={(v) => api.put(`/api/admin/momo-operators/${o.id}`, { ...o, payoutEnabled: v }).then(list.reload)} />,
                <Switch on={o.enabled} onChange={(v) => api.put(`/api/admin/momo-operators/${o.id}`, { ...o, enabled: v }).then(list.reload)} />,
                <div className="row">
                  <Button size="sm" variant="secondary" onClick={() => setEdit({ ...o })}>
                    Configure
                  </Button>
                  <ConfirmButton size="sm" variant="ghost" onConfirm={() => api.del(`/api/admin/momo-operators/${o.id}`).then(list.reload)}>
                    Delete
                  </ConfirmButton>
                </div>,
              ])}
              empty="No operators match"
            />
          </div>
        </>
      )}
      {tab === 'devices' && (
        <div className="grid cols-2">
          <div className="card">
            <h4>Register an SMS-forwarder device</h4>
            <p className="small muted">
              The forwarder app on the collection phone generates an Ed25519 key pair and keeps the private key in the device's secure storage. Paste its public key (PEM or raw base64). Every
              forwarded SMS is signed over <code>deviceId\nnonce\nreceivedAt\nfrom\noperatorId\ntext</code> and posted to <code>POST {config?.apiUrl}/api/evidence/sms</code>. Nonces are single-use;
              bad signatures raise the device's risk score.
            </p>
            <Field label="Device name">
              <Input value={dev.name} onChange={(e) => setDev({ ...dev, name: e.target.value })} placeholder="Collection phone – Nairobi" />
            </Field>
            <Field label="Public key">
              <Textarea rows={4} value={dev.publicKey} onChange={(e) => setDev({ ...dev, publicKey: e.target.value })} placeholder="-----BEGIN PUBLIC KEY----- …" />
            </Field>
            <Field label="Operators this device may confirm (comma-separated ids, blank = any)">
              <Input value={dev.operatorIds} onChange={(e) => setDev({ ...dev, operatorIds: e.target.value })} placeholder="mpesa_ke, airtel_ke" />
            </Field>
            <Field label="Device kind">
              <Select value={dev.kind} onChange={(e) => setDev({ ...dev, kind: e.target.value })}>
                <option value="collection">collection – forwards receipts for money in</option>
                <option value="payout">payout – approved Android device with a merchant SIM</option>
              </Select>
            </Field>
            {dev.kind === 'payout' && (
              <div className="grid cols-2">
                <Field label="SIM MSISDN">
                  <Input value={dev.simMsisdn} onChange={(e) => setDev({ ...dev, simMsisdn: e.target.value })} />
                </Field>
                <Field label="SIM ICCID">
                  <Input value={dev.simIccid} onChange={(e) => setDev({ ...dev, simIccid: e.target.value })} />
                </Field>
                <Field label="Payout account id">
                  <Input value={dev.payoutAccountId} onChange={(e) => setDev({ ...dev, payoutAccountId: e.target.value })} />
                </Field>
                <Field label="Operating agent user id">
                  <Input value={dev.agentUserId} onChange={(e) => setDev({ ...dev, agentUserId: e.target.value })} />
                </Field>
              </div>
            )}
            <Button
              disabled={!dev.name || dev.publicKey.length < 32}
              onClick={() =>
                api
                  .post('/api/admin/evidence/devices', {
                    name: dev.name,
                    publicKey: dev.publicKey,
                    operatorIds: dev.operatorIds
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                    kind: dev.kind,
                    simMsisdn: dev.simMsisdn || null,
                    simIccid: dev.simIccid || null,
                    payoutAccountId: dev.payoutAccountId || null,
                    agentUserId: dev.agentUserId || null,
                  })
                  .then(() => {
                    toast('Device registered', 'success');
                    setDev({ name: '', publicKey: '', operatorIds: '', kind: 'collection', simMsisdn: '', simIccid: '', payoutAccountId: '', agentUserId: '' });
                    devices.reload();
                  })
                  .catch((e) => toast(e.message, 'error'))
              }
            >
              Register device
            </Button>
          </div>
          <div className="card">
            <h4>Registered devices</h4>
            <Table
              head={['Name', 'Id', 'Kind / SIM', 'Operators', 'Status', 'Risk', 'Last seen', '']}
              rows={(devices.data?.items ?? []).map((d: any) => [
                <b>{d.name}</b>,
                <span className="mono tiny">{d.id}</span>,
                <span className="tiny">
                  {d.kind}
                  {d.simMsisdn ? ` · …${String(d.simMsisdn).slice(-4)}` : ''}
                </span>,
                d.operatorIds.length ? d.operatorIds.join(', ') : 'any',
                <StatusBadge status={d.status} />,
                <Chip kind={d.riskScore >= 50 ? 'danger' : d.riskScore > 0 ? 'warning' : 'success'}>{d.riskScore}</Chip>,
                fmtDate(d.lastSeenAt),
                d.status === 'active' ? (
                  <ConfirmButton
                    size="sm"
                    variant="danger"
                    prompt="Reason"
                    onConfirm={(r) =>
                      api.del(`/api/admin/evidence/devices/${d.id}`).then(() => {
                        toast(`Revoked: ${r}`, 'success');
                        devices.reload();
                      })
                    }
                  >
                    Revoke
                  </ConfirmButton>
                ) : null,
              ])}
              empty="No devices registered – signed evidence cannot be received yet"
            />
          </div>
        </div>
      )}
      {tab === 'templates' && (
        <div className="grid cols-2">
          <div className="card">
            <div className="row mb">
              <h4 style={{ margin: 0 }}>Operator parsing templates</h4>
              <Button
                size="sm"
                style={{ marginLeft: 'auto' }}
                onClick={() =>
                  setTpl({
                    id: 'new',
                    operatorId: '*',
                    name: '',
                    priority: 0,
                    enabled: true,
                    patterns: { keywords: [], reference: '', amount: '', currency: '', sender: '', recipient: '', externalRef: '', timestamp: '', balance: '' },
                  })
                }
              >
                + New template
              </Button>
            </div>
            <p className="small muted">
              Regular expressions (group 1 = value; sender uses group 1 = name, group 2 = phone). Templates for a specific operator take priority over the generic <code>*</code> templates. Confidence:
              reference 50, amount 25, currency 10, operator transaction id 10, sender 5.
            </p>
            <Table
              head={['Operator', 'Name', 'Priority', 'Enabled', '']}
              rows={(templates.data?.items ?? []).map((t: any) => [
                <span className="mono">{t.operatorId}</span>,
                t.name,
                t.priority,
                <StatusBadge status={t.enabled ? 'active' : 'disabled'} />,
                <div className="row">
                  <Button size="sm" variant="secondary" onClick={() => setTpl({ ...t, patterns: { ...t.patterns } })}>
                    Edit
                  </Button>
                  <ConfirmButton size="sm" variant="ghost" onConfirm={() => api.del(`/api/admin/evidence/templates/${t.id}`).then(templates.reload)}>
                    Delete
                  </ConfirmButton>
                </div>,
              ])}
            />
          </div>
          <div className="card">
            <h4>Test a message</h4>
            <Field label="Paste an operator SMS">
              <Textarea
                rows={4}
                value={testText}
                onChange={(e) => setTestText(e.target.value)}
                placeholder="QX7A1B2C3D Confirmed. You have received Ksh1,000.00 from JOHN DOE 254712345678 … Ref MMABC123"
              />
            </Field>
            <Button
              variant="secondary"
              disabled={!testText}
              onClick={() =>
                api
                  .post('/api/admin/evidence/parse-test', { text: testText })
                  .then((r: any) => setTestOut(r.parsed))
                  .catch((e) => toast(e.message, 'error'))
              }
            >
              Parse
            </Button>
            {testOut && (
              <pre className="tiny mono mt" style={{ whiteSpace: 'pre-wrap' }}>
                {JSON.stringify(testOut, null, 2)}
              </pre>
            )}
          </div>
        </div>
      )}
      <Modal open={!!tpl} onClose={() => setTpl(null)} title={tpl?.id === 'new' ? 'New parsing template' : `Edit ${tpl?.name}`} wide>
        {tpl && (
          <>
            <div className="grid cols-2">
              <Field label="Operator id (* = any)">
                <Input value={tpl.operatorId} onChange={(e) => setTpl({ ...tpl, operatorId: e.target.value })} />
              </Field>
              <Field label="Name">
                <Input value={tpl.name} onChange={(e) => setTpl({ ...tpl, name: e.target.value })} />
              </Field>
              <Field label="Priority">
                <Input type="number" value={tpl.priority} onChange={(e) => setTpl({ ...tpl, priority: Number(e.target.value) })} />
              </Field>
              <Field label="Keywords (comma-separated, message must contain one)">
                <Input
                  value={(tpl.patterns.keywords ?? []).join(', ')}
                  onChange={(e) =>
                    setTpl({
                      ...tpl,
                      patterns: {
                        ...tpl.patterns,
                        keywords: e.target.value
                          .split(',')
                          .map((s: string) => s.trim())
                          .filter(Boolean),
                      },
                    })
                  }
                />
              </Field>
            </div>
            {['reference', 'amount', 'currency', 'sender', 'recipient', 'externalRef', 'timestamp', 'balance'].map((k) => (
              <Field key={k} label={`${k} pattern`}>
                <Input className="mono" value={tpl.patterns[k] ?? ''} onChange={(e) => setTpl({ ...tpl, patterns: { ...tpl.patterns, [k]: e.target.value } })} />
              </Field>
            ))}
            <Switch on={!!tpl.enabled} onChange={(v) => setTpl({ ...tpl, enabled: v })} label="Enabled" />
            <div className="mt">
              <Button
                disabled={!tpl.name || !tpl.operatorId}
                onClick={() => {
                  const patterns = Object.fromEntries(Object.entries(tpl.patterns).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : !!v)));
                  api
                    .put(`/api/admin/evidence/templates/${tpl.id}`, { operatorId: tpl.operatorId, name: tpl.name, priority: tpl.priority, enabled: tpl.enabled, patterns })
                    .then(() => {
                      toast('Template saved', 'success');
                      setTpl(null);
                      templates.reload();
                    })
                    .catch((e) => toast(e.message, 'error'));
                }}
              >
                Save
              </Button>
            </div>
          </>
        )}
      </Modal>
      {tab === 'routes' && (
        <div className="card">
          <Alert kind="info">
            Every any-to-any movement (card → mobile money, mobile money → bank, bank → QR…). Funding legs settle through gateways or the direct rails; payout legs to bank / mobile money appear in
            Approvals → Withdrawals.
          </Alert>
          <Table
            head={['User', 'From', 'To', 'Amount', 'Deliver in', 'Status', 'Created', 'Error']}
            rows={(routes.data?.items ?? []).map((r: any) => [
              <UserCell user={r.user} />,
              r.source.replace('_', ' '),
              <span>
                {r.destination.replace('_', ' ')}
                <br />
                <span className="tiny muted">{r.destinationDetails?.to || r.destinationDetails?.phone || r.destinationDetails?.accountNumber || r.destinationDetails?.agent || ''}</span>
              </span>,
              money(r.amount, r.currency),
              r.targetCurrency,
              <StatusBadge status={r.status} />,
              fmtDate(r.createdAt),
              <span className="small" style={{ color: 'var(--danger)' }}>
                {r.error ?? ''}
              </span>,
            ])}
            empty="No routes yet"
          />
        </div>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Configure ${edit.name}` : 'Add operator'}>
        {edit && (
          <>
            {!edit.id && (
              <Field label="ID (lowercase, e.g. mtn_gh)">
                <Input value={edit.id} onChange={(e) => setEdit({ ...edit, id: e.target.value })} />
              </Field>
            )}
            <div className="grid cols-2">
              <Field label="Name">
                <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
              </Field>
              <Field label="Brand">
                <Input value={edit.brand} onChange={(e) => setEdit({ ...edit, brand: e.target.value })} />
              </Field>
              <Field label="Country">
                <Select value={edit.country} onChange={(e) => setEdit({ ...edit, country: e.target.value })}>
                  {(config?.countries ?? []).map((c: any) => (
                    <option key={c.code} value={c.code}>
                      {countryFlag(c.code)} {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Currency">
                <Input value={edit.currency} onChange={(e) => setEdit({ ...edit, currency: e.target.value.toUpperCase() })} />
              </Field>
              <Field label="USSD code">
                <Input value={edit.ussd ?? ''} onChange={(e) => setEdit({ ...edit, ussd: e.target.value })} />
              </Field>
              <Field label="Color">
                <Input type="color" value={edit.color} onChange={(e) => setEdit({ ...edit, color: e.target.value })} />
              </Field>
            </div>
            <Alert kind="success">Direct rail: customers pay to this number with a reference. Leave blank to route this operator only through API gateways (or the sandbox in development).</Alert>
            <div className="grid cols-2">
              <Field label="Your collection / merchant number">
                <Input value={edit.collectionNumber ?? ''} onChange={(e) => setEdit({ ...edit, collectionNumber: e.target.value })} placeholder="0244000000" />
              </Field>
              <Field label="Account name shown to payers">
                <Input value={edit.collectionName ?? ''} onChange={(e) => setEdit({ ...edit, collectionName: e.target.value })} placeholder="BitriPay Ltd" />
              </Field>
            </div>
            <Field label="Custom instructions (optional)">
              <Textarea value={edit.instructions ?? ''} onChange={(e) => setEdit({ ...edit, instructions: e.target.value })} />
            </Field>
            <Switch on={!!edit.payoutEnabled} onChange={(v) => setEdit({ ...edit, payoutEnabled: v })} label="Allow payouts to this operator" />
            <div className="mt-sm">
              <Switch on={!!edit.enabled} onChange={(v) => setEdit({ ...edit, enabled: v })} label="Enabled" />
            </div>
            <div className="mt">
              <Button onClick={save} disabled={!edit.id || !edit.name}>
                Save
              </Button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}

function KVLine({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}
