import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Chip, Empty, Field, Input, KV, Modal, PageHeader, Select, StatusBadge, Tabs, Textarea, useAsync } from '../components/ui';
import { offlineDevice, offlineQueue } from '../lib/offline';

/**
 * Merchant command centre: balance classes, settlement calendar / cycles / statements, disputes with evidence,
 * effective fees, split payouts, verification level, and the offline acceptance kit (device key, prefetched nonces,
 * pending promises).
 */
export function MerchantCentre() {
  const { user, money, toast, config } = useStore();
  const [tab, setTab] = useState<'overview' | 'settlement' | 'disputes' | 'fees' | 'offline'>('overview');
  const balance = useAsync(() => api.get<any>('/api/v1/balance'), [tab]);
  const calendar = useAsync(() => api.get<any>('/api/v1/settlement_calendar'), [tab]);
  const disputes = useAsync(() => api.get<any>('/api/v1/disputes'), [tab]);
  const verification = useAsync(() => api.get<any>('/api/risk/verification'), [tab]);
  const fees = useAsync(() => (tab === 'fees' ? api.get<any>('/api/v1/fee_schedule') : Promise.resolve(null)), [tab]);
  const err = (e: any) => toast(e.message, 'error');
  if (user?.role !== 'merchant' && user?.role !== 'admin') return <Alert kind="info">Upgrade to a merchant account under <Link to="/app/merchant">Merchant</Link> to use the command centre.</Alert>;
  const open = (disputes.data?.data ?? []).filter((d: any) => ['OPEN', 'EVIDENCE_REQUESTED', 'UNDER_REVIEW'].includes(d.status));
  return (
    <div>
      <PageHeader title="Command centre" subtitle="What you can spend, what is on its way, what needs your attention" actions={<><Link className="btn" to="/app/merchant/qr">🔳 QR centre</Link><Link className="btn secondary" to="/app/merchant/developer">🧑‍💻 Developer</Link></>} />
      <Tabs tabs={[{ id: 'overview', label: 'Overview' }, { id: 'settlement', label: 'Settlement' }, { id: 'disputes', label: `Disputes${open.length ? ` (${open.length})` : ''}` }, { id: 'fees', label: 'My fees' }, { id: 'offline', label: 'Offline kit' }]} value={tab} onChange={(v) => setTab(v as any)} />
      {tab === 'overview' && (
        <>
          <div className="grid cols-4">
            {(balance.data?.data ?? []).map((b: any) => (
              <div className="card" key={b.currency}>
                <div className="stat"><span className="label">Available · {b.currency}</span><span className="value">{money(b.available, b.currency)}</span><span className="small muted">balance {money(b.balance, b.currency)}</span></div>
                <div className="mt small">
                  <KV k="Pending in" v={money(b.pending, b.currency)} />
                  <KV k="Awaiting settlement" v={money(b.settlement_pending, b.currency)} />
                  <KV k="Held" v={money(b.held, b.currency)} />
                  <KV k="Disputed" v={money(b.disputed, b.currency)} />
                  {b.frozen ? <KV k="Frozen" v={<Chip kind="danger">{money(b.frozen, b.currency)}</Chip>} /> : null}
                </div>
              </div>
            ))}
            {balance.data?.data?.length === 0 && <div className="card"><Empty icon="💼" text="No wallet yet" /></div>}
          </div>
          <div className="grid cols-3 mt">
            <div className="card">
              <h3>Next settlements</h3>
              {(calendar.data?.upcoming ?? []).map((u: any) => <KV key={u.profileId} k={`${u.currency} · ${u.schedule}`} v={<span className="small">cut-off {new Date(u.nextCutoff).toLocaleString()}<br />paid {u.expectedPayout ? new Date(u.expectedPayout).toLocaleDateString() : 'in wallet'}</span>} />)}
              {calendar.data?.upcoming?.length === 0 && <p className="small muted">No settlement profile yet — payments stay in your wallet. Set one under Settlement.</p>}
              {calendar.data?.obligations?.cycles?.length > 0 && <Alert kind="info">{calendar.data.obligations.cycles.length} closed cycle(s) awaiting payout.</Alert>}
            </div>
            <div className="card">
              <h3>Needs attention</h3>
              {open.length === 0 && <p className="small muted">No open disputes.</p>}
              {open.slice(0, 5).map((d: any) => <div key={d.id} className="list-item"><div className="flex1"><div className="main-text">{money(d.amount.valueMinor, d.amount.currency)} · {d.reasonCode.replace(/_/g, ' ')}</div><div className="sub-text">respond by {new Date(d.deadlineAt).toLocaleDateString()}</div></div><StatusBadge status={d.status} /></div>)}
            </div>
            <div className="card">
              <h3>Verification level</h3>
              {verification.data && <><div className="value" style={{ fontSize: 20 }}>{verification.data.label}</div>{verification.data.limits ? <p className="small muted">Per transaction {verification.data.limits.perTransaction} · daily {verification.data.limits.daily} · monthly {verification.data.limits.monthly} (base minor units)</p> : <p className="small muted">Legacy limits apply.</p>}<p className="small">{verification.data.next}</p><KV k="Business (KYB)" v={<StatusBadge status={verification.data.kybStatus} />} /><Link className="btn secondary" to="/app/settings?tab=kyc">Verification →</Link></>}
            </div>
          </div>
        </>
      )}
      {tab === 'settlement' && <Settlement calendar={calendar} money={money} toast={toast} currencies={(config?.currencies ?? []).map((c) => c.code)} />}
      {tab === 'disputes' && <Disputes disputes={disputes} money={money} toast={toast} />}
      {tab === 'fees' && (
        <div className="card">
          <p className="small muted">The fee rules that apply to your account right now (merchant &gt; tier &gt; country &gt; platform). Fixed parts are in base-currency minor units.</p>
          {fees.data?.tier && <Alert kind="success">You are on the <b>{fees.data.tier}</b> tier.</Alert>}
          <div className="list">{(fees.data?.data ?? []).map((f: any) => <div key={f.type} className="list-item"><div className="flex1"><div className="main-text">{f.type.replace(/_/g, ' ')}</div><div className="sub-text">{f.rule.bps / 100}% + {f.rule.fixed}{f.rule.min ? ` · min ${f.rule.min}` : ''}{f.rule.max ? ` · max ${f.rule.max}` : ''}</div></div><Chip>{f.source.scope}{f.source.version ? ` v${f.source.version}` : ''}</Chip></div>)}</div>
        </div>
      )}
      {tab === 'offline' && <OfflineKit toast={toast} err={err} />}
    </div>
  );
}

