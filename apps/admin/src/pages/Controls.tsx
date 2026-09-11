import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Chip, ConfirmButton, Field, Input, PageHeader, Select, Switch, Table, Tabs, fmtDate, useAsync } from '../components/ui';

const GATEWAY_FIELDS: [string, string, 'number' | 'boolean'][] = [
  ['intentExpiryHours', 'Intent expiry (hours) – unconfirmed intents expire, nothing is credited', 'number'],
  ['evidenceWindowHours', 'Evidence time window (hours) after the intent was created', 'number'],
  ['autoConfirmScore', 'Confidence needed to settle automatically (0-100)', 'number'],
  ['reviewScore', 'Below this evidence is "unsupported" and goes to manual review', 'number'],
  ['sharedSecretAutoConfirm', 'Treat the legacy shared-secret SMS webhook as authoritative (device-signed evidence is the standard)', 'boolean'],
  ['makerChecker', 'Maker-checker: manual settlement needs a proposer and a different approver', 'boolean'],
  ['adminStepUp', 'Administrative approvals require a passkey step-up or PIN', 'boolean'],
];
const FX_FIELDS: [string, string, 'number' | 'boolean'][] = [
  ['quoteTtlSeconds', 'Seconds a quoted rate stays guaranteed', 'number'],
  ['maxRateAgeHours', 'Live rates older than this are stale (no guaranteed quotes, labelled)', 'number'],
  ['guaranteedQuotes', 'Offer guaranteed (locked) rates when a fresh live rate exists', 'boolean'],
];
const RISK_FIELDS: [string, string, 'number' | 'boolean'][] = [
  ['maxTxPerHour', 'Velocity: transactions per hour before flagging', 'number'],
  ['maxTxPerDay', 'Velocity: transactions per day before flagging', 'number'],
  ['coolingOffMinutes', 'Cooling-off for new beneficiaries (minutes)', 'number'],
  ['coolingOffAmount', 'Cooling-off applies above this amount (base currency, minor units)', 'number'],
  ['reviewScore', 'Inbound payments at/above this score are held for manual review', 'number'],
  ['blockScore', 'Outbound movements at/above this score are blocked', 'number'],
];

function SettingsForm({ title, keyName, fields, initial, onSaved }: { title: string; keyName: string; fields: [string, string, 'number' | 'boolean'][]; initial: any; onSaved: () => void }) {
  const { toast } = useStore();
  const [v, setV] = useState<any>(initial ?? {});
  useEffect(() => setV(initial ?? {}), [initial]);
  return (
    <div className="card">
      <h4>{title}</h4>
      {fields.map(([k, label, type]) => (
        <Field key={k} label={label}>{type === 'boolean' ? <Switch on={!!v[k]} onChange={(on) => setV({ ...v, [k]: on })} /> : <Input type="number" step="any" value={v[k] ?? ''} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} style={{ maxWidth: 200 }} />}</Field>
      ))}
      <Button onClick={() => api.put(`/api/admin/settings/${keyName}`, { value: v }).then(() => { toast('Saved', 'success'); onSaved(); }).catch((e) => toast(e.message, 'error'))}>Save</Button>
    </div>
  );
}

