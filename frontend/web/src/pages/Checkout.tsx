import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { Alert, Avatar, Button, Field, Input, KV, Loading, PinModal, QrImage, StatusBadge, Tabs } from '../components/ui';
import { CardForm, type CardValues } from '../components/CardForm';
import { PaymentStatus, type PaymentView } from './AddMoney';
import { formatMoney, type PaymentRequest } from '@bitripay/shared';
import { OperatorPicker } from './AddMoney';

/** Hosted checkout page for payment links, invoices and API-created requests (guest friendly). */
export function Checkout() {
  const { code } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const t = useT();
  const { user, wallets, refreshWallets, config } = useStore();
  const [info, setInfo] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<string>('');
  const [card, setCard] = useState<CardValues>({ number: '', expMonth: '', expYear: '', cvc: '', holderName: '' });
  const [email, setEmail] = useState(user?.email ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [payment, setPayment] = useState<PaymentView | null>(null);
  const [done, setDone] = useState<any>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [amount, setAmount] = useState('');
  const [operatorId, setOperatorId] = useState('');
  const [opCountry, setOpCountry] = useState('');
  const [declaration, setDeclaration] = useState<any>(null);
  const [pinFor, setPinFor] = useState<'wallet' | 'external' | 'authenticate'>('wallet');

  const load = () =>
    api
      .get<any>(`/api/checkout/${code}`)
      .then((r) => {
        setInfo(r);
        if (!method) setMethod(r.methods[0] ?? 'wallet');
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const pid = params.get('payment');
    if (pid)
      api
        .get<{ payment: PaymentView }>(`/api/checkout/${code}/payments/${pid}`)
        .then((r) => setPayment(r.payment))
        .catch(() => {});
  }, [params, code]);
  useEffect(() => {
    if (!payment || !['pending', 'initiated'].includes(payment.status) || payment.stage === 'AUTHENTICATION_REQUIRED') return;
    const t = setInterval(
      () =>
        api.get<{ payment: PaymentView; paymentRequest: PaymentRequest }>(`/api/checkout/${code}/payments/${payment.id}`).then((r) => {
          if (r.payment.stage !== payment.stage) setPayment(r.payment);
          if (r.payment.status === 'succeeded') {
            setDone(r.paymentRequest);
            load();
          }
        }),
      payment.next?.type === 'bank_instructions' ? 10000 : 3000,
    );
    return () => clearInterval(t);
  }, [payment, code]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error)
    return (
      <div className="auth-page">
        <div className="card">
          <Alert kind="error">{error}</Alert>
          <Link to="/">Go to BitriPay</Link>
        </div>
      </div>
    );
  if (!info) return <Loading />;
  const pr: PaymentRequest = info.paymentRequest;
  const cur = info.currency;
  const merchant = info.merchant;
  const fixed = pr.amount != null;
  const money = (m: number) => formatMoney(m, cur);
  const successUrl = pr.successUrl || null;

  const cardBody = () => ({
    number: card.number.replace(/\s/g, ''),
    expMonth: Number(card.expMonth),
    expYear: Number(card.expYear.length === 2 ? '20' + card.expYear : card.expYear),
    cvc: card.cvc,
    holderName: card.holderName,
  });
  /** Guests are authenticated by the rail itself (3-D Secure, their operator app); signed-in payers confirm with biometrics or PIN first. */
  const payExternal = async (pin?: string) => {
    setLoading(true);
    setError(null);
    try {
      const body: any = {
        method,
        email: email || undefined,
        phone: phone || undefined,
        operatorId: operatorId || undefined,
        name: card.holderName || user?.fullName || undefined,
        returnUrl: window.location.href.split('?')[0],
        pin: pin || undefined,
      };
      if (method === 'card' || method === 'virtual_card') body.card = cardBody();
      const r = await api.post<any>(`/api/checkout/${code}/pay`, body);
      setPinOpen(false);
      if (r.declaration) setDeclaration(r.declaration);
      if (r.status === 'succeeded') {
        setDone(r.paymentRequest);
        load();
      } else {
        setPayment(r.payment);
        if (r.payment.status === 'succeeded') {
          setDone(r.paymentRequest);
          load();
        } else if (r.payment.next?.type === 'redirect' && r.payment.next.url) window.location.href = r.payment.next.url;
      }
    } catch (err) {
      setError((err as Error).message);
      setPinOpen(false);
    } finally {
      setLoading(false);
    }
  };
  const authenticate = async (pin: string) => {
    if (!payment) return;
    setLoading(true);
    try {
      const body: any = { pin: pin || undefined };
      if (payment.method === 'card') body.card = cardBody();
      const r = await api.post<any>(`/api/checkout/${code}/payments/${payment.id}/authenticate`, body);
      setPinOpen(false);
      setPayment(r.payment);
      if (r.payment.status === 'succeeded') {
        setDone(r.paymentRequest);
        load();
      } else if (r.payment.next?.type === 'redirect' && r.payment.next.url) window.location.href = r.payment.next.url;
    } catch (err) {
      setError((err as Error).message);
      setPinOpen(false);
    } finally {
      setLoading(false);
    }
  };
  const startExternal = () => {
    if (user) {
      setPinFor('external');
      setPinOpen(true);
    } else void payExternal();
  };
  const payWallet = async (pin: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.post<any>(`/api/checkout/${code}/wallet`, { pin, amount: fixed ? undefined : amount });
      setDone(r.paymentRequest);
      setPinOpen(false);
      refreshWallets();
    } catch (err) {
      setError((err as Error).message);
      setPinOpen(false);
    } finally {
      setLoading(false);
    }
  };
  const wallet = wallets.find((w) => w.currency === cur.code);
  const labels: Record<string, string> = { wallet: 'BitriPay wallet', card: 'Card', mobile_money: 'Mobile money', bank: 'Bank transfer', virtual_card: 'BitriPay virtual card' };
  /** What the payer sees before confirming: fee, FX rate + margin, receiver currency and exact amount, total, ETA per method (from the API, never computed here). */
  const disclosure = info.disclosure ?? null;
  const receiverCur = disclosure
    ? ((config?.currencies ?? []).find((c) => c.code === disclosure.receiverCurrency) ?? { code: disclosure.receiverCurrency, symbol: disclosure.receiverCurrency, decimals: 2 })
    : cur;
  const crossCurrency = !!disclosure && disclosure.receiverCurrency !== cur.code;
  const methodLabel = (m: string) => labels[m] ?? m.replace(/_/g, ' ');
  /** Recovery after a failed attempt: the other eligible methods and a one-tap retry of the same one. */
  const failed = !!payment && payment.status === 'failed';
  const alternatives: string[] = failed ? (info.methods as string[]).filter((m) => m !== payment!.method && (m !== 'wallet' || !!user)) : [];
  const retrySame = () => {
    setPayment(null);
    setError(null);
    setPinFor('external');
    if (user) setPinOpen(true);
    else void payExternal();
  };
  const retryWith = (m: string) => {
    setPayment(null);
    setError(null);
    setMethod(m);
  };
  const disclosureBlock = disclosure && (
    <div className="card soft compact mb" data-testid="checkout-disclosure">
      <div className="small bold mb-sm">{t('checkout.disclosureTitle')}</div>
      {disclosure.feeMinor != null && <KV k={disclosure.feeFrom === 'receiver' ? t('checkout.feePaidByReceiver') : 'Fee'} v={money(disclosure.feeMinor)} />}
      {crossCurrency && (
        <>
          <KV k={t('checkout.fxRate')} v={`1 ${cur.code} = ${Number(disclosure.fxRate).toFixed(6)} ${disclosure.receiverCurrency} · ${disclosure.fxProvider}`} />
          <KV k={t('checkout.fxMargin')} v={`${(disclosure.fxMarginBps / 100).toFixed(2)}% (mid 1 ${cur.code} = ${Number(disclosure.fxMidRate).toFixed(6)} ${disclosure.receiverCurrency})`} />
        </>
      )}
      <KV k={t('checkout.receiverCurrency')} v={disclosure.receiverCurrency} />
      {disclosure.receiverAmountMinor != null && <KV k={t('checkout.receiverGets')} v={formatMoney(disclosure.receiverAmountMinor, receiverCur)} />}
      {disclosure.totalMinor != null && <KV k={t('checkout.youPay')} v={<b>{money(disclosure.totalMinor)}</b>} />}
      {disclosure.etaByMethod?.[method] && <KV k={t('checkout.eta')} v={`${methodLabel(method)} · ${disclosure.etaByMethod[method]}`} />}
      <p className="tiny muted mt-sm" data-testid="checkout-trust">
        {t('trust.notProof')}
      </p>
    </div>
  );

  return (
    <div className="auth-page" style={{ alignItems: 'flex-start', paddingTop: 40 }}>
      <div style={{ width: '100%', maxWidth: 900 }}>
        <div className="grid cols-2">
          <div className="card" style={{ borderTop: `6px solid ${merchant.brandColor}` }}>
            <div className="list-item">
              {merchant.logoUrl ? <img src={merchant.logoUrl} alt="" style={{ height: 40, borderRadius: 8 }} /> : <Avatar user={merchant} size="lg" />}
              <div>
                <div className="main-text" style={{ fontSize: '1.15rem' }}>
                  {merchant.businessName || merchant.fullName}
                </div>
                <div className="sub-text">
                  @{merchant.tag} {merchant.testMode && <span className="chip warning">test mode</span>}
                </div>
              </div>
            </div>
            <h1 className="mt" style={{ fontSize: '2.4rem' }}>
              {fixed ? money(pr.amount!) : `Any amount (${cur.code})`}
            </h1>
            <p className="muted">{pr.description}</p>
            <KV k="Reference" v={<span className="mono">{pr.code}</span>} />
            <KV k="Status" v={<StatusBadge status={pr.status} />} />
            {pr.expiresAt && <KV k="Expires" v={new Date(pr.expiresAt).toLocaleString()} />}
            <div className="center mt">
              <QrImage value={pr.link!} size={160} />
              <div className="tiny muted mt-sm">Scan with the BitriPay app</div>
            </div>
          </div>
          <div className="card">
            {done || pr.status === 'paid' ? (
              <div className="center">
                <div style={{ fontSize: '4rem' }}>✅</div>
                <h2>Payment complete</h2>
                <p className="muted">Thank you! {merchant.businessName || merchant.fullName} has received your payment.</p>
                {successUrl && (
                  <a className="btn block" href={successUrl}>
                    Return to merchant
                  </a>
                )}
                {!successUrl && user && (
                  <Button block variant="secondary" onClick={() => nav('/app')}>
                    Back to BitriPay
                  </Button>
                )}
              </div>
            ) : pr.status !== 'open' ? (
              <Alert kind="warning">
                This payment request is {pr.status}.
                {pr.cancelUrl && (
                  <>
                    {' '}
                    <a href={pr.cancelUrl}>Back to merchant</a>
                  </>
                )}
              </Alert>
            ) : payment ? (
              <>
                <PaymentStatus
                  payment={payment}
                  declaration={declaration}
                  onDone={() => setPayment(null)}
                  onAuthenticate={
                    payment.stage === 'AUTHENTICATION_REQUIRED'
                      ? () => {
                          setPinFor('authenticate');
                          setPinOpen(true);
                        }
                      : undefined
                  }
                />
                {failed && (
                  <div className="card soft compact mt" data-testid="checkout-recovery">
                    <div className="small bold">{t('checkout.recoveryTitle')}</div>
                    <p className="tiny muted">{t('checkout.recoveryHint')}</p>
                    <div className="row wrap">
                      <Button size="sm" loading={loading} onClick={retrySame}>
                        {t('checkout.retry')} · {methodLabel(payment.method)}
                      </Button>
                      {alternatives.map((m) => (
                        <Button key={m} size="sm" variant="secondary" onClick={() => retryWith(m)}>
                          {t('checkout.retryWith', { method: methodLabel(m) })}
                        </Button>
                      ))}
                    </div>
                    <p className="tiny muted mt-sm">{t('trust.notProof')}</p>
                  </div>
                )}
              </>
            ) : (
              <>
                <h3>Pay with</h3>
                {error && <Alert kind="error">{error}</Alert>}
                <Tabs pills tabs={info.methods.map((m: string) => ({ id: m, label: labels[m] ?? m }))} value={method} onChange={setMethod} />
                <div className="mt" />
                {disclosureBlock}
                {method === 'wallet' &&
                  (user ? (
                    <>
                      {!fixed && (
                        <Field label={`Amount (${cur.code})`}>
                          <Input className="amount-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
                        </Field>
                      )}
                      <KV k="Your balance" v={wallet ? money(wallet.balance) : `No ${cur.code} wallet`} />
                      <Button
                        block
                        size="lg"
                        className="mt"
                        disabled={!wallet || (fixed ? wallet.balance < pr.amount! : !amount)}
                        onClick={() => {
                          setPinFor('wallet');
                          setPinOpen(true);
                        }}
                      >
                        Pay {fixed ? money(pr.amount!) : ''} from wallet
                      </Button>
                    </>
                  ) : (
                    <div className="center">
                      <p className="muted">Sign in to pay from your BitriPay wallet.</p>
                      <Link className="btn block" to={`/login?next=${encodeURIComponent(window.location.pathname)}`}>
                        Sign in
                      </Link>
                      <p className="small mt-sm">
                        <Link to={`/register?next=${encodeURIComponent(window.location.pathname)}`}>Create an account</Link>
                      </p>
                    </div>
                  ))}
                {(method === 'card' || method === 'virtual_card') && (
                  <>
                    {!fixed && <Alert kind="warning">Open-amount requests can only be paid from a BitriPay wallet.</Alert>}
                    {method === 'virtual_card' && <Alert kind="info">Enter the details of your BitriPay virtual card (starts with 6273 11).</Alert>}
                    <CardForm value={card} onChange={setCard} />
                    <Field label="Email for receipt">
                      <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                    </Field>
                    <Button block size="lg" loading={loading} disabled={!fixed || card.number.length < 12} onClick={startExternal}>
                      {user ? '🔐 Confirm and pay' : 'Pay'} {money(pr.amount ?? 0)}
                    </Button>
                  </>
                )}
                {method === 'mobile_money' && (
                  <>
                    <OperatorPicker value={operatorId} onChange={setOperatorId} country={opCountry} onCountry={setOpCountry} />
                    <Field label="Mobile money number">
                      <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+233…" />
                    </Field>
                    <Field label="Email for receipt">
                      <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                    </Field>
                    <Button block size="lg" loading={loading} disabled={!fixed || !phone} onClick={startExternal}>
                      {user ? '🔐 Confirm and pay' : 'Pay'} by mobile money
                    </Button>
                  </>
                )}
                {method === 'bank' && (
                  <>
                    <Field label="Email for receipt">
                      <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                    </Field>
                    <Button block size="lg" loading={loading} disabled={!fixed} onClick={startExternal}>
                      Get bank transfer details
                    </Button>
                  </>
                )}
                <p className="tiny muted center mt">
                  🔒 Secured by BitriPay. Card payments are processed by a licensed processor; mobile money and bank payments are confirmed from the operator or bank before the merchant is credited.{' '}
                  {pr.cancelUrl && <a href={pr.cancelUrl}>Cancel and return</a>}
                </p>
              </>
            )}
          </div>
        </div>
      </div>
      <PinModal
        open={pinOpen}
        onClose={() => setPinOpen(false)}
        onSubmit={(pin) => (pinFor === 'wallet' ? payWallet(pin) : pinFor === 'authenticate' ? authenticate(pin) : payExternal(pin))}
        loading={loading}
        title="Authorise this payment"
        summary={<KV k={`Pay ${merchant.businessName || merchant.fullName}`} v={fixed ? money(pr.amount!) : `${amount} ${cur.code}`} />}
      />
    </div>
  );
}
