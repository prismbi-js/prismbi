import type { CellValue, ColumnRef, DataType } from './types';
import { columnRefToString, compareValues, isColumnRefString, parseColumnRef, valueKey } from './types';
import type { ColumnsFilter, Filter, FilterSpec, TopNFilterSpec } from './filters';
import { compileFilter } from './filters';
import type { DataModel } from './model';
import type { Expr } from '../dax/ast';
import { parseDax } from '../dax/parser';
import { fastGroupQuery, useFastQuery } from './fastQuery';
import { aggregationRewrite, parsedValues } from './aggregations';
import { computeVisualCalc } from './visualCalc';

export type Aggregation = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'countRows' | 'distinctCount' | 'median' | 'first' | 'last';

/**
 * A field placed in a visual's data well:
 * - `"Total Sales"` → measure
 * - `"Sales[Amount]"` → column (grouping wells) or implicit aggregation (value wells)
 * - `{ field: "Sales[Amount]", aggregation: "avg" }`
 * - `{ expression: "SUM(Sales[Amount]) * 1.1", name: "Forecast" }` → ad-hoc DAX
 */
export type FieldSpec =
  | string
  | {
      field?: string;
      expression?: string;
      aggregation?: Aggregation;
      /** Display name. */
      name?: string;
      format?: string;
      /**
       * Visual calculation over this visual's result rows, e.g. `RUNNINGSUM([Total Sales])` or
       * `[Total Sales] - PREVIOUS([Total Sales])`. Evaluated after sorting and Top N.
       */
      visualCalc?: string;
      /** For visual calculations: `'parent'` restarts window functions when the outer group changes. */
      reset?: 'none' | 'parent';
    };

export interface QuerySpec {
  /** Columns to group by, e.g. `['Products[Category]', 'Date[Year]']`. */
  groupBy?: string[];
  values?: FieldSpec[];
  filters?: (FilterSpec | Filter)[];
  /** Extra filters whose effect is returned separately as `highlights` (Power BI highlighting). */
  highlight?: (FilterSpec | Filter)[];
  /** Sort keys. `field` is a group column ref, a value name, or `{ value: index }` / `{ group: index }`. */
  orderBy?: { field: string | { value: number } | { group: number }; direction?: 'asc' | 'desc' }[];
  /** Keep the first N rows after sorting. */
  top?: number;
  totals?: boolean;
  /** Keep groups where every value is BLANK ("Show items with no data"). */
  includeEmpty?: boolean;
  /** Safety cap on returned rows (default 30 000). */
  limit?: number;
}

export interface QueryField {
  name: string;
  ref: string;
  kind: 'group' | 'value';
  type?: DataType;
  format?: string;
  column?: ColumnRef;
}

export interface QueryRow {
  keys: CellValue[];
  values: CellValue[];
  highlights?: CellValue[];
  /** Per-value formats from calculation items in this row's context (when they differ from the field's). */
  formats?: (string | undefined)[];
}

export interface QueryResult {
  groups: QueryField[];
  values: QueryField[];
  rows: QueryRow[];
  totals?: CellValue[];
  truncated: boolean;
  /** Filters that produced this result (for drill-through / selection identities). */
  baseFilters: readonly Filter[];
  /** The aggregation table that answered the query, when one did ({@link DataModel.addAggregation}). */
  aggregation?: string;
}

const AGG_FN: Record<Aggregation, string> = {
  sum: 'SUM',
  avg: 'AVERAGE',
  min: 'MIN',
  max: 'MAX',
  count: 'COUNTA',
  countRows: 'COUNTROWS',
  distinctCount: 'DISTINCTCOUNT',
  median: 'MEDIAN',
  first: 'MIN',
  last: 'MAX',
};

const AGG_LABEL: Record<Aggregation, string> = {
  sum: 'Sum of',
  avg: 'Average of',
  min: 'Min of',
  max: 'Max of',
  count: 'Count of',
  countRows: 'Count of',
  distinctCount: 'Count (Distinct) of',
  median: 'Median of',
  first: 'First',
  last: 'Last',
};

export interface ResolvedValue extends QueryField {
  ast: Expr;
}

