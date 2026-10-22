import { s } from '../render/svg';
import type { CellValue } from '../data/types';
import { interactive } from './common';
import type { DataPointIdentity, RenderContext } from './types';

/** Above this many marks, grid visuals (heatmap, calendar) paint on a canvas instead of one SVG element each. */
export const RASTER_MIN = 3000;

/** What a painted mark answers to: tooltips, selection, the context menu and drill. */
export interface RasterMark {
  identity: DataPointIdentity;
  keys: CellValue[];
  tooltip: () => { title?: string; items: { label: string; value: string; color?: string }[] };
}

export interface RasterRect extends RasterMark {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  alpha: number;
  /** Painted but not a data point (an empty calendar day). */
  inert?: boolean;
}

/** `'auto'` (default): SVG, then canvas above {@link RASTER_MIN} marks. */
export type RasterRenderer = 'auto' | 'svg' | 'canvas';

/** Whether to paint `count` marks on a canvas for a `format.<visual>.renderer` setting. */
export function useRaster(ctx: RenderContext, visual: string, count: number): boolean {
  const r = ((ctx.format as unknown as Record<string, { renderer?: RasterRenderer } | undefined>)[visual]?.renderer ?? 'auto') as RasterRenderer;
  return r === 'canvas' || (r === 'auto' && count > RASTER_MIN);
}

/** A device-pixel canvas the size of the visual, absolutely positioned over it. */
export function sizedCanvas(width: number, height: number): { canvas: HTMLCanvasElement; dpr: number } {
  const canvas = document.createElement('canvas');
  const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;pointer-events:none`;
  canvas.className = 'pbi-canvas';
  return { canvas, dpr };
}

/** The canvas's 2D context, or null where there is none (headless exports, jsdom). */
export function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

/** Text painted over the rectangles (centred on x). */
export interface RasterLabel {
  x: number;
  y: number;
  text: string;
  fill: string;
}

/**
 * Paint rectangles (rounded by `radius`) and labels on a canvas over `svg`. Without a 2D canvas (headless exports)
 * they become SVG elements instead, before any `<defs>`.
 */
export function paintRects(ctx: RenderContext, svg: SVGSVGElement, rects: RasterRect[], width: number, height: number, radius: number, find: (x: number, y: number) => RasterMark | undefined, labels: RasterLabel[] = []): void {
  const { canvas, dpr } = sizedCanvas(width, height);
  const g2 = context2d(canvas);
  if (!g2) {
    const before = svg.querySelector('defs');
    for (const r of rects) {
      const el = s('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: radius, fill: r.fill, opacity: r.alpha });
      if (!r.inert) interactive(ctx, el, r.identity, r.tooltip, r.keys);
      svg.insertBefore(el, before);
    }
    for (const l of labels) svg.insertBefore(s('text', { x: l.x, y: l.y, 'text-anchor': 'middle', class: 'pbi-label', fill: l.fill }, l.text), before);
    return;
  }
  g2.scale(dpr, dpr);
  const rounded = radius > 0 && typeof g2.roundRect === 'function';
  for (const r of rects) {
    g2.globalAlpha = r.alpha;
    g2.fillStyle = r.fill;
    if (rounded) {
      g2.beginPath();
      g2.roundRect(r.x, r.y, r.w, r.h, radius);
      g2.fill();
    } else g2.fillRect(r.x, r.y, r.w, r.h);
  }
  g2.globalAlpha = 1;
  g2.font = `${ctx.theme.labelFontSize}px ${ctx.theme.fontFamily}`;
  g2.textAlign = 'center';
  for (const l of labels) {
    g2.fillStyle = l.fill;
    g2.fillText(l.text, l.x, l.y);
  }
  rasterOverlay(ctx, svg, svg, canvas, { x: 0, y: 0, w: width, h: height }, width, height, find);
}

/**
 * Lay a painted canvas over the SVG (axes, labels), with a transparent hit rectangle whose pointer events go to
 * `find`, so tooltips, selection, the context menu and drill keep working.
 */
export function rasterOverlay(ctx: RenderContext, svg: SVGSVGElement, hitLayer: Element, canvas: HTMLCanvasElement, clip: { x: number; y: number; w: number; h: number }, width: number, height: number, find: (x: number, y: number) => RasterMark | undefined): void {
  const wrap = document.createElement('div');
  wrap.style.cssText = `position:relative;width:${width}px;height:${height}px`;
  svg.style.display = 'block';
  if (svg.parentNode) svg.replaceWith(wrap);
  wrap.append(svg, canvas);
  if (!wrap.parentNode) ctx.root.replaceChildren(wrap);

  const hit = s('rect', { x: clip.x, y: clip.y, width: Math.max(0, clip.w), height: Math.max(0, clip.h), fill: 'transparent', class: 'pbi-hit' });
  hitLayer.append(hit);
  const at = (e: MouseEvent) => {
    const r = svg.getBoundingClientRect();
    return find(((e.clientX - r.left) * width) / (r.width || width), ((e.clientY - r.top) * height) / (r.height || height));
  };
  hit.addEventListener('mousemove', (e) => {
    const p = at(e);
    (hit as SVGElement).style.cursor = p ? 'pointer' : '';
    if (!p) return ctx.host.hideTooltip();
    if (ctx.format.tooltip.show) {
      const t = p.tooltip();
      ctx.host.showTooltip(e, t.items, t.title, p.identity);
    }
  });
  hit.addEventListener('mouseleave', () => ctx.host.hideTooltip());
  hit.addEventListener('click', (e) => {
    const p = at(e);
    if (!p) return;
    e.stopPropagation();
    ctx.host.select(p.identity, { multi: e.ctrlKey || e.metaKey });
    ctx.host.emit('dataPointClick', { keys: p.keys, identity: p.identity, event: e });
  });
  hit.addEventListener('contextmenu', (e) => {
    const p = at(e);
    if (!p) return;
    e.preventDefault();
    e.stopPropagation();
    ctx.host.contextMenu(e, p.identity);
  });
  hit.addEventListener('dblclick', (e) => {
    const p = at(e);
    if (p && ctx.host.drill.levels > 1 && ctx.host.drill.level < ctx.host.drill.levels - 1) ctx.host.drillDown(p.keys[p.keys.length - 1]);
  });
}
