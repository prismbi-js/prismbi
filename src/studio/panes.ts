import type { FieldSpec } from '../data/query';
import type { Aggregation } from '../data/query';
import { h } from '../render/svg';
import { getVisual, listVisuals } from '../visuals/registry';
import type { VisualDefinition } from '../visuals/types';
import { ContextMenu } from '../report/contextMenu';
import { fieldRefOf, removeField } from './assign';
import type { StudioContext } from './context';
import { CHIP_MIME, FIELD_MIME } from './context';
import { FALLBACK_ICON, VISUAL_ICONS, VISUAL_ORDER } from './icons';

const asArray = (f: FieldSpec | FieldSpec[] | undefined): FieldSpec[] => (f === undefined ? [] : Array.isArray(f) ? f : [f]);
const label = (ref: string) => ref.replace(/^'?([^'[]+)'?\[(.+)\]$/, '$2');

function icon(html: string): HTMLElement {
  const span = h('span', { class: 'pbs-svg' });
  span.innerHTML = html;
  return span.firstElementChild as HTMLElement;
}

// ---------------------------------------------------------------------------- fields

/** Fields pane: tables → columns, hierarchies and measures. Click adds, drag drops, ⋯ opens actions. */
export function renderFields(ctx: StudioContext, container: HTMLElement, opts: { query: string; showHidden: boolean; menu: ContextMenu }): void {
  const { model } = ctx;
  const q = opts.query.trim().toLowerCase();
  const used = new Set<string>();
  const sel = ctx.selected();
  if (sel)
    for (const f of Object.values(ctx.report.visual(sel).spec.fields ?? {}))
      for (const x of asArray(f as FieldSpec | FieldSpec[])) used.add(fieldRefOf(x));
  const fields = model.fields();
  const byTable = new Map<string, typeof fields>();
  for (const f of fields) {
    if (f.kind === 'column' && f.hidden && !opts.showHidden) continue;
    const t = f.table || 'Measures';
    byTable.set(t, [...(byTable.get(t) ?? []), f]);
  }
  container.replaceChildren();
  for (const [table, list] of byTable) {
    const matches = list.filter((f) => !q || f.name.toLowerCase().includes(q) || table.toLowerCase().includes(q));
    if (!matches.length) continue;
    const det = h('details', { class: 'pbs-table', open: !!q || byTable.size <= 4 }) as HTMLDetailsElement;
    det.append(h('summary', {}, h('span', {}, table), h('small', {}, String(matches.length))));
    // measures first, grouped by display folder
    const ordered = [...matches].sort((a, b) => (a.kind === 'measure' ? 0 : 1) - (b.kind === 'measure' ? 0 : 1) || (a.folder ?? '').localeCompare(b.folder ?? '') || a.name.localeCompare(b.name));
    let folder: string | undefined;
    for (const f of ordered) {
      if ((f.folder ?? '') !== (folder ?? '')) {
        folder = f.folder;
        if (folder) det.append(h('div', { class: 'pbs-folder' }, folder));
      }
      const badge = f.kind === 'measure' ? 'fx' : f.kind === 'hierarchy' ? 'H' : f.type === 'number' ? '#' : f.type === 'date' ? 'D' : f.type === 'boolean' ? 'T/F' : 'Aa';
      const isCalc = f.kind === 'column' && ctx.isStudioColumn(f.table, f.name);
      const more = h('button', { type: 'button', class: 'pbs-more', title: 'More actions', 'aria-label': `Actions for ${f.name}` }, '⋯');
      const row = h(
        'div',
        { class: `pbs-field${used.has(f.ref) ? ' is-used' : ''}`, draggable: 'true', role: 'button', tabindex: 0, title: f.description ?? f.ref, 'data-ref': f.ref },
        h('i', { class: `pbs-badge${f.kind === 'measure' ? ' is-measure' : ''}` }, badge),
        h('span', {}, f.name),
        more,
      );
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData(FIELD_MIME, f.ref);
        e.dataTransfer?.setData('text/plain', f.ref);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
      });
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.pbs-more')) return;
        ctx.addField(f.ref);
      });
      row.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), ctx.addField(f.ref)));
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        const r = more.getBoundingClientRect();
        const items =
          f.kind === 'measure'
            ? [
                { label: 'Edit measure', onClick: () => ctx.editMeasure(f.name) },
                { label: 'Delete measure', onClick: () => ctx.deleteMeasure(f.name) },
              ]
            : f.kind === 'column'
              ? [
                  ...(f.type === 'number'
                    ? [
                        {
                          label: 'New measure: Sum',
                          onClick: () => {
                            const name = `Total ${f.name}`;
                            if (model.hasMeasure(name)) return ctx.toast(`"${name}" already exists`);
                            model.addMeasure(name, `SUM(${f.ref})`, { table: f.table, format: f.format });
                            ctx.commit();
                            ctx.toast(`Added measure ${name}`);
                          },
                        },
                      ]
                    : []),
                  { label: 'New calculated column in this table', onClick: () => ctx.editColumn(f.table) },
                  ...(isCalc
                    ? [
                        { label: 'Edit column', onClick: () => ctx.editColumn(f.table, f.name) },
                        { label: 'Delete column', onClick: () => ctx.deleteColumn(f.table, f.name) },
                      ]
                    : []),
                ]
              : [];
        if (items.length) opts.menu.show(r.left, r.bottom + 2, items);
      });
      det.append(row);
    }
    container.append(det);
  }
  if (!container.childElementCount) container.append(h('div', { class: 'pbs-hint' }, q ? `No fields match "${opts.query}"` : 'This model has no fields yet'));
}

