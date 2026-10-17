import type { CellValue, DataModel, FieldSpec, FilterSpec, VisualSpec } from 'prismbi';
import { candidateDimensions, formatter, measureName } from './explain';

export interface Insight {
  kind: 'anomaly' | 'trend' | 'mover' | 'concentration' | 'outlier';
  title: string;
  detail: string;
  /** Higher is more notable (0–1). */
  score: number;
  /** A visual that shows it. */
  spec?: Omit<VisualSpec, 'layout'>;
}

export interface InsightOptions {
  measure: FieldSpec;
  filters?: FilterSpec[];
  /** Time column for the series (default: the calendar's year-month or date column). */
  time?: string;
  dimensions?: string[];
  max?: number;
}

const nameOf = (ref: string) => {
  const m = /^'?(.*?)'?\[([^\]]+)\]$/.exec(ref);
  return !m ? ref : /^name$/i.test(m[2]) ? m[1] : m[2];
};
const refOf = (table: string, column: string) => `${/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) ? table : `'${table}'`}[${column}]`;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const label = (v: CellValue) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

/** The calendar column to build series on: year-month labels when present, else the date. */
export function timeColumn(model: DataModel): string | undefined {
  for (const t of model.tableNames()) {
    const cols = [...model.table(t).columns.values()];
    if (!cols.some((c) => c.type === 'date') || !cols.some((c) => /^year$/i.test(c.name))) continue;
    const ym = cols.find((c) => /month.?year|year.?month/i.test(c.name) && c.type === 'string');
    return refOf(t, (ym ?? cols.find((c) => c.type === 'date')!).name);
  }
  return undefined;
}

/** Robust z-scores (median / MAD); 0 where the spread is zero. */
function robustZ(xs: number[]): number[] {
  const med = median(xs);
  const mad = median(xs.map((x) => Math.abs(x - med)));
  return xs.map((x) => (mad ? (0.6745 * (x - med)) / mad : 0));
}

/**
 * Automatic insights for a measure: unusual periods, the recent trend, what moved most in the latest period,
 * concentration in one member, and outlying members. Each comes with a visual spec.
 */
