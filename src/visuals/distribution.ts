import { s, measureText } from '../render/svg';
import { bandScale, linearScale, niceStep } from '../render/scales';
import type { CellValue } from '../data/types';
import { isColumnRefString, parseColumnRef, valueKey } from '../data/types';
import type { FieldSpec } from '../data/query';
import { defineVisual } from './registry';
import { categoryLabelLayout, drawCategoryLabels, drawValueAxisY, emptyState, identityOf, interactive, markOpacity, valueAxisFormatter } from './common';
import type { QueryBuildContext } from './types';

const ref = (f: FieldSpec | undefined) => (f === undefined ? '' : typeof f === 'string' ? f : (f.field ?? ''));

/** Row-count expression for the table that owns a column. */
function countOf(column: string): FieldSpec {
  const t = parseColumnRef(column).table;
  return { expression: `COUNTROWS('${t.replace(/'/g, "''")}')`, name: 'Count', format: '#,0' };
}

/** Value at position `idx` of the sorted values expanded by their weights. */
function valueAt(pairs: [number, number][], idx: number): number {
  let cum = 0;
  for (const [v, w] of pairs) {
    cum += w;
    if (idx < cum) return v;
  }
  return pairs[pairs.length - 1][0];
}

/** Weighted quantile (linear interpolation, like Excel's QUARTILE.INC) over (value, count) pairs sorted by value. */
export function wQuantile(pairs: [number, number][], q: number): number {
  const total = pairs.reduce((a, p) => a + p[1], 0);
  if (!total) return NaN;
  const h = q * (total - 1);
  const lo = Math.floor(h);
  const a = valueAt(pairs, lo);
  const b = valueAt(pairs, Math.ceil(h));
  return a + (b - a) * (h - lo);
}

// ------------------------------------------------------------------- histogram

interface HistogramFormat {
  /** Number of bins (default: Sturges' rule). */
  bins?: number;
  /** Fixed bin width (overrides `bins`). */
  binWidth?: number;
}

/** Histogram of a numeric column. Optional `weight` measure sums a measure per bin instead of counting rows. */
export const histogram = /* @__PURE__ */ defineVisual({
  type: 'histogram',
  displayName: 'Histogram',
  category: 'chart',
  roles: [
    { name: 'values', displayName: 'Values (numeric column)', kind: 'any', required: true },
    { name: 'weight', displayName: 'Weight (optional measure)', kind: 'any' },
  ],
  buildQuery(b: QueryBuildContext, base) {
    const field = ref(b.fields('values')[0]);
    if (!field || !isColumnRefString(field)) return null;
    const weight = b.fields('weight')[0];
    return { ...base, groupBy: [field], values: [weight ?? countOf(field)], orderBy: undefined, highlight: undefined };
  },
  render(ctx) {
    const field = ctx.data.groups[0];
    const vField = ctx.data.values[0];
    if (!field || field.type !== 'number') return emptyState(ctx, 'Add a numeric column');
    const pairs = ctx.data.rows
      .filter((r) => typeof r.keys[0] === 'number' && typeof r.values[0] === 'number')
      .map((r) => [r.keys[0] as number, r.values[0] as number] as [number, number]);
    if (!pairs.length) return emptyState(ctx);
    const t = ctx.theme;
    const f = ctx.format;
    const hf = (f.histogram ?? {}) as HistogramFormat;
    const min = Math.min(...pairs.map((p) => p[0]));
    const max = Math.max(...pairs.map((p) => p[0]));
    const n = pairs.reduce((a, p) => a + p[1], 0);
    const bins = hf.bins ?? Math.max(5, Math.min(40, Math.ceil(Math.log2(Math.max(1, n)) + 1)));
    const width0 = hf.binWidth ?? niceStep(max - min || 1, bins);
    const start = Math.floor(min / width0) * width0;
    const count = Math.max(1, Math.ceil((max - start) / width0 + 1e-9) || 1);
    const sums = new Array(count).fill(0);
    for (const [v, w] of pairs) sums[Math.min(count - 1, Math.floor((v - start) / width0))] += w;
    const fs = t.labelFontSize;
    const W = ctx.width;
    const H = ctx.height;
    let y = linearScale(0, Math.max(...sums), [H - fs - 16, 8]);
    const fmtY = valueAxisFormatter(ctx, vField, y);
    const left = Math.ceil(Math.max(...y.ticks.map((v) => measureText(fmtY(v), fs, t.fontFamily)))) + 12;
    const bottom = H - fs - 16;
    y = linearScale(0, Math.max(...sums), [bottom, 8], { tickCount: Math.max(2, Math.floor((bottom - 8) / 36)) });
    const x = linearScale(start, start + count * width0, [left, W - 8], { includeZero: false, fixedMin: start, fixedMax: start + count * width0, tickCount: Math.max(2, Math.floor((W - left) / 70)) });
    const svg = s('svg', { width: W, height: H, class: 'pbi-svg', role: 'img', 'aria-label': ctx.spec.title ?? 'Histogram' });
    const g = s('g');
    svg.append(g);
    drawValueAxisY(ctx, g, y, left, W - 8, valueAxisFormatter(ctx, vField, y));
    for (const tk of x.ticks) g.append(s('text', { x: x(tk), y: bottom + fs + 6, 'text-anchor': 'middle', class: 'pbi-tick', fill: t.foregroundSecondary }, ctx.fmt(field, tk, { displayUnits: 'auto' })));
    const color = f.colors.default ?? t.dataColors[0];
    const gap = f.bars.gap;
    sums.forEach((v, i) => {
      if (!v) return;
      const x0 = x(start + i * width0) + gap / 2;
      const x1 = x(start + (i + 1) * width0) - gap / 2;
      const rect = s('rect', { x: x0, y: y(v), width: Math.max(1, x1 - x0), height: Math.max(0, bottom - y(v)), fill: color, class: 'pbi-mark' });
      const lo = start + i * width0;
      const hi = lo + width0;
      rect.addEventListener('mousemove', (e) => ctx.host.showTooltip(e, [{ label: vField.name, value: ctx.fmt(vField, v) }], `${ctx.fmt(field, lo)} – ${ctx.fmt(field, hi)}`));
      rect.addEventListener('mouseleave', () => ctx.host.hideTooltip());
      g.append(rect);
    });
    ctx.root.replaceChildren(svg);
  },
});

