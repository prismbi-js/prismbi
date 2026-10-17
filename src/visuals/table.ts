import { h } from '../render/svg';
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

export interface ConditionalFormat {
  dataBars?: boolean | { color?: string; negativeColor?: string };
  /** Colour scale on cell background: `true` uses the theme sequential ramp. */
  background?: boolean | { min?: string; mid?: string; max?: string };
  rules?: ConditionalRule[];
  /** ▲ ▼ ● icons by sign. */
  icons?: boolean;
}

interface TableFormat {
  totals?: boolean;
  rowBanding?: boolean;
  wrap?: boolean;
  density?: 'compact' | 'normal' | 'comfortable';
  conditional?: Record<string, ConditionalFormat>;
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

/** Apply conditional formatting to a value cell. */
export function decorateCell(ctx: RenderContext, td: HTMLElement, cf: ConditionalFormat | undefined, v: CellValue, stats: { min: number; max: number }, text: string): void {
  const span = h('span', { class: 'pbi-cell-text' }, text);
  if (!cf || typeof v !== 'number') {
    td.append(span);
    return;
  }
  const t = ctx.theme;
  if (cf.background) {
    const stops = typeof cf.background === 'object' ? [cf.background.min ?? t.sequential[0], ...(cf.background.mid ? [cf.background.mid] : []), cf.background.max ?? t.sequential[t.sequential.length - 2]] : [t.sequential[0], t.sequential[Math.floor(t.sequential.length * 0.7)]];
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
    const color = (typeof cf.dataBars === 'object' && cf.dataBars.color) || ctx.format.colors.default || t.dataColors[0];
    const neg = (typeof cf.dataBars === 'object' && cf.dataBars.negativeColor) || t.bad;
    const span0 = Math.max(Math.abs(stats.min), Math.abs(stats.max)) || 1;
    const pct = (Math.abs(v) / span0) * 100;
    td.classList.add('pbi-databar-cell');
    td.append(h('i', { class: 'pbi-databar', style: `width:${pct.toFixed(1)}%;background:${v < 0 ? neg : color}` }));
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
        const text = ctx.fmt(c.field, v);
        if (c.kind === 'value') decorateCell(ctx, td, tf.conditional?.[c.field.name] ?? tf.conditional?.[c.field.ref], v, stats[ci], text);
        else td.textContent = text;
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
      // windowing: spacer rows stand in for everything outside the viewport
      let rowH = 0;
      const spacer = (height: number) => {
        const tr = h('tr', { class: 'pbi-spacer', 'aria-hidden': 'true' });
        const td = h('td', { colspan: cols.length });
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
        const last = Math.min(rows.length, first + Math.ceil(view / est) + OVERSCAN * 2);
        if (`${first}:${last}` === range) return;
        range = `${first}:${last}`;
        const els: HTMLElement[] = [];
        if (first > 0) els.push(spacer(first * est));
        for (let ri = first; ri < last; ri++) els.push(rowEl(ri));
        if (last < rows.length) els.push(spacer((rows.length - last) * est));
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
      ctx.root.replaceChildren(scroller);
      // measure real row heights once attached
      raf(() => {
        range = '';
        update();
      });
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

interface MatrixFormat {
  subtotals?: boolean;
  columnTotals?: boolean;
  expandAll?: boolean;
  stepped?: boolean;
  conditional?: Record<string, ConditionalFormat>;
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
    const keyOf = (path: CellValue[], col?: CellValue) => JSON.stringify([...path.map(valueKey), col === undefined ? '__total__' : valueKey(col)]);
    const childrenOf = new Map<string, CellValue[][]>();
    for (let lvl = 0; lvl <= rowFields.length; lvl++) {
      const m: LevelData = new Map();
      const groupRefs = rowFields.slice(0, lvl).map((f) => f.ref);
      const run = (withCol: boolean) => {
        const q = model.query({ groupBy: withCol && colField ? [...groupRefs, colField.ref] : groupRefs, values: valueSpecs, filters });
        for (const r of q.rows) {
          const path = r.keys.slice(0, lvl);
          m.set(keyOf(path, withCol && colField ? r.keys[lvl] : undefined), r.values);
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
    if (colField) {
      const tr = h('tr');
      tr.append(h('th', { rowspan: valuePerCol > 1 ? 2 : 1, scope: 'col' }, rowFields.map((f) => f.name).join(' / ') || ''));
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
      tr.append(h('th', { scope: 'col' }, rowFields.map((f) => f.name).join(' / ')));
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
      const emit = (vals: CellValue[] | undefined) =>
        valueFields.forEach((vf, i) => {
          const td = h('td', { class: 'is-num' });
          const v = vals?.[i] ?? null;
          decorateCell(ctx, td, lvl === rowFields.length ? mf.conditional?.[vf.name] : undefined, v, stats[i], ctx.fmt(vf, v));
          tr.append(td);
        });
      if (colField) {
        for (const ck of colKeys) emit(m.get(keyOf(path, ck)));
        if (mf.columnTotals !== false) emit(m.get(keyOf(path)));
      } else emit(m.get(keyOf(path)));
    };

    const addRows = (lvl: number, parent: CellValue[]) => {
      const kids = lvl === 0 ? [[]] : childrenOf.get(JSON.stringify(parent.map(valueKey))) ?? [];
      if (lvl === 0) {
        (childrenOf.get(JSON.stringify([])) ?? []).forEach((p) => addRow(1, p));
        return;
      }
      kids.forEach((p) => addRow(lvl + 1, p));
    };
    const addRow = (lvl: number, path: CellValue[]) => {
      const pk = JSON.stringify(path.map(valueKey));
      const hasKids = lvl < rowFields.length;
      const open = hasKids && isExpanded(pk);
      const tr = h('tr', { class: `pbi-level-${lvl}${hasKids ? ' has-children' : ''}` });
      const label = ctx.fmt(rowFields[lvl - 1], path[path.length - 1]) || '(Blank)';
      const th = h('th', { scope: 'row', style: `padding-left:${8 + (lvl - 1) * 16}px` });
      if (hasKids) {
        const btn = h('button', { class: 'pbi-expander', type: 'button', 'aria-expanded': String(open), 'aria-label': `${open ? 'Collapse' : 'Expand'} ${label}` }, open ? '−' : '+');
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const next = new Set(expanded);
          const k = mf.expandAll ? `!${pk}` : pk;
          if (next.has(k)) next.delete(k);
          else next.add(k);
          ctx.host.setState({ expanded: [...next] });
        });
        th.append(btn);
      }
      th.append(h('span', {}, label));
      tr.append(th);
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
      tbody.append(tr);
      if (open) (childrenOf.get(pk) ?? []).forEach((p) => addRow(lvl + 1, p));
      else if (!hasKids) void 0;
    };
    if (rowFields.length) addRows(0, []);
    tableEl.append(tbody);
    const tfoot = h('tfoot');
    const tr = h('tr');
    tr.append(h('th', { scope: 'row' }, 'Total'));
    cells(tr, 0, []);
    tfoot.append(tr);
    tableEl.append(tfoot);
    ctx.root.replaceChildren(h('div', { class: 'pbi-table-scroll' }, tableEl));
  },
});
