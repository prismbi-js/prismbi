import { h, s } from '../render/svg';
import { ramp, textOn } from '../render/color';
import type { CellValue } from '../data/types';
import { compareValues, isColumnRefString, valueKey } from '../data/types';
import type { FieldSpec, QueryField, QueryRow } from '../data/query';
import { defineVisual } from './registry';
import { emptyState, identityOf } from './common';
import type { RenderContext } from './types';

export interface ConditionalRule {
  op: '>' | '>=' | '<' | '<=' | '=' | '<>' | 'between';
  value: number;
  value2?: number;
  color?: string;
  background?: string;
  icon?: string;
}

export interface DataBarOptions {
  /** Bar fill color for positive values (default: theme accent / data color). */
  color?: string;
  /** Bar fill color for negative values (default: theme.bad). */
  negativeColor?: string;
  /** Whether to align around a zero axis when negative values exist (default: true). */
  axis?: boolean;
  /** Zero axis line color (default: theme.axis). */
  axisColor?: string;
  /** Fixed scale minimum. */
  min?: number;
  /** Fixed scale maximum. */
  max?: number;
  /** When true, hides the numeric text and only shows the visual bar. */
  barOnly?: boolean;
  /** Bar fill opacity (0–1, default 0.28). */
  opacity?: number;
}

export interface ConditionalFormat {
  dataBars?: boolean | DataBarOptions;
  /** Colour scale on cell background: `true` uses the theme sequential ramp. */
  background?: boolean | { min?: string; mid?: string; max?: string };
  rules?: ConditionalRule[];
  /** ▲ ▼ ● icons by sign. */
  icons?: boolean;
}

export interface TableFormat {
  totals?: boolean;
  rowBanding?: boolean;
  wrap?: boolean;
  density?: 'compact' | 'normal' | 'comfortable';
  conditional?: Record<string, ConditionalFormat>;
  /** In-cell sparkline configurations per measure column name. */
  sparklines?: Record<string, SparklineOptions>;
  /** Pixel width per column name. */
  columnWidths?: Record<string, number>;
  pageSize?: number;
  /** Render only the rows in view (default: automatic above 500 rows, off when wrapping). */
  virtualize?: boolean;
}

/** Row count above which tables window their rows. */
const VIRTUAL_MIN = 500;
/** Rows rendered beyond each edge of the viewport while windowing. */
const OVERSCAN = 12;
const raf = (cb: () => void): void => void (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(cb, 16));

/** Render only the rows in view of `scroller`: spacer rows stand in for everything outside the viewport. */
function windowRows(scroller: HTMLElement, tbody: HTMLElement, count: number, colspan: number, rowEl: (i: number) => HTMLElement): void {
  let rowH = 0;
  const spacer = (height: number) => {
    const tr = h('tr', { class: 'pbi-spacer', 'aria-hidden': 'true' });
    const td = h('td', { colspan });
    td.style.height = `${height}px`;
    tr.append(td);
    return tr;
  };
  let range = '';
  const update = () => {
    const est = rowH || 28;
    const view = scroller.clientHeight || est * 40;
    let first = Math.max(0, Math.floor(scroller.scrollTop / est) - OVERSCAN);
    // keep zebra banding stable: with a top spacer the first data row must have an odd index
    if (first > 0 && first % 2 === 0) first--;
    const last = Math.min(count, first + Math.ceil(view / est) + OVERSCAN * 2);
    if (`${first}:${last}` === range) return;
    range = `${first}:${last}`;
    const els: HTMLElement[] = [];
    if (first > 0) els.push(spacer(first * est));
    for (let ri = first; ri < last; ri++) els.push(rowEl(ri));
    if (last < count) els.push(spacer((count - last) * est));
    tbody.replaceChildren(...els);
    if (!rowH) {
      const measured = (els.find((e) => !e.classList.contains('pbi-spacer')) as HTMLElement | undefined)?.offsetHeight ?? 0;
      if (measured) {
        rowH = measured;
        range = '';
        update();
      }
    }
  };
  update();
  let pending = false;
  scroller.addEventListener('scroll', () => {
    if (pending) return;
    pending = true;
    raf(() => {
      pending = false;
      update();
    });
  });
  // measure real row heights once attached
  raf(() => {
    range = '';
    update();
  });
}

