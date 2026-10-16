import { s, measureText } from '../render/svg';
import { ramp } from '../render/color';
import type { CellValue } from '../data/types';
import { isColumnRefString, valueKey } from '../data/types';
import type { FieldSpec } from '../data/query';
import { defineVisual } from './registry';
import { emptyState, identityOf, interactive, markOpacity, renderLegend, withLegend } from './common';
import { hasValueColors, valueColor } from './analytics';
import type { RenderContext } from './types';

type Position = [number, number];
interface Geometry {
  type: 'Polygon' | 'MultiPolygon' | 'Point' | 'MultiPoint' | 'LineString' | 'MultiLineString';
  coordinates: unknown;
}
export interface GeoFeature {
  type: 'Feature';
  properties?: Record<string, unknown> | null;
  geometry: Geometry | null;
  id?: string | number;
}
export interface GeoFeatureCollection {
  type: 'FeatureCollection';
  features: GeoFeature[];
}

export interface MapFormat {
  /** Basemap / regions as GeoJSON (required for filled maps). */
  geojson?: GeoFeatureCollection;
  /** Property used to match the location field to features (default "name"). */
  featureKey?: string;
  /** Raster tile template, e.g. "https://tile.example.com/{z}/{x}/{y}.png". Mind the provider's terms. */
  tiles?: string;
  /** Tile attribution text shown bottom-right. */
  attribution?: string;
  /** Maximum bubble radius in px (default 28). */
  maxRadius?: number;
  /** Mouse-wheel zoom and drag-to-pan (default true). */
  zoom?: boolean;
  /** Draw a latitude/longitude grid when no geojson or tiles are given (default true). */
  graticule?: boolean;
}

// ------------------------------------------------------------------ projection

const toMerc = ([lon, lat]: Position): Position => {
  const φ = Math.max(-85.05, Math.min(85.05, lat)) * (Math.PI / 180);
  return [lon * (Math.PI / 180), Math.log(Math.tan(Math.PI / 4 + φ / 2))];
};

interface Projection {
  (p: Position): Position;
  k: number;
  tx: number;
  ty: number;
}

/** Fit Web Mercator to a set of lon/lat positions inside a box. */
function fitProjection(points: Position[], width: number, height: number, pad = 24): Projection {
  const m = points.map(toMerc);
  let x0 = Math.min(...m.map((p) => p[0]));
  let x1 = Math.max(...m.map((p) => p[0]));
  let y0 = Math.min(...m.map((p) => p[1]));
  let y1 = Math.max(...m.map((p) => p[1]));
  if (x1 - x0 < 1e-3) (x0 -= 0.05), (x1 += 0.05);
  if (y1 - y0 < 1e-3) (y0 -= 0.05), (y1 += 0.05);
  const k = Math.min((width - pad * 2) / (x1 - x0), (height - pad * 2) / (y1 - y0));
  const tx = width / 2 - ((x0 + x1) / 2) * k;
  const ty = height / 2 + ((y0 + y1) / 2) * k;
  const f = ((p: Position) => {
    const [x, y] = toMerc(p);
    return [tx + x * k, ty - y * k] as Position;
  }) as Projection;
  f.k = k;
  f.tx = tx;
  f.ty = ty;
  return f;
}

function rings(g: Geometry | null): Position[][] {
  if (!g) return [];
  if (g.type === 'Polygon') return g.coordinates as Position[][];
  if (g.type === 'MultiPolygon') return (g.coordinates as Position[][][]).flat();
  if (g.type === 'LineString') return [g.coordinates as Position[]];
  if (g.type === 'MultiLineString') return g.coordinates as Position[][];
  return [];
}

function pathOf(g: Geometry | null, proj: Projection): string {
  const closed = g?.type === 'Polygon' || g?.type === 'MultiPolygon';
  return rings(g)
    .map((r) => 'M' + r.map((p) => proj(p).map((v) => v.toFixed(1)).join(',')).join('L') + (closed ? 'Z' : ''))
    .join('');
}

function allPositions(fc?: GeoFeatureCollection): Position[] {
  return (fc?.features ?? []).flatMap((f) => rings(f.geometry).flat());
}

