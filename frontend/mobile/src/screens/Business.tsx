import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Screen, Card, Button, Input, Alert, T, KV, PinSheet, AmountInput, Row, Status, Tabs, Empty, useAsync, Avatar, Qr, Sheet, Chip, Select } from '../components/ui';
import { Header } from '../components/Header';
import { useNav } from '../navigation';
import { toMinor, currencyLabel, type PaymentRequest, type PublicUser } from '@bitripay/shared';

export function Merchant() {
  const { t, user, money, wallets, config } = useStore();
  const nav = useNav();
  const stats = useAsync(() => api.get<any>('/api/merchant/stats'), []);
  const [amount, setAmount] = useState('');
  const [cur, setCur] = useState(wallets[0]?.currency || config?.baseCurrency || 'USD');
  const [desc, setDesc] = useState('');
  const [pr, setPr] = useState<PaymentRequest | null>(null);
  const [mode, setMode] = useState<'items' | 'amount'>('items');
  const [lines, setLines] = useState<{ description: string; quantity: string; unitPrice: string }[]>([{ description: '', quantity: '1', unitPrice: '' }]);
  const [vatRate, setVatRate] = useState('');
  const gw = useAsync(() => api.get<{ settings: { vatRate?: number; taxId?: string | null } }>('/api/merchant/gateway'), []);
  useEffect(() => {
    if (gw.data && vatRate === '') setVatRate(String(gw.data.settings.vatRate ?? 0));
  }, [gw.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const decimals = (config?.currencies ?? []).find((c: any) => c.code === cur)?.decimals ?? 2;
  const rate = Math.min(100, Math.max(0, Number(vatRate) || 0));
  const preview = (() => {
    const items = lines
      .filter((l) => l.description.trim() && l.unitPrice)
      .map((l) => {
        let unit = 0;
        try {
          unit = toMinor(l.unitPrice, decimals);
        } catch {
          unit = 0;
        }
        const qty = Math.max(1, Math.floor(Number(l.quantity) || 1));
        return { description: l.description.trim(), quantity: qty, unitPrice: l.unitPrice, total: qty * unit };
      });
    const subtotal = items.reduce((a, i) => a + i.total, 0);
    const vat = Math.round((subtotal * rate) / 100);
    return { items, subtotal, vat, total: subtotal + vat };
  })();
  const setLine = (i: number, patch: Partial<{ description: string; quantity: string; unitPrice: string }>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  useEffect(() => {
    if (!pr || pr.status !== 'open') return;
    const id = setInterval(() => api.get<{ paymentRequest: PaymentRequest }>(`/api/payment-requests/${pr.code}`).then((r) => setPr(r.paymentRequest)), 3000);
    return () => clearInterval(id);
  }, [pr]);
  const s = stats.data;
  return (
    <Screen>
      <Header title={user?.businessName || 'Merchant'} right={<Button title="Gateway" small variant="secondary" onPress={() => nav.navigate('MerchantGateway')} />} />
      <Row style={{ flexWrap: 'wrap' }}>
        {(s?.byCurrency ?? []).map((c: any) => (
          <Card key={c.currency} style={{ flexGrow: 1 }}>
            <T muted size={12}>
              30-day volume · {c.currency}
            </T>
            <T bold size={20}>
              {money(c.volume, c.currency)}
            </T>
            <T muted size={11}>
              {c.c} payments · today {money(c.today, c.currency)}
            </T>
          </Card>
        ))}
        <Card style={{ flexGrow: 1 }}>
          <T muted size={12}>
            Open payment links
          </T>
          <T bold size={20}>
            {s?.openPaymentRequests ?? 0}
          </T>
        </Card>
      </Row>
      <Card>
        <T bold size={16}>
          Point of sale
        </T>
        {pr ? (
          <View style={{ alignItems: 'center', gap: 8 }}>
            {pr.status === 'paid' ? <T size={48}>✅</T> : <Qr value={pr.link!} size={220} />}
            <T bold size={26}>
              {pr.amount != null ? money(pr.amount, pr.currency) : 'Any amount'}
            </T>
            <T muted>{pr.description}</T>
            {pr.sale && (
              <View style={{ alignSelf: 'stretch' }}>
                {pr.sale.items.map((it, i) => (
                  <KV key={i} k={`${it.quantity} × ${it.description}`} v={money(it.total, pr.currency)} />
                ))}
                <KV k="Subtotal" v={money(pr.sale.subtotal, pr.currency)} />
                <KV k={`VAT ${pr.sale.vatRate}%`} v={money(pr.sale.vat, pr.currency)} />
                <KV k="Total" v={money(pr.sale.total, pr.currency)} />
                {pr.sale.taxId && (
                  <T muted size={11}>
                    Tax ID {pr.sale.taxId}
                  </T>
                )}
              </View>
            )}
            <Status status={pr.status} />
            {pr.status === 'open' && (
              <T muted size={12}>
                Waiting for the customer to scan…
              </T>
            )}
            {pr.status === 'paid' && <T size={13}>Paid by {pr.payer?.fullName ?? 'customer'}</T>}
            <Row>
              <Button title="Copy link" small variant="secondary" onPress={() => Clipboard.setStringAsync(pr.link!)} />
              <Button title="New sale" small onPress={() => setPr(null)} />
            </Row>
          </View>
        ) : (
          <>
            <Tabs
              tabs={[
                { id: 'items', label: 'Items & VAT' },
                { id: 'amount', label: 'Amount only' },
              ]}
              value={mode}
              onChange={(v) => setMode(v as 'items' | 'amount')}
            />
            {mode === 'items' ? (
              <>
                <Row>
                  <View style={{ flex: 1 }}>
                    <Select label="Currency" value={cur} onChange={setCur} options={(config?.currencies ?? []).map((c: any) => ({ value: c.code, label: `${currencyLabel(c.code)}` }))} />
                  </View>
                  <View style={{ width: 110 }}>
                    <Input label="VAT %" value={vatRate} onChangeText={(v) => setVatRate(v.replace(/[^\d.]/g, ''))} keyboardType="decimal-pad" />
                  </View>
                </Row>
                {lines.map((l, i) => (
                  <Row key={i} style={{ alignItems: 'flex-end' }}>
                    <View style={{ flex: 1 }}>
                      <Input label={i === 0 ? 'Item' : undefined} value={l.description} onChangeText={(v) => setLine(i, { description: v })} placeholder={`Item ${i + 1}`} />
                    </View>
                    <View style={{ width: 56 }}>
                      <Input label={i === 0 ? 'Qty' : undefined} value={l.quantity} onChangeText={(v) => setLine(i, { quantity: v.replace(/\D/g, '') })} keyboardType="number-pad" />
                    </View>
                    <View style={{ width: 96 }}>
                      <Input
                        label={i === 0 ? 'Unit' : undefined}
                        value={l.unitPrice}
                        onChangeText={(v) => setLine(i, { unitPrice: v.replace(/[^\d.]/g, '') })}
                        keyboardType="decimal-pad"
                        placeholder="0.00"
                      />
                    </View>
                    <Button title="✕" small variant="ghost" onPress={() => setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : [{ description: '', quantity: '1', unitPrice: '' }]))} />
                  </Row>
                ))}
                <Button title="+ Add a line" small variant="secondary" onPress={() => setLines((ls) => [...ls, { description: '', quantity: '1', unitPrice: '' }])} />
                <KV k="Subtotal" v={money(preview.subtotal, cur)} />
                <KV k={`VAT ${rate}%`} v={money(preview.vat, cur)} />
                <KV k="Total to pay" v={money(preview.total, cur)} />
              </>
            ) : (
              <AmountInput label={t('common.amount')} amount={amount} currency={cur} onAmount={setAmount} onCurrency={setCur} currencies={(config?.currencies ?? []).map((c: any) => c.code)} />
            )}
            <Input label="Reference" value={desc} onChangeText={setDesc} placeholder="Table 4 · Order #1042" />
            <Button
              title={mode === 'items' && preview.total > 0 ? `Generate QR · ${money(preview.total, cur)}` : 'Generate QR'}
              disabled={mode === 'items' ? preview.items.length === 0 || preview.total <= 0 : !amount}
              onPress={() =>
                api
                  .post<{ paymentRequest: PaymentRequest }>(
                    '/api/payment-requests',
                    mode === 'items'
                      ? {
                          kind: 'qr',
                          currency: cur,
                          description: desc || null,
                          expiresInMinutes: 30,
                          items: preview.items.map((i) => ({ description: i.description, quantity: i.quantity, unitPrice: i.unitPrice })),
                          vatRate: rate,
                        }
                      : { kind: 'qr', amount, currency: cur, description: desc || null, expiresInMinutes: 30 },
                  )
                  .then((r) => setPr(r.paymentRequest))
              }
            />
          </>
        )}
      </Card>
      <Card>
        <T bold>By method (30 days)</T>
        {(s?.byMethod ?? []).map((m: any) => (
          <KV key={m.method} k={m.method.replace('_', ' ')} v={String(m.count)} />
        ))}
        {s?.byMethod?.length === 0 && <Empty icon="📊" text="No sales yet" />}
      </Card>
    </Screen>
  );
}

export function MerchantGateway() {
  const { toast, config } = useStore();
  const gw = useAsync(() => api.get<any>('/api/merchant/gateway'), []);
  const keys = useAsync(() => api.get<{ items: any[] }>('/api/merchant/api-keys'), []);
  const [settings, setSettings] = useState<any>(null);
  const [newKey, setNewKey] = useState<any>(null);
  const [webhook, setWebhook] = useState('');
  useEffect(() => {
    if (gw.data) {
      setSettings(gw.data.settings);
      setWebhook(gw.data.webhookUrl ?? '');
    }
  }, [gw.data]);
  const methods = ['wallet', 'card', 'mobile_money', 'bank', 'virtual_card'];
  return (
    <Screen>
      <Header title="Payment gateway" />
      {settings && (
        <Card>
          <T bold>Accepted methods on checkout</T>
          <Row style={{ flexWrap: 'wrap' }}>
            {methods.map((m) => (
              <Chip
                key={m}
                label={m.replace('_', ' ')}
                selected={settings.methods.includes(m)}
                onPress={() => setSettings({ ...settings, methods: settings.methods.includes(m) ? settings.methods.filter((x: string) => x !== m) : [...settings.methods, m] })}
              />
            ))}
          </Row>
          <Input label="Success URL" value={settings.successUrl ?? ''} onChangeText={(v) => setSettings({ ...settings, successUrl: v || null })} autoCapitalize="none" />
          <Button
            title="Save"
            onPress={() =>
              api
                .put('/api/merchant/gateway', settings)
                .then(() => toast('Saved', 'success'))
                .catch((e) => toast(e.message, 'error'))
            }
          />
        </Card>
      )}
      <Card>
        <T bold>API keys</T>
        <T muted size={12}>
          Used by your website, app or the WooCommerce plugin. Keys are shown once.
        </T>
        {keys.data?.items.map((k) => (
          <KV
            key={k.id}
            k={k.label}
            v={
              <Row>
                <T mono size={12}>
                  {k.prefix}
                </T>
                <Button title="Revoke" small variant="ghost" onPress={() => api.del(`/api/merchant/api-keys/${k.id}`).then(keys.reload)} />
              </Row>
            }
          />
        ))}
        <Button
          title="Create API key"
          variant="secondary"
          onPress={() =>
            api.post<{ apiKey: any }>('/api/merchant/api-keys', { label: 'Mobile' }).then((r) => {
              setNewKey(r.apiKey);
              keys.reload();
            })
          }
        />
      </Card>
      <Card>
        <T bold>Webhook</T>
        <Input label="Webhook URL" value={webhook} onChangeText={setWebhook} autoCapitalize="none" placeholder="https://yourstore.com/wc-api/bitripay" />
        <Button
          title="Save webhook"
          variant="secondary"
          onPress={() =>
            api.put('/api/merchant/webhook', { url: webhook || null }).then(() => {
              toast('Saved', 'success');
              gw.reload();
            })
          }
        />
        {gw.data?.webhookSecret && (
          <KV
            k="Signing secret"
            v={
              <Row>
                <T mono size={11}>
                  {gw.data.webhookSecret.slice(0, 14)}…
                </T>
                <Button title="Copy" small variant="secondary" onPress={() => Clipboard.setStringAsync(gw.data.webhookSecret)} />
              </Row>
            }
          />
        )}
        <T muted size={12}>
          Full integration docs: {config?.webUrl}/app/merchant/gateway
        </T>
      </Card>
      <Sheet open={!!newKey} onClose={() => setNewKey(null)} title="Your new API key">
        <Alert kind="warning" text="Copy this key now – it won't be shown again." />
        <T mono size={12}>
          {newKey?.secret}
        </T>
        <Button title="Copy" onPress={() => Clipboard.setStringAsync(newKey.secret)} />
      </Sheet>
    </Screen>
  );
}

/** The till. Members of an agent's team (invited on the web Team tab) reach it with their own login and see the agent's float and queue. */
export function Agent() {
  const { t, user, money, wallets, memberships, toast, refreshWallets, config } = useStore();
  const [tab, setTab] = useState<'cashin' | 'cashout' | 'pickup' | 'requests' | 'payouts'>('cashin');
  const counter = memberships.find((m) => m.kind === 'agent' && !m.owner) ?? null;
  const stats = useAsync(() => api.get<any>('/api/agents/me/stats'), [tab]);
  const payouts = useAsync(() => (tab === 'payouts' ? api.get<{ items: any[] }>('/api/payouts/agent/queue') : Promise.resolve(null)), [tab]);
  const [ev, setEv] = useState<{ id: string; text: string; externalRef: string } | null>(null);
  const requests = useAsync(() => api.get<{ items: any[] }>('/api/agents/me/cash-requests'), [tab]);
  const [customer, setCustomer] = useState('');
  const [found, setFound] = useState<PublicUser | null>(null);
  const [amount, setAmount] = useState('');
  const [cur, setCur] = useState(wallets[0]?.currency || 'USD');
  const [code, setCode] = useState('');
  const [pickup, setPickup] = useState<any>(null);
  const [idNumber, setIdNumber] = useState('');
  const [pin, setPin] = useState<null | 'cashin' | 'cashout' | 'pickup'>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (customer.length < 3) return setFound(null);
    const id = setTimeout(
      () =>
        api
          .get<{ user: PublicUser }>(`/api/account/lookup?q=${encodeURIComponent(customer)}`)
          .then((r) => setFound(r.user))
          .catch(() => setFound(null)),
      350,
    );
    return () => clearTimeout(id);
  }, [customer]);
  const run = async (p: string) => {
    setLoading(true);
    try {
      if (pin === 'cashin') {
        await api.post('/api/agents/me/cash-in', { customer: found?.tag ?? customer, amount, currency: cur, pin: p });
        toast('Customer wallet credited', 'success');
        setAmount('');
      }
      if (pin === 'cashout') {
        await api.post('/api/agents/me/cash-out/confirm', { code, pin: p });
        toast('Confirmed – hand over the cash', 'success');
        setCode('');
      }
      if (pin === 'pickup') {
        await api.post(`/api/agents/me/pickups/${pickup.pickupCode}/payout`, { recipientIdNumber: idNumber, pin: p });
        toast('Pickup paid out', 'success');
        setPickup(null);
      }
      setPin(null);
      refreshWallets();
      stats.reload();
      requests.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
      setPin(null);
    } finally {
      setLoading(false);
    }
  };
  const s = stats.data;
  // A team member sees the agent's float, never their own wallet.
  const float: { currency: string; balance: number }[] = s?.float?.length ? s.float : wallets;
  return (
    <Screen>
      <Header title={s?.agent?.name || user?.businessName || t('nav.agentTools')} />
      {counter && (
        <Card>
          <T muted size={12}>
            You work at the counter of {counter.name} as {counter.role.replace(/_/g, ' ')}. Cash operations use the agent's float, record you as the operator and are confirmed with your own PIN.
          </T>
        </Card>
      )}
      <Row style={{ flexWrap: 'wrap' }}>
        <Card style={{ flexGrow: 1 }}>
          <T muted size={12}>
            Float
          </T>
          <T bold size={18}>
            {float[0] ? money(float[0].balance, float[0].currency) : '—'}
          </T>
        </Card>
        <Card style={{ flexGrow: 1 }}>
          <T muted size={12}>
            Commission (30d)
          </T>
          <T bold size={18}>
            {s ? money(s.commissionEarned, wallets[0]?.currency || 'USD') : '—'}
          </T>
          <T muted size={11}>
            {s?.cashInCount ?? 0} in · {s?.cashOutCount ?? 0} out
          </T>
        </Card>
      </Row>
      <Tabs
        tabs={[
          { id: 'cashin', label: 'Cash-in' },
          { id: 'cashout', label: 'Cash-out' },
          { id: 'pickup', label: 'Cash pickup' },
          { id: 'requests', label: 'Requests' },
          { id: 'payouts', label: 'Payouts' },
        ]}
        value={tab}
        onChange={(v) => setTab(v as any)}
      />
      {tab === 'payouts' && (
        <>
          <Alert text="Execute each payout from the merchant SIM (USSD / operator app). The forwarder app on that SIM submits the signed confirmation SMS; a transfer settles only on that evidence. Manual confirmations go to a second administrator." />
          {payouts.data?.items.length === 0 && <Empty icon="📤" text="Nothing queued for you" />}
          {(payouts.data?.items ?? []).map((p) => (
            <Card key={p.id}>
              <Row between>
                <View style={{ flex: 1 }}>
                  <T bold>
                    {money(p.amount, p.currency)} → {p.operatorName ?? p.rail} {p.recipientMsisdn ?? p.recipientMasked}
                  </T>
                  <T muted size={12}>
                    {p.recipientName ?? ''} · ref {p.reference}
                  </T>
                </View>
                <Status status={p.stage.toLowerCase().replace(/_/g, ' ')} />
              </Row>
              {p.instructions &&
                p.instructions.steps.map((st: string, i: number) => (
                  <T key={i} size={12}>
                    {i + 1}. {st}
                  </T>
                ))}
              <Row>
                {p.stage === 'QUEUED' && (
                  <Button
                    title="Start payout"
                    small
                    onPress={() =>
                      api
                        .post(`/api/payouts/agent/${p.id}/claim`)
                        .then(() => {
                          toast('Claimed – execute now', 'success');
                          payouts.reload();
                        })
                        .catch((e) => toast(e.message, 'error'))
                    }
                  />
                )}
                {p.stage === 'IN_PROGRESS' && (
                  <>
                    <Button title="Enter confirmation" small variant="secondary" onPress={() => setEv({ id: p.id, text: '', externalRef: '' })} />
                    <Button title="Give back" small variant="ghost" onPress={() => api.post(`/api/payouts/agent/${p.id}/release`, { reason: 'Could not execute' }).then(payouts.reload)} />
                  </>
                )}
              </Row>
            </Card>
          ))}
          {ev && (
            <Card>
              <T bold>Manual confirmation (needs a second administrator)</T>
              <Input label="Operator SMS, exactly as received" value={ev.text} onChangeText={(v) => setEv({ ...ev, text: v })} />
              <Input label="Operator transaction ID" value={ev.externalRef} onChangeText={(v) => setEv({ ...ev, externalRef: v })} />
              <Row>
                <Button
                  title="Submit"
                  small
                  disabled={ev.text.length < 5 || ev.externalRef.length < 4}
                  onPress={() =>
                    api
                      .post(`/api/payouts/agent/${ev.id}/evidence`, { text: ev.text, externalRef: ev.externalRef })
                      .then(() => {
                        toast('Submitted for approval', 'success');
                        setEv(null);
                        payouts.reload();
                      })
                      .catch((e) => toast(e.message, 'error'))
                  }
                />
                <Button title="Cancel" small variant="ghost" onPress={() => setEv(null)} />
              </Row>
            </Card>
          )}
        </>
      )}
      {tab === 'cashin' && (
        <Card>
          <T bold>Credit a customer's wallet</T>
          <Input label="Customer (@tag, email or phone)" value={customer} onChangeText={setCustomer} autoCapitalize="none" />
          {found && (
            <Row>
              <Avatar user={found} size={34} />
              <T bold>
                {found.fullName} (@{found.tag})
              </T>
            </Row>
          )}
          <AmountInput label={t('common.amount')} amount={amount} currency={cur} onAmount={setAmount} onCurrency={setCur} />
          <Button title="Confirm cash-in" disabled={!found || !amount} onPress={() => setPin('cashin')} />
        </Card>
      )}
      {tab === 'cashout' && (
        <Card>
          <T bold>Pay out cash</T>
          <T muted size={12}>
            Enter the code the customer shows you. Funds move to your float when you confirm.
          </T>
          <Input label="Cash-out code" value={code} onChangeText={(v) => setCode(v.toUpperCase())} autoCapitalize="characters" />
          <Button title="Confirm & pay cash" disabled={code.length < 4} onPress={() => setPin('cashout')} />
        </Card>
      )}
      {tab === 'pickup' && (
        <Card>
          <T bold>Remittance cash pickup</T>
          <Row>
            <View style={{ flex: 1 }}>
              <Input label="Pickup code" value={code} onChangeText={(v) => setCode(v.toUpperCase())} autoCapitalize="characters" />
            </View>
            <Button
              title="Look up"
              small
              variant="secondary"
              onPress={() =>
                api
                  .get<{ remittance: any }>(`/api/agents/me/pickups/${code}`)
                  .then((r) => setPickup(r.remittance))
                  .catch((e) => toast(e.message, 'error'))
              }
            />
          </Row>
          {pickup && (
            <>
              <KV k="Recipient" v={pickup.recipient?.name} />
              <KV k="Pay out" v={money(pickup.targetAmount, pickup.targetCurrency)} />
              <KV k="Status" v={<Status status={pickup.status} />} />
              {pickup.status === 'ready_for_pickup' && (
                <>
                  <Input label="Recipient ID number" value={idNumber} onChangeText={setIdNumber} />
                  <Button title={`Pay out ${money(pickup.targetAmount, pickup.targetCurrency)}`} onPress={() => setPin('pickup')} />
                </>
              )}
            </>
          )}
        </Card>
      )}
      {tab === 'requests' && (
        <>
          {requests.data?.items.length === 0 && <Empty icon="💵" />}
          {requests.data?.items.map((r) => (
            <Card key={r.id}>
              <Row between>
                <View>
                  <T bold>
                    {money(r.amount, r.currency)} · <T mono>{r.code}</T>
                  </T>
                  <T muted size={12}>
                    {r.customer?.fullName}
                  </T>
                </View>
                <Status status={r.status} />
              </Row>
              {r.status === 'pending' && (
                <Button
                  title="Confirm"
                  small
                  onPress={() => {
                    setCode(r.code);
                    setPin('cashout');
                  }}
                />
              )}
            </Card>
          ))}
        </>
      )}
      <Card style={{ alignItems: 'center' }}>
        <T bold>Your agent QR</T>
        <Qr value={`${config?.webUrl}/q?v=1&t=ag&id=${s?.agent?.tag ?? user?.tag}`} size={170} />
        <T muted size={12}>
          @{s?.agent?.tag ?? user?.tag}
        </T>
      </Card>
      <PinSheet open={!!pin} onClose={() => setPin(null)} onSubmit={run} loading={loading} />
    </Screen>
  );
}
