import { useState } from 'react';
import { Link } from 'react-router-dom';
import QRCode from 'qrcode';
import { api, qs, API_BASE } from '../lib/api';
import { useStore } from '../lib/store';
import { useT, tr } from '../lib/i18n';
import { Alert, Button, Chip, Empty, Field, Input, KV, Modal, PageHeader, QrImage, Select, StatusBadge, Tabs, useAsync } from '../components/ui';
import { offlineDevice } from '../lib/offline';
import { isMerchantClass, currencyFlag } from '@bitripay/shared';

/** The scannable content of a code, whichever view produced it (static code, dynamic intent, offline promise). */
const payloadOf = (q: any): string => String(q.payload ?? q.qrPayload ?? q.uri ?? '');
function saveBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const fileStem = (q: any) => `bitripay-qr-${String(q.code ?? q.id ?? 'code').replace(/[^A-Za-z0-9_-]/g, '')}`;
/** PNG rendered from the same encoder the on-screen image uses; SVG from the API's image route; payload as text. */
async function downloadPng(q: any) {
  const dataUrl = await QRCode.toDataURL(payloadOf(q), { margin: 2, width: 1024, errorCorrectionLevel: 'M', color: { dark: '#0f172a', light: '#ffffff' } });
  saveBlob(`${fileStem(q)}.png`, await (await fetch(dataUrl)).blob());
}
async function downloadSvg(q: any) {
  const r = await fetch(`${API_BASE}/api/qr/image.svg?data=${encodeURIComponent(payloadOf(q))}`);
  if (!r.ok) throw new Error(`Image route returned ${r.status}`);
  saveBlob(`${fileStem(q)}.svg`, new Blob([await r.text()], { type: 'image/svg+xml' }));
}
function downloadPayload(q: any) {
  saveBlob(`${fileStem(q)}.txt`, new Blob([payloadOf(q)], { type: 'text/plain' }));
}
function DownloadButtons({ q, err, size }: { q: any; err: (e: any) => void; size?: 'sm' }) {
  const t = useT();
  return (
    <>
      <Button size={size} variant="ghost" onClick={() => downloadPng(q).catch(err)} title="PNG">
        {t('qr.downloadPng')}
      </Button>
      <Button size={size} variant="ghost" onClick={() => downloadSvg(q).catch(err)} title={tr('SVG from /api/qr/image.svg')}>
        {t('qr.downloadSvg')}
      </Button>
      <Button size={size} variant="ghost" onClick={() => downloadPayload(q)} title={tr('Payload as text')}>
        {t('qr.downloadPayload')}
      </Button>
    </>
  );
}

/**
 * QR centre: locations and terminals, static / dynamic / offline codes, analytics, revocation, printable sheets,
 * and Diaspora-Direct institution codes for purpose-locked payments from abroad.
 */
