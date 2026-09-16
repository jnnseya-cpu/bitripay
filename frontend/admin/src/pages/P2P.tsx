import { useState } from 'react';
import { tr } from '../lib/i18n';
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
  const resolve = (outcome: 'release' | 'refund', note?: string) =>
    api
      .post(`/api/admin/p2p/trades/${sel.id}/resolve`, { outcome, note })
      .then(() => {
        toast(`Dispute resolved: ${outcome}`, 'success');
        setSel(null);
        trades.reload();
        stats.reload();
      })
      .catch((e) => toast(e.message, 'error'));
  return (
    <div>
      <PageHeader title={tr('P2P marketplace & disputes')} subtitle={tr('Monitor trades, resolve disputes by releasing escrow to the buyer or refunding the seller')} />
      <div className="grid cols-4 mb">
        <div className="card">
          <div className="stat">
            <span className="label">{tr('Active ads')}</span>
            <span className="value">{stats.data?.activeAds ?? 0}</span>
          </div>
        </div>
        <div className="card">
          <div className="stat">
            <span className="label">{tr('Disputed')}</span>
            <span className="value">{stats.data?.tradesByStatus?.disputed ?? 0}</span>
          </div>
        </div>
        <div className="card">
          <div className="stat">
            <span className="label">{tr('Completed')}</span>
            <span className="value">{stats.data?.tradesByStatus?.completed ?? 0}</span>
          </div>
        </div>
        <div className="card">
          <div className="stat">
            <span className="label">{tr('Volume')}</span>
            <span className="value" style={{ fontSize: '1rem' }}>
              {(stats.data?.volume ?? []).map((v: any) => money(v.v, v.currency)).join(' · ') || '—'}
            </span>
          </div>
        </div>
      </div>
      <Tabs
        tabs={[
          { id: 'trades', label: tr('Trades') },
          { id: 'ads', label: tr('Ads') },
        ]}
        value={tab}
        onChange={(v) => setTab(v as any)}
      />
      <div className="card">
        {tab === 'trades' && (
          <>
            <div className="row mb">
              <Select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 160 }}>
                <option value="disputed">{tr('Disputed')}</option>
                <option value="escrowed">{tr('Escrowed')}</option>
                <option value="paid">{tr('Paid')}</option>
                <option value="negotiating">{tr('Negotiating')}</option>
                <option value="completed">{tr('Completed')}</option>
                <option value="">{tr('All')}</option>
              </Select>
            </div>
            <Table
              head={[tr('Reference'), tr('Buyer'), tr('Seller'), tr('Amount'), tr('Price'), tr('Method'), tr('Updated'), tr('Status'), '']}
              rows={(trades.data?.items ?? []).map((t) => [
                <span className="mono small">{t.reference}</span>,
                <UserCell user={t.buyer} />,
                <UserCell user={t.seller} />,
                money(t.amount, t.currency),
                money(t.priceAmount, t.priceCurrency),
                t.paymentMethod,
                fmtDate(t.updatedAt),
                <StatusBadge status={t.status} />,
                <Button size="sm" variant="secondary" onClick={() => open(t.id)}>
                  {tr('Open')}
                </Button>,
              ])}
              empty={tr('No trades')}
            />
          </>
        )}
        {tab === 'ads' && (
          <Table
            head={[tr('Trader'), tr('Side'), tr('Currency'), tr('Rate'), tr('Available'), tr('Status'), '']}
            rows={(ads.data?.items ?? []).map((a) => [
              <UserCell user={a.user} />,
              a.side,
              `${a.currency} / ${a.priceCurrency}`,
              a.rate,
              money(a.availableAmount, a.currency),
              <StatusBadge status={a.status} />,
              a.status !== 'closed' && (
                <ConfirmButton size="sm" variant="ghost" onConfirm={() => api.post(`/api/admin/p2p/ads/${a.id}/status`, { status: 'closed' }).then(ads.reload)}>
                  {tr('Close ad')}
                </ConfirmButton>
              ),
            ])}
          />
        )}
      </div>
      <Modal open={!!sel} onClose={() => setSel(null)} title={sel?.reference} wide>
        {sel && (
          <div className="grid cols-2">
            <div>
              <KV k={tr('Status')} v={<StatusBadge status={sel.status} />} />
              <KV k={tr('Buyer')} v={<UserCell user={sel.buyer} />} />
              <KV k={tr('Seller')} v={<UserCell user={sel.seller} />} />
              <KV k={tr('Amount')} v={money(sel.amount, sel.currency)} />
              <KV k={tr('Price')} v={money(sel.priceAmount, sel.priceCurrency)} />
              <KV k={tr('Method')} v={sel.paymentMethod} />
              {sel.disputeReason && <KV k={tr('Dispute')} v={sel.disputeReason} />}
              {sel.status === 'disputed' && (
                <div className="row mt">
                  <ConfirmButton variant="success" prompt="Note" onConfirm={(n) => resolve('release', n)}>
                    {tr('Release to buyer')}
                  </ConfirmButton>
                  <ConfirmButton variant="danger" prompt="Note" onConfirm={(n) => resolve('refund', n)}>
                    {tr('Refund seller')}
                  </ConfirmButton>
                </div>
              )}
            </div>
            <div>
              <h4>{tr('Offers')}</h4>
              {sel.offers?.map((o: any) => (
                <div key={o.id} className="kv small">
                  <span>
                    {money(o.amount, sel.currency)} @ {o.rate}
                  </span>
                  <StatusBadge status={o.status} />
                </div>
              ))}
              <h4 className="mt">{tr('Chat')}</h4>
              <div className="col" style={{ maxHeight: 260, overflowY: 'auto' }}>
                {sel.messages?.map((m: any) => (
                  <div key={m.id} className="card soft compact small">
                    <b>{m.senderId === sel.buyerId ? tr('Buyer') : tr('Seller')}:</b> {m.body}
                    <div className="tiny muted">{fmtDate(m.createdAt)}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
