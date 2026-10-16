import { s, barPath, measureText } from '../render/svg';
import { bandScale, linearScale, pointScale } from '../render/scales';
import type { RenderContext } from './types';
import { defineVisual } from './registry';
import type { Series } from './common';
import { drawReferenceLines, drawTrendLine } from './analytics';
import { renderSmallMultiples } from './multiples';
import { categoryLabelLayout, drawCategoryLabels, drawValueAxisY, emptyState, labelFormatter, markOpacity, mergeIdentity, pivot, renderLegend, tooltipItems, valueAxisFormatter, withLegend } from './common';

type Kind = 'line' | 'area' | 'stackedArea' | 'combo';

function linePath(pts: ([number, number] | null)[], smooth: boolean): string {
  let d = '';
  let run: [number, number][] = [];
  const flush = () => {
    if (!run.length) return;
    if (!smooth || run.length < 3) d += `M${run.map((p) => p.join(',')).join('L')}`;
    else {
      // monotone-ish cardinal spline
      d += `M${run[0].join(',')}`;
      for (let i = 0; i < run.length - 1; i++) {
        const p0 = run[i - 1] ?? run[i];
        const p1 = run[i];
        const p2 = run[i + 1];
        const p3 = run[i + 2] ?? p2;
        const t = 0.18;
        d += `C${p1[0] + (p2[0] - p0[0]) * t},${p1[1] + (p2[1] - p0[1]) * t} ${p2[0] - (p3[0] - p1[0]) * t},${p2[1] - (p3[1] - p1[1]) * t} ${p2[0]},${p2[1]}`;
      }
    }
    run = [];
  };
  for (const p of pts) {
    if (p) run.push(p);
    else flush();
  }
  flush();
  return d;
}

