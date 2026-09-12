import { useState } from 'react';
import { api, qs } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Chip, ConfirmButton, Field, Input, KV, Modal, PageHeader, Select, StepUpButton, Switch, Table, Tabs, Textarea, UserCell, fmtDate, useAsync } from '../components/ui';

/**
 * Agent control centre: the registry of agents, what each may do, pause and kill switches, the approvals a checker
 * must decide, every run with its steps, published policies, usage and cost, and the model settings.
 */
export function Agents() {
  const { toast, can } = useStore();
  const data = useAsync(() => api.get<any>('/api/admin/agents'), []);
  const [tab, setTab] = useState<'agents' | 'approvals' | 'runs' | 'policies' | 'usage' | 'settings'>('agents');
  const ok = (m: string) => { toast(m, 'success'); data.reload(); };
  const err = (e: any) => toast(e.message, 'error');
  const d = data.data;
  if (!d) return <div className="loading-page"><span className="spinner" /></div>;
  const rt = d.runtime;
  const pending: any[] = d.approvals ?? [];
  return (
    <div>
      <PageHeader title="Agents & command centres" subtitle="Every agent reads through typed tools under a policy you publish here. Agents propose; people approve. Nothing here can mint, release, unfreeze or change a corridor." actions={<StepUpButton variant={rt.killSwitch ? 'success' : 'danger'} title={rt.killSwitch ? 'Resume all agents' : 'Pause every agent now'} onConfirm={(pin) => api.post('/api/admin/agents/kill-switch', { on: !rt.killSwitch, pin }).then(() => ok(rt.killSwitch ? 'Agents resumed' : 'All agents paused')).catch(err)}>{rt.killSwitch ? '▶ Resume all agents' : '⏹ Kill switch'}</StepUpButton>} />
      <Alert kind={rt.killSwitch ? 'error' : rt.mode === 'live' ? 'success' : 'warning'}>{rt.killSwitch ? <>Kill switch is <b>on</b>: no agent runs until an administrator resumes them.</> : rt.mode === 'live' ? <>Agents are <b>live</b> on {rt.model} (fast model {rt.fastModel}). {rt.agents} agents, {rt.tools} tools, {pending.length} approval(s) waiting.</> : <>Agents run in <b>offline mode</b>: no model key configured, so answers come from the built-in planner over the same tools. Add a key under Settings to switch to {rt.model}.</>}</Alert>
      <Tabs tabs={[{ id: 'agents', label: `Agents (${d.agents.length})` }, { id: 'approvals', label: `Approvals (${pending.length})` }, { id: 'runs', label: 'Runs' }, { id: 'policies', label: `Policies (${d.policies.length})` }, { id: 'usage', label: 'Usage & cost' }, { id: 'settings', label: 'Settings' }]} value={tab} onChange={(v) => setTab(v as any)} />
      {tab === 'agents' && <Registry d={d} ok={ok} err={err} />}
      {tab === 'approvals' && <Approvals items={pending} ok={ok} err={err} canApprove={can('approvals')} />}
      {tab === 'runs' && <Runs />}
      {tab === 'policies' && <Policies d={d} ok={ok} err={err} />}
      {tab === 'usage' && <Usage d={d} />}
      {tab === 'settings' && <Settings d={d} ok={ok} err={err} />}
    </div>
  );
}

function Registry({ d, ok, err }: { d: any; ok: (m: string) => void; err: (e: any) => void }) {
  const [ask, setAsk] = useState<{ key: string; input: string } | null>(null);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <div className="card">
        <Table head={['Agent', 'For', 'Tools', 'Runs (30d)', 'Failed', 'Waiting', 'ACU (30d)', 'Last run', '']} rows={d.agents.map((a: any) => [
          <div><b>{a.icon} {a.name}</b><div className="tiny muted">{a.tagline}{a.schedule ? ' · scheduled daily' : ''}</div></div>,
          <span className="tiny">{a.roles.join(', ')}</span>,
          <span className="tiny" title={a.tools.join('\n')}>{a.tools.length} tools · max {a.budget.maxSteps} steps</span>,
          a.runs30d, a.failed30d ? <Chip kind="danger">{a.failed30d}</Chip> : 0, a.awaiting ? <Chip kind="warning">{a.awaiting}</Chip> : 0, a.acu30d, <span className="tiny">{fmtDate(a.lastRunAt)}</span>,
          <div className="row">
            {a.paused ? <Button size="sm" variant="success" onClick={() => api.post(`/api/admin/agents/${a.key}/resume`).then(() => ok(`${a.name} resumed`)).catch(err)}>Resume</Button> : <Button size="sm" variant="secondary" onClick={() => api.post(`/api/admin/agents/${a.key}/pause`).then(() => ok(`${a.name} paused`)).catch(err)}>Pause</Button>}
            {a.roles.includes('admin') && <Button size="sm" variant="ghost" onClick={() => { setAsk({ key: a.key, input: a.schedule ? `Run the ${a.name.toLowerCase()} check` : '' }); setResult(null); }}>Run</Button>}
          </div>,
        ])} />
      </div>
      <div className="card mt">
        <h4>Never available to agents</h4>
        <p className="tiny muted">These capabilities are not tools. A person does them in the app under maker-checker and step-up, and any attempt by an agent is logged as denied.</p>
        <div className="row wrap">{d.forbidden.map((f: string) => <Chip key={f} kind="danger">{f}</Chip>)}</div>
      </div>
      <Modal open={!!ask} onClose={() => setAsk(null)} title={`Run ${ask?.key.replace(/_/g, ' ')} as yourself`} wide>
        {ask && (
          <>
            <Field label="Instruction"><Textarea rows={2} value={ask.input} onChange={(e) => setAsk({ ...ask, input: e.target.value })} /></Field>
            <Button loading={busy} disabled={ask.input.trim().length < 2} onClick={() => { setBusy(true); api.post<any>('/api/admin/agents/run?wait=1', { agent: ask.key, input: ask.input }).then((r) => { setResult(r.run); ok('Run finished'); }).catch(err).finally(() => setBusy(false)); }}>Run now</Button>
            {result && <RunDetail run={result} />}
          </>
        )}
      </Modal>
    </>
  );
}