/** Turn a FieldSpec into an expression the evaluator can run. */
export function resolveValueField(model: DataModel, f: FieldSpec): ResolvedValue {
  const spec = typeof f === 'string' ? { field: f } : f;
  if (spec.expression) {
    const ast = (typeof f === 'object' && parsedValues.get(f)) || parseDax(spec.expression);
    return { kind: 'value', name: spec.name ?? spec.expression, ref: spec.expression, ast, format: spec.format };
  }
  const field = spec.field ?? '';
  const bare = field.replace(/^\[|\]$/g, '');
  if (!isColumnRefString(field) && model.hasMeasure(bare)) {
    const m = model.measure(bare);
    return { kind: 'value', name: spec.name ?? m.name, ref: m.name, ast: parseDax(`[${m.name}]`), format: spec.format ?? m.format, type: undefined };
  }
  if (isColumnRefString(field)) {
    const col = parseColumnRef(field);
    const c = model.table(col.table).column(col.column);
    const agg: Aggregation = spec.aggregation ?? (c.type === 'number' ? 'sum' : 'count');
    const ref = columnRefToString(col);
    const expr = agg === 'countRows' ? `COUNTROWS(${columnRefToString({ table: col.table, column: '' }).replace(/\[\]$/, '')})` : `${AGG_FN[agg]}(${ref})`;
    const keepsFormat = ['sum', 'avg', 'min', 'max', 'median', 'first', 'last'].includes(agg);
    return {
      kind: 'value',
      name: spec.name ?? `${AGG_LABEL[agg]} ${col.column}`,
      ref,
      ast: parseDax(expr),
      format: spec.format ?? (keepsFormat ? c.format : undefined),
      type: keepsFormat ? c.type : 'number',
      column: col,
    };
  }
  throw new Error(`Unknown field "${field}". Use a measure name or a Table[Column] reference.`);
}

export function resolveGroupField(model: DataModel, ref: string): QueryField & { column: ColumnRef } {
  const col = parseColumnRef(ref);
  const c = model.table(col.table).column(col.column);
  return { kind: 'group', name: col.column, ref: columnRefToString(col), type: c.type, format: c.format, column: col };
}

/** Build a function returning `col`'s value for each row of `anchor` (follows many→one relationships). */
function resolver(model: DataModel, anchor: string, col: ColumnRef): (row: number) => CellValue {
  const target = model.table(col.table).column(col.column).values;
  if (col.table === anchor) return (r) => target[r];
  const map = model.relatedRows(anchor, col.table)!;
  return (r) => {
    const t = map[r];
    return t < 0 ? null : target[t];
  };
}

function resolveTopN(model: DataModel, spec: TopNFilterSpec, ctx: Filter[]): ColumnsFilter {
  const col = parseColumnRef(spec.target);
  const by = resolveValueField(model, spec.by);
  const vals = model.valuesOf(col, ctx);
  const scored = vals.map((v) => ({
    v,
    s: model.evaluator.evalScalar(by.ast, { filters: [...ctx, compileFilter({ target: col, op: 'eq', value: v })] }),
  }));
  const dir = spec.direction === 'bottom' ? 1 : -1;
  scored.sort((a, b) => (a.s === null ? 1 : b.s === null ? -1 : compareValues(a.s, b.s) * dir));
  return compileFilter({ target: col, op: 'in', values: scored.slice(0, spec.n).map((x) => x.v) });
}

export function runQuery(model: DataModel, spec: QuerySpec): QueryResult {
  const aggs = model.aggregations();
  const hit = aggs.length ? aggregationRewrite(model, spec, aggs, resolveValueField) : null;
  if (hit) {
    // run against the aggregation table, then report the fields as asked for
    const res = runQueryAll(model, hit.spec);
    const groups = (spec.groupBy ?? []).map((g) => resolveGroupField(model, g));
    const values = (spec.values ?? []).map((v, i) => (typeof v === 'object' && v.visualCalc ? res.values[i] : stripAst(resolveValueField(model, v))));
    return { ...res, groups, values: values.map((v, i) => ({ ...v, format: res.values[i]?.format ?? v.format })), aggregation: hit.table };
  }
  return runQueryAll(model, spec);
}

function runQueryAll(model: DataModel, spec: QuerySpec): QueryResult {
  const plan = visualCalcPlan(spec);
  return plan ? plan.finish(runQueryCore(model, plan.spec)) : runQueryCore(model, spec);
}

/**
 * For a query with visual calculations: the query of its plain values, and `finish` to add the calculations to that
 * query's result. Null when there are none. Lets other engines (SQL, workers) support visual calculations.
 */