// ---------------------------------------------------------------------------- visualizations + wells

/** Distinct visual definitions in a sensible order (aliases removed). */
export function visualTypes(): VisualDefinition[] {
  const seen = new Set<VisualDefinition>();
  const defs: VisualDefinition[] = [];
  for (const t of [...VISUAL_ORDER, ...listVisuals()]) {
    let d: VisualDefinition;
    try {
      d = getVisual(t);
    } catch {
      continue;
    }
    if (seen.has(d)) continue;
    seen.add(d);
    defs.push(d);
  }
  return defs;
}

export function renderVisualizations(ctx: StudioContext, container: HTMLElement): void {
  const sel = ctx.selected();
  const current = sel ? ctx.report.visual(sel).spec.type : null;
  const currentDef = current ? getVisual(current) : null;
  const grid = h('div', { class: 'pbs-vgrid', role: 'toolbar', 'aria-label': 'Visual types' });
  for (const d of visualTypes()) {
    const b = h('button', { type: 'button', class: 'pbs-vbtn', title: d.displayName, 'aria-label': d.displayName, 'aria-pressed': String(currentDef === d) });
    b.append(icon(VISUAL_ICONS[d.type] ?? FALLBACK_ICON));
    b.addEventListener('click', () => (sel ? ctx.setVisualType(d.type) : ctx.addVisual(d.type)));
    grid.append(b);
  }
  container.replaceChildren(
    h('div', { class: 'pbs-hint', style: 'padding-bottom:0' }, sel ? 'Change the selected visual' : 'Add a visual (or click a field)'),
    grid,
  );
}

const AGGS: [Aggregation | '', string][] = [
  ['sum', 'Sum'],
  ['avg', 'Average'],
  ['min', 'Min'],
  ['max', 'Max'],
  ['count', 'Count'],
  ['distinctCount', 'Count (distinct)'],
  ['median', 'Median'],
];

/** Field wells of the selected visual: drop targets, reorder, remove, aggregation. */
export function renderWells(ctx: StudioContext, container: HTMLElement): void {
  container.replaceChildren();
  const sel = ctx.selected();
  if (!sel) {
    container.append(h('div', { class: 'pbs-hint' }, 'Select a visual to see its fields.'));
    return;
  }
  const spec = ctx.report.visual(sel).spec;
  const def = getVisual(spec.type);
  if (!def.roles.length) {
    container.append(h('div', { class: 'pbs-hint' }, `${def.displayName} has no data fields.`));
    return;
  }
  for (const role of def.roles) {
    const list = asArray(spec.fields?.[role.name]);
    const drop = h('div', { class: 'pbs-drop', 'data-role': role.name });
    list.forEach((f, i) => {
      const ref = fieldRefOf(f);
      const isMeasure = ctx.model.hasMeasure(ref);
      const chip = h('div', { class: 'pbs-chip', draggable: 'true', title: ref }, h('span', {}, typeof f === 'object' && f.name ? f.name : isMeasure ? ref : label(ref)));
      // aggregation choice for a column used as a value (or one that already carries an aggregation)
      if (!isMeasure && (role.kind === 'measure' || (typeof f === 'object' && !!f.aggregation))) {
        const agg = h('select', { 'aria-label': 'Aggregation' }) as HTMLSelectElement;
        const cur = typeof f === 'object' ? (f.aggregation ?? 'sum') : 'sum';
        for (const [v, l] of AGGS) agg.append(h('option', { value: v, selected: v === cur }, l));
        agg.addEventListener('change', () => {
          const next = asArray(spec.fields?.[role.name]).slice();
          next[i] = { field: ref, aggregation: agg.value as Aggregation };
          ctx.report.updateVisual(sel, { fields: { ...spec.fields, [role.name]: role.multiple || role.kind === 'any' ? next : next[0] } });
        });
        chip.append(agg);
      }
      const x = h('button', { type: 'button', title: 'Remove', 'aria-label': `Remove ${ref}` }, '✕');
      x.addEventListener('click', () => ctx.report.updateVisual(sel, { fields: removeField(spec, role.name, i) }));
      chip.append(x);
      chip.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData(CHIP_MIME, JSON.stringify({ role: role.name, index: i, ref }));
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      });
      drop.append(chip);
    });
    drop.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes(FIELD_MIME) || e.dataTransfer?.types.includes(CHIP_MIME)) {
        e.preventDefault();
        drop.classList.add('is-over');
      }
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
      // index from the drop position among chips
      const chips = [...drop.querySelectorAll('.pbs-chip')];
      const at = chips.findIndex((c) => e.clientY < c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2);
      const index = at < 0 ? undefined : at;
      const chipData = e.dataTransfer?.getData(CHIP_MIME);
      if (chipData) {
        const { role: fromRole, index: fromIndex, ref } = JSON.parse(chipData) as { role: string; index: number; ref: string };
        const base = { ...spec, fields: removeField(spec, fromRole, fromIndex) };
        const adj = fromRole === role.name && index !== undefined && fromIndex < index ? index - 1 : index;
        ctx.report.updateVisual(sel, { fields: base.fields });
        ctx.assign(sel, ref, role.name, adj);
        return;
      }
      const ref = e.dataTransfer?.getData(FIELD_MIME);
      if (ref) ctx.assign(sel, ref, role.name, index);
    });
    container.append(
      h('div', { class: 'pbs-well' }, h('div', { class: 'pbs-well-h' }, h('span', {}, role.displayName + (role.required ? ' *' : '')), h('small', {}, role.kind === 'measure' ? 'values' : role.kind === 'grouping' ? 'fields' : '')), drop),
    );
  }
}

