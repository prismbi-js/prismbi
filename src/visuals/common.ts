import type { CellValue, ColumnRef } from '../data/types';
import { valueKey } from '../data/types';
import type { QueryField } from '../data/query';
import { h, s, fitText, measureText } from '../render/svg';
import type { LinearScale } from '../render/scales';
import type { DataPointIdentity, RenderContext, TooltipItem } from './types';

export interface Category {
  keys: CellValue[];
  label: string;
  identity: DataPointIdentity;
}

export interface Series {
  name: string;
  color: string;
  values: (number | null)[];
  highlights?: (number | null)[];
  /** Identity of the series itself (legend value), if any. */
  identity?: DataPointIdentity;
  field?: QueryField;
}

export interface Pivoted {
  categories: Category[];
  series: Series[];
  categoryFields: QueryField[];
  legendField?: QueryField;
  valueFields: QueryField[];
  hasHighlights: boolean;
}

function toNum(v: CellValue): number | null {
  if (v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

export function identityOf(fields: QueryField[], values: CellValue[]): DataPointIdentity {
  return { columns: fields.map((f) => f.column as ColumnRef), values };
}

export function mergeIdentity(a: DataPointIdentity, b?: DataPointIdentity): DataPointIdentity {
  if (!b) return a;
  return { columns: [...a.columns, ...b.columns], values: [...a.values, ...b.values] };
}

/** Pivot a query result into categories × series (category role + optional legend role + value role). */
export function pivot(ctx: RenderContext, categoryRole = 'category', legendRole = 'legend', valueRole = 'values', sortByTotal = false): Pivoted {
  const { data } = ctx;
  const cat = ctx.role(categoryRole);
  const leg = ctx.role(legendRole);
  const val = ctx.role(valueRole);
  const catFields = cat.indices.map((i) => data.groups[i]);
  const legendField = leg.indices.length ? data.groups[leg.indices[0]] : undefined;
  const valueFields = val.indices.map((i) => data.values[i]);
  const hasHighlights = data.rows.some((r) => r.highlights);

  const catIndex = new Map<string, number>();
  const categories: Category[] = [];
  const catKey = (keys: CellValue[]) => JSON.stringify(keys.map(valueKey));
  for (const r of data.rows) {
    const keys = cat.indices.map((i) => r.keys[i]);
    const k = catKey(keys);
    if (!catIndex.has(k)) {
      catIndex.set(k, categories.length);
      categories.push({ keys, label: keys.map((v, i) => ctx.fmt(catFields[i], v)).join(' · ') || '(Blank)', identity: identityOf(catFields, keys) });
    }
  }

  let series: Series[];
  if (legendField) {
    const li = leg.indices[0];
    const vi = val.indices[0];
    // stable series order: model order of the legend column
    const domainOrder = new Map<unknown, number>();
    ctx.model.table(legendField.column!.table).distinct(legendField.column!.column).forEach((v, i) => domainOrder.set(valueKey(v), i));
    const seriesMap = new Map<unknown, Series>();
    for (const r of data.rows) {
      const lv = r.keys[li];
      const k = valueKey(lv);
      let ser = seriesMap.get(k);
      if (!ser) {
        ser = {
          name: ctx.fmt(legendField, lv) || '(Blank)',
          color: ctx.colorFor(legendField, lv),
          values: new Array(categories.length).fill(null),
          highlights: hasHighlights ? new Array(categories.length).fill(null) : undefined,
          identity: identityOf([legendField], [lv]),
          field: valueFields[0],
        };
        seriesMap.set(k, ser);
      }
      const ci = catIndex.get(catKey(cat.indices.map((i) => r.keys[i])))!;
      ser.values[ci] = toNum(r.values[vi]);
      if (ser.highlights) ser.highlights[ci] = toNum(r.highlights?.[vi] ?? null);
    }
    series = [...seriesMap.entries()].sort((a, b) => (domainOrder.get(a[0]) ?? 0) - (domainOrder.get(b[0]) ?? 0)).map((e) => e[1]);
  } else {
    series = val.indices.map((vi, si) => ({
      name: data.values[vi].name,
      color: ctx.seriesColor(data.values[vi].name, si),
      values: categories.map(() => null as number | null),
      highlights: hasHighlights ? categories.map(() => null as number | null) : undefined,
      field: data.values[vi],
    }));
    for (const r of data.rows) {
      const ci = catIndex.get(catKey(cat.indices.map((i) => r.keys[i])))!;
      val.indices.forEach((vi, si) => {
        series[si].values[ci] = toNum(r.values[vi]);
        if (series[si].highlights) series[si].highlights![ci] = toNum(r.highlights?.[vi] ?? null);
      });
    }
  }

  if (sortByTotal && legendField && !ctx.spec.sort) {
    const totals = categories.map((_, ci) => series.reduce((a, se) => a + (se.values[ci] ?? 0), 0));
    const order = categories.map((_, i) => i).sort((a, b) => totals[b] - totals[a]);
    const reorder = <T,>(arr: T[]) => order.map((i) => arr[i]);
    categories.splice(0, categories.length, ...reorder(categories));
    for (const se of series) {
      se.values = reorder(se.values);
      if (se.highlights) se.highlights = reorder(se.highlights);
    }
  }
  return { categories, series, categoryFields: catFields, legendField, valueFields, hasHighlights };
}

/** HTML legend; returns its element. Clicking a legend entry selects that series (when it has an identity). */
export function renderLegend(ctx: RenderContext, items: { name: string; color: string; identity?: DataPointIdentity; shape?: 'square' | 'line' | 'dot' }[]): HTMLElement | null {
  const show = ctx.format.legend.show;
  if (show === false || (show === 'auto' && items.length < 2)) return null;
  const pos = ctx.format.legend.position;
  const el = h('div', { class: `pbi-legend pbi-legend-${pos}`, role: 'list' });
  for (const it of items) {
    const selected = it.identity ? ctx.host.isSelected(it.identity) : null;
    const item = h(
      'button',
      { class: `pbi-legend-item${selected === false ? ' is-dim' : ''}`, role: 'listitem', type: 'button', title: it.name },
      h('i', { class: `pbi-swatch pbi-swatch-${it.shape ?? 'square'}`, style: `background:${it.color}` }),
      h('span', {}, it.name),
    );
    if (ctx.format.legend.fontSize) item.style.fontSize = `${ctx.format.legend.fontSize}px`;
    if (it.identity) {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        ctx.host.select(it.identity!, { multi: e.ctrlKey || e.metaKey });
      });
    } else item.disabled = true;
    el.append(item);
  }
  return el;
}

