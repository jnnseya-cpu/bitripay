import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { Chip, Empty, PageHeader, Select, useAsync } from '../components/ui';
import { analyticsScenes, CHART_FAMILIES, type AnalyticsSeries, type ChartCard } from '@bitripay/charts';
import { Chart } from '@bitripay/charts/react';

const FAMILY_LABELS: Record<keyof typeof CHART_FAMILIES, string> = { comparison: 'Comparison', trends: 'Trends & time', composition: 'Composition', distribution: 'Distribution & relationships' };

/** Compact money for axis ticks: whole units, thousands as k. */
export function tickMoney(money: (minor: number, code: string) => string, code: string) {
  return (minor: number) => {
    const major = minor / 100;
    if (Math.abs(major) >= 100_000) return `${Math.round(major / 1000)}k`;
    if (Math.abs(major) >= 1000) return `${(major / 1000).toFixed(1)}k`;
    return money(Math.round(minor), code).replace(/[.,]00$/, '');
  };
}

/** Every chart family over the signed-in account's own activity: customers, merchants and agents alike. */
export function Insights() {
  const { money, config, user } = useStore();
  const t = useT();
  const [days, setDays] = useState(30);
  const [family, setFamily] = useState<string>('');
  const data = useAsync(() => api.get<AnalyticsSeries>(`/api/account/analytics?days=${days}`), [days]);
  const base = config?.baseCurrency ?? 'USD';
  const cards = useMemo<ChartCard[]>(
    () => (data.data ? analyticsScenes(data.data, { money: (m) => money(m, base), tick: tickMoney(money, base), labels: { in: t('insights.in'), out: t('insights.out') }, scope: 'account' }) : []),
    [data.data, base, money, t],
  );
  const visible = family ? cards.filter((c) => c.family === family) : cards;
  const p = data.data;
  return (
    <div>
      <PageHeader
        title={t('nav.insights')}
        subtitle={t('insights.subtitle')}
        actions={
          <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 30, 90, 365].map((d) => (
              <option key={d} value={d}>
                {t('insights.days', { n: d })}
              </option>
            ))}
          </Select>
        }
      />
      {p && (
        <div className="grid cols-4">
          <div className="card">
            <div className="stat">
              <span className="label">{t('insights.operations')}</span>
              <span className="value">{p.totals.count}</span>
            </div>
          </div>
          <div className="card">
            <div className="stat">
              <span className="label">{t('insights.in')}</span>
              <span className="value">{money(p.totals.in, base)}</span>
            </div>
          </div>
          <div className="card">
            <div className="stat">
              <span className="label">{t('insights.out')}</span>
              <span className="value">{money(p.totals.out, base)}</span>
            </div>
          </div>
          <div className="card">
            <div className="stat">
              <span className="label">{t('insights.fees')}</span>
              <span className="value">{money(p.totals.fees, base)}</span>
              <span className="small muted">
                <Link to="/app/statements">{t('nav.statements')} →</Link>
              </span>
            </div>
          </div>
        </div>
      )}
      <div className="row wrap mt">
        <Chip selected={!family} onClick={() => setFamily('')}>
          {t('insights.all')}
        </Chip>
        {(Object.keys(CHART_FAMILIES) as (keyof typeof CHART_FAMILIES)[]).map((f) => (
          <Chip key={f} selected={family === f} onClick={() => setFamily(f)}>
            {FAMILY_LABELS[f]}
          </Chip>
        ))}
      </div>
      {!p && <div className="card mt">…</div>}
      {p && p.totals.count === 0 && <Empty icon="📊" text={t('insights.empty')} />}
      <div className="grid cols-2 mt">
        {visible.map((c) => (
          <div className="card" key={c.id}>
            <div className="card-title">
              <h3>{c.title}</h3>
              <span className="chip">{c.kind}</span>
            </div>
            <Chart scene={c.scene} />
            <div className="tiny muted mt-sm">{c.note}</div>
          </div>
        ))}
      </div>
      <p className="tiny muted mt">{t('insights.footnote', { role: user?.role ?? 'user', currency: base })}</p>
    </div>
  );
}