/** Draw raster tiles under the projection (standard XYZ / slippy-map tiles). */
function drawTiles(g: SVGGElement, template: string, proj: Projection, width: number, height: number): void {
  const z = Math.max(0, Math.min(19, Math.round(Math.log2((proj.k * 2 * Math.PI) / 256))));
  const n = 2 ** z;
  const world = (proj.k * 2 * Math.PI) / n; // px per tile at this projection scale
  // mercator x in [-π, π] → tile index
  const tileX = (px: number) => Math.floor((((px - proj.tx) / proj.k + Math.PI) / (2 * Math.PI)) * n);
  const tileY = (py: number) => Math.floor(((Math.PI - (proj.ty - py) / proj.k) / (2 * Math.PI)) * n);
  const xa = Math.max(0, tileX(0));
  const xb = Math.min(n - 1, tileX(width));
  const ya = Math.max(0, tileY(0));
  const yb = Math.min(n - 1, tileY(height));
  if ((xb - xa + 1) * (yb - ya + 1) > 64) return;
  for (let x = xa; x <= xb; x++)
    for (let y = ya; y <= yb; y++) {
      const px = proj.tx + ((x / n) * 2 * Math.PI - Math.PI) * proj.k;
      const py = proj.ty - (Math.PI - (y / n) * 2 * Math.PI) * proj.k;
      const href = template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
      g.append(s('image', { href, x: px, y: py, width: world + 0.5, height: world + 0.5, preserveAspectRatio: 'none', 'pointer-events': 'none' }));
    }
}

/** Wheel zoom + drag pan on a group (view kept in transient visual state). */
function enableZoom(ctx: RenderContext, svg: SVGSVGElement, g: SVGGElement): void {
  const st = ctx.host.state as { _view?: { k: number; x: number; y: number } };
  let view = st._view ?? { k: 1, x: 0, y: 0 };
  const apply = () => g.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
  apply();
  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const k = Math.max(1, Math.min(16, view.k * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      view = { k, x: mx - ((mx - view.x) * k) / view.k, y: my - ((my - view.y) * k) / view.k };
      st._view = view;
      apply();
    },
    { passive: false },
  );
  let drag: { x: number; y: number } | null = null;
  svg.addEventListener('pointerdown', (e) => {
    if ((e.target as Element).classList.contains('pbi-mark')) return;
    drag = { x: e.clientX - view.x, y: e.clientY - view.y };
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    view = { ...view, x: e.clientX - drag.x, y: e.clientY - drag.y };
    st._view = view;
    apply();
  });
  const end = () => (drag = null);
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointerleave', end);
  svg.addEventListener('dblclick', () => {
    view = { k: 1, x: 0, y: 0 };
    st._view = view;
    apply();
  });
}

