import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, AmountInput, Button, Chip, CopyButton, Empty, Field, Input, KV, Modal, PageHeader, QrImage, Select, StatusBadge, Tabs, TxRow, useAsync } from '../components/ui';
import type { ApiKey, PaymentRequest, Transaction } from '@bitripay/shared';

export function MerchantDashboard() {
  const { user, money } = useStore();
  const stats = useAsync(() => api.get<any>('/api/merchant/stats'), []);
  const tx = useAsync(() => api.get<{ items: Transaction[] }>('/api/wallets/transactions?direction=in&pageSize=10'), []);
  const [apply, setApply] = useState('');
  const { refresh } = useStore();
  if (user?.role !== 'merchant' && user?.role !== 'admin') {
    return (
      <div style={{ maxWidth: 520 }}>
        <PageHeader title="Become a merchant" subtitle="Accept QR, card, mobile money and virtual card payments" />
        <div className="card">
          <Field label="Business name"><Input value={apply} onChange={(e) => setApply(e.target.value)} /></Field>
          <Button onClick={() => api.post('/api/merchant/apply', { businessName: apply }).then(refresh)} disabled={apply.length < 2}>Upgrade my account</Button>
        </div>
      </div>
    );
  }
  const s = stats.data;
  return (
    <div>
      <PageHeader title={user?.businessName || 'Merchant dashboard'} subtitle="Sales overview for the last 30 days" actions={<><Link className="btn" to="/app/merchant/pos">🧾 Point of sale</Link><Link className="btn secondary" to="/app/merchant/gateway">🔌 Gateway & API</Link></>} />
      <div className="grid cols-4">
        {(s?.byCurrency ?? []).map((c: any) => (
          <div className="card" key={c.currency}><div className="stat"><span className="label">Volume · {c.currency}</span><span className="value">{money(c.volume, c.currency)}</span><span className="small muted">{c.c} payments · today {money(c.today, c.currency)} · fees {money(c.fees, c.currency)}</span></div></div>
        ))}
        {s?.byCurrency?.length === 0 && <div className="card"><div className="stat"><span className="label">Volume</span><span className="value">—</span><span className="small muted">No sales yet</span></div></div>}
        <div className="card"><div className="stat"><span className="label">Open payment links</span><span className="value">{s?.openPaymentRequests ?? 0}</span></div></div>
      </div>
      <div className="grid cols-3 mt">
        <div className="card" style={{ gridColumn: 'span 2' }}>
          <h3>Daily volume</h3>
          <Bars data={(s?.daily ?? []).map((d: any) => ({ label: d.day.slice(5), value: d.volume, currency: d.currency }))} />
        </div>
        <div className="card">
          <h3>By method</h3>
          {(s?.byMethod ?? []).map((m: any) => <KV key={m.method} k={m.method.replace('_', ' ')} v={m.count} />)}
          {s?.byMethod?.length === 0 && <Empty icon="📊" />}
        </div>
      </div>
      <div className="card mt">
        <div className="card-title"><h3>Recent payments</h3><Link to="/app/transactions?direction=in" className="small">All →</Link></div>
        {tx.data?.items.length === 0 && <Empty icon="🏪" />}
        <div className="list">{tx.data?.items.map((t) => <TxRow key={t.id} tx={t} />)}</div>
      </div>
    </div>
  );
}

function Bars({ data }: { data: { label: string; value: number; currency: string }[] }) {
  const { money } = useStore();
  if (data.length === 0) return <Empty icon="📈" text="No data yet" />;
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="row" style={{ alignItems: 'flex-end', height: 160, gap: 4, overflowX: 'auto' }}>
      {data.map((d, i) => (
        <div key={i} title={`${d.label}: ${money(d.value, d.currency)}`} style={{ flex: 1, minWidth: 14, background: 'var(--primary)', height: `${(d.value / max) * 100}%`, borderRadius: 4, opacity: 0.85 }} />
      ))}
    </div>
  );
}

