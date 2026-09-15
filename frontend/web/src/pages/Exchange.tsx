import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { Alert, AmountInput, Button, Field, KV, PageHeader, PinModal, RouteDisclosure, Select, useDebounce } from '../components/ui';
import { currencyFlag } from '@bitripay/shared';

export function Exchange() {
  const t = useT();
  const { wallets, config, money, toast, refreshWallets } = useStore();
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState(wallets[0]?.currency || 'USD');
  const [to, setTo] = useState(wallets[1]?.currency || 'EUR');
  const [quote, setQuote] = useState<any>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [newCur, setNewCur] = useState('');
  const d = useDebounce(amount, 300);
  useEffect(() => {
    if (!d || from === to) return setQuote(null);
    api
      .get(`/api/wallets/exchange/quote?from=${from}&to=${to}&amount=${d}`)
      .then(setQuote)
      .catch(() => setQuote(null));
  }, [d, from, to]);
  const submit = async (pin: string) => {
    setLoading(true);
    setError(null);
    try {
      await api.post('/api/wallets/exchange', { from, to, amount, pin: pin || undefined, quoteId: quote?.fx?.quoteId ?? null });
      toast('Exchange completed', 'success');
      setAmount('');
      setPinOpen(false);
      refreshWallets();
    } catch (err) {
      setError((err as Error).message);
      setPinOpen(false);
    } finally {
      setLoading(false);
    }
  };
  const addWallet = async () => {
    if (!newCur) return;
    await api.post('/api/wallets', { currency: newCur });
    toast(`${newCur} wallet created`, 'success');
    setNewCur('');
    refreshWallets();
  };
  return (
    <div>
      <PageHeader title={t('nav.exchange')} subtitle="Switch between currencies. The reference rate, its source and time, and our markup are shown before you confirm." />
      <div className="grid cols-2">
        <div className="card">
          {error && <Alert kind="error">{error}</Alert>}
          <Field label="From">
            <AmountInput amount={amount} currency={from} onAmount={setAmount} onCurrency={setFrom} big />
          </Field>
          <Field label="To">
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
              <KV k="Rate" v={`1 ${from} = ${quote.rate.toFixed(6)} ${to}`} />
              <KV k="Mid-market" v={`${quote.midRate.toFixed(6)} (margin ${(quote.marginBps / 100).toFixed(2)}%)`} />
              <KV k="Fee" v={money(quote.fee ?? 0, from)} />
              <KV k="You receive" v={<b style={{ color: 'var(--success)' }}>{money(quote.receive, to)}</b>} />
              {quote.fx && (
                <KV
                  k="Rate source"
                  v={
                    <span className="small">
                      {quote.fx.providerLabel}
                      {quote.fx.rateTimestamp ? ` · ${new Date(quote.fx.rateTimestamp).toLocaleString()}` : ''}
                    </span>
                  }
                />
              )}
              {quote.fx && (
                <KV
                  k="Guarantee"
                  v={
                    quote.fx.guaranteed ? (
                      <span className="chip success">locked until {new Date(quote.fx.expiresAt).toLocaleTimeString()}</span>
                    ) : (
                      <span className="chip warning">indicative – executes at the current rate</span>
                    )
                  }
                />
              )}
            </div>
          )}
          {quote?.fx && <RouteDisclosure fx={quote.fx} />}
          <Button block size="lg" disabled={!quote} onClick={() => setPinOpen(true)}>
            Exchange
          </Button>
        </div>
        <div className="card">
          <h3>My wallets</h3>
          <div className="list">
            {wallets.map((w) => (
              <div key={w.id} className="list-item">
                <div className="flex1">
                  <div className="main-text">{w.currency}</div>
                  <div className="sub-text">{config?.currencies.find((c) => c.code === w.currency)?.name}</div>
                </div>
                <div className="bold">{money(w.balance, w.currency)}</div>
              </div>
            ))}
          </div>
          <div className="divider" />
          <Field label="Add a currency wallet">
            <div className="row">
              <Select value={newCur} onChange={(e) => setNewCur(e.target.value)}>
                <option value="">Choose…</option>
                {(config?.currencies ?? [])
                  .filter((c) => !wallets.some((w) => w.currency === c.code))
                  .map((c) => (
                    <option key={c.code} value={c.code}>
                      {currencyFlag(c.code)} {c.code} – {c.name}
                    </option>
                  ))}
              </Select>
              <Button variant="secondary" onClick={addWallet} disabled={!newCur}>
                Add
              </Button>
            </div>
          </Field>
          <h4 className="mt">Reference rates (vs {config?.baseCurrency})</h4>
          <div className="row wrap">
            {(config?.currencies ?? []).slice(0, 12).map((c) => (
              <span key={c.code} className="chip">
                {c.code} {c.rateToBase}
              </span>
            ))}
          </div>
        </div>
      </div>
      <PinModal open={pinOpen} onClose={() => setPinOpen(false)} onSubmit={submit} loading={loading} summary={quote && <KV k={`Exchange ${amount} ${from}`} v={money(quote.receive, to)} />} />
    </div>
  );
}
