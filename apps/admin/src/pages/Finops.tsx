import { useState } from 'react';
import { api, qs } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Chip, ConfirmButton, Field, Input, KV, Modal, PageHeader, Select, StatusBadge, Table, Tabs, Textarea, fmtDate, useAsync } from '../components/ui';

/** Finance operations: versioned fee schedules, settlement obligations, disputes, holds, commissions and the processor reconciliation workbench. */
export function Finops() {
  const { toast, money } = useStore();
  const [tab, setTab] = useState<'fees' | 'settlements' | 'disputes' | 'holds' | 'commissions' | 'recon' | 'batches'>('fees');
  const err = (e: any) => toast(e.message, 'error');
  const ok = (m: string) => toast(m, 'success');
  return (
    <div>
      <PageHeader title="Finance operations" subtitle="Fees with a history, settlement obligations, disputes as objects, holds, the commission ledger and the three-way reconciliation workbench." />
      <Tabs tabs={[{ id: 'fees', label: 'Fee schedules' }, { id: 'settlements', label: 'Settlements' }, { id: 'disputes', label: 'Disputes' }, { id: 'holds', label: 'Holds' }, { id: 'commissions', label: 'Commissions' }, { id: 'batches', label: 'Payout batches' }, { id: 'recon', label: 'Processor reconciliation' }]} value={tab} onChange={(v) => setTab(v as any)} />
      {tab === 'fees' && <Fees ok={ok} err={err} />}
      {tab === 'settlements' && <Settlements ok={ok} err={err} money={money} />}
      {tab === 'disputes' && <Disputes ok={ok} err={err} money={money} />}
      {tab === 'holds' && <Holds ok={ok} err={err} money={money} />}
      {tab === 'commissions' && <Commissions money={money} />}
      {tab === 'recon' && <Recon ok={ok} err={err} money={money} />}
      {tab === 'batches' && <PayoutBatches ok={ok} err={err} money={money} />}
    </div>
  );
}

function Fees({ ok, err }: { ok: (m: string) => void; err: (e: any) => void }) {
  const data = useAsync(() => api.get<any>('/api/admin/finops/fees/schedules'), []);
  const [draft, setDraft] = useState<any>({ scope: 'platform', scopeRef: '', rulesText: '{\n  "merchant_payment": { "fixed": 0, "bps": 150, "min": 0, "max": 0 }\n}', notes: '' });
  const [explain, setExplain] = useState({ user: '', type: 'merchant_payment' });
  const [resolved, setResolved] = useState<any>(null);
  return (
    <div className="grid cols-2">
      <div className="card">
        <h4>Schedules (draft → approve by another administrator → activate)</h4>
        <Table head={['Scope', 'Version', 'Status', 'Effective', 'Author / approver', '']} rows={(data.data?.items ?? []).map((s: any) => [<span>{s.scope}{s.scopeRef ? ` · ${s.scopeRef}` : ''}</span>, `v${s.version}`, <StatusBadge status={s.status} />, <span className="tiny">{fmtDate(s.effectiveFrom)}{s.effectiveTo ? ` → ${fmtDate(s.effectiveTo)}` : ''}</span>, <span className="tiny">{s.authorId?.slice(0, 8)} / {s.approvedBy?.slice(0, 8) ?? '—'}</span>, <div className="row">{s.status === 'DRAFT' && <ConfirmButton size="sm" onConfirm={() => api.post(`/api/admin/finops/fees/schedules/${s.id}/approve`, {}).then(() => { ok('Approved'); data.reload(); }).catch(err)}>Approve</ConfirmButton>}{s.status === 'APPROVED' && <ConfirmButton size="sm" variant="success" onConfirm={() => api.post(`/api/admin/finops/fees/schedules/${s.id}/activate`, {}).then(() => { ok('Activated'); data.reload(); }).catch(err)}>Activate</ConfirmButton>}{s.status === 'ACTIVE' && <ConfirmButton size="sm" variant="ghost" onConfirm={() => api.post(`/api/admin/finops/fees/schedules/${s.id}/retire`, {}).then(() => { ok('Retired'); data.reload(); }).catch(err)}>Retire</ConfirmButton>}</div>])} empty="No schedules: the flat fee setting applies" />
        <h4 className="mt">Explain a fee</h4>
        <div className="row"><Input placeholder="user id (optional)" value={explain.user} onChange={(e) => setExplain({ ...explain, user: e.target.value })} /><Select value={explain.type} onChange={(e) => setExplain({ ...explain, type: e.target.value })}>{(data.data?.feeTypes ?? ['merchant_payment']).map((t: string) => <option key={t}>{t}</option>)}</Select><Button size="sm" onClick={() => api.get<any>(`/api/admin/finops/fees/effective${qs({ user: explain.user, type: explain.type })}`).then(setResolved).catch(err)}>Resolve</Button></div>
        {resolved && <pre className="mono tiny mt">{JSON.stringify(resolved, null, 2)}</pre>}
      </div>
      <div className="card">
        <h4>New draft</h4>
        <div className="grid cols-2"><Field label="Scope"><Select value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value })}>{['platform', 'country', 'tier', 'merchant'].map((s) => <option key={s}>{s}</option>)}</Select></Field><Field label="Scope reference"><Input value={draft.scopeRef} onChange={(e) => setDraft({ ...draft, scopeRef: e.target.value })} placeholder="CD / gold / user id" /></Field></div>
        <Field label="Rules (JSON: fee type → fixed, bps, min, max in base minor units)"><Textarea rows={8} value={draft.rulesText} onChange={(e) => setDraft({ ...draft, rulesText: e.target.value })} /></Field>
        <Field label="Notes"><Input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></Field>
        <Button onClick={() => { let rules; try { rules = JSON.parse(draft.rulesText); } catch { return err(new Error('Rules must be valid JSON')); } api.post('/api/admin/finops/fees/schedules', { scope: draft.scope, scopeRef: draft.scopeRef || null, rules, notes: draft.notes || null }).then(() => { ok('Draft created'); data.reload(); }).catch(err); }}>Create draft</Button>
      </div>
    </div>
  );
}

