import { useState } from 'react';
import { api, qs } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Chip, ConfirmButton, Field, Input, KV, Modal, PageHeader, Select, StatusBadge, StepUpButton, Table, Tabs, Textarea, UserCell, fmtDate, useAsync } from '../components/ui';

const STAGE_KIND: Record<string, 'success' | 'warning' | 'danger' | 'primary' | undefined> = { SETTLED: 'success', QUEUED: 'primary', IN_PROGRESS: 'primary', EVIDENCE_RECEIVED: 'primary', VERIFYING: 'primary', MANUAL_REVIEW: 'warning', INSUFFICIENT_LIQUIDITY: 'warning', MISMATCHED: 'danger', DUPLICATE: 'danger', FAILED: 'danger', EXPIRED: undefined, CANCELLED: undefined };
const Stage = ({ stage }: { stage: string }) => <Chip kind={STAGE_KIND[stage]}>{stage.toLowerCase().replace(/_/g, ' ')}</Chip>;

/** Corridor registry, prefunded liquidity, payout instructions (device / agent execution) and chargebacks. */
export function Corridors() {
  const { toast, money, config, user } = useStore();
  const [tab, setTab] = useState<'corridors' | 'liquidity' | 'payouts' | 'chargebacks'>('corridors');
  const corridors = useAsync(() => api.get<any>('/api/admin/corridors'), [tab]);
  const liquidity = useAsync(() => (tab === 'liquidity' ? api.get<any>('/api/admin/liquidity') : Promise.resolve(null)), [tab]);
  const [stage, setStage] = useState('');
  const payouts = useAsync(() => (tab === 'payouts' ? api.get<any>(`/api/admin/payouts${qs({ stage, pageSize: 100 })}`) : Promise.resolve(null)), [tab, stage]);
  const chargebacks = useAsync(() => (tab === 'chargebacks' ? api.get<any>('/api/admin/chargebacks') : Promise.resolve(null)), [tab]);
  const [sel, setSel] = useState<string | null>(null);
  const kase = useAsync(() => (sel ? api.get<any>(`/api/admin/payouts/${sel}`) : Promise.resolve(null)), [sel, payouts.data]);
  const [corridorEdit, setCorridorEdit] = useState<any>(null);
  const [goLive, setGoLive] = useState<any>(null);
  const [acct, setAcct] = useState<any>(null);
  const [settle, setSettle] = useState({ externalRef: '', note: '' });
  const [cbOpen, setCbOpen] = useState({ paymentId: '', reason: '' });
  const ok = (msg: string) => { toast(msg, 'success'); corridors.reload(); liquidity.reload(); payouts.reload(); chargebacks.reload(); kase.reload(); };
  const err = (e: any) => toast(e.message, 'error');
  const compliance = corridors.data?.compliance;
  return (
    <div>
      <PageHeader title="Corridors, liquidity & payouts" subtitle="Where money can go, the prefunded local accounts that pay it out, the devices and agents that execute payouts, and the disputes." actions={<Button onClick={() => setCorridorEdit({ sourceCountry: 'GB', sourceCurrency: 'GBP', destCountry: 'CD', destCurrency: 'CDF', operatorId: 'orange_cd', rail: 'mobile_money', estimatedPayoutMinutes: 30, maxAmount: 0, notes: '' })}>+ Corridor</Button>} />
      {compliance && (compliance.mode === 'sandbox' ? <Alert kind="warning"><b>Sandbox mode.</b> Live customer funds are not accepted: real card processors are refused on every corridor until the platform is switched to live in Gateway controls and each corridor records its authorised collection partner, payout partner and licence reference. Cross-border transfers are a regulated money-transfer service regardless of how payouts are executed.</Alert> : <Alert kind="info"><b>Live mode.</b> Only corridors marked live accept real processor funds; all others stay sandbox.</Alert>)}
      <Tabs tabs={[{ id: 'corridors', label: 'Corridors' }, { id: 'liquidity', label: 'Liquidity & payout accounts' }, { id: 'payouts', label: 'Payout instructions' }, { id: 'chargebacks', label: 'Chargebacks & disputes' }]} value={tab} onChange={(v) => setTab(v as any)} />
      {tab === 'corridors' && (
        <div className="card">
          <Table head={['Corridor', 'Rail / operator', 'Status', 'Arrangements', 'ETA', 'Max', '']} rows={(corridors.data?.items ?? []).map((c: any) => [
            <b>{c.sourceCountry ?? '*'} {c.sourceCurrency} → {c.destCountry} {c.destCurrency}</b>, <span className="small">{c.rail}{c.operatorId ? ` · ${c.operatorId}` : ' · any operator'}</span>, <Chip kind={c.status === 'live' ? 'success' : c.status === 'suspended' ? 'danger' : 'warning'}>{c.status}</Chip>,
            <span className="tiny">{c.readiness.ready ? <Chip kind="success">arrangements complete</Chip> : <Chip kind="warning">{c.readiness.missing.length} missing</Chip>}<br />{c.collectionPartner && <>in: {c.collectionPartner}<br /></>}{c.payoutPartner && <>out: {c.payoutPartner}<br /></>}{c.licenceRef && <>licence: {c.licenceRef}</>}{c.licenceExpiresAt ? <><br />expires {new Date(c.licenceExpiresAt).toLocaleDateString()}</> : null}{c.approvedBy ? <><br />live since {fmtDate(c.approvedAt)}</> : null}{c.readiness.missing.length > 0 && <><br /><span style={{ color: 'var(--danger)' }}>{c.readiness.missing.join('; ')}</span></>}{c.readiness.warnings.length > 0 && <><br /><span className="muted">{c.readiness.warnings.join('; ')}</span></>}</span>, `${c.estimatedPayoutMinutes} min`, c.maxAmount ? c.maxAmount : '—',
            <div className="row"><Button size="sm" variant="secondary" onClick={() => setCorridorEdit({ ...c })}>Edit</Button><Button size="sm" variant={c.status === 'live' ? 'ghost' : undefined} onClick={() => setGoLive({ ...c, nextStatus: c.status === 'live' ? 'suspended' : 'live' })}>{c.status === 'live' ? 'Suspend' : 'Go live'}</Button><ConfirmButton size="sm" variant="ghost" onConfirm={() => api.del(`/api/admin/corridors/${c.id}`).then(() => ok('Deleted')).catch(err)}>Delete</ConfirmButton></div>,
          ])} empty="No corridors yet – they are also registered automatically when a customer requests one (sandbox)" />
        </div>
      )}
      {tab === 'liquidity' && (
        <>
          <div className="card mb">
            <div className="row"><h4 style={{ margin: 0 }}>Prefunded payout accounts</h4><Button size="sm" style={{ marginLeft: 'auto' }} onClick={() => setAcct({ rail: 'mobile_money', operatorId: 'orange_cd', country: 'CD', currency: 'CDF', label: '', msisdn: '', simIccid: '', agentUserId: '', dailyLimit: 0, perTxLimit: 0 })}>+ Payout account</Button></div>
            <p className="small muted">A card receipt in the UK never turns into mobile money: recipients are paid from these local balances (merchant SIMs / treasury bank accounts) and the corridor is rebalanced later. Each account has its own ledger float wallet; prefunding is a step-up protected treasury posting.</p>
            <Table head={['Account', 'Rail / operator', 'Float', 'Paid today', 'Queued demand', 'Shortfall', 'Agent', 'Device', 'Status', '']} rows={(liquidity.data?.items ?? []).map((a: any) => [
              <span><b>{a.label}</b><br /><span className="mono tiny">{a.msisdn ?? a.accountNumber ?? ''}</span></span>, <span className="small">{a.rail}{a.operatorName ? ` · ${a.operatorName}` : ''} · {a.country}</span>, <b>{money(a.balance, a.currency)}</b>, money(a.paidToday, a.currency), money(a.queuedDemand, a.currency), a.shortfall > 0 ? <Chip kind="danger">{money(a.shortfall, a.currency)}</Chip> : <Chip kind="success">none</Chip>, a.agent ? <UserCell user={a.agent} /> : <span className="muted tiny">treasury</span>, a.deviceId ? <span className="mono tiny">{a.deviceId.slice(0, 8)}</span> : <span className="tiny muted">none</span>, <StatusBadge status={a.status} />,
              <div className="row"><StepUpButton size="sm" variant="success" prompt="Amount to prefund (major units) – reference in the note" title="Prefund float" onConfirm={(pin, amount) => api.post(`/api/admin/liquidity/accounts/${a.id}/prefund`, { amount, pin, reference: `PREFUND-${Date.now()}` }).then((r: any) => ok(`Prefunded · ${r.requeued} waiting payouts re-queued`)).catch(err)}>Prefund</StepUpButton><StepUpButton size="sm" variant="secondary" prompt="Signed delta (e.g. -12.50) to match the real SIM balance" title="Reconcile float" onConfirm={(pin, delta) => api.post(`/api/admin/liquidity/accounts/${a.id}/adjust`, { delta, pin, note: 'Reconciled to operator balance' }).then(() => ok('Adjusted')).catch(err)}>Adjust</StepUpButton><Button size="sm" variant="ghost" onClick={() => api.patch(`/api/admin/liquidity/accounts/${a.id}`, { status: a.status === 'active' ? 'paused' : 'active' }).then(() => ok('Updated')).catch(err)}>{a.status === 'active' ? 'Pause' : 'Activate'}</Button></div>,
            ])} empty="No payout accounts – payouts will wait on liquidity" />
          </div>
        </>
      )}
      {tab === 'payouts' && (
        <div className="grid cols-2">
          <div className="card">
            <div className="row mb"><h4 style={{ margin: 0 }}>Instructions</h4><Select value={stage} onChange={(e) => setStage(e.target.value)} style={{ width: 200, marginLeft: 'auto' }}><option value="">All stages</option>{['QUEUED', 'IN_PROGRESS', 'EVIDENCE_RECEIVED', 'VERIFYING', 'MANUAL_REVIEW', 'MISMATCHED', 'DUPLICATE', 'INSUFFICIENT_LIQUIDITY', 'SETTLED', 'FAILED', 'EXPIRED', 'CANCELLED'].map((s) => <option key={s} value={s}>{s.toLowerCase().replace(/_/g, ' ')}</option>)}</Select></div>
            {(payouts.data?.pending ?? []).length > 0 && <Alert kind="warning">{payouts.data.pending.length} decision(s) await a second approver in the <a href="/verification">verification console</a>.</Alert>}
            <Table head={['Ref', 'Amount', 'To', 'Account', 'Stage', 'Created', '']} rows={(payouts.data?.items ?? []).map((p: any) => [
              <span className="mono small">{p.reference}</span>, <b>{money(p.amount, p.currency)}</b>, <span className="small">{p.operatorName ?? p.rail}<br /><span className="mono tiny">{p.recipientMasked}</span></span>, <span className="tiny">{p.payoutAccount?.label ?? <span className="muted">unassigned</span>}</span>, <Stage stage={p.stage} />, <span className="small">{fmtDate(p.createdAt)}</span>, <Button size="sm" variant={sel === p.id ? undefined : 'secondary'} onClick={() => setSel(p.id)}>Open</Button>,
            ])} empty="No payout instructions" />
          </div>
          <div className="card">
            {!kase.data && <div className="muted small">Select a payout to see its evidence, events and actions.</div>}
            {kase.data && (() => { const p = kase.data.payout; return (
              <>
                <div className="row mb"><h4 style={{ margin: 0 }}>{money(p.amount, p.currency)} · {p.operatorName ?? p.rail}</h4><Stage stage={p.stage} /></div>
                <KV k="Reference" v={<span className="mono">{p.reference}</span>} /><KV k="Recipient" v={`${p.recipientMsisdn ?? ''}${p.recipientName ? ` · ${p.recipientName}` : ''}`} /><KV k="Sender" v={kase.data.sender ? <UserCell user={kase.data.sender} /> : '—'} /><KV k="Payout account" v={p.payoutAccount?.label ?? 'unassigned'} /><KV k="Claimed" v={p.claimedAt ? `${fmtDate(p.claimedAt)} · ${p.claimedByDeviceId ? `device ${p.claimedByDeviceId.slice(0, 8)}` : `agent ${p.claimedByUserId?.slice(0, 8)}`}` : '—'} /><KV k="Held transaction" v={kase.data.transaction ? `${kase.data.transaction.reference} · ${kase.data.transaction.status}` : '—'} />{p.externalRef && <KV k="Operator ref" v={<span className="mono">{p.externalRef}</span>} />}
                {p.riskFlags.length > 0 && <Alert kind="warning">{p.riskFlags.join(', ')}</Alert>}
                {p.error && <div className="tiny" style={{ color: 'var(--danger)' }}>{p.error}</div>}
                <h5 className="mt">Evidence ({kase.data.evidence.length})</h5>
                {kase.data.evidence.map((e: any) => <div key={e.id} className="card soft compact mb-sm"><div className="row wrap"><Chip kind={e.outcome === 'settled' ? 'success' : e.outcome === 'review' ? 'warning' : 'danger'}>{e.outcome}</Chip><Chip>{e.source.replace('_', ' ')}</Chip>{e.simIdentity && <span className="tiny">SIM …{String(e.simIdentity).slice(-4)}</span>}<span className="tiny muted">{fmtDate(e.createdAt)}</span></div><div className="mono tiny mt-sm" style={{ whiteSpace: 'pre-wrap' }}>{e.rawText}</div><div className="tiny">recipient <b>{e.parsed.recipient ?? '—'}</b> · amount <b>{e.parsed.amount ?? '—'} {e.parsed.currency ?? ''}</b> · operator ref <b>{e.parsed.externalRef ?? '—'}</b></div>{e.reasons.length > 0 && <div className="tiny" style={{ color: 'var(--danger)' }}>{e.reasons.join(', ')}</div>}</div>)}
                {!['SETTLED', 'CANCELLED'].includes(p.stage) && (
                  <div className="card soft compact mt">
                    <div className="row wrap mb-sm">
                      {['INSUFFICIENT_LIQUIDITY', 'FAILED', 'EXPIRED', 'MANUAL_REVIEW', 'MISMATCHED', 'DUPLICATE'].includes(p.stage) && <Button size="sm" onClick={() => api.post(`/api/admin/payouts/${p.id}/requeue`).then(() => ok('Re-queued')).catch(err)}>Re-queue</Button>}
                      {p.stage === 'IN_PROGRESS' && <ConfirmButton size="sm" variant="secondary" prompt="Reason" onConfirm={(r) => api.post(`/api/admin/payouts/${p.id}/release`, { reason: r }).then(() => ok('Released to queue')).catch(err)}>Release claim</ConfirmButton>}
                      <StepUpButton size="sm" variant="danger" prompt="Reason" title="Cancel payout (funds back to sender)" onConfirm={(pin, r) => api.post(`/api/admin/payouts/${p.id}/cancel`, { reason: r, pin }).then(() => ok('Cancelled')).catch(err)}>Cancel</StepUpButton>
                      <ConfirmButton size="sm" variant="danger" prompt="Reason (proposal – a second admin approves)" onConfirm={(r) => api.post(`/api/admin/payouts/${p.id}/fail`, { reason: r }).then(() => ok('Failure proposed')).catch(err)}>Propose: failed</ConfirmButton>
                    </div>
                    <div className="small bold">Administrative settlement (exception – documentary evidence + second approver)</div>
                    <div className="grid cols-2"><Field label="Operator / bank transaction reference"><Input value={settle.externalRef} onChange={(e) => setSettle({ ...settle, externalRef: e.target.value })} /></Field><Field label="What you checked (statement line, portal, receipt id)"><Input value={settle.note} onChange={(e) => setSettle({ ...settle, note: e.target.value })} /></Field></div>
                    <Button size="sm" disabled={settle.externalRef.length < 4 || settle.note.length < 8} onClick={() => api.post(`/api/admin/payouts/${p.id}/settle`, settle).then(() => { ok('Settlement proposed – awaiting a second administrator'); setSettle({ externalRef: '', note: '' }); }).catch(err)}>Propose: settled</Button>
                  </div>
                )}
                <h5 className="mt">History</h5>
                <div style={{ maxHeight: 220, overflow: 'auto' }}>{kase.data.events.map((e: any) => <div key={e.id} className="tiny mb-sm"><span className="muted">{fmtDate(e.createdAt)}</span> · <span className="mono">{e.event}</span> · {e.actor.type}{e.details?.reasons ? ` · ${e.details.reasons.join(', ')}` : ''}</div>)}</div>
              </>
            ); })()}
          </div>
        </div>
      )}
      {tab === 'chargebacks' && (
        <div className="card">
          <p className="small muted">A processor dispute freezes the transfer it funded. If the local payout had not been executed, the payout is cancelled and the funding reversed immediately; otherwise the case stays open until won or lost (lost books the customer's debt). Sandbox disputes can be opened here by payment id.</p>
          <div className="row wrap mb"><Input placeholder="payment id" value={cbOpen.paymentId} onChange={(e) => setCbOpen({ ...cbOpen, paymentId: e.target.value })} style={{ maxWidth: 320 }} /><Input placeholder="reason" value={cbOpen.reason} onChange={(e) => setCbOpen({ ...cbOpen, reason: e.target.value })} style={{ maxWidth: 240 }} /><StepUpButton size="sm" variant="danger" title="Open chargeback" onConfirm={(pin) => api.post('/api/admin/chargebacks', { ...cbOpen, pin }).then(() => { ok('Chargeback opened'); setCbOpen({ paymentId: '', reason: '' }); }).catch(err)}>Open dispute</StepUpButton></div>
          <Table head={['Opened', 'Payment', 'Amount', 'Reason', 'Payout state', 'Status', 'Resolved', '']} rows={(chargebacks.data?.items ?? []).map((c: any) => [fmtDate(c.openedAt), <span className="mono tiny">{c.paymentId.slice(0, 8)}…</span>, money(c.amount, c.currency), c.reason ?? '—', c.payoutStateAtOpen ?? '—', <Chip kind={c.status === 'won' ? 'success' : c.status === 'lost' ? 'danger' : c.status === 'open' ? 'warning' : undefined}>{c.status.replace(/_/g, ' ')}</Chip>, c.resolvedAt ? `${fmtDate(c.resolvedAt)}${c.note ? ` · ${c.note}` : ''}` : '—',
            c.status === 'open' ? <div className="row"><StepUpButton size="sm" variant="success" title="Dispute won" onConfirm={(pin) => api.post(`/api/admin/chargebacks/${c.id}/resolve`, { outcome: 'won', pin }).then(() => ok('Marked won')).catch(err)}>Won</StepUpButton><StepUpButton size="sm" variant="danger" prompt="Note" title="Dispute lost" onConfirm={(pin, note) => api.post(`/api/admin/chargebacks/${c.id}/resolve`, { outcome: 'lost', note, pin }).then(() => ok('Marked lost – funding reversed')).catch(err)}>Lost</StepUpButton></div> : null])} empty="No disputes" />
        </div>
      )}
      <Modal open={!!corridorEdit} onClose={() => setCorridorEdit(null)} title={corridorEdit?.id ? 'Edit corridor' : 'New corridor'}>
        {corridorEdit && (
          <>
            <div className="grid cols-2">
              <Field label="Source country (blank = any)"><Input value={corridorEdit.sourceCountry ?? ''} onChange={(e) => setCorridorEdit({ ...corridorEdit, sourceCountry: e.target.value.toUpperCase() || null })} maxLength={2} /></Field>
              <Field label="Source currency (* = any)"><Input value={corridorEdit.sourceCurrency} onChange={(e) => setCorridorEdit({ ...corridorEdit, sourceCurrency: e.target.value.toUpperCase() })} maxLength={3} /></Field>
              <Field label="Destination country"><Select value={corridorEdit.destCountry} onChange={(e) => setCorridorEdit({ ...corridorEdit, destCountry: e.target.value })}>{(config?.countries ?? []).map((c: any) => <option key={c.code} value={c.code}>{c.name}</option>)}</Select></Field>
              <Field label="Destination currency"><Input value={corridorEdit.destCurrency} onChange={(e) => setCorridorEdit({ ...corridorEdit, destCurrency: e.target.value.toUpperCase() })} maxLength={3} /></Field>
              <Field label="Rail"><Select value={corridorEdit.rail} onChange={(e) => setCorridorEdit({ ...corridorEdit, rail: e.target.value })}><option value="mobile_money">mobile money</option><option value="bank">bank</option><option value="agent">agent cash</option></Select></Field>
              <Field label="Operator id (blank = any)"><Input value={corridorEdit.operatorId ?? ''} onChange={(e) => setCorridorEdit({ ...corridorEdit, operatorId: e.target.value || null })} placeholder="orange_cd" /></Field>
              <Field label="Estimated payout (minutes)"><Input type="number" value={corridorEdit.estimatedPayoutMinutes} onChange={(e) => setCorridorEdit({ ...corridorEdit, estimatedPayoutMinutes: Number(e.target.value) })} /></Field>
              <Field label="Max amount (base minor units, 0 = none)"><Input type="number" value={corridorEdit.maxAmount} onChange={(e) => setCorridorEdit({ ...corridorEdit, maxAmount: Number(e.target.value) })} /></Field>
            </div>
            <Field label="Notes"><Textarea rows={2} value={corridorEdit.notes ?? ''} onChange={(e) => setCorridorEdit({ ...corridorEdit, notes: e.target.value })} /></Field>
            <Button onClick={() => api.put(`/api/admin/corridors/${corridorEdit.id ?? 'new'}`, corridorEdit).then(() => { ok('Corridor saved'); setCorridorEdit(null); }).catch(err)}>Save</Button>
          </>
        )}
      </Modal>
      <Modal open={!!goLive} onClose={() => setGoLive(null)} title={goLive?.nextStatus === 'live' ? 'Authorise corridor for live funds' : 'Suspend corridor'}>
        {goLive && (
          <>
            {goLive.nextStatus === 'live' && <Alert kind="warning">Going live requires the regulatory arrangements on record: an authorised collection partner (licensed processor / EMI), an authorised payout partner (operator super-agent / licensed payout partner) and your licence or authorisation reference. This decision is attributed to you ({user?.fullName}) and step-up protected.</Alert>}
            <Field label="Collection partner"><Input value={goLive.collectionPartner ?? ''} onChange={(e) => setGoLive({ ...goLive, collectionPartner: e.target.value })} /></Field>
            <Field label="Payout partner"><Input value={goLive.payoutPartner ?? ''} onChange={(e) => setGoLive({ ...goLive, payoutPartner: e.target.value })} /></Field>
            <Field label="Licence / authorisation reference"><Input value={goLive.licenceRef ?? ''} onChange={(e) => setGoLive({ ...goLive, licenceRef: e.target.value })} /></Field>
            <div className="grid cols-2">
              <Field label="Regulator / competent authority *"><Input value={goLive.compliance?.regulator ?? ''} onChange={(e) => setGoLive({ ...goLive, compliance: { ...goLive.compliance, regulator: e.target.value } })} /></Field>
              <Field label="Licence type *"><Input value={goLive.compliance?.licenceType ?? ''} onChange={(e) => setGoLive({ ...goLive, compliance: { ...goLive.compliance, licenceType: e.target.value } })} placeholder="Authorised Payment Institution" /></Field>
              <Field label="Licence number *"><Input value={goLive.compliance?.licenceNumber ?? ''} onChange={(e) => setGoLive({ ...goLive, compliance: { ...goLive.compliance, licenceNumber: e.target.value } })} /></Field>
              <Field label="Licence expiry *"><Input type="date" value={goLive.licenceExpiresAt ? String(goLive.licenceExpiresAt).slice(0, 10) : ''} onChange={(e) => setGoLive({ ...goLive, licenceExpiresAt: e.target.value ? new Date(e.target.value).toISOString() : null })} /></Field>
              <Field label="Safeguarding account *"><Input value={goLive.compliance?.safeguardingAccount ?? ''} onChange={(e) => setGoLive({ ...goLive, compliance: { ...goLive.compliance, safeguardingAccount: e.target.value } })} /></Field>
              <Field label="AML / KYC programme reference *"><Input value={goLive.compliance?.amlProgrammeRef ?? ''} onChange={(e) => setGoLive({ ...goLive, compliance: { ...goLive.compliance, amlProgrammeRef: e.target.value } })} /></Field>
              <Field label="Data-protection registration"><Input value={goLive.compliance?.dataProtectionRef ?? ''} onChange={(e) => setGoLive({ ...goLive, compliance: { ...goLive.compliance, dataProtectionRef: e.target.value } })} /></Field>
              <Field label="Destination FX / mobile-money approval"><Input value={goLive.compliance?.fxApprovalRef ?? ''} onChange={(e) => setGoLive({ ...goLive, compliance: { ...goLive.compliance, fxApprovalRef: e.target.value } })} /></Field>
              <Field label="Consumer disclosure / terms URL"><Input value={goLive.compliance?.consumerDisclosureUrl ?? ''} onChange={(e) => setGoLive({ ...goLive, compliance: { ...goLive.compliance, consumerDisclosureUrl: e.target.value } })} /></Field>
              <Field label="Agent due-diligence & supervision procedure"><Input value={goLive.compliance?.agentSupervisionRef ?? ''} onChange={(e) => setGoLive({ ...goLive, compliance: { ...goLive.compliance, agentSupervisionRef: e.target.value } })} /></Field>
            </div>
            {goLive.readiness && !goLive.readiness.ready && <Alert kind="warning">Still missing: {goLive.readiness.missing.join('; ')}</Alert>}
            <StepUpButton variant={goLive.nextStatus === 'live' ? 'success' : 'danger'} title={goLive.nextStatus === 'live' ? 'Confirm go-live' : 'Confirm suspension'} onConfirm={(pin) => api.post(`/api/admin/corridors/${goLive.id}/status`, { status: goLive.nextStatus, collectionPartner: goLive.collectionPartner, payoutPartner: goLive.payoutPartner, licenceRef: goLive.licenceRef, compliance: goLive.compliance ?? {}, licenceExpiresAt: goLive.licenceExpiresAt ?? null, pin }).then(() => { ok(`Corridor ${goLive.nextStatus}`); setGoLive(null); }).catch((e: any) => { toast(e.message, 'error'); if (e.details?.missing) setGoLive({ ...goLive, readiness: e.details }); })}>{goLive.nextStatus === 'live' ? 'Mark live' : 'Suspend'}</StepUpButton>
          </>
        )}
      </Modal>
      <Modal open={!!acct} onClose={() => setAcct(null)} title="New payout account">
        {acct && (
          <>
            <div className="grid cols-2">
              <Field label="Rail"><Select value={acct.rail} onChange={(e) => setAcct({ ...acct, rail: e.target.value })}><option value="mobile_money">mobile money (merchant SIM)</option><option value="bank">bank (treasury account)</option></Select></Field>
              <Field label="Operator id"><Input value={acct.operatorId} onChange={(e) => setAcct({ ...acct, operatorId: e.target.value })} placeholder="orange_cd" /></Field>
              <Field label="Country"><Input value={acct.country} onChange={(e) => setAcct({ ...acct, country: e.target.value.toUpperCase() })} maxLength={2} /></Field>
              <Field label="Currency"><Input value={acct.currency} onChange={(e) => setAcct({ ...acct, currency: e.target.value.toUpperCase() })} maxLength={3} /></Field>
              <Field label="Label"><Input value={acct.label} onChange={(e) => setAcct({ ...acct, label: e.target.value })} placeholder="Orange Money DRC – SIM 1" /></Field>
              <Field label="Merchant SIM number (MSISDN)"><Input value={acct.msisdn} onChange={(e) => setAcct({ ...acct, msisdn: e.target.value })} /></Field>
              <Field label="SIM ICCID"><Input value={acct.simIccid} onChange={(e) => setAcct({ ...acct, simIccid: e.target.value })} /></Field>
              <Field label="Operating agent user id (KYC verified)"><Input value={acct.agentUserId} onChange={(e) => setAcct({ ...acct, agentUserId: e.target.value })} /></Field>
              <Field label="Daily limit (minor units, 0 = none)"><Input type="number" value={acct.dailyLimit} onChange={(e) => setAcct({ ...acct, dailyLimit: Number(e.target.value) })} /></Field>
              <Field label="Per-transaction limit (minor units)"><Input type="number" value={acct.perTxLimit} onChange={(e) => setAcct({ ...acct, perTxLimit: Number(e.target.value) })} /></Field>
            </div>
            <p className="tiny muted">Then register the Android payout device on this account under Mobile money & evidence → Evidence devices (kind: payout, with the SIM identity).</p>
            <Button onClick={() => api.post('/api/admin/liquidity/accounts', { ...acct, operatorId: acct.operatorId || null, agentUserId: acct.agentUserId || null, msisdn: acct.msisdn || null, simIccid: acct.simIccid || null }).then(() => { ok('Payout account created'); setAcct(null); }).catch(err)}>Create</Button>
          </>
        )}
      </Modal>
    </div>
  );
}
