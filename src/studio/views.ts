import type { DataModel } from '../data/model';
import { valueKey } from '../data/types';
import { formatValue } from '../format/format';
import { h, s } from '../render/svg';
import type { StudioContext } from './context';

// ---------------------------------------------------------------------------- data view

export function renderDataView(ctx: StudioContext, container: HTMLElement, state: { table?: string; limit: number }, onState: () => void): void {
  const { model } = ctx;
  const tables = model.tableNames();
  if (!state.table || !model.hasTable(state.table)) state.table = tables[0];
  const list = h('nav', { class: 'pbs-data-list', 'aria-label': 'Tables' });
  for (const t of tables) {
    const b = h('button', { type: 'button', 'aria-pressed': String(t === state.table) }, h('span', {}, t), h('small', {}, formatValue(model.table(t).rowCount, '#,0')));
    b.addEventListener('click', () => {
      state.table = t;
      state.limit = 200;
      onState();
    });
    list.append(b);
  }
  const main = h('div', { class: 'pbs-data-main' });
  if (state.table) {
    const t = model.table(state.table);
    const cols = [...t.columns.values()];
    const addCol = h('button', { type: 'button', class: 'pbs-btn' }, 'New column');
    addCol.addEventListener('click', () => ctx.editColumn(state.table));
    const steps = model.transformsOf(state.table)?.length ?? 0;
    const transform = h('button', { type: 'button', class: 'pbs-btn', title: 'Clean and reshape this table (Power Query-style steps)' }, steps ? `Transform (${steps})` : 'Transform');
    transform.addEventListener('click', () => ctx.editTransforms(state.table));
    const addMeasure = h('button', { type: 'button', class: 'pbs-btn' }, 'New measure');
    addMeasure.addEventListener('click', () => ctx.editMeasure());
    main.append(h('div', { class: 'pbs-data-bar' }, h('b', {}, state.table), h('span', { class: 'pbs-status' }, `${formatValue(t.rowCount, '#,0')} rows · ${cols.length} columns`), h('span', { class: 'pbs-spacer' }), transform, addCol, addMeasure));
    const table = h('table');
    table.append(
      h(
        'thead',
        {},
        h('tr', {}, ...cols.map((c) => h('th', { title: c.expression ? `= ${c.expression}` : c.description ?? '' }, c.name, h('small', {}, `${c.type}${c.expression ? ' · calculated' : ''}${c.hidden ? ' · hidden' : ''}`)))),
      ),
    );
    const tbody = h('tbody');
    const n = Math.min(t.rowCount, state.limit);
    for (let r = 0; r < n; r++) tbody.append(h('tr', {}, ...cols.map((c) => h('td', { class: c.type === 'number' ? 'num' : '' }, formatValue(c.values[r], c.format, { blank: '' })))));
    table.append(tbody);
    const grid = h('div', { class: 'pbs-grid' }, table);
    main.append(grid);
    if (t.rowCount > n) {
      const more = h('button', { type: 'button', class: 'pbs-btn', style: 'margin:8px 12px;align-self:flex-start' }, `Show ${Math.min(500, t.rowCount - n)} more`);
      more.addEventListener('click', () => {
        state.limit += 500;
        onState();
      });
      main.append(more);
    }
  }
  container.replaceChildren(h('div', { class: 'pbs-data' }, list, main));
}

// ---------------------------------------------------------------------------- model view

const CARD_W = 200;
const HEAD_H = 33;
const ROW_H = 22;

export interface ModelViewState {
  positions: Record<string, { x: number; y: number }>;
}

export function autoLayoutModel(model: DataModel, state: ModelViewState, force = false): void {
  const tables = model.tableNames();
  if (!tables.length) return;
  if (!force && tables.every((t: string) => state.positions[t])) return;
  const outgoingCount = new Map<string, number>();
  for (const r of model.relationships()) outgoingCount.set(r.fromTable, (outgoingCount.get(r.fromTable) ?? 0) + 1);
  const sorted = [...tables].sort((a, b) => (outgoingCount.get(b) ?? 0) - (outgoingCount.get(a) ?? 0) || model.table(b).rowCount - model.table(a).rowCount);
  sorted.forEach((t, i) => {
    if (!force && state.positions[t]) return;
    const col = i === 0 ? 1 : i % 3 === 1 ? 0 : i % 3 === 2 ? 2 : 3;
    const row = i === 0 ? 0 : Math.floor((i - 1) / 3);
    state.positions[t] = { x: 30 + col * 260, y: 30 + row * 300 };
  });
}

