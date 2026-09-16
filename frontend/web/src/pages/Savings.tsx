import { useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { useT, tr } from '../lib/i18n';
import { Alert, Button, Chip, Empty, Field, Input, KV, Modal, PageHeader, Select, useAsync } from '../components/ui';
import { currencyFlag } from '@bitripay/shared';

/**
 * Savings: ring-fenced goals (holds on the wallet, never a separate balance), the automatic income anchor (10% minimum,
 * opt-in), round-ups on every payment, and the live-within-means monitor with its plan when spending outruns income.
 */
export function Savings() {
  const { wallets, money, toast, refreshWallets } = useStore();
  const t = useT();
  const overview = useAsync(() => api.get<any>('/api/savings'), []);
  const [goalForm, setGoalForm] = useState({ name: '', currency: wallets[0]?.currency ?? 'USD', target: '', deadline: '' });
  const [move, setMove] = useState<{ goal: any; dir: 'contribute' | 'withdraw' } | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const err = (e: any) => toast(e.message, 'error');
  const s = overview.data?.settings;
  const goals: any[] = overview.data?.goals ?? [];
  const wb = overview.data?.wellbeing;
  const saveSettings = (patch: Record<string, unknown>) =>
    api
      .put<any>('/api/savings/settings', patch)
      .then(() => {
        overview.reload();
        toast(tr('Savings settings saved'), 'success');
      })
      .catch(err);
  const createGoal = () => {
    if (!goalForm.name.trim()) return toast(tr('Give the goal a name'), 'error');
    api
      .post<any>('/api/savings/goals', {
        name: goalForm.name,
        currency: goalForm.currency,
        target: goalForm.target || null,
        deadline: goalForm.deadline ? new Date(goalForm.deadline).toISOString() : null,
      })
      .then(() => {
        setGoalForm({ ...goalForm, name: '', target: '', deadline: '' });
        overview.reload();
        toast(tr('Goal created'), 'success');
      })
      .catch(err);
  };
  const submitMove = () => {
    if (!move) return;
    setBusy(true);
    api
      .post<any>(`/api/savings/goals/${move.goal.id}/${move.dir}`, { amount })
      .then(() => {
        setMove(null);
        setAmount('');
        overview.reload();
        refreshWallets();
        toast(move.dir === 'contribute' ? 'Set aside' : 'Released to your balance', 'success');
      })
      .catch(err)
      .finally(() => setBusy(false));
  };
  const closeGoal = (g: any) => {
    if (!confirm(`Close "${g.name}"? Everything set aside goes back to your spendable balance.`)) return;
    api
      .del<any>(`/api/savings/goals/${g.id}`)
      .then(() => {
        overview.reload();
        refreshWallets();
        toast(tr('Goal closed'), 'success');
      })
      .catch(err);
  };
  const stateKind = (st: string) => (st === 'green' ? 'success' : st === 'amber' ? 'warning' : 'danger');
  const setAside = goals.reduce((acc: Record<string, number>, g) => ({ ...acc, [g.currency]: (acc[g.currency] ?? 0) + g.savedMinor }), {});

  return (
    <div>
      <PageHeader
        title={t('nav.savings')}
        subtitle={tr(
          'Money you set aside stays in your wallet but cannot be spent by accident. The anchor puts at least 10% of everything you receive into your goal; round-ups sweep the change of every payment.',
        )}
      />
      {overview.error && <Alert kind="error">{overview.error}</Alert>}
      <div className="grid cols-2">
        <div className="card">
          <h3>{tr('Living within your means')}</h3>
          {wb ? (
            <>
              <div className="row" style={{ alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Chip kind={stateKind(wb.overall)}>{wb.overall === 'green' ? tr('On track') : wb.overall === 'amber' ? tr('Watch your spending') : tr('Spending more than you receive')}</Chip>
                <span className="sub-text">last {wb.days} days</span>
              </div>
              {wb.currencies.length === 0 && <Empty icon="🌱" text={tr('No completed movements in the last 30 days yet.')} />}
              {wb.currencies.map((c: any) => (
                <div key={c.currency} className="list-item" style={{ display: 'block' }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <strong>{c.currency}</strong>
                    <Chip kind={stateKind(c.state)}>{c.state}</Chip>
                  </div>
                  <KV k={tr('Received')} v={money(c.incomeMinor, c.currency)} />
                  <KV k={tr('Spent')} v={money(c.spendMinor, c.currency)} />
                  {c.ratio !== null && <KV k={tr('Spend / income')} v={`${Math.round(c.ratio * 100)}%`} />}
                  {c.plan && (
                    <Alert kind={c.state === 'red' ? 'error' : 'warning'}>
                      <div>{c.plan.message}</div>
                      <div style={{ marginTop: 6 }}>
                        {tr('Set aside')} <strong>{money(c.plan.weeklySavingMinor, c.currency)}</strong> a week.
                        {c.plan.cutFrom.length > 0 && (
                          <> {tr('Trim: {0}.', { 0: c.plan.cutFrom.map((x: any) => `${x.type.replace(/_/g, ' ')} by ${money(x.reduceByMinor, c.currency)}`).join(', ') })}</>
                        )}
                      </div>
                    </Alert>
                  )}
                </div>
              ))}
            </>
          ) : (
            <div className="sub-text">{tr('Loading…')}</div>
          )}
        </div>
        <div className="card">
          <h3>{tr('Automatic saving')}</h3>
          {s && (
            <>
              <label className="row" style={{ gap: 8, alignItems: 'center' }}>
                <input type="checkbox" checked={s.autoAnchor} onChange={(e) => saveSettings({ autoAnchor: e.target.checked })} />
                <span>{tr('Anchor {0}% of every income into my default goal', { 0: s.anchorBps / 100 })}</span>
              </label>
              <Field label={tr('Anchor share')} hint={`Never below ${overview.data.minimumAnchorBps / 100}%; at most 50%.`}>
                <Select value={s.anchorBps} onChange={(e) => saveSettings({ anchorBps: Number(e.target.value) })}>
                  {[1000, 1500, 2000, 2500, 3000, 4000, 5000].map((b) => (
                    <option key={b} value={b}>
                      {b / 100}%
                    </option>
                  ))}
                </Select>
              </Field>
              <label className="row" style={{ gap: 8, alignItems: 'center' }}>
                <input type="checkbox" checked={s.roundUps} onChange={(e) => saveSettings({ roundUps: e.target.checked })} />
                <span>{tr('Round up every payment and keep the change')}</span>
              </label>
              <Field label="Round to">
                <Select value={s.roundToMinor} onChange={(e) => saveSettings({ roundToMinor: Number(e.target.value) })}>
                  <option value={100}>nearest 1.00</option>
                  <option value={500}>nearest 5.00</option>
                  <option value={1000}>nearest 10.00</option>
                </Select>
              </Field>
              <Field label={tr('Default goal')}>
                <Select value={s.defaultGoalId ?? ''} onChange={(e) => saveSettings({ defaultGoalId: e.target.value || null })}>
                  <option value="">— none —</option>
                  {goals.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name} ({g.currency})
                    </option>
                  ))}
                </Select>
              </Field>
              {Object.keys(setAside).length > 0 && (
                <div className="sub-text">
                  {tr('Set aside:{0} {1}', {
                    0: ' ',
                    1: Object.entries(setAside)
                      .map(([c, m]) => money(m as number, c))
                      .join(' · '),
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <div className="card">
        <h3>{tr('Goals')}</h3>
        {goals.length === 0 && <Empty icon="🎯" text={tr('No goal yet. Create one below and the anchor starts working.')} />}
        {goals.map((g) => (
          <div key={g.id} className="list-item" style={{ display: 'block' }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div className="main-text">
                  {g.name} {g.status === 'REACHED' && <Chip kind="success">reached</Chip>}
                </div>
                <div className="sub-text">
                  {money(g.savedMinor, g.currency)}
                  {g.targetMinor > 0 && <> of {money(g.targetMinor, g.currency)}</>}
                  {g.deadline && <> · by {new Date(g.deadline).toLocaleDateString()}</>}
                </div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <Button
                  size="sm"
                  onClick={() => {
                    setMove({ goal: g, dir: 'contribute' });
                    setAmount('');
                  }}
                >
                  {tr('Set aside')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={g.savedMinor <= 0}
                  onClick={() => {
                    setMove({ goal: g, dir: 'withdraw' });
                    setAmount('');
                  }}
                >
                  {tr('Release')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => closeGoal(g)}>
                  {tr('Close')}
                </Button>
              </div>
            </div>
            {g.targetMinor > 0 && (
              <div className="progress" style={{ marginTop: 8 }}>
                <div style={{ width: `${Math.round(g.progress * 100)}%` }} />
              </div>
            )}
            <div className="sub-text" style={{ marginTop: 4 }}>
              {g.projection.weeklyPaceMinor > 0 ? (
                <>
                  {tr('Pace')} {money(g.projection.weeklyPaceMinor, g.currency)} a week
                  {g.projection.weeksToTarget !== null && g.projection.weeksToTarget > 0 && <> · about {g.projection.weeksToTarget} weeks to go</>}
                  {g.projection.onTrack === false && (
                    <>
                      {' '}
                      · <span style={{ color: 'var(--danger)' }}>behind the deadline</span>
                    </>
                  )}
                </>
              ) : (
                'No contributions in the last four weeks.'
              )}
            </div>
          </div>
        ))}
        <h4 style={{ marginTop: 16 }}>{tr('New goal')}</h4>
        <div className="grid cols-2">
          <Field label={tr('Name')}>
            <Input value={goalForm.name} onChange={(e) => setGoalForm({ ...goalForm, name: e.target.value })} placeholder={tr('School fees, a moto, stock for the shop…')} />
          </Field>
          <Field label={tr('Currency')}>
            <Select value={goalForm.currency} onChange={(e) => setGoalForm({ ...goalForm, currency: e.target.value })}>
              {wallets.map((w) => (
                <option key={w.currency} value={w.currency}>
                  {currencyFlag(w.currency)} {w.currency}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={tr('Target (optional)')}>
            <Input inputMode="decimal" value={goalForm.target} onChange={(e) => setGoalForm({ ...goalForm, target: e.target.value })} placeholder="0.00" />
          </Field>
          <Field label={tr('Deadline (optional)')}>
            <Input type="date" value={goalForm.deadline} onChange={(e) => setGoalForm({ ...goalForm, deadline: e.target.value })} />
          </Field>
        </div>
        <Button onClick={createGoal}>{tr('Create goal')}</Button>
      </div>
      <Modal open={!!move} onClose={() => setMove(null)} title={move?.dir === 'contribute' ? `Set aside into ${move?.goal.name}` : `Release from ${move?.goal.name}`}>
        {move && (
          <>
            <p className="sub-text">
              {move.dir === 'contribute'
                ? tr('The amount stays in your wallet but is ring-fenced: it cannot be spent until you release it.')
                : `Up to ${money(move.goal.savedMinor, move.goal.currency)} can go back to your spendable balance.`}
            </p>
            <Field label={`Amount (${move.goal.currency})`}>
              <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" autoFocus />
            </Field>
            <Button block loading={busy} onClick={submitMove}>
              {move.dir === 'contribute' ? tr('Set aside') : tr('Release')}
            </Button>
          </>
        )}
      </Modal>
    </div>
  );
}
