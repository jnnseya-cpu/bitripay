import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
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
const COMPLIANCE_FIELDS: [string, string, 'number' | 'boolean' | 'mode'][] = [
  ['mode', 'Compliance mode: sandbox (no live customer funds) or live (authorised corridors only)', 'mode'],
  ['cardPayoutHoldMinutes', 'Hold card-funded payouts this many minutes before execution (chargeback exposure)', 'number'],
  ['cardReviewAmount', 'Card-funded transfers at/above this base amount (minor units) need a verifier before payout', 'number'],
  ['sourceOfFundsThreshold', 'Senders must declare source of funds at/above this base amount (minor units)', 'number'],
  ['maxPayoutsPerRecipientPerDay', 'Abnormal pattern: max settled payouts to one recipient per day', 'number'],
  ['payoutClaimMinutes', 'Minutes a claimed payout may stay in progress before it returns to the queue', 'number'],
];
const RISK_FIELDS: [string, string, 'number' | 'boolean'][] = [
  ['maxTxPerHour', 'Velocity: transactions per hour before flagging', 'number'],
  ['maxTxPerDay', 'Velocity: transactions per day before flagging', 'number'],
  ['coolingOffMinutes', 'Cooling-off for new beneficiaries (minutes)', 'number'],
  ['coolingOffAmount', 'Cooling-off applies above this amount (base currency, minor units)', 'number'],
  ['reviewScore', 'Inbound payments at/above this score are held for manual review', 'number'],
  ['blockScore', 'Outbound movements at/above this score are blocked', 'number'],
];

function SettingsForm({ title, keyName, fields, initial, onSaved }: { title: string; keyName: string; fields: [string, string, 'number' | 'boolean' | 'mode'][]; initial: any; onSaved: () => void }) {
  const { toast } = useStore();
  const [v, setV] = useState<any>(initial ?? {});
  useEffect(() => setV(initial ?? {}), [initial]);
  return (
    <div className="card">
      <h4>{title}</h4>
      {fields.map(([k, label, type]) => (
        <Field key={k} label={label}>
          {type === 'boolean' ? (
            <Switch on={!!v[k]} onChange={(on) => setV({ ...v, [k]: on })} />
          ) : type === 'mode' ? (
            <Select value={v[k] ?? 'sandbox'} onChange={(e) => setV({ ...v, [k]: e.target.value })} style={{ maxWidth: 220 }}>
              <option value="sandbox">sandbox – no live funds</option>
              <option value="live">live – authorised corridors only</option>
            </Select>
          ) : (
            <Input type="number" step="any" value={v[k] ?? ''} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} style={{ maxWidth: 200 }} />
          )}
        </Field>
      ))}
      <Button
        onClick={() =>
          api
            .put(`/api/admin/settings/${keyName}`, { value: v })
            .then(() => {
              toast('Saved', 'success');
              onSaved();
            })
            .catch((e) => toast(e.message, 'error'))
        }
      >
        Save
      </Button>
    </div>
  );
}

/**
 * Capability matrix editor (country × method × rail). Method columns and the per-transaction ceiling write through to
 * the enforced country capabilities; rail cells show whether a rail serving the method in that country is enabled and
 * usable (rail-level controls live in the switch console: pause / resume / maintenance).
 */
