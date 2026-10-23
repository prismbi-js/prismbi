import type { Expr } from '../dax/ast';
import type { CellValue, ColumnRef } from './types';
import { compareValues, valueKey } from './types';
import type { ColumnsFilter, Filter } from './filters';
import { compileFilter } from './filters';
import type { DataModel } from './model';
import type { QueryRow } from './query';
import { compileRowExpr, type RowFn, type RowPlan } from '../dax/rowCompile';
import { isBlankCall } from '../dax/parser';
import { parallelPeriod, periodStart, periodWindow, shiftDates } from '../dax/timeIntel';

/**
 * A CALCULATE filter on fact rows: a column filter (the column's values that pass, by dictionary code; slot 0 is
 * BLANK), or `FILTER(fact, condition)`, whose rows also pass the filters in force where it is written (`within`):
 * CALCULATE evaluates its filter arguments in the outer context.
 */
type Pred = {
  table: string;
  /** Identity for de-duplicating aggregations. */
  key: string;
} & ({ column: string; allowed: Uint8Array; rows?: undefined } | { column?: undefined; rows: Expr; within: Pred[] });

/** Identities of FILTER conditions (by AST node). */
const filterIds = new WeakMap<Expr, number>();
let nextFilterId = 0;

/** Is this pred, or one a FILTER was written under, on one of these tables? */
const predOn = (p: Pred, tables: Set<string>): boolean => tables.has(p.table) || (p.rows !== undefined && p.within.some((q) => predOn(q, tables)));

