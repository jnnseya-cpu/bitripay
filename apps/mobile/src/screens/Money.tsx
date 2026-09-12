import React, { useEffect, useState } from 'react';
import { Linking, View } from 'react-native';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Screen, Card, Button, Input, Alert, T, KV, PinSheet, AmountInput, Row, Status, Tabs, Empty, useAsync, Avatar, Select, Sheet, Chip } from '../components/ui';
import { Header } from '../components/Header';
import { useNav, type ScreenProps } from '../navigation';
import type { BankAccount, PublicUser, Transaction } from '@bitripay/shared';

interface PaymentView { id: string; status: string; stage?: string; stageLabel?: string; stageGroup?: string; stageDescription?: string; authMethod?: string | null; expiresAt?: string | null; method: string; amount: number; currency: string; fee: number; failureReason: string | null; next: any; gatewayName: string; createdAt: string }
const OPEN = (p: PaymentView) => !['succeeded', 'failed', 'cancelled'].includes(p.status);
const STEPS: [string, string[]][] = [['Initiated', ['CREATED', 'AUTHENTICATION_REQUIRED', 'INSTRUCTION_ISSUED']], ['Sent', ['PAYMENT_SENT']], ['Verifying', ['EVIDENCE_RECEIVED', 'VERIFYING', 'MANUAL_REVIEW', 'MISMATCHED', 'DUPLICATE', 'DISPUTED']], ['Confirmed', ['CONFIRMED']], ['Settled', ['SETTLED']]];

/** Initiated → sent → verifying → confirmed → settled, so nobody mistakes an instruction for money. */
export const ROUTE_STEPS: [string, string[]][] = [['Initiated', ['CREATED', 'QUOTED', 'BIOMETRIC_APPROVAL_REQUIRED', 'FUNDING_PENDING']], ['Funds confirmed', ['FUNDS_CONFIRMED', 'MANUAL_REVIEW', 'LIQUIDITY_UNAVAILABLE']], ['Paying out', ['PAYOUT_QUEUED', 'PAYOUT_IN_PROGRESS', 'EVIDENCE_RECEIVED', 'VERIFYING', 'MISMATCHED', 'DUPLICATE']], ['Settled', ['SETTLED']]];
export function StageBar({ stage, label, description, steps = STEPS }: { stage?: string; label?: string; description?: string; steps?: [string, string[]][] }) {
  if (!stage) return null;
  const bad = ['EXPIRED', 'REJECTED', 'REVERSED', 'FAILED', 'REFUNDED', 'DISPUTED'].includes(stage);
  const warn = ['MANUAL_REVIEW', 'MISMATCHED', 'DUPLICATE', 'LIQUIDITY_UNAVAILABLE'].includes(stage);
  const idx = steps.findIndex(([, s]) => s.includes(stage));
  return (
    <View style={{ alignSelf: 'stretch', gap: 6 }}>
      <Row style={{ gap: 3 }}>{steps.map(([name], i) => <View key={name} style={{ flex: 1, alignItems: 'center' }}><View style={{ height: 6, borderRadius: 3, alignSelf: 'stretch', backgroundColor: bad ? (i === 0 ? '#dc2626' : '#e5e7eb') : i < idx ? '#16a34a' : i === idx ? (warn ? '#f59e0b' : '#16a34a') : '#e5e7eb' }} /><T size={10} muted={i > idx}>{name}</T></View>)}</Row>
      <T size={13}><T bold>{label ?? stage}</T>{description ? ` – ${description}` : ''}</T>
    </View>
  );
}