export function QrCentre() {
  const { user, config, toast, wallets } = useStore();
  const t = useT();
  const [tab, setTab] = useState<'codes' | 'locations' | 'analytics' | 'institution'>('codes');
  const codes = useAsync(() => api.get<any>('/api/v1/qr_codes'), [tab]);
  const locations = useAsync(() => api.get<any>('/api/v1/locations'), [tab]);
  const analytics = useAsync(() => (tab === 'analytics' ? api.get<any>('/api/v1/qr_codes/analytics') : Promise.resolve(null)), [tab]);
  const purposes = useAsync(() => api.get<any>('/api/v1/diaspora/rate-cards'), []);
  /** Merchant gateway settings carry the optional QR floor/ceiling (`qrMinAmountMinor` / `qrMaxAmountMinor`) the API enforces. */
  const gateway = useAsync(() => api.get<any>('/api/merchant/gateway').catch(() => null), []);
  // Amount rules mirrored from the service: a code can only be denominated in a currency the merchant can receive
  // (a wallet currency); dynamic codes need an amount > 0; static codes carry none (the payer enters it).
  const walletCurrencies = Array.from(new Set(wallets.map((w) => w.currency)));
  const currencyOptions = walletCurrencies.length ? walletCurrencies : (config?.currencies ?? []).map((c) => c.code);
  const rules = { currencies: walletCurrencies, min: gateway.data?.settings?.qrMinAmountMinor ?? null, max: gateway.data?.settings?.qrMaxAmountMinor ?? null };
  const [form, setForm] = useState<any>({
    mode: 'static',
    currency: currencyOptions[0] ?? config?.baseCurrency ?? 'USD',
    kind: 'merchant',
    purpose_code: '',
    reference: '',
    amount: '',
    location_id: '',
    sign: true,
  });
  const [offline, setOffline] = useState<any>({ amount: '', currency: config?.baseCurrency ?? 'USD', reference: '' });
  const [shown, setShown] = useState<any>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const decimalsOf = (code: string) => (config?.currencies ?? []).find((c) => c.code === code)?.decimals ?? 2;
  const minorToText = (minor: number, code: string) => `${(minor / 10 ** decimalsOf(code)).toFixed(decimalsOf(code))} ${code}`;
  /** The API's amount-rule error codes, shown in the user's language. */
  const localised = (e: any): string => {
    const range = t('qr.amountRange', { min: rules.min ? minorToText(rules.min, form.currency) : '0', max: rules.max ? minorToText(rules.max, form.currency) : '∞' });
    const map: Record<string, string> = { amount_required: t('qr.amountRequired'), currency_not_receivable: t('qr.currencyNotReceivable'), amount_below_minimum: range, amount_above_maximum: range };
    return map[e?.code] ?? e?.message ?? String(e);
  };
  const err = (e: any) => toast(localised(e), 'error');
  if (!isMerchantClass(user?.role) && user?.role !== 'admin')
    return (
      <Alert kind="info">
        {tr('The QR centre is for merchant accounts.')} <Link to="/app/merchant">{tr('Upgrade')}</Link> or use <Link to="/app/receive">{tr('Receive')}</Link> for personal codes.
      </Alert>
    );
  /** Client-side check of the same rules the service applies; returns the message to show or null when the form may be sent. */
  const amountProblem = (): string | null => {
    const amountMinor = form.amount ? Math.round(parseFloat(form.amount) * 10 ** decimalsOf(form.currency)) : null;
    if (rules.currencies.length && !rules.currencies.includes(form.currency)) return t('qr.currencyNotReceivable');
    if (form.mode === 'dynamic' && (amountMinor == null || !(amountMinor > 0))) return t('qr.amountRequired');
    if (amountMinor != null && ((rules.min && amountMinor < rules.min) || (rules.max && amountMinor > rules.max)))
      return t('qr.amountRange', { min: rules.min ? minorToText(rules.min, form.currency) : '0', max: rules.max ? minorToText(rules.max, form.currency) : '∞' });
    return null;
  };
  const create = () => {
    const problem = amountProblem();
    setFormError(problem);
    if (problem) return toast(problem, 'error');
    const amountMinor = form.amount ? Math.round(parseFloat(form.amount) * 10 ** decimalsOf(form.currency)) : null;
    if (form.mode === 'dynamic') {
      // a dynamic code is a payment intent with an amount: single use, expires, one QR per sale
      api
        .post<any>('/api/v1/payment_intents', {
          amount_minor: amountMinor,
          currency: form.currency,
          reference: form.reference || null,
          purpose_code: form.purpose_code || null,
          location_id: form.location_id || null,
        })
        .then((intent) => {
          setShown({
            ...intent,
            mode: 'DYNAMIC',
            code: intent.id,
            payload: intent.qrPayload ?? intent.uri,
            amount: intent.amount?.valueMinor ?? null,
            currency: intent.amount?.currency ?? form.currency,
            reference: intent.reference ?? form.reference ?? null,
          });
          codes.reload();
          toast(tr('Dynamic code created'), 'success');
        })
        .catch((e) => {
          setFormError(localised(e));
          err(e);
        });
      return;
    }
    const body: any = { currency: form.currency, kind: form.kind, sign: form.sign, purpose_code: form.purpose_code || null, reference: form.reference || null, location_id: form.location_id || null };
    api
      .post<any>('/api/v1/qr_codes', body)
      .then((q) => {
        setShown(q);
        codes.reload();
        toast(tr('Code created'), 'success');
      })
      .catch((e) => {
        setFormError(localised(e));
        err(e);
      });
  };
  const offlineCode = async () => {
    try {
      const amountMinor = Math.round(parseFloat(offline.amount) * 100);
      if (navigator.onLine) {
        const q = await api.post<any>('/api/v1/offline/qr', { amount_minor: amountMinor, currency: offline.currency, reference: offline.reference || null });
        setShown({ ...q, mode: 'OFFLINE', qrPayload: q.payload, uri: null });
      } else {
        const q = await offlineDevice.localOfflineQr({
          merchantCode: user!.tag,
          merchantName: user!.businessName || user!.fullName,
          country: user!.country ?? 'CD',
          currency: offline.currency,
          amount: offline.amount,
          reference: offline.reference || null,
        });
        setShown({ ...q, mode: 'OFFLINE', qrPayload: q.payload, uri: null, local: true });
      }
    } catch (e) {
      err(e);
    }
  };
  return (
    <div>
      <PageHeader
        title={tr('QR centre')}
        subtitle={tr('One code, every eligible rail. Static for the counter, dynamic per sale, offline when the network is down.')}
        actions={
          <Link className="btn secondary" to="/app/merchant/centre">
            {tr('← Command centre')}
          </Link>
        }
      />
      <Tabs
        tabs={[
          { id: 'codes', label: tr('Codes') },
          { id: 'locations', label: tr('Locations & terminals') },
          { id: 'analytics', label: tr('Analytics') },
          { id: 'institution', label: tr('Diaspora-Direct') },
        ]}
        value={tab}
        onChange={(v) => setTab(v as any)}
      />
      {tab === 'codes' && (
        <div className="grid cols-3">
          <div className="card">
            <h3>{tr('New code')}</h3>
            <div className="grid cols-2">
              <Field label={tr('Mode')} hint={form.mode === 'dynamic' ? tr('One sale, one code: carries the amount and expires.') : tr('Printed at the counter: the payer enters the amount.')}>
                <Select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value, amount: e.target.value === 'static' ? '' : form.amount })}>
                  <option value="static">{tr('Static')}</option>
                  <option value="dynamic">{tr('Dynamic (fixed amount)')}</option>
                </Select>
              </Field>
              <Field label={tr('Currency')} hint={walletCurrencies.length ? `Your wallets: ${walletCurrencies.join(', ')}` : undefined}>
                <Select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                  {currencyOptions.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
              </Field>
              <Field label={tr('Kind')}>
                <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                  {['merchant', 'invoice', 'agent', 'institution', 'mandate'].map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </Select>
              </Field>
              {form.mode === 'dynamic' ? (
                <Field
                  label={`Amount (${form.currency})`}
                  hint={
                    rules.min || rules.max
                      ? t('qr.amountRange', { min: rules.min ? minorToText(rules.min, form.currency) : '0', max: rules.max ? minorToText(rules.max, form.currency) : '∞' })
                      : undefined
                  }
                >
                  <Input inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value.replace(/[^\d.]/g, '') })} placeholder="0.00" />
                </Field>
              ) : (
                <Field label={tr('Amount')}>
                  <Input value="" disabled placeholder="payer enters the amount" />
                </Field>
              )}
              <Field label={tr('Purpose')}>
                <Select value={form.purpose_code} onChange={(e) => setForm({ ...form, purpose_code: e.target.value })}>
                  <option value="">{tr('General')}</option>
                  {(purposes.data?.purposes ?? []).map((p: any) => (
                    <option key={p.code} value={p.code}>
                      {p.code}
                      {p.restricted ? ' (institutions)' : ''}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label={tr('Reference / label')}>
              <Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder="TILL-1" />
            </Field>
            <Field label={tr('Location')}>
              <Select value={form.location_id} onChange={(e) => setForm({ ...form, location_id: e.target.value })}>
                <option value="">{tr('None')}</option>
                {(locations.data?.data ?? []).map((l: any) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
            {form.mode === 'static' && (
              <label className="checkbox mb">
                <input type="checkbox" checked={form.sign} onChange={(e) => setForm({ ...form, sign: e.target.checked })} /> {tr('Sign with my merchant key (recommended)')}
              </label>
            )}
            {formError && <Alert kind="error">{formError}</Alert>}
            <Button onClick={create} disabled={form.mode === 'dynamic' && !form.amount}>
              {tr('Create {0} code', { 0: form.mode })}
            </Button>
            <h3 className="mt">{tr('Offline code')}</h3>
            <p className="small muted">{tr("Works with or without signal. The customer's phone signs a promise; the money is confirmed when either of you is back online.")}</p>
            <div className="grid cols-2">
              <Field label={tr('Amount')}>
                <Input value={offline.amount} onChange={(e) => setOffline({ ...offline, amount: e.target.value })} />
              </Field>
              <Field label={tr('Currency')}>
                <Select value={offline.currency} onChange={(e) => setOffline({ ...offline, currency: e.target.value })}>
                  {(config?.currencies ?? []).map((c) => (
                    <option key={c.code} value={c.code}>
                      {currencyFlag(c.code)} {c.code}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label={tr('Reference')}>
              <Input value={offline.reference} onChange={(e) => setOffline({ ...offline, reference: e.target.value })} />
            </Field>
            <Button variant="secondary" onClick={offlineCode} disabled={!offline.amount}>
              {tr('Show offline code')} {navigator.onLine ? '' : '(signed on this device)'}
            </Button>
          </div>
          <div className="card" style={{ gridColumn: 'span 2' }}>
            <h3>{tr('My codes')}</h3>
            {(codes.data?.data ?? []).length === 0 && <Empty icon="🔳" text={tr('No codes yet')} />}
            <div className="list">
              {(codes.data?.data ?? []).map((q: any) => (
                <div key={q.id} className="list-item">
                  <div className="flex1">
                    <div className="main-text">
                      {q.mode} · {q.currency}
                      {q.amount ? ` · ${q.amount / 100}` : ''} · {q.kind}
                      {q.purposeCode ? ` · ${q.purposeCode}` : ''}
                      {q.corridorFlag ? ` · ${q.corridorFlag}` : ''}
                    </div>
                    <div className="sub-text mono">
                      {q.code ?? q.id}
                      {q.reference ? ` · ${q.reference}` : ''}
                      {q.signed ? ' · signed' : ''}
                      {q.expiresAt ? ` · expires ${new Date(q.expiresAt).toLocaleString()}` : ''}
                    </div>
                  </div>
                  <StatusBadge status={q.status} />
                  <div className="row wrap">
                    <Button size="sm" variant="secondary" onClick={() => setShown(q)}>
                      {tr('Show')}
                    </Button>
                    <DownloadButtons q={q} err={err} size="sm" />
                    {q.status === 'active' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          api
                            .post(`/api/v1/qr_codes/${q.id}/revoke`, { reason: 'replaced' })
                            .then(() => {
                              codes.reload();
                              toast(tr('Code revoked'), 'success');
                            })
                            .catch(err)
                        }
                      >
                        {tr('Revoke')}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {tab === 'locations' && <Locations locations={locations} toast={toast} err={err} />}
      {tab === 'analytics' && (
        <div className="grid cols-3">
          {analytics.data &&
            Object.entries(analytics.data)
              .filter(([, v]) => typeof v === 'number')
              .map(([k, v]) => (
                <div className="card" key={k}>
                  <div className="stat">
                    <span className="label">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
                    <span className="value">{String(v)}</span>
                  </div>
                </div>
              ))}
          {Array.isArray(analytics.data?.byDay) && (
            <div className="card" style={{ gridColumn: 'span 3' }}>
              <h3>{tr('Scans by day')}</h3>
              <p className="tiny muted">{tr('Last {0} days · scans and paid codes per day (days without activity are shown as zero).', { 0: analytics.data.days })}</p>
              <div className="row" style={{ alignItems: 'flex-end', height: 140, gap: 4 }}>
                {analytics.data.byDay.map((d: any) => {
                  const peak = Math.max(1, ...analytics.data.byDay.map((x: any) => x.scans));
                  return (
                    <div
                      key={d.day}
                      title={`${d.day}: ${d.scans} scans · ${d.paid} paid`}
                      style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%', gap: 2 }}
                    >
                      <div style={{ background: 'var(--primary)', height: `${(d.scans / peak) * 100}%`, minHeight: d.scans ? 3 : 0, borderRadius: 4 }} />
                      <div style={{ background: 'var(--success)', height: `${(d.paid / peak) * 100}%`, minHeight: d.paid ? 3 : 0, borderRadius: 4 }} />
                    </div>
                  );
                })}
              </div>
              <div className="table-wrap mt">
                <table data-testid="qr-by-day">
                  <thead>
                    <tr>
                      <th>{tr('Day')}</th>
                      <th className="right">{tr('Scans')}</th>
                      <th className="right">{tr('Paid')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analytics.data.byDay
                      .slice()
                      .reverse()
                      .map((d: any) => (
                        <tr key={d.day}>
                          <td className="mono">{d.day}</td>
                          <td className="right">{d.scans}</td>
                          <td className="right">{d.paid}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {Array.isArray(analytics.data?.byOutcome) && (
            <div className="card" style={{ gridColumn: 'span 3' }} data-testid="qr-by-outcome">
              <h3>{tr('Outcomes')}</h3>
              {analytics.data.byOutcome.length === 0 && <Empty icon="📈" text={tr('No scans in this window yet')} />}
              {analytics.data.byOutcome.map((o: any) => (
                <KV key={o.outcome} k={String(o.outcome).replace(/_/g, ' ')} v={String(o.count)} />
              ))}
            </div>
          )}
          {analytics.data?.byLocation?.length > 0 && (
            <div className="card" style={{ gridColumn: 'span 3' }}>
              <h3>{tr('By location')}</h3>
              {analytics.data.byLocation.map((l: any, i: number) => (
                <KV key={`${l.name}-${i}`} k={l.name} v={String(l.scans)} />
              ))}
            </div>
          )}
        </div>
      )}
      {tab === 'institution' && <Institution toast={toast} err={err} purposes={purposes.data?.purposes ?? []} currencies={(config?.currencies ?? []).map((c) => c.code)} />}
      <Modal open={!!shown} onClose={() => setShown(null)} title={shown?.mode === 'OFFLINE' ? tr('Offline code') : tr('Your code')}>
        {shown && (
          <div className="print-sheet" style={{ textAlign: 'center' }}>
            <div className="bold" style={{ fontSize: 18 }}>
              {user?.businessName || user?.fullName}
            </div>
            <QrImage value={shown.qrPayload ?? shown.uri ?? shown.payload} size={280} />
            {shown.amount ? (
              <div className="bold">
                {shown.amount / 100} {shown.currency}
              </div>
            ) : null}
            {shown.amountMinor ? (
              <div className="bold">
                {shown.amountMinor / 100} {shown.currency}
              </div>
            ) : null}
            {shown.reference && <div className="small muted">{shown.reference}</div>}
            {shown.mode === 'OFFLINE' && (
              <Alert kind="warning">
                {tr('Valid until')} {new Date(shown.expiresAt).toLocaleTimeString()}. The customer's app will confirm when back online{shown.local ? ' (signed on this device)' : ''}.
              </Alert>
            )}
            {shown.uri && (
              <div className="mono tiny" style={{ wordBreak: 'break-all' }}>
                {shown.uri}
              </div>
            )}
            <div className="row wrap mt" style={{ justifyContent: 'center' }}>
              <Button variant="secondary" onClick={() => window.print()}>
                {tr('Print')}
              </Button>
              <DownloadButtons q={shown} err={err} />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function Locations({ locations, toast, err }: { locations: any; toast: any; err: (e: any) => void }) {
  const [form, setForm] = useState({ name: '', address: '', city: '', mcc: '' });
  const [terminal, setTerminal] = useState<{ locationId: string; label: string } | null>(null);
  return (
    <div className="grid cols-2">
      <div className="card">
        <h3>{tr('New location')}</h3>
        <Field label={tr('Name')}>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={tr('Marché de la Liberté, stand 12')} />
        </Field>
        <div className="grid cols-2">
          <Field label={tr('Address')}>
            <Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </Field>
          <Field label={tr('City')}>
            <Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
          </Field>
        </div>
        <Field label="MCC">
          <Input value={form.mcc} onChange={(e) => setForm({ ...form, mcc: e.target.value })} placeholder="5411" />
        </Field>
        <Button
          onClick={() =>
            api
              .post('/api/v1/locations', { name: form.name, address: form.address || null, city: form.city || null, mcc: form.mcc || null })
              .then(() => {
                toast(tr('Location added'), 'success');
                locations.reload();
              })
              .catch(err)
          }
          disabled={form.name.length < 2}
        >
          {tr('Add location')}
        </Button>
      </div>
      <div className="card">
        <h3>{tr('Locations')}</h3>
        {(locations.data?.data ?? []).length === 0 && <Empty icon="📍" text={tr('No locations yet')} />}
        {(locations.data?.data ?? []).map((l: any) => (
          <div key={l.id} className="list-item">
            <div className="flex1">
              <div className="main-text">{l.name}</div>
              <div className="sub-text">
                {[l.address, l.city].filter(Boolean).join(', ')}
                {l.mcc ? ` · MCC ${l.mcc}` : ''} · {l.terminals?.length ?? 0} terminal(s)
              </div>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setTerminal({ locationId: l.id, label: '' })}>
              {tr('+ Terminal')}
            </Button>
          </div>
        ))}
        <Modal open={!!terminal} onClose={() => setTerminal(null)} title={tr('New terminal')}>
          <Field label={tr('Label')}>
            <Input value={terminal?.label ?? ''} onChange={(e) => setTerminal({ ...terminal!, label: e.target.value })} placeholder={tr('Till 1')} />
          </Field>
          <Button
            onClick={() =>
              api
                .post(`/api/v1/locations/${terminal!.locationId}/terminals`, { label: terminal!.label })
                .then(() => {
                  toast(tr('Terminal added'), 'success');
                  setTerminal(null);
                  locations.reload();
                })
                .catch(err)
            }
          >
            {tr('Add')}
          </Button>
        </Modal>
      </div>
    </div>
  );
}

function Institution({ toast, err, purposes, currencies }: { toast: any; err: (e: any) => void; purposes: any[]; currencies: string[] }) {
  const me = useAsync(() => api.get<any>('/api/v1/institutions/me'), []);
  const [form, setForm] = useState<any>({ kind: 'school', name: '', registryRef: '', purposeCodes: ['SCHOOL'] });
  const [qr, setQr] = useState<any>({ purposeCode: 'SCHOOL', currency: currencies.includes('CDF') ? 'CDF' : currencies[0], reference: '' });
  const [shown, setShown] = useState<any>(null);
  const restricted = purposes.filter((p) => p.restricted);
  return (
    <div className="grid cols-2">
      <div className="card">
        <h3>{tr('Institution registration')}</h3>
        <p className="small muted">
          {tr(
            'Schools, hospitals, utilities, landlords, government services and NGOs receive purpose-locked payments from the diaspora at a published rate. Verification by BitriPay is required before the first payment.',
          )}
        </p>
        {me.data && (
          <Alert kind={me.data.status === 'verified' ? 'success' : 'warning'}>
            {me.data.name} · {me.data.kind} · <b>{me.data.status}</b> · purposes {me.data.purposeCodes.join(', ')}
          </Alert>
        )}
        <div className="grid cols-2">
          <Field label={tr('Kind')}>
            <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {['school', 'hospital', 'utility', 'government', 'ngo', 'landlord', 'cooperative'].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </Select>
          </Field>
          <Field label={tr('Registry reference')}>
            <Input value={form.registryRef} onChange={(e) => setForm({ ...form, registryRef: e.target.value })} placeholder="MINEDUC-KIN-0042" />
          </Field>
        </div>
        <Field label={tr('Official name')}>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label={tr('Purposes')}>
          <div className="row wrap">
            {restricted.map((p) => (
              <Chip
                key={p.code}
                kind={form.purposeCodes.includes(p.code) ? 'primary' : undefined}
                onClick={() => setForm({ ...form, purposeCodes: form.purposeCodes.includes(p.code) ? form.purposeCodes.filter((c: string) => c !== p.code) : [...form.purposeCodes, p.code] })}
              >
                {p.code}
              </Chip>
            ))}
          </div>
        </Field>
        <Button
          onClick={() =>
            api
              .post('/api/v1/institutions', { kind: form.kind, name: form.name, registryRef: form.registryRef || null, purposeCodes: form.purposeCodes })
              .then(() => {
                toast(tr('Registration submitted'), 'success');
                me.reload();
              })
              .catch(err)
          }
          disabled={form.name.length < 2 || !form.purposeCodes.length}
        >
          {tr('Submit for verification')}
        </Button>
      </div>
      <div className="card">
        <h3>{tr('Diaspora-Direct code')}</h3>
        <p className="small muted">{tr('A “DD” flagged code your payers abroad scan; the app quotes at the published rate card and locks the payment to your purpose.')}</p>
        <div className="grid cols-2">
          <Field label={tr('Purpose')}>
            <Select value={qr.purposeCode} onChange={(e) => setQr({ ...qr, purposeCode: e.target.value })}>
              {(me.data?.purposeCodes ?? ['SCHOOL']).map((c: string) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Field label={tr('Currency')}>
            <Select value={qr.currency} onChange={(e) => setQr({ ...qr, currency: e.target.value })}>
              {currencies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={tr('Reference')}>
          <Input value={qr.reference} onChange={(e) => setQr({ ...qr, reference: e.target.value })} placeholder="FEES-2026-T1" />
        </Field>
        <Button
          onClick={() =>
            api
              .post<any>('/api/v1/institutions/me/qr', { purposeCode: qr.purposeCode, currency: qr.currency, reference: qr.reference || null })
              .then((q) => {
                setShown(q);
                toast(tr('Code issued'), 'success');
              })
              .catch(err)
          }
          disabled={me.data?.status !== 'verified'}
        >
          {tr('Issue DD code')}
        </Button>
        <Modal open={!!shown} onClose={() => setShown(null)} title={tr('Diaspora-Direct code')}>
          {shown && (
            <div style={{ textAlign: 'center' }}>
              <QrImage value={shown.qrPayload ?? shown.uri} size={280} />
              <div className="small muted">
                {shown.purposeCode} · {shown.currency} · DD
              </div>
              <div className="mono tiny" style={{ wordBreak: 'break-all' }}>
                {shown.uri}
              </div>
            </div>
          )}
        </Modal>
      </div>
    </div>
  );
}
export { qs };