/** Lay out root as [legend?][plot] and return the plot element with its size. */
export function withLegend(ctx: RenderContext, legend: HTMLElement | null): { plot: HTMLElement; width: number; height: number } {
  ctx.root.replaceChildren();
  const pos = ctx.format.legend.position;
  const wrap = h('div', { class: `pbi-chart pbi-chart-legend-${legend ? pos : 'none'}` });
  const plot = h('div', { class: 'pbi-plot' });
  if (legend && (pos === 'top' || pos === 'left')) wrap.append(legend, plot);
  else if (legend) wrap.append(plot, legend);
  else wrap.append(plot);
  ctx.root.append(wrap);
  let width = ctx.width;
  let height = ctx.height;
  if (legend) {
    if (pos === 'top' || pos === 'bottom') height -= Math.max(legend.offsetHeight || 0, 22) + 6;
    else width -= Math.min(Math.max(legend.offsetWidth || 0, 90), ctx.width * 0.4) + 8;
  }
  return { plot, width: Math.max(40, width), height: Math.max(40, height) };
}

export function emptyState(ctx: RenderContext, message = 'No data for the current filters'): void {
  ctx.root.replaceChildren(h('div', { class: 'pbi-empty' }, message));
}

/** Opacity for a mark given selection / highlight state. */
export function markOpacity(ctx: RenderContext, identity: DataPointIdentity): number {
  const sel = ctx.host.isSelected(identity);
  return sel === false ? 0.3 : 1;
}

export function valueAxisFormatter(ctx: RenderContext, field: QueryField | undefined, scale: LinearScale): (v: number) => string {
  const ref = Math.max(Math.abs(scale.domain[0]), Math.abs(scale.domain[1]));
  const va = ctx.format.valueAxis;
  return (v) => ctx.fmt(field, v, { displayUnits: va.displayUnits, autoReference: ref, decimals: va.decimals, ...(va.format ? {} : {}) });
}

export function labelFormatter(ctx: RenderContext, field: QueryField | undefined): (v: number | null) => string {
  const dl = ctx.format.dataLabels;
  return (v) => (v === null ? '' : ctx.fmt(dl.format ? { ...(field ?? { name: '', ref: '', kind: 'value' }), format: dl.format } : field, v, { displayUnits: dl.displayUnits, decimals: dl.decimals }));
}

