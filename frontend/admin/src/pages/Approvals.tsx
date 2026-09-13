import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, ConfirmButton, KV, Modal, PageHeader, Select, StatusBadge, StepUpButton, Table, Tabs, UserCell, fmtDate, useAsync, Alert } from '../components/ui';
import { Link } from 'react-router-dom';

export function Approvals() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'withdrawals';
  const { money, toast } = useStore();
  const [status, setStatus] = useState('pending');
  const withdrawals = useAsync(() => (tab === 'withdrawals' ? api.get<any>(`/api/admin/withdrawals${qs({ status, pageSize: 50 })}`) : Promise.resolve(null)), [tab, status]);
  const deposits = useAsync(() => (tab === 'deposits' ? api.get<any>(`/api/admin/payments${qs({ status: status === 'pending' ? 'pending' : status, pageSize: 50 })}`) : Promise.resolve(null)), [tab, status]);
  const remittances = useAsync(() => (tab === 'remittances' ? api.get<any>(`/api/admin/remittances${qs({ status: status === 'pending' ? 'pending' : status })}`) : Promise.resolve(null)), [tab, status]);
  const settlements = useAsync(() => (tab === 'settlements' ? api.get<any>('/api/admin/settlements') : Promise.resolve(null)), [tab]);
  const act = (p: Promise<unknown>, msg: string) => p.then(() => { toast(msg, 'success'); withdrawals.reload(); deposits.reload(); remittances.reload(); settlements.reload(); }).catch((e) => toast(e.message, 'error'));
  return (
    <div>
      <PageHeader title="Approvals" subtitle="Withdrawals, bank deposits, remittance payouts and merchant settlements" />
      <Tabs tabs={[{ id: 'withdrawals', label: 'Withdrawals' }, { id: 'deposits', label: 'Bank & mobile money deposits' }, { id: 'remittances', label: 'Remittances' }, { id: 'settlements', label: 'Settlements' }]} value={tab} onChange={(t) => setParams({ tab: t })} />
      <div className="card">
        {tab !== 'settlements' && <div className="row mb"><Select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 160 }}><option value="pending">Pending</option><option value="completed">Completed</option><option value="succeeded">Succeeded</option><option value="rejected">Rejected</option><option value="failed">Failed</option><option value="">All</option></Select></div>}
        {tab === 'withdrawals' && (
          <Table head={['User', 'Amount', 'Fee', 'Destination', 'Requested', 'Status', '']} rows={(withdrawals.data?.items ?? []).map((t: any) => [
            <UserCell user={t.sender} />, <b>{money(t.amount, t.currency)}</b>, money(t.fee, t.currency),
            t.metadata?.method === 'mobile_money' ? <span className="small">📱 {t.metadata.operator?.name} ({t.metadata.operator?.country})<br /><span className="mono">{t.metadata.phone}</span>{t.metadata.recipientName ? ` · ${t.metadata.recipientName}` : ''}</span> : <span className="small">🏦 {t.metadata?.bankAccount?.bankName}<br />{t.metadata?.bankAccount?.accountName} · {t.metadata?.bankAccount?.accountNumber}</span>, <span className="small">{fmtDate(t.createdAt)}</span>, <StatusBadge status={t.status} />,
            t.status === 'pending' ? <div className="row"><StepUpButton size="sm" variant="success" prompt="Payout reference (bank / operator transaction id)" title="Confirm payout was executed" onConfirm={(pin, r) => act(api.post(`/api/admin/withdrawals/${t.id}/approve`, { payoutReference: r, pin }), 'Withdrawal approved')}>Approve</StepUpButton><StepUpButton size="sm" variant="danger" prompt="Reason" title="Reject payout" onConfirm={(pin, r) => act(api.post(`/api/admin/withdrawals/${t.id}/reject`, { reason: r, pin }), 'Withdrawal rejected')}>Reject</StepUpButton></div> : null,
          ])} />
        )}
        {tab === 'deposits' && (
          <>
          <Alert kind="info">Bank and mobile money deposits are settled only through the <Link to="/verification">verification console</Link>: evidence is matched, one administrator proposes and a second approves under step-up.</Alert>
          <Table head={['User / payer', 'Amount', 'Method', 'Gateway', 'Sent-report', 'Created', 'Stage', '']} rows={(deposits.data?.items ?? []).map((p: any) => [
            p.user ? <UserCell user={p.user} /> : <span className="small">{p.payerName}<br />{p.payerEmail}</span>, <b>{money(p.amount, p.currency)}</b>, p.method.replace('_', ' '), <span className="small">{p.gatewayName}<br /><span className="mono tiny">{p.providerRef}</span></span>,
            p.proof ? <span className="small">{p.proof.reference}{p.proof.note ? ` · ${p.proof.note}` : ''}</span> : <span className="muted small">—</span>, <span className="small">{fmtDate(p.createdAt)}</span>, <StatusBadge status={p.stageLabel ?? p.status} />,
            ['pending', 'initiated'].includes(p.status) ? <Link className="btn sm secondary" to={`/verification?payment=${p.id}`}>Review in console</Link> : null,
          ])} />
          </>
        )}
        {tab === 'remittances' && (
          <Table head={['Sender', 'Recipient', 'Send', 'Payout', 'Method', 'Created', 'Status', '']} rows={(remittances.data?.items ?? []).map((r: any) => [
            <UserCell user={r.sender} />, <span className="small">{r.recipient?.name}<br /><span className="muted">{r.recipient?.bankName ? `${r.recipient.bankName} · ${r.recipient.accountNumber}` : r.recipient?.country ?? ''}</span></span>, money(r.sourceAmount, r.sourceCurrency), <b>{money(r.targetAmount, r.targetCurrency)}</b>, <span>{r.payoutMethod.replace('_', ' ')}{r.pickupCode && <><br /><span className="mono tiny">{r.pickupCode}</span></>}</span>, <span className="small">{fmtDate(r.createdAt)}</span>, <StatusBadge status={r.status} />,
            ['pending', 'processing'].includes(r.status) ? <div className="row"><StepUpButton size="sm" variant="success" title="Confirm payout executed" onConfirm={(pin) => act(api.post(`/api/admin/remittances/${r.id}/settle`, { outcome: 'completed', pin }), 'Marked as paid out')}>Paid out</StepUpButton><StepUpButton size="sm" variant="danger" prompt="Reason" title="Refund remittance" onConfirm={(pin, reason) => act(api.post(`/api/admin/remittances/${r.id}/settle`, { outcome: 'rejected', reason, pin }), 'Remittance refunded')}>Refund</StepUpButton></div> : r.status === 'ready_for_pickup' ? <StepUpButton size="sm" variant="danger" prompt="Reason" title="Cancel remittance" onConfirm={(pin, reason) => act(api.post(`/api/admin/remittances/${r.id}/settle`, { outcome: 'rejected', reason, pin }), 'Remittance cancelled')}>Cancel & refund</StepUpButton> : null,
          ])} />
        )}
        {tab === 'settlements' && (
          <>
            <div className="row mb"><Button variant="secondary" onClick={() => act(api.post('/api/admin/settlements/run'), 'Settlement run completed')}>Run automated settlement now</Button><span className="small muted">Sweeps merchant balances above the threshold into pending withdrawals (Fees & limits → automated settlement).</span></div>
            <Table head={['Merchant', 'Amount', 'Reference', 'Created', 'Status']} rows={(settlements.data?.items ?? []).map((s: any) => [s.merchant ?? s.userId, money(s.amount, s.currency), <span className="mono small">{s.reference}</span>, fmtDate(s.createdAt), <StatusBadge status={s.status} />])} />
          </>
        )}
      </div>
    </div>
  );
}