/** Relationship diagram. Drag table headers to arrange, drag a column onto another table's column to relate them. */
export function renderModelView(ctx: StudioContext, container: HTMLElement, state: ModelViewState, onLayoutChange: () => void): void {
  const { model } = ctx;
  const tables = model.tableNames();
  autoLayoutModel(model, state);
  const wrap = h('div', { class: 'pbs-model', tabindex: 0, 'aria-label': 'Model diagram' });
  const autoBtn = h('button', { type: 'button', class: 'pbs-btn', style: 'position:absolute;top:12px;right:12px;z-index:10' }, 'Auto layout');
  wrap.append(autoBtn);
  const svgEl = s('svg', { class: 'pbs-model-svg', width: 1, height: 1 });
  const defs = s('defs');
  const marker = (id: string) => {
    const m = s('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    m.append(s('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'currentColor' }));
    return m;
  };
  defs.append(marker('pbs-arrow'));
  svgEl.append(defs);
  wrap.append(svgEl);
  const cards = new Map<string, HTMLElement>();
  const rowEls = new Map<string, HTMLElement>();

  for (const t of tables) {
    const pos = state.positions[t];
    const tbl = model.table(t);
    const head = h('header', {}, h('span', {}, t), h('small', {}, formatValue(tbl.rowCount, '#,0')));
    const ul = h('ul');
    for (const c of tbl.columns.values()) {
      const li = h('li', { class: c.hidden ? 'is-hidden' : '', 'data-col': `${t}|${c.name}`, title: `${c.name} · ${c.type}${c.expression ? ' · calculated' : ''}` }, h('span', {}, c.name));
      rowEls.set(`${t}|${c.name}`, li);
      ul.append(li);
    }
    const card = h('div', { class: 'pbs-card', style: `left:${pos.x}px;top:${pos.y}px`, 'data-table': t }, head, ul);
    cards.set(t, card);
    wrap.append(card);
    // drag the card by its header
    head.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const sx = e.clientX;
      const sy = e.clientY;
      const start = { ...state.positions[t] };
      const moveCard = (ev: PointerEvent) => {
        state.positions[t] = { x: Math.max(0, start.x + ev.clientX - sx), y: Math.max(0, start.y + ev.clientY - sy) };
        card.style.left = `${state.positions[t].x}px`;
        card.style.top = `${state.positions[t].y}px`;
        drawLines();
      };
      const up = () => {
        window.removeEventListener('pointermove', moveCard);
        window.removeEventListener('pointerup', up);
        onLayoutChange();
      };
      window.addEventListener('pointermove', moveCard);
      window.addEventListener('pointerup', up);
    });
    ul.addEventListener('scroll', () => drawLines());
  }

  // relationship creation: press on a column, release on another table's column
  let dragFrom: string | null = null;
  const temp = s('path', { stroke: 'currentColor', 'stroke-dasharray': '4 4', fill: 'none', 'stroke-width': 1.5, visibility: 'hidden' });
  svgEl.append(temp);
  wrap.addEventListener('pointerdown', (e) => {
    const li = (e.target as HTMLElement).closest('li[data-col]') as HTMLElement | null;
    if (!li) return;
    e.preventDefault();
    dragFrom = li.dataset.col!;
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!dragFrom) return;
    const a = anchor(dragFrom, 'right');
    const r = wrap.getBoundingClientRect();
    const x = e.clientX - r.left + wrap.scrollLeft;
    const y = e.clientY - r.top + wrap.scrollTop;
    temp.setAttribute('d', `M${a.x},${a.y} L${x},${y}`);
    temp.setAttribute('visibility', 'visible');
    wrap.querySelectorAll('li.is-target').forEach((n) => n.classList.remove('is-target'));
    (document.elementFromPoint?.(e.clientX, e.clientY) as HTMLElement | null)?.closest('li[data-col]')?.classList.add('is-target');
  });
  const finish = (e: PointerEvent) => {
    if (!dragFrom) return;
    const from = dragFrom;
    dragFrom = null;
    temp.setAttribute('visibility', 'hidden');
    wrap.querySelectorAll('li.is-target').forEach((n) => n.classList.remove('is-target'));
    const li = (document.elementFromPoint?.(e.clientX, e.clientY) as HTMLElement | null)?.closest('li[data-col]') as HTMLElement | null;
    const to = li?.dataset.col;
    if (!to || to === from || to.split('|')[0] === from.split('|')[0]) return;
    createRelationship(ctx, from, to);
  };
  wrap.addEventListener('pointerup', finish);
  wrap.addEventListener('pointerleave', () => {
    dragFrom = null;
    temp.setAttribute('visibility', 'hidden');
  });

  const anchor = (key: string, side: 'left' | 'right') => {
    const [t] = key.split('|');
    const pos = state.positions[t];
    const li = rowEls.get(key);
    const card = cards.get(t)!;
    const ul = card.querySelector('ul')!;
    const top = li ? li.offsetTop - ul.scrollTop : 0;
    const y = pos.y + HEAD_H + Math.max(0, Math.min(ul.clientHeight || 260, top)) + ROW_H / 2;
    return { x: pos.x + (side === 'right' ? CARD_W : 0), y: Number.isFinite(y) ? y : pos.y + HEAD_H };
  };

  const lines = s('g');
  svgEl.append(lines);
  const drawLines = () => {
    lines.replaceChildren();
    let maxX = 0;
    let maxY = 0;
    for (const p of Object.values(state.positions)) {
      maxX = Math.max(maxX, p.x + CARD_W + 40);
      maxY = Math.max(maxY, p.y + 340);
    }
    svgEl.setAttribute('width', String(maxX));
    svgEl.setAttribute('height', String(maxY));
    model.relationships().forEach((r) => {
      const fk = `${r.fromTable}|${r.fromColumn}`;
      const pk = `${r.toTable}|${r.toColumn}`;
      const fromLeft = state.positions[r.fromTable].x > state.positions[r.toTable].x;
      const a = anchor(fk, fromLeft ? 'left' : 'right');
      const b = anchor(pk, fromLeft ? 'right' : 'left');
      const mx = (a.x + b.x) / 2;
      const d = `M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`;
      const color = r.active ? 'var(--pbi-fg-2)' : 'var(--pbi-fg-3)';
      // the path runs many → one; filters flow one → many, so the arrow points at the start (and both ways when bidirectional)
      const path = s('path', { d, class: 'pbs-rel', stroke: color, 'stroke-dasharray': r.active ? undefined : '6 4', 'marker-start': 'url(#pbs-arrow)', 'marker-end': r.crossFilter === 'both' ? 'url(#pbs-arrow)' : undefined, style: `color:${color}` });
      const hit = s('path', { d, class: 'pbs-rel-hit', 'data-rel': r.index, 'aria-label': `${r.fromTable}[${r.fromColumn}] to ${r.toTable}[${r.toColumn}]` });
      hit.addEventListener('click', (e) => showRelPopover(ctx, wrap, r.index, e as MouseEvent));
      lines.append(path, hit);
      lines.append(s('text', { x: a.x + (fromLeft ? -12 : 6), y: a.y - 4, 'font-size': 12, fill: 'var(--pbi-fg-2)' }, '*'));
      lines.append(s('text', { x: b.x + (fromLeft ? 6 : -12), y: b.y - 4, 'font-size': 12, fill: 'var(--pbi-fg-2)' }, r.cardinality === 'manyToMany' ? '*' : '1'));
    });
  };
  autoBtn.addEventListener('click', () => {
    autoLayoutModel(model, state, true);
    for (const [t, card] of cards) {
      const p = state.positions[t];
      card.style.left = `${p.x}px`;
      card.style.top = `${p.y}px`;
    }
    drawLines();
    onLayoutChange();
  });
  container.replaceChildren(wrap);
  drawLines();
  requestAnimationFrame?.(() => drawLines());
}