export function visualCalcPlan(spec: QuerySpec): { spec: QuerySpec; finish: <R extends Omit<QueryResult, 'baseFilters'>>(res: R) => R } | null {
  const all = spec.values ?? [];
  const isCalc = (v: FieldSpec): v is Exclude<FieldSpec, string> & { visualCalc: string } => typeof v === 'object' && !!v.visualCalc;
  if (!all.some(isCalc)) return null;
  // run the plain values, then evaluate visual calculations over the final (sorted, Top N) rows
  const plain = all.filter((v) => !isCalc(v));
  return { spec: { ...spec, values: plain, orderBy: spec.orderBy?.filter((o) => typeof o.field !== 'object' || !('value' in o.field)) }, finish: (res) => finishVisualCalcs(all, isCalc, res) };
}

function finishVisualCalcs<R extends Omit<QueryResult, 'baseFilters'>>(all: FieldSpec[], isCalc: (v: FieldSpec) => v is Exclude<FieldSpec, string> & { visualCalc: string }, res: R): R {
  const plainFields = res.values;
  const values: QueryField[] = [];
  const calcCols = new Map<number, { values: CellValue[]; highlights?: CellValue[]; total?: CellValue }>();
  let pi = 0;
  all.forEach((v, i) => {
    if (!isCalc(v)) {
      values.push(plainFields[pi++]);
      return;
    }
    values.push({ kind: 'value', name: v.name ?? v.visualCalc, ref: v.visualCalc, format: v.format, type: 'number' });
    const calc = { expression: v.visualCalc, reset: v.reset };
    const col = computeVisualCalc(calc, res.rows, plainFields, res.groups.length);
    const hasHl = res.rows.some((r) => r.highlights);
    const hl = hasHl ? computeVisualCalc(calc, res.rows, plainFields, res.groups.length, (r) => r.highlights) : undefined;
    const total = res.totals ? computeVisualCalc(calc, [{ keys: [], values: res.totals }], plainFields, 0)[0] : undefined;
    calcCols.set(i, { values: col, highlights: hl, total });
  });
  const merge = (plainVals: CellValue[] | undefined, row: number, which: 'values' | 'highlights'): CellValue[] | undefined => {
    if (!plainVals) return undefined;
    let k = 0;
    return all.map((v, i) => (isCalc(v) ? ((calcCols.get(i)![which]?.[row] as CellValue | undefined) ?? null) : plainVals[k++]));
  };
  return {
    ...res,
    values,
    rows: res.rows.map((r, ri) => ({ ...r, values: merge(r.values, ri, 'values')!, highlights: merge(r.highlights, ri, 'highlights') })),
    totals: res.totals ? (() => {
      let k = 0;
      return all.map((v, i) => (isCalc(v) ? (calcCols.get(i)!.total ?? null) : res.totals![k++]));
    })() : undefined,
  };
}

function runQueryCore(model: DataModel, spec: QuerySpec): QueryResult {
  const res = runQueryPlain(model, spec);
  return model.hasCalculationFormats ? applyCalcFormats(model, spec, res) : res;
}

/** Calculation-item formats: one item for the whole query overrides the field format; items per row go in `row.formats`. */
function applyCalcFormats(model: DataModel, spec: QuerySpec, res: QueryResult): QueryResult {
  const measures = res.values.map((v) => (model.hasMeasure(v.ref) ? v.ref : null));
  if (!measures.some(Boolean)) return res;
  const base = res.baseFilters as Filter[];
  const values = res.values.map((v, k) => {
    const f = measures[k] ? model.evaluator.measureFormat(measures[k]!, base) : undefined;
    return f ? { ...v, format: f } : v;
  });
  const groups = res.groups as (QueryField & { column?: ColumnRef })[];
  const calcTables = new Set(model.calculationGroups().map((g) => g.table));
  const byRow = groups.some((g) => g.column && calcTables.has(g.column.table));
  const rows = !byRow
    ? res.rows
    : res.rows.map((r) => {
        const ctx = [...base, ...groups.map((g, i) => groupFilter(g.column!, r.keys[i]))];
        const formats = values.map((_v, k) => (measures[k] ? model.evaluator.measureFormat(measures[k]!, ctx) : undefined));
        return formats.some((f, k) => f && f !== values[k].format) ? { ...r, formats } : r;
      });
  void spec;
  return { ...res, values, rows };
}

