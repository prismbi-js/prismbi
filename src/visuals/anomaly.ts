import { linearFit } from './analytics';

/**
 * Time-series anomaly and statistical outlier detection for continuous charts.
 * Supports detrended Interquartile Range (IQR) and Z-score outlier detection.
 */

export interface AnomalyOptions {
  /** Whether anomaly detection is enabled (default true when object is provided). */
  enabled?: boolean;
  /**
   * Sensitivity factor:
   * - For 'iqr': multiplier on the interquartile range (default 1.5).
   * - For 'zscore': threshold in standard deviations (default 2.5).
   * Higher values result in fewer anomalies flagged.
   */
  sensitivity?: number;
  /** Outlier detection method: 'iqr' (default) or 'zscore'. */
  method?: 'iqr' | 'zscore';
  /** Custom marker color for anomaly beacon halos (defaults to theme alert/bad color). */
  color?: string;
  /** Whether to detrend the series via linear regression before computing residuals (default true). */
  detrend?: boolean;
}

export interface AnomalyPoint {
  index: number;
  value: number;
  expected: number;
  score: number;
  direction: 'high' | 'low';
  explanation: string;
}

function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * Math.max(0, Math.min(1, p));
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * Detect statistical anomalies and outliers in a time series.
 * Automatically handles nulls and computes trend residuals.
 */
export function detectAnomalies(
  rawValues: (number | null)[],
  options: AnomalyOptions | boolean = {},
): AnomalyPoint[] {
  const opts = typeof options === 'object' ? options : {};
  if (opts.enabled === false) return [];

  const pts: [number, number][] = [];
  for (let i = 0; i < rawValues.length; i++) {
    const v = rawValues[i];
    if (v !== null && Number.isFinite(v)) pts.push([i, v]);
  }

  const n = pts.length;
  if (n < 4) return [];

  const method = opts.method ?? 'iqr';
  const detrend = opts.detrend !== false;
  const fit = detrend ? linearFit(pts) : null;
  const slope = fit ? fit.slope : 0;
  const intercept = fit ? fit.intercept : pts.reduce((s, p) => s + p[1], 0) / n;

  const residuals = pts.map(([x, y]) => y - (slope * x + intercept));
  const anomalies: AnomalyPoint[] = [];

  if (method === 'zscore') {
    const k = opts.sensitivity ?? 2.5;
    const meanR = residuals.reduce((s, r) => s + r, 0) / n;
    const sumSq = residuals.reduce((s, r) => s + (r - meanR) ** 2, 0);
    const stdDev = Math.sqrt(sumSq / n);
    if (stdDev === 0) return [];

    pts.forEach(([idx, val], i) => {
      const z = (residuals[i] - meanR) / stdDev;
      if (Math.abs(z) >= k) {
        const expected = slope * idx + intercept;
        anomalies.push({
          index: idx,
          value: val,
          expected,
          score: Math.abs(z),
          direction: z > 0 ? 'high' : 'low',
          explanation: `${z > 0 ? '+' : ''}${z.toFixed(1)}σ from expected`,
        });
      }
    });
  } else {
    const k = opts.sensitivity ?? 1.5;
    const sorted = [...residuals].sort((a, b) => a - b);
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    const iqr = q3 - q1;
    if (iqr === 0) {
      return detectAnomalies(rawValues, { ...opts, method: 'zscore' });
    }

    const lowerBound = q1 - k * iqr;
    const upperBound = q3 + k * iqr;

    pts.forEach(([idx, val], i) => {
      const r = residuals[i];
      const expected = slope * idx + intercept;
      if (r > upperBound) {
        const score = (r - q3) / iqr;
        anomalies.push({
          index: idx,
          value: val,
          expected,
          score,
          direction: 'high',
          explanation: `+${score.toFixed(1)}x IQR above expected`,
        });
      } else if (r < lowerBound) {
        const score = (q1 - r) / iqr;
        anomalies.push({
          index: idx,
          value: val,
          expected,
          score,
          direction: 'low',
          explanation: `-${score.toFixed(1)}x IQR below expected`,
        });
      }
    });
  }

  return anomalies;
}
