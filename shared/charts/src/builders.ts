/**
 * BitriPay charts: one geometry engine, every chart family, any renderer.
 *
 * Each builder turns plain data into a `Scene` — a list of drawing primitives in a fixed coordinate space — so the
 * same chart renders as SVG on the web and the console, as react-native-svg on the phone, and can be tested without a
 * DOM. Colours come from the palette (brand first) and text uses `currentColor`, so charts follow the theme.
 *
 * Families: comparison (bar, column, radar), trends (line, area, gantt), composition (pie, donut, treemap),
 * distribution and relationships (scatter, histogram, bubble, heatmap).
 */

export type Primitive =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; fill: string; rx?: number; opacity?: number; tip?: string; key?: string }
  | { kind: 'circle'; cx: number; cy: number; r: number; fill: string; opacity?: number; stroke?: string; tip?: string; key?: string }
  | { kind: 'path'; d: string; stroke?: string; fill?: string; width?: number; opacity?: number; dash?: string; tip?: string; key?: string }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; stroke: string; width?: number; opacity?: number; dash?: string }
  | { kind: 'polygon'; points: [number, number][]; fill?: string; stroke?: string; width?: number; opacity?: number; tip?: string; key?: string }
  | {
      kind: 'text';
      x: number;
      y: number;
      text: string;
      size?: number;
      fill?: string;
      anchor?: 'start' | 'middle' | 'end';
      weight?: number;
      opacity?: number;
      baseline?: 'auto' | 'middle' | 'hanging';
    };

export interface LegendItem {
  label: string;
  color: string;
  value?: string;
}
export interface Scene {
  width: number;
  height: number;
  items: Primitive[];
  legend: LegendItem[];
  /** Human summary for screen readers and captions. */
  summary: string;
}

/** Brand palette: BitriPay blue, gold, green, then distinguishable companions. */
export const PALETTE = ['#1f4fd8', '#f5b31c', '#0b6e4f', '#b42318', '#7c3aed', '#0e7490', '#b7791f', '#db2777', '#4b5563', '#65a30d'];
export const TEXT = 'currentColor';
const GRID = 'currentColor';

export interface Options {
  width?: number;
  height?: number;
  colors?: string[];
  /** Format a numeric value for axis ticks and labels (e.g. money). */
  format?: (v: number) => string;
  /** Show value labels on marks. */
  labels?: boolean;
  title?: string;
}
const defaults = (o: Options, w = 480, h = 260) => ({
  width: o.width ?? w,
  height: o.height ?? h,
  colors: o.colors?.length ? o.colors : PALETTE,
  format: o.format ?? ((v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1))),
  labels: o.labels ?? true,
});
const color = (colors: string[], i: number) => colors[i % colors.length];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const fmtPct = (v: number) => `${Math.round(v * 1000) / 10}%`;

/** Nice axis ticks: 4–6 round steps covering [0, max] (or [min, max] when negatives exist). */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (max === min) max = min + 1;
  const span = max - min;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.5; v += step) ticks.push(Math.round(v * 1e9) / 1e9);
  return ticks;
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ------------------------------------------------------------------------------------------------ comparison

export interface Datum {
  label: string;
  value: number;
  color?: string;
}
export interface Series {
  name: string;
  values: number[];
  color?: string;
}

/** Horizontal bars: one bar per category, longest first when `sort`. */
export function barChart(data: Datum[], o: Options & { sort?: boolean } = {}): Scene {
  const { width, height, colors, format, labels } = defaults(o, 480, Math.max(120, 28 * data.length + 30));
  const rows = o.sort ? [...data].sort((a, b) => b.value - a.value) : data;
  const max = Math.max(1, ...rows.map((d) => d.value));
  const labelW = Math.min(150, Math.max(...rows.map((d) => d.label.length), 4) * 7 + 8);
  const x0 = labelW + 8;
  const plotW = width - x0 - 60;
  const rowH = (height - 24) / Math.max(1, rows.length);
  const items: Primitive[] = [];
  for (const t of niceTicks(0, max, 4)) {
    const x = x0 + (t / max) * plotW;
    items.push({ kind: 'line', x1: x, y1: 8, x2: x, y2: height - 16, stroke: GRID, opacity: 0.12 });
    items.push({ kind: 'text', x, y: height - 4, text: format(t), size: 10, fill: TEXT, anchor: 'middle', opacity: 0.7 });
  }
  rows.forEach((d, i) => {
    const y = 8 + i * rowH;
    const w = (d.value / max) * plotW;
    items.push({ kind: 'text', x: x0 - 6, y: y + rowH / 2, text: truncate(d.label, 22), size: 11, fill: TEXT, anchor: 'end', baseline: 'middle' });
    items.push({ kind: 'rect', x: x0, y: y + rowH * 0.18, w: Math.max(1, w), h: rowH * 0.64, fill: d.color ?? color(colors, i), rx: 3, tip: `${d.label}: ${format(d.value)}`, key: d.label });
    if (labels) items.push({ kind: 'text', x: x0 + w + 5, y: y + rowH / 2, text: format(d.value), size: 10.5, fill: TEXT, baseline: 'middle', opacity: 0.85 });
  });
  return { width, height, items, legend: [], summary: `${rows.length} categories, largest ${rows[0]?.label ?? '—'} at ${format(max)}` };
}

