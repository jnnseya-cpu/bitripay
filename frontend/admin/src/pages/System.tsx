import { useState } from 'react';
import { tr } from '../lib/i18n';
import { api, qs } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Chip, ConfirmButton, Field, Input, KV, Modal, PageHeader, Select, Table, Tabs, fmtDate, useAsync } from '../components/ui';

/**
 * System console: process and database health, service-level objectives with their met / missed verdicts, API
 * operations (usage per key, error codes, rate limiting), the SLA register with measured breaches, and the gate to
 * scale computed from 30 days of real platform data.
 */
export function System() {
  const { toast } = useStore();
  const [tab, setTab] = useState<'health' | 'slo' | 'api' | 'sla' | 'gate'>('health');
  const err = (e: any) => toast(e.message, 'error');
  const ok = (m: string) => toast(m, 'success');
  return (
    <div>
      <PageHeader
        title={tr('System health & SLOs')}
        subtitle={tr('What the platform measured about itself and its counterparties. Targets are met or missed on real traffic; without traffic they are neither.')}
      />
      <Tabs
        tabs={[
          { id: 'health', label: tr('Health') },
          { id: 'slo', label: tr('SLOs') },
          { id: 'api', label: tr('API operations') },
          { id: 'sla', label: tr('SLA register') },
          { id: 'gate', label: tr('Gate to scale') },
        ]}
        value={tab}
        onChange={(v) => setTab(v as any)}
      />
      {tab === 'health' && <Health />}
      {tab === 'slo' && <Slo />}
      {tab === 'api' && <ApiOps />}
      {tab === 'sla' && <SlaRegister ok={ok} err={err} />}
      {tab === 'gate' && <GateToScale />}
    </div>
  );
}

const mb = (n?: number | null) => (n == null ? '—' : `${(n / 1_048_576).toFixed(1)} MB`);
const pctOf = (n?: number | null, digits = 2) => (n == null ? '—' : `${(n * 100).toFixed(digits)} %`);
const ms = (n?: number | null) => (n == null ? '—' : `${Math.round(n)} ms`);
const Verdict = ({ met }: { met: boolean | null }) => (met === true ? <Chip kind="success">met</Chip> : met === false ? <Chip kind="danger">missed</Chip> : <Chip>no traffic</Chip>);

