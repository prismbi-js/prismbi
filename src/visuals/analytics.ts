import type { QueryField } from '../data/query';
import { s } from '../render/svg';
import { ramp } from '../render/color';
import type { LinearScale } from '../render/scales';
import type { ReferenceLine } from './format';
import type { RenderContext } from './types';

function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * Math.max(0, Math.min(1, p));
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Value of a reference line over the plotted values. */
export function referenceValue(line: ReferenceLine, values: number[]): number | null {
  if (line.type === 'constant') return line.value ?? null;
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  switch (line.type) {
    case 'average':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'median':
      return quantile(sorted, 0.5);
    case 'min':
      return sorted[0];
    case 'max':
      return sorted[sorted.length - 1];
    case 'percentile':
      return quantile(sorted, (line.percentile ?? 50) / 100);
  }
}

const LABELS: Record<ReferenceLine['type'], string> = { constant: '', average: 'Average', median: 'Median', min: 'Min', max: 'Max', percentile: 'P' };

/**
 * Draw `format.analytics.referenceLines` across the plot.
 * `axis: 'y'` → horizontal lines (vertical charts); `axis: 'x'` → vertical lines (horizontal bars).
 */
export function drawReferenceLines(ctx: RenderContext, g: SVGGElement, scale: LinearScale, axis: 'x' | 'y', span: [number, number], values: number[], field?: QueryField): void {
  const t = ctx.theme;
  for (const line of ctx.format.analytics.referenceLines ?? []) {
    const v = referenceValue(line, values);
    if (v === null || !Number.isFinite(v)) continue;
    const p = Math.round(scale(v)) + 0.5;
    const color = line.color ?? t.foregroundSecondary;
    const attrs = { stroke: color, 'stroke-width': 1.5, 'stroke-dasharray': line.dash === false ? undefined : '5 4', class: 'pbi-refline', 'pointer-events': 'none' };
    const valueText = ctx.fmt(field, v, { displayUnits: 'auto' });
    const label = line.label === false ? '' : line.label ? line.label.replace('{value}', valueText) : `${line.type === 'percentile' ? `P${line.percentile ?? 50}` : LABELS[line.type]}${LABELS[line.type] || line.type === 'percentile' ? ' ' : ''}${valueText}`;
    if (axis === 'y') {
      g.append(s('line', { x1: span[0], x2: span[1], y1: p, y2: p, ...attrs }));
      if (label) g.append(s('text', { x: span[1] - 4, y: p - 5, 'text-anchor': 'end', class: 'pbi-label pbi-refline-label', fill: t.foregroundSecondary }, label));
    } else {
      g.append(s('line', { y1: span[0], y2: span[1], x1: p, x2: p, ...attrs }));
      if (label) g.append(s('text', { x: p + 4, y: span[0] + 12, class: 'pbi-label pbi-refline-label', fill: t.foregroundSecondary }, label));
    }
  }
}

/** Least-squares fit over (index, value) pairs. */
export function linearFit(points: [number, number][]): { slope: number; intercept: number } | null {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (const [x, y] of points) {
    sx += x;
    sy += y;
    sxy += x * y;
    sxx += x * x;
  }
  const den = n * sxx - sx * sx;
  if (den === 0) return null;
  const slope = (n * sxy - sx * sy) / den;
  return { slope, intercept: (sy - slope * sx) / n };
}

/** Draw a dashed trend line for a series of values placed at `xAt(i)`. */
export function drawTrendLine(ctx: RenderContext, g: SVGGElement, values: (number | null)[], xAt: (i: number) => number, yScale: LinearScale, color: string): void {
  const tl = ctx.format.analytics.trendLine;
  if (!tl) return;
  const pts = values.map((v, i) => (v === null ? null : ([i, v] as [number, number]))).filter((p): p is [number, number] => !!p);
  const fit = linearFit(pts);
  if (!fit) return;
  const first = pts[0][0];
  const last = pts[pts.length - 1][0];
  const stroke = (typeof tl === 'object' && tl.color) || color;
  g.append(
    s('line', {
      x1: xAt(first),
      x2: xAt(last),
      y1: yScale(fit.intercept + fit.slope * first),
      y2: yScale(fit.intercept + fit.slope * last),
      stroke,
      'stroke-width': 1.5,
      'stroke-dasharray': '6 4',
      opacity: 0.9,
      class: 'pbi-trend',
      'pointer-events': 'none',
    }),
  );
}

/** Colour for a value from `format.colors.rules` / `gradient`, or `fallback`. */
export function valueColor(ctx: RenderContext, v: number | null, domain: [number, number], fallback: string): string {
  const c = ctx.format.colors;
  if (v === null) return fallback;
  for (const r of c.rules ?? []) {
    const hit =
      r.op === '>' ? v > r.value : r.op === '>=' ? v >= r.value : r.op === '<' ? v < r.value : r.op === '<=' ? v <= r.value : r.op === '=' ? v === r.value : r.op === '<>' ? v !== r.value : v >= r.value && v <= (r.value2 ?? r.value);
    if (hit) return r.color;
  }
  if (c.gradient) {
    const t = ctx.theme;
    const stops = [c.gradient.min ?? t.sequential[1], ...(c.gradient.mid ? [c.gradient.mid] : []), c.gradient.max ?? t.sequential[t.sequential.length - 2]];
    const [lo, hi] = domain;
    return ramp(stops, hi === lo ? 1 : (v - lo) / (hi - lo));
  }
  return fallback;
}

export function hasValueColors(ctx: RenderContext): boolean {
  return !!(ctx.format.colors.rules?.length || ctx.format.colors.gradient);
}
