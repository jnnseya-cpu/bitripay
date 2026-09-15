import { useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { useT, tr } from '../lib/i18n';
import { Alert, Button, Empty, Field, Input, KV, Modal, PageHeader, PinModal, Select, TxRow, useAsync } from '../components/ui';
import type { VirtualCard, Transaction } from '@bitripay/shared';
import { currencyFlag, toMinor } from '@bitripay/shared';

export function VirtualCards() {
  const t = useT();
  const { config, wallets, money, toast, refreshWallets } = useStore();
  const cards = useAsync(() => api.get<{ items: VirtualCard[] }>('/api/virtual-cards'), []);
  const [action, setAction] = useState<null | { type: 'issue' | 'fund' | 'withdraw' | 'reveal'; card?: VirtualCard }>(null);
  const [cur, setCur] = useState(wallets[0]?.currency || 'USD');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [revealed, setRevealed] = useState<any>(null);
  const [selected, setSelected] = useState<VirtualCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // A card is only ever loaded from the wallet of the same currency: nothing is created on the card itself.
  const fundingWallet = wallets.find((w) => w.currency === (action?.type === 'issue' ? cur : action?.card?.currency));
  const overWallet = (() => {
    if (action?.type !== 'fund' || !amount) return false;
    const decimals = config?.currencies?.find((c) => c.code === action.card?.currency)?.decimals ?? 2;
    try {
      return toMinor(amount, decimals) > (fundingWallet?.balance ?? 0);
    } catch {
      return false;
    }
  })();
  const txs = useAsync(() => (selected ? api.get<{ items: Transaction[] }>(`/api/virtual-cards/${selected.id}/transactions`) : Promise.resolve({ items: [] })), [selected?.id, cards.data]);

  const run = async (pin: string) => {
    if (!action) return;
    setLoading(true);
    setError(null);
    try {
      if (action.type === 'issue') await api.post('/api/virtual-cards', { currency: cur, label: label || null, amount: amount || undefined, pin });
      if (action.type === 'fund') await api.post(`/api/virtual-cards/${action.card!.id}/fund`, { amount, pin });
      if (action.type === 'withdraw') await api.post(`/api/virtual-cards/${action.card!.id}/withdraw`, { amount, pin });
      if (action.type === 'reveal') {
        const r = await api.post<{ card: any }>(`/api/virtual-cards/${action.card!.id}/reveal`, { pin });
        setRevealed(r.card);
      } else toast(tr('Done'), 'success');
      setAction(null);
      setAmount('');
      cards.reload();
      refreshWallets();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const setStatus = async (card: VirtualCard, s: 'freeze' | 'unfreeze' | 'close') => {
    await api.post(`/api/virtual-cards/${card.id}/${s}`);
    cards.reload();
    refreshWallets();
    if (s === 'close') setSelected(null);
  };

  return (
    <div>
      <PageHeader
        title={t('nav.cards')}
        subtitle={tr('Create virtual cards for online purchases without exposing your real card. Merchants on BitriPay checkout accept them.')}
        actions={<Button onClick={() => setAction({ type: 'issue' })}>{tr('+ New virtual card')}</Button>}
      />
      {error && <Alert kind="error">{error}</Alert>}
      {cards.data?.items.length === 0 && (
        <div className="card">
          <Empty icon="💳" text={tr('No virtual cards yet')} />
        </div>
      )}
      <div className="grid cols-2">
        {cards.data?.items.map((c) => (
          <div key={c.id}>
            <div className={`vcard ${c.status === 'frozen' ? 'frozen' : ''}`} onClick={() => setSelected(c)} style={{ cursor: 'pointer' }}>
              <div className="row between">
                <span className="bold">{tr('BitriPay Virtual')}</span>
                <span className="chip" style={{ background: 'rgba(255,255,255,0.2)', color: '#fff' }}>
                  {c.status}
                </span>
              </div>
              <div className="num">{c.maskedNumber}</div>
              <div className="row between">
                <div>
                  <div className="tiny" style={{ opacity: 0.7 }}>
                    {tr('CARD HOLDER')}
                  </div>
                  <div className="bold">{c.holderName}</div>
                </div>
                <div>
                  <div className="tiny" style={{ opacity: 0.7 }}>
                    {tr('EXPIRES')}
                  </div>
                  <div className="bold">
                    {String(c.expMonth).padStart(2, '0')}/{String(c.expYear).slice(-2)}
                  </div>
                </div>
                <div>
                  <div className="tiny" style={{ opacity: 0.7 }}>
                    {tr('BALANCE')}
                  </div>
                  <div className="bold">{money(c.balance, c.currency)}</div>
                </div>
              </div>
            </div>
            <div className="row wrap mt-sm">
              <Button size="sm" onClick={() => setAction({ type: 'fund', card: c })} disabled={c.status !== 'active'}>
                {tr('Fund')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setAction({ type: 'withdraw', card: c })}>
                {tr('Withdraw')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setAction({ type: 'reveal', card: c })}>
                {tr('Show details')}
              </Button>
              {c.status === 'active' ? (
                <Button size="sm" variant="ghost" onClick={() => setStatus(c, 'freeze')}>
                  {tr('Freeze')}
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setStatus(c, 'unfreeze')}>
                  {tr('Unfreeze')}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => confirm('Close this card? Remaining balance returns to your wallet.') && setStatus(c, 'close')}>
                {tr('Close')}
              </Button>
            </div>
          </div>
        ))}
      </div>
      {selected && (
        <div className="card mt">
          <h3>{tr('Card activity · •••• {0}', { 0: selected.maskedNumber.slice(-4) })}</h3>
          {txs.data?.items.length === 0 && <Empty icon="🧾" />}
          <div className="list">
            {txs.data?.items.map((tx) => (
              <TxRow key={tx.id} tx={tx} />
            ))}
          </div>
        </div>
      )}
      <Modal
        open={!!action && action.type !== 'reveal'}
        onClose={() => setAction(null)}
        title={action?.type === 'issue' ? tr('New virtual card') : action?.type === 'fund' ? tr('Fund card') : tr('Withdraw from card')}
      >
        {action?.type === 'issue' ? (
          <>
            <Field label={t('common.currency')}>
              <Select value={cur} onChange={(e) => setCur(e.target.value)}>
                {(config?.currencies ?? []).map((c) => (
                  <option key={c.code} value={c.code}>
                    {currencyFlag(c.code)} {c.code}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={tr('Label (optional)')}>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={tr('Subscriptions')} />
            </Field>
            <Field label={`First load (${cur})`} hint={issueTerms(config?.fees?.virtual_card_issue, cur)}>
              <Input
                className="amount-input"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
                placeholder={issuePlaceholder(config?.fees?.virtual_card_issue)}
              />
            </Field>
          </>
        ) : (
          <Field
            label={`${t('common.amount')} (${action?.card?.currency})`}
            hint={
              action?.type === 'fund'
                ? `Taken from your ${action.card?.currency} wallet · available ${money(fundingWallet?.balance ?? 0, action.card?.currency ?? 'USD')}`
                : `Returned to your ${action?.card?.currency} wallet · on the card ${money(action?.card?.balance ?? 0, action?.card?.currency ?? 'USD')}`
            }
          >
            <Input className="amount-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
          </Field>
        )}
        {overWallet && (
          <Alert kind="error">
            Your {action?.card?.currency} wallet holds {money(fundingWallet?.balance ?? 0, action?.card?.currency ?? 'USD')}. Add money to the wallet first.
          </Alert>
        )}
        <PinInline onSubmit={run} loading={loading} disabled={(action?.type !== 'issue' && !amount) || overWallet} />
      </Modal>
      <PinModal open={action?.type === 'reveal'} onClose={() => setAction(null)} onSubmit={run} loading={loading} title={tr('Reveal card details')} />
      <Modal open={!!revealed} onClose={() => setRevealed(null)} title={tr('Card details')}>
        {revealed && (
          <>
            <KV k="Number" v={<span className="mono">{revealed.number.replace(/(.{4})/g, '$1 ').trim()}</span>} />
            <KV k="Expiry" v={`${String(revealed.expMonth).padStart(2, '0')}/${revealed.expYear}`} />
            <KV k="CVV" v={<span className="mono">{revealed.cvv}</span>} />
            <KV k="Name" v={revealed.holderName} />
            <p className="small muted mt">{tr('Use these details at any BitriPay-powered checkout. Keep them private.')}</p>
          </>
        )}
      </Modal>
    </div>
  );
}

function PinInline({ onSubmit, loading, disabled }: { onSubmit: (pin: string) => void; loading: boolean; disabled?: boolean }) {
  const t = useT();
  const [pin, setPin] = useState('');
  return (
    <>
      <Field label={t('common.pin')}>
        <Input className="pin-input" type="password" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
      </Field>
      <Button block loading={loading} disabled={disabled || pin.length < 4} onClick={() => onSubmit(pin)}>
        {t('common.confirm')}
      </Button>
    </>
  );
}

/** The published terms of a card issue: fixed part + percentage of the first load, minimum first load (base-currency figures). */
function issueTerms(rule: { fixed?: number; bps?: number; minAmount?: number } | undefined, currency: string): string {
  if (!rule) return '';
  const parts: string[] = [];
  if (rule.fixed) parts.push(`fixed ${(rule.fixed / 100).toFixed(2)}`);
  if (rule.bps) parts.push(`${(rule.bps / 100).toFixed(2)}% of the first load`);
  if (rule.minAmount) parts.push(`minimum first load ${(rule.minAmount / 100).toFixed(2)}`);
  return parts.length ? `Issue fee: ${parts.join(' + ').replace(' + minimum', ' · minimum')} (${currency} equivalent). Leave empty to load the minimum.` : '';
}
const issuePlaceholder = (rule: { minAmount?: number } | undefined) => (rule?.minAmount ? (rule.minAmount / 100).toFixed(2) : '0.00');