/** Vertical columns, optionally grouped by series (ranking, month-over-month comparison). */
export function columnChart(categories: string[], series: Series[], o: Options & { stacked?: boolean } = {}): Scene {
  const { width, height, colors, format, labels } = defaults(o);
  const left = 44;
  const bottom = 30;
  const plotW = width - left - 12;
  const plotH = height - bottom - 12;
  const totals = categories.map((_, c) => (o.stacked ? series.reduce((a, s) => a + (s.values[c] ?? 0), 0) : Math.max(...series.map((s) => s.values[c] ?? 0))));
  const max = Math.max(1, ...totals);
  const items: Primitive[] = [];
  for (const t of niceTicks(0, max, 4)) {
    const y = 12 + plotH - (t / max) * plotH;
    items.push({ kind: 'line', x1: left, y1: y, x2: left + plotW, y2: y, stroke: GRID, opacity: 0.12 });
    items.push({ kind: 'text', x: left - 6, y, text: format(t), size: 10, fill: TEXT, anchor: 'end', baseline: 'middle', opacity: 0.7 });
  }
  const groupW = plotW / Math.max(1, categories.length);
  const inner = groupW * 0.7;
  const barW = o.stacked ? inner : inner / Math.max(1, series.length);
  categories.forEach((cat, c) => {
    const gx = left + c * groupW + (groupW - inner) / 2;
    let stackY = 12 + plotH;
    series.forEach((s, si) => {
      const v = s.values[c] ?? 0;
      const h = (v / max) * plotH;
      const x = o.stacked ? gx : gx + si * barW;
      const y = o.stacked ? stackY - h : 12 + plotH - h;
      if (o.stacked) stackY -= h;
      items.push({ kind: 'rect', x, y, w: Math.max(1, barW - 2), h: Math.max(0, h), fill: s.color ?? color(colors, si), rx: 2, tip: `${cat} · ${s.name}: ${format(v)}`, key: `${cat}:${s.name}` });
      if (labels && !o.stacked && v > 0 && categories.length <= 12)
        items.push({ kind: 'text', x: x + (barW - 2) / 2, y: y - 3, text: format(v), size: 9.5, fill: TEXT, anchor: 'middle', opacity: 0.8 });
    });
    if (categories.length <= 16 || c % Math.ceil(categories.length / 16) === 0)
      items.push({ kind: 'text', x: gx + inner / 2, y: height - 8, text: truncate(cat, 10), size: 10, fill: TEXT, anchor: 'middle', opacity: 0.8 });
  });
  const legend = series.map((s, i) => ({ label: s.name, color: s.color ?? color(colors, i) }));
  return { width, height, items, legend, summary: `${categories.length} categories × ${series.length} series, peak ${format(max)}` };
}