function renderLine(ctx: RenderContext, kind: Kind): void {
  if (kind !== 'combo' && renderSmallMultiples(ctx, (panel) => renderLine(panel, kind), kind === 'stackedArea')) return;
  const pv = pivot(ctx, 'category', 'legend', 'values');
  let lineSeries: Series[] = [];
  let colSeries: Series[] = [];
  if (kind === 'combo') {
    colSeries = pv.series;
    const lp = pivot(ctx, 'category', '__none__', 'lineValues');
    // align line values to column categories
    lineSeries = lp.series.map((se, i) => ({ ...se, color: ctx.seriesColor(se.name, colSeries.length + i) }));
    if (!pv.categories.length && lp.categories.length) pv.categories.push(...lp.categories);
  } else lineSeries = pv.series;
  const { categories } = pv;
  if (!categories.length || (!lineSeries.length && !colSeries.length)) return emptyState(ctx);
  const t = ctx.theme;
  const f = ctx.format;
  const all = [...colSeries, ...lineSeries];
  const legend = renderLegend(
    ctx,
    all.map((se, i) => ({ name: se.name, color: se.color, identity: se.identity, shape: i >= colSeries.length ? 'line' : 'square' })),
  );
  const { plot, width, height } = withLegend(ctx, legend);
  const fs = t.labelFontSize;
  const va = f.valueAxis;

  const stacked = kind === 'stackedArea';
  let lo = 0;
  let hi = 0;
  categories.forEach((_, ci) => {
    if (stacked) {
      let sum = 0;
      for (const se of lineSeries) sum += se.values[ci] ?? 0;
      hi = Math.max(hi, sum);
      lo = Math.min(lo, sum);
    } else
      for (const se of all) {
        const v = se.values[ci];
        if (v === null) continue;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
  });
  const includeZero = kind !== 'line' || va.min === 0;
  if (!includeZero) {
    lo = Infinity;
    hi = -Infinity;
    for (const se of all) for (const v of se.values) if (v !== null) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
  }
  const valueField = all[0]?.field;
  const endLabels = f.lines.endLabels && lineSeries.length <= 4 && kind !== 'combo';
  const labelFmt = labelFormatter(ctx, valueField);
  const endW = endLabels ? Math.max(...lineSeries.map((se) => measureText(labelFmt(lastValue(se)), fs, t.fontFamily, 600))) + 12 : 10;

  const top = 10;
  let scale = linearScale(lo, hi, [height - 30, top], { includeZero, fixedMin: va.min, fixedMax: va.max, tickCount: Math.max(2, Math.min(va.tickCount, Math.floor(height / 40))) });
  const fmtAxis = valueAxisFormatter(ctx, valueField, scale);
  const left = va.show ? Math.ceil(Math.max(...scale.ticks.map((x) => measureText(fmtAxis(x), fs, t.fontFamily)))) + 12 : 8;
  const right = endW;
  const useBand = kind === 'combo';
  const xs = useBand ? bandScale(categories.length, [left, width - right], f.bars.categoryGap, 0.15) : pointScale(categories.length, [left, width - right], 6);
  const xAt = (i: number) => (useBand ? xs(i) + xs.bandwidth / 2 : xs(i));
  const labels = categories.map((c) => c.label);
  const catLayout = categoryLabelLayout(ctx, labels, Math.max(xs.step, 1));
  const bottom = height - catLayout.height - 2;
  scale = linearScale(lo, hi, [bottom, top], { includeZero, fixedMin: va.min, fixedMax: va.max, tickCount: Math.max(2, Math.min(va.tickCount, Math.floor((bottom - top) / 36))) });

  const svg = s('svg', { width, height, class: 'pbi-svg', role: 'img', 'aria-label': ctx.spec.title ?? 'Line chart' });
  const g = s('g');
  svg.append(g);
  plot.append(svg);
  drawValueAxisY(ctx, g, scale, left, width - right, valueAxisFormatter(ctx, valueField, scale));
  drawCategoryLabels(ctx, g, labels, xAt, bottom, catLayout);
  const marks = s('g', { class: 'pbi-marks' });
  g.append(marks);

  // combo columns
  if (colSeries.length) {
    const n = colSeries.length;
    const gap = f.bars.gap;
    const thick = Math.max(1, Math.min(f.bars.maxThickness, (xs.bandwidth - gap * (n - 1)) / n));
    categories.forEach((cat, ci) => {
      const groupW = thick * n + gap * (n - 1);
      const x0 = xs(ci) + (xs.bandwidth - groupW) / 2;
      colSeries.forEach((se, si) => {
        const v = se.values[ci];
        if (v === null) return;
        const y0 = scale(0);
        const y1 = scale(v);
        const identity = mergeIdentity(cat.identity, se.identity);
        const path = s('path', { d: barPath(x0 + si * (thick + gap), Math.min(y0, y1), thick, Math.abs(y1 - y0), f.bars.radius, v >= 0 ? 'top' : 'bottom'), fill: se.color, opacity: markOpacity(ctx, identity), class: 'pbi-mark' });
        marks.append(path);
      });
    });
  }

  // stacked baselines
  const base = categories.map(() => 0);
  lineSeries.forEach((se) => {
    const pts = se.values.map((v, i) => {
      if (v === null && !stacked) return null;
      const y = stacked ? base[i] + (v ?? 0) : (v as number);
      return [xAt(i), scale(y)] as [number, number];
    });
    if (kind === 'area' || stacked || f.lines.area) {
      const lower = categories.map((_, i) => [xAt(i), scale(stacked ? base[i] : 0)] as [number, number]);
      const valid = pts.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
      if (valid.length) {
        const upper = valid.map((i) => pts[i]!);
        const low = valid.map((i) => lower[i]).reverse();
        marks.append(s('path', { d: `M${upper.map((p) => p.join(',')).join('L')}L${low.map((p) => p.join(',')).join('L')}Z`, fill: se.color, 'fill-opacity': stacked ? 0.55 : f.lines.areaOpacity, stroke: 'none', 'pointer-events': 'none' }));
      }
    }
    const path = s('path', { d: linePath(pts, f.lines.smooth), fill: 'none', stroke: se.color, 'stroke-width': f.lines.width, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: se.highlights ? 0.3 : se.identity ? markOpacity(ctx, se.identity) : 1, class: 'pbi-line' });
    if (ctx.animate && f.animation.enabled) {
      path.style.strokeDasharray = '4000';
      path.style.strokeDashoffset = '4000';
      path.classList.add('pbi-draw');
      path.style.animationDuration = `${f.animation.duration * 2}ms`;
    }
    marks.append(path);
    if (se.highlights && !stacked) {
      // cross-highlight: the selected portion drawn solid over the faded full line
      const hp = se.highlights.map((v, i) => (v === null ? null : ([xAt(i), scale(v)] as [number, number])));
      marks.append(s('path', { d: linePath(hp, f.lines.smooth), fill: 'none', stroke: se.color, 'stroke-width': f.lines.width, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', class: 'pbi-line pbi-line-highlight', 'pointer-events': 'none' }));
    }
    const showMarkers = f.lines.markers === true || (f.lines.markers === 'auto' && categories.length <= 16);
    if (showMarkers)
      pts.forEach((p, i) => {
        if (!p) return;
        const op = markOpacity(ctx, mergeIdentity(categories[i].identity, se.identity));
        marks.append(s('circle', { cx: p[0], cy: p[1], r: 4, fill: se.color, stroke: t.surface, 'stroke-width': 2, opacity: op, 'pointer-events': 'none' }));
      });
    if (stacked) se.values.forEach((v, i) => (base[i] += v ?? 0));
  });

  drawReferenceLines(ctx, g, scale, 'y', [left, width - right], all.flatMap((se) => se.values.filter((v): v is number => v !== null)), valueField);
  if (!stacked) lineSeries.forEach((se) => drawTrendLine(ctx, g, se.values, xAt, scale, se.color));

  // end labels (value at the end of each line)
  if (endLabels) {
    const placed: number[] = [];
    lineSeries.forEach((se) => {
      const li = lastIndex(se);
      if (li < 0) return;
      let y = scale(stacked ? cumulative(lineSeries, se, li) : se.values[li]!) + fs / 3;
      if (placed.some((p) => Math.abs(p - y) < fs + 1)) return; // collisions → legend/tooltip carry it
      placed.push(y);
      y = Math.max(fs, Math.min(bottom, y));
      marks.append(s('text', { x: xAt(li) + 8, y, class: 'pbi-label pbi-end-label', fill: t.foreground, 'font-weight': 600 }, labelFmt(se.values[li])));
    });
  }
  if (f.dataLabels.show && !endLabels)
    lineSeries.forEach((se) => se.values.forEach((v, i) => v !== null && marks.append(s('text', { x: xAt(i), y: scale(v) - 8, 'text-anchor': 'middle', class: 'pbi-label', fill: t.foregroundSecondary }, labelFmt(v)))));

  // crosshair + hit layer
  const cross = s('line', { y1: top, y2: bottom, stroke: t.axis, 'stroke-width': 1, visibility: 'hidden', 'pointer-events': 'none' });
  const dots = s('g', { 'pointer-events': 'none' });
  g.append(cross, dots);
  const hit = s('rect', { x: left, y: top, width: Math.max(0, width - right - left), height: Math.max(0, bottom - top), fill: 'transparent', class: 'pbi-hit' });
  g.append(hit);
  const indexAt = (e: MouseEvent) => {
    const r = svg.getBoundingClientRect();
    return xs.indexAt(((e.clientX - r.left) * width) / (r.width || width));
  };
  hit.addEventListener('mousemove', (e) => {
    const i = indexAt(e);
    const x = xAt(i);
    cross.setAttribute('x1', String(x));
    cross.setAttribute('x2', String(x));
    cross.setAttribute('visibility', 'visible');
    dots.replaceChildren();
    const cum = categories.map(() => 0);
    for (const se of lineSeries) {
      const v = se.values[i];
      if (v === null) continue;
      const yv = stacked ? (cum[i] += v) : v;
      dots.append(s('circle', { cx: x, cy: scale(yv), r: 4, fill: se.color, stroke: t.surface, 'stroke-width': 2 }));
    }
    if (f.tooltip.show) ctx.host.showTooltip(e, tooltipItems(ctx, categories[i], all, i), categories[i].label);
  });
  hit.addEventListener('mouseleave', () => {
    cross.setAttribute('visibility', 'hidden');
    dots.replaceChildren();
    ctx.host.hideTooltip();
  });
  hit.addEventListener('click', (e) => {
    e.stopPropagation();
    const i = indexAt(e);
    ctx.host.select(categories[i].identity, { multi: e.ctrlKey || e.metaKey });
    ctx.host.emit('dataPointClick', { keys: categories[i].keys, identity: categories[i].identity, event: e });
  });
  hit.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    ctx.host.contextMenu(e, categories[indexAt(e)].identity);
  });
  hit.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    if (ctx.host.drill.levels > 1 && ctx.host.drill.level < ctx.host.drill.levels - 1) {
      const i = indexAt(e);
      ctx.host.drillDown(categories[i].keys[categories[i].keys.length - 1]);
    }
  });
}

