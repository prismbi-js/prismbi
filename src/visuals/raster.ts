import { s } from '../render/svg';
import type { CellValue } from '../data/types';
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
}

/** `'auto'` (default): SVG, then canvas above {@link RASTER_MIN} marks. */
export type RasterRenderer = 'auto' | 'svg' | 'canvas';

/** Whether to paint `count` marks on a canvas for a `format.<visual>.renderer` setting. */
export function useRaster(ctx: RenderContext, visual: string, count: number): boolean {
  const r = ((ctx.format as unknown as Record<string, { renderer?: RasterRenderer } | undefined>)[visual]?.renderer ?? 'auto') as RasterRenderer;
  return r === 'canvas' || (r === 'auto' && count > RASTER_MIN);
}

/** A device-pixel canvas the size of the visual, absolutely positioned; null without a 2D context (headless exports). */
export function rasterCanvas(width: number, height: number): { canvas: HTMLCanvasElement; g2: CanvasRenderingContext2D } | null {
  const canvas = document.createElement('canvas');
  const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;pointer-events:none`;
  canvas.className = 'pbi-canvas';
  let g2: CanvasRenderingContext2D | null = null;
  try {
    g2 = canvas.getContext('2d');
  } catch {
    /* no 2D canvas */
  }
  if (!g2) return null;
  g2.scale(dpr, dpr);
  return { canvas, g2 };
}

/** Text painted over the rectangles (centred on x). */
export interface RasterLabel {
  x: number;
  y: number;
  text: string;
  fill: string;
}

/** Paint rectangles (rounded by `radius`) and labels; false when there is no 2D canvas, so the caller keeps its SVG. */
export function paintRects(ctx: RenderContext, svg: SVGSVGElement, rects: RasterRect[], width: number, height: number, radius: number, find: (x: number, y: number) => RasterMark | undefined, labels: RasterLabel[] = []): boolean {
  const c = rasterCanvas(width, height);
  if (!c) return false;
  const { g2 } = c;
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
  rasterOverlay(ctx, svg, svg, c.canvas, { x: 0, y: 0, w: width, h: height }, width, height, find);
  return true;
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
