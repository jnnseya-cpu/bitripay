import { useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { useT, tr } from '../lib/i18n';
import { Alert, Button, Empty, Field, Input, KV, Modal, PageHeader, PinModal, Select, StatusBadge, useAsync } from '../components/ui';
import { fromMinor, countryFlag, countryLabel } from '@bitripay/shared';

const CATEGORY_ICON: Record<string, string> = {
  electricity: '⚡',
  water: '💧',
  internet: '🌐',
  tv: '📺',
  gas: '🔥',
  insurance: '🛡️',
  education: '🎓',
  tax: '🏛️',
  shopping: '🛍️',
  entertainment: '🎬',
  gaming: '🎮',
  travel: '✈️',
  food: '🍔',
};

export function Bills() {
  const t = useT();
  const { money, toast, refreshWallets, currency, user } = useStore();
  const [country, setCountry] = useState(user?.country || '');
  const billers = useAsync(() => api.get<{ items: any[] }>(`/api/bills/billers${country ? `?country=${country}` : ''}`), [country]);
  const history = useAsync(() => api.get<{ items: any[] }>('/api/bills'), []);
  const [sel, setSel] = useState<any>(null);
  const [account, setAccount] = useState('');
  const [amount, setAmount] = useState('');
  const [pinOpen, setPinOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const pay = async (pin: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.post<{ receiptNo: string }>('/api/bills', { billerId: sel.id, accountNumber: account, amount, pin });
      toast(tr('Bill payment accepted (receipt {0}); you will be told when the biller confirms', { 0: r.receiptNo }), 'success');
      setPinOpen(false);
      setSel(null);
      setAmount('');
      history.reload();
      refreshWallets();
    } catch (err) {
      setError((err as Error).message);
      setPinOpen(false);
    } finally {
      setLoading(false);
    }
  };
  const categories = Array.from(new Set((billers.data?.items ?? []).map((b) => b.category)));
  return (
    <div>
      <PageHeader title={t('nav.bills')} subtitle={tr('Pay utilities and services straight from your wallet')} actions={<CountryPicker value={country} onChange={setCountry} />} />
      <div className="grid cols-3">
        <div style={{ gridColumn: 'span 2' }}>
          {categories.map((cat) => (
            <div key={cat} className="mb">
              <h4>
                {CATEGORY_ICON[cat] ?? '🧾'} {cat}
              </h4>
              <div className="grid auto">
                {billers.data?.items
                  .filter((b) => b.category === cat)
                  .map((b) => (
                    <div
                      key={b.id}
                      className={`brand-tile ${sel?.id === b.id ? 'selected' : ''}`}
                      style={{ background: b.color }}
                      onClick={() => {
                        setSel(b);
                        setAmount('');
                      }}
                    >
                      <div>
                        {b.name}
                        <div className="tiny" style={{ opacity: 0.85 }}>
                          {countryLabel(b.country)} · {b.currency}
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          ))}
          {billers.data?.items.length === 0 && (
            <div className="card">
              <Empty icon="🧾" text={tr('No billers available for this country')} />
            </div>
          )}
        </div>
        <div className="card">
          {error && <Alert kind="error">{error}</Alert>}
          {sel ? (
            <>
              <h3>{sel.name}</h3>
              <Field label={sel.accountLabel}>
                <Input value={account} onChange={(e) => setAccount(e.target.value)} />
              </Field>
              <Field
                label={`${t('common.amount')} (${sel.currency})`}
                hint={sel.minAmount ? `Min ${money(sel.minAmount, sel.currency)}${sel.maxAmount ? ` · max ${money(sel.maxAmount, sel.currency)}` : ''}` : undefined}
              >
                <Input className="amount-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
              </Field>
              <Button block disabled={!account || !amount} onClick={() => setPinOpen(true)}>
                {tr('Pay bill')}
              </Button>
            </>
          ) : (
            <Empty icon="👆" text={tr('Select a biller')} />
          )}
          <h4 className="mt">{tr('Recent bills')}</h4>
          <div className="list">
            {history.data?.items.slice(0, 8).map((b) => (
              <div key={b.id} className="list-item">
                <div className="flex1">
                  <div className="main-text small">{b.billerName}</div>
                  <div className="sub-text">
                    {b.accountNumber} · {b.receiptNo}
                  </div>
                </div>
                <div className="bold">{money(b.amount, b.currency)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <PinModal open={pinOpen} onClose={() => setPinOpen(false)} onSubmit={pay} loading={loading} summary={sel && <KV k={`${sel.name} · ${account}`} v={`${amount} ${sel.currency}`} />} />
      <span className="hidden">{currency('USD').code}</span>
    </div>
  );
}

function CountryPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { config } = useStore();
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} style={{ width: 220 }}>
      <option value="">{tr('All countries')}</option>
      {(config?.countries ?? []).map((c) => (
        <option key={c.code} value={c.code}>
          {countryFlag(c.code)} {c.name}
        </option>
      ))}
    </Select>
  );
}

export function Topup() {
  const t = useT();
  const { money, toast, refreshWallets, user } = useStore();
  const [country, setCountry] = useState(user?.country || '');
  const ops = useAsync(() => api.get<{ items: any[] }>(`/api/topups/operators${country ? `?country=${country}` : ''}`), [country]);
  const history = useAsync(() => api.get<{ items: any[] }>('/api/topups'), []);
  const [sel, setSel] = useState<any>(null);
  const [phone, setPhone] = useState(user?.phone || '');
  const [amount, setAmount] = useState('');
  const [pinOpen, setPinOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const submit = async (pin: string) => {
    setLoading(true);
    setError(null);
    try {
      await api.post('/api/topups', { operatorId: sel.id, phone, amount, pin });
      toast(tr('Top-up accepted; you will be told when the operator confirms'), 'success');
      setPinOpen(false);
      setAmount('');
      history.reload();
      refreshWallets();
    } catch (err) {
      setError((err as Error).message);
      setPinOpen(false);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div>
      <PageHeader title={t('nav.topup')} subtitle={tr('Recharge any prepaid phone instantly')} actions={<CountryPicker value={country} onChange={setCountry} />} />
      <div className="grid cols-3">
        <div style={{ gridColumn: 'span 2' }}>
          <div className="grid auto">
            {ops.data?.items.map((o) => (
              <div
                key={o.id}
                className={`brand-tile ${sel?.id === o.id ? 'selected' : ''}`}
                style={{ background: o.color }}
                onClick={() => {
                  setSel(o);
                  setAmount('');
                }}
              >
                <div>
                  📶 {o.name}
                  <div className="tiny" style={{ opacity: 0.85 }}>
                    {countryLabel(o.country)} · {o.currency}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {ops.data?.items.length === 0 && (
            <div className="card">
              <Empty icon="📶" text={tr('No operators for this country')} />
            </div>
          )}
        </div>
        <div className="card">
          {error && <Alert kind="error">{error}</Alert>}
          {sel ? (
            <>
              <h3>{sel.name}</h3>
              <Field label={tr('Phone number')}>
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+234…" />
              </Field>
              {sel.denominations.length > 0 && (
                <Field label={tr('Quick amounts')}>
                  <div className="row wrap">
                    {sel.denominations.map((d: number) => (
                      <span key={d} className={`chip clickable ${amount === fromMinor(d, 2) ? 'selected' : ''}`} onClick={() => setAmount(fromMinor(d, 2))}>
                        {money(d, sel.currency)}
                      </span>
                    ))}
                  </div>
                </Field>
              )}
              <Field label={`${t('common.amount')} (${sel.currency})`}>
                <Input className="amount-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
              </Field>
              <Button block disabled={!phone || !amount} onClick={() => setPinOpen(true)}>
                {tr('Top up')}
              </Button>
            </>
          ) : (
            <Empty icon="👆" text={tr('Select an operator')} />
          )}
          <h4 className="mt">{tr('Recent top-ups')}</h4>
          <div className="list">
            {history.data?.items.slice(0, 8).map((x) => (
              <div key={x.id} className="list-item">
                <div className="flex1">
                  <div className="main-text small">{x.operatorName}</div>
                  <div className="sub-text">{x.phone}</div>
                </div>
                <div className="bold">{money(x.amount, x.currency)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <PinModal open={pinOpen} onClose={() => setPinOpen(false)} onSubmit={submit} loading={loading} summary={sel && <KV k={`${sel.name} · ${phone}`} v={`${amount} ${sel.currency}`} />} />
    </div>
  );
}

export function GiftCards() {
  const t = useT();
  const { money, refreshWallets } = useStore();
  const products = useAsync(() => api.get<{ items: any[] }>('/api/gift-cards/products'), []);
  const mine = useAsync(() => api.get<{ items: any[] }>('/api/gift-cards'), []);
  const [sel, setSel] = useState<any>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [email, setEmail] = useState('');
  const [pinOpen, setPinOpen] = useState(false);
  const [bought, setBought] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const buy = async (pin: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.post<any>('/api/gift-cards', { productId: sel.id, amount: fromMinor(amount!, 2), recipientEmail: email || null, pin });
      setBought({ ...r, product: sel, amount });
      setPinOpen(false);
      setSel(null);
      mine.reload();
      refreshWallets();
    } catch (err) {
      setError((err as Error).message);
      setPinOpen(false);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div>
      <PageHeader title={t('nav.giftCards')} subtitle={tr('Buy digital gift cards for popular brands')} />
      {error && <Alert kind="error">{error}</Alert>}
      <div className="grid cols-3">
        <div style={{ gridColumn: 'span 2' }}>
          <div className="grid auto">
            {products.data?.items.map((p) => (
              <div
                key={p.id}
                className={`brand-tile ${sel?.id === p.id ? 'selected' : ''}`}
                style={{ background: p.color, minHeight: 120 }}
                onClick={() => {
                  setSel(p);
                  setAmount(p.denominations[0] ?? null);
                }}
              >
                <div>
                  <div style={{ fontSize: '1.2rem' }}>{p.brand}</div>
                  <div className="tiny" style={{ opacity: 0.85 }}>
                    {p.name} · {p.currency}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          {sel ? (
            <>
              <h3>{sel.brand}</h3>
              <p className="small muted">{sel.description}</p>
              <Field label={tr('Value')}>
                <div className="row wrap">
                  {sel.denominations.map((d: number) => (
                    <span key={d} className={`chip clickable ${amount === d ? 'selected' : ''}`} onClick={() => setAmount(d)}>
                      {money(d, sel.currency)}
                    </span>
                  ))}
                </div>
              </Field>
              <Field label={tr('Send to email (optional)')}>
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Button block disabled={!amount} onClick={() => setPinOpen(true)}>
                {tr('Buy')} {amount ? money(amount, sel.currency) : ''}
              </Button>
            </>
          ) : (
            <Empty icon="🎁" text={tr('Pick a brand')} />
          )}
          <h4 className="mt">{tr('My gift cards')}</h4>
          {mine.data?.items.length === 0 && <div className="small muted">{tr('None yet')}</div>}
          <div className="list">
            {mine.data?.items.map((g) => (
              <div key={g.id} className="list-item">
                <div className="flex1">
                  <div className="main-text small">
                    {g.brand} · {money(g.amount, g.currency)}
                  </div>
                  <div className="sub-text mono">
                    {g.code} · PIN {g.pin}
                  </div>
                </div>
                <StatusBadge status={g.status} />
              </div>
            ))}
          </div>
        </div>
      </div>
      <PinModal open={pinOpen} onClose={() => setPinOpen(false)} onSubmit={buy} loading={loading} summary={sel && amount && <KV k={`${sel.brand} gift card`} v={money(amount, sel.currency)} />} />
      <Modal open={!!bought} onClose={() => setBought(null)} title={tr('Your gift card')}>
        {bought && (
          <div className="center">
            <div className="brand-tile" style={{ background: bought.product.color, minHeight: 120, justifyContent: 'center', alignItems: 'center' }}>
              {bought.product.brand} · {money(bought.amount, bought.product.currency)}
            </div>
            <KV k={tr('Code')} v={<span className="mono">{bought.code}</span>} />
            <KV k="PIN" v={<span className="mono">{bought.pin}</span>} />
            <p className="small muted mt">{tr('Saved under “My gift cards”.')}</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
