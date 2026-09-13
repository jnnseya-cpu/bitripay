import React, { useEffect, useState } from 'react';
import { Share, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { api, qs } from '../lib/api';
import { useStore } from '../lib/store';
import { Screen, Card, Button, Input, Alert, T, KV, Qr, Avatar, PinSheet, AmountInput, Row, Status, Tabs, Empty, useAsync, Chip, Sheet } from '../components/ui';
import { Scanner } from '../components/Scanner';
import { offlineQueue } from '../lib/offline';
import { Header } from '../components/Header';
import { useNav, type ScreenProps } from '../navigation';
import { decodeQr, toMinor, type PaymentRequest, type PublicUser, type Transaction } from '@bitripay/shared';

type Resolved =
  | {
      kind: 'payment_request';
      paymentRequest: PaymentRequest;
      merchant: PublicUser & { verified?: boolean; location?: { name: string } | null };
      methods: string[];
      trust?: 'verified' | 'basic';
      intent?: { purposeCode: string | null };
    }
  | { kind: 'user' | 'merchant' | 'agent'; user: PublicUser; amount: string | null; currency: string | null; note: string | null }
  | {
      kind: 'bitriqr';
      user: PublicUser & { verified?: boolean; location?: { name: string } | null };
      qrId: string | null;
      amount: null;
      currency: string | null;
      note: string | null;
      purposeCode: string | null;
      trust: 'verified' | 'basic';
    };

export function Scan() {
  const { t } = useStore();
  const nav = useNav();
  const [manual, setManual] = useState('');
  const [active, setActive] = useState(true);
  useEffect(() => {
    const unsub = nav.addListener('focus', () => setActive(true));
    const blur = nav.addListener('blur', () => setActive(false));
    return () => {
      unsub();
      blur();
    };
  }, [nav]);
  const go = (data: string) => {
    setActive(false);
    nav.navigate('PayTarget', { data });
    setTimeout(() => setActive(true), 1500);
  };
  return (
    <Screen title={t('scan.title')}>
      <T muted>{t('scan.hint')}</T>
      <Scanner onScan={go} active={active} />
      <Card>
        <Input label={t('scan.paste')} value={manual} onChangeText={setManual} autoCapitalize="none" placeholder="@tag, bitripay://… or https://…/pay/CODE" />
        <Button title="Go" onPress={() => manual && go(manual)} disabled={!manual} />
      </Card>
    </Screen>
  );
}

export function PayTarget({ route }: ScreenProps<'PayTarget'> | ScreenProps<'Checkout'>) {
  const params = route.params as { data?: string; code?: string };
  const { t, money, wallets, currency, refreshWallets, toast, user, config } = useStore();
  const nav = useNav();
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [cur, setCur] = useState(wallets[0]?.currency || config?.baseCurrency || 'USD');
  const [note, setNote] = useState('');
  const [fee, setFee] = useState(0);
  const [pin, setPin] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const data = params.data ?? (params.code ? `${config?.webUrl}/pay/${params.code}` : '');
    if (!data) return;
    if (!decodeQr(data)) return setError(t('scan.hint') + ' – invalid code');
    const offline = offlineQueue.decodeOffline(data);
    if (offline) setOfflineCode({ ...offline, payload: data });
    api
      .post<Resolved>('/api/qr/resolve', { data })
      .then((r) => {
        setResolved(r);
        if (r.kind === 'payment_request') {
          const pr = r.paymentRequest;
          setCur(pr.currency);
          if (pr.amount != null) setAmount(String(pr.amount / 10 ** currency(pr.currency).decimals));
          setNote(pr.description ?? '');
        } else {
          if (r.amount) setAmount(r.amount);
          if (r.currency) setCur(r.currency);
          if (r.note) setNote(r.note);
        }
      })
      .catch((e) => {
        if (!offline) setError(e.message);
        else setError(null);
      });
  }, [params.data, params.code]); // eslint-disable-line react-hooks/exhaustive-deps
  const [offlineCode, setOfflineCode] = useState<null | {
    payload: string;
    merchantCode: string;
    merchantName: string;
    amount: string;
    currency: string;
    nonce: string;
    expiresAt: number | null;
    reference: string | null;
  }>(null);
  const payOffline = async () => {
    if (!offlineCode || !user) return;
    setLoading(true);
    try {
      const merchantId = (resolved as any)?.merchant?.id ?? (resolved as any)?.user?.id ?? null;
      const item = await offlineQueue.promiseFor(offlineCode.payload, user.id, merchantId ?? offlineCode.merchantCode, currency(offlineCode.currency).decimals);
      toast(`Queued ${money(item.amountMinor, item.currency)} for ${item.merchantName}; it settles when you are back online`, 'success');
      nav.replace('Offline');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const target = resolved ? (resolved.kind === 'payment_request' ? resolved.merchant : resolved.user) : null;
  const isPr = resolved?.kind === 'payment_request';
  const pr = isPr ? ((resolved as any).paymentRequest as PaymentRequest) : null;
  let minor = 0;
  try {
    minor = amount ? toMinor(amount, currency(cur).decimals) : 0;
  } catch {
    minor = -1;
  }
  useEffect(() => {
    if (minor <= 0 || !target) return setFee(0);
    const type = target.role === 'merchant' ? 'merchant_payment' : 'transfer';
    api
      .get<{ fee: number }>(`/api/transfers/fee?amount=${amount}&currency=${cur}&type=${type}`)
      .then((r) => setFee(r.fee))
      .catch(() => setFee(0));
  }, [amount, cur, minor, target]);
  const feeOnMe = target?.role !== 'merchant';
  const total = minor + (feeOnMe ? fee : 0);
  const wallet = wallets.find((w) => w.currency === cur);

  const pay = async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      let tx: Transaction;
      if (isPr) tx = (await api.post<{ transaction: Transaction }>(`/api/payment-requests/${pr!.code}/pay`, { pin: p, amount: pr!.amount == null ? amount : undefined, note })).transaction;
      else if (resolved?.kind === 'bitriqr' && resolved.qrId) {
        const intent = await api.post<{ paymentRequestCode: string }>(`/api/v1/qr/${resolved.qrId}/intent`, { amount, description: note || null });
        tx = (await api.post<{ transaction: Transaction }>(`/api/payment-requests/${intent.paymentRequestCode}/pay`, { pin: p, note })).transaction;
      } else tx = (await api.post<{ transaction: Transaction }>('/api/transfers', { to: target!.tag, amount, currency: cur, note, pin: p })).transaction;
      await refreshWallets();
      toast('Payment successful', 'success');
      setPin(false);
      nav.replace('TxDetail', { id: tx.id });
    } catch (err) {
      setError((err as Error).message);
      setPin(false);
    } finally {
      setLoading(false);
    }
  };

  if (error)
    return (
      <Screen>
        <Header title="Pay" />
        <Alert kind="error" text={error} />
        <Button title={t('common.back')} variant="secondary" onPress={() => nav.goBack()} />
      </Screen>
    );
  if (!resolved && offlineCode) {
    return (
      <Screen>
        <Header title="Pay offline" />
        <Card>
          <T bold size={18}>
            {offlineCode.merchantName}
          </T>
          <T muted>
            @{offlineCode.merchantCode}
            {offlineCode.reference ? ` · ${offlineCode.reference}` : ''}
          </T>
          <View style={{ alignItems: 'center', paddingVertical: 8 }}>
            <T bold size={34}>
              {offlineCode.amount} {offlineCode.currency}
            </T>
          </View>
          <Alert kind="info" text="No network right now. This payment is signed on your phone and settles in order when you are back online; if it cannot settle, nothing leaves your balance." />
          <Button title="Confirm offline payment" loading={loading} onPress={payOffline} />
        </Card>
      </Screen>
    );
  }
  if (!resolved || !target)
    return (
      <Screen>
        <Header title="Pay" />
        <T muted>{t('common.loading')}</T>
      </Screen>
    );
  if (resolved.kind === 'agent') {
    return (
      <Screen>
        <Header title="Agent" />
        <Card>
          <Row>
            <Avatar user={target} />
            <View>
              <T bold>{target.businessName || target.fullName}</T>
              <T muted>@{target.tag}</T>
            </View>
          </Row>
          <T muted size={13}>
            Agents let you deposit or withdraw cash.
          </T>
          <Button title="Withdraw cash (cash-out)" onPress={() => nav.navigate('Agents', { agent: target.tag })} />
          <Button title="Send money to agent" variant="secondary" onPress={() => nav.navigate('Send', { to: target.tag })} />
        </Card>
      </Screen>
    );
  }
  return (
    <Screen>
      <Header title="Pay" />
      <Card>
        <Row>
          <Avatar user={target} size={52} />
          <View>
            <T bold size={18}>
              {target.businessName || target.fullName}
            </T>
            <T muted>
              @{target.tag} · {target.role}
            </T>
          </View>
          {pr && <Status status={pr.status} />}
        </Row>
        {(resolved.kind === 'bitriqr' || (isPr && (resolved as any).trust)) && (
          <Row style={{ flexWrap: 'wrap', gap: 6 }}>
            <Chip label={(resolved as any).trust === 'verified' ? '✓ Verified merchant' : 'Unverified code'} kind={(resolved as any).trust === 'verified' ? 'success' : 'warning'} />
            {(target as any).location?.name ? <Chip label={(target as any).location.name} /> : null}
          </Row>
        )}
        {pr && pr.status !== 'open' && <Alert kind="warning" text={`This payment request is ${pr.status}.`} />}
        {target.id === user?.id && <Alert kind="warning" text="This is your own code." />}
        {pr?.amount != null ? (
          <View style={{ alignItems: 'center', paddingVertical: 8 }}>
            <T bold size={34}>
              {money(pr.amount, pr.currency)}
            </T>
            <T muted>{pr.description}</T>
          </View>
        ) : (
          <AmountInput label={t('common.amount')} amount={amount} currency={cur} onAmount={setAmount} onCurrency={setCur} currencies={isPr ? [cur] : undefined} />
        )}
        {!pr?.description && <Input label={t('common.note')} value={note} onChangeText={setNote} />}
        {minor > 0 && (
          <Card soft>
            <KV k={t('common.fee')} v={feeOnMe ? money(fee, cur) : 'Paid by merchant'} />
            <KV k={t('common.total')} v={money(total, cur)} />
            <KV k={t('common.balance')} v={wallet ? money(wallet.balance, wallet.currency) : `No ${cur} wallet`} />
          </Card>
        )}
        <Button
          title={`Pay ${minor > 0 ? money(total, cur) : ''}`}
          onPress={() => setPin(true)}
          disabled={minor <= 0 || !wallet || wallet.balance < total || (!!pr && pr.status !== 'open') || target.id === user?.id}
        />
      </Card>
      <PinSheet open={pin} onClose={() => setPin(false)} onSubmit={pay} loading={loading} summary={<KV k={`Pay ${target.businessName || target.fullName}`} v={money(total, cur)} />} />
    </Screen>
  );
}