/** Radar: several variables per series on a circular grid (activity profile, risk profile). */
export function radarChart(axes: string[], series: Series[], o: Options & { max?: number } = {}): Scene {
  const { width, height, colors, format } = defaults(o, 360, 300);
  const cx = width / 2;
  const cy = height / 2 + 6;
  const R = Math.min(width, height) / 2 - 40;
  const max = o.max ?? Math.max(1, ...series.flatMap((s) => s.values));
  const n = Math.max(3, axes.length);
  const angle = (i: number) => -Math.PI / 2 + (i / n) * Math.PI * 2;
  const pt = (i: number, v: number): [number, number] => [cx + Math.cos(angle(i)) * R * (v / max), cy + Math.sin(angle(i)) * R * (v / max)];
  const items: Primitive[] = [];
  for (const f of [0.25, 0.5, 0.75, 1]) {
    items.push({ kind: 'polygon', points: axes.map((_, i) => pt(i, max * f)), stroke: GRID, opacity: 0.18, fill: 'none' });
    items.push({ kind: 'text', x: cx + 4, y: cy - R * f, text: format(max * f), size: 9, fill: TEXT, opacity: 0.55 });
  }
  axes.forEach((a, i) => {
    const [x, y] = pt(i, max);
    items.push({ kind: 'line', x1: cx, y1: cy, x2: x, y2: y, stroke: GRID, opacity: 0.18 });
    const [lx, ly] = [cx + Math.cos(angle(i)) * (R + 16), cy + Math.sin(angle(i)) * (R + 16)];
    items.push({
      kind: 'text',
      x: lx,
      y: ly,
      text: truncate(a, 14),
      size: 10.5,
      fill: TEXT,
      anchor: Math.abs(Math.cos(angle(i))) < 0.2 ? 'middle' : Math.cos(angle(i)) > 0 ? 'start' : 'end',
      baseline: 'middle',
    });
  });
  series.forEach((s, si) => {
    const c = s.color ?? color(colors, si);
    const points = axes.map((_, i) => pt(i, clamp(s.values[i] ?? 0, 0, max)));
    items.push({ kind: 'polygon', points, fill: c, stroke: c, opacity: 0.25, width: 2, tip: s.name, key: s.name });
    points.forEach((p, i) => items.push({ kind: 'circle', cx: p[0], cy: p[1], r: 3, fill: c, tip: `${s.name} · ${axes[i]}: ${format(s.values[i] ?? 0)}` }));
  });
  return { width, height, items, legend: series.map((s, i) => ({ label: s.name, color: s.color ?? color(colors, i) })), summary: `${axes.length} axes, ${series.length} profile(s)` };
}

// ------------------------------------------------------------------------------------------------ trends and time

export interface Point {
  x: string;
  y: number;
}

function xyFrame(width: number, height: number) {
  const left = 46;
  const bottom = 28;
  return { left, bottom, plotW: width - left - 12, plotH: height - bottom - 12, top: 12 };
}

/** Line chart: one line per series over shared x labels; `area` fills below each line. */
export function lineChart(labels: string[], series: Series[], o: Options & { area?: boolean; smooth?: boolean } = {}): Scene {
  const { width, height, colors, format } = defaults(o);
  const { left, plotW, plotH, top } = xyFrame(width, height);
  const all = series.flatMap((s) => s.values);
  const min = Math.min(0, ...all);
  const max = Math.max(1, ...all);
  const items: Primitive[] = [];
  const ticks = niceTicks(min, max, 4);
  const yOf = (v: number) => top + plotH - ((v - ticks[0]) / (ticks[ticks.length - 1] - ticks[0] || 1)) * plotH;
  const xOf = (i: number) => left + (labels.length > 1 ? (i / (labels.length - 1)) * plotW : plotW / 2);
  for (const t of ticks) {
    items.push({ kind: 'line', x1: left, y1: yOf(t), x2: left + plotW, y2: yOf(t), stroke: GRID, opacity: 0.12 });
    items.push({ kind: 'text', x: left - 6, y: yOf(t), text: format(t), size: 10, fill: TEXT, anchor: 'end', baseline: 'middle', opacity: 0.7 });
  }
  const every = Math.max(1, Math.ceil(labels.length / 8));
  labels.forEach((l, i) => {
    if (i % every === 0 || i === labels.length - 1) items.push({ kind: 'text', x: xOf(i), y: height - 8, text: truncate(l, 8), size: 10, fill: TEXT, anchor: 'middle', opacity: 0.8 });
  });
  series.forEach((s, si) => {
    const c = s.color ?? color(colors, si);
    const pts = s.values.map((v, i) => [xOf(i), yOf(v)] as [number, number]);
    if (!pts.length) return;
    const d = pts
      .map(([x, y], i) => (i === 0 ? `M${x.toFixed(1)},${y.toFixed(1)}` : o.smooth ? `S${x.toFixed(1)},${y.toFixed(1)} ${x.toFixed(1)},${y.toFixed(1)}` : `L${x.toFixed(1)},${y.toFixed(1)}`))
      .join(' ');
    if (o.area)
      items.push({ kind: 'path', d: `${d} L${pts[pts.length - 1][0].toFixed(1)},${yOf(ticks[0]).toFixed(1)} L${pts[0][0].toFixed(1)},${yOf(ticks[0]).toFixed(1)} Z`, fill: c, opacity: 0.18 });
    items.push({ kind: 'path', d, stroke: c, width: 2, fill: 'none', key: s.name });
    const last = pts[pts.length - 1];
    items.push({ kind: 'circle', cx: last[0], cy: last[1], r: 3.5, fill: c, tip: `${s.name} · ${labels[labels.length - 1]}: ${format(s.values[s.values.length - 1])}` });
    if (pts.length <= 40)
      pts.forEach((p, i) => i < pts.length - 1 && items.push({ kind: 'circle', cx: p[0], cy: p[1], r: 2, fill: c, opacity: 0.9, tip: `${s.name} · ${labels[i]}: ${format(s.values[i])}` }));
  });
  return {
    width,
    height,
    items,
    legend: series.map((s, i) => ({ label: s.name, color: s.color ?? color(colors, i) })),
    summary: `${labels.length} points, ${series.length} series, peak ${format(max)}`,
  };
}

