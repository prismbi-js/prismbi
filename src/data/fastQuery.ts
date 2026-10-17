import type { Expr } from '../dax/ast';
import type { CellValue, ColumnRef } from './types';
import { valueKey } from './types';
import type { Filter } from './filters';
import type { DataModel } from './model';
import type { QueryRow } from './query';
import { compileRowExpr, type RowFn, type RowPlan } from '../dax/rowCompile';

/** A leaf aggregation computed in one pass over the fact table. */
interface Agg {
  kind: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'distinct' | 'rows' | 'sumx' | 'avgx';
  column?: string;
  isDate?: boolean;
  /** SUMX / AVERAGEX row expression. */
  row?: RowPlan;
}

type Tree =
  | { t: 'agg'; i: number }
  | { t: 'num'; v: number }
  | { t: 'bin'; op: '+' | '-' | '*' | '/'; l: Tree; r: Tree }
  | { t: 'div'; a: Tree; b: Tree; alt?: Tree };

const AGG_FN: Record<string, Agg['kind']> = { SUM: 'sum', AVERAGE: 'avg', MIN: 'min', MAX: 'max', COUNT: 'count', COUNTA: 'count', DISTINCTCOUNT: 'distinct' };

interface Plan {
  table: string | null;
  aggs: Agg[];
  keys: Map<string, number>;
}

/** Compile a value expression into a tree of single-pass aggregations, or null when it needs the full engine. */
function compile(model: DataModel, e: Expr, plan: Plan, seen: Set<string>): Tree | null {
  const leaf = (table: string, agg: Agg): Tree | null => {
    if (plan.table === null) plan.table = table;
    if (plan.table !== table) return null; // one fact table per plan
    const k = `${agg.kind}|${agg.column ?? ''}`;
    let i = plan.keys.get(k);
    if (i === undefined) {
      i = plan.aggs.length;
      plan.aggs.push(agg);
      plan.keys.set(k, i);
    }
    return { t: 'agg', i };
  };
  switch (e.type) {
    case 'number':
      return { t: 'num', v: e.value };
    case 'bracket': {
      if (!model.hasMeasure(e.name) || seen.has(e.name)) return null;
      seen.add(e.name);
      const r = compile(model, model.measure(e.name).ast, plan, seen);
      seen.delete(e.name);
      return r;
    }
    case 'unary':
      if (e.op !== '-') return null;
      return ((x) => (x ? { t: 'bin', op: '*', l: { t: 'num', v: -1 }, r: x } : null))(compile(model, e.operand, plan, seen));
    case 'binary': {
      if (!['+', '-', '*', '/'].includes(e.op)) return null;
      const l = compile(model, e.left, plan, seen);
      const r = l && compile(model, e.right, plan, seen);
      return l && r ? { t: 'bin', op: e.op as '+', l, r } : null;
    }
    case 'call': {
      if (e.name === 'DIVIDE' && (e.args.length === 2 || e.args.length === 3)) {
        const a = compile(model, e.args[0], plan, seen);
        const b = a && compile(model, e.args[1], plan, seen);
        const alt = e.args[2] ? compile(model, e.args[2], plan, seen) : undefined;
        return a && b && alt !== null ? { t: 'div', a, b, alt } : null;
      }
      if ((e.name === 'SUMX' || e.name === 'AVERAGEX') && e.args.length === 2 && e.args[0].type === 'table') {
        const table = e.args[0].name;
        if (!model.hasTable(table)) return null;
        // a grouped query has no outer row context, so bare references to related tables follow relationships
        const row = compileRowExpr(model, table, e.args[1], true);
        if (!row) return null;
        if (plan.table === null) plan.table = table;
        if (plan.table !== table) return null;
        plan.aggs.push({ kind: e.name === 'SUMX' ? 'sumx' : 'avgx', row });
        return { t: 'agg', i: plan.aggs.length - 1 };
      }
      if (e.name === 'COUNTROWS' && e.args.length === 1 && e.args[0].type === 'table') {
        if (!model.hasTable(e.args[0].name)) return null;
        return leaf(e.args[0].name, { kind: 'rows' });
      }
      const kind = AGG_FN[e.name];
      if (!kind || e.args.length !== 1 || e.args[0].type !== 'column') return null;
      const { table, column } = e.args[0];
      if (!model.hasTable(table) || !model.table(table).hasColumn(column)) return null;
      const type = model.table(table).column(column).type;
      if ((kind === 'sum' || kind === 'avg') && type !== 'number') return null;
      if ((kind === 'min' || kind === 'max') && type !== 'number' && type !== 'date') return null;
      return leaf(table, { kind, column, isDate: type === 'date' });
    }
  }
  return null;
}