function CapabilityMatrixEditor() {
  const { toast } = useStore();
  const matrix = useAsync(() => api.get<any>('/api/admin/switch/capability-matrix'), []);
  const [ceilings, setCeilings] = useState<Record<string, string>>({});
  const [newCountry, setNewCountry] = useState('');
  const [extra, setExtra] = useState<string[]>([]);
  const extraRows = useAsync(() => (extra.length ? api.get<any>(`/api/admin/switch/capability-matrix?country=${extra.join(',')}`) : Promise.resolve(null)), [extra]);
  const rows = [...(matrix.data?.items ?? []), ...(extraRows.data?.items ?? []).filter((e: any) => !(matrix.data?.items ?? []).some((m: any) => m.country === e.country))];
  const save = (country: string, body: Record<string, unknown>) =>
    api
      .put(`/api/admin/switch/capability-matrix/${country}`, body)
      .then(() => {
        toast(`${country} updated`, 'success');
        matrix.reload();
        if (extra.length) extraRows.reload();
      })
      .catch((e) => toast(e.message, 'error'));
  return (
    <div className="card">
      <p className="small muted">
        Never assume a capability from one country applies elsewhere. Toggling a method here changes what the policy and routing layers allow for that country immediately; the ceiling is the country's
        per-transaction maximum in its main currency's minor units (0 = policy limits only). ● rail enabled and usable · ○ rail disabled, paused, open circuit or in maintenance.
      </p>
      <div className="row mb">
        <Input placeholder="Add country (ISO-2)" value={newCountry} onChange={(e) => setNewCountry(e.target.value.toUpperCase().slice(0, 2))} style={{ width: 180 }} />
        <Button
          size="sm"
          variant="secondary"
          disabled={newCountry.length !== 2}
          onClick={() => {
            setExtra([...new Set([...extra, newCountry])]);
            setNewCountry('');
          }}
        >
          Show
        </Button>
      </div>
      <Table
        head={['Country', 'Phase', ...(matrix.data?.methods ?? []).map((m: any) => m.label), 'Ceiling / tx (minor)']}
        rows={rows.map((c: any) => [
          <b>{c.country}</b>,
          <Chip kind={c.licencePhase === 'full' ? 'success' : 'warning'}>{c.licencePhase}</Chip>,
          ...c.methods.map((m: any) => (
            <div key={m.method}>
              <Switch on={m.allowed} onChange={(on) => save(c.country, { methods: { [m.method]: on } })} />
              <div className="tiny">
                {m.rails.length
                  ? m.rails.map((r: any) => (
                      <span key={r.id} title={r.reason ?? r.state}>
                        {r.enabled ? '●' : '○'} {r.name}
                        <br />
                      </span>
                    ))
                  : 'no rail'}
              </div>
            </div>
          )),
          <div className="row">
            <Input
              type="number"
              min={0}
              value={ceilings[c.country] ?? String(c.maxPerTransaction)}
              onChange={(e) => setCeilings({ ...ceilings, [c.country]: e.target.value })}
              style={{ width: 120 }}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={ceilings[c.country] == null || ceilings[c.country] === String(c.maxPerTransaction)}
              onClick={() => save(c.country, { maxPerTransaction: Number(ceilings[c.country]) })}
            >
              Save
            </Button>
          </div>,
        ])}
        empty="No country configured"
      />
    </div>
  );
}

