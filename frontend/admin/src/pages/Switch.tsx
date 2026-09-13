import { useState } from 'react';
import { api, qs } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Chip, ConfirmButton, Field, Input, KV, Modal, PageHeader, Select, StatusBadge, Table, Tabs, Textarea, fmtDate, useAsync } from '../components/ui';

/**
 * National switch console (CMP-13): connections and certification, participants and pairs, routing policies,
 * payments with their five status dimensions and timeline, inbox / outbox / recovery, incidents, and the
 * reconciliation workbench with dual-approved closures. There is deliberately no "mark as paid".
 */
export function SwitchConsole() {
  const { toast, money } = useStore();
  const [tab, setTab] = useState<'connections' | 'participants' | 'policies' | 'payments' | 'messages' | 'recon' | 'rails' | 'incidents'>('connections');
  const err = (e: any) => toast(e.message, 'error');
  const ok = (m: string) => toast(m, 'success');
  return (
    <div>
      <PageHeader title="National switch" subtitle="BitriPay initiates, orchestrates and reconciles; the switch settles. Every state here comes from an authenticated observation or a dual-approved correction." />
      <Tabs tabs={[{ id: 'connections', label: 'Connections' }, { id: 'participants', label: 'Participants' }, { id: 'policies', label: 'Routing policies' }, { id: 'payments', label: 'Payments' }, { id: 'messages', label: 'Inbox / outbox' }, { id: 'recon', label: 'Reconciliation' }, { id: 'rails', label: 'Rails & Smart Route' }, { id: 'incidents', label: 'Incidents' }]} value={tab} onChange={(v) => setTab(v as any)} />
      {tab === 'connections' && <Connections ok={ok} err={err} />}
      {tab === 'participants' && <Participants ok={ok} err={err} />}
      {tab === 'policies' && <Policies ok={ok} err={err} />}
      {tab === 'payments' && <Payments ok={ok} err={err} money={money} />}
      {tab === 'messages' && <Messages ok={ok} err={err} />}
      {tab === 'recon' && <Recon ok={ok} err={err} money={money} />}
      {tab === 'rails' && <Rails ok={ok} err={err} />}
      {tab === 'incidents' && <Incidents ok={ok} err={err} />}
    </div>
  );
}

function Connections({ ok, err }: { ok: (m: string) => void; err: (e: any) => void }) {
  const data = useAsync(() => api.get<any>('/api/admin/switch/connections'), []);
  const [cert, setCert] = useState<any>(null);
  return (
    <div>
      {(data.data?.items ?? []).map((c: any) => (
        <div className="card mb" key={c.id}>
          <div className="row"><h4 style={{ margin: 0 }}>{c.name} <Chip>{c.country}</Chip> <Chip kind={c.environment === 'production' ? 'success' : 'warning'}>{c.environment}</Chip> <Chip>{c.accessMode}</Chip> <Chip kind={c.enabled ? 'success' : 'danger'}>{c.enabled ? 'enabled' : 'disabled'}</Chip></h4><span style={{ marginLeft: 'auto' }} className="small muted">{c.adapter} · certification {c.certification?.status ?? c.certificationStatus}</span></div>
          <div className="grid cols-3 mt">
            <div><KV k="Emission gate" v={c.gate?.allowed ? <Chip kind="success">open</Chip> : <Chip kind="danger">closed</Chip>} />{c.gate?.reasons?.length ? <ul className="small">{c.gate.reasons.map((r: string) => <li key={r}>{r}</li>)}</ul> : null}</div>
            <div><KV k="Link" v={<StatusBadge status={c.linkState ?? c.link?.state ?? 'unknown'} />} /><KV k="Certificate" v={c.certificate?.notAfter ? `until ${fmtDate(c.certificate.notAfter)}` : 'none'} /></div>
            <div><KV k="Blockers to enable" v={c.blockers?.length ? c.blockers.join('; ') : 'none'} /></div>
          </div>
          <div className="row mt">
            <Button size="sm" variant="secondary" onClick={() => setCert({ id: c.id, status: 'INTERNAL_TESTS', evidenceRef: '', profileVersion: '' })}>Certification step</Button>
            <ConfirmButton size="sm" variant={c.enabled ? 'danger' : 'success'} onConfirm={() => api.post(`/api/admin/switch/connections/${c.id}/enabled`, { enabled: !c.enabled }).then(() => { ok('Updated'); data.reload(); }).catch(err)}>{c.enabled ? 'Disable emission' : 'Enable emission'}</ConfirmButton>
            <Button size="sm" variant="ghost" onClick={() => api.post('/api/admin/switch/connections/probe', {}).then((r: any) => { ok(`Probed ${r.probed?.length ?? ''}`); data.reload(); }).catch(err)}>Probe link</Button>
          </div>
        </div>
      ))}
      <Modal open={!!cert} onClose={() => setCert(null)} title="Certification step">
        {cert && <><Field label="Status"><Select value={cert.status} onChange={(e) => setCert({ ...cert, status: e.target.value })}>{['INTERNAL_TESTS', 'SANDBOX', 'CERTIFIED', 'REVOKED'].map((s) => <option key={s}>{s}</option>)}</Select></Field><Field label="Evidence reference"><Input value={cert.evidenceRef} onChange={(e) => setCert({ ...cert, evidenceRef: e.target.value })} /></Field><Field label="Profile version"><Input value={cert.profileVersion} onChange={(e) => setCert({ ...cert, profileVersion: e.target.value })} /></Field><Button onClick={() => api.post(`/api/admin/switch/connections/${cert.id}/certification`, cert).then(() => { ok('Recorded'); setCert(null); data.reload(); }).catch(err)}>Record</Button></>}
      </Modal>
    </div>
  );
}