export function AddMoney() {
  const { t, money, config, wallets, toast, refreshWallets, user } = useStore();
  const [cur, setCur] = useState(wallets[0]?.currency || config?.baseCurrency || 'USD');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'card' | 'mobile_money' | 'bank'>('card');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [opCountry, setOpCountry] = useState(user?.country ?? '');
  const [operatorId, setOperatorId] = useState('');
  const [proof, setProof] = useState('');
  const card0 = { number: '', expMonth: '', expYear: '', cvc: '', holderName: user?.fullName ?? '' };
  const [card, setCard] = useState(card0);
  const [savedCardId, setSavedCardId] = useState('');
  const [payment, setPayment] = useState<PaymentView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pin, setPin] = useState(false);
  const [declaration, setDeclaration] = useState<any>(null);
  const options = useAsync(() => api.get<{ methods: any[] }>(`/api/deposits/options?currency=${cur}`), [cur]);
  const cards = useAsync(() => api.get<{ items: any[] }>('/api/cards'), [payment?.status]);
  const opt = options.data?.methods.find((m) => m.method === method);
  const gw = opt?.gateways[0];
  useEffect(() => {
    if (options.data && !opt) setMethod(options.data.methods[0]?.method ?? 'card');
  }, [options.data, opt]);
  useEffect(() => {
    if (!payment || !OPEN(payment) || payment.stage === 'AUTHENTICATION_REQUIRED') return;
    const id = setInterval(async () => {
      const r = await api.get<{ payment: PaymentView }>(`/api/deposits/${payment.id}`);
      if (r.payment.stage !== payment.stage) setPayment(r.payment);
      if (r.payment.status === 'succeeded' && payment.status !== 'succeeded') { toast('Money added', 'success'); refreshWallets(); }
    }, payment.next?.type === 'bank_instructions' ? 10000 : 3000);
    return () => clearInterval(id);
  }, [payment]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Device biometrics (PinSheet) or PIN authorise the intent before any instruction is issued. */
  const submit = async (p?: string) => {
    setLoading(true);
    setError(null);
    try {
      const body: any = { method, amount, currency: cur, gateway: method === 'mobile_money' ? undefined : gw?.id, saveCard: true, pin: p || undefined };
      if (method === 'card') {
        if (savedCardId) body.savedCardId = savedCardId;
        else if (gw?.provider !== 'stripe') body.card = { number: card.number.replace(/\s/g, ''), expMonth: Number(card.expMonth), expYear: Number(card.expYear.length === 2 ? '20' + card.expYear : card.expYear), cvc: card.cvc, holderName: card.holderName };
      }
      if (method === 'mobile_money') {
        body.phone = phone;
        if (operatorId) body.operatorId = operatorId;
      }
      const r = await api.post<{ payment: PaymentView; declaration?: any }>('/api/deposits', body);
      setPin(false);
      setPayment(r.payment);
      setDeclaration(r.declaration ?? null);
      if (r.payment.status === 'succeeded') { toast('Money added', 'success'); refreshWallets(); }
      else if (r.payment.next?.type === 'redirect' || r.payment.next?.type === 'stripe_payment_intent') Linking.openURL(r.payment.next.url ?? `${config?.webUrl}/add-money?payment=${r.payment.id}`);
    } catch (err) {
      setError((err as Error).message);
      setPin(false);
    } finally {
      setLoading(false);
    }
  };
  const labels: Record<string, string> = { card: t('addMoney.card'), mobile_money: t('addMoney.mobileMoney'), bank: t('addMoney.bank') };
  return (
    <Screen>
      <Header title={t('addMoney.title')} />
      {payment ? (
        <Card style={{ alignItems: 'center' }}>
          <T size={44}>{payment.status === 'succeeded' ? '✅' : payment.status === 'failed' ? '❌' : payment.stageGroup === 'exception' ? '🔍' : '⏳'}</T>
          <T bold size={26}>{money(payment.amount, payment.currency)}</T>
          <Status status={payment.stageLabel ?? payment.status} />
          <StageBar stage={payment.stage} label={payment.stageLabel} description={payment.stageDescription} />
          {error && <Alert kind="error" text={error} />}
          {payment.failureReason && <Alert kind="error" text={payment.failureReason} />}
          {payment.stage === 'AUTHENTICATION_REQUIRED' && <Button title="🔐 Confirm with biometrics or PIN" onPress={() => setPin(true)} />}
          {payment.next?.type === 'prompt' && OPEN(payment) && <Alert text={payment.next.message} />}
          {payment.next?.type === 'bank_instructions' && OPEN(payment) && (
            <View style={{ alignSelf: 'stretch', gap: 8 }}>
              {['INSTRUCTION_ISSUED', 'PAYMENT_SENT'].includes(payment.stage ?? '') && <><Alert text={payment.next.message} />{Object.entries(payment.next.instructions ?? {}).map(([k, v]) => <KV key={k} k={k} v={String(v)} />)}</>}
              {payment.stage === 'INSTRUCTION_ISSUED' && <>
                <Input label={payment.method === 'mobile_money' ? 'Transaction ID from your receipt (optional)' : 'Transfer reference (optional)'} value={proof} onChangeText={setProof} />
                <T muted size={12}>Supporting note only – your wallet is credited when the operator/bank confirmation is matched, never from a typed reference or screenshot.</T>
                <Button title="I have sent the money" variant="secondary" onPress={() => api.post<{ payment: PaymentView }>(`/api/deposits/${payment.id}/sent`, { reference: proof || undefined }).then((r) => { setPayment(r.payment); toast('Waiting for confirmation', 'success'); }).catch((e) => setError(e.message))} />
              </>}
              {payment.stage === 'PAYMENT_SENT' && <Alert kind="warning" text="Waiting for independent confirmation. Nothing has been credited yet." />}
              {['MANUAL_REVIEW', 'MISMATCHED', 'DUPLICATE'].includes(payment.stage ?? '') && <Alert kind="warning" text="A verifier is reviewing this payment. Nothing is credited until it is confirmed." />}
            </View>
          )}
          {declaration && <Card soft><T bold size={13}>How this works · {declaration.processing} · {declaration.expectedCompletion}</T><T size={12}>Confirmation: {declaration.confirmation}</T><T size={12}>Settlement: {declaration.settlement}</T></Card>}
          <Button title={OPEN(payment) ? 'Back' : 'Done'} variant="secondary" onPress={() => { setPayment(null); setDeclaration(null); setError(null); }} />
        </Card>
      ) : (
        <Card>
          {error && <Alert kind="error" text={error} />}
          <AmountInput label={t('common.amount')} amount={amount} currency={cur} onAmount={setAmount} onCurrency={setCur} currencies={(config?.currencies ?? []).map((c: any) => c.code)} />
          <Tabs tabs={(options.data?.methods ?? []).map((m) => ({ id: m.method, label: labels[m.method] }))} value={method} onChange={(m) => setMethod(m as any)} />
          {options.data?.methods.length === 0 && <Alert kind="warning" text={`No payment gateway is configured for ${cur}. Use an agent instead.`} />}
          {method === 'card' && (
            <>
              {cards.data && cards.data.items.length > 0 && <Row style={{ flexWrap: 'wrap' }}>{cards.data.items.map((c) => <Chip key={c.id} label={`${c.brand} •••• ${c.last4}`} selected={savedCardId === c.id} onPress={() => setSavedCardId(savedCardId === c.id ? '' : c.id)} />)}</Row>}
              {!savedCardId && gw?.provider !== 'stripe' && (
                <>
                  <Input label="Card number" value={card.number} onChangeText={(v) => setCard({ ...card, number: v.replace(/\D/g, '').replace(/(.{4})/g, '$1 ').trim().slice(0, 23) })} keyboardType="number-pad" placeholder="4242 4242 4242 4242" />
                  <Row><View style={{ flex: 1 }}><Input label="MM" value={card.expMonth} onChangeText={(v) => setCard({ ...card, expMonth: v })} keyboardType="number-pad" maxLength={2} /></View><View style={{ flex: 1 }}><Input label="YY" value={card.expYear} onChangeText={(v) => setCard({ ...card, expYear: v })} keyboardType="number-pad" maxLength={4} /></View><View style={{ flex: 1 }}><Input label="CVC" value={card.cvc} onChangeText={(v) => setCard({ ...card, cvc: v })} keyboardType="number-pad" maxLength={4} secureTextEntry /></View></Row>
                  <Input label="Name on card" value={card.holderName} onChangeText={(v) => setCard({ ...card, holderName: v })} />
                </>
              )}
              {gw?.provider === 'stripe' && !savedCardId && <Alert text="You'll be taken to a secure Stripe page to enter your card." />}
              {gw?.provider === 'sandbox' && <Alert text="Sandbox: use 4242 4242 4242 4242 with any future expiry." />}
            </>
          )}
          {method === 'mobile_money' && (
            <>
              <OperatorPicker country={opCountry} onCountry={setOpCountry} value={operatorId} onChange={setOperatorId} onCurrency={(c) => { if ((config?.currencies ?? []).some((x: any) => x.code === c)) setCur(c); }} />
              <Input label="Your mobile money number" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="+233…" />
            </>
          )}
          {method === 'bank' && <Alert text="You'll receive bank details and a reference. Your wallet is credited only once the transfer is independently confirmed." />}
          <Button title={`🔐 Confirm and add ${amount ? `${amount} ${cur}` : 'money'}`} loading={loading} onPress={() => setPin(true)} disabled={!amount || !opt} />
        </Card>
      )}
      <PinSheet open={pin} onClose={() => setPin(false)} title="Authorise this payment" onSubmit={(p) => (payment?.stage === 'AUTHENTICATION_REQUIRED' ? api.post<{ payment: PaymentView }>(`/api/deposits/${payment.id}/authenticate`, { pin: p || undefined }).then((r) => { setPin(false); setPayment(r.payment); }).catch((e) => { setPin(false); setError(e.message); }) : submit(p))} loading={loading} summary={<KV k={`Add money via ${labels[method]}`} v={payment ? money(payment.amount, payment.currency) : `${amount} ${cur}`} />} />
    </Screen>
  );
}

