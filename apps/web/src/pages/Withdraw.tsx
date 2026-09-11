import { useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { Alert, AmountInput, Button, Empty, Field, Input, KV, Modal, PageHeader, PinModal, Select, StatusBadge, TxRow, useAsync } from '../components/ui';
import type { BankAccount, Transaction } from '@bitripay/shared';
import { useNavigate } from 'react-router-dom';
import { OperatorPicker } from './AddMoney';

export function Withdraw() {
  const t = useT();
  const nav = useNavigate();
  const { wallets, money, config, toast, refreshWallets } = useStore();
  const accounts = useAsync(() => api.get<{ items: BankAccount[] }>('/api/bank-accounts'), []);
  const history = useAsync(() => api.get<{ items: Transaction[] }>('/api/withdrawals?pageSize=10'), []);
  const [amount, setAmount] = useState('');
  const [cur, setCur] = useState(wallets[0]?.currency || 'USD');
  const [bankId, setBankId] = useState('');
  const [dest, setDest] = useState<'bank' | 'mobile_money'>('bank');
  const [operatorId, setOperatorId] = useState('');
  const [opCountry, setOpCountry] = useState('');
  const [phone, setPhone] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [fee, setFee] = useState<number | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [bank, setBank] = useState({ bankName: '', accountName: '', accountNumber: '', currency: cur, country: '', swift: '' });
  const wallet = wallets.find((w) => w.currency === cur);
  const eligible = accounts.data?.items.filter((a) => a.currency === cur) ?? [];

  const quote = async (a: string, c: string) => {
    setAmount(a);
    if (!a) return setFee(null);
    try {
      const r = await api.get<{ fee: number }>(`/api/withdrawals/fee?amount=${a}&currency=${c}`);
      setFee(r.fee);
    } catch {
      setFee(null);
    }
  };

  const submit = async (pin: string) => {
    setLoading(true);
    setError(null);
    try {
      const destination = dest === 'mobile_money' ? { method: 'mobile_money', operatorId, phone, name: recipientName || null } : { method: 'bank', bankAccountId: bankId || eligible[0]?.id };
      const r = await api.post<{ transaction: Transaction }>('/api/withdrawals', { amount, currency: cur, destination, pin });
      toast('Withdrawal requested', 'success');
      refreshWallets();
      nav(`/app/transactions/${r.transaction.id}`);
    } catch (err) {
      setError((err as Error).message);
      setPinOpen(false);
    } finally {
      setLoading(false);
    }
  };

  const addBank = async () => {
    try {
      await api.post('/api/bank-accounts', { ...bank, country: bank.country || null, swift: bank.swift || null });
      setAddOpen(false);
      accounts.reload();
      toast('Bank account added', 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <div>
      <PageHeader title={t('withdraw.title')} subtitle="Send wallet funds to your bank account or to any mobile money number in the world. Prefer cash? Use an agent." actions={<Button variant="secondary" onClick={() => { setBank((b) => ({ ...b, currency: cur })); setAddOpen(true); }}>+ Add bank account</Button>} />
      <div className="grid cols-2">
        <div className="card">
          {error && <Alert kind="error">{error}</Alert>}
          <Field label={t('common.amount')} hint={wallet ? `${t('common.balance')}: ${money(wallet.balance, wallet.currency)}` : undefined}>
            <AmountInput amount={amount} currency={cur} onAmount={(a) => quote(a, cur)} onCurrency={(c) => { setCur(c); quote(amount, c); }} big />
          </Field>
          <Field label="Pay out to">
            <div className="pill-tabs"><button type="button" className={`tab ${dest === 'bank' ? 'active' : ''}`} onClick={() => setDest('bank')}>🏦 Bank account</button><button type="button" className={`tab ${dest === 'mobile_money' ? 'active' : ''}`} onClick={() => setDest('mobile_money')}>📱 Mobile money (any operator)</button></div>
          </Field>
          {dest === 'mobile_money' && (
            <>
              <OperatorPicker value={operatorId} onChange={setOperatorId} country={opCountry} onCountry={setOpCountry} />
              <div className="grid cols-2">
                <Field label="Mobile money number"><Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+2547…" /></Field>
                <Field label="Recipient name (optional)"><Input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} /></Field>
              </div>
            </>
          )}
          {dest === 'bank' && <Field label="Bank account">
            {eligible.length === 0 ? (
              <Alert kind="warning">No {cur} bank account saved yet. Add one to continue.</Alert>
            ) : (
              <Select value={bankId || eligible[0].id} onChange={(e) => setBankId(e.target.value)}>
                {eligible.map((a) => <option key={a.id} value={a.id}>{a.bankName} · {a.accountName} · •••• {a.accountNumber.slice(-4)}</option>)}
              </Select>
            )}
          </Field>}
          {fee != null && amount && (
            <div className="card soft compact mb">
              <KV k={t('common.fee')} v={money(fee, cur)} />
              <KV k="You receive" v={`${amount} ${cur}`} />
            </div>
          )}
          <Button block size="lg" disabled={!amount || (dest === 'bank' ? eligible.length === 0 : !operatorId || !phone)} onClick={() => setPinOpen(true)}>Withdraw</Button>
          <p className="small muted mt">Bank withdrawals and mobile money payouts (to any operator worldwide) are reviewed and paid out by our team or a local agent, usually within one business day.</p>
        </div>
        <div className="card">
          <h3>Bank accounts</h3>
          {accounts.data?.items.length === 0 && <Empty icon="🏦" text="No bank accounts yet" />}
          <div className="list">
            {accounts.data?.items.map((a) => (
              <div key={a.id} className="list-item">
                <div className="flex1">
                  <div className="main-text">{a.bankName} <span className="chip">{a.currency}</span></div>
                  <div className="sub-text">{a.accountName} · {a.accountNumber}</div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => api.del(`/api/bank-accounts/${a.id}`).then(accounts.reload)}>Remove</Button>
              </div>
            ))}
          </div>
          <h3 className="mt">Recent withdrawals</h3>
          <div className="list">
            {history.data?.items.length === 0 && <Empty icon="🏦" />}
            {history.data?.items.map((tx) => <TxRow key={tx.id} tx={tx} onClick={() => nav(`/app/transactions/${tx.id}`)} />)}
          </div>
        </div>
      </div>
      <PinModal open={pinOpen} onClose={() => setPinOpen(false)} onSubmit={submit} loading={loading} summary={<KV k="Withdraw" v={`${amount} ${cur}`} />} />
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add bank account">
        <Field label="Bank name"><Input value={bank.bankName} onChange={(e) => setBank({ ...bank, bankName: e.target.value })} /></Field>
        <Field label="Account holder name"><Input value={bank.accountName} onChange={(e) => setBank({ ...bank, accountName: e.target.value })} /></Field>
        <Field label="Account number / IBAN"><Input value={bank.accountNumber} onChange={(e) => setBank({ ...bank, accountNumber: e.target.value })} /></Field>
        <div className="grid cols-2">
          <Field label={t('common.currency')}>
            <Select value={bank.currency} onChange={(e) => setBank({ ...bank, currency: e.target.value })}>{(config?.currencies ?? []).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</Select>
          </Field>
          <Field label="Country">
            <Select value={bank.country} onChange={(e) => setBank({ ...bank, country: e.target.value })}><option value="">—</option>{(config?.countries ?? []).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</Select>
          </Field>
        </div>
        <Field label="SWIFT / routing (optional)"><Input value={bank.swift} onChange={(e) => setBank({ ...bank, swift: e.target.value })} /></Field>
        <Button block onClick={addBank} disabled={!bank.bankName || !bank.accountName || !bank.accountNumber}>{t('common.save')}</Button>
      </Modal>
    </div>
  );
}