export function MerchantPos() {
  const { money, wallets, config } = useStore();
  const [amount, setAmount] = useState('');
  const [cur, setCur] = useState(wallets[0]?.currency || config?.baseCurrency || 'USD');
  const [desc, setDesc] = useState('');
  const [pr, setPr] = useState<PaymentRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requests = useAsync(() => api.get<{ items: PaymentRequest[] }>('/api/payment-requests?role=requester&pageSize=15'), [pr?.id]);
  useEffect(() => {
    if (!pr || pr.status !== 'open') return;
    const timer = setInterval(async () => {
      const r = await api.get<{ paymentRequest: PaymentRequest }>(`/api/payment-requests/${pr.code}`);
      setPr(r.paymentRequest);
    }, 3000);
    return () => clearInterval(timer);
  }, [pr]);
  const create = async () => {
    setError(null);
    try {
      const r = await api.post<{ paymentRequest: PaymentRequest }>('/api/payment-requests', { kind: 'qr', amount, currency: cur, description: desc || null, expiresInMinutes: 30 });
      setPr(r.paymentRequest);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div>
      <PageHeader title="Point of sale" subtitle="Enter an amount and let the customer scan the dynamic QR code" />
      <div className="grid cols-2">
        <div className="card">
          {error && <Alert kind="error">{error}</Alert>}
          <Field label="Amount"><AmountInput amount={amount} currency={cur} onAmount={setAmount} onCurrency={setCur} big currencies={(config?.currencies ?? []).map((c) => c.code)} /></Field>
          <Field label="Description (optional)"><Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Table 4 · Order #1042" /></Field>
          <Button block size="lg" onClick={create} disabled={!amount}>Generate QR</Button>
          <div className="divider" />
          <h4>Recent</h4>
          <div className="list">
            {requests.data?.items.map((r) => (
              <div key={r.id} className="list-item clickable" onClick={() => setPr(r)}>
                <div className="flex1"><div className="main-text">{r.amount != null ? money(r.amount, r.currency) : 'Open'} {r.description ? `· ${r.description}` : ''}</div><div className="sub-text">{new Date(r.createdAt).toLocaleTimeString()} · {r.code}</div></div>
                <StatusBadge status={r.status} />
              </div>
            ))}
          </div>
        </div>
        <div className="card center">
          {pr ? (
            <>
              {pr.status === 'paid' ? <div style={{ fontSize: '4rem' }}>✅</div> : <QrImage value={pr.link!} size={260} />}
              <h2 className="mt">{pr.amount != null ? money(pr.amount, pr.currency) : 'Any amount'}</h2>
              <p className="muted">{pr.description}</p>
              <StatusBadge status={pr.status} />
              {pr.status === 'open' && <p className="small muted mt-sm">Waiting for payment… <span className="spinner" style={{ verticalAlign: 'middle' }} /></p>}
              {pr.status === 'paid' && <p className="small mt-sm">Paid by {pr.payer?.fullName ?? 'customer'}</p>}
              <div className="row mt" style={{ justifyContent: 'center' }}><CopyButton text={pr.link!} label="Copy link" /><Button size="sm" variant="secondary" onClick={() => setPr(null)}>New sale</Button></div>
            </>
          ) : (
            <Empty icon="🔳" text="Your QR will appear here" />
          )}
        </div>
      </div>
    </div>
  );
}

export function MerchantGateway() {
  const { toast, config } = useStore();
  const [tab, setTab] = useState<'settings' | 'keys' | 'webhooks' | 'settlements' | 'docs'>('settings');
  const gw = useAsync(() => api.get<{ settings: any; webhookUrl: string | null; webhookSecret: string | null }>('/api/merchant/gateway'), []);
  const keys = useAsync(() => api.get<{ items: ApiKey[] }>('/api/merchant/api-keys'), []);
  const deliveries = useAsync(() => api.get<{ items: any[] }>('/api/merchant/webhook/deliveries'), [tab]);
  const settlements = useAsync(() => api.get<{ items: any[] }>('/api/merchant/settlements'), [tab]);
  const [settings, setSettings] = useState<any>(null);
  const [newKey, setNewKey] = useState<(ApiKey & { secret: string }) | null>(null);
  const [label, setLabel] = useState('');
  const [webhook, setWebhook] = useState('');
  useEffect(() => {
    if (gw.data) {
      setSettings(gw.data.settings);
      setWebhook(gw.data.webhookUrl ?? '');
    }
  }, [gw.data]);
  const save = async () => {
    try {
      await api.put('/api/merchant/gateway', settings);
      toast('Gateway settings saved', 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const methods = ['wallet', 'card', 'mobile_money', 'bank', 'virtual_card'];
  return (
    <div>
      <PageHeader title="Payment gateway" subtitle="Configure how customers pay you, manage API keys and webhooks" />
      <Tabs tabs={[{ id: 'settings', label: 'Manage gateway' }, { id: 'keys', label: 'API keys' }, { id: 'webhooks', label: 'Webhooks' }, { id: 'settlements', label: 'Settlements' }, { id: 'docs', label: 'Integration docs' }]} value={tab} onChange={(v) => setTab(v as any)} />
      {tab === 'settings' && settings && (
        <div className="card">
          <Field label="Accepted payment methods on hosted checkout">
            <div className="row wrap">{methods.map((m) => <Chip key={m} kind={settings.methods.includes(m) ? 'primary' : undefined} onClick={() => setSettings({ ...settings, methods: settings.methods.includes(m) ? settings.methods.filter((x: string) => x !== m) : [...settings.methods, m] })}>{settings.methods.includes(m) ? '✓ ' : ''}{m.replace('_', ' ')}</Chip>)}</div>
          </Field>
          <div className="grid cols-2">
            <Field label="Brand color"><Input type="color" value={settings.brandColor} onChange={(e) => setSettings({ ...settings, brandColor: e.target.value })} /></Field>
            <Field label="Settlement currency"><Select value={settings.settlementCurrency ?? ''} onChange={(e) => setSettings({ ...settings, settlementCurrency: e.target.value || null })}><option value="">Keep in received currency</option>{(config?.currencies ?? []).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</Select></Field>
            <Field label="Success URL (after payment)"><Input value={settings.successUrl ?? ''} onChange={(e) => setSettings({ ...settings, successUrl: e.target.value || null })} placeholder="https://yourstore.com/thank-you" /></Field>
            <Field label="Cancel URL"><Input value={settings.cancelUrl ?? ''} onChange={(e) => setSettings({ ...settings, cancelUrl: e.target.value || null })} /></Field>
          </div>
          <Field label="Logo (URL or data URI)"><Input value={settings.logoUrl ?? ''} onChange={(e) => setSettings({ ...settings, logoUrl: e.target.value || null })} /></Field>
          <label className="checkbox mb"><input type="checkbox" checked={!!settings.autoSettle} onChange={(e) => setSettings({ ...settings, autoSettle: e.target.checked })} /> Automatically settle my balance to my default bank account</label>
          <label className="checkbox mb"><input type="checkbox" checked={!!settings.testMode} onChange={(e) => setSettings({ ...settings, testMode: e.target.checked })} /> Show “test mode” badge on checkout</label>
          <Button onClick={save}>Save settings</Button>
        </div>
      )}
      {tab === 'keys' && (
        <div className="card">
          <p className="small muted">Use API keys to create payment requests from your website, app or the WooCommerce plugin. Keys are shown once.</p>
          <div className="row mb"><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Key label (e.g. WooCommerce)" style={{ maxWidth: 260 }} /><Button onClick={() => api.post<{ apiKey: any }>('/api/merchant/api-keys', { label }).then((r) => { setNewKey(r.apiKey); setLabel(''); keys.reload(); })}>Create key</Button></div>
          {keys.data?.items.length === 0 && <Empty icon="🔑" />}
          <div className="list">
            {keys.data?.items.map((k) => (
              <div key={k.id} className="list-item"><div className="flex1"><div className="main-text">{k.label}</div><div className="sub-text mono">{k.prefix} · created {new Date(k.createdAt).toLocaleDateString()} {k.lastUsedAt ? `· last used ${new Date(k.lastUsedAt).toLocaleString()}` : ''}</div></div><Button size="sm" variant="ghost" onClick={() => api.del(`/api/merchant/api-keys/${k.id}`).then(keys.reload)}>Revoke</Button></div>
            ))}
          </div>
          <Modal open={!!newKey} onClose={() => setNewKey(null)} title="Your new API key">
            <Alert kind="warning">Copy this key now – it won't be shown again.</Alert>
            <div className="card soft compact mono small" style={{ wordBreak: 'break-all' }}>{newKey?.secret}</div>
            <div className="mt"><CopyButton text={newKey?.secret ?? ''} /></div>
          </Modal>
        </div>
      )}
      {tab === 'webhooks' && (
        <div className="card">
          <Field label="Webhook URL" hint="We POST payment.completed and payment_request.created events, signed with X-BitriPay-Signature (HMAC-SHA256 of the raw body).">
            <div className="row"><Input value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="https://yourstore.com/wc-api/bitripay" /><Button onClick={() => api.put('/api/merchant/webhook', { url: webhook || null }).then(() => { toast('Saved', 'success'); gw.reload(); })}>Save</Button></div>
          </Field>
          {gw.data?.webhookSecret && <KV k="Signing secret" v={<span className="row" style={{ justifyContent: 'flex-end' }}><span className="mono small">{gw.data.webhookSecret}</span><CopyButton text={gw.data.webhookSecret} /><Button size="sm" variant="ghost" onClick={() => api.post('/api/merchant/webhook/rotate').then(gw.reload)}>Rotate</Button></span>} />}
          <h4 className="mt">Recent deliveries</h4>
          {deliveries.data?.items.length === 0 && <Empty icon="📡" />}
          <div className="table-wrap"><table><thead><tr><th>Event</th><th>Status</th><th>Attempts</th><th>When</th></tr></thead><tbody>{deliveries.data?.items.map((d) => <tr key={d.id}><td>{d.event}</td><td>{d.success ? <Chip kind="success">{d.statusCode}</Chip> : <Chip kind="danger">{d.statusCode ?? d.lastError ?? 'pending'}</Chip>}</td><td>{d.attempts}</td><td>{new Date(d.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div>
        </div>
      )}
      {tab === 'settlements' && (
        <div className="card">
          <p className="small muted">Settlements move your balance to your bank account. Turn on automatic settlement in “Manage gateway”, or <Link to="/app/withdraw">withdraw manually</Link>.</p>
          {settlements.data?.items.length === 0 && <Empty icon="🏦" />}
          <div className="list">{settlements.data?.items.map((s) => <div key={s.id} className="list-item"><div className="flex1"><div className="main-text">{s.amount / 100} {s.currency}</div><div className="sub-text">{s.reference} · {new Date(s.createdAt).toLocaleString()}</div></div><StatusBadge status={s.status} /></div>)}</div>
        </div>
      )}
      {tab === 'docs' && <Docs />}
    </div>
  );
}

function Docs() {
  const { config } = useStore();
  const base = config?.apiUrl || window.location.origin;
  return (
    <div className="card md">
      <h3>Integrate BitriPay checkout</h3>
      <p>1. Create a payment request with your API key. 2. Redirect the customer to <code>checkoutUrl</code> (or show the QR). 3. Listen for the <code>payment.completed</code> webhook or poll the request.</p>
      <pre className="card soft compact small" style={{ overflowX: 'auto' }}>{`curl -X POST ${base}/v1/payment-requests \\
  -H "Authorization: Bearer bp_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{"amount":"49.99","currency":"USD","description":"Order #1001",
       "successUrl":"https://shop.example/thanks","metadata":{"orderId":1001}}'

# → { "paymentRequest": {...,"code":"ABCD1234EF","status":"open"}, "checkoutUrl": "${config?.webUrl}/pay/ABCD1234EF" }

# Check status
curl ${base}/v1/payment-requests/ABCD1234EF -H "Authorization: Bearer bp_live_..."

# Webhook payload (POST to your URL, header X-BitriPay-Signature: sha256=<hmac>)
{ "event": "payment.completed", "data": { "paymentRequest": {...}, "transaction": { "reference": "BP-...", "amount": 4999, "currency": "USD", "method": "card" } } }`}</pre>
      <p>Amounts in API responses are integers in minor units (cents). Endpoints: <code>GET /v1/me</code>, <code>GET /v1/balance</code>, <code>POST /v1/payment-requests</code>, <code>GET /v1/payment-requests/:code</code>, <code>POST /v1/payment-requests/:code/cancel</code>, <code>GET /v1/transactions</code>.</p>
      <p>WordPress / WooCommerce: install the <b>BitriPay Payment Gateway</b> plugin from the <code>integrations/woocommerce-bitripay</code> folder of the repository, paste an API key and your webhook secret, and set the webhook URL to <code>https://yourstore.com/?wc-api=bitripay</code>.</p>
    </div>
  );
}
