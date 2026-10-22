import type { Expr } from '../dax/ast';
import type { CellValue, ColumnRef } from './types';
import { valueKey } from './types';
import type { Filter } from './filters';
import type { DataModel } from './model';
import type { QueryRow } from './query';
import { compileRowExpr, type RowFn, type RowPlan } from '../dax/rowCompile';
import { parallelPeriod, periodStart, shiftDates } from '../dax/timeIntel';

/** A CALCULATE column filter: the column's values that pass (by dictionary code; slot 0 is BLANK). */
interface Pred {
  table: string;
  column: string;
  allowed: Uint8Array;
  /** Identity for de-duplicating aggregations. */
  key: string;
}

/** A leaf aggregation computed in one pass over the fact table. */
interface Agg {
  kind: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'distinct' | 'rows' | 'sumx' | 'avgx';
  column?: string;
  isDate?: boolean;
  /** SUMX / AVERAGEX row expression. */
  row?: RowPlan;
  /** CALCULATE filters every counted row must pass. */
  preds?: Pred[];
}

/** Columns the query itself groups or filters by: a CALCULATE filter on them replaces the query's, so no single pass. */
interface CompileEnv {
  touched: Set<string>;
  touchedTables: Set<string>;
}

type Tree =
  | { t: 'agg'; i: number }
  | { t: 'ti'; i: number }
  | { t: 'num'; v: number }
  | { t: 'bin'; op: '+' | '-' | '*' | '/'; l: Tree; r: Tree }
  | { t: 'div'; a: Tree; b: Tree; alt?: Tree };

const AGG_FN: Record<string, Agg['kind']> = { SUM: 'sum', AVERAGE: 'avg', MIN: 'min', MAX: 'max', COUNT: 'count', COUNTA: 'count', DISTINCTCOUNT: 'distinct' };

interface Plan {
  table: string | null;
  aggs: Agg[];
  keys: Map<string, number>;
  env?: CompileEnv;
  /** Time-intelligence sub-measures (top-level plan only). */
  ti?: TiNode[];
}

/**
 * A measure evaluated over a shifted or period-to-date set of dates: `CALCULATE(x, SAMEPERIODLASTYEAR(D[c]))`,
 * `DATEADD`, `DATES*TD`, `PARALLELPERIOD`, `PREVIOUS*`, or `TOTAL*TD(x, D[c])`. The date set replaces every
 * filter on the date table (as in CALCULATE), so its aggregations are summed from per-date partials.
 */
interface TiNode {
  /** Which dates replace the group's: period to date, shifted, or a whole parallel period (rules in dax/timeIntel). */
  rule: { fn: 'td'; period: 'year' | 'quarter' | 'month'; yearEnd?: string } | { fn: 'shift' | 'parallel'; n: number; unit: string };
  date: ColumnRef;
  sub: Plan;
  tree: Tree;
}

const TI_TABLES = new Set(['SAMEPERIODLASTYEAR', 'DATEADD', 'DATESYTD', 'DATESQTD', 'DATESMTD', 'PARALLELPERIOD', 'PREVIOUSMONTH', 'PREVIOUSQUARTER', 'PREVIOUSYEAR']);
const TI_TOTALS: Record<string, string> = { TOTALYTD: 'DATESYTD', TOTALQTD: 'DATESQTD', TOTALMTD: 'DATESMTD' };
const isTiTable = (x: Expr): boolean => x.type === 'call' && TI_TABLES.has(x.name.toUpperCase()) && x.args[0]?.type === 'column';

