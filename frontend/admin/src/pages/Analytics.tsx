import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Chip, PageHeader, Select, useAsync } from '../components/ui';
import { analyticsScenes, CHART_FAMILIES, type AnalyticsSeries, type ChartCard } from '@bitripay/charts';
import { Chart } from '@bitripay/charts/react';

const FAMILY_LABELS: Record<keyof typeof CHART_FAMILIES, string> = { comparison: 'Comparison', trends: 'Trends & time', composition: 'Composition', distribution: 'Distribution & relationships' };

/** Compact money for axis ticks. */
export function tickMoney(money: (minor: number, code: string) => string, code: string) {
  return (minor: number) => {
    const major = minor / 100;
    if (Math.abs(major) >= 100_000) return `${Math.round(major / 1000)}k`;
    if (Math.abs(major) >= 1000) return `${(major / 1000).toFixed(1)}k`;
    return money(Math.round(minor), code).replace(/[.,]00$/, '');
  };
}

/** Platform-wide charts: every family over settled operations, accounts, KYC tiers, countries, corridors and holds. */
export function Analytics() {
  const { money, config } = useStore();
  const [days, setDays] = useState(30);
  const [family, setFamily] = useState('');
  const data = useAsync(() => api.get<AnalyticsSeries>(`/api/admin/insights/analytics?days=${days}`), [days]);
  const base = config?.baseCurrency ?? 'USD';
  const cards = useMemo<ChartCard[]>(() => (data.data ? analyticsScenes(data.data, { money: (m) => money(m, base), tick: tickMoney(money, base), scope: 'platform' }) : []), [data.data, base, money]);
  const visible = family ? cards.filter((c) => c.family === family) : cards;
  const p = data.data;
  return (
    <div>
      <PageHeader
        title="Analytics & charts"
        subtitle="Comparison, trend, composition and distribution charts over the whole platform: settled volume, accounts, KYC tiers, countries, corridors and holds."
        actions={
          <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 30, 90, 365].map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </Select>
        }
      />
      {p && (
        <div className="grid cols-4">
          <div className="card">
            <div className="tiny muted">Settled operations</div>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{p.totals.count}</div>
          </div>
          <div className="card">
            <div className="tiny muted">Volume ({base})</div>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{money(p.totals.in, base)}</div>
          </div>
          <div className="card">
            <div className="tiny muted">Fees earned</div>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{money(p.totals.fees, base)}</div>
          </div>
          <div className="card">
            <div className="tiny muted">Generated</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{new Date(p.period.to).toLocaleString()}</div>
            <div className="tiny">{p.period.days}-day window</div>
          </div>
        </div>
      )}
      <div className="row wrap mt">
        <Chip selected={!family} onClick={() => setFamily('')}>
          All charts
        </Chip>
        {(Object.keys(CHART_FAMILIES) as (keyof typeof CHART_FAMILIES)[]).map((f) => (
          <Chip key={f} selected={family === f} onClick={() => setFamily(f)}>
            {FAMILY_LABELS[f]}
          </Chip>
        ))}
      </div>
      {!p && <div className="card mt">Loading…</div>}
      <div className="grid cols-2 mt">
        {visible.map((c) => (
          <div className="card" key={c.id}>
            <div className="row between">
              <h4>{c.title}</h4>
              <span className="chip">{c.kind}</span>
            </div>
            <Chart scene={c.scene} />
            <div className="tiny muted mt-sm">{c.note}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