export function Send({ route }: ScreenProps<'Send'>) {
  const { t, money, wallets, currency, refreshWallets, toast, config } = useStore();
  const nav = useNav();
  const [to, setTo] = useState(route.params?.to ?? '');
  const [recipient, setRecipient] = useState<PublicUser | null>(null);
  const [amount, setAmount] = useState(route.params?.amount ?? '');
  const [cur, setCur] = useState(route.params?.currency ?? wallets[0]?.currency ?? config?.baseCurrency ?? 'USD');
  const [note, setNote] = useState(route.params?.note ?? '');
  const [fee, setFee] = useState(0);
  const [pin, setPin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (to.length < 3) return setRecipient(null);
    const id = setTimeout(
      () =>
        api
          .get<{ user: PublicUser }>(`/api/account/lookup?q=${encodeURIComponent(to)}`)
          .then((r) => setRecipient(r.user))
          .catch(() => setRecipient(null)),
      350,
    );
    return () => clearTimeout(id);
  }, [to]);
  let minor = 0;
  try {
    minor = amount ? toMinor(amount, currency(cur).decimals) : 0;
  } catch {
    minor = -1;
  }
  useEffect(() => {
    if (minor <= 0) return setFee(0);
    const id = setTimeout(
      () =>
        api
          .get<{ fee: number }>(`/api/transfers/fee?amount=${amount}&currency=${cur}&type=${recipient?.role === 'merchant' ? 'merchant_payment' : 'transfer'}`)
          .then((r) => setFee(r.fee))
          .catch(() => setFee(0)),
      300,
    );
    return () => clearTimeout(id);
  }, [amount, cur, minor, recipient]);
  const feeOnMe = recipient?.role !== 'merchant';
  const total = minor + (feeOnMe ? fee : 0);
  const wallet = wallets.find((w) => w.currency === cur);
  const submit = async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.post<{ transaction: Transaction }>('/api/transfers', { to: recipient!.tag, amount, currency: cur, note, pin: p });
      await refreshWallets();
      toast(t('send.success'), 'success');
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
      <Header title={t('send.title')} />
      <Card>
        {error && <Alert kind="error" text={error} />}
        <Input label={t('send.to')} value={to} onChangeText={setTo} autoCapitalize="none" placeholder="@alice" />
        {recipient && (
          <Card soft>
            <Row>
              <Avatar user={recipient} />
              <View>
                <T bold>{recipient.businessName || recipient.fullName}</T>
                <T muted>@{recipient.tag}</T>
              </View>
            </Row>
          </Card>
        )}
        <AmountInput label={t('common.amount')} amount={amount} currency={cur} onAmount={setAmount} onCurrency={setCur} />
        {wallet && (
          <T muted size={12}>
            {t('common.balance')}: {money(wallet.balance, wallet.currency)}
          </T>
        )}
        <Input label={t('common.note')} value={note} onChangeText={setNote} />
        {minor > 0 && (
          <Card soft>
            <KV k={t('common.fee')} v={feeOnMe ? money(fee, cur) : 'Paid by merchant'} />
            <KV k={t('common.total')} v={money(total, cur)} />
          </Card>
        )}
        <Button title={t('send.review')} onPress={() => setPin(true)} disabled={!recipient || minor <= 0 || !wallet || wallet.balance < total} />
      </Card>
      <PinSheet
        open={pin}
        onClose={() => setPin(false)}
        onSubmit={submit}
        loading={loading}
        summary={
          <>
            <KV k="To" v={`${recipient?.fullName} (@${recipient?.tag})`} />
            <KV k={t('common.total')} v={money(total, cur)} />
          </>
        }
      />
    </Screen>
  );
}