/** Area chart: line chart with the area below filled (volume, cumulative trends). */
export const areaChart = (labels: string[], series: Series[], o: Options = {}) => lineChart(labels, series, { ...o, area: true });

export interface Task {
  label: string;
  /** ISO dates or timestamps. */
  start: string | number;
  end: string | number;
  progress?: number;
  color?: string;
  group?: string;
}
/** Gantt: tasks on a timeline (holds, scheduled payments, savings goals, licence expiries). */
export function ganttChart(tasks: Task[], o: Options & { from?: string | number; to?: string | number; today?: string | number } = {}): Scene {
  const { width, height, colors } = defaults(o, 560, Math.max(120, 26 * tasks.length + 40));
  const ms = (v: string | number) => (typeof v === 'number' ? v : Date.parse(v));
  const starts = tasks.map((t) => ms(t.start));
  const ends = tasks.map((t) => ms(t.end));
  const from = o.from !== undefined ? ms(o.from) : Math.min(...starts, Date.now());
  const to = o.to !== undefined ? ms(o.to) : Math.max(...ends, Date.now());
  const span = Math.max(1, to - from);
  const labelW = Math.min(170, Math.max(...tasks.map((t) => t.label.length), 6) * 7 + 8);
  const x0 = labelW + 8;
  const plotW = width - x0 - 12;
  const rowH = (height - 36) / Math.max(1, tasks.length);
  const xOf = (t: number) => x0 + clamp((t - from) / span, 0, 1) * plotW;
  const items: Primitive[] = [];
  const days = span / 86_400_000;
  const stepDays = days > 180 ? 30 : days > 60 ? 14 : days > 14 ? 7 : 1;
  for (let t = from; t <= to; t += stepDays * 86_400_000) {
    const x = xOf(t);
    items.push({ kind: 'line', x1: x, y1: 8, x2: x, y2: height - 28, stroke: GRID, opacity: 0.12 });
    items.push({ kind: 'text', x, y: height - 14, text: new Date(t).toISOString().slice(5, 10), size: 9.5, fill: TEXT, anchor: 'middle', opacity: 0.7 });
  }
  const today = o.today !== undefined ? ms(o.today) : Date.now();
  if (today >= from && today <= to) items.push({ kind: 'line', x1: xOf(today), y1: 8, x2: xOf(today), y2: height - 28, stroke: '#b42318', width: 1.5, dash: '4 3' });
  tasks.forEach((t, i) => {
    const y = 8 + i * rowH;
    const x1 = xOf(ms(t.start));
    const x2 = Math.max(x1 + 2, xOf(ms(t.end)));
    const c = t.color ?? color(colors, i);
    items.push({ kind: 'text', x: x0 - 6, y: y + rowH / 2, text: truncate(t.label, 24), size: 11, fill: TEXT, anchor: 'end', baseline: 'middle' });
    items.push({
      kind: 'rect',
      x: x1,
      y: y + rowH * 0.2,
      w: x2 - x1,
      h: rowH * 0.6,
      fill: c,
      rx: 3,
      opacity: 0.35,
      tip: `${t.label}: ${new Date(ms(t.start)).toISOString().slice(0, 10)} → ${new Date(ms(t.end)).toISOString().slice(0, 10)}`,
      key: t.label,
    });
    if (t.progress !== undefined)
      items.push({ kind: 'rect', x: x1, y: y + rowH * 0.2, w: (x2 - x1) * clamp(t.progress, 0, 1), h: rowH * 0.6, fill: c, rx: 3, tip: `${t.label}: ${fmtPct(clamp(t.progress, 0, 1))}` });
  });
  return { width, height, items, legend: [], summary: `${tasks.length} items between ${new Date(from).toISOString().slice(0, 10)} and ${new Date(to).toISOString().slice(0, 10)}` };
}