/** Gateway controls: lifecycle/evidence thresholds, FX disclosure policy, fraud & sanctions, reconciliation and the declared route catalogue. */
export function Controls() {
  const { toast } = useStore();
  const [tab, setTab] = useState<'controls' | 'sanctions' | 'reconcile' | 'catalog' | 'events'>('controls');
  const settings = useAsync(() => api.get<any>('/api/admin/settings'), []);
  const sanctions = useAsync(() => (tab === 'sanctions' ? api.get<any>('/api/admin/sanctions') : Promise.resolve(null)), [tab]);
  const risk = useAsync(() => (tab === 'sanctions' ? api.get<any>('/api/admin/risk-events?pageSize=50') : Promise.resolve(null)), [tab]);
  const reconcile = useAsync(() => (tab === 'reconcile' ? api.get<any>('/api/admin/reconcile') : Promise.resolve(null)), [tab]);
  const catalog = useAsync(() => (tab === 'catalog' ? api.get<any>('/api/admin/route-catalog?currency=USD') : Promise.resolve(null)), [tab]);
  const [stream, setStream] = useState('');
  const events = useAsync(() => (tab === 'events' ? api.get<any>(`/api/admin/events?pageSize=100${stream ? `&stream=${stream}` : ''}`) : Promise.resolve(null)), [tab, stream]);
  const [entry, setEntry] = useState({ kind: 'name', value: '', note: '' });
  return (
    <div>
      <PageHeader title="Gateway controls & risk" subtitle="Lifecycle thresholds, evidence policy, FX disclosure, fraud/sanctions controls, ledger reconciliation and the declared route catalogue" />
      <Tabs tabs={[{ id: 'controls', label: 'Controls' }, { id: 'sanctions', label: 'Sanctions & risk events' }, { id: 'reconcile', label: 'Reconciliation' }, { id: 'catalog', label: 'Route catalogue' }, { id: 'events', label: 'Event log' }]} value={tab} onChange={(v) => setTab(v as any)} />
      {tab === 'controls' && settings.data && (
        <div className="grid cols-3">
          <SettingsForm title="Payment lifecycle & evidence" keyName="gateway" fields={GATEWAY_FIELDS} initial={settings.data.gateway} onSaved={settings.reload} />
          <SettingsForm title="Foreign exchange disclosure" keyName="fx" fields={FX_FIELDS} initial={settings.data.fx} onSaved={settings.reload} />
          <SettingsForm title="Fraud, velocity & cooling-off" keyName="risk" fields={RISK_FIELDS} initial={settings.data.risk} onSaved={settings.reload} />
        </div>
      )}
      {tab === 'sanctions' && (
        <div className="grid cols-2">
          <div className="card">
            <h4>Sanctions / block list</h4>
            <p className="small muted">Names match on normalised containment, phones on the last 9 digits. Matches block outbound movements and hold inbound payments for manual review. Connect a screening provider by importing its list here.</p>
            <div className="row wrap"><Select value={entry.kind} onChange={(e) => setEntry({ ...entry, kind: e.target.value })} style={{ width: 120 }}><option value="name">name</option><option value="phone">phone</option><option value="email">email</option><option value="country">country</option></Select><Input placeholder="value" value={entry.value} onChange={(e) => setEntry({ ...entry, value: e.target.value })} /><Input placeholder="note / list source" value={entry.note} onChange={(e) => setEntry({ ...entry, note: e.target.value })} /><Button disabled={entry.value.length < 2} onClick={() => api.post('/api/admin/sanctions', entry).then(() => { toast('Added', 'success'); setEntry({ ...entry, value: '', note: '' }); sanctions.reload(); }).catch((e) => toast(e.message, 'error'))}>Add</Button></div>
            <Table head={['Kind', 'Value', 'Note', 'Added', '']} rows={(sanctions.data?.items ?? []).map((s: any) => [s.kind, <b>{s.value}</b>, s.note ?? '—', fmtDate(s.createdAt), <ConfirmButton size="sm" variant="ghost" onConfirm={() => api.del(`/api/admin/sanctions/${s.id}`).then(sanctions.reload)}>Remove</ConfirmButton>])} empty="No entries" />
          </div>
          <div className="card">
            <h4>Recent risk assessments</h4>
            <Table head={['When', 'Kind', 'Score', 'Action', 'Flags']} rows={(risk.data?.items ?? []).map((r: any) => [fmtDate(r.createdAt), r.kind, r.score, <Chip kind={r.action === 'allow' ? 'success' : r.action === 'review' ? 'warning' : 'danger'}>{r.action}</Chip>, <span className="tiny">{r.flags.join(', ')}</span>])} empty="No assessments yet" />
          </div>
        </div>
      )}
      {tab === 'reconcile' && (
        <div className="grid cols-2">
          <div className="card">
            <h4>Ledger</h4>
            {reconcile.data && (reconcile.data.ledger.ok ? <Alert kind="success">Every transaction balances per currency and every wallet equals the sum of its entries ({reconcile.data.ledger.transactionsChecked} transactions checked).</Alert> : <Alert kind="error">Ledger inconsistency detected. Unbalanced: {reconcile.data.ledger.unbalancedTransactions.join(', ') || 'none'}. Wallet mismatches: {reconcile.data.ledger.walletMismatches.length}.</Alert>)}
            <Button variant="secondary" onClick={reconcile.reload}>Re-run</Button>
          </div>
          <div className="card">
            <h4>Immutable event chain</h4>
            {reconcile.data && (reconcile.data.events.ok ? <Alert kind="success">Hash chain intact across {reconcile.data.events.checked} events. Audit, event and ledger tables are append-only at the database level.</Alert> : <Alert kind="error">Event chain broken at sequence {reconcile.data.events.brokenAt} – history was altered.</Alert>)}
          </div>
        </div>
      )}
      {tab === 'catalog' && (
        <div className="card">
          <p className="small muted">Every logical route declares how it is initiated, confirmed and settled, its expected completion, refund path and whether processing is automatic, assisted (a verifier confirms evidence) or manual. External legs always depend on the payer's own bank, operator or a licensed processor.</p>
          <Table head={['Route', 'Processing', 'Initiation', 'Confirmation', 'Settlement', 'Expected', 'Refund']} rows={(catalog.data?.items ?? []).map((r: any) => [<b>{r.source.replace('_', ' ')} → {r.destination.replace('_', ' ')}</b>, <Chip kind={r.processing === 'automatic' ? 'success' : r.processing === 'assisted' ? 'warning' : undefined}>{r.processing}</Chip>, <span className="tiny">{r.funding.initiation}{r.payout.initiation !== r.funding.initiation ? ` → ${r.payout.initiation}` : ''}</span>, <span className="tiny">{r.funding.confirmation}; {r.payout.confirmation}</span>, <span className="tiny">{r.settlementMechanism}</span>, <span className="tiny">{r.expectedCompletion}</span>, <span className="tiny">{r.refundMethod}</span>])} />
        </div>
      )}
      {tab === 'events' && (
        <div className="card">
          <div className="row mb"><Select value={stream} onChange={(e) => setStream(e.target.value)} style={{ width: 200 }}><option value="">All streams</option>{['payment', 'auth', 'evidence', 'approval', 'ledger', 'risk', 'route', 'admin'].map((s) => <option key={s} value={s}>{s}</option>)}</Select>{events.data?.chain && (events.data.chain.ok ? <Chip kind="success">chain intact ({events.data.chain.checked})</Chip> : <Chip kind="danger">chain broken at {events.data.chain.brokenAt}</Chip>)}</div>
          <Table head={['Seq', 'When', 'Stream', 'Event', 'Actor', 'Subject', 'Details']} rows={(events.data?.items ?? []).map((e: any) => [e.seq, fmtDate(e.createdAt), e.stream, <span className="mono small">{e.event}</span>, <span className="small">{e.actor.type} {e.actor.id ? <span className="mono tiny">{String(e.actor.id).slice(0, 8)}</span> : ''}</span>, <span className="mono tiny">{e.subjectId ? String(e.subjectId).slice(0, 8) : ''}</span>, <span className="tiny mono">{JSON.stringify(e.details).slice(0, 140)}</span>])} />
        </div>
      )}
    </div>
  );
}
