import { useState } from 'react';
import { tr } from '../lib/i18n';
import { api, qs } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Chip, ConfirmButton, Field, Input, KV, PageHeader, Select, StatusBadge, Table, Tabs, fmtDate, useAsync } from '../components/ui';

/** Intelligence console: AI gateway economics and routing, the agent mesh, domain events, Diaspora-Direct rate policies and institutions, the offline protocol. */
export function Intelligence() {
  const { toast, money } = useStore();
  const [tab, setTab] = useState<'gateway' | 'mesh' | 'events' | 'diaspora' | 'offline'>('gateway');
  const err = (e: any) => toast(e.message, 'error');
  const ok = (m: string) => toast(m, 'success');
  return (
    <div>
      <PageHeader
        title={tr('Intelligence')}
        subtitle={tr('Every model call goes through one gateway with a margin floor; every operations agent is bound to an event, shadow-first; people confirm money.')}
      />
      <Tabs
        tabs={[
          { id: 'gateway', label: tr('AI gateway & ACU') },
          { id: 'mesh', label: tr('Agent mesh') },
          { id: 'events', label: tr('Domain events') },
          { id: 'diaspora', label: tr('Diaspora-Direct') },
          { id: 'offline', label: tr('Offline protocol') },
        ]}
        value={tab}
        onChange={(v) => setTab(v as any)}
      />
      {tab === 'gateway' && <Gateway ok={ok} err={err} />}
      {tab === 'mesh' && <Mesh ok={ok} err={err} />}
      {tab === 'events' && <Events ok={ok} err={err} />}
      {tab === 'diaspora' && <Diaspora ok={ok} err={err} />}
      {tab === 'offline' && <Offline ok={ok} err={err} money={money} />}
    </div>
  );
}
const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(4)}`;

function Gateway({ ok, err }: { ok: (m: string) => void; err: (e: any) => void }) {
  const data = useAsync(() => api.get<any>('/api/admin/intelligence/gateway'), []);
  const ledger = useAsync(() => api.get<any>('/api/admin/intelligence/gateway/ledger?limit=100'), []);
  const [policy, setPolicy] = useState<any>(null);
  const d = data.data;
  if (!d)
    return (
      <div className="loading-page">
        <span className="spinner" />
      </div>
    );
  const p = policy ?? d.policy;
  return (
    <div>
      <Alert kind={d.totals.belowFloor ? 'error' : 'success'}>
        {tr('Realised gross margin over')} {d.days} days: <b>{d.totals.acuRevenueMicros ? `${(d.totals.margin * 100).toFixed(1)}%` : 'n/a'}</b> · floor {(d.policy.minGrossMargin * 100).toFixed(0)}% ·{' '}
        {d.totals.requests} requests · cost {usd(d.totals.rawCostMicros)} · ACU revenue {usd(d.totals.acuRevenueMicros)}
      </Alert>
      <div className="grid cols-2">
        <div className="card">
          <h4>{tr('Models on the router')}</h4>
          <Table
            head={[tr('Model'), tr('Provider'), tr('Circuit'), tr('List price in/out'), tr('Projected margin'), '']}
            rows={(d.models ?? []).map((m: any) => [
              <span className="mono tiny">{m.model}</span>,
              m.provider,
              m.circuitOpen ? <Chip kind="danger">open</Chip> : <Chip kind="success">closed</Chip>,
              m.listPrice ? `${m.listPrice.input} / ${m.listPrice.output} per M` : '—',
              <Chip kind={m.economics.ok ? 'success' : 'danger'}>{(m.economics.margin * 100).toFixed(0)}%</Chip>,
              <span className="tiny">{m.providerEnabled ? 'enabled' : 'disabled'}</span>,
            ])}
            empty={tr('No models')}
          />
          <h4 className="mt">{tr('Task routing')}</h4>
          {Object.entries(d.routing.taskTypes).map(([t, models]: any) => (
            <KV key={t} k={t} v={<span className="mono tiny">{models.join(' → ')}</span>} />
          ))}
          <p className="small muted">
            {tr("Failover after errors or {0} ms; a model's circuit opens after {1} failures in {2} min.", {
              0: d.routing.timeoutMs,
              1: d.routing.circuitFailures,
              2: d.routing.circuitWindowMs / 60000,
            })}
          </p>
        </div>
        <div className="card">
          <h4>{tr('ACU policy')}</h4>
          <div className="grid cols-2">
            <Field label={tr('ACU price (micro-dollars)')}>
              <Input type="number" value={p.acuPriceMicros} onChange={(e) => setPolicy({ ...p, acuPriceMicros: Number(e.target.value) })} />
            </Field>
            <Field label={tr('ACU per 1k tokens')}>
              <Input type="number" step="0.1" value={p.acuPerKiloToken} onChange={(e) => setPolicy({ ...p, acuPerKiloToken: Number(e.target.value) })} />
            </Field>
            <Field label={tr('Margin floor (≥ 0.66)')}>
              <Input type="number" step="0.01" value={p.minGrossMargin} onChange={(e) => setPolicy({ ...p, minGrossMargin: Number(e.target.value) })} />
            </Field>
            <Field label={tr('Alert below')}>
              <Input type="number" step="0.01" value={p.alertBelowMargin} onChange={(e) => setPolicy({ ...p, alertBelowMargin: Number(e.target.value) })} />
            </Field>
            <Field label={tr('Monthly budget / user (ACU, 0 = none)')}>
              <Input type="number" value={p.monthlyBudgetPerUser} onChange={(e) => setPolicy({ ...p, monthlyBudgetPerUser: Number(e.target.value) })} />
            </Field>
            <Field label={tr('Monthly budget / tenant')}>
              <Input type="number" value={p.monthlyBudgetPerTenant} onChange={(e) => setPolicy({ ...p, monthlyBudgetPerTenant: Number(e.target.value) })} />
            </Field>
            <Field label={tr('Overage')}>
              <Select value={p.overage} onChange={(e) => setPolicy({ ...p, overage: e.target.value })}>
                <option value="block">block (AI paused)</option>
                <option value="bill">bill</option>
              </Select>
            </Field>
            <Field label={tr('Expected tokens (standard / deep)')}>
              <div className="row">
                <Input type="number" value={p.expectedTokensStandard} onChange={(e) => setPolicy({ ...p, expectedTokensStandard: Number(e.target.value) })} />
                <Input type="number" value={p.expectedTokensDeep} onChange={(e) => setPolicy({ ...p, expectedTokensDeep: Number(e.target.value) })} />
              </div>
            </Field>
          </div>
          <div className="row">
            <Button
              onClick={() =>
                api
                  .put('/api/admin/intelligence/gateway/acu-policy', p)
                  .then(() => {
                    ok('Policy saved');
                    setPolicy(null);
                    data.reload();
                  })
                  .catch(err)
              }
            >
              {tr('Save')}
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                api
                  .post('/api/admin/intelligence/gateway/reconcile-margin', {})
                  .then((r: any) => ok(`${r.month}: margin ${r.margin === null ? 'n/a' : `${(r.margin * 100).toFixed(1)}%`}${r.belowFloor ? ' — BELOW FLOOR' : ''}`))
                  .catch(err)
              }
            >
              {tr('Reconcile this month')}
            </Button>
          </div>
          <h4 className="mt">{tr('Budgets this month')}</h4>
          {(d.budgets ?? []).map((b: any) => (
            <KV key={`${b.scope}-${b.scopeId}`} k={`${b.scope} ${b.scopeId}`} v={`${b.used.toFixed(3)} / ${b.budget || '∞'} ACU`} />
          ))}
        </div>
      </div>
      <div className="card mt">
        <h4>{tr('Usage ledger (administrators only)')}</h4>
        <Table
          head={[tr('When'), tr('Agent'), tr('Task'), tr('Provider / model'), tr('Tokens'), tr('Cost'), 'ACU', tr('Margin'), tr('Outcome')]}
          rows={(ledger.data?.items ?? []).map((x: any) => [
            <span className="tiny">{fmtDate(x.createdAt)}</span>,
            x.agent,
            x.taskType,
            <span className="mono tiny">
              {x.provider}/{x.model}
            </span>,
            `${x.tokensIn}/${x.tokensOut}`,
            usd(x.rawCostMicros),
            x.acuUsed.toFixed(3),
            x.margin === null ? '—' : `${(x.margin * 100).toFixed(0)}%`,
            <StatusBadge status={x.outcome} />,
          ])}
          empty={tr('No neural requests yet')}
        />
      </div>
    </div>
  );
}

function Mesh({ ok, err }: { ok: (m: string) => void; err: (e: any) => void }) {
  const data = useAsync(() => api.get<any>('/api/admin/intelligence/mesh'), []);
  const [drill, setDrill] = useState({ type: 'connector.degraded', aggregateId: 'mpesa_cd', payload: '{"connector":"mpesa_cd","failures":5}' });
  return (
    <div>
      <p className="small muted">
        {tr('Every binding starts in shadow mode: the agent reads and reports, side-effecting tools are refused. After')} {data.data?.shadowDays} days it can be promoted to propose (approvals by a
        second administrator); money never moves without a person.
      </p>
      <div className="card">
        <Table
          head={[tr('Registry'), tr('Agent'), tr('Event'), tr('Autonomy'), tr('Runs'), tr('Last run'), tr('Eligible'), '']}
          rows={(data.data?.bindings ?? []).map((b: any) => [
            <b>{b.registryId}</b>,
            <span>
              {data.data.agents.find((a: any) => a.key === b.agentKey)?.name ?? b.agentKey}
              <br />
              <span className="tiny muted">{(data.data.agents.find((a: any) => a.key === b.agentKey)?.aliases ?? []).join(', ')}</span>
            </span>,
            <span className="mono tiny">{b.eventType}</span>,
            <span>
              <Chip kind={b.autonomy === 'propose' ? 'primary' : undefined}>{b.autonomy}</Chip>
              {b.killSwitch && <Chip kind="danger">killed</Chip>}
              {!b.enabled && <Chip>disabled</Chip>}
            </span>,
            b.runs,
            <span className="tiny">{fmtDate(b.lastRunAt)}</span>,
            <span className="tiny">{b.eligibleForPromotionAt.slice(0, 10)}</span>,
            <div className="row">
              {b.autonomy === 'shadow' ? (
                <ConfirmButton
                  size="sm"
                  prompt="Override reason (leave empty after the shadow period)"
                  onConfirm={(o) =>
                    api
                      .post(`/api/admin/intelligence/mesh/bindings/${b.id}/promote`, { override: o || null })
                      .then(() => {
                        ok('Promoted');
                        data.reload();
                      })
                      .catch(err)
                  }
                >
                  {tr('Promote')}
                </ConfirmButton>
              ) : (
                <ConfirmButton
                  size="sm"
                  variant="ghost"
                  prompt="Reason"
                  onConfirm={(r) =>
                    api
                      .post(`/api/admin/intelligence/mesh/bindings/${b.id}/demote`, { reason: r || 'back to shadow' })
                      .then(() => {
                        ok('Demoted');
                        data.reload();
                      })
                      .catch(err)
                  }
                >
                  {tr('Demote')}
                </ConfirmButton>
              )}
              <ConfirmButton
                size="sm"
                variant={b.killSwitch ? 'success' : 'danger'}
                onConfirm={() =>
                  api
                    .post(`/api/admin/intelligence/mesh/bindings/${b.id}/kill-switch`, { on: !b.killSwitch, reason: 'console' })
                    .then(() => {
                      ok('Updated');
                      data.reload();
                    })
                    .catch(err)
                }
              >
                {b.killSwitch ? tr('Revive') : tr('Kill')}
              </ConfirmButton>
            </div>,
          ])}
          empty={tr('No bindings')}
        />
      </div>
      <div className="card mt">
        <h4>{tr('Drill: publish an event into the mesh')}</h4>
        <div className="grid cols-3">
          <Field label={tr('Type')}>
            <Select value={drill.type} onChange={(e) => setDrill({ ...drill, type: e.target.value })}>
              {(data.data?.eventTypes ?? []).map((t: string) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          </Field>
          <Field label={tr('Aggregate id')}>
            <Input value={drill.aggregateId} onChange={(e) => setDrill({ ...drill, aggregateId: e.target.value })} />
          </Field>
          <Field label={tr('Payload JSON')}>
            <Input value={drill.payload} onChange={(e) => setDrill({ ...drill, payload: e.target.value })} />
          </Field>
        </div>
        <Button
          size="sm"
          onClick={() => {
            let payload;
            try {
              payload = JSON.parse(drill.payload);
            } catch {
              return err(new Error('Payload must be JSON'));
            }
            api
              .post('/api/admin/intelligence/events', { type: drill.type, aggregateId: drill.aggregateId, payload })
              .then(() => {
                ok('Published');
                data.reload();
              })
              .catch(err);
          }}
        >
          {tr('Publish drill')}
        </Button>
      </div>
    </div>
  );
}

function Events(_props: { ok: (m: string) => void; err: (e: any) => void }) {
  const [type, setType] = useState('');
  const data = useAsync(() => api.get<any>(`/api/admin/intelligence/events${qs({ type, limit: 100 })}`), [type]);
  return (
    <div className="card">
      <div className="row mb">
        <Input placeholder="type filter" value={type} onChange={(e) => setType(e.target.value)} style={{ width: 260 }} />
        <Button size="sm" variant="ghost" onClick={() => data.reload()}>
          {tr('Refresh')}
        </Button>
      </div>
      <Table
        head={[tr('When'), tr('Type'), tr('Tenant'), tr('Aggregate'), 'Handled by', tr('Payload')]}
        rows={(data.data?.items ?? []).map((e: any) => [
          <span className="tiny">{fmtDate(e.occurredAt)}</span>,
          <span className="mono tiny">{e.type}</span>,
          <span className="tiny">{e.tenantId}</span>,
          <span className="mono tiny">{e.aggregateId ?? '—'}</span>,
          <span className="tiny">{(e.handled ?? []).join(', ') || '—'}</span>,
          <span className="tiny" style={{ maxWidth: 360, display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {JSON.stringify(e.payload)}
          </span>,
        ])}
        empty={tr('No events')}
      />
    </div>
  );
}

function Diaspora({ ok, err }: { ok: (m: string) => void; err: (e: any) => void }) {
  const data = useAsync(() => api.get<any>('/api/admin/intelligence/diaspora'), []);
  const [form, setForm] = useState({ sourceCurrency: 'GBP', destCurrency: 'CDF', markupBps: 150, feeBps: 100, feeFixedSourceMinor: 99, maxValidityHours: 4, minSourceMinor: 0, maxSourceMinor: 0 });
  return (
    <div className="grid cols-2">
      <div className="card">
        <h4>{tr('Sign a rate policy')}</h4>
        <p className="small muted">
          {tr('Your signature binds the markup, fees and ceilings; rate cards are then re-issued from the live mid-market rate under this policy at most every {0} hours.', {
            0: form.maxValidityHours,
          })}
        </p>
        <div className="grid cols-2">
          {(['sourceCurrency', 'destCurrency'] as const).map((k) => (
            <Field key={k} label={k}>
              <Input value={(form as any)[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value.toUpperCase() })} />
            </Field>
          ))}
          {(['markupBps', 'feeBps', 'feeFixedSourceMinor', 'maxValidityHours', 'minSourceMinor', 'maxSourceMinor'] as const).map((k) => (
            <Field key={k} label={k}>
              <Input type="number" value={(form as any)[k]} onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })} />
            </Field>
          ))}
        </div>
        <ConfirmButton
          onConfirm={() =>
            api
              .post('/api/admin/intelligence/diaspora/policies', form)
              .then(() => {
                ok('Policy signed, card issued');
                data.reload();
              })
              .catch(err)
          }
        >
          {tr('Sign policy')}
        </ConfirmButton>
        <h4 className="mt">{tr('Policies')}</h4>
        <Table
          head={[tr('Pair'), tr('Markup'), tr('Fees'), tr('Validity'), tr('Version'), tr('Status')]}
          rows={(data.data?.policies ?? []).map((p: any) => [
            `${p.sourceCurrency}/${p.destCurrency}`,
            `${p.markupBps} bps`,
            `${p.feeBps} bps + ${p.feeFixedSourceMinor}`,
            `${p.maxValidityHours}h`,
            `v${p.version}`,
            <StatusBadge status={p.status} />,
          ])}
          empty={tr('No policies')}
        />
      </div>
      <div className="card">
        <div className="row">
          <h4 style={{ margin: 0 }}>{tr('Rate cards')}</h4>
          <Button
            size="sm"
            variant="secondary"
            style={{ marginLeft: 'auto' }}
            onClick={() =>
              api
                .post('/api/admin/intelligence/diaspora/cards/refresh', {})
                .then((r: any) => {
                  ok(`Issued ${r.issued}`);
                  data.reload();
                })
                .catch(err)
            }
          >
            {tr('Refresh')}
          </Button>
        </div>
        <Table
          head={[tr('Pair'), tr('Mid'), tr('Customer'), tr('Provider'), tr('Valid until')]}
          rows={(data.data?.cards ?? []).map((c: any) => [
            `${c.sourceCurrency}/${c.destCurrency}`,
            c.midRate.toFixed(4),
            <b>{c.customerRate.toFixed(4)}</b>,
            <span className="tiny">{c.provider}</span>,
            <span className="tiny">{fmtDate(c.validUntil)}</span>,
          ])}
          empty={tr('No cards')}
        />
        <h4 className="mt">{tr('Institutions')}</h4>
        <Table
          head={[tr('Institution'), tr('Kind'), tr('Purposes'), tr('Status'), '']}
          rows={(data.data?.institutions ?? []).map((i: any) => [
            <b>
              {i.name}
              <br />
              <span className="tiny muted">
                {i.registryRef ?? ''} · {i.country}
              </span>
            </b>,
            i.kind,
            <span className="tiny">{i.purposeCodes.join(', ')}</span>,
            <StatusBadge status={i.status} />,
            <div className="row">
              {i.status !== 'verified' && (
                <ConfirmButton
                  size="sm"
                  variant="success"
                  onConfirm={() =>
                    api
                      .post(`/api/admin/intelligence/diaspora/institutions/${i.userId}/review`, { decision: 'verified' })
                      .then(() => {
                        ok('Verified');
                        data.reload();
                      })
                      .catch(err)
                  }
                >
                  {tr('Verify')}
                </ConfirmButton>
              )}
              {i.status === 'verified' && (
                <ConfirmButton
                  size="sm"
                  variant="danger"
                  prompt="Reason"
                  onConfirm={(n) =>
                    api
                      .post(`/api/admin/intelligence/diaspora/institutions/${i.userId}/review`, { decision: 'suspended', note: n })
                      .then(() => {
                        ok('Suspended');
                        data.reload();
                      })
                      .catch(err)
                  }
                >
                  {tr('Suspend')}
                </ConfirmButton>
              )}
            </div>,
          ])}
          empty={tr('No institutions')}
        />
      </div>
    </div>
  );
}

function Offline({ ok, err, money }: { ok: (m: string) => void; err: (e: any) => void; money: (m: number, c: string) => string }) {
  const data = useAsync(() => api.get<any>('/api/admin/intelligence/offline'), []);
  const [s, setS] = useState<any>(null);
  const cur = s ?? data.data?.settings;
  return (
    <div className="grid cols-2">
      <div className="card">
        <h4>{tr('Settings')}</h4>
        {cur && (
          <>
            <div className="grid cols-2">
              <Field label={tr('Ceiling per promise (base minor)')}>
                <Input type="number" value={cur.maxPerPromiseBase} onChange={(e) => setS({ ...cur, maxPerPromiseBase: Number(e.target.value) })} />
              </Field>
              <Field label={tr('Per device / 24h')}>
                <Input type="number" value={cur.maxOutstandingPerDeviceBase} onChange={(e) => setS({ ...cur, maxOutstandingPerDeviceBase: Number(e.target.value) })} />
              </Field>
              <Field label={tr('Promise validity (h)')}>
                <Input type="number" value={cur.promiseValidityHours} onChange={(e) => setS({ ...cur, promiseValidityHours: Number(e.target.value) })} />
              </Field>
              <Field label={tr('QR TTL (s)')}>
                <Input type="number" value={cur.qrTtlSeconds} onChange={(e) => setS({ ...cur, qrTtlSeconds: Number(e.target.value) })} />
              </Field>
            </div>
            <label className="checkbox mb">
              <input type="checkbox" checked={!!cur.enabled} onChange={(e) => setS({ ...cur, enabled: e.target.checked })} /> {tr('Offline acceptance enabled')}
            </label>
            <div className="row">
              <Button
                onClick={() =>
                  api
                    .put('/api/admin/intelligence/offline/settings', cur)
                    .then(() => {
                      ok('Saved');
                      setS(null);
                      data.reload();
                    })
                    .catch(err)
                }
              >
                {tr('Save')}
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  api
                    .post('/api/admin/intelligence/offline/purge-nonces', {})
                    .then((r: any) => ok(`Purged ${r.purged}`))
                    .catch(err)
                }
              >
                {tr('Purge expired nonces')}
              </Button>
            </div>
          </>
        )}
        <h4 className="mt">{tr('Totals')}</h4>
        {(data.data?.stats ?? []).map((st: any) => (
          <KV key={st.state} k={st.state} v={`${st.count} · ${st.amountMinor} minor`} />
        ))}
        <KV k={tr('Devices')} v={data.data?.devices ?? 0} />
      </div>
      <div className="card">
        <h4>{tr('Recent promises')}</h4>
        <Table
          head={[tr('Hash'), tr('Amount'), tr('Payer'), tr('Merchant'), tr('State'), tr('Reason'), tr('Synced')]}
          rows={(data.data?.promises ?? []).map((p: any) => [
            <span className="mono tiny">{p.hash.slice(0, 12)}…</span>,
            money(p.amountMinor, p.currency),
            <span className="tiny">{p.payerId.slice(0, 8)}</span>,
            <span className="tiny">{p.merchantId.slice(0, 8)}</span>,
            <StatusBadge status={p.state} />,
            <span className="tiny">{p.rejectReason ?? ''}</span>,
            <span className="tiny">{fmtDate(p.syncedAt)}</span>,
          ])}
          empty={tr('No offline promises yet')}
        />
      </div>
    </div>
  );
}
