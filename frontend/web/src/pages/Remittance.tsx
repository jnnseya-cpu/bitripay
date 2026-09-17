import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { useT, tr } from '../lib/i18n';
import { Alert, AmountInput, Button, Empty, Field, Input, KV, PageHeader, PinModal, Select, StatusBadge, Tabs, useAsync, useDebounce } from '../components/ui';
import { currencyFlag, countryLabel } from '@bitripay/shared';

type Method = 'wallet' | 'bank' | 'cash_pickup';

export function Remittance() {
  const t = useT();
  const nav = useNavigate();
  const { wallets, config, money, toast, refreshWallets } = useStore();
  const [tab, setTab] = useState<'send' | 'history' | 'recipients'>('send');
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState(wallets[0]?.currency || 'USD');
  const [to, setTo] = useState('NGN');
  const [method, setMethod] = useState<Method>('wallet');
  const [rec, setRec] = useState({ name: '', country: '', phone: '', email: '', tag: '', bankName: '', accountNumber: '', swift: '', idNumber: '', address: '' });
  const [save, setSave] = useState(true);
  const [quote, setQuote] = useState<any>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const dAmount = useDebounce(amount, 300);
  const history = useAsync(() => api.get<{ items: any[] }>('/api/remittances'), [tab]);
  const recipients = useAsync(() => api.get<{ items: any[] }>('/api/recipients'), [tab]);
  useEffect(() => {
    if (!dAmount) return setQuote(null);
    api
      .get(`/api/remittances/quote?from=${from}&to=${to}&amount=${dAmount}`)
      .then(setQuote)
      .catch(() => setQuote(null));
  }, [dAmount, from, to]);

  const submit = async (pin: string) => {
    setLoading(true);
    setError(null);
    try {
      const body = {
        amount,
        sourceCurrency: from,
        targetCurrency: to,
        payoutMethod: method,
        recipient: Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, v || null])),
        saveRecipient: save,
        pin,
      };
      const r = await api.post<{ remittance: any; transaction: any }>('/api/remittances', body);
      toast(r.remittance.pickupCode ? `Sent! Pickup code: ${r.remittance.pickupCode}` : 'Remittance sent', 'success');
      refreshWallets();
      nav(`/app/transactions/${r.transaction.id}`);
    } catch (err) {
      setError((err as Error).message);
      setPinOpen(false);
    } finally {
      setLoading(false);
    }
  };
  const pickRecipient = (r: any) => {
    setRec({
      name: r.name,
      country: r.country || '',
      phone: r.phone || '',
      email: r.email || '',
      tag: r.tag || '',
      bankName: r.bankName || '',
      accountNumber: r.accountNumber || '',
      swift: '',
      idNumber: '',
      address: '',
    });
    setMethod(r.payoutMethod);
    if (r.currency) setTo(r.currency);
    setTab('send');
  };

  return (
    <div>
      <PageHeader title={t('nav.remittance')} subtitle={tr('Send money abroad to a BitriPay wallet, a bank account or for cash pickup at an agent')} />
      <Tabs
        tabs={[
          { id: 'send', label: tr('Send') },
          { id: 'history', label: tr('History') },
          { id: 'recipients', label: tr('Saved recipients') },
        ]}
        value={tab}
        onChange={(v) => setTab(v as any)}
      />
      {tab === 'send' && (
        <div className="grid cols-2">
          <div className="card">
            {error && <Alert kind="error">{error}</Alert>}
            <Field label={tr('You send')}>
              <AmountInput amount={amount} currency={from} onAmount={setAmount} onCurrency={setFrom} big />
            </Field>
            <Field label="Recipient receives in">
              <Select value={to} onChange={(e) => setTo(e.target.value)}>
                {(config?.currencies ?? []).map((c) => (
                  <option key={c.code} value={c.code}>
                    {currencyFlag(c.code)} {c.code} – {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            {quote && (
              <div className="card soft compact mb">
                <KV k={tr('Exchange rate')} v={`1 ${from} = ${quote.rate.toFixed(4)} ${to}`} />
                <KV k={t('common.fee')} v={money(quote.fee, from)} />
                <KV k={tr('Total debited')} v={money(quote.total, from)} />
                <KV k={tr('Recipient gets')} v={<b style={{ color: 'var(--success)' }}>{money(quote.targetAmount, to)}</b>} />
              </div>
            )}
            <Field label={tr('Payout method')}>
              <Tabs
                pills
                tabs={[
                  { id: 'wallet', label: tr('BitriPay wallet') },
                  { id: 'bank', label: tr('Bank transfer') },
                  { id: 'cash_pickup', label: tr('Cash pickup') },
                ]}
                value={method}
                onChange={(m) => setMethod(m as Method)}
              />
            </Field>
            <p className="small muted">
              {method === 'wallet' && 'Instant delivery to any BitriPay user.'}
              {method === 'bank' && 'Deposited to the recipient bank account, usually within 1–2 business days.'}
              {method === 'cash_pickup' && 'You get a pickup code; the recipient collects cash at any BitriPay agent with a matching ID.'}
            </p>
          </div>
          <div className="card">
            <h3>{tr('Recipient')}</h3>
            {recipients.data && recipients.data.items.length > 0 && (
              <Field label={tr('Saved recipients')}>
                <div className="row wrap">
                  {recipients.data.items.map((r) => (
                    <span key={r.id} className="chip clickable" onClick={() => pickRecipient(r)}>
                      {r.name}
                    </span>
                  ))}
                </div>
              </Field>
            )}
            <Field label={tr('Full name')}>
              <Input value={rec.name} onChange={(e) => setRec({ ...rec, name: e.target.value })} />
            </Field>
            <Field label={tr('Country')}>
              <Select value={rec.country} onChange={(e) => setRec({ ...rec, country: e.target.value })}>
                <option value="">—</option>
                {(config?.countries ?? []).map((c) => (
                  <option key={c.code} value={c.code}>
                    {countryLabel(c.code, c.name)}
                  </option>
                ))}
              </Select>
            </Field>
            {method === 'wallet' && (
              <Field label={tr('BitriPay @tag, email or phone')}>
                <Input value={rec.tag} onChange={(e) => setRec({ ...rec, tag: e.target.value })} placeholder="@family" />
              </Field>
            )}
            {method === 'bank' && (
              <>
                <Field label={tr('Bank name')}>
                  <Input value={rec.bankName} onChange={(e) => setRec({ ...rec, bankName: e.target.value })} />
                </Field>
                <Field label={tr('Account number / IBAN')}>
                  <Input value={rec.accountNumber} onChange={(e) => setRec({ ...rec, accountNumber: e.target.value })} />
                </Field>
                <Field label={tr('SWIFT / BIC (optional)')}>
                  <Input value={rec.swift} onChange={(e) => setRec({ ...rec, swift: e.target.value })} />
                </Field>
              </>
            )}
            {method === 'cash_pickup' && (
              <Field label={tr('Recipient ID number')} hint={tr('The agent checks this ID before paying out')}>
                <Input value={rec.idNumber} onChange={(e) => setRec({ ...rec, idNumber: e.target.value })} />
              </Field>
            )}
            <div className="grid cols-2">
              <Field label={tr('Phone')}>
                <Input value={rec.phone} onChange={(e) => setRec({ ...rec, phone: e.target.value })} />
              </Field>
              <Field label={tr('Email')}>
                <Input value={rec.email} onChange={(e) => setRec({ ...rec, email: e.target.value })} />
              </Field>
            </div>
            <label className="checkbox mb">
              <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> {tr('Save recipient for next time')}
            </label>
            <Button block size="lg" disabled={!quote || !rec.name} onClick={() => setPinOpen(true)}>
              {tr('Send')} {quote ? money(quote.targetAmount, to) : ''}
            </Button>
          </div>
        </div>
      )}
      {tab === 'history' && (
        <div className="card">
          {history.data?.items.length === 0 && <Empty icon="🌍" />}
          <div className="list">
            {history.data?.items.map((r) => (
              <div key={r.id} className="list-item clickable" onClick={() => nav(`/app/transactions/${r.transactionId}`)}>
                <div className="flex1">
                  <div className="main-text">
                    {r.recipient?.name} · {money(r.targetAmount, r.targetCurrency)}
                  </div>
                  <div className="sub-text">
                    {money(r.sourceAmount, r.sourceCurrency)} · {r.payoutMethod.replace('_', ' ')} {r.pickupCode ? `· pickup code ${r.pickupCode}` : ''} · {new Date(r.createdAt).toLocaleString()}
                  </div>
                </div>
                <StatusBadge status={r.status} />
              </div>
            ))}
          </div>
        </div>
      )}
      {tab === 'recipients' && (
        <div className="card">
          {recipients.data?.items.length === 0 && <Empty icon="👥" />}
          <div className="list">
            {recipients.data?.items.map((r) => (
              <div key={r.id} className="list-item">
                <div className="flex1">
                  <div className="main-text">{r.name}</div>
                  <div className="sub-text">
                    {r.payoutMethod.replace('_', ' ')} · {r.bankName || r.tag || r.phone || r.email} · {countryLabel(r.country)}
                  </div>
                </div>
                <Button size="sm" onClick={() => pickRecipient(r)}>
                  {tr('Send')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => api.del(`/api/recipients/${r.id}`).then(recipients.reload)}>
                  {tr('Remove')}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
      <PinModal
        open={pinOpen}
        onClose={() => setPinOpen(false)}
        onSubmit={submit}
        loading={loading}
        summary={
          quote && (
            <>
              <KV k={tr('Send')} v={money(quote.total, from)} />
              <KV k={`${rec.name} receives`} v={money(quote.targetAmount, to)} />
            </>
          )
        }
      />
    </div>
  );
}
