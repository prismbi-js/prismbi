import { s, measureText } from '../render/svg';
import { linearScale, logScale } from '../render/scales';
import { defineVisual } from './registry';
import { drawValueAxisY, emptyState, identityOf, interactive, markOpacity, renderLegend, valueAxisFormatter, withLegend } from './common';
import type { DataPointIdentity, RenderContext } from './types';
import type { CellValue } from '../data/types';
import { drawReferenceLines, linearFit } from './analytics';

/** Above this many points marks are painted on a canvas instead of one SVG element each... */
const CANVAS_MIN = 3000;
/** ...and above this many, with WebGL when available. */
const WEBGL_MIN = 50_000;

interface ScatterFormat {
  /** `'auto'` (default): SVG, then canvas above 3,000 points, then WebGL above 50,000. */
  renderer?: 'auto' | 'svg' | 'canvas' | 'webgl';
}

interface CanvasPoint {
  x: number;
  y: number;
  r: number;
  color: string;
  alpha: number;
  identity: DataPointIdentity;
  keys: CellValue[];
  tooltip: () => { title?: string; items: { label: string; value: string; color?: string }[] };
}

/** CSS colour to RGBA floats (hex, rgb/rgba, or anything the 2D canvas understands). */
const colorCache = new Map<string, [number, number, number, number]>();
function rgba(color: string): [number, number, number, number] {
  const hit = colorCache.get(color);
  if (hit) return hit;
  let c = color.trim();
  if (!/^#|^rgb/i.test(c)) {
    try {
      const probe = document.createElement('canvas').getContext('2d');
      if (probe) {
        probe.fillStyle = c;
        c = String(probe.fillStyle);
      }
    } catch {
      /* no 2D canvas */
    }
  }
  let out: [number, number, number, number] = [0.3, 0.45, 0.85, 1];
  const hex = /^#([0-9a-f]{3,8})$/i.exec(c)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((h) => h + h).join('') : hex;
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
    out = [n(0), n(2), n(4), full.length >= 8 ? n(6) : 1];
  } else {
    const m = /rgba?\(([^)]+)\)/i.exec(c);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      out = [p[0] / 255, p[1] / 255, p[2] / 255, p[3] ?? 1];
    }
  }
  colorCache.set(color, out);
  return out;
}

const VERTEX = `attribute vec2 a_pos; attribute float a_size; attribute vec4 a_color; uniform vec2 u_res; varying vec4 v_color;
void main() { vec2 p = a_pos / u_res * 2.0 - 1.0; gl_Position = vec4(p.x, -p.y, 0.0, 1.0); gl_PointSize = a_size; v_color = a_color; }`;
const FRAGMENT = `precision mediump float; varying vec4 v_color;
void main() { float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard; gl_FragColor = vec4(v_color.rgb, v_color.a * smoothstep(0.5, 0.4, d)); }`;