function Health() {
  const { toast } = useStore();
  const data = useAsync(() => api.get<any>('/api/admin/system/health'), []);
  const h = data.data;
  const [guardian, setGuardian] = useState<any>(null);
  if (!h) return data.error ? <Alert kind="error">{data.error}</Alert> : <p className="muted small">{tr('Loading…')}</p>;
  const stateKind = (s: string) => (s === 'HEALTHY' ? 'success' : s === 'DEGRADED' ? 'warning' : 'danger');
  return (
    <div>
      <div className="grid cols-4 mb">
        <div className="card">
          <div className="stat">
            <span className="label">{tr('Uptime')}</span>
            <span className="value">
              {Math.floor(h.process.uptimeSeconds / 3600)}h {Math.floor((h.process.uptimeSeconds % 3600) / 60)}m
            </span>
            <span className="small muted">
              {h.process.environment} · node {h.process.node} · since {fmtDate(h.process.startedAt)}
            </span>
          </div>
        </div>
        <div className="card">
          <div className="stat">
            <span className="label">{tr('Memory (RSS)')}</span>
            <span className="value">{mb(h.memory.rssBytes)}</span>
            <span className="small muted">
              heap {mb(h.memory.heapUsedBytes)} / {mb(h.memory.heapTotalBytes)}
            </span>
          </div>
        </div>
        <div className="card">
          <div className="stat">
            <span className="label">{tr('Database')}</span>
            <span className="value">{mb(h.database.fileBytes ?? h.database.logicalBytes)}</span>
            <span className="small muted">
              {h.database.journalMode} · WAL {mb(h.database.walBytes)} · {h.database.migrations.count} migrations (last {h.database.migrations.last})
            </span>
          </div>
        </div>
        <div className="card">
          <div className="stat">
            <span className="label">{tr('SLOs (24 h)')}</span>
            <span className="value">
              {h.slo.summary.met} met · {h.slo.summary.missed} missed
            </span>
            <span className="small muted">
              {h.slo.summary.noTraffic} without traffic · switch availability {pctOf(h.slo.switchAvailability['24h'].availability)}
            </span>
          </div>
        </div>
      </div>
      <div className="grid cols-3">
        <div className="card">
          <h4>{tr('Database (PRAGMA)')}</h4>
          <KV k={tr('Journal mode')} v={h.database.journalMode} />
          <KV k={tr('Pages')} v={`${h.database.pageCount} × ${h.database.pageSize} B (${h.database.freelistPages} free)`} />
          <KV k={tr('WAL checkpoint')} v={h.database.walCheckpoint ? <span className="mono tiny">{JSON.stringify(h.database.walCheckpoint)}</span> : 'not in WAL mode'} />
          <KV k={tr('Storage')} v={h.database.path} />
          <KV k={tr('Scheduler')} v={`${h.scheduler.enabled ? 'enabled' : 'disabled'} · last runs: ${h.scheduler.lastRuns}`} />
        </div>
        <div className="card">
          <h4>{tr('Backlogs')}</h4>
          <KV k={tr('Webhook deliveries pending')} v={h.webhooks.pending} />
          <KV k={tr('Webhook deliveries retrying')} v={h.webhooks.retrying} />
          <KV k={tr('Webhook dead letters')} v={h.webhooks.dead ? <Chip kind="danger">{h.webhooks.dead}</Chip> : 0} />
          <KV k={tr('Switch outbox pending')} v={h.switchOutbox.pending} />
          <KV k={tr('Switch outbox dead')} v={h.switchOutbox.dead ? <Chip kind="danger">{h.switchOutbox.dead}</Chip> : 0} />
          <KV k={tr('Open incidents')} v={h.incidents.open} />
        </div>
        <div className="card">
          <h4>{tr('Rails & Guardian')}</h4>
          <div className="row wrap mb">
            {Object.entries(h.rails.byState).map(([s, n]) => (
              <Chip key={s} kind={(n as number) > 0 ? stateKind(s) : undefined}>
                {s} {n as number}
              </Chip>
            ))}
          </div>
          {h.rails.notUsable.length > 0 && (
            <ul className="small">
              {h.rails.notUsable.map((r: any) => (
                <li key={r.id}>
                  <b>{r.name}</b> — {r.state}
                  {r.reason ? `: ${r.reason}` : ''}
                </li>
              ))}
            </ul>
          )}
          <KV k={tr('Operating mode')} v={<Chip kind={h.guardian.operatingMode === 'normal' ? 'success' : 'danger'}>{h.guardian.operatingMode}</Chip>} />
          <div className="row wrap mb">
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                api
                  .post<any>('/api/admin/guardian/run', {})
                  .then((r) => {
                    setGuardian(r);
                    data.reload();
                  })
                  .catch((e) => toast(e.message, 'error'))
              }
            >
              {tr('Run the Guardian check now')}
            </Button>
            {guardian && (
              <Chip kind={guardian.result.ok ? 'success' : 'danger'}>
                {guardian.result.ok
                  ? tr('No discrepancy: every transaction balances and no balance is negative')
                  : tr('{0} finding(s): the platform is paused until an administrator resolves them', { 0: guardian.result.findings.length })}
              </Chip>
            )}
          </div>
          {guardian && !guardian.result.ok && (
            <ul className="small">
              {guardian.result.findings.map((f: any, i: number) => (
                <li key={i}>
                  <b>{f.kind}</b> {f.ref} — {f.detail}
                </li>
              ))}
            </ul>
          )}
          <KV
            k={tr('Last Guardian check')}
            v={h.guardian.lastCheck ? `${h.guardian.lastCheck.ok ? 'ok' : `${h.guardian.lastCheck.findings} finding(s)`} · ${fmtDate(h.guardian.lastCheck.at)}` : 'never'}
          />
          {h.guardian.openViolations.length > 0 && (
            <Alert kind="error">
              {h.guardian.openViolations.length} open Guardian violation(s):{' '}
              {h.guardian.openViolations
                .slice(0, 5)
                .map((v: any) => v.kind ?? v.type ?? JSON.stringify(v))
                .join(', ')}
            </Alert>
          )}
        </div>
      </div>
      <div className="row mt">
        <Button variant="secondary" onClick={data.reload}>
          {tr('Refresh')}
        </Button>
        <span className="small muted">generated {fmtDate(h.generatedAt)}</span>
      </div>
    </div>
  );
}

