import { h } from '../render/svg';
import type { CellValue } from '../data/types';
import { parseColumnRef, valueKey } from '../data/types';
import type { FieldSpec, QueryRow } from '../data/query';
import type { FilterSpec } from '../data/filters';
import { defineVisual } from './registry';
import { emptyState } from './common';
import type { RenderContext } from './types';

interface Split {
  field: string;
  /** valueKey JSON of the selected node, if any. */
  selected: string | null;
  /** The selected member itself (keeps dates as dates). */
  value?: CellValue;
  /** True when the split was chosen automatically ("High value" / "Low value"). */
  auto?: 'high' | 'low';
}

interface DecompFormat {
  /** Nodes shown per level before folding the rest (default 10). */
  maxNodes?: number;
  /** Offer "High value" / "Low value" automatic splits (default true). */
  aiSplits?: boolean;
  /** Column width in px (default 190). */
  columnWidth?: number;
}

const ref = (f: FieldSpec) => (typeof f === 'string' ? f : (f.field ?? ''));

/**
 * Decomposition tree: start from a measure total and split it level by level by any "explain by"
 * field; pick a node to keep narrowing down. "High value" / "Low value" chooses the split that
 * produces the largest / smallest member automatically.
 */
export const decompositionTree = /* @__PURE__ */ defineVisual({
  type: 'decompositionTree',
  displayName: 'Decomposition tree',
  category: 'chart',
  roles: [
    { name: 'values', displayName: 'Analyze', kind: 'measure', required: true },
    { name: 'explainBy', displayName: 'Explain by', kind: 'any', multiple: true, required: true },
  ],
  defaultFormat: { header: { showAsTable: false } },
  buildQuery(b, base) {
    return { ...base, groupBy: [], values: b.fields('values').slice(0, 1) };
  },
  render(ctx) {
    const valueSpec = ([] as FieldSpec[]).concat(ctx.spec.fields?.values ?? [])[0];
    const dims = ([] as FieldSpec[]).concat(ctx.spec.fields?.explainBy ?? []).map(ref);
    if (!valueSpec || !dims.length) return emptyState(ctx, 'Add a value to analyze and fields to explain by');
    const vField = ctx.data.values[0];
    const total = ctx.data.rows[0]?.values[0] ?? null;
    const df = (ctx.format.decomposition ?? {}) as DecompFormat;
    const maxNodes = df.maxNodes ?? 10;
    const colW = df.columnWidth ?? 190;
    const st = ctx.host.state as { splits?: Split[] };
    const splits: Split[] = st.splits ?? [];
    const base = ctx.data.baseFilters as never[];

    const query = (field: string, filters: FilterSpec[]): QueryRow[] =>
      ctx.model.query({ groupBy: [field], values: [valueSpec], filters: [...base, ...filters], orderBy: [{ field: { value: 0 }, direction: 'desc' }] }).rows.filter((r) => r.values[0] !== null);

    const pathFilters = (upto: number): FilterSpec[] => {
      const out: FilterSpec[] = [];
      for (let i = 0; i < upto; i++) {
        const sp = splits[i];
        if (!sp?.selected) break;
        out.push({ target: sp.field, op: 'eq', value: sp.value ?? null });
      }
      return out;
    };
    const nodeKey = (v: CellValue) => JSON.stringify(valueKey(v));

    const autoPick = (mode: 'high' | 'low', used: string[], filters: FilterSpec[]): string | null => {
      let best: { field: string; v: number } | null = null;
      for (const d of dims) {
        if (used.includes(d)) continue;
        const rows = query(d, filters);
        const vals = rows.map((r) => r.values[0]).filter((v): v is number => typeof v === 'number');
        if (!vals.length) continue;
        const v = mode === 'high' ? Math.max(...vals) : Math.min(...vals);
        if (!best || (mode === 'high' ? v > best.v : v < best.v)) best = { field: d, v };
      }
      return best?.field ?? null;
    };

    const setSplits = (next: Split[]) => {
      ctx.host.setState({ splits: next });
      // cross-filter the page with the selected path
      const sel = next.filter((x, i) => x.selected && next.slice(0, i).every((y) => y.selected));
      if (!sel.length) return ctx.host.select(null);
      const cols = sel.map((x) => parseColumnRef(x.field));
      ctx.host.select({ columns: cols, values: sel.map((x) => x.value ?? null) });
    };

    const wrap = h('div', { class: 'pbi-decomp', style: `--pbi-decomp-col:${colW}px` });
    // root column
    const rootCol = h('div', { class: 'pbi-decomp-col' }, h('div', { class: 'pbi-decomp-head' }, vField.name));
    rootCol.append(nodeEl(ctx, vField.name, total, total, true, () => {}));
    wrap.append(rootCol);

    let level = 0;
    for (; level < splits.length; level++) {
      const sp = splits[level];
      const lvl = level; // stable copy for the handlers below
      const filters = pathFilters(level);
      const rows = query(sp.field, filters);
      const col = h('div', { class: 'pbi-decomp-col' });
      const used = splits.slice(0, level).map((x) => x.field);
      col.append(headSelect(ctx, dims, used, sp, df.aiSplits !== false, (choice) => {
        const next = splits.slice(0, lvl);
        if (choice === '__remove__') return setSplits(next);
        const auto = choice === '__high__' ? 'high' : choice === '__low__' ? 'low' : undefined;
        const field = auto ? autoPick(auto, used, filters) : choice;
        if (field) setSplits([...next, { field, selected: null, auto }]);
      }));
      const max = Math.max(...rows.map((r) => Math.abs(r.values[0] as number)), 0);
      rows.slice(0, maxNodes).forEach((r) => {
        const key = nodeKey(r.keys[0]);
        const label = ctx.fmt({ name: '', ref: sp.field, kind: 'group', format: ctx.model.table(parseColumnRef(sp.field).table).column(parseColumnRef(sp.field).column).format }, r.keys[0]) || '(Blank)';
        const selected = sp.selected === key;
        col.append(
          nodeEl(ctx, label, r.values[0], max, selected, () => {
            const next = splits.slice(0, lvl + 1).map((x, i) => (i === lvl ? { ...x, selected: selected ? null : key, value: selected ? undefined : r.keys[0] } : x));
            setSplits(next);
          }, splits.some((x) => x.selected) && !selected),
        );
      });
      if (rows.length > maxNodes) col.append(h('div', { class: 'pbi-decomp-more' }, `+${rows.length - maxNodes} more`));
      wrap.append(col);
      if (!sp.selected || !rows.some((r) => nodeKey(r.keys[0]) === sp.selected)) {
        level++;
        break;
      }
    }
    // "+" column to add the next split (after the root, or after a selected node)
    const lastSelected = splits.length === 0 || (splits[splits.length - 1].selected && level === splits.length);
    const used = splits.map((x) => x.field);
    if (lastSelected && used.length < dims.length) {
      const filters = pathFilters(splits.length);
      const col = h('div', { class: 'pbi-decomp-col is-add' });
      col.append(headSelect(ctx, dims, used, null, df.aiSplits !== false, (choice) => {
        const auto = choice === '__high__' ? 'high' : choice === '__low__' ? 'low' : undefined;
        const field = auto ? autoPick(auto, used, filters) : choice;
        if (field && field !== '__remove__') setSplits([...splits, { field, selected: null, auto }]);
      }));
      col.append(h('div', { class: 'pbi-decomp-hint' }, splits.length ? 'Split the selected node by another field' : 'Choose a field to break the total down'));
      wrap.append(col);
    }
    ctx.root.replaceChildren(h('div', { class: 'pbi-decomp-scroll' }, wrap));
  },
});