// ------------------------------------------------------------------------------------------------ composition

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number, inner = 0): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (r: number, a: number) => `${(cx + Math.cos(a) * r).toFixed(2)},${(cy + Math.sin(a) * r).toFixed(2)}`;
  if (inner <= 0) return `M${cx},${cy} L${p(r, a0)} A${r},${r} 0 ${large} 1 ${p(r, a1)} Z`;
  return `M${p(r, a0)} A${r},${r} 0 ${large} 1 ${p(r, a1)} L${p(inner, a1)} A${inner},${inner} 0 ${large} 0 ${p(inner, a0)} Z`;
}

/** Pie (inner = 0) or donut (inner > 0): share of a whole. */
export function pieChart(data: Datum[], o: Options & { inner?: number; centre?: string } = {}): Scene {
  const { width, height, colors, format } = defaults(o, 420, 240);
  const total = data.reduce((a, d) => a + Math.max(0, d.value), 0);
  const cx = 110;
  const cy = height / 2;
  const r = Math.min(cy - 10, 100);
  const inner = o.inner ?? 0;
  const items: Primitive[] = [];
  let a = -Math.PI / 2;
  const legend: LegendItem[] = [];
  data.forEach((d, i) => {
    const share = total ? Math.max(0, d.value) / total : 0;
    const a1 = a + share * Math.PI * 2;
    const c = d.color ?? color(colors, i);
    if (share > 0) items.push({ kind: 'path', d: arcPath(cx, cy, r, a, Math.min(a1, a + Math.PI * 2 - 1e-6), inner), fill: c, tip: `${d.label}: ${format(d.value)} (${fmtPct(share)})`, key: d.label });
    if (share >= 0.06) {
      const mid = (a + a1) / 2;
      const lr = inner ? (r + inner) / 2 : r * 0.62;
      items.push({ kind: 'text', x: cx + Math.cos(mid) * lr, y: cy + Math.sin(mid) * lr, text: fmtPct(share), size: 10, fill: '#ffffff', anchor: 'middle', baseline: 'middle', weight: 600 });
    }
    legend.push({ label: d.label, color: c, value: `${format(d.value)} · ${fmtPct(share)}` });
    a = a1;
  });
  if (!total) items.push({ kind: 'circle', cx, cy, r, fill: GRID, opacity: 0.1 });
  if (inner && o.centre) items.push({ kind: 'text', x: cx, y: cy, text: o.centre, size: 13, fill: TEXT, anchor: 'middle', baseline: 'middle', weight: 600 });
  legend.slice(0, 9).forEach((l, i) => {
    const y = 20 + i * 22;
    items.push({ kind: 'rect', x: 236, y: y - 6, w: 10, h: 10, fill: l.color, rx: 2 });
    items.push({ kind: 'text', x: 252, y, text: `${truncate(l.label, 18)} — ${l.value ?? ''}`, size: 10.5, fill: TEXT, baseline: 'middle' });
  });
  return { width, height, items, legend, summary: total ? `${data.length} parts of ${format(total)}` : 'nothing to show yet' };
}
export const donutChart = (data: Datum[], o: Options & { centre?: string } = {}) => pieChart(data, { ...o, inner: 58 });

