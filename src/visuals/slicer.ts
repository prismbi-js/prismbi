import { h } from '../render/svg';
import type { CellValue } from '../data/types';
import { compareValues, parseColumnRef, valueKey } from '../data/types';
import type { ColumnFilterSpec } from '../data/filters';
import { formatValue } from '../format/format';
import { defineVisual } from './registry';
import { emptyState } from './common';
import type { RenderContext } from './types';

export type SlicerStyle = 'list' | 'dropdown' | 'tiles' | 'between' | 'relative' | 'slider';

export interface SlicerFormat {
  style?: SlicerStyle;
  /** Single-select mode (radio behaviour). */
  single?: boolean;
  search?: boolean;
  selectAll?: boolean;
  /** Tiles orientation. */
  orientation?: 'horizontal' | 'vertical';
  placeholder?: string;
  /** Initial relative-date setting. */
  relative?: { anchor?: 'last' | 'next' | 'this'; n?: number; unit?: 'days' | 'weeks' | 'months' | 'years'; includeToday?: boolean };
  /** Slicers sharing a sync group (on any page) share one selection. */
  syncGroup?: string;
}

let uidSeq = 0;

function currentValues(ctx: RenderContext): CellValue[] | null {
  const f = ctx.host.currentFilter?.[0] as ColumnFilterSpec | undefined;
  if (!f) return null;
  if (f.op === 'in') return f.values ?? [];
  if (f.op === 'eq') return [f.value ?? null];
  return null;
}

function label(ctx: RenderContext, v: CellValue): string {
  const field = ctx.data.groups[0];
  return v === null ? '(Blank)' : ctx.fmt(field, v);
}

function emitSelection(ctx: RenderContext, target: string, values: CellValue[] | null): void {
  ctx.host.setFilter(values === null ? null : [{ target, op: 'in', values }]);
}

function renderList(ctx: RenderContext, target: string, domain: CellValue[], fmt: SlicerFormat, container: HTMLElement, compact = false): void {
  const selected = currentValues(ctx);
  const selKeys = new Set(selected?.map(valueKey));
  const state = ctx.host.state as { _search?: string };
  const id = `pbi-sl-${++uidSeq}`;
  const wrap = h('div', { class: `pbi-slicer-list${compact ? ' is-compact' : ''}`, role: 'listbox', 'aria-multiselectable': String(!fmt.single), id });
  if (fmt.search !== false && domain.length > 7) {
    const input = h('input', { type: 'search', class: 'pbi-slicer-search', placeholder: 'Search', 'aria-label': 'Search values', value: state._search ?? '' }) as HTMLInputElement;
    input.addEventListener('input', () => {
      (ctx.host.state as { _search?: string })._search = input.value;
      const q = input.value.toLowerCase();
      for (const row of wrap.querySelectorAll<HTMLElement>('[data-label]')) row.hidden = !!q && !row.dataset.label!.toLowerCase().includes(q);
    });
    container.append(input);
  }
  if (fmt.selectAll !== false && !fmt.single) {
    const all = selected === null;
    const row = h('label', { class: 'pbi-slicer-item pbi-select-all' }, h('input', { type: 'checkbox', checked: all, 'aria-label': 'Select all' }), h('span', {}, 'Select all'));
    row.querySelector('input')!.addEventListener('change', () => emitSelection(ctx, target, null));
    wrap.append(row);
  }
  for (const v of domain) {
    const text = label(ctx, v);
    const checked = selected !== null && selKeys.has(valueKey(v));
    const input = h('input', { type: fmt.single ? 'radio' : 'checkbox', name: id, checked });
    const row = h('label', { class: `pbi-slicer-item${checked ? ' is-checked' : ''}`, 'data-label': text, role: 'option', 'aria-selected': String(checked) }, input, h('span', {}, text));
    if (state._search && !text.toLowerCase().includes(state._search.toLowerCase())) row.hidden = true;
    input.addEventListener('change', (e) => {
      const multi = !fmt.single;
      if (!multi) return emitSelection(ctx, target, checked ? null : [v]);
      const next = new Set(selected?.map(valueKey) ?? []);
      const vals = new Map((selected ?? []).map((x) => [valueKey(x), x]));
      if (checked) {
        next.delete(valueKey(v));
        vals.delete(valueKey(v));
      } else {
        next.add(valueKey(v));
        vals.set(valueKey(v), v);
      }
      void e;
      emitSelection(ctx, target, vals.size ? [...vals.values()] : null);
    });
    wrap.append(row);
  }
  container.append(wrap);
}

