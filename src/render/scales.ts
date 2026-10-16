export interface LinearScale {
  (v: number): number;
  domain: [number, number];
  range: [number, number];
  ticks: number[];
  invert(px: number): number;
}

/** "Nice" step: 1, 2, 2.5, 5 × 10^n. */
export function niceStep(span: number, count: number): number {
  if (span <= 0 || !Number.isFinite(span)) return 1;
  const raw = span / Math.max(1, count);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

/**
 * Linear scale whose domain is extended to nice tick boundaries.
 * Always includes zero unless `includeZero` is false (bars must start at zero).
 */
export function linearScale(min: number, max: number, range: [number, number], opts: { tickCount?: number; includeZero?: boolean; fixedMin?: number; fixedMax?: number } = {}): LinearScale {
  const includeZero = opts.includeZero ?? true;
  let lo = opts.fixedMin ?? (includeZero ? Math.min(0, min) : min);
  let hi = opts.fixedMax ?? (includeZero ? Math.max(0, max) : max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  if (lo === hi) {
    if (lo === 0) hi = 1;
    else if (lo > 0) lo = includeZero ? 0 : lo * 0.9;
    else hi = includeZero ? 0 : hi * 0.9;
    if (lo === hi) hi = lo + 1;
  }
  const count = opts.tickCount ?? 5;
  const step = niceStep(hi - lo, count);
  if (opts.fixedMin === undefined) lo = Math.floor(lo / step + 1e-9) * step;
  if (opts.fixedMax === undefined) hi = Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-6; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : +v.toPrecision(12));
  const [r0, r1] = range;
  const f = ((v: number) => r0 + ((v - lo) / (hi - lo)) * (r1 - r0)) as LinearScale;
  f.domain = [lo, hi];
  f.range = range;
  f.ticks = ticks;
  f.invert = (px) => lo + ((px - r0) / (r1 - r0)) * (hi - lo);
  return f;
}

export interface BandScale {
  (i: number): number;
  bandwidth: number;
  step: number;
  count: number;
  /** Index under a pixel position. */
  indexAt(px: number): number;
}

/** Band scale over `count` slots with inner/outer padding ratios. */
export function bandScale(count: number, range: [number, number], paddingInner = 0.35, paddingOuter = 0.2): BandScale {
  const [r0, r1] = range;
  const n = Math.max(1, count);
  const step = (r1 - r0) / (n - paddingInner + paddingOuter * 2);
  const bandwidth = step * (1 - paddingInner);
  const start = r0 + step * paddingOuter;
  const f = ((i: number) => start + i * step) as BandScale;
  f.bandwidth = Math.max(0, bandwidth);
  f.step = step;
  f.count = count;
  f.indexAt = (px) => Math.max(0, Math.min(count - 1, Math.floor((px - start + (step - bandwidth) / 2) / step)));
  return f;
}

/** Point scale (line charts): first and last point on the range edges, with a little inset. */
export function pointScale(count: number, range: [number, number], inset = 0): BandScale {
  const [r0, r1] = range;
  const a = r0 + inset;
  const b = r1 - inset;
  const step = count > 1 ? (b - a) / (count - 1) : 0;
  const f = ((i: number) => (count > 1 ? a + i * step : (a + b) / 2)) as BandScale;
  f.bandwidth = 0;
  f.step = step;
  f.count = count;
  f.indexAt = (px) => (count > 1 ? Math.max(0, Math.min(count - 1, Math.round((px - a) / step))) : 0);
  return f;
}
