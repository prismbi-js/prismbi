import type { DataModel } from '../data/model';
import type { MeasureDef } from '../data/types';
import { FORMAT_PRESETS, formatValue } from '../format/format';
import { h } from '../render/svg';
import { ExpressionEditor } from './expressionEditor';

export interface DialogButton {
  label: string;
  primary?: boolean;
  /** Return false to keep the dialog open. */
  onClick?: () => boolean | void;
}

/** Minimal accessible modal: focus moves in, Esc / backdrop closes, focus returns. */
export function openDialog(host: HTMLElement, title: string, body: HTMLElement, buttons: DialogButton[]): { close: () => void } {
  const prev = document.activeElement as HTMLElement | null;
  const footer = h('footer');
  const dialog = h('div', { class: 'pbs-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('header', {}, title), h('div', { class: 'pbs-body' }, body), footer);
  const modal = h('div', { class: 'pbs-modal' }, dialog);
  const close = () => {
    modal.remove();
    prev?.focus?.();
  };
  for (const b of buttons) {
    const btn = h('button', { type: 'button', class: `pbs-btn${b.primary ? ' is-primary' : ''}` }, b.label);
    btn.addEventListener('click', () => {
      if (b.onClick?.() === false) return;
      close();
    });
    footer.append(btn);
  }
  modal.addEventListener('mousedown', (e) => e.target === modal && close());
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  host.append(modal);
  (dialog.querySelector('input, textarea, select, button') as HTMLElement | null)?.focus();
  return { close };
}

const field = (label: string, control: HTMLElement) => h('div', { class: 'pbs-row' }, h('label', {}, label), control);

function formatSelect(current?: string): { el: HTMLElement; value: () => string | undefined } {
  const presets: [string, string][] = [
    ['', 'General'],
    ['#,0', 'Whole number (1,234)'],
    ['#,0.00', 'Decimal (1,234.56)'],
    ['$#,0', 'Currency ($1,234)'],
    ['$#,0.00', 'Currency ($1,234.56)'],
    ['0%', 'Percent (12%)'],
    ['0.0%', 'Percent (12.3%)'],
    ['yyyy-MM-dd', 'Date (2025-03-01)'],
    ['MMM yyyy', 'Month (Mar 2025)'],
  ];
  const sel = h('select', { 'aria-label': 'Format' }) as HTMLSelectElement;
  for (const [v, l] of presets) sel.append(h('option', { value: v, selected: (current ?? '') === v }, l));
  sel.append(h('option', { value: '__custom__', selected: !!current && !presets.some((p) => p[0] === current) }, 'Custom…'));
  const custom = h('input', { type: 'text', placeholder: 'e.g. #,0.0 "units"', value: current ?? '', 'aria-label': 'Custom format' }) as HTMLInputElement;
  custom.hidden = sel.value !== '__custom__';
  sel.addEventListener('change', () => (custom.hidden = sel.value !== '__custom__'));
  void FORMAT_PRESETS;
  return { el: h('div', { class: 'pbs-row2' }, sel, custom), value: () => (sel.value === '__custom__' ? custom.value.trim() || undefined : sel.value || undefined) };
}

/** Create or edit a measure. Calls `onSave` with the definition (and the previous name when renamed). */
export function measureDialog(host: HTMLElement, model: DataModel, existing: MeasureDef | null, onSave: (def: MeasureDef, previousName?: string) => void): void {
  const name = h('input', { type: 'text', value: existing?.name ?? '', placeholder: 'Total Sales', 'aria-label': 'Measure name' }) as HTMLInputElement;
  const table = h('select', { 'aria-label': 'Home table' }) as HTMLSelectElement;
  for (const t of model.tableNames()) table.append(h('option', { value: t, selected: (existing?.table ?? model.tableNames()[0]) === t }, t));
  const editor = new ExpressionEditor(model, existing?.expression ?? '');
  const fmt = formatSelect(existing?.format);
  const folder = h('input', { type: 'text', value: existing?.folder ?? '', placeholder: 'Optional', 'aria-label': 'Display folder' }) as HTMLInputElement;
  const preview = h('div', { class: 'pbs-preview', role: 'status' });
  const error = h('div', { class: 'pbs-diag' });
  const update = () => {
    const problems = editor.problems();
    if (problems.length) {
      preview.replaceChildren('Value: —');
      return;
    }
    try {
      const v = model.evaluate(editor.value);
      preview.replaceChildren('Value with no filters: ', h('b', {}, formatValue(v, fmt.value(), { blank: '(Blank)' })));
    } catch (e) {
      preview.replaceChildren(h('span', { class: 'error' }, (e as Error).message));
    }
  };
  editor.onChange = update;
  fmt.el.addEventListener('change', update);
  update();
  const body = h(
    'div',
    { style: 'display:flex;flex-direction:column;gap:10px' },
    h('div', { class: 'pbs-row2' }, field('Name', name), field('Home table', table)),
    field('Expression', editor.el),
    h('div', { class: 'pbs-row2' }, field('Format', fmt.el), field('Display folder', folder)),
    preview,
    error,
  );
  openDialog(host, existing ? `Edit measure: ${existing.name}` : 'New measure', body, [
    { label: 'Cancel' },
    {
      label: existing ? 'Save' : 'Create',
      primary: true,
      onClick: () => {
        const n = name.value.trim();
        const problems = editor.problems();
        const clash = n !== existing?.name && model.hasMeasure(n);
        const msg = !n ? 'Give the measure a name' : clash ? `A measure named "${n}" already exists` : problems[0];
        if (msg) {
          error.replaceChildren(h('div', { class: 'error' }, msg));
          return false;
        }
        onSave({ name: n, expression: editor.value.trim(), table: table.value, format: fmt.value(), folder: folder.value.trim() || undefined }, existing && existing.name !== n ? existing.name : undefined);
      },
    },
  ]);
}

export interface CalcColumnDef {
  table: string;
  name: string;
  expression: string;
  format?: string;
}

/** Create or edit a calculated column. */
export function columnDialog(host: HTMLElement, model: DataModel, existing: CalcColumnDef | null, defaultTable: string | undefined, onSave: (def: CalcColumnDef, previous?: CalcColumnDef) => void): void {
  const table = h('select', { 'aria-label': 'Table', disabled: !!existing }) as HTMLSelectElement;
  for (const t of model.tableNames()) table.append(h('option', { value: t, selected: (existing?.table ?? defaultTable ?? model.tableNames()[0]) === t }, t));
  const name = h('input', { type: 'text', value: existing?.name ?? '', placeholder: 'Profit', 'aria-label': 'Column name' }) as HTMLInputElement;
  const editor = new ExpressionEditor(model, existing?.expression ?? '', { placeholder: 'Sales[Amount] - Sales[Cost]' });
  const fmt = formatSelect(existing?.format);
  const error = h('div', { class: 'pbs-diag' });
  const body = h('div', { style: 'display:flex;flex-direction:column;gap:10px' }, h('div', { class: 'pbs-row2' }, field('Table', table), field('Name', name)), field('Expression (evaluated for each row)', editor.el), field('Format', fmt.el), error);
  openDialog(host, existing ? `Edit column: ${existing.name}` : 'New calculated column', body, [
    { label: 'Cancel' },
    {
      label: existing ? 'Save' : 'Create',
      primary: true,
      onClick: () => {
        const n = name.value.trim();
        const t = table.value;
        const clash = n !== existing?.name && model.table(t).hasColumn(n);
        const msg = !n ? 'Give the column a name' : clash ? `Table "${t}" already has a column "${n}"` : editor.problems()[0];
        if (msg) {
          error.replaceChildren(h('div', { class: 'error' }, msg));
          return false;
        }
        onSave({ table: t, name: n, expression: editor.value.trim(), format: fmt.value() }, existing ?? undefined);
      },
    },
  ]);
}

/** In-page confirm (window.confirm is blocked in many embeds). */
export function confirmDialog(host: HTMLElement, title: string, message: string, confirmLabel: string, onConfirm: () => void): void {
  openDialog(host, title, h('p', { style: 'margin:0' }, message), [{ label: 'Cancel' }, { label: confirmLabel, primary: true, onClick: () => void onConfirm() }]);
}