function renderTiles(ctx: RenderContext, target: string, domain: CellValue[], fmt: SlicerFormat, container: HTMLElement): void {
  const selected = currentValues(ctx);
  const selKeys = new Set(selected?.map(valueKey));
  const wrap = h('div', { class: `pbi-slicer-tiles is-${fmt.orientation ?? 'horizontal'}`, role: 'group' });
  for (const v of domain) {
    const on = selected !== null && selKeys.has(valueKey(v));
    const b = h('button', { type: 'button', class: 'pbi-tile', 'aria-pressed': String(on) }, label(ctx, v));
    b.addEventListener('click', (e) => {
      const multi = !fmt.single && (e.ctrlKey || e.metaKey || (fmt.single === false && !!selected));
      if (!multi) return emitSelection(ctx, target, on && selected!.length === 1 ? null : [v]);
      const vals = new Map((selected ?? []).map((x) => [valueKey(x), x]));
      if (on) vals.delete(valueKey(v));
      else vals.set(valueKey(v), v);
      emitSelection(ctx, target, vals.size ? [...vals.values()] : null);
    });
    wrap.append(b);
  }
  container.append(wrap);
}

function renderDropdown(ctx: RenderContext, target: string, domain: CellValue[], fmt: SlicerFormat, container: HTMLElement): void {
  const selected = currentValues(ctx);
  const text = selected === null ? fmt.placeholder ?? 'All' : selected.length === 1 ? label(ctx, selected[0]) : `${selected.length} selected`;
  const state = ctx.host.state as { _open?: boolean };
  const btn = h('button', { type: 'button', class: 'pbi-dropdown-btn', 'aria-haspopup': 'listbox', 'aria-expanded': String(!!state._open) }, h('span', {}, text), h('i', { class: 'pbi-caret' }, '▾'));
  const wrap = h('div', { class: 'pbi-dropdown' }, btn);
  if (state._open) {
    const panel = h('div', { class: 'pbi-dropdown-panel' });
    renderList(ctx, target, domain, fmt, panel, true);
    wrap.append(panel);
    const close = (e: MouseEvent) => {
      if (!wrap.contains(e.target as Node)) {
        document.removeEventListener('mousedown', close);
        ctx.host.setState({ _open: false });
      }
    };
    setTimeout(() => document.addEventListener('mousedown', close));
  }
  btn.addEventListener('click', () => ctx.host.setState({ _open: !state._open }));
  container.append(wrap);
}

function toInputValue(v: CellValue, isDate: boolean): string {
  if (v === null) return '';
  if (isDate && v instanceof Date) return formatValue(v, 'yyyy-MM-dd');
  return String(v);
}