function isGroupField(f: FieldSpec): boolean {
  if (typeof f === 'string') return isColumnRefString(f);
  return !!f.field && isColumnRefString(f.field) && !f.aggregation && !f.expression;
}

function ruleMatch(r: ConditionalRule, v: number): boolean {
  switch (r.op) {
    case '>':
      return v > r.value;
    case '>=':
      return v >= r.value;
    case '<':
      return v < r.value;
    case '<=':
      return v <= r.value;
    case '=':
      return v === r.value;
    case '<>':
      return v !== r.value;
    case 'between':
      return v >= r.value && v <= (r.value2 ?? r.value);
  }
}

export interface SparklineOptions {
  type?: 'line' | 'column' | 'area' | 'winloss';
  color?: string;
  negativeColor?: string;
  width?: number;
  height?: number;
  /** Whether to draw dots/markers: true for all points, 'endpoints' for first & last, 'minmax' for extremes. */
  markers?: boolean | 'endpoints' | 'minmax';
  /** Marker dot radius in pixels (default 2). */
  dotRadius?: number;
  /** Area fill opacity (0–1, default 0.18 for type: 'area'). */
  areaOpacity?: number;
  /** Explicit numeric values or historical trend series. */
  values?: number[];
}

function renderMarkers(
  svg: SVGSVGElement,
  values: number[],
  pts: [number, number][],
  opts: SparklineOptions,
  color: string,
  negColor: string,
  dotR: number
): void {
  if (!opts.markers || !values.length) return;
  const n = values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const minIdx = values.indexOf(min);
  const maxIdx = values.lastIndexOf(max);

  pts.forEach(([cx, cy], i) => {
    let show = false;
    let dotColor = color;
    if (opts.markers === true) {
      show = true;
    } else if (opts.markers === 'endpoints') {
      show = i === 0 || i === n - 1;
    } else if (opts.markers === 'minmax') {
      if (i === maxIdx) {
        show = true;
        dotColor = color;
      } else if (i === minIdx) {
        show = true;
        dotColor = negColor;
      }
    }
    if (show) {
      svg.append(s('circle', {
        cx: cx.toFixed(1),
        cy: cy.toFixed(1),
        r: String(dotR),
        fill: dotColor,
        class: 'pbi-sparkline-dot',
      }));
    }
  });
}