function runQueryPlain(model: DataModel, spec: QuerySpec): QueryResult {
  const groups = (spec.groupBy ?? []).map((g) => resolveGroupField(model, g));
  const values = (spec.values ?? []).map((v) => resolveValueField(model, v));
  const limit = spec.limit ?? 30_000;

  // base filter context (resolve Top N filters against the others)
  const raw = spec.filters ?? [];
  let base: Filter[] = model.toContext(raw.filter((f) => !('op' in f && f.op === 'topN')) as (FilterSpec | Filter)[]);
  for (const f of raw) if ('op' in f && f.op === 'topN') base = [...base, resolveTopN(model, f as TopNFilterSpec, base)];
  const highlight = spec.highlight?.length ? model.toContext(spec.highlight) : undefined;

  const evalValues = (filters: Filter[]) => values.map((v) => model.evaluator.evalScalar(v.ast, { filters }));

  let rows: QueryRow[] = [];
  if (groups.length === 0) {
    if (values.length) rows = [{ keys: [], values: evalValues(base), highlights: highlight ? evalValues([...base, ...highlight]) : undefined }];
  } else {
    let truncated = false;
    let totals: CellValue[] | undefined;
    const cols = groups.map((g) => g.column);
    const fast = !spec.includeEmpty && useFastQuery(model, cols, values.map((v) => v.ast)) ? fastGroupQuery(model, cols, values.map((v) => v.ast), base, highlight, () => groupCombos(model, cols, base, true), !!spec.totals) : null;
    if (fast) {
      rows = fast.rows;
      totals = fast.totals;
    } else for (const keys of groupCombos(model, groups.map((g) => g.column), base, values.length > 0)) {
      const gf = groups.map((g, i) => groupFilter(g.column, keys[i]));
      const ctx = [...base, ...gf];
      const vals = evalValues(ctx);
      if (values.length && !spec.includeEmpty && vals.every((v) => v === null)) continue;
      rows.push({ keys, values: vals, highlights: highlight ? evalValues([...ctx, ...highlight]) : undefined });
    }
    sortRows(model, rows, groups, values, spec);
    if (spec.top !== undefined) rows = rows.slice(0, spec.top);
    if (rows.length > limit) {
      rows = rows.slice(0, limit);
      truncated = true;
    }
    return { groups, values: values.map(stripAst), rows, totals: spec.totals ? (totals ?? evalValues(base)) : undefined, truncated, baseFilters: base };
  }
  return { groups, values: values.map(stripAst), rows, totals: spec.totals ? evalValues(base) : undefined, truncated: false, baseFilters: base };
}

/** Filter introduced by a visual's grouping; distinct cache key so ALLSELECTED results never collide. */
export function groupFilter(column: ColumnRef, value: CellValue): ColumnsFilter {
  const f = compileFilter({ target: column, op: 'eq', value });
  return { ...f, origin: 'group', key: `${f.key}@group` };
}

function stripAst({ ast: _ast, ...rest }: ResolvedValue): QueryField {
  return rest;
}