function Slo() {
  const data = useAsync(() => api.get<any>('/api/admin/system/slo'), []);
  const r = data.data?.report;
  if (!r) return data.error ? <Alert kind="error">{data.error}</Alert> : <p className="muted small">{tr('Loading…')}</p>;
  const win = (c: any, w: '1h' | '24h') => c.windows[w];
  return (
    <div>
      <div className="grid cols-2 mb">
        <div className="card">
          <div className="stat">
            <span className="label">{tr('National switch availability (target {0})', { 0: pctOf(r.switchAvailability.target) })}</span>
            <span className="value">
              {pctOf(r.switchAvailability['24h'].availability)} <Verdict met={r.switchAvailability['24h'].met} />
            </span>
            <span className="small muted">
              {tr('24 h on {0} request(s) · 1 h {1} on {2}', { 0: r.switchAvailability['24h'].requests, 1: pctOf(r.switchAvailability['1h'].availability), 2: r.switchAvailability['1h'].requests })}
            </span>
          </div>
        </div>
        <div className="card">
          <div className="stat">
            <span className="label">{tr('Targets over 24 h')}</span>
            <span className="value">
              {r.summary.met} met · {r.summary.missed} missed · {r.summary.noTraffic} no traffic
            </span>
            <span className="small muted">{tr('Health-aware failover keeps the switch target; the ring buffers hold the last 10 000 samples per class.')}</span>
          </div>
        </div>
      </div>
      <div className="card">
        <Table
          head={[tr('Class'), tr('Target'), tr('1 h p50 / p95 / p99'), tr('1 h errors'), tr('1 h'), tr('24 h p50 / p95 / p99'), tr('24 h requests'), tr('24 h error rate'), tr('24 h')]}
          rows={r.classes.map((c: any) => [
            <b>{c.class}</b>,
            <span className="tiny">{c.target ? c.target.label : c.class === 'switch' ? `availability ≥ ${pctOf(r.switchAvailability.target)}` : '—'}</span>,
            <span className="tiny">
              {ms(win(c, '1h').p50Ms)} / {ms(win(c, '1h').p95Ms)} / {ms(win(c, '1h').p99Ms)}
            </span>,
            <span className="tiny">
              {win(c, '1h').errors} server · {win(c, '1h').clientErrors} client · {win(c, '1h').rateLimited} rate-limited
            </span>,
            c.target ? <Verdict met={win(c, '1h').met} /> : c.class === 'switch' ? <Verdict met={r.switchAvailability['1h'].met} /> : '—',
            <span className="tiny">
              {ms(win(c, '24h').p50Ms)} / {ms(win(c, '24h').p95Ms)} / {ms(win(c, '24h').p99Ms)}
            </span>,
            <span className="tiny">
              {win(c, '24h').count} ({win(c, '24h').sampled} sampled)
            </span>,
            pctOf(win(c, '24h').errorRate),
            c.target ? <Verdict met={win(c, '24h').met} /> : c.class === 'switch' ? <Verdict met={r.switchAvailability['24h'].met} /> : '—',
          ])}
        />
        <div className="row mt">
          <Button variant="secondary" onClick={data.reload}>
            {tr('Refresh')}
          </Button>
          <span className="small muted">generated {fmtDate(r.generatedAt)}</span>
        </div>
      </div>
    </div>
  );
}

