import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { useT, tr } from '../lib/i18n';
import { Alert, AmountInput, Avatar, Button, Empty, Field, Input, KV, Modal, PageHeader, PinModal, StatusBadge, useAsync, useDebounce } from '../components/ui';
import type { PublicUser } from '@bitripay/shared';
import { countryLabel } from '@bitripay/shared';

type Agent = PublicUser & { commissionBps: number };

export function Agents() {
  const t = useT();
  const { wallets, money, toast, user } = useStore();
  const [params] = useSearchParams();
  const [q, setQ] = useState('');
  const dq = useDebounce(q, 300);
  const agents = useAsync(() => api.get<{ items: Agent[] }>(`/api/agents?q=${encodeURIComponent(dq)}`), [dq]);
  const requests = useAsync(() => api.get<{ items: any[] }>('/api/agents/cash-requests'), []);
  const [selected, setSelected] = useState<Agent | null>(null);
  const [amount, setAmount] = useState('');
  const [cur, setCur] = useState(wallets[0]?.currency || 'USD');
  const [pinOpen, setPinOpen] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const preselect = params.get('agent');
  if (preselect && !selected && agents.data) {
    const a = agents.data.items.find((x) => x.tag === preselect);
    if (a) setSelected(a);
  }

  const submit = async (pin: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.post<{ request: any }>('/api/agents/cash-out', { agent: selected!.tag, amount, currency: cur, pin });
      setResult(r.request);
      setPinOpen(false);
      requests.reload();
      toast(tr('Cash-out code created – show it to the agent'), 'success');
    } catch (err) {
      setError((err as Error).message);
      setPinOpen(false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <PageHeader title={t('nav.agents')} subtitle={tr('Deposit or withdraw cash with a BitriPay agent near you')} />
      <div className="grid cols-2">
        <div className="card">
          <Field label={tr('Find an agent')}>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Search by name, business or @tag')} />
          </Field>
          {agents.data?.items.length === 0 && <Empty icon="🏪" text={tr('No agents found')} />}
          <div className="list">
            {agents.data?.items.map((a) => (
              <div key={a.id} className={`list-item clickable`} onClick={() => setSelected(a)}>
                <Avatar user={a} />
                <div className="flex1">
                  <div className="main-text">{a.businessName || a.fullName}</div>
                  <div className="sub-text">
                    @{a.tag} {a.country ? `· ${countryLabel(a.country)}` : ''} · commission {(a.commissionBps / 100).toFixed(2)}%
                  </div>
                </div>
                <Button size="sm" variant={selected?.id === a.id ? undefined : 'secondary'}>
                  {tr('Select')}
                </Button>
              </div>
            ))}
          </div>
          <div className="alert info small mt">
            <b>Cash-in:</b> hand cash to the agent and tell them your @{user?.tag}; they credit your wallet instantly.
            <br />
            <b>Cash-out:</b> create a code below, show it to the agent, and receive cash.
          </div>
        </div>
        <div className="card">
          <h3>{tr('Withdraw cash (cash-out)')}</h3>
          {error && <Alert kind="error">{error}</Alert>}
          {selected ? (
            <div className="list-item card soft compact mb">
              <Avatar user={selected} />
              <div>
                <div className="main-text">{selected.businessName || selected.fullName}</div>
                <div className="sub-text">@{selected.tag}</div>
              </div>
            </div>
          ) : (
            <p className="muted small">{tr('Select an agent from the list first.')}</p>
          )}
          <Field label={t('common.amount')}>
            <AmountInput amount={amount} currency={cur} onAmount={setAmount} onCurrency={setCur} big />
          </Field>
          <Button block disabled={!selected || !amount} onClick={() => setPinOpen(true)}>
            {tr('Create cash-out code')}
          </Button>
          <h3 className="mt">{tr('My cash requests')}</h3>
          {requests.data?.items.length === 0 && <Empty icon="💵" />}
          <div className="list">
            {requests.data?.items.map((r) => (
              <div key={r.id} className="list-item">
                <div className="flex1">
                  <div className="main-text">
                    {money(r.amount, r.currency)} · <span className="mono">{r.code}</span>
                  </div>
                  <div className="sub-text">
                    {r.kind.replace('_', '-')} · {r.agent?.businessName || r.agent?.fullName} · {new Date(r.createdAt).toLocaleString()}
                  </div>
                </div>
                <StatusBadge status={r.status} />
                {r.status === 'pending' && (
                  <Button size="sm" variant="ghost" onClick={() => api.post(`/api/agents/cash-requests/${r.code}/cancel`).then(requests.reload)}>
                    {t('common.cancel')}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <PinModal
        open={pinOpen}
        onClose={() => setPinOpen(false)}
        onSubmit={submit}
        loading={loading}
        summary={<KV k={`Cash out at ${selected?.businessName || selected?.fullName}`} v={`${amount} ${cur}`} />}
      />
      <Modal open={!!result} onClose={() => setResult(null)} title={tr('Show this code to the agent')}>
        {result && (
          <div className="center">
            <div style={{ fontSize: '2.4rem', letterSpacing: '0.2em', fontWeight: 800 }} className="mono">
              {result.code}
            </div>
            <p className="muted small">
              {money(result.amount, result.currency)} {tr('+ fee')} {money(result.fee, result.currency)} · expires {new Date(result.expiresAt).toLocaleTimeString()}
            </p>
            <p className="small">{tr('The agent enters this code to hand you the cash. Funds leave your wallet only when they confirm.')}</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
