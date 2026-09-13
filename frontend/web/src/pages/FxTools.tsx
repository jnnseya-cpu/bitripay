import { useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { Alert, Button, Chip, Empty, Field, Input, KV, PageHeader, PinModal, Select, StatusBadge, Tabs, useAsync } from '../components/ui';

/** Rates & forwards: rate alerts, auto-convert rules (on receipt / sweep) and forwards that lock today's rate for a later date. */
export function FxTools() {
  const { money, toast } = useStore();
  const t = useT();
  const [tab, setTab] = useState<'alerts' | 'rules' | 'forwards'>('alerts');
  const view = useAsync(() => api.get<any>('/api/fx-tools'), [tab]);
  const currencies: string[] = view.data?.currencies ?? ['USD', 'EUR'];
  const [alert, setAlert] = useState({ baseCurrency: 'USD', quoteCurrency: 'EUR', direction: 'above', targetRate: '' });
  const [rule, setRule] = useState({ fromCurrency: 'USD', toCurrency: 'EUR', kind: 'on_receipt', share: '100', keep: '', minRate: '' });
  const [fwd, setFwd] = useState({ fromCurrency: 'USD', toCurrency: 'EUR', amount: '', settleOn: '' });
  const [quote, setQuote] = useState<any>(null);
  const [pin, setPin] = useState<null | 'rule' | 'forward'>(null);
  const [busy, setBusy] = useState(false);
  const err = (e: any) => toast(e.message, 'error');
  const rate = (a: string, b: string) => view.data?.rates?.find((r: any) => r.from === a && r.to === b);
  const addAlert = () =>
    api
      .post('/api/fx-tools/alerts', { ...alert, targetRate: Number(alert.targetRate) })
      .then(() => {
        view.reload();
        toast('Alert set', 'success');
      })
      .catch(err);
  const submitRule = (p: string) => {
    setBusy(true);
    api
      .post('/api/fx-tools/rules', {
        fromCurrency: rule.fromCurrency,
        toCurrency: rule.toCurrency,
        kind: rule.kind,
        shareBps: Math.round(Number(rule.share || '100') * 100),
        keep: rule.keep || null,
        minRate: rule.minRate ? Number(rule.minRate) : null,
        pin: p,
      })
      .then(() => {
        setPin(null);
        view.reload();
        toast('Rule saved', 'success');
      })
      .catch(err)
      .finally(() => setBusy(false));
  };
  const getQuote = () => api.get<any>(`/api/fx-tools/forwards/quote?from=${fwd.fromCurrency}&to=${fwd.toCurrency}&amount=${fwd.amount}&settleOn=${fwd.settleOn}`).then(setQuote).catch(err);
  const lock = (p: string) => {
    setBusy(true);
    api
      .post('/api/fx-tools/forwards', { ...fwd, pin: p })
      .then(() => {
        setPin(null);
        setQuote(null);
        view.reload();
        toast('Rate locked', 'success');
      })
      .catch(err)
      .finally(() => setBusy(false));
  };
  const act = (path: string) =>
    api
      .post(path, {})
      .then(() => view.reload())
      .catch(err);
  return (
    <div>
      <PageHeader title={t('nav.fxTools')} subtitle="Watch a rate, convert automatically on your own terms, or lock today's rate for a date you choose. Nothing converts without a rule you created." />
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {(view.data?.rates ?? []).slice(0, 8).map((r: any) => (
          <Chip key={`${r.from}${r.to}`}>
            {r.from}→{r.to} {r.rate.toFixed(4)} <span className="sub-text">(ref {r.midRate.toFixed(4)})</span>
          </Chip>
        ))}
      </div>
      <Tabs
        tabs={[
          { id: 'alerts', label: 'Rate alerts' },
          { id: 'rules', label: 'Auto-convert' },
          { id: 'forwards', label: 'Forwards' },
        ]}
        value={tab}
        onChange={(v) => setTab(v as any)}
      />
      {tab === 'alerts' && (
        <div className="grid cols-2">
          <div className="card">
            <h3>New alert</h3>
            <div className="grid cols-2">
              <Field label="From">
                <Select value={alert.baseCurrency} onChange={(e) => setAlert({ ...alert, baseCurrency: e.target.value })}>
                  {currencies.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
              </Field>
              <Field label="To">
                <Select value={alert.quoteCurrency} onChange={(e) => setAlert({ ...alert, quoteCurrency: e.target.value })}>
                  {currencies.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Tell me when the reference rate is">
                <Select value={alert.direction} onChange={(e) => setAlert({ ...alert, direction: e.target.value })}>
                  <option value="above">at or above</option>
                  <option value="below">at or below</option>
                </Select>
              </Field>
              <Field label="Target rate" hint={rate(alert.baseCurrency, alert.quoteCurrency) ? `now ${rate(alert.baseCurrency, alert.quoteCurrency).midRate.toFixed(4)}` : undefined}>
                <Input inputMode="decimal" value={alert.targetRate} onChange={(e) => setAlert({ ...alert, targetRate: e.target.value })} />
              </Field>
            </div>
            <Button onClick={addAlert} disabled={!alert.targetRate}>
              Set alert
            </Button>
          </div>
          <div className="card">
            <h3>Alerts</h3>
            {(view.data?.alerts ?? []).length === 0 && <Empty icon="🔔" text="No alert yet." />}
            {(view.data?.alerts ?? []).map((a: any) => (
              <div key={a.id} className="list-item">
                <div className="flex1">
                  <div className="main-text">
                    {a.baseCurrency}/{a.quoteCurrency} {a.direction} {a.targetRate}
                  </div>
                  <div className="sub-text">
                    now {a.currentRate.toFixed(4)}
                    {a.triggeredAt && (
                      <>
                        {' '}
                        · fired {new Date(a.triggeredAt).toLocaleString()} at {a.triggeredRate?.toFixed(4)}
                      </>
                    )}
                  </div>
                </div>
                <StatusBadge status={a.status} />
                {a.status === 'ACTIVE' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      api
                        .del(`/api/fx-tools/alerts/${a.id}`)
                        .then(() => view.reload())
                        .catch(err)
                    }
                  >
                    Remove
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {tab === 'rules' && (
        <div className="grid cols-2">
          <div className="card">
            <h3>New rule</h3>
            <div className="grid cols-2">
              <Field label="Convert from">
                <Select value={rule.fromCurrency} onChange={(e) => setRule({ ...rule, fromCurrency: e.target.value })}>
                  {currencies.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Into">
                <Select value={rule.toCurrency} onChange={(e) => setRule({ ...rule, toCurrency: e.target.value })}>
                  {currencies.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
              </Field>
              <Field label="When">
                <Select value={rule.kind} onChange={(e) => setRule({ ...rule, kind: e.target.value })}>
                  <option value="on_receipt">money arrives (convert a share)</option>
                  <option value="sweep">the balance is above an amount to keep (hourly sweep)</option>
                </Select>
              </Field>
              {rule.kind === 'on_receipt' ? (
                <Field label="Share of each receipt (%)">
                  <Input inputMode="decimal" value={rule.share} onChange={(e) => setRule({ ...rule, share: e.target.value })} />
                </Field>
              ) : (
                <Field label={`Keep in ${rule.fromCurrency}`}>
                  <Input inputMode="decimal" value={rule.keep} onChange={(e) => setRule({ ...rule, keep: e.target.value })} placeholder="20.00" />
                </Field>
              )}
              <Field label="Only if the rate is at least (optional)" hint="Below this the rule waits and tells you why.">
                <Input inputMode="decimal" value={rule.minRate} onChange={(e) => setRule({ ...rule, minRate: e.target.value })} />
              </Field>
            </div>
            <Button onClick={() => setPin('rule')}>Save rule</Button>
          </div>
          <div className="card">
            <h3>Rules</h3>
            {(view.data?.rules ?? []).length === 0 && <Empty icon="🔁" text="No rule yet." />}
            {(view.data?.rules ?? []).map((r: any) => (
              <div key={r.id} className="list-item" style={{ display: 'block' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div className="main-text">
                    {r.fromCurrency} → {r.toCurrency} · {r.kind === 'on_receipt' ? `${r.shareBps / 100}% of each receipt` : `keep ${money(r.keepMinor, r.fromCurrency)}`}
                    {r.minRate ? ` · rate ≥ ${r.minRate}` : ''}
                  </div>
                  <StatusBadge status={r.status} />
                </div>
                <div className="sub-text">
                  {r.runs} run(s) · {money(r.convertedMinor, r.fromCurrency)} converted{r.lastError ? ` · last: ${r.lastError}` : ''}
                </div>
                <div className="row" style={{ gap: 6, marginTop: 6 }}>
                  <Button size="sm" variant="secondary" onClick={() => act(`/api/fx-tools/rules/${r.id}/${r.status === 'ACTIVE' ? 'pause' : 'resume'}`)}>
                    {r.status === 'ACTIVE' ? 'Pause' : 'Resume'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => act(`/api/fx-tools/rules/${r.id}/delete`)}>
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {tab === 'forwards' && (
        <div className="grid cols-2">
          <div className="card">
            <h3>Lock a rate</h3>
            {view.data?.forwardSettings && !view.data.forwardSettings.enabled && <Alert kind="warning">Forwards are paused by the platform right now.</Alert>}
            <div className="grid cols-2">
              <Field label="From">
                <Select value={fwd.fromCurrency} onChange={(e) => setFwd({ ...fwd, fromCurrency: e.target.value })}>
                  {currencies.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
              </Field>
              <Field label="To">
                <Select value={fwd.toCurrency} onChange={(e) => setFwd({ ...fwd, toCurrency: e.target.value })}>
                  {currencies.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Amount">
                <Input inputMode="decimal" value={fwd.amount} onChange={(e) => setFwd({ ...fwd, amount: e.target.value })} />
              </Field>
              <Field label="Settle on" hint={view.data?.forwardSettings ? `up to ${view.data.forwardSettings.maxTenorDays} days ahead` : undefined}>
                <Input type="date" value={fwd.settleOn} onChange={(e) => setFwd({ ...fwd, settleOn: e.target.value })} />
              </Field>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <Button variant="secondary" onClick={getQuote} disabled={!fwd.amount || !fwd.settleOn}>
                Quote
              </Button>
              {quote && <Button onClick={() => setPin('forward')}>Lock {quote.rate.toFixed(4)}</Button>}
            </div>
            {quote && (
              <Alert kind="info">
                <KV k="You give" v={money(quote.amountMinor, quote.fromCurrency)} />
                <KV k="You receive on the date" v={money(quote.receiveMinor, quote.toCurrency)} />
                <KV k="Locked rate" v={quote.rate.toFixed(6)} />
                <div className="sub-text">{quote.disclosure}</div>
              </Alert>
            )}
          </div>
          <div className="card">
            <h3>Forwards</h3>
            {(view.data?.forwards ?? []).length === 0 && <Empty icon="📅" text="No forward yet." />}
            {(view.data?.forwards ?? []).map((f: any) => (
              <div key={f.id} className="list-item" style={{ display: 'block' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div className="main-text">
                    {money(f.amountMinor, f.fromCurrency)} → {money(f.receiveMinor, f.toCurrency)} at {f.rate.toFixed(4)}
                  </div>
                  <StatusBadge status={f.status} />
                </div>
                <div className="sub-text">
                  settles {f.settleOn} · locked {new Date(f.createdAt).toLocaleDateString()}
                </div>
                {f.status === 'LOCKED' && (
                  <div className="row" style={{ gap: 6, marginTop: 6 }}>
                    <Button size="sm" onClick={() => act(`/api/fx-tools/forwards/${f.id}/settle`)}>
                      Settle now
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => act(`/api/fx-tools/forwards/${f.id}/cancel`)}>
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      <PinModal
        open={pin !== null}
        onClose={() => setPin(null)}
        loading={busy}
        onSubmit={(p) => (pin === 'rule' ? submitRule(p) : lock(p))}
        title={pin === 'rule' ? 'Confirm the standing instruction' : 'Lock this rate'}
        summary={
          pin === 'rule'
            ? `${rule.fromCurrency} → ${rule.toCurrency}, ${rule.kind === 'on_receipt' ? `${rule.share}% of each receipt` : `sweep above ${rule.keep || '0'}`}`
            : quote
              ? quote.disclosure
              : ''
        }
      />
    </div>
  );
}