/** A leaf aggregation computed in one pass over the fact table. */
interface Agg {
  kind: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'distinct' | 'rows' | 'sumx' | 'avgx' | 'minx' | 'maxx' | 'countx';
  column?: string;
  isDate?: boolean;
  /** Iterator (SUMX, AVERAGEX, MINX, MAXX, COUNTX) row expression. */
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
  | { t: 'div'; a: Tree; b: Tree; alt?: Tree }
  | { t: 'sub'; i: number }
  /** RANKX: the value's rank in the group's list (sub-result i) */
  | { t: 'rank'; i: number; v: Tree }
  /** IF(l op r, a, [b]) */
  | { t: 'if'; op: string; l: Tree; r: Tree; a: Tree; b?: Tree }
  | { t: 'lit'; v: CellValue }
  /** A pure scalar function or operator over sub-results, computed by the evaluator on literal arguments (exact semantics). */
  | { t: 'expr'; model: DataModel; make: (args: Expr[]) => Expr; args: Tree[] };

/** Scalar functions that only depend on their arguments: safe to apply to per-group results. */
const SCALAR_FNS = new Set(['ABS', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'INT', 'TRUNC', 'SQRT', 'POWER', 'EXP', 'LN', 'LOG', 'LOG10', 'MOD', 'SIGN', 'CEILING', 'FLOOR', 'COALESCE', 'ISBLANK', 'NOT', 'AND', 'OR', 'IF', 'SWITCH', 'FORMAT', 'CONCATENATE', 'VALUE', 'ISNUMBER', 'ISTEXT', 'LEFT', 'RIGHT', 'UPPER', 'LOWER', 'LEN']);
const ITER_FN: Record<string, Agg['kind']> = { SUMX: 'sumx', AVERAGEX: 'avgx', MINX: 'minx', MAXX: 'maxx', COUNTX: 'countx', COUNTAX: 'countx' };

const AGG_FN: Record<string, Agg['kind']> = { SUM: 'sum', AVERAGE: 'avg', MIN: 'min', MAX: 'max', COUNT: 'count', COUNTA: 'count', DISTINCTCOUNT: 'distinct' };

interface Plan {
  table: string | null;
  aggs: Agg[];
  keys: Map<string, number>;
  env?: CompileEnv;
  /** Time-intelligence sub-measures (top-level plan only). */
  ti?: TiNode[];
  /** Measures under ALL / REMOVEFILTERS / ALLEXCEPT / ALLSELECTED, answered at a coarser grain (top-level plan only). */
  subs?: SubNode[];
}

/**
 * `CALCULATE(expr, ALL(…), …)`: `expr` evaluated with the removals applied to the query's filters and groups;
 * `RANKX(ALL(T[c]), expr)`: `expr` for every value of the column, ranked per group; or `AVERAGEX(VALUES(T[c]), expr)`
 * (any iterator): `expr` per value of the column within each group, folded.
 */
type SubNode =
  | { kind: 'all'; mods: Expr[]; expr: Expr }
  | { kind: 'rank'; col: ColumnRef; expr: Expr; asc: boolean; dense: boolean; selected: boolean; whole?: boolean }
  | { kind: 'iter'; fn: Agg['kind']; col: ColumnRef; expr: Expr };

/** A group's ranking: the rank of a value among the group's list. */
type Ranker = (v: CellValue) => CellValue;

const REMOVALS = new Set(['ALL', 'ALLNOBLANKROW', 'REMOVEFILTERS', 'ALLEXCEPT', 'ALLSELECTED']);
const isRemoval = (x: Expr): boolean => x.type === 'call' && REMOVALS.has(x.name.toUpperCase());

/**
 * A measure evaluated over a shifted or period-to-date set of dates: `CALCULATE(x, SAMEPERIODLASTYEAR(D[c]))`,
 * `DATEADD`, `DATES*TD`, `PARALLELPERIOD`, `PREVIOUS*`, or `TOTAL*TD(x, D[c])`. The date set replaces every
 * filter on the date table (as in CALCULATE), so its aggregations are summed from per-date partials.
 */
interface TiNode {
  /** Which dates replace the group's: period to date, shifted, or a whole parallel period (rules in dax/timeIntel). */
  rule:
    | { fn: 'td'; period: 'year' | 'quarter' | 'month'; yearEnd?: string }
    | { fn: 'shift' | 'parallel'; n: number; unit: string }
    /** DATESINPERIOD from the last (or first) visible date: rolling windows */
    | { fn: 'window'; n: number; unit: string; from: 'last' | 'first' };
  date: ColumnRef;
  sub: Plan;
  tree: Tree;
}

const TI_TABLES = new Set(['DATESINPERIOD', 'SAMEPERIODLASTYEAR', 'DATEADD', 'DATESYTD', 'DATESQTD', 'DATESMTD', 'PARALLELPERIOD', 'PREVIOUSMONTH', 'PREVIOUSQUARTER', 'PREVIOUSYEAR']);
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
function compile(model: DataModel, e: Expr, plan: Plan, seen: Set<string>, preds: Pred[] = [], vars: Map<string, Tree> = new Map()): Tree | null {
  const sub = (x: Expr, p = preds) => compile(model, x, plan, seen, p, vars);
  const scalar = (args: Expr[], make: (a: Expr[]) => Expr): Tree | null => {
    const ts: Tree[] = [];
    for (const a of args) {
      const t = sub(a);
      if (!t) return null;
      ts.push(t);
    }
    return { t: 'expr', model, make, args: ts };
  };
  const leaf = (table: string, agg: Agg): Tree | null => {
    if (plan.table === null) plan.table = table;
    if (plan.table !== table) return null; // one fact table per plan
    if (preds.some((p) => p.rows !== undefined && p.table !== table)) return null;
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
    case 'string':
    case 'boolean':
      return { t: 'lit', v: e.value };
    case 'var': {
      // bindings are evaluated where they're defined: their trees keep the CALCULATE filters around them
      const inner = new Map(vars);
      for (const b of e.bindings) {
        const t = compile(model, b.value, plan, seen, preds, inner);
        if (!t) return null;
        inner.set(b.name, t);
      }
      return compile(model, e.body, plan, seen, preds, inner);
    }
    case 'varRef':
      return vars.get(e.name) ?? null;
    case 'bracket': {
      if (!model.hasMeasure(e.name) || seen.has(e.name)) return null;
      seen.add(e.name);
      const r = compile(model, model.measure(e.name).ast, plan, seen, preds);
      seen.delete(e.name);
      return r;
    }
    case 'unary':
      if (e.op === 'NOT') return scalar([e.operand], ([x]) => ({ type: 'unary', op: 'NOT', operand: x }));
      if (e.op !== '-') return null;
      return ((x) => (x ? { t: 'bin', op: '*', l: { t: 'num', v: -1 }, r: x } : null))(sub(e.operand));
    case 'binary': {
      if (!['+', '-', '*', '/'].includes(e.op)) {
        if (!['=', '==', '<>', '<', '>', '<=', '>=', '&&', '||', '&'].includes(e.op)) return null;
        const op = e.op;
        return scalar([e.left, e.right], ([l, r]) => ({ type: 'binary', op, left: l, right: r }));
      }
      const l = sub(e.left);
      const r = l && sub(e.right);
      return l && r ? { t: 'bin', op: e.op as '+', l, r } : null;
    }
    case 'call': {
      if (e.name.toUpperCase() === 'IF' && (e.args.length === 2 || e.args.length === 3)) {
        // IF(<measure comparison>, a, [b]): "only when there are sales" and similar guards
        const c = e.args[0];
        if (c.type === 'binary' && ['>', '<', '>=', '<=', '=', '<>'].includes(c.op)) {
          const l = sub(c.left);
          const r = l && sub(c.right);
          const a = r && sub(e.args[1]);
          const b = a && e.args[2] ? sub(e.args[2]) : undefined;
          return l && r && a && b !== null ? { t: 'if', op: c.op, l, r, a, b } : null;
        }
      }
      const upper = e.name.toUpperCase();
      if (upper === 'BLANK' && !e.args.length) return { t: 'lit', v: null };
      if ((upper === 'TRUE' || upper === 'FALSE') && !e.args.length) return { t: 'lit', v: upper === 'TRUE' };
      if (SCALAR_FNS.has(upper) || ((upper === 'MIN' || upper === 'MAX') && e.args.length === 2)) {
        const name = e.name;
        return scalar(e.args, (args) => ({ type: 'call', name, args }));
      }
      if (e.name === 'DIVIDE' && (e.args.length === 2 || e.args.length === 3)) {
        const a = sub(e.args[0]);
        const b = a && sub(e.args[1]);
        const alt = e.args[2] ? sub(e.args[2]) : undefined;
        return a && b && alt !== null ? { t: 'div', a, b, alt } : null;
      }
      const over = e.args[0];
      if (ITER_FN[e.name] && e.args.length === 2 && over?.type === 'call' && ['VALUES', 'DISTINCT'].includes(over.name.toUpperCase()) && over.args.length === 1 && over.args[0].type === 'column') {
        // an iterator over a column's values with a measure body: one grouped query by (groups × column), folded
        const c = over.args[0];
        if (!plan.subs || preds.length || !model.hasTable(c.table) || !model.table(c.table).hasColumn(c.column)) return null;
        plan.subs.push({ kind: 'iter', fn: ITER_FN[e.name], col: model.resolveColumn({ table: c.table, column: c.column }), expr: e.args[1] });
        return { t: 'sub', i: plan.subs.length - 1 };
      }
      if (ITER_FN[e.name] && e.args.length === 2 && e.args[0].type === 'table') {
        const table = e.args[0].name;
        if (!model.hasTable(table)) return null;
        // a grouped query has no outer row context, so bare references to related tables follow relationships
        const row = compileRowExpr(model, table, e.args[1], true);
        if (!row) return null;
        if (plan.table === null) plan.table = table;
        if (plan.table !== table || preds.some((p) => p.rows !== undefined && p.table !== table)) return null;
        plan.aggs.push({ kind: ITER_FN[e.name], row, ...(preds.length ? { preds } : {}) });
        return { t: 'agg', i: plan.aggs.length - 1 };
      }
      const total = TI_TOTALS[e.name.toUpperCase()];
      if (total && e.args.length === 2 && e.args[1].type === 'column') return tiNode(model, e.args[0], { type: 'call', name: total, args: [e.args[1]] }, plan, seen, preds);
      if (e.name === 'CALCULATE' && e.args.length >= 2 && e.args.slice(1).some(isTiTable)) {
        // one time-intelligence filter; the others must be column filters, which apply inside it
        const tis = e.args.slice(1).filter(isTiTable);
        if (tis.length !== 1) return null;
        const rest = e.args.slice(1).filter((a) => !isTiTable(a));
        // a table filter next to the date set keeps the outer context's rows (and so its dates)
        if (rest.some((a) => a.type === 'call' && (a.name.toUpperCase() === 'FILTER' || (a.name.toUpperCase() === 'KEEPFILTERS' && a.args[0]?.type === 'call' && a.args[0].name.toUpperCase() === 'FILTER')))) return null;
        return tiNode(model, rest.length ? { type: 'call', name: 'CALCULATE', args: [e.args[0], ...rest] } : e.args[0], tis[0] as Expr & { type: 'call'; args: Expr[] }, plan, seen, preds);
      }
      if (e.name === 'CALCULATE' && e.args.length >= 2 && e.args.slice(1).some(isRemoval)) {
        // only where nothing outer filters the expression (the sub-query starts from the query's own filters); the
        // other arguments must be column filters, which don't depend on the context they're evaluated in
        if (!plan.subs || preds.length) return null;
        const mods = e.args.slice(1).filter(isRemoval);
        const others = e.args.slice(1).filter((a) => !isRemoval(a));
        for (const o of others) {
          const cond = o.type === 'call' && o.name.toUpperCase() === 'KEEPFILTERS' ? o.args[0] : o;
          if (!cond || !onlyColumn(cond)) return null;
        }
        plan.subs.push({ kind: 'all', mods, expr: others.length ? { type: 'call', name: 'CALCULATE', args: [e.args[0], ...others] } : e.args[0] });
        return { t: 'sub', i: plan.subs.length - 1 };
      }
      if (e.name === 'CALCULATE' && e.args.length >= 1) {
        // column filters become row predicates; one on a column the query groups or filters by would replace the
        // query's filter, which a single pass over the query's rows can't do
        let next = preds;
        for (const f of e.args.slice(1)) {
          const keep = f.type === 'call' && f.name.toUpperCase() === 'KEEPFILTERS';
          const cond = keep ? (f as { args: Expr[] }).args[0] : f;
          if (cond?.type === 'call' && cond.name.toUpperCase() === 'FILTER' && cond.args.length === 2 && cond.args[0].type === 'table') {
            // FILTER over the fact table: its rows within the outer filters, intersected with the rest
            const t = cond.args[0].name;
            if (!model.hasTable(t) || (plan.table !== null && plan.table !== t)) return null;
            if (!model.evaluator.rowTest(t, cond.args[1], true)) return null;
            let id = filterIds.get(cond.args[1]);
            if (id === undefined) filterIds.set(cond.args[1], (id = nextFilterId++));
            next = [...next, { table: t, rows: cond.args[1], within: preds, key: `FILTER#${id}(${preds.map((p) => p.key).join('&')})` }];
            continue;
          }
          const ref = cond && onlyColumn(cond);
          if (!ref || !model.hasTable(ref.table) || !model.table(ref.table).hasColumn(ref.column)) return null;
          const env = plan.env;
          if (!keep && env && (env.touched.has(refKey(ref.table, ref.column)) || env.touchedTables.has(ref.table))) return null;
          const p = predFor(model, ref, cond);
          if (!p) return null;
          // a nested filter on the same column replaces the outer one (KEEPFILTERS intersects)
          next = keep ? [...next, p] : [...next.filter((q) => q.table !== p.table || q.column !== p.column), p];
        }
        return sub(e.args[0], next);
      }
      if (upper === 'RANKX' && e.args.length >= 2 && e.args.length <= 5) {
        // RANKX(ALL(T[c]) | ALL(T), expr [, value [, order [, ties]]]): one ranking list per group outside the column
        const tab = e.args[0];
        if (!plan.subs || preds.length || tab.type !== 'call' || !['ALL', 'ALLSELECTED'].includes(tab.name.toUpperCase()) || tab.args.length !== 1) return null;
        const arg = tab.args[0];
        // a whole table ranks its rows: by its unique key (the one side of a relationship), one row per value
        const whole = arg.type === 'table' ? uniqueKey(model, arg.name) : null;
        const c = arg.type === 'column' ? arg : whole;
        if (!c || !model.hasTable(c.table) || !model.table(c.table).hasColumn(c.column)) return null;
        const word = (x: Expr | undefined) => (x?.type === 'table' ? x.name.toUpperCase() : null);
        const [order, ties] = [e.args[3], e.args[4]].map((x) => (isBlankCall(x) ? undefined : x));
        const asc = word(order) === 'ASC' || (order?.type === 'number' && order.value === 1);
        if (order && !asc && word(order) !== 'DESC' && !(order.type === 'number' && order.value === 0)) return null;
        const dense = word(ties) === 'DENSE';
        if (ties && !dense && word(ties) !== 'SKIP') return null;
        const v = sub(e.args[2] ?? e.args[1]);
        if (!v) return null;
        plan.subs.push({ kind: 'rank', col: model.resolveColumn({ table: c.table, column: c.column }), expr: e.args[1], asc, dense, selected: tab.name.toUpperCase() === 'ALLSELECTED', whole: !!whole });
        return { t: 'rank', i: plan.subs.length - 1, v };
      }
      if (e.name === 'COUNTROWS' && e.args.length === 1 && e.args[0].type === 'call' && ['VALUES', 'DISTINCT'].includes(e.args[0].name) && e.args[0].args.length === 1 && e.args[0].args[0].type === 'column') {
        // the distinct values of a fact-table column, BLANK included like DISTINCTCOUNT; a table on the one side of a
        // relationship can gain a blank row, which only the full engine adds
        const { table, column } = e.args[0].args[0];
        if (!model.hasTable(table) || !model.table(table).hasColumn(column) || model.relationships().some((r) => r.toTable === table)) return null;
        return leaf(table, { kind: 'distinct', column, isDate: model.table(table).column(column).type === 'date' });
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
  if (name === 'DATESINPERIOD') {
    // the start must be the visible dates' last or first one, on the same column: MAX(D[c]), LASTDATE(D[c]), …
    const st = a[1];
    const d = a[0] as Expr & { type: 'column' };
    const fn = st?.type === 'call' && st.args.length === 1 && st.args[0].type === 'column' && st.args[0].table === d.table && st.args[0].column === d.column ? st.name.toUpperCase() : '';
    const from = fn === 'MAX' || fn === 'LASTDATE' ? 'last' : fn === 'MIN' || fn === 'FIRSTDATE' ? 'first' : null;
    const n = lit(a[2]);
    const u = unit(a[3]);
    return from && n !== null && u && ['DAY', 'MONTH', 'QUARTER', 'YEAR'].includes(u) && a.length === 4 ? { fn: 'window', n, unit: u, from } : null;
  }
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
  if (sub.aggs.some((a) => a.kind === 'distinct' || a.isDate || a.preds?.some((p) => predOn(p, exp)))) return null;
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
    case 'if':
      return blankPreserving(t.a) && (t.b === undefined || blankPreserving(t.b));
    case 'lit':
      return t.v === null;
    case 'sub':
      // its rows can come from another table than the group's: groups come from the general path's combinations
      return false;
    case 'rank':
      return blankPreserving(t.v);
    case 'expr':
      // what an empty group (every aggregation BLANK) gives
      return evalTree(t, [], []) === null;
  }
}

/** A per-group result as a literal for the evaluator. */
function literal(v: CellValue): Expr {
  if (v === null) return { type: 'call', name: 'BLANK', args: [] };
  if (typeof v === 'number') return { type: 'number', value: v };
  if (typeof v === 'boolean') return { type: 'boolean', value: v };
  return { type: 'string', value: String(v) };
}

const num = (v: CellValue) => (v === null ? 0 : typeof v === 'number' ? v : v instanceof Date ? v.getTime() / 86_400_000 : Number(v));

/** Evaluate a tree with the evaluator's exact BLANK arithmetic. */
function evalTree(t: Tree, vals: CellValue[], ti: CellValue[] = [], sv: (CellValue | Ranker)[] = []): CellValue {
  switch (t.t) {
    case 'agg':
      return vals[t.i] ?? null;
    case 'ti':
      return ti[t.i] ?? null;
    case 'sub':
      return (sv[t.i] as CellValue) ?? null;
    case 'rank': {
      const r = sv[t.i] as Ranker | undefined;
      return r ? r(evalTree(t.v, vals, ti, sv)) : null;
    }
    case 'num':
    case 'lit':
      return t.v;
    case 'expr':
      return t.model.evaluator.evalScalar(t.make(t.args.map((a) => literal(evalTree(a, vals, ti, sv)))), { filters: [] });
    case 'bin': {
      const a = evalTree(t.l, vals, ti, sv);
      const b = evalTree(t.r, vals, ti, sv);
      if (t.op === '+' || t.op === '-') {
        if (a === null && b === null) return null;
        return t.op === '+' ? num(a) + num(b) : num(a) - num(b);
      }
      if (t.op === '*') return a === null || b === null ? null : num(a) * num(b);
      if (a === null && b === null) return null;
      if (num(b) === 0) return num(a) === 0 ? NaN : num(a) > 0 ? Infinity : -Infinity;
      return num(a) / num(b);
    }
    case 'if': {
      // the evaluator's comparison: BLANK compares as 0 against a number
      const c = compareValues(evalTree(t.l, vals, ti, sv) ?? 0, evalTree(t.r, vals, ti, sv) ?? 0);
      const ok = t.op === '>' ? c > 0 : t.op === '<' ? c < 0 : t.op === '>=' ? c >= 0 : t.op === '<=' ? c <= 0 : t.op === '=' ? c === 0 : c !== 0;
      return ok ? evalTree(t.a, vals, ti, sv) : t.b ? evalTree(t.b, vals, ti, sv) : null;
    }
    case 'div': {
      const a = evalTree(t.a, vals, ti, sv);
      const b = evalTree(t.b, vals, ti, sv);
      if (b === null || num(b) === 0) return t.alt ? evalTree(t.alt, vals, ti, sv) : null;
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
        case 'minx':
          return this.cnt[i] ? this.min[i] : null;
        case 'maxx':
          return this.cnt[i] ? this.max[i] : null;
        case 'countx':
          return this.cnt[i] || null;
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
  const walk = (x: Tree): boolean =>
    x.t === 'agg' ? !aggs[x.i].isDate : x.t === 'num' || x.t === 'ti' || x.t === 'lit' || x.t === 'sub' ? true : x.t === 'expr' ? x.args.every(walk) : x.t === 'rank' ? walk(x.v) : x.t === 'bin' ? walk(x.l) && walk(x.r) : x.t === 'if' ? walk(x.l) && walk(x.r) && walk(x.a) && (!x.b || walk(x.b)) : walk(x.a) && walk(x.b) && (!x.alt || walk(x.alt));
  return t.t === 'agg' || walk(t);
}

/** Group codes per fact row, by the row map and the column codes they were made from. */
const composed = new WeakMap<Int32Array, WeakMap<Int32Array, Int32Array>>();

/**
 * Group code for every row of `fact` (many → one hops). Each hop maps the foreign key's dictionary codes through the
 * key index once, so the per-row cost is two typed-array reads instead of a hash lookup.
 */
function groupCodes(model: DataModel, fact: string, col: ColumnRef): Int32Array | null {
  const target = model.table(col.table).codes(col.column).codes;
  if (col.table === fact) return target;
  // through the model's cached row map (fact row → dimension row): rebuilt only when either array is
  const map = model.relatedRows(fact, col.table);
  if (map) {
    let byTarget = composed.get(map);
    if (!byTarget) composed.set(map, (byTarget = new WeakMap()));
    let out = byTarget.get(target);
    if (!out) {
      out = new Int32Array(map.length);
      for (let r = 0; r < map.length; r++) out[r] = map[r] < 0 ? UNMATCHED : target[map[r]];
      byTarget.set(target, out);
    }
    return out;
  }
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

/** Fold one aggregation list's values per slot: aggregation i of slot s lives at i * S + s; negative slots are skipped. */
function accumulate(prep: Prepared, slot: Int32Array, S: number, list: ArrayLike<number> | null) {
  const { aggs, cols, nums, rowFns, predTests } = prep;
  const count = slot.length;
  const n = aggs.length * S;
  const sum = new Float64Array(n);
  const cnt = new Float64Array(n);
  const mn = new Float64Array(n).fill(Infinity);
  const mx = new Float64Array(n).fill(-Infinity);
  aggs.forEach((a, i) => {
    const o = i * S;
    const pt = predTests[i];
    const v = nums[i];
    if (v && !pt) {
      // the common case, a plain column aggregation: one tight loop
      for (let j = 0; j < count; j++) {
        const p = slot[j];
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
      const p = slot[j];
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
}

type Partials = ReturnType<typeof accumulate>;

/**
 * Per-date partial aggregates for the time-intelligence nodes, in one pass over the fact rows the date filters don't
 * restrict. Each group's date set comes from its visible dates by the same rules as the evaluator (dax/timeIntel) and
 * combines the partials of those dates: period-to-date and parallel periods are ranges of the sorted dates. Groupings
 * by columns outside the date table (product × month) keep partials per group and date. Null when the query doesn't
 * fit.
 */
function timeIntelligence(model: DataModel, fact: string, nodes: TiNode[], mainAggs: Agg[], groupCols: ColumnRef[], keyCodes: Int32Array[], dicts: CellValue[][], base: Filter[], highlight: Filter[] | undefined, prepare: (aggs: Agg[]) => Prepared | null) {
  const dt = nodes[0].date.table;
  const dc = nodes[0].date.column;
  if (highlight || nodes.some((n) => n.date.table !== dt || n.date.column !== dc) || fact === dt) return null;
  // filters flowing back to the date table would change which dates are visible
  if (model.relationships().some((r) => r.active && r.crossFilter === 'both')) return null;
  const map = model.relatedRows(fact, dt);
  if (!map) return null;
  const exp = model.expanded(dt);
  // group columns outside the date table split the partials; they must not filter the dates themselves
  const other = groupCols.flatMap((c, j) => (c.table === dt ? [] : [j]));
  if (other.some((j) => exp.has(groupCols[j].table))) return null;
  const dateCols = groupCols.flatMap((c, j) => (c.table === dt ? [j] : []));
  // the query's other aggregations come from the same partials, summed over each group's own dates, when they
  // merge (not distinct counts) and the date table's filters are only its own
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
  const P = sorted.length;
  // fact rows without a dated date-table row: only a date set nothing restricts (no date filter or group) sees them
  const ORPHAN = P;
  const S1 = P + 1;

  // the date set replaces every filter within the date table's expanded table (CALCULATE's clearTable)
  const kept = base.filter((f) => f.kind === 'rel' || !(f.kind === 'rows' ? exp.has(f.table) : f.columns.every((c) => exp.has(c.table))));
  const datesFiltered = kept.length < base.length;
  // with nothing left to filter (and no security roles) every fact row counts: no row list needed
  const list = kept.length || model.activeRoleNames.length ? model.rowsOf(fact, kept) : null;
  const count = list ? list.length : map.length;
  const at = new Int32Array(count); // date position of each counted row
  for (let j = 0; j < count; j++) {
    const d = map[list ? list[j] : j];
    at[j] = d < 0 || rowPos[d] < 0 ? ORPHAN : rowPos[d];
  }

  // with groups outside the date table, each counted row feeds the cell of its group key and date. Keys are
  // mixed-radix numbers over the codes (BLANK = digit 0); key `space` collects rows with no related group row.
  const radix = other.map((j) => dicts[j].length + 1);
  const space = radix.reduce((a, b) => a * b, 1);
  let cellOf: ((k: number, p: number) => number) | null = null;
  let slot = at;
  let S = S1;
  const cellPos: number[] = [];
  if (other.length) {
    if ((space + 1) * S1 > Number.MAX_SAFE_INTEGER) return null;
    const oc = other.map((j) => keyCodes[j]);
    const dense = (space + 1) * S1 <= DENSE_GROUPS ? new Int32Array((space + 1) * S1).fill(-1) : null;
    const sparse = dense ? null : new Map<number, number>();
    slot = new Int32Array(count);
    for (let j = 0; j < count; j++) {
      const r = list ? list[j] : j;
      let k = 0;
      for (let x = 0; x < oc.length; x++) {
        const c = oc[x][r];
        if (c === UNMATCHED) {
          k = space;
          break;
        }
        k = k * radix[x] + c + 1;
      }
      const key = k * S1 + at[j];
      let cell = dense ? dense[key] : (sparse!.get(key) ?? -1);
      if (cell < 0) {
        cell = cellPos.length;
        cellPos.push(at[j]);
        if (dense) dense[key] = cell;
        else sparse!.set(key, cell);
      }
      slot[j] = cell;
    }
    S = cellPos.length;
    cellOf = (k, p) => (k !== k ? -1 : dense ? dense[k * S1 + p] : (sparse!.get(k * S1 + p) ?? -1));
  }
  const parts = preps.map((prep) => accumulate(prep!, slot, S, list));
  // the totals' partials per date: the cells folded together
  const totals: Partials[] = cellOf
    ? parts.map((c, s) => {
        const A = sets[s].aggs.length;
        const t = { sum: new Float64Array(A * S1), cnt: new Float64Array(A * S1), mn: new Float64Array(A * S1).fill(Infinity), mx: new Float64Array(A * S1).fill(-Infinity) };
        for (let i = 0; i < A; i++)
          for (let e = 0; e < S; e++) {
            const q = i * S + e;
            if (!c.cnt[q]) continue;
            const u = i * S1 + cellPos[e];
            t.sum[u] += c.sum[q];
            t.cnt[u] += c.cnt[q];
            if (c.mn[q] < t.mn[u]) t.mn[u] = c.mn[q];
            if (c.mx[q] > t.mx[u]) t.mx[u] = c.mx[q];
          }
        return t;
      })
    : parts;

  // visible dates per date-table key (and for the totals): the date-table rows under the query's filters
  const keyOf = (keys: CellValue[]) => keys.map((v) => String(valueKey(v))).join('');
  const groupVals = dateCols.map((j) => dtab.column(groupCols[j].column).values);
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
  // each set's date positions, resolved once per date-table key: every product of a month shares the month's
  const resolved = sets.map(() => new Map<string, number[]>());
  const totalPositions: (number[] | undefined)[] = [];
  const positions = (s: number, ps: number[] | undefined, unrestricted: boolean): number[] => {
    const out: number[] = [];
    if (!ps?.length) return out;
    let first = Infinity;
    let last = -Infinity;
    for (const p of ps) (first = Math.min(first, p)), (last = Math.max(last, p));
    const rule = sets[s].rule;
    if (rule.fn === 'same') {
      out.push(...new Set(ps));
      if (unrestricted) out.push(ORPHAN);
    } else if (rule.fn === 'td') for (let p = lowerBound(periodStart(new Date(sorted[last]), rule.period, rule.yearEnd).getTime()); p <= last; p++) out.push(p);
    else if (rule.fn === 'window') {
      const [start, end] = periodWindow(new Date(sorted[rule.from === 'last' ? last : first]), rule.n, rule.unit);
      for (let p = lowerBound(start.getTime()); p < sorted.length && sorted[p] <= end.getTime() + 1e-3; p++) out.push(p);
    } else if (rule.fn === 'parallel') {
      const [start, end] = parallelPeriod(new Date(sorted[first]), rule.unit, rule.n);
      for (let p = lowerBound(start.getTime()); p < sorted.length && sorted[p] <= end.getTime(); p++) out.push(p);
    } else
      for (const d of shiftDates(
        ps.map((p) => new Date(sorted[p])),
        existing,
        rule.n,
        rule.unit,
      ))
        out.push(posOf.get(d.getTime())!);
    return out;
  };
  /** `k` is the group key over the columns outside the date table (NaN: no rows), or null for the totals. */
  const values = (dkey: string | null, k: number | null): { ti: CellValue[]; main?: CellValue[] } => {
    const out = sets.map((n, s) => {
      let ps = dkey === null ? totalPositions[s] : resolved[s].get(dkey);
      if (!ps) {
        ps = dkey === null ? positions(s, all, !datesFiltered) : positions(s, visible.get(dkey), !datesFiltered && !dateCols.length);
        if (dkey === null) totalPositions[s] = ps;
        else resolved[s].set(dkey, ps);
      }
      const acc = new Acc(n.aggs);
      const { sum, cnt, mn, mx } = k === null ? totals[s] : parts[s];
      const stride = k === null ? S1 : S;
      const A = n.aggs.length;
      for (const p of ps) {
        const c = k === null ? p : cellOf!(k, p);
        if (c < 0) continue;
        for (let i = 0, q = c; i < A; i++, q += stride) {
          if (!cnt[q]) continue;
          acc.sum[i] += sum[q];
          acc.cnt[i] += cnt[q];
          if (mn[q] < acc.min[i]) acc.min[i] = mn[q];
          if (mx[q] > acc.max[i]) acc.max[i] = mx[q];
        }
      }
      return acc.result(n.aggs);
    });
    return { ti: nodes.map((n, s) => evalTree(n.tree, out[s])), main: withMain ? out[nodes.length] : undefined };
  };
  const codeOf = other.map((j) => new Map(dicts[j].map((v, c) => [valueKey(v), c])));
  return {
    /** The query's own aggregations come with the groups' values (no separate pass needed). */
    merged: withMain,
    group: (keys: CellValue[]) => {
      let k = 0;
      other.forEach((j, x) => {
        const v = keys[j];
        k = k * radix[x] + (v === null ? -1 : (codeOf[x].get(valueKey(v)) ?? NaN)) + 1;
      });
      return values(keyOf(dateCols.map((j) => keys[j])), other.length ? k : null);
    },
    total: () => values(null, null),
  };
}

export interface FastResult {
  rows: QueryRow[];
  totals: CellValue[];
}

/**
 * Single-pass grouped evaluation for simple measures (SUM/AVERAGE/MIN/MAX/COUNT/DISTINCTCOUNT/COUNTROWS
 * combined with + - * / and DIVIDE). Returns null when the full engine is needed. Results are identical to the
 * general path: groups come from visible fact rows (auto-exist) and all-blank groups are dropped. Without `wantTotals`
 * the grand totals aren't accumulated and `totals` is empty.
 */
export function fastGroupQuery(model: DataModel, groupCols: ColumnRef[], values: Expr[], base: Filter[], highlight: Filter[] | undefined, combos?: () => CellValue[][], wantTotals = true): FastResult | null {
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
  const plan: Plan = { table: null, aggs: [], keys: new Map(), env: { touched, touchedTables }, ti: [], subs: [] };
  const trees: Tree[] = [];
  // a value that isn't BLANK for an empty group (COALESCE(x, 0)) shows every combination, as in the general path
  let everyCombo = false;
  for (const v of values) {
    const t = compile(model, v, plan, new Set());
    if (!t || !datesOnlyAtTop(t, plan.aggs)) return null;
    if (!blankPreserving(t)) everyCombo = true;
    trees.push(t);
  }
  if (everyCombo && !combos) return null;
  const subs: ResolvedSub[] = [];
  for (const sn of plan.subs!) {
    const r = resolveSub(model, sn, groupCols, base, wantTotals);
    if (!r) return null;
    subs.push(r);
  }
  // highlighted values: the same sub-results over the query's filters plus the highlight (removals apply to both)
  const hlSubs: ResolvedSub[] = [];
  if (highlight)
    for (const sn of plan.subs!) {
      const r = resolveSub(model, sn, groupCols, [...base, ...highlight], false);
      if (!r || r.dates) return null;
      hlSubs.push(r);
    }
  const subVals = (keys: CellValue[]) => subs.map((x) => x.value(keys));
  const hlSubVals = (keys: CellValue[]) => (hlSubs.length ? hlSubs.map((x) => x.value(keys)) : undefined);
  const subTotals = () => subs.map((x) => x.total);
  if (subs.some((x) => x.dates)) return null;
  const fact = plan.table;
  if (!fact) {
    // only coarser sub-results (CALCULATE([x], ALL(Product), …)): each existing combination takes its coarse value
    if (!subs.length || !combos) return null;
    const rows: QueryRow[] = [];
    for (const keys of combos()) {
      const sv = subVals(keys);
      const vals = trees.map((t) => evalTree(t, [], [], sv));
      if (vals.every((v) => v === null)) continue;
      const row: QueryRow = { keys, values: vals };
      if (highlight) row.highlights = trees.map((t) => evalTree(t, [], [], hlSubVals(keys)));
      rows.push(row);
    }
    return { rows, totals: wantTotals ? trees.map((t) => evalTree(t, [], [], subTotals())) : [] };
  }
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
      const testOf = (p: Pred): ((r: number) => boolean) | null => {
        if (p.rows !== undefined) {
          const t = p.table === fact ? model.evaluator.rowTest(fact, p.rows, true) : null;
          const within = p.within.map(testOf);
          if (!t || within.some((w) => !w)) return null;
          const ws = within as ((r: number) => boolean)[];
          return ws.length ? (r: number) => t(r) && ws.every((w) => w(r)) : t;
        }
        const codes = model.table(p.table).codes(p.column).codes;
        if (p.table === fact) return (r: number) => p.allowed[codes[r] + 1] === 1;
        const map = model.relatedRows(fact, p.table);
        if (!map) return null;
        // a fact row without a related row sees the dimension's BLANK row
        return (r: number) => {
          const t = map[r];
          return p.allowed[t < 0 ? 0 : codes[t] + 1] === 1;
        };
      };
      const tests = a.preds.map(testOf);
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
        else if (a.row) {
          // unlike stored columns, NaN here is a computed value (0/0), not BLANK
          const v = rowFns[i]!(r);
          if (v === null) continue;
          acc.cnt[i]++;
          acc.sum[i] += v;
          if (v < acc.min[i]) acc.min[i] = v;
          if (v > acc.max[i]) acc.max[i] = v;
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
  const ti = plan.ti!.length ? timeIntelligence(model, fact, plan.ti!, plan.aggs, groupCols, kc, dicts, base, highlight, prepare) : undefined;
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
    if (wantTotals) feed(total, r);
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
  if (ti || everyCombo) {
    // groups come from the date table, as in the general path: a month without sales still has last year's
    const codeOf = dicts.map((d) => new Map(d.map((v, k) => [valueKey(v), k])));
    for (const keys of combos?.() ?? []) {
      let k: number | string = numeric ? 0 : '';
      keys.forEach((v, j) => {
        const c = v === null ? -1 : (codeOf[j].get(valueKey(v)) ?? -1);
        k = numeric ? (k as number) * radix[j] + c + 1 : `${k}${j ? '|' : ''}${c}`;
      });
      const gi = lookup(k);
      const tv: { ti: CellValue[]; main?: CellValue[] } = ti ? ti.group(keys) : { ti: [] };
      const aggVals = tv.main ?? (gi === undefined ? empty : accs[gi].result(plan.aggs));
      const vals = trees.map((t) => evalTree(t, aggVals, tv.ti, subs.length ? subVals(keys) : undefined));
      if (vals.every((v) => v === null)) continue;
      const row: QueryRow = { keys, values: vals };
      // time intelligence never runs with highlights (see timeIntelligence), so only the plain aggregations here
      if (hl) row.highlights = trees.map((t) => evalTree(t, (gi === undefined ? undefined : hl![gi]?.result(plan.aggs)) ?? empty, undefined, hlSubVals(keys)));
      rows.push(row);
    }
    if (!wantTotals) return { rows, totals: [] };
    const tt: { ti: CellValue[]; main?: CellValue[] } = ti ? ti.total() : { ti: [] };
    return { rows, totals: trees.map((t) => evalTree(t, tt.main ?? total.result(plan.aggs), tt.ti, subTotals())) };
  }
  accs.forEach((acc, gi) => {
    const aggVals = acc.result(plan.aggs);
    const keys = groupKeys[gi].map((code, j) => (code < 0 ? null : dicts[j][code]));
    const sv = subs.length ? subVals(keys) : undefined;
    const vals = trees.map((t) => evalTree(t, aggVals, undefined, sv));
    if (vals.every((v) => v === null)) return;
    const row: QueryRow = { keys, values: vals };
    if (hl) {
      const h = hl[gi]?.result(plan.aggs) ?? empty;
      row.highlights = trees.map((t) => evalTree(t, h, undefined, hlSubVals(keys)));
    }
    rows.push(row);
  });
  return { rows, totals: wantTotals ? trees.map((t) => evalTree(t, total.result(plan.aggs), undefined, subTotals())) : [] };
}

interface ResolvedSub {
  value(keys: CellValue[]): CellValue | Ranker;
  total: CellValue | Ranker;
  /** Date results would meet the tree's arithmetic, which doesn't follow DAX's date rules. */
  dates: boolean;
}

/**
 * Answer a measure under removal modifiers for every group at once. The evaluator applies the removals to the query's
 * filters (exact CALCULATE semantics); a group column stays when its group filter survives them. The rest is a
 * coarser grouped query in one pass (null when that query can't take it).
 */
function resolveSub(model: DataModel, sn: SubNode, groupCols: ColumnRef[], base: Filter[], wantTotals: boolean): ResolvedSub | null {
  if (sn.kind === 'rank') return resolveRank(model, sn, groupCols, base, wantTotals);
  if (sn.kind === 'iter') return resolveIter(model, sn, groupCols, base, wantTotals);
  const ev = model.evaluator;
  const rest = ev.removeWith(base, sn.mods);
  if (!rest) return null;
  const groupF = (c: ColumnRef, v: CellValue): ColumnsFilter => {
    const f = compileFilter({ target: c, op: 'eq', value: v });
    return { ...f, origin: 'group', key: `${f.key}@group` };
  };
  const keep: number[] = [];
  for (let j = 0; j < groupCols.length; j++) {
    const left = ev.removeWith([groupF(groupCols[j], null)], sn.mods);
    if (!left) return null;
    if (left.length) keep.push(j);
  }
  const total = ev.evalScalar(sn.expr, { filters: rest });
  let dates = total instanceof Date;
  if (!keep.length) return { value: () => total, total, dates };
  const cols = keep.map((j) => groupCols[j]);
  const keyOf = (keys: CellValue[]) => keep.map((j) => String(valueKey(keys[j]))).join('\u0001');
  const fast = fastGroupQuery(model, cols, [sn.expr], rest, undefined, undefined, false);
  if (fast) {
    const byKey = new Map<string, CellValue>();
    for (const r of fast.rows) {
      byKey.set(r.keys.map((v) => String(valueKey(v))).join('\u0001'), r.values[0]);
      if (r.values[0] instanceof Date) dates = true;
    }
    return { value: (keys) => byKey.get(keyOf(keys)) ?? null, total, dates };
  }
  return null;
}

/**
 * RANKX(ALL(T[c]), expr): the iterated rows set T[c] by context transition, which overrides the query's filters on that
 * column and keeps the others, so each group's list is `expr` by (group columns other than c) × c, from one grouped
 * query, sorted once per coarse key. `expr` must be BLANK for a value without rows (those drop out of the list either
 * way), and every row must have a related T row, so that ALL(T[c]) has no blank member the grouped query can't see.
 */
function resolveRank(model: DataModel, sn: SubNode & { kind: 'rank' }, groupCols: ColumnRef[], base: Filter[], wantTotals: boolean): ResolvedSub | null {
  const c = sn.col;
  // ALLSELECTED lists the values the query's own filters leave: the same as ALL unless they filter the column itself
  // a row of the whole table sets all its columns: every filter on them goes, and so do group columns of the table
  const on = (x: ColumnRef) => x.table === c.table && (sn.whole || x.column === c.column);
  if (sn.selected && base.some((f) => (f.kind === 'rows' ? f.table === c.table : f.kind === 'columns' && f.columns.some(on)))) return null;
  if (hasBlankMember(model, c.table)) return null;
  const cleared = sn.whole ? [...model.table(c.table).columns.keys()] : [c.column];
  const removed = model.evaluator.removeWith(base, [{ type: 'call', name: 'REMOVEFILTERS', args: cleared.map((column) => ({ type: 'column', table: c.table, column })) }]);
  if (!removed) return null;
  const rest = sn.whole ? removed.filter((f) => f.kind !== 'rows' || f.table !== c.table) : removed;
  const keep = groupCols.flatMap((g, j) => (on(g) ? [] : [j]));
  const listsBy = (cols: ColumnRef[]) => {
    const q = fastGroupQuery(model, [...cols, c], [sn.expr], rest, undefined, undefined, false);
    if (!q) return null;
    const lists = new Map<string, number[]>();
    for (const r of q.rows) {
      const v = r.values[0];
      if (v === null) continue;
      if (typeof v !== 'number' || v !== v) return null;
      const k = r.keys.slice(0, cols.length).map((x) => String(valueKey(x))).join('\u0001');
      const l = lists.get(k);
      if (l) l.push(v);
      else lists.set(k, [v]);
    }
    return lists;
  };
  const ranker = (list: number[] | undefined): Ranker => {
    const sorted = Float64Array.from(list ?? []).sort();
    const xs = sn.dense ? Float64Array.from(new Set(sorted)) : sorted;
    // how many entries are below (or above) v, by binary search
    const below = (v: number, orEqual: boolean) => {
      let lo = 0;
      let hi = xs.length;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (xs[m] < v || (orEqual && xs[m] === v)) lo = m + 1;
        else hi = m;
      }
      return lo;
    };
    return (v) => {
      if (v === null) return null;
      if (typeof v !== 'number') {
        // the evaluator's comparison, for values of another type
        const cmp = (x: number) => (sn.asc ? compareValues(x, v) < 0 : compareValues(x, v) > 0);
        return xs.filter(cmp).length + 1;
      }
      return (sn.asc ? below(v, false) : xs.length - below(v, true)) + 1;
    };
  };
  // the totals' list (by the column alone) is one more pass, only made when totals are wanted
  const totalLists = wantTotals || !keep.length ? listsBy([]) : new Map<string, number[]>();
  const lists = keep.length ? listsBy(keep.map((j) => groupCols[j])) : totalLists;
  if (!lists || !totalLists) return null;
  const rankers = new Map<string, Ranker>();
  const total = ranker(totalLists.get(''));
  return {
    value: (keys) => {
      const k = keep.map((j) => String(valueKey(keys[j]))).join('\u0001');
      let r = rankers.get(k);
      if (!r) rankers.set(k, (r = ranker(lists.get(k))));
      return r;
    },
    total,
    dates: false,
  };
}

/** The column a table is related by on its one side, when its values are unique (one per row), or null. */
function uniqueKey(model: DataModel, table: string): ColumnRef | null {
  if (!model.hasTable(table)) return null;
  const t = model.table(table);
  for (const r of model.relationships())
    if (r.toTable === table && t.hasColumn(r.toColumn) && t.distinct(r.toColumn).length === t.rowCount) return { table, column: r.toColumn };
  return null;
}

/** Can a column of this table show a blank member (a related row without a match), which grouped queries skip? */
function hasBlankMember(model: DataModel, table: string): boolean {
  for (const r of model.relationships())
    if (r.active && r.toTable === table) {
      const map = model.relatedRows(r.fromTable, table);
      if (!map || map.some((x) => x < 0)) return true;
    }
  return false;
}

/**
 * An iterator over VALUES(T[c]) with a measure body: within a group, each value of the column sets T[c] by context
 * transition (narrowing the group), so the body's values are a grouped query by (group columns + c). The body must be
 * BLANK for a value without rows, which iterators skip.
 */
function resolveIter(model: DataModel, sn: SubNode & { kind: 'iter' }, groupCols: ColumnRef[], base: Filter[], wantTotals: boolean): ResolvedSub | null {
  const c = sn.col;
  if (hasBlankMember(model, c.table)) return null;
  const at = groupCols.findIndex((g) => g.table === c.table && g.column === c.column);
  const fold = (cols: ColumnRef[], keyLen: number) => {
    const q = fastGroupQuery(model, cols, [sn.expr], base, undefined, undefined, false);
    if (!q) return null;
    const accs = new Map<string, { sum: number; n: number; min: number; max: number }>();
    for (const r of q.rows) {
      const v = r.values[0];
      if (v === null) continue;
      if (typeof v !== 'number') return null;
      const k = r.keys.slice(0, keyLen).map((x) => String(valueKey(x))).join('\u0001');
      const a = accs.get(k);
      if (a) (a.sum += v), a.n++, (a.min = Math.min(a.min, v)), (a.max = Math.max(a.max, v));
      else accs.set(k, { sum: v, n: 1, min: v, max: v });
    }
    const out = new Map<string, CellValue>();
    for (const [k, a] of accs) out.set(k, sn.fn === 'sumx' ? a.sum : sn.fn === 'avgx' ? a.sum / a.n : sn.fn === 'minx' ? a.min : sn.fn === 'maxx' ? a.max : a.n);
    return out;
  };
  // the group's own key when it groups by the column; otherwise groups × column, keyed by the groups
  const byGroup = fold(at >= 0 ? groupCols : [...groupCols, c], groupCols.length);
  const all = wantTotals ? fold([c], 0) : new Map<string, CellValue>();
  if (!byGroup || !all) return null;
  return { value: (keys) => byGroup.get(keys.map((x) => String(valueKey(x))).join('\u0001')) ?? null, total: all.get('') ?? null, dates: false };
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
