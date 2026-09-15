import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { useT, tr } from '../lib/i18n';
import { AmountInput, Button, CopyButton, Field, Input, PageHeader, QrImage } from '../components/ui';

export function Receive() {
  const t = useT();
  const { user, config, wallets } = useStore();
  const [amount, setAmount] = useState('');
  const [cur, setCur] = useState(wallets[0]?.currency || config?.baseCurrency || 'USD');
  const [note, setNote] = useState('');
  const [data, setData] = useState<{ content: string; native: string } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams();
    if (amount) {
      q.set('amount', amount);
      q.set('currency', cur);
    }
    if (note) q.set('note', note);
    api
      .get<{ content: string; native: string }>(`/api/qr/me?${q}`)
      .then(setData)
      .catch(() => setData(null));
  }, [amount, cur, note]);
  const share = () => {
    if (navigator.share && data) navigator.share({ title: tr('Pay me on BitriPay'), text: `Pay @${user?.tag} on BitriPay`, url: data.content }).catch(() => {});
  };
  return (
    <div style={{ maxWidth: 720 }}>
      <PageHeader title={t('receive.title')} subtitle={t('receive.subtitle')} />
      <div className="grid cols-2">
        <div className="card center">
          {data && <QrImage value={data.content} size={260} />}
          <h3 className="mt">@{user?.tag}</h3>
          <div className="muted small">{user?.businessName || user?.fullName}</div>
          {amount && (
            <div className="bold mt-sm">
              {amount} {cur}
              {note ? ` · ${note}` : ''}
            </div>
          )}
          <div className="row mt" style={{ justifyContent: 'center' }}>
            {data && <CopyButton text={data.content} label={tr('Copy link')} />}
            {data && <CopyButton text={`@${user?.tag}`} label={tr('Copy @tag')} />}
            {typeof navigator.share === 'function' && (
              <Button variant="secondary" size="sm" onClick={share}>
                {t('common.share')}
              </Button>
            )}
            {data && (
              <a className="btn secondary sm" href={`/api/qr/image.svg?data=${encodeURIComponent(data.content)}`} download={`bitripay-${user?.tag}.svg`}>
                {tr('Download')}
              </a>
            )}
          </div>
        </div>
        <div className="card">
          <h3>{t('receive.requestAmount')}</h3>
          <p className="muted small">{tr('Optional – the payer will see these pre-filled.')}</p>
          <Field label={t('common.amount')}>
            <AmountInput amount={amount} currency={cur} onAmount={setAmount} onCurrency={setCur} currencies={(config?.currencies ?? []).map((c) => c.code)} />
          </Field>
          <Field label={t('common.note')}>
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} />
          </Field>
          <div className="alert info small">{tr('Anyone can pay this code with the BitriPay app or by opening the link in a browser.')}</div>
        </div>
      </div>
    </div>
  );
}
