import { h } from '../render/svg';
import type { CellValue } from '../data/types';
import { columnRefToString, parseColumnRef, valueKey } from '../data/types';
import type { ColumnFilterSpec, FilterOp, FilterSpec, TopNFilterSpec } from '../data/filters';
import type { DataModel } from '../data/model';
import { formatValue } from '../format/format';

export interface FilterSection {
  scope: 'visual' | 'page' | 'report';
  title: string;
  filters: FilterSpec[];
  set(filters: FilterSpec[]): void;
}

const ADV_OPS: { op: FilterOp; label: string; needsValue: boolean }[] = [
  { op: 'contains', label: 'contains', needsValue: true },
  { op: 'notContains', label: 'does not contain', needsValue: true },
  { op: 'startsWith', label: 'starts with', needsValue: true },
  { op: 'endsWith', label: 'ends with', needsValue: true },
  { op: 'eq', label: 'is', needsValue: true },
  { op: 'neq', label: 'is not', needsValue: true },
  { op: 'gt', label: 'is greater than', needsValue: true },
  { op: 'gte', label: 'is greater than or equal to', needsValue: true },
  { op: 'lt', label: 'is less than', needsValue: true },
  { op: 'lte', label: 'is less than or equal to', needsValue: true },
  { op: 'isBlank', label: 'is blank', needsValue: false },
  { op: 'isNotBlank', label: 'is not blank', needsValue: false },
];

/** Human summary of a filter: "is Bikes, Clothing", "contains 'mount'", "Top 5 by Total Sales". */
export function describeFilter(f: FilterSpec, model?: DataModel): string {
  if (f.op === 'topN') return `${f.direction === 'bottom' ? 'Bottom' : 'Top'} ${f.n} by ${f.by}`;
  if (f.op === 'tuples') return `${f.tuples.length} combination(s)`;
  const col = parseColumnRef(f.target);
  const fmt = (v: CellValue) => formatValue(v, model?.table(col.table).column(col.column).format) || '(Blank)';
  switch (f.op) {
    case 'in':
      return f.values?.length ? `is ${f.values.slice(0, 3).map(fmt).join(', ')}${f.values.length > 3 ? ` +${f.values.length - 3}` : ''}` : 'is (none)';
    case 'notIn':
      return f.values?.length ? `is not ${f.values.slice(0, 3).map(fmt).join(', ')}` : 'is (All)';
    case 'between':
      return `${f.min === undefined || f.min === null ? '…' : fmt(f.min)} – ${f.max === undefined || f.max === null ? '…' : fmt(f.max)}`;
    default: {
      const o = ADV_OPS.find((x) => x.op === f.op);
      return o?.needsValue ? `${o.label} ${fmt(f.value ?? null)}` : (o?.label ?? f.op);
    }
  }
}

function targetOf(f: FilterSpec): string {
  if (f.op === 'tuples') return f.targets.map((t) => columnRefToString(parseColumnRef(t))).join(', ');
  return columnRefToString(parseColumnRef(f.target));
}

function isActive(f: FilterSpec): boolean {
  return !(f.op === 'notIn' && !(f.values ?? []).length);
}

/** Power BI-style filter pane: visual / page / report filters with Basic, Advanced and Top N modes. */
export class FilterPane {
  readonly el: HTMLElement;
  private open = new Set<string>();
  private search = new Map<string, string>();

  constructor(
    private model: DataModel,
    private onClose: () => void,
  ) {
    this.el = h('aside', { class: 'pbi-fpane', 'aria-label': 'Filters' });
  }

  render(sections: FilterSection[]): void {
    this.el.replaceChildren();
    const close = h('button', { type: 'button', class: 'pbi-icon', 'aria-label': 'Close filters', title: 'Close' }, '✕');
    close.addEventListener('click', () => this.onClose());
    this.el.append(h('div', { class: 'pbi-fpane-h' }, h('span', {}, 'Filters'), close));
    for (const sec of sections) this.el.append(this.section(sec));
  }