export function renderSparkline(values: number[], opts: SparklineOptions = {}): SVGSVGElement {
  const w = opts.width ?? 60;
  const h = opts.height ?? 16;
  const color = opts.color ?? 'currentColor';
  const negColor = opts.negativeColor ?? '#e74c3c';
  const dotR = opts.dotRadius ?? 2;
  const pad = 2;

  const svg = s('svg', {
    width: w,
    height: h,
    class: `pbi-sparkline pbi-sparkline-${opts.type ?? 'line'}`,
    role: 'img',
  });

  if (!values.length) return svg;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const scaleY = (v: number) => h - pad - ((v - min) / span) * (h - pad * 2);
  const scaleX = (i: number) => pad + (i / Math.max(1, values.length - 1)) * (w - pad * 2);

  if (opts.type === 'column') {
    const colW = Math.max(1.5, (w - pad * 2) / values.length - 1);
    const zeroY = min < 0 && max > 0 ? scaleY(0) : min >= 0 ? h - pad : pad;
    values.forEach((v, i) => {
      const y = scaleY(v);
      const isNeg = v < 0;
      const top = Math.min(y, zeroY);
      const barH = Math.max(1, Math.abs(y - zeroY));
      svg.append(s('rect', {
        x: scaleX(i) - colW / 2,
        y: top,
        width: colW,
        height: barH,
        fill: isNeg ? negColor : color,
      }));
    });
  } else if (opts.type === 'winloss') {
    const colW = Math.max(1.5, (w - pad * 2) / values.length - 1);
    const midY = h / 2;
    const barH = Math.max(1, (h - pad * 2) / 2 - 1);
    values.forEach((v, i) => {
      const isWin = v > 0;
      const isLoss = v < 0;
      const x = scaleX(i) - colW / 2;
      if (isWin) {
        svg.append(s('rect', { x, y: pad, width: colW, height: barH, fill: color }));
      } else if (isLoss) {
        svg.append(s('rect', { x, y: midY + 1, width: colW, height: barH, fill: negColor }));
      } else {
        svg.append(s('rect', { x, y: midY - 0.5, width: colW, height: 1, fill: color, opacity: '0.4' }));
      }
    });
  } else if (opts.type === 'area') {
    const pts: [number, number][] = values.map((v, i) => [scaleX(i), scaleY(v)]);
    const baselineY = min < 0 && max > 0 ? scaleY(0) : h - pad;
    const pathD = `M ${pts[0][0]},${baselineY} ` +
      pts.map(([x, y]) => `L ${x.toFixed(1)},${y.toFixed(1)}`).join(' ') +
      ` L ${pts[pts.length - 1][0]},${baselineY} Z`;
    const areaOp = opts.areaOpacity ?? 0.18;
    svg.append(s('path', { d: pathD, fill: color, opacity: String(areaOp) }));

    const linePts = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    svg.append(s('polyline', {
      points: linePts,
      fill: 'none',
      stroke: color,
      'stroke-width': '1.5',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }));
    renderMarkers(svg, values, pts, opts, color, negColor, dotR);
  } else {
    const pts: [number, number][] = values.map((v, i) => [scaleX(i), scaleY(v)]);
    const linePts = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    svg.append(s('polyline', {
      points: linePts,
      fill: 'none',
      stroke: color,
      'stroke-width': '1.5',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }));
    renderMarkers(svg, values, pts, opts, color, negColor, dotR);
  }
  return svg;
}

/** Apply conditional formatting to a value cell. */
export function decorateCell(
  ctx: RenderContext,
  td: HTMLElement,
  cf: ConditionalFormat | undefined,
  v: CellValue,
  stats: { min: number; max: number },
  text: string,
  sparkline?: SparklineOptions & { values: number[] }
): void {
  const span = h('span', { class: 'pbi-cell-text' }, text);
  if (sparkline?.values.length) span.prepend(renderSparkline(sparkline.values, sparkline));
  if (!cf || typeof v !== 'number') {
    td.append(span);
    return;
  }
  const t = ctx.theme;
  if (cf.background) {
    const stops = typeof cf.background === 'object'
      ? [cf.background.min ?? t.sequential[0], ...(cf.background.mid ? [cf.background.mid] : []), cf.background.max ?? t.sequential[t.sequential.length - 2]]
      : [t.sequential[0], t.sequential[Math.floor(t.sequential.length * 0.7)]];
    const tt = stats.max === stats.min ? 1 : (v - stats.min) / (stats.max - stats.min);
    const bg = ramp(stops, tt);
    td.style.background = bg;
    td.style.color = textOn(bg, t.foreground);
  }
  for (const r of cf.rules ?? [])
    if (ruleMatch(r, v)) {
      if (r.color) td.style.color = r.color;
      if (r.background) td.style.background = r.background;
      if (r.icon) span.prepend(h('i', { class: 'pbi-cf-icon' }, r.icon + ' '));
    }
  if (cf.icons) span.prepend(h('i', { class: `pbi-cf-icon ${v > 0 ? 'is-good' : v < 0 ? 'is-bad' : 'is-flat'}` }, v > 0 ? '▲ ' : v < 0 ? '▼ ' : '● '));

  if (cf.dataBars) {
    const db = typeof cf.dataBars === 'object' ? cf.dataBars : {};
    const color = db.color || ctx.format.colors.default || t.dataColors[0];
    const neg = db.negativeColor || t.bad;
    const opacity = db.opacity ?? 0.28;
    const showAxis = db.axis !== false;
    const minVal = db.min ?? stats.min;
    const maxVal = db.max ?? stats.max;

    td.classList.add('pbi-databar-cell');

    if (showAxis && minVal < 0 && maxVal > 0) {
      // Bi-directional zero-axis alignment
      const range = maxVal - minVal;
      const zeroPct = (Math.abs(minVal) / range) * 100;

      // Axis marker
      const axisLine = h('i', {
        class: 'pbi-databar-axis',
        style: `left:${zeroPct.toFixed(1)}%;background:${db.axisColor ?? t.axis}`,
      });
      td.append(axisLine);

      if (v >= 0) {
        const wPct = Math.min(100 - zeroPct, (v / range) * 100);
        td.append(h('i', {
          class: 'pbi-databar is-positive',
          style: `left:${zeroPct.toFixed(1)}%;right:auto;width:${wPct.toFixed(1)}%;background:${color};opacity:${opacity}`,
        }));
      } else {
        const wPct = Math.min(zeroPct, (Math.abs(v) / range) * 100);
        const leftPct = zeroPct - wPct;
        td.append(h('i', {
          class: 'pbi-databar is-negative',
          style: `left:${leftPct.toFixed(1)}%;right:auto;width:${wPct.toFixed(1)}%;background:${neg};opacity:${opacity}`,
        }));
      }
    } else {
      // Unidirectional bar
      const span0 = Math.max(Math.abs(minVal), Math.abs(maxVal)) || 1;
      const pct = Math.min(100, (Math.abs(v) / span0) * 100);
      const isNeg = v < 0;
      td.append(h('i', {
        class: `pbi-databar ${isNeg ? 'is-negative' : 'is-positive'}`,
        style: `width:${pct.toFixed(1)}%;background:${isNeg ? neg : color};opacity:${opacity}`,
      }));
    }

    if (db.barOnly) {
      span.style.visibility = 'hidden';
      span.style.width = '0';
    }
  }

  td.append(span);
}

