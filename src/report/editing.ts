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
}

type Mode = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const HANDLES: Mode[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/**
 * Design-time layout editing: selection, drag to move, 8-way resize, all snapped to the page grid.
 * Visual content can't be interacted with while editing (an overlay captures the pointer).
 */
export class EditController {
  private drag: { id: string; mode: Mode; x: number; y: number; start: VisualLayout; current: VisualLayout; pointer: number } | null = null;

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
    const overlay = h('div', { class: 'pbi-edit', 'data-edit-for': id, tabindex: 0, role: 'button', 'aria-label': 'Select visual (drag to move)' });
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
    for (const [id, el] of p.visuals) el.toggleAttribute('data-selected', id === sel);
  }

  /** Draw the snapping grid on the page background. */
  paintGrid(): void {
    const p = this.host.page();
    if (!p) return;
    const { col, row } = this.steps(p);
    p.el.style.setProperty('--pbi-grid-col', `${col}px`);
    p.el.style.setProperty('--pbi-grid-row', `${row}px`);
  }

  private start(id: string, mode: Mode | undefined, e: PointerEvent): void {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    this.host.select(id);
    const p = this.host.page();
    const spec = p?.specs.find((s) => s.id === id);
    if (!p || !spec) return;
    const start = { ...(spec.layout ?? { x: 0, y: 0, w: 4, h: 6 }) };
    this.drag = { id, mode: mode ?? 'move', x: e.clientX, y: e.clientY, start, current: { ...start }, pointer: e.pointerId };
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
    const dc = Math.round((e.clientX - d.x) / col);
    const dr = Math.round((e.clientY - d.y) / row);
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
  }

  private end(_e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const p = this.host.page();
    p?.visuals.get(d.id)?.classList.remove('is-dragging');
    const c = d.current;
    const s = d.start;
    if (c.x !== s.x || c.y !== s.y || c.w !== s.w || c.h !== s.h) this.host.commitLayout(d.id, c);
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