function headSelect(ctx: RenderContext, dims: string[], used: string[], current: Split | null, ai: boolean, onChange: (v: string) => void): HTMLElement {
  const sel = h('select', { class: 'pbi-select pbi-decomp-select', 'aria-label': current ? 'Change split field' : 'Add a split' }) as HTMLSelectElement;
  if (!current) sel.append(h('option', { value: '' }, '+ Split by…'));
  if (ai) {
    sel.append(h('option', { value: '__high__' }, 'High value (auto)'));
    sel.append(h('option', { value: '__low__' }, 'Low value (auto)'));
  }
  for (const d of dims) {
    if (used.includes(d) && d !== current?.field) continue;
    const c = parseColumnRef(d);
    sel.append(h('option', { value: d, selected: current?.field === d }, c.column));
  }
  if (current) sel.append(h('option', { value: '__remove__' }, 'Remove this level'));
  sel.addEventListener('change', () => sel.value && onChange(sel.value));
  sel.addEventListener('click', (e) => e.stopPropagation());
  const wrap = h('div', { class: 'pbi-decomp-head' }, sel);
  if (current?.auto) wrap.append(h('span', { class: 'pbi-decomp-auto' }, current.auto === 'high' ? 'auto · high' : 'auto · low'));
  void ctx;
  return wrap;
}

function nodeEl(ctx: RenderContext, label: string, value: CellValue, max: CellValue, selected: boolean, onClick: () => void, dim = false): HTMLElement {
  const v = typeof value === 'number' ? value : 0;
  const m = typeof max === 'number' && max !== 0 ? Math.abs(max) : 1;
  const pct = Math.max(1, (Math.abs(v) / m) * 100);
  const color = ctx.format.colors.default ?? ctx.theme.dataColors[0];
  const field = ctx.data.values[0];
  const el = h(
    'button',
    { type: 'button', class: `pbi-decomp-node${selected ? ' is-selected' : ''}${dim ? ' is-dim' : ''}`, 'aria-pressed': String(selected), title: `${label}: ${ctx.fmt(field, value)}` },
    h('div', { class: 'pbi-decomp-row' }, h('span', { class: 'pbi-decomp-label' }, label), h('b', {}, ctx.fmt(field, value, { displayUnits: 'auto' }))),
    h('div', { class: 'pbi-decomp-track' }, h('i', { style: `width:${pct.toFixed(1)}%;background:${v < 0 ? ctx.theme.bad : color}` })),
  );
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return el;
}