function ApiOps() {
  const [hours, setHours] = useState(24);
  const data = useAsync(() => api.get<any>(`/api/admin/system/api-ops${qs({ hours })}`), [hours]);
  const d = data.data;
  return (
    <div>
      <div className="row mb">
        <Select value={hours} onChange={(e) => setHours(Number(e.target.value))} style={{ width: 160 }}>
          <option value={1}>last hour</option>
          <option value={24}>last 24 hours</option>
          <option value={168}>last 7 days</option>
        </Select>
        <Button size="sm" variant="secondary" onClick={data.reload}>
          {tr('Refresh')}
        </Button>
      </div>
      {d && (
        <div className="grid cols-4 mb">
          <div className="card">
            <div className="stat">
              <span className="label">{tr('Requests')}</span>
              <span className="value">{d.totals.requests}</span>
            </div>
          </div>
          <div className="card">
            <div className="stat">
              <span className="label">{tr('Server errors')}</span>
              <span className="value">{d.totals.serverErrors}</span>
            </div>
          </div>
          <div className="card">
            <div className="stat">
              <span className="label">{tr('Client errors')}</span>
              <span className="value">{d.totals.clientErrors}</span>
            </div>
          </div>
          <div className="card">
            <div className="stat">
              <span className="label">{tr('Rate-limited (429)')}</span>
              <span className="value">{d.totals.rateLimited}</span>
            </div>
          </div>
        </div>
      )}
      <div className="grid cols-2">
        <div className="card">
          <h4>{tr('Usage per API key')}</h4>
          <Table
            head={[tr('Key'), tr('Mode'), tr('Requests'), tr('Errors'), tr('Rate-limited'), tr('Last seen')]}
            rows={(d?.keys ?? []).map((k: any) => [
              <span>
                <b>{k.label ?? 'unknown key'}</b> {k.revoked && <Chip kind="danger">revoked</Chip>}
                <br />
                <span className="mono tiny">{k.prefix ?? k.apiKeyId}</span>
              </span>,
              k.mode ?? '—',
              k.requests,
              k.errors,
              k.rateLimited,
              <span className="tiny">{k.lastMinute}</span>,
            ])}
            empty={tr('No API-key traffic in this window')}
          />
        </div>
        <div className="card">
          <h4>{tr('Top error codes')}</h4>
          <Table head={[tr('Code'), tr('Count')]} rows={(d?.topErrorCodes ?? []).map((c: any) => [<span className="mono small">{c.code}</span>, c.count])} empty={tr('No errors in this window')} />
        </div>
      </div>
    </div>
  );
}