/** Relate two columns: the side with unique values becomes the one side; otherwise many-to-many. */
export function createRelationship(ctx: StudioContext, a: string, b: string): boolean {
  const { model } = ctx;
  const [ta, ca] = a.split('|');
  const [tb, cb] = b.split('|');
  const unique = (t: string, c: string) => {
    const idx = model.table(t).index(c);
    for (const rows of idx.values()) if (rows.length > 1) return false;
    return true;
  };
  if (model.findRelationship({ table: ta, column: ca }, { table: tb, column: cb })) {
    ctx.toast('These columns are already related');
    return false;
  }
  const ref = (t: string, c: string) => `'${t.replace(/'/g, "''")}'[${c}]`;
  try {
    const sameType = model.table(ta).column(ca).type === model.table(tb).column(cb).type;
    if (!sameType) throw new Error(`Column types differ (${model.table(ta).column(ca).type} vs ${model.table(tb).column(cb).type})`);
    // a relationship between these two tables that is already active makes the new one inactive
    const active = !model.relationships().some((r) => r.active && ((r.fromTable === ta && r.toTable === tb) || (r.fromTable === tb && r.toTable === ta)));
    if (unique(tb, cb)) model.addRelationship({ from: ref(ta, ca), to: ref(tb, cb), active });
    else if (unique(ta, ca)) model.addRelationship({ from: ref(tb, cb), to: ref(ta, ca), active });
    else model.addRelationship({ from: ref(ta, ca), to: ref(tb, cb), cardinality: 'manyToMany', active });
    // a shared key value proves the relationship will actually match rows
    const keysA = new Set([...model.table(ta).index(ca).keys()]);
    const overlap = [...model.table(tb).index(cb).keys()].some((k) => keysA.has(k as never));
    ctx.toast(overlap ? (active ? 'Relationship created' : 'Relationship created (inactive: another one is already active)') : 'Relationship created, but no values match yet');
    ctx.commit();
    return true;
  } catch (e) {
    ctx.toast(`Could not relate: ${(e as Error).message}`);
    return false;
  }
}

