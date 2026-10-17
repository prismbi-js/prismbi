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
  /** Basemap / regions as GeoJSON (filled maps need this or `boundaries`). */
  geojson?: GeoFeatureCollection;
  /**
   * Built-in boundaries registered by `@prismbi/prismbi/geo`: `'world'` (countries) or `'usStates'`. Locations match
   * names or ISO codes (e.g. "France", "FR", "FRA"; "Texas", "TX").
   */
  boundaries?: string;
  /** Property (or properties) used to match the location field to features (default "name"). */
  featureKey?: string | string[];
  /** Filled maps: a continuous `'gradient'` legend (default) or `'classes'` (quantile buckets with swatches). */
  legend?: 'gradient' | 'classes';
  /** Number of quantile classes for `legend: 'classes'` (default 5). */
  classes?: number;
  /** Bubble maps: group nearby bubbles into clusters showing a count; click a cluster to zoom in. `radius` in px (default 40). */
  cluster?: boolean | { radius?: number };
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

// ------------------------------------------------------------------ boundaries

interface Boundaries {
  fc: GeoFeatureCollection;
  keys: string[];
}
const GEO_KEY = Symbol.for('prismbi.boundaries');
const geoStore = globalThis as unknown as Record<symbol, Map<string, Boundaries> | undefined>;
const boundaryRegistry: Map<string, Boundaries> = (geoStore[GEO_KEY] ??= new Map());

/** Make a GeoJSON collection available to maps as `format.map.boundaries: name`, matched on `keys` (default ["name"]). */
export function registerBoundaries(name: string, fc: GeoFeatureCollection, opts: { keys?: string[] } = {}): void {
  boundaryRegistry.set(name, { fc, keys: opts.keys ?? ['name'] });
}

export function getBoundaries(name: string): GeoFeatureCollection | undefined {
  return boundaryRegistry.get(name)?.fc;
}

// common names that differ from Natural Earth's
const ALIASES: Record<string, string> = { usa: 'us', 'united states': 'us', 'u.s.': 'us', 'u.s.a.': 'us', uk: 'gb', 'great britain': 'gb', england: 'gb', 'czech republic': 'czechia', 'ivory coast': "côte d'ivoire", 'republic of korea': 'south korea', 'korea, south': 'south korea', 'dr congo': 'dem. rep. congo', 'democratic republic of the congo': 'dem. rep. congo', 'the netherlands': 'netherlands', holland: 'netherlands', 'russian federation': 'russia', burma: 'myanmar', 'viet nam': 'vietnam', turkiye: 'turkey', 'türkiye': 'turkey' };

/** The regions for a map and a matcher from location values to features. */
function resolveGeo(mf: MapFormat): { fc: GeoFeatureCollection; find: (v: CellValue) => GeoFeature | undefined } | null {
  const src: Boundaries | undefined = mf.geojson ? { fc: mf.geojson, keys: [] } : mf.boundaries ? boundaryRegistry.get(mf.boundaries) : undefined;
  if (!src) return null;
  const keys = mf.featureKey !== undefined ? (Array.isArray(mf.featureKey) ? mf.featureKey : [mf.featureKey]) : src.keys.length ? src.keys : ['name'];
  const index = new Map<string, GeoFeature>();
  for (const f of src.fc.features) {
    for (const k of keys) {
      const v = f.properties?.[k];
      if (v !== undefined && v !== null && !index.has(String(v).toLowerCase())) index.set(String(v).toLowerCase(), f);
    }
    if (f.id !== undefined && !index.has(String(f.id).toLowerCase())) index.set(String(f.id).toLowerCase(), f);
  }
  return {
    fc: src.fc,
    find: (v) => {
      const k = String(v ?? '').trim().toLowerCase();
      return index.get(k) ?? (ALIASES[k] ? index.get(ALIASES[k]) : undefined);
    },
  };
}

