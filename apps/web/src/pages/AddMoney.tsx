import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { Alert, AmountInput, Button, Empty, Field, Input, KV, PageHeader, Select, StatusBadge, Tabs, useAsync } from '../components/ui';
import { CardForm, type CardValues } from '../components/CardForm';
import { StripePayment } from '../components/StripePayment';
import type { SavedCard } from '@bitripay/shared';

interface Operator { id: string; name: string; brand: string; country: string; currency: string; ussd: string | null; color: string; directRail: boolean }
interface Option { method: 'card' | 'mobile_money' | 'bank'; gateways: { id: string; name: string; provider: string; publishableKey: string | null }[]; fee: number; operators?: Operator[] }
export interface PaymentView { id: string; status: string; method: string; amount: number; currency: string; fee: number; failureReason: string | null; next: { type: string; url?: string; clientSecret?: string; publishableKey?: string; message?: string; instructions?: Record<string, string> } | null; gatewayName: string; createdAt: string }

export function AddMoney() {
  const t = useT();
  const { config, wallets, money, toast, refreshWallets, user } = useStore();
  const [params] = useSearchParams();
  const [cur, setCur] = useState(wallets[0]?.currency || config?.baseCurrency || 'USD');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'card' | 'mobile_money' | 'bank'>('card');
  const [gateway, setGateway] = useState('');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [operatorId, setOperatorId] = useState('');
  const [opCountry, setOpCountry] = useState(user?.country ?? '');
  const [card, setCard] = useState<CardValues>({ number: '', expMonth: '', expYear: '', cvc: '', holderName: user?.fullName ?? '' });
  const [savedCardId, setSavedCardId] = useState('');
  const [saveCard, setSaveCard] = useState(true);
  const [payment, setPayment] = useState<PaymentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [proof, setProof] = useState('');
  const options = useAsync(() => api.get<{ methods: Option[] }>(`/api/deposits/options?currency=${cur}`), [cur]);
  const cards = useAsync(() => api.get<{ items: SavedCard[] }>('/api/cards'), []);
  const history = useAsync(() => api.get<{ items: PaymentView[] }>('/api/deposits?pageSize=10'), [payment?.status]);
  const opt = options.data?.methods.find((m) => m.method === method);
  const gw = opt?.gateways.find((g) => g.id === gateway) ?? opt?.gateways[0];

  useEffect(() => {
    const id = params.get('payment');
    if (id) api.get<{ payment: PaymentView }>(`/api/deposits/${id}`).then((r) => setPayment(r.payment)).catch(() => {});
  }, [params]);
  useEffect(() => {
    if (options.data && !options.data.methods.find((m) => m.method === method)) setMethod(options.data.methods[0]?.method ?? 'card');
  }, [options.data, method]);

  // Poll pending payments (mobile money prompts, redirects)
  useEffect(() => {
    if (!payment || !['pending', 'initiated'].includes(payment.status) || payment.method === 'bank') return;
    const timer = setInterval(async () => {
      const r = await api.get<{ payment: PaymentView }>(`/api/deposits/${payment.id}`);
      setPayment(r.payment);
      if (r.payment.status === 'succeeded') {
        toast('Money added to your wallet', 'success');
        refreshWallets();
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [payment, refreshWallets, toast]);

  const submit = async () => {
    setError(null);
    setLoading(true);
    try {
      const body: Record<string, unknown> = { method, amount, currency: cur, gateway: method === 'mobile_money' ? undefined : gw?.id };
      if (method === 'card') {
        if (savedCardId) body.savedCardId = savedCardId;
        else if (gw?.provider !== 'stripe') {
          body.card = { number: card.number.replace(/\s/g, ''), expMonth: Number(card.expMonth), expYear: Number(card.expYear.length === 2 ? '20' + card.expYear : card.expYear), cvc: card.cvc, holderName: card.holderName };
          body.saveCard = saveCard;
        } else body.saveCard = saveCard;
      }
      if (method === 'mobile_money') {
        body.phone = phone;
        if (operatorId) body.operatorId = operatorId;
      }
      const r = await api.post<{ payment: PaymentView }>('/api/deposits', body);
      setPayment(r.payment);
      if (r.payment.status === 'succeeded') {
        toast('Money added to your wallet', 'success');
        refreshWallets();
        cards.reload();
      } else if (r.payment.next?.type === 'redirect' && r.payment.next.url) {
        window.location.href = r.payment.next.url;
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const methodLabels: Record<string, string> = { card: t('addMoney.card'), mobile_money: t('addMoney.mobileMoney'), bank: t('addMoney.bank') };

  return (
    <div>
      <PageHeader title={t('addMoney.title')} subtitle="Fund your wallet with a card, mobile money, bank transfer or cash at an agent" />
      <div className="grid cols-3">
        <div className="card" style={{ gridColumn: 'span 2' }}>
          {payment ? (
            <PaymentStatus payment={payment} onDone={() => setPayment(null)} proof={proof} setProof={setProof} onProof={async () => { const r = await api.post<{ payment: PaymentView }>(`/api/deposits/${payment.id}/proof`, { reference: proof }); setPayment(r.payment); toast('Proof submitted – we will confirm shortly', 'success'); }} />
          ) : (
            <>
              {error && <Alert kind="error">{error}</Alert>}
              <Field label={t('common.amount')}>
                <AmountInput amount={amount} currency={cur} onAmount={setAmount} onCurrency={setCur} big currencies={(config?.currencies ?? []).map((c) => c.code)} />
              </Field>
              <Field label={t('addMoney.method')}>
                <Tabs pills tabs={(options.data?.methods ?? []).map((m) => ({ id: m.method, label: methodLabels[m.method] }))} value={method} onChange={(m) => { setMethod(m as any); setGateway(''); }} />
              </Field>
              {options.data && options.data.methods.length === 0 && <Alert kind="warning">No payment gateway is configured for {cur}. Ask an admin to enable one, or use an agent.</Alert>}
              {opt && opt.gateways.length > 1 && (
                <Field label="Provider">
                  <Select value={gw?.id ?? ''} onChange={(e) => setGateway(e.target.value)}>
                    {opt.gateways.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </Select>
                </Field>
              )}
              {method === 'card' && (
                <>
                  {cards.data && cards.data.items.length > 0 && (
                    <Field label="Saved cards">
                      <div className="row wrap">
                        {cards.data.items.filter((c) => c.provider === gw?.provider).map((c) => (
                          <span key={c.id} className={`chip clickable ${savedCardId === c.id ? 'selected' : ''}`} onClick={() => setSavedCardId(savedCardId === c.id ? '' : c.id)}>
                            {c.brand} •••• {c.last4}
                          </span>
                        ))}
                      </div>
                    </Field>
                  )}
                  {!savedCardId && gw?.provider !== 'stripe' && <CardForm value={card} onChange={setCard} />}
                  {!savedCardId && gw?.provider === 'stripe' && <Alert kind="info">You'll enter your card securely on the next step (Stripe).</Alert>}
                  {!savedCardId && (
                    <label className="checkbox mb"><input type="checkbox" checked={saveCard} onChange={(e) => setSaveCard(e.target.checked)} /> Save this card for next time</label>
                  )}
                  {gw?.provider === 'sandbox' && <div className="alert info small">Sandbox: use 4242 4242 4242 4242 (any future expiry, any CVC). Cards ending 0002 are declined.</div>}
                </>
              )}
              {method === 'mobile_money' && (
                <>
                  <OperatorPicker value={operatorId} onChange={setOperatorId} country={opCountry} onCountry={setOpCountry} onCurrency={(c) => { if ((config?.currencies ?? []).some((x) => x.code === c)) setCur(c); }} />
                  <Field label="Your mobile money number">
                    <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+233…" />
                  </Field>
                </>
              )}
              {method === 'bank' && <Alert kind="info">You'll receive bank details and a reference. Your wallet is credited once the transfer is confirmed.</Alert>}
              {amount && opt && (
                <div className="card soft compact mb">
                  <KV k={t('common.fee')} v={<FeeEstimate amount={amount} currency={cur} method={method} />} />
                </div>
              )}
              <Button block size="lg" loading={loading} disabled={!amount || !opt || (method === 'mobile_money' && !phone)} onClick={submit}>
                Add {amount ? `${amount} ${cur}` : 'money'}
              </Button>
              {config?.modules.agents !== false && (
                <p className="center small muted mt">Prefer cash? <Link to="/app/agents">Find an agent near you</Link> for a cash-in.</p>
              )}
            </>
          )}
        </div>
        <div className="card">
          <h3>Recent deposits</h3>
          {history.data?.items.length === 0 && <Empty icon="💳" />}
          <div className="list">
            {history.data?.items.map((p) => (
              <div key={p.id} className="list-item clickable" onClick={() => setPayment(p)}>
                <div className="flex1">
                  <div className="main-text">{money(p.amount, p.currency)}</div>
                  <div className="sub-text">{p.gatewayName} · {p.method.replace('_', ' ')} · {new Date(p.createdAt).toLocaleDateString()}</div>
                </div>
                <StatusBadge status={p.status} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Picks any mobile money operator in the world; operators with a collection number use the direct rail (no API). */
export function OperatorPicker({ value, onChange, country, onCountry, onCurrency }: { value: string; onChange: (id: string) => void; country: string; onCountry: (c: string) => void; onCurrency?: (currency: string) => void }) {
  const { config } = useStore();
  const ops = useAsync(() => api.get<{ items: Operator[] }>(`/api/mobile-money-operators${country ? `?country=${country}` : ''}`), [country]);
  const list = ops.data?.items ?? [];
  const countriesWithOps = new Set((config?.countries ?? []).map((c) => c.code));
  return (
    <>
      <div className="grid cols-2">
        <Field label="Country">
          <Select value={country} onChange={(e) => { onCountry(e.target.value); onChange(''); }}>
            <option value="">All countries</option>
            {(config?.countries ?? []).filter((c) => countriesWithOps.has(c.code)).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Mobile money operator" hint={value && list.find((o) => o.id === value)?.directRail ? 'Direct rail: pay from your own mobile money app with a reference' : value ? 'Routed through a connected gateway or the sandbox' : undefined}>
          <Select value={value} onChange={(e) => { onChange(e.target.value); const o = list.find((x) => x.id === e.target.value); if (o && onCurrency) onCurrency(o.currency); }}>
            <option value="">Choose operator…</option>
            {list.map((o) => <option key={o.id} value={o.id}>{o.name} · {o.country} ({o.currency})</option>)}
          </Select>
        </Field>
      </div>
      {value && (() => { const o = list.find((x) => x.id === value); return o ? <div className="row wrap mb"><span className="chip" style={{ background: o.color, color: '#fff' }}>{o.brand}</span>{o.ussd && <span className="chip">USSD {o.ussd}</span>}<span className="chip">{o.currency}</span>{o.directRail && <span className="chip success">no API needed</span>}</div> : null; })()}
    </>
  );
}

function FeeEstimate({ amount, currency, method }: { amount: string; currency: string; method: string }) {
  const { money } = useStore();
  const type = method === 'card' ? 'card_deposit' : method === 'mobile_money' ? 'mobile_money_deposit' : 'bank_deposit';
  const fee = useAsync(() => api.get<{ fee: number }>(`/api/transfers/fee?amount=${amount}&currency=${currency}&type=${type}`), [amount, currency, type]);
  return <>{fee.data ? `${money(fee.data.fee, currency)} (deducted from the amount)` : '…'}</>;
}

export function PaymentStatus({ payment, onDone, proof, setProof, onProof }: { payment: PaymentView; onDone: () => void; proof?: string; setProof?: (v: string) => void; onProof?: () => void }) {
  const { money } = useStore();
  const [stripeDone, setStripeDone] = useState(false);
  return (
    <div>
      <div className="center">
        <div style={{ fontSize: '3rem' }}>{payment.status === 'succeeded' ? '✅' : payment.status === 'failed' ? '❌' : '⏳'}</div>
        <h2>{money(payment.amount, payment.currency)}</h2>
        <StatusBadge status={payment.status} />
        <p className="muted small mt-sm">{payment.gatewayName} · {payment.method.replace('_', ' ')}</p>
      </div>
      {payment.failureReason && <Alert kind="error">{payment.failureReason}</Alert>}
      {payment.status !== 'succeeded' && payment.status !== 'failed' && payment.next?.type === 'prompt' && <Alert kind="info">{payment.next.message} <span className="spinner" style={{ verticalAlign: 'middle', marginLeft: 8 }} /></Alert>}
      {payment.status !== 'succeeded' && payment.next?.type === 'stripe_payment_intent' && payment.next.clientSecret && !stripeDone && (
        <StripePayment clientSecret={payment.next.clientSecret} publishableKey={payment.next.publishableKey!} onComplete={() => setStripeDone(true)} />
      )}
      {payment.status !== 'succeeded' && payment.next?.type === 'redirect' && payment.next.url && (
        <a className="btn block" href={payment.next.url}>Continue to {payment.gatewayName}</a>
      )}
      {payment.status !== 'succeeded' && payment.status !== 'failed' && payment.next?.type === 'bank_instructions' && (
        <div>
          <Alert kind="info">{payment.next.message}</Alert>
          <div className="card soft compact">
            {Object.entries(payment.next.instructions ?? {}).map(([k, v]) => <KV key={k} k={k} v={<span className="mono">{v}</span>} />)}
          </div>
          {setProof && onProof && (
            <div className="mt">
              <Field label={payment.method === 'mobile_money' ? 'Transaction ID from your mobile money receipt' : 'Transfer reference / proof (optional)'}>
                <div className="row">
                  <Input value={proof} onChange={(e) => setProof(e.target.value)} placeholder={payment.method === 'mobile_money' ? 'e.g. MP240911.1234.A12345' : 'Bank reference number'} />
                  <Button variant="secondary" onClick={onProof}>Submit</Button>
                </div>
              </Field>
            </div>
          )}
        </div>
      )}
      <Button block variant="secondary" className="mt" onClick={onDone}>{payment.status === 'succeeded' || payment.status === 'failed' ? 'Done' : 'Back'}</Button>
    </div>
  );
}
