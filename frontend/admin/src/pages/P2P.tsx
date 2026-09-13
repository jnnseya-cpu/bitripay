import { useState } from 'react';
import { api, qs } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, ConfirmButton, KV, Modal, PageHeader, Select, StatusBadge, Table, Tabs, UserCell, fmtDate, useAsync } from '../components/ui';

export function P2P() {
  const { money, toast } = useStore();
  const [tab, setTab] = useState<'trades' | 'ads'>('trades');
  const [status, setStatus] = useState('disputed');
  const stats = useAsync(() => api.get<any>('/api/admin/p2p/stats'), []);
  const trades = useAsync(() => api.get<{ items: any[] }>(`/api/admin/p2p/trades${qs({ status })}`), [status, tab]);
  const ads = useAsync(() => api.get<{ items: any[] }>('/api/admin/p2p/ads'), [tab]);
  const [sel, setSel] = useState<any>(null);
  const open = async (id: string) => setSel((await api.get<any>(`/api/admin/p2p/trades/${id}`)).trade);
  const resolve = (outcome: 'release' | 'refund', note?: string) => api.post(`/api/admin/p2p/trades/${sel.id}/resolve`, { outcome, note }).then(() => { toast(`Dispute resolved: ${outcome}`, 'success'); setSel(null); trades.reload(); stats.reload(); }).catch((e) => toast(e.message, 'error'));
  return (
    <div>
      <PageHeader title="P2P marketplace & disputes" subtitle="Monitor trades, resolve disputes by releasing escrow to the buyer or refunding the seller" />
      <div className="grid cols-4 mb">
        <div className="card"><div className="stat"><span className="label">Active ads</span><span className="value">{stats.data?.activeAds ?? 0}</span></div></div>
        <div className="card"><div className="stat"><span className="label">Disputed</span><span className="value">{stats.data?.tradesByStatus?.disputed ?? 0}</span></div></div>
        <div className="card"><div className="stat"><span className="label">Completed</span><span className="value">{stats.data?.tradesByStatus?.completed ?? 0}</span></div></div>
        <div className="card"><div className="stat"><span className="label">Volume</span><span className="value" style={{ fontSize: '1rem' }}>{(stats.data?.volume ?? []).map((v: any) => money(v.v, v.currency)).join(' · ') || '—'}</span></div></div>
      </div>
      <Tabs tabs={[{ id: 'trades', label: 'Trades' }, { id: 'ads', label: 'Ads' }]} value={tab} onChange={(v) => setTab(v as any)} />
      <div className="card">
        {tab === 'trades' && (
          <>
            <div className="row mb"><Select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 160 }}><option value="disputed">Disputed</option><option value="escrowed">Escrowed</option><option value="paid">Paid</option><option value="negotiating">Negotiating</option><option value="completed">Completed</option><option value="">All</option></Select></div>
            <Table head={['Reference', 'Buyer', 'Seller', 'Amount', 'Price', 'Method', 'Updated', 'Status', '']} rows={(trades.data?.items ?? []).map((t) => [<span className="mono small">{t.reference}</span>, <UserCell user={t.buyer} />, <UserCell user={t.seller} />, money(t.amount, t.currency), money(t.priceAmount, t.priceCurrency), t.paymentMethod, fmtDate(t.updatedAt), <StatusBadge status={t.status} />, <Button size="sm" variant="secondary" onClick={() => open(t.id)}>Open</Button>])} empty="No trades" />
          </>
        )}
        {tab === 'ads' && <Table head={['Trader', 'Side', 'Currency', 'Rate', 'Available', 'Status', '']} rows={(ads.data?.items ?? []).map((a) => [<UserCell user={a.user} />, a.side, `${a.currency} / ${a.priceCurrency}`, a.rate, money(a.availableAmount, a.currency), <StatusBadge status={a.status} />, a.status !== 'closed' && <ConfirmButton size="sm" variant="ghost" onConfirm={() => api.post(`/api/admin/p2p/ads/${a.id}/status`, { status: 'closed' }).then(ads.reload)}>Close ad</ConfirmButton>])} />}
      </div>
      <Modal open={!!sel} onClose={() => setSel(null)} title={sel?.reference} wide>
        {sel && (
          <div className="grid cols-2">
            <div>
              <KV k="Status" v={<StatusBadge status={sel.status} />} /><KV k="Buyer" v={<UserCell user={sel.buyer} />} /><KV k="Seller" v={<UserCell user={sel.seller} />} /><KV k="Amount" v={money(sel.amount, sel.currency)} /><KV k="Price" v={money(sel.priceAmount, sel.priceCurrency)} /><KV k="Method" v={sel.paymentMethod} />
              {sel.disputeReason && <KV k="Dispute" v={sel.disputeReason} />}
              {sel.status === 'disputed' && <div className="row mt"><ConfirmButton variant="success" prompt="Note" onConfirm={(n) => resolve('release', n)}>Release to buyer</ConfirmButton><ConfirmButton variant="danger" prompt="Note" onConfirm={(n) => resolve('refund', n)}>Refund seller</ConfirmButton></div>}
            </div>
            <div>
              <h4>Offers</h4>{sel.offers?.map((o: any) => <div key={o.id} className="kv small"><span>{money(o.amount, sel.currency)} @ {o.rate}</span><StatusBadge status={o.status} /></div>)}
              <h4 className="mt">Chat</h4><div className="col" style={{ maxHeight: 260, overflowY: 'auto' }}>{sel.messages?.map((m: any) => <div key={m.id} className="card soft compact small"><b>{m.senderId === sel.buyerId ? 'Buyer' : 'Seller'}:</b> {m.body}<div className="tiny muted">{fmtDate(m.createdAt)}</div></div>)}</div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
