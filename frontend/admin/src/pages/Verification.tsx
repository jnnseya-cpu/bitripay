import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Chip, ConfirmButton, Field, Input, KV, Modal, PageHeader, Select, StepUpButton, Table, Textarea, UserCell, fmtDate, useAsync } from '../components/ui';

const STAGE_KIND: Record<string, 'success' | 'warning' | 'danger' | 'primary' | undefined> = {
  SETTLED: 'success',
  CONFIRMED: 'success',
  MANUAL_REVIEW: 'warning',
  MISMATCHED: 'danger',
  DUPLICATE: 'danger',
  DISPUTED: 'danger',
  REJECTED: 'danger',
  EXPIRED: undefined,
  VERIFYING: 'primary',
  EVIDENCE_RECEIVED: 'primary',
};
const Stage = ({ stage, label }: { stage: string; label?: string }) => <Chip kind={STAGE_KIND[stage]}>{label ?? stage.toLowerCase().replace(/_/g, ' ')}</Chip>;

/**
 * Manual verification console (maker-checker). A verifier reviews the intent, its evidence, the payer's
 * sent-report, risk flags and the full event history, then PROPOSES confirm/reject. A different
 * administrator APPROVES under step-up. Only an approved confirmation can settle.
 */
export function Verification() {
  const { money, toast, user } = useStore();
  const [params, setParams] = useSearchParams();
  const [stage, setStage] = useState('');
  const selected = params.get('payment');
  const data = useAsync(() => api.get<any>(`/api/admin/verifications${qs({ stage })}`), [stage]);
  const c = useAsync(() => (selected ? api.get<any>(`/api/admin/payments/${selected}/case`) : Promise.resolve(null)), [selected, data.data]);
  const [note, setNote] = useState('');
  const [manual, setManual] = useState({ text: '', operatorId: '', from: '' });
  const [manualOpen, setManualOpen] = useState(false);
  const act = (p: Promise<unknown>, msg: string) =>
    p
      .then(() => {
        toast(msg, 'success');
        data.reload();
        c.reload();
      })
      .catch((e) => toast(e.message, 'error'));
  const kase = c.data;
  const p = kase?.payment;
  return (
    <div>
      <PageHeader title="Verification console" subtitle="External payments never settle on their own word. Review the evidence, propose a decision, and let a second administrator approve it." />
      <Alert kind="info">
        Maker-checker is on: the person who proposes a decision cannot approve it. Approvals require your transaction PIN or a passkey step-up. Screenshots and typed references from payers are
        supporting notes only.
      </Alert>
      {(data.data?.pending ?? []).length > 0 && (
        <div className="card mb">
          <h4>Awaiting a second approver</h4>
          <Table
            head={['Item', 'Decision', 'Proposed by', 'Note', 'When', '']}
            rows={data.data.pending.map((v: any) => [
              <span>
                <Chip>{(v.subjectType ?? 'payment').replace('_', ' ')}</Chip>{' '}
                {v.subjectType === 'payment' || !v.subjectType ? (
                  <Button size="sm" variant="ghost" onClick={() => setParams({ payment: v.paymentId })}>
                    <span className="mono tiny">{v.paymentId.slice(0, 8)}…</span>
                  </Button>
                ) : (
                  <span className="mono tiny">
                    {v.paymentId.slice(0, 8)}… {v.externalRef ? `· ref ${v.externalRef}` : ''}
                  </span>
                )}
              </span>,
              <Chip kind={v.action === 'confirm' ? 'success' : 'danger'}>{v.action}</Chip>,
              <UserCell user={v.proposedBy} />,
              <span className="small">
                {v.payload ? (
                  <b>
                    {v.payload.direction} {v.payload.amount} {v.payload.currency} ·{' '}
                  </b>
                ) : null}
                {v.note ?? '—'}
              </span>,
              fmtDate(v.proposedAt),
              v.proposedBy?.id === user?.id ? (
                <span className="tiny muted">you proposed this – another admin must approve</span>
              ) : (
                <div className="row">
                  <StepUpButton
                    size="sm"
                    variant={v.action === 'confirm' ? 'success' : 'danger'}
                    title={`Approve ${v.action}`}
                    onConfirm={(pin) => act(api.post(`/api/admin/verifications/${v.id}/approve`, { pin }), `Decision approved – payment ${v.action === 'confirm' ? 'settled' : 'rejected'}`)}
                  >
                    Approve {v.action}
                  </StepUpButton>
                  <ConfirmButton
                    size="sm"
                    variant="ghost"
                    prompt="Why are you declining?"
                    onConfirm={(r) => act(api.post(`/api/admin/verifications/${v.id}/decline`, { reason: r }), 'Proposal declined')}
                  >
                    Decline
                  </ConfirmButton>
                </div>
              ),
            ])}
          />
        </div>
      )}
      <div className="grid cols-2">
        <div className="card">
          <div className="row mb">
            <h4 style={{ margin: 0 }}>Open intents</h4>
            <Select value={stage} onChange={(e) => setStage(e.target.value)} style={{ width: 200, marginLeft: 'auto' }}>
              <option value="">All open stages</option>
              {Object.keys(data.data?.stages ?? {}).map((s) => (
                <option key={s} value={s}>
                  {data.data.stages[s].label}
                </option>
              ))}
            </Select>
          </div>
          <Table
            head={['Amount', 'Rail', 'Payer', 'Stage', 'Created', '']}
            rows={(data.data?.queue ?? []).map((q: any) => [
              <b>{money(q.amount, q.currency)}</b>,
              <span className="small">
                {q.method.replace('_', ' ')}
                <br />
                <span className="tiny muted">
                  {q.gatewayName} · <span className="mono">{q.providerRef}</span>
                </span>
              </span>,
              q.user ? <UserCell user={q.user} /> : <span className="tiny muted">guest</span>,
              <Stage stage={q.stage} label={q.stageLabel} />,
              <span className="small">{fmtDate(q.createdAt)}</span>,
              <Button size="sm" variant={selected === q.id ? undefined : 'secondary'} onClick={() => setParams({ payment: q.id })}>
                Review
              </Button>,
            ])}
            empty="Nothing waiting for verification"
          />
        </div>
        <div className="card">
          {!p && <div className="muted small">Select a payment to see its evidence, decisions and full history.</div>}
          {p && (
            <>
              <div className="row mb">
                <h4 style={{ margin: 0 }}>
                  {money(p.amount, p.currency)} · {p.method.replace('_', ' ')}
                </h4>
                <Stage stage={p.stage} label={p.stageLabel} />
              </div>
              <div className="small muted mb">{p.stageDescription}</div>
              <div className="grid cols-2">
                <div>
                  <KV k="Gateway / rail" v={`${p.gatewayName}`} />
                  <KV k="Reference" v={<span className="mono">{p.providerRef ?? '—'}</span>} />
                  <KV k="Purpose" v={p.purpose} />
                  <KV k="Authorised by" v={p.authMethod ? `${p.authMethod} · ${fmtDate(p.authenticatedAt)}` : <Chip kind="danger">not authenticated</Chip>} />
                  <KV k="Expires" v={fmtDate(p.expiresAt)} />
                </div>
                <div>
                  <KV k="Account" v={kase.user ? <UserCell user={kase.user} /> : 'guest'} />
                  <KV
                    k="Payer"
                    v={
                      <span className="small">
                        {kase.payer.name ?? '—'}
                        <br />
                        {kase.payer.phone ?? ''} {kase.payer.email ?? ''}
                      </span>
                    }
                  />
                  <KV k="Fee" v={money(p.fee, p.currency)} />
                  <KV k="Ledger tx" v={p.transactionId ? <span className="mono tiny">{p.transactionId}</span> : '—'} />
                </div>
              </div>
              {kase.riskFlags?.length > 0 && <Alert kind="warning">Risk flags: {kase.riskFlags.join(', ')}</Alert>}
              {kase.proof && (
                <Alert kind="info">
                  <b>Payer's sent-report (not authoritative):</b> reference {kase.proof.reference ?? '—'}
                  {kase.proof.note ? ` · ${kase.proof.note}` : ''}
                  {kase.proof.hasImage ? ' · screenshot attached' : ''} · {fmtDate(kase.proof.submittedAt)}
                  {kase.proof.image && (
                    <div>
                      <img src={kase.proof.image} alt="" style={{ maxHeight: 160, marginTop: 6, borderRadius: 6 }} />
                    </div>
                  )}
                </Alert>
              )}
              <h5 className="mt">Evidence ({kase.evidence.length})</h5>
              {kase.evidence.length === 0 && <div className="muted small">No operator/bank evidence received yet.</div>}
              {kase.evidence.map((e: any) => (
                <div key={e.id} className="card soft compact mb-sm">
                  <div className="row wrap">
                    <Chip kind={e.outcome === 'settled' || e.outcome === 'matched' ? 'success' : e.outcome === 'review' ? 'warning' : 'danger'}>{e.outcome}</Chip>
                    <Chip>{e.source.replace('_', ' ')}</Chip>
                    <Chip kind={e.confidence >= 80 ? 'success' : e.confidence >= 50 ? 'warning' : 'danger'}>confidence {e.confidence}</Chip>
                    {e.deviceId && <span className="tiny muted">device {e.deviceId.slice(0, 8)}…</span>}
                    <span className="tiny muted">{fmtDate(e.createdAt)}</span>
                  </div>
                  <div className="mono tiny mt-sm" style={{ whiteSpace: 'pre-wrap' }}>
                    {e.rawText}
                  </div>
                  <div className="tiny mt-sm">
                    Parsed: ref <b>{e.parsed.reference ?? '—'}</b> · amount{' '}
                    <b>
                      {e.parsed.amount ?? '—'} {e.parsed.currency ?? ''}
                    </b>{' '}
                    · operator txn <b>{e.parsed.externalRef ?? '—'}</b> · sender{' '}
                    <b>
                      {e.parsed.senderName ?? ''} {e.parsed.senderPhone ?? ''}
                    </b>
                    {e.parsed.balance ? ` · balance ${e.parsed.balance}` : ''}
                  </div>
                  {e.reasons.length > 0 && (
                    <div className="tiny" style={{ color: 'var(--danger)' }}>
                      {e.reasons.join(', ')}
                    </div>
                  )}
                  <div className="tiny muted">
                    verifier: {e.verifier.type} {e.verifier.id ? e.verifier.id.slice(0, 8) : ''} · hash {e.rawHash.slice(0, 12)}…
                  </div>
                </div>
              ))}
              <div className="row mb">
                <Button size="sm" variant="secondary" onClick={() => setManualOpen(true)}>
                  + Enter statement line / SMS manually
                </Button>
              </div>
              <h5>Decisions</h5>
              {kase.verifications.length === 0 && <div className="muted small">No decision proposed yet.</div>}
              {kase.verifications.map((v: any) => (
                <div key={v.id} className="small mb-sm">
                  <Chip kind={v.status === 'approved' ? 'success' : v.status === 'declined' ? 'danger' : 'warning'}>{v.status}</Chip> <b>{v.action}</b> proposed by {v.proposedBy?.fullName ?? '?'}{' '}
                  {fmtDate(v.proposedAt)}
                  {v.approvedBy ? ` · approved by ${v.approvedBy.fullName} ${fmtDate(v.approvedAt)}` : ''}
                  {v.declinedBy ? ` · declined by ${v.declinedBy.fullName}: ${v.declineReason}` : ''}
                  {v.note ? ` · "${v.note}"` : ''}
                </div>
              ))}
              {!['SETTLED', 'REJECTED', 'EXPIRED', 'REVERSED'].includes(p.stage) && !kase.verifications.some((v: any) => v.status === 'proposed') && (
                <div className="card soft compact">
                  <Field label="Verifier note (what you checked: statement line, operator portal, receipt id)">
                    <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
                  </Field>
                  <div className="row">
                    <ConfirmButton variant="success" onConfirm={() => act(api.post(`/api/admin/payments/${p.id}/confirm`, { note }), 'Confirmation proposed – a second admin must approve')}>
                      Propose: confirm received
                    </ConfirmButton>
                    <ConfirmButton
                      variant="danger"
                      prompt="Reason shown to the payer"
                      onConfirm={(r) => act(api.post(`/api/admin/payments/${p.id}/reject`, { reason: r }), 'Rejection proposed – a second admin must approve')}
                    >
                      Propose: reject
                    </ConfirmButton>
                  </div>
                </div>
              )}
              <h5 className="mt">History (immutable event log)</h5>
              <div style={{ maxHeight: 260, overflow: 'auto' }}>
                {kase.events.map((e: any) => (
                  <div key={e.id} className="tiny mb-sm">
                    <span className="muted">{fmtDate(e.createdAt)}</span> · <span className="mono">{e.event}</span> · {e.actor.type}
                    {e.actor.id ? ` ${String(e.actor.id).slice(0, 8)}` : ''}
                    {e.details?.from ? ` · ${e.details.from} → ${e.details.to}` : ''}
                    {e.details?.reason ? ` · ${e.details.reason}` : ''}
                    {e.details?.method ? ` · ${e.details.method}` : ''}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <Modal open={manualOpen} onClose={() => setManualOpen(false)} title="Manual evidence (needs maker-checker approval)">
        <Alert kind="warning">
          Paste the exact SMS or statement line. It is parsed and matched like device evidence but is never authoritative on its own – a second administrator still has to approve the settlement.
        </Alert>
        <Field label="Message / statement line">
          <Textarea rows={4} value={manual.text} onChange={(e) => setManual({ ...manual, text: e.target.value })} />
        </Field>
        <div className="grid cols-2">
          <Field label="Operator id (optional)">
            <Input value={manual.operatorId} onChange={(e) => setManual({ ...manual, operatorId: e.target.value })} placeholder="mpesa_ke" />
          </Field>
          <Field label="Sender (optional)">
            <Input value={manual.from} onChange={(e) => setManual({ ...manual, from: e.target.value })} placeholder="MPESA" />
          </Field>
        </div>
        <Button
          disabled={manual.text.length < 5 || !p}
          onClick={() =>
            act(api.post(`/api/admin/payments/${p.id}/evidence`, { text: manual.text, operatorId: manual.operatorId || null, from: manual.from || null }), 'Evidence recorded').then(() => {
              setManualOpen(false);
              setManual({ text: '', operatorId: '', from: '' });
            })
          }
        >
          Record evidence
        </Button>
      </Modal>
    </div>
  );
}
