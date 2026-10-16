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

const DAY = 86_400_000;

export interface TimeScale {
  (ms: number): number;
  domain: [number, number];
  range: [number, number];
  ticks: number[];
  /** Label for a tick, granularity-aware ("Mar 4", "Mar 2025", "2025"). */
  tickFormat(ms: number, index: number): string;
  invert(px: number): number;
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Continuous time scale with calendar-aligned ticks (days, weeks, months, quarters, years). */
export function timeScale(min: number, max: number, range: [number, number], approxTicks = 6): TimeScale {
  if (!(max > min)) max = min + DAY;
  const span = max - min;
  type Step = { unit: 'day' | 'month' | 'year'; n: number; approx: number };
  const steps: Step[] = [
    { unit: 'day', n: 1, approx: DAY },
    { unit: 'day', n: 2, approx: 2 * DAY },
    { unit: 'day', n: 7, approx: 7 * DAY },
    { unit: 'day', n: 14, approx: 14 * DAY },
    { unit: 'month', n: 1, approx: 30.4 * DAY },
    { unit: 'month', n: 2, approx: 61 * DAY },
    { unit: 'month', n: 3, approx: 91 * DAY },
    { unit: 'month', n: 6, approx: 182 * DAY },
    { unit: 'year', n: 1, approx: 365 * DAY },
    { unit: 'year', n: 2, approx: 730 * DAY },
    { unit: 'year', n: 5, approx: 1826 * DAY },
    { unit: 'year', n: 10, approx: 3652 * DAY },
  ];
  const step = steps.find((s) => span / s.approx <= Math.max(2, approxTicks)) ?? { unit: 'year', n: Math.ceil(span / (365 * DAY) / approxTicks), approx: 0 };
  const ticks: number[] = [];
  const start = new Date(min);
  let d: Date;
  if (step.unit === 'day') d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  else if (step.unit === 'month') d = new Date(start.getFullYear(), Math.floor(start.getMonth() / step.n) * step.n, 1);
  else d = new Date(Math.floor(start.getFullYear() / step.n) * step.n, 0, 1);
  if (step.unit === 'day' && step.n === 7) d.setDate(d.getDate() - d.getDay());
  for (let guard = 0; guard < 500 && d.getTime() <= max; guard++) {
    if (d.getTime() >= min) ticks.push(d.getTime());
    if (step.unit === 'day') d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + step.n);
    else if (step.unit === 'month') d = new Date(d.getFullYear(), d.getMonth() + step.n, 1);
    else d = new Date(d.getFullYear() + step.n, 0, 1);
  }
  const [r0, r1] = range;
  const f = ((ms: number) => r0 + ((ms - min) / (max - min)) * (r1 - r0)) as TimeScale;
  f.domain = [min, max];
  f.range = range;
  f.ticks = ticks;
  f.invert = (px) => min + ((px - r0) / (r1 - r0)) * (max - min);
  f.tickFormat = (ms, i) => {
    const t = new Date(ms);
    if (step.unit === 'year') return String(t.getFullYear());
    if (step.unit === 'month') return t.getMonth() === 0 || i === 0 ? `${SHORT_MONTHS[t.getMonth()]} ${t.getFullYear()}` : SHORT_MONTHS[t.getMonth()];
    return t.getDate() === 1 || i === 0 ? `${SHORT_MONTHS[t.getMonth()]} ${t.getDate()}` : String(t.getDate());
  };
  return f;
}

/** Base-10 log scale (positive values only). Ticks at powers of ten, plus 2× and 5× when few decades. */
export function logScale(min: number, max: number, range: [number, number]): LinearScale {
  const lo = Math.pow(10, Math.floor(Math.log10(Math.max(min, 1e-12))));
  let hi = Math.pow(10, Math.ceil(Math.log10(Math.max(max, lo * 10))));
  if (hi <= lo) hi = lo * 10;
  const l0 = Math.log10(lo);
  const l1 = Math.log10(hi);
  const [r0, r1] = range;
  const f = ((v: number) => r0 + ((Math.log10(Math.max(v, lo)) - l0) / (l1 - l0)) * (r1 - r0)) as LinearScale;
  const decades = l1 - l0;
  const ticks: number[] = [];
  for (let e = l0; e <= l1 + 1e-9; e++) {
    const base = Math.pow(10, e);
    ticks.push(+base.toPrecision(12));
    if (decades <= 2 && e < l1) ticks.push(+(base * 2).toPrecision(12), +(base * 5).toPrecision(12));
  }
  f.domain = [lo, hi];
  f.range = range;
  f.ticks = ticks.sort((a, b) => a - b);
  f.invert = (px) => Math.pow(10, l0 + ((px - r0) / (r1 - r0)) * (l1 - l0));
  return f;
}