export function findInsights(model: DataModel, opts: InsightOptions): Insight[] {
  const m = opts.measure;
  const name = measureName(m);
  const fmt = formatter(model, m);
  const filters = opts.filters ?? [];
  const out: Insight[] = [];
  const time = opts.time ?? timeColumn(model);
  const dims = opts.dimensions ?? candidateDimensions(model);
  const values = (r: { values: CellValue[] }) => (typeof r.values[0] === 'number' ? (r.values[0] as number) : null);

  let lastTwo: CellValue[] = [];
  if (time) {
    const series = model.query({ groupBy: [time], values: [m], filters }).rows.filter((r) => values(r) !== null);
    const xs = series.map((r) => values(r)!);
    const lineSpec: Omit<VisualSpec, 'layout'> = { type: 'line', title: `${name} over time`, fields: { category: time, values: m }, filters };
    if (xs.length >= 6) {
      // anomalies: residuals from a centred rolling median
      const w = 2;
      const resid = xs.map((x, i) => x - median(xs.slice(Math.max(0, i - w), Math.min(xs.length, i + w + 1))));
      const z = robustZ(resid);
      z.map((zi, i) => ({ zi, i }))
        .filter((x) => Math.abs(x.zi) >= 3.5)
        .sort((a, b) => Math.abs(b.zi) - Math.abs(a.zi))
        .slice(0, 2)
        .forEach(({ zi, i }) => {
          const typical = xs[i] - resid[i];
          const ratio = typical ? xs[i] / typical : 0;
          out.push({
            kind: 'anomaly',
            title: `Unusual ${zi > 0 ? 'spike' : 'drop'} in ${name} in ${label(series[i].keys[0])}`,
            detail: `${fmt(xs[i])}${ratio > 0 ? `, ${ratio >= 1 ? `${ratio.toFixed(1)}×` : `${Math.round(ratio * 100)}% of`} the typical ${fmt(typical)}` : ''}.`,
            score: Math.min(1, Math.abs(zi) / 10),
            spec: lineSpec,
          });
        });
      // trend: the latest periods against the ones before
      const k = Math.min(6, Math.floor(xs.length / 2));
      const recent = xs.slice(-k).reduce((a, b) => a + b, 0);
      const before = xs.slice(-2 * k, -k).reduce((a, b) => a + b, 0);
      if (before) {
        const pct = (recent - before) / Math.abs(before);
        if (Math.abs(pct) >= 0.05)
          out.push({
            kind: 'trend',
            title: `${name} ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct * 100).toFixed(0)}% in the last ${k} periods`,
            detail: `${fmt(recent)} in the last ${k} periods against ${fmt(before)} in the ${k} before.`,
            score: Math.min(1, Math.abs(pct)),
            spec: lineSpec,
          });
      }
    }
    if (series.length >= 2) lastTwo = series.slice(-2).map((r) => r.keys[0]);
  }

  for (const d of dims) {
    const rows = model.query({ groupBy: [d], values: [m], filters }).rows.filter((r) => (values(r) ?? 0) > 0);
    if (rows.length < 2) continue;
    const total = rows.reduce((s, r) => s + values(r)!, 0);
    const sorted = [...rows].sort((a, b) => values(b)! - values(a)!);
    const lead = sorted[0];
    const share = values(lead)! / total;
    if (rows.length >= 3 && share >= 0.4)
      out.push({
        kind: 'concentration',
        title: `${label(lead.keys[0])} makes up ${Math.round(share * 100)}% of ${name}`,
        detail: `Across ${rows.length} ${nameOf(d)} values; the next is ${label(sorted[1].keys[0])} at ${Math.round((values(sorted[1])! / total) * 100)}%.`,
        score: Math.min(1, (share - 1 / rows.length) * 1.2),
        spec: { type: 'donut', title: `${name} by ${nameOf(d)}`, fields: { legend: d, values: m }, filters },
      });
    if (rows.length >= 6) {
      const z = robustZ(rows.map((r) => values(r)!));
      const i = z.reduce((best, zi, j) => (Math.abs(zi) > Math.abs(z[best]) ? j : best), 0);
      if (Math.abs(z[i]) >= 3.5)
        out.push({
          kind: 'outlier',
          title: `${label(rows[i].keys[0])} stands out among ${nameOf(d)} values`,
          detail: `${fmt(values(rows[i]))} against a typical ${fmt(median(rows.map((r) => values(r)!)))}.`,
          score: Math.min(1, Math.abs(z[i]) / 12),
          spec: { type: 'clusteredBar', title: `${name} by ${nameOf(d)}`, fields: { category: d, values: m }, filters, sort: { field: name, direction: 'desc' } },
        });
    }
    if (time && lastTwo.length === 2) {
      const at = (v: CellValue) => model.query({ groupBy: [d], values: [m], filters: [...filters, { target: time, op: 'eq', value: v }] }).rows;
      const prev = new Map(at(lastTwo[0]).map((r) => [label(r.keys[0]), values(r) ?? 0]));
      const now = at(lastTwo[1]);
      const deltas = now.map((r) => ({ key: r.keys[0], delta: (values(r) ?? 0) - (prev.get(label(r.keys[0])) ?? 0) }));
      const totalDelta = deltas.reduce((s, x) => s + x.delta, 0);
      const best = [...deltas].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
      if (best && totalDelta && Math.abs(best.delta / totalDelta) >= 0.5 && deltas.length >= 3)
        out.push({
          kind: 'mover',
          title: `${label(best.key)} drove the change in ${label(lastTwo[1])}`,
          detail: `${best.delta > 0 ? '+' : '−'}${fmt(Math.abs(best.delta))} versus ${label(lastTwo[0])}, ${Math.round(Math.abs(best.delta / totalDelta) * 100)}% of the total change in ${name}.`,
          score: Math.min(1, Math.abs(best.delta / totalDelta) * 0.8),
          spec: { type: 'clusteredBar', title: `${name} by ${nameOf(d)} in ${label(lastTwo[1])}`, fields: { category: d, values: m }, filters: [...filters, { target: time, op: 'eq', value: lastTwo[1] }], sort: { field: name, direction: 'desc' } },
        });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, opts.max ?? 8);
}
