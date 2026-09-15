import { useEffect, useState } from 'react';
import { tr } from '../lib/i18n';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Alert, Button, KV, Loading } from '../components/ui';

/**
 * Beneficiary currency confirmation (no login). In regulated corridors the recipient must confirm a non-local payout
 * currency before the payout is executed; they can accept, switch to another offered currency, or decline.
 */
export function ConfirmCurrency() {
  const { token = '' } = useParams();
  const [view, setView] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ stage: string; currency: string } | null>(null);
  const [choice, setChoice] = useState<string>('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .get<any>(`/api/routes/consent/${token}`, { token: null })
      .then((v) => {
        setView(v);
        setChoice(v.currency);
      })
      .catch((e) => setError(e.message));
  }, [token]);
  const decide = async (accept: boolean) => {
    setBusy(true);
    try {
      const r = await api.post<any>(`/api/routes/consent/${token}`, { accept, currency: accept ? choice : null }, { token: null });
      setDone({ stage: r.stage, currency: r.currency });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (error)
    return (
      <div className="auth-page">
        <div className="card" style={{ maxWidth: 480, margin: '40px auto' }}>
          <Alert kind="error">{error}</Alert>
        </div>
      </div>
    );
  if (!view) return <Loading />;
  const fmt = (n: number | null, c: string) => (n == null ? '—' : `${(n / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })} ${c}`);
  return (
    <div className="auth-page">
      <div className="card" style={{ maxWidth: 520, margin: '40px auto' }}>
        <h2>{tr('Confirm your payout currency')}</h2>
        {done ? (
          <Alert kind={done.stage === 'FAILED' ? 'warning' : 'success'}>
            {done.stage === 'FAILED'
              ? tr('You declined. The sender keeps the money and can resend in your local currency.')
              : `Thank you – the payout will be made in ${done.currency}. Stage: ${done.stage.replace(/_/g, ' ').toLowerCase()}.`}
          </Alert>
        ) : view.confirmedAt ? (
          <Alert kind="info">{tr('This transfer was already confirmed.')}</Alert>
        ) : (
          <>
            <p className="muted">{view.sender.name} is sending you money. This corridor requires you to confirm the currency you will receive before the payout is executed.</p>
            <KV k="Proposed currency" v={<b>{view.currency}</b>} />
            <KV k="Estimated amount" v={fmt(view.amount, view.currency)} />
            {view.localCurrency && <KV k="Local currency" v={view.localCurrency} />}
            <div className="mt">
              <div className="small bold mb-sm">Receive in</div>
              <div className="row wrap">
                {view.options.map((o: any) => (
                  <button key={o.currency} type="button" className={`chip ${choice === o.currency ? 'primary' : ''}`} onClick={() => setChoice(o.currency)}>
                    {o.currency}
                    {o.isLocal ? ' (local)' : ''}
                  </button>
                ))}
              </div>
              {choice !== view.currency && <div className="tiny muted mt-sm">{tr('The transfer will be re-quoted in {0} at the current disclosed rate.', { 0: choice })}</div>}
            </div>
            <div className="row mt">
              <Button loading={busy} onClick={() => decide(true)}>
                {tr('Confirm {0}', { 0: choice })}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => decide(false)}>
                {tr('Decline')}
              </Button>
            </div>
            <p className="tiny muted mt">{tr('Nothing is paid out until you confirm. Your choice is recorded in the immutable transfer log.')}</p>
          </>
        )}
      </div>
    </div>
  );
}