/** Any mobile money operator in the world; those with a collection number use the direct rail (no API). */
export function OperatorPicker({ country, onCountry, value, onChange, onCurrency }: { country: string; onCountry: (c: string) => void; value: string; onChange: (id: string) => void; onCurrency?: (c: string) => void }) {
  const { config } = useStore();
  const ops = useAsync(() => api.get<{ items: any[] }>(`/api/mobile-money-operators${country ? `?country=${country}` : ''}`), [country]);
  const items = ops.data?.items ?? [];
  const sel = items.find((o) => o.id === value);
  return (
    <View style={{ gap: 8 }}>
      <Select label="Country" value={country} onChange={(c) => { onCountry(c); onChange(''); }} options={[{ value: '', label: 'All countries' }, ...(config?.countries ?? []).map((c: any) => ({ value: c.code, label: c.name }))]} />
      <Select label="Mobile money operator" value={value} onChange={(id) => { onChange(id); const o = items.find((x) => x.id === id); if (o && onCurrency) onCurrency(o.currency); }} options={[{ value: '', label: 'Choose operator…' }, ...items.map((o) => ({ value: o.id, label: `${o.name} · ${o.country} (${o.currency})` }))]} />
      {sel && <Row style={{ flexWrap: 'wrap' }}><Chip label={sel.brand} /><Chip label={sel.currency} />{sel.ussd && <Chip label={`USSD ${sel.ussd}`} />}{sel.directRail && <Chip label="no API needed" kind="success" />}</Row>}
    </View>
  );
}

