import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { tr } from '../lib/i18n';
import { Alert, Button, Field, Input, KV, Select } from './ui';
import { SwitchMessage } from './SwitchMessage';

type Institution = { participant_id: string; name: string; kind: string };
type Result = {
  payment: {
    payment_id: string;
    status: string;
    customer_message: { fr: string; en: string };
    tracking_reference: string;
    payer: { participant_id: string; account_masked: string | null };
    rejection: { code: string; message: string } | null;
  };
  intent: { id: string; status: string; paymentRequestCode?: string | null };
  simulation: boolean;
};
const FINAL = new Set(['COMPLETED', 'REJECTED', 'EXPIRED', 'CANCELLED']);

/**
 * Pay from your own institution (aggregator perimeter): the customer chooses the bank or mobile-money operator where
 * they hold an account and gives their identifier there; the payment goes through the national switch and the
 * institution answers. Nothing is debited from or credited to any BitriPay wallet. Works signed in (the app) and as
 * a guest (hosted checkout). A pending answer is polled until the institution decides.
 */
export function InstitutionPay({
  intentId,
  code,
  qrId,
  amount,
  amountLabel,
  merchantName,
  disabled,
  onPaid,
}: {
  intentId?: string | null;
  code?: string | null;
  qrId?: string | null;
  /** Static QR: the amount the customer typed (major units). */
  amount?: string | null;
  amountLabel: string;
  merchantName: string;
  disabled?: boolean;
  onPaid?: (result: Result) => void;
}) {
  const { user } = useStore();
  const [options, setOptions] = useState<{ available: boolean; simulation: boolean; institutions: Institution[] } | null>(null);
  const [participant, setParticipant] = useState('');
  const [account, setAccount] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const poll = useRef<number | null>(null);
  const query = intentId ? `intent=${encodeURIComponent(intentId)}` : code ? `code=${encodeURIComponent(code)}` : qrId ? `qr=${encodeURIComponent(qrId)}` : '';
  useEffect(() => {
    if (!query) return;
    api
      .get<{ available: boolean; simulation: boolean; institutions: Institution[] }>(`/api/pay/institutions?${query}`)
      .then((r) => {
        setOptions(r);
        if (r.institutions[0] && !participant) setParticipant(r.institutions[0].participant_id);
      })
      .catch(() => setOptions({ available: false, simulation: false, institutions: [] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  useEffect(
    () => () => {
      if (poll.current) window.clearInterval(poll.current);
    },
    [],
  );
  if (!options?.available) return null;

  const finish = (r: Result) => {
    setResult(r);
    if (FINAL.has(r.payment.status)) {
      if (poll.current) window.clearInterval(poll.current);
      poll.current = null;
      if (r.payment.status === 'COMPLETED') onPaid?.(r);
    }
  };
  const pay = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.post<Result>('/api/pay/institution', {
        intent_id: intentId ?? undefined,
        code: code ?? undefined,
        qr_id: qrId ?? undefined,
        amount: amount ?? undefined,
        participant_id: participant,
        account_token: account.trim(),
      });
      finish(r);
      if (!FINAL.has(r.payment.status)) {
        let ticks = 0;
        poll.current = window.setInterval(() => {
          ticks += 1;
          if (ticks > 40 && poll.current) window.clearInterval(poll.current);
          api
            .get<Result>(`/api/pay/institution/${r.payment.payment_id}?intent=${encodeURIComponent(r.intent.id)}`)
            .then(finish)
            .catch(() => {});
        }, 3000);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const institution = options.institutions.find((i) => i.participant_id === participant);
  const done = !!result && FINAL.has(result.payment.status);

  return (
    <div className="card soft compact mb" data-testid="institution-pay">
      <h4 style={{ marginTop: 0 }}>{tr('Pay from your bank or mobile money')}</h4>
      <p className="small muted">
        {tr('The money leaves the account you already hold at your institution and reaches {0} at its institution through the national switch. BitriPay holds nothing.', { 0: merchantName })}
      </p>
      {error && <Alert kind="error">{error}</Alert>}
      {result ? (
        <div>
          <KV k={tr('Institution')} v={institution?.name ?? result.payment.payer.participant_id} />
          <KV k={tr('Account')} v={result.payment.payer.account_masked ?? '•••'} />
          <KV k={tr('Amount')} v={amountLabel} />
          <KV
            k={tr('Status')}
            v={<span className={`chip ${result.payment.status === 'COMPLETED' ? 'success' : result.payment.status === 'REJECTED' ? 'danger' : 'warning'}`}>{result.payment.status}</span>}
          />
          <KV k={tr('Reference')} v={<span className="mono tiny">{result.payment.tracking_reference}</span>} />
          <SwitchMessage message={result.payment.customer_message} />
          {!done && <p className="tiny muted">{tr('Waiting for your institution to answer…')}</p>}
          {result.payment.status === 'REJECTED' && (
            <Button size="sm" variant="secondary" onClick={() => setResult(null)}>
              {tr('Try another institution')}
            </Button>
          )}
        </div>
      ) : (
        <>
          <Field label={tr('Your institution')}>
            <Select value={participant} onChange={(e) => setParticipant(e.target.value)} data-testid="institution-select">
              {options.institutions.map((i) => (
                <option key={i.participant_id} value={i.participant_id}>
                  {i.name} · {i.kind === 'BANK' ? tr('bank') : i.kind === 'EMI' || i.kind === 'MMO' ? tr('mobile money') : i.kind.toLowerCase()}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={tr('Your identifier at this institution')} hint={tr('Mobile money number or account number. Your institution asks for your own PIN; BitriPay never sees it.')}>
            <Input value={account} onChange={(e) => setAccount(e.target.value)} placeholder={user?.phone ?? '+243…'} inputMode="tel" data-testid="institution-account" />
          </Field>
          {options.simulation && <p className="tiny muted">{tr('Simulation connection: fictitious institutions answer as the real ones would.')}</p>}
          <Button size="lg" block loading={loading} disabled={disabled || !participant || account.trim().length < 4} onClick={pay} data-testid="institution-pay-button">
            {tr('Pay {0} from my institution', { 0: amountLabel })}
          </Button>
        </>
      )}
    </div>
  );
}