/** Gateway controls: lifecycle/evidence thresholds, FX disclosure policy, fraud & sanctions, reconciliation and the declared route catalogue. */
export function Controls() {
  const { toast } = useStore();
  const [tab, setTab] = useState<'golive' | 'controls' | 'capabilities' | 'sanctions' | 'reconcile' | 'catalog' | 'events' | 'emoney'>('golive');
  const golive = useAsync(() => (tab === 'golive' ? api.get<any>('/api/admin/go-live') : Promise.resolve(null)), [tab]);
  const emoney = useAsync(() => (tab === 'emoney' ? api.get<any>('/api/admin/emoney?pageSize=100') : Promise.resolve(null)), [tab]);
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
      <Tabs
        tabs={[
          { id: 'golive', label: 'Go-live checklist' },
          { id: 'controls', label: 'Controls' },
          { id: 'capabilities', label: 'Capability matrix' },
          { id: 'sanctions', label: 'Sanctions & risk events' },
          { id: 'reconcile', label: 'Reconciliation' },
          { id: 'catalog', label: 'Route catalogue' },
          { id: 'events', label: 'Event log' },
          { id: 'emoney', label: 'E-money issuance' },
        ]}
        value={tab}
        onChange={(v) => setTab(v as any)}
      />
      {tab === 'golive' && golive.data && (
        <div className="card">
          {golive.data.readyForLive ? (
            <Alert kind="success">All blocking items are complete. Switching to live mode (Controls → Compliance mode) will be accepted; it requires your step-up PIN.</Alert>
          ) : (
            <Alert kind="warning">
              <b>Platform is in {golive.data.mode} mode.</b> Live customer funds cannot be accepted until every blocking item below is complete. The switch to live is refused by the API while any
              blocking item is open.
            </Alert>
          )}
          <Table
            head={['', 'Requirement', 'Status', 'What to do', '']}
            rows={golive.data.items.map((i: any) => [
              i.ok ? <Chip kind="success">ok</Chip> : <Chip kind={i.blocking ? 'danger' : 'warning'}>{i.blocking ? 'blocking' : 'recommended'}</Chip>,
              <b>{i.label}</b>,
              <span className="tiny">{i.detail}</span>,
              <span className="tiny muted">{i.ok ? '' : (i.fix ?? '')}</span>,
              !i.ok && i.href ? (
                <Link to={i.href} className="tiny">
                  Open →
                </Link>
              ) : (
                ''
              ),
            ])}
          />
          <div className="row mt">
            <Button variant="secondary" onClick={golive.reload}>
              Re-check
            </Button>
          </div>
        </div>
      )}
      {tab === 'controls' && settings.data && (
        <div className="grid cols-3">
          <SettingsForm title="Payment lifecycle & evidence" keyName="gateway" fields={GATEWAY_FIELDS} initial={settings.data.gateway} onSaved={settings.reload} />
          <SettingsForm title="Foreign exchange disclosure" keyName="fx" fields={FX_FIELDS} initial={settings.data.fx} onSaved={settings.reload} />
          <SettingsForm title="Fraud, velocity & cooling-off" keyName="risk" fields={RISK_FIELDS} initial={settings.data.risk} onSaved={settings.reload} />
          <SettingsForm title="Compliance & payout exposure" keyName="compliance" fields={COMPLIANCE_FIELDS} initial={settings.data.compliance} onSaved={settings.reload} />
        </div>
      )}
      {tab === 'capabilities' && <CapabilityMatrixEditor />}
      {tab === 'sanctions' && (
        <div className="grid cols-2">
          <div className="card">
            <h4>Sanctions / block list</h4>
            <p className="small muted">
              Names match on normalised containment, phones on the last 9 digits. Matches block outbound movements and hold inbound payments for manual review. Connect a screening provider by
              importing its list here.
            </p>
            <div className="row wrap">
              <Select value={entry.kind} onChange={(e) => setEntry({ ...entry, kind: e.target.value })} style={{ width: 120 }}>
                <option value="name">name</option>
                <option value="phone">phone</option>
                <option value="email">email</option>
                <option value="country">country</option>
              </Select>
              <Input placeholder="value" value={entry.value} onChange={(e) => setEntry({ ...entry, value: e.target.value })} />
              <Input placeholder="note / list source" value={entry.note} onChange={(e) => setEntry({ ...entry, note: e.target.value })} />
              <Button
                disabled={entry.value.length < 2}
                onClick={() =>
                  api
                    .post('/api/admin/sanctions', entry)
                    .then(() => {
                      toast('Added', 'success');
                      setEntry({ ...entry, value: '', note: '' });
                      sanctions.reload();
                    })
                    .catch((e) => toast(e.message, 'error'))
                }
              >
                Add
              </Button>
            </div>
            <Table
              head={['Kind', 'Value', 'Note', 'Added', '']}
              rows={(sanctions.data?.items ?? []).map((s: any) => [
                s.kind,
                <b>{s.value}</b>,
                s.note ?? '—',
                fmtDate(s.createdAt),
                <ConfirmButton size="sm" variant="ghost" onConfirm={() => api.del(`/api/admin/sanctions/${s.id}`).then(sanctions.reload)}>
                  Remove
                </ConfirmButton>,
              ])}
              empty="No entries"
            />
          </div>
          <div className="card">
            <h4>Recent risk assessments</h4>
            <Table
              head={['When', 'Kind', 'Score', 'Action', 'Flags']}
              rows={(risk.data?.items ?? []).map((r: any) => [
                fmtDate(r.createdAt),
                r.kind,
                r.score,
                <Chip kind={r.action === 'allow' ? 'success' : r.action === 'review' ? 'warning' : 'danger'}>{r.action}</Chip>,
                <span className="tiny">{r.flags.join(', ')}</span>,
              ])}
              empty="No assessments yet"
            />
          </div>
        </div>
      )}
      {tab === 'reconcile' && (
        <div className="grid cols-2">
          <div className="card">
            <h4>Ledger</h4>
            {reconcile.data &&
              (reconcile.data.ledger.ok ? (
                <Alert kind="success">Every transaction balances per currency and every wallet equals the sum of its entries ({reconcile.data.ledger.transactionsChecked} transactions checked).</Alert>
              ) : (
                <Alert kind="error">
                  Ledger inconsistency detected. Unbalanced: {reconcile.data.ledger.unbalancedTransactions.join(', ') || 'none'}. Wallet mismatches: {reconcile.data.ledger.walletMismatches.length}.
                </Alert>
              ))}
            <Button variant="secondary" onClick={reconcile.reload}>
              Re-run
            </Button>
          </div>
          <div className="card">
            <h4>Immutable event chain</h4>
            {reconcile.data &&
              (reconcile.data.events.ok ? (
                <Alert kind="success">Hash chain intact across {reconcile.data.events.checked} events. Audit, event and ledger tables are append-only at the database level.</Alert>
              ) : (
                <Alert kind="error">Event chain broken at sequence {reconcile.data.events.brokenAt} – history was altered.</Alert>
              ))}
          </div>
        </div>
      )}
      {tab === 'catalog' && (
        <div className="card">
          <p className="small muted">
            Every logical route declares how it is initiated, confirmed and settled, its expected completion, refund path and whether processing is automatic, assisted (a verifier confirms evidence)
            or manual. External legs always depend on the payer's own bank, operator or a licensed processor.
          </p>
          <Table
            head={['Route', 'Processing', 'Initiation', 'Confirmation', 'Settlement', 'Expected', 'Refund']}
            rows={(catalog.data?.items ?? []).map((r: any) => [
              <b>
                {r.source.replace('_', ' ')} → {r.destination.replace('_', ' ')}
              </b>,
              <Chip kind={r.processing === 'automatic' ? 'success' : r.processing === 'assisted' ? 'warning' : undefined}>{r.processing}</Chip>,
              <span className="tiny">
                {r.funding.initiation}
                {r.payout.initiation !== r.funding.initiation ? ` → ${r.payout.initiation}` : ''}
              </span>,
              <span className="tiny">
                {r.funding.confirmation}; {r.payout.confirmation}
              </span>,
              <span className="tiny">{r.settlementMechanism}</span>,
              <span className="tiny">{r.expectedCompletion}</span>,
              <span className="tiny">{r.refundMethod}</span>,
            ])}
          />
        </div>
      )}
      {tab === 'emoney' && (
        <>
          <Alert kind="success">
            Issuer programmes, safeguarded reserves, distribution pools and reconciliation live in the <a href="/emoney">E-money & reserves console</a>. Spendable e-money never exceeds verified
            safeguarded reserves.
          </Alert>
          <Alert kind="info">
            <b>E-money is created by administrators only.</b> Balance enters circulation solely through confirmed external funding, administrator issuance (proposed by one admin, approved by a
            different admin with the issuance permission under step-up), liquidity prefunding of payout floats, or an administrator-configured programme. Users, agents, merchants and devices can never
            create balance; the ledger refuses any posting from the treasury without an issuance authority.
          </Alert>
          {(emoney.data?.pending ?? []).length > 0 && (
            <Alert kind="warning">
              {emoney.data.pending.length} issuance proposal(s) await a second approver in the <a href="/verification">verification console</a>.
            </Alert>
          )}
          <div className="card mb">
            <h4>Outstanding e-money by currency</h4>
            <Table
              head={['Currency', 'Outstanding (customer wallets)', 'Wallets', 'Issued by authority', 'Payout float']}
              rows={(emoney.data?.supply ?? []).map((s: any) => [
                <b>{s.currency}</b>,
                s.outstanding,
                s.wallets,
                <span className="tiny">{s.issued.map((i: any) => `${i.authority}: ${i.total} (${i.count})`).join(' · ') || '—'}</span>,
                s.payoutFloat,
              ])}
              empty="No e-money outstanding"
            />
          </div>
          <div className="card">
            <h4>Issuance register (immutable)</h4>
            <Table
              head={['When', 'Authority', 'Type', 'Amount', 'Currency', 'Approved by', 'Reference']}
              rows={(emoney.data?.register?.items ?? []).map((e: any) => [
                fmtDate(e.createdAt),
                <Chip kind={e.details.authority === 'admin' ? 'warning' : 'success'}>{e.event.replace('issuance.', '')}</Chip>,
                e.details.type,
                e.details.amount,
                e.details.currency,
                e.actor.id ? <span className="mono tiny">{String(e.actor.id).slice(0, 8)}</span> : e.actor.type,
                <span className="tiny">{e.details.reference ?? e.details.programme ?? e.details.paymentId ?? ''}</span>,
              ])}
              empty="Nothing issued yet"
            />
          </div>
        </>
      )}
      {tab === 'events' && (
        <div className="card">
          <div className="row mb">
            <Select value={stream} onChange={(e) => setStream(e.target.value)} style={{ width: 200 }}>
              <option value="">All streams</option>
              {['payment', 'auth', 'evidence', 'approval', 'ledger', 'risk', 'route', 'admin'].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
            {events.data?.chain &&
              (events.data.chain.ok ? <Chip kind="success">chain intact ({events.data.chain.checked})</Chip> : <Chip kind="danger">chain broken at {events.data.chain.brokenAt}</Chip>)}
          </div>
          <Table
            head={['Seq', 'When', 'Stream', 'Event', 'Actor', 'Subject', 'Details']}
            rows={(events.data?.items ?? []).map((e: any) => [
              e.seq,
              fmtDate(e.createdAt),
              e.stream,
              <span className="mono small">{e.event}</span>,
              <span className="small">
                {e.actor.type} {e.actor.id ? <span className="mono tiny">{String(e.actor.id).slice(0, 8)}</span> : ''}
              </span>,
              <span className="mono tiny">{e.subjectId ? String(e.subjectId).slice(0, 8) : ''}</span>,
              <span className="tiny mono">{JSON.stringify(e.details).slice(0, 140)}</span>,
            ])}
          />
        </div>
      )}
    </div>
  );
}
