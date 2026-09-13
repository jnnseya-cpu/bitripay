import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Screen, Card, Button, Input, Alert, T, KV, PinSheet, AmountInput, Row, Status, Tabs, Empty, useAsync, Select, Sheet, Chip, useTheme } from '../components/ui';
import { Header } from '../components/Header';
import { useNav } from '../navigation';
import { fromMinor, type VirtualCard } from '@bitripay/shared';

export function Remittance() {
  const { t, money, wallets, config, toast, refreshWallets } = useStore();
  const nav = useNav();
  const [tab, setTab] = useState<'send' | 'history'>('send');
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState(wallets[0]?.currency || 'USD');
  const [to, setTo] = useState('NGN');
  const [method, setMethod] = useState<'wallet' | 'bank' | 'cash_pickup'>('wallet');
  const [rec, setRec] = useState({ name: '', country: '', phone: '', tag: '', bankName: '', accountNumber: '', idNumber: '' });
  const [quote, setQuote] = useState<any>(null);
  const [pin, setPin] = useState(false);
  const [loading, setLoading] = useState(false);
  const history = useAsync(() => api.get<{ items: any[] }>('/api/remittances'), [tab]);
  const recipients = useAsync(() => api.get<{ items: any[] }>('/api/recipients'), []);
  useEffect(() => {
    if (!amount) return setQuote(null);
    const id = setTimeout(() => api.get(`/api/remittances/quote?from=${from}&to=${to}&amount=${amount}`).then(setQuote).catch(() => setQuote(null)), 300);
    return () => clearTimeout(id);
  }, [amount, from, to]);
  const submit = async (p: string) => {
    setLoading(true);
    try {
      const r = await api.post<any>('/api/remittances', { amount, sourceCurrency: from, targetCurrency: to, payoutMethod: method, recipient: Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, v || null])), saveRecipient: true, pin: p });
      toast(r.remittance.pickupCode ? `Pickup code: ${r.remittance.pickupCode}` : 'Remittance sent', 'success');
      refreshWallets();
      setPin(false);
      nav.replace('TxDetail', { id: r.transaction.id });
    } catch (err) {
      toast((err as Error).message, 'error');
      setPin(false);
    } finally {
      setLoading(false);
    }
  };
  return (
    <Screen>
      <Header title={t('nav.remittance')} />
      <Tabs tabs={[{ id: 'send', label: 'Send abroad' }, { id: 'history', label: 'History' }]} value={tab} onChange={(v) => setTab(v as any)} />
      {tab === 'send' ? (
        <>
          <Card>
            <AmountInput label="You send" amount={amount} currency={from} onAmount={setAmount} onCurrency={setFrom} />
            <Select label="Recipient receives in" value={to} onChange={setTo} options={(config?.currencies ?? []).map((c: any) => ({ value: c.code, label: `${c.code} – ${c.name}` }))} />
            {quote && <Card soft><KV k="Rate" v={`1 ${from} = ${quote.rate.toFixed(4)} ${to}`} /><KV k={t('common.fee')} v={money(quote.fee, from)} /><KV k="Recipient gets" v={money(quote.targetAmount, to)} /></Card>}
            <Tabs tabs={[{ id: 'wallet', label: 'BitriPay wallet' }, { id: 'bank', label: 'Bank transfer' }, { id: 'cash_pickup', label: 'Cash pickup' }]} value={method} onChange={(m) => setMethod(m as any)} />
          </Card>
          <Card>
            <T bold>Recipient</T>
            {recipients.data && recipients.data.items.length > 0 && <Row style={{ flexWrap: 'wrap' }}>{recipients.data.items.map((r) => <Chip key={r.id} label={r.name} onPress={() => { setRec({ name: r.name, country: r.country || '', phone: r.phone || '', tag: r.tag || '', bankName: r.bankName || '', accountNumber: r.accountNumber || '', idNumber: '' }); setMethod(r.payoutMethod); if (r.currency) setTo(r.currency); }} />)}</Row>}
            <Input label="Full name" value={rec.name} onChangeText={(v) => setRec({ ...rec, name: v })} />
            <Select label="Country" value={rec.country} onChange={(v) => setRec({ ...rec, country: v })} options={[{ value: '', label: '—' }, ...(config?.countries ?? []).map((c: any) => ({ value: c.code, label: c.name }))]} />
            {method === 'wallet' && <Input label="BitriPay @tag, email or phone" value={rec.tag} onChangeText={(v) => setRec({ ...rec, tag: v })} autoCapitalize="none" />}
            {method === 'bank' && <><Input label="Bank name" value={rec.bankName} onChangeText={(v) => setRec({ ...rec, bankName: v })} /><Input label="Account number / IBAN" value={rec.accountNumber} onChangeText={(v) => setRec({ ...rec, accountNumber: v })} /></>}
            {method === 'cash_pickup' && <Input label="Recipient ID number" value={rec.idNumber} onChangeText={(v) => setRec({ ...rec, idNumber: v })} hint="The agent checks this ID before paying out" />}
            <Input label="Phone" value={rec.phone} onChangeText={(v) => setRec({ ...rec, phone: v })} keyboardType="phone-pad" />
            <Button title={`Send ${quote ? money(quote.targetAmount, to) : ''}`} onPress={() => setPin(true)} disabled={!quote || !rec.name} />
          </Card>
        </>
      ) : (
        <>
          {history.data?.items.length === 0 && <Empty icon="🌍" />}
          {history.data?.items.map((r) => <Card key={r.id}><Row between><View><T bold>{r.recipient?.name} · {money(r.targetAmount, r.targetCurrency)}</T><T muted size={12}>{money(r.sourceAmount, r.sourceCurrency)} · {r.payoutMethod.replace('_', ' ')}{r.pickupCode ? ` · ${r.pickupCode}` : ''}</T></View><Status status={r.status} /></Row></Card>)}
        </>
      )}
      <PinSheet open={pin} onClose={() => setPin(false)} onSubmit={submit} loading={loading} summary={quote && <><KV k="Debit" v={money(quote.total, from)} /><KV k={`${rec.name} receives`} v={money(quote.targetAmount, to)} /></>} />
    </Screen>
  );
}

