import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  barChart,
  columnChart,
  radarChart,
  lineChart,
  areaChart,
  ganttChart,
  pieChart,
  donutChart,
  treemap,
  scatterPlot,
  histogram,
  bubbleChart,
  heatmap,
  niceTicks,
  sceneToSvg,
  CHART_FAMILIES,
} from './builders.ts';

const rects = (s: { items: any[] }) => s.items.filter((i) => i.kind === 'rect');

test('nice ticks cover the range with round steps', () => {
  assert.deepEqual(niceTicks(0, 100, 4), [0, 25, 50, 75, 100]);
  const t = niceTicks(0, 7, 4);
  assert.equal(t[0], 0);
  assert.ok(t[t.length - 1] >= 7);
  assert.ok(niceTicks(3, 3).length >= 2);
});

test('bar and column charts draw one mark per datum and label the axis', () => {
  const bar = barChart(
    [
      { label: 'Transfers', value: 40 },
      { label: 'Bills', value: 15 },
    ],
    { sort: true },
  );
  assert.equal(rects(bar).length, 2);
  assert.equal(rects(bar)[0].key, 'Transfers');
  assert.match(bar.summary, /Transfers/);
  const col = columnChart(
    ['Jan', 'Feb', 'Mar'],
    [
      { name: 'in', values: [1, 2, 3] },
      { name: 'out', values: [3, 2, 1] },
    ],
  );
  assert.equal(rects(col).length, 6);
  assert.equal(col.legend.length, 2);
  const stacked = columnChart(
    ['Jan'],
    [
      { name: 'a', values: [10] },
      { name: 'b', values: [10] },
    ],
    { stacked: true },
  );
  const [a, b] = rects(stacked);
  assert.ok(Math.abs(a.h - b.h) < 0.01, 'equal stacks share the height');
  assert.ok(b.y < a.y, 'second series stacks above the first');
});

test('radar closes a polygon per series with one vertex per axis', () => {
  const s = radarChart(['a', 'b', 'c', 'd'], [{ name: 'me', values: [1, 2, 3, 4] }]);
  const polys = s.items.filter((i) => i.kind === 'polygon' && i.fill && i.fill !== 'none');
  assert.equal(polys.length, 1);
  assert.equal((polys[0] as any).points.length, 4);
});

test('line, area and gantt lay out time', () => {
  const line = lineChart(['d1', 'd2', 'd3'], [{ name: 'volume', values: [10, 30, 20] }]);
  assert.equal(line.items.filter((i) => i.kind === 'path').length, 1);
  const area = areaChart(['d1', 'd2'], [{ name: 'v', values: [1, 2] }]);
  assert.equal(area.items.filter((i) => i.kind === 'path').length, 2, 'area adds a filled path');
  const g = ganttChart([{ label: 'Hold', start: '2026-09-01', end: '2026-09-10', progress: 0.5 }], { from: '2026-09-01', to: '2026-09-30', today: '2026-09-05' });
  const bars = rects(g);
  assert.equal(bars.length, 2, 'bar plus progress');
  assert.ok(Math.abs(bars[1].w - bars[0].w / 2) < 0.01);
  assert.ok(
    g.items.some((i) => i.kind === 'line' && i.dash),
    'today marker',
  );
});

test('pie, donut and treemap partition a whole', () => {
  const pie = pieChart([
    { label: 'A', value: 75 },
    { label: 'B', value: 25 },
  ]);
  assert.equal(pie.items.filter((i) => i.kind === 'path').length, 2);
  assert.equal(pie.legend[0].value, '75 · 75%');
  const donut = donutChart([{ label: 'A', value: 1 }], { centre: '100%' });
  assert.ok(donut.items.some((i) => i.kind === 'text' && i.text === '100%'));
  assert.equal(pieChart([]).summary, 'nothing to show yet');
  const tm = treemap(
    [
      { label: 'x', value: 50 },
      { label: 'y', value: 30 },
      { label: 'z', value: 20 },
    ],
    { width: 200, height: 100 },
  );
  const area = rects(tm).reduce((a, r) => a + r.w * r.h, 0);
  assert.ok(Math.abs(area - 200 * 100) < 1, `rectangles tile the canvas (${area})`);
  assert.equal(rects(tm).length, 3);
});

