import { h } from '../render/svg';
import type { TooltipItem } from '../visuals/types';

export type TooltipRenderer = (items: TooltipItem[], title?: string) => HTMLElement | string;

/** One shared tooltip per report, positioned in viewport space and kept on-screen. */
export class Tooltip {
  private el: HTMLElement;
  renderer?: TooltipRenderer;

  constructor(parent: HTMLElement) {
    this.el = h('div', { class: 'pbi-tooltip', role: 'tooltip' });
    this.el.hidden = true;
    parent.append(this.el);
  }

  private parked: HTMLElement | null = null;

  /** Show an arbitrary element (e.g. a report-tooltip page) inside the tooltip. */
  showElement(node: HTMLElement, e: { clientX: number; clientY: number }): void {
    if (this.el.firstElementChild !== node) {
      this.park();
      this.el.replaceChildren(node);
      this.parked = node;
    }
    this.el.classList.add('is-page');
    this.el.hidden = false;
    this.move(e);
  }

  isShowingElement(node: HTMLElement): boolean {
    return !this.el.hidden && this.el.firstElementChild === node;
  }

  /** Keep the tooltip next to the pointer and on-screen. */
  move(e: { clientX: number; clientY: number }): void {
    const pad = 14;
    const w = this.el.offsetWidth;
    const hh = this.el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    if (x + w > vw - 4) x = e.clientX - w - pad;
    if (y + hh > vh - 4) y = e.clientY - hh - pad;
    this.el.style.left = `${Math.max(4, x)}px`;
    this.el.style.top = `${Math.max(4, y)}px`;
  }

  /** Detach a previously shown page element (it is re-attached on the next showElement). */
  private park(): void {
    if (this.parked) {
      this.parked.hidden = true;
      this.parked.remove();
      this.parked = null;
    }
    this.el.classList.remove('is-page');
  }

  show(e: { clientX: number; clientY: number }, items: TooltipItem[], title?: string): void {
    this.park();
    const custom = this.renderer?.(items, title);
    if (custom !== undefined) {
      if (typeof custom === 'string') this.el.innerHTML = custom;
      else this.el.replaceChildren(custom);
    } else {
      this.el.replaceChildren();
      if (title) this.el.append(h('div', { class: 'pbi-tooltip-title' }, title));
      for (const it of items)
        this.el.append(
          h(
            'div',
            { class: 'pbi-tooltip-row' },
            h('span', {}, it.color ? h('i', { class: 'pbi-swatch', style: `background:${it.color}` }) : null, it.label),
            h('b', {}, it.value),
          ),
        );
    }
    this.el.hidden = false;
    this.move(e);
  }

  hide(): void {
    this.el.hidden = true;
  }

  destroy(): void {
    this.el.remove();
  }
}