function lastIndex(se: Series): number {
  for (let i = se.values.length - 1; i >= 0; i--) if (se.values[i] !== null) return i;
  return -1;
}
function lastValue(se: Series): number | null {
  const i = lastIndex(se);
  return i < 0 ? null : se.values[i];
}
function cumulative(all: Series[], upto: Series, i: number): number {
  let sum = 0;
  for (const se of all) {
    sum += se.values[i] ?? 0;
    if (se === upto) break;
  }
  return sum;
}

const ROLES = [
  { name: 'category', displayName: 'X-axis', kind: 'grouping' as const, multiple: true, drillable: true },
  { name: 'legend', displayName: 'Legend', kind: 'grouping' as const },
  { name: 'values', displayName: 'Y-axis', kind: 'measure' as const, multiple: true, required: true },
  { name: 'smallMultiples', displayName: 'Small multiples', kind: 'grouping' as const },
];

export const lineChart = defineVisual({ type: 'line', displayName: 'Line chart', category: 'chart', roles: ROLES, supportsHighlight: true, defaultSort: 'key', render: (c) => renderLine(c, 'line') });
export const areaChart = defineVisual({ type: 'area', displayName: 'Area chart', category: 'chart', roles: ROLES, supportsHighlight: true, defaultSort: 'key', render: (c) => renderLine(c, 'area') });
export const stackedAreaChart = defineVisual({ type: 'stackedArea', displayName: 'Stacked area chart', category: 'chart', roles: ROLES, defaultSort: 'key', render: (c) => renderLine(c, 'stackedArea') });
export const comboChart = defineVisual({
  type: 'lineClusteredColumn',
  displayName: 'Line and clustered column chart',
  category: 'chart',
  roles: [
    { name: 'category', displayName: 'X-axis', kind: 'grouping', multiple: true, drillable: true },
    { name: 'legend', displayName: 'Column legend', kind: 'grouping' },
    { name: 'values', displayName: 'Column y-axis', kind: 'measure', multiple: true },
    { name: 'lineValues', displayName: 'Line y-axis', kind: 'measure', multiple: true },
  ],
  defaultSort: 'key',
  render: (c) => renderLine(c, 'combo'),
});