export function Receive() {
  const { t, user, config } = useStore();
  const [amount, setAmount] = useState('');
  const [cur, setCur] = useState(config?.baseCurrency ?? 'USD');
  const [note, setNote] = useState('');
  const [data, setData] = useState<{ content: string } | null>(null);
  useEffect(() => {
    const q = qs({ amount: amount || undefined, currency: amount ? cur : undefined, note: note || undefined });
    api
      .get<{ content: string }>(`/api/qr/me${q}`)
      .then(setData)
      .catch(() => setData(null));
  }, [amount, cur, note]);
  return (
    <Screen title={t('receive.title')}>
      <T muted>{t('receive.subtitle')}</T>
      <Card style={{ alignItems: 'center' }}>
        {data && <Qr value={data.content} size={230} />}
        <T bold size={20}>
          @{user?.tag}
        </T>
        <T muted>{user?.businessName || user?.fullName}</T>
        {amount ? (
          <T bold>
            {amount} {cur}
            {note ? ` · ${note}` : ''}
          </T>
        ) : null}
        <Row>
          <Button title={t('common.copy')} small variant="secondary" onPress={() => data && Clipboard.setStringAsync(data.content)} />
          <Button title={t('common.share')} small variant="secondary" onPress={() => data && Share.share({ message: `Pay @${user?.tag} on BitriPay: ${data.content}` })} />
        </Row>
      </Card>
      <Card>
        <T bold>{t('receive.requestAmount')}</T>
        <AmountInput amount={amount} currency={cur} onAmount={setAmount} onCurrency={setCur} currencies={(config?.currencies ?? []).map((c: any) => c.code)} />
        <Input label={t('common.note')} value={note} onChangeText={setNote} />
      </Card>
    </Screen>
  );
}