function Settlements({ ok, err, money }: { ok: (m: string) => void; err: (e: any) => void; money: (m: number, c: string) => string }) {
  const obligations = useAsync(() => api.get<any>('/api/admin/finops/settlements/obligations'), []);
  const [status, setStatus] = useState('');
  const cycles = useAsync(() => api.get<any>(`/api/admin/finops/settlements/cycles${qs({ status, limit: 100 })}`), [status]);
  const [close, setClose] = useState({ userId: '', currency: 'USD', pay: false });
  return (
    <div>
      <div className="grid cols-3 mb">{Object.entries(obligations.data?.byCurrency ?? {}).map(([cur, v]: any) => <div className="card" key={cur}><div className="stat"><span className="label">Owed · {cur}</span><span className="value">{money(v.netMinor, cur)}</span><span className="small muted">{v.count} cycle(s) · {v.overdue} overdue</span></div></div>)}<div className="card"><h4>Close a cycle</h4><div className="row"><Input placeholder="merchant user id" value={close.userId} onChange={(e) => setClose({ ...close, userId: e.target.value })} /><Input style={{ width: 80 }} value={close.currency} onChange={(e) => setClose({ ...close, currency: e.target.value.toUpperCase() })} /></div><label className="checkbox"><input type="checkbox" checked={close.pay} onChange={(e) => setClose({ ...close, pay: e.target.checked })} /> pay immediately</label><div className="row mt"><Button size="sm" onClick={() => api.post('/api/admin/finops/settlements/cycles', close).then((c: any) => { ok(`Cycle ${c.status}`); cycles.reload(); obligations.reload(); }).catch(err)} disabled={!close.userId}>Close</Button><Button size="sm" variant="secondary" onClick={() => api.post('/api/admin/finops/settlements/run', {}).then((r: any) => { ok(`Run: closed ${r.closed}, paid ${r.paid}`); cycles.reload(); }).catch(err)}>Run schedules now</Button></div></div></div>
      <div className="card">
        <div className="row mb"><Select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 200 }}><option value="">All statuses</option>{['CLOSED', 'PAYING', 'PAID', 'FAILED', 'SKIPPED'].map((s) => <option key={s}>{s}</option>)}</Select></div>
        <Table head={['Cycle', 'Merchant', 'Period', 'Gross', 'Net', 'Status', 'Due', '']} rows={(cycles.data?.items ?? []).map((c: any) => [<span className="mono tiny">{c.id}</span>, <span className="tiny">{c.userId}</span>, <span className="tiny">{c.periodFrom.slice(0, 10)} → {c.periodTo.slice(0, 10)}</span>, money(c.grossMinor, c.currency), <b>{money(c.netMinor, c.currency)}</b>, <StatusBadge status={c.status} />, <span className="tiny">{c.dueAt ? fmtDate(c.dueAt) : '—'}</span>, <div className="row"><a className="btn ghost sm" href={`/api/admin/finops/settlements/cycles/${c.id}/statement?format=pdf`} target="_blank" rel="noreferrer">PDF</a>{c.status === 'CLOSED' && <ConfirmButton size="sm" variant="success" onConfirm={() => api.post(`/api/admin/finops/settlements/cycles/${c.id}/pay`, {}).then(() => { ok('Payout requested'); cycles.reload(); obligations.reload(); }).catch(err)}>Pay</ConfirmButton>}</div>])} empty="No cycles" />
      </div>
    </div>
  );
}

