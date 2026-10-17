import type { CellValue, DataType } from './types';
import { valueKey } from './types';
import type { Filter, FilterContext } from './filters';
import { contextKey } from './filters';
import type { DataModel } from './model';

/**
 * Pre-aggregation of a fact column by the rows of one dimension. When the filters that do not involve that
 * dimension stay the same across many evaluations (YTD / running totals per day, a measure per period), the
 * aggregate over a set of dimension rows is a sum of per-row partials instead of a scan of the fact rows.
 */
interface Partial {
  sum: Float64Array;
  cnt: Int32Array;
  min: Float64Array;
  max: Float64Array;
  type: DataType;
}

export type PartialKind = 'SUM' | 'AVERAGE' | 'MIN' | 'MAX' | 'COUNT' | 'COUNTA';

/** Build only for a filter split that has been requested before, so one-off contexts never pay for it. */
const MIN_HITS = 2;
const CACHE_LIMIT = 200;
/** With fewer visible dimension rows the key-index path is already cheap. */
const MIN_DIM_ROWS = 16;

export class PartialAggregates {
  private hits = new Map<string, number>();
  private cache = new Map<string, Partial>();

  constructor(private model: DataModel) {}

  clear(): void {
    this.hits.clear();
    this.cache.clear();
  }

  /** Aggregate `table[column]` under `ctx` from per-dimension partials, or `undefined` when not applicable. */
  evaluate(kind: PartialKind, table: string, column: string, ctx: FilterContext): CellValue | undefined {
    const m = this.model;
    if (!ctx.length || ctx.some((f) => f.kind === 'rel')) return undefined;
    const dims = m.outgoing(table);
    if (!dims.length || m.relationships().some((r) => r.crossFilter === 'both' && r.active && (r.fromTable === table || r.toTable === table || dims.some((d) => d.toTable === r.toTable || d.toTable === r.fromTable)))) return undefined;
    for (const rel of dims) {
      const dimFilters: Filter[] = [];
      const rest: Filter[] = [];
      let ok = true;
      for (const f of ctx) {
        if (m.filterApplies(f, rel.toTable)) {
          // the filter must reach the fact only through this dimension
          if (dims.some((o) => o !== rel && m.filterApplies(f, o.toTable))) ok = false;
          dimFilters.push(f);
        } else rest.push(f);
      }
      if (!ok || !dimFilters.length) continue;
      const dimRows = m.rowsOf(rel.toTable, dimFilters);
      if (dimRows.length < MIN_DIM_ROWS) continue;
      const key = `${table}\u0001${column}\u0001${rel.toTable}\u0001${contextKey(rest)}`;
      let p = this.cache.get(key);
      if (!p) {
        const n = (this.hits.get(key) ?? 0) + 1;
        if (this.hits.size > 10_000) this.hits.clear();
        this.hits.set(key, n);
        if (n < MIN_HITS) continue;
        p = this.build(table, column, rel.fromColumn, rel.toTable, rel.toColumn, rest);
        if (this.cache.size >= CACHE_LIMIT) this.cache.clear();
        this.cache.set(key, p);
      }
      return combine(kind, p, dimRows);
    }
    return undefined;
  }

  private build(table: string, column: string, fkColumn: string, dim: string, pkColumn: string, rest: Filter[]): Partial {
    const m = this.model;
    const t = m.table(table);
    const col = t.column(column);
    const d = m.table(dim);
    const size = d.rowCount;
    const p: Partial = { sum: new Float64Array(size), cnt: new Int32Array(size), min: new Float64Array(size).fill(Infinity), max: new Float64Array(size).fill(-Infinity), type: col.type };
    // foreign-key dictionary → dimension row, once per distinct key
    const pk = d.index(pkColumn);
    const { codes, dict } = t.codes(fkColumn);
    const dimRow = new Int32Array(dict.length + 1);
    dimRow[0] = pk.get(valueKey(null))?.[0] ?? -1;
    for (let k = 0; k < dict.length; k++) dimRow[k + 1] = pk.get(valueKey(dict[k]))?.[0] ?? -1;
    const numeric = col.type === 'number' || col.type === 'date' || col.type === 'boolean';
    const nums = numeric ? t.numeric(column) : null;
    const vals = col.values;
    const rows = m.rowsOf(table, rest);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const di = dimRow[codes[r] + 1];
      if (di < 0) continue;
      if (nums) {
        const v = nums[r];
        if (v !== v) continue;
        p.cnt[di]++;
        p.sum[di] += v;
        if (v < p.min[di]) p.min[di] = v;
        if (v > p.max[di]) p.max[di] = v;
      } else {
        const v = vals[r];
        if (v !== null && v !== '') p.cnt[di]++;
      }
    }
    return p;
  }
}

function combine(kind: PartialKind, p: Partial, dimRows: number[]): CellValue {
  let n = 0;
  let sum = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < dimRows.length; i++) {
    const d = dimRows[i];
    const c = p.cnt[d];
    if (!c) continue;
    n += c;
    sum += p.sum[d];
    if (p.min[d] < lo) lo = p.min[d];
    if (p.max[d] > hi) hi = p.max[d];
  }
  if (!n) return null;
  switch (kind) {
    case 'SUM':
      return sum;
    case 'AVERAGE':
      return sum / n;
    case 'MIN':
      return p.type === 'date' ? new Date(lo) : lo;
    case 'MAX':
      return p.type === 'date' ? new Date(hi) : hi;
    default:
      return n;
  }
}
