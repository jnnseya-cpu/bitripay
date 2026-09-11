import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Screen, Card, Button, Input, Alert, T, KV, PinSheet, Row, Status, Tabs, Empty, useAsync, Avatar, Select, Sheet, Chip } from '../components/ui';
import { Header } from '../components/Header';
import { useNav, type ScreenProps } from '../navigation';
import { fromMinor } from '@bitripay/shared';

export function P2P() {
  const { t, money, user, config, wallets, toast, currency } = useStore();
  const nav = useNav();
  const [tab, setTab] = useState<'market' | 'trades' | 'ads'>('market');
  const [side, setSide] = useState<'sell' | 'buy'>('sell');
  const ads = useAsync(() => api.get<{ items: any[] }>(`/api/p2p/ads?side=${side}`), [side, tab]);
  const trades = useAsync(() => api.get<{ items: any[] }>('/api/p2p/trades'), [tab]);
  const myAds = useAsync(() => api.get<{ items: any[] }>('/api/p2p/ads/mine'), [tab]);
  const [openAd, setOpenAd] = useState<any>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('wallet');
  const [create, setCreate] = useState(false);
  const [ad, setAd] = useState({ side: 'sell', currency: wallets[0]?.currency || 'USD', priceCurrency: 'EUR', rate: '', minAmount: '', maxAmount: '', availableAmount: '' });
  const openTrade = async () => {
    try {
      const r = await api.post<{ trade: any }>('/api/p2p/trades', { adId: openAd.id, amount, paymentMethod: method });
      setOpenAd(null);
      nav.navigate('Trade', { id: r.trade.id });
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const createAd = async () => {
    try {
      await api.post('/api/p2p/ads', { ...ad, rate: Number(ad.rate), paymentMethods: ['wallet', 'bank_transfer'] });
      setCreate(false);
      toast('Ad published', 'success');
      setTab('ads');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <Screen>
      <Header title={t('nav.p2p')} right={<Button title="+ Ad" small onPress={() => setCreate(true)} />} />
      <Tabs tabs={[{ id: 'market', label: 'Marketplace' }, { id: 'trades', label: 'My trades' }, { id: 'ads', label: 'My ads' }]} value={tab} onChange={(v) => setTab(v as any)} />
      {tab === 'market' && (
        <>
          <Tabs tabs={[{ id: 'sell', label: 'Buy from sellers' }, { id: 'buy', label: 'Sell to buyers' }]} value={side} onChange={(v) => setSide(v as any)} />
          {ads.data?.items.length === 0 && <Empty icon="🤝" text="No live offers" />}
          {ads.data?.items.map((a) => (
            <Card key={a.id}>
              <Row between><Row><Avatar user={a.user} size={34} /><View><T bold>{a.user?.fullName}</T><T muted size={11}>{a.user?.stats?.trades} trades · {a.user?.stats?.completionRate}%</T></View></Row>{a.userId !== user?.id && <Button title={a.side === 'sell' ? 'Buy' : 'Sell'} small onPress={() => { setOpenAd(a); setAmount(fromMinor(a.minAmount, currency(a.currency).decimals)); setMethod(a.paymentMethods[0]); }} />}</Row>
              <T><T bold>{a.currency}</T> for {a.priceCurrency} · 1 {a.currency} = {a.rate} {a.priceCurrency}</T>
              <T muted size={12}>Limits {money(a.minAmount, a.currency)} – {money(a.maxAmount, a.currency)} · available {money(a.availableAmount, a.currency)}</T>
              <Row style={{ flexWrap: 'wrap' }}>{a.paymentMethods.map((m: string) => <Chip key={m} label={m.replace('_', ' ')} />)}</Row>
            </Card>
          ))}
        </>
      )}
      {tab === 'trades' && (
        <>
          {trades.data?.items.length === 0 && <Empty icon="📑" />}
          {trades.data?.items.map((tr) => <Card key={tr.id}><Row between><View><T bold>{tr.buyerId === user?.id ? 'Buy' : 'Sell'} {money(tr.amount, tr.currency)} for {money(tr.priceAmount, tr.priceCurrency)}</T><T muted size={12}>{tr.reference}</T></View><Status status={tr.status} /></Row><Button title="Open" small variant="secondary" onPress={() => nav.navigate('Trade', { id: tr.id })} /></Card>)}
        </>
      )}
      {tab === 'ads' && (
        <>
          {myAds.data?.items.length === 0 && <Empty icon="📢" />}
          {myAds.data?.items.map((a) => <Card key={a.id}><Row between><View><T bold>{a.side.toUpperCase()} {a.currency} @ {a.rate} {a.priceCurrency}</T><T muted size={12}>available {money(a.availableAmount, a.currency)}</T></View><Status status={a.status} /></Row>{a.status !== 'closed' && <Button title={a.status === 'active' ? 'Pause' : 'Resume'} small variant="secondary" onPress={() => api.post(`/api/p2p/ads/${a.id}/status`, { status: a.status === 'active' ? 'paused' : 'active' }).then(myAds.reload)} />}</Card>)}
        </>
      )}
      <Sheet open={!!openAd} onClose={() => setOpenAd(null)} title={openAd ? `${openAd.side === 'sell' ? 'Buy' : 'Sell'} ${openAd.currency}` : ''}>
        {openAd && <><KV k="Rate" v={`1 ${openAd.currency} = ${openAd.rate} ${openAd.priceCurrency}`} /><Input label={`Amount (${openAd.currency})`} value={amount} onChangeText={(v) => setAmount(v.replace(/[^\d.]/g, ''))} keyboardType="decimal-pad" big /><Select label="Payment method" value={method} onChange={setMethod} options={openAd.paymentMethods.map((m: string) => ({ value: m, label: m.replace('_', ' ') }))} /><Button title="Open trade" onPress={openTrade} disabled={!amount} /></>}
      </Sheet>
      <Sheet open={create} onClose={() => setCreate(false)} title="Post a P2P ad">
        <Select label="I want to" value={ad.side} onChange={(v) => setAd({ ...ad, side: v })} options={[{ value: 'sell', label: 'Sell currency' }, { value: 'buy', label: 'Buy currency' }]} />
        <Row><View style={{ flex: 1 }}><Select label="Currency" value={ad.currency} onChange={(v) => setAd({ ...ad, currency: v })} options={(config?.currencies ?? []).map((c: any) => ({ value: c.code, label: c.code }))} /></View><View style={{ flex: 1 }}><Select label="Priced in" value={ad.priceCurrency} onChange={(v) => setAd({ ...ad, priceCurrency: v })} options={(config?.currencies ?? []).map((c: any) => ({ value: c.code, label: c.code }))} /></View></Row>
        <Input label="Rate" value={ad.rate} onChangeText={(v) => setAd({ ...ad, rate: v })} keyboardType="decimal-pad" />
        <Row><View style={{ flex: 1 }}><Input label="Min" value={ad.minAmount} onChangeText={(v) => setAd({ ...ad, minAmount: v })} keyboardType="decimal-pad" /></View><View style={{ flex: 1 }}><Input label="Max" value={ad.maxAmount} onChangeText={(v) => setAd({ ...ad, maxAmount: v })} keyboardType="decimal-pad" /></View><View style={{ flex: 1 }}><Input label="Available" value={ad.availableAmount} onChangeText={(v) => setAd({ ...ad, availableAmount: v })} keyboardType="decimal-pad" /></View></Row>
        <Button title="Publish" onPress={createAd} disabled={!ad.rate || !ad.minAmount || !ad.maxAmount || !ad.availableAmount} />
      </Sheet>
    </Screen>
  );
}

export function Trade({ route }: ScreenProps<'Trade'>) {
  const { id } = route.params;
  const { user, money, toast, refreshWallets } = useStore();
  const trade = useAsync(() => api.get<{ trade: any }>(`/api/p2p/trades/${id}`), [id]);
  const [msg, setMsg] = useState('');
  const [pinAction, setPinAction] = useState<null | 'accept' | 'release'>(null);
  const [counter, setCounter] = useState<{ amount: string; rate: string } | null>(null);
  const [dispute, setDispute] = useState<string | null>(null);
  useEffect(() => { const t = setInterval(() => trade.reload(), 5000); return () => clearInterval(t); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const tr = trade.data?.trade;
  if (!tr) return <Screen><Header title="Trade" /></Screen>;
  const isBuyer = tr.buyerId === user?.id;
  const other = isBuyer ? tr.seller : tr.buyer;
  const pending = tr.offers?.filter((o: any) => o.status === 'pending').slice(-1)[0];
  const act = async (path: string, body: any = {}) => {
    try {
      await api.post(`/api/p2p/trades/${tr.id}/${path}`, body);
      trade.reload();
      refreshWallets();
      toast('Updated', 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <Screen>
      <Header title={tr.reference} />
      <Card>
        <Row between><Status status={tr.status} /><T muted size={12}>Rate {tr.rate}</T></Row>
        <T bold size={18}>{isBuyer ? 'Buying' : 'Selling'} {money(tr.amount, tr.currency)} for {money(tr.priceAmount, tr.priceCurrency)}</T>
        <Row><Avatar user={other} size={34} /><T>{other?.fullName} (@{other?.tag})</T></Row>
        {tr.offers?.map((o: any) => <KV key={o.id} k={`${o.fromUserId === user?.id ? 'You' : other?.fullName}: ${money(o.amount, tr.currency)} @ ${o.rate}`} v={<Status status={o.status} />} />)}
        {tr.status === 'negotiating' && <Row style={{ flexWrap: 'wrap' }}>{pending && pending.fromUserId !== user?.id && <Button title="Accept" small onPress={() => setPinAction('accept')} />}<Button title="Counter" small variant="secondary" onPress={() => setCounter({ amount: fromMinor(tr.amount, 2), rate: String(tr.rate) })} /><Button title="Cancel" small variant="ghost" onPress={() => act('cancel')} /></Row>}
        {tr.status === 'escrowed' && isBuyer && <><Alert text={`Pay ${money(tr.priceAmount, tr.priceCurrency)} to the seller via ${tr.paymentMethod.replace('_', ' ')}, then mark as paid.`} /><Button title="I have paid" onPress={() => act('paid')} /></>}
        {tr.status === 'escrowed' && !isBuyer && <Alert text="Your funds are in escrow. Waiting for the buyer to pay." />}
        {tr.status === 'paid' && !isBuyer && <><Alert kind="warning" text="Buyer says they paid. Confirm to release escrow." /><Row><Button title="Release escrow" variant="success" onPress={() => setPinAction('release')} /><Button title="Dispute" variant="danger" onPress={() => setDispute('')} /></Row></>}
        {tr.status === 'paid' && isBuyer && <><Alert text="Waiting for the seller to confirm." /><Button title="Open dispute" variant="danger" onPress={() => setDispute('')} /></>}
        {tr.status === 'disputed' && <Alert kind="warning" text={`Dispute open: ${tr.disputeReason}`} />}
        {tr.status === 'completed' && <Alert kind="success" text="Trade completed." />}
      </Card>
      <Card>
        <T bold>Chat</T>
        {tr.messages?.map((m: any) => <View key={m.id} style={{ alignSelf: m.senderId === user?.id ? 'flex-end' : 'flex-start', backgroundColor: m.senderId === user?.id ? '#2563eb' : '#e2e8f0', padding: 8, borderRadius: 10, maxWidth: '85%' }}><T color={m.senderId === user?.id ? '#fff' : '#0f172a'} size={14}>{m.body}</T></View>)}
        <Row><View style={{ flex: 1 }}><Input value={msg} onChangeText={setMsg} placeholder="Message…" /></View><Button title="Send" small onPress={() => msg.trim() && api.post(`/api/p2p/trades/${tr.id}/messages`, { body: msg }).then(() => { setMsg(''); trade.reload(); })} /></Row>
      </Card>
      <Sheet open={!!counter} onClose={() => setCounter(null)} title="Counter-offer">{counter && <><Input label={`Amount (${tr.currency})`} value={counter.amount} onChangeText={(v) => setCounter({ ...counter, amount: v })} keyboardType="decimal-pad" /><Input label="Rate" value={counter.rate} onChangeText={(v) => setCounter({ ...counter, rate: v })} keyboardType="decimal-pad" /><Button title="Send counter-offer" onPress={() => act('counter', { amount: counter.amount, rate: Number(counter.rate) }).then(() => setCounter(null))} /></>}</Sheet>
      <Sheet open={dispute !== null} onClose={() => setDispute(null)} title="Open a dispute"><Input label="What went wrong?" value={dispute ?? ''} onChangeText={setDispute} multiline /><Button title="Submit dispute" variant="danger" disabled={!dispute || dispute.length < 3} onPress={() => act('dispute', { reason: dispute }).then(() => setDispute(null))} /></Sheet>
      <PinSheet open={!!pinAction} onClose={() => setPinAction(null)} onSubmit={(pin) => act(pinAction!, { pin }).then(() => setPinAction(null))} title={pinAction === 'accept' ? 'Accept offer' : 'Release escrow'} />
    </Screen>
  );
}
