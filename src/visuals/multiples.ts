import { h } from '../render/svg';
import { linearScale } from '../render/scales';
import { valueKey } from '../data/types';
import type { QueryRow } from '../data/query';
import { deepMerge } from '../utils';
import type { VisualFormat } from './format';
import type { RenderContext } from './types';
import { pivot, renderLegend } from './common';

export interface SmallMultiplesFormat {
  /** Fixed number of grid columns (default: auto from aspect ratio). */
  columns?: number;
  /** Share one value axis range across panels (default true). */
  sharedAxis?: boolean;
  /** Minimum panel size in px. */
  minWidth?: number;
  minHeight?: number;
}

/**
 * If the visual has a `smallMultiples` field, render one panel per member with a shared value
 * axis and a single legend, calling `render` for each panel. Returns false when not applicable.
 */
export function renderSmallMultiples(ctx: RenderContext, render: (panel: RenderContext) => void, stacked = false): boolean {
  const sm = ctx.role('smallMultiples');
  if (!sm.indices.length) return false;
  const si = sm.indices[0];
  const field = ctx.data.groups[si];
  const smf = (ctx.format.smallMultiples ?? {}) as SmallMultiplesFormat;
  const order = new Map<unknown, number>();
  if (field.column) ctx.model.table(field.column.table).distinct(field.column.column).forEach((v, i) => order.set(valueKey(v), i));
  const panels = new Map<unknown, { key: QueryRow['keys'][number]; rows: QueryRow[] }>();
  for (const r of ctx.data.rows) {
    const k = valueKey(r.keys[si]);
    let p = panels.get(k);
    if (!p) panels.set(k, (p = { key: r.keys[si], rows: [] }));
    p.rows.push(r);
  }
  const list = [...panels.values()].sort((a, b) => (order.get(valueKey(a.key)) ?? 0) - (order.get(valueKey(b.key)) ?? 0));

  // shared value range across panels (stack totals for stacked charts)
  const vals = ctx.role('values').indices;
  const cat = ctx.role('category').indices;
  let lo = 0;
  let hi = 0;
  if (stacked) {
    const sums = new Map<string, [number, number]>();
    for (const r of ctx.data.rows) {
      const k = JSON.stringify([valueKey(r.keys[si]), ...cat.map((i) => valueKey(r.keys[i]))]);
      const cur = sums.get(k) ?? [0, 0];
      for (const vi of vals) {
        const v = r.values[vi];
        if (typeof v === 'number') v >= 0 ? (cur[1] += v) : (cur[0] += v);
      }
      sums.set(k, cur);
    }
    for (const [n, p] of sums.values()) (lo = Math.min(lo, n)), (hi = Math.max(hi, p));
  } else
    for (const r of ctx.data.rows)
      for (const vi of vals) {
        const v = r.values[vi];
        if (typeof v === 'number') (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
      }
  const nice = linearScale(lo, hi, [0, 1]);

  // one legend for the whole visual
  const full = pivot(ctx);
  const legend = renderLegend(ctx, full.series.map((se) => ({ name: se.name, color: se.color, identity: se.identity })));
  ctx.root.replaceChildren();
  const wrap = h('div', { class: 'pbi-sm' });
  if (legend) wrap.append(legend);
  const grid = h('div', { class: 'pbi-sm-grid' });
  wrap.append(grid);
  ctx.root.append(wrap);

  const W = ctx.width;
  const H = ctx.height - (legend ? Math.max(legend.offsetHeight || 0, 22) + 6 : 0);
  const n = list.length;
  const minW = smf.minWidth ?? 160;
  const cols = Math.max(1, Math.min(n, smf.columns ?? Math.max(1, Math.min(Math.floor(W / minW), Math.round(Math.sqrt((n * W) / Math.max(1, H)))))));
  const rowsN = Math.ceil(n / cols);
  const gap = 8;
  const cellW = (W - gap * (cols - 1)) / cols;
  const cellH = Math.max(smf.minHeight ?? 110, (H - gap * (rowsN - 1)) / rowsN);
  grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  grid.style.gap = `${gap}px`;
  const titleH = ctx.theme.labelFontSize + 8;
  const fmt: VisualFormat = deepMerge(ctx.format, {
    legend: { show: false },
    valueAxis: smf.sharedAxis === false ? {} : { min: ctx.format.valueAxis.min ?? nice.domain[0], max: ctx.format.valueAxis.max ?? nice.domain[1] },
  } as Partial<VisualFormat>);
  for (const p of list) {
    const body = h('div', { class: 'pbi-sm-body' });
    grid.append(h('div', { class: 'pbi-sm-cell', style: `height:${cellH}px` }, h('div', { class: 'pbi-sm-title' }, ctx.fmt(field, p.key) || '(Blank)'), body));
    render({
      ...ctx,
      root: body,
      width: cellW,
      height: cellH - titleH,
      format: fmt,
      data: { ...ctx.data, rows: p.rows, totals: undefined },
      role: (name) => (name === 'smallMultiples' ? { kind: 'group', indices: [], fields: [] } : ctx.role(name)),
    });
  }
  return true;
}
