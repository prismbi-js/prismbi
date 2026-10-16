import { h, s, arcPath, measureText } from '../render/svg';
import { linearScale, pointScale } from '../render/scales';
import { defineVisual } from './registry';
import { emptyState } from './common';
import type { RenderContext } from './types';
import type { CellValue } from '../data/types';

type CardFormat = { labelPosition?: 'top' | 'bottom'; showLabel?: boolean; align?: 'left' | 'center'; valueFontSize?: number; upIsGood?: boolean; deltaLabel?: string };

function deltaEl(ctx: RenderContext, delta: CellValue, field: Parameters<RenderContext['fmt']>[0], label: string | undefined, upIsGood: boolean): HTMLElement | null {
  if (typeof delta !== 'number') return null;
  const up = delta >= 0;
  const good = up === upIsGood;
  const cls = delta === 0 ? 'is-flat' : good ? 'is-good' : 'is-bad';
  const arrow = delta === 0 ? '●' : up ? '▲' : '▼';
  return h('div', { class: 'pbi-card-delta' }, h('b', { class: cls }, `${arrow} ${ctx.fmt(field, Math.abs(delta) * (up ? 1 : 1))}`), label ? ` ${label}` : '');
}

export const card = /* @__PURE__ */ defineVisual({
  type: 'card',
  displayName: 'Card',
  category: 'card',
  roles: [
    { name: 'value', displayName: 'Value', kind: 'measure', required: true },
    { name: 'delta', displayName: 'Change', kind: 'measure' },
  ],
  defaultFormat: { header: { showAsTable: false }, title: { show: false } },
  render(ctx) {
    const vi = ctx.role('value').indices[0];
    if (vi === undefined) return emptyState(ctx, 'Add a value');
    const di = ctx.role('delta').indices[0];
    const row = ctx.data.rows[0];
    const f = (ctx.format.card ?? {}) as CardFormat;
    const field = ctx.data.values[vi];
    const v = row?.values[vi] ?? null;
    const label = ctx.spec.title ?? field.name;
    const fontSize = f.valueFontSize ?? Math.max(18, Math.min(ctx.theme.calloutFontSize, ctx.height * 0.42, ctx.width / Math.max(4, ctx.fmt(field, v, { displayUnits: 'auto' }).length * 0.62)));
    const value = h('div', { class: 'pbi-card-value', style: `font-size:${fontSize.toFixed(0)}px` }, ctx.fmt(field, v, { displayUnits: ctx.format.dataLabels.displayUnits, decimals: ctx.format.dataLabels.decimals, blank: '(Blank)' }));
    const labelEl = f.showLabel === false ? null : h('div', { class: 'pbi-card-label' }, label);
    const delta = di !== undefined ? deltaEl(ctx, row?.values[di] ?? null, ctx.data.values[di], f.deltaLabel ?? ctx.data.values[di].name, f.upIsGood ?? true) : null;
    const wrap = h('div', { class: `pbi-card pbi-card-${f.align ?? 'left'}` });
    if ((f.labelPosition ?? 'top') === 'top') wrap.append(...[labelEl, value, delta].filter(Boolean) as HTMLElement[]);
    else wrap.append(...[value, labelEl, delta].filter(Boolean) as HTMLElement[]);
    ctx.root.replaceChildren(wrap);
    if (ctx.format.tooltip.show)
      value.addEventListener('mousemove', (e) => ctx.host.showTooltip(e, [{ label: field.name, value: ctx.fmt(field, v) }]));
    value.addEventListener('mouseleave', () => ctx.host.hideTooltip());
  },
});

export const multiRowCard = /* @__PURE__ */ defineVisual({
  type: 'multiRowCard',
  displayName: 'Multi-row card',
  category: 'card',
  roles: [
    { name: 'category', displayName: 'Group', kind: 'grouping' },
    { name: 'values', displayName: 'Fields', kind: 'measure', multiple: true, required: true },
  ],
  render(ctx) {
    const vals = ctx.role('values').indices;
    const gi = ctx.role('category').indices[0];
    if (!ctx.data.rows.length) return emptyState(ctx);
    const list = h('div', { class: 'pbi-mrc' });
    for (const r of ctx.data.rows.slice(0, 200)) {
      const item = h('div', { class: 'pbi-mrc-row' });
      if (gi !== undefined) item.append(h('div', { class: 'pbi-mrc-title' }, ctx.fmt(ctx.data.groups[gi], r.keys[gi])));
      const grid = h('div', { class: 'pbi-mrc-grid' });
      for (const vi of vals) grid.append(h('div', {}, h('div', { class: 'pbi-mrc-value' }, ctx.fmt(ctx.data.values[vi], r.values[vi], { displayUnits: 'auto' })), h('div', { class: 'pbi-card-label' }, ctx.data.values[vi].name)));
      item.append(grid);
      list.append(item);
    }
    ctx.root.replaceChildren(list);
  },
});

