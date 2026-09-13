import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, Field, Input, PageHeader, Select, Switch, Tabs, useAsync, Alert } from '../components/ui';
import { FEE_TYPES, TRANSACTION_TYPE_LABELS } from '@bitripay/shared';

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
      toast('Saved', 'success');
      refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const base = config?.baseCurrency ?? 'USD';
  if (!fees || !limits || !referral || !app) return null;
  return (
    <div>
      <PageHeader title="Fees, limits, referral & platform" subtitle={`Fixed amounts are in ${base} minor units (e.g. 100 = 1.00). Percentages are basis points (100 bps = 1%).`} />
      <Tabs
        tabs={[
          { id: 'fees', label: 'Fees & charges' },
          { id: 'limits', label: 'Transaction limits' },
          { id: 'referral', label: 'Referral levels' },
          { id: 'app', label: 'Platform settings' },
        ]}
        value={tab}
        onChange={(v) => setTab(v as any)}
      />
      {tab === 'fees' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Transaction type</th>
                  <th>Fixed ({base} minor)</th>
                  <th>Percent (bps)</th>
                  <th>Example on 100.00</th>
                </tr>
              </thead>
              <tbody>
                {FEE_TYPES.map((t) => (
                  <tr key={t}>
                    <td>{TRANSACTION_TYPE_LABELS[t]}</td>
                    <td>
                      <Input type="number" value={fees[t]?.fixed ?? 0} onChange={(e) => setFees({ ...fees, [t]: { ...fees[t], fixed: Number(e.target.value) } })} style={{ width: 120 }} />
                    </td>
                    <td>
                      <Input type="number" value={fees[t]?.bps ?? 0} onChange={(e) => setFees({ ...fees, [t]: { ...fees[t], bps: Number(e.target.value) } })} style={{ width: 120 }} />
                    </td>
                    <td className="muted small">
                      {(((fees[t]?.fixed ?? 0) + (10000 * (fees[t]?.bps ?? 0)) / 10000) / 100).toFixed(2)} {base}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Button className="mt" onClick={() => save('fees', fees)}>
            Save fees
          </Button>
        </div>
      )}
      {tab === 'limits' && (
        <div className="card">
          <div className="grid cols-2">
            {(['unverified', 'verified'] as const).map((tier) => (
              <div key={tier} className="card soft">
                <h4>{tier === 'unverified' ? 'Unverified accounts (no KYC)' : 'Verified accounts (KYC approved)'}</h4>
                <Field label={`Per transaction (${base} minor units)`}>
                  <Input type="number" value={limits[tier].perTransaction} onChange={(e) => setLimits({ ...limits, [tier]: { ...limits[tier], perTransaction: Number(e.target.value) } })} />
                </Field>
                <Field label="Daily total">
                  <Input type="number" value={limits[tier].daily} onChange={(e) => setLimits({ ...limits, [tier]: { ...limits[tier], daily: Number(e.target.value) } })} />
                </Field>
              </div>
            ))}
          </div>
          <Button className="mt" onClick={() => save('limits', limits)}>
            Save limits
          </Button>
        </div>
      )}
      {tab === 'referral' && (
        <div className="card">
          <Switch on={referral.enabled} onChange={(v) => setReferral({ ...referral, enabled: v })} label="Referral program enabled" />
          <Field label="Reward trigger">
            <Select value={referral.trigger} onChange={(e) => setReferral({ ...referral, trigger: e.target.value })}>
              <option value="first_deposit">When the referred user makes their first deposit</option>
              <option value="registration">Immediately at registration</option>
            </Select>
          </Field>
          <h4>Level packages (reward per level, {base} minor units)</h4>
          {referral.rewards.map((r: number, i: number) => (
            <div key={i} className="row mb-sm">
              <span style={{ width: 80 }}>Level {i + 1}</span>
              <Input
                type="number"
                value={r}
                onChange={(e) => setReferral({ ...referral, rewards: referral.rewards.map((x: number, j: number) => (j === i ? Number(e.target.value) : x)) })}
                style={{ width: 160 }}
              />
              <Button size="sm" variant="ghost" onClick={() => setReferral({ ...referral, rewards: referral.rewards.filter((_: number, j: number) => j !== i) })}>
                Remove
              </Button>
            </div>
          ))}
          <div className="row">
            <Button variant="secondary" size="sm" onClick={() => setReferral({ ...referral, rewards: [...referral.rewards, 0] })}>
              + Add level
            </Button>
            <Button onClick={() => save('referral', referral)}>Save referral settings</Button>
          </div>
        </div>
      )}
      {tab === 'app' && (
        <div className="card">
          <div className="grid cols-2">
            <Field label="Support email">
              <Input value={app.supportEmail} onChange={(e) => setApp({ ...app, supportEmail: e.target.value })} />
            </Field>
            <Field label="Default agent commission (bps of cash-in/out)">
              <Input type="number" value={app.agentCommissionBps} onChange={(e) => setApp({ ...app, agentCommissionBps: Number(e.target.value) })} />
            </Field>
            <Field label="P2P trade fee (bps, charged to seller)">
              <Input type="number" value={app.p2pFeeBps} onChange={(e) => setApp({ ...app, p2pFeeBps: Number(e.target.value) })} />
            </Field>
            <Field label="Exchange margin (bps)">
              <Input type="number" value={app.exchangeMarginBps} onChange={(e) => setApp({ ...app, exchangeMarginBps: Number(e.target.value) })} />
            </Field>
          </div>
          <h4>Automated merchant settlements</h4>
          <div className="grid cols-3">
            <Switch on={app.autoSettlement.enabled} onChange={(v) => setApp({ ...app, autoSettlement: { ...app.autoSettlement, enabled: v } })} label="Enabled" />
            <Field label={`Minimum balance to settle (${base} minor)`}>
              <Input type="number" value={app.autoSettlement.minAmount} onChange={(e) => setApp({ ...app, autoSettlement: { ...app.autoSettlement, minAmount: Number(e.target.value) } })} />
            </Field>
            <Field label="Interval (hours)">
              <Input type="number" value={app.autoSettlement.intervalHours} onChange={(e) => setApp({ ...app, autoSettlement: { ...app.autoSettlement, intervalHours: Number(e.target.value) } })} />
            </Field>
          </div>
          <h4>Access control</h4>
          <div className="col mb">
            <Switch on={app.registrationOpen} onChange={(v) => setApp({ ...app, registrationOpen: v })} label="Registration open" />
            <Switch on={app.requireKycForWithdrawals} onChange={(v) => setApp({ ...app, requireKycForWithdrawals: v })} label="Require KYC before withdrawals" />
            <Switch on={app.maintenanceMode} onChange={(v) => setApp({ ...app, maintenanceMode: v })} label="Maintenance mode (blocks all user operations except admin)" />
          </div>
          {app.maintenanceMode && <Alert kind="warning">Maintenance mode is ON – users see a "site under maintenance" message for any write operation.</Alert>}
          <Button onClick={() => save('app', app)}>Save platform settings</Button>
        </div>
      )}
    </div>
  );
}