/** Does a value expression (following measures) use time intelligence? */
export function usesTimeIntelligence(model: DataModel, e: Expr, seen = new Set<string>()): boolean {
  switch (e.type) {
    case 'bracket':
      if (!model.hasMeasure(e.name) || seen.has(e.name)) return false;
      seen.add(e.name);
      return usesTimeIntelligence(model, model.measure(e.name).ast, seen);
    case 'call':
      return isTiTable(e) || e.name.toUpperCase() in TI_TOTALS || e.args.some((a) => usesTimeIntelligence(model, a, seen));
    case 'binary':
      return usesTimeIntelligence(model, e.left, seen) || usesTimeIntelligence(model, e.right, seen);
    case 'unary':
      return usesTimeIntelligence(model, e.operand, seen);
    default:
      return false;
  }
}

const refKey = (table: string, column: string) => `${table}[${column}]`;

/** The single column a CALCULATE boolean filter reads, or null. */
function onlyColumn(e: Expr, out = new Set<string>(), refs: { table: string; column: string }[] = []): { table: string; column: string } | null {
  const walk = (x: Expr): boolean => {
    switch (x.type) {
      case 'column':
        if (!out.has(refKey(x.table, x.column))) (out.add(refKey(x.table, x.column)), refs.push({ table: x.table, column: x.column }));
        return true;
      case 'number':
      case 'string':
      case 'boolean':
        return true;
      case 'unary':
        return walk(x.operand);
      case 'binary':
        return walk(x.left) && walk(x.right);
      case 'list':
        return x.items.every(walk);
      case 'call':
        // only deterministic scalar functions; aggregates or measures would need the full engine
        return ['BLANK', 'TRUE', 'FALSE', 'DATE', 'NOT', 'AND', 'OR', 'ISBLANK', 'LEFT', 'RIGHT', 'UPPER', 'LOWER', 'YEAR', 'MONTH', 'CONTAINSSTRING', 'SEARCH', 'LEN'].includes(x.name.toUpperCase()) && x.args.every(walk);
      default:
        return false;
    }
  };
  return walk(e) && refs.length === 1 ? refs[0] : null;
}

/**
 * The values of one column that pass a CALCULATE filter, computed once with the general engine as
 * `FILTER(ALL(col), filter)` (exact DAX semantics), as a lookup over the column's dictionary codes.
 */
function predFor(model: DataModel, ref: { table: string; column: string }, filter: Expr): Pred | null {
  const t = model.table(ref.table);
  if (t.column(ref.column).expression) return null;
  let rows: CellValue[][];
  try {
    rows = model.evaluator.evalTableToRows({ type: 'call', name: 'FILTER', args: [{ type: 'call', name: 'ALL', args: [{ type: 'column', table: ref.table, column: ref.column }] }, filter] }, { filters: [] }).rows;
  } catch {
    return null;
  }
  const pass = new Set(rows.map((r) => valueKey(r[0])));
  const { dict } = t.codes(ref.column);
  const allowed = new Uint8Array(dict.length + 1);
  allowed[0] = pass.has(valueKey(null)) ? 1 : 0;
  for (let k = 0; k < dict.length; k++) allowed[k + 1] = pass.has(valueKey(dict[k])) ? 1 : 0;
  return { table: ref.table, column: ref.column, allowed, key: `${refKey(ref.table, ref.column)}=${[...pass].sort().join('\u0001')}` };
}