/** True when the expression is BLANK whenever all its aggregations are BLANK (so empty groups drop out). */
function blankPreserving(t: Tree): boolean {
  switch (t.t) {
    case 'agg':
      return true;
    case 'num':
      return false;
    case 'bin':
      if (t.op === '*') return blankPreserving(t.l) || blankPreserving(t.r);
      return blankPreserving(t.l) && blankPreserving(t.r);
    case 'div':
      return blankPreserving(t.a) && (t.alt === undefined || blankPreserving(t.alt));
  }
}

const num = (v: CellValue) => (v === null ? 0 : typeof v === 'number' ? v : v instanceof Date ? v.getTime() / 86_400_000 : Number(v));

/** Evaluate a tree with the evaluator's exact BLANK arithmetic. */
function evalTree(t: Tree, vals: CellValue[]): CellValue {
  switch (t.t) {
    case 'agg':
      return vals[t.i];
    case 'num':
      return t.v;
    case 'bin': {
      const a = evalTree(t.l, vals);
      const b = evalTree(t.r, vals);
      if (t.op === '+' || t.op === '-') {
        if (a === null && b === null) return null;
        return t.op === '+' ? num(a) + num(b) : num(a) - num(b);
      }
      if (t.op === '*') return a === null || b === null ? null : num(a) * num(b);
      if (a === null && b === null) return null;
      if (num(b) === 0) return num(a) === 0 ? NaN : num(a) > 0 ? Infinity : -Infinity;
      return num(a) / num(b);
    }
    case 'div': {
      const a = evalTree(t.a, vals);
      const b = evalTree(t.b, vals);
      if (b === null || num(b) === 0) return t.alt ? evalTree(t.alt, vals) : null;
      if (a === null) return null;
      return num(a) / num(b);
    }
  }
}

/** Accumulator for one group. */
class Acc {
  rows = 0;
  sum: Float64Array;
  cnt: Int32Array;
  min: Float64Array;
  max: Float64Array;
  distinct: (Set<number> | null)[];

  constructor(aggs: Agg[]) {
    const n = aggs.length;
    this.sum = new Float64Array(n);
    this.cnt = new Int32Array(n);
    this.min = new Float64Array(n).fill(Infinity);
    this.max = new Float64Array(n).fill(-Infinity);
    this.distinct = aggs.map((a) => (a.kind === 'distinct' ? new Set<number>() : null));
  }

  result(aggs: Agg[]): CellValue[] {
    return aggs.map((a, i) => {
      switch (a.kind) {
        case 'rows':
          return this.rows || null;
        case 'sum':
        case 'sumx':
          return this.cnt[i] ? this.sum[i] : null;
        case 'avg':
        case 'avgx':
          return this.cnt[i] ? this.sum[i] / this.cnt[i] : null;
        case 'min':
          return this.cnt[i] ? (a.isDate ? new Date(this.min[i]) : this.min[i]) : null;
        case 'max':
          return this.cnt[i] ? (a.isDate ? new Date(this.max[i]) : this.max[i]) : null;
        case 'count':
          return this.cnt[i] || null;
        case 'distinct':
          return this.distinct[i]!.size || null;
      }
    });
  }
}

/** Code for fact rows with no related row: they count in totals but belong to no group. */
const UNMATCHED = -2;

/** Date-valued aggregations only survive as a whole measure (date arithmetic has calendar semantics). */
function datesOnlyAtTop(t: Tree, aggs: Agg[]): boolean {
  const walk = (x: Tree): boolean => (x.t === 'agg' ? !aggs[x.i].isDate : x.t === 'num' ? true : x.t === 'bin' ? walk(x.l) && walk(x.r) : walk(x.a) && walk(x.b) && (!x.alt || walk(x.alt)));
  return t.t === 'agg' || walk(t);
}