export function Cards() {
  const { t, money, config, wallets, toast, refreshWallets } = useStore();
  const th = useTheme();
  const cards = useAsync(() => api.get<{ items: VirtualCard[] }>('/api/virtual-cards'), []);
  const [action, setAction] = useState<null | { type: 'issue' | 'fund' | 'withdraw' | 'reveal'; card?: VirtualCard }>(null);
  const [cur, setCur] = useState(wallets[0]?.currency || 'USD');
  const [amount, setAmount] = useState('');
  const [revealed, setRevealed] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const run = async (p: string) => {
    if (!action) return;
    setLoading(true);
    try {
      if (action.type === 'issue') await api.post('/api/virtual-cards', { currency: cur, pin: p });
      if (action.type === 'fund') await api.post(`/api/virtual-cards/${action.card!.id}/fund`, { amount, pin: p });
      if (action.type === 'withdraw') await api.post(`/api/virtual-cards/${action.card!.id}/withdraw`, { amount, pin: p });
      if (action.type === 'reveal') setRevealed((await api.post<{ card: any }>(`/api/virtual-cards/${action.card!.id}/reveal`, { pin: p })).card);
      else toast('Done', 'success');
      setAction(null);
      setAmount('');
      cards.reload();
      refreshWallets();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };
  return (
    <Screen>
      <Header title={t('nav.cards')} right={<Button title="+ New" small onPress={() => setAction({ type: 'issue' })} />} />
      {cards.data?.items.length === 0 && <Empty icon="💳" text="No virtual cards yet" />}
      {cards.data?.items.map((c) => (
        <View key={c.id} style={{ gap: 8 }}>
          <View style={{ backgroundColor: '#1e3a8a', borderRadius: 18, padding: 20, gap: 18, opacity: c.status === 'frozen' ? 0.6 : 1 }}>
            <Row between><Text style={{ color: '#fff', fontWeight: '700' }}>BitriPay Virtual</Text><Text style={{ color: '#fff', fontSize: 12 }}>{c.status}</Text></Row>
            <Text style={{ color: '#fff', fontSize: 20, letterSpacing: 3, fontFamily: 'monospace' }}>{c.maskedNumber}</Text>
            <Row between><View><Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 10 }}>HOLDER</Text><Text style={{ color: '#fff', fontWeight: '600' }}>{c.holderName}</Text></View><View><Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 10 }}>EXP</Text><Text style={{ color: '#fff', fontWeight: '600' }}>{String(c.expMonth).padStart(2, '0')}/{String(c.expYear).slice(-2)}</Text></View><View><Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 10 }}>BALANCE</Text><Text style={{ color: '#fff', fontWeight: '600' }}>{money(c.balance, c.currency)}</Text></View></Row>
          </View>
          <Row style={{ flexWrap: 'wrap' }}>
            <Button title="Fund" small onPress={() => setAction({ type: 'fund', card: c })} disabled={c.status !== 'active'} />
            <Button title="Withdraw" small variant="secondary" onPress={() => setAction({ type: 'withdraw', card: c })} />
            <Button title="Details" small variant="secondary" onPress={() => setAction({ type: 'reveal', card: c })} />
            <Button title={c.status === 'active' ? 'Freeze' : 'Unfreeze'} small variant="ghost" onPress={() => api.post(`/api/virtual-cards/${c.id}/${c.status === 'active' ? 'freeze' : 'unfreeze'}`).then(cards.reload)} />
          </Row>
        </View>
      ))}
      <Sheet open={!!action && action.type !== 'reveal'} onClose={() => setAction(null)} title={action?.type === 'issue' ? 'New virtual card' : action?.type === 'fund' ? 'Fund card' : 'Withdraw from card'}>
        {action?.type === 'issue' ? <Select label={t('common.currency')} value={cur} onChange={setCur} options={(config?.currencies ?? []).map((c: any) => ({ value: c.code, label: c.code }))} /> : <Input label={`${t('common.amount')} (${action?.card?.currency})`} value={amount} onChangeText={(v) => setAmount(v.replace(/[^\d.]/g, ''))} keyboardType="decimal-pad" big />}
        <PinInline onSubmit={run} loading={loading} />
      </Sheet>
      <PinSheet open={action?.type === 'reveal'} onClose={() => setAction(null)} onSubmit={run} loading={loading} title="Reveal card details" />
      <Sheet open={!!revealed} onClose={() => setRevealed(null)} title="Card details">
        {revealed && <><KV k="Number" v={<T mono bold>{revealed.number.replace(/(.{4})/g, '$1 ').trim()}</T>} /><KV k="Expiry" v={`${String(revealed.expMonth).padStart(2, '0')}/${revealed.expYear}`} /><KV k="CVV" v={<T mono bold>{revealed.cvv}</T>} /><KV k="Name" v={revealed.holderName} /></>}
      </Sheet>
      <View style={{ height: 0, borderColor: th.border }} />
    </Screen>
  );
}