/** Draw horizontal value gridlines + tick labels on the left (vertical charts). */
export function drawValueAxisY(ctx: RenderContext, g: SVGGElement, scale: LinearScale, x0: number, x1: number, fmt: (v: number) => string): void {
  const va = ctx.format.valueAxis;
  const t = ctx.theme;
  for (const tick of scale.ticks) {
    const y = Math.round(scale(tick)) + 0.5;
    if (va.gridlines || tick === 0) g.append(s('line', { x1: x0, x2: x1, y1: y, y2: y, stroke: tick === 0 ? t.axis : t.gridline, 'stroke-width': 1, class: tick === 0 ? 'pbi-baseline' : 'pbi-grid' }));
    if (va.show) g.append(s('text', { x: x0 - 6, y: y + 4, 'text-anchor': 'end', class: 'pbi-tick', fill: t.foregroundMuted }, fmt(tick)));
  }
}

/** Draw vertical gridlines + tick labels at the bottom (horizontal bar charts). */
export function drawValueAxisX(ctx: RenderContext, g: SVGGElement, scale: LinearScale, y0: number, y1: number, fmt: (v: number) => string): void {
  const va = ctx.format.valueAxis;
  const t = ctx.theme;
  for (const tick of scale.ticks) {
    const x = Math.round(scale(tick)) + 0.5;
    if (va.gridlines || tick === 0) g.append(s('line', { x1: x, x2: x, y1: y0, y2: y1, stroke: tick === 0 ? t.axis : t.gridline, 'stroke-width': 1 }));
    if (va.show) g.append(s('text', { x, y: y1 + 14, 'text-anchor': 'middle', class: 'pbi-tick', fill: t.foregroundMuted }, fmt(tick)));
  }
}

/** Space needed for value-axis labels on the left. */
export function yAxisWidth(ctx: RenderContext, scale: LinearScale, fmt: (v: number) => string): number {
  if (!ctx.format.valueAxis.show) return 8;
  const fs = ctx.theme.labelFontSize;
  return Math.ceil(Math.max(...scale.ticks.map((t) => measureText(fmt(t), fs, ctx.theme.fontFamily)))) + 12;
}

/** Category labels under a band/point scale with auto rotate / thin / truncate. Returns height used. */
export function categoryLabelLayout(ctx: RenderContext, labels: string[], step: number): { angle: 0 | 45 | 90; height: number; every: number; maxWidth: number } {
  const fs = ctx.theme.labelFontSize;
  const ca = ctx.format.categoryAxis;
  if (!ca.show) return { angle: 0, height: 4, every: 1, maxWidth: 0 };
  const widths = labels.map((l) => measureText(l, fs, ctx.theme.fontFamily));
  const maxW = Math.min(Math.max(0, ...widths), ca.maxLabelWidth);
  const st = Math.max(1, step);
  let angle: 0 | 45 | 90 = ca.labelAngle === 'auto' ? 0 : ca.labelAngle;
  if (ca.labelAngle === 'auto' && maxW + 8 > st) angle = 45;
  // thin labels when even rotated text would collide
  const every = angle === 0 ? Math.max(1, Math.ceil((maxW + 8) / st)) : Math.max(1, Math.ceil((fs * 1.4) / st));
  const height = angle === 0 ? fs + 10 : angle === 45 ? maxW * 0.72 + fs + 6 : maxW + 10;
  return { angle, height, every, maxWidth: angle === 0 ? Math.max(st * every - 6, 24) : ca.maxLabelWidth };
}

export function drawCategoryLabels(ctx: RenderContext, g: SVGGElement, labels: string[], xAt: (i: number) => number, y: number, layout: ReturnType<typeof categoryLabelLayout>): void {
  if (!ctx.format.categoryAxis.show) return;
  const fs = ctx.theme.labelFontSize;
  labels.forEach((l, i) => {
    if (i % layout.every !== 0) return;
    const text = fitText(l, layout.maxWidth, fs, ctx.theme.fontFamily);
    const x = xAt(i);
    if (layout.angle === 0) g.append(s('text', { x, y: y + fs + 2, 'text-anchor': 'middle', class: 'pbi-tick pbi-cat', fill: ctx.theme.foregroundSecondary }, text));
    else
      g.append(
        s('text', { x, y: y + 6, 'text-anchor': 'end', transform: `rotate(-${layout.angle} ${x} ${y + 6})`, class: 'pbi-tick pbi-cat', fill: ctx.theme.foregroundSecondary, 'dominant-baseline': 'middle' }, text),
      );
  });
}

