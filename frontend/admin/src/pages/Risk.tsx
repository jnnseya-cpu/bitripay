import { useState } from 'react';
import { api, qs } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Chip, ConfirmButton, Field, Input, KV, PageHeader, Select, StatusBadge, Table, Tabs, Textarea, fmtDate, useAsync } from '../components/ui';

/** Risk & compliance console: policy versions, fraud scores, compliance cases with SAR drafts, sanctions sources, KYC tiers & KYB, destination changes, agent intelligence. */
export function Risk() {
  const { toast, money } = useStore();
  const [tab, setTab] = useState<'policies' | 'fraud' | 'cases' | 'sanctions' | 'kyc' | 'destinations' | 'agents'>('cases');
  const err = (e: any) => toast(e.message, 'error');
  const ok = (m: string) => toast(m, 'success');
  return (
    <div>
      <PageHeader
        title="Risk & compliance"
        subtitle="Deterministic controls that run for every account: an explainable policy, fraud scores, cases with a report draft, sanctions lists with versions, tiers and business verification."
      />
      <Tabs
        tabs={[
          { id: 'cases', label: 'Compliance cases' },
          { id: 'fraud', label: 'Fraud scores' },
          { id: 'policies', label: 'Risk policy' },
          { id: 'sanctions', label: 'Sanctions lists' },
          { id: 'kyc', label: 'KYC tiers & KYB' },
          { id: 'destinations', label: 'Destination changes' },
          { id: 'agents', label: 'Agent intelligence' },
        ]}
        value={tab}
        onChange={(v) => setTab(v as any)}
      />
      {tab === 'cases' && <Cases ok={ok} err={err} />}
      {tab === 'fraud' && <Fraud />}
      {tab === 'policies' && <Policies ok={ok} err={err} />}
      {tab === 'sanctions' && <Sanctions ok={ok} err={err} />}
      {tab === 'kyc' && <Kyc ok={ok} err={err} />}
      {tab === 'destinations' && <Destinations ok={ok} err={err} />}
      {tab === 'agents' && <AgentIntel ok={ok} err={err} money={money} />}
    </div>
  );
}

