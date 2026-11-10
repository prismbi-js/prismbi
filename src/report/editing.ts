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
  /** Select an explicit set of visuals (e.g. from marquee lasso selection). */
  selectVisuals?(ids: string[]): void;
  /** Canvas zoom scale factor (1 by default). */
  scale?(): number;
  /** Whether snap-to-grid is active (defaults to true). */
  snapToGrid?(): boolean;
}

type Mode = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const HANDLES: Mode[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/**
 * Design-time layout editing: selection, drag to move, 8-way resize, all snapped to the page grid.
 * Visual content can't be interacted with while editing (an overlay captures the pointer).
 */
export class EditController {
  private drag: { id: string; mode: Mode; x: number; y: number; start: VisualLayout; current: VisualLayout; pointer: number; others?: Map<string, { start: VisualLayout; current: VisualLayout }> } | null = null;
  private marquee: { pageEl: HTMLElement; startX: number; startY: number; el: HTMLElement; pointer: number; additive: boolean; moved: boolean } | null = null;
  private boundPages = new WeakSet<HTMLElement>();

  constructor(private host: EditHost) {}

  /** Grid step in px for columns and rows. */
  steps(p: EditPageInfo): { col: number; row: number } {
    const s = this.host.scale?.() ?? 1;
    const inner = Math.max(0, (p.el.clientWidth || 0) - p.gap * 2);
    const col = (inner > 0 ? (inner + p.gap) / p.cols : 80) * s;
    return { col, row: (p.rowHeight + p.gap) * s };
  }

  /** Bind marquee lasso selection to the canvas background of a page. */
  decoratePage(el: HTMLElement): void {
    if (this.boundPages.has(el)) return;
    this.boundPages.add(el);
    el.addEventListener('pointerdown', (e) => this.onPagePointerDown(el, e as PointerEvent));
  }

  undecoratePage(el: HTMLElement): void {
    this.boundPages.delete(el);
    el.querySelector(':scope > .pbi-marquee')?.remove();
  }

  /** Add (or refresh) the edit overlay on a visual element. */
  decorate(id: string, el: HTMLElement): void {
    el.querySelector(':scope > .pbi-edit')?.remove();
    const spec = this.host.page()?.specs.find((s) => s.id === id);
    el.toggleAttribute('data-group', !!spec?.group);
    el.classList.toggle('is-locked', !!spec?.locked);
    const overlay = h('div', { class: 'pbi-edit', 'data-edit-for': id, tabindex: 0, role: 'button', 'aria-label': 'Select visual (drag, or arrow keys, to move; Shift+arrows to resize)' });
    overlay.addEventListener('keydown', (e) => this.key(id, e as KeyboardEvent));
    if (!spec?.locked) {
      for (const m of HANDLES) {
        const handle = h('i', { class: `pbi-handle pbi-handle-${m}`, 'data-mode': m, 'aria-hidden': 'true' });
        overlay.append(handle);
      }
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
    el.removeAttribute('data-group');
    el.classList.remove('is-locked');
  }

  /** Reflect the current selection on the overlays. */
  markSelection(): void {
    const p = this.host.page();
    if (!p) return;
    const sel = this.host.selected();
    const many = this.host.selection?.() ?? [];
    for (const [id, el] of p.visuals) {
      el.toggleAttribute('data-selected', id === sel || many.includes(id));
      const spec = p.specs.find((s) => s.id === id);
      el.toggleAttribute('data-group', !!spec?.group);
      el.classList.toggle('is-locked', !!spec?.locked);
    }
  }

  /** Draw the snapping grid on the page background. */
  paintGrid(): void {
    const p = this.host.page();
    if (!p) return;
    const s = this.host.scale?.() ?? 1;
    const { col, row } = this.steps(p);
    p.el.style.setProperty('--pbi-grid-col', `${col / s}px`);
    p.el.style.setProperty('--pbi-grid-row', `${row / s}px`);
  }

  /** Keyboard editing: arrows move one grid cell (with the rest of the selection), Shift+arrows resize. */
  private key(id: string, e: KeyboardEvent): void {
    const dx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const dy = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!dx && !dy) return;
    const p = this.host.page();
    if (!p) return;
    if (p.specs.find((s) => s.id === id)?.locked) return;
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
    if (!p || !spec || spec.locked) return;
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
    if (this.host.snapToGrid && !this.host.snapToGrid()) return;
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
      if (Math.abs(cur.x + cur.w / 2 - (ol.x + ol.w / 2)) < 0.1) {
        p.el.append(h('div', { class: 'pbi-guide pbi-guide-v pbi-guide-center', style: `left:${(cur.x + cur.w / 2) * colPx + p.gap}px` }));
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
      if (Math.abs(cur.y + cur.h / 2 - (ol.y + ol.h / 2)) < 0.1) {
        p.el.append(h('div', { class: 'pbi-guide pbi-guide-h pbi-guide-center', style: `top:${(cur.y + cur.h / 2) * rowPx + p.gap}px` }));
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

  private onPagePointerDown(pageEl: HTMLElement, e: PointerEvent): void {
    if (e.button !== undefined && e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('.pbi-edit') || target?.closest('.pbi-visual')) return;
    e.preventDefault();
    e.stopPropagation();
    const additive = e.ctrlKey || e.shiftKey || e.metaKey;
    const marqueeEl = h('div', { class: 'pbi-marquee' });
    this.marquee = { pageEl, startX: e.clientX, startY: e.clientY, el: marqueeEl, pointer: e.pointerId, additive, moved: false };
    const onMove = (ev: PointerEvent) => this.marqueeMove(ev);
    const onEnd = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      this.marqueeEnd(ev);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  }

  private visualIntersects(p: EditPageInfo, id: string, el: HTMLElement, minX: number, maxX: number, minY: number, maxY: number): boolean {
    const br = el.getBoundingClientRect();
    if (br.width > 0 || br.height > 0) {
      return br.right >= minX && br.left <= maxX && br.bottom >= minY && br.top <= maxY;
    }
    const spec = p.specs.find((s) => s.id === id);
    if (!spec) return false;
    const pr = p.el.getBoundingClientRect();
    const { col, row } = this.steps(p);
    const l = spec.layout ?? { x: 0, y: 0, w: 4, h: 6 };
    const vx0 = pr.left + l.x * col + p.gap;
    const vx1 = vx0 + l.w * col;
    const vy0 = pr.top + l.y * row + p.gap;
    const vy1 = vy0 + l.h * row;
    return vx1 >= minX && vx0 <= maxX && vy1 >= minY && vy0 <= maxY;
  }

  private marqueeMove(e: PointerEvent): void {
    const m = this.marquee;
    if (!m) return;
    const dx = e.clientX - m.startX;
    const dy = e.clientY - m.startY;
    if (!m.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      m.moved = true;
      m.pageEl.append(m.el);
    }
    const s = this.host.scale?.() ?? 1;
    const r = m.pageEl.getBoundingClientRect();
    const minX = Math.min(m.startX, e.clientX);
    const maxX = Math.max(m.startX, e.clientX);
    const minY = Math.min(m.startY, e.clientY);
    const maxY = Math.max(m.startY, e.clientY);

    m.el.style.left = `${(minX - r.left + m.pageEl.scrollLeft) / s}px`;
    m.el.style.top = `${(minY - r.top + m.pageEl.scrollTop) / s}px`;
    m.el.style.width = `${(maxX - minX) / s}px`;
    m.el.style.height = `${(maxY - minY) / s}px`;

    const p = this.host.page();
    if (!p) return;
    const existing = new Set(m.additive ? (this.host.selection?.() ?? []) : []);
    for (const [id, el] of p.visuals) {
      const hit = this.visualIntersects(p, id, el, minX, maxX, minY, maxY);
      el.toggleAttribute('data-selected', existing.has(id) || hit);
    }
  }

  private marqueeEnd(e: PointerEvent): void {
    const m = this.marquee;
    if (!m) return;
    this.marquee = null;
    m.el.remove();
    if (m.moved) {
      const minX = Math.min(m.startX, e.clientX);
      const maxX = Math.max(m.startX, e.clientX);
      const minY = Math.min(m.startY, e.clientY);
      const maxY = Math.max(m.startY, e.clientY);
      const p = this.host.page();
      if (!p) return;
      const hitIds: string[] = [];
      for (const [id, el] of p.visuals) {
        if (this.visualIntersects(p, id, el, minX, maxX, minY, maxY)) {
          hitIds.push(id);
        }
      }
      const existing = m.additive ? (this.host.selection?.() ?? []) : [];
      const finalIds = [...new Set([...existing, ...hitIds])];
      if (this.host.selectVisuals) this.host.selectVisuals(finalIds);
      else if (finalIds.length > 0) this.host.select(finalIds[0]);
      else this.host.select(null);
    } else {
      if (!m.additive) this.host.select(null);
    }
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