test('scatter, bubble, histogram and heatmap describe distributions', () => {
  const sc = scatterPlot([
    { x: 1, y: 2 },
    { x: 3, y: 4, group: 'card' },
  ]);
  assert.equal(sc.items.filter((i) => i.kind === 'circle').length, 2);
  assert.deepEqual(
    sc.legend.map((l) => l.label),
    ['card'],
  );
  const bb = bubbleChart([
    { x: 1, y: 1, size: 100, label: 'big' },
    { x: 2, y: 2, size: 1, label: 'small' },
  ]);
  const circles = bb.items.filter((i) => i.kind === 'circle') as any[];
  assert.ok(circles[0].r > circles[1].r);
  const h = histogram([1, 2, 2, 3, 3, 3, 10], { bins: 3 });
  const counts = rects(h).map((r) => r.tip);
  assert.ok(rects(h).length >= 2, 'nice edges give at least two bins');
  assert.match(h.summary, /7 values/);
  assert.ok(counts.length);
  const hm = heatmap(
    ['Mon', 'Tue'],
    ['00', '01', '02'],
    [
      [0, 5, 10],
      [1, 0, 0],
    ],
  );
  assert.equal(rects(hm).length, 6);
  const hottest = rects(hm).find((r) => r.tip === 'Mon · 02: 10');
  assert.equal(hottest.opacity, 1);
});

test('scenes serialise to accessible SVG and the catalogue lists the thirteen kinds', () => {
  const svg = sceneToSvg(barChart([{ label: 'a<b', value: 1 }]));
  assert.match(svg, /^<svg xmlns=/);
  assert.match(svg, /aria-label=/);
  assert.match(svg, /a&lt;b/);
  assert.equal(Object.values(CHART_FAMILIES).flat().length, 13);
});

test('the analytics mapping yields every chart family from one payload', async () => {
  const { analyticsScenes } = await import('./analytics.ts');
  const labels = ['2026-09-01', '2026-09-02'];
  const cards = analyticsScenes(
    {
      period: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z', days: 1 },
      currency: 'USD',
      totals: { count: 2, in: 1000, out: 500, fees: 5 },
      trend: { labels, in: [1000, 0], out: [0, 500], count: [1, 1] },
      byType: [{ label: 'Transfer', value: 500 }],
      byChannel: [{ label: 'Wallet', value: 1500 }],
      monthly: {
        categories: ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'],
        series: [
          { name: 'In', values: [0, 0, 0, 0, 0, 1000] },
          { name: 'Out', values: [0, 0, 0, 0, 0, 500] },
        ],
      },
      profile: { axes: ['Transfers', 'Payments', 'Money in'], values: [1, 0, 1] },
      timeline: [],
      counterparties: [{ label: 'Ana', value: 500, count: 1, average: 500 }],
      byHour: [{ x: 9.5, y: 500, label: 'Transfer', group: 'Transfers' }],
      amounts: [1000, 500],
      heat: { rows: ['Mon'], cols: ['09'], values: [[2]] },
      extras: { methods: [{ label: 'qr', value: 300 }] },
    },
    { money: (m) => `$${(m / 100).toFixed(2)}` },
  );
  const kinds = cards.map((c) => c.kind);
  for (const k of ['bar', 'column', 'radar', 'line', 'area', 'gantt', 'pie', 'donut', 'treemap', 'scatter', 'histogram', 'bubble', 'heatmap']) assert.ok(kinds.includes(k as any), k);
  assert.ok(
    cards.some((c) => c.id === 'methods'),
    'merchant extra card',
  );
  assert.equal(cards.find((c) => c.id === 'donut')!.scene.legend[0].value, '$10.00 · 66.7%');
});