function Approvals({ items, ok, err, canApprove }: { items: any[]; ok: (m: string) => void; err: (e: any) => void; canApprove: boolean }) {
  return (
    <div className="card">
      <p className="tiny muted">An agent may only queue these; a different administrator with the right permission approves under PIN or passkey step-up. Approvals expire after three days.</p>
      <Table head={['Requested', 'Agent', 'For', 'Action', 'Expires', '']} rows={items.map((a) => [fmtDate(a.createdAt), a.agent, <UserCell user={a.requestedFor} />, <div><b>{a.summary}</b><div className="tiny mono muted">{a.tool} {JSON.stringify(a.input)}</div></div>, <span className="tiny">{fmtDate(a.expiresAt)}</span>,
        canApprove ? <div className="row"><StepUpButton size="sm" variant="success" title="Approve agent action" prompt="Reason / reference" onConfirm={(pin, reason) => api.post(`/api/admin/agents/approvals/${a.id}/approve`, { pin, reason }).then(() => ok('Approved and executed')).catch(err)}>Approve</StepUpButton><ConfirmButton size="sm" variant="danger" prompt="Reason" onConfirm={(reason) => api.post(`/api/admin/agents/approvals/${a.id}/decline`, { reason }).then(() => ok('Declined')).catch(err)}>Decline</ConfirmButton></div> : <span className="tiny muted">needs approvals permission</span>])} empty="Nothing waiting for approval" />
    </div>
  );
}

function RunDetail({ run }: { run: any }) {
  return (
    <div className="mt">
      <div className="row wrap"><Chip kind={run.status === 'completed' ? 'success' : run.status === 'failed' ? 'danger' : 'warning'}>{run.status}</Chip><span className="tiny muted">{run.provider}{run.model ? ` · ${run.model}` : ''} · {run.steps} steps · {run.tokensIn + run.tokensOut} tokens · {run.acu} ACU</span></div>
      <KV k="Input" v={<span className="small">{run.input}</span>} />
      <Table head={['#', 'Tool', 'Input', 'Outcome', 'Result']} rows={(run.actions ?? []).map((a: any) => [a.stepNo, <span className="mono tiny">{a.tool}</span>, <span className="tiny mono">{JSON.stringify(a.input)}</span>, <Chip kind={a.outcome === 'executed' ? 'success' : a.outcome === 'denied' ? 'danger' : 'warning'}>{a.outcome}{a.reason ? ` · ${a.reason}` : ''}</Chip>, <details><summary className="tiny">view</summary><pre className="tiny" style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>{JSON.stringify(a.result, null, 1)}</pre></details>])} empty="No tool calls" />
      {run.output && <div className="card mt" style={{ whiteSpace: 'pre-wrap' }}>{run.output}</div>}
      {run.error && <Alert kind="error">{run.errorCode}: {run.error}</Alert>}
    </div>
  );
}

