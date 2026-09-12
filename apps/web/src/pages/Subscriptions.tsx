import { useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { Button, Chip, Empty, Field, Input, KV, PageHeader, PinModal, StatusBadge, useAsync } from '../components/ui';

/** Subscriptions you pay from your wallet: look up a merchant plan by code, confirm the mandate, follow invoices, cancel. */
export function Subscriptions() {
  const { money, toast } = useStore();
  const t = useT();
  const view = useAsync(() => api.get<any>('/api/billing/subscriptions'), []);
  const [code, setCode] = useState('');
  const [plan, setPlan] = useState<any>(null);
  const [pin, setPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const err = (e: any) => toast(e.message, 'error');
  const lookup = () => api.get<any>(`/api/billing/plans/${code.trim()}`).then((r) => setPlan(r.plan)).catch(err);
  const subscribe = (p: string) => { setBusy(true); api.post<any>('/api/billing/subscriptions', { plan: plan.code, pin: p }).then((r) => { setPin(false); setPlan(null); setCode(''); view.reload(); toast(r.invoice ? `Subscribed · ${money(r.invoice.totalMinor, r.invoice.currency)} paid` : 'Trial started', 'success'); }).catch(err).finally(() => setBusy(false)); };
  const cancel = (id: string) => api.post(`/api/billing/subscriptions/${id}/cancel`, {}).then(() => { view.reload(); toast('Cancelled at the end of the period', 'success'); }).catch(err);
  const every = (p: any) => `${p.intervalCount > 1 ? `${p.intervalCount} ` : ''}${p.interval}${p.intervalCount > 1 ? 's' : ''}`;
  return (
    <div>
      <PageHeader title={t('nav.subscriptions')} subtitle="Plans you pay from your BitriPay balance. Each charge shows up as an ordinary merchant payment with its invoice number." />
      <div className="grid cols-2">
        <div className="card">
          <h3>Add a subscription</h3>
          <Field label="Plan code from the merchant"><div className="row" style={{ gap: 8 }}><Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="home-20-mbps-a1b2" /><Button variant="secondary" onClick={lookup} disabled={!code.trim()}>Look up</Button></div></Field>
          {plan && (
            <div className="card" style={{ background: 'var(--bg-soft)' }}>
              <div className="main-text">{plan.name}</div>
              {plan.description && <div className="sub-text">{plan.description}</div>}
              <KV k="Price" v={`${money(plan.amountMinor, plan.currency)} every ${every(plan)}${plan.taxBps ? ` + ${plan.taxBps / 100}% ${plan.taxLabel ?? 'tax'}` : ''}`} />
              {plan.usageUnit && <KV k="Usage" v={`${money(plan.usagePriceMinor, plan.currency)} per ${plan.usageUnit}, billed with the period`} />}
              {plan.trialDays > 0 && <KV k="Trial" v={`${plan.trialDays} days free`} />}
              <Button onClick={() => setPin(true)} disabled={plan.status !== 'ACTIVE'}>Subscribe</Button>
            </div>
          )}
        </div>
        <div className="card">
          <h3>Your subscriptions</h3>
          {(view.data?.items ?? []).length === 0 && <Empty icon="🔄" text="No subscription yet." />}
          {(view.data?.items ?? []).map((s: any) => (
            <div key={s.id} className="list-item" style={{ display: 'block' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div className="main-text">{s.plan.name}</div>
                <StatusBadge status={s.status} />
              </div>
              <div className="sub-text">{money(s.plan.amountMinor, s.plan.currency)} every {every(s.plan)} · next {s.status === 'PAST_DUE' ? 'retry' : 'charge'} {new Date(s.nextChargeAt).toLocaleDateString()}{s.cancelAtPeriodEnd ? ' · ends after this period' : ''}{s.lastError ? ` · ${s.lastError}` : ''}</div>
              {['ACTIVE', 'TRIALING', 'PAST_DUE'].includes(s.status) && !s.cancelAtPeriodEnd && <Button size="sm" variant="ghost" onClick={() => cancel(s.id)}>Cancel</Button>}
            </div>
          ))}
          <h4 style={{ marginTop: 16 }}>Invoices</h4>
          {(view.data?.invoices ?? []).map((i: any) => (
            <div key={i.id} className="list-item">
              <div className="flex1"><div className="main-text">{i.number}</div><div className="sub-text">{i.periodStart.slice(0, 10)} → {i.periodEnd.slice(0, 10)}{i.taxMinor ? ` · tax ${money(i.taxMinor, i.currency)}` : ''}{i.usageQty ? ` · usage ${i.usageQty}` : ''}</div></div>
              <div>{money(i.totalMinor, i.currency)}</div>
              <Chip kind={i.status === 'PAID' ? 'success' : i.status === 'FAILED' ? 'danger' : undefined}>{i.status}</Chip>
            </div>
          ))}
        </div>
      </div>
      <PinModal open={pin} onClose={() => setPin(false)} loading={busy} onSubmit={subscribe} title="Confirm the mandate" summary={plan ? `${plan.name}: ${money(plan.amountMinor, plan.currency)} every ${every(plan)} from your ${plan.currency} balance until you cancel.` : ''} />
    </div>
  );
}
