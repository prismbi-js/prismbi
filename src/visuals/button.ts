import { h, s } from '../render/svg';
import { defineVisual } from './registry';
import type { RenderContext } from './types';

export interface ButtonAction {
  type: 'drillthrough' | 'page' | 'bookmark' | 'back' | 'clearFilters' | 'export' | 'url';
  destination?: string;
  exportFormat?: 'pdf' | 'xlsx' | 'pptx' | 'image' | 'csv';
  url?: string;
  tooltip?: string;
  disabledTooltip?: string;
}

export interface ButtonFormat {
  text?: string;
  icon?: 'arrow-left' | 'arrow-right' | 'back' | 'reset' | 'bookmark' | 'export' | 'link' | 'info' | 'help' | 'none';
  iconPosition?: 'left' | 'right';
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost';
  action?: ButtonAction;
  fill?: string;
  color?: string;
  hoverFill?: string;
  hoverColor?: string;
  border?: string;
  borderRadius?: number;
  fontSize?: number;
  fontWeight?: string | number;
  align?: 'left' | 'center' | 'right';
}

const ICON_PATHS: Record<string, string> = {
  back: 'M19 12H5M12 19l-7-7 7-7',
  'arrow-left': 'M19 12H5M12 19l-7-7 7-7',
  'arrow-right': 'M5 12h14M12 5l7 7-7 7',
  reset: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5',
  bookmark: 'M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z',
  export: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  link: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  help: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01',
};

function renderIcon(name: string): SVGElement | null {
  const d = ICON_PATHS[name];
  if (!d) return null;
  const svg = s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  for (const part of d.split(/(?=M)/)) {
    if (part.trim()) svg.append(s('path', { d: part.trim() }));
  }
  return svg;
}

export const actionButton = /* @__PURE__ */ defineVisual({
  type: 'button',
  displayName: 'Button',
  category: 'other',
  roles: [],
  defaultFormat: {
    header: { show: false },
    title: { show: false },
    border: { show: false },
    background: { show: false },
  },
  render(ctx: RenderContext) {
    const fmt = (ctx.format.button as ButtonFormat | undefined) ?? {};
    const act = fmt.action ?? { type: 'page' };
    const text = fmt.text ?? (act.type === 'back' ? 'Back' : act.type === 'drillthrough' ? 'Drill through' : act.type === 'clearFilters' ? 'Reset filters' : act.type === 'export' ? 'Export' : 'Button');
    const variant = fmt.variant ?? (act.type === 'drillthrough' ? 'primary' : 'secondary');

    const btn = h('button', {
      type: 'button',
      class: `pbi-action-btn is-${variant}`,
      'aria-label': text,
    });

    // Check drill-through availability
    let disabled = false;
    let tooltip = act.tooltip;
    if (act.type === 'drillthrough' && act.destination) {
      const dt = ctx.host.canDrillThrough?.(act.destination) ?? { canDrill: false };
      const dest = dt.destinationName || act.destination;
      if (!dt.canDrill) {
        disabled = true;
        btn.disabled = true;
        btn.setAttribute('aria-disabled', 'true');
        tooltip = act.disabledTooltip ?? `Select a data point to drill through to ${dest}`;
      } else {
        tooltip = act.tooltip ?? `Drill through to ${dest}`;
      }
    }

    if (tooltip) btn.title = tooltip;

    // Custom inline styles if specified in format
    if (fmt.fill) btn.style.backgroundColor = fmt.fill;
    if (fmt.color) btn.style.color = fmt.color;
    if (fmt.border) btn.style.border = fmt.border;
    if (fmt.borderRadius !== undefined) btn.style.borderRadius = `${fmt.borderRadius}px`;
    if (fmt.fontSize) btn.style.fontSize = `${fmt.fontSize}px`;
    if (fmt.fontWeight) btn.style.fontWeight = String(fmt.fontWeight);
    if (fmt.align) btn.style.justifyContent = fmt.align === 'left' ? 'flex-start' : fmt.align === 'right' ? 'flex-end' : 'center';

    const iconName = fmt.icon ?? (act.type === 'back' ? 'back' : act.type === 'clearFilters' ? 'reset' : act.type === 'export' ? 'export' : act.type === 'url' ? 'link' : 'none');
    const iconEl = iconName !== 'none' ? renderIcon(iconName) : null;
    const textEl = h('span', { class: 'pbi-action-btn-text' }, text);

    if (iconEl && fmt.iconPosition === 'right') {
      btn.append(textEl, iconEl);
    } else if (iconEl) {
      btn.append(iconEl, textEl);
    } else {
      btn.append(textEl);
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (disabled) return;
      ctx.host.triggerAction?.(act);
    });

    const wrap = h('div', { class: 'pbi-action-btn-wrap', style: 'width:100%;height:100%;display:flex;align-items:center;justify-content:center' }, btn);
    ctx.root.replaceChildren(wrap);
  },
});