/** Distinct combinations of group columns that exist under the filter context ("auto-exist"). */
export function groupCombos(model: DataModel, cols: ColumnRef[], ctx: Filter[], hasValues: boolean): CellValue[][] {
  const tables = [...new Set(cols.map((c) => c.table))];
  const dedupe = (rowsIter: Iterable<CellValue[]>) => {
    const m = new Map<string, CellValue[]>();
    for (const tu of rowsIter) {
      const k = tu.length === 1 ? String(valueKey(tu[0])) + typeof tu[0] : JSON.stringify(tu.map(valueKey));
      if (!m.has(k)) m.set(k, tu);
    }
    return [...m.values()];
  };

  const fromAnchor = (anchor: string): CellValue[][] => {
    const rows = model.rowsOf(anchor, ctx);
    // distinct tuples by dictionary codes: a mixed-radix number per row (BLANK = digit 0) instead of a string key
    const coded = cols.map((c) => ({ ...model.table(c.table).codes(c.column), map: c.table === anchor ? null : model.relatedRows(anchor, c.table) }));
    const radix = coded.map((c) => c.dict.length + 1);
    const space = radix.reduce((a, b) => a * b, 1);
    if (space <= Number.MAX_SAFE_INTEGER && coded.every((c, j) => cols[j].table === anchor || c.map)) {
      const dense = space <= 1 << 22 ? new Uint8Array(space) : null;
      const seen = new Set<number>();
      const out: CellValue[][] = [];
      const code = (j: number, r: number) => {
        const { codes, map } = coded[j];
        const t = map ? map[r] : r;
        return t < 0 ? -1 : codes[t];
      };
      for (const r of rows) {
        let k = 0;
        for (let j = 0; j < coded.length; j++) k = k * radix[j] + code(j, r) + 1;
        if (dense ? dense[k] : seen.has(k)) continue;
        if (dense) dense[k] = 1;
        else seen.add(k);
        out.push(coded.map((c, j) => {
          const x = code(j, r);
          return x < 0 ? null : c.dict[x];
        }));
      }
      return out;
    }
    const rs = cols.map((c) => resolver(model, anchor, c));
    function* gen() {
      for (const r of rows) yield rs.map((f) => f(r));
    }
    return dedupe(gen());
  };

  if (tables.length === 1) {
    if (cols.length === 1) return model.valuesOf(cols[0], ctx).map((v) => [v]);
    return fromAnchor(tables[0]);
  }
  // pick an anchor table whose expanded table covers every group table (prefer the biggest – the fact)
  const anchors = model
    .tableNames()
    .filter((t) => tables.every((g) => model.expanded(t).has(g)))
    .sort((a, b) => model.table(b).rowCount - model.table(a).rowCount);
  if (anchors.length) return fromAnchor(anchors[0]);

  // no common fact: cross join per-table tuples (measures will prune empty combinations)
  if (!hasValues) throw new Error(`Columns from unrelated tables (${tables.join(', ')}) need at least one measure to be combined`);
  let acc: CellValue[][] = [[]];
  const order: number[] = [];
  for (const t of tables) {
    const tcols = cols.map((c, i) => ({ c, i })).filter((x) => x.c.table === t);
    order.push(...tcols.map((x) => x.i));
    const rs = tcols.map((x) => resolver(model, t, x.c));
    const tuples = dedupe(model.rowsOf(t, ctx).map((r) => rs.map((f) => f(r))));
    const next: CellValue[][] = [];
    for (const a of acc) for (const tu of tuples) next.push([...a, ...tu]);
    acc = next;
    if (acc.length > 1_000_000) throw new Error('Cross join too large; add a relationship between these tables');
  }
  return acc.map((tu) => {
    const out: CellValue[] = new Array(cols.length);
    order.forEach((colIdx, k) => (out[colIdx] = tu[k]));
    return out;
  });
}

function sortRows(model: DataModel, rows: QueryRow[], groups: (QueryField & { column: ColumnRef })[], values: QueryField[], spec: QuerySpec): void {
  // rank maps honour "sort by column"
  const ranks = groups.map((g) => {
    const m = new Map<unknown, number>();
    model.table(g.column.table).distinct(g.column.column).forEach((v, i) => m.set(valueKey(v), i));
    return m;
  });
  const keyCmp = (a: QueryRow, b: QueryRow, i: number) => (ranks[i].get(valueKey(a.keys[i])) ?? 0) - (ranks[i].get(valueKey(b.keys[i])) ?? 0);
  const order = spec.orderBy ?? [];
  const cmps = order.map((o) => {
    const dir = o.direction === 'desc' ? -1 : 1;
    let get: ((r: QueryRow) => CellValue) | null = null;
    let gi = -1;
    if (typeof o.field === 'object') {
      if ('value' in o.field) {
        const vi = o.field.value;
        get = (r) => r.values[vi];
      } else gi = o.field.group;
    } else {
      gi = groups.findIndex((g) => g.ref === o.field || g.name === o.field);
      if (gi < 0) {
        const vi = values.findIndex((v) => v.name === o.field || v.ref === o.field);
        if (vi >= 0) get = (r) => r.values[vi];
      }
    }
    return (a: QueryRow, b: QueryRow) => {
      if (get) {
        const x = get(a);
        const y = get(b);
        if (x === null && y === null) return 0;
        if (x === null) return 1; // blanks last
        if (y === null) return -1;
        return compareValues(x, y) * dir;
      }
      return gi >= 0 ? keyCmp(a, b, gi) * dir : 0;
    };
  });
  rows.sort((a, b) => {
    for (const c of cmps) {
      const r = c(a, b);
      if (r) return r;
    }
    for (let i = 0; i < groups.length; i++) {
      const r = keyCmp(a, b, i);
      if (r) return r;
    }
    return 0;
  });
}