// ------------------------------------------------------------------- box plot

/** Box-and-whisker plot of a numeric column, optionally split by a category. Whiskers at 1.5 × IQR; outliers drawn as dots. */
export const boxPlot = /* @__PURE__ */ defineVisual({
  type: 'boxPlot',
  displayName: 'Box plot',
  category: 'chart',
  roles: [
    { name: 'category', displayName: 'Category', kind: 'any' },
    { name: 'values', displayName: 'Values (numeric column)', kind: 'any', required: true },
  ],
  buildQuery(b, base) {
    const field = ref(b.fields('values')[0]);
    if (!field || !isColumnRefString(field)) return null;
    const cat = ref(b.fields('category')[0]);
    return { ...base, groupBy: cat ? [cat, field] : [field], values: [countOf(field)], orderBy: undefined, highlight: undefined };
  },
  render(ctx) {
    const hasCat = ctx.data.groups.length === 2;
    const vi = hasCat ? 1 : 0;
    const field = ctx.data.groups[vi];
    if (!field || field.type !== 'number') return emptyState(ctx, 'Add a numeric column');
    const catField = hasCat ? ctx.data.groups[0] : undefined;
    const groups = new Map<unknown, { key: CellValue; pairs: [number, number][] }>();
    for (const r of ctx.data.rows) {
      const v = r.keys[vi];
      const w = r.values[0];
      if (typeof v !== 'number' || typeof w !== 'number') continue;
      const k = hasCat ? valueKey(r.keys[0]) : '__all__';
      let gr = groups.get(k);
      if (!gr) groups.set(k, (gr = { key: hasCat ? r.keys[0] : field.name, pairs: [] }));
      gr.pairs.push([v, w]);
    }
    if (!groups.size) return emptyState(ctx);
    const stats = [...groups.values()].map((gr) => {
      const pairs = gr.pairs.sort((a, b) => a[0] - b[0]);
      const q1 = wQuantile(pairs, 0.25);
      const med = wQuantile(pairs, 0.5);
      const q3 = wQuantile(pairs, 0.75);
      const iqr = q3 - q1;
      const inside = pairs.filter((p) => p[0] >= q1 - 1.5 * iqr && p[0] <= q3 + 1.5 * iqr);
      const lo = inside.length ? inside[0][0] : q1;
      const hi = inside.length ? inside[inside.length - 1][0] : q3;
      const total = pairs.reduce((a, p) => a + p[1], 0);
      const mean = pairs.reduce((a, p) => a + p[0] * p[1], 0) / (total || 1);
      return { key: gr.key, q1, med, q3, lo, hi, mean, outliers: pairs.filter((p) => p[0] < lo || p[0] > hi).map((p) => p[0]), n: total };
    });
    const t = ctx.theme;
    const fs = t.labelFontSize;
    const W = ctx.width;
    const H = ctx.height;
    const all = stats.flatMap((x) => [x.lo, x.hi, ...x.outliers]);
    let y = linearScale(Math.min(...all), Math.max(...all), [H - 30, 8], { includeZero: false });
    const fmtY = valueAxisFormatter(ctx, field, y);
    const left = Math.ceil(Math.max(...y.ticks.map((v) => measureText(fmtY(v), fs, t.fontFamily)))) + 12;
    const labels = stats.map((x) => (catField ? ctx.fmt(catField, x.key) || '(Blank)' : String(x.key)));
    const band = bandScale(stats.length, [left, W - 8], 0.45, 0.2);
    const layout = categoryLabelLayout(ctx, labels, band.step);
    const bottom = H - layout.height - 2;
    y = linearScale(Math.min(...all), Math.max(...all), [bottom, 8], { includeZero: false, tickCount: Math.max(2, Math.floor((bottom - 8) / 36)) });
    const svg = s('svg', { width: W, height: H, class: 'pbi-svg', role: 'img', 'aria-label': ctx.spec.title ?? 'Box plot' });
    const g = s('g');
    svg.append(g);
    drawValueAxisY(ctx, g, y, left, W - 8, valueAxisFormatter(ctx, field, y));
    drawCategoryLabels(ctx, g, labels, (i) => band(i) + band.bandwidth / 2, bottom, layout);
    stats.forEach((st, i) => {
      const color = catField ? ctx.colorFor(catField, st.key) : ctx.format.colors.default ?? t.dataColors[0];
      const bw = Math.min(band.bandwidth, 48);
      const x = band(i) + (band.bandwidth - bw) / 2;
      const cx = x + bw / 2;
      const identity = catField ? identityOf([catField], [st.key]) : null;
      const op = identity ? markOpacity(ctx, identity) : 1;
      const grp = s('g', { opacity: op });
      grp.append(s('line', { x1: cx, x2: cx, y1: y(st.hi), y2: y(st.q3), stroke: t.foregroundSecondary, 'stroke-width': 1.5 }));
      grp.append(s('line', { x1: cx, x2: cx, y1: y(st.q1), y2: y(st.lo), stroke: t.foregroundSecondary, 'stroke-width': 1.5 }));
      grp.append(s('line', { x1: cx - bw / 4, x2: cx + bw / 4, y1: y(st.hi), y2: y(st.hi), stroke: t.foregroundSecondary, 'stroke-width': 1.5 }));
      grp.append(s('line', { x1: cx - bw / 4, x2: cx + bw / 4, y1: y(st.lo), y2: y(st.lo), stroke: t.foregroundSecondary, 'stroke-width': 1.5 }));
      const box = s('rect', { x, y: y(st.q3), width: bw, height: Math.max(1, y(st.q1) - y(st.q3)), rx: 4, fill: color, 'fill-opacity': 0.25, stroke: color, 'stroke-width': 1.5 });
      grp.append(box);
      grp.append(s('line', { x1: x, x2: x + bw, y1: y(st.med), y2: y(st.med), stroke: color, 'stroke-width': 2.5 }));
      grp.append(s('circle', { cx, cy: y(st.mean), r: 3, fill: t.surface, stroke: color, 'stroke-width': 1.5 }));
      for (const o of st.outliers) grp.append(s('circle', { cx, cy: y(o), r: 4, fill: color, stroke: t.surface, 'stroke-width': 2 }));
      const tip = () => ({
        title: labels[i],
        items: [
          { label: 'Max (whisker)', value: ctx.fmt(field, st.hi) },
          { label: 'Q3', value: ctx.fmt(field, st.q3) },
          { label: 'Median', value: ctx.fmt(field, st.med) },
          { label: 'Mean', value: ctx.fmt(field, st.mean) },
          { label: 'Q1', value: ctx.fmt(field, st.q1) },
          { label: 'Min (whisker)', value: ctx.fmt(field, st.lo) },
          { label: 'Rows', value: String(st.n) },
          ...(st.outliers.length ? [{ label: 'Outliers', value: String(st.outliers.length) }] : []),
        ],
      });
      if (identity) interactive(ctx, box, identity, tip, [st.key]);
      else {
        box.addEventListener('mousemove', (e) => {
          const tt = tip();
          ctx.host.showTooltip(e, tt.items, tt.title);
        });
        box.addEventListener('mouseleave', () => ctx.host.hideTooltip());
      }
      g.append(grp);
    });
    ctx.root.replaceChildren(svg);
  },
});