export function Requests() {
  const { t, money, config, toast, refreshWallets, wallets } = useStore();
  const [tab, setTab] = useState<'incoming' | 'mine' | 'links'>('incoming');
  const [create, setCreate] = useState<null | 'link' | 'request'>(null);
  const [form, setForm] = useState({ amount: '', currency: wallets[0]?.currency || config?.baseCurrency || 'USD', description: '', payer: '' });
  const [created, setCreated] = useState<PaymentRequest | null>(null);
  const [payCode, setPayCode] = useState<PaymentRequest | null>(null);
  const [loading, setLoading] = useState(false);
  const list = useAsync(
    () =>
      api.get<{ items: PaymentRequest[] }>(
        tab === 'incoming' ? '/api/payment-requests?role=payer&status=open' : `/api/payment-requests?role=requester&pageSize=50${tab === 'mine' ? '&kind=request' : ''}`,
      ),
    [tab],
  );
  const submitCreate = async () => {
    setLoading(true);
    try {
      const body: any = { kind: create, currency: form.currency, description: form.description || null };
      if (form.amount) body.amount = form.amount;
      if (create === 'request') body.payer = form.payer;
      const r = await api.post<{ paymentRequest: PaymentRequest }>('/api/payment-requests', body);
      setCreate(null);
      setCreated(r.paymentRequest);
      list.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };
  const pay = async (p: string) => {
    setLoading(true);
    try {
      await api.post(`/api/payment-requests/${payCode!.code}/pay`, { pin: p });
      toast('Paid', 'success');
      setPayCode(null);
      list.reload();
      refreshWallets();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };
  const items = (list.data?.items ?? []).filter((r) => tab !== 'links' || r.kind !== 'request');
  return (
    <Screen>
      <Header title={t('nav.requests')} />
      <Row>
        <Button title="🙋 Request money" small variant="secondary" onPress={() => setCreate('request')} />
        <Button title="🔗 Payment link" small onPress={() => setCreate('link')} />
      </Row>
      <Tabs
        tabs={[
          { id: 'incoming', label: 'To pay' },
          { id: 'mine', label: 'My requests' },
          { id: 'links', label: 'My links' },
        ]}
        value={tab}
        onChange={(v) => setTab(v as any)}
      />
      {items.length === 0 && <Empty icon="🔗" />}
      {items.map((r) => (
        <Card key={r.id}>
          <Row between>
            <T bold>{r.amount != null ? money(r.amount, r.currency) : `Any amount (${r.currency})`}</T>
            <Status status={r.status} />
          </Row>
          <T muted size={13}>
            {r.description ?? ''} {tab === 'incoming' ? `· from @${r.requester?.tag}` : r.payer ? `· to @${r.payer.tag}` : ''}
          </T>
          <Row>
            {tab === 'incoming' && r.status === 'open' && (
              <>
                <Button title="Pay" small onPress={() => setPayCode(r)} />
                <Button title="Decline" small variant="secondary" onPress={() => api.post(`/api/payment-requests/${r.code}/decline`).then(list.reload)} />
              </>
            )}
            {tab !== 'incoming' && (
              <>
                <Button title="View QR" small variant="secondary" onPress={() => setCreated(r)} />
                {r.status === 'open' && <Button title={t('common.cancel')} small variant="ghost" onPress={() => api.post(`/api/payment-requests/${r.code}/cancel`).then(list.reload)} />}
              </>
            )}
          </Row>
        </Card>
      ))}
      <Sheet open={!!create} onClose={() => setCreate(null)} title={create === 'link' ? 'New payment link' : 'Request money'}>
        {create === 'request' && <Input label="From (@tag, email or phone)" value={form.payer} onChangeText={(v) => setForm({ ...form, payer: v })} autoCapitalize="none" />}
        <AmountInput
          label={t('common.amount')}
          amount={form.amount}
          currency={form.currency}
          onAmount={(a) => setForm({ ...form, amount: a })}
          onCurrency={(c) => setForm({ ...form, currency: c })}
          currencies={(config?.currencies ?? []).map((c: any) => c.code)}
        />
        <Input label="Description" value={form.description} onChangeText={(v) => setForm({ ...form, description: v })} />
        <Button title={create === 'link' ? 'Create link' : 'Send request'} loading={loading} onPress={submitCreate} disabled={create === 'request' && (!form.amount || !form.payer)} />
      </Sheet>
      <Sheet open={!!created} onClose={() => setCreated(null)} title="Payment link">
        {created && (
          <View style={{ alignItems: 'center', gap: 10 }}>
            <Qr value={created.link!} size={200} />
            <T bold size={20}>
              {created.amount != null ? money(created.amount, created.currency) : 'Any amount'}
            </T>
            <T muted size={12}>
              {created.link}
            </T>
            <Row>
              <Button title="Copy link" small variant="secondary" onPress={() => Clipboard.setStringAsync(created.link!)} />
              <Button title={t('common.share')} small onPress={() => Share.share({ message: created.link! })} />
            </Row>
          </View>
        )}
      </Sheet>
      <PinSheet
        open={!!payCode}
        onClose={() => setPayCode(null)}
        onSubmit={pay}
        loading={loading}
        summary={payCode && <KV k={`Pay @${payCode.requester?.tag}`} v={money(payCode.amount ?? 0, payCode.currency)} />}
      />
    </Screen>
  );
}
