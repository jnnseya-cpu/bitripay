/**
 * From the analytics payload the API serves (`/api/account/analytics`, `/api/admin/insights/analytics`) to the
 * catalogue of chart cards every surface shows: the web app, the console and the phone build the same cards from
 * this one mapping, each with its own renderer.
 */
import {
  areaChart,
  barChart,
  bubbleChart,
  columnChart,
  donutChart,
  ganttChart,
  heatmap,
  histogram,
  lineChart,
  pieChart,
  radarChart,
  scatterPlot,
  treemap,
  type Scene,
  type ChartKind,
} from './builders.ts';

export interface AnalyticsSeries {
  period: { from: string; to: string; days: number };
  currency: string;
  totals: { count: number; in: number; out: number; fees: number };
  trend: { labels: string[]; in: number[]; out: number[]; count: number[] };
  byType: { label: string; value: number }[];
  byChannel: { label: string; value: number }[];
  monthly: { categories: string[]; series: { name: string; values: number[] }[] };
  profile: { axes: string[]; values: number[] };
  timeline: { label: string; start: string; end: string; progress?: number; group?: string }[];
  counterparties: { label: string; value: number; count: number; average: number }[];
  byHour: { x: number; y: number; label: string; group: string }[];
  amounts: number[];
  heat: { rows: string[]; cols: string[]; values: number[][] };
  extras: Record<string, unknown>;
}

export interface ChartCard {
  id: string;
  kind: ChartKind;
  family: 'comparison' | 'trends' | 'composition' | 'distribution';
  title: string;
  note: string;
  scene: Scene;
}

export interface SceneOptions {
  /** Money formatter for base-currency minor units. */
  money: (minor: number) => string;
  /** Short money for axis ticks (defaults to `money`). */
  tick?: (minor: number) => string;
  /** Labels; defaults are English. */
  labels?: Partial<Record<'in' | 'out' | 'count' | 'volume' | 'you' | 'platform', string>>;
  /** Whose activity: 'account' (customer, merchant, agent) or 'platform' (console). */
  scope?: 'account' | 'platform';
  width?: number;
}

const short = (labels: string[]) => labels.map((l) => (l.length === 10 ? l.slice(5) : l));

