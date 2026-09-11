import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { Alert, AmountInput, Avatar, Button, Empty, Field, Input, KV, PageHeader, PinModal, RouteDisclosure, Select, StatusBadge, Tabs, useAsync, useDebounce } from '../components/ui';
import { CardForm, type CardValues } from '../components/CardForm';
import { OperatorPicker, PaymentStatus, type PaymentView } from './AddMoney';
import type { BankAccount } from '@bitripay/shared';

type Source = 'wallet' | 'card' | 'mobile_money' | 'bank';
type Dest = 'wallet' | 'qr' | 'mobile_money' | 'bank' | 'agent';

/** Any → any: fund from card / bank / mobile money / wallet and deliver to a wallet, QR code, bank account, mobile money number or agent. */
export function MoveMoney() {
  const t = useT();
  const nav = useNavigate();
  const { user, wallets, config, money, toast, refreshWallets } = useStore();
  const [source, setSource] = useState<Source>('wallet');
  const [dest, setDest] = useState<Dest>('wallet');
  const [amount, setAmount] = useState('');
  const [cur, setCur] = useState(wallets[0]?.currency || config?.baseCurrency || 'USD');
  const [target, setTarget] = useState('');
  const [to, setTo] = useState('');
  const [qr, setQr] = useState('');
  const [srcOp, setSrcOp] = useState({ operatorId: '', country: user?.country ?? '', phone: user?.phone ?? '' });
  const [dstOp, setDstOp] = useState({ operatorId: '', country: '', phone: '', name: '' });
  const [bank, setBank] = useState({ bankAccountId: '', bankName: '', accountName: '', accountNumber: '', country: '' });
  const [agent, setAgent] = useState('');
  const [card, setCard] = useState<CardValues>({ number: '', expMonth: '', expYear: '', cvc: '', holderName: user?.fullName ?? '' });
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState<any>(null);
  const accounts = useAsync(() => api.get<{ items: BankAccount[] }>('/api/bank-accounts'), []);
  const history = useAsync(() => api.get<{ items: any[] }>('/api/money'), [route?.status]);
  const dAmount = useDebounce(amount, 350);
  const dTo = useDebounce(to, 350);
  const dQr = useDebounce(qr, 350);

  const destination = () => {
    switch (dest) {
      case 'wallet': return { method: 'wallet', to, note: note || null };
      case 'qr': return { method: 'qr', data: qr, note: note || null };
      case 'mobile_money': return { method: 'mobile_money', operatorId: dstOp.operatorId, phone: dstOp.phone, name: dstOp.name || null };
      case 'bank': return bank.bankAccountId ? { method: 'bank', bankAccountId: bank.bankAccountId } : { method: 'bank', bankName: bank.bankName, accountName: bank.accountName, accountNumber: bank.accountNumber, country: bank.country || null };
      case 'agent': return { method: 'agent', agent };
    }
  };
  const destReady = dest === 'wallet' ? dTo.length >= 3 : dest === 'qr' ? dQr.length > 3 : dest === 'mobile_money' ? !!dstOp.operatorId && dstOp.phone.length > 5 : dest === 'bank' ? !!bank.bankAccountId || (!!bank.bankName && !!bank.accountNumber) : agent.length >= 2;

  useEffect(() => {
    if (!dAmount || !destReady) return setPreview(null);
    api.post<any>('/api/money/preview', { destination: destination(), sourceMethod: source, amount: dAmount, currency: cur, targetCurrency: target || cur })
      .then((r) => { setPreview(r); setPreviewError(null); })
      .catch((e) => { setPreview(null); setPreviewError(e.message); });
  }, [dAmount, cur, target, source, dest, dTo, dQr, dstOp.operatorId, dstOp.phone, bank.bankAccountId, bank.bankName, bank.accountNumber, agent]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!route || !['funding', 'authentication_required'].includes(route.status)) return;
    const id = setInterval(async () => {
      const r = await api.get<{ route: any }>(`/api/money/${route.id}`);
      if (r.route.status !== route.status || r.route.payment?.stage !== route.payment?.stage) setRoute(r.route);
      if (!['funding', 'authentication_required'].includes(r.route.status)) { refreshWallets(); history.reload(); }
    }, route.payment?.next?.type === 'bank_instructions' ? 10000 : 3000);
    return () => clearInterval(id);
  }, [route]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (pin?: string) => {
    setLoading(true);
    setError(null);
    try {
      const src: any = { method: source };
      if (source === 'card') src.card = { number: card.number.replace(/\s/g, ''), expMonth: Number(card.expMonth), expYear: Number(card.expYear.length === 2 ? '20' + card.expYear : card.expYear), cvc: card.cvc, holderName: card.holderName };
      if (source === 'mobile_money') { src.operatorId = srcOp.operatorId || null; src.phone = srcOp.phone; }
      if (source !== 'wallet') src.returnUrl = `${window.location.origin}/app/move`;
      const r = await api.post<{ route: any }>('/api/money', { source: src, destination: destination(), amount, currency: cur, targetCurrency: target || null, note: note || null, pin: pin || undefined, quoteId: preview?.fx?.quoteId ?? null });
      setRoute(r.route);
      setPinOpen(false);
      refreshWallets();
      history.reload();
      if (r.route.status === 'completed') toast('Money delivered', 'success');
      else if (r.route.payment?.next?.type === 'redirect' && r.route.payment.next.url) window.location.href = r.route.payment.next.url;
    } catch (err) {
      setError((err as Error).message);
      setPinOpen(false);
    } finally {
      setLoading(false);
    }
  };
  const wallet = wallets.find((w) => w.currency === cur);
  const sourceLabels: Record<Source, string> = { wallet: '👛 My wallet', card: '💳 Card', mobile_money: '📱 Mobile money', bank: '🏦 Bank transfer' };
  const destLabels: Record<Dest, string> = { wallet: '👛 BitriPay user', qr: '🔳 QR code / link', mobile_money: '📱 Mobile money', bank: '🏦 Bank account', agent: '💵 Cash at agent' };

  return (
    <div>
      <PageHeader title="Move money" subtitle="Fund from a card, bank, mobile money or your wallet and deliver to a wallet, QR code, bank account, mobile money number or agent. The BitriPay ledger coordinates both legs; external legs move only through your own bank, operator or a licensed processor and are credited or paid out after independent confirmation." />
      <div className="grid cols-3">
        <div className="card" style={{ gridColumn: 'span 2' }}>
          {route ? (
            <div>
              <div className="center">
                <div style={{ fontSize: '3rem' }}>{route.status === 'completed' ? '✅' : route.status === 'failed' ? '❌' : '⏳'}</div>
                <h2>{money(route.amount, route.currency)} → {destLabels[route.destination as Dest]}</h2>
                <StatusBadge status={route.status} />
                {route.error && <Alert kind="error">{route.error}</Alert>}
              </div>
              {['funding', 'authentication_required'].includes(route.status) && route.payment && <div className="mt"><PaymentStatus payment={route.payment as PaymentView} onDone={() => {}} /></div>}
              {route.status === 'authentication_required' && <Alert kind="warning">This transfer was not authorised. Start again and confirm with biometrics or your PIN.</Alert>}
              {route.status === 'pending' && <Alert kind="info">Your money arrived and the payout is queued. Bank and mobile money payouts are completed by our team or a local agent, usually within a business day.</Alert>}
              {route.destinationDetails?.cashOutCode && <Alert kind="success">Cash-out code for the agent: <b className="mono">{route.destinationDetails.cashOutCode}</b></Alert>}
              {route.status === 'funded' && <Button onClick={() => api.post(`/api/money/${route.id}/retry`, {}).then((r: any) => setRoute(r.route)).catch((e) => setError(e.message))}>Retry payout</Button>}
              <div className="row mt"><Button variant="secondary" onClick={() => setRoute(null)}>New transfer</Button>{route.payoutTransactionId && <Button variant="ghost" onClick={() => nav(`/app/transactions/${route.payoutTransactionId}`)}>View transaction</Button>}</div>
            </div>
          ) : (
            <>
              {error && <Alert kind="error">{error}</Alert>}
              <Field label="From"><Tabs pills tabs={(Object.keys(sourceLabels) as Source[]).map((k) => ({ id: k, label: sourceLabels[k] }))} value={source} onChange={(v) => setSource(v as Source)} /></Field>
              {source === 'card' && <CardForm value={card} onChange={setCard} />}
              {source === 'mobile_money' && <><OperatorPicker value={srcOp.operatorId} onChange={(id) => setSrcOp({ ...srcOp, operatorId: id })} country={srcOp.country} onCountry={(c) => setSrcOp({ ...srcOp, country: c })} onCurrency={(c) => { if ((config?.currencies ?? []).some((x) => x.code === c)) setCur(c); }} /><Field label="Your mobile money number"><Input value={srcOp.phone} onChange={(e) => setSrcOp({ ...srcOp, phone: e.target.value })} /></Field></>}
              {source === 'bank' && <Alert kind="info">You'll get bank details and a reference; the transfer continues automatically once the deposit is confirmed.</Alert>}
              <Field label={t('common.amount')} hint={source === 'wallet' && wallet ? `${t('common.balance')}: ${money(wallet.balance, wallet.currency)}` : undefined}>
                <AmountInput amount={amount} currency={cur} onAmount={setAmount} onCurrency={setCur} big currencies={(config?.currencies ?? []).map((c) => c.code)} />
              </Field>
              <Field label="To"><Tabs pills tabs={(Object.keys(destLabels) as Dest[]).map((k) => ({ id: k, label: destLabels[k] }))} value={dest} onChange={(v) => setDest(v as Dest)} /></Field>
              {dest === 'wallet' && <Field label="Recipient (@tag, email or phone)"><Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="@alice" /></Field>}
              {dest === 'qr' && <Field label="QR content or payment link" hint="Paste the link from a payment request or a scanned QR code"><Input value={qr} onChange={(e) => setQr(e.target.value)} placeholder="https://…/pay/CODE or bitripay://pay?…" /></Field>}
              {dest === 'mobile_money' && <><OperatorPicker value={dstOp.operatorId} onChange={(id) => setDstOp({ ...dstOp, operatorId: id })} country={dstOp.country} onCountry={(c) => setDstOp({ ...dstOp, country: c })} /><div className="grid cols-2"><Field label="Recipient mobile money number"><Input value={dstOp.phone} onChange={(e) => setDstOp({ ...dstOp, phone: e.target.value })} /></Field><Field label="Recipient name"><Input value={dstOp.name} onChange={(e) => setDstOp({ ...dstOp, name: e.target.value })} /></Field></div></>}
              {dest === 'bank' && (
                <>
                  {accounts.data && accounts.data.items.length > 0 && <Field label="My saved bank accounts"><Select value={bank.bankAccountId} onChange={(e) => setBank({ ...bank, bankAccountId: e.target.value })}><option value="">Enter another account…</option>{accounts.data.items.map((a) => <option key={a.id} value={a.id}>{a.bankName} · {a.accountName} · {a.currency}</option>)}</Select></Field>}
                  {!bank.bankAccountId && <div className="grid cols-2"><Field label="Bank name"><Input value={bank.bankName} onChange={(e) => setBank({ ...bank, bankName: e.target.value })} /></Field><Field label="Account holder"><Input value={bank.accountName} onChange={(e) => setBank({ ...bank, accountName: e.target.value })} /></Field><Field label="Account number / IBAN"><Input value={bank.accountNumber} onChange={(e) => setBank({ ...bank, accountNumber: e.target.value })} /></Field><Field label="Country"><Select value={bank.country} onChange={(e) => setBank({ ...bank, country: e.target.value })}><option value="">—</option>{(config?.countries ?? []).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</Select></Field></div>}
                </>
              )}
              {dest === 'agent' && <Field label="Agent (@tag)"><Input value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="@kwameagent" /></Field>}
              <div className="grid cols-2">
                <Field label="Deliver in currency"><Select value={target} onChange={(e) => setTarget(e.target.value)}><option value="">Same as sent ({cur})</option>{(config?.currencies ?? []).map((c) => <option key={c.code} value={c.code}>{c.code} – {c.name}</option>)}</Select></Field>
                <Field label={t('common.note')}><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              </div>
              {previewError && <Alert kind="warning">{previewError}</Alert>}
              {preview && (
                <div className="card soft compact mb">
                  <div className="row mb-sm">{preview.destination.user && <Avatar user={preview.destination.user} size="sm" />}<b>{preview.destination.label}</b>{preview.destination.instant ? <span className="chip success">instant</span> : <span className="chip warning">payout within a business day</span>}</div>
                  {preview.quote.fundingFee > 0 && <KV k="Funding fee" v={money(preview.quote.fundingFee, preview.quote.currency)} />}
                  {preview.quote.exchangeFee > 0 && <KV k="Exchange fee" v={money(preview.quote.exchangeFee, preview.quote.currency)} />}
                  {preview.quote.rate !== 1 && <KV k="Rate" v={`1 ${preview.quote.currency} = ${preview.quote.rate.toFixed(4)} ${preview.quote.targetCurrency}`} />}
                  {preview.quote.payoutFee > 0 && <KV k="Payout fee" v={money(preview.quote.payoutFee, preview.quote.targetCurrency)} />}
                  <KV k="Recipient gets" v={<b style={{ color: 'var(--success)' }}>{money(preview.quote.targetAmount, preview.quote.targetCurrency)}</b>} />
                  {preview.quote.fx && !preview.quote.fx.guaranteed && preview.quote.fx.sourceCurrency !== preview.quote.fx.targetCurrency && <div className="tiny muted">Indicative rate ({preview.quote.fx.providerLabel}). The amount received may differ.</div>}
                </div>
              )}
              {preview && <RouteDisclosure declaration={preview.declaration} fx={preview.fx} />}
              <Button block size="lg" loading={loading} disabled={!preview || !amount || (source === 'card' && card.number.length < 12) || (source === 'mobile_money' && !srcOp.phone)} onClick={() => setPinOpen(true)}>
                🔐 Confirm and {source === 'wallet' ? 'send' : `pay ${amount ? `${amount} ${cur}` : ''} and deliver`}
              </Button>
            </>
          )}
        </div>
        <div className="card">
          <h3>Recent movements</h3>
          {history.data?.items.length === 0 && <Empty icon="🔀" />}
          <div className="list">
            {history.data?.items.slice(0, 12).map((r) => (
              <div key={r.id} className="list-item clickable" onClick={() => setRoute(r)}>
                <div className="flex1"><div className="main-text">{money(r.amount, r.currency)}</div><div className="sub-text">{sourceLabels[r.source as Source]} → {destLabels[r.destination as Dest]} · {new Date(r.createdAt).toLocaleDateString()}</div></div>
                <StatusBadge status={r.status} />
              </div>
            ))}
          </div>
        </div>
      </div>
      <PinModal open={pinOpen} onClose={() => setPinOpen(false)} onSubmit={(pin) => submit(pin)} loading={loading} title="Authorise this transfer" summary={preview && <KV k={`Send to ${preview.destination.label}`} v={money(preview.quote.targetAmount, preview.quote.targetCurrency)} />} />
    </div>
  );
}
