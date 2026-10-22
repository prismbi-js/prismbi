import type { CellValue, DataModel, FieldSpec, FilterSpec } from '@prismbi/prismbi';
import { candidateDimensions, formatter, measureName } from './explain';

export interface InfluencerOptions {
  /** The measure to explain (an average or rate reads best; sums and counts are compared per row). */
  measure: FieldSpec;
  /** Columns to look in (default: the model's categorical columns, as for insights). */
  explainBy?: string[];
  filters?: FilterSpec[];
  /** `'value'`: the measure in each segment. `'perRow'`: the measure per fact row. `'auto'` (default): per row when the measure adds up over segments (a sum or count). */
  basis?: 'auto' | 'value' | 'perRow';
  /** Segments smaller than this share of the rows are ignored (default 0.05). */
  minShare?: number;
  /** How many influencers to return (default 10). */
  max?: number;
}

export interface Influencer {
  /** The column, as a reference (`Region[Country]`). */
  column: string;
  value: CellValue;
  /** "Country is Canada". */
  label: string;
  /** The compared figure in the segment and overall (per row when `basis` is per row). */
  segment: number;
  overall: number;
  /** segment ÷ overall. */
  ratio: number;
  /** Share of the rows in the segment. */
  share: number;
  direction: 'up' | 'down';
  /** "1.8× higher". */
  effect: string;
}

export interface KeyInfluencers {
  measure: string;
  basis: 'value' | 'perRow';
  /** "Total Sales per row" or the measure's name. */
  metric: string;
  overall: number | null;
  influencers: Influencer[];
  /** Every analyzed column's segments, for charts. */
  columns: { column: string; name: string; segments: { value: CellValue; label: string; segment: number; share: number }[] }[];
  format: (v: number | null) => string;
}

const nameOf = (ref: string) => /^'?(.*?)'?\[([^\]]+)\]$/.exec(ref)?.[2] ?? ref;

/** The fact table: the largest table on the many side of a relationship. */
function factTable(model: DataModel): string | undefined {
  const facts = [...new Set(model.relationships().map((r) => r.fromTable))];
  return facts.sort((a, b) => model.table(b).rowCount - model.table(a).rowCount)[0];
}

/**
 * Which column values move a measure most: each value of each column is compared with the overall figure, and
 * the segments with the largest effect (weighted towards larger segments) come first.
 */
export function keyInfluencers(model: DataModel, opts: InfluencerOptions): KeyInfluencers {
  const filters = opts.filters ?? [];
  const explainBy = opts.explainBy?.length ? opts.explainBy : candidateDimensions(model);
  const fact = factTable(model);
  const rowsSpec: FieldSpec | undefined = fact ? { name: 'Rows', expression: `COUNTROWS('${fact.replace(/'/g, "''")}')` } : undefined;
  const values = rowsSpec ? [opts.measure, rowsSpec] : [opts.measure];
  const total = model.query({ values, filters }).rows[0];
  const overallValue = typeof total?.values[0] === 'number' ? (total.values[0] as number) : null;
  const totalRows = typeof total?.values[1] === 'number' ? (total.values[1] as number) : null;
  const per = explainBy.map((column) => ({ column, rows: model.query({ groupBy: [column], values, filters, includeEmpty: false }).rows }));
  // a measure that adds up over a column's segments (a sum, a count) is compared per row
  const additive =
    overallValue !== null &&
    per.some((p) => {
      const sum = p.rows.reduce((a, r) => a + (typeof r.values[0] === 'number' ? (r.values[0] as number) : 0), 0);
      return p.rows.length > 1 && Math.abs(sum - overallValue) <= 1e-9 * Math.max(1, Math.abs(overallValue));
    });
  const basis = opts.basis === 'value' || opts.basis === 'perRow' ? opts.basis : additive && totalRows ? 'perRow' : 'value';
  const perRow = basis === 'perRow' && !!totalRows;
  const overall = overallValue === null ? null : perRow ? overallValue / totalRows! : overallValue;
  const fmt = formatter(model, opts.measure);
  const name = measureName(opts.measure);
  const minShare = opts.minShare ?? 0.05;
  const influencers: (Influencer & { score: number })[] = [];
  const columns: KeyInfluencers['columns'] = [];
  for (const { column, rows } of per) {
    const segments: KeyInfluencers['columns'][number]['segments'] = [];
    for (const r of rows) {
      const v = r.values[0];
      const n = r.values[1];
      if (typeof v !== 'number' || r.keys[0] === null) continue;
      const share = typeof n === 'number' && totalRows ? n / totalRows : NaN;
      const segment = perRow ? (typeof n === 'number' && n > 0 ? v / n : NaN) : v;
      if (!Number.isFinite(segment)) continue;
      const label = String(r.keys[0] instanceof Date ? (r.keys[0] as Date).toISOString().slice(0, 10) : r.keys[0]);
      segments.push({ value: r.keys[0], label, segment, share });
      if (overall === null || overall <= 0 || segment <= 0 || (Number.isFinite(share) && share < minShare)) continue;
      const ratio = segment / overall;
      if (Math.abs(ratio - 1) < 0.02) continue;
      const up = ratio > 1;
      influencers.push({
        column,
        value: r.keys[0],
        label: `${nameOf(column)} is ${label}`,
        segment,
        overall,
        ratio,
        share,
        direction: up ? 'up' : 'down',
        effect: up ? `${ratio.toFixed(ratio >= 10 ? 0 : 1)}× higher` : `${((1 - ratio) * 100).toFixed(0)}% lower`,
        // a large effect in a large segment matters most
        score: Math.abs(Math.log(ratio)) * Math.sqrt(Number.isFinite(share) ? share : 1),
      });
    }
    columns.push({ column, name: nameOf(column), segments });
  }
  influencers.sort((a, b) => b.score - a.score);
  // the same rows found through another column (a subcategory with one product) are listed once
  const seen = new Set<string>();
  const distinct = influencers.filter((i) => {
    const k = `${i.share.toPrecision(12)}|${i.segment.toPrecision(12)}`;
    return !seen.has(k) && !!seen.add(k);
  });
  return {
    measure: name,
    basis: perRow ? 'perRow' : 'value',
    metric: perRow ? `${name} per row` : name,
    overall,
    influencers: distinct.slice(0, opts.max ?? 10).map(({ score: _s, ...i }) => i),
    columns,
    format: fmt,
  };
}