/** Area-weighted centroid of a feature's largest polygon (lon/lat). */
export function featureCentroid(f: GeoFeature): Position | null {
  const g = f.geometry;
  if (!g) return null;
  if (g.type === 'Point') return g.coordinates as Position;
  const polys: Position[][] = g.type === 'Polygon' ? [(g.coordinates as Position[][])[0]] : g.type === 'MultiPolygon' ? (g.coordinates as Position[][][]).map((p) => p[0]) : [];
  let best: { a: number; c: Position } | null = null;
  for (const ring of polys) {
    let a = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      a += cross;
      cx += (ring[j][0] + ring[i][0]) * cross;
      cy += (ring[j][1] + ring[i][1]) * cross;
    }
    if (!a) continue;
    if (!best || Math.abs(a) > best.a) best = { a: Math.abs(a), c: [cx / (3 * a), cy / (3 * a)] };
  }
  return best?.c ?? null;
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
function enableZoom(ctx: RenderContext, svg: SVGSVGElement, g: SVGGElement, onSettle?: () => void): void {
  let settle: ReturnType<typeof setTimeout> | undefined;
  const changed = () => {
    if (!onSettle) return;
    if (settle) clearTimeout(settle);
    settle = setTimeout(onSettle, 180);
  };
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
      changed();
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
    changed();
  });
}