const EMPTY_SLA = {
  counterparty: '',
  kind: 'processor',
  service: '',
  railId: '',
  availabilityPct: '',
  latencyTargetMs: '',
  supportContact: '',
  escalationContact: '',
  maintenanceWindow: '',
  incidentContact: '',
  reviewDate: '',
  documentRef: '',
};
function SlaRegister({ ok, err }: { ok: (m: string) => void; err: (e: any) => void }) {
  const list = useAsync(() => api.get<any>('/api/admin/system/sla'), []);
  const breaches = useAsync(() => api.get<any>('/api/admin/system/sla/breaches'), [list.data]);
  const [edit, setEdit] = useState<any>(null);
  const measurementFor = (id: string) => (breaches.data?.items ?? []).find((b: any) => b.entry.id === id);
  const open = (e?: any) =>
    setEdit(
      e
        ? {
            ...EMPTY_SLA,
            ...e,
            railId: e.railId ?? '',
            availabilityPct: e.availabilityTarget != null ? String(e.availabilityTarget * 100) : '',
            latencyTargetMs: e.latencyTargetMs ?? '',
            supportContact: e.supportContact ?? '',
            escalationContact: e.escalationContact ?? '',
            maintenanceWindow: e.maintenanceWindow ?? '',
            incidentContact: e.incidentContact ?? '',
            reviewDate: e.reviewDate ?? '',
            documentRef: e.documentRef ?? '',
          }
        : { ...EMPTY_SLA },
    );
  const save = () => {
    const body = {
      counterparty: edit.counterparty,
      kind: edit.kind,
      service: edit.service,
      railId: edit.railId || null,
      availabilityTarget: edit.availabilityPct === '' ? null : Number(edit.availabilityPct) / 100,
      latencyTargetMs: edit.latencyTargetMs === '' ? null : Number(edit.latencyTargetMs),
      supportContact: edit.supportContact || null,
      escalationContact: edit.escalationContact || null,
      maintenanceWindow: edit.maintenanceWindow || null,
      incidentContact: edit.incidentContact || null,
      reviewDate: edit.reviewDate || null,
      documentRef: edit.documentRef || null,
    };
    (edit.id ? api.put(`/api/admin/system/sla/${edit.id}`, body) : api.post('/api/admin/system/sla', body))
      .then(() => {
        ok('Saved');
        setEdit(null);
        list.reload();
      })
      .catch(err);
  };
  const text = (k: keyof typeof EMPTY_SLA, label: string, type = 'text') => (
    <Field label={label}>
      <Input type={type} value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} />
    </Field>
  );
  return (
    <div>
      {breaches.data && (
        <Alert kind={breaches.data.breached ? 'error' : 'success'}>
          {breaches.data.breached} breach(es) against {breaches.data.items.length} commitment(s) · {breaches.data.unmeasured} without a measurement source (no rail and not the switch). A breach is an
          observation to raise with the counterparty, never an automatic action.
        </Alert>
      )}
      <div className="card">
        <div className="row mb">
          <h4 style={{ margin: 0 }}>{tr('Counterparty commitments')}</h4>
          <Button size="sm" style={{ marginLeft: 'auto' }} onClick={() => open()}>
            {tr('Add SLA')}
          </Button>
        </div>
        <Table
          head={[tr('Counterparty'), tr('Kind'), tr('Service / rail'), tr('Committed'), tr('Measured'), tr('Contacts'), tr('Review'), '']}
          rows={(list.data?.items ?? []).map((e: any) => {
            const m = measurementFor(e.id);
            return [
              <b>{e.counterparty}</b>,
              e.kind,
              <span className="tiny">
                {e.service}
                {e.railId ? (
                  <>
                    <br />
                    <span className="mono">{e.railId}</span>
                  </>
                ) : null}
              </span>,
              <span className="tiny">
                {e.availabilityTarget != null ? `availability ≥ ${pctOf(e.availabilityTarget)}` : ''}
                {e.availabilityTarget != null && e.latencyTargetMs != null ? <br /> : null}
                {e.latencyTargetMs != null ? `p95 ≤ ${e.latencyTargetMs} ms` : ''}
                {e.maintenanceWindow ? (
                  <>
                    <br />
                    maintenance {e.maintenanceWindow}
                  </>
                ) : null}
              </span>,
              m ? (
                <span className="tiny">
                  {m.breached ? <Chip kind="danger">breach</Chip> : m.measured.source === 'none' ? <Chip>unmeasured</Chip> : <Chip kind="success">within</Chip>}
                  <br />
                  {m.measured.source !== 'none' && (
                    <>
                      availability {pctOf(m.measured.availability)} · p95 {ms(m.measured.p95LatencyMs)}
                      {m.measured.state ? ` · ${m.measured.state}` : ''}
                    </>
                  )}
                  {m.reasons.length > 0 && <div className="muted">{m.reasons.join('; ')}</div>}
                </span>
              ) : (
                '—'
              ),
              <span className="tiny">
                {e.supportContact && <div>support: {e.supportContact}</div>}
                {e.escalationContact && <div>escalation: {e.escalationContact}</div>}
                {e.incidentContact && <div>incident: {e.incidentContact}</div>}
              </span>,
              <span className="tiny">
                {e.reviewDate ?? '—'} {m?.reviewOverdue && <Chip kind="warning">overdue</Chip>}
                {e.documentRef && (
                  <>
                    <br />
                    {e.documentRef}
                  </>
                )}
              </span>,
              <div className="row">
                <Button size="sm" variant="secondary" onClick={() => open(e)}>
                  {tr('Edit')}
                </Button>
                <ConfirmButton
                  size="sm"
                  variant="ghost"
                  onConfirm={() =>
                    api
                      .del(`/api/admin/system/sla/${e.id}`)
                      .then(() => {
                        ok('Removed');
                        list.reload();
                      })
                      .catch(err)
                  }
                >
                  {tr('Remove')}
                </ConfirmButton>
              </div>,
            ];
          })}
          empty={tr('No SLA registered yet — add every processor, operator, switch, bank and vendor commitment with its contacts')}
        />
      </div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? tr('Edit SLA') : tr('Add SLA')} wide>
        {edit && (
          <>
            <div className="grid cols-2">
              {text('counterparty', 'Counterparty')}
              <Field label={tr('Kind')}>
                <Select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>
                  {(list.data?.kinds ?? ['processor', 'operator', 'switch', 'bank', 'vendor']).map((k: string) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </Select>
              </Field>
              {text('service', 'Service')}
              <Field label={tr('Rail (measured against its health)')} hint={tr("Leave empty for commitments without a rail; kind 'switch' is measured against the switch SLO")}>
                <Select value={edit.railId} onChange={(e) => setEdit({ ...edit, railId: e.target.value })}>
                  <option value="">none</option>
                  {(list.data?.rails ?? []).map((r: any) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({r.id})
                    </option>
                  ))}
                </Select>
              </Field>
              {text('availabilityPct', 'Availability target (%)', 'number')}
              {text('latencyTargetMs', 'Latency target p95 (ms)', 'number')}
              {text('supportContact', 'Support contact')}
              {text('escalationContact', 'Escalation contact')}
              {text('maintenanceWindow', 'Maintenance window')}
              {text('incidentContact', 'Incident contact')}
              {text('reviewDate', 'Review date', 'date')}
              {text('documentRef', 'Document reference')}
            </div>
            <Button onClick={save} disabled={edit.counterparty.length < 2 || edit.service.length < 2}>
              {tr('Save')}
            </Button>
          </>
        )}
      </Modal>
    </div>
  );
}

