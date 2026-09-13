import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { Alert, AmountInput, Avatar, Button, Field, Input, KV, PageHeader, PinModal, useDebounce } from '../components/ui';
import { toMinor, type PublicUser, type Transaction } from '@bitripay/shared';

export function Send() {
  const t = useT();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { wallets, money, currency, refreshWallets, toast, config } = useStore();
  const [to, setTo] = useState(params.get('to') || '');
  const [amount, setAmount] = useState(params.get('amount') || '');
  const [cur, setCur] = useState(params.get('currency') || wallets[0]?.currency || config?.baseCurrency || 'USD');
  const [note, setNote] = useState(params.get('note') || '');
  const [recipient, setRecipient] = useState<PublicUser | null>(null);
  const [fee, setFee] = useState<{ fee: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const debouncedTo = useDebounce(to, 350);
  const debouncedAmount = useDebounce(amount, 350);

  useEffect(() => {
    if (!debouncedTo || debouncedTo.length < 3) return setRecipient(null);
    api
      .get<{ user: PublicUser }>(`/api/account/lookup?q=${encodeURIComponent(debouncedTo)}`)
      .then((r) => setRecipient(r.user))
      .catch(() => setRecipient(null));
  }, [debouncedTo]);

  useEffect(() => {
    if (!debouncedAmount || !cur) return setFee(null);
    const type = recipient?.role === 'merchant' ? 'merchant_payment' : 'transfer';
    api
      .get<{ fee: number; total: number }>(`/api/transfers/fee?amount=${debouncedAmount}&currency=${cur}&type=${type}`)
      .then(setFee)
      .catch(() => setFee(null));
  }, [debouncedAmount, cur, recipient]);

  const wallet = wallets.find((w) => w.currency === cur);
  let minor = 0;
  try {
    minor = amount ? toMinor(amount, currency(cur).decimals) : 0;
  } catch {
    minor = -1;
  }
  const feeOnSender = recipient?.role !== 'merchant';
  const total = minor + (feeOnSender ? (fee?.fee ?? 0) : 0);
  const canSubmit = !!recipient && minor > 0 && !!wallet && wallet.balance >= total;

  const submit = async (pin: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.post<{ transaction: Transaction }>('/api/transfers', { to: recipient!.tag, amount, currency: cur, note, pin, idempotencyKey: `${recipient!.id}-${amount}-${Date.now()}` });
      await refreshWallets();
      toast(t('send.success'), 'success');
      nav(`/app/transactions/${res.transaction.id}`);
    } catch (err) {
      setError((err as Error).message);
      setPinOpen(false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 560 }}>
      <PageHeader title={t('send.title')} subtitle="Send to any BitriPay user by @tag, email or phone" />
      <div className="card">
        {error && <Alert kind="error">{error}</Alert>}
        <Field label={t('send.to')}>
          <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="@alice" autoFocus />
        </Field>
        {recipient && (
          <div className="list-item card soft compact mb">
            <Avatar user={recipient} />
            <div>
              <div className="main-text">{recipient.businessName || recipient.fullName}</div>
              <div className="sub-text">
                @{recipient.tag} · {recipient.role}
              </div>
            </div>
          </div>
        )}
        {to.length >= 3 && !recipient && <div className="small muted mb">No user found for "{to}"</div>}
        <Field label={t('common.amount')} hint={wallet ? `${t('common.balance')}: ${money(wallet.balance, wallet.currency)}` : 'Create a wallet in this currency first'}>
          <AmountInput amount={amount} currency={cur} onAmount={setAmount} onCurrency={setCur} big />
        </Field>
        <Field label={t('common.note')}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="What's it for?" />
        </Field>
        {fee && minor > 0 && (
          <div className="card soft compact mb">
            <KV k={t('common.amount')} v={money(minor, cur)} />
            <KV k={t('common.fee')} v={feeOnSender ? money(fee.fee, cur) : `${money(fee.fee, cur)} (paid by merchant)`} />
            <KV k={t('common.total')} v={money(total, cur)} />
          </div>
        )}
        <Button block size="lg" disabled={!canSubmit} onClick={() => setPinOpen(true)}>
          {t('send.review')}
        </Button>
      </div>
      <PinModal
        open={pinOpen}
        onClose={() => setPinOpen(false)}
        loading={loading}
        onSubmit={submit}
        title={t('send.review')}
        summary={
          <div className="mb">
            <KV k="To" v={`${recipient?.fullName} (@${recipient?.tag})`} />
            <KV k={t('common.total')} v={money(total, cur)} />
          </div>
        }
      />
    </div>
  );
}