function Cases({ ok, err }: { ok: (m: string) => void; err: (e: any) => void }) {
  const [status, setStatus] = useState('');
  const data = useAsync(() => api.get<any>(`/api/admin/risk/cases${qs({ status })}`), [status]);
  const [sel, setSel] = useState<any>(null);
  const [sar, setSar] = useState('');
  const [decision, setDecision] = useState({ decision: 'NO_ACTION', reason: '', sarReference: '' });
  const open = (c: any) => {
    setSel(c);
    setSar(c.sarDraft ?? '');
  };
  return (
    <div>
      <div className="grid cols-4 mb">
        {(data.data?.open ?? []).slice(0, 4).map((o: any) => (
          <div className="card" key={`${o.kind}-${o.severity}`}>
            <div className="stat">
              <span className="label">
                {o.kind} · {o.severity}
              </span>
              <span className="value">{o.count}</span>
              <span className="small muted">oldest {o.oldestAgeHours}h</span>
            </div>
          </div>
        ))}
        <div className="card">
          <div className="stat">
            <span className="label">SAR drafts open</span>
            <span className="value">{data.data?.sarDrafts ?? 0}</span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              api
                .post('/api/admin/risk/aml/run', {})
                .then((r: any) => {
                  ok(`AML scan: ${r.scanned} accounts, ${r.opened} new case(s)`);
                  data.reload();
                })
                .catch(err)
            }
          >
            Run AML monitor
          </Button>
        </div>
      </div>
      <div className="grid cols-2">
        <div className="card">
          <div className="row mb">
            <Select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 200 }}>
              <option value="">All</option>
              {['OPEN', 'ASSIGNED', 'ESCALATED', 'DECIDED', 'CLOSED'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </Select>
          </div>
          <Table
            head={['Case', 'Kind', 'Severity', 'Account', 'Status', '']}
            rows={(data.data?.items ?? []).map((c: any) => [
              <span>
                <b>{c.title}</b>
                <br />
                <span className="mono tiny">{c.id}</span>
              </span>,
              c.kind,
              <Chip kind={c.severity === 'critical' ? 'danger' : c.severity === 'high' ? 'warning' : undefined}>{c.severity}</Chip>,
              <span className="tiny">{c.user?.fullName ?? c.userId ?? '—'}</span>,
              <StatusBadge status={c.status} />,
              <Button size="sm" variant="secondary" onClick={() => open(c)}>
                Open
              </Button>,
            ])}
            empty="No cases"
          />
        </div>
        <div className="card">
          {!sel && <p className="small muted">Open a case to read the indicators, edit the report draft, decide and close (a different officer closes).</p>}
          {sel && (
            <>
              <h4>{sel.title}</h4>
              <p className="small">{sel.summary}</p>
              <div className="row wrap mb">
                {sel.indicators.map((i: string) => (
                  <Chip key={i}>{i}</Chip>
                ))}
              </div>
              <div className="row mb">
                <ConfirmButton
                  size="sm"
                  onConfirm={() =>
                    api
                      .post(`/api/admin/risk/cases/${sel.id}/assign`, {})
                      .then(() => {
                        ok('Assigned to you');
                        data.reload();
                      })
                      .catch(err)
                  }
                >
                  Assign to me
                </ConfirmButton>
                <ConfirmButton
                  size="sm"
                  variant="danger"
                  prompt="Note"
                  onConfirm={(n) =>
                    api
                      .post(`/api/admin/risk/cases/${sel.id}/escalate`, { note: n || 'escalated' })
                      .then(() => {
                        ok('Escalated');
                        data.reload();
                      })
                      .catch(err)
                  }
                >
                  Escalate
                </ConfirmButton>
              </div>
              <Field label="Suspicious activity report (draft)">
                <Textarea rows={10} value={sar} onChange={(e) => setSar(e.target.value)} />
              </Field>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  api
                    .put(`/api/admin/risk/cases/${sel.id}/sar`, { text: sar })
                    .then(() => ok('Draft saved'))
                    .catch(err)
                }
              >
                Save draft
              </Button>
              {sel.status !== 'CLOSED' && sel.status !== 'DECIDED' && (
                <div className="mt">
                  <div className="grid cols-2">
                    <Field label="Decision">
                      <Select value={decision.decision} onChange={(e) => setDecision({ ...decision, decision: e.target.value })}>
                        {(data.data?.decisions ?? ['NO_ACTION', 'CLEARED', 'SAR_FILED', 'ACCOUNT_RESTRICTED', 'ACCOUNT_CLOSED']).map((d: string) => (
                          <option key={d}>{d}</option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Filing reference (SAR_FILED)">
                      <Input value={decision.sarReference} onChange={(e) => setDecision({ ...decision, sarReference: e.target.value })} />
                    </Field>
                  </div>
                  <Field label="Reason">
                    <Input value={decision.reason} onChange={(e) => setDecision({ ...decision, reason: e.target.value })} />
                  </Field>
                  <ConfirmButton
                    onConfirm={() =>
                      api
                        .post(`/api/admin/risk/cases/${sel.id}/decide`, { ...decision, sarReference: decision.sarReference || null })
                        .then(() => {
                          ok('Decided');
                          data.reload();
                          setSel(null);
                        })
                        .catch(err)
                    }
                  >
                    Decide
                  </ConfirmButton>
                </div>
              )}
              {sel.status === 'DECIDED' && (
                <div className="mt">
                  <KV k="Decision" v={`${sel.decision}: ${sel.decisionReason}`} />
                  <ConfirmButton
                    variant="success"
                    onConfirm={() =>
                      api
                        .post(`/api/admin/risk/cases/${sel.id}/close`, {})
                        .then(() => {
                          ok('Closed');
                          data.reload();
                          setSel(null);
                        })
                        .catch(err)
                    }
                  >
                    Close (four eyes)
                  </ConfirmButton>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Fraud() {
  const [band, setBand] = useState('');
  const data = useAsync(() => api.get<any>(`/api/admin/risk/fraud${qs({ band, limit: 100 })}`), [band]);
  return (
    <div>
      <div className="grid cols-4 mb">
        {Object.entries(data.data?.byBand ?? {}).map(([k, v]) => (
          <div className="card" key={k}>
            <div className="stat">
              <span className="label">{k.replace('_', ' ')}</span>
              <span className="value">{String(v)}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="card">
        <div className="row mb">
          <Select value={band} onChange={(e) => setBand(e.target.value)} style={{ width: 200 }}>
            <option value="">All bands</option>
            {['approve', 'step_up', 'review', 'block'].map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </Select>
          <span className="small muted">
            top factors:{' '}
            {Object.entries(data.data?.topFactors ?? {})
              .map(([k, v]) => `${k} ${v}`)
              .join(' · ')}
          </span>
        </div>
        <Table
          head={['When', 'Account', 'Kind', 'Amount', 'Score', 'Band', 'Rule', 'Factors']}
          rows={(data.data?.items ?? []).map((s: any) => [
            <span className="tiny">{fmtDate(s.createdAt)}</span>,
            <span className="tiny">{s.userId ?? '—'}</span>,
            s.kind,
            `${s.amount.valueMinor} ${s.amount.currency}`,
            <b>{s.score}</b>,
            <StatusBadge status={s.band} />,
            <span className="mono tiny">{s.policyRule ?? '—'}</span>,
            <span className="tiny">{s.factors.map((f: any) => `${f.code} +${f.points}`).join(', ')}</span>,
          ])}
          empty="No scores yet"
        />
      </div>
    </div>
  );
}

function Policies({ ok, err }: { ok: (m: string) => void; err: (e: any) => void }) {
  const data = useAsync(() => api.get<any>('/api/admin/risk/policies'), []);
  const [sim, setSim] = useState({ kind: 'transfer', baseMinor: 10000, score: 45, flags: '' });
  const [out, setOut] = useState<any>(null);
  return (
    <div className="grid cols-2">
      <div className="card">
        <Table
          head={['Version', 'Name', 'Status', 'Rules', '']}
          rows={(data.data?.items ?? []).map((p: any) => [
            `v${p.version}`,
            p.name,
            <StatusBadge status={p.status} />,
            <span className="tiny">{p.rules.map((r: any) => `${r.id}→${r.action}`).join(' · ')}</span>,
            <div className="row">
              {p.status === 'DRAFT' && (
                <ConfirmButton
                  size="sm"
                  onConfirm={() =>
                    api
                      .post(`/api/admin/risk/policies/${p.id}/approve`, {})
                      .then(() => {
                        ok('Approved');
                        data.reload();
                      })
                      .catch(err)
                  }
                >
                  Approve
                </ConfirmButton>
              )}
              {p.status === 'APPROVED' && (
                <ConfirmButton
                  size="sm"
                  variant="success"
                  onConfirm={() =>
                    api
                      .post(`/api/admin/risk/policies/${p.id}/activate`, {})
                      .then(() => {
                        ok('Activated');
                        data.reload();
                      })
                      .catch(err)
                  }
                >
                  Activate
                </ConfirmButton>
              )}
            </div>,
          ])}
          empty="No policies"
        />
      </div>
      <div className="card">
        <h4>Simulate the active policy</h4>
        <div className="grid cols-3">
          <Field label="Kind">
            <Input value={sim.kind} onChange={(e) => setSim({ ...sim, kind: e.target.value })} />
          </Field>
          <Field label="Base minor">
            <Input type="number" value={sim.baseMinor} onChange={(e) => setSim({ ...sim, baseMinor: Number(e.target.value) })} />
          </Field>
          <Field label="Score">
            <Input type="number" value={sim.score} onChange={(e) => setSim({ ...sim, score: Number(e.target.value) })} />
          </Field>
        </div>
        <Field label="Flags (comma separated)">
          <Input value={sim.flags} onChange={(e) => setSim({ ...sim, flags: e.target.value })} placeholder="sanctions:name:X" />
        </Field>
        <Button
          onClick={() =>
            api
              .post<any>('/api/admin/risk/policies/simulate', { ...sim, flags: sim.flags ? sim.flags.split(',').map((f) => f.trim()) : [] })
              .then(setOut)
              .catch(err)
          }
        >
          Decide
        </Button>
        {out && (
          <Alert kind={out.action === 'block' ? 'error' : out.action === 'allow' ? 'success' : 'warning'}>
            {out.action} · rule {out.rule?.id ?? 'none'} · {out.reason} · policy v{out.version}
          </Alert>
        )}
      </div>
    </div>
  );
}

function Sanctions({ ok, err }: { ok: (m: string) => void; err: (e: any) => void }) {
  const data = useAsync(() => api.get<any>('/api/admin/risk/sanctions/sources'), []);
  const [src, setSrc] = useState({ id: '', name: '', url: '', kind: 'sanctions', format: 'csv' });
  const [imp, setImp] = useState({ id: 'ofac_sdn', version: new Date().toISOString().slice(0, 10), csv: '' });
  return (
    <div className="grid cols-2">
      <div className="card">
        <h4>Sources</h4>
        <p className="tiny muted">
          The official consolidated lists (US OFAC, UK OFSI, UN, EU) are registered at first start and refreshed daily; Refresh reloads one now. Add your screening provider as a further source.
        </p>
        <Table
          head={['Source', 'Kind', 'Version', 'Entries', 'Refreshed', 'Error', '']}
          rows={(data.data?.items ?? []).map((s: any) => [
            <b>
              {s.name}
              <br />
              <span className="mono tiny">{s.id}</span>
            </b>,
            s.kind,
            s.lastVersion ?? '—',
            s.lastCount ?? 0,
            <span className="tiny">{fmtDate(s.lastRefreshedAt)}</span>,
            <span className="tiny" style={{ color: 'var(--danger)' }}>
              {s.lastError ?? ''}
            </span>,
            s.url ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  api
                    .post(`/api/admin/risk/sanctions/sources/${s.id}/refresh`, {})
                    .then((r: any) => {
                      ok(r.ok ? `Imported ${r.imported}` : `Failed: ${r.error}`);
                      data.reload();
                    })
                    .catch(err)
                }
              >
                Refresh
              </Button>
            ) : null,
          ])}
          empty="No sources"
        />
        <h4 className="mt">Add / edit source</h4>
        <div className="grid cols-2">
          <Field label="Id">
            <Input value={src.id} onChange={(e) => setSrc({ ...src, id: e.target.value })} />
          </Field>
          <Field label="Name">
            <Input value={src.name} onChange={(e) => setSrc({ ...src, name: e.target.value })} />
          </Field>
          <Field label="URL (optional)">
            <Input value={src.url} onChange={(e) => setSrc({ ...src, url: e.target.value })} />
          </Field>
          <Field label="Kind">
            <Select value={src.kind} onChange={(e) => setSrc({ ...src, kind: e.target.value })}>
              <option value="sanctions">sanctions</option>
              <option value="pep">pep</option>
            </Select>
          </Field>
          <Field label="Format" hint="Official lists are parsed as published; csv accepts kind,value or the OFAC layout">
            <Select value={src.format} onChange={(e) => setSrc({ ...src, format: e.target.value })}>
              <option value="csv">csv (kind,value or OFAC layout)</option>
              <option value="json">json rows</option>
              <option value="ofac_sdn">US OFAC SDN / consolidated</option>
              <option value="uk_ofsi">UK OFSI consolidated list</option>
              <option value="un_xml">UN Security Council XML</option>
              <option value="eu_fsf">EU financial sanctions file</option>
            </Select>
          </Field>
        </div>
        <Button
          size="sm"
          onClick={() =>
            api
              .put(`/api/admin/risk/sanctions/sources/${src.id}`, { name: src.name, url: src.url || null, kind: src.kind, format: src.format })
              .then(() => {
                ok('Saved');
                data.reload();
              })
              .catch(err)
          }
        >
          Save source
        </Button>
      </div>
      <div className="card">
        <h4>Import a version (CSV: kind,value or OFAC SDN layout)</h4>
        <div className="grid cols-2">
          <Field label="Source id">
            <Input value={imp.id} onChange={(e) => setImp({ ...imp, id: e.target.value })} />
          </Field>
          <Field label="Version">
            <Input value={imp.version} onChange={(e) => setImp({ ...imp, version: e.target.value })} />
          </Field>
        </div>
        <Field label="CSV">
          <Textarea rows={10} value={imp.csv} onChange={(e) => setImp({ ...imp, csv: e.target.value })} />
        </Field>
        <Button
          onClick={() =>
            api
              .post(`/api/admin/risk/sanctions/sources/${imp.id}/import`, { version: imp.version, csv: imp.csv })
              .then((r: any) => {
                ok(`Imported ${r.imported}, replaced ${r.replaced}`);
                data.reload();
              })
              .catch(err)
          }
          disabled={!imp.csv.trim()}
        >
          Import
        </Button>
        <h5 className="mt">Entries ({data.data?.entries?.length ?? 0})</h5>
        <div style={{ maxHeight: 260, overflow: 'auto' }}>
          {(data.data?.entries ?? []).slice(0, 200).map((e: any) => (
            <div key={e.id} className="tiny">
              {e.kind} · {e.value} · {e.source}
              {e.listVersion ? ` v${e.listVersion}` : ''}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Kyc({ ok, err }: { ok: (m: string) => void; err: (e: any) => void }) {
  const tiers = useAsync(() => api.get<any>('/api/admin/risk/kyc/tiers'), []);
  const kyb = useAsync(() => api.get<any>('/api/admin/risk/kyb?status=pending'), []);
  const [userTier, setUserTier] = useState({ userId: '', tier: 1, reason: '' });
  const [threshold, setThreshold] = useState<number | ''>('');
  return (
    <div className="grid cols-2">
      <div className="card">
        <h4>Tier limits (base minor units)</h4>
        {tiers.data &&
          Object.entries(tiers.data.settings.default).map(([t, l]: any) => (
            <KV key={t} k={tiers.data.labels[t]} v={l ? `per tx ${l.perTransaction} · daily ${l.daily} · monthly ${l.monthly}` : 'no platform ceiling (business)'} />
          ))}
        <p className="small muted">
          Country overrides: {Object.keys(tiers.data?.settings?.countries ?? {}).join(', ') || 'none'} · proof of address max age {tiers.data?.settings?.addressDocMaxAgeDays} days · KYB threshold{' '}
          {tiers.data?.settings?.kybMonthlyVolumeThreshold}
        </p>
        <div className="row">
          <Input type="number" placeholder="KYB monthly volume threshold" value={threshold} onChange={(e) => setThreshold(e.target.value === '' ? '' : Number(e.target.value))} />
          <Button
            size="sm"
            onClick={() =>
              api
                .put('/api/admin/risk/kyc/tiers', { kybMonthlyVolumeThreshold: Number(threshold) })
                .then(() => {
                  ok('Saved');
                  tiers.reload();
                })
                .catch(err)
            }
            disabled={threshold === ''}
          >
            Save
          </Button>
        </div>
        <h4 className="mt">Set a user's tier</h4>
        <div className="grid cols-3">
          <Field label="User id">
            <Input value={userTier.userId} onChange={(e) => setUserTier({ ...userTier, userId: e.target.value })} />
          </Field>
          <Field label="Tier">
            <Select value={userTier.tier} onChange={(e) => setUserTier({ ...userTier, tier: Number(e.target.value) })}>
              {[0, 1, 2, 3, 4].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Reason">
            <Input value={userTier.reason} onChange={(e) => setUserTier({ ...userTier, reason: e.target.value })} />
          </Field>
        </div>
        <Button
          size="sm"
          onClick={() =>
            api
              .put(`/api/admin/risk/kyc/users/${userTier.userId}/tier`, { tier: userTier.tier, reason: userTier.reason })
              .then(() => ok('Tier set'))
              .catch(err)
          }
          disabled={!userTier.userId || userTier.reason.length < 3}
        >
          Set tier
        </Button>
      </div>
      <div className="card">
        <h4>KYB queue</h4>
        <Table
          head={['Business', 'Country', 'Registration', 'Directors', 'Volume', '']}
          rows={(kyb.data?.items ?? []).map((k: any) => [
            <b>
              {k.legalName}
              <br />
              <span className="tiny muted">{k.user?.fullName}</span>
            </b>,
            k.country,
            <span className="tiny">{k.registrationNumber}</span>,
            <span className="tiny">{k.directors.map((d: any) => d.name).join(', ')}</span>,
            k.expectedMonthlyVolume,
            <div className="row">
              <ConfirmButton
                size="sm"
                variant="success"
                onConfirm={() =>
                  api
                    .post(`/api/admin/risk/kyb/${k.id}/review`, { decision: 'verified' })
                    .then(() => {
                      ok('Verified (Tier 4)');
                      kyb.reload();
                    })
                    .catch(err)
                }
              >
                Verify
              </ConfirmButton>
              <ConfirmButton
                size="sm"
                variant="danger"
                prompt="Reason"
                onConfirm={(n) =>
                  api
                    .post(`/api/admin/risk/kyb/${k.id}/review`, { decision: 'rejected', note: n })
                    .then(() => {
                      ok('Rejected');
                      kyb.reload();
                    })
                    .catch(err)
                }
              >
                Reject
              </ConfirmButton>
            </div>,
          ])}
          empty="No pending KYB"
        />
      </div>
    </div>
  );
}

function Destinations({ ok, err }: { ok: (m: string) => void; err: (e: any) => void }) {
  const data = useAsync(() => api.get<any>('/api/admin/risk/destination-changes'), []);
  return (
    <div className="card">
      <p className="small muted">
        Cooling-off {data.data?.settings?.coolingOffHours}h · locked {data.data?.settings?.lockAfterCredentialChangeHours}h after a password change.
      </p>
      <Table
        head={['When', 'Account', 'Kind', 'From → to', 'Flags', 'Status', 'Effective', '']}
        rows={(data.data?.items ?? []).map((c: any) => [
          <span className="tiny">{fmtDate(c.createdAt)}</span>,
          <span className="tiny">{c.userId}</span>,
          c.kind,
          <span className="tiny">
            {JSON.stringify(c.previous ?? {})} → {JSON.stringify(c.next)}
          </span>,
          <span className="tiny">{c.riskFlags.join(', ')}</span>,
          <StatusBadge status={c.status} />,
          <span className="tiny">{fmtDate(c.effectiveAt)}</span>,
          <div className="row">
            {c.status === 'COOLING' && (
              <ConfirmButton
                size="sm"
                variant="success"
                onConfirm={() =>
                  api
                    .post(`/api/admin/risk/destination-changes/${c.id}/approve`, {})
                    .then(() => {
                      ok('Approved');
                      data.reload();
                    })
                    .catch(err)
                }
              >
                Approve
              </ConfirmButton>
            )}
            {c.status !== 'REVOKED' && (
              <ConfirmButton
                size="sm"
                variant="danger"
                onConfirm={() =>
                  api
                    .post(`/api/admin/risk/destination-changes/${c.id}/revoke`, {})
                    .then(() => {
                      ok('Revoked');
                      data.reload();
                    })
                    .catch(err)
                }
              >
                Revoke
              </ConfirmButton>
            )}
          </div>,
        ])}
        empty="No destination changes"
      />
    </div>
  );
}

function AgentIntel({ ok, err, money }: { ok: (m: string) => void; err: (e: any) => void; money: (m: number, c: string) => string }) {
  const data = useAsync(() => api.get<any>('/api/admin/risk/agents/overview'), []);
  return (
    <div>
      <div className="row mb">
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            api
              .post('/api/admin/risk/agents/trust/run', {})
              .then((r: any) => {
                ok(`Scored ${r.scored}, alerts ${r.alerts?.alerted}`);
                data.reload();
              })
              .catch(err)
          }
        >
          Recompute trust & float alerts
        </Button>
        <span className="small muted">
          target {data.data?.settings?.targetDays} days · alert below {data.data?.settings?.alertDays} · bonuses {JSON.stringify(data.data?.settings?.bonusByBand)}
        </span>
      </div>
      <div className="grid cols-2">
        <div className="card">
          <h4>Agents</h4>
          <Table
            head={['Agent', 'Trust', 'Commission (cash-in)', 'Float']}
            rows={(data.data?.agents ?? []).map((a: any) => [
              <b>
                {a.name}
                <br />
                <span className="tiny muted">
                  @{a.tag} · {a.country}
                </span>
              </b>,
              <span>
                {a.trustScore ?? '—'} {a.band && <Chip>{a.band}</Chip>}
              </span>,
              <span className="tiny">
                {a.commission?.bps} bps (base {a.commission?.base} + trust {a.commission?.trustBonus} + liquidity {a.commission?.liquidityBonus})
              </span>,
              <span className="tiny">
                {a.float.map((f: any) => (
                  <div key={f.currency}>
                    <Chip kind={f.status === 'critical' ? 'danger' : f.status === 'low' ? 'warning' : f.status === 'ok' ? 'success' : undefined}>{f.status}</Chip> {money(f.balanceMinor, f.currency)} ·
                    runway {f.runwayDays ?? '∞'}d · refill {money(f.refillRecommendedMinor, f.currency)}
                  </div>
                ))}
              </span>,
            ])}
            empty="No agents"
          />
        </div>
        <div className="card">
          <h4>Float requests</h4>
          <Table
            head={['Agent', 'Amount', 'Method', 'Reference', '']}
            rows={(data.data?.requests ?? []).map((r: any) => [
              <span className="tiny">{r.agentId}</span>,
              money(r.amountMinor, r.currency),
              r.method,
              r.reference ?? '—',
              <div className="row">
                <ConfirmButton
                  size="sm"
                  variant="success"
                  prompt="What did you check? (receipt, deposit slip…)"
                  onConfirm={(note) =>
                    api
                      .post(`/api/admin/risk/agents/float-requests/${r.id}/fulfil`, { note: note || 'Cash received and counted' })
                      .then(() => {
                        ok('Proposed to a second administrator');
                        data.reload();
                      })
                      .catch(err)
                  }
                >
                  Fulfil
                </ConfirmButton>
                <ConfirmButton
                  size="sm"
                  variant="danger"
                  prompt="Reason"
                  onConfirm={(reason) =>
                    api
                      .post(`/api/admin/risk/agents/float-requests/${r.id}/reject`, { reason: reason || 'declined' })
                      .then(() => {
                        ok('Rejected');
                        data.reload();
                      })
                      .catch(err)
                  }
                >
                  Reject
                </ConfirmButton>
              </div>,
            ])}
            empty="No open requests"
          />
        </div>
      </div>
    </div>
  );
}