export function Withdraw() {
  const { t, money, wallets, config, toast, refreshWallets } = useStore();
  const nav = useNav();
  const accounts = useAsync(() => api.get<{ items: BankAccount[] }>('/api/bank-accounts'), []);
  const [amount, setAmount] = useState('');
  const [cur, setCur] = useState(wallets[0]?.currency || 'USD');
  const [bankId, setBankId] = useState('');
  const [dest, setDest] = useState<'bank' | 'mobile_money'>('bank');
  const [opCountry, setOpCountry] = useState('');
  const [operatorId, setOperatorId] = useState('');
  const [phone, setPhone] = useState('');
  const [fee, setFee] = useState<number | null>(null);
  const [pin, setPin] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [bank, setBank] = useState({ bankName: '', accountName: '', accountNumber: '', currency: cur });
  const [bankPin, setBankPin] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eligible = (accounts.data?.items ?? []).filter((a) => a.currency === cur);
  useEffect(() => {
    if (!amount) return setFee(null);
    const id = setTimeout(() => api.get<{ fee: number }>(`/api/withdrawals/fee?amount=${amount}&currency=${cur}`).then((r) => setFee(r.fee)).catch(() => setFee(null)), 300);
    return () => clearTimeout(id);
  }, [amount, cur]);
  const submit = async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      const destination = dest === 'mobile_money' ? { method: 'mobile_money', operatorId, phone } : { method: 'bank', bankAccountId: bankId || eligible[0]?.id };
      const r = await api.post<{ transaction: Transaction }>('/api/withdrawals', { amount, currency: cur, destination, pin: p });
      toast('Withdrawal requested', 'success');
      refreshWallets();
      setPin(false);
      nav.replace('TxDetail', { id: r.transaction.id });
    } catch (err) {
      setError((err as Error).message);
      setPin(false);
    } finally {
      setLoading(false);
    }
  };
  return (
    <Screen>
      <Header title={t('withdraw.title')} right={<Button title="+ Bank" small variant="secondary" onPress={() => { setBank({ ...bank, currency: cur }); setAddOpen(true); }} />} />
      <Card>
        {error && <Alert kind="error" text={error} />}
        <AmountInput label={t('common.amount')} amount={amount} currency={cur} onAmount={setAmount} onCurrency={setCur} />
        <Tabs tabs={[{ id: 'bank', label: '🏦 Bank account' }, { id: 'mobile_money', label: '📱 Mobile money (any operator)' }]} value={dest} onChange={(v) => setDest(v as any)} />
        {dest === 'bank' && (eligible.length === 0 ? <Alert kind="warning" text={`No ${cur} bank account saved yet.`} /> : <Select label="Bank account" value={bankId || eligible[0].id} onChange={setBankId} options={eligible.map((a) => ({ value: a.id, label: `${a.bankName} · •••• ${a.accountNumber.slice(-4)}` }))} />)}
        {dest === 'mobile_money' && <><OperatorPicker country={opCountry} onCountry={setOpCountry} value={operatorId} onChange={setOperatorId} /><Input label="Mobile money number" value={phone} onChangeText={setPhone} keyboardType="phone-pad" /></>}
        {fee != null && <Card soft><KV k={t('common.fee')} v={money(fee, cur)} /></Card>}
        <Button title="Withdraw" onPress={() => setPin(true)} disabled={!amount || (dest === 'bank' ? eligible.length === 0 : !operatorId || !phone)} />
        <T muted size={12}>Payouts are executed from the platform's bank / mobile money accounts by our treasury team under maker-checker approval, usually within one business day. New beneficiaries have a short cooling-off period for larger amounts. Prefer cash? Use an agent.</T>
      </Card>
      <Card>
        <T bold>Bank accounts</T>
        {accounts.data?.items.length === 0 && <Empty icon="🏦" text="No bank accounts yet" />}
        {accounts.data?.items.map((a) => <Row key={a.id} between><View><T bold>{a.bankName} · {a.currency}</T><T muted size={12}>{a.accountName} · {a.accountNumber}</T></View><Button title="Remove" small variant="ghost" onPress={() => api.del(`/api/bank-accounts/${a.id}`).then(accounts.reload)} /></Row>)}
      </Card>
      <PinSheet open={pin} onClose={() => setPin(false)} onSubmit={submit} loading={loading} summary={<KV k="Withdraw" v={`${amount} ${cur}`} />} />
      <Sheet open={addOpen} onClose={() => setAddOpen(false)} title="Add bank account">
        <Input label="Bank name" value={bank.bankName} onChangeText={(v) => setBank({ ...bank, bankName: v })} />
        <Input label="Account holder" value={bank.accountName} onChangeText={(v) => setBank({ ...bank, accountName: v })} />
        <Input label="Account number / IBAN" value={bank.accountNumber} onChangeText={(v) => setBank({ ...bank, accountNumber: v })} />
        <Select label={t('common.currency')} value={bank.currency} onChange={(v) => setBank({ ...bank, currency: v })} options={(config?.currencies ?? []).map((c: any) => ({ value: c.code, label: c.code }))} />
        <Input label="Transaction PIN (beneficiary changes are step-up protected)" value={bankPin} onChangeText={setBankPin} keyboardType="number-pad" secureTextEntry maxLength={6} />
        <Button title={t('common.save')} onPress={() => api.post('/api/bank-accounts', { ...bank, pin: bankPin }).then(() => { setAddOpen(false); setBankPin(''); accounts.reload(); }).catch((e) => toast(e.message, 'error'))} disabled={!bank.bankName || !bank.accountName || !bank.accountNumber || bankPin.length < 4} />
      </Sheet>
    </Screen>
  );
}