export interface TreeNode {
  label: string;
  value: number;
  color?: string;
  group?: string;
}
/** Treemap (squarified): nested rectangles sized by value (spend by counterparty, volume by country). */
export function treemap(nodes: TreeNode[], o: Options = {}): Scene {
  const { width, height, colors, format } = defaults(o, 480, 280);
  const data = nodes.filter((n) => n.value > 0).sort((a, b) => b.value - a.value);
  const total = data.reduce((a, n) => a + n.value, 0);
  const items: Primitive[] = [];
  if (!total) return { width, height, items: [{ kind: 'rect', x: 0, y: 0, w: width, h: height, fill: GRID, opacity: 0.06 }], legend: [], summary: 'nothing to show yet' };
  // squarified layout
  let x = 0;
  let y = 0;
  let w = width;
  let h = height;
  const scale = (width * height) / total;
  let row: TreeNode[] = [];
  const worst = (row: TreeNode[], side: number) => {
    const s = row.reduce((a, n) => a + n.value * scale, 0);
    const mx = Math.max(...row.map((n) => n.value * scale));
    const mn = Math.min(...row.map((n) => n.value * scale));
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  const place = (row: TreeNode[]) => {
    const s = row.reduce((a, n) => a + n.value * scale, 0);
    const horizontal = w >= h;
    const side = horizontal ? h : w;
    const thickness = s / side;
    let off = 0;
    for (const n of row) {
      const len = (n.value * scale) / thickness;
      const rect = horizontal ? { x, y: y + off, w: thickness, h: len } : { x: x + off, y, w: len, h: thickness };
      const i = data.indexOf(n);
      items.push({ kind: 'rect', ...rect, fill: n.color ?? color(colors, i), rx: 2, opacity: 0.9, tip: `${n.label}: ${format(n.value)} (${fmtPct(n.value / total)})`, key: n.label });
      if (rect.w > 46 && rect.h > 26) {
        items.push({ kind: 'text', x: rect.x + 6, y: rect.y + 14, text: truncate(n.label, Math.floor(rect.w / 6.5)), size: 10.5, fill: '#ffffff', weight: 600 });
        if (rect.h > 40) items.push({ kind: 'text', x: rect.x + 6, y: rect.y + 28, text: format(n.value), size: 10, fill: '#ffffff', opacity: 0.9 });
      }
      off += len;
    }
    if (horizontal) {
      x += thickness;
      w -= thickness;
    } else {
      y += thickness;
      h -= thickness;
    }
  };
  for (const n of data) {
    const side = Math.min(w, h);
    if (!row.length || worst([...row, n], side) <= worst(row, side)) row.push(n);
    else {
      place(row);
      row = [n];
    }
  }
  if (row.length) place(row);
  return {
    width,
    height,
    items,
    legend: data.slice(0, 8).map((n, i) => ({ label: n.label, color: n.color ?? color(colors, i), value: format(n.value) })),
    summary: `${data.length} rectangles summing to ${format(total)}`,
  };
}

// ------------------------------------------------------------------------------------------------ distribution and relationships

export interface XY {
  x: number;
  y: number;
  label?: string;
  size?: number;
  color?: string;
  group?: string;
}

function scatterFrame(points: XY[], o: Options, w = 480, h = 280) {
  const { width, height, colors, format } = defaults(o, w, h);
  const { left, plotW, plotH, top } = xyFrame(width, height);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xt = niceTicks(Math.min(0, ...xs), Math.max(1, ...xs), 5);
  const yt = niceTicks(Math.min(0, ...ys), Math.max(1, ...ys), 4);
  const xOf = (v: number) => left + ((v - xt[0]) / (xt[xt.length - 1] - xt[0] || 1)) * plotW;
  const yOf = (v: number) => top + plotH - ((v - yt[0]) / (yt[yt.length - 1] - yt[0] || 1)) * plotH;
  const items: Primitive[] = [];
  for (const t of yt) {
    items.push({ kind: 'line', x1: left, y1: yOf(t), x2: left + plotW, y2: yOf(t), stroke: GRID, opacity: 0.12 });
    items.push({ kind: 'text', x: left - 6, y: yOf(t), text: format(t), size: 10, fill: TEXT, anchor: 'end', baseline: 'middle', opacity: 0.7 });
  }
  for (const t of xt) {
    items.push({ kind: 'line', x1: xOf(t), y1: top, x2: xOf(t), y2: top + plotH, stroke: GRID, opacity: 0.08 });
    items.push({ kind: 'text', x: xOf(t), y: height - 8, text: format(t), size: 10, fill: TEXT, anchor: 'middle', opacity: 0.7 });
  }
  return { width, height, colors, format, items, xOf, yOf };
}

/** Scatter plot: relationship between two variables (amount vs hour, count vs value). */
export function scatterPlot(points: XY[], o: Options & { xLabel?: string; yLabel?: string } = {}): Scene {
  const f = scatterFrame(points, o);
  const groups = Array.from(new Set(points.map((p) => p.group ?? '')));
  points.forEach((p) => {
    const gi = groups.indexOf(p.group ?? '');
    f.items.push({
      kind: 'circle',
      cx: f.xOf(p.x),
      cy: f.yOf(p.y),
      r: 4,
      fill: p.color ?? color(f.colors, gi),
      opacity: 0.75,
      tip: `${p.label ?? ''} ${f.format(p.x)} · ${f.format(p.y)}`.trim(),
      key: p.label,
    });
  });
  if (o.xLabel) f.items.push({ kind: 'text', x: f.width - 12, y: f.height - 20, text: o.xLabel, size: 10, fill: TEXT, anchor: 'end', opacity: 0.7 });
  if (o.yLabel) f.items.push({ kind: 'text', x: 8, y: 10, text: o.yLabel, size: 10, fill: TEXT, opacity: 0.7, baseline: 'hanging' });
  const legend = groups.filter(Boolean).map((g, i) => ({ label: g, color: color(f.colors, i) }));
  return { width: f.width, height: f.height, items: f.items, legend, summary: `${points.length} points` };
}

/** Bubble chart: scatter with a third variable as the bubble area. */
export function bubbleChart(points: XY[], o: Options & { xLabel?: string; yLabel?: string; sizeLabel?: string } = {}): Scene {
  const f = scatterFrame(points, o);
  const maxSize = Math.max(1, ...points.map((p) => p.size ?? 1));
  const groups = Array.from(new Set(points.map((p) => p.group ?? '')));
  [...points]
    .sort((a, b) => (b.size ?? 1) - (a.size ?? 1))
    .forEach((p) => {
      const gi = groups.indexOf(p.group ?? '');
      const r = 4 + Math.sqrt((p.size ?? 1) / maxSize) * 22;
      f.items.push({
        kind: 'circle',
        cx: f.xOf(p.x),
        cy: f.yOf(p.y),
        r,
        fill: p.color ?? color(f.colors, gi),
        opacity: 0.55,
        stroke: p.color ?? color(f.colors, gi),
        tip: `${p.label ?? ''} ${f.format(p.x)} · ${f.format(p.y)} · ${o.sizeLabel ?? 'size'} ${f.format(p.size ?? 1)}`.trim(),
        key: p.label,
      });
      if (p.label && r > 12)
        f.items.push({ kind: 'text', x: f.xOf(p.x), y: f.yOf(p.y), text: truncate(p.label, Math.floor(r / 3)), size: 9.5, fill: TEXT, anchor: 'middle', baseline: 'middle', weight: 600 });
    });
  if (o.xLabel) f.items.push({ kind: 'text', x: f.width - 12, y: f.height - 20, text: o.xLabel, size: 10, fill: TEXT, anchor: 'end', opacity: 0.7 });
  if (o.yLabel) f.items.push({ kind: 'text', x: 8, y: 10, text: o.yLabel, size: 10, fill: TEXT, opacity: 0.7, baseline: 'hanging' });
  const legend = groups.filter(Boolean).map((g, i) => ({ label: g, color: color(f.colors, i) }));
  return { width: f.width, height: f.height, items: f.items, legend, summary: `${points.length} bubbles, largest ${f.format(maxSize)}` };
}

/** Histogram: continuous values grouped into `bins` equal-width bins (amount distribution). */
export function histogram(values: number[], o: Options & { bins?: number } = {}): Scene {
  const { width, height, colors, format, labels } = defaults(o);
  const clean = values.filter((v) => Number.isFinite(v));
  const bins = Math.max(1, o.bins ?? Math.min(12, Math.max(4, Math.round(Math.sqrt(clean.length)))));
  const min = clean.length ? Math.min(...clean) : 0;
  const max = clean.length ? Math.max(...clean) : 1;
  const edges = niceTicks(min, max, bins);
  const stepW = edges[1] - edges[0];
  const counts = new Array(Math.max(1, edges.length - 1)).fill(0) as number[];
  for (const v of clean) counts[clamp(Math.floor((v - edges[0]) / stepW), 0, counts.length - 1)] += 1;
  const scene = columnChart(
    counts.map((_, i) => `${format(edges[i])}`),
    [{ name: 'count', values: counts, color: color(colors, 0) }],
    { width, height, colors, labels, format: (v) => String(Math.round(v)) },
  );
  return { ...scene, legend: [], summary: `${clean.length} values in ${counts.length} bins of ${format(stepW)}` };
}

/** Heatmap: rows × columns grid coloured by value (weekday × hour activity, country × channel). */
export function heatmap(rows: string[], cols: string[], values: number[][], o: Options & { color?: string } = {}): Scene {
  const { width, height, format } = defaults(o, 520, Math.max(140, 22 * rows.length + 40));
  const labelW = Math.min(110, Math.max(...rows.map((r) => r.length), 3) * 7 + 8);
  const x0 = labelW + 6;
  const cellW = (width - x0 - 8) / Math.max(1, cols.length);
  const cellH = (height - 30) / Math.max(1, rows.length);
  const max = Math.max(1, ...values.flat());
  const base = o.color ?? PALETTE[0];
  const items: Primitive[] = [];
  const every = Math.max(1, Math.ceil(cols.length / 12));
  cols.forEach((c, j) => {
    if (j % every === 0) items.push({ kind: 'text', x: x0 + j * cellW + cellW / 2, y: height - 8, text: truncate(c, 6), size: 9.5, fill: TEXT, anchor: 'middle', opacity: 0.75 });
  });
  rows.forEach((r, i) => {
    items.push({ kind: 'text', x: x0 - 6, y: 6 + i * cellH + cellH / 2, text: truncate(r, 14), size: 10.5, fill: TEXT, anchor: 'end', baseline: 'middle' });
    cols.forEach((c, j) => {
      const v = values[i]?.[j] ?? 0;
      items.push({
        kind: 'rect',
        x: x0 + j * cellW + 1,
        y: 6 + i * cellH + 1,
        w: Math.max(1, cellW - 2),
        h: Math.max(1, cellH - 2),
        fill: base,
        opacity: v ? 0.15 + 0.85 * (v / max) : 0.05,
        rx: 2,
        tip: `${r} · ${c}: ${format(v)}`,
        key: `${r}:${c}`,
      });
    });
  });
  return { width, height, items, legend: [{ label: `0 → ${format(max)}`, color: base }], summary: `${rows.length}×${cols.length} cells, hottest ${format(max)}` };
}

/** Column chart is the vertical twin of the bar chart; exported under both names for the catalogue. */
export const CHART_FAMILIES = {
  comparison: ['bar', 'column', 'radar'],
  trends: ['line', 'area', 'gantt'],
  composition: ['pie', 'donut', 'treemap'],
  distribution: ['scatter', 'histogram', 'bubble', 'heatmap'],
} as const;
export type ChartKind = (typeof CHART_FAMILIES)[keyof typeof CHART_FAMILIES][number];

/** Serialise a scene to SVG markup (server-rendered pages, e-mails, Lite, tests). */
export function sceneToSvg(scene: Scene, opts: { className?: string } = {}): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const attrs = (o: Record<string, unknown>) =>
    Object.entries(o)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}="${esc(String(v))}"`)
      .join(' ');
  const parts = scene.items.map((it) => {
    const tip = 'tip' in it && it.tip ? `<title>${esc(it.tip)}</title>` : '';
    switch (it.kind) {
      case 'rect':
        return `<rect ${attrs({ x: it.x, y: it.y, width: it.w, height: it.h, fill: it.fill, rx: it.rx, opacity: it.opacity })}>${tip}</rect>`;
      case 'circle':
        return `<circle ${attrs({ cx: it.cx, cy: it.cy, r: it.r, fill: it.fill, opacity: it.opacity, stroke: it.stroke })}>${tip}</circle>`;
      case 'path':
        return `<path ${attrs({ d: it.d, stroke: it.stroke, fill: it.fill ?? 'none', 'stroke-width': it.width, opacity: it.opacity, 'stroke-dasharray': it.dash, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' })}>${tip}</path>`;
      case 'line':
        return `<line ${attrs({ x1: it.x1, y1: it.y1, x2: it.x2, y2: it.y2, stroke: it.stroke, 'stroke-width': it.width, opacity: it.opacity, 'stroke-dasharray': it.dash })}/>`;
      case 'polygon':
        return `<polygon ${attrs({ points: it.points.map((p) => p.join(',')).join(' '), fill: it.fill ?? 'none', stroke: it.stroke, 'stroke-width': it.width, opacity: it.opacity })}>${tip}</polygon>`;
      case 'text':
        return `<text ${attrs({ x: it.x, y: it.y, 'font-size': it.size ?? 11, fill: it.fill ?? TEXT, 'text-anchor': it.anchor, 'font-weight': it.weight, opacity: it.opacity, 'dominant-baseline': it.baseline })}>${esc(it.text)}</text>`;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${scene.width} ${scene.height}" role="img" aria-label="${esc(scene.summary)}"${opts.className ? ` class="${esc(opts.className)}"` : ''} style="width:100%;height:auto;font-family:system-ui,sans-serif">${parts.join('')}</svg>`;
}