function Participants({ ok, err }: { ok: (m: string) => void; err: (e: any) => void }) {
  const data = useAsync(() => api.get<any>('/api/admin/switch/participants'), []);
  const pairs = useAsync(() => api.get<any>('/api/admin/switch/pairs'), []);
  const [country, setCountry] = useState('CD');
  const registry = useAsync(() => api.get<any>(`/api/admin/switch/registry${qs({ country })}`), [country, data.data]);
  return (
    <div className="grid cols-2">
      <div className="card">
        <div className="row"><h4 style={{ margin: 0 }}>Registry</h4><Input value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} style={{ width: 80, marginLeft: 'auto' }} /></div>
        {registry.data && <Alert kind={registry.data.stale ? 'warning' : 'success'}>{registry.data.stale ? 'Registry stale' : 'Registry fresh'} · {registry.data.contradictions?.length ?? 0} contradiction(s)</Alert>}
        <Table head={['Participant', 'Type', 'Status', 'Services', '']} rows={(data.data?.items ?? []).map((p: any) => [<b>{p.name}<br /><span className="mono tiny">{p.id}</span></b>, p.type, <StatusBadge status={p.status} />, <span className="tiny">{(p.services ?? []).join(', ')}</span>, <div className="row">{p.status !== 'ACTIVE' && <ConfirmButton size="sm" onConfirm={() => api.post(`/api/admin/switch/participants/${p.id}/approve`, {}).then(() => { ok('Approved'); data.reload(); }).catch(err)}>Approve</ConfirmButton>}<ConfirmButton size="sm" variant="ghost" onConfirm={() => api.post(`/api/admin/switch/participants/${p.id}/status`, { status: p.status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED', reason: 'console' }).then(() => { ok('Updated'); data.reload(); }).catch(err)}>{p.status === 'SUSPENDED' ? 'Reinstate' : 'Suspend'}</ConfirmButton></div>])} empty="No participants" />
      </div>
      <div className="card">
        <h4>Pairs (from → to, product)</h4>
        <Table head={['From', 'To', 'Product', 'Status', 'Evidence']} rows={(pairs.data?.items ?? []).map((p: any) => [p.fromId ?? p.from, p.toId ?? p.to, p.product, <StatusBadge status={p.status} />, <span className="tiny">{p.evidenceRef ?? '—'}</span>])} empty="No pairs" />
      </div>
    </div>
  );
}

function Policies({ ok, err }: { ok: (m: string) => void; err: (e: any) => void }) {
  const data = useAsync(() => api.get<any>('/api/admin/switch/policies'), []);
  const exceptions = useAsync(() => api.get<any>('/api/admin/switch/exceptions'), []);
  const [sim, setSim] = useState({ fromParticipant: 'DEMO_BANK_A', toParticipant: 'DEMO_MMO_B', product: 'TRANSFER', currency: 'CDF', amountMinor: 100000 });
  const [decision, setDecision] = useState<any>(null);
  return (
    <div className="grid cols-2">
      <div className="card">
        <h4>Policy versions</h4>
        <Table head={['Version', 'Status', 'Author', 'Approver', '']} rows={(data.data?.items ?? []).map((p: any) => [p.version, <StatusBadge status={p.status} />, <span className="tiny">{p.authorId ?? '—'}</span>, <span className="tiny">{p.approvedBy ?? '—'}</span>, <div className="row">{p.status === 'DRAFT' && <ConfirmButton size="sm" onConfirm={() => api.post(`/api/admin/switch/policies/${p.id}/approve`, {}).then(() => { ok('Approved'); data.reload(); }).catch(err)}>Approve</ConfirmButton>}{p.status === 'APPROVED' && <ConfirmButton size="sm" variant="success" onConfirm={() => api.post(`/api/admin/switch/policies/${p.id}/activate`, {}).then(() => { ok('Activated'); data.reload(); }).catch(err)}>Activate</ConfirmButton>}</div>])} empty="No policies" />
        <h4 className="mt">Exceptions (two approvals + signature)</h4>
        <Table head={['Id', 'Scope', 'Status', 'Approvals']} rows={(exceptions.data?.items ?? []).map((e: any) => [<span className="mono tiny">{e.id}</span>, <span className="tiny">{e.scope ?? e.reason}</span>, <StatusBadge status={e.status} />, <span className="tiny">{(e.approvals ?? []).length}/2</span>])} empty="No exceptions" />
      </div>
      <div className="card">
        <h4>Explain a route (RTE-001…006)</h4>
        <div className="grid cols-2">
          <Field label="From"><Input value={sim.fromParticipant} onChange={(e) => setSim({ ...sim, fromParticipant: e.target.value })} /></Field>
          <Field label="To"><Input value={sim.toParticipant} onChange={(e) => setSim({ ...sim, toParticipant: e.target.value })} /></Field>
          <Field label="Product"><Input value={sim.product} onChange={(e) => setSim({ ...sim, product: e.target.value })} /></Field>
          <Field label="Amount (minor)"><Input type="number" value={sim.amountMinor} onChange={(e) => setSim({ ...sim, amountMinor: Number(e.target.value) })} /></Field>
        </div>
        <Button onClick={() => api.post<any>('/api/admin/switch/policies/decide', sim).then(setDecision).catch(err)}>Decide</Button>
        {decision && <pre className="mono tiny mt" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(decision, null, 2)}</pre>}
      </div>
    </div>
  );
}

function Payments({ ok, err, money }: { ok: (m: string) => void; err: (e: any) => void; money: (m: number, c: string) => string }) {
  const [status, setStatus] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const data = useAsync(() => api.get<any>(`/api/admin/switch/payments${qs({ status, uncertain: uncertain ? 1 : '' })}`), [status, uncertain]);
  const [sel, setSel] = useState<string | null>(null);
  const timeline = useAsync(() => (sel ? api.get<any>(`/api/admin/switch/payments/${sel}/timeline`) : Promise.resolve(null)), [sel]);
  return (
    <div className="grid cols-2">
      <div className="card">
        <div className="row mb"><Select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 200 }}><option value="">All states</option>{['RECEIVED', 'VALIDATED', 'QUEUED', 'SENT', 'PENDING', 'AUTHORIZED', 'COMPLETED', 'REJECTED', 'UNKNOWN', 'EXPIRED', 'CANCELLED', 'QUARANTINED'].map((s) => <option key={s}>{s}</option>)}</Select><label className="checkbox"><input type="checkbox" checked={uncertain} onChange={(e) => setUncertain(e.target.checked)} /> uncertain only</label><Button size="sm" variant="secondary" style={{ marginLeft: 'auto' }} onClick={() => api.post('/api/admin/switch/recovery', {}).then((r: any) => { ok(`Recovery: ${JSON.stringify(r)}`); data.reload(); }).catch(err)}>Run recovery (inquiries only)</Button></div>
        <Table head={['Payment', 'Order', 'Amount', 'Status', 'Dimensions', '']} rows={(data.data?.items ?? []).map((p: any) => [<span className="mono tiny">{p.payment_id}</span>, <span className="tiny">{p.merchant_order_id}</span>, <b>{money(p.amount?.value_minor ?? p.amount_minor ?? 0, p.amount?.currency ?? p.currency ?? 'CDF')}</b>, <StatusBadge status={p.status} />, <span className="tiny">{p.dimensions ? Object.entries(p.dimensions).map(([k, v]) => `${k}:${v}`).join(' ') : ''}</span>, <Button size="sm" variant="secondary" onClick={() => setSel(p.payment_id)}>Timeline</Button>])} empty="No payments" />
      </div>
      <div className="card">
        {!timeline.data && <p className="muted small">Select a payment to see its journal, attempts, observations and linked operations.</p>}
        {timeline.data && <pre className="mono tiny" style={{ whiteSpace: 'pre-wrap', maxHeight: 600, overflow: 'auto' }}>{JSON.stringify(timeline.data, null, 2)}</pre>}
      </div>
    </div>
  );
}

function Messages({ ok, err }: { ok: (m: string) => void; err: (e: any) => void }) {
  const inbox = useAsync(() => api.get<any>('/api/admin/switch/inbox?limit=50'), []);
  const outbox = useAsync(() => api.get<any>('/api/admin/switch/outbox?limit=50'), []);
  return (
    <div className="grid cols-2">
      <div className="card"><h4>Inbox (verified observations, quarantine)</h4><Table head={['Id', 'Connection', 'Outcome', 'Quarantine', 'Received', '']} rows={(inbox.data?.items ?? []).map((m: any) => [<span className="mono tiny">{m.id}</span>, m.connectionId, m.outcome ?? m.status, m.quarantined ? <Chip kind="danger">yes</Chip> : 'no', <span className="tiny">{fmtDate(m.receivedAt ?? m.createdAt)}</span>, m.quarantined ? <ConfirmButton size="sm" variant="ghost" prompt="Reason" onConfirm={(reason) => api.post(`/api/admin/switch/inbox/${m.id}/discard`, { reason: reason || 'reviewed' }).then(() => { ok('Discarded'); inbox.reload(); }).catch(err)}>Discard</ConfirmButton> : null])} empty="Inbox empty" /></div>
      <div className="card"><h4>Outbox (pending, dead letters)</h4><Table head={['Id', 'Kind', 'Attempts', 'Next', 'Dead', '']} rows={(outbox.data?.items ?? []).map((m: any) => [<span className="mono tiny">{m.id}</span>, m.kind, m.attempts, <span className="tiny">{fmtDate(m.nextAttemptAt)}</span>, m.dead ? <Chip kind="danger">dead</Chip> : '—', m.dead ? <Button size="sm" variant="secondary" onClick={() => api.post(`/api/admin/switch/outbox/${m.id}/retry`, {}).then(() => { ok('Requeued'); outbox.reload(); }).catch(err)}>Retry</Button> : null])} empty="Outbox empty" /></div>
    </div>
  );
}

function Recon({ ok, err, money }: { ok: (m: string) => void; err: (e: any) => void; money: (m: number, c: string) => string }) {
  const [status, setStatus] = useState('OPEN');
  const cases = useAsync(() => api.get<any>(`/api/admin/switch/cases${qs({ status, limit: 100 })}`), [status]);
  const workbench = useAsync(() => api.get<any>('/api/admin/finops/reconciliation/workbench'), []);
  const [sel, setSel] = useState<any>(null);
  const [resolution, setResolution] = useState('');
  return (
    <div>
      <div className="grid cols-3 mb">{(workbench.data?.exceptions ?? []).slice(0, 6).map((e: any) => <div className="card" key={`${e.connectionId}-${e.class}`}><div className="stat"><span className="label">{e.connectionId} · {e.class}</span><span className="value">{e.count}</span><span className="small muted">exposure {money(e.exposureMinor, e.currency ?? 'USD')} · oldest {e.oldestAgeHours}h</span></div></div>)}</div>
      <div className="grid cols-2">
        <div className="card">
          <div className="row mb"><Select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 220 }}>{['OPEN', 'ASSIGNED', 'RESOLUTION_PROPOSED', 'CLOSED'].map((s) => <option key={s}>{s}</option>)}</Select></div>
          <Table head={['Case', 'Class', 'Exposure', 'Age', 'Owner', '']} rows={(cases.data?.data ?? []).map((c: any) => [<span className="mono tiny">{c.id}<br />{c.connectionId}</span>, <Chip kind={c.priority === 'CRITICAL' ? 'danger' : c.priority === 'HIGH' ? 'warning' : undefined}>{c.class}</Chip>, c.exposure?.currency ? money(c.exposure.valueMinor, c.exposure.currency) : '—', `${c.ageHours}h`, <span className="tiny">{c.ownerId ?? '—'}</span>, <Button size="sm" variant="secondary" onClick={() => setSel(c)}>Open</Button>])} empty="No cases" />
        </div>
        <div className="card">
          {!sel && <p className="small muted">Open a case: assign it, propose a resolution with documents, and a different administrator approves closure.</p>}
          {sel && <>
            <h4>{sel.class} · {sel.id}</h4>
            <KV k="Status" v={<StatusBadge status={sel.status} />} /><KV k="References" v={<span className="mono tiny">{JSON.stringify(sel.references)}</span>} /><KV k="Sources" v={(sel.sources ?? []).join(', ')} />{sel.resolution && <KV k="Proposed" v={sel.resolution} />}
            <div className="row mt"><ConfirmButton size="sm" onConfirm={() => api.post(`/api/admin/switch/cases/${sel.id}/assign`, {}).then(() => { ok('Assigned to you'); cases.reload(); }).catch(err)}>Assign to me</ConfirmButton>{sel.status === 'RESOLUTION_PROPOSED' && <ConfirmButton size="sm" variant="success" onConfirm={() => api.post(`/api/admin/switch/cases/${sel.id}/approve`, {}).then(() => { ok('Closed'); setSel(null); cases.reload(); }).catch(err)}>Approve closure</ConfirmButton>}</div>
            <Field label="Resolution"><Textarea rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} /></Field>
            <Button size="sm" onClick={() => api.post(`/api/admin/switch/cases/${sel.id}/resolution`, { resolution, documents: [] }).then(() => { ok('Proposed'); cases.reload(); }).catch(err)} disabled={resolution.length < 10}>Propose resolution</Button>
          </>}
        </div>
      </div>
    </div>
  );
}