/**
 * Group code for every row of `fact` (many → one hops). Each hop maps the foreign key's dictionary codes through the
 * key index once, so the per-row cost is two typed-array reads instead of a hash lookup.
 */
function groupCodes(model: DataModel, fact: string, col: ColumnRef): Int32Array | null {
  const target = model.table(col.table).codes(col.column).codes;
  if (col.table === fact) return target;
  const path = model.pathTo(fact, col.table);
  if (!path) return null;
  let rowCode = target; // codes per row of the current "one" side, walking back towards the fact
  for (let h = path.length - 1; h >= 0; h--) {
    const rel = path[h];
    const pk = model.table(rel.toTable).index(rel.toColumn);
    const { codes: fk, dict } = model.table(rel.fromTable).codes(rel.fromColumn);
    // slot 0 is the blank key; slot k + 1 is dictionary entry k
    const map = new Int32Array(dict.length + 1);
    const lookup = (v: CellValue) => {
      const row = pk.get(valueKey(v))?.[0];
      return row === undefined ? UNMATCHED : rowCode[row];
    };
    map[0] = lookup(null);
    for (let k = 0; k < dict.length; k++) map[k + 1] = lookup(dict[k]);
    const out = new Int32Array(fk.length);
    for (let r = 0; r < fk.length; r++) out[r] = map[fk[r] + 1];
    rowCode = out;
  }
  return rowCode;
}

export interface FastResult {
  rows: QueryRow[];
  totals: CellValue[];
}

/**
 * Single-pass grouped evaluation for simple measures (SUM/AVERAGE/MIN/MAX/COUNT/DISTINCTCOUNT/COUNTROWS
 * combined with + - * / and DIVIDE). Returns null when the full engine is needed. Results are identical to the
 * general path: groups come from visible fact rows (auto-exist) and all-blank groups are dropped.
 */