function basemap(ctx: RenderContext, g: SVGGElement, mf: MapFormat, proj: Projection, W: number, H: number, fc?: GeoFeatureCollection): void {
  if (mf.tiles) drawTiles(g, mf.tiles, proj, W, H);
  if (!mf.tiles && !fc && mf.graticule !== false) {
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
  for (const f of fc?.features ?? []) g.append(s('path', { d: pathOf(f.geometry, proj), fill: mf.tiles ? 'none' : ctx.theme.gridline, stroke: ctx.theme.surface, 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' }));
}

function attribution(svg: SVGSVGElement, ctx: RenderContext, mf: MapFormat, W: number, H: number): void {
  if (!mf.attribution) return;
  const w = measureText(mf.attribution, 10, ctx.theme.fontFamily) + 8;
  svg.append(s('rect', { x: W - w, y: H - 16, width: w, height: 16, fill: ctx.theme.surface, opacity: 0.8 }));
  svg.append(s('text', { x: W - 4, y: H - 5, 'text-anchor': 'end', 'font-size': 10, fill: ctx.theme.foregroundMuted }, mf.attribution));
}

const avgOf = (f: FieldSpec | undefined): FieldSpec | undefined => (typeof f === 'string' && isColumnRefString(f) ? { field: f, aggregation: 'avg' } : f);

// ------------------------------------------------------------------ bubble map

interface Bubble {
  i: number;
  x: number;
  y: number;
  size: number;
}

/** Greedy screen-space clustering: the biggest bubble collects its unclaimed neighbours within `radius`. */
export function clusterPoints(points: Bubble[], radius: number): Bubble[][] {
  const order = [...points].sort((a, b) => b.size - a.size);
  const taken = new Set<number>();
  const out: Bubble[][] = [];
  const r2 = radius * radius;
  for (const p of order) {
    if (taken.has(p.i)) continue;
    const group = order.filter((q) => !taken.has(q.i) && (q.x - p.x) ** 2 + (q.y - p.y) ** 2 <= r2);
    for (const q of group) taken.add(q.i);
    out.push(group);
  }
  return out;
}

/** Bubble map: one bubble per location, at latitude/longitude or at the centre of its region (boundaries/GeoJSON), sized by a measure. */
export const bubbleMap = /* @__PURE__ */ defineVisual({
  type: 'map',
  displayName: 'Map',
  category: 'chart',
  roles: [
    { name: 'location', displayName: 'Location', kind: 'grouping', required: true },
    { name: 'legend', displayName: 'Legend', kind: 'grouping' },
    { name: 'latitude', displayName: 'Latitude', kind: 'any' },
    { name: 'longitude', displayName: 'Longitude', kind: 'any' },
    { name: 'size', displayName: 'Bubble size', kind: 'measure' },
  ],
  buildQuery(b, base) {
    const lat = avgOf(b.fields('latitude')[0]);
    const lon = avgOf(b.fields('longitude')[0]);
    const size = b.fields('size')[0];
    const mf = ((b.spec.format as { map?: MapFormat } | undefined)?.map ?? {}) as MapFormat;
    // without coordinates, bubbles sit at their region's centre (needs boundaries or GeoJSON)
    if (!lat || !lon) return mf.boundaries || mf.geojson ? { ...base, values: size ? [size] : [], orderBy: undefined, highlight: undefined } : null;
    return { ...base, values: [lat, lon, ...(size ? [size] : [])], orderBy: undefined, highlight: undefined };
  },
  render(ctx) {
    const li = ctx.role('location').indices[0];
    const gi = ctx.role('legend').indices[0];
    const mf = (ctx.format.map ?? {}) as MapFormat;
    const geo = resolveGeo(mf);
    if (mf.boundaries && !geo) return emptyState(ctx, `Boundaries "${mf.boundaries}" aren't registered: import '@prismbi/prismbi/geo'`);
    const byCoords = ctx.fields('latitude').length > 0 && ctx.fields('longitude').length > 0;
    if (li === undefined || (byCoords ? ctx.data.values.length < 2 : !geo)) return emptyState(ctx, 'Add location, and latitude and longitude (or format.map.boundaries)');
    const si = byCoords ? (ctx.data.values.length > 2 ? 2 : -1) : ctx.data.values.length ? 0 : -1;
    const hasSize = si >= 0;
    const lField = ctx.data.groups[li];
    const gField = gi !== undefined ? ctx.data.groups[gi] : undefined;
    const sField = hasSize ? ctx.data.values[si] : undefined;
    type Row = (typeof ctx.data.rows)[number];
    const located: { r: Row; pos: Position }[] = [];
    for (const r of ctx.data.rows) {
      if (byCoords) {
        if (typeof r.values[0] === 'number' && typeof r.values[1] === 'number') located.push({ r, pos: [r.values[1], r.values[0]] });
        continue;
      }
      const f = geo!.find(r.keys[li]);
      const c = f ? featureCentroid(f) : null;
      if (c) located.push({ r, pos: c });
    }
    if (!located.length) return emptyState(ctx);
    const pts = located.map((x) => x.r);
    const positions = located.map((x) => x.pos);
    const t = ctx.theme;
    const legendItems = new Map<unknown, { name: string; color: string; identity: ReturnType<typeof identityOf> }>();
    if (gField) for (const r of pts) legendItems.set(valueKey(r.keys[gi!]), { name: ctx.fmt(gField, r.keys[gi!]), color: ctx.colorFor(gField, r.keys[gi!]), identity: identityOf([gField], [r.keys[gi!]]) });
    const legend = renderLegend(ctx, [...legendItems.values()].map((x) => ({ ...x, shape: 'dot' as const })));
    const { plot, width: W, height: H } = withLegend(ctx, legend);
    // keep the largest bubble inside the frame
    const fitTo = geo && !mf.tiles && mf.geojson ? [...positions, ...allPositions(geo.fc)] : positions;
    const proj = fitProjection(fitTo, W, H, Math.max(24, (mf.maxRadius ?? 28) + 6));
    const svg = s('svg', { width: W, height: H, class: 'pbi-svg pbi-map', role: 'img', 'aria-label': ctx.spec.title ?? 'Map' });
    plot.append(svg);
    const g = s('g');
    svg.append(g);
    basemap(ctx, g, mf, proj, W, H, geo?.fc);
    const sizes = pts.map((r) => (hasSize ? Math.max(0, (r.values[si] as number) ?? 0) : 1));
    const maxSize = Math.max(1, ...sizes);
    const maxR = mf.maxRadius ?? 28;
    const radiusOf = (v: number) => (hasSize ? 3 + Math.sqrt(v / maxSize) * maxR : 6);
    const bubble = (i: number) => {
      const r = pts[i];
      const [x, y] = proj(positions[i]);
      const color = gField ? ctx.colorFor(gField, r.keys[gi!]) : ctx.format.colors.default ?? t.dataColors[0];
      const keys = gField ? [r.keys[li], r.keys[gi!]] : [r.keys[li]];
      const identity = identityOf(gField ? [lField, gField] : [lField], keys);
      const c = s('circle', { cx: x, cy: y, r: radiusOf(sizes[i]), fill: color, 'fill-opacity': 0.75, stroke: t.surface, 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke', opacity: markOpacity(ctx, identity) });
      interactive(ctx, c, identity, () => ({ title: ctx.fmt(lField, r.keys[li]), items: [...(sField ? [{ label: sField.name, value: ctx.fmt(sField, r.values[si]), color }] : []), ...(gField ? [{ label: gField.name, value: ctx.fmt(gField, r.keys[gi!]) }] : [])] }), [r.keys[li]]);
      g.append(c);
    };
    const st = ctx.host.state as { _view?: { k: number; x: number; y: number } };
    if (mf.cluster) {
      const k = st._view?.k ?? 1;
      const radius = (typeof mf.cluster === 'object' && mf.cluster.radius) || 40;
      const groups = clusterPoints(pts.map((_, i) => ({ i, x: proj(positions[i])[0], y: proj(positions[i])[1], size: sizes[i] })), radius / k);
      for (const group of groups.sort((a, b) => b.length - a.length)) {
        if (group.length === 1) {
          bubble(group[0].i);
          continue;
        }
        const total = group.reduce((n, p) => n + p.size, 0);
        const weight = group.reduce((n, p) => n + (p.size || 1), 0);
        const cx = group.reduce((n, p) => n + p.x * (p.size || 1), 0) / weight;
        const cy = group.reduce((n, p) => n + p.y * (p.size || 1), 0) / weight;
        const rr = Math.max(14, Math.min(maxR * 1.4, hasSize ? radiusOf(total) : 10 + Math.sqrt(group.length) * 3)) / Math.sqrt(k);
        const names = group.slice(0, 3).map((p) => ctx.fmt(lField, pts[p.i].keys[li]));
        const more = group.length > 3 ? ', …' : '';
        const cl = s('g', { class: 'pbi-cluster', tabindex: 0, role: 'button', 'aria-label': `${group.length} locations: ${names.join(', ')}${more}. Press Enter to zoom in.`, style: 'cursor:zoom-in' });
        cl.append(s('circle', { cx, cy, r: rr, fill: ctx.format.colors.default ?? t.dataColors[0], 'fill-opacity': 0.85, stroke: t.surface, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }));
        cl.append(s('text', { x: cx, y: cy, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': Math.max(10, 12 / Math.sqrt(k)), 'font-weight': 600, fill: '#fff', 'pointer-events': 'none' }, String(group.length)));
        const zoomIn = () => {
          const v = st._view ?? { k: 1, x: 0, y: 0 };
          const nk = Math.min(16, v.k * 2.5);
          st._view = { k: nk, x: W / 2 - cx * nk, y: H / 2 - cy * nk };
          ctx.host.rerender?.();
        };
        cl.addEventListener('click', (e) => {
          e.stopPropagation();
          zoomIn();
        });
        cl.addEventListener('keydown', (e) => {
          const ke = e as KeyboardEvent;
          if (ke.key !== 'Enter' && ke.key !== ' ') return;
          ke.preventDefault();
          zoomIn();
        });
        cl.addEventListener('mousemove', (e) => ctx.host.showTooltip(e as MouseEvent, [{ label: 'Locations', value: String(group.length) }, ...(sField ? [{ label: sField.name, value: ctx.fmt(sField, total) }] : []), { label: 'Includes', value: names.join(', ') + more }]));
        cl.addEventListener('mouseleave', () => ctx.host.hideTooltip());
        g.append(cl);
      }
    } else for (const i of pts.map((_, i) => i).sort((a, b) => sizes[b] - sizes[a])) bubble(i);
    attribution(svg, ctx, mf, W, H);
    if (mf.zoom !== false) enableZoom(ctx, svg, g, mf.cluster ? () => ctx.host.rerender?.() : undefined);
  },
});

// ------------------------------------------------------------------ filled map

/** Quantile class breaks (upper bounds) for `n` classes. */
export function quantileBreaks(values: number[], n: number): number[] {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return [];
  const out: number[] = [];
  for (let k = 1; k <= n; k++) {
    const b = v[Math.min(v.length - 1, Math.ceil((k / n) * v.length) - 1)];
    if (!out.length || b > out[out.length - 1]) out.push(b);
  }
  return out;
}

/** Filled map (choropleth): regions from built-in boundaries or your GeoJSON, coloured by a measure. */
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
    const geo = resolveGeo(mf);
    if (mf.boundaries && !geo) return emptyState(ctx, `Boundaries "${mf.boundaries}" aren't registered: import '@prismbi/prismbi/geo'`);
    if (!geo?.fc.features.length) return emptyState(ctx, 'Filled maps need format.map.boundaries (with @prismbi/prismbi/geo) or format.map.geojson');
    const li = ctx.role('location').indices[0];
    const vi = ctx.role('values').indices[0];
    if (li === undefined || vi === undefined) return emptyState(ctx);
    const lField = ctx.data.groups[li];
    const vField = ctx.data.values[vi];
    const t = ctx.theme;
    const byFeature = new Map<GeoFeature, { key: CellValue; v: CellValue }>();
    for (const r of ctx.data.rows) {
      const f = geo.find(r.keys[li]);
      if (f) byFeature.set(f, { key: r.keys[li], v: r.values[vi] });
    }
    const nums = [...byFeature.values()].map((x) => x.v).filter((v): v is number => typeof v === 'number');
    const lo = Math.min(...nums);
    const hi = Math.max(...nums);
    const stops = t.mode === 'dark' ? [...t.sequential].reverse() : t.sequential;
    const classed = mf.legend === 'classes' && !hasValueColors(ctx);
    const breaks = classed ? quantileBreaks(nums, Math.max(2, Math.min(9, mf.classes ?? 5))) : [];
    const classColor = (k: number) => ramp(stops.slice(0, -1), breaks.length < 2 ? 1 : k / (breaks.length - 1));
    const colorOf = (v: number) => {
      if (hasValueColors(ctx)) return valueColor(ctx, v, [lo, hi], stops[3]);
      if (classed) return classColor(Math.max(0, breaks.findIndex((b) => v <= b)));
      return ramp(stops.slice(0, -1), hi === lo ? 1 : (v - lo) / (hi - lo));
    };
    const W = ctx.width;
    const H = ctx.height;
    const matched = [...byFeature.keys()];
    // built-in boundaries frame the regions that have data (the whole collection otherwise)
    const frame = mf.boundaries && matched.length ? matched.flatMap((f) => rings(f.geometry).flat()) : allPositions(geo.fc);
    const proj = fitProjection(frame, W, H - 22, 12);
    const svg = s('svg', { width: W, height: H, class: 'pbi-svg pbi-map', role: 'img', 'aria-label': ctx.spec.title ?? 'Filled map' });
    const g = s('g');
    svg.append(g);
    if (mf.tiles) drawTiles(g, mf.tiles, proj, W, H);
    for (const f of geo.fc.features) {
      const hit = byFeature.get(f);
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
    const fmt = (v: number) => ctx.fmt(vField, v, { displayUnits: 'auto' });
    if (nums.length && classed) {
      // classed legend: one swatch per quantile bucket with its range
      const legendG = s('g', { class: 'pbi-map-legend', role: 'list', 'aria-label': `${vField.name} classes` });
      let x = 4;
      breaks.forEach((b, k) => {
        const label = k === 0 ? `up to ${fmt(b)}` : `${fmt(breaks[k - 1])} to ${fmt(b)}`;
        const item = s('g', { role: 'listitem' });
        item.append(s('rect', { x, y: H - 15, width: 12, height: 10, rx: 2, fill: classColor(k) }));
        item.append(s('text', { x: x + 16, y: H - 6, class: 'pbi-tick', fill: t.foregroundMuted }, label));
        legendG.append(item);
        x += 16 + measureText(label, t.labelFontSize, t.fontFamily) + 12;
      });
      svg.append(legendG);
    } else if (nums.length) {
      const gid = `pbi-fm-${Math.random().toString(36).slice(2, 8)}`;
      const lg = s('linearGradient', { id: gid, x1: 0, x2: 1, y1: 0, y2: 0 });
      stops.slice(0, -1).forEach((c, k, arr) => lg.append(s('stop', { offset: `${(k / Math.max(1, arr.length - 1)) * 100}%`, 'stop-color': c })));
      const defs = s('defs');
      defs.append(lg);
      svg.append(defs);
      const lw = Math.min(160, W / 2);
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
