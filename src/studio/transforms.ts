import type { DataModel } from '../data/model';
import type { CellValue, Row } from '../data/types';
import { applySteps, describeStep, type TransformStep } from '../data/transform';
import { formatValue } from '../format/format';
import { h } from '../render/svg';
import { openDialog } from './dialogs';

type Op = TransformStep['op'];

/** Step types offered in the editor, with labels. */
const OPS: [Op, string][] = [
  ['filterRows', 'Filter rows'],
  ['removeColumns', 'Remove columns'],
  ['keepColumns', 'Keep columns'],
  ['renameColumns', 'Rename column'],
  ['changeType', 'Change type'],
  ['replaceValues', 'Replace values'],
  ['transformText', 'Clean text'],
  ['splitColumn', 'Split column'],
  ['mergeColumns', 'Merge columns'],
  ['addColumn', 'Add column (template)'],
  ['fillDown', 'Fill down'],
  ['unpivot', 'Unpivot columns'],
  ['groupBy', 'Group by'],
  ['sort', 'Sort'],
  ['removeDuplicates', 'Remove duplicates'],
  ['keepTop', 'Keep top rows'],
];

const parseValue = (s: string): CellValue => (s.trim() === '' ? null : /^-?\d+(\.\d+)?$/.test(s.trim()) ? Number(s) : s);

/**
 * Power Query-style step editor for a table: the step list (reorder, remove), a form to add steps and a live
 * preview of the first rows. `onSave` receives the full step list.
 */
