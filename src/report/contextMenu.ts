import { h } from '../render/svg';

export interface MenuItem {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  /** Render a divider before this item. */
  separator?: boolean;
  /** Small trailing hint (e.g. target page). */
  hint?: string;
}

/** A small keyboard-accessible popup menu, positioned in viewport space. */
export class ContextMenu {
  private el: HTMLElement;
  private cleanup: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.el = h('div', { class: 'pbi-menu', role: 'menu' });
    this.el.hidden = true;
    parent.append(this.el);
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  show(x: number, y: number, items: MenuItem[]): void {
    this.hide();
    if (!items.length) return;
    // keyboard users get focus back where they were when the menu closes
    this.returnFocus = document.activeElement instanceof HTMLElement || document.activeElement instanceof SVGElement ? (document.activeElement as HTMLElement) : null;
    this.el.replaceChildren();
    for (const it of items) {
      if (it.separator) this.el.append(h('div', { class: 'pbi-menu-sep', role: 'separator' }));
      const b = h('button', { type: 'button', class: 'pbi-menu-item', role: 'menuitem', disabled: it.disabled }, h('span', {}, it.label), it.hint ? h('small', {}, it.hint) : null);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.hide();
        it.onClick?.();
      });
      this.el.append(b);
    }
    this.el.hidden = false;
    const w = this.el.offsetWidth;
    const hh = this.el.offsetHeight;
    this.el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - w - 4))}px`;
    this.el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - hh - 4))}px`;
    (this.el.querySelector('button:not([disabled])') as HTMLButtonElement | null)?.focus();

    const onDown = (e: MouseEvent) => !this.el.contains(e.target as Node) && this.hide();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.hide();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        const btns = [...this.el.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        const to = e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
        btns[to]?.focus();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        this.hide();
      }
    };
    const onScroll = () => this.hide();
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('blur', onScroll);
    this.cleanup = () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('blur', onScroll);
    };
  }

  private returnFocus: HTMLElement | null = null;

  hide(): void {
    const wasOpen = !this.el.hidden;
    this.el.hidden = true;
    this.cleanup?.();
    this.cleanup = null;
    const back = this.returnFocus;
    this.returnFocus = null;
    if (wasOpen && back?.isConnected && this.el.contains(document.activeElement)) back.focus();
  }

  destroy(): void {
    this.hide();
    this.el.remove();
  }
}
