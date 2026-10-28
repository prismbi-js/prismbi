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

/** Writes and explains expressions from plain language (see `daxCopilot` in `@prismbi/prismbi/ai`). */
export interface ExpressionCopilot {
  write(request: string, ctx: { kind: 'measure' | 'column'; table?: string }): Promise<{ expression: string; name?: string; format?: string; note?: string }>;
  explain?(expression: string): string | Promise<string>;
}

function formatSelect(current?: string): { el: HTMLElement; value: () => string | undefined; set: (v: string | undefined) => void } {
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
  const set = (v: string | undefined) => {
    const preset = presets.some((p) => p[0] === (v ?? ''));
    sel.value = preset ? (v ?? '') : '__custom__';
    custom.value = v ?? '';
    custom.hidden = preset;
  };
  return { el: h('div', { class: 'pbs-row2' }, sel, custom), value: () => (sel.value === '__custom__' ? custom.value.trim() || undefined : sel.value || undefined), set };
}

/** Create or edit a measure. Calls `onSave` with the definition (and the previous name when renamed). */
export function measureDialog(host: HTMLElement, model: DataModel, existing: MeasureDef | null, onSave: (def: MeasureDef, previousName?: string) => void, copilot?: ExpressionCopilot): void {
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
  let assist: HTMLElement | string = '';
  if (copilot) {
    const ask = h('input', { type: 'text', placeholder: 'Describe it: “sales year to date”, “profit margin”, “sales last year for bikes”', 'aria-label': 'Describe the measure' }) as HTMLInputElement;
    const note = h('div', { class: 'pbs-copilot-note', role: 'status' });
    const write = h('button', { type: 'button', class: 'pbs-btn' }, '✦ Write DAX') as HTMLButtonElement;
    const explainBtn = h('button', { type: 'button', class: 'pbs-btn' }, 'Explain') as HTMLButtonElement;
    explainBtn.hidden = !copilot.explain;
    const run = async () => {
      if (!ask.value.trim()) return void (note.textContent = 'Describe the measure first.');
      write.disabled = true;
      note.textContent = 'Writing…';
      try {
        const r = await copilot.write(ask.value.trim(), { kind: 'measure', table: table.value });
        editor.value = r.expression;
        if (!name.value.trim() && r.name) name.value = r.name;
        if (r.format !== undefined) fmt.set(r.format);
        update();
        note.textContent = r.note ?? 'Check the expression and the value below, then save.';
      } catch (e) {
        note.textContent = (e as Error).message;
      } finally {
        write.disabled = false;
      }
    };
    write.addEventListener('click', () => void run());
    ask.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void run();
      }
    });
    explainBtn.addEventListener('click', async () => {
      if (!editor.value.trim()) return void (note.textContent = 'Nothing to explain yet.');
      try {
        note.textContent = await copilot.explain!(editor.value);
      } catch (e) {
        note.textContent = (e as Error).message;
      }
    });
    assist = h('div', { class: 'pbs-copilot' }, h('div', { class: 'pbs-copilot-row' }, ask, write, explainBtn), note);
  }
  const body = h(
    'div',
    { style: 'display:flex;flex-direction:column;gap:10px' },
    h('div', { class: 'pbs-row2' }, field('Name', name), field('Home table', table)),
    assist,
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

/** Quick measure calculation templates for common DAX patterns. */
export function quickMeasureDialog(host: HTMLElement, model: DataModel, onSave: (def: MeasureDef) => void, defaultBase?: string): void {
  const allFields = model.fields();
  const measures = model.measureList().map((m) => m.name);
  const dateCols = allFields.filter((f) => f.kind === 'column' && f.type === 'date').map((f) => f.ref);
  const catCols = allFields.filter((f) => f.kind === 'column' && f.type === 'string').map((f) => f.ref);
  const tables = model.tableNames();

  const TEMPLATES: { id: string; label: string; kind: 'date' | 'cat'; defaultFmt?: string; gen: (b: string, d?: string, c?: string) => { name: string; expr: string } }[] = [
    { id: 'yoy', label: 'Year-over-year change %', kind: 'date', defaultFmt: '0.0%', gen: (b, d) => ({ name: `${b} YoY %`, expr: `DIVIDE([${b}] - CALCULATE([${b}], SAMEPERIODLASTYEAR(${d})), CALCULATE([${b}], SAMEPERIODLASTYEAR(${d})))` }) },
    { id: 'ytd', label: 'Year-to-date total', kind: 'date', gen: (b, d) => ({ name: `${b} YTD`, expr: `TOTALYTD([${b}], ${d})` }) },
    { id: 'running', label: 'Running total', kind: 'date', gen: (b, d) => ({ name: `${b} Running Total`, expr: `CALCULATE([${b}], DATESBETWEEN(${d}, BLANK(), MAX(${d})))` }) },
    { id: 'rolling3', label: 'Rolling 3-month average', kind: 'date', gen: (b, d) => ({ name: `${b} 3M Avg`, expr: `AVERAGEX(DATESINPERIOD(${d}, LASTDATE(${d}), -3, MONTH), [${b}])` }) },
    { id: 'mom', label: 'Month-over-month change', kind: 'date', gen: (b, d) => ({ name: `${b} MoM Change`, expr: `[${b}] - CALCULATE([${b}], DATEADD(${d}, -1, MONTH))` }) },
    { id: 'share', label: 'Share of category total %', kind: 'cat', defaultFmt: '0.0%', gen: (b, _, c) => ({ name: `${b} % of Total`, expr: `DIVIDE([${b}], CALCULATE([${b}], ALLSELECTED(${c})))` }) },
  ];

  const calcSelect = h('select', { 'aria-label': 'Calculation' }) as HTMLSelectElement;
  for (const t of TEMPLATES) calcSelect.append(h('option', { value: t.id }, t.label));

  const baseSelect = h('select', { 'aria-label': 'Base measure' }) as HTMLSelectElement;
  for (const m of measures) baseSelect.append(h('option', { value: m, selected: m === defaultBase }, m));

  const dateSelect = h('select', { 'aria-label': 'Date column' }) as HTMLSelectElement;
  for (const d of dateCols) dateSelect.append(h('option', { value: d }, d));

  const catSelect = h('select', { 'aria-label': 'Category column' }) as HTMLSelectElement;
  for (const c of catCols) catSelect.append(h('option', { value: c }, c));

  const homeTable = h('select', { 'aria-label': 'Home table' }) as HTMLSelectElement;
  for (const t of tables) homeTable.append(h('option', { value: t }, t));

  const nameInput = h('input', { type: 'text', 'aria-label': 'Measure name' }) as HTMLInputElement;
  const editor = new ExpressionEditor(model, '');
  const fmt = formatSelect();
  const error = h('div', { class: 'pbs-diag' });

  const dateRow = field('Date column', dateSelect);
  const catRow = field('Category column', catSelect);

  const sync = () => {
    const tmpl = TEMPLATES.find((t) => t.id === calcSelect.value) ?? TEMPLATES[0];
    dateRow.hidden = tmpl.kind !== 'date';
    catRow.hidden = tmpl.kind !== 'cat';
    const b = baseSelect.value || (measures[0] ?? 'Sales');
    const d = dateSelect.value || (dateCols[0] ?? 'Date[Date]');
    const c = catSelect.value || (catCols[0] ?? 'Product[Category]');
    const generated = tmpl.gen(b, d, c);
    nameInput.value = generated.name;
    editor.value = generated.expr;
    if (tmpl.defaultFmt) fmt.set(tmpl.defaultFmt);
  };

  calcSelect.addEventListener('change', sync);
  baseSelect.addEventListener('change', sync);
  dateSelect.addEventListener('change', sync);
  catSelect.addEventListener('change', sync);
  sync();

  const body = h(
    'div',
    { style: 'display:flex;flex-direction:column;gap:10px' },
    field('Calculation', calcSelect),
    h('div', { class: 'pbs-row2' }, field('Base measure', baseSelect), field('Home table', homeTable)),
    dateRow,
    catRow,
    field('Name', nameInput),
    field('Expression', editor.el),
    field('Format', fmt.el),
    error,
  );

  openDialog(host, 'Quick measure', body, [
    { label: 'Cancel' },
    {
      label: 'Create',
      primary: true,
      onClick: () => {
        const n = nameInput.value.trim();
        const clash = model.hasMeasure(n);
        const msg = !n ? 'Give the measure a name' : clash ? `A measure named "${n}" already exists` : editor.problems()[0];
        if (msg) {
          error.replaceChildren(h('div', { class: 'error' }, msg));
          return false;
        }
        onSave({ name: n, expression: editor.value.trim(), table: homeTable.value, format: fmt.value() });
      },
    },
  ]);
}
