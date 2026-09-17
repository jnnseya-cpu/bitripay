import { useState } from 'react';
import { tr } from '../lib/i18n';
import { Link } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Chip, CopyButton, Empty, Field, Input, KV, Modal, PageHeader, Select, StatusBadge, Tabs, useAsync } from '../components/ui';
import { isMerchantClass } from '@bitripay/shared';
import { InstitutionSettlementAccount } from '../components/InstitutionSettlementAccount';

/**
 * Developer portal: scoped API keys (secret / restricted / publishable), webhook endpoints with dual signatures,
 * deliveries and replay, the event log, the sandbox catalogue with its magic numbers, the OpenAPI document, SDK
 * snippets and the BP error catalogue.
 */
export function Developer() {
  const { user, memberships, organisationId, toast } = useStore();
  // A developer invited into a client's organisation (role developer, or any role holding api_keys:manage) works here too.
  const clientWorkspaces = memberships.filter((m) => m.kind !== 'agent' && !m.owner);
  const workspace = memberships.find((m) => m.organisationId === organisationId) ?? null;
  const [tab, setTab] = useState<'keys' | 'webhooks' | 'settlement' | 'events' | 'sandbox' | 'docs'>('keys');
  const keys = useAsync(() => api.get<any>('/api/v1/api_keys'), [tab]);
  const scopes = useAsync(() => api.get<any>('/api/v1/api_keys/scopes'), []);
  const endpoints = useAsync(() => api.get<any>('/api/v1/webhook_endpoints'), [tab]);
  const types = useAsync(() => api.get<any>('/api/v1/webhook_events/types'), []);
  const events = useAsync(() => (tab === 'events' ? api.get<any>('/api/v1/events?limit=50') : Promise.resolve(null)), [tab]);
  const deliveries = useAsync(() => (tab === 'webhooks' ? api.get<any>('/api/v1/webhook_deliveries?limit=50') : Promise.resolve(null)), [tab, endpoints.data]);
  const sandbox = useAsync(() => (tab === 'sandbox' ? api.get<any>('/api/v1/sandbox') : Promise.resolve(null)), [tab]);
  /** Built-in receiver: real deliveries with their headers and signature checks, no external site needed. */
  const inbox = useAsync(() => (tab === 'webhooks' ? api.get<any>('/api/v1/webhook_inbox') : Promise.resolve(null)), [tab]);
  const [key, setKey] = useState<any>({ label: '', kind: 'secret', mode: 'test', scopes: [] as string[] });
  const [created, setCreated] = useState<any>(null);
  const [ep, setEp] = useState<any>({ url: '', events: ['payment_intent.created', 'payment_intent.succeeded', 'refund.succeeded'] });
  const [epSecret, setEpSecret] = useState<any>(null);
  const err = (e: any) => toast(e.message, 'error');
  if (!isMerchantClass(user?.role) && user?.role !== 'admin' && clientWorkspaces.length === 0)
    return (
      <Alert kind="info">
        {tr("The developer portal is for merchant and developer accounts, and for developers invited into a client's organisation.")} <Link to="/app/merchant">{tr('Upgrade')}</Link> first, or ask your
        client to add you under Command centre → Team with the developer role.
      </Alert>
    );
  // The catalogue lists { type, description } objects (older builds returned plain strings): render the type, keep the description as a tooltip.
  const allTypes: { type: string; description?: string }[] = (types.data?.data ?? types.data?.types ?? []).map((t: any) => (typeof t === 'string' ? { type: t } : t));
  return (
    <div>
      <PageHeader
        title={tr('Developer portal')}
        subtitle={
          workspace
            ? `Working for ${workspace.name} as ${workspace.role.replace(/_/g, ' ')}: the keys, webhooks and events below belong to that organisation.`
            : clientWorkspaces.length && !isMerchantClass(user?.role)
              ? `Working for ${clientWorkspaces[0].name}: pick a client in the workspace selector at the top when you integrate several.`
              : tr('One integration, every eligible rail. Keys, webhooks, events, sandbox and docs.')
        }
        actions={
          <a className="btn secondary" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">
            {tr('OpenAPI ↗')}
          </a>
        }
      />
      <Tabs
        tabs={[
          { id: 'keys', label: tr('API keys') },
          { id: 'webhooks', label: tr('Webhooks') },
          { id: 'settlement', label: tr('Settlement account') },
          { id: 'events', label: tr('Events') },
          { id: 'sandbox', label: tr('Sandbox') },
          { id: 'docs', label: tr('Docs & SDKs') },
        ]}
        value={tab}
        onChange={(v) => setTab(v as any)}
      />
      {tab === 'keys' && (
        <div className="grid cols-2">
          <div className="card">
            <h3>{tr('New key')}</h3>
            <p className="small muted">
              <b>sk_</b> {tr('secret keys act for your whole account;')} <b>rk_</b> {tr('restricted keys carry only the scopes you tick;')} <b>pk_</b>{' '}
              {tr('publishable keys are safe in browsers and apps. Test keys only touch the sandbox.')}
            </p>
            <div className="grid cols-2">
              <Field label={tr('Label')}>
                <Input value={key.label} onChange={(e) => setKey({ ...key, label: e.target.value })} placeholder={tr('Shop backend')} />
              </Field>
              <Field label={tr('Kind')}>
                <Select value={key.kind} onChange={(e) => setKey({ ...key, kind: e.target.value })}>
                  <option value="secret">secret (sk_)</option>
                  <option value="restricted">restricted (rk_)</option>
                  <option value="publishable">publishable (pk_)</option>
                </Select>
              </Field>
              <Field label={tr('Mode')}>
                <Select value={key.mode} onChange={(e) => setKey({ ...key, mode: e.target.value })}>
                  <option value="test">test</option>
                  <option value="live">live</option>
                </Select>
              </Field>
            </div>
            {key.kind === 'restricted' && (
              <Field label={tr('Scopes')}>
                <div className="row wrap">
                  {(scopes.data?.data ?? scopes.data?.scopes ?? []).map((s: string) => (
                    <Chip
                      key={s}
                      kind={key.scopes.includes(s) ? 'primary' : undefined}
                      onClick={() => setKey({ ...key, scopes: key.scopes.includes(s) ? key.scopes.filter((x: string) => x !== s) : [...key.scopes, s] })}
                    >
                      {s}
                    </Chip>
                  ))}
                </div>
              </Field>
            )}
            <Button
              onClick={() =>
                api
                  .post<any>('/api/v1/api_keys', { label: key.label, kind: key.kind, mode: key.mode, scopes: key.kind === 'restricted' ? key.scopes : undefined })
                  .then((r) => {
                    setCreated(r);
                    keys.reload();
                  })
                  .catch(err)
              }
              disabled={key.label.length < 2}
            >
              {tr('Create key')}
            </Button>
            <Modal open={!!created} onClose={() => setCreated(null)} title={tr('Your new key')}>
              <Alert kind="warning">{tr('Copy it now — it is shown once.')}</Alert>
              <div className="card soft compact mono small" style={{ wordBreak: 'break-all' }}>
                {created?.secret ?? created?.key ?? created?.apiKey?.secret}
              </div>
              <div className="mt">
                <CopyButton text={created?.secret ?? created?.key ?? created?.apiKey?.secret ?? ''} />
              </div>
            </Modal>
          </div>
          <div className="card">
            <h3>{tr('Keys')}</h3>
            {(keys.data?.data ?? keys.data?.items ?? []).length === 0 && <Empty icon="🔑" text={tr('No keys yet')} />}
            <div className="list">
              {(keys.data?.data ?? keys.data?.items ?? []).map((k: any) => (
                <div key={k.id} className="list-item">
                  <div className="flex1">
                    <div className="main-text">
                      {k.label} <Chip>{k.kind ?? 'secret'}</Chip> <Chip kind={k.mode === 'live' ? 'success' : 'warning'}>{k.mode}</Chip>
                    </div>
                    <div className="sub-text mono">
                      {k.prefix} · {(k.scopes ?? ['*']).join(', ')}
                      {k.lastUsedAt ? ` · ${tr('last used {0}', { 0: new Date(k.lastUsedAt).toLocaleString() })}` : ''}
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => api.del(`/api/v1/api_keys/${k.id}`).then(keys.reload).catch(err)}>
                    {tr('Revoke')}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {tab === 'webhooks' && (
        <div className="grid cols-2">
          <div className="card">
            <h3>{tr('Endpoints')}</h3>
            <p className="small muted">
              {tr('Every delivery carries')} <code>{tr('BitriPay-Signature')}</code> (HMAC, <code>t=…,v1=…</code>, 5-minute tolerance) and <code>BitriPay-Signature-Ed25519</code> (platform key from{' '}
              <code>/v1/keys</code>). Retries: 10s, 30s, 2m, 10m, 30m, then every 2h for 24h; dead letters can be replayed here.
            </p>
            <p className="tiny muted" data-testid="standards">
              {tr('Standards: the Ed25519 signature is')} <a href="https://www.rfc-editor.org/rfc/rfc8032">{tr('RFC 8032')}</a> over the raw body; HTTP semantics, status codes and idempotent methods
              follow <a href="https://www.rfc-editor.org/rfc/rfc9110">{tr('RFC 9110')}</a>; bearer tokens issued to your users are JSON Web Tokens (
              <a href="https://www.rfc-editor.org/rfc/rfc7519">{tr('RFC 7519')}</a>).
            </p>
            {endpoints.error && <Alert kind="error">{endpoints.error}</Alert>}
            <Field label="URL" hint={tr('A public https:// address of your server; use the inbox on the right to try deliveries without one.')}>
              <Input value={ep.url} onChange={(e) => setEp({ ...ep, url: e.target.value })} placeholder="https://shop.example/webhooks/bitripay" />
            </Field>
            <Field label={tr('Events')}>
              <div className="row wrap">
                {allTypes.map(({ type: t, description }) => (
                  <span key={t} title={description ?? t}>
                    <Chip
                      kind={ep.events.includes(t) ? 'primary' : undefined}
                      onClick={() => setEp({ ...ep, events: ep.events.includes(t) ? ep.events.filter((x: string) => x !== t) : [...ep.events, t] })}
                    >
                      {t}
                    </Chip>
                  </span>
                ))}
              </div>
            </Field>
            <Button
              onClick={() =>
                api
                  .post<any>('/api/v1/webhook_endpoints', ep)
                  .then((r) => {
                    setEpSecret(r);
                    endpoints.reload();
                  })
                  .catch(err)
              }
              disabled={!/^https?:\/\//.test(ep.url)}
            >
              {tr('Add endpoint')}
            </Button>
            <Modal open={!!epSecret} onClose={() => setEpSecret(null)} title={tr('Endpoint secret')}>
              <Alert kind="warning">{tr('Store this signing secret now.')}</Alert>
              <div className="card soft compact mono small">{epSecret?.secret}</div>
              <CopyButton text={epSecret?.secret ?? ''} />
            </Modal>
            <div className="list mt">
              {(endpoints.data?.data ?? endpoints.data?.items ?? []).map((e: any) => (
                <div key={e.id} className="list-item">
                  <div className="flex1">
                    <div className="main-text">{e.url}</div>
                    <div className="sub-text">
                      {(e.events ?? []).join(', ')} · {e.status ?? (e.active ? 'active' : 'disabled')}
                    </div>
                  </div>
                  <div className="row">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        api
                          .post(`/api/v1/webhook_endpoints/${e.id}/ping`, {})
                          .then(() => toast(tr('Ping sent'), 'success'))
                          .catch(err)
                      }
                    >
                      {tr('Ping')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        api
                          .post<any>(`/api/v1/webhook_endpoints/${e.id}/rotate`, {})
                          .then((r) => setEpSecret(r))
                          .catch(err)
                      }
                    >
                      {tr('Rotate')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => api.del(`/api/v1/webhook_endpoints/${e.id}`).then(endpoints.reload).catch(err)}>
                      {tr('Delete')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="card">
            <h3>{tr('Webhook inbox (built-in receiver)')}</h3>
            <p className="small muted">
              {tr(
                'Point an endpoint at this address and every delivery is recorded here with its headers and the result of both signature checks. Nothing runs on receipt: it only shows what your server would receive.',
              )}
            </p>
            {inbox.error && <Alert kind="error">{inbox.error}</Alert>}
            {inbox.data?.url && (
              <>
                <div className="card soft compact mono small" style={{ wordBreak: 'break-all' }}>
                  {inbox.data.url}
                </div>
                <div className="row wrap mt">
                  <CopyButton text={inbox.data.url} />
                  <Button size="sm" variant="secondary" onClick={() => setEp({ ...ep, url: inbox.data.url })}>
                    {tr('Use as endpoint URL')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => inbox.reload()}>
                    {tr('Refresh')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      api
                        .del('/api/v1/webhook_inbox')
                        .then(() => inbox.reload())
                        .catch(err)
                    }
                  >
                    {tr('Clear')}
                  </Button>
                </div>
              </>
            )}
            <div className="list mt">
              {(inbox.data?.data ?? []).map((m: any) => (
                <details key={m.id} className="list-item" style={{ display: 'block' }}>
                  <summary>
                    <b>{m.eventType ?? '—'}</b> · {new Date(m.receivedAt).toLocaleString()}{' '}
                    <Chip kind={m.hmacValid ? 'success' : m.hmacValid === false ? 'danger' : undefined}>
                      {tr('HMAC')} {m.hmacValid ? '✓' : m.hmacValid === false ? '✗' : '–'}
                    </Chip>{' '}
                    <Chip kind={m.ed25519Valid ? 'success' : m.ed25519Valid === false ? 'danger' : undefined}>Ed25519 {m.ed25519Valid ? '✓' : m.ed25519Valid === false ? '✗' : '–'}</Chip>
                  </summary>
                  <pre className="mono tiny" style={{ whiteSpace: 'pre-wrap' }}>
                    {Object.entries(m.headers ?? {})
                      .map(([k, v]) => `${k}: ${v}`)
                      .join('\n')}
                  </pre>
                  <pre className="mono tiny" style={{ whiteSpace: 'pre-wrap' }}>
                    {m.body}
                  </pre>
                </details>
              ))}
            </div>
            {inbox.data && inbox.data.data?.length === 0 && <Empty icon="📥" text={tr('No delivery received yet')} />}
          </div>
          <div className="card">
            <h3>{tr('Deliveries')}</h3>
            {deliveries.error && <Alert kind="error">{deliveries.error}</Alert>}
            {(deliveries.data?.data ?? deliveries.data?.items ?? []).length === 0 && <Empty icon="📬" text={tr('No deliveries yet')} />}
            <div className="list">
              {(deliveries.data?.data ?? deliveries.data?.items ?? []).map((d: any) => (
                <div key={d.id} className="list-item">
                  <div className="flex1">
                    <div className="main-text">{d.type ?? d.eventType}</div>
                    <div className="sub-text">
                      {d.url} · {tr('attempt')} {d.attempts ?? d.attempt} · {d.lastStatus ?? d.statusCode ?? ''} · {new Date(d.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <StatusBadge status={d.status ?? (d.success ? 'succeeded' : d.dead ? 'dead' : 'pending')} />
                  {!d.success && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        api
                          .post(`/api/v1/webhook_deliveries/${d.id}/replay`, {})
                          .then(() => {
                            toast(tr('Replayed'), 'success');
                            deliveries.reload();
                          })
                          .catch(err)
                      }
                    >
                      {tr('Replay')}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {tab === 'settlement' && <InstitutionSettlementAccount />}
      {tab === 'events' && (
        <div className="card">
          <h3>{tr('Events')}</h3>
          <div className="list">
            {(events.data?.data ?? []).map((e: any) => (
              <div key={e.id} className="list-item">
                <div className="flex1">
                  <div className="main-text">{e.type}</div>
                  <div className="sub-text mono">
                    {e.id} · {new Date(e.createdAt).toLocaleString()}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    api
                      .post(`/api/v1/events/${e.id}/replay`, {})
                      .then(() => toast(tr('Replayed to every endpoint'), 'success'))
                      .catch(err)
                  }
                >
                  {tr('Replay')}
                </Button>
              </div>
            ))}
          </div>
          {events.data?.data?.length === 0 && <Empty icon="⚡" text={tr('No events yet')} />}
        </div>
      )}
      {tab === 'sandbox' && (
        <div className="card">
          <h3>{tr('Sandbox')}</h3>
          <p className="small muted">Test keys drive the real intent and attempt state machine against the simulator. These numbers force outcomes:</p>
          {(sandbox.data?.magic ?? sandbox.data?.outcomes ?? []).map((m: any) => (
            <KV key={m.msisdn ?? m.value} k={<span className="mono">{m.msisdn ?? m.value}</span>} v={m.outcome ?? m.description} />
          ))}
          {sandbox.data && !sandbox.data.magic && !sandbox.data.outcomes && (
            <pre className="mono tiny" style={{ whiteSpace: 'pre-wrap' }}>
              {JSON.stringify(sandbox.data, null, 2)}
            </pre>
          )}
        </div>
      )}
      {tab === 'docs' && <Docs />}
    </div>
  );
}

const NODE = `import { BitriPay } from '@bitripay/sdk';
const bp = new BitriPay({ apiKey: process.env.BITRIPAY_SECRET_KEY });
const intent = await bp.paymentIntents.create({ amount_minor: 2500, currency: 'USD', reference: 'ORDER-1001' }, { idempotencyKey: 'order-1001' });
console.log(intent.checkout_url, intent.qr_payload);
// webhooks
app.post('/webhooks', express.raw({ type: '*/*' }), (req, res) => {
  const event = bp.webhooks.verify(req.body, req.headers['bitripay-signature'], process.env.BITRIPAY_WEBHOOK_SECRET);
  res.sendStatus(200);
});`;
const PHP = `$bp = new BitriPay\\Client(getenv('BITRIPAY_SECRET_KEY'));
$intent = $bp->paymentIntents->create(['amount_minor' => 2500, 'currency' => 'USD', 'reference' => 'ORDER-1001'], 'order-1001');
$event = BitriPay\\Webhook::verify(file_get_contents('php://input'), $_SERVER['HTTP_BITRIPAY_SIGNATURE'], getenv('BITRIPAY_WEBHOOK_SECRET'));`;
const PY = `from bitripay import BitriPay, Webhook
bp = BitriPay(api_key=os.environ["BITRIPAY_SECRET_KEY"])
intent = bp.payment_intents.create({"amount_minor": 2500, "currency": "USD", "reference": "ORDER-1001"}, idempotency_key="order-1001")
event = Webhook.verify(request.data, request.headers["BitriPay-Signature"], os.environ["BITRIPAY_WEBHOOK_SECRET"])`;
const CURL = `curl -X POST https://api.bitripay.com/v1/payment_intents \\
  -H "Authorization: Bearer sk_test_..." -H "Idempotency-Key: order-1001" \\
  -H "Content-Type: application/json" \\
  -d '{"amount_minor":2500,"currency":"USD","reference":"ORDER-1001"}'`;
const PLATFORM = `# 1. Create your customer's account (returns acct_…; they get a claim link to own it)
curl -X POST https://api.bitripay.com/v1/accounts -H "Authorization: Bearer sk_live_..." -H "Content-Type: application/json" \\
  -d '{"business_name":"Pharmacie Lumière","type":"merchant","email":"owner@pharmacie.example","country":"CD","application_fee_bps":150}'

# 2. Any operation for that customer: your key + the account header (their money, your fee)
curl -X POST https://api.bitripay.com/v1/payment_intents -H "Authorization: Bearer sk_live_..." -H "BitriPay-Account: acct_..." \\
  -H "Idempotency-Key: inv-88" -H "Content-Type: application/json" \\
  -d '{"amount_minor":250000,"currency":"CDF","description":"Invoice 88","application_fee_minor":3750}'

# 3. Hand over: a one-time claim link (7 days) for the customer to set a password
curl -X POST https://api.bitripay.com/v1/accounts/acct_.../account_links -H "Authorization: Bearer sk_live_..."`;
function Docs() {
  const [lang, setLang] = useState<'node' | 'php' | 'python' | 'curl'>('node');
  const code = { node: NODE, php: PHP, python: PY, curl: CURL }[lang];
  const errors = [
    ['BP-1xxx', 'authentication & authorisation (invalid key, scope, step-up required)'],
    ['BP-2xxx', 'validation (idempotency key reused, malformed body)'],
    ['BP-3xxx', 'ledger (insufficient funds, limits, frozen)'],
    ['BP-4xxx', 'rails (connector unavailable, degraded mode)'],
    ['BP-5xxx', 'compliance (risk block, KYC tier, KYB, cooling-off)'],
    ['BP-6xxx', 'intelligence & ACU (rate limited, margin protection, quota)'],
  ];
  return (
    <div className="grid cols-2">
      <div className="card">
        <h3>{tr('Installing BitriPay for your clients')}</h3>
        <p className="small muted">
          {tr(
            "BitriPay holds the aggregator licence; you integrate it into your clients' shops, apps and billing systems. Each client is the merchant of record: their money settles to their own settlement profile and their statements are theirs. You never hold their funds and never need their password.",
          )}
        </p>
        <ol className="small">
          <li>
            {tr('The client opens a merchant account (')}
            <Link to="/register?role=merchant">register</Link>, or you register it with their details and they take ownership by signing in).
          </li>
          <li>
            The client adds you under <b>{tr('Command centre → Team')}</b> with the <b>developer</b> role: API keys, webhooks and payment creation, nothing on settlement or exports.
          </li>
          <li>{tr('Pick the client in the workspace selector at the top; the keys and webhooks you create here belong to that client.')}</li>
          <li>
            Integrate with the hosted checkout, the embedded widget (publishable key), the WooCommerce or Shopify plugin, or the SDKs below. Use a <b>test</b> key and the sandbox magic numbers until
            the client is verified.
          </li>
          <li>{tr('Hand over: the client can revoke your membership at any time; the keys stay theirs and keep working.')}</li>
        </ol>
        <p className="small muted">
          Your own account can also hold a merchant organisation for products you sell yourself. Register it as a <Link to="/register?role=developer">developer account</Link>.
        </p>
      </div>
      <div className="card">
        <h3>{tr('Connected accounts: onboard your customers by API')}</h3>
        <p className="small muted">
          For platforms, marketplaces, billing systems and integrators with many customers. Create each customer's merchant account with one call, take their payments with your own key and the{' '}
          <code>{tr('BitriPay-Account')}</code> header (every v1 operation), keep an application fee (a transparent split paid at capture), receive their events on your webhooks with{' '}
          <code>account</code>, and hand the account over with a claim link. The customer is the merchant of record; BitriPay holds the aggregator licence. Scopes: <code>accounts:write</code>,{' '}
          <code>accounts:read</code>.
        </p>
        <pre className="code">{PLATFORM}</pre>
      </div>
      <div className="card">
        <h3>{tr('Quick start')}</h3>
        <ol className="small">
          <li>
            Create a <b>test</b> secret key under API keys.
          </li>
          <li>{tr('Create a payment intent (amount in minor units) — you get a hosted checkout URL and a BitriQR payload.')}</li>
          <li>{tr('Show the QR or redirect to the checkout; the customer pays over the eligible rail Smart Route picks.')}</li>
          <li>
            Listen to <code>payment_intent.succeeded</code> (verify both signatures), then <code>payment_intent.settled</code>.
          </li>
          <li>
            Refund, verify (KODA), pay out and reconcile with the same key. Switch to a <b>live</b> key when you go live.
          </li>
        </ol>
        <div className="row wrap mb">
          {(['node', 'php', 'python', 'curl'] as const).map((l) => (
            <Chip key={l} kind={lang === l ? 'primary' : undefined} onClick={() => setLang(l)}>
              {l}
            </Chip>
          ))}
        </div>
        <pre className="mono tiny card soft compact" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {code}
        </pre>
        <div className="row">
          <a className="btn secondary" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">
            {tr('OpenAPI 3.1')}
          </a>
          <a className="btn ghost" href="/api/v1/keys" target="_blank" rel="noreferrer">
            {tr('Key registry')}
          </a>
          <a className="btn ghost" href="/api/v1/status" target="_blank" rel="noreferrer">
            {tr('Status')}
          </a>
        </div>
      </div>
      <div className="card">
        <h3>{tr('Error catalogue')}</h3>
        {errors.map(([k, v]) => (
          <KV key={k} k={<span className="mono">{k}</span>} v={v} />
        ))}
        <p className="small muted mt">
          {tr('Every error body is')} <code>{'{ error: { code, bp, message, details } }'}</code>. Idempotency: send <code>{tr('Idempotency-Key')}</code> on every money-moving POST; a replay returns
          the same object (200), a reuse with a different body is refused (422).
        </p>
        <h3 className="mt">{tr('Signatures and tokens')}</h3>
        <p className="small">
          {tr('HTTP semantics, status codes and idempotent methods follow')} <b>{tr('RFC 9110')}</b>; bearer tokens are JSON Web Tokens (<b>{tr('RFC 7519')}</b>) carrying the key's scopes and tenant;
          webhook and QR signatures use Ed25519 (<b>{tr('RFC 8032')}</b>) with the platform public key published at <code>/v1/keys</code> and your merchant key in the BitriQR registry. Verify both
          webhook signatures; never trust a redirect or a success screen as proof of payment – wait for <code>payment_intent.settled</code>.
        </p>
        <h3 className="mt">{tr('Objects')}</h3>
        <p className="small">
          payment_intents · checkout_sessions · payment_links · qr_codes · locations · refunds · verifications · payouts · balance · webhook_endpoints · events · settlement_profiles ·
          settlement_cycles · disputes · offline · diaspora · payments (national switch)
        </p>
        <p className="tiny muted">
          <b>payments</b> (national switch, DRC): domestic interoperability payments are routed through the Switch Monétique National under <b>{tr('Instruction n°58')}</b> of the Banque Centrale du
          Congo. BitriPay initiates, orchestrates, normalises and reports; licensed institutions hold and settle the funds. Track them under{' '}
          <Link to="/app/merchant/switch">{tr('National switch')}</Link>.
        </p>
      </div>
    </div>
  );
}
export { qs };