/** Compile a value expression into a tree of single-pass aggregations, or null when it needs the full engine. */
function compile(model: DataModel, e: Expr, plan: Plan, seen: Set<string>, preds: Pred[] = []): Tree | null {
  const leaf = (table: string, agg: Agg): Tree | null => {
    if (plan.table === null) plan.table = table;
    if (plan.table !== table) return null; // one fact table per plan
    if (preds.length) agg.preds = preds;
    const k = `${agg.kind}|${agg.column ?? ''}|${preds.map((p) => p.key).join('&')}`;
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
      const r = compile(model, model.measure(e.name).ast, plan, seen, preds);
      seen.delete(e.name);
      return r;
    }
    case 'unary':
      if (e.op !== '-') return null;
      return ((x) => (x ? { t: 'bin', op: '*', l: { t: 'num', v: -1 }, r: x } : null))(compile(model, e.operand, plan, seen, preds));
    case 'binary': {
      if (!['+', '-', '*', '/'].includes(e.op)) return null;
      const l = compile(model, e.left, plan, seen, preds);
      const r = l && compile(model, e.right, plan, seen, preds);
      return l && r ? { t: 'bin', op: e.op as '+', l, r } : null;
    }
    case 'call': {
      if (e.name === 'DIVIDE' && (e.args.length === 2 || e.args.length === 3)) {
        const a = compile(model, e.args[0], plan, seen, preds);
        const b = a && compile(model, e.args[1], plan, seen, preds);
        const alt = e.args[2] ? compile(model, e.args[2], plan, seen, preds) : undefined;
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
        plan.aggs.push({ kind: e.name === 'SUMX' ? 'sumx' : 'avgx', row, ...(preds.length ? { preds } : {}) });
        return { t: 'agg', i: plan.aggs.length - 1 };
      }
      const total = TI_TOTALS[e.name.toUpperCase()];
      if (total && e.args.length === 2 && e.args[1].type === 'column') return tiNode(model, e.args[0], { type: 'call', name: total, args: [e.args[1]] }, plan, seen, preds);
      if (e.name === 'CALCULATE' && e.args.length >= 2 && e.args.slice(1).some(isTiTable)) {
        // one time-intelligence filter; the others must be column filters, which apply inside it
        const tis = e.args.slice(1).filter(isTiTable);
        if (tis.length !== 1) return null;
        const rest = e.args.slice(1).filter((a) => !isTiTable(a));
        return tiNode(model, rest.length ? { type: 'call', name: 'CALCULATE', args: [e.args[0], ...rest] } : e.args[0], tis[0] as Expr & { type: 'call'; args: Expr[] }, plan, seen, preds);
      }
      if (e.name === 'CALCULATE' && e.args.length >= 1) {
        // column filters become row predicates; one on a column the query groups or filters by would replace the
        // query's filter, which a single pass over the query's rows can't do
        let next = preds;
        for (const f of e.args.slice(1)) {
          const keep = f.type === 'call' && f.name.toUpperCase() === 'KEEPFILTERS';
          const cond = keep ? (f as { args: Expr[] }).args[0] : f;
          const ref = cond && onlyColumn(cond);
          if (!ref || !model.hasTable(ref.table) || !model.table(ref.table).hasColumn(ref.column)) return null;
          const env = plan.env;
          if (!keep && env && (env.touched.has(refKey(ref.table, ref.column)) || env.touchedTables.has(ref.table))) return null;
          const p = predFor(model, ref, cond);
          if (!p) return null;
          // a nested filter on the same column replaces the outer one (KEEPFILTERS intersects)
          next = keep ? [...next, p] : [...next.filter((q) => q.table !== p.table || q.column !== p.column), p];
        }
        return compile(model, e.args[0], plan, seen, next);
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

/** Compile the measure under a time-intelligence filter into its own plan of mergeable aggregations. */
/** The date rule of a time-intelligence table function with literal arguments, or null. */
function tiRule(call: Expr & { type: 'call'; args: Expr[] }): TiNode['rule'] | null {
  const name = call.name.toUpperCase();
  const a = call.args;
  const lit = (e: Expr | undefined): number | null => (e?.type === 'number' ? e.value : e?.type === 'unary' && e.op === '-' && e.operand.type === 'number' ? -e.operand.value : null);
  const unit = (e: Expr | undefined): string | null => (e?.type === 'table' || e?.type === 'varRef' ? e.name.toUpperCase() : e?.type === 'string' ? e.value.toUpperCase() : null);
  if (name === 'DATESYTD' && a.length <= 2) return a[1] === undefined ? { fn: 'td', period: 'year' } : a[1].type === 'string' ? { fn: 'td', period: 'year', yearEnd: a[1].value } : null;
  if ((name === 'DATESQTD' || name === 'DATESMTD') && a.length === 1) return { fn: 'td', period: name === 'DATESQTD' ? 'quarter' : 'month' };
  if (name === 'SAMEPERIODLASTYEAR' && a.length === 1) return { fn: 'shift', n: -1, unit: 'YEAR' };
  if (name.startsWith('PREVIOUS') && a.length === 1) return { fn: 'parallel', n: -1, unit: name.slice(8) };
  const n = lit(a[1]);
  const u = unit(a[2]);
  if (n === null || u === null || a.length !== 3) return null;
  if (name === 'DATEADD') return ['DAY', 'MONTH', 'QUARTER', 'YEAR'].includes(u) ? { fn: 'shift', n, unit: u } : null;
  if (name === 'PARALLELPERIOD') return { fn: 'parallel', n, unit: u };
  return null;
}

function tiNode(model: DataModel, inner: Expr, call: Expr & { type: 'call'; args: Expr[] }, plan: Plan, seen: Set<string>, preds: Pred[]): Tree | null {
  if (!plan.ti) return null; // no nesting
  const rule = tiRule(call);
  if (!rule) return null;
  const d = call.args[0] as Expr & { type: 'column' };
  if (!model.hasTable(d.table) || !model.table(d.table).hasColumn(d.column) || model.table(d.table).column(d.column).type !== 'date') return null;
  const date = model.resolveColumn({ table: d.table, column: d.column });
  // filters on the date table are replaced by the date set, so CALCULATE filters there can't be row predicates
  const exp = model.expanded(date.table);
  const sub: Plan = { table: plan.table, aggs: [], keys: new Map(), env: plan.env };
  const tree = compile(model, inner, sub, seen, preds);
  if (!tree || !blankPreserving(tree)) return null;
  if (sub.aggs.some((a) => a.kind === 'distinct' || a.isDate || a.preds?.some((p) => exp.has(p.table)))) return null;
  if (plan.table === null) plan.table = sub.table;
  if (sub.table === null || plan.table !== sub.table) return null;
  plan.ti.push({ rule, date, sub, tree });
  return { t: 'ti', i: plan.ti.length - 1 };
}

/** True when the expression is BLANK whenever all its aggregations are BLANK (so empty groups drop out). */
function blankPreserving(t: Tree): boolean {
  switch (t.t) {
    case 'agg':
    case 'ti':
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
function evalTree(t: Tree, vals: CellValue[], ti: CellValue[] = []): CellValue {
  switch (t.t) {
    case 'agg':
      return vals[t.i];
    case 'ti':
      return ti[t.i];
    case 'num':
      return t.v;
    case 'bin': {
      const a = evalTree(t.l, vals, ti);
      const b = evalTree(t.r, vals, ti);
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
      const a = evalTree(t.a, vals, ti);
      const b = evalTree(t.b, vals, ti);
      if (b === null || num(b) === 0) return t.alt ? evalTree(t.alt, vals, ti) : null;
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
          return this.cnt[i] || null;
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

/** Group key spaces up to this size use a dense lookup table instead of a hash map. */
const DENSE_GROUPS = 1 << 22;

/** Code for fact rows with no related row: they count in totals but belong to no group. */
const UNMATCHED = -2;

/** Date-valued aggregations only survive as a whole measure (date arithmetic has calendar semantics). */
function datesOnlyAtTop(t: Tree, aggs: Agg[]): boolean {
  const walk = (x: Tree): boolean => (x.t === 'agg' ? !aggs[x.i].isDate : x.t === 'num' || x.t === 'ti' ? true : x.t === 'bin' ? walk(x.l) && walk(x.r) : walk(x.a) && walk(x.b) && (!x.alt || walk(x.alt)));
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

/** What feeding an aggregation list reads: column views, row functions and CALCULATE predicate tests per aggregation. */
interface Prepared {
  aggs: Agg[];
  cols: (CellValue[] | null)[];
  nums: (Float64Array | null)[];
  codes: (Int32Array | null)[];
  rowFns: (RowFn | null)[];
  predTests: (((r: number) => boolean) | null)[];
}

/**
 * Per-date partial aggregates for the time-intelligence nodes, in one pass over the fact rows the date filters don't
 * restrict. Each group's date set comes from its visible dates by the same rules as the evaluator (dax/timeIntel) and
 * combines the partials of those dates: period-to-date and parallel periods are ranges of the sorted dates. Null
 * when the query doesn't fit.
 */
function timeIntelligence(model: DataModel, fact: string, nodes: TiNode[], mainAggs: Agg[], groupCols: ColumnRef[], base: Filter[], highlight: Filter[] | undefined, prepare: (aggs: Agg[]) => Prepared | null) {
  const dt = nodes[0].date.table;
  const dc = nodes[0].date.column;
  if (highlight || nodes.some((n) => n.date.table !== dt || n.date.column !== dc) || groupCols.some((c) => c.table !== dt) || fact === dt) return null;
  // filters flowing back to the date table would change which dates are visible
  if (model.relationships().some((r) => r.active && r.crossFilter === 'both')) return null;
  const map = model.relatedRows(fact, dt);
  if (!map) return null;
  // the query's other aggregations come from the same partials, summed over each group's own dates, when they
  // merge (not distinct counts) and the date table's filters are only its own
  const exp = model.expanded(dt);
  const withMain = mainAggs.length > 0 && exp.size === 1 && !mainAggs.some((a) => a.kind === 'distinct');
  const sets: { aggs: Agg[]; rule: TiNode['rule'] | { fn: 'same' } }[] = nodes.map((n) => ({ aggs: n.sub.aggs, rule: n.rule }));
  if (withMain) sets.push({ aggs: mainAggs, rule: { fn: 'same' } });
  const preps = sets.map((x) => prepare(x.aggs));
  if (preps.some((p) => !p)) return null;

  // the date column's distinct dates in order; every date-table row maps to its position
  const dtab = model.table(dt);
  const dateVals = dtab.column(dc).values;
  const sorted = [...new Set(dateVals.filter((v): v is Date => v instanceof Date).map((v) => v.getTime()))].sort((x, y) => x - y);
  const posOf = new Map(sorted.map((t, p) => [t, p]));
  const rowPos = Int32Array.from(dateVals, (v) => (v instanceof Date ? posOf.get(v.getTime())! : -1));
  const existing = new Set(sorted);
  const lowerBound = (t: number) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  // the date set replaces every filter within the date table's expanded table (CALCULATE's clearTable)
  const kept = base.filter((f) => f.kind === 'rel' || !(f.kind === 'rows' ? exp.has(f.table) : f.columns.every((c) => exp.has(c.table))));
  // with nothing left to filter (and no security roles) every fact row counts: no row list needed
  const list = kept.length || model.activeRoleNames.length ? model.rowsOf(fact, kept) : null;
  const count = list ? list.length : map.length;
  const at = new Int32Array(count); // date position of each counted row
  for (let j = 0; j < count; j++) {
    const d = map[list ? list[j] : j];
    at[j] = d < 0 ? -1 : rowPos[d];
  }
  // partials per node: aggregation i of date position p lives at i * P + p
  const P = sorted.length;
  const parts = preps.map((prep) => {
    const { aggs, cols, nums, rowFns, predTests } = prep!;
    const n = aggs.length * P;
    const sum = new Float64Array(n);
    const cnt = new Float64Array(n);
    const mn = new Float64Array(n).fill(Infinity);
    const mx = new Float64Array(n).fill(-Infinity);
    aggs.forEach((a, i) => {
      const o = i * P;
      const pt = predTests[i];
      const v = nums[i];
      if (v && !pt) {
        // the common case, a plain column aggregation: one tight loop
        for (let j = 0; j < count; j++) {
          const p = at[j];
          if (p < 0) continue;
          const x = v[list ? list[j] : j];
          if (x !== x) continue;
          const q = o + p;
          sum[q] += x;
          cnt[q]++;
          if (x < mn[q]) mn[q] = x;
          if (x > mx[q]) mx[q] = x;
        }
        return;
      }
      const col = cols[i];
      const fn = rowFns[i];
      for (let j = 0; j < count; j++) {
        const p = at[j];
        if (p < 0) continue;
        const r = list ? list[j] : j;
        if (pt && !pt(r)) continue;
        const q = o + p;
        if (a.kind === 'rows') cnt[q]++;
        else if (a.kind === 'count') {
          const x = col![r];
          if (x !== null && x !== '') cnt[q]++;
        } else {
          // unlike stored columns, NaN from a row expression is a computed value (0/0), not BLANK
          const x = fn ? fn(r) : v![r];
          if (x === null || (!fn && x !== x)) continue;
          sum[q] += x;
          cnt[q]++;
          if (x < mn[q]) mn[q] = x;
          if (x > mx[q]) mx[q] = x;
        }
      }
    });
    return { sum, cnt, mn, mx };
  });

  // visible dates per group (and for the totals): the date-table rows under the query's filters
  const keyOf = (keys: CellValue[]) => keys.map((v) => String(valueKey(v))).join('');
  const groupVals = groupCols.map((c) => dtab.column(c.column).values);
  const visible = new Map<string, number[]>();
  const all: number[] = [];
  for (const r of model.rowsOf(dt, base)) {
    const p = rowPos[r];
    if (p < 0) continue;
    all.push(p);
    const k = keyOf(groupVals.map((v) => v[r]));
    const list = visible.get(k);
    if (list) list.push(p);
    else visible.set(k, [p]);
  }
  const values = (ps: number[] | undefined): { ti: CellValue[]; main?: CellValue[] } => {
    const out = sets.map((n, k) => {
      const acc = new Acc(n.aggs);
      const { sum, cnt, mn, mx } = parts[k];
      const A = n.aggs.length;
      const add = (p: number) => {
        for (let i = 0, q = p; i < A; i++, q += P) {
          if (!cnt[q]) continue;
          acc.sum[i] += sum[q];
          acc.cnt[i] += cnt[q];
          if (mn[q] < acc.min[i]) acc.min[i] = mn[q];
          if (mx[q] > acc.max[i]) acc.max[i] = mx[q];
        }
      };
      if (ps?.length) {
        let first = Infinity;
        let last = -Infinity;
        for (const p of ps) (first = Math.min(first, p)), (last = Math.max(last, p));
        const rule = n.rule;
        if (rule.fn === 'same') for (const p of new Set(ps)) add(p);
        else if (rule.fn === 'td') for (let p = lowerBound(periodStart(new Date(sorted[last]), rule.period, rule.yearEnd).getTime()); p <= last; p++) add(p);
        else if (rule.fn === 'parallel') {
          const [start, end] = parallelPeriod(new Date(sorted[first]), rule.unit, rule.n);
          for (let p = lowerBound(start.getTime()); p < sorted.length && sorted[p] <= end.getTime(); p++) add(p);
        } else
          for (const d of shiftDates(
            ps.map((p) => new Date(sorted[p])),
            existing,
            rule.n,
            rule.unit,
          ))
            add(posOf.get(d.getTime())!);
      }
      return acc.result(n.aggs);
    });
    return { ti: nodes.map((n, k) => evalTree(n.tree, out[k])), main: withMain ? out[nodes.length] : undefined };
  };
  return {
    /** The query's own aggregations come with the groups' values (no separate pass needed). */
    merged: withMain,
    group: (keys: CellValue[]) => values(visible.get(keyOf(keys))),
    total: () => values(all),
  };
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
export function fastGroupQuery(model: DataModel, groupCols: ColumnRef[], values: Expr[], base: Filter[], highlight: Filter[] | undefined, combos?: () => CellValue[][]): FastResult | null {
  if (!groupCols.length || !values.length) return null;
  if (base.some((f) => f.kind === 'rel') || highlight?.some((f) => f.kind === 'rel')) return null;
  // calculation groups can rewrite measures: only safe when none of their tables is involved
  const cgTables = new Set(model.calculationGroups().map((g) => g.table));
  const touchesCg = (fs: Filter[] | undefined) => (fs ?? []).some((f) => (f.kind === 'rows' ? cgTables.has(f.table) : f.kind === 'columns' && f.columns.some((c) => cgTables.has(c.table))));
  if (cgTables.size && (groupCols.some((c) => cgTables.has(c.table)) || touchesCg(base) || touchesCg(highlight))) return null;

  // columns the query groups or filters by (CALCULATE filters on them need the full engine)
  const touched = new Set<string>(groupCols.map((c) => refKey(c.table, c.column)));
  const touchedTables = new Set<string>();
  for (const f of [...base, ...(highlight ?? [])]) {
    if (f.kind === 'columns') for (const c of f.columns) touched.add(refKey(c.table, c.column));
    else if (f.kind === 'rows') touchedTables.add(f.table);
  }
  const plan: Plan = { table: null, aggs: [], keys: new Map(), env: { touched, touchedTables }, ti: [] };
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
  const prepare = (aggs: Agg[]): Prepared | null => {
    const cols = aggs.map((a) => (a.column ? (a.kind === 'count' ? ft.column(a.column).values : null) : null));
    const nums = aggs.map((a) => (a.column && a.kind !== 'count' && a.kind !== 'distinct' ? ft.numeric(a.column) : null));
    const codes = aggs.map((a) => (a.column && a.kind === 'distinct' ? ft.codes(a.column).codes : null));
    const rowFns: (RowFn | null)[] = aggs.map((a) => (a.row ? a.row.bind() : null));
    // CALCULATE predicates: the filtered column's code for each fact row (through the relationship for dimensions)
    const predTests = aggs.map((a) => {
      if (!a.preds?.length) return null;
      const tests = a.preds.map((p) => {
        const codes = model.table(p.table).codes(p.column).codes;
        if (p.table === fact) return (r: number) => p.allowed[codes[r] + 1] === 1;
        const map = model.relatedRows(fact, p.table);
        if (!map) return null;
        // a fact row without a related row sees the dimension's BLANK row
        return (r: number) => {
          const t = map[r];
          return p.allowed[t < 0 ? 0 : codes[t] + 1] === 1;
        };
      });
      if (tests.some((t) => !t)) return undefined;
      const ts = tests as ((r: number) => boolean)[];
      return ts.length === 1 ? ts[0] : (r: number) => ts.every((t) => t(r));
    });
    if (predTests.some((t) => t === undefined)) return null;
    return { aggs, cols, nums, codes, rowFns, predTests: predTests as (((r: number) => boolean) | null)[] };
  };
  const feeder = (prep: Prepared) => {
    const { aggs, cols, nums, codes, rowFns, predTests } = prep;
    return (acc: Acc, r: number) => {
      acc.rows++;
      for (let i = 0; i < aggs.length; i++) {
        const a = aggs[i];
        const pt = predTests[i];
        if (pt && !pt(r)) continue;
        if (a.kind === 'rows') {
          acc.cnt[i]++;
          continue;
        }
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
  };
  const prep = prepare(plan.aggs);
  if (!prep) return null;
  const feed = feeder(prep);
  const ti = plan.ti!.length ? timeIntelligence(model, fact, plan.ti!, plan.aggs, groupCols, base, highlight, prepare) : undefined;
  if (ti === null) return null;

  // Group keys are mixed-radix numbers over the codes (BLANK = digit 0), so no strings are built per row. Small key
  // spaces index a dense table directly; keys beyond 2^53 fall back to strings.
  const radix = dicts.map((d) => d.length + 1);
  const space = radix.reduce((a, b) => a * b, 1);
  const numeric = space <= Number.MAX_SAFE_INTEGER;
  const dense = space <= DENSE_GROUPS ? new Int32Array(space).fill(-1) : null;
  const groupOf = new Map<number | string, number>();
  const groupKeys: number[][] = [];
  const accs: Acc[] = [];
  const total = new Acc(plan.aggs);
  const keyOf = (r: number): number | string => {
    if (numeric) {
      let k = 0;
      for (let j = 0; j < kc.length; j++) {
        const c = kc[j][r];
        if (c === UNMATCHED) return UNMATCHED;
        k = k * radix[j] + c + 1;
      }
      return k;
    }
    let k = '';
    for (let j = 0; j < kc.length; j++) {
      const c = kc[j][r];
      if (c === UNMATCHED) return UNMATCHED;
      k += (j ? '|' : '') + c;
    }
    return k;
  };
  const lookup = (k: number | string): number | undefined => {
    if (dense) {
      const gi = dense[k as number];
      return gi < 0 ? undefined : gi;
    }
    return groupOf.get(k);
  };
  // with only time-intelligence values there is nothing to aggregate per group here
  const mainRows = ti && (!plan.aggs.length || ti.merged) ? [] : model.rowsOf(fact, base);
  for (const r of mainRows) {
    feed(total, r);
    const k = keyOf(r);
    if (k === UNMATCHED) continue;
    let gi = lookup(k);
    if (gi === undefined) {
      gi = accs.length;
      if (dense) dense[k as number] = gi;
      else groupOf.set(k, gi);
      groupKeys.push(kc.map((codes) => codes[r]));
      accs.push(new Acc(plan.aggs));
    }
    feed(accs[gi], r);
  }
  let hl: (Acc | undefined)[] | undefined;
  if (highlight) {
    hl = accs.map(() => undefined);
    for (const r of model.rowsOf(fact, [...base, ...highlight])) {
      const k = keyOf(r);
      const gi = k === UNMATCHED ? undefined : lookup(k);
      if (gi === undefined) continue;
      feed((hl[gi] ??= new Acc(plan.aggs)), r);
    }
  }
  const empty = new Acc(plan.aggs).result(plan.aggs);
  const rows: QueryRow[] = [];
  if (ti) {
    // groups come from the date table, as in the general path: a month without sales still has last year's
    const codeOf = dicts.map((d) => new Map(d.map((v, k) => [valueKey(v), k])));
    for (const keys of combos?.() ?? []) {
      let k: number | string = numeric ? 0 : '';
      keys.forEach((v, j) => {
        const c = v === null ? -1 : (codeOf[j].get(valueKey(v)) ?? -1);
        k = numeric ? (k as number) * radix[j] + c + 1 : `${k}${j ? '|' : ''}${c}`;
      });
      const gi = lookup(k);
      const tv = ti.group(keys);
      const aggVals = tv.main ?? (gi === undefined ? empty : accs[gi].result(plan.aggs));
      const vals = trees.map((t) => evalTree(t, aggVals, tv.ti));
      if (vals.every((v) => v === null)) continue;
      rows.push({ keys, values: vals });
    }
    const tt = ti.total();
    return { rows, totals: trees.map((t) => evalTree(t, tt.main ?? total.result(plan.aggs), tt.ti)) };
  }
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
export function useFastQuery(model: DataModel, groupCols: ColumnRef[], values: Expr[] = []): boolean {
  if (mode !== 'auto') return mode === 'always';
  // per-group time intelligence re-scans the facts per group; the single pass sums per-date partials instead
  if (values.some((v) => usesTimeIntelligence(model, v))) return true;
  if (groupCols.length !== 1) return groupCols.length > 1;
  return model.table(groupCols[0].table).distinct(groupCols[0].column).length > AUTO_MIN_GROUPS;
}
