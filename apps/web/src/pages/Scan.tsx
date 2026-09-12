import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams, useParams, Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { Scanner } from '../components/Scanner';
import { Alert, AmountInput, Avatar, Button, Field, Input, KV, Loading, PageHeader, PinModal, StatusBadge } from '../components/ui';
import { decodeQr, toMinor, type PaymentRequest, type PublicUser, type Transaction } from '@bitripay/shared';

type Trust = 'verified' | 'basic';
type Resolved =
  | { kind: 'payment_request'; paymentRequest: PaymentRequest; merchant: PublicUser & { brandColor: string; verified?: boolean; location?: { name: string; city: string | null } | null }; methods: string[]; trust?: Trust; intent?: { id: string; status: string; purposeCode: string | null; reference: string | null } }
  | { kind: 'user' | 'merchant' | 'agent'; user: PublicUser; amount: string | null; currency: string | null; note: string | null }
  /** A static BitriQR sticker: the payer enters the amount, an intent is created for the code, then paid. */
  | { kind: 'bitriqr'; user: PublicUser & { verified?: boolean; location?: { name: string; city: string | null } | null }; qrId: string | null; amount: null; currency: string | null; note: string | null; purposeCode: string | null; trust: Trust };

export function Scan() {
  const t = useT();
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  const resolve = useCallback(async (data: string) => {
    setError(null);
    try {
      const r = await api.post<Resolved>('/api/qr/resolve', { data });
      setResolved(r);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  return (
    <div style={{ maxWidth: 560 }}>
      <PageHeader title={t('scan.title')} subtitle={t('scan.hint')} />
      {error && <Alert kind="error">{error}</Alert>}
      {resolved ? (
        <PayTarget resolved={resolved} onBack={() => setResolved(null)} />
      ) : (
        <div className="card">
          <Scanner onScan={resolve} />
          <div className="divider" />
          <Field label={t('scan.paste')}>
            <div className="row">
              <Input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="bitripay://pay?… or https://…/pay/CODE or @tag" />
              <Button type="button" onClick={() => manual && resolve(manual)}>Go</Button>
            </div>
          </Field>
        </div>
      )}
    </div>
  );
}

export function PayTarget({ resolved, onBack }: { resolved: Resolved; onBack?: () => void }) {
  const t = useT();
  const nav = useNavigate();
  const { wallets, money, currency, refreshWallets, toast, user, config } = useStore();
  const isPr = resolved.kind === 'payment_request';
  const isBq = resolved.kind === 'bitriqr';
  const pr = isPr ? resolved.paymentRequest : null;
  const target = isPr ? resolved.merchant : resolved.user;
  const trust: Trust | null = isPr ? resolved.trust ?? null : isBq ? resolved.trust : null;
  const location = isPr ? resolved.merchant.location : isBq ? resolved.user.location : null;
  const purpose = isPr ? resolved.intent?.purposeCode ?? null : isBq ? resolved.purposeCode : null;
  const fixedAmount = isPr ? (pr!.amount != null ? String(pr!.amount / 10 ** currency(pr!.currency).decimals) : '') : resolved.amount ?? '';
  const [amount, setAmount] = useState(fixedAmount);
  const [cur, setCur] = useState(isPr ? pr!.currency : resolved.currency || wallets[0]?.currency || config?.baseCurrency || 'USD');
  const [note, setNote] = useState(isPr ? pr!.description ?? '' : resolved.note ?? '');
  const [pinOpen, setPinOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fee, setFee] = useState<number>(0);
  const wallet = wallets.find((w) => w.currency === cur);
  let minor = 0;
  try {
    minor = amount ? toMinor(amount, currency(cur).decimals) : 0;
  } catch {
    minor = -1;
  }
  useEffect(() => {
    if (minor <= 0) return setFee(0);
    const type = target.role === 'merchant' ? 'merchant_payment' : isPr ? 'transfer' : 'qr_payment';
    api.get<{ fee: number }>(`/api/transfers/fee?amount=${amount}&currency=${cur}&type=${type}`).then((r) => setFee(r.fee)).catch(() => setFee(0));
  }, [amount, cur, minor, target.role, isPr]);
  const feeOnMe = target.role !== 'merchant';
  const total = minor + (feeOnMe ? fee : 0);

  if (resolved.kind === 'agent') {
    return (
      <div className="card">
        <div className="list-item"><Avatar user={target} /><div><div className="main-text">{target.businessName || target.fullName}</div><div className="sub-text">Agent · @{target.tag}</div></div></div>
        <p className="muted small">Agents let you deposit cash into your wallet or withdraw cash. Choose what you'd like to do.</p>
        <div className="row wrap">
          <Link className="btn" to={`/app/agents?agent=${target.tag}&action=cashout`}>Withdraw cash (cash-out)</Link>
          <Link className="btn secondary" to={`/app/send?to=${target.tag}`}>Send money to agent</Link>
          {onBack && <Button variant="ghost" onClick={onBack}>{t('common.back')}</Button>}
        </div>
      </div>
    );
  }

  const pay = async (pin: string) => {
    setLoading(true);
    setError(null);
    try {
      let tx: Transaction;
      if (isPr) {
        const r = await api.post<{ transaction: Transaction }>(`/api/payment-requests/${pr!.code}/pay`, { pin, amount: pr!.amount == null ? amount : undefined, note });
        tx = r.transaction;
      } else if (isBq && resolved.qrId) {
        // static BitriQR: the amount creates a payment intent for this code, then the intent is paid from the wallet
        const intent = await api.post<{ id: string; paymentRequestCode: string }>(`/api/v1/qr/${resolved.qrId}/intent`, { amount, description: note || null });
        const r = await api.post<{ transaction: Transaction }>(`/api/payment-requests/${intent.paymentRequestCode}/pay`, { pin, note });
        tx = r.transaction;
      } else {
        const r = await api.post<{ transaction: Transaction }>('/api/transfers', { to: target.tag, amount, currency: cur, note, pin });
        tx = r.transaction;
      }
      await refreshWallets();
      toast('Payment successful', 'success');
      nav(`/app/transactions/${tx.id}`);
    } catch (err) {
      setError((err as Error).message);
      setPinOpen(false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card">
      {error && <Alert kind="error">{error}</Alert>}
      <div className="list-item">
        <Avatar user={target} size="lg" />
        <div>
          <div className="main-text" style={{ fontSize: '1.1rem' }}>{target.businessName || target.fullName}</div>
          <div className="sub-text">@{target.tag} · {target.role}{isPr && <> · <StatusBadge status={pr!.status} /></>}</div>
          {(trust || location || purpose) && (
            <div className="row wrap" style={{ gap: 6, marginTop: 4 }}>
              {trust && <span className={`chip ${trust === 'verified' ? 'success' : 'warning'}`} title={trust === 'verified' ? 'Signed by the merchant key registered with BitriPay' : 'Unsigned code: check the name before paying'}>{trust === 'verified' ? '✓ Verified merchant' : 'Unverified code'}</span>}
              {location && <span className="chip">{location.name}{location.city ? ` · ${location.city}` : ''}</span>}
              {purpose && purpose !== 'GENERAL_MERCHANT' && <span className="chip primary">{purpose.replace(/_/g, ' ').toLowerCase()}</span>}
            </div>
          )}
        </div>
      </div>
      {isPr && pr!.status !== 'open' && <Alert kind="warning">This payment request is {pr!.status}.</Alert>}
      {target.id === user?.id && <Alert kind="warning">This is your own code.</Alert>}
      <Field label={t('common.amount')} hint={wallet ? `${t('common.balance')}: ${money(wallet.balance, wallet.currency)}` : undefined}>
        <AmountInput amount={amount} currency={cur} onAmount={setAmount} onCurrency={setCur} big disabled={!!fixedAmount} currencies={isPr || isBq ? [cur] : undefined} />
      </Field>
      <Field label={t('common.note')}>
        <Input value={note} onChange={(e) => setNote(e.target.value)} disabled={isPr && !!pr!.description} />
      </Field>
      {minor > 0 && (
        <div className="card soft compact mb">
          <KV k={t('common.fee')} v={feeOnMe ? money(fee, cur) : 'Paid by merchant'} />
          <KV k={t('common.total')} v={money(total, cur)} />
        </div>
      )}
      <div className="row">
        <Button size="lg" className="flex1" disabled={minor <= 0 || !wallet || wallet.balance < total || (isPr && pr!.status !== 'open') || target.id === user?.id} onClick={() => setPinOpen(true)}>
          Pay {minor > 0 ? money(total, cur) : ''}
        </Button>
        {onBack && <Button variant="secondary" onClick={onBack}>{t('common.back')}</Button>}
      </div>
      <PinModal open={pinOpen} onClose={() => setPinOpen(false)} onSubmit={pay} loading={loading} summary={<KV k={`Pay ${target.businessName || target.fullName}`} v={money(total, cur)} />} />
    </div>
  );
}

/** Landing for scanned links (/q?…, /u/:tag): sends signed-in users to pay, guests to login/checkout. */
export function QrLanding() {
  const [params] = useSearchParams();
  const { tag } = useParams();
  const { user, loading } = useStore();
  const nav = useNavigate();
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (loading) return;
    const payload = tag ? { type: 'u' as const, id: tag } : decodeQr(window.location.href);
    if (!payload) {
      setError('Invalid QR link');
      return;
    }
    if (payload.type === 'pr') {
      nav(`/pay/${payload.id}`, { replace: true });
      return;
    }
    if (!user) {
      nav(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`, { replace: true });
      return;
    }
    api.post<Resolved>('/api/qr/resolve', { data: window.location.href }).then(setResolved).catch((e) => setError(e.message));
  }, [loading, user, tag, nav, params]);
  if (error) return <div className="auth-page"><div className="card"><Alert kind="error">{error}</Alert><Link to="/">Home</Link></div></div>;
  if (!resolved) return <Loading />;
  return (
    <div className="auth-page">
      <div className="auth-card">
        <Link to="/app" className="brand" style={{ color: 'inherit', justifyContent: 'center' }}><img className="brand-img swap" src="/brand/logo.svg" alt="BitriPay" width={140} height={34} /></Link>
        <PayTarget resolved={resolved} onBack={() => nav('/app')} />
      </div>
    </div>
  );
}