function renderBetween(ctx: RenderContext, target: string, domain: CellValue[], container: HTMLElement): void {
  const nonNull = domain.filter((v) => v !== null);
  if (!nonNull.length) return;
  const isDate = nonNull[0] instanceof Date;
  const sorted = [...nonNull].sort(compareValues);
  const dmin = sorted[0];
  const dmax = sorted[sorted.length - 1];
  const cur = ctx.host.currentFilter?.[0] as ColumnFilterSpec | undefined;
  const lo = cur?.op === 'between' ? cur.min ?? dmin : dmin;
  const hi = cur?.op === 'between' ? cur.max ?? dmax : dmax;
  const parse = (s: string): CellValue => {
    if (s === '') return null;
    if (isDate) {
      const [y, m, d] = s.split('-').map(Number);
      return new Date(y, m - 1, d);
    }
    return Number(s);
  };
  const type = isDate ? 'date' : 'number';
  const a = h('input', { type, class: 'pbi-range-input', value: toInputValue(lo, isDate), 'aria-label': 'From' }) as HTMLInputElement;
  const b = h('input', { type, class: 'pbi-range-input', value: toInputValue(hi, isDate), 'aria-label': 'To' }) as HTMLInputElement;
  const apply = (min: CellValue, max: CellValue) => {
    const full = compareValues(min ?? dmin, dmin) <= 0 && compareValues(max ?? dmax, dmax) >= 0;
    ctx.host.setFilter(full ? null : [{ target, op: 'between', min, max }]);
  };
  a.addEventListener('change', () => apply(parse(a.value), parse(b.value)));
  b.addEventListener('change', () => apply(parse(a.value), parse(b.value)));
  // dual-thumb slider over the domain index
  const n = sorted.length - 1;
  const idx = (v: CellValue) => Math.max(0, sorted.findIndex((x) => compareValues(x, v) >= 0));
  const r1 = h('input', { type: 'range', min: 0, max: n, value: idx(lo), class: 'pbi-range', 'aria-label': 'Minimum' }) as HTMLInputElement;
  const r2 = h('input', { type: 'range', min: 0, max: n, value: idx2(sorted, hi), class: 'pbi-range', 'aria-label': 'Maximum' }) as HTMLInputElement;
  // one visible track with the selected span highlighted between the thumbs
  const fill = h('i', { class: 'pbi-range-fill' });
  const paintFill = () => {
    const i = Math.min(Number(r1.value), Number(r2.value));
    const j = Math.max(Number(r1.value), Number(r2.value));
    fill.style.left = `${n ? (i / n) * 100 : 0}%`;
    fill.style.width = `${n ? ((j - i) / n) * 100 : 100}%`;
  };
  const sync = () => {
    let i = Number(r1.value);
    let j = Number(r2.value);
    if (i > j) [i, j] = [j, i];
    a.value = toInputValue(sorted[i], isDate);
    b.value = toInputValue(sorted[j], isDate);
    paintFill();
  };
  paintFill();
  r1.addEventListener('input', sync);
  r2.addEventListener('input', sync);
  const commit = () => apply(parse(a.value), parse(b.value));
  r1.addEventListener('change', commit);
  r2.addEventListener('change', commit);
  container.append(h('div', { class: 'pbi-between' }, h('div', { class: 'pbi-between-inputs' }, a, h('span', { class: 'pbi-between-sep' }, '–'), b), h('div', { class: 'pbi-dual-range' }, h('div', { class: 'pbi-range-track' }, fill), r1, r2)));
}

/** Single-value slider (what-if parameters): emits an `eq` filter on the chosen value. */
function renderSlider(ctx: RenderContext, target: string, domain: CellValue[], container: HTMLElement): void {
  const sorted = domain.filter((v) => v !== null).sort(compareValues);
  if (!sorted.length) return;
  const field = ctx.data.groups[0];
  const cur = ctx.host.currentFilter?.[0] as ColumnFilterSpec | undefined;
  const curVal = cur?.op === 'eq' ? (cur.value ?? null) : cur?.op === 'in' && cur.values?.length === 1 ? cur.values[0] : null;
  const at = curVal === null ? -1 : sorted.findIndex((v) => compareValues(v, curVal) === 0);
  const input = h('input', { type: 'range', min: 0, max: sorted.length - 1, value: at < 0 ? Math.floor((sorted.length - 1) / 2) : at, class: 'pbi-slider', 'aria-label': field?.name ?? 'Value' }) as HTMLInputElement;
  const out = h('output', { class: 'pbi-slider-value' }, at < 0 ? 'Default' : ctx.fmt(field, sorted[at]));
  input.addEventListener('input', () => (out.textContent = ctx.fmt(field, sorted[Number(input.value)])));
  input.addEventListener('change', () => ctx.host.setFilter([{ target, op: 'eq', value: sorted[Number(input.value)] }]));
  const clear = h('button', { type: 'button', class: 'pbi-link' }, 'Reset');
  clear.addEventListener('click', () => ctx.host.setFilter(null));
  const ends = h('div', { class: 'pbi-slider-ends' }, h('span', {}, ctx.fmt(field, sorted[0])), h('span', {}, ctx.fmt(field, sorted[sorted.length - 1])));
  container.append(h('div', { class: 'pbi-slider-wrap' }, h('div', { class: 'pbi-slider-head' }, out, at < 0 ? null : clear), input, ends));
}