function Runs() {
  const [filter, setFilter] = useState({ agent: '', status: '' });
  const runs = useAsync(() => api.get<any>(`/api/admin/agents/runs${qs({ agent: filter.agent || undefined, status: filter.status || undefined, limit: 100 })}`), [filter]);
  const [open, setOpen] = useState<any>(null);
  return (
    <div className="card">
      <div className="row mb wrap"><Input placeholder="agent key" value={filter.agent} onChange={(e) => setFilter({ ...filter, agent: e.target.value })} style={{ width: 180 }} /><Select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })} style={{ width: 180 }}><option value="">Any status</option>{['completed', 'failed', 'awaiting_approval', 'running', 'cancelled', 'budget_exhausted'].map((s) => <option key={s} value={s}>{s}</option>)}</Select></div>
      <Table head={['When', 'Agent', 'Trigger', 'Input', 'Status', 'Steps', 'ACU', '']} rows={(runs.data?.items ?? []).map((r: any) => [fmtDate(r.createdAt), r.agent, r.trigger, <span className="small">{r.input.slice(0, 80)}</span>, <Chip kind={r.status === 'completed' ? 'success' : r.status === 'failed' ? 'danger' : 'warning'}>{r.status}</Chip>, r.steps, r.acu, <Button size="sm" variant="ghost" onClick={() => api.get<any>(`/api/admin/agents/runs/${r.id}`).then((x) => setOpen(x))}>Open</Button>])} empty="No runs" />
      <Modal open={!!open} onClose={() => setOpen(null)} title="Run detail" wide>{open && <><KV k="Account" v={<UserCell user={open.user} />} /><RunDetail run={open.run} /></>}</Modal>
    </div>
  );
}

function Policies({ d, ok, err }: { d: any; ok: (m: string) => void; err: (e: any) => void }) {
  const [form, setForm] = useState<any>(null);
  const tools: any[] = d.tools;
  const toggle = (list: string, name: string) => setForm({ ...form, rules: { ...form.rules, [list]: form.rules[list].includes(name) ? form.rules[list].filter((x: string) => x !== name) : [...form.rules[list], name] } });
  return (
    <>
      <div className="card">
        <div className="row between mb"><p className="tiny muted" style={{ margin: 0 }}>Policies layer: global → agent → account. Publishing a new version retires the previous one and needs step-up. Deny wins over allow; approval lists add a checker.</p><Button onClick={() => setForm({ scope: 'agent', scopeId: 'chief_of_staff', note: '', rules: { deny: [], requireApproval: [], allow: [] }, maxStepsPerRun: '', maxRunsPerDay: '' })}>+ Publish policy</Button></div>
        <Table head={['Scope', 'Target', 'Version', 'Deny', 'Needs approval', 'Allow only', 'Limits', 'Note', 'Published']} rows={d.policies.map((p: any) => [p.scope, p.scopeId, p.version, <span className="tiny">{(p.rules.deny ?? []).join(', ') || '—'}</span>, <span className="tiny">{(p.rules.requireApproval ?? []).join(', ') || '—'}</span>, <span className="tiny">{(p.rules.allow ?? []).join(', ') || '—'}</span>, <span className="tiny">{p.rules.maxStepsPerRun ? `${p.rules.maxStepsPerRun} steps/run ` : ''}{p.rules.maxRunsPerDay ? `${p.rules.maxRunsPerDay} runs/day` : ''}</span>, <span className="tiny">{p.note ?? ''}</span>, fmtDate(p.createdAt)])} empty="No policies published; agents run with their registry defaults." />
      </div>
      <Modal open={!!form} onClose={() => setForm(null)} title="Publish a policy" wide>
        {form && (
          <>
            <div className="grid cols-2">
              <Field label="Scope"><Select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value, scopeId: e.target.value === 'global' ? '*' : '' })}><option value="global">Global (every agent)</option><option value="agent">One agent</option><option value="user">One account</option></Select></Field>
              {form.scope === 'agent' ? <Field label="Agent"><Select value={form.scopeId} onChange={(e) => setForm({ ...form, scopeId: e.target.value })}>{d.agents.map((a: any) => <option key={a.key} value={a.key}>{a.name}</option>)}</Select></Field> : form.scope === 'user' ? <Field label="Account id"><Input value={form.scopeId} onChange={(e) => setForm({ ...form, scopeId: e.target.value })} /></Field> : <div />}
            </div>
            {(['deny', 'requireApproval', 'allow'] as const).map((list) => (
              <Field key={list} label={list === 'deny' ? 'Deny these tools' : list === 'requireApproval' ? 'Require a checker for these tools' : 'Allow only these tools (empty = no restriction)'}>
                <div className="row wrap">{tools.map((t) => <Chip key={t.name} kind={form.rules[list].includes(t.name) ? (list === 'deny' ? 'danger' : list === 'requireApproval' ? 'warning' : 'primary') : undefined} onClick={() => toggle(list, t.name)}>{t.name}</Chip>)}</div>
              </Field>
            ))}
            <div className="grid cols-3"><Field label="Max steps per run"><Input type="number" value={form.maxStepsPerRun} onChange={(e) => setForm({ ...form, maxStepsPerRun: e.target.value })} /></Field><Field label="Max runs per day"><Input type="number" value={form.maxRunsPerDay} onChange={(e) => setForm({ ...form, maxRunsPerDay: e.target.value })} /></Field><Field label="Note"><Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field></div>
            <StepUpButton title="Publish policy" onConfirm={(pin) => api.put('/api/admin/agents/policies', { scope: form.scope, scopeId: form.scopeId, note: form.note || null, pin, rules: { deny: form.rules.deny, requireApproval: form.rules.requireApproval, ...(form.rules.allow.length ? { allow: form.rules.allow } : {}), ...(form.maxStepsPerRun ? { maxStepsPerRun: Number(form.maxStepsPerRun) } : {}), ...(form.maxRunsPerDay ? { maxRunsPerDay: Number(form.maxRunsPerDay) } : {}) } }).then(() => { setForm(null); ok('Policy published'); }).catch(err)}>Publish with step-up</StepUpButton>
          </>
        )}
      </Modal>
    </>
  );
}