/** Every chart family from one payload, in catalogue order. Empty series still return a card so the page has a stable layout. */
export function analyticsScenes(p: AnalyticsSeries, o: SceneOptions): ChartCard[] {
  const money = o.money;
  const tick = o.tick ?? o.money;
  const L = { in: 'In', out: 'Out', count: 'Operations', volume: 'Volume', you: 'Your activity', platform: 'Platform', ...(o.labels ?? {}) };
  const width = o.width;
  const platform = o.scope === 'platform';
  const dayLabels = short(p.trend.labels);
  const cards: ChartCard[] = [
    {
      id: 'bar',
      kind: 'bar',
      family: 'comparison',
      title: 'Volume by operation type',
      note: 'Horizontal bars compare the total moved through each kind of operation over the period.',
      scene: barChart(p.byType.slice(0, 10), { format: tick, sort: true, width }),
    },
    {
      id: 'column',
      kind: 'column',
      family: 'comparison',
      title: 'Six months, in and out',
      note: platform ? 'Monthly volume settled on the platform.' : 'Money received and money sent, month by month; the ranking shows your busiest months.',
      scene: columnChart(
        p.monthly.categories.map((m) => m.slice(2)),
        platform ? [{ name: L.volume, values: p.monthly.series[0].values }] : p.monthly.series.map((s) => ({ ...s, name: s.name === 'In' ? L.in : L.out })),
        { format: tick, width },
      ),
    },
    {
      id: 'radar',
      kind: 'radar',
      family: 'comparison',
      title: 'Activity profile',
      note: 'How many operations of each family: a rounded profile is a diversified account, a spike is a single-purpose one.',
      scene: radarChart(p.profile.axes, [{ name: platform ? L.platform : L.you, values: p.profile.values }], { format: (v) => String(Math.round(v)), width }),
    },
    {
      id: 'line',
      kind: 'line',
      family: 'trends',
      title: 'Daily operations',
      note: 'Number of completed operations per day.',
      scene: lineChart(dayLabels, [{ name: L.count, values: p.trend.count }], { format: (v) => String(Math.round(v)), width }),
    },
    {
      id: 'area',
      kind: 'area',
      family: 'trends',
      title: 'Daily volume',
      note: platform ? 'Volume settled per day in the base currency.' : 'Money in and money out per day, converted to the base currency.',
      scene: areaChart(
        dayLabels,
        platform
          ? [{ name: L.volume, values: p.trend.in }]
          : [
              { name: L.in, values: p.trend.in },
              { name: L.out, values: p.trend.out },
            ],
        { format: tick, width },
      ),
    },
    {
      id: 'gantt',
      kind: 'gantt',
      family: 'trends',
      title: platform ? 'Corridor licences and active holds' : 'Holds, savings goals and forwards',
      note: platform
        ? 'Each bar runs from creation to licence expiry or hold release; the dashed line is today.'
        : 'Each bar runs from creation to release, deadline or settlement; the filled part of a goal is what you have saved.',
      scene: p.timeline.length
        ? ganttChart(p.timeline, { width: width ?? 560 })
        : ganttChart([{ label: 'Nothing scheduled', start: p.period.from, end: p.period.to, color: '#9ca3af' }], { width: width ?? 560, from: p.period.from, to: p.period.to }),
    },
    {
      id: 'pie',
      kind: 'pie',
      family: 'composition',
      title: 'Share by channel',
      note: 'Which rail carried the money: wallet, QR, checkout, card, bank, mobile money, agents, payouts, services.',
      scene: pieChart(p.byChannel, { format: money, width }),
    },
    {
      id: 'donut',
      kind: 'donut',
      family: 'composition',
      title: platform ? 'Accounts by role' : 'In versus out',
      note: platform ? 'Customers, merchants and agents with an account.' : 'What came in against what went out over the period.',
      scene: donutChart(
        platform
          ? ((p.extras.accounts as { label: string; value: number }[] | undefined) ?? [])
          : [
              { label: L.in, value: p.totals.in },
              { label: L.out, value: p.totals.out },
            ],
        {
          format: platform ? (v) => String(Math.round(v)) : money,
          centre: platform ? String(((p.extras.accounts as { value: number }[] | undefined) ?? []).reduce((a, b) => a + b.value, 0)) : money(p.totals.in - p.totals.out),
          width,
        },
      ),
    },
    {
      id: 'treemap',
      kind: 'treemap',
      family: 'composition',
      title: platform ? 'Volume by country' : 'Counterparties by volume',
      note: platform ? 'Rectangles sized by the volume of the accounts in each country.' : 'Rectangles sized by how much moved with each counterparty.',
      scene: treemap(platform ? ((p.extras.byCountry as { label: string; value: number }[] | undefined) ?? []) : p.counterparties, { format: money, width }),
    },
    {
      id: 'scatter',
      kind: 'scatter',
      family: 'distribution',
      title: 'Amount by hour of day',
      note: 'Each dot is one operation placed at the hour it happened and its amount; colours are the operation family.',
      scene: scatterPlot(p.byHour, { format: (v) => (v <= 24 && Number.isInteger(v) ? `${v}h` : tick(v)), xLabel: 'hour (UTC)', yLabel: 'amount', width }),
    },
    {
      id: 'histogram',
      kind: 'histogram',
      family: 'distribution',
      title: 'Amount distribution',
      note: 'How many operations fall in each amount band.',
      scene: histogram(p.amounts, { format: tick, width }),
    },
    {
      id: 'bubble',
      kind: 'bubble',
      family: 'distribution',
      title: platform ? 'Countries: operations, volume, average' : 'Counterparties: operations, volume, average',
      note: 'Position is the number of operations and the total volume; the bubble area is the average amount.',
      scene: bubbleChart(
        platform
          ? ((p.extras.byCountry as { label: string; value: number }[] | undefined) ?? []).map((c) => ({ label: c.label, x: 1, y: c.value, size: c.value }))
          : p.counterparties.map((c) => ({ label: c.label, x: c.count, y: c.value, size: c.average })),
        { format: tick, xLabel: 'operations', yLabel: 'volume', sizeLabel: 'average', width },
      ),
    },
    {
      id: 'heatmap',
      kind: 'heatmap',
      family: 'distribution',
      title: 'When operations happen',
      note: 'Weekday against hour of the day (UTC); the darker the cell, the more operations.',
      scene: heatmap(p.heat.rows, p.heat.cols, p.heat.values, { format: (v) => String(Math.round(v)), width }),
    },
  ];
  // role-specific extras become extra cards without changing the catalogue order
  const methods = p.extras.methods as { label: string; value: number }[] | undefined;
  if (methods)
    cards.splice(7, 0, {
      id: 'methods',
      kind: 'donut',
      family: 'composition',
      title: 'Payments by method',
      note: 'How customers paid you: wallet, QR, card, mobile money, bank.',
      scene: donutChart(methods, { format: money, width }),
    });
  const cash = p.extras.cash as { labels: string[]; cashIn: number[]; cashOut: number[] } | undefined;
  if (cash)
    cards.splice(2, 0, {
      id: 'cash',
      kind: 'column',
      family: 'comparison',
      title: 'Cash-in and cash-out per day',
      note: 'Cash taken in and paid out at your counter each day.',
      scene: columnChart(
        short(cash.labels),
        [
          { name: 'Cash-in', values: cash.cashIn },
          { name: 'Cash-out', values: cash.cashOut },
        ],
        { format: tick, labels: false, width },
      ),
    });
  const kyc = p.extras.kyc as { categories: string[]; series: { name: string; values: number[] }[] } | undefined;
  if (kyc)
    cards.splice(2, 0, {
      id: 'kyc',
      kind: 'column',
      family: 'comparison',
      title: 'Accounts by KYC tier and role',
      note: 'Stacked columns: how many accounts of each role sit at each tier.',
      scene: columnChart(
        kyc.categories.map((c) => c.replace(/^Tier \d · /, '')),
        kyc.series,
        { stacked: true, format: (v) => String(Math.round(v)), width },
      ),
    });
  const growth = p.extras.newAccounts as { labels: string[]; values: number[] } | undefined;
  if (growth)
    cards.splice(5, 0, {
      id: 'growth',
      kind: 'line',
      family: 'trends',
      title: 'New accounts per day',
      note: 'Accounts opened each day of the period.',
      scene: lineChart(short(growth.labels), [{ name: 'Accounts', values: growth.values }], { format: (v) => String(Math.round(v)), width }),
    });
  return cards;
}