function idx2(sorted: CellValue[], v: CellValue): number {
  let j = sorted.length - 1;
  while (j > 0 && compareValues(sorted[j], v) > 0) j--;
  return j;
}

/** Compute the [min, max] dates for a relative-date setting. */
export function relativeRange(anchor: 'last' | 'next' | 'this', n: number, unit: 'days' | 'weeks' | 'months' | 'years', includeToday = true, today = new Date()): [Date, Date] {
  const d0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const add = (d: Date, k: number) => {
    const r = new Date(d);
    if (unit === 'days') r.setDate(r.getDate() + k);
    else if (unit === 'weeks') r.setDate(r.getDate() + 7 * k);
    else if (unit === 'months') r.setMonth(r.getMonth() + k);
    else r.setFullYear(r.getFullYear() + k);
    return r;
  };
  if (anchor === 'this') {
    if (unit === 'days') return [d0, d0];
    if (unit === 'weeks') {
      const s0 = new Date(d0);
      s0.setDate(d0.getDate() - d0.getDay());
      const e = new Date(s0);
      e.setDate(s0.getDate() + 6);
      return [s0, e];
    }
    if (unit === 'months') return [new Date(d0.getFullYear(), d0.getMonth(), 1), new Date(d0.getFullYear(), d0.getMonth() + 1, 0)];
    return [new Date(d0.getFullYear(), 0, 1), new Date(d0.getFullYear(), 11, 31)];
  }
  if (anchor === 'last') {
    const end = includeToday ? d0 : add(d0, 0);
    if (!includeToday) end.setDate(end.getDate() - 1);
    const start = add(end, -n);
    start.setDate(start.getDate() + 1);
    return [start, end];
  }
  const start = includeToday ? d0 : new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + 1);
  const end = add(start, n);
  end.setDate(end.getDate() - 1);
  return [start, end];
}

function renderRelative(ctx: RenderContext, target: string, fmt: SlicerFormat, container: HTMLElement): void {
  const st = ctx.host.state as { _rel?: { anchor: 'last' | 'next' | 'this'; n: number; unit: 'days' | 'weeks' | 'months' | 'years'; on: boolean } };
  const rel = st._rel ?? { anchor: fmt.relative?.anchor ?? 'last', n: fmt.relative?.n ?? 30, unit: fmt.relative?.unit ?? 'days', on: !!ctx.host.currentFilter };
  const anchor = h('select', { class: 'pbi-select', 'aria-label': 'Period' }) as HTMLSelectElement;
  for (const o of ['last', 'next', 'this']) anchor.append(h('option', { value: o, selected: rel.anchor === o }, o[0].toUpperCase() + o.slice(1)));
  const n = h('input', { type: 'number', min: 1, value: rel.n, class: 'pbi-range-input pbi-rel-n', 'aria-label': 'Count', disabled: rel.anchor === 'this' }) as HTMLInputElement;
  const unit = h('select', { class: 'pbi-select', 'aria-label': 'Unit' }) as HTMLSelectElement;
  for (const o of ['days', 'weeks', 'months', 'years']) unit.append(h('option', { value: o, selected: rel.unit === o }, o[0].toUpperCase() + o.slice(1)));
  const apply = (on = true) => {
    const next = { anchor: anchor.value as 'last', n: Math.max(1, Number(n.value) || 1), unit: unit.value as 'days', on };
    (ctx.host.state as Record<string, unknown>)._rel = next;
    if (!on) return ctx.host.setFilter(null);
    const [min, max] = relativeRange(next.anchor, next.n, next.unit, fmt.relative?.includeToday ?? true);
    ctx.host.setFilter([{ target, op: 'between', min, max }]);
  };
  anchor.addEventListener('change', () => apply());
  n.addEventListener('change', () => apply());
  unit.addEventListener('change', () => apply());
  const clear = h('button', { type: 'button', class: 'pbi-link' }, 'Clear');
  clear.addEventListener('click', () => apply(false));
  const cur = ctx.host.currentFilter?.[0] as ColumnFilterSpec | undefined;
  const desc = cur?.op === 'between' && cur.min instanceof Date && cur.max instanceof Date ? `${formatValue(cur.min, 'MMM d, yyyy')} – ${formatValue(cur.max, 'MMM d, yyyy')}` : 'No date filter';
  container.append(h('div', { class: 'pbi-relative' }, h('div', { class: 'pbi-relative-row' }, anchor, n, unit, clear), h('div', { class: 'pbi-relative-desc' }, desc)));
}

