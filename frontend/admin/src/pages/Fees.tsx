import { useEffect, useState } from 'react';
import { tr } from '../lib/i18n';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, Field, Input, PageHeader, Select, Switch, Tabs, useAsync, Alert } from '../components/ui';
import { FEE_TYPES, FEE_TYPE_LABELS } from '@bitripay/shared';

export function Fees() {
  const { toast, config, refresh } = useStore();
  const settings = useAsync(() => api.get<any>('/api/admin/settings'), []);
  const [tab, setTab] = useState<'fees' | 'limits' | 'referral' | 'app'>('fees');
  const [fees, setFees] = useState<any>(null);
  const [limits, setLimits] = useState<any>(null);
  const [referral, setReferral] = useState<any>(null);
  const [app, setApp] = useState<any>(null);
  useEffect(() => {
    if (settings.data) {
      setFees(settings.data.fees);
      setLimits(settings.data.limits);
      setReferral(settings.data.referral);
      setApp(settings.data.app);
    }
  }, [settings.data]);
  const save = async (key: string, value: unknown) => {
    try {
      await api.put(`/api/admin/settings/${key}`, { value });
      toast(tr('Saved'), 'success');
      refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const base = config?.baseCurrency ?? 'USD';
  if (!fees || !limits || !referral || !app) return null;
  return (
    <div>
      <PageHeader title={tr('Fees, limits, referral & platform')} subtitle={`Fixed amounts are in ${base} minor units (e.g. 100 = 1.00). Percentages are basis points (100 bps = 1%).`} />
      <Tabs
        tabs={[
          { id: 'fees', label: tr('Fees & charges') },
          { id: 'limits', label: tr('Transaction limits') },
          { id: 'referral', label: tr('Referral levels') },
          { id: 'app', label: tr('Platform settings') },
        ]}
        value={tab}
        onChange={(v) => setTab(v as any)}
      />
      {tab === 'fees' && (
        <div className="card">
          <p className="tiny muted">
            {tr(
              'The published tariff grid: BitriPay fee as a percentage of the amount (basis points) plus an optional fixed part, the amount band of the operation and the agent commission paid out of the fee. Blank or 0 = no bound / platform default. Statements, quotes and the developer portal show these figures; versioned schedules (Finance operations) layer on top.',
            )}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{tr('Operation')}</th>
                  <th>{tr('Fee %')}</th>
                  <th>{tr('Fixed ({0} minor)', { 0: base })}</th>
                  <th>{tr('Min amount ({0} minor)', { 0: base })}</th>
                  <th>{tr('Max amount ({0} minor)', { 0: base })}</th>
                  <th>{tr('Agent commission %')}</th>
                  <th>{tr('Example on 100.00')}</th>
                </tr>
              </thead>
              <tbody>
                {FEE_TYPES.map((t) => {
                  const r = fees[t] ?? { fixed: 0, bps: 0 };
                  const set = (patch: Record<string, number | undefined>) => setFees({ ...fees, [t]: { ...r, ...patch } });
                  const num = (v: string) => (v === '' ? undefined : Number(v));
                  return (
                    <tr key={t}>
                      <td>
                        <b>{FEE_TYPE_LABELS[t]}</b>
                        <div className="tiny muted mono">{t}</div>
                      </td>
                      <td>
                        <Input type="number" step="0.01" value={(r.bps ?? 0) / 100} onChange={(e) => set({ bps: Math.round(Number(e.target.value) * 100) })} style={{ width: 90 }} />
                      </td>
                      <td>
                        <Input type="number" value={r.fixed ?? 0} onChange={(e) => set({ fixed: Number(e.target.value) })} style={{ width: 100 }} />
                      </td>
                      <td>
                        <Input type="number" value={r.minAmount ?? ''} onChange={(e) => set({ minAmount: num(e.target.value) })} style={{ width: 110 }} placeholder="none" />
                      </td>
                      <td>
                        <Input type="number" value={r.maxAmount ?? ''} onChange={(e) => set({ maxAmount: num(e.target.value) })} style={{ width: 110 }} placeholder="none" />
                      </td>
                      <td>
                        <Input
                          type="number"
                          step="0.01"
                          value={r.agentBps === undefined ? '' : r.agentBps / 100}
                          onChange={(e) => set({ agentBps: e.target.value === '' ? undefined : Math.round(Number(e.target.value) * 100) })}
                          style={{ width: 90 }}
                          placeholder="default"
                        />
                      </td>
                      <td className="muted small">
                        {(((r.fixed ?? 0) + (10000 * (r.bps ?? 0)) / 10000) / 100).toFixed(2)} {base}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Button className="mt" onClick={() => save('fees', fees)}>
            {tr('Save tariff grid')}
          </Button>
        </div>
      )}
      {tab === 'limits' && (
        <div className="card">
          <div className="grid cols-2">
            {(['unverified', 'verified'] as const).map((tier) => (
              <div key={tier} className="card soft">
                <h4>{tier === 'unverified' ? tr('Unverified accounts (no KYC)') : tr('Verified accounts (KYC approved)')}</h4>
                <Field label={`Per transaction (${base} minor units)`}>
                  <Input type="number" value={limits[tier].perTransaction} onChange={(e) => setLimits({ ...limits, [tier]: { ...limits[tier], perTransaction: Number(e.target.value) } })} />
                </Field>
                <Field label={tr('Daily total')}>
                  <Input type="number" value={limits[tier].daily} onChange={(e) => setLimits({ ...limits, [tier]: { ...limits[tier], daily: Number(e.target.value) } })} />
                </Field>
              </div>
            ))}
          </div>
          <Button className="mt" onClick={() => save('limits', limits)}>
            {tr('Save limits')}
          </Button>
        </div>
      )}
      {tab === 'referral' && (
        <div className="card">
          <Switch on={referral.enabled} onChange={(v) => setReferral({ ...referral, enabled: v })} label={tr('Referral program enabled')} />
          <Field label={tr('Reward trigger')}>
            <Select value={referral.trigger} onChange={(e) => setReferral({ ...referral, trigger: e.target.value })}>
              <option value="first_deposit">{tr('When the referred user makes their first deposit')}</option>
              <option value="registration">{tr('Immediately at registration')}</option>
            </Select>
          </Field>
          <h4>{tr('Level packages (reward per level, {0} minor units)', { 0: base })}</h4>
          {referral.rewards.map((r: number, i: number) => (
            <div key={i} className="row mb-sm">
              <span style={{ width: 80 }}>{tr('Level {0}', { 0: i + 1 })}</span>
              <Input
                type="number"
                value={r}
                onChange={(e) => setReferral({ ...referral, rewards: referral.rewards.map((x: number, j: number) => (j === i ? Number(e.target.value) : x)) })}
                style={{ width: 160 }}
              />
              <Button size="sm" variant="ghost" onClick={() => setReferral({ ...referral, rewards: referral.rewards.filter((_: number, j: number) => j !== i) })}>
                {tr('Remove')}
              </Button>
            </div>
          ))}
          <div className="row">
            <Button variant="secondary" size="sm" onClick={() => setReferral({ ...referral, rewards: [...referral.rewards, 0] })}>
              {tr('+ Add level')}
            </Button>
            <Button onClick={() => save('referral', referral)}>{tr('Save referral settings')}</Button>
          </div>
        </div>
      )}
      {tab === 'app' && (
        <div className="card">
          <div className="grid cols-2">
            <Field label={tr('Support email')}>
              <Input value={app.supportEmail} onChange={(e) => setApp({ ...app, supportEmail: e.target.value })} />
            </Field>
            <Field label={tr('Default agent commission (bps of cash-in/out)')}>
              <Input type="number" value={app.agentCommissionBps} onChange={(e) => setApp({ ...app, agentCommissionBps: Number(e.target.value) })} />
            </Field>
            <Field label={tr('P2P trade fee (bps, charged to seller)')}>
              <Input type="number" value={app.p2pFeeBps} onChange={(e) => setApp({ ...app, p2pFeeBps: Number(e.target.value) })} />
            </Field>
            <Field label={tr('Exchange margin (bps)')}>
              <Input type="number" value={app.exchangeMarginBps} onChange={(e) => setApp({ ...app, exchangeMarginBps: Number(e.target.value) })} />
            </Field>
          </div>
          <h4>{tr('Automated merchant settlements')}</h4>
          <div className="grid cols-3">
            <Switch on={app.autoSettlement.enabled} onChange={(v) => setApp({ ...app, autoSettlement: { ...app.autoSettlement, enabled: v } })} label={tr('Enabled')} />
            <Field label={`Minimum balance to settle (${base} minor)`}>
              <Input type="number" value={app.autoSettlement.minAmount} onChange={(e) => setApp({ ...app, autoSettlement: { ...app.autoSettlement, minAmount: Number(e.target.value) } })} />
            </Field>
            <Field label={tr('Interval (hours)')}>
              <Input type="number" value={app.autoSettlement.intervalHours} onChange={(e) => setApp({ ...app, autoSettlement: { ...app.autoSettlement, intervalHours: Number(e.target.value) } })} />
            </Field>
          </div>
          <h4>{tr('Access control')}</h4>
          <div className="col mb">
            <Switch on={app.registrationOpen} onChange={(v) => setApp({ ...app, registrationOpen: v })} label={tr('Registration open')} />
            <Switch on={app.requireKycForWithdrawals} onChange={(v) => setApp({ ...app, requireKycForWithdrawals: v })} label={tr('Require KYC before withdrawals')} />
            <Switch on={app.maintenanceMode} onChange={(v) => setApp({ ...app, maintenanceMode: v })} label={tr('Maintenance mode (blocks all user operations except admin)')} />
          </div>
          {app.maintenanceMode && <Alert kind="warning">{tr('Maintenance mode is ON – users see a "site under maintenance" message for any write operation.')}</Alert>}
          <Button onClick={() => save('app', app)}>{tr('Save platform settings')}</Button>
        </div>
      )}
    </div>
  );
}