function Settlement({ calendar, money, toast, currencies }: { calendar: any; money: (m: number, c: string) => string; toast: any; currencies: string[] }) {
  const [form, setForm] = useState<any>({ currency: currencies[0] ?? 'USD', schedule: 'T1', cutoff_hour_utc: 22, destination: { method: 'wallet' }, min_amount: 0, auto: true });
  const banks = useAsync(() => api.get<{ items: any[] }>('/api/bank-accounts'), []);
  const [statement, setStatement] = useState<any>(null);
  const err = (e: any) => toast(e.message, 'error');
  const save = () => api.post('/api/v1/settlement_profiles', form).then(() => { toast('Settlement profile saved', 'success'); calendar.reload(); }).catch(err);
  const close = (currency: string, pay: boolean) => api.post('/api/v1/settlement_cycles', { currency, pay }).then((c: any) => { toast(`Cycle ${c.status.toLowerCase()} · net ${money(c.netMinor, c.currency)}`, 'success'); calendar.reload(); }).catch(err);
  return (
    <div className="grid cols-2">
      <div className="card">
        <h3>Settlement profile</h3>
        <p className="small muted">When your collections are paid out, where, and the minimum. T+1 means the day after the cut-off. Destination changes cool off for 24 hours.</p>
        <div className="grid cols-2">
          <Field label="Currency"><Select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>{currencies.map((c) => <option key={c}>{c}</option>)}</Select></Field>
          <Field label="Schedule"><Select value={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.value })}>{['T0', 'T1', 'T2', 'weekly', 'manual'].map((s) => <option key={s}>{s}</option>)}</Select></Field>
          <Field label="Cut-off hour (UTC)"><Input type="number" min={0} max={23} value={form.cutoff_hour_utc} onChange={(e) => setForm({ ...form, cutoff_hour_utc: Number(e.target.value) })} /></Field>
          <Field label="Minimum (minor units)"><Input type="number" min={0} value={form.min_amount} onChange={(e) => setForm({ ...form, min_amount: Number(e.target.value) })} /></Field>
        </div>
        <Field label="Destination"><Select value={form.destination.method === 'bank' ? form.destination.bankAccountId : 'wallet'} onChange={(e) => setForm({ ...form, destination: e.target.value === 'wallet' ? { method: 'wallet' } : { method: 'bank', bankAccountId: e.target.value } })}><option value="wallet">Keep in my wallet</option>{(banks.data?.items ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.bankName} •••• {String(b.accountNumber).slice(-4)} ({b.currency})</option>)}</Select></Field>
        <label className="checkbox mb"><input type="checkbox" checked={!!form.auto} onChange={(e) => setForm({ ...form, auto: e.target.checked })} /> Run automatically at the cut-off</label>
        <div className="row"><Button onClick={save}>Save profile</Button><Button variant="secondary" onClick={() => close(form.currency, false)}>Close cycle now</Button><Button variant="ghost" onClick={() => close(form.currency, true)}>Close & pay</Button></div>
        <h4 className="mt">Profiles</h4>
        {(calendar.data?.profiles ?? []).map((p: any) => <KV key={p.id} k={`${p.currency} · ${p.rail}`} v={`${p.schedule} · ${p.destination?.method ?? 'wallet'}${p.auto ? ' · auto' : ''}`} />)}
      </div>
      <div className="card">
        <h3>Cycles & statements</h3>
        {(calendar.data?.recent ?? []).length === 0 && <Empty icon="📅" text="No cycles yet" />}
        <div className="list">
          {(calendar.data?.recent ?? []).map((c: any) => (
            <div key={c.id} className="list-item">
              <div className="flex1"><div className="main-text">{c.businessDate} · {money(c.netMinor, c.currency)} net</div><div className="sub-text">gross {money(c.grossMinor, c.currency)} · fees {money(c.feesMinor, c.currency)} · refunds {money(c.refundsMinor, c.currency)} · splits {money(c.splitsMinor, c.currency)} · holds {money(c.holdsMinor, c.currency)} · {c.itemCount} items</div></div>
              <StatusBadge status={c.status} />
              <div className="row"><Button size="sm" variant="ghost" onClick={() => api.get(`/api/v1/settlement_cycles/${c.id}/statement`).then(setStatement).catch(err)}>Statement</Button><a className="btn ghost sm" href={`/api/v1/settlement_cycles/${c.id}/statement?format=csv`} target="_blank" rel="noreferrer">CSV</a><a className="btn ghost sm" href={`/api/v1/settlement_cycles/${c.id}/statement?format=pdf`} target="_blank" rel="noreferrer">PDF</a>{c.status === 'CLOSED' && <Button size="sm" onClick={() => api.post(`/api/v1/settlement_cycles/${c.id}/pay`, {}).then(() => { toast('Payout requested', 'success'); calendar.reload(); }).catch(err)}>Pay</Button>}</div>
            </div>
          ))}
        </div>
        <Modal open={!!statement} onClose={() => setStatement(null)} title={statement?.number} wide>
          {statement && <><KV k="Merchant" v={statement.merchant.name} /><KV k="Period" v={`${statement.cycle.periodFrom.slice(0, 10)} → ${statement.cycle.periodTo.slice(0, 10)}`} /><KV k="Net" v={statement.totals.formatted.net} /><KV k="Hash" v={<span className="mono tiny">{statement.hash}</span>} />
            <div className="list mt">{statement.items.map((i: any) => <div key={i.id} className="list-item"><div className="flex1"><div className="main-text">{i.kind} · {i.reference}</div><div className="sub-text">{i.occurredAt}</div></div><b>{money(i.amountMinor, statement.currency)}</b></div>)}</div></>}
        </Modal>
      </div>
    </div>
  );
}