export function Kyc() {
  const { toast } = useStore();
  const [status, setStatus] = useState('pending');
  const list = useAsync(() => api.get<any>(`/api/admin/kyc${qs({ status, pageSize: 50 })}`), [status]);
  const [sel, setSel] = useState<any>(null);
  const open = async (id: string) => setSel((await api.get<any>(`/api/admin/kyc/${id}`)).submission);
  const review = (decision: 'verified' | 'rejected', note?: string) => api.post(`/api/admin/kyc/${sel.id}/review`, { decision, note }).then(() => { toast(`Submission ${decision}`, 'success'); setSel(null); list.reload(); }).catch((e) => toast(e.message, 'error'));
  return (
    <div>
      <PageHeader title="KYC verification" subtitle="Review identity documents and approve or reject submissions" actions={<Select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 160 }}><option value="pending">Pending</option><option value="verified">Verified</option><option value="rejected">Rejected</option><option value="">All</option></Select>} />
      <div className="card">
        <Table head={['User', 'Document', 'Name', 'Submitted', 'Status', '']} rows={(list.data?.items ?? []).map((k: any) => [<UserCell user={k.user} />, <span>{k.docType.replace('_', ' ')} · <span className="mono">{k.docNumber}</span></span>, k.fullName, fmtDate(k.createdAt), <StatusBadge status={k.status} />, <Button size="sm" variant="secondary" onClick={() => open(k.id)}>Review</Button>])} empty="No submissions" />
      </div>
      <Modal open={!!sel} onClose={() => setSel(null)} title="KYC submission" wide>
        {sel && (
          <div className="grid cols-2">
            <div>
              <KV k="User" v={<UserCell user={sel.user} />} /><KV k="Document" v={`${sel.docType} · ${sel.docNumber}`} /><KV k="Legal name" v={sel.fullName} /><KV k="Date of birth" v={sel.dob ?? '—'} /><KV k="Address" v={sel.address ?? '—'} /><KV k="Submitted" v={fmtDate(sel.createdAt)} /><KV k="Status" v={<StatusBadge status={sel.status} />} />
              {sel.note && <Alert kind="info">Note: {sel.note}</Alert>}
              {sel.status === 'pending' && <div className="row mt"><ConfirmButton variant="success" onConfirm={() => review('verified')}>Approve</ConfirmButton><ConfirmButton variant="danger" prompt="Rejection reason (shown to user)" onConfirm={(r) => review('rejected', r)}>Reject</ConfirmButton></div>}
            </div>
            <div className="col">
              {[['Document front', sel.docFront], ['Document back', sel.docBack], ['Selfie', sel.selfie]].map(([label, src]) => <div key={label as string}><div className="small bold">{label}</div>{src ? <img src={src as string} alt={label as string} style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid var(--border)' }} /> : <div className="muted small">Not provided</div>}</div>)}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
