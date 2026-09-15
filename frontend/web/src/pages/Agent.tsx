import { useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, AmountInput, Avatar, Button, Empty, Field, Input, KV, PageHeader, PinModal, StatusBadge, Tabs, useAsync, useDebounce, QrImage } from '../components/ui';
import type { PublicUser } from '@bitripay/shared';
import { Link } from 'react-router-dom';
import { columnChart, type AnalyticsSeries } from '@bitripay/charts';
import { Chart } from '@bitripay/charts/react';
import { tickMoney } from './Insights';
import { OrganisationTeam } from '../components/OrganisationTeam';

/**
 * Agent dashboard: the till. The agent account owns it; members of the agent's team (invited under the Team tab) reach
 * the same page with their own login and see the agent's float and queue, limited to what their role allows.
 */
export function AgentDashboard() {
  const { user, money, wallets, memberships, toast, refreshWallets, config } = useStore();
  const [tab, setTab] = useState<'cashin' | 'cashout' | 'pickup' | 'requests' | 'payouts' | 'team'>('cashin');
  const isAgent = user?.role === 'agent' || user?.role === 'admin';
  const counter = memberships.find((m) => m.kind === 'agent' && !m.owner) ?? null;
  const allowed = isAgent || !!counter;
  const payouts = useAsync(() => (allowed && tab === 'payouts' ? api.get<{ items: any[] }>('/api/payouts/agent/queue') : Promise.resolve(null)), [tab, allowed]);
  const [evidence, setEvidence] = useState<{ id: string; text: string; externalRef: string } | null>(null);
  const stats = useAsync(() => (allowed ? api.get<any>('/api/agents/me/stats') : Promise.resolve(null)), [tab, allowed]);
  const insights = useAsync(() => (isAgent ? api.get<AnalyticsSeries>('/api/account/analytics?days=30') : Promise.resolve(null)), [tab, isAgent]);
  const requests = useAsync(() => (allowed ? api.get<{ items: any[] }>('/api/agents/me/cash-requests') : Promise.resolve(null)), [tab, allowed]);
  const org = useAsync(() => (allowed ? api.get<any>('/api/organisations/me').catch(() => null) : Promise.resolve(null)), [tab, allowed]);
  const can = (p: string) => {
    const mine: string[] = org.data?.membership?.permissions ?? ['*'];
    return mine.includes('*') || mine.includes(p);
  };
  const [customer, setCustomer] = useState('');
  const dCustomer = useDebounce(customer, 300);
  const found = useAsync(() => (dCustomer.length >= 3 ? api.get<{ user: PublicUser }>(`/api/account/lookup?q=${encodeURIComponent(dCustomer)}`) : Promise.resolve(null)), [dCustomer]);
  const [amount, setAmount] = useState('');
  const [cur, setCur] = useState(wallets[0]?.currency || 'USD');
  const [code, setCode] = useState('');
  const [pickup, setPickup] = useState<any>(null);
  const [idNumber, setIdNumber] = useState('');
  const [pin, setPin] = useState<null | 'cashin' | 'cashout' | 'pickup'>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  if (!allowed) return <Alert kind="warning">This area is for agent accounts and the members of an agent's team.</Alert>;
  const s = stats.data;
  // A team member sees the agent's float, never their own wallet; the agent sees the same figures from the wallet store.
  const float: { currency: string; balance: number }[] = s?.float?.length ? s.float : wallets;
  const agentTag = s?.agent?.tag ?? user?.tag;
  const title = s?.agent?.name || user?.businessName || 'Agent dashboard';

  const run = async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      if (pin === 'cashin') {
        await api.post('/api/agents/me/cash-in', { customer: found.data?.user.tag ?? customer, amount, currency: cur, pin: p });
        toast('Customer wallet credited', 'success');
        setAmount('');
      } else if (pin === 'cashout') {
        await api.post('/api/agents/me/cash-out/confirm', { code, pin: p });
        toast('Cash-out confirmed – hand over the cash', 'success');
        setCode('');
      } else if (pin === 'pickup') {
        await api.post(`/api/agents/me/pickups/${pickup.pickupCode}/payout`, { recipientIdNumber: idNumber, pin: p });
        toast('Pickup paid out – your float was credited', 'success');
        setPickup(null);
      }
      setPin(null);
      refreshWallets();
      stats.reload();
      requests.reload();
    } catch (err) {
      setError((err as Error).message);
      setPin(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <PageHeader
        title={title}
        subtitle={`@${agentTag} · commission ${(s?.commissionBps ?? config?.agentCommissionBps ?? 0) / 100}%${counter ? ` · you work here as ${counter.role.replace(/_/g, ' ')}` : ''}`}
      />
      {counter && (
        <Alert kind="info">
          You are at the counter of <b>{counter.name}</b> with your own login. Cash operations use the agent's float and record you as the operator; confirm them with your own PIN.
        </Alert>
      )}
      <div className="grid cols-4">
        <div className="card">
          <div className="stat">
            <span className="label">Float</span>
            <span className="value">{float[0] ? money(float[0].balance, float[0].currency) : '—'}</span>
            <span className="small muted">
              {float
                .slice(1)
                .map((w) => money(w.balance, w.currency))
                .join(' · ')}
            </span>
          </div>
        </div>
        <div className="card">
          <div className="stat">
            <span className="label">Cash-in (30d)</span>
            <span className="value">{s?.cashInCount ?? 0}</span>
          </div>
        </div>
        <div className="card">
          <div className="stat">
            <span className="label">Cash-out (30d)</span>
            <span className="value">{s?.cashOutCount ?? 0}</span>
          </div>
        </div>
        <div className="card">
          <div className="stat">
            <span className="label">Commission (30d)</span>
            <span className="value">{s ? money(s.commissionEarned, wallets[0]?.currency || 'USD') : '—'}</span>
            <span className="small muted">{s?.pendingRequests ?? 0} pending requests</span>
          </div>
        </div>
      </div>
      {!!insights.data?.extras.cash && (
        <div className="card mt">
          <div className="card-title">
            <h3>Cash-in and cash-out per day (30 days)</h3>
            <Link to="/app/insights" className="small">
              All charts →
            </Link>
          </div>
          <Chart
            scene={columnChart(
              (insights.data.extras.cash as { labels: string[] }).labels.map((l) => l.slice(5)),
              [
                { name: 'Cash-in', values: (insights.data.extras.cash as { cashIn: number[] }).cashIn },
                { name: 'Cash-out', values: (insights.data.extras.cash as { cashOut: number[] }).cashOut },
              ],
              { format: tickMoney(money, config?.baseCurrency ?? 'USD'), labels: false, height: 200 },
            )}
          />
        </div>
      )}
      <div className="mt" />
      <Tabs
        tabs={[
          { id: 'cashin', label: 'Cash-in (deposit)' },
          { id: 'cashout', label: 'Cash-out (withdraw)' },
          { id: 'pickup', label: 'Cash pickup' },
          { id: 'requests', label: 'Requests' },
          { id: 'payouts', label: '📤 Payouts to execute' },
          { id: 'team', label: `👥 Team${s?.teamSize ? ` (${s.teamSize})` : ''}` },
        ]}
        value={tab}
        onChange={(v) => setTab(v as any)}
      />
      {error && <Alert kind="error">{error}</Alert>}
      <div className="grid cols-2">
        {tab === 'cashin' && (
          <div className="card">
            <h3>Credit a customer's wallet</h3>
            <p className="small muted">
              Take cash from the customer, then send the same amount from your float. The platform fee is deducted from the customer's credit and your commission is paid instantly.
            </p>
            <Field label="Customer (@tag, email or phone)">
              <Input value={customer} onChange={(e) => setCustomer(e.target.value)} />
            </Field>
            {found.data?.user && (
              <div className="list-item card soft compact mb">
                <Avatar user={found.data.user} />
                <div>
                  <div className="main-text">{found.data.user.fullName}</div>
                  <div className="sub-text">@{found.data.user.tag}</div>
                </div>
              </div>
            )}
            <Field label="Amount">
              <AmountInput amount={amount} currency={cur} onAmount={setAmount} onCurrency={setCur} big />
            </Field>
            <Button block size="lg" disabled={!found.data?.user || !amount} onClick={() => setPin('cashin')}>
              Confirm cash-in
            </Button>
          </div>
        )}
        {tab === 'cashout' && (
          <div className="card">
            <h3>Pay out cash</h3>
            <p className="small muted">The customer creates a cash-out request in their app and shows you the code. Confirm it to receive the funds in your float, then hand over the cash.</p>
            <Field label="Cash-out code">
              <Input className="pin-input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABC123" />
            </Field>
            <Button block size="lg" disabled={code.length < 4} onClick={() => setPin('cashout')}>
              Confirm & pay cash
            </Button>
          </div>
        )}
        {tab === 'pickup' && (
          <div className="card">
            <h3>Remittance cash pickup</h3>
            <Field label="Pickup code">
              <div className="row">
                <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX" />
                <Button
                  variant="secondary"
                  onClick={() =>
                    api
                      .get<{ remittance: any }>(`/api/agents/me/pickups/${code}`)
                      .then((r) => setPickup(r.remittance))
                      .catch((e) => setError(e.message))
                  }
                >
                  Look up
                </Button>
              </div>
            </Field>
            {pickup && (
              <div className="card soft compact mb">
                <KV k="Recipient" v={pickup.recipient?.name} />
                <KV k="Amount to pay" v={<b>{money(pickup.targetAmount, pickup.targetCurrency)}</b>} />
                <KV k="Sender" v={pickup.sender?.fullName} />
                <KV k="Status" v={<StatusBadge status={pickup.status} />} />
              </div>
            )}
            {pickup?.status === 'ready_for_pickup' && (
              <>
                <Field label="Recipient ID number (verify their ID)">
                  <Input value={idNumber} onChange={(e) => setIdNumber(e.target.value)} />
                </Field>
                <Button block size="lg" onClick={() => setPin('pickup')}>
                  Pay out {money(pickup.targetAmount, pickup.targetCurrency)}
                </Button>
              </>
            )}
          </div>
        )}
        {tab === 'requests' && (
          <div className="card">
            <h3>Cash-out requests</h3>
            {requests.data?.items.length === 0 && <Empty icon="💵" />}
            <div className="list">
              {requests.data?.items.map((r) => (
                <div key={r.id} className="list-item">
                  <Avatar user={r.customer} size="sm" />
                  <div className="flex1">
                    <div className="main-text">
                      {money(r.amount, r.currency)} · <span className="mono">{r.code}</span>
                    </div>
                    <div className="sub-text">
                      {r.customer?.fullName} · {new Date(r.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <StatusBadge status={r.status} />
                  {r.status === 'pending' && can('agent:cash_out') && (
                    <Button
                      size="sm"
                      onClick={() => {
                        setCode(r.code);
                        setPin('cashout');
                      }}
                    >
                      Confirm
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        {tab !== 'team' && (
          <div className="card center">
            <h3>{counter ? 'Agent QR' : 'Your agent QR'}</h3>
            <p className="small muted">Customers scan this to cash out {counter ? 'at this counter' : 'with you'} or send money to the agent.</p>
            <QrImage value={`${config?.webUrl}/q?v=1&t=ag&id=${agentTag}`} size={200} />
            <div className="mt bold">@{agentTag}</div>
          </div>
        )}
      </div>
      {tab === 'team' && <OrganisationTeam org={org} toast={toast} err={(e: any) => toast(e.message, 'error')} kind="agent" />}
      {tab === 'payouts' && (
        <div className="card">
          <h3>Payouts assigned to your payout account</h3>
          <p className="small muted">
            Execute each transfer from the merchant SIM with USSD / the operator app. The Android forwarder on that SIM submits the signed confirmation SMS automatically; only then does the transfer
            settle. If you must type the confirmation by hand it goes to a second administrator for approval – it never settles on your word alone.
          </p>
          {payouts.data?.items.length === 0 && <Empty icon="📤" text="Nothing queued for you" />}
          <div className="list">
            {(payouts.data?.items ?? []).map((p: any) => (
              <div key={p.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                <div className="flex1">
                  <div className="main-text">
                    {money(p.amount, p.currency)} → {p.operatorName ?? p.rail} {p.recipientMsisdn ?? p.recipientMasked}
                    {p.recipientName ? ` (${p.recipientName})` : ''}
                  </div>
                  <div className="sub-text">
                    Ref <span className="mono">{p.reference}</span> · <StatusBadge status={p.stage.toLowerCase().replace(/_/g, ' ')} />
                    {p.riskFlags?.length ? (
                      <span className="tiny" style={{ color: 'var(--danger)' }}>
                        {' '}
                        · {p.riskFlags.join(', ')}
                      </span>
                    ) : null}
                  </div>
                  {p.instructions && (
                    <ol className="tiny mt-sm">
                      {p.instructions.steps.map((st: string) => (
                        <li key={st}>{st}</li>
                      ))}
                    </ol>
                  )}
                </div>
                <div className="col">
                  {p.stage === 'QUEUED' && (
                    <Button
                      size="sm"
                      onClick={() =>
                        api
                          .post(`/api/payouts/agent/${p.id}/claim`)
                          .then(() => {
                            toast('Claimed – execute the transfer now', 'success');
                            payouts.reload();
                          })
                          .catch((e) => toast(e.message, 'error'))
                      }
                    >
                      Start payout
                    </Button>
                  )}
                  {p.stage === 'IN_PROGRESS' && (
                    <>
                      <Button size="sm" variant="secondary" onClick={() => setEvidence({ id: p.id, text: '', externalRef: '' })}>
                        Enter confirmation manually
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => api.post(`/api/payouts/agent/${p.id}/release`, { reason: 'Could not execute' }).then(payouts.reload)}>
                        Give back
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {evidence && (
        <div className="card">
          <h4>Manual confirmation (goes to maker-checker)</h4>
          <Field label="Operator confirmation SMS, exactly as received">
            <Input value={evidence.text} onChange={(e) => setEvidence({ ...evidence, text: e.target.value })} />
          </Field>
          <Field label="Operator transaction ID">
            <Input value={evidence.externalRef} onChange={(e) => setEvidence({ ...evidence, externalRef: e.target.value })} />
          </Field>
          <div className="row">
            <Button
              disabled={evidence.text.length < 5 || evidence.externalRef.length < 4}
              onClick={() =>
                api
                  .post(`/api/payouts/agent/${evidence.id}/evidence`, { text: evidence.text, externalRef: evidence.externalRef })
                  .then(() => {
                    toast('Submitted for approval', 'success');
                    setEvidence(null);
                    payouts.reload();
                  })
                  .catch((e) => toast(e.message, 'error'))
              }
            >
              Submit
            </Button>
            <Button variant="ghost" onClick={() => setEvidence(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      <PinModal open={!!pin} onClose={() => setPin(null)} onSubmit={run} loading={loading} title="Confirm with your PIN" />
    </div>
  );
}