  private section(sec: FilterSection): HTMLElement {
    const el = h('div', { class: 'pbi-fpane-sec' }, h('h4', {}, sec.title));
    sec.filters.forEach((f, i) => {
      if (f.op === 'tuples') return;
      el.append(this.card(sec, f, i));
    });
    // add filter
    const select = h('select', { class: 'pbi-select', 'aria-label': `Add a filter to ${sec.title.toLowerCase()}` }) as HTMLSelectElement;
    select.append(h('option', { value: '' }, '+ Add data field'));
    for (const fi of this.model.fields())
      if (fi.kind === 'column' && !fi.hidden) select.append(h('option', { value: fi.ref }, `${fi.table} › ${fi.name}`));
    select.addEventListener('change', () => {
      if (!select.value) return;
      const key = `${sec.scope}:${sec.filters.length}`;
      this.open.add(key);
      sec.set([...sec.filters, { target: select.value, op: 'notIn', values: [] }]);
    });
    el.append(select);
    return el;
  }

  private card(sec: FilterSection, f: ColumnFilterSpec | TopNFilterSpec, index: number): HTMLElement {
    const key = `${sec.scope}:${index}`;
    const target = targetOf(f);
    const col = parseColumnRef(target);
    const column = this.model.table(col.table).column(col.column);
    const isOpen = this.open.has(key);
    const replace = (nf: FilterSpec | null) => {
      const next = sec.filters.slice();
      if (nf) next[index] = nf;
      else next.splice(index, 1);
      sec.set(next);
    };
    const toggle = h('button', { type: 'button', class: 'pbi-icon', 'aria-expanded': String(isOpen), 'aria-label': isOpen ? 'Collapse filter' : 'Expand filter' }, isOpen ? '▾' : '▸');
    toggle.addEventListener('click', () => {
      if (isOpen) this.open.delete(key);
      else this.open.add(key);
      sec.set(sec.filters.slice());
    });
    const clear = h('button', { type: 'button', class: 'pbi-icon', title: 'Clear filter', 'aria-label': 'Clear filter' }, '⌫');
    clear.addEventListener('click', () => replace({ target, op: 'notIn', values: [] }));
    const remove = h('button', { type: 'button', class: 'pbi-icon', title: 'Remove filter', 'aria-label': 'Remove filter' }, '✕');
    remove.addEventListener('click', () => replace(null));
    const card = h(
      'div',
      { class: `pbi-fcard${isActive(f) ? ' is-active' : ''}` },
      h('div', { class: 'pbi-fcard-h' }, toggle, h('b', { title: target }, col.column), clear, remove),
      h('div', { class: 'pbi-fcard-sum' }, isActive(f) ? describeFilter(f, this.model) : 'is (All)'),
    );
    if (!isOpen) return card;

    const mode: 'basic' | 'advanced' | 'topN' = f.op === 'topN' ? 'topN' : f.op === 'in' || f.op === 'notIn' ? 'basic' : 'advanced';
    const seg = h('div', { class: 'pbi-seg', role: 'group', 'aria-label': 'Filter type' });
    const modeBtn = (m: typeof mode, label: string, make: () => FilterSpec) => {
      const b = h('button', { type: 'button', 'aria-pressed': String(mode === m) }, label);
      b.addEventListener('click', () => mode !== m && replace(make()));
      seg.append(b);
    };
    modeBtn('basic', 'Basic', () => ({ target, op: 'notIn', values: [] }));
    modeBtn('advanced', 'Advanced', () => ({ target, op: column.type === 'number' ? 'gt' : 'contains', value: column.type === 'number' ? 0 : '' }));
    const firstMeasure = this.model.measureList()[0]?.name;
    if (firstMeasure) modeBtn('topN', 'Top N', () => ({ target, op: 'topN', n: 5, by: firstMeasure, direction: 'top' }));
    const body = h('div', { class: 'pbi-fcard-body' }, seg);

    if (mode === 'basic') {
      const cf = f as ColumnFilterSpec;
      const domain = this.model.valuesOf(col, []); // respects row-level security
      const selected = new Set((cf.op === 'in' ? cf.values ?? [] : []).map(valueKey));
      const q = this.search.get(key) ?? '';
      if (domain.length > 8) {
        const input = h('input', { type: 'search', class: 'pbi-slicer-search', placeholder: 'Search', value: q, 'aria-label': 'Search values' }) as HTMLInputElement;
        input.addEventListener('input', () => {
          this.search.set(key, input.value);
          const needle = input.value.toLowerCase();
          for (const row of list.querySelectorAll<HTMLElement>('[data-label]')) row.hidden = !!needle && !row.dataset.label!.toLowerCase().includes(needle);
        });
        body.append(input);
      }
      const list = h('div', { class: 'pbi-slicer-list' });
      for (const v of domain.slice(0, 1000)) {
        const label = formatValue(v, column.format) || '(Blank)';
        const input = h('input', { type: 'checkbox', checked: selected.has(valueKey(v)) }) as HTMLInputElement;
        const row = h('label', { class: 'pbi-slicer-item', 'data-label': label }, input, h('span', {}, label));
        if (q && !label.toLowerCase().includes(q.toLowerCase())) row.hidden = true;
        input.addEventListener('change', () => {
          const vals = (cf.op === 'in' ? (cf.values ?? []) : []).filter((x) => valueKey(x) !== valueKey(v));
          if (input.checked) vals.push(v);
          replace(vals.length ? { target, op: 'in', values: vals } : { target, op: 'notIn', values: [] });
        });
        list.append(row);
      }
      body.append(list);
    } else if (mode === 'advanced') {
      const cf = f as ColumnFilterSpec;
      const opSel = h('select', { class: 'pbi-select', 'aria-label': 'Condition' }) as HTMLSelectElement;
      for (const o of ADV_OPS) opSel.append(h('option', { value: o.op, selected: o.op === cf.op }, `Show items when the value ${o.label}`));
      const needs = ADV_OPS.find((o) => o.op === cf.op)?.needsValue ?? true;
      const type = column.type === 'number' ? 'number' : column.type === 'date' ? 'date' : 'text';
      const shown = cf.value instanceof Date ? formatValue(cf.value, 'yyyy-MM-dd') : cf.value === null || cf.value === undefined ? '' : String(cf.value);
      const val = h('input', { type, class: 'pbi-range-input', value: shown, 'aria-label': 'Value', disabled: !needs }) as HTMLInputElement;
      const parse = (s: string): CellValue => {
        if (type === 'number') return s === '' ? null : Number(s);
        if (type === 'date') {
          const [y, m, d] = s.split('-').map(Number);
          return s ? new Date(y, m - 1, d) : null;
        }
        return s;
      };
      const apply = () => replace({ target, op: opSel.value as FilterOp, value: parse(val.value) });
      opSel.addEventListener('change', apply);
      val.addEventListener('change', apply);
      body.append(opSel, val);
    } else {
      const tf = f as TopNFilterSpec;
      const dir = h('select', { class: 'pbi-select', 'aria-label': 'Direction' }) as HTMLSelectElement;
      dir.append(h('option', { value: 'top', selected: tf.direction !== 'bottom' }, 'Top'), h('option', { value: 'bottom', selected: tf.direction === 'bottom' }, 'Bottom'));
      const n = h('input', { type: 'number', min: 1, value: tf.n, class: 'pbi-range-input', 'aria-label': 'Number of items' }) as HTMLInputElement;
      const by = h('select', { class: 'pbi-select', 'aria-label': 'By value' }) as HTMLSelectElement;
      for (const m of this.model.measureList()) by.append(h('option', { value: m.name, selected: m.name === tf.by }, `By ${m.name}`));
      const apply = () => replace({ target, op: 'topN', n: Math.max(1, Number(n.value) || 1), by: by.value, direction: dir.value as 'top' | 'bottom' });
      dir.addEventListener('change', apply);
      n.addEventListener('change', apply);
      by.addEventListener('change', apply);
      body.append(h('div', { class: 'pbi-between-inputs' }, dir, n), by);
    }
    card.append(body);
    return card;
  }
}