export function fastGroupQuery(model: DataModel, groupCols: ColumnRef[], values: Expr[], base: Filter[], highlight: Filter[] | undefined): FastResult | null {
  if (!groupCols.length || !values.length) return null;
  if (base.some((f) => f.kind === 'rel') || highlight?.some((f) => f.kind === 'rel')) return null;
  // calculation groups can rewrite measures: only safe when none of their tables is involved
  const cgTables = new Set(model.calculationGroups().map((g) => g.table));
  const touchesCg = (fs: Filter[] | undefined) => (fs ?? []).some((f) => (f.kind === 'rows' ? cgTables.has(f.table) : f.kind === 'columns' && f.columns.some((c) => cgTables.has(c.table))));
  if (cgTables.size && (groupCols.some((c) => cgTables.has(c.table)) || touchesCg(base) || touchesCg(highlight))) return null;

  const plan: Plan = { table: null, aggs: [], keys: new Map() };
  const trees: Tree[] = [];
  for (const v of values) {
    const t = compile(model, v, plan, new Set());
    if (!t || !blankPreserving(t) || !datesOnlyAtTop(t, plan.aggs)) return null;
    trees.push(t);
  }
  const fact = plan.table;
  if (!fact) return null;
  const keyCodes = groupCols.map((c) => groupCodes(model, fact, c));
  if (keyCodes.some((k) => !k)) return null;
  const kc = keyCodes as Int32Array[];
  const dicts = groupCols.map((c) => model.table(c.table).codes(c.column).dict);
  const ft = model.table(fact);
  const cols = plan.aggs.map((a) => (a.column ? (a.kind === 'count' ? ft.column(a.column).values : null) : null));
  const nums = plan.aggs.map((a) => (a.column && a.kind !== 'count' && a.kind !== 'distinct' ? ft.numeric(a.column) : null));
  const codes = plan.aggs.map((a) => (a.column && a.kind === 'distinct' ? ft.codes(a.column).codes : null));
  const rowFns: (RowFn | null)[] = plan.aggs.map((a) => (a.row ? a.row.bind() : null));

  const feed = (acc: Acc, r: number) => {
    acc.rows++;
    for (let i = 0; i < plan.aggs.length; i++) {
      const a = plan.aggs[i];
      if (a.kind === 'rows') continue;
      if (a.kind === 'count') {
        const v = cols[i]![r];
        if (v !== null && v !== '') acc.cnt[i]++;
      } else if (a.kind === 'distinct') acc.distinct[i]!.add(codes[i]![r]);
      else if (a.kind === 'sumx' || a.kind === 'avgx') {
        // unlike stored columns, NaN here is a computed value (0/0), not BLANK
        const v = rowFns[i]!(r);
        if (v === null) continue;
        acc.cnt[i]++;
        acc.sum[i] += v;
      } else {
        const v = nums[i]![r];
        if (v !== v) continue;
        acc.cnt[i]++;
        acc.sum[i] += v;
        if (v < acc.min[i]) acc.min[i] = v;
        if (v > acc.max[i]) acc.max[i] = v;
      }
    }
  };

  const single = kc.length === 1;
  const groupOf = new Map<number | string, number>();
  const groupKeys: number[][] = [];
  const accs: Acc[] = [];
  const total = new Acc(plan.aggs);
  const keyOf = (r: number): number | string => {
    if (single) return kc[0][r];
    let k = '';
    for (let j = 0; j < kc.length; j++) {
      const c = kc[j][r];
      if (c === UNMATCHED) return UNMATCHED;
      k += (j ? '|' : '') + c;
    }
    return k;
  };
  for (const r of model.rowsOf(fact, base)) {
    feed(total, r);
    const k = keyOf(r);
    if (k === UNMATCHED) continue;
    let gi = groupOf.get(k);
    if (gi === undefined) {
      gi = accs.length;
      groupOf.set(k, gi);
      groupKeys.push(single ? [k as number] : (k as string).split('|').map(Number));
      accs.push(new Acc(plan.aggs));
    }
    feed(accs[gi], r);
  }
  let hl: (Acc | undefined)[] | undefined;
  if (highlight) {
    hl = accs.map(() => undefined);
    for (const r of model.rowsOf(fact, [...base, ...highlight])) {
      const gi = groupOf.get(keyOf(r));
      if (gi === undefined) continue;
      feed((hl[gi] ??= new Acc(plan.aggs)), r);
    }
  }
  const empty = new Acc(plan.aggs).result(plan.aggs);
  const rows: QueryRow[] = [];
  accs.forEach((acc, gi) => {
    const aggVals = acc.result(plan.aggs);
    const vals = trees.map((t) => evalTree(t, aggVals));
    if (vals.every((v) => v === null)) return;
    const keys = groupKeys[gi].map((code, j) => (code < 0 ? null : dicts[j][code]));
    const row: QueryRow = { keys, values: vals };
    if (hl) {
      const h = hl[gi]?.result(plan.aggs) ?? empty;
      row.highlights = trees.map((t) => evalTree(t, h));
    }
    rows.push(row);
  });
  return { rows, totals: trees.map((t) => evalTree(t, total.result(plan.aggs))) };
}

export type FastQueryMode = 'auto' | 'always' | 'off';

let mode: FastQueryMode = 'auto';

/** Below this many groups a single indexed column is answered faster by per-group evaluation. */
const AUTO_MIN_GROUPS = 1000;

/**
 * Choose when the single-pass grouped path runs. `'auto'` (default) uses it for multi-column or high-cardinality
 * groupings; `'always'` / `'off'` force it (results are identical – useful for benchmarks and tests).
 */
export function setFastQuery(m: FastQueryMode | boolean): void {
  mode = m === true ? 'always' : m === false ? 'off' : m;
}

/** False only in `'off'` mode: also gates the evaluator's per-dimension partial aggregates. */
export function fastPathsEnabled(): boolean {
  return mode !== 'off';
}

/** Should `runQuery` try the single-pass path for these group columns? */
export function useFastQuery(model: DataModel, groupCols: ColumnRef[]): boolean {
  if (mode !== 'auto') return mode === 'always';
  if (groupCols.length !== 1) return groupCols.length > 1;
  return model.table(groupCols[0].table).distinct(groupCols[0].column).length > AUTO_MIN_GROUPS;
}