export function transformDialog(host: HTMLElement, model: DataModel, table: string, onSave: (steps: TransformStep[]) => void): void {
  // steps run over the source without calculated columns (those are recomputed after the steps)
  const calc = [...model.table(table).columns.values()].filter((c) => c.expression).map((c) => c.name);
  const source = model.sourceRowsOf(table) ?? model.table(table).toRows().map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !calc.includes(k))));
  const steps: TransformStep[] = model.transformsOf(table) ?? [];
  const list = h('ol', { class: 'pbs-steps', 'aria-label': 'Applied steps' });
  const form = h('div', { class: 'pbs-step-form' });
  const preview = h('div', { class: 'pbs-grid pbs-step-preview' });
  const status = h('div', { class: 'pbs-status', role: 'status' });

  const result = (): { rows: Row[]; error?: string } => {
    try {
      return { rows: applySteps(source, steps, { lookup: (n) => model.table(n).toRows() }) };
    } catch (e) {
      return { rows: [], error: (e as Error).message };
    }
  };
  const columnsNow = (): string[] => {
    const r = result().rows;
    return r.length ? Object.keys(r[0]) : Object.keys(source[0] ?? {});
  };

  const render = () => {
    list.replaceChildren();
    if (!steps.length) list.append(h('li', { class: 'pbs-empty' }, 'No steps yet: the table shows its source rows.'));
    steps.forEach((st, i) => {
      const up = h('button', { type: 'button', class: 'pbs-icon-btn', 'aria-label': 'Move up', title: 'Move up' }, '↑');
      const down = h('button', { type: 'button', class: 'pbs-icon-btn', 'aria-label': 'Move down', title: 'Move down' }, '↓');
      const del = h('button', { type: 'button', class: 'pbs-icon-btn', 'aria-label': 'Remove step', title: 'Remove step' }, '×');
      up.addEventListener('click', () => i > 0 && (steps.splice(i - 1, 0, steps.splice(i, 1)[0]), render()));
      down.addEventListener('click', () => i < steps.length - 1 && (steps.splice(i + 1, 0, steps.splice(i, 1)[0]), render()));
      del.addEventListener('click', () => (steps.splice(i, 1), render()));
      list.append(h('li', {}, h('span', {}, describeStep(st)), up, down, del));
    });
    const { rows, error } = result();
    status.textContent = error ? `⚠ ${error}` : `${formatValue(rows.length, '#,0')} rows · ${rows.length ? Object.keys(rows[0]).length : 0} columns (source: ${formatValue(source.length, '#,0')} rows)`;
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const tbl = h('table', {}, h('thead', {}, h('tr', {}, ...cols.map((c) => h('th', {}, c)))), h('tbody', {}, ...rows.slice(0, 8).map((r) => h('tr', {}, ...cols.map((c) => h('td', {}, formatValue(r[c] as never, undefined, { blank: '' }) || String(r[c] ?? '')))))));
    preview.replaceChildren(tbl);
    renderForm();
  };

  // ---------------------------------------------------------------- add-step form
  const opSelect = h('select', { 'aria-label': 'Step type' }, ...OPS.map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
  const fields = h('div', { class: 'pbs-step-fields' });
  const add = h('button', { type: 'button', class: 'pbs-btn is-primary' }, 'Add step');
  const colSelect = (multiple = false) => h('select', { 'aria-label': 'Column', ...(multiple ? { multiple: '', size: '4' } : {}) }, ...columnsNow().map((c) => h('option', { value: c }, c))) as HTMLSelectElement;
  const input = (label: string, value = '') => h('input', { 'aria-label': label, placeholder: label, value }) as HTMLInputElement;
  const pick = (sel: HTMLSelectElement) => [...sel.selectedOptions].map((o) => o.value);
  let build: () => TransformStep | null = () => null;

  const renderForm = () => {
    const op = opSelect.value as Op;
    fields.replaceChildren();
    const lab = (text: string, el: HTMLElement) => h('label', {}, h('span', {}, text), el);
    switch (op) {
      case 'filterRows': {
        const c = colSelect();
        const t = h('select', { 'aria-label': 'Condition' }, ...['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'notContains', 'startsWith', 'notBlank', 'isBlank'].map((v) => h('option', { value: v }, v))) as HTMLSelectElement;
        const v = input('Value');
        fields.append(lab('Column', c), lab('Keep rows where', t), lab('Value', v));
        build = () => ({ op, column: c.value, test: t.value as never, value: parseValue(v.value) });
        break;
      }
      case 'removeColumns':
      case 'keepColumns':
      case 'fillDown':
      case 'unpivot': {
        const c = colSelect(true);
        fields.append(lab('Columns', c));
        build = () => (pick(c).length ? ({ op, columns: pick(c) } as TransformStep) : null);
        break;
      }
      case 'renameColumns': {
        const c = colSelect();
        const n = input('New name');
        fields.append(lab('Column', c), lab('New name', n));
        build = () => (n.value.trim() ? { op, names: { [c.value]: n.value.trim() } } : null);
        break;
      }
      case 'changeType': {
        const c = colSelect();
        const t = h('select', { 'aria-label': 'Type' }, ...['number', 'string', 'date', 'boolean'].map((v) => h('option', { value: v }, v))) as HTMLSelectElement;
        fields.append(lab('Column', c), lab('Type', t));
        build = () => ({ op, column: c.value, type: t.value as never });
        break;
      }
      case 'replaceValues': {
        const c = colSelect();
        const f = input('Find');
        const r = input('Replace with');
        fields.append(lab('Column', c), lab('Find', f), lab('Replace with', r));
        build = () => ({ op, column: c.value, find: parseValue(f.value), replace: parseValue(r.value) });
        break;
      }
      case 'transformText': {
        const c = colSelect(true);
        const fn = h('select', { 'aria-label': 'Operation' }, ...['trim', 'clean', 'upper', 'lower', 'title'].map((v) => h('option', { value: v }, v))) as HTMLSelectElement;
        fields.append(lab('Columns', c), lab('Operation', fn));
        build = () => (pick(c).length ? { op, columns: pick(c), fn: fn.value as never } : null);
        break;
      }
      case 'splitColumn': {
        const c = colSelect();
        const d = input('Delimiter', ',');
        const into = input('New column names (comma separated)');
        fields.append(lab('Column', c), lab('Delimiter', d), lab('Into', into));
        build = () => {
          const names = into.value.split(',').map((x) => x.trim()).filter(Boolean);
          return names.length && d.value ? { op, column: c.value, delimiter: d.value, into: names } : null;
        };
        break;
      }
      case 'mergeColumns': {
        const c = colSelect(true);
        const sep = input('Separator', ' ');
        const as = input('New column name');
        fields.append(lab('Columns', c), lab('Separator', sep), lab('Name', as));
        build = () => (pick(c).length > 1 && as.value.trim() ? { op, columns: pick(c), separator: sep.value, as: as.value.trim() } : null);
        break;
      }
      case 'addColumn': {
        const n = input('Column name');
        const t = input('Template, e.g. {First} {Last}');
        fields.append(lab('Name', n), lab('Template', t));
        build = () => (n.value.trim() && t.value ? { op, name: n.value.trim(), template: t.value } : null);
        break;
      }
      case 'groupBy': {
        const by = colSelect(true);
        const agg = h('select', { 'aria-label': 'Aggregation' }, ...['count', 'sum', 'avg', 'min', 'max', 'distinctCount'].map((v) => h('option', { value: v }, v))) as HTMLSelectElement;
        const of = colSelect();
        const name = input('Result name', 'Count');
        fields.append(lab('Group by', by), lab('Aggregation', agg), lab('Of column', of), lab('Name', name));
        build = () => (pick(by).length ? { op, by: pick(by), aggregations: [{ name: name.value.trim() || agg.value, agg: agg.value as never, ...(agg.value === 'count' ? {} : { column: of.value }) }] } : null);
        break;
      }
      case 'sort': {
        const c = colSelect();
        const dir = h('select', { 'aria-label': 'Direction' }, h('option', { value: 'asc' }, 'Ascending'), h('option', { value: 'desc' }, 'Descending')) as HTMLSelectElement;
        fields.append(lab('Column', c), lab('Direction', dir));
        build = () => ({ op, by: [{ column: c.value, desc: dir.value === 'desc' }] });
        break;
      }
      case 'removeDuplicates': {
        const c = colSelect(true);
        fields.append(lab('By columns (none = whole row)', c));
        build = () => ({ op, ...(pick(c).length ? { columns: pick(c) } : {}) });
        break;
      }
      case 'keepTop': {
        const n = input('Rows', '100');
        fields.append(lab('Rows', n));
        build = () => (Number(n.value) > 0 ? { op, n: Math.floor(Number(n.value)) } : null);
        break;
      }
      default:
        build = () => null;
    }
  };
  opSelect.addEventListener('change', renderForm);
  add.addEventListener('click', () => {
    const st = build();
    if (!st) {
      status.textContent = 'Fill in the step first.';
      return;
    }
    steps.push(st);
    render();
  });
  form.append(h('div', { class: 'pbs-step-pick' }, opSelect, add), fields);

  const body = h('div', { class: 'pbs-transform' }, h('h4', {}, 'Applied steps'), list, h('h4', {}, 'Add a step'), form, h('h4', {}, 'Preview'), status, preview);
  render();
  openDialog(host, `Transform ${table}`, body, [
    { label: 'Cancel' },
    {
      label: 'Apply',
      primary: true,
      onClick: () => {
        if (result().error) {
          status.textContent = `⚠ Fix the failing step first: ${result().error}`;
          return false;
        }
        onSave(steps);
      },
    },
  ]);
}
