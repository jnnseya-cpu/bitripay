import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { API_BASE, api, getToken } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Chip, Empty, PageHeader, useAsync } from '../components/ui';

/**
 * Command centre: one place where the account holder talks to their agents. Each agent reads through audited tools,
 * proposes actions the account holder confirms in the app, and never moves money itself. Runs stream live; every
 * step is shown so people see exactly what was checked.
 */
interface AgentCard { key: string; name: string; icon: string; tagline: string; suggestions: string[]; tools: string[]; enabled: boolean; paused: boolean; scheduled: string | null; lastRunAt: string | null; usage: number }
interface Action { id: string; stepNo: number; tool: string; input: any; result: any; outcome: string; reason: string | null; approvalId: string | null; latencyMs: number }
interface Run { id: string; agent: string; agentName: string; status: string; input: string; output: string | null; actions: Action[]; proposals: any[]; acu: number; steps: number; provider: string; model: string | null; error: string | null; createdAt: string }

const TOOL_LABELS: Record<string, string> = { 'wallets.balances': 'Read balances', 'transactions.list': 'Read transactions', 'transactions.get': 'Read a transaction', 'statements.build': 'Build statement', 'fees.quote': 'Quote fee', 'routes.quote': 'Quote route', 'routes.list': 'Read routes', 'routes.get': 'Read route', 'rates.list': 'Read rates', 'profile.summary': 'Check account protection', 'notifications.recent': 'Read alerts', 'knowledge.search': 'Search guides', 'actions.propose': 'Prepare action', 'memory.remember': 'Save memory', 'support.tickets': 'Read tickets', 'support.create_ticket': 'Open ticket', 'merchant.stats': 'Read sales', 'merchant.settlements': 'Read settlements', 'merchant.payment_requests': 'Read payment links', 'merchant.webhooks': 'Read webhook log', 'agent.queue': 'Read payout queue', 'agent.stats': 'Read agent activity' };
const label = (tool: string) => TOOL_LABELS[tool] ?? tool.replace(/^admin\./, 'Admin: ').replace(/[._]/g, ' ');

/** Reads a run's server-sent events with the bearer token (EventSource cannot send headers). */
async function streamRun(id: string, onEvent: (event: string, data: any) => void, signal: AbortSignal) {
  const res = await fetch(`${API_BASE}/api/assist/runs/${id}/stream`, { headers: { Authorization: `Bearer ${getToken()}` }, signal });
  if (!res.ok || !res.body) throw new Error('Stream unavailable');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) {
        try {
          onEvent(event, JSON.parse(data));
        } catch {
          /* ignore malformed */
        }
      }
    }
  }
}

