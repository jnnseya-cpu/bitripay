import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Chip, Empty, Field, Input, KV, Modal, PageHeader, QrImage, Select, StatusBadge, Tabs, useAsync } from '../components/ui';
import { offlineDevice } from '../lib/offline';

/**
 * QR centre: locations and terminals, static / dynamic / offline codes, analytics, revocation, printable sheets,
 * and Diaspora-Direct institution codes for purpose-locked payments from abroad.
 */
export function QrCentre() {
  const { user, config, toast } = useStore();
  const [tab, setTab] = useState<'codes' | 'locations' | 'analytics' | 'institution'>('codes');
  const codes = useAsync(() => api.get<any>('/api/v1/qr_codes'), [tab]);
  const locations = useAsync(() => api.get<any>('/api/v1/locations'), [tab]);
  const analytics = useAsync(() => (tab === 'analytics' ? api.get<any>('/api/v1/qr_codes/analytics') : Promise.resolve(null)), [tab]);
  const purposes = useAsync(() => api.get<any>('/api/v1/diaspora/rate-cards'), []);
  const [form, setForm] = useState<any>({ currency: config?.baseCurrency ?? 'USD', kind: 'merchant', purpose_code: '', reference: '', amount: '', location_id: '', sign: true });
  const [offline, setOffline] = useState<any>({ amount: '', currency: config?.baseCurrency ?? 'USD', reference: '' });
  const [shown, setShown] = useState<any>(null);
  const err = (e: any) => toast(e.message, 'error');
  if (user?.role !== 'merchant' && user?.role !== 'admin') return <Alert kind="info">The QR centre is for merchant accounts. <Link to="/app/merchant">Upgrade</Link> or use <Link to="/app/receive">Receive</Link> for personal codes.</Alert>;
  const create = () => {
    const body: any = { currency: form.currency, kind: form.kind, sign: form.sign, purpose_code: form.purpose_code || null, reference: form.reference || null, location_id: form.location_id || null };
    if (form.amount) body.amount_minor = Math.round(parseFloat(form.amount) * 100);
    api.post<any>('/api/v1/qr_codes', body).then((q) => { setShown(q); codes.reload(); toast('Code created', 'success'); }).catch(err);
  };
  const offlineCode = async () => {
    try {
      const amountMinor = Math.round(parseFloat(offline.amount) * 100);
      if (navigator.onLine) {
        const q = await api.post<any>('/api/v1/offline/qr', { amount_minor: amountMinor, currency: offline.currency, reference: offline.reference || null });
        setShown({ ...q, mode: 'OFFLINE', qrPayload: q.payload, uri: null });
      } else {
        const q = await offlineDevice.localOfflineQr({ merchantCode: user!.tag, merchantName: user!.businessName || user!.fullName, country: user!.country ?? 'CD', currency: offline.currency, amount: offline.amount, reference: offline.reference || null });
        setShown({ ...q, mode: 'OFFLINE', qrPayload: q.payload, uri: null, local: true });
      }
    } catch (e) {
      err(e);
    }
  };
  return (
    <div>
      <PageHeader title="QR centre" subtitle="One code, every eligible rail. Static for the counter, dynamic per sale, offline when the network is down." actions={<Link className="btn secondary" to="/app/merchant/centre">← Command centre</Link>} />
      <Tabs tabs={[{ id: 'codes', label: 'Codes' }, { id: 'locations', label: 'Locations & terminals' }, { id: 'analytics', label: 'Analytics' }, { id: 'institution', label: 'Diaspora-Direct' }]} value={tab} onChange={(v) => setTab(v as any)} />
      {tab === 'codes' && (
        <div className="grid cols-3">
          <div className="card">
            <h3>New static code</h3>
            <div className="grid cols-2">
              <Field label="Currency"><Select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>{(config?.currencies ?? []).map((c) => <option key={c.code}>{c.code}</option>)}</Select></Field>
              <Field label="Kind"><Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{['merchant', 'invoice', 'agent', 'institution', 'mandate'].map((k) => <option key={k}>{k}</option>)}</Select></Field>
              <Field label="Fixed amount (optional)"><Input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="leave empty: payer enters" /></Field>
              <Field label="Purpose"><Select value={form.purpose_code} onChange={(e) => setForm({ ...form, purpose_code: e.target.value })}><option value="">General</option>{(purposes.data?.purposes ?? []).map((p: any) => <option key={p.code} value={p.code}>{p.code}{p.restricted ? ' (institutions)' : ''}</option>)}</Select></Field>
            </div>
            <Field label="Reference / label"><Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder="TILL-1" /></Field>
            <Field label="Location"><Select value={form.location_id} onChange={(e) => setForm({ ...form, location_id: e.target.value })}><option value="">None</option>{(locations.data?.data ?? []).map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
            <label className="checkbox mb"><input type="checkbox" checked={form.sign} onChange={(e) => setForm({ ...form, sign: e.target.checked })} /> Sign with my merchant key (recommended)</label>
            <Button onClick={create}>Create code</Button>
            <h3 className="mt">Offline code</h3>
            <p className="small muted">Works with or without signal. The customer's phone signs a promise; the money is confirmed when either of you is back online.</p>
            <div className="grid cols-2"><Field label="Amount"><Input value={offline.amount} onChange={(e) => setOffline({ ...offline, amount: e.target.value })} /></Field><Field label="Currency"><Select value={offline.currency} onChange={(e) => setOffline({ ...offline, currency: e.target.value })}>{(config?.currencies ?? []).map((c) => <option key={c.code}>{c.code}</option>)}</Select></Field></div>
            <Field label="Reference"><Input value={offline.reference} onChange={(e) => setOffline({ ...offline, reference: e.target.value })} /></Field>
            <Button variant="secondary" onClick={offlineCode} disabled={!offline.amount}>Show offline code {navigator.onLine ? '' : '(signed on this device)'}</Button>
          </div>
          <div className="card" style={{ gridColumn: 'span 2' }}>
            <h3>My codes</h3>
            {(codes.data?.data ?? []).length === 0 && <Empty icon="🔳" text="No codes yet" />}
            <div className="list">
              {(codes.data?.data ?? []).map((q: any) => (
                <div key={q.id} className="list-item">
                  <div className="flex1"><div className="main-text">{q.mode} · {q.currency}{q.amount ? ` · ${q.amount / 100}` : ''} · {q.kind}{q.purposeCode ? ` · ${q.purposeCode}` : ''}{q.corridorFlag ? ` · ${q.corridorFlag}` : ''}</div><div className="sub-text mono">{q.code ?? q.id}{q.reference ? ` · ${q.reference}` : ''}{q.signed ? ' · signed' : ''}{q.expiresAt ? ` · expires ${new Date(q.expiresAt).toLocaleString()}` : ''}</div></div>
                  <StatusBadge status={q.status} />
                  <div className="row"><Button size="sm" variant="secondary" onClick={() => setShown(q)}>Show</Button>{q.status === 'active' && <Button size="sm" variant="ghost" onClick={() => api.post(`/api/v1/qr_codes/${q.id}/revoke`, { reason: 'replaced' }).then(() => { codes.reload(); toast('Code revoked', 'success'); }).catch(err)}>Revoke</Button>}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {tab === 'locations' && <Locations locations={locations} toast={toast} err={err} />}
      {tab === 'analytics' && (
        <div className="grid cols-3">
          {analytics.data && Object.entries(analytics.data).filter(([, v]) => typeof v === 'number').map(([k, v]) => <div className="card" key={k}><div className="stat"><span className="label">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</span><span className="value">{String(v)}</span></div></div>)}
          {analytics.data?.byDay && <div className="card" style={{ gridColumn: 'span 3' }}><h3>Scans by day</h3><div className="row" style={{ alignItems: 'flex-end', height: 140, gap: 4 }}>{analytics.data.byDay.map((d: any) => <div key={d.day} title={`${d.day}: ${d.scans}`} style={{ flex: 1, background: 'var(--primary)', height: `${(d.scans / Math.max(1, ...analytics.data.byDay.map((x: any) => x.scans))) * 100}%`, borderRadius: 4 }} />)}</div></div>}
          {analytics.data?.byOutcome && <div className="card" style={{ gridColumn: 'span 3' }}><h3>Outcomes</h3>{Object.entries(analytics.data.byOutcome).map(([k, v]) => <KV key={k} k={k.replace(/_/g, ' ')} v={String(v)} />)}</div>}
        </div>
      )}
      {tab === 'institution' && <Institution toast={toast} err={err} purposes={purposes.data?.purposes ?? []} currencies={(config?.currencies ?? []).map((c) => c.code)} />}
      <Modal open={!!shown} onClose={() => setShown(null)} title={shown?.mode === 'OFFLINE' ? 'Offline code' : 'Your code'}>
        {shown && (
          <div className="print-sheet" style={{ textAlign: 'center' }}>
            <div className="bold" style={{ fontSize: 18 }}>{user?.businessName || user?.fullName}</div>
            <QrImage value={shown.qrPayload ?? shown.uri ?? shown.payload} size={280} />
            {shown.amount ? <div className="bold">{shown.amount / 100} {shown.currency}</div> : null}
            {shown.amountMinor ? <div className="bold">{shown.amountMinor / 100} {shown.currency}</div> : null}
            {shown.reference && <div className="small muted">{shown.reference}</div>}
            {shown.mode === 'OFFLINE' && <Alert kind="warning">Valid until {new Date(shown.expiresAt).toLocaleTimeString()}. The customer's app will confirm when back online{shown.local ? ' (signed on this device)' : ''}.</Alert>}
            {shown.uri && <div className="mono tiny" style={{ wordBreak: 'break-all' }}>{shown.uri}</div>}
            <div className="row mt" style={{ justifyContent: 'center' }}><Button variant="secondary" onClick={() => window.print()}>Print</Button></div>
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
        <h3>New location</h3>
        <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Marché de la Liberté, stand 12" /></Field>
        <div className="grid cols-2"><Field label="Address"><Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field><Field label="City"><Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></Field></div>
        <Field label="MCC"><Input value={form.mcc} onChange={(e) => setForm({ ...form, mcc: e.target.value })} placeholder="5411" /></Field>
        <Button onClick={() => api.post('/api/v1/locations', { name: form.name, address: form.address || null, city: form.city || null, mcc: form.mcc || null }).then(() => { toast('Location added', 'success'); locations.reload(); }).catch(err)} disabled={form.name.length < 2}>Add location</Button>
      </div>
      <div className="card">
        <h3>Locations</h3>
        {(locations.data?.data ?? []).length === 0 && <Empty icon="📍" text="No locations yet" />}
        {(locations.data?.data ?? []).map((l: any) => <div key={l.id} className="list-item"><div className="flex1"><div className="main-text">{l.name}</div><div className="sub-text">{[l.address, l.city].filter(Boolean).join(', ')}{l.mcc ? ` · MCC ${l.mcc}` : ''} · {l.terminals?.length ?? 0} terminal(s)</div></div><Button size="sm" variant="secondary" onClick={() => setTerminal({ locationId: l.id, label: '' })}>+ Terminal</Button></div>)}
        <Modal open={!!terminal} onClose={() => setTerminal(null)} title="New terminal">
          <Field label="Label"><Input value={terminal?.label ?? ''} onChange={(e) => setTerminal({ ...terminal!, label: e.target.value })} placeholder="Till 1" /></Field>
          <Button onClick={() => api.post(`/api/v1/locations/${terminal!.locationId}/terminals`, { label: terminal!.label }).then(() => { toast('Terminal added', 'success'); setTerminal(null); locations.reload(); }).catch(err)}>Add</Button>
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
        <h3>Institution registration</h3>
        <p className="small muted">Schools, hospitals, utilities, landlords, government services and NGOs receive purpose-locked payments from the diaspora at a published rate. Verification by BitriPay is required before the first payment.</p>
        {me.data && <Alert kind={me.data.status === 'verified' ? 'success' : 'warning'}>{me.data.name} · {me.data.kind} · <b>{me.data.status}</b> · purposes {me.data.purposeCodes.join(', ')}</Alert>}
        <div className="grid cols-2">
          <Field label="Kind"><Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{['school', 'hospital', 'utility', 'government', 'ngo', 'landlord', 'cooperative'].map((k) => <option key={k}>{k}</option>)}</Select></Field>
          <Field label="Registry reference"><Input value={form.registryRef} onChange={(e) => setForm({ ...form, registryRef: e.target.value })} placeholder="MINEDUC-KIN-0042" /></Field>
        </div>
        <Field label="Official name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Purposes"><div className="row wrap">{restricted.map((p) => <Chip key={p.code} kind={form.purposeCodes.includes(p.code) ? 'primary' : undefined} onClick={() => setForm({ ...form, purposeCodes: form.purposeCodes.includes(p.code) ? form.purposeCodes.filter((c: string) => c !== p.code) : [...form.purposeCodes, p.code] })}>{p.code}</Chip>)}</div></Field>
        <Button onClick={() => api.post('/api/v1/institutions', { kind: form.kind, name: form.name, registryRef: form.registryRef || null, purposeCodes: form.purposeCodes }).then(() => { toast('Registration submitted', 'success'); me.reload(); }).catch(err)} disabled={form.name.length < 2 || !form.purposeCodes.length}>Submit for verification</Button>
      </div>
      <div className="card">
        <h3>Diaspora-Direct code</h3>
        <p className="small muted">A “DD” flagged code your payers abroad scan; the app quotes at the published rate card and locks the payment to your purpose.</p>
        <div className="grid cols-2"><Field label="Purpose"><Select value={qr.purposeCode} onChange={(e) => setQr({ ...qr, purposeCode: e.target.value })}>{(me.data?.purposeCodes ?? ['SCHOOL']).map((c: string) => <option key={c}>{c}</option>)}</Select></Field><Field label="Currency"><Select value={qr.currency} onChange={(e) => setQr({ ...qr, currency: e.target.value })}>{currencies.map((c) => <option key={c}>{c}</option>)}</Select></Field></div>
        <Field label="Reference"><Input value={qr.reference} onChange={(e) => setQr({ ...qr, reference: e.target.value })} placeholder="FEES-2026-T1" /></Field>
        <Button onClick={() => api.post<any>('/api/v1/institutions/me/qr', { purposeCode: qr.purposeCode, currency: qr.currency, reference: qr.reference || null }).then((q) => { setShown(q); toast('Code issued', 'success'); }).catch(err)} disabled={me.data?.status !== 'verified'}>Issue DD code</Button>
        <Modal open={!!shown} onClose={() => setShown(null)} title="Diaspora-Direct code">{shown && <div style={{ textAlign: 'center' }}><QrImage value={shown.qrPayload ?? shown.uri} size={280} /><div className="small muted">{shown.purposeCode} · {shown.currency} · DD</div><div className="mono tiny" style={{ wordBreak: 'break-all' }}>{shown.uri}</div></div>}</Modal>
      </div>
    </div>
  );
}
export { qs };