/** KPI: indicator value, goal and a trend sparkline. */
export const kpi = /* @__PURE__ */ defineVisual({
  type: 'kpi',
  displayName: 'KPI',
  category: 'card',
  roles: [
    { name: 'trend', displayName: 'Trend axis', kind: 'grouping' },
    { name: 'value', displayName: 'Value', kind: 'measure', required: true },
    { name: 'target', displayName: 'Target', kind: 'measure' },
  ],
  defaultSort: 'key',
  defaultFormat: { title: { show: false } },
  buildQuery(_b, base) {
    return { ...base, totals: true };
  },
  render(ctx) {
    const vi = ctx.role('value').indices[0];
    const ti = ctx.role('target').indices[0];
    const gi = ctx.role('trend').indices[0];
    if (vi === undefined) return emptyState(ctx, 'Add a value');
    const t = ctx.theme;
    const field = ctx.data.values[vi];
    const rows = ctx.data.rows;
    // headline = last point of the trend (Power BI KPI semantics) or the total when there is no trend
    const last = gi !== undefined ? rows[rows.length - 1] : rows[0];
    const value = last?.values[vi] ?? null;
    const target = ti !== undefined ? last?.values[ti] ?? null : null;
    const f = (ctx.format.kpi ?? {}) as { upIsGood?: boolean; showGoal?: boolean };
    const upIsGood = f.upIsGood ?? true;
    const wrap = h('div', { class: 'pbi-kpi' });
    wrap.append(h('div', { class: 'pbi-card-label' }, ctx.spec.title ?? field.name));
    const valEl = h('div', { class: 'pbi-card-value', style: `font-size:${Math.max(18, Math.min(t.calloutFontSize, ctx.height * 0.3)).toFixed(0)}px` }, ctx.fmt(field, value, { displayUnits: 'auto', blank: '(Blank)' }));
    wrap.append(valEl);
    if (typeof value === 'number' && typeof target === 'number' && target !== 0) {
      const diff = (value - target) / Math.abs(target);
      const good = diff >= 0 === upIsGood;
      wrap.append(h('div', { class: 'pbi-card-delta' }, h('b', { class: good ? 'is-good' : 'is-bad' }, `${diff >= 0 ? '▲' : '▼'} ${(Math.abs(diff) * 100).toFixed(1)}%`), ` vs goal ${ctx.fmt(ctx.data.values[ti!], target, { displayUnits: 'auto' })}`));
    }
    ctx.root.replaceChildren(wrap);
    if (gi !== undefined && rows.length > 1) {
      const w = ctx.width;
      const hh = Math.max(24, ctx.height - wrap.offsetHeight - 8 || ctx.height * 0.4);
      const vals = rows.map((r) => (typeof r.values[vi] === 'number' ? (r.values[vi] as number) : null));
      const nums = vals.filter((v): v is number => v !== null);
      const y = linearScale(Math.min(...nums), Math.max(...nums), [hh - 4, 4], { includeZero: false });
      const x = pointScale(vals.length, [2, w - 6]);
      const svg = s('svg', { width: w, height: hh, class: 'pbi-svg pbi-spark' });
      const pts = vals.map((v, i) => (v === null ? null : `${x(i)},${y(v)}`)).filter(Boolean);
      svg.append(s('path', { d: `M${pts.join('L')}L${x(vals.length - 1)},${hh}L${x(0)},${hh}Z`, fill: t.dataColors[0], 'fill-opacity': 0.1 }));
      svg.append(s('path', { d: `M${pts.join('L')}`, fill: 'none', stroke: t.dataColors[0], 'stroke-width': 2, 'stroke-linejoin': 'round' }));
      const lv = vals[vals.length - 1];
      if (lv !== null) svg.append(s('circle', { cx: x(vals.length - 1), cy: y(lv), r: 4, fill: t.dataColors[0], stroke: t.surface, 'stroke-width': 2 }));
      const gField = ctx.data.groups[gi];
      const hit = s('rect', { x: 0, y: 0, width: w, height: hh, fill: 'transparent' });
      hit.addEventListener('mousemove', (e) => {
        const r = svg.getBoundingClientRect();
        const i = x.indexAt(((e.clientX - r.left) * w) / (r.width || w));
        ctx.host.showTooltip(e, [{ label: field.name, value: ctx.fmt(field, vals[i]) }], ctx.fmt(gField, rows[i].keys[gi]));
      });
      hit.addEventListener('mouseleave', () => ctx.host.hideTooltip());
      svg.append(hit);
      ctx.root.append(svg);
    }
  },
});