function Disputes({ ok, err, money }: { ok: (m: string) => void; err: (e: any) => void; money: (m: number, c: string) => string }) {
  const [status, setStatus] = useState('');
  const data = useAsync(() => api.get<any>(`/api/admin/finops/disputes${qs({ status })}`), [status]);
  const [sel, setSel] = useState<any>(null);
  const detail = useAsync(() => (sel ? api.get<any>(`/api/admin/finops/disputes/${sel}`) : Promise.resolve(null)), [sel, data.data]);
  const [reason, setReason] = useState('');
  return (
    <div className="grid cols-2">
      <div className="card">
        <div className="row mb"><Select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 220 }}><option value="">All</option>{['OPEN', 'EVIDENCE_REQUESTED', 'UNDER_REVIEW', 'WON', 'LOST', 'WITHDRAWN', 'EXPIRED'].map((s) => <option key={s}>{s}</option>)}</Select></div>
        <Table head={['Dispute', 'Amount', 'Reason', 'Opened by', 'Deadline', 'Status', '']} rows={(data.data?.items ?? []).map((d: any) => [<span className="mono tiny">{d.id}</span>, money(d.amount.valueMinor, d.amount.currency), d.reasonCode, d.openedBy, <span className="tiny">{fmtDate(d.deadlineAt)}</span>, <StatusBadge status={d.status} />, <Button size="sm" variant="secondary" onClick={() => setSel(d.id)}>Open</Button>])} empty="No disputes" />
      </div>
      <div className="card">
        {detail.data && <>
          <h4>{detail.data.reasonCode} · <StatusBadge status={detail.data.status} /></h4>
          <KV k="Merchant" v={detail.data.merchantId} /><KV k="Amount" v={money(detail.data.amount.valueMinor, detail.data.amount.currency)} /><KV k="Rail" v={detail.data.rail} /><KV k="Hold" v={detail.data.holdId ?? '—'} /><KV k="Refund" v={detail.data.refundId ?? '—'} />
          {detail.data.evidence.map((e: any, i: number) => <div key={i} className="card soft compact small"><b>{e.role}</b> · {fmtDate(e.at)}<br />{e.text}</div>)}
          {!['WON', 'LOST', 'WITHDRAWN'].includes(detail.data.status) && <><Field label="Decision reason"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field><div className="row"><ConfirmButton size="sm" variant="success" onConfirm={() => api.post(`/api/admin/finops/disputes/${sel}/decide`, { decision: 'WON', reason }).then(() => { ok('Merchant won'); data.reload(); }).catch(err)}>Merchant wins</ConfirmButton><ConfirmButton size="sm" variant="danger" onConfirm={() => api.post(`/api/admin/finops/disputes/${sel}/decide`, { decision: 'LOST', reason }).then(() => { ok('Refunded to the payer'); data.reload(); }).catch(err)}>Merchant loses (refund)</ConfirmButton><ConfirmButton size="sm" variant="ghost" prompt="Note" onConfirm={(note) => api.post(`/api/admin/finops/disputes/${sel}/request-evidence`, { note: note || 'More evidence needed' }).then(() => { ok('Evidence requested'); data.reload(); }).catch(err)}>Request evidence</ConfirmButton></div></>}
          <h5 className="mt">Chronology</h5>{(detail.data.chronology ?? []).map((e: any, i: number) => <div key={i} className="tiny">{fmtDate(e.at)} · {e.event} · {e.actor}</div>)}
        </>}
        {!detail.data && <p className="small muted">Select a dispute.</p>}
      </div>
    </div>
  );
}