function PinInline({ onSubmit, loading }: { onSubmit: (pin: string) => void; loading: boolean }) {
  const { t } = useStore();
  const [pin, setPin] = useState('');
  return <><Input label={t('common.pin')} value={pin} onChangeText={(v) => setPin(v.replace(/\D/g, ''))} secureTextEntry keyboardType="number-pad" maxLength={6} /><Button title={t('common.confirm')} loading={loading} disabled={pin.length < 4} onPress={() => onSubmit(pin)} /></>;
}

function Tile({ label, sub, color, selected, onPress }: { label: string; sub: string; color: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ width: '47%', flexGrow: 1, backgroundColor: color, borderRadius: 14, padding: 14, minHeight: 80, justifyContent: 'flex-end', borderWidth: selected ? 3 : 0, borderColor: '#fff' }}>
      <Text style={{ color: '#fff', fontWeight: '700' }}>{label}</Text>
      <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 11 }}>{sub}</Text>
    </Pressable>
  );
}

export function Bills() {
  const { t, money, toast, refreshWallets, user } = useStore();
  const billers = useAsync(() => api.get<{ items: any[] }>(`/api/bills/billers${user?.country ? `?country=${user.country}` : ''}`), []);
  const [sel, setSel] = useState<any>(null);
  const [account, setAccount] = useState('');
  const [amount, setAmount] = useState('');
  const [pin, setPin] = useState(false);
  const [loading, setLoading] = useState(false);
  const pay = async (p: string) => {
    setLoading(true);
    try {
      const r = await api.post<{ receiptNo: string }>('/api/bills', { billerId: sel.id, accountNumber: account, amount, pin: p });
      toast(`Bill paid · ${r.receiptNo}`, 'success');
      setPin(false);
      setSel(null);
      refreshWallets();
    } catch (err) {
      toast((err as Error).message, 'error');
      setPin(false);
    } finally {
      setLoading(false);
    }
  };
  return (
    <Screen>
      <Header title={t('nav.bills')} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{billers.data?.items.map((b) => <Tile key={b.id} label={b.name} sub={`${b.category} · ${b.currency}`} color={b.color} selected={sel?.id === b.id} onPress={() => setSel(b)} />)}</View>
      {billers.data?.items.length === 0 && <Empty icon="🧾" text="No billers available" />}
      {sel && <Card><T bold size={18}>{sel.name}</T><Input label={sel.accountLabel} value={account} onChangeText={setAccount} /><Input label={`${t('common.amount')} (${sel.currency})`} value={amount} onChangeText={(v) => setAmount(v.replace(/[^\d.]/g, ''))} keyboardType="decimal-pad" big /><Button title="Pay bill" onPress={() => setPin(true)} disabled={!account || !amount} /></Card>}
      <PinSheet open={pin} onClose={() => setPin(false)} onSubmit={pay} loading={loading} summary={sel && <KV k={`${sel.name} · ${account}`} v={`${amount} ${sel.currency}`} />} />
    </Screen>
  );
}