function Disputes({ disputes, money, toast }: { disputes: any; money: (m: number, c: string) => string; toast: any }) {
  const [sel, setSel] = useState<any>(null);
  const [text, setText] = useState('');
  const detail = useAsync(() => (sel ? api.get<any>(`/api/v1/disputes/${sel}`) : Promise.resolve(null)), [sel, disputes.data]);
  const err = (e: any) => toast(e.message, 'error');
  const respond = () => api.post(`/api/v1/disputes/${sel}/respond`, { response: text }).then(() => { toast('Response sent', 'success'); setText(''); disputes.reload(); }).catch(err);
  return (
    <div className="grid cols-2">
      <div className="card">
        <h3>Disputes</h3>
        <p className="small muted">Response windows: {Object.entries(disputes.data?.settings?.responseDays ?? {}).map(([k, v]) => `${k} ${v}d`).join(' · ')}</p>
        {(disputes.data?.data ?? []).length === 0 && <Empty icon="⚖️" text="No disputes" />}
        <div className="list">{(disputes.data?.data ?? []).map((d: any) => <div key={d.id} className="list-item" onClick={() => setSel(d.id)} style={{ cursor: 'pointer' }}><div className="flex1"><div className="main-text">{money(d.amount.valueMinor, d.amount.currency)} · {d.reasonCode.replace(/_/g, ' ')}</div><div className="sub-text">{d.openedBy} · {d.rail} · deadline {new Date(d.deadlineAt).toLocaleDateString()}</div></div><StatusBadge status={d.status} /></div>)}</div>
      </div>
      <div className="card">
        {!detail.data && <Empty icon="📂" text="Select a dispute" />}
        {detail.data && (
          <>
            <h3>{detail.data.reasonCode.replace(/_/g, ' ')} · <StatusBadge status={detail.data.status} /></h3>
            <KV k="Amount" v={money(detail.data.amount.valueMinor, detail.data.amount.currency)} /><KV k="Opened by" v={detail.data.openedBy} /><KV k="Deadline" v={new Date(detail.data.deadlineAt).toLocaleString()} />{detail.data.decision && <KV k="Decision" v={`${detail.data.decision}: ${detail.data.decisionReason ?? ''}`} />}
            <h4 className="mt">Evidence</h4>
            {detail.data.evidence.map((e: any, i: number) => <div key={i} className="card soft compact small"><b>{e.role}</b> · {new Date(e.at).toLocaleString()}<br />{e.text}{e.files?.length ? <div className="tiny muted">files: {e.files.join(', ')}</div> : null}</div>)}
            {['OPEN', 'EVIDENCE_REQUESTED'].includes(detail.data.status) && <><Field label="Your response"><Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="What happened, with delivery proof, invoice numbers, signatures…" /></Field><Button onClick={respond} disabled={text.length < 5}>Send response</Button></>}
            <h4 className="mt">Chronology</h4>
            <div className="list">{(detail.data.chronology ?? []).map((e: any, i: number) => <div key={i} className="list-item"><div className="flex1"><div className="main-text">{e.event}</div><div className="sub-text">{new Date(e.at).toLocaleString()} · {e.actor}</div></div></div>)}</div>
          </>
        )}
      </div>
    </div>
  );
}