function Holds({ ok, err, money }: { ok: (m: string) => void; err: (e: any) => void; money: (m: number, c: string) => string }) {
  const data = useAsync(() => api.get<any>('/api/admin/finops/holds?status=ACTIVE'), []);
  const [form, setForm] = useState({ userId: '', currency: 'USD', amountMinor: 0, kind: 'reserve', reason: '' });
  return (
    <div className="grid cols-2">
      <div className="card"><Table head={['Hold', 'User', 'Amount', 'Kind', 'Reason', 'Created', '']} rows={(data.data?.items ?? []).map((h: any) => [<span className="mono tiny">{h.id}</span>, <span className="tiny">{h.userId}</span>, money(h.amountMinor, h.currency), h.kind, <span className="tiny">{h.reason}</span>, <span className="tiny">{fmtDate(h.createdAt)}</span>, <ConfirmButton size="sm" variant="ghost" prompt="Release reason" onConfirm={(r) => api.post(`/api/admin/finops/holds/${h.id}/release`, { reason: r || 'released' }).then(() => { ok('Released'); data.reload(); }).catch(err)}>Release</ConfirmButton>])} empty="No active holds" /></div>
      <div className="card"><h4>Place a hold</h4><Field label="User id"><Input value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} /></Field><div className="grid cols-3"><Field label="Currency"><Input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} /></Field><Field label="Amount (minor)"><Input type="number" value={form.amountMinor} onChange={(e) => setForm({ ...form, amountMinor: Number(e.target.value) })} /></Field><Field label="Kind"><Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{['reserve', 'review', 'settlement', 'compliance', 'dispute'].map((k) => <option key={k}>{k}</option>)}</Select></Field></div><Field label="Reason"><Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field><Button onClick={() => api.post('/api/admin/finops/holds', form).then(() => { ok('Hold placed'); data.reload(); }).catch(err)} disabled={!form.userId || form.amountMinor <= 0 || form.reason.length < 3}>Place hold</Button></div>
    </div>
  );
}

function Commissions({ money }: { money: (m: number, c: string) => string }) {
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const data = useAsync(() => api.get<any>(`/api/admin/finops/commissions/overview${qs({ period })}`), [period]);
  return (
    <div className="card">
      <div className="row mb"><Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} style={{ width: 180 }} /><span className="small muted">platform share {data.data?.settings?.platformShareBps ?? 0} bps · onboarding {data.data?.settings?.onboardingFeeMinor}</span></div>
      <Table head={['Agent', 'Kind', 'Currency', 'Count', 'Earned', 'Platform share']} rows={(data.data?.rows ?? []).map((r: any, i: number) => [<span className="tiny">{r.agentUserId}</span>, r.kind, r.currency, r.count, money(r.amountMinor, r.currency), money(r.platformShareMinor, r.currency)])} empty="No commissions this period" />
    </div>
  );
}

function Recon({ ok, err, money }: { ok: (m: string) => void; err: (e: any) => void; money: (m: number, c: string) => string }) {
  const wb = useAsync(() => api.get<any>('/api/admin/finops/reconciliation/workbench'), []);
  const [form, setForm] = useState({ gatewayId: 'sandbox', cycleRef: new Date().toISOString().slice(0, 10), currency: 'USD', csv: 'reference,amountMinor,status,feeMinor\n' });
  const parse = () => form.csv.trim().split(/\r?\n/).slice(1).filter(Boolean).map((l) => { const [reference, amountMinor, status, feeMinor] = l.split(','); return { reference: reference.trim(), amountMinor: Number(amountMinor), currency: form.currency, status: (status ?? 'SETTLED').trim(), feeMinor: feeMinor ? Number(feeMinor) : null }; });
  return (
    <div className="grid cols-2">
      <div className="card">
        <h4>Import a processor statement</h4>
        <div className="grid cols-3"><Field label="Gateway"><Input value={form.gatewayId} onChange={(e) => setForm({ ...form, gatewayId: e.target.value })} /></Field><Field label="Cycle"><Input value={form.cycleRef} onChange={(e) => setForm({ ...form, cycleRef: e.target.value })} /></Field><Field label="Currency"><Input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} /></Field></div>
        <Field label="CSV (reference, amountMinor, status, feeMinor)"><Textarea rows={8} value={form.csv} onChange={(e) => setForm({ ...form, csv: e.target.value })} /></Field>
        <Button onClick={() => api.post('/api/admin/finops/reconciliation/processors/' + form.gatewayId + '/statements', { cycleRef: form.cycleRef, currency: form.currency, lines: parse(), run: true }).then((r: any) => { ok(`Imported ${r.import.lineCount} lines · matched ${r.run?.matched} · cases ${r.run?.casesOpened}`); wb.reload(); }).catch(err)}>Import & run</Button>
      </div>
      <div className="card">
        <h4>Workbench</h4>
        {(wb.data?.exceptions ?? []).map((e: any) => <KV key={`${e.connectionId}-${e.class}`} k={`${e.connectionId} · ${e.class}`} v={`${e.count} · ${money(e.exposureMinor, e.currency ?? 'USD')} · oldest ${e.oldestAgeHours}h`} />)}
        {wb.data?.exceptions?.length === 0 && <Alert kind="success">No open exceptions.</Alert>}
        <h5 className="mt">Recent runs</h5>
        {(wb.data?.recentRuns ?? []).map((r: any) => <div key={r.id} className="tiny">{fmtDate(r.createdAt)} · {r.connectionId} · {r.cycleRef} · matched {r.matched} · cases {r.casesOpened} · {r.complete ? 'complete' : 'incomplete'}</div>)}
      </div>
    </div>
  );
}

