import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { API_BASE, api, getToken } from '../lib/api';
import { useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { Alert, Button, Chip, Empty, PageHeader, useAsync } from '../components/ui';

/**
 * Command centre: one place where the account holder talks to their agents. Each agent reads through audited tools,
 * proposes actions the account holder confirms in the app, and never moves money itself. Runs stream live; every
 * step is shown so people see exactly what was checked.
 */
interface AgentCard {
  key: string;
  name: string;
  icon: string;
  tagline: string;
  suggestions: string[];
  tools: string[];
  enabled: boolean;
  paused: boolean;
  scheduled: string | null;
  lastRunAt: string | null;
  usage: number;
}
interface Action {
  id: string;
  stepNo: number;
  tool: string;
  input: any;
  result: any;
  outcome: string;
  reason: string | null;
  approvalId: string | null;
  latencyMs: number;
}
interface Run {
  id: string;
  agent: string;
  agentName: string;
  status: string;
  input: string;
  output: string | null;
  actions: Action[];
  proposals: any[];
  billing?: { tier: string; reason: string; amount: number; currency: string | null; charged: boolean } | null;
  acu: number;
  steps: number;
  provider: string;
  model: string | null;
  error: string | null;
  createdAt: string;
}

const TOOL_LABELS: Record<string, string> = {
  'wallets.balances': 'Read balances',
  'transactions.list': 'Read transactions',
  'transactions.get': 'Read a transaction',
  'statements.build': 'Build statement',
  'fees.quote': 'Quote fee',
  'routes.quote': 'Quote route',
  'routes.list': 'Read routes',
  'routes.get': 'Read route',
  'rates.list': 'Read rates',
  'profile.summary': 'Check account protection',
  'notifications.recent': 'Read alerts',
  'knowledge.search': 'Search guides',
  'actions.propose': 'Prepare action',
  'memory.remember': 'Save memory',
  'support.tickets': 'Read tickets',
  'support.create_ticket': 'Open ticket',
  'merchant.stats': 'Read sales',
  'merchant.settlements': 'Read settlements',
  'merchant.payment_requests': 'Read payment links',
  'merchant.webhooks': 'Read webhook log',
  'agent.queue': 'Read payout queue',
  'agent.stats': 'Read agent activity',
};
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

/** NEURAL_QUOTA_EXCEEDED from the AI gateway (HTTP 422, code lower-cased by the error middleware) or its message. */
function quotaExceeded(e: any): boolean {
  const code = String(e?.code ?? '').toLowerCase();
  const message = String(e?.message ?? '');
  return code === 'neural_quota_exceeded' || /AI paused: ACU depleted/i.test(message) || (e?.status === 'budget_exhausted' && /ACU/i.test(message));
}
/** The reset date when the API provides one (details.resetAt / resetsAt / periodEnd); never invented client-side. */
function resetDateOf(e: any): string | null {
  const d = e?.details ?? e?.billing ?? {};
  const v = d.resetAt ?? d.resetsAt ?? d.periodEnd ?? d.period_end ?? e?.resetAt ?? e?.resetsAt ?? null;
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null;
}

export function Assist() {
  const { user, toast } = useStore();
  const [params, setParams] = useSearchParams();
  const data = useAsync(() => api.get<{ agents: AgentCard[]; usage: any; runtime: any; addon: any; billing: any }>('/api/assist/agents'), []);
  const [deep, setDeep] = useState(false);
  const agents = data.data?.agents ?? [];
  const selectedKey = params.get('agent') || agents[0]?.key || 'chief_of_staff';
  const agent = agents.find((a) => a.key === selectedKey) ?? agents[0];
  const [runs, setRuns] = useState<Run[]>([]);
  const [input, setInput] = useState('');
  const [live, setLive] = useState<{ id: string; text: string; actions: Action[]; status: string } | null>(null);
  const [tab, setTab] = useState<'chat' | 'memory' | 'history'>('chat');
  const t = useT();
  /** Set when the API answers NEURAL_QUOTA_EXCEEDED (or a run comes back "AI paused: ACU depleted…"); cleared when the agents reload with credit left. */
  const [paused, setPaused] = useState<{ resetAt: string | null } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!agent) return;
    api
      .get<{ items: Run[] }>(`/api/assist/runs?agent=${agent.key}&limit=12`)
      .then((r) => setRuns(r.items.reverse()))
      .catch(() => setRuns([]));
    setLive(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the selected agent changes
  }, [agent?.key]);
  useEffect(() => bottom.current?.scrollIntoView({ behavior: 'smooth' }), [runs, live?.text, live?.actions.length]);
  useEffect(() => () => abort.current?.abort(), []);

  const ask = async (text: string) => {
    if (!agent || !text.trim() || live) return;
    setInput('');
    try {
      const r = await api.post<{ run: Run }>('/api/assist/runs', { agent: agent.key, input: text, depth: deep ? 'deep' : 'standard' });
      if (['completed', 'failed', 'budget_exhausted'].includes(r.run.status)) {
        setRuns((rs) => [...rs, r.run]);
        if (quotaExceeded({ code: (r.run as any).errorCode ?? (r.run as any).error_code, message: r.run.error, status: r.run.status })) setPaused({ resetAt: resetDateOf(r.run) });
        return;
      }
      setLive({ id: r.run.id, text: '', actions: [], status: r.run.status });
      abort.current = new AbortController();
      await streamRun(
        r.run.id,
        (event, d) => {
          if (event === 'step') setLive((l) => (l ? { ...l, actions: [...l.actions.filter((a) => a.id !== d.action.id), d.action] } : l));
          else if (event === 'delta') setLive((l) => (l ? { ...l, text: l.text + d.text } : l));
          else if (event === 'message') setLive((l) => (l && !l.text ? { ...l, text: d.text } : l));
          else if (event === 'status') setLive((l) => (l ? { ...l, status: d.status } : l));
          else if (event === 'done') {
            setRuns((rs) => [...rs.filter((x) => x.id !== d.run.id), d.run]);
            setLive(null);
            data.reload();
          }
        },
        abort.current.signal,
      );
    } catch (e) {
      setLive(null);
      if (quotaExceeded(e)) setPaused({ resetAt: resetDateOf(e) });
      toast((e as Error).message, 'error');
    }
  };
  const toggle = async (a: AgentCard) => {
    await api.put(`/api/assist/instances/${a.key}`, { enabled: !a.enabled });
    data.reload();
  };

  if (!data.data)
    return (
      <div className="loading-page">
        <span className="spinner" />
      </div>
    );
  const usage = data.data.usage;
  // the API's own usage summary says the monthly ACU allowance is gone → runs would come back budget_exhausted
  const depleted = !!paused || (!usage.unlimited && usage.allowance > 0 && usage.remaining === 0);
  const resetAt = paused?.resetAt ?? usage.resetsAt ?? usage.resetAt ?? null;
  const mode = data.data.runtime.mode;
  const addon = data.data.addon;
  const billing = data.data.billing;
  if (billing?.mode === 'subscription' && addon?.required && !addon.active && addon.freeRunsLeft === 0) return <Activate addon={addon} onDone={() => data.reload()} />;
  if (billing?.consentRequired) return <Consent billing={billing} onDone={() => data.reload()} />;
  const price = billing?.prices?.[0];
  const priceLabel =
    billing?.mode !== 'per_use' || billing?.subscriptionActive
      ? ''
      : deep && price
        ? ` · ${price.deepFormatted}`
        : (billing?.freeRunsLeft ?? 0) > 0
          ? ' · free'
          : price
            ? ` · up to ${price.standardFormatted}`
            : '';
  return (
    <div>
      <PageHeader
        title="Command centre"
        subtitle="Your agents read your account through audited tools, explain what they find and prepare actions you confirm yourself. They never move money."
        actions={
          addon?.required && addon.subscription ? (
            <span className="tiny muted">
              Active until {new Date(addon.subscription.expiresAt).toLocaleDateString()} ·{' '}
              {addon.subscription.autoRenew ? (
                <button
                  className="btn ghost sm"
                  onClick={() =>
                    api.post('/api/assist/addon/cancel').then(() => {
                      toast('Renewal cancelled. Your agents stay active until the end of the period.', 'success');
                      data.reload();
                    })
                  }
                >
                  Cancel renewal
                </button>
              ) : (
                <button className="btn ghost sm" onClick={() => api.post('/api/assist/addon/auto-renew', { on: true }).then(() => data.reload())}>
                  Turn renewal on
                </button>
              )}
            </span>
          ) : undefined
        }
      />
      {billing?.mode === 'per_use' && !billing.subscriptionActive && (
        <div className="row wrap tiny muted mb" style={{ gap: 12 }}>
          <span>Lookups from your own records are free.</span>
          {price && (
            <span>
              Other questions {price.standardFormatted}
              {billing.canDeep ? `, in-depth ${price.deepFormatted}` : ''}, taken from your wallet after the answer.
            </span>
          )}
          {billing.freeRunsPerMonth > 0 && <span>{billing.freeRunsLeft} free question(s) left this month.</span>}
          <span>
            {billing.paidToday}/{billing.dailyCap} paid today.
          </span>
          {billing.flatPlanAvailable && !billing.subscriptionActive && addon?.prices?.[0] && (
            <Link
              to="/app/assist?plan=1"
              onClick={(e) => {
                e.preventDefault();
                setParams({ agent: agent?.key ?? '', plan: '1' });
              }}
            >
              Flat plan {addon.prices[0].formatted}/{addon.periodDays} days
            </Link>
          )}
        </div>
      )}
      {depleted && (
        <div data-testid="assist-paused">
          <Alert kind="warning">
            <b>{t('assist.paused')}</b>
            {resetAt ? ` · ${t('assist.pausedReset', { date: new Date(resetAt).toLocaleDateString() })}` : ''}
          </Alert>
        </div>
      )}
      {billing?.degraded && <Alert kind="info">Paid answers are paused for the rest of the month while the platform stays within its budget. Free lookups still work.</Alert>}
      {params.get('plan') === '1' && addon && (
        <Activate
          addon={addon}
          onDone={() => {
            setParams({ agent: agent?.key ?? '' });
            data.reload();
          }}
        />
      )}
      {mode === 'offline' && (
        <Alert kind="info">Agents are answering from built-in checks right now (no language model connected). Every question still runs through the same tools and audit log.</Alert>
      )}
      <div className="cc-layout">
        <aside className="cc-agents">
          <div className="cc-usage card">
            <div className="row between">
              <b>This month</b>
              <span className="tiny muted">{usage.runs} runs</span>
            </div>
            {usage.unlimited ? (
              <div className="tiny muted">Unlimited agent credit</div>
            ) : (
              <>
                <div className="progress mt-sm">
                  <div style={{ width: `${Math.min(100, (usage.acuUsed / Math.max(1, usage.allowance)) * 100)}%` }} />
                </div>
                <div className="tiny muted">
                  {usage.acuUsed} of {usage.allowance} agent credits used
                </div>
              </>
            )}
          </div>
          {agents.map((a) => (
            <button
              key={a.key}
              className={`cc-agent ${a.key === agent?.key ? 'active' : ''} ${!a.enabled || a.paused ? 'off' : ''}`}
              onClick={() => {
                setParams({ agent: a.key });
                setTab('chat');
              }}
            >
              <span className="cc-ico">{a.icon}</span>
              <span className="cc-agent-text">
                <b>{a.name}</b>
                <span className="tiny muted">{a.paused ? 'Paused by BitriPay' : !a.enabled ? 'Switched off' : a.tagline}</span>
              </span>
            </button>
          ))}
        </aside>
        <section className="cc-main card">
          {agent && (
            <>
              <div className="row between cc-head">
                <div className="row">
                  <span className="cc-ico big">{agent.icon}</span>
                  <div>
                    <b>{agent.name}</b>
                    <div className="tiny muted">
                      {agent.tagline}
                      {agent.scheduled ? ' · runs every morning for administrators' : ''}
                    </div>
                  </div>
                </div>
                <div className="row">
                  <div className="row" style={{ gap: 4 }}>
                    {(['chat', 'memory', 'history'] as const).map((k) => (
                      <Chip key={k} selected={tab === k} onClick={() => setTab(k)}>
                        {k === 'chat' ? 'Chat' : k === 'memory' ? 'Memory' : 'History'}
                      </Chip>
                    ))}
                  </div>
                  <label className="tiny muted row" style={{ gap: 6 }}>
                    <input type="checkbox" checked={agent.enabled} onChange={() => toggle(agent)} /> On
                  </label>
                </div>
              </div>
              {tab === 'memory' && <Memory />}
              {tab === 'history' && <History agent={agent.key} />}
              {tab === 'chat' && (
                <>
                  <div className="cc-thread">
                    {runs.length === 0 && !live && (
                      <Empty
                        icon={agent.icon}
                        text={`Ask ${agent.name} anything about your account. It can use: ${agent.tools.slice(0, 6).map(label).join(', ')}${agent.tools.length > 6 ? '…' : ''}`}
                      />
                    )}
                    {runs.map((r) => (
                      <RunBubble key={r.id} run={r} user={user?.fullName ?? 'You'} />
                    ))}
                    {live && (
                      <div className="cc-run">
                        <div className="cc-msg me">
                          {runs.length ? '' : ''}
                          {live.actions.length === 0 && !live.text ? 'Working…' : ''}
                        </div>
                        <Steps actions={live.actions} />
                        {live.text ? (
                          <div className="cc-msg agent">{live.text}</div>
                        ) : (
                          <div className="cc-msg agent muted">
                            <span className="spinner" /> {live.status === 'awaiting_approval' ? 'Waiting for an approval' : 'Checking…'}
                          </div>
                        )}
                      </div>
                    )}
                    <div ref={bottom} />
                  </div>
                  <div className="row wrap mt-sm">
                    {agent.suggestions.map((s) => (
                      <Chip key={s} onClick={() => ask(s)}>
                        {s}
                      </Chip>
                    ))}
                  </div>
                  <form
                    className="row mt-sm"
                    onSubmit={(e) => {
                      e.preventDefault();
                      ask(input);
                    }}
                  >
                    <input
                      className="input"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      placeholder={`Ask ${agent.name}…`}
                      disabled={!agent.enabled || agent.paused || !!live || depleted}
                      maxLength={4000}
                    />
                    {billing?.canDeep && billing.mode === 'per_use' && (
                      <label className="tiny muted row" style={{ gap: 4, whiteSpace: 'nowrap' }} title="Uses the main model for a longer analysis; priced higher">
                        <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} /> In depth
                      </label>
                    )}
                    <Button disabled={!input.trim() || !!live || !agent.enabled || agent.paused || depleted} title={depleted ? t('assist.paused') : undefined}>
                      Ask{priceLabel}
                    </Button>
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

/** Pricing disclosure: shown once (and again whenever prices change) before the first paid question. Nothing runs before it is accepted. */
function Consent({ billing, onDone }: { billing: any; onDone: () => void }) {
  const { toast } = useStore();
  const [busy, setBusy] = useState(false);
  const d = billing.disclosure;
  const accept = async () => {
    setBusy(true);
    try {
      await api.post('/api/assist/consent', { version: d.version });
      onDone();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <PageHeader title="Command centre" subtitle="Personal agents that read your account, explain your money and prepare actions you confirm yourself. Here is exactly what it costs." />
      <div className="grid cols-2">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>How questions are priced</h3>
          <ul className="small" style={{ paddingLeft: 18, lineHeight: 1.7 }}>
            {d.lines.map((l: string, i: number) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          <p className="tiny muted">
            You can read this again any time under the command centre. Not for you? Nothing changes: sending, receiving, cards, agents, statements and everything else keep working exactly as they do
            today.
          </p>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Prices in your wallet currencies</h3>
          <table style={{ width: '100%', fontSize: 14 }}>
            <tbody>
              <tr>
                <td>Lookups from your own records</td>
                <td className="bold" style={{ textAlign: 'right' }}>
                  Free
                </td>
              </tr>
              {billing.prices.map((p: any) => (
                <tr key={p.currency}>
                  <td>Question ({p.currency})</td>
                  <td className="bold" style={{ textAlign: 'right' }}>
                    {p.standardFormatted}
                  </td>
                </tr>
              ))}
              {billing.canDeep &&
                billing.prices.map((p: any) => (
                  <tr key={`d${p.currency}`}>
                    <td>In-depth analysis ({p.currency})</td>
                    <td className="bold" style={{ textAlign: 'right' }}>
                      {p.deepFormatted}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          <Button block loading={busy} onClick={accept}>
            I understand the prices, continue
          </Button>
          <Link className="btn ghost" to="/app" style={{ display: 'block', textAlign: 'center', marginTop: 8 }}>
            Not now
          </Link>
        </div>
      </div>
    </div>
  );
}

/** The flat plan is optional: an alternative to per-question pricing for heavy users. Everything else in BitriPay is unchanged. */
function Activate({ addon, onDone }: { addon: any; onDone: () => void }) {
  const { toast, refreshWallets } = useStore();
  const [currency, setCurrency] = useState<string>(addon.prices[0]?.currency ?? 'USD');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const price = addon.prices.find((p: any) => p.currency === currency) ?? addon.prices[0];
  const activate = async () => {
    setBusy(true);
    try {
      await api.post('/api/assist/addon/activate', { currency, pin });
      toast('Command centre activated', 'success');
      refreshWallets();
      onDone();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <PageHeader title="Flat plan" subtitle="Ask as many questions as you like for one fixed price per period, instead of paying per question." />
      <div className="grid cols-2">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>What you get</h3>
          <ul className="small" style={{ paddingLeft: 18, lineHeight: 1.7 }}>
            <li>
              <b>Chief of Staff</b>: a daily briefing of what matters on your account.
            </li>
            <li>
              <b>Analyst</b>: why a fee was charged, what you spent, a statement in one question.
            </li>
            <li>
              <b>Research, Automation, Security, Knowledge</b>: answers from BitriPay's guides, prepared repeat payments, safety checks and preferences it remembers.
            </li>
            <li>Every step is logged. Agents never move money: you confirm each action with your PIN or passkey.</li>
          </ul>
          <p className="tiny muted">Not for you? Nothing changes. Sending, receiving, cards, agents, statements and everything else keep working exactly as they do today.</p>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>
            {price?.formatted} <span className="small muted">for {addon.periodDays} days</span>
          </h3>
          <p className="small muted">Paid from your wallet now.{addon.autoRenewDefault ? ' Renews automatically; cancel any time.' : ''}</p>
          {addon.prices.length > 1 && (
            <div className="row wrap mb">
              {addon.prices.map((p: any) => (
                <Chip key={p.currency} selected={p.currency === currency} onClick={() => setCurrency(p.currency)}>
                  {p.formatted}
                </Chip>
              ))}
            </div>
          )}
          <label className="small">Your transaction PIN</label>
          <input className="input" type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="••••" />
          <Button block loading={busy} disabled={pin.length < 4} onClick={activate}>
            Activate for {price?.formatted}
          </Button>
          <p className="tiny muted mt-sm">
            Low balance? <Link to="/app/add-money">Add money</Link> first.
          </p>
        </div>
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
      <div className="cc-msg me">
        <span className="tiny muted">
          {user} · {new Date(run.createdAt).toLocaleString()}
        </span>
        {run.input}
      </div>
      <Steps actions={run.actions} />
      {run.output && (
        <div className="cc-msg agent">
          <span className="tiny muted">
            {run.agentName}
            {run.billing
              ? run.billing.charged
                ? ` · charged ${(run.billing.amount / 100).toFixed(2)} ${run.billing.currency}`
                : run.billing.reason === 'lookup' || run.billing.reason === 'offline'
                  ? ' · free lookup'
                  : run.billing.reason === 'allowance'
                    ? ' · free (allowance)'
                    : run.billing.reason === 'degraded'
                      ? ' · free (paused answers)'
                      : ''
              : ''}
          </span>
          {run.output}
        </div>
      )}
      {run.status === 'failed' && (
        <div className="cc-msg agent">
          <Alert kind="error">{run.error ?? 'Something went wrong.'}</Alert>
        </div>
      )}
      {run.status === 'budget_exhausted' && (
        <div className="cc-msg agent">
          <Alert kind="warning">Your monthly agent credit is used up. It resets next month.</Alert>
        </div>
      )}
      {run.status === 'awaiting_approval' && (
        <div className="cc-msg agent">
          <Alert kind="warning">An action is queued for a second administrator to approve. You will be notified.</Alert>
        </div>
      )}
      {run.proposals.map((p, i) => (
        <div key={i} className="cc-proposal">
          <div>
            <b>{p.title}</b>
            <div className="tiny muted">{p.why ?? 'Prepared for you to confirm. Nothing has been executed.'}</div>
          </div>
          <Link className="btn" to={p.link}>
            Review & confirm
          </Link>
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
        <div key={m.id} className="row between cc-memory">
          <span>
            <Chip>{m.kind}</Chip> {m.content}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              api
                .del(`/api/assist/memories/${m.id}`)
                .then(() => mem.reload())
                .catch((e) => toast(e.message, 'error'))
            }
          >
            Delete
          </Button>
        </div>
      ))}
      <form
        className="row mt"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. I prefer receipts on WhatsApp" maxLength={400} />
        <Button variant="secondary">Remember</Button>
      </form>
      {(mem.data?.items ?? []).length > 0 && (
        <Button variant="ghost" size="sm" onClick={() => api.del('/api/assist/memories').then(() => mem.reload())}>
          Delete everything
        </Button>
      )}
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
        <div key={r.id} className="row between cc-memory">
          <span>
            <Chip kind={r.status === 'completed' ? 'success' : r.status === 'failed' ? 'danger' : 'warning'}>{r.status.replace(/_/g, ' ')}</Chip> {r.input}
          </span>
          <span className="tiny muted">
            {new Date(r.createdAt).toLocaleString()} · {r.steps} steps{r.acu ? ` · ${r.acu} credits` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}
