import { useEffect, useState } from 'react';
import { Route, Routes, useNavigate, useParams, Link } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { Alert, Avatar, Button, Empty, Field, Input, KV, Modal, PageHeader, PinModal, Select, StatusBadge, Tabs, Textarea, useAsync } from '../components/ui';
import { fromMinor } from '@bitripay/shared';

export function P2P() {
  return (
    <Routes>
      <Route index element={<Marketplace />} />
      <Route path="trades/:id" element={<TradeDetail />} />
    </Routes>
  );
}

function Marketplace() {
  const t = useT();
  const nav = useNavigate();
  const { config, money, wallets, user, toast, currency } = useStore();
  const [tab, setTab] = useState<'market' | 'trades' | 'ads'>('market');
  const [side, setSide] = useState<'sell' | 'buy'>('sell');
  const [cur, setCur] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [openAd, setOpenAd] = useState<any>(null);
  const [tradeAmount, setTradeAmount] = useState('');
  const [tradeMethod, setTradeMethod] = useState('wallet');
  const [ad, setAd] = useState({
    side: 'sell',
    currency: wallets[0]?.currency || 'USD',
    priceCurrency: 'EUR',
    rate: '',
    minAmount: '',
    maxAmount: '',
    availableAmount: '',
    paymentMethods: ['wallet'],
    terms: '',
  });
  const [error, setError] = useState<string | null>(null);
  const ads = useAsync(() => api.get<{ items: any[] }>(`/api/p2p/ads${qs({ side, currency: cur })}`), [side, cur, tab]);
  const trades = useAsync(() => api.get<{ items: any[] }>('/api/p2p/trades'), [tab]);
  const myAds = useAsync(() => api.get<{ items: any[] }>('/api/p2p/ads/mine'), [tab]);

  const createAd = async () => {
    setError(null);
    try {
      await api.post('/api/p2p/ads', { ...ad, rate: Number(ad.rate) });
      setCreateOpen(false);
      toast('Ad published', 'success');
      setTab('ads');
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const openTrade = async () => {
    setError(null);
    try {
      const r = await api.post<{ trade: any }>('/api/p2p/trades', { adId: openAd.id, amount: tradeAmount, paymentMethod: tradeMethod });
      setOpenAd(null);
      nav(`/app/p2p/trades/${r.trade.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div>
      <PageHeader
        title={t('nav.p2p')}
        subtitle="Buy and sell currency directly with other users. Escrow protects every trade."
        actions={<Button onClick={() => setCreateOpen(true)}>+ Post an ad</Button>}
      />
      <Tabs
        tabs={[
          { id: 'market', label: 'Marketplace' },
          { id: 'trades', label: 'My trades' },
          { id: 'ads', label: 'My ads' },
        ]}
        value={tab}
        onChange={(v) => setTab(v as any)}
      />
      {tab === 'market' && (
        <div className="card">
          <div className="row wrap mb">
            <Tabs
              pills
              tabs={[
                { id: 'sell', label: 'Buy currency (from sellers)' },
                { id: 'buy', label: 'Sell currency (to buyers)' },
              ]}
              value={side}
              onChange={(v) => setSide(v as any)}
            />
            <Select value={cur} onChange={(e) => setCur(e.target.value)} style={{ width: 160 }}>
              <option value="">All currencies</option>
              {(config?.currencies ?? []).map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}
                </option>
              ))}
            </Select>
          </div>
          {ads.data?.items.length === 0 && <Empty icon="🤝" text="No live offers match" />}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Trader</th>
                  <th>Currency</th>
                  <th>Rate</th>
                  <th>Limits</th>
                  <th>Available</th>
                  <th>Payment</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {ads.data?.items.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <div className="row">
                        <Avatar user={a.user} size="sm" />
                        <div>
                          <div className="bold small">{a.user?.fullName}</div>
                          <div className="tiny muted">
                            {a.user?.stats?.trades} trades · {a.user?.stats?.completionRate}%
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <b>{a.currency}</b> for {a.priceCurrency}
                    </td>
                    <td>
                      1 {a.currency} = {a.rate} {a.priceCurrency}
                    </td>
                    <td>
                      {money(a.minAmount, a.currency)} – {money(a.maxAmount, a.currency)}
                    </td>
                    <td>{money(a.availableAmount, a.currency)}</td>
                    <td>
                      {a.paymentMethods.map((m: string) => (
                        <span key={m} className="chip">
                          {m.replace('_', ' ')}
                        </span>
                      ))}
                    </td>
                    <td>
                      {a.userId !== user?.id && (
                        <Button
                          size="sm"
                          onClick={() => {
                            setOpenAd(a);
                            setTradeAmount(fromMinor(a.minAmount, currency(a.currency).decimals));
                            setTradeMethod(a.paymentMethods[0]);
                          }}
                        >
                          {a.side === 'sell' ? 'Buy' : 'Sell'}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {tab === 'trades' && (
        <div className="card">
          {trades.data?.items.length === 0 && <Empty icon="📑" />}
          <div className="list">
            {trades.data?.items.map((tr) => (
              <div key={tr.id} className="list-item clickable" onClick={() => nav(`/app/p2p/trades/${tr.id}`)}>
                <div className="flex1">
                  <div className="main-text">
                    {tr.buyerId === user?.id ? 'Buy' : 'Sell'} {money(tr.amount, tr.currency)} for {money(tr.priceAmount, tr.priceCurrency)}
                  </div>
                  <div className="sub-text">
                    {tr.reference} · with {(tr.buyerId === user?.id ? tr.seller : tr.buyer)?.fullName} · {new Date(tr.updatedAt).toLocaleString()}
                  </div>
                </div>
                <StatusBadge status={tr.status} />
              </div>
            ))}
          </div>
        </div>
      )}
      {tab === 'ads' && (
        <div className="card">
          {myAds.data?.items.length === 0 && <Empty icon="📢" />}
          <div className="list">
            {myAds.data?.items.map((a) => (
              <div key={a.id} className="list-item">
                <div className="flex1">
                  <div className="main-text">
                    {a.side.toUpperCase()} {a.currency} @ {a.rate} {a.priceCurrency}
                  </div>
                  <div className="sub-text">
                    {money(a.minAmount, a.currency)} – {money(a.maxAmount, a.currency)} · available {money(a.availableAmount, a.currency)}
                  </div>
                </div>
                <StatusBadge status={a.status} />
                {a.status === 'active' ? (
                  <Button size="sm" variant="secondary" onClick={() => api.post(`/api/p2p/ads/${a.id}/status`, { status: 'paused' }).then(myAds.reload)}>
                    Pause
                  </Button>
                ) : a.status === 'paused' ? (
                  <Button size="sm" variant="secondary" onClick={() => api.post(`/api/p2p/ads/${a.id}/status`, { status: 'active' }).then(myAds.reload)}>
                    Resume
                  </Button>
                ) : null}
                {a.status !== 'closed' && (
                  <Button size="sm" variant="ghost" onClick={() => api.post(`/api/p2p/ads/${a.id}/status`, { status: 'closed' }).then(myAds.reload)}>
                    Close
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Post a P2P ad">
        {error && <Alert kind="error">{error}</Alert>}
        <Field label="I want to">
          <Select value={ad.side} onChange={(e) => setAd({ ...ad, side: e.target.value })}>
            <option value="sell">Sell currency</option>
            <option value="buy">Buy currency</option>
          </Select>
        </Field>
        <div className="grid cols-2">
          <Field label="Currency">
            <Select value={ad.currency} onChange={(e) => setAd({ ...ad, currency: e.target.value })}>
              {(config?.currencies ?? []).map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priced in">
            <Select value={ad.priceCurrency} onChange={(e) => setAd({ ...ad, priceCurrency: e.target.value })}>
              {(config?.currencies ?? []).map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={`Rate (1 ${ad.currency} = ? ${ad.priceCurrency})`}>
          <Input inputMode="decimal" value={ad.rate} onChange={(e) => setAd({ ...ad, rate: e.target.value })} />
        </Field>
        <div className="grid cols-3">
          <Field label="Min">
            <Input inputMode="decimal" value={ad.minAmount} onChange={(e) => setAd({ ...ad, minAmount: e.target.value })} />
          </Field>
          <Field label="Max">
            <Input inputMode="decimal" value={ad.maxAmount} onChange={(e) => setAd({ ...ad, maxAmount: e.target.value })} />
          </Field>
          <Field label="Available">
            <Input inputMode="decimal" value={ad.availableAmount} onChange={(e) => setAd({ ...ad, availableAmount: e.target.value })} />
          </Field>
        </div>
        <Field label="Payment methods accepted">
          <div className="row wrap">
            {['wallet', 'bank_transfer', 'mobile_money', 'cash'].map((m) => (
              <span
                key={m}
                className={`chip clickable ${ad.paymentMethods.includes(m) ? 'selected' : ''}`}
                onClick={() => setAd({ ...ad, paymentMethods: ad.paymentMethods.includes(m) ? ad.paymentMethods.filter((x) => x !== m) : [...ad.paymentMethods, m] })}
              >
                {m.replace('_', ' ')}
              </span>
            ))}
          </div>
        </Field>
        <Field label="Terms (optional)">
          <Textarea value={ad.terms} onChange={(e) => setAd({ ...ad, terms: e.target.value })} />
        </Field>
        <Button block onClick={createAd} disabled={!ad.rate || !ad.minAmount || !ad.maxAmount || !ad.availableAmount}>
          Publish
        </Button>
      </Modal>
      <Modal open={!!openAd} onClose={() => setOpenAd(null)} title={openAd ? `${openAd.side === 'sell' ? 'Buy' : 'Sell'} ${openAd.currency}` : ''}>
        {error && <Alert kind="error">{error}</Alert>}
        {openAd && (
          <>
            <KV k="Rate" v={`1 ${openAd.currency} = ${openAd.rate} ${openAd.priceCurrency}`} />
            <KV k="Limits" v={`${money(openAd.minAmount, openAd.currency)} – ${money(openAd.maxAmount, openAd.currency)}`} />
            {openAd.terms && <p className="small muted mt-sm">{openAd.terms}</p>}
            <Field label={`Amount (${openAd.currency})`}>
              <Input className="amount-input" inputMode="decimal" value={tradeAmount} onChange={(e) => setTradeAmount(e.target.value.replace(/[^\d.]/g, ''))} />
            </Field>
            <Field label="Payment method">
              <Select value={tradeMethod} onChange={(e) => setTradeMethod(e.target.value)}>
                {openAd.paymentMethods.map((m: string) => (
                  <option key={m} value={m}>
                    {m.replace('_', ' ')}
                    {m === 'wallet' ? ' (instant, escrow settled automatically)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <p className="small muted">
              You'll pay about {tradeAmount && !isNaN(Number(tradeAmount)) ? (Number(tradeAmount) * openAd.rate).toFixed(2) : '—'} {openAd.priceCurrency}. The other party can accept or counter your
              offer.
            </p>
            <Button block onClick={openTrade} disabled={!tradeAmount}>
              Open trade
            </Button>
          </>
        )}
      </Modal>
    </div>
  );
}

function TradeDetail() {
  const { id } = useParams();
  const { user, money, toast, refreshWallets } = useStore();
  const trade = useAsync(() => api.get<{ trade: any }>(`/api/p2p/trades/${id}`), [id]);
  const [msg, setMsg] = useState('');
  const [counter, setCounter] = useState<{ amount: string; rate: string } | null>(null);
  const [pinAction, setPinAction] = useState<null | 'accept' | 'release'>(null);
  const [dispute, setDispute] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tr = trade.data?.trade;
  useEffect(() => {
    const timer = setInterval(() => trade.reload(), 5000);
    return () => clearInterval(timer);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!tr) return <div className="card">Loading…</div>;
  const isBuyer = tr.buyerId === user?.id;
  const other = isBuyer ? tr.seller : tr.buyer;
  const pending = tr.offers?.filter((o: any) => o.status === 'pending').slice(-1)[0];
  const act = async (path: string, body: any = {}) => {
    setError(null);
    try {
      await api.post(`/api/p2p/trades/${tr.id}/${path}`, body);
      trade.reload();
      refreshWallets();
      toast('Updated', 'success');
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div>
      <PageHeader
        title={`Trade ${tr.reference}`}
        subtitle={`${isBuyer ? 'Buying' : 'Selling'} ${money(tr.amount, tr.currency)} for ${money(tr.priceAmount, tr.priceCurrency)} · ${tr.paymentMethod}`}
        actions={
          <Link to="/app/p2p" className="btn secondary">
            ← Back
          </Link>
        }
      />
      {error && <Alert kind="error">{error}</Alert>}
      <div className="grid cols-2">
        <div className="card">
          <div className="row between mb">
            <StatusBadge status={tr.status} />
            <span className="small muted">Rate {tr.rate}</span>
          </div>
          <div className="list-item">
            <Avatar user={other} />
            <div>
              <div className="main-text">{other?.fullName}</div>
              <div className="sub-text">
                @{other?.tag} · {isBuyer ? 'seller' : 'buyer'}
              </div>
            </div>
          </div>
          <h4 className="mt">Offers</h4>
          {tr.offers?.map((o: any) => (
            <div key={o.id} className="kv">
              <span className="k">
                {o.fromUserId === user?.id ? 'You' : other?.fullName}: {money(o.amount, tr.currency)} @ {o.rate}
                {o.message ? ` · "${o.message}"` : ''}
              </span>
              <StatusBadge status={o.status} />
            </div>
          ))}
          <div className="divider" />
          {tr.status === 'negotiating' && (
            <div className="row wrap">
              {pending && pending.fromUserId !== user?.id && <Button onClick={() => setPinAction('accept')}>Accept offer</Button>}
              <Button variant="secondary" onClick={() => setCounter({ amount: fromMinor(tr.amount, 2), rate: String(tr.rate) })}>
                Counter-offer
              </Button>
              <Button variant="ghost" onClick={() => act('cancel')}>
                Cancel
              </Button>
            </div>
          )}
          {tr.status === 'escrowed' && isBuyer && (
            <div className="col">
              <Alert kind="info">
                Pay {money(tr.priceAmount, tr.priceCurrency)} to the seller via {tr.paymentMethod.replace('_', ' ')}, then mark as paid.
              </Alert>
              <div className="row">
                <Button onClick={() => act('paid')}>I have paid</Button>
                <Button variant="ghost" onClick={() => act('cancel')}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {tr.status === 'escrowed' && !isBuyer && <Alert kind="info">Your {money(tr.amount, tr.currency)} is held in escrow. Waiting for the buyer to pay.</Alert>}
          {tr.status === 'paid' && !isBuyer && (
            <div className="col">
              <Alert kind="warning">The buyer says they paid {money(tr.priceAmount, tr.priceCurrency)}. Confirm receipt to release escrow.</Alert>
              <div className="row">
                <Button variant="success" onClick={() => setPinAction('release')}>
                  Release escrow
                </Button>
                <Button variant="danger" onClick={() => setDispute('')}>
                  Dispute
                </Button>
              </div>
            </div>
          )}
          {tr.status === 'paid' && isBuyer && (
            <div className="col">
              <Alert kind="info">Waiting for the seller to confirm your payment.</Alert>
              <Button variant="danger" onClick={() => setDispute('')}>
                Open dispute
              </Button>
            </div>
          )}
          {tr.status === 'escrowed' && (
            <Button variant="ghost" className="mt-sm" onClick={() => setDispute('')}>
              Open dispute
            </Button>
          )}
          {tr.status === 'disputed' && <Alert kind="warning">Dispute open: {tr.disputeReason}. Support will review and resolve.</Alert>}
          {tr.status === 'completed' && <Alert kind="success">Trade completed.</Alert>}
        </div>
        <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
          <h4>Chat</h4>
          <div style={{ flex: 1, overflowY: 'auto', maxHeight: 360 }} className="col">
            {tr.messages?.length === 0 && <div className="muted small">Say hello 👋</div>}
            {tr.messages?.map((m: any) => (
              <div
                key={m.id}
                style={{
                  alignSelf: m.senderId === user?.id ? 'flex-end' : 'flex-start',
                  background: m.senderId === user?.id ? 'var(--primary)' : 'var(--bg-soft)',
                  color: m.senderId === user?.id ? '#fff' : 'inherit',
                  padding: '8px 12px',
                  borderRadius: 12,
                  maxWidth: '80%',
                }}
              >
                <div className="small">{m.body}</div>
                <div className="tiny" style={{ opacity: 0.7 }}>
                  {new Date(m.createdAt).toLocaleTimeString()}
                </div>
              </div>
            ))}
          </div>
          <form
            className="row mt"
            onSubmit={(e) => {
              e.preventDefault();
              if (!msg.trim()) return;
              api.post(`/api/p2p/trades/${tr.id}/messages`, { body: msg }).then(() => {
                setMsg('');
                trade.reload();
              });
            }}
          >
            <Input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Message…" />
            <Button>Send</Button>
          </form>
        </div>
      </div>
      <Modal open={!!counter} onClose={() => setCounter(null)} title="Counter-offer">
        {counter && (
          <>
            <Field label={`Amount (${tr.currency})`}>
              <Input value={counter.amount} onChange={(e) => setCounter({ ...counter, amount: e.target.value })} />
            </Field>
            <Field label={`Rate (${tr.priceCurrency} per ${tr.currency})`}>
              <Input value={counter.rate} onChange={(e) => setCounter({ ...counter, rate: e.target.value })} />
            </Field>
            <Button block onClick={() => act('counter', { amount: counter.amount, rate: Number(counter.rate) }).then(() => setCounter(null))}>
              Send counter-offer
            </Button>
          </>
        )}
      </Modal>
      <Modal open={dispute !== null} onClose={() => setDispute(null)} title="Open a dispute">
        <Field label="What went wrong?">
          <Textarea value={dispute ?? ''} onChange={(e) => setDispute(e.target.value)} />
        </Field>
        <Button block variant="danger" disabled={!dispute || dispute.length < 3} onClick={() => act('dispute', { reason: dispute }).then(() => setDispute(null))}>
          Submit dispute
        </Button>
      </Modal>
      <PinModal
        open={!!pinAction}
        onClose={() => setPinAction(null)}
        onSubmit={(pin) => act(pinAction!, { pin }).then(() => setPinAction(null))}
        title={pinAction === 'accept' ? 'Accept offer' : 'Release escrow'}
      />
    </div>
  );
}