interface TreeNode {
  key: string;
  label: string;
  depth: number;
  path: CellValue[];
  children: TreeNode[];
  leaves: string[];
}

/** Hierarchy slicer: several fields form a tree; selections become a precise tuples filter on the full path. */
function renderHierarchy(ctx: RenderContext, targets: string[], fmt: SlicerFormat, container: HTMLElement): void {
  const tuples = ctx.host.domainTuples(targets);
  const cols = targets.map((t) => parseColumnRef(t));
  const formats = cols.map((c) => ctx.model.table(c.table).column(c.column).format);
  const keyOf = (path: CellValue[]) => JSON.stringify(path.map(valueKey));
  const root: TreeNode = { key: '[]', label: '', depth: -1, path: [], children: [], leaves: [] };
  const byKey = new Map<string, TreeNode>([[root.key, root]]);
  const leafPath = new Map<string, CellValue[]>();
  for (const tu of tuples) {
    const lk = keyOf(tu);
    leafPath.set(lk, tu);
    let parent = root;
    parent.leaves.push(lk);
    for (let d = 0; d < tu.length; d++) {
      const path = tu.slice(0, d + 1);
      const k = keyOf(path);
      let node = byKey.get(k);
      if (!node) {
        node = { key: k, label: tu[d] === null ? '(Blank)' : formatValue(tu[d], formats[d]), depth: d, path, children: [], leaves: [] };
        byKey.set(k, node);
        parent.children.push(node);
      }
      node.leaves.push(lk);
      parent = node;
    }
  }
  const cur = ctx.host.currentFilter?.[0];
  const selected = new Set<string>(cur && cur.op === 'tuples' ? cur.tuples.map(keyOf) : []);
  const st = ctx.host.state as { expanded?: string[]; _search?: string };
  const expanded = new Set(st.expanded ?? []);
  const q = (st._search ?? '').toLowerCase();

  const emit = (next: Set<string>) => {
    if (!next.size) return ctx.host.setFilter(null);
    ctx.host.setFilter([{ targets, op: 'tuples', tuples: [...next].map((k) => leafPath.get(k)!) }]);
  };
  const toggle = (node: TreeNode) => {
    const next = fmt.single ? new Set<string>() : new Set(selected);
    const all = node.leaves.every((l) => selected.has(l));
    if (all && !fmt.single) node.leaves.forEach((l) => next.delete(l));
    else if (!(fmt.single && all)) node.leaves.forEach((l) => next.add(l));
    emit(next);
  };

  if (fmt.search !== false) {
    const input = h('input', { type: 'search', class: 'pbi-slicer-search', placeholder: 'Search', 'aria-label': 'Search values', value: st._search ?? '' }) as HTMLInputElement;
    input.addEventListener('change', () => ctx.host.setState({ _search: input.value }));
    input.addEventListener('keydown', (e) => e.key === 'Enter' && ctx.host.setState({ _search: input.value }));
    container.append(input);
  }
  const list = h('div', { class: 'pbi-slicer-list pbi-tree', role: 'tree', 'aria-multiselectable': String(!fmt.single) });
  const matches = (n: TreeNode): boolean => !q || n.label.toLowerCase().includes(q) || n.children.some(matches);
  const draw = (n: TreeNode) => {
    if (!matches(n)) return;
    const hasKids = n.children.length > 0;
    const open = hasKids && (expanded.has(n.key) || !!q);
    const count = n.leaves.filter((l) => selected.has(l)).length;
    const checked = count > 0 && count === n.leaves.length;
    const input = h('input', { type: fmt.single ? 'radio' : 'checkbox', checked, 'aria-label': n.label }) as HTMLInputElement;
    input.indeterminate = count > 0 && !checked;
    input.addEventListener('change', () => toggle(n));
    const row = h('div', { class: 'pbi-slicer-item pbi-tree-item', role: 'treeitem', 'aria-expanded': hasKids ? String(open) : undefined, 'aria-selected': String(checked), style: `padding-left:${n.depth * 16}px` });
    if (hasKids) {
      const btn = h('button', { type: 'button', class: 'pbi-tree-toggle', 'aria-label': `${open ? 'Collapse' : 'Expand'} ${n.label}` }, open ? '▾' : '▸');
      btn.addEventListener('click', () => {
        const next = new Set(expanded);
        if (next.has(n.key)) next.delete(n.key);
        else next.add(n.key);
        ctx.host.setState({ expanded: [...next] });
      });
      row.append(btn);
    } else row.append(h('span', { class: 'pbi-tree-spacer' }));
    row.append(h('label', {}, input, h('span', {}, n.label)));
    list.append(row);
    if (open) n.children.forEach(draw);
  };
  root.children.forEach(draw);
  container.append(list);
}

