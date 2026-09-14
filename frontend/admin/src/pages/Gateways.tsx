import { useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Chip, ConfirmButton, Field, Input, Modal, PageHeader, Select, Switch, Table, useAsync } from '../components/ui';

export function Gateways() {
  const { toast, config } = useStore();
  const data = useAsync(() => api.get<{ items: any[]; providers: any[] }>('/api/admin/gateways'), []);
  const [edit, setEdit] = useState<any>(null);
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const test = async (id: string) => {
    setTesting(id);
    try {
      const r = await api.post<any>(`/api/admin/gateways/${id}/test`);
      toast(`${r.ok ? '✅' : '❌'} ${r.message} · webhook: ${r.webhookUrl}`, r.ok ? 'success' : 'error');
      data.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setTesting(null);
    }
  };
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
  /** Provider operations fields live in the gateway config JSON under the keys the rail registry reads (services/rails.ts gatewayCapabilities). */
  const setCfg = (key: string, value: unknown) => {
    const cfg = { ...(edit.config ?? {}) };
    if (value === '' || value === undefined || value === null) delete cfg[key];
    else cfg[key] = value;
    setEdit({ ...edit, config: cfg });
  };
  const cfgText = (key: string) => (edit?.config?.[key] == null ? '' : String(edit.config[key]));
  const triState = (key: string) => (edit?.config?.[key] === true ? 'yes' : edit?.config?.[key] === false ? 'no' : 'inherit');
  const save = async () => {
    try {
      const id = edit.id || edit.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      await api.put(`/api/admin/gateways/${id}`, {
        name: edit.name,
        provider: edit.provider,
        enabled: edit.enabled,
        methods: edit.methods,
        currencies: edit.currencies
          .split(',')
          .map((s: string) => s.trim().toUpperCase())
          .filter(Boolean),
        countries: edit.countries
          .split(',')
          .map((s: string) => s.trim().toUpperCase())
          .filter(Boolean),
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
      <PageHeader
        title="Deposit & payment gateways (aggregator)"
        subtitle="Route cards, mobile money and bank transfers through multiple providers. Credentials are encrypted at rest; environment variables act as defaults."
        actions={<Button onClick={startNew}>+ Add gateway</Button>}
      />
      <Alert kind="warning">
        <b>Onboarding a real processor:</b> create the account with Stripe, Paystack or Flutterwave, paste the <b>test</b> keys first, register the webhook URL shown by <i>Test connection</i> at the
        processor and paste its signing secret, complete a full sandbox run, then replace with <b>live</b> keys. Live keys are recognised automatically and are never offered to payers while the
        platform is in sandbox compliance mode (Gateway controls → Compliance). Card collection is only ever performed by the licensed processor; BitriPay never sees or stores card numbers.
      </Alert>
      <Alert kind="info">
        The <b>sandbox</b> gateway simulates every method for testing. Enable real providers by adding their keys. Order determines which gateway is used first for a method/currency. Mobile money
        works for every operator in the world without an API through the <b>direct rail</b> – configure collection numbers under <b>Mobile money operators</b>.
      </Alert>
      <Alert kind="info">
        <b>Bitcoin / Lightning</b> is a payment rail behind the same intent and QR, never a second checkout: it is offered only where the country capability matrix allows it (Capabilities →{' '}
        <i>bitcoin</i>) and the merchant opted in. <b>sandbox</b> mode generates invoices locally at a labelled sandbox BTC rate; <b>btcpay</b> mode talks to a BTCPay Server (Greenfield API key, store
        id, webhook secret) and Lightning settles on payment, on-chain after the configured confirmations. Refunds are manual.
      </Alert>
      <div className="card">
        <Table
          head={['Gateway', 'Provider', 'Mode', 'Methods', 'Currencies', 'Countries', 'Keys', 'Ops', 'Last test', 'Enabled', '']}
          rows={(data.data?.items ?? []).map((g) => [
            <b>
              {g.name}
              <br />
              <span className="tiny muted mono">{g.id}</span>
            </b>,
            g.provider,
            <Chip kind={g.mode === 'live' ? 'danger' : g.mode === 'test' ? 'success' : undefined}>{g.mode}</Chip>,
            <span className="row wrap">
              {g.methods.map((m: string) => (
                <Chip key={m}>{m.replace('_', ' ')}</Chip>
              ))}
            </span>,
            g.currencies.length ? g.currencies.join(', ') : <span className="muted">all</span>,
            g.countries.length ? g.countries.join(', ') : <span className="muted">all</span>,
            <span className="small">{g.credentialFields.length === 0 ? '—' : `${g.configuredKeys.length}/${g.credentialFields.length}`}</span>,
            <span className="tiny">
              {g.config?.settlementT != null || g.config?.settlementDays != null ? `T+${g.config.settlementT ?? g.config.settlementDays}` : <span className="muted">T+default</span>}
              {g.config?.maintenanceWindow ? <> · maint. {g.config.maintenanceWindow}</> : null}
              {g.config?.supportContact ? (
                <>
                  <br />
                  <span className="muted">{g.config.supportContact}</span>
                </>
              ) : null}
            </span>,
            g.lastHealth ? (
              <span className="tiny" style={{ color: g.lastHealth.ok ? 'var(--success)' : 'var(--danger)' }}>
                {g.lastHealth.ok ? '✅' : '❌'} {g.lastHealth.message.slice(0, 60)}
                <br />
                <span className="muted">{new Date(g.lastHealth.at).toLocaleString()}</span>
              </span>
            ) : (
              <span className="tiny muted">not tested</span>
            ),
            <Switch
              on={g.enabled}
              onChange={(v) =>
                api
                  .put(`/api/admin/gateways/${g.id}`, {
                    name: g.name,
                    provider: g.provider,
                    enabled: v,
                    methods: g.methods,
                    currencies: g.currencies,
                    countries: g.countries,
                    config: g.config,
                    sortOrder: g.sortOrder,
                  })
                  .then(data.reload)
              }
            />,
            <div className="row">
              <Button size="sm" variant="secondary" onClick={() => startEdit(g)}>
                Configure
              </Button>
              <Button size="sm" variant="ghost" loading={testing === g.id} onClick={() => test(g.id)}>
                Test connection
              </Button>
              <ConfirmButton size="sm" variant="ghost" onConfirm={() => api.del(`/api/admin/gateways/${g.id}`).then(data.reload)}>
                Delete
              </ConfirmButton>
            </div>,
          ])}
        />
      </div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Configure ${edit.name}` : 'New gateway'} wide>
        {edit && (
          <div className="grid cols-2">
            <div>
              <Field label="Display name">
                <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
              </Field>
              <Field label="Provider">
                <Select
                  value={edit.provider}
                  onChange={(e) => {
                    const p = providers.find((x) => x.id === e.target.value);
                    setEdit({ ...edit, provider: e.target.value, methods: p?.methods ?? [] });
                  }}
                  disabled={!!edit.id}
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              {edit.provider === 'stripe' && (
                <Field label="3-D Secure" hint="automatic = Stripe/issuer decide (SCA); any = always challenge">
                  <Select value={edit.config?.threeDSecure ?? 'automatic'} onChange={(e) => setEdit({ ...edit, config: { ...edit.config, threeDSecure: e.target.value } })}>
                    <option value="automatic">automatic (recommended)</option>
                    <option value="any">always challenge</option>
                  </Select>
                </Field>
              )}
              <Field label="Methods">
                <div className="row wrap">
                  {(provider?.methods ?? []).map((m: string) => (
                    <Chip
                      key={m}
                      kind={edit.methods.includes(m) ? 'primary' : undefined}
                      onClick={() => setEdit({ ...edit, methods: edit.methods.includes(m) ? edit.methods.filter((x: string) => x !== m) : [...edit.methods, m] })}
                    >
                      {m.replace('_', ' ')}
                    </Chip>
                  ))}
                </div>
              </Field>
              <Field label="Currencies (comma separated, blank = all)" hint={`Enabled: ${(config?.currencies ?? []).map((c: any) => c.code).join(', ')}`}>
                <Input value={edit.currencies} onChange={(e) => setEdit({ ...edit, currencies: e.target.value })} placeholder="USD,EUR,NGN" />
              </Field>
              <Field label="Countries (ISO codes, blank = all)">
                <Input value={edit.countries} onChange={(e) => setEdit({ ...edit, countries: e.target.value })} placeholder="NG,GH,KE" />
              </Field>
              <Field label="Sort order (lower = preferred)">
                <Input type="number" value={edit.sortOrder} onChange={(e) => setEdit({ ...edit, sortOrder: e.target.value })} />
              </Field>
              <Switch on={edit.enabled} onChange={(v) => setEdit({ ...edit, enabled: v })} label="Enabled" />
              {edit.provider === 'sandbox' && (
                <div className="mt">
                  <Switch
                    on={!!edit.config?.allowInProduction}
                    onChange={(v) => setEdit({ ...edit, config: { ...edit.config, allowInProduction: v } })}
                    label="Allow sandbox in production (not recommended)"
                  />
                </div>
              )}
              {edit.provider === 'bitcoin' && (
                <div className="mt">
                  <Switch
                    on={!!edit.config?.allowInProduction}
                    onChange={(v) => setEdit({ ...edit, config: { ...edit.config, allowInProduction: v } })}
                    label="Allow sandbox-mode invoices in production (not recommended)"
                  />
                  <div className="muted small mt">
                    Merchants settle in the intent currency at the disclosed rate by default, or keep a BTC balance when their policy says <code>bitcoinSettlement: 'btc'</code> (the BTC currency must
                    be enabled). The disclosed rate is the platform BTC rate: sandbox until a live provider or an imported rate sheet supplies one.
                  </div>
                </div>
              )}
              <h4 className="mt">Provider operations</h4>
              <div className="muted small">Stored on the gateway; the rail registry, Smart Route and the go-live checklist read them. Blank = provider default.</div>
              <div className="grid cols-2">
                <Field label="Settlement T+n (days)">
                  <Input
                    type="number"
                    min={0}
                    value={cfgText('settlementT')}
                    onChange={(e) => setCfg('settlementT', e.target.value === '' ? '' : Number(e.target.value))}
                    placeholder="provider default"
                  />
                </Field>
                <Field label="Maintenance window" hint="e.g. Sun 02:00–04:00 UTC">
                  <Input value={cfgText('maintenanceWindow')} onChange={(e) => setCfg('maintenanceWindow', e.target.value)} placeholder="none" />
                </Field>
                <Field label="Support contact" hint="Provider support desk (email / phone)">
                  <Input value={cfgText('supportContact')} onChange={(e) => setCfg('supportContact', e.target.value)} placeholder="support@provider.example" />
                </Field>
                <Field label="Incident contact" hint="24/7 escalation for outages">
                  <Input value={cfgText('incidentContact')} onChange={(e) => setCfg('incidentContact', e.target.value)} placeholder="noc@provider.example" />
                </Field>
                <Field label="Minimum amount (minor units)">
                  <Input type="number" min={0} value={cfgText('minMinor')} onChange={(e) => setCfg('minMinor', e.target.value === '' ? '' : Number(e.target.value))} placeholder="0 = none" />
                </Field>
                <Field label="Maximum amount (minor units)">
                  <Input type="number" min={0} value={cfgText('maxMinor')} onChange={(e) => setCfg('maxMinor', e.target.value === '' ? '' : Number(e.target.value))} placeholder="0 = none" />
                </Field>
                <Field label="Refunds supported">
                  <Select value={triState('refunds')} onChange={(e) => setCfg('refunds', e.target.value === 'inherit' ? '' : e.target.value === 'yes')}>
                    <option value="inherit">provider contract</option>
                    <option value="yes">yes</option>
                    <option value="no">no</option>
                  </Select>
                </Field>
                <Field label="Webhooks supported">
                  <Select value={triState('webhooks')} onChange={(e) => setCfg('webhooks', e.target.value === 'inherit' ? '' : e.target.value === 'yes')}>
                    <option value="inherit">provider contract</option>
                    <option value="yes">yes</option>
                    <option value="no">no</option>
                  </Select>
                </Field>
              </div>
            </div>
            <div>
              <h4>Credentials</h4>
              {(provider?.credentialFields ?? []).length === 0 && <div className="muted small">This provider needs no credentials.</div>}
              {(provider?.credentialFields ?? []).map((f: any) => (
                <Field key={f.key} label={f.label} hint={edit.configuredKeys?.includes(f.key) ? 'Configured – leave blank to keep, type to replace' : 'Not configured'}>
                  {edit.provider === 'bitcoin' && f.key === 'mode' ? (
                    <Select value={creds.mode ?? ''} onChange={(e) => setCreds({ ...creds, mode: e.target.value })}>
                      <option value="">{edit.configuredKeys?.includes('mode') ? 'keep current' : 'sandbox (default)'}</option>
                      <option value="sandbox">sandbox – local invoices, paid through the simulator</option>
                      <option value="btcpay">btcpay – BTCPay Server (Greenfield API)</option>
                    </Select>
                  ) : edit.provider === 'bitcoin' && f.key === 'network' ? (
                    <Select value={creds.network ?? ''} onChange={(e) => setCreds({ ...creds, network: e.target.value })}>
                      <option value="">{edit.configuredKeys?.includes('network') ? 'keep current' : 'default (regtest in sandbox, mainnet with BTCPay)'}</option>
                      <option value="mainnet">mainnet (live)</option>
                      <option value="testnet">testnet (test)</option>
                      <option value="signet">signet (test)</option>
                      <option value="regtest">regtest (test)</option>
                    </Select>
                  ) : (
                    <Input
                      type={f.secret ? 'password' : 'text'}
                      value={creds[f.key] ?? ''}
                      onChange={(e) => setCreds({ ...creds, [f.key]: e.target.value })}
                      placeholder={edit.configuredKeys?.includes(f.key) ? '••••••••' : ''}
                    />
                  )}
                </Field>
              ))}
              {edit.provider === 'bitcoin' && (
                <Alert kind="info">
                  BTCPay: create a Greenfield API key with <code>btcpay.store.cancreateinvoice</code>, <code>btcpay.store.canviewinvoices</code> and <code>btcpay.store.canmodifyinvoices</code>,
                  register the webhook URL below on the store and paste its secret (<code>BTCPay-Sig</code> HMAC-SHA256). Confirmations default to 1 on-chain; Lightning settles on payment.
                </Alert>
              )}
              {edit.provider !== 'sandbox' && edit.provider !== 'manual_bank' && (
                <Alert kind="info">
                  Webhook URL for this provider:{' '}
                  <code>
                    {config?.apiUrl}/api/webhooks/{edit.id || '<id>'}
                  </code>
                </Alert>
              )}
              <Button onClick={save} disabled={!edit.name}>
                Save gateway
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