function columnStats(rows: QueryRow[], vi: number): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const r of rows) {
    const v = r.values[vi];
    if (typeof v === 'number') {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  return { min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 0 };
}

export const table = /* @__PURE__ */ defineVisual({
  type: 'table',
  displayName: 'Table',
  category: 'table',
  roles: [{ name: 'columns', displayName: 'Columns', kind: 'any', multiple: true, required: true }],
  defaultSort: 'key',
  buildQuery(b, base) {
    const fields = b.fields('columns');
    const tf = (b.spec.format?.table ?? {}) as TableFormat;
    return {
      ...base,
      groupBy: fields.filter(isGroupField).map((f) => (typeof f === 'string' ? f : f.field!)),
      values: fields.filter((f) => !isGroupField(f)),
      totals: tf.totals ?? true,
    };
  },
  render(ctx) {
    const fields = ctx.fields('columns');
    const tf = (ctx.format.table ?? {}) as TableFormat;
    const { data } = ctx;
    if (!data.rows.length) return emptyState(ctx);
    // column order follows the field well, mixing groups and values
    let gi = 0;
    let vi = 0;
    const cols = fields.map((f) => (isGroupField(f) ? { kind: 'group' as const, i: gi++, field: data.groups[gi - 1] } : { kind: 'value' as const, i: vi++, field: data.values[vi - 1] }));
    const state = ctx.host.state as { sortCol?: number; sortDir?: 'asc' | 'desc'; _shown?: number };
    let rows = data.rows.slice();
    if (state.sortCol !== undefined && cols[state.sortCol]) {
      const c = cols[state.sortCol];
      const dir = state.sortDir === 'desc' ? -1 : 1;
      rows.sort((a, b) => {
        const x = c.kind === 'group' ? a.keys[c.i] : a.values[c.i];
        const y = c.kind === 'group' ? b.keys[c.i] : b.values[c.i];
        if (x === null) return 1;
        if (y === null) return -1;
        return compareValues(x, y) * dir;
      });
    }
    const pageSize = tf.pageSize ?? 200;
    const shown = Math.min(rows.length, state._shown ?? pageSize);
    const stats = cols.map((c) => (c.kind === 'value' ? columnStats(data.rows, c.i) : { min: 0, max: 0 }));
    const groupFields = data.groups as QueryField[];

    const tableEl = h('table', { class: `pbi-table pbi-density-${tf.density ?? 'normal'}${tf.rowBanding === false ? '' : ' pbi-banded'}${tf.wrap ? ' pbi-wrap' : ''}` });
    const thead = h('thead');
    const hr = h('tr');
    cols.forEach((c, ci) => {
      const sorted = state.sortCol === ci;
      const th = h('th', { class: c.kind === 'value' ? 'is-num' : '', scope: 'col', 'aria-sort': sorted ? (state.sortDir === 'desc' ? 'descending' : 'ascending') : undefined, tabindex: 0 }, c.field.name, sorted ? h('span', { class: 'pbi-sort' }, state.sortDir === 'desc' ? ' ↓' : ' ↑') : '');
      const w = tf.columnWidths?.[c.field.name];
      if (w) th.style.width = `${w}px`;
      const toggle = () => {
        const dir = sorted && state.sortDir === 'asc' ? 'desc' : sorted && state.sortDir === 'desc' ? 'asc' : c.kind === 'value' ? 'desc' : 'asc';
        ctx.host.setState({ sortCol: ci, sortDir: dir });
      };
      th.addEventListener('click', toggle);
      th.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle()));
      hr.append(th);
    });
    thead.append(hr);
    tableEl.append(thead);

    const tbody = h('tbody');
    const rowEl = (ri: number): HTMLElement => {
      const r = rows[ri];
      const identity = groupFields.length ? identityOf(groupFields, r.keys) : null;
      const sel = identity ? ctx.host.isSelected(identity) : null;
      const tr = h('tr', { class: sel === false ? 'is-dim' : sel ? 'is-selected' : '' });
      cols.forEach((c, ci) => {
        const v = c.kind === 'group' ? r.keys[c.i] : r.values[c.i];
        const td = h('td', { class: c.kind === 'value' ? 'is-num' : '' });
        // a calculation item in this row may bring its own format (e.g. YoY % as a percentage)
        const rf = c.kind === 'value' ? r.formats?.[c.i] : undefined;
        const text = ctx.fmt(rf ? { ...c.field, format: rf } : c.field, v);
        if (c.kind === 'value') {
          const sl = tf.sparklines?.[c.field.name] ?? tf.sparklines?.[c.field.ref];
          const sparkOpts = sl && typeof v === 'number' ? { ...sl, values: sl.values ?? [v * 0.85, v * 0.95, v * 1.05, v] } : undefined;
          decorateCell(ctx, td, tf.conditional?.[c.field.name] ?? tf.conditional?.[c.field.ref], v, stats[ci], text, sparkOpts);
        } else {
          td.textContent = text;
        }
        tr.append(td);
      });
      if (identity) {
        tr.classList.add('pbi-row-select');
        tr.addEventListener('click', (e) => {
          e.stopPropagation();
          ctx.host.select(identity, { multi: e.ctrlKey || e.metaKey });
          ctx.host.emit('dataPointClick', { keys: r.keys, identity, event: e });
        });
        tr.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          ctx.host.contextMenu(e, identity);
        });
      }
      return tr;
    };
    const renderRows = (from: number, to: number) => {
      for (let ri = from; ri < to; ri++) tbody.append(rowEl(ri));
    };
    const virtual = tf.virtualize ?? (rows.length > VIRTUAL_MIN && !tf.wrap);
    if (!virtual) renderRows(0, shown);
    tableEl.append(tbody);

    if (data.totals && tf.totals !== false) {
      const tfoot = h('tfoot');
      const tr = h('tr');
      cols.forEach((c, ci) => tr.append(h('td', { class: c.kind === 'value' ? 'is-num' : '' }, c.kind === 'value' ? ctx.fmt(c.field, data.totals![c.i]) : ci === 0 ? 'Total' : '')));
      tfoot.append(tr);
      tableEl.append(tfoot);
    }
    const scroller = h('div', { class: 'pbi-table-scroll' }, tableEl);
    if (virtual) {
      windowRows(scroller, tbody, rows.length, cols.length, rowEl);
      ctx.root.replaceChildren(scroller);
      return;
    }
    // incremental rendering: append the next page when scrolled near the bottom
    let rendered = shown;
    scroller.addEventListener('scroll', () => {
      if (rendered >= rows.length) return;
      if (scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - 80) {
        const next = Math.min(rows.length, rendered + pageSize);
        renderRows(rendered, next);
        rendered = next;
      }
    });
    ctx.root.replaceChildren(scroller);
  },
});

