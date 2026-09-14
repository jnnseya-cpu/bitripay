import React, { useMemo, useState } from 'react';
import { useWindowDimensions, View } from 'react-native';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Screen, Card, T, Row, Tabs, Empty, Loading, useAsync, KV } from '../components/ui';
import { Header } from '../components/Header';
import { Chart } from '../components/Chart';
import { analyticsScenes, CHART_FAMILIES, type AnalyticsSeries } from '@bitripay/charts';

const FAMILY_LABELS: Record<string, string> = { '': 'All', comparison: 'Compare', trends: 'Trends', composition: 'Composition', distribution: 'Distribution' };
const PERIODS = [7, 30, 90, 365];

/** Every chart family over the account's own activity, on the phone. */
export function Insights() {
  const { money, config, t } = useStore();
  const { width } = useWindowDimensions();
  const [days, setDays] = useState(30);
  const [family, setFamily] = useState('');
  const data = useAsync(() => api.get<AnalyticsSeries>(`/api/account/analytics?days=${days}`), [days]);
  const base = config?.baseCurrency ?? 'USD';
  const chartWidth = Math.max(280, width - 32 - 28);
  const cards = useMemo(
    () =>
      data.data
        ? analyticsScenes(data.data, {
            money: (m) => money(m, base),
            tick: (m) => (Math.abs(m) >= 100_000 ? `${(m / 100_000).toFixed(1)}k` : money(Math.round(m), base).replace(/[.,]00$/, '')),
            labels: { in: t('insights.in'), out: t('insights.out') },
            scope: 'account',
            width: 360,
          })
        : [],
    [data.data, base, money, t],
  );
  const visible = family ? cards.filter((c) => c.family === family) : cards;
  const p = data.data;
  return (
    <Screen>
      <Header title={t('nav.insights')} />
      <T muted>{t('insights.subtitle')}</T>
      <Tabs tabs={PERIODS.map((d) => ({ id: String(d), label: t('insights.days', { n: d }) }))} value={String(days)} onChange={(v) => setDays(Number(v))} />
      {!p && <Loading />}
      {p && (
        <Card>
          <KV k={t('insights.operations')} v={String(p.totals.count)} />
          <KV k={t('insights.in')} v={money(p.totals.in, base)} />
          <KV k={t('insights.out')} v={money(p.totals.out, base)} />
          <KV k={t('insights.fees')} v={money(p.totals.fees, base)} />
        </Card>
      )}
      <Tabs tabs={['', ...Object.keys(CHART_FAMILIES)].map((f) => ({ id: f, label: FAMILY_LABELS[f] }))} value={family} onChange={setFamily} />
      {p && p.totals.count === 0 && <Empty icon="📊" text={t('insights.empty')} />}
      {visible.map((c) => (
        <Card key={c.id}>
          <Row between>
            <T bold>{c.title}</T>
            <T muted size={12}>
              {c.kind}
            </T>
          </Row>
          <View style={{ marginTop: 6 }}>
            <Chart scene={c.scene} width={chartWidth} />
          </View>
          <T muted size={12}>
            {c.note}
          </T>
        </Card>
      ))}
    </Screen>
  );
}