export function Topup() {
  const { t, money, toast, refreshWallets, user } = useStore();
  const ops = useAsync(() => api.get<{ items: any[] }>(`/api/topups/operators${user?.country ? `?country=${user.country}` : ''}`), []);
  const [sel, setSel] = useState<any>(null);
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [amount, setAmount] = useState('');
  const [pin, setPin] = useState(false);
  const [loading, setLoading] = useState(false);
  const submit = async (p: string) => {
    setLoading(true);
    try {
      await api.post('/api/topups', { operatorId: sel.id, phone, amount, pin: p });
      toast('Top-up sent', 'success');
      setPin(false);
      refreshWallets();
    } catch (err) {
      toast((err as Error).message, 'error');
      setPin(false);
    } finally {
      setLoading(false);
    }
  };
  return (
    <Screen>
      <Header title={t('nav.topup')} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{ops.data?.items.map((o) => <Tile key={o.id} label={o.name} sub={`${o.country} · ${o.currency}`} color={o.color} selected={sel?.id === o.id} onPress={() => setSel(o)} />)}</View>
      {sel && (
        <Card>
          <T bold size={18}>{sel.name}</T>
          <Input label="Phone number" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
          <Row style={{ flexWrap: 'wrap' }}>{sel.denominations.map((d: number) => <Chip key={d} label={money(d, sel.currency)} selected={amount === fromMinor(d, 2)} onPress={() => setAmount(fromMinor(d, 2))} />)}</Row>
          <Input label={`${t('common.amount')} (${sel.currency})`} value={amount} onChangeText={(v) => setAmount(v.replace(/[^\d.]/g, ''))} keyboardType="decimal-pad" big />
          <Button title="Top up" onPress={() => setPin(true)} disabled={!phone || !amount} />
        </Card>
      )}
      <PinSheet open={pin} onClose={() => setPin(false)} onSubmit={submit} loading={loading} summary={sel && <KV k={`${sel.name} · ${phone}`} v={`${amount} ${sel.currency}`} />} />
    </Screen>
  );
}

export function GiftCards() {
  const { t, money, toast, refreshWallets } = useStore();
  const products = useAsync(() => api.get<{ items: any[] }>('/api/gift-cards/products'), []);
  const mine = useAsync(() => api.get<{ items: any[] }>('/api/gift-cards'), []);
  const [sel, setSel] = useState<any>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [pin, setPin] = useState(false);
  const [loading, setLoading] = useState(false);
  const buy = async (p: string) => {
    setLoading(true);
    try {
      const r = await api.post<any>('/api/gift-cards', { productId: sel.id, amount: fromMinor(amount!, 2), pin: p });
      toast(`Gift card code: ${r.code}`, 'success');
      setPin(false);
      setSel(null);
      mine.reload();
      refreshWallets();
    } catch (err) {
      toast((err as Error).message, 'error');
      setPin(false);
    } finally {
      setLoading(false);
    }
  };
  return (
    <Screen>
      <Header title={t('nav.giftCards')} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{products.data?.items.map((p) => <Tile key={p.id} label={p.brand} sub={`${p.name} · ${p.currency}`} color={p.color} selected={sel?.id === p.id} onPress={() => { setSel(p); setAmount(p.denominations[0] ?? null); }} />)}</View>
      {sel && <Card><T bold size={18}>{sel.brand}</T><T muted size={13}>{sel.description}</T><Row style={{ flexWrap: 'wrap' }}>{sel.denominations.map((d: number) => <Chip key={d} label={money(d, sel.currency)} selected={amount === d} onPress={() => setAmount(d)} />)}</Row><Button title={`Buy ${amount ? money(amount, sel.currency) : ''}`} onPress={() => setPin(true)} disabled={!amount} /></Card>}
      {(mine.data?.items ?? []).length > 0 && <Card><T bold>My gift cards</T>{mine.data!.items.map((g) => <KV key={g.id} k={`${g.brand} · ${money(g.amount, g.currency)}`} v={<T mono size={12}>{g.code} · PIN {g.pin}</T>} />)}</Card>}
      <PinSheet open={pin} onClose={() => setPin(false)} onSubmit={buy} loading={loading} summary={sel && amount && <KV k={`${sel.brand} gift card`} v={money(amount, sel.currency)} />} />
    </Screen>
  );
}
