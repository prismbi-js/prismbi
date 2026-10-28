import { h } from '../render/svg';
import type { VisualLayout, VisualSpec } from '../visuals/types';

export interface EditPageInfo {
  el: HTMLElement;
  cols: number;
  rowHeight: number;
  gap: number;
  /** visual id → container element */
  visuals: Map<string, HTMLElement>;
  specs: VisualSpec[];
}

export interface EditHost {
  page(): EditPageInfo | null;
  select(id: string | null): void;
  selected(): string | null;
  commitLayout(id: string, layout: VisualLayout): void;
  /** Several layout changes as one edit (multi-drag). */
  commitLayouts?(updates: { id: string; layout: VisualLayout }[]): void;
  /** All selected visual ids (multi-select). */
  selection?(): string[];
  /** Ctrl/Shift-click: add or remove from the selection. */
  toggle?(id: string): void;
}

type Mode = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const HANDLES: Mode[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/**
 * Design-time layout editing: selection, drag to move, 8-way resize, all snapped to the page grid.
 * Visual content can't be interacted with while editing (an overlay captures the pointer).
 */
export class EditController {
  private drag: { id: string; mode: Mode; x: number; y: number; start: VisualLayout; current: VisualLayout; pointer: number; others?: Map<string, { start: VisualLayout; current: VisualLayout }> } | null = null;

  constructor(private host: EditHost) {}

  /** Grid step in px for columns and rows. */
  steps(p: EditPageInfo): { col: number; row: number } {
    const inner = Math.max(0, (p.el.clientWidth || 0) - p.gap * 2);
    const col = inner > 0 ? (inner + p.gap) / p.cols : 80;
    return { col, row: p.rowHeight + p.gap };
  }

  /** Add (or refresh) the edit overlay on a visual element. */
  decorate(id: string, el: HTMLElement): void {
    el.querySelector(':scope > .pbi-edit')?.remove();
    const overlay = h('div', { class: 'pbi-edit', 'data-edit-for': id, tabindex: 0, role: 'button', 'aria-label': 'Select visual (drag, or arrow keys, to move; Shift+arrows to resize)' });
    overlay.addEventListener('keydown', (e) => this.key(id, e as KeyboardEvent));
    for (const m of HANDLES) {
      const handle = h('i', { class: `pbi-handle pbi-handle-${m}`, 'data-mode': m, 'aria-hidden': 'true' });
      overlay.append(handle);
    }
    overlay.addEventListener('pointerdown', (e) => this.start(id, (e.target as HTMLElement).dataset.mode as Mode | undefined, e as PointerEvent));
    overlay.addEventListener('pointermove', (e) => this.move(e as PointerEvent));
    overlay.addEventListener('pointerup', (e) => this.end(e as PointerEvent));
    overlay.addEventListener('pointercancel', (e) => this.end(e as PointerEvent));
    overlay.addEventListener('click', (e) => e.stopPropagation());
    overlay.addEventListener('focus', () => this.host.selected() !== id && this.host.select(id));
    el.append(overlay);
    this.markSelection();
  }

  undecorate(el: HTMLElement): void {
    el.querySelector(':scope > .pbi-edit')?.remove();
    el.removeAttribute('data-selected');
  }

  /** Reflect the current selection on the overlays. */
  markSelection(): void {
    const p = this.host.page();
    if (!p) return;
    const sel = this.host.selected();
    const many = this.host.selection?.() ?? [];
    for (const [id, el] of p.visuals) el.toggleAttribute('data-selected', id === sel || many.includes(id));
  }

  /** Draw the snapping grid on the page background. */
  paintGrid(): void {
    const p = this.host.page();
    if (!p) return;
    const { col, row } = this.steps(p);
    p.el.style.setProperty('--pbi-grid-col', `${col}px`);
    p.el.style.setProperty('--pbi-grid-row', `${row}px`);
  }

  /** Keyboard editing: arrows move one grid cell (with the rest of the selection), Shift+arrows resize. */
  private key(id: string, e: KeyboardEvent): void {
    const dx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const dy = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!dx && !dy) return;
    const p = this.host.page();
    if (!p) return;
    e.preventDefault();
    e.stopPropagation();
    const selection = this.host.selection?.() ?? [];
    const ids = !e.shiftKey && selection.includes(id) && selection.length > 1 ? selection : [id];
    const updates: { id: string; layout: VisualLayout }[] = [];
    for (const vid of ids) {
      const l = { ...(p.specs.find((s) => s.id === vid)?.layout ?? { x: 0, y: 0, w: 4, h: 6 }) };
      if (e.shiftKey) {
        l.w = Math.max(1, Math.min(p.cols - l.x, l.w + dx));
        l.h = Math.max(1, l.h + dy);
      } else {
        l.x = Math.max(0, Math.min(p.cols - l.w, l.x + dx));
        l.y = Math.max(0, l.y + dy);
      }
      updates.push({ id: vid, layout: l });
    }
    if (updates.length > 1 && this.host.commitLayouts) this.host.commitLayouts(updates);
    else for (const u of updates) this.host.commitLayout(u.id, u.layout);
    // re-rendering replaces the overlay: keep keyboard focus on this visual
    (p.visuals.get(id)?.querySelector(':scope > .pbi-edit') as HTMLElement | null)?.focus();
  }

  private start(id: string, mode: Mode | undefined, e: PointerEvent): void {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // Ctrl / Shift / Cmd-click adds to or removes from the selection
    if ((e.ctrlKey || e.shiftKey || e.metaKey) && this.host.toggle) {
      this.host.toggle(id);
      return;
    }
    const selection = this.host.selection?.() ?? [];
    if (!selection.includes(id)) this.host.select(id);
    const p = this.host.page();
    const spec = p?.specs.find((s) => s.id === id);
    if (!p || !spec) return;
    const start = { ...(spec.layout ?? { x: 0, y: 0, w: 4, h: 6 }) };
    // moving one of several selected visuals moves them all
    const group = (this.host.selection?.() ?? []).filter((x) => x !== id);
    const others = (mode ?? 'move') === 'move' && group.length ? new Map(group.map((x) => {
      const l = { ...(p.specs.find((s) => s.id === x)?.layout ?? { x: 0, y: 0, w: 4, h: 6 }) };
      return [x, { start: l, current: { ...l } }] as const;
    })) : undefined;
    this.drag = { id, mode: mode ?? 'move', x: e.clientX, y: e.clientY, start, current: { ...start }, pointer: e.pointerId, others };
    try {
      (e.target as HTMLElement).closest('.pbi-edit')?.setPointerCapture?.(e.pointerId);
    } catch {
      /* jsdom / synthetic events */
    }
    p.visuals.get(id)?.classList.add('is-dragging');
  }

  private move(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const p = this.host.page();
    if (!p) return;
    const { col, row } = this.steps(p);
    let dc = Math.round((e.clientX - d.x) / col);
    let dr = Math.round((e.clientY - d.y) / row);
    if (d.others) {
      // the whole selection moves by the same amount and stays on the grid
      const all = [d.start, ...[...d.others.values()].map((o) => o.start)];
      dc = Math.max(-Math.min(...all.map((l) => l.x)), Math.min(p.cols - Math.max(...all.map((l) => l.x + l.w)), dc));
      dr = Math.max(-Math.min(...all.map((l) => l.y)), dr);
      for (const [oid, o] of d.others) {
        o.current = { ...o.start, x: o.start.x + dc, y: o.start.y + dr };
        const oel = p.visuals.get(oid);
        if (oel) for (const k of ['x', 'y'] as const) oel.style.setProperty(`--${k}`, String(o.current[k]));
      }
    }
    const s = d.start;
    let { x, y, w, h: hh } = s;
    const m = d.mode;
    if (m === 'move') {
      x += dc;
      y += dr;
    } else {
      if (m.includes('e')) w += dc;
      if (m.includes('s')) hh += dr;
      if (m.includes('w')) {
        x += dc;
        w -= dc;
      }
      if (m.includes('n')) {
        y += dr;
        hh -= dr;
      }
    }
    // clamp to the page grid
    w = Math.max(1, Math.min(p.cols, w));
    hh = Math.max(1, hh);
    if (m.includes('w') && w === 1) x = s.x + s.w - 1;
    if (m.includes('n') && hh === 1) y = s.y + s.h - 1;
    x = Math.max(0, Math.min(p.cols - w, x));
    y = Math.max(0, y);
    const next: VisualLayout = { ...s, x, y, w, h: hh };
    if (next.x === d.current.x && next.y === d.current.y && next.w === d.current.w && next.h === d.current.h) return;
    d.current = next;
    const el = p.visuals.get(d.id);
    if (el) for (const k of ['x', 'y', 'w', 'h'] as const) el.style.setProperty(`--${k}`, String(next[k]));
    this.updateGuides(p, d.id, next, col, row);
  }

  private updateGuides(p: EditPageInfo, id: string, cur: VisualLayout, colPx: number, rowPx: number): void {
    p.el.querySelectorAll('.pbi-guide').forEach((g) => g.remove());
    const others = p.specs.filter((s) => s.id !== id && s.layout);
    for (const o of others) {
      const ol = o.layout!;
      if (cur.x === ol.x || cur.x === ol.x + ol.w) {
        p.el.append(h('div', { class: 'pbi-guide pbi-guide-v', style: `left:${cur.x * colPx + p.gap}px` }));
        break;
      }
      if (cur.x + cur.w === ol.x + ol.w || cur.x + cur.w === ol.x) {
        p.el.append(h('div', { class: 'pbi-guide pbi-guide-v', style: `left:${(cur.x + cur.w) * colPx + p.gap}px` }));
        break;
      }
    }
    for (const o of others) {
      const ol = o.layout!;
      if (cur.y === ol.y || cur.y === ol.y + ol.h) {
        p.el.append(h('div', { class: 'pbi-guide pbi-guide-h', style: `top:${cur.y * rowPx + p.gap}px` }));
        break;
      }
      if (cur.y + cur.h === ol.y + ol.h || cur.y + cur.h === ol.y) {
        p.el.append(h('div', { class: 'pbi-guide pbi-guide-h', style: `top:${(cur.y + cur.h) * rowPx + p.gap}px` }));
        break;
      }
    }
  }

  private end(_e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const p = this.host.page();
    p?.el.querySelectorAll('.pbi-guide').forEach((g) => g.remove());
    p?.visuals.get(d.id)?.classList.remove('is-dragging');
    const c = d.current;
    const s = d.start;
    const changed = (a: VisualLayout, b: VisualLayout) => a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h;
    if (d.others && this.host.commitLayouts) {
      const updates = [{ id: d.id, layout: c, start: s }, ...[...d.others].map(([id, o]) => ({ id, layout: o.current, start: o.start }))].filter((u) => changed(u.layout, u.start));
      if (updates.length) this.host.commitLayouts(updates.map(({ id, layout }) => ({ id, layout })));
      return;
    }
    if (changed(c, s)) this.host.commitLayout(d.id, c);
  }
}

/** First free grid position for a w×h visual (scanning rows top-down, then columns). */
export function findFreeSpot(specs: VisualSpec[], cols: number, w: number, h: number): { x: number; y: number } {
  const occupied = specs.map((s) => s.layout ?? { x: 0, y: 0, w: 4, h: 6 });
  const hit = (x: number, y: number) => occupied.some((o) => x < o.x + o.w && x + w > o.x && y < o.y + o.h && y + h > o.y);
  const maxY = occupied.reduce((m, o) => Math.max(m, o.y + o.h), 0);
  for (let y = 0; y <= maxY; y++) for (let x = 0; x + w <= cols; x++) if (!hit(x, y)) return { x, y };
  return { x: 0, y: maxY };
}