/** Bulk payout batches across merchants: oversight, and four-eyes approval by an administrator (audited). */
function PayoutBatches({ ok, err, money }: { ok: (m: string) => void; err: (e: any) => void; money: (m: number, c: string) => string }) {
  const [status, setStatus] = useState('');
  const list = useAsync(() => api.get<any>(`/api/admin/finops/payout-batches${qs({ status: status || undefined })}`), [status]);
  const [selected, setSelected] = useState<any>(null);
  const open = (id: string) => api.get<any>(`/api/admin/finops/payout-batches/${id}`).then(setSelected).catch(err);
  const approve = (id: string) => api.post<any>(`/api/admin/finops/payout-batches/${id}/approve`, {}).then((r) => { setSelected({ batch: r.batch }); list.reload(); ok(`Batch ${r.batch.status.toLowerCase()}: ${r.batch.paidRows} row(s) paid`); }).catch(err);
  const cancel = (id: string) => api.post<any>(`/api/admin/finops/payout-batches/${id}/cancel`, {}).then((r) => { setSelected({ batch: r.batch }); list.reload(); ok('Batch cancelled'); }).catch(err);
  const b = selected?.batch;
  return (
    <div className="grid cols-2">
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h3>Batches</h3>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{['PENDING_APPROVAL', 'EXECUTED', 'PARTIAL', 'FAILED', 'CANCELLED'].map((s) => <option key={s} value={s}>{s}</option>)}</Select>
        </div>
        <Table head={['Merchant', 'Reference', 'Rows', 'Total', 'Status', 'Created']} empty="No batches" rows={(list.data?.items ?? []).map((x: any) => [<a onClick={() => open(x.id)}>{x.owner?.name}</a>, x.reference ?? x.id, `${x.paidRows}/${x.validRows}`, money(x.totalMinor, x.currency), <StatusBadge status={x.status} />, fmtDate(x.createdAt)])} />
      </div>
      <div className="card">
        {!b && <Alert kind="info">Select a batch. Approving here is the second pair of eyes for the merchant's upload: no step-up, but the decision is audited.</Alert>}
        {b && (
          <>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <h3>{b.reference ?? b.id} <StatusBadge status={b.status} /></h3>
              {b.status === 'PENDING_APPROVAL' && (
                <div className="row" style={{ gap: 6 }}>
                  <ConfirmButton size="sm" prompt={`Approve and pay ${b.validRows} rows, ${money(b.totalMinor + b.feeMinor, b.currency)} including fees?`} onConfirm={() => approve(b.id)}>Approve (four-eyes)</ConfirmButton>
                  <ConfirmButton size="sm" variant="ghost" prompt="Cancel this batch?" onConfirm={() => cancel(b.id)}>Cancel</ConfirmButton>
                </div>
              )}
            </div>
            <div className="grid cols-2">
              <KV k="Created by" v={b.createdBy} />
              <KV k="Rows" v={`${b.rowCount} (${b.validRows} valid, ${b.invalidRows} invalid)`} />
              <KV k="Total + fees" v={`${money(b.totalMinor, b.currency)} + ${money(b.feeMinor, b.currency)}`} />
              <KV k="Approval" v={b.approvalMethod ? `${b.approvalMethod} by ${b.approvedBy} · ${fmtDate(b.approvedAt)}` : 'pending'} />
              {selected.readiness && <KV k="Available / needed" v={`${money(selected.readiness.available, b.currency)} / ${money(selected.readiness.needed, b.currency)}`} />}
            </div>
            <Table head={['#', 'Method', 'Destination', 'Amount', 'Status', 'Outcome']} empty="No rows" rows={(b.rows ?? []).map((r: any) => [r.lineNo, r.method, r.method === 'wallet' ? r.destination.to : r.method === 'mobile_money' ? `${r.destination.operatorId} ${r.destination.phone}` : r.destination.bankName ?? r.destination.bankAccountId, money(r.amountMinor, b.currency), <StatusBadge status={r.status} />, r.error ?? (r.transactionId ? r.transactionId.slice(0, 8) : '')])} />
          </>
        )}
      </div>
    </div>
  );
}
