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

  show(e: { clientX: number; clientY: number }, items: TooltipItem[], title?: string): void {
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

  hide(): void {
    this.el.hidden = true;
  }

  destroy(): void {
    this.el.remove();
  }
}
