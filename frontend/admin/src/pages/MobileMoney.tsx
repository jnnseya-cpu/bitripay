import { useState } from 'react';
import { tr } from '../lib/i18n';
import { countryLabel } from '@bitripay/shared';
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
      toast(tr('Operator saved'), 'success');
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
        title={tr('Mobile money – all world operators')}
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
            {tr('+ Add operator')}
          </Button>
        }
      />
      <Tabs
        tabs={[
          { id: 'operators', label: tr('Operators & collection numbers') },
          { id: 'devices', label: tr('Evidence devices (SMS forwarders)') },
          { id: 'templates', label: tr('SMS parsing templates') },
          { id: 'routes', label: tr('Any-to-any money routes') },
        ]}
        value={tab}
        onChange={(v) => setTab(v as any)}
      />
      {tab === 'operators' && (
        <>
          <div className="card mb">
            <h4>{tr('How the direct rail works')}</h4>
            <p className="small muted">
              1. Register a merchant / collection number with each operator you want to accept (your normal business mobile money account). 2. Enter it below. 3. Customers authorise the intent with
              biometrics/PIN and pay from their own mobile money app or USSD to that number with the reference we show them. 4. The operator's receipt SMS is forwarded by a{' '}
              <b>registered, key-signed device</b> (Evidence devices tab); it is parsed, matched on reference / amount / currency / sender / time window, checked for replays and duplicates, and only
              then settled. Anything uncertain lands in the verification console for maker-checker approval. The legacy shared-secret webhook below is accepted as evidence but is not authoritative
              unless you enable it in Gateway controls. Payouts to any mobile money number are queued in Approvals → Withdrawals for your treasury team or an agent to pay from the operator float.
            </p>
            <div className="grid cols-2">
              <div>
                <KVLine k={tr('Signed evidence endpoint')} v={<code>POST {config?.apiUrl}/api/evidence/sms</code>} />
                <KVLine k={tr('Legacy shared-secret webhook')} v={<code>POST {config?.apiUrl}/api/webhooks/manual_momo</code>} />
                <KVLine k={tr('Body')} v={<code>{'{"secret":"<smsSecret>","text":"<forwarded SMS>"}'}</code>} />
                <KVLine k={tr('Gateway status')} v={direct ? <StatusBadge status={direct.enabled ? 'active' : 'pending'} /> : '—'} />
                <KVLine k={tr('Configured operators')} v={`${configured} with a collection number`} />
              </div>
              <div>
                <Field
                  label={tr('SMS webhook shared secret')}
                  hint={
                    direct?.configuredKeys?.includes('smsSecret')
                      ? tr('Configured – enter a new value to rotate. Not authoritative unless enabled in Gateway controls.')
                      : tr('Not configured – the legacy webhook is rejected until set')
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
                            toast(tr('Secret saved'), 'success');
                            setSecret('');
                            gateway.reload();
                          })
                          .catch((e) => toast(e.message, 'error'))
                      }
                    >
                      {tr('Save')}
                    </Button>
                  </div>
                </Field>
              </div>
            </div>
          </div>
          <div className="card">
            <div className="row wrap mb">
              <Input placeholder={tr('Search operator, brand, country')} value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />
              <Select value={country} onChange={(e) => setCountry(e.target.value)} style={{ width: 220 }}>
                <option value="">{tr('All countries')}</option>
                {(config?.countries ?? []).map((c: any) => (
                  <option key={c.code} value={c.code}>
                    {countryLabel(c.code, c.name)}
                  </option>
                ))}
              </Select>
              <Chip kind={onlyDirect ? 'primary' : undefined} onClick={() => setOnlyDirect(!onlyDirect)}>
                {tr('Only configured')}
              </Chip>
            </div>
            <Table
              head={[tr('Operator'), tr('Country'), tr('Currency'), 'USSD', tr('Collection number'), tr('Payouts'), tr('Enabled'), '']}
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
                    {tr('Configure')}
                  </Button>
                  <ConfirmButton size="sm" variant="ghost" onConfirm={() => api.del(`/api/admin/momo-operators/${o.id}`).then(list.reload)}>
                    {tr('Delete')}
                  </ConfirmButton>
                </div>,
              ])}
              empty={tr('No operators match')}
            />
          </div>
        </>
      )}
      {tab === 'devices' && (
        <div className="grid cols-2">
          <div className="card">
            <h4>{tr('Register an SMS-forwarder device')}</h4>
            <p className="small muted">
              {tr(
                "The forwarder app on the collection phone generates an Ed25519 key pair and keeps the private key in the device's secure storage. Paste its public key (PEM or raw base64). Every forwarded SMS is signed over",
              )}{' '}
              <code>deviceId\nnonce\nreceivedAt\nfrom\noperatorId\ntext</code> and posted to <code>POST {config?.apiUrl}/api/evidence/sms</code>. Nonces are single-use; bad signatures raise the
              device's risk score.
            </p>
            <Field label={tr('Device name')}>
              <Input value={dev.name} onChange={(e) => setDev({ ...dev, name: e.target.value })} placeholder={tr('Collection phone – Nairobi')} />
            </Field>
            <Field label={tr('Public key')}>
              <Textarea rows={4} value={dev.publicKey} onChange={(e) => setDev({ ...dev, publicKey: e.target.value })} placeholder="-----BEGIN PUBLIC KEY----- …" />
            </Field>
            <Field label={tr('Operators this device may confirm (comma-separated ids, blank = any)')}>
              <Input value={dev.operatorIds} onChange={(e) => setDev({ ...dev, operatorIds: e.target.value })} placeholder="mpesa_ke, airtel_ke" />
            </Field>
            <Field label={tr('Device kind')}>
              <Select value={dev.kind} onChange={(e) => setDev({ ...dev, kind: e.target.value })}>
                <option value="collection">collection – forwards receipts for money in</option>
                <option value="payout">payout – approved Android device with a merchant SIM</option>
              </Select>
            </Field>
            {dev.kind === 'payout' && (
              <div className="grid cols-2">
                <Field label={tr('SIM MSISDN')}>
                  <Input value={dev.simMsisdn} onChange={(e) => setDev({ ...dev, simMsisdn: e.target.value })} />
                </Field>
                <Field label={tr('SIM ICCID')}>
                  <Input value={dev.simIccid} onChange={(e) => setDev({ ...dev, simIccid: e.target.value })} />
                </Field>
                <Field label={tr('Payout account id')}>
                  <Input value={dev.payoutAccountId} onChange={(e) => setDev({ ...dev, payoutAccountId: e.target.value })} />
                </Field>
                <Field label={tr('Operating agent user id')}>
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
                    toast(tr('Device registered'), 'success');
                    setDev({ name: '', publicKey: '', operatorIds: '', kind: 'collection', simMsisdn: '', simIccid: '', payoutAccountId: '', agentUserId: '' });
                    devices.reload();
                  })
                  .catch((e) => toast(e.message, 'error'))
              }
            >
              {tr('Register device')}
            </Button>
          </div>
          <div className="card">
            <h4>{tr('Registered devices')}</h4>
            <Table
              head={[tr('Name'), tr('Id'), tr('Kind / SIM'), tr('Operators'), tr('Status'), tr('Risk'), tr('Last seen'), '']}
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
                    {tr('Revoke')}
                  </ConfirmButton>
                ) : null,
              ])}
              empty={tr('No devices registered – signed evidence cannot be received yet')}
            />
          </div>
        </div>
      )}
      {tab === 'templates' && (
        <div className="grid cols-2">
          <div className="card">
            <div className="row mb">
              <h4 style={{ margin: 0 }}>{tr('Operator parsing templates')}</h4>
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
                {tr('+ New template')}
              </Button>
            </div>
            <p className="small muted">
              {tr('Regular expressions (group 1 = value; sender uses group 1 = name, group 2 = phone). Templates for a specific operator take priority over the generic')} <code>*</code> templates.
              Confidence: reference 50, amount 25, currency 10, operator transaction id 10, sender 5.
            </p>
            <Table
              head={[tr('Operator'), tr('Name'), tr('Priority'), tr('Enabled'), '']}
              rows={(templates.data?.items ?? []).map((t: any) => [
                <span className="mono">{t.operatorId}</span>,
                t.name,
                t.priority,
                <StatusBadge status={t.enabled ? 'active' : 'disabled'} />,
                <div className="row">
                  <Button size="sm" variant="secondary" onClick={() => setTpl({ ...t, patterns: { ...t.patterns } })}>
                    {tr('Edit')}
                  </Button>
                  <ConfirmButton size="sm" variant="ghost" onConfirm={() => api.del(`/api/admin/evidence/templates/${t.id}`).then(templates.reload)}>
                    {tr('Delete')}
                  </ConfirmButton>
                </div>,
              ])}
            />
          </div>
          <div className="card">
            <h4>{tr('Test a message')}</h4>
            <Field label={tr('Paste an operator SMS')}>
              <Textarea
                rows={4}
                value={testText}
                onChange={(e) => setTestText(e.target.value)}
                placeholder={tr('QX7A1B2C3D Confirmed. You have received Ksh1,000.00 from JOHN DOE 254712345678 … Ref MMABC123')}
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
              {tr('Parse')}
            </Button>
            {testOut && (
              <pre className="tiny mono mt" style={{ whiteSpace: 'pre-wrap' }}>
                {JSON.stringify(testOut, null, 2)}
              </pre>
            )}
          </div>
        </div>
      )}
      <Modal open={!!tpl} onClose={() => setTpl(null)} title={tpl?.id === 'new' ? tr('New parsing template') : `Edit ${tpl?.name}`} wide>
        {tpl && (
          <>
            <div className="grid cols-2">
              <Field label={tr('Operator id (* = any)')}>
                <Input value={tpl.operatorId} onChange={(e) => setTpl({ ...tpl, operatorId: e.target.value })} />
              </Field>
              <Field label={tr('Name')}>
                <Input value={tpl.name} onChange={(e) => setTpl({ ...tpl, name: e.target.value })} />
              </Field>
              <Field label={tr('Priority')}>
                <Input type="number" value={tpl.priority} onChange={(e) => setTpl({ ...tpl, priority: Number(e.target.value) })} />
              </Field>
              <Field label={tr('Keywords (comma-separated, message must contain one)')}>
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
            <Switch on={!!tpl.enabled} onChange={(v) => setTpl({ ...tpl, enabled: v })} label={tr('Enabled')} />
            <div className="mt">
              <Button
                disabled={!tpl.name || !tpl.operatorId}
                onClick={() => {
                  const patterns = Object.fromEntries(Object.entries(tpl.patterns).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : !!v)));
                  api
                    .put(`/api/admin/evidence/templates/${tpl.id}`, { operatorId: tpl.operatorId, name: tpl.name, priority: tpl.priority, enabled: tpl.enabled, patterns })
                    .then(() => {
                      toast(tr('Template saved'), 'success');
                      setTpl(null);
                      templates.reload();
                    })
                    .catch((e) => toast(e.message, 'error'));
                }}
              >
                {tr('Save')}
              </Button>
            </div>
          </>
        )}
      </Modal>
      {tab === 'routes' && (
        <div className="card">
          <Alert kind="info">
            {tr(
              'Every any-to-any movement (card → mobile money, mobile money → bank, bank → QR…). Funding legs settle through gateways or the direct rails; payout legs to bank / mobile money appear in Approvals → Withdrawals.',
            )}
          </Alert>
          <Table
            head={[tr('User'), 'From', 'To', tr('Amount'), 'Deliver in', tr('Status'), tr('Created'), tr('Error')]}
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
            empty={tr('No routes yet')}
          />
        </div>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Configure ${edit.name}` : tr('Add operator')}>
        {edit && (
          <>
            {!edit.id && (
              <Field label={tr('ID (lowercase, e.g. mtn_gh)')}>
                <Input value={edit.id} onChange={(e) => setEdit({ ...edit, id: e.target.value })} />
              </Field>
            )}
            <div className="grid cols-2">
              <Field label={tr('Name')}>
                <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
              </Field>
              <Field label={tr('Brand')}>
                <Input value={edit.brand} onChange={(e) => setEdit({ ...edit, brand: e.target.value })} />
              </Field>
              <Field label={tr('Country')}>
                <Select value={edit.country} onChange={(e) => setEdit({ ...edit, country: e.target.value })}>
                  {(config?.countries ?? []).map((c: any) => (
                    <option key={c.code} value={c.code}>
                      {countryLabel(c.code, c.name)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={tr('Currency')}>
                <Input value={edit.currency} onChange={(e) => setEdit({ ...edit, currency: e.target.value.toUpperCase() })} />
              </Field>
              <Field label={tr('USSD code')}>
                <Input value={edit.ussd ?? ''} onChange={(e) => setEdit({ ...edit, ussd: e.target.value })} />
              </Field>
              <Field label={tr('Color')}>
                <Input type="color" value={edit.color} onChange={(e) => setEdit({ ...edit, color: e.target.value })} />
              </Field>
            </div>
            <Alert kind="success">
              {tr('Direct rail: customers pay to this number with a reference. Leave blank to route this operator only through API gateways (or the sandbox in development).')}
            </Alert>
            <div className="grid cols-2">
              <Field label={tr('Your collection / merchant number')}>
                <Input value={edit.collectionNumber ?? ''} onChange={(e) => setEdit({ ...edit, collectionNumber: e.target.value })} placeholder="0244000000" />
              </Field>
              <Field label={tr('Account name shown to payers')}>
                <Input value={edit.collectionName ?? ''} onChange={(e) => setEdit({ ...edit, collectionName: e.target.value })} placeholder={tr('BitriPay Ltd')} />
              </Field>
            </div>
            <Field label={tr('Custom instructions (optional)')}>
              <Textarea value={edit.instructions ?? ''} onChange={(e) => setEdit({ ...edit, instructions: e.target.value })} />
            </Field>
            <Switch on={!!edit.payoutEnabled} onChange={(v) => setEdit({ ...edit, payoutEnabled: v })} label={tr('Allow payouts to this operator')} />
            <div className="mt-sm">
              <Switch on={!!edit.enabled} onChange={(v) => setEdit({ ...edit, enabled: v })} label={tr('Enabled')} />
            </div>
            <div className="mt">
              <Button onClick={save} disabled={!edit.id || !edit.name}>
                {tr('Save')}
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