function GateToScale() {
  const [days, setDays] = useState(30);
  const data = useAsync(() => api.get<any>(`/api/admin/system/gate-to-scale${qs({ days })}`), [days]);
  const g = data.data;
  return (
    <div>
      {g && (
        <Alert kind={g.ready ? 'success' : 'warning'}>
          {g.ready ? (
            <>
              <b>{tr('Gate to scale open.')}</b> {tr('Every threshold has been met on the last')} {g.windowDays} days of real data.
            </>
          ) : (
            <>
              <b>{tr('Gate to scale closed.')}</b> {tr('Marketing spend waits until 95 % auto-reconciliation, under 2 % exceptions, zero Guardian halts and fraud loss under 25 bps hold over')}{' '}
              {g.windowDays} days of real data (since {fmtDate(g.since)}).
            </>
          )}
        </Alert>
      )}
      <div className="card">
        <div className="row mb">
          <Select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 160 }}>
            <option value={7}>last 7 days</option>
            <option value={30}>last 30 days</option>
            <option value={90}>last 90 days</option>
          </Select>
          <Button size="sm" variant="secondary" onClick={data.reload}>
            {tr('Re-check')}
          </Button>
        </div>
        <Table
          head={['', tr('Threshold'), tr('Measured'), tr('What to do')]}
          rows={(g?.items ?? []).map((i: any) => [
            i.ok ? <Chip kind="success">ok</Chip> : <Chip kind="danger">not met</Chip>,
            <b>{i.label}</b>,
            <span className="tiny">{i.detail}</span>,
            <span className="tiny muted">{i.ok ? '' : (i.fix ?? '')}</span>,
          ])}
          empty={tr('Loading…')}
        />
      </div>
    </div>
  );
}