export function Assist() {
  const { user, toast } = useStore();
  const [params, setParams] = useSearchParams();
  const data = useAsync(() => api.get<{ agents: AgentCard[]; usage: any; runtime: any }>('/api/assist/agents'), []);
  const agents = data.data?.agents ?? [];
  const selectedKey = params.get('agent') || agents[0]?.key || 'chief_of_staff';
  const agent = agents.find((a) => a.key === selectedKey) ?? agents[0];
  const [runs, setRuns] = useState<Run[]>([]);
  const [input, setInput] = useState('');
  const [live, setLive] = useState<{ id: string; text: string; actions: Action[]; status: string } | null>(null);
  const [tab, setTab] = useState<'chat' | 'memory' | 'history'>('chat');
  const bottom = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!agent) return;
    api.get<{ items: Run[] }>(`/api/assist/runs?agent=${agent.key}&limit=12`).then((r) => setRuns(r.items.reverse())).catch(() => setRuns([]));
    setLive(null);
  }, [agent?.key]);
  useEffect(() => bottom.current?.scrollIntoView({ behavior: 'smooth' }), [runs, live?.text, live?.actions.length]);
  useEffect(() => () => abort.current?.abort(), []);

  const ask = async (text: string) => {
    if (!agent || !text.trim() || live) return;
    setInput('');
    try {
      const r = await api.post<{ run: Run }>('/api/assist/runs', { agent: agent.key, input: text });
      if (['completed', 'failed', 'budget_exhausted'].includes(r.run.status)) {
        setRuns((rs) => [...rs, r.run]);
        return;
      }
      setLive({ id: r.run.id, text: '', actions: [], status: r.run.status });
      abort.current = new AbortController();
      await streamRun(r.run.id, (event, d) => {
        if (event === 'step') setLive((l) => (l ? { ...l, actions: [...l.actions.filter((a) => a.id !== d.action.id), d.action] } : l));
        else if (event === 'delta') setLive((l) => (l ? { ...l, text: l.text + d.text } : l));
        else if (event === 'message') setLive((l) => (l && !l.text ? { ...l, text: d.text } : l));
        else if (event === 'status') setLive((l) => (l ? { ...l, status: d.status } : l));
        else if (event === 'done') {
          setRuns((rs) => [...rs.filter((x) => x.id !== d.run.id), d.run]);
          setLive(null);
          data.reload();
        }
      }, abort.current.signal);
    } catch (e) {
      setLive(null);
      toast((e as Error).message, 'error');
    }
  };
  const toggle = async (a: AgentCard) => {
    await api.put(`/api/assist/instances/${a.key}`, { enabled: !a.enabled });
    data.reload();
  };

  if (!data.data) return <div className="loading-page"><span className="spinner" /></div>;
  const usage = data.data.usage;
  const mode = data.data.runtime.mode;
  return (
    <div>
      <PageHeader title="Command centre" subtitle="Your agents read your account through audited tools, explain what they find and prepare actions you confirm yourself. They never move money." />
      {mode === 'offline' && <Alert kind="info">Agents are answering from built-in checks right now (no language model connected). Every question still runs through the same tools and audit log.</Alert>}
      <div className="cc-layout">
        <aside className="cc-agents">
          <div className="cc-usage card">
            <div className="row between"><b>This month</b><span className="tiny muted">{usage.runs} runs</span></div>
            {usage.unlimited ? <div className="tiny muted">Unlimited agent credit</div> : (
              <>
                <div className="progress mt-sm"><div style={{ width: `${Math.min(100, (usage.acuUsed / Math.max(1, usage.allowance)) * 100)}%` }} /></div>
                <div className="tiny muted">{usage.acuUsed} of {usage.allowance} agent credits used</div>
              </>
            )}
          </div>
          {agents.map((a) => (
            <button key={a.key} className={`cc-agent ${a.key === agent?.key ? 'active' : ''} ${!a.enabled || a.paused ? 'off' : ''}`} onClick={() => { setParams({ agent: a.key }); setTab('chat'); }}>
              <span className="cc-ico">{a.icon}</span>
              <span className="cc-agent-text"><b>{a.name}</b><span className="tiny muted">{a.paused ? 'Paused by BitriPay' : !a.enabled ? 'Switched off' : a.tagline}</span></span>
            </button>
          ))}
        </aside>
        <section className="cc-main card">
          {agent && (
            <>
              <div className="row between cc-head">
                <div className="row"><span className="cc-ico big">{agent.icon}</span><div><b>{agent.name}</b><div className="tiny muted">{agent.tagline}{agent.scheduled ? ' · runs every morning for administrators' : ''}</div></div></div>
                <div className="row">
                  <div className="row" style={{ gap: 4 }}>{(['chat', 'memory', 'history'] as const).map((k) => <Chip key={k} selected={tab === k} onClick={() => setTab(k)}>{k === 'chat' ? 'Chat' : k === 'memory' ? 'Memory' : 'History'}</Chip>)}</div>
                  <label className="tiny muted row" style={{ gap: 6 }}><input type="checkbox" checked={agent.enabled} onChange={() => toggle(agent)} /> On</label>
                </div>
              </div>
              {tab === 'memory' && <Memory />}
              {tab === 'history' && <History agent={agent.key} />}
              {tab === 'chat' && (
                <>
                  <div className="cc-thread">
                    {runs.length === 0 && !live && <Empty icon={agent.icon} text={`Ask ${agent.name} anything about your account. It can use: ${agent.tools.slice(0, 6).map(label).join(', ')}${agent.tools.length > 6 ? '…' : ''}`} />}
                    {runs.map((r) => <RunBubble key={r.id} run={r} user={user?.fullName ?? 'You'} />)}
                    {live && (
                      <div className="cc-run">
                        <div className="cc-msg me">{runs.length ? '' : ''}{live.actions.length === 0 && !live.text ? 'Working…' : ''}</div>
                        <Steps actions={live.actions} />
                        {live.text ? <div className="cc-msg agent">{live.text}</div> : <div className="cc-msg agent muted"><span className="spinner" /> {live.status === 'awaiting_approval' ? 'Waiting for an approval' : 'Checking…'}</div>}
                      </div>
                    )}
                    <div ref={bottom} />
                  </div>
                  <div className="row wrap mt-sm">{agent.suggestions.map((s) => <Chip key={s} onClick={() => ask(s)}>{s}</Chip>)}</div>
                  <form className="row mt-sm" onSubmit={(e) => { e.preventDefault(); ask(input); }}>
                    <input className="input" value={input} onChange={(e) => setInput(e.target.value)} placeholder={`Ask ${agent.name}…`} disabled={!agent.enabled || agent.paused || !!live} maxLength={4000} />
                    <Button disabled={!input.trim() || !!live || !agent.enabled || agent.paused}>Ask</Button>
                  </form>
                  <div className="tiny muted mt-sm">Answers come from your own data. Money only moves when you confirm an action with your PIN or passkey. Every step is logged.</div>
                </>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function Steps({ actions }: { actions: Action[] }) {
  if (!actions.length) return null;
  return (
    <div className="cc-steps">
      {actions.map((a) => (
        <span key={a.id} className={`cc-step ${a.outcome}`} title={a.reason ?? (a.input ? JSON.stringify(a.input) : '')}>
          {a.outcome === 'executed' ? '✓' : a.outcome === 'denied' ? '⛔' : a.outcome === 'awaiting_approval' ? '⏳' : '!'} {label(a.tool)}
        </span>
      ))}
    </div>
  );
}

function RunBubble({ run, user }: { run: Run; user: string }) {
  return (
    <div className="cc-run">
      <div className="cc-msg me"><span className="tiny muted">{user} · {new Date(run.createdAt).toLocaleString()}</span>{run.input}</div>
      <Steps actions={run.actions} />
      {run.output && <div className="cc-msg agent"><span className="tiny muted">{run.agentName}{run.model ? ` · ${run.model}` : ''}{run.acu ? ` · ${run.acu} credits` : ''}</span>{run.output}</div>}
      {run.status === 'failed' && <div className="cc-msg agent"><Alert kind="error">{run.error ?? 'Something went wrong.'}</Alert></div>}
      {run.status === 'budget_exhausted' && <div className="cc-msg agent"><Alert kind="warning">Your monthly agent credit is used up. It resets next month.</Alert></div>}
      {run.status === 'awaiting_approval' && <div className="cc-msg agent"><Alert kind="warning">An action is queued for a second administrator to approve. You will be notified.</Alert></div>}
      {run.proposals.map((p, i) => (
        <div key={i} className="cc-proposal">
          <div><b>{p.title}</b><div className="tiny muted">{p.why ?? 'Prepared for you to confirm. Nothing has been executed.'}</div></div>
          <Link className="btn" to={p.link}>Review & confirm</Link>
        </div>
      ))}
    </div>
  );
}

function Memory() {
  const { toast } = useStore();
  const mem = useAsync(() => api.get<{ items: any[] }>('/api/assist/memories'), []);
  const [text, setText] = useState('');
  const add = async () => {
    if (text.trim().length < 3) return;
    await api.post('/api/assist/memories', { content: text, kind: 'preference' });
    setText('');
    mem.reload();
  };
  return (
    <div>
      <p className="small muted">What your agents remember about you. Only what you asked for is kept; delete anything at any time. Secrets are never stored.</p>
      {(mem.data?.items ?? []).length === 0 && <Empty icon="📚" text="Nothing stored yet." />}
      {(mem.data?.items ?? []).map((m) => (
        <div key={m.id} className="row between cc-memory"><span><Chip>{m.kind}</Chip> {m.content}</span><Button size="sm" variant="ghost" onClick={() => api.del(`/api/assist/memories/${m.id}`).then(() => mem.reload()).catch((e) => toast(e.message, 'error'))}>Delete</Button></div>
      ))}
      <form className="row mt" onSubmit={(e) => { e.preventDefault(); add(); }}><input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. I prefer receipts on WhatsApp" maxLength={400} /><Button variant="secondary">Remember</Button></form>
      {(mem.data?.items ?? []).length > 0 && <Button variant="ghost" size="sm" onClick={() => api.del('/api/assist/memories').then(() => mem.reload())}>Delete everything</Button>}
    </div>
  );
}

function History({ agent }: { agent: string }) {
  const runs = useAsync(() => api.get<{ items: Run[] }>(`/api/assist/runs?agent=${agent}&limit=50`), [agent]);
  const items = runs.data?.items ?? [];
  if (!items.length) return <Empty icon="🕓" text="No runs yet." />;
  return (
    <div className="col">
      {items.map((r) => (
        <div key={r.id} className="row between cc-memory"><span><Chip kind={r.status === 'completed' ? 'success' : r.status === 'failed' ? 'danger' : 'warning'}>{r.status.replace(/_/g, ' ')}</Chip> {r.input}</span><span className="tiny muted">{new Date(r.createdAt).toLocaleString()} · {r.steps} steps{r.acu ? ` · ${r.acu} credits` : ''}</span></div>
      ))}
    </div>
  );
}
