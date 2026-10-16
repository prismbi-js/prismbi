import type { CellValue, ColumnRef } from './types';
import { columnRefToString, compareValues, parseColumnRef, valueKey } from './types';

export type FilterOp =
  | 'in'
  | 'notIn'
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'isBlank'
  | 'isNotBlank';

/** Public, serialisable filter on one column (Power BI "basic"/"advanced" filter). */
export interface ColumnFilterSpec {
  target: string | ColumnRef;
  op: FilterOp;
  value?: CellValue;
  values?: CellValue[];
  /** Inclusive bounds for `between`. Either may be omitted for open ranges. */
  min?: CellValue;
  max?: CellValue;
}

/** Filter on combinations of columns, produced by multi-column selections. */
export interface TupleFilterSpec {
  targets: (string | ColumnRef)[];
  op: 'tuples';
  tuples: CellValue[][];
  /** Keep everything except these combinations ("Exclude"). */
  exclude?: boolean;
}

/** Keep the N groups with the highest/lowest value of `by` (visual-level Top N). */
export interface TopNFilterSpec {
  target: string | ColumnRef;
  op: 'topN';
  n: number;
  /** Measure name or DAX expression to rank by. */
  by: string;
  direction?: 'top' | 'bottom';
}

export type FilterSpec = ColumnFilterSpec | TupleFilterSpec | TopNFilterSpec;

/** Compiled filter that the engine understands. */
export type Filter = ColumnsFilter | RowsFilter;

export interface ColumnsFilter {
  kind: 'columns';
  columns: ColumnRef[];
  key: string;
  test: (values: CellValue[]) => boolean;
  /** For single-column equality/`in` filters: value keys usable against the column hash index. */
  lookupKeys?: unknown[];
  spec?: FilterSpec;
  /** `'group'` marks filters introduced by a visual's own grouping (removed by ALLSELECTED). */
  origin?: 'group';
}

export interface RowsFilter {
  kind: 'rows';
  table: string;
  rows: Set<number>;
  key: string;
}

export type FilterContext = readonly Filter[];

let rowsFilterSeq = 0;

export function rowsFilter(table: string, rows: Iterable<number>): RowsFilter {
  const set = new Set(rows);
  // small row sets get a deterministic key so cached results are reused across iterations
  const key = set.size <= 64 ? `rows#${table}#${[...set].sort((a, b) => a - b).join(',')}` : `rows#${table}#seq${++rowsFilterSeq}`;
  return { kind: 'rows', table, rows: set, key };
}

function strOf(v: CellValue): string {
  return v === null ? '' : v instanceof Date ? v.toISOString() : String(v);
}

function stableKey(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x instanceof Date ? `D${x.getTime()}` : x));
}

/** Compile a public filter spec into an engine filter. TopN must be resolved by the query engine first. */
export function compileFilter(spec: ColumnFilterSpec | TupleFilterSpec): ColumnsFilter {
  if (spec.op === 'tuples') {
    const t = spec as TupleFilterSpec;
    const columns = t.targets.map(parseColumnRef);
    const set = new Set(t.tuples.map((tu) => stableKey(tu.map(valueKey))));
    return {
      kind: 'columns',
      columns,
      key: `tuples${t.exclude ? '!' : ''}(${columns.map(columnRefToString).join(',')})=${stableKey(t.tuples.map((tu) => tu.map(valueKey)))}`,
      test: t.exclude ? (vals) => !set.has(stableKey(vals.map(valueKey))) : (vals) => set.has(stableKey(vals.map(valueKey))),
      spec,
    };
  }
  const s = spec as ColumnFilterSpec;
  const col = parseColumnRef(s.target);
  const key = `${columnRefToString(col)} ${s.op} ${stableKey([s.value, s.values, s.min, s.max])}`;
  const base = { kind: 'columns' as const, columns: [col], key, spec };
  const v = s.value ?? null;
  switch (s.op) {
    case 'eq':
      return { ...base, test: ([x]) => valueKey(x) === valueKey(v), lookupKeys: [valueKey(v)] };
    case 'in': {
      const keys = (s.values ?? []).map(valueKey);
      const set = new Set(keys);
      return { ...base, test: ([x]) => set.has(valueKey(x)), lookupKeys: [...set] };
    }
    case 'neq':
      return { ...base, test: ([x]) => valueKey(x) !== valueKey(v) };
    case 'notIn': {
      const set = new Set((s.values ?? []).map(valueKey));
      return { ...base, test: ([x]) => !set.has(valueKey(x)) };
    }
    case 'gt':
      return { ...base, test: ([x]) => x !== null && compareValues(x, v) > 0 };
    case 'gte':
      return { ...base, test: ([x]) => x !== null && compareValues(x, v) >= 0 };
    case 'lt':
      return { ...base, test: ([x]) => x !== null && compareValues(x, v) < 0 };
    case 'lte':
      return { ...base, test: ([x]) => x !== null && compareValues(x, v) <= 0 };
    case 'between': {
      const lo = s.min ?? null;
      const hi = s.max ?? null;
      return {
        ...base,
        test: ([x]) => x !== null && (lo === null || compareValues(x, lo) >= 0) && (hi === null || compareValues(x, hi) <= 0),
      };
    }
    case 'contains': {
      const needle = strOf(v).toLowerCase();
      return { ...base, test: ([x]) => strOf(x).toLowerCase().includes(needle) };
    }
    case 'notContains': {
      const needle = strOf(v).toLowerCase();
      return { ...base, test: ([x]) => !strOf(x).toLowerCase().includes(needle) };
    }
    case 'startsWith': {
      const needle = strOf(v).toLowerCase();
      return { ...base, test: ([x]) => strOf(x).toLowerCase().startsWith(needle) };
    }
    case 'endsWith': {
      const needle = strOf(v).toLowerCase();
      return { ...base, test: ([x]) => strOf(x).toLowerCase().endsWith(needle) };
    }
    case 'isBlank':
      return { ...base, test: ([x]) => x === null || x === '', lookupKeys: [null] };
    case 'isNotBlank':
      return { ...base, test: ([x]) => !(x === null || x === '') };
    default:
      throw new Error(`Unknown filter operator "${(s as ColumnFilterSpec).op}"`);
  }
}

export function contextKey(ctx: FilterContext): string {
  return ctx.map((f) => f.key).sort().join('|');
}

function sameColumns(a: ColumnRef[], b: ColumnRef[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((c) => b.some((d) => d.table === c.table && d.column === c.column));
}

/**
 * CALCULATE semantics: each new filter overwrites existing filters on the same column(s).
 * Row-set filters on a table overwrite earlier row-set filters on that table.
 */
export function overrideFilters(ctx: FilterContext, add: Filter[]): Filter[] {
  const out = ctx.filter(
    (f) =>
      !add.some((n) => {
        if (n.kind === 'rows' && f.kind === 'rows') return n.table === f.table;
        if (n.kind === 'columns' && f.kind === 'columns') {
          // a single-column filter overrides any filter that touches that column
          if (n.columns.length === 1) return f.columns.some((c) => c.table === n.columns[0].table && c.column === n.columns[0].column);
          return sameColumns(n.columns, f.columns);
        }
        return false;
      }),
  );
  return [...out, ...add];
}

export function filterTouchesTable(f: Filter, tables: Set<string>): boolean {
  return f.kind === 'rows' ? tables.has(f.table) : f.columns.some((c) => tables.has(c.table));
}
