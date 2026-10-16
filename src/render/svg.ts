export const SVG_NS = 'http://www.w3.org/2000/svg';

type Attrs = Record<string, string | number | boolean | undefined | null>;

/** Create an SVG element with attributes (undefined/null/false are skipped). */
export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, text?: string | number): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = String(text);
  return e;
}

/** Create an HTML element. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs & { class?: string; style?: string } = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) e.setAttribute(k, String(v));
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

export function svgRoot(width: number, height: number, label?: string): SVGSVGElement {
  return s('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': label, class: 'pbi-svg' });
}

/** Rect with rounded data-end only (square at the baseline). `end`: which side carries the value. */
export function barPath(x: number, y: number, w: number, hgt: number, r: number, end: 'top' | 'bottom' | 'right' | 'left'): string {
  if (w <= 0 || hgt <= 0) return '';
  const rr = Math.max(0, Math.min(r, end === 'top' || end === 'bottom' ? Math.min(w / 2, hgt) : Math.min(hgt / 2, w)));
  if (rr === 0) return `M${x},${y}h${w}v${hgt}h${-w}Z`;
  switch (end) {
    case 'top':
      return `M${x},${y + hgt}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + hgt}Z`;
    case 'bottom':
      return `M${x},${y}V${y + hgt - rr}Q${x},${y + hgt} ${x + rr},${y + hgt}H${x + w - rr}Q${x + w},${y + hgt} ${x + w},${y + hgt - rr}V${y}Z`;
    case 'right':
      return `M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + hgt - rr}Q${x + w},${y + hgt} ${x + w - rr},${y + hgt}H${x}Z`;
    case 'left':
      return `M${x + w},${y}H${x + rr}Q${x},${y} ${x},${y + rr}V${y + hgt - rr}Q${x},${y + hgt} ${x + rr},${y + hgt}H${x + w}Z`;
  }
}

/** Arc segment path for pie/donut/gauge. Angles in radians, 0 = 12 o'clock, clockwise. */
export function arcPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const p = (r: number, a: number) => `${(cx + r * Math.sin(a)).toFixed(2)},${(cy - r * Math.cos(a)).toFixed(2)}`;
  const sweep = a1 - a0;
  if (sweep >= Math.PI * 2 - 1e-6) {
    // full ring: two halves
    const m = a0 + Math.PI;
    return `${arcPath(cx, cy, r0, r1, a0, m)} ${arcPath(cx, cy, r0, r1, m, a1 - 1e-6)}`;
  }
  const large = sweep > Math.PI ? 1 : 0;
  if (r0 <= 0) return `M${cx},${cy}L${p(r1, a0)}A${r1},${r1} 0 ${large} 1 ${p(r1, a1)}Z`;
  return `M${p(r1, a0)}A${r1},${r1} 0 ${large} 1 ${p(r1, a1)}L${p(r0, a1)}A${r0},${r0} 0 ${large} 0 ${p(r0, a0)}Z`;
}

let canvas: HTMLCanvasElement | null = null;

/** Measure text width (falls back to an estimate where canvas is unavailable, e.g. jsdom). */
export function measureText(text: string, fontSize: number, fontFamily = 'system-ui, sans-serif', weight = 400): number {
  try {
    if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) throw 0;
    canvas ??= document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.font = `${weight} ${fontSize}px ${fontFamily}`;
      const w = ctx.measureText(text).width;
      if (w > 0) return w;
    }
  } catch {
    /* ignore */
  }
  return text.length * fontSize * 0.56;
}

/** Truncate with ellipsis to fit `maxWidth`. */
export function fitText(text: string, maxWidth: number, fontSize: number, fontFamily?: string): string {
  if (measureText(text, fontSize, fontFamily) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measureText(text.slice(0, mid) + '…', fontSize, fontFamily) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo <= 0 ? '' : text.slice(0, lo) + '…';
}