// ----------------------------------------------------------------- matrix

export interface MatrixFormat {
  subtotals?: boolean;
  columnTotals?: boolean;
  expandAll?: boolean;
  stepped?: boolean;
  conditional?: Record<string, ConditionalFormat>;
  sparklines?: Record<string, SparklineOptions>;
  /** Render only the rows in view (default: automatic above 500 visible rows; subtotal rows count). */
  virtualize?: boolean;
}

export const matrix = /* @__PURE__ */ defineVisual({
  type: 'matrix',
  displayName: 'Matrix',
  category: 'table',
  roles: [
    { name: 'rows', displayName: 'Rows', kind: 'grouping', multiple: true },
    { name: 'columns', displayName: 'Columns', kind: 'grouping' },
    { name: 'values', displayName: 'Values', kind: 'measure', multiple: true, required: true },
  ],
  defaultSort: 'key',
  buildQuery(_b, base) {
    return { ...base, totals: true };
  },
  render(ctx) {
    const mf = (ctx.format.matrix ?? {}) as MatrixFormat;
    const rowRole = ctx.role('rows');
    const colRole = ctx.role('columns');
    const valRole = ctx.role('values');
    const { data, model } = ctx;
    if (!valRole.indices.length) return emptyState(ctx, 'Add values');
    const rowFields = rowRole.indices.map((i) => data.groups[i]);
    const colField = colRole.indices.length ? data.groups[colRole.indices[0]] : undefined;
    const valueFields = valRole.indices.map((i) => data.values[i]);
    const valueSpecs = ctx.fields('values');
    const filters = data.baseFilters as never[];
    const colKeys: CellValue[] = colField ? [...new Map(data.rows.map((r) => [valueKey(r.keys[colRole.indices[0]]), r.keys[colRole.indices[0]]])).values()] : [];
    if (colField) {
      const order = new Map<unknown, number>();
      model.table(colField.column!.table).distinct(colField.column!.column).forEach((v, i) => order.set(valueKey(v), i));
      colKeys.sort((a, b) => (order.get(valueKey(a)) ?? 0) - (order.get(valueKey(b)) ?? 0));
    }

    // query each level of the row hierarchy (subtotals are real measure evaluations, not sums)
    type LevelData = Map<string, CellValue[]>; // key: JSON(rowPath + colKey) → values
    const levelCache: LevelData[] = [];
    // calculation-item formats per cell (same keys as levelCache, across levels)
    const cellFormats = new Map<string, (string | undefined)[]>();
    const keyOf = (path: CellValue[], col?: CellValue) => JSON.stringify([...path.map(valueKey), col === undefined ? '__total__' : valueKey(col)]);
    const childrenOf = new Map<string, CellValue[][]>();
    for (let lvl = 0; lvl <= rowFields.length; lvl++) {
      const m: LevelData = new Map();
      const groupRefs = rowFields.slice(0, lvl).map((f) => f.ref);
      const run = (withCol: boolean) => {
        const q = model.query({ groupBy: withCol && colField ? [...groupRefs, colField.ref] : groupRefs, values: valueSpecs, filters });
        for (const r of q.rows) {
          const path = r.keys.slice(0, lvl);
          const ck = keyOf(path, withCol && colField ? r.keys[lvl] : undefined);
          m.set(ck, r.values);
          const fmts = r.formats ?? (q.values.some((v, k) => v.format !== valueFields[k]?.format) ? q.values.map((v) => v.format) : undefined);
          if (fmts) cellFormats.set(`${lvl}|${ck}`, fmts);
          if (!withCol && lvl > 0) {
            const parent = JSON.stringify(path.slice(0, -1).map(valueKey));
            const list = childrenOf.get(parent) ?? [];
            if (!list.some((p) => valueKey(p[p.length - 1]) === valueKey(path[path.length - 1]))) list.push(path);
            childrenOf.set(parent, list);
          }
        }
        if (!groupRefs.length && !withCol) m.set(keyOf([], undefined), q.rows[0]?.values ?? valueFields.map(() => null));
      };
      run(false);
      if (colField) run(true);
      levelCache.push(m);
    }

    const state = ctx.host.state as { expanded?: string[] };
    const expanded = new Set(state.expanded ?? []);
    const isExpanded = (pk: string) => (mf.expandAll ? !expanded.has(`!${pk}`) : expanded.has(pk));

    const tableEl = h('table', { class: 'pbi-table pbi-matrix pbi-banded' });
    const thead = h('thead');
    const valuePerCol = valueFields.length;
    const isStepped = mf.stepped !== false;
    if (colField) {
      const tr = h('tr');
      if (isStepped) tr.append(h('th', { rowspan: valuePerCol > 1 ? 2 : 1, scope: 'col' }, rowFields.map((f) => f.name).join(' / ') || ''));
      else for (const rf of rowFields) tr.append(h('th', { rowspan: valuePerCol > 1 ? 2 : 1, scope: 'col' }, rf.name));
      for (const ck of colKeys) tr.append(h('th', { colspan: valuePerCol, class: 'is-num pbi-col-group', scope: 'colgroup' }, ctx.fmt(colField, ck)));
      if (mf.columnTotals !== false) tr.append(h('th', { colspan: valuePerCol, class: 'is-num pbi-col-group', scope: 'colgroup' }, 'Total'));
      thead.append(tr);
      if (valuePerCol > 1) {
        const tr2 = h('tr');
        const groups = colKeys.length + (mf.columnTotals !== false ? 1 : 0);
        for (let i = 0; i < groups; i++) for (const vf of valueFields) tr2.append(h('th', { class: 'is-num', scope: 'col' }, vf.name));
        thead.append(tr2);
      }
    } else {
      const tr = h('tr');
      if (isStepped) tr.append(h('th', { scope: 'col' }, rowFields.map((f) => f.name).join(' / ')));
      else for (const rf of rowFields) tr.append(h('th', { scope: 'col' }, rf.name));
      for (const vf of valueFields) tr.append(h('th', { class: 'is-num', scope: 'col' }, vf.name));
      thead.append(tr);
    }
    tableEl.append(thead);
    const tbody = h('tbody');
    const stats = valueFields.map((_, i) => {
      let min = Infinity;
      let max = -Infinity;
      for (const v of levelCache[rowFields.length].values()) if (typeof v[i] === 'number') (min = Math.min(min, v[i] as number)), (max = Math.max(max, v[i] as number));
      return { min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 0 };
    });

    const cells = (tr: HTMLElement, lvl: number, path: CellValue[]) => {
      const m = levelCache[lvl];
      const emit = (key: string) => {
        const vals = m.get(key);
        const fmts = cellFormats.get(`${lvl}|${key}`);
        valueFields.forEach((vf, i) => {
          const td = h('td', { class: 'is-num' });
          const v = vals?.[i] ?? null;
          const sl = mf.sparklines?.[vf.name];
          const sparkOpts = sl && typeof v === 'number' ? { ...sl, values: sl.values ?? [v * 0.85, v * 0.95, v * 1.05, v] } : undefined;
          decorateCell(ctx, td, lvl === rowFields.length ? mf.conditional?.[vf.name] : undefined, v, stats[i], ctx.fmt(fmts?.[i] ? { ...vf, format: fmts[i] } : vf, v), sparkOpts);
          tr.append(td);
        });
      };
      if (colField) {
        for (const ck of colKeys) emit(keyOf(path, ck));
        if (mf.columnTotals !== false) emit(keyOf(path));
      } else emit(keyOf(path));
    };

    // the visible rows, depth first: a parent row (carrying its subtotals) then its children when expanded
    const visible: { lvl: number; path: CellValue[]; pk: string }[] = [];
    const walk = (lvl: number, path: CellValue[]) => {
      const pk = JSON.stringify(path.map(valueKey));
      visible.push({ lvl, path, pk });
      if (lvl < rowFields.length && isExpanded(pk)) for (const p of childrenOf.get(pk) ?? []) walk(lvl + 1, p);
    };
    if (rowFields.length) for (const p of childrenOf.get(JSON.stringify([])) ?? []) walk(1, p);
    const rowEl = (i: number): HTMLElement => {
      const { lvl, path, pk } = visible[i];
      const hasKids = lvl < rowFields.length;
      const open = hasKids && isExpanded(pk);
      const tr = h('tr', { class: `pbi-level-${lvl}${hasKids ? ' has-children' : ''}` });
      const label = ctx.fmt(rowFields[lvl - 1], path[path.length - 1]) || '(Blank)';
      const expanderBtn = hasKids
        ? (() => {
            const btn = h('button', { class: 'pbi-expander', type: 'button', 'aria-expanded': String(open), 'aria-label': `${open ? 'Collapse' : 'Expand'} ${label}` }, open ? '−' : '+');
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              const next = new Set(expanded);
              const k = mf.expandAll ? `!${pk}` : pk;
              if (next.has(k)) next.delete(k);
              else next.add(k);
              ctx.host.setState({ expanded: [...next] });
            });
            return btn;
          })()
        : null;

      if (isStepped) {
        const th = h('th', { scope: 'row', style: `padding-left:${8 + (lvl - 1) * 16}px` });
        if (expanderBtn) th.append(expanderBtn);
        th.append(h('span', {}, label));
        tr.append(th);
      } else {
        for (let j = 0; j < rowFields.length; j++) {
          if (j < lvl - 1) {
            tr.append(h('td', { class: 'pbi-indent' }));
          } else if (j === lvl - 1) {
            const th = h('th', { scope: 'row' });
            if (expanderBtn) th.append(expanderBtn);
            th.append(h('span', {}, label));
            tr.append(th);
          } else {
            tr.append(h('td', { class: 'pbi-subtotal-cell' }, 'Total'));
          }
        }
      }
      cells(tr, lvl, path);
      const identity = identityOf(rowFields.slice(0, lvl), path);
      const sel = ctx.host.isSelected(identity);
      if (sel === false) tr.classList.add('is-dim');
      tr.addEventListener('click', (e) => {
        e.stopPropagation();
        ctx.host.select(identity, { multi: e.ctrlKey || e.metaKey });
      });
      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        ctx.host.contextMenu(e, identity);
      });
      return tr;
    };
    const virtual = mf.virtualize ?? visible.length > VIRTUAL_MIN;
    if (!virtual) for (let i = 0; i < visible.length; i++) tbody.append(rowEl(i));
    tableEl.append(tbody);
    const tfoot = h('tfoot');
    const tr = h('tr');
    tr.append(h('th', { scope: 'row', colspan: isStepped ? 1 : rowFields.length }, 'Total'));
    cells(tr, 0, []);
    tfoot.append(tr);
    tableEl.append(tfoot);
    // expanding or collapsing re-renders: keep the reader where they were
    const prevTop = (ctx.root.querySelector('.pbi-table-scroll') as HTMLElement | null)?.scrollTop ?? 0;
    const scroller = h('div', { class: 'pbi-table-scroll' }, tableEl);
    const colspan = (isStepped ? 1 : rowFields.length) + valueFields.length * (colField ? colKeys.length + (mf.columnTotals !== false ? 1 : 0) : 1);
    if (virtual) windowRows(scroller, tbody, visible.length, colspan, rowEl);
    ctx.root.replaceChildren(scroller);
    if (prevTop) {
      scroller.scrollTop = prevTop;
      if (virtual) scroller.dispatchEvent(new Event('scroll'));
    }
  },
});