/** Draw points as round GL point sprites (one draw call). False when WebGL isn't available. */
function drawWebGL(canvas: HTMLCanvasElement, pts: CanvasPoint[], clip: { x: number; y: number; w: number; h: number }, height: number, dpr: number): boolean {
  let gl: WebGLRenderingContext | null = null;
  try {
    gl = canvas.getContext('webgl', { premultipliedAlpha: false, antialias: true, preserveDrawingBuffer: true }) as WebGLRenderingContext | null;
  } catch {
    gl = null;
  }
  if (!gl) return false;
  const shader = (type: number, src: string) => {
    const sh = gl!.createShader(type)!;
    gl!.shaderSource(sh, src);
    gl!.compileShader(sh);
    return sh;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
  gl.useProgram(prog);
  const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | null;
  const maxSize = range ? range[1] : 64;
  // interleaved x, y, size, r, g, b, a
  const data = new Float32Array(pts.length * 7);
  pts.forEach((p, i) => {
    const [r, g, b, a] = rgba(p.color);
    data.set([p.x * dpr, p.y * dpr, Math.min(maxSize, (p.r * 2 + 1) * dpr), r, g, b, a * p.alpha], i * 7);
  });
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const attr = (name: string, size: number, offset: number) => {
    const loc = gl!.getAttribLocation(prog, name);
    gl!.enableVertexAttribArray(loc);
    gl!.vertexAttribPointer(loc, size, gl!.FLOAT, false, 28, offset * 4);
  };
  attr('a_pos', 2, 0);
  attr('a_size', 1, 2);
  attr('a_color', 4, 3);
  gl.uniform2f(gl.getUniformLocation(prog, 'u_res'), canvas.width, canvas.height);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(Math.round(clip.x * dpr), Math.round((height - clip.y - clip.h) * dpr), Math.round(clip.w * dpr), Math.round(clip.h * dpr));
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.POINTS, 0, pts.length);
  return true;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

/**
 * Paint points on a canvas laid over the SVG axes; a grid index finds the point under the pointer so tooltips,
 * selection, the context menu and drill keep working.
 */
function paintCanvas(ctx: RenderContext, svg: SVGSVGElement, hitLayer: SVGGElement, pts: CanvasPoint[], clip: { x: number; y: number; w: number; h: number }, width: number, height: number, webgl = false): boolean {
  const canvas = document.createElement('canvas');
  const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;pointer-events:none`;
  const gl = webgl && drawWebGL(canvas, pts, clip, height, dpr);
  canvas.className = gl ? 'pbi-canvas pbi-webgl' : 'pbi-canvas';
  if (!gl && !paint2d(ctx, canvas, pts, clip, dpr)) return false;
  return overlay(ctx, svg, hitLayer, canvas, pts, clip, width, height);
}

function paint2d(ctx: RenderContext, canvas: HTMLCanvasElement, pts: CanvasPoint[], clip: { x: number; y: number; w: number; h: number }, dpr: number): boolean {
  const g2 = context2d(canvas);
  if (!g2) return false;
  g2.scale(dpr, dpr);
  g2.beginPath();
  g2.rect(clip.x, clip.y, clip.w, clip.h);
  g2.clip();
  const stroke = ctx.theme.surface;
  for (const p of pts) {
    g2.globalAlpha = p.alpha;
    g2.beginPath();
    g2.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    g2.fillStyle = p.color;
    g2.fill();
    if (p.r >= 3) {
      g2.lineWidth = 1;
      g2.strokeStyle = stroke;
      g2.stroke();
    }
  }
  return true;
}

/** Lay the canvas over the SVG axes, with a grid index so tooltips, selection, the context menu and drill work. */
function overlay(ctx: RenderContext, svg: SVGSVGElement, hitLayer: SVGGElement, canvas: HTMLCanvasElement, pts: CanvasPoint[], clip: { x: number; y: number; w: number; h: number }, width: number, height: number): boolean {
  const wrap = document.createElement('div');
  wrap.style.cssText = `position:relative;width:${width}px;height:${height}px`;
  svg.style.display = 'block';
  svg.replaceWith(wrap);
  wrap.append(svg, canvas);

  // spatial grid for hit testing
  const cell = 24;
  const grid = new Map<number, number[]>();
  const keyOf = (cx: number, cy: number) => cx * 100_003 + cy;
  pts.forEach((p, i) => {
    const k = keyOf(Math.floor(p.x / cell), Math.floor(p.y / cell));
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  });
  const nearest = (x: number, y: number): CanvasPoint | undefined => {
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    let best: CanvasPoint | undefined;
    let bestD = Infinity;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const i of grid.get(keyOf(cx + dx, cy + dy)) ?? []) {
          const p = pts[i];
          const d = Math.hypot(p.x - x, p.y - y);
          // later points are painted on top: prefer them on ties
          if (d <= Math.max(p.r, 4) + 3 && d <= bestD) {
            best = p;
            bestD = d;
          }
        }
    return best;
  };
  const hit = s('rect', { x: clip.x, y: clip.y, width: Math.max(0, clip.w), height: Math.max(0, clip.h), fill: 'transparent', class: 'pbi-hit' });
  hitLayer.append(hit);
  const at = (e: MouseEvent) => {
    const r = svg.getBoundingClientRect();
    return nearest(((e.clientX - r.left) * width) / (r.width || width), ((e.clientY - r.top) * height) / (r.height || height));
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
  return true;
}

export const scatter = /* @__PURE__ */ defineVisual({
  type: 'scatter',
  displayName: 'Scatter chart',
  category: 'chart',
  roles: [
    { name: 'details', displayName: 'Values (points)', kind: 'grouping', multiple: true, required: true },
    { name: 'legend', displayName: 'Legend', kind: 'grouping' },
    { name: 'x', displayName: 'X-axis', kind: 'measure', required: true },
    { name: 'y', displayName: 'Y-axis', kind: 'measure', required: true },
    { name: 'size', displayName: 'Size', kind: 'measure' },
  ],
  supportsHighlight: true,
  render(ctx) {
    const d = ctx.role('details');
    const l = ctx.role('legend');
    const xi = ctx.role('x').indices[0];
    const yi = ctx.role('y').indices[0];
    const si = ctx.role('size').indices[0];
    if (xi === undefined || yi === undefined) return emptyState(ctx, 'Add X and Y measures');
    const rows = ctx.data.rows.filter((r) => typeof r.values[xi] === 'number' && typeof r.values[yi] === 'number');
    if (!rows.length) return emptyState(ctx);
    const t = ctx.theme;
    const fs = t.labelFontSize;
    const dFields = d.indices.map((i) => ctx.data.groups[i]);
    const lField = l.indices.length ? ctx.data.groups[l.indices[0]] : undefined;
    const xField = ctx.data.values[xi];
    const yField = ctx.data.values[yi];
    const sField = si !== undefined ? ctx.data.values[si] : undefined;

    const legendItems = new Map<unknown, { name: string; color: string; identity: DataPointIdentity }>();
    if (lField)
      for (const r of rows) {
        const v = r.keys[l.indices[0]];
        if (!legendItems.has(v)) legendItems.set(v, { name: ctx.fmt(lField, v), color: ctx.colorFor(lField, v), identity: identityOf([lField], [v]) });
      }
    // legend follows the colour (domain) order, not the order rows happen to arrive in
    const domainPos = (v: unknown) => (lField?.column ? ctx.model.table(lField.column.table).distinct(lField.column.column).findIndex((d) => d === v || (d instanceof Date && v instanceof Date && d.getTime() === v.getTime())) : 0);
    const legendSorted = [...legendItems.entries()].sort((a, b) => domainPos(a[0]) - domainPos(b[0])).map((e) => e[1]);
    const legend = renderLegend(ctx, legendSorted.map((x) => ({ ...x, shape: 'dot' as const })));
    const { plot, width, height } = withLegend(ctx, legend);

    const xs = rows.map((r) => r.values[xi] as number);
    const ys = rows.map((r) => r.values[yi] as number);
    const sizes = sField ? rows.map((r) => Math.max(0, (r.values[si!] as number) ?? 0)) : [];
    const maxSize = Math.max(1, ...sizes);
    const yScale0 = linearScale(Math.min(...ys), Math.max(...ys), [height - 30, 10], { includeZero: false });
    const fmtY = valueAxisFormatter(ctx, yField, yScale0);
    const left = Math.ceil(Math.max(...yScale0.ticks.map((v) => measureText(fmtY(v), fs, t.fontFamily)))) + 12;
    const bottom = height - fs - 22;
    const logX = ctx.format.categoryAxis.scale === 'log' && xs.every((v) => v > 0);
    const logY = ctx.format.valueAxis.scale === 'log' && ys.every((v) => v > 0);
    // inset the plot by the largest bubble so marks never spill over the axes
    const maxR = sField ? Math.min(28, width / 18, height / 10) + 4 : 7;
    const xr: [number, number] = [left + maxR, width - maxR];
    const yr: [number, number] = [bottom - maxR, Math.max(10, maxR)];
    const x = logX ? logScale(Math.min(...xs), Math.max(...xs), xr) : linearScale(Math.min(...xs), Math.max(...xs), xr, { includeZero: false, tickCount: Math.max(2, Math.floor(width / 90)) });
    const y = logY ? logScale(Math.min(...ys), Math.max(...ys), yr) : linearScale(Math.min(...ys), Math.max(...ys), yr, { includeZero: false, tickCount: Math.max(2, Math.floor(height / 45)) });
    const svg = s('svg', { width, height, class: 'pbi-svg', role: 'img', 'aria-label': ctx.spec.title ?? 'Scatter chart' });
    plot.append(svg);
    const g = s('g');
    svg.append(g);
    drawValueAxisY(ctx, g, y, left, width - 8, valueAxisFormatter(ctx, yField, y));
    const fmtX = valueAxisFormatter(ctx, xField, x);
    for (const tick of x.ticks) g.append(s('text', { x: x(tick), y: bottom + fs + 4, 'text-anchor': 'middle', class: 'pbi-tick', fill: t.foregroundMuted }, fmtX(tick)));
    g.append(s('text', { x: (left + width) / 2, y: height - 4, 'text-anchor': 'middle', class: 'pbi-axis-title', fill: t.foregroundSecondary }, xField.name));

    drawReferenceLines(ctx, g, y, 'y', [left, width - 8], ys, yField);
    const fit = ctx.format.analytics.trendLine ? linearFit(xs.map((v, i) => [v, ys[i]] as [number, number])) : null;
    if (fit) {
      const [x0, x1] = x.domain;
      const tl = ctx.format.analytics.trendLine;
      g.append(s('line', { x1: x(x0), x2: x(x1), y1: y(fit.intercept + fit.slope * x0), y2: y(fit.intercept + fit.slope * x1), stroke: (typeof tl === 'object' && tl.color) || t.foregroundSecondary, 'stroke-width': 1.5, 'stroke-dasharray': '6 4', class: 'pbi-trend', 'pointer-events': 'none' }));
    }
    const clipId = `pbi-clip-${Math.random().toString(36).slice(2, 9)}`;
    const defs = s('defs');
    const clip = s('clipPath', { id: clipId });
    clip.append(s('rect', { x: left, y: 0, width: Math.max(0, width - left), height: Math.max(0, bottom) }));
    defs.append(clip);
    svg.append(defs);
    const marks = s('g', { 'clip-path': `url(#${clipId})` });
    g.append(marks);
    // draw bigger bubbles first so small ones stay clickable
    const order = rows.map((_, i) => i).sort((a, b) => (sizes[b] ?? 0) - (sizes[a] ?? 0));
    const tooltipFor = (i: number, keys: CellValue[], color: string) => () => ({
      title: keys.map((k, j) => ctx.fmt(dFields[j], k)).join(' · '),
      items: [
        { label: xField.name, value: ctx.fmt(xField, xs[i]) },
        { label: yField.name, value: ctx.fmt(yField, ys[i]) },
        ...(sField ? [{ label: sField.name, value: ctx.fmt(sField, rows[i].values[si!]) }] : []),
        ...(lField ? [{ label: lField.name, value: ctx.fmt(lField, rows[i].keys[l.indices[0]]), color }] : []),
      ],
    });
    const renderer = ((ctx.format as { scatter?: ScatterFormat }).scatter?.renderer ?? 'auto') as NonNullable<ScatterFormat['renderer']>;
    const raster = renderer === 'canvas' || renderer === 'webgl' || (renderer === 'auto' && rows.length > CANVAS_MIN);
    if (raster) {
      const pts: CanvasPoint[] = order.map((i) => {
        const r = rows[i];
        const color = lField ? ctx.colorFor(lField, r.keys[l.indices[0]]) : ctx.format.colors.default ?? t.dataColors[0];
        const keys = d.indices.map((k) => r.keys[k]);
        const identity = identityOf(dFields, keys);
        const dimmed = r.highlights ? r.highlights[yi] === null || r.highlights[xi] === null : false;
        // dense clouds use small dots; bubbles keep their area encoding
        const radius = sField ? 2 + Math.sqrt(sizes[i] / maxSize) * (maxR - 6) : 2.5;
        return { x: x(xs[i]), y: y(ys[i]), r: radius, color, alpha: (dimmed ? 0.25 : markOpacity(ctx, identity)) * (sField ? 0.7 : 0.85), identity, keys, tooltip: tooltipFor(i, keys, color) };
      });
      const webgl = renderer === 'webgl' || (renderer === 'auto' && rows.length >= WEBGL_MIN);
      if (paintCanvas(ctx, svg, g, pts, { x: left, y: 0, w: width - left, h: bottom }, width, height, webgl)) return;
    }
    for (const i of order) {
      const r = rows[i];
      const color = lField ? ctx.colorFor(lField, r.keys[l.indices[0]]) : ctx.format.colors.default ?? t.dataColors[0];
      const radius = sField ? 4 + Math.sqrt(sizes[i] / maxSize) * (maxR - 8) : 5;
      const keys = d.indices.map((k) => r.keys[k]);
      const identity = identityOf(dFields, keys);
      // highlighted points keep full strength; the rest fade (cross-highlight from other visuals)
      const dimmed = r.highlights ? r.highlights[yi] === null || r.highlights[xi] === null : false;
      const c = s('circle', { cx: x(xs[i]), cy: y(ys[i]), r: radius, fill: color, 'fill-opacity': sField ? 0.7 : 1, stroke: t.surface, 'stroke-width': sField ? 1 : 2, opacity: dimmed ? 0.25 : markOpacity(ctx, identity) });
      interactive(ctx, c, identity, tooltipFor(i, keys, color), keys);
      marks.append(c);
    }
  },
});