function Rails({ ok, err }: { ok: (m: string) => void; err: (e: any) => void }) {
  const rails = useAsync(() => api.get<any>('/api/admin/switch/rails'), []);
  return (
    <div className="card">
      <Table head={['Rail', 'Kind', 'Country', 'Circuit', 'Success 24h', 'p95', 'Cost', '']} rows={(rails.data?.items ?? []).map((r: any) => [<b>{r.name}<br /><span className="mono tiny">{r.id}</span></b>, r.kind, r.country ?? '—', <span>{r.health?.usable ? <Chip kind="success">usable</Chip> : <Chip kind="danger">{r.health?.reason ?? 'down'}</Chip>} <span className="tiny">{r.health?.circuit}</span></span>, r.stats ? `${Math.round((r.stats.successRate ?? 0) * 100)}%` : '—', r.stats?.p95LatencyMs ? `${r.stats.p95LatencyMs} ms` : '—', r.costBps != null ? `${r.costBps} bps` : '—', <div className="row">{r.health?.paused ? <ConfirmButton size="sm" variant="success" onConfirm={() => api.post(`/api/admin/switch/rails/${r.id}/resume`, {}).then(() => { ok('Resumed'); rails.reload(); }).catch(err)}>Resume</ConfirmButton> : <ConfirmButton size="sm" variant="danger" prompt="Reason" onConfirm={(reason) => api.post(`/api/admin/switch/rails/${r.id}/pause`, { reason: reason || 'operations' }).then(() => { ok('Paused'); rails.reload(); }).catch(err)}>Pause</ConfirmButton>}</div>])} empty="No rails" />
    </div>
  );
}

