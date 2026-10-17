/**
 * Forecasting for line charts: additive Holt-Winters (level, trend and an optional season) with parameters picked
 * by one-step-ahead error, and a prediction interval that widens with the horizon.
 */
export interface ForecastOptions {
  /** Periods to forecast. */
  periods: number;
  /** Interval coverage, 0–1 (default 0.95). */
  confidence?: number;
  /** Season length in periods, `'auto'` (default: detected by autocorrelation) or `'none'`. */
  seasonality?: number | 'auto' | 'none';
}

export interface Forecast {
  mean: number[];
  lower: number[];
  upper: number[];
  season: number;
}

/** z-score for a two-sided interval (approximation, good to ~1e-3 over 0.5–0.999). */
function zFor(confidence: number): number {
  const p = 1 - (1 - Math.min(0.999, Math.max(0.5, confidence))) / 2;
  // Acklam's rational approximation of the normal quantile (central region)
  const q = p - 0.5;
  const r = q * q;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  if (Math.abs(q) <= 0.425) return (q * (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5])) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const t = Math.sqrt(-2 * Math.log(1 - p));
  // upper tail (p > 0.5): the lower-tail formula, negated
  return -(((((c[0] * t + c[1]) * t + c[2]) * t + c[3]) * t + c[4]) * t + c[5]) / ((((d[0] * t + d[1]) * t + d[2]) * t + d[3]) * t + 1);
}

/** Season length with the strongest autocorrelation (needs two full cycles), or 0. */
export function detectSeason(xs: number[]): number {
  const n = xs.length;
  // remove the linear trend first: a trend correlates every small lag and would hide the season
  const mx = (n - 1) / 2;
  const my = xs.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  xs.forEach((y, i) => ((sxy += (i - mx) * (y - my)), (sxx += (i - mx) ** 2)));
  const slope = sxx ? sxy / sxx : 0;
  const dev = xs.map((y, i) => y - (my + slope * (i - mx)));
  const denom = dev.reduce((s, d) => s + d * d, 0);
  if (!denom) return 0;
  const maxLag = Math.floor(n / 2);
  const r: number[] = [];
  for (let lag = 0; lag <= maxLag + 1; lag++) {
    let num = 0;
    for (let i = lag; i < n; i++) num += dev[i] * dev[i - lag];
    r[lag] = num / denom;
  }
  let best = 0;
  let bestR = 0.3; // weak autocorrelation is not a season
  for (let lag = 2; lag <= maxLag; lag++) {
    const peak = r[lag] >= r[lag - 1] && r[lag] >= (r[lag + 1] ?? -Infinity);
    if (peak && r[lag] > bestR) {
      bestR = r[lag];
      best = lag;
    }
  }
  return best;
}

function holtWinters(xs: number[], m: number, alpha: number, beta: number, gamma: number, phi: number) {
  const n = xs.length;
  let level = xs[0];
  let trend = n > 1 ? (m && n >= 2 * m ? (xs.slice(m, 2 * m).reduce((a, b) => a + b, 0) - xs.slice(0, m).reduce((a, b) => a + b, 0)) / (m * m) : xs[1] - xs[0]) : 0;
  const season = m ? xs.slice(0, m).map((x) => x - xs.slice(0, m).reduce((a, b) => a + b, 0) / m) : [];
  if (m) level = xs.slice(0, m).reduce((a, b) => a + b, 0) / m;
  let sse = 0;
  let count = 0;
  for (let i = m ? m : 1; i < n; i++) {
    const s = m ? season[i % m] : 0;
    const predicted = level + phi * trend + s;
    const err = xs[i] - predicted;
    sse += err * err;
    count++;
    const prevLevel = level;
    level = alpha * (xs[i] - s) + (1 - alpha) * (level + phi * trend);
    trend = beta * (level - prevLevel) + (1 - beta) * phi * trend;
    if (m) season[i % m] = gamma * (xs[i] - level) + (1 - gamma) * s;
  }
  return { level, trend, season, sse, count, n, phi, alpha };
}

/** Forecast `periods` values after `xs` (at least 4 points; seasonality needs two full cycles). */
export function forecastSeries(xs: number[], opts: ForecastOptions): Forecast | null {
  if (xs.length < 4 || opts.periods < 1) return null;
  let m = opts.seasonality === 'none' ? 0 : typeof opts.seasonality === 'number' ? opts.seasonality : detectSeason(xs);
  if (m && xs.length < 2 * m) m = 0;
  let best: ReturnType<typeof holtWinters> | null = null;
  // damped trends (phi < 1) and no trend at all keep noisy series from running away
  for (const alpha of [0.2, 0.4, 0.6, 0.8])
    for (const beta of [0, 0.05, 0.15, 0.3])
      for (const phi of beta === 0 ? [1] : [0.8, 0.9, 0.98])
        for (const gamma of m ? [0.1, 0.3, 0.5] : [0]) {
          const fit = holtWinters(xs, m, alpha, beta, gamma, phi);
          if (!best || fit.sse < best.sse) best = fit;
        }
  if (!best) return null;
  const sd = Math.sqrt(best.sse / Math.max(1, best.count - 1));
  const z = zFor(opts.confidence ?? 0.95);
  const mean: number[] = [];
  const lower: number[] = [];
  const upper: number[] = [];
  // a series that has never been negative (sales, counts) is not forecast below zero
  const floor = xs.every((x) => x >= 0) ? 0 : -Infinity;
  let damp = 0;
  for (let h = 1; h <= opts.periods; h++) {
    damp += best.phi ** h;
    const v = best.level + damp * best.trend + (m ? best.season[(best.n + h - 1) % m] : 0);
    // exponential smoothing: forecast variance grows by alpha² per step, not like a random walk
    const half = z * sd * Math.sqrt(1 + (h - 1) * best.alpha ** 2);
    mean.push(Math.max(floor, v));
    lower.push(Math.max(floor, v - half));
    upper.push(Math.max(floor, v + half));
  }
  return { mean, lower, upper, season: m };
}

const DAY = 86_400_000;

/** Positions (ms or numbers) of the next `periods` keys after `nums`, calendar-aware for dates. */
export function futureKeys(nums: number[], isDate: boolean, periods: number): number[] {
  const n = nums.length;
  const diffs = nums.slice(1).map((v, i) => v - nums[i]).sort((a, b) => a - b);
  const step = diffs[Math.floor(diffs.length / 2)] ?? 1;
  const last = nums[n - 1];
  const out: number[] = [];
  if (isDate && step >= 27 * DAY && step <= 32 * DAY) {
    const d = new Date(last);
    for (let k = 1; k <= periods; k++) out.push(new Date(d.getFullYear(), d.getMonth() + k, d.getDate()).getTime());
  } else if (isDate && step >= 89 * DAY && step <= 93 * DAY) {
    const d = new Date(last);
    for (let k = 1; k <= periods; k++) out.push(new Date(d.getFullYear(), d.getMonth() + 3 * k, d.getDate()).getTime());
  } else if (isDate && step >= 364 * DAY && step <= 367 * DAY) {
    const d = new Date(last);
    for (let k = 1; k <= periods; k++) out.push(new Date(d.getFullYear() + k, d.getMonth(), d.getDate()).getTime());
  } else for (let k = 1; k <= periods; k++) out.push(last + k * step);
  return out;
}