/** Visuals / Layers selection pane: reorder z-index, toggle visibility, select or rename visuals. */
export function renderSelectionPane(ctx: StudioContext, container: HTMLElement): void {
  container.replaceChildren();
  const r = ctx.report;
  const ids = r.visualIds();
  if (!ids.length) {
    container.append(h('div', { class: 'pbs-hint' }, 'No visuals on this page yet.'));
    return;
  }
  const sel = ctx.selected();
  const list = h('div', { class: 'pbs-sel-list', role: 'listbox', 'aria-label': 'Visual layers' });

  // Display top-most visual first (reverse order of layout)
  const reversed = ids.slice().reverse();

  for (const id of reversed) {
    const handle = r.visual(id);
    const spec = handle.spec;
    const def = getVisual(spec.type);
    const title = spec.title || def.displayName;
    const isSelected = sel === id;
    const isHidden = !!spec.hidden;

    const row = h('div', {
      class: `pbs-sel-item${isSelected ? ' is-selected' : ''}${isHidden ? ' is-hidden' : ''}`,
      role: 'option',
      'aria-selected': String(isSelected),
      'data-id': id,
    });

    const iconSpan = h('span', { class: 'pbs-svg', style: 'width:16px;height:16px;flex-shrink:0' });
    iconSpan.innerHTML = VISUAL_ICONS[spec.type] ?? FALLBACK_ICON;

    const labelSpan = h('span', { title: 'Click to select, double-click to rename' }, title);
    labelSpan.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const current = spec.title || '';
      const input = h('input', { type: 'text', value: current, style: 'width:100%;padding:2px 4px;font-size:12px' }) as HTMLInputElement;
      labelSpan.replaceWith(input);
      input.focus();
      const commit = () => {
        const val = input.value.trim();
        r.updateVisual(id, { title: val || undefined });
        ctx.commit();
        renderSelectionPane(ctx, container);
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') commit();
        else if (ev.key === 'Escape') renderSelectionPane(ctx, container);
      });
    });

    const upBtn = h('button', { type: 'button', class: 'pbs-sel-btn', title: 'Bring forward', 'aria-label': 'Bring forward' }, '▲');
    upBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      r.arrange(id, 'forward');
      ctx.commit();
      renderSelectionPane(ctx, container);
    });

    const downBtn = h('button', { type: 'button', class: 'pbs-sel-btn', title: 'Send backward', 'aria-label': 'Send backward' }, '▼');
    downBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      r.arrange(id, 'backward');
      ctx.commit();
      renderSelectionPane(ctx, container);
    });

    const hideBtn = h('button', { type: 'button', class: 'pbs-sel-btn', title: isHidden ? 'Show visual' : 'Hide visual', 'aria-label': isHidden ? 'Show' : 'Hide' }, isHidden ? '👁️‍🗨️' : '👁');
    hideBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      r.updateVisual(id, { hidden: !isHidden });
      ctx.commit();
      renderSelectionPane(ctx, container);
    });

    row.addEventListener('click', () => {
      ctx.report.setActiveVisual(id);
    });

    row.append(iconSpan, labelSpan, upBtn, downBtn, hideBtn);
    list.append(row);
  }

  container.append(
    h('div', { class: 'pbs-pane-h', style: 'padding:8px 10px 4px' }, h('span', {}, 'Visual Layers'), h('small', {}, `${ids.length} visuals`)),
    list,
  );
}
