import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { Alert, Button, Chip, Empty, KV, Modal, PageHeader, Select, StatusBadge, useAsync } from '../components/ui';
import { SwitchMessage } from '../components/SwitchMessage';
import { formatMoney } from '@bitripay/shared';

/** Payment states of the national switch (dossier §7): before emission, in flight, uncertain, terminal. */
const STATES = ['RECEIVED', 'REQUIRES_ACTION', 'READY', 'DISPATCHING', 'PENDING', 'AUTHORIZED', 'UNKNOWN', 'COMPLETED', 'REJECTED', 'EXPIRED', 'CANCELLED'];
const UNAVAILABLE_CODES = new Set(['switch_unavailable', 'link_down', 'circuit_open', 'timeout', 'provider_unavailable', 'service_unavailable']);
/** Marker the loader throws when the API answered with a link condition (down, timed out, circuit open) rather than a payment state. */
const UNAVAILABLE = 'SWITCH_UNAVAILABLE';
const isUnavailable = (e: any) => e?.status === 503 || e?.status === 504 || UNAVAILABLE_CODES.has(String(e?.code ?? '').toLowerCase());
/** `useAsync` keeps only the message, so the link condition is translated into the marker before it gets there. */
const load = <T,>(path: string) =>
  api.get<T>(path).catch((e) => {
    throw new Error(isUnavailable(e) ? UNAVAILABLE : e.message);
  });

/**
 * National switch payments (aggregator phase, DRC): every payment a merchant created through the partner API with its
 * status and the customer wording in the user's language. Read-only view over `/api/v1/payments`; the merchant acts
 * (cancel, refund, consent) from the API so that every command keeps its idempotency key.
 */
export function SwitchPayments() {
  const { user, config } = useStore();
  const t = useT();
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<any>(null);
  const list = useAsync(() => load<{ data: any[] }>(`/api/v1/payments${qs({ status: status || null, limit: 100 })}`), [status]);
  const timeline = useAsync(() => (selected ? load<any>(`/api/v1/payments/${selected.payment_id}/timeline`) : Promise.resolve(null)), [selected?.payment_id]);
  // Platform staff only: merchants and customers use the gateway (banks and mobile money are reached behind it) and
  // the switch connection, its states and its interchange stay with BitriPay under the aggregator licence.
  if (user?.role !== 'admin')
    return (
      <Alert kind="info">
        The national switch is operated by BitriPay. Your payments through banks and mobile money show under <Link to="/app/merchant">Merchant</Link> and{' '}
        <Link to="/app/transactions">Transactions</Link>.
      </Alert>
    );
  const money = (a: { currency: string; value_minor: string } | null | undefined) => {
    if (!a) return '—';
    const cur = (config?.currencies ?? []).find((c) => c.code === a.currency) ?? { code: a.currency, symbol: a.currency, decimals: 2 };
    return formatMoney(Number(a.value_minor), cur);
  };
  const unavailable = list.error === UNAVAILABLE;
  return (
    <div>
      <PageHeader
        title={t('nav.switchPayments')}
        subtitle="Domestic interoperability payments routed through the Switch Monétique National under Instruction n°58 of the Banque Centrale du Congo. BitriPay initiates, orchestrates, normalises and reports; licensed institutions hold and settle the funds."
        actions={
          <Link className="btn secondary" to="/app/merchant/developer">
            Developer portal
          </Link>
        }
      />
      <p className="tiny muted" data-testid="switch-trust">
        {t('trust.notProof')} The customer wording below is the switch's own state, never a guess: «Confirmation en cours» means do not repeat the payment.
      </p>
      {unavailable && (
        <Alert kind="warning">
          <SwitchMessage unavailable />
        </Alert>
      )}
      {list.error && !unavailable && <Alert kind="error">{list.error}</Alert>}
      <div className="row wrap mb">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 260 }}>
          <option value="">All states</option>
          {STATES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Button variant="secondary" size="sm" onClick={() => list.reload()}>
          Refresh
        </Button>
      </div>
      <div className="card">
        {list.data && list.data.data.length === 0 && <Empty icon="🏦" text="No national switch payments yet. Create one with POST /v1/payments from the developer portal." />}
        <div className="list">
          {(list.data?.data ?? []).map((p: any) => (
            <div key={p.payment_id} className="list-item" data-testid="switch-payment">
              <div className="flex1">
                <div className="main-text">
                  {money(p.amount)} · {p.merchant_order_id}
                  {p.simulation && <span className="chip warning">simulation</span>}
                </div>
                <div className="sub-text mono">
                  {p.payment_id} · {p.route?.rail ?? p.route?.class ?? '—'} · {new Date(p.created_at).toLocaleString()}
                </div>
                <SwitchMessage message={p.customer_message} />
              </div>
              <StatusBadge status={p.status} />
              <Button size="sm" variant="secondary" onClick={() => setSelected(p)}>
                Timeline
              </Button>
            </div>
          ))}
        </div>
      </div>
      <Modal open={!!selected} onClose={() => setSelected(null)} title={selected ? `Payment ${selected.merchant_order_id}` : ''}>
        {selected && (
          <div>
            <div className="row wrap mb-sm">
              <StatusBadge status={selected.status} />
              <Chip>{selected.product}</Chip>
              {selected.route?.rail && <Chip>{selected.route.rail}</Chip>}
            </div>
            <SwitchMessage message={selected.customer_message} />
            <KV k="Amount" v={money(selected.amount)} />
            <KV k="Tracking reference" v={<span className="mono">{selected.tracking_reference}</span>} />
            <KV k="Authorisation" v={selected.authorization_status} />
            <KV k="Beneficiary credit" v={selected.beneficiary_credit_status} />
            <KV k="Settlement" v={selected.settlement_status} />
            <KV k="Reconciliation" v={selected.reconciliation_status} />
            {selected.rejection && <Alert kind="error">{selected.rejection.message}</Alert>}
            {selected.action && <Alert kind="info">{selected.action.message}</Alert>}
            {timeline.error === UNAVAILABLE && <SwitchMessage unavailable />}
            {timeline.data && (
              <div className="mt">
                <h4>Events</h4>
                {timeline.data.events.length === 0 && <div className="tiny muted">No events yet.</div>}
                {timeline.data.events.map((e: any) => (
                  <KV key={e.seq} k={`${e.seq} · ${e.type} · ${e.source}`} v={`${e.from ?? '—'} → ${e.to ?? '—'} · ${new Date(e.occurredAt).toLocaleString()}`} />
                ))}
                {timeline.data.journal?.length > 0 && (
                  <>
                    <h4 className="mt">Ledger facts</h4>
                    {timeline.data.journal.map((j: any, i: number) => (
                      <KV key={i} k={j.fact} v={`${j.amountMinor} ${j.currency} · ${new Date(j.occurredAt).toLocaleString()}`} />
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