function showRelPopover(ctx: StudioContext, wrap: HTMLElement, index: number, e: MouseEvent): void {
  wrap.querySelector('.pbs-pop')?.remove();
  const r = ctx.model.relationships()[index];
  if (!r) return;
  const rect = wrap.getBoundingClientRect();
  const active = h('input', { type: 'checkbox', checked: r.active }) as HTMLInputElement;
  const dir = h('select', {}, h('option', { value: 'single', selected: r.crossFilter === 'single' }, 'Single'), h('option', { value: 'both', selected: r.crossFilter === 'both' }, 'Both')) as HTMLSelectElement;
  const del = h('button', { type: 'button', class: 'pbs-btn' }, 'Delete relationship');
  const close = h('button', { type: 'button', class: 'pbs-btn' }, 'Close');
  const pop = h(
    'div',
    { class: 'pbs-pop', role: 'dialog', 'aria-label': 'Relationship', style: `left:${e.clientX - rect.left + wrap.scrollLeft + 8}px;top:${e.clientY - rect.top + wrap.scrollTop + 8}px` },
    h('b', {}, `${r.fromTable}[${r.fromColumn}] → ${r.toTable}[${r.toColumn}]`),
    h('span', { class: 'pbs-status' }, r.cardinality === 'manyToMany' ? 'Many-to-many' : 'Many-to-one'),
    h('label', {}, 'Active', active),
    h('label', {}, 'Cross-filter direction', dir),
    h('div', { style: 'display:flex;gap:6px;justify-content:space-between' }, del, close),
  );
  active.addEventListener('change', () => {
    ctx.model.updateRelationship(index, { active: active.checked });
    ctx.commit();
  });
  dir.addEventListener('change', () => {
    ctx.model.updateRelationship(index, { crossFilter: dir.value as 'single' | 'both' });
    ctx.commit();
  });
  del.addEventListener('click', () => {
    ctx.model.removeRelationship(index);
    ctx.commit();
  });
  close.addEventListener('click', () => pop.remove());
  wrap.append(pop);
  void valueKey;
}