function OfflineKit({ toast, err }: { toast: any; err: (e: any) => void }) {
  const settings = useAsync(() => api.get<any>('/api/v1/offline/settings'), []);
  const devices = useAsync(() => api.get<any>('/api/v1/offline/devices'), []);
  const promises = useAsync(() => api.get<any>('/api/v1/offline/promises'), []);
  const [local, setLocal] = useState<{ deviceId: string | null; keyId: string | null; nonces: number; queued: number; supported: boolean }>({ deviceId: null, keyId: null, nonces: 0, queued: 0, supported: true });
  const refreshLocal = async () => {
    const d = await offlineDevice.status();
    setLocal({ deviceId: d.deviceId, keyId: d.keyId, nonces: d.nonces, queued: await offlineQueue.count(), supported: d.supported });
  };
  useEffect(() => { void refreshLocal(); }, []);
  const provision = async () => {
    try {
      const d = await offlineDevice.provision(navigator.userAgent.includes('Mobile') ? 'Phone' : 'Browser');
      toast(`Device ${d.deviceId} ready until ${new Date(d.keyNotAfter).toLocaleString()}`, 'success');
      await refreshLocal();
      devices.reload();
    } catch (e) {
      err(e);
    }
  };
  const prefetch = async () => {
    try {
      const n = await offlineDevice.prefetchNonces(20);
      toast(`${n} offline codes stored on this device`, 'success');
      await refreshLocal();
    } catch (e) {
      err(e);
    }
  };
  const sync = async () => {
    try {
      const r = await offlineQueue.sync();
      toast(`Synced: ${r.settled} settled, ${r.rejected} rejected, ${r.duplicates} duplicates`, r.rejected ? 'error' : 'success');
      await refreshLocal();
      promises.reload();
    } catch (e) {
      err(e);
    }
  };
  return (
    <div className="grid cols-2">
      <div className="card">
        <h3>Offline acceptance</h3>
        <p className="small muted">When the network is down this device shows signed offline codes and customers' phones sign a promise. Money moves only when either side is back online and the platform confirms; nothing is final before that. Ceiling per payment: {settings.data?.maxPerPromiseBase} base minor units; device keys last {settings.data ? Math.round(settings.data.promiseValidityHours) : 72} hours.</p>
        {!local.supported && <Alert kind="warning">This browser cannot generate the device key (Ed25519 WebCrypto). Use a recent Chrome, Edge, Safari or the mobile app.</Alert>}
        <KV k="This device" v={local.deviceId ? <span className="mono small">{local.deviceId}</span> : <span className="muted">not provisioned</span>} />
        <KV k="Key" v={local.keyId ? <span className="mono small">{local.keyId}</span> : '—'} />
        <KV k="Offline codes stored" v={local.nonces} />
        <KV k="Promises waiting to sync" v={local.queued} />
        <div className="row mt"><Button onClick={provision} disabled={!local.supported}>{local.deviceId ? 'Renew device key' : 'Provision this device'}</Button><Button variant="secondary" onClick={prefetch} disabled={!local.deviceId}>Prefetch codes</Button><Button variant="ghost" onClick={sync} disabled={!local.queued}>Sync now</Button></div>
        <p className="small mt">Offline codes are issued from the <Link to="/app/merchant/qr">QR centre</Link> (“Offline code”) and customers pay them from <Link to="/app/scan">Scan</Link> even without signal.</p>
      </div>
      <div className="card">
        <h3>Devices & recent promises</h3>
        {(devices.data?.data ?? []).map((d: any) => <KV key={d.deviceId} k={d.label ?? d.deviceId} v={<span className="small">key {d.keyId} · until {new Date(d.keyNotAfter).toLocaleString()} · counter {d.lastCounter}</span>} />)}
        <div className="list mt">{(promises.data?.data ?? []).slice(0, 20).map((p: any) => <div key={p.hash} className="list-item"><div className="flex1"><div className="main-text">{p.amountMinor / 100} {p.currency} · {p.reference ?? p.hash.slice(0, 10)}</div><div className="sub-text">{p.syncedAt ? new Date(p.syncedAt).toLocaleString() : ''}{p.rejectReason ? ` · ${p.rejectReason.replace(/_/g, ' ')}` : ''}</div></div><StatusBadge status={p.state} /></div>)}</div>
        {promises.data?.data?.length === 0 && <Empty icon="📡" text="No offline promises yet" />}
      </div>
    </div>
  );
}
export { qs };