function basemap(ctx: RenderContext, g: SVGGElement, mf: MapFormat, proj: Projection, W: number, H: number): void {
  if (mf.tiles) drawTiles(g, mf.tiles, proj, W, H);
  if (!mf.tiles && !mf.geojson && mf.graticule !== false) {
    // no basemap supplied: a light 15-degree latitude/longitude grid keeps points oriented
    const stroke = ctx.theme.gridline;
    for (let lon = -180; lon <= 180; lon += 15) {
      const [x] = proj([lon, 0]);
      if (x >= -1 && x <= W + 1) g.append(s('line', { x1: x, x2: x, y1: 0, y2: H, stroke, 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' }));
    }
    for (let lat = -75; lat <= 75; lat += 15) {
      const [, y] = proj([0, lat]);
      if (y >= -1 && y <= H + 1) g.append(s('line', { x1: 0, x2: W, y1: y, y2: y, stroke, 'stroke-width': lat === 0 ? 1.5 : 1, 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' }));
    }
  }
  for (const f of mf.geojson?.features ?? []) g.append(s('path', { d: pathOf(f.geometry, proj), fill: mf.tiles ? 'none' : ctx.theme.gridline, stroke: ctx.theme.surface, 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' }));
}

function attribution(svg: SVGSVGElement, ctx: RenderContext, mf: MapFormat, W: number, H: number): void {
  if (!mf.attribution) return;
  const w = measureText(mf.attribution, 10, ctx.theme.fontFamily) + 8;
  svg.append(s('rect', { x: W - w, y: H - 16, width: w, height: 16, fill: ctx.theme.surface, opacity: 0.8 }));
  svg.append(s('text', { x: W - 4, y: H - 5, 'text-anchor': 'end', 'font-size': 10, fill: ctx.theme.foregroundMuted }, mf.attribution));
}

const avgOf = (f: FieldSpec | undefined): FieldSpec | undefined => (typeof f === 'string' && isColumnRefString(f) ? { field: f, aggregation: 'avg' } : f);

// ------------------------------------------------------------------ bubble map

/** Bubble map: one bubble per location at latitude/longitude, sized by a measure. */
export const bubbleMap = /* @__PURE__ */ defineVisual({
  type: 'map',
  displayName: 'Map',
  category: 'chart',
  roles: [
    { name: 'location', displayName: 'Location', kind: 'grouping', required: true },
    { name: 'legend', displayName: 'Legend', kind: 'grouping' },
    { name: 'latitude', displayName: 'Latitude', kind: 'any', required: true },
    { name: 'longitude', displayName: 'Longitude', kind: 'any', required: true },
    { name: 'size', displayName: 'Bubble size', kind: 'measure' },
  ],
  buildQuery(b, base) {
    const lat = avgOf(b.fields('latitude')[0]);
    const lon = avgOf(b.fields('longitude')[0]);
    if (!lat || !lon) return null;
    const size = b.fields('size')[0];
    return { ...base, values: [lat, lon, ...(size ? [size] : [])], orderBy: undefined, highlight: undefined };
  },
  render(ctx) {
    const li = ctx.role('location').indices[0];
    const gi = ctx.role('legend').indices[0];
    if (li === undefined || ctx.data.values.length < 2) return emptyState(ctx, 'Add location, latitude and longitude');
    const hasSize = ctx.data.values.length > 2;
    const lField = ctx.data.groups[li];
    const gField = gi !== undefined ? ctx.data.groups[gi] : undefined;
    const sField = hasSize ? ctx.data.values[2] : undefined;
    const pts = ctx.data.rows.filter((r) => typeof r.values[0] === 'number' && typeof r.values[1] === 'number');
    if (!pts.length) return emptyState(ctx);
    const t = ctx.theme;
    const mf = (ctx.format.map ?? {}) as MapFormat;
    const legendItems = new Map<unknown, { name: string; color: string; identity: ReturnType<typeof identityOf> }>();
    if (gField) for (const r of pts) legendItems.set(valueKey(r.keys[gi!]), { name: ctx.fmt(gField, r.keys[gi!]), color: ctx.colorFor(gField, r.keys[gi!]), identity: identityOf([gField], [r.keys[gi!]]) });
    const legend = renderLegend(ctx, [...legendItems.values()].map((x) => ({ ...x, shape: 'dot' as const })));
    const { plot, width: W, height: H } = withLegend(ctx, legend);
    const positions = pts.map((r) => [r.values[1] as number, r.values[0] as number] as Position);
    const proj = fitProjection(mf.geojson && !mf.tiles ? [...positions, ...allPositions(mf.geojson)] : positions, W, H);
    const svg = s('svg', { width: W, height: H, class: 'pbi-svg pbi-map', role: 'img', 'aria-label': ctx.spec.title ?? 'Map' });
    plot.append(svg);
    const g = s('g');
    svg.append(g);
    basemap(ctx, g, mf, proj, W, H);
    const sizes = hasSize ? pts.map((r) => Math.max(0, (r.values[2] as number) ?? 0)) : [];
    const maxSize = Math.max(1, ...sizes);
    const maxR = mf.maxRadius ?? 28;
    const order = pts.map((_, i) => i).sort((a, b) => (sizes[b] ?? 0) - (sizes[a] ?? 0));
    for (const i of order) {
      const r = pts[i];
      const [x, y] = proj(positions[i]);
      const color = gField ? ctx.colorFor(gField, r.keys[gi!]) : ctx.format.colors.default ?? t.dataColors[0];
      const keys = gField ? [r.keys[li], r.keys[gi!]] : [r.keys[li]];
      const identity = identityOf(gField ? [lField, gField] : [lField], keys);
      const radius = hasSize ? 3 + Math.sqrt(sizes[i] / maxSize) * maxR : 6;
      const c = s('circle', { cx: x, cy: y, r: radius, fill: color, 'fill-opacity': 0.75, stroke: t.surface, 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke', opacity: markOpacity(ctx, identity) });
      interactive(ctx, c, identity, () => ({ title: ctx.fmt(lField, r.keys[li]), items: [...(sField ? [{ label: sField.name, value: ctx.fmt(sField, r.values[2]), color }] : []), ...(gField ? [{ label: gField.name, value: ctx.fmt(gField, r.keys[gi!]) }] : [])] }), [r.keys[li]]);
      g.append(c);
    }
    attribution(svg, ctx, mf, W, H);
    if (mf.zoom !== false) enableZoom(ctx, svg, g);
  },
});

// ------------------------------------------------------------------ filled map

/** Filled map (choropleth): regions from your GeoJSON coloured by a measure. */
export const filledMap = /* @__PURE__ */ defineVisual({
  type: 'filledMap',
  displayName: 'Filled map',
  category: 'chart',
  roles: [
    { name: 'location', displayName: 'Location', kind: 'grouping', required: true },
    { name: 'values', displayName: 'Color saturation', kind: 'measure', required: true },
  ],
  supportsHighlight: false,
  render(ctx) {
    const mf = (ctx.format.map ?? {}) as MapFormat;
    if (!mf.geojson?.features?.length) return emptyState(ctx, 'Filled maps need format.map.geojson (region outlines)');
    const li = ctx.role('location').indices[0];
    const vi = ctx.role('values').indices[0];
    if (li === undefined || vi === undefined) return emptyState(ctx);
    const lField = ctx.data.groups[li];
    const vField = ctx.data.values[vi];
    const t = ctx.theme;
    const key = mf.featureKey ?? 'name';
    const byLoc = new Map<string, { key: CellValue; v: CellValue }>();
    for (const r of ctx.data.rows) byLoc.set(String(r.keys[li]).toLowerCase(), { key: r.keys[li], v: r.values[vi] });
    const nums = [...byLoc.values()].map((x) => x.v).filter((v): v is number => typeof v === 'number');
    const lo = Math.min(...nums);
    const hi = Math.max(...nums);
    const stops = t.mode === 'dark' ? [...t.sequential].reverse() : t.sequential;
    const colorOf = (v: number) => (hasValueColors(ctx) ? valueColor(ctx, v, [lo, hi], stops[3]) : ramp(stops.slice(0, -1), hi === lo ? 1 : (v - lo) / (hi - lo)));
    const W = ctx.width;
    const H = ctx.height;
    const proj = fitProjection(allPositions(mf.geojson), W, H - 22, 12);
    const svg = s('svg', { width: W, height: H, class: 'pbi-svg pbi-map', role: 'img', 'aria-label': ctx.spec.title ?? 'Filled map' });
    const g = s('g');
    svg.append(g);
    if (mf.tiles) drawTiles(g, mf.tiles, proj, W, H);
    for (const f of mf.geojson.features) {
      const name = String(f.properties?.[key] ?? f.id ?? '');
      const hit = byLoc.get(name.toLowerCase());
      const d = pathOf(f.geometry, proj);
      if (!hit || typeof hit.v !== 'number') {
        g.append(s('path', { d, fill: t.gridline, stroke: t.surface, 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));
        continue;
      }
      const identity = identityOf([lField], [hit.key]);
      const path = s('path', { d, fill: colorOf(hit.v), stroke: t.surface, 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke', opacity: markOpacity(ctx, identity) });
      interactive(ctx, path, identity, () => ({ title: ctx.fmt(lField, hit.key), items: [{ label: vField.name, value: ctx.fmt(vField, hit.v) }] }), [hit.key]);
      g.append(path);
    }
    // gradient legend
    if (nums.length) {
      const gid = `pbi-fm-${Math.random().toString(36).slice(2, 8)}`;
      const lg = s('linearGradient', { id: gid, x1: 0, x2: 1, y1: 0, y2: 0 });
      stops.slice(0, -1).forEach((c, k, arr) => lg.append(s('stop', { offset: `${(k / Math.max(1, arr.length - 1)) * 100}%`, 'stop-color': c })));
      const defs = s('defs');
      defs.append(lg);
      svg.append(defs);
      const lw = Math.min(160, W / 2);
      const fmt = (v: number) => ctx.fmt(vField, v, { displayUnits: 'auto' });
      const tw = measureText(fmt(lo), t.labelFontSize, t.fontFamily);
      svg.append(s('text', { x: 4, y: H - 6, class: 'pbi-tick', fill: t.foregroundMuted }, fmt(lo)));
      svg.append(s('rect', { x: tw + 10, y: H - 15, width: lw, height: 10, rx: 3, fill: `url(#${gid})` }));
      svg.append(s('text', { x: tw + 16 + lw, y: H - 6, class: 'pbi-tick', fill: t.foregroundMuted }, fmt(hi)));
    }
    ctx.root.replaceChildren(svg);
    attribution(svg, ctx, mf, W, H);
    if (mf.zoom !== false) enableZoom(ctx, svg, g);
  },
});