export function Exchange() {
  const { t, money, wallets, config, toast, refreshWallets } = useStore();
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState(wallets[0]?.currency || 'USD');
  const [to, setTo] = useState(wallets[1]?.currency || 'EUR');
  const [quote, setQuote] = useState<any>(null);
  const [pin, setPin] = useState(false);
  const [loading, setLoading] = useState(false);
  const [newCur, setNewCur] = useState('');
  useEffect(() => {
    if (!amount || from === to) return setQuote(null);
    const id = setTimeout(() => api.get(`/api/wallets/exchange/quote?from=${from}&to=${to}&amount=${amount}`).then(setQuote).catch(() => setQuote(null)), 300);
    return () => clearTimeout(id);
  }, [amount, from, to]);
  const submit = async (p: string) => {
    setLoading(true);
    try {
      await api.post('/api/wallets/exchange', { from, to, amount, pin: p });
      toast('Exchange completed', 'success');
      setAmount('');
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
      <Header title={t('nav.exchange')} />
      <Card>
        <AmountInput label="From" amount={amount} currency={from} onAmount={setAmount} onCurrency={setFrom} />
        <Select label="To" value={to} onChange={setTo} options={(config?.currencies ?? []).map((c: any) => ({ value: c.code, label: `${c.code} – ${c.name}` }))} />
        {quote && <Card soft><KV k="Rate" v={`1 ${from} = ${quote.rate.toFixed(4)} ${to}`} /><KV k="You receive" v={money(quote.receive, to)} /></Card>}
        <Button title="Exchange" onPress={() => setPin(true)} disabled={!quote} />
      </Card>
      <Card>
        <T bold>My wallets</T>
        {wallets.map((w) => <KV key={w.id} k={w.currency} v={money(w.balance, w.currency)} />)}
        <Select label="Add a currency wallet" value={newCur} onChange={setNewCur} options={[{ value: '', label: 'Choose…' }, ...(config?.currencies ?? []).filter((c: any) => !wallets.some((w) => w.currency === c.code)).map((c: any) => ({ value: c.code, label: `${c.code} – ${c.name}` }))]} />
        <Button title="Add wallet" variant="secondary" disabled={!newCur} onPress={() => api.post('/api/wallets', { currency: newCur }).then(() => { toast(`${newCur} wallet created`, 'success'); setNewCur(''); refreshWallets(); })} />
      </Card>
      <PinSheet open={pin} onClose={() => setPin(false)} onSubmit={submit} loading={loading} summary={quote && <KV k={`Exchange ${amount} ${from}`} v={money(quote.receive, to)} />} />
    </Screen>
  );
}

export function Agents({ route }: ScreenProps<'Agents'>) {
  const { t, money, wallets, toast, user } = useStore();
  const [q, setQ] = useState('');
  const agents = useAsync(() => api.get<{ items: (PublicUser & { commissionBps: number })[] }>(`/api/agents?q=${encodeURIComponent(q)}`), [q]);
  const requests = useAsync(() => api.get<{ items: any[] }>('/api/agents/cash-requests'), []);
  const [selected, setSelected] = useState<PublicUser | null>(null);
  const [amount, setAmount] = useState('');
  const [cur, setCur] = useState(wallets[0]?.currency || 'USD');
  const [pin, setPin] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const pre = route.params?.agent;
    if (pre && agents.data && !selected) { const a = agents.data.items.find((x) => x.tag === pre); if (a) setSelected(a); }
  }, [agents.data, route.params?.agent, selected]);
  const submit = async (p: string) => {
    setLoading(true);
    try {
      const r = await api.post<{ request: any }>('/api/agents/cash-out', { agent: selected!.tag, amount, currency: cur, pin: p });
      setResult(r.request);
      setPin(false);
      requests.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
      setPin(false);
    } finally {
      setLoading(false);
    }
  };
  return (
    <Screen>
      <Header title={t('nav.agents')} />
      <Alert text={`Cash-in: hand cash to an agent and tell them @${user?.tag}. Cash-out: create a code below and show it to the agent.`} />
      <Input placeholder="Search agents" value={q} onChangeText={setQ} />
      {agents.data?.items.length === 0 && <Empty icon="🏪" text="No agents found" />}
      {agents.data?.items.map((a) => (
        <Card key={a.id} style={{ borderColor: selected?.id === a.id ? '#2563eb' : undefined }}>
          <Row between><Row><Avatar user={a} /><View><T bold>{a.businessName || a.fullName}</T><T muted size={12}>@{a.tag} · {a.country ?? ''} · {(a.commissionBps / 100).toFixed(2)}%</T></View></Row><Button title="Select" small variant={selected?.id === a.id ? undefined : 'secondary'} onPress={() => setSelected(a)} /></Row>
        </Card>
      ))}
      <Card>
        <T bold>Withdraw cash (cash-out)</T>
        {selected ? <T muted>at {selected.businessName || selected.fullName}</T> : <T muted>Select an agent first</T>}
        <AmountInput amount={amount} currency={cur} onAmount={setAmount} onCurrency={setCur} />
        <Button title="Create cash-out code" onPress={() => setPin(true)} disabled={!selected || !amount} />
      </Card>
      {(requests.data?.items ?? []).length > 0 && <Card><T bold>My cash requests</T>{requests.data!.items.map((r) => <Row key={r.id} between><View><T bold>{money(r.amount, r.currency)} · <T mono>{r.code}</T></T><T muted size={12}>{r.agent?.businessName || r.agent?.fullName}</T></View><Status status={r.status} /></Row>)}</Card>}
      <PinSheet open={pin} onClose={() => setPin(false)} onSubmit={submit} loading={loading} summary={<KV k="Cash out" v={`${amount} ${cur}`} />} />
      <Sheet open={!!result} onClose={() => setResult(null)} title="Show this code to the agent">
        {result && <View style={{ alignItems: 'center', gap: 8 }}><T bold size={40} mono>{result.code}</T><T muted>{money(result.amount, result.currency)} + fee {money(result.fee, result.currency)}</T><T size={13} center>Funds leave your wallet only when the agent confirms and hands you the cash.</T></View>}
      </Sheet>
    </Screen>
  );
}