/** Radial gauge with min / max / target. */
export const gauge = /* @__PURE__ */ defineVisual({
  type: 'gauge',
  displayName: 'Gauge',
  category: 'card',
  roles: [
    { name: 'value', displayName: 'Value', kind: 'measure', required: true },
    { name: 'min', displayName: 'Minimum', kind: 'measure' },
    { name: 'max', displayName: 'Maximum', kind: 'measure' },
    { name: 'target', displayName: 'Target', kind: 'measure' },
  ],
  render(ctx) {
    const get = (role: string) => {
      const i = ctx.role(role).indices[0];
      const v = i === undefined ? null : ctx.data.rows[0]?.values[i];
      return typeof v === 'number' ? v : null;
    };
    const vi = ctx.role('value').indices[0];
    if (vi === undefined) return emptyState(ctx, 'Add a value');
    const field = ctx.data.values[vi];
    const value = get('value');
    const t = ctx.theme;
    const lo = get('min') ?? 0;
    const target = get('target');
    const hi = get('max') ?? Math.max((value ?? 0) * 2, target ?? 0, 1);
    const w = ctx.width;
    const hgt = ctx.height;
    const r1 = Math.max(20, Math.min(w / 2 - 10, hgt - 34));
    const r0 = r1 * 0.72;
    const cx = w / 2;
    const cy = Math.min(hgt - 22, r1 + 14);
    const A0 = -Math.PI / 2;
    const A1 = Math.PI / 2;
    const ang = (v: number) => A0 + (A1 - A0) * Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1)));
    const svg = s('svg', { width: w, height: hgt, class: 'pbi-svg', role: 'img', 'aria-label': `${field.name} gauge` });
    const color = ctx.format.colors.default ?? t.dataColors[0];
    svg.append(s('path', { d: arcPath(cx, cy, r0, r1, A0, A1), fill: t.gridline }));
    if (value !== null) svg.append(s('path', { d: arcPath(cx, cy, r0, r1, A0, Math.max(A0 + 0.001, ang(value))), fill: color }));
    if (target !== null) {
      const a = ang(target);
      svg.append(s('line', { x1: cx + (r0 - 6) * Math.sin(a), y1: cy - (r0 - 6) * Math.cos(a), x2: cx + (r1 + 6) * Math.sin(a), y2: cy - (r1 + 6) * Math.cos(a), stroke: t.foreground, 'stroke-width': 2 }));
    }
    const fs = Math.max(14, Math.min(t.calloutFontSize * 0.8, r0 * 0.5));
    svg.append(s('text', { x: cx, y: cy - 4, 'text-anchor': 'middle', fill: t.foreground, 'font-size': fs, 'font-weight': 600 }, ctx.fmt(field, value, { displayUnits: 'auto' })));
    const lf = t.labelFontSize;
    svg.append(s('text', { x: cx - (r0 + r1) / 2, y: cy + lf + 4, 'text-anchor': 'middle', class: 'pbi-tick', fill: t.foregroundMuted }, ctx.fmt(field, lo, { displayUnits: 'auto' })));
    svg.append(s('text', { x: cx + (r0 + r1) / 2, y: cy + lf + 4, 'text-anchor': 'middle', class: 'pbi-tick', fill: t.foregroundMuted }, ctx.fmt(field, hi, { displayUnits: 'auto' })));
    if (target !== null) {
      const label = `Target ${ctx.fmt(field, target, { displayUnits: 'auto' })}`;
      svg.append(s('text', { x: cx, y: Math.min(hgt - 2, cy + lf + 18), 'text-anchor': 'middle', class: 'pbi-tick', fill: t.foregroundSecondary }, label));
      void measureText;
    }
    ctx.root.replaceChildren(svg);
  },
});