export function tooltipItems(ctx: RenderContext, cat: Category, series: Series[], ci: number, only?: number): TooltipItem[] {
  const items: TooltipItem[] = [];
  series.forEach((se, si) => {
    if (only !== undefined && si !== only) return;
    const v = se.values[ci];
    items.push({ label: se.name, value: ctx.fmt(se.field, v, { blank: '(Blank)' }), color: se.color });
    if (se.highlights && se.highlights[ci] !== null && se.highlights[ci] !== v) items.push({ label: `${se.name} (selected)`, value: ctx.fmt(se.field, se.highlights[ci]) });
  });
  void cat;
  return items;
}

/** Wire click (select) + hover (tooltip) on a mark. */
export function interactive(ctx: RenderContext, el: Element, identity: DataPointIdentity, tooltip: () => { title?: string; items: TooltipItem[] }, keys: CellValue[]): void {
  el.classList.add('pbi-mark');
  el.setAttribute('tabindex', '0');
  // stable identity across renders: animated transitions tween the same data point
  el.setAttribute('data-key', JSON.stringify([identity.columns.map((c) => `${c.table}[${c.column}]`), identity.values.map((v) => (v instanceof Date ? v.getTime() : v))]));
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    const me = e as MouseEvent;
    ctx.host.select(identity, { multi: me.ctrlKey || me.metaKey });
    ctx.host.emit('dataPointClick', { keys, identity, event: me });
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    ctx.host.contextMenu(e as MouseEvent, identity);
  });
  el.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    if (ctx.host.drill.levels > 1 && ctx.host.drill.level < ctx.host.drill.levels - 1) ctx.host.drillDown(keys[keys.length - 1]);
  });
  el.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter' || ke.key === ' ') {
      ke.preventDefault();
      ke.stopPropagation();
      ctx.host.select(identity, { multi: ke.ctrlKey || ke.metaKey });
      return;
    }
    if (ke.key === 'ContextMenu' || (ke.key === 'F10' && ke.shiftKey)) {
      ke.preventDefault();
      const r = el.getBoundingClientRect();
      ctx.host.contextMenu(new MouseEvent('contextmenu', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }), identity);
      return;
    }
    // arrow keys walk the data points of this visual (roving tabindex)
    const marks = [...ctx.root.querySelectorAll<HTMLElement | SVGElement>('.pbi-mark')];
    const at = marks.indexOf(el as HTMLElement);
    const step = ke.key === 'ArrowRight' || ke.key === 'ArrowDown' ? 1 : ke.key === 'ArrowLeft' || ke.key === 'ArrowUp' ? -1 : 0;
    const to = step ? Math.max(0, Math.min(marks.length - 1, at + step)) : ke.key === 'Home' ? 0 : ke.key === 'End' ? marks.length - 1 : -1;
    if (to < 0 || at < 0) return;
    ke.preventDefault();
    marks[to].focus();
  });
  el.addEventListener('focus', () => {
    const marks = [...ctx.root.querySelectorAll<HTMLElement | SVGElement>('.pbi-mark')];
    marks.forEach((m) => m.setAttribute('tabindex', m === el ? '0' : '-1'));
    ctx.host.markFocused?.(marks.indexOf(el as HTMLElement));
  });
  if (ctx.format.tooltip.show) {
    el.addEventListener('mousemove', (e) => {
      const t = tooltip();
      ctx.host.showTooltip(e as MouseEvent, t.items, t.title, identity);
    });
    el.addEventListener('mouseleave', () => ctx.host.hideTooltip());
    el.addEventListener('focus', () => {
      const r = el.getBoundingClientRect();
      const t = tooltip();
      ctx.host.showTooltip({ clientX: r.right, clientY: r.top }, t.items, t.title, identity);
    });
    el.addEventListener('blur', () => ctx.host.hideTooltip());
  }
}

/** Grow-in animation via CSS (respects prefers-reduced-motion in the stylesheet). */
export function animateIn(ctx: RenderContext, el: SVGElement | HTMLElement, origin: string): void {
  if (!ctx.animate || !ctx.format.animation.enabled) return;
  el.style.transformOrigin = origin;
  el.style.transformBox = 'fill-box';
  el.classList.add(origin === 'left' || origin === 'right' ? 'pbi-grow-x' : origin === 'center' ? 'pbi-pop' : 'pbi-grow');
  el.style.animationDuration = `${ctx.format.animation.duration}ms`;
}
