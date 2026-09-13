import { useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { Alert, Button, Chip, Empty, Field, Input, PageHeader, PinModal, useAsync } from '../components/ui';

/** Credit readiness: your signal, factor by factor, with tips; share it with a lender only when you say so. */
export function Credit() {
  const { toast } = useStore();
  const t = useT();
  const view = useAsync(() => api.get<any>('/api/credit'), []);
  const [lender, setLender] = useState({ lenderName: '', purpose: '', days: '90' });
  const [pin, setPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const err = (e: any) => toast(e.message, 'error');
  const r = view.data?.readiness;
  const bandKind = (b: string) => (b === 'strong' ? 'success' : b === 'good' ? 'success' : b === 'fair' ? 'warning' : 'danger');
  const grant = (p: string) => {
    setBusy(true);
    api
      .post('/api/credit/consents', { lenderName: lender.lenderName, purpose: lender.purpose || null, days: Number(lender.days) || 90, pin: p })
      .then(() => {
        setPin(false);
        setLender({ ...lender, lenderName: '', purpose: '' });
        view.reload();
        toast('Access code created', 'success');
      })
      .catch(err)
      .finally(() => setBusy(false));
  };
  return (
    <div>
      <PageHeader
        title={t('nav.credit')}
        subtitle="A signal built from your own BitriPay history that a lender can read with your consent. BitriPay does not lend and never shares your transactions."
        actions={
          <Button variant="secondary" onClick={() => api.get<any>('/api/credit?refresh=1').then(() => view.reload())}>
            Recompute
          </Button>
        }
      />
      {r && (
        <div className="grid cols-2">
          <div className="card">
            <div className="row" style={{ alignItems: 'baseline', gap: 12 }}>
              <div style={{ fontSize: '2.6rem', fontWeight: 700 }}>{r.score}</div>
              <div className="sub-text">/ 1000</div>
              <Chip kind={bandKind(r.band)}>{r.band}</Chip>
            </div>
            <div className="sub-text">
              Computed {new Date(r.computedAt).toLocaleString()} over the last {r.windowDays} days.
            </div>
            {r.signals.map((s: any) => (
              <div key={s.key} style={{ marginTop: 10 }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span>{s.label}</span>
                  <span className="sub-text">
                    {s.points} / {s.max}
                  </span>
                </div>
                <div className="progress">
                  <div style={{ width: `${Math.round((s.points / s.max) * 100)}%` }} />
                </div>
                <div className="sub-text">{s.note}</div>
              </div>
            ))}
            {r.tips.length > 0 && (
              <Alert kind="info">
                <strong>How to improve</strong>
                <ul style={{ margin: '6px 0 0 18px' }}>
                  {r.tips.map((tip: string) => (
                    <li key={tip}>{tip}</li>
                  ))}
                </ul>
              </Alert>
            )}
          </div>
          <div className="card">
            <h3>Share with a lender</h3>
            <p className="sub-text">The lender receives your score, band and the factors above for the period you choose. You can revoke at any time; every read is logged.</p>
            <Field label="Lender">
              <Input value={lender.lenderName} onChange={(e) => setLender({ ...lender, lenderName: e.target.value })} placeholder="Kivu Microfinance" />
            </Field>
            <div className="grid cols-2">
              <Field label="Purpose (optional)">
                <Input value={lender.purpose} onChange={(e) => setLender({ ...lender, purpose: e.target.value })} placeholder="stock loan" />
              </Field>
              <Field label="Valid for (days)">
                <Input inputMode="numeric" value={lender.days} onChange={(e) => setLender({ ...lender, days: e.target.value })} />
              </Field>
            </div>
            <Button onClick={() => setPin(true)} disabled={lender.lenderName.trim().length < 2}>
              Create access code
            </Button>
            <h4 style={{ marginTop: 16 }}>Consents</h4>
            {(view.data?.consents ?? []).length === 0 && <Empty icon="🔐" text="Nothing shared." />}
            {(view.data?.consents ?? []).map((c: any) => (
              <div key={c.id} className="list-item">
                <div className="flex1">
                  <div className="main-text">
                    {c.lenderName} <code>{c.accessCode}</code>
                  </div>
                  <div className="sub-text">
                    {c.purpose ?? ''} · until {c.expiresAt.slice(0, 10)} · read {c.accessCount} time(s)
                  </div>
                </div>
                <Chip kind={c.active ? 'success' : 'danger'}>{c.active ? 'active' : c.revokedAt ? 'revoked' : 'expired'}</Chip>
                {c.active && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      api
                        .del(`/api/credit/consents/${c.id}`)
                        .then(() => view.reload())
                        .catch(err)
                    }
                  >
                    Revoke
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      <PinModal
        open={pin}
        onClose={() => setPin(false)}
        loading={busy}
        onSubmit={grant}
        title="Share your readiness signal"
        summary={`${lender.lenderName} will be able to read your score and factors for ${lender.days} days.`}
      />
    </div>
  );
}