export const slicer = /* @__PURE__ */ defineVisual({
  type: 'slicer',
  displayName: 'Slicer',
  category: 'slicer',
  isSlicer: true,
  roles: [{ name: 'field', displayName: 'Field (several fields = hierarchy)', kind: 'grouping', required: true, multiple: true }],
  defaultFormat: { header: { showAsTable: false, exportData: false, focusMode: false }, title: { show: true } },
  buildQuery(b) {
    // slicers query their domain through host.domain(); the base query only resolves field metadata
    const f = b.fields('field')[0];
    return f ? { groupBy: [typeof f === 'string' ? f : f.field!], values: [], filters: [], limit: 1 } : null;
  },
  render(ctx) {
    const all = ctx.fields('field') as (string | { field: string })[];
    const f = all[0];
    if (!f) return emptyState(ctx, 'Add a field');
    const target = typeof f === 'string' ? f : f.field;
    const fmt = (ctx.format.slicer ?? {}) as SlicerFormat;
    if (all.length > 1) {
      const tree = h('div', { class: 'pbi-slicer pbi-slicer-tree' });
      ctx.root.replaceChildren(tree);
      return renderHierarchy(ctx, all.map((x) => (typeof x === 'string' ? x : x.field)), fmt, tree);
    }
    const field = ctx.data.groups[0];
    const style: SlicerStyle = fmt.style ?? (field?.type === 'date' ? 'between' : 'list');
    const container = h('div', { class: `pbi-slicer pbi-slicer-${style}` });
    ctx.root.replaceChildren(container);
    if (style === 'relative') return renderRelative(ctx, target, fmt, container);
    const domain = ctx.host.domain(target);
    if (style === 'between') return renderBetween(ctx, target, domain, container);
    if (style === 'slider') return renderSlider(ctx, target, domain, container);
    if (style === 'tiles') return renderTiles(ctx, target, domain, fmt, container);
    if (style === 'dropdown') return renderDropdown(ctx, target, domain, fmt, container);
    renderList(ctx, target, domain, fmt, container);
  },
});