function Usage({ d }: { d: any }) {
  const rows: any[] = d.usage ?? [];
  const totals = rows.reduce((t, r) => ({ runs: t.runs + Number(r.runs), acu: t.acu + Number(r.acu), tokens: t.tokens + Number(r.tokens_in) + Number(r.tokens_out) }), { runs: 0, acu: 0, tokens: 0 });
  return (
    <>
      <div className="grid cols-3 mb"><div className="card"><KV k="Runs (30 days)" v={totals.runs} /></div><div className="card"><KV k="Tokens" v={totals.tokens.toLocaleString()} /></div><div className="card"><KV k="ACU (≈ USD)" v={`${Math.round(totals.acu * 100) / 100} (≈ $${(totals.acu / 100).toFixed(2)})`} /></div></div>
      <div className="card"><p className="tiny muted">1 ACU = one US cent of model spend at the list prices under Settings. Offline runs cost nothing.</p><Table head={['Day', 'Agent', 'Model', 'Runs', 'Tokens in', 'Tokens out', 'ACU']} rows={rows.map((r) => [r.day, r.agent_key, r.model, r.runs, r.tokens_in, r.tokens_out, Math.round(Number(r.acu) * 1000) / 1000])} empty="No usage yet" /></div>
    </>
  );
}

function Settings({ d, ok, err }: { d: any; ok: (m: string) => void; err: (e: any) => void }) {
  const [s, setS] = useState<any>(() => JSON.parse(JSON.stringify(d.settings)));
  const [pricing, setPricing] = useState(JSON.stringify(d.settings.pricing, null, 1));
  const save = () => {
    let p = s.pricing;
    try { p = JSON.parse(pricing); } catch { return err(new Error('Pricing must be valid JSON')); }
    api.put('/api/admin/agents/settings', { ...s, pricing: p }).then(() => ok('Settings saved')).catch(err);
  };
  return (
    <div className="card">
      <div className="grid cols-2">
        <div>
          <Switch on={s.enabled} onChange={(v) => setS({ ...s, enabled: v })} label="Command centres enabled" />
          <Switch on={s.scheduledSystemAgents} onChange={(v) => setS({ ...s, scheduledSystemAgents: v })} label="Run Operations, Compliance and System Health every morning (05:00 UTC)" />
          <Field label="Model (reasoning, drafting)"><Input value={s.model} onChange={(e) => setS({ ...s, model: e.target.value })} /></Field>
          <Field label="Fast model (short answers, research)"><Input value={s.fastModel} onChange={(e) => setS({ ...s, fastModel: e.target.value })} /></Field>
          <Field label="Anthropic API key" hint="Stored encrypted. Leave the dots to keep the current key; clear to fall back to the content-agent key or the server environment."><Input type="password" value={s.apiKey} onChange={(e) => setS({ ...s, apiKey: e.target.value })} /></Field>
          <div className="grid cols-2"><Field label="Max steps per run"><Input type="number" value={s.maxStepsPerRun} onChange={(e) => setS({ ...s, maxStepsPerRun: Number(e.target.value) })} /></Field><Field label="Max tokens per run"><Input type="number" value={s.maxTokensPerRun} onChange={(e) => setS({ ...s, maxTokensPerRun: Number(e.target.value) })} /></Field></div>
        </div>
        <div>
          <h4>Monthly allowance (ACU) per role · 0 = unlimited</h4>
          <div className="grid cols-2">{['user', 'merchant', 'agent', 'admin'].map((r) => <Field key={r} label={r}><Input type="number" value={s.allowances[r] ?? 0} onChange={(e) => setS({ ...s, allowances: { ...s.allowances, [r]: Number(e.target.value) } })} /></Field>)}</div>
          <Field label="List prices (USD per million tokens) by model" hint="Edit to follow the provider's price list; ACU metering uses these."><Textarea rows={8} value={pricing} onChange={(e) => setPricing(e.target.value)} /></Field>
        </div>
      </div>
      <Button onClick={save}>Save settings</Button>
    </div>
  );
}