function Incidents({ ok, err }: { ok: (m: string) => void; err: (e: any) => void }) {
  const data = useAsync(() => api.get<any>('/api/admin/switch/incidents'), []);
  return (
    <div className="card">
      <Table head={['Severity', 'Title', 'Status', 'Opened', '']} rows={(data.data?.items ?? []).map((i: any) => [<Chip kind={i.severity === 'P1' ? 'danger' : i.severity === 'P2' ? 'warning' : undefined}>{i.severity}</Chip>, <span><b>{i.title}</b><br /><span className="tiny muted">{i.summary ?? i.description}</span></span>, <StatusBadge status={i.status} />, <span className="tiny">{fmtDate(i.openedAt ?? i.createdAt)}</span>, <div className="row">{i.status === 'OPEN' && <Button size="sm" variant="secondary" onClick={() => api.post(`/api/admin/switch/incidents/${i.id}/acknowledge`, {}).then(() => { ok('Acknowledged'); data.reload(); }).catch(err)}>Acknowledge</Button>}{i.status !== 'RESOLVED' && <ConfirmButton size="sm" variant="success" prompt="Resolution" onConfirm={(note) => api.post(`/api/admin/switch/incidents/${i.id}/resolve`, { resolution: note || 'resolved' }).then(() => { ok('Resolved'); data.reload(); }).catch(err)}>Resolve</ConfirmButton>}</div>])} empty="No incidents" />
    </div>
  );
}
