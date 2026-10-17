import type { Expr } from './ast';
import type { CellValue, ColumnRef } from '../data/types';
import { compareValues, valueKey } from '../data/types';
import type { ColumnsFilter, Filter } from '../data/filters';
import { compileFilter, contextKey, overrideFilters, relFilter, rowsFilter } from '../data/filters';
import { groupCombos, groupFilter } from '../data/query';
import type { DataModel } from '../data/model';
import { formatValue } from '../format/format';
import { PartialAggregates, type PartialKind } from '../data/partials';
import { fastPathsEnabled } from '../data/fastQuery';
import { compileRowExpr, type RowFn, type RowPlan } from './rowCompile';

export class DaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaxError';
  }
}

/** Rows of a physical table. */
export interface RowsTable {
  kind: 'rows';
  table: string;
  rows: number[];
}

/** A set of distinct column tuples (VALUES, ALL(col), DATESYTD, ...). */
export interface TuplesTable {
  kind: 'tuples';
  columns: ColumnRef[];
  tuples: CellValue[][];
  /** Time-intelligence results clear every other filter on this (date) table when used in CALCULATE. */
  clearTable?: string;
  /** Display format per column (computed columns that are plain measure references). */
  formats?: (string | undefined)[];
}

export type TableValue = RowsTable | TuplesTable;
export type Value = CellValue | TableValue;

type RowBinding = { kind: 'row'; table: string; row: number } | { kind: 'tuple'; columns: ColumnRef[]; values: CellValue[] };

export interface EvalContext {
  filters: readonly Filter[];
  rows?: readonly RowBinding[];
  vars?: ReadonlyMap<string, Value>;
  /** Measure being rewritten by a calculation item (SELECTEDMEASURE). */
  selectedMeasure?: string;
}

/** CALCULATE modifiers returned by ALL/REMOVEFILTERS/ALLEXCEPT/ALLSELECTED/KEEPFILTERS. */
type Modifier =
  | { mod: 'removeTable'; table: string }
  | { mod: 'removeColumns'; columns: ColumnRef[] }
  | { mod: 'allExcept'; table: string; keep: ColumnRef[] }
  | { mod: 'allSelected'; tables?: string[]; columns?: ColumnRef[] }
  | { mod: 'keep'; filters: Filter[] };

/** Functions whose arguments are evaluated in their own context – column refs inside them are not "free". */
const CONTEXT_FUNCS = new Set([
  'OFFSET', 'INDEX', 'WINDOW', 'RANK', 'ROWNUMBER', 'ORDERBY', 'PARTITIONBY', 'MATCHBY',
  'SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'COUNTBLANK', 'COUNTROWS', 'DISTINCTCOUNT', 'DISTINCTCOUNTNOBLANK', 'MEDIAN',
  'SUMX', 'AVERAGEX', 'MINX', 'MAXX', 'COUNTX', 'COUNTAX', 'MEDIANX', 'CONCATENATEX', 'RANKX', 'PRODUCTX', 'PRODUCT',
  'CALCULATE', 'CALCULATETABLE', 'FILTER', 'ALL', 'ALLSELECTED', 'ALLEXCEPT', 'REMOVEFILTERS', 'VALUES', 'DISTINCT', 'SELECTEDVALUE',
  'HASONEVALUE', 'ISFILTERED', 'TOPN', 'RELATEDTABLE', 'FIRSTDATE', 'LASTDATE', 'TOTALYTD', 'TOTALMTD', 'TOTALQTD',
  'SUMMARIZE', 'SUMMARIZECOLUMNS', 'ADDCOLUMNS', 'SELECTCOLUMNS', 'LOOKUPVALUE', 'EARLIER', 'EARLIEST', 'ISINSCOPE', 'ISCROSSFILTERED', 'TREATAS', 'CONTAINS',
  'STDEV.S', 'STDEV.P', 'VAR.S', 'VAR.P', 'STDEVX.S', 'STDEVX.P', 'VARX.S', 'VARX.P', 'PERCENTILE.INC', 'PERCENTILE.EXC', 'PERCENTILEX.INC', 'PERCENTILEX.EXC', 'GEOMEAN', 'GEOMEANX', 'FIRSTNONBLANK', 'LASTNONBLANK', 'AVERAGEA', 'MAXA', 'MINA',
]);

const MS_DAY = 86_400_000;

const UNHANDLED = Symbol('unhandled');
const FAST_AGGS = new Set(['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'DISTINCTCOUNT']);

function isTable(v: Value): v is TableValue {
  return v !== null && typeof v === 'object' && !(v instanceof Date) && 'kind' in v;
}

function num(v: CellValue): number {
  if (v === null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.getTime() / MS_DAY;
  const n = Number(v);
  if (Number.isNaN(n)) throw new DaxError(`Cannot convert value "${v}" of type Text to type Number`);
  return n;
}

function truthy(v: CellValue): boolean {
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    if (v.toUpperCase() === 'TRUE') return true;
    if (v.toUpperCase() === 'FALSE' || v === '') return false;
  }
  return true;
}

function blankAs(v: CellValue, like: CellValue): CellValue {
  if (v !== null) return v;
  if (typeof like === 'string') return '';
  if (typeof like === 'boolean') return false;
  if (like instanceof Date) return new Date(0);
  return 0;
}

function addMonths(d: Date, n: number): Date {
  const r = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
  r.setDate(Math.min(d.getDate(), last));
  return r;
}

/**
 * Evaluates DAX-like expressions against a {@link DataModel}.
 * Implements filter context, row context, context transition and CALCULATE semantics.
 */
export class Evaluator {
  private measureCache = new Map<string, CellValue>();
  private partials: PartialAggregates;
  private stack: string[] = [];
  /** Compiled row expressions per AST node and iterated table (WeakMap: ad-hoc ASTs don't accumulate). */
  private rowPlans = new WeakMap<Expr, Map<string, RowPlan | null>>();

  constructor(private model: DataModel) {
    this.partials = new PartialAggregates(model);
  }

  /** Drop memoised measure results (called by the model whenever data or definitions change). */
  clearCache(): void {
    this.measureCache.clear();
    this.partials.clear();
    this.rowPlans = new WeakMap();
  }

  // ------------------------------------------------------------ entry points

  evalScalar(expr: Expr, ctx: EvalContext): CellValue {
    const v = this.eval(expr, ctx);
    if (isTable(v)) return this.tableToScalar(v);
    return v;
  }

  evalScalarInRow(expr: Expr, table: string, row: number): CellValue {
    return this.evalScalar(expr, { filters: [], rows: [{ kind: 'row', table, row }] });
  }

  /** Evaluate `expr` in a row context on each of the first `count` rows of `table` (calculated columns). */
  evalColumn(expr: Expr, table: string, count: number): CellValue[] {
    const values: CellValue[] = new Array(count);
    const f = this.rowFn(table, expr, { filters: [] });
    if (f) for (let i = 0; i < count; i++) values[i] = f(i);
    else for (let i = 0; i < count; i++) values[i] = this.evalScalarInRow(expr, table, i);
    return values;
  }

  evalMeasure(name: string, filters: readonly Filter[]): CellValue {
    return this.callMeasure(name, { filters });
  }

  // ------------------------------------------------------------ core

  private eval(e: Expr, ctx: EvalContext): Value {
    switch (e.type) {
      case 'number':
      case 'string':
      case 'boolean':
        return e.value;
      case 'column':
        return this.columnValue({ table: e.table, column: e.column }, ctx);
      case 'bracket':
        if (this.model.hasMeasure(e.name)) return this.callMeasure(e.name, ctx);
        return this.unqualifiedColumn(e.name, ctx);
      case 'table':
        return this.evalTable(e, ctx);
      case 'varRef': {
        const vname = e.name.toUpperCase();
        if (!ctx.vars?.has(vname)) throw new DaxError(`Variable ${e.name} is not defined`);
        return ctx.vars.get(vname)!;
      }
      case 'var': {
        const vars = new Map(ctx.vars ?? []);
        for (const b of e.bindings) vars.set(b.name.toUpperCase(), this.eval(b.value, { ...ctx, vars }));
        return this.eval(e.body, { ...ctx, vars });
      }
      case 'list':
        return this.listToTable(e, ctx);
      case 'unary': {
        const v = this.evalScalar(e.operand, ctx);
        if (e.op === 'NOT') return !truthy(v);
        if (v === null) return null;
        return e.op === '-' ? -num(v) : num(v);
      }
      case 'binary':
        return this.binary(e.op, e.left, e.right, ctx);
      case 'call':
        return this.call(e.name, e.args, ctx);
    }
  }

  private binary(op: string, l: Expr, r: Expr, ctx: EvalContext): Value {
    if (op === '&&') return truthy(this.evalScalar(l, ctx)) && truthy(this.evalScalar(r, ctx));
    if (op === '||') return truthy(this.evalScalar(l, ctx)) || truthy(this.evalScalar(r, ctx));
    if (op === 'IN') {
      const a = this.evalScalar(l, ctx);
      const t = this.evalTableValue(this.eval(r, ctx));
      const tuples = this.tableTuples(t);
      return tuples.some((tu) => valueKey(tu[0]) === valueKey(a));
    }
    const a = this.evalScalar(l, ctx);
    const b = this.evalScalar(r, ctx);
    switch (op) {
      case '+':
      case '-': {
        if (a === null && b === null) return null;
        if (a instanceof Date && !(b instanceof Date)) {
          const n = (op === '+' ? 1 : -1) * num(b);
          // whole days use calendar arithmetic so DST never shifts the time of day
          if (Number.isInteger(n)) return new Date(a.getFullYear(), a.getMonth(), a.getDate() + n, a.getHours(), a.getMinutes(), a.getSeconds(), a.getMilliseconds());
          return new Date(a.getTime() + n * MS_DAY);
        }
        if (a instanceof Date && b instanceof Date && op === '-') return (a.getTime() - b.getTime()) / MS_DAY;
        return op === '+' ? num(a) + num(b) : num(a) - num(b);
      }
      case '*':
        return a === null || b === null ? null : num(a) * num(b);
      case '/':
        if (a === null && b === null) return null;
        if (num(b) === 0) return num(a) === 0 ? NaN : num(a) > 0 ? Infinity : -Infinity;
        return num(a) / num(b);
      case '^':
        return a === null ? null : Math.pow(num(a), num(b));
      case '&':
        return `${this.text(a)}${this.text(b)}`;
      case '==':
        return a === null || b === null ? a === b : compareValues(a, b) === 0;
      case '=':
      case '<>':
      case '<':
      case '>':
      case '<=':
      case '>=': {
        const x = blankAs(a, b);
        const y = blankAs(b, a);
        let c: number;
        if (typeof x === 'string' || typeof y === 'string') c = String(this.text(x)).localeCompare(String(this.text(y)), undefined, { sensitivity: 'accent' });
        else c = compareValues(x, y);
        if (op === '=') return c === 0;
        if (op === '<>') return c !== 0;
        if (op === '<') return c < 0;
        if (op === '>') return c > 0;
        if (op === '<=') return c <= 0;
        return c >= 0;
      }
    }
    throw new DaxError(`Unknown operator ${op}`);
  }

  private text(v: CellValue): string {
    if (v === null) return '';
    if (v instanceof Date) return formatValue(v, 'yyyy-MM-dd');
    return String(v);
  }

  // ------------------------------------------------------------ references

  private columnValue(col: ColumnRef, ctx: EvalContext): CellValue {
    this.model.resolveColumn(col);
    const rows = ctx.rows ?? [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const b = rows[i];
      if (b.kind === 'row') {
        if (b.table === col.table) return this.model.table(b.table).value(col.column, b.row);
      } else {
        const k = b.columns.findIndex((c) => c.table === col.table && c.column === col.column);
        if (k >= 0) return b.values[k];
      }
    }
    // lenient RELATED: row context on a many-side table can read its related one-side columns
    for (let i = rows.length - 1; i >= 0; i--) {
      const b = rows[i];
      if (b.kind === 'row' && this.model.expanded(b.table).has(col.table)) return this.model.relatedValue(b.table, b.row, col);
    }
    throw new DaxError(
      `A single value for column '${col.table}'[${col.column}] cannot be determined. Use an aggregation (SUM, MAX, SELECTEDVALUE...) or an iterator.`,
    );
  }

  private unqualifiedColumn(name: string, ctx: EvalContext): CellValue {
    const rows = ctx.rows ?? [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const b = rows[i];
      if (b.kind === 'row' && this.model.table(b.table).hasColumn(name)) return this.model.table(b.table).value(name, b.row);
      if (b.kind === 'tuple') {
        const k = b.columns.findIndex((c) => c.column === name);
        if (k >= 0) return b.values[k];
      }
    }
    throw new DaxError(`Measure or column [${name}] not found`);
  }

  private callMeasure(name: string, ctx: EvalContext): CellValue {
    const m = this.model.measure(name);
    const filters = this.transition(ctx);
    const calc = this.activeCalcItem(filters);
    if (calc) {
      const ckey = `${name}@${calc.table}:${calc.item.name}::${contextKey(filters)}`;
      const chit = this.measureCache.get(ckey);
      if (chit !== undefined || this.measureCache.has(ckey)) return chit ?? null;
      const v = this.evalScalar(calc.item.ast, { filters: calc.inner, selectedMeasure: name });
      this.measureCache.set(ckey, v);
      return v;
    }
    const key = `${name}::${contextKey(filters)}`;
    const hit = this.measureCache.get(key);
    if (hit !== undefined || this.measureCache.has(key)) return hit ?? null;
    if (this.stack.includes(name)) throw new DaxError(`Circular dependency detected: ${[...this.stack, name].join(' → ')}`);
    this.stack.push(name);
    try {
      const v = this.evalScalar(m.ast, { filters });
      if (this.measureCache.size > 50_000) this.measureCache.clear();
      this.measureCache.set(key, v);
      return v;
    } finally {
      this.stack.pop();
    }
  }

  /** The calculation item selected (exactly one) for the highest-precedence active calculation group. */
  private activeCalcItem(filters: readonly Filter[]): { table: string; item: { name: string; ast: Expr; format?: string; formatAst?: Expr }; inner: Filter[] } | null {
    const groups = this.model.calculationGroups();
    if (!groups.length) return null;
    for (const g of groups) {
      const touches = (f: Filter) => (f.kind === 'rows' ? f.table === g.table : f.kind === 'columns' && f.columns.some((c) => c.table === g.table));
      if (!filters.some(touches)) continue;
      const vals = this.model.valuesOf({ table: g.table, column: g.column }, filters);
      if (vals.length !== 1) continue;
      const item = g.items.get(String(vals[0]));
      if (!item) continue;
      // evaluate the item without this group's filter so it is applied once
      return { table: g.table, item, inner: filters.filter((f) => !touches(f)) };
    }
    return null;
  }

  /**
   * The format a measure's value takes in a filter context: the active calculation item's format (static or
   * dynamic), or undefined to keep the measure's own format.
   */
  measureFormat(measure: string, filters: readonly Filter[]): string | undefined {
    const active = this.activeCalcItem(filters);
    if (!active) return undefined;
    if (active.item.formatAst) {
      const v = this.evalScalar(active.item.formatAst, { filters: active.inner, selectedMeasure: measure });
      return v === null || v === '' ? undefined : String(v);
    }
    return active.item.format;
  }

  /** Context transition: row context becomes equivalent filter context. */
  private transition(ctx: EvalContext): Filter[] {
    let filters = [...ctx.filters];
    for (const b of ctx.rows ?? []) {
      if (b.kind === 'row') filters = overrideFilters(filters, [rowsFilter(b.table, [b.row])]);
      else {
        const real = b.columns.map((c, i) => ({ c, v: b.values[i] })).filter((x) => x.c.table && this.model.hasTable(x.c.table) && this.model.table(x.c.table).hasColumn(x.c.column));
        filters = overrideFilters(filters, real.map((x) => compileFilter({ target: x.c, op: 'eq', value: x.v })));
      }
    }
    return filters;
  }

  // ------------------------------------------------------------ tables

  private evalTableValue(v: Value): TableValue {
    if (!isTable(v)) return { kind: 'tuples', columns: [{ table: '', column: 'Value' }], tuples: [[v]] };
    return v;
  }

  private evalTable(e: Expr, ctx: EvalContext): TableValue {
    if (e.type === 'table') {
      if (!this.model.hasTable(e.name)) throw new DaxError(`Table '${e.name}' not found`);
      // a table reference sees the filter context; an outer row context does not transition
      return { kind: 'rows', table: e.name, rows: this.model.rowsOf(e.name, ctx.filters) };
    }
    if (e.type === 'column') {
      const col = this.model.resolveColumn({ table: e.table, column: e.column });
      return { kind: 'tuples', columns: [col], tuples: this.model.valuesOf(col, ctx.filters).map((v) => [v]) };
    }
    const v = this.eval(e, ctx);
    if (!isTable(v)) throw new DaxError('A table expression was expected');
    return v;
  }

  /**
   * DAX window functions: OFFSET(delta, …), INDEX(position, …), WINDOW(from, ABS|REL, to, ABS|REL, …), and the
   * scalars RANK([DENSE|SKIP], …) and ROWNUMBER(…), each taking an optional relation, ORDERBY and PARTITIONBY.
   * Without a relation, the ALLSELECTED values of the ORDERBY / PARTITIONBY columns are used.
   */
  private windowFunction(name: string, args: Expr[], ctx: EvalContext): Value {
    const isCall = (e: Expr | undefined, n: string): e is Extract<Expr, { type: 'call' }> => e?.type === 'call' && e.name === n;
    const word = (e: Expr | undefined) => (e?.type === 'table' ? e.name.toUpperCase() : undefined);
    const orderBy = args.find((a) => isCall(a, 'ORDERBY')) as Extract<Expr, { type: 'call' }> | undefined;
    const partitionBy = args.find((a) => isCall(a, 'PARTITIONBY')) as Extract<Expr, { type: 'call' }> | undefined;
    // leading positional arguments per function, then an optional relation
    const lead = name === 'WINDOW' ? 4 : name === 'OFFSET' || name === 'INDEX' ? 1 : name === 'RANK' && ['DENSE', 'SKIP'].includes(word(args[0]) ?? '') ? 1 : 0;
    const rest = args.slice(lead).filter((a) => !isCall(a, 'ORDERBY') && !isCall(a, 'PARTITIONBY') && !isCall(a, 'MATCHBY') && !['KEEP', 'FIRST', 'LAST', 'DEFAULT'].includes(word(a) ?? ''));
    const relExpr = rest[0];

    // ORDERBY(expr, [ASC|DESC], expr, …)
    const orders: { expr: Expr; desc: boolean }[] = [];
    const oargs = orderBy?.args ?? [];
    for (let i = 0; i < oargs.length; i++) {
      const dir = word(oargs[i + 1]);
      orders.push({ expr: oargs[i], desc: dir === 'DESC' });
      if (dir === 'ASC' || dir === 'DESC') i++;
    }
    const partCols = (partitionBy?.args ?? []).map((a) => this.colArg(a, 'PARTITIONBY'));

    // the relation as tuples with known columns
    let rel: TuplesTable;
    if (relExpr) {
      const t = this.evalTable(relExpr, ctx);
      rel = t.kind === 'tuples' ? t : { kind: 'tuples', columns: [...this.model.table(t.table).columns.keys()].map((c) => ({ table: t.table, column: c })), tuples: this.tableTuples(t) };
    } else {
      const cols = [...orders.filter((o) => o.expr.type === 'column').map((o) => this.colArg(o.expr, 'ORDERBY')), ...partCols];
      if (!cols.length) throw new DaxError(`${name} needs a relation or ORDERBY columns`);
      const unique = cols.filter((c, i) => cols.findIndex((d) => d.table === c.table && d.column === c.column) === i);
      const filters = this.removeFilters([...this.transition(ctx)], { mod: 'allSelected' });
      rel = unique.length === 1 ? { kind: 'tuples', columns: unique, tuples: this.model.valuesOf(unique[0], filters).map((v) => [v]) } : this.distinctTuples(unique, filters);
    }
    if (!orders.length) for (const c of rel.columns) orders.push({ expr: { type: 'column', table: c.table, column: c.column }, desc: false });
    const colIndex = (c: ColumnRef) => rel.columns.findIndex((d) => d.table === c.table && d.column === c.column);

    // the current row: each relation column's value from the row context, else a single value in the filter context
    const filters = this.transition(ctx);
    const current = rel.columns.map((c): { known: boolean; value: CellValue } => {
      for (let i = (ctx.rows?.length ?? 0) - 1; i >= 0; i--) {
        const b = ctx.rows![i];
        if (b.kind === 'tuple') {
          const k = b.columns.findIndex((d) => d.table === c.table && d.column === c.column);
          if (k >= 0) return { known: true, value: b.values[k] };
        } else if (b.table === c.table) return { known: true, value: this.model.table(c.table).value(c.column, b.row) };
      }
      const vals = this.model.valuesOf(c, filters);
      return vals.length === 1 ? { known: true, value: vals[0] } : { known: false, value: null };
    });
    const same = (tu: CellValue[], idx: number[]) => idx.every((i) => valueKey(tu[i]) === valueKey(current[i].value));
    const pIdx = partCols.map(colIndex);
    if (pIdx.some((i) => i < 0)) throw new DaxError('PARTITIONBY columns must be part of the relation');
    if (pIdx.some((i) => !current[i].known)) return name === 'RANK' || name === 'ROWNUMBER' ? null : { ...rel, tuples: [] };

    // sort the current partition
    const part = rel.tuples.filter((tu) => same(tu, pIdx));
    const partTable: TuplesTable = { ...rel, tuples: part };
    const keys = orders.map((o) => this.iterate(partTable, o.expr, ctx));
    const order = part.map((_, i) => i).sort((a, b) => {
      for (let k = 0; k < orders.length; k++) {
        const c = compareValues(keys[k][a], keys[k][b]);
        if (c) return orders[k].desc ? -c : c;
      }
      return 0;
    });
    const sorted = order.map((i) => part[i]);
    const known = rel.columns.map((_, i) => i).filter((i) => current[i].known);
    const pos = sorted.findIndex((tu) => same(tu, known));
    const empty = (): TuplesTable => ({ ...rel, tuples: [] });

    switch (name) {
      case 'OFFSET': {
        if (pos < 0) return empty();
        const t = sorted[pos + Math.trunc(num(this.evalScalar(args[0], ctx)))];
        return { ...rel, tuples: t ? [t] : [] };
      }
      case 'INDEX': {
        const n = Math.trunc(num(this.evalScalar(args[0], ctx)));
        const t = n > 0 ? sorted[n - 1] : n < 0 ? sorted[sorted.length + n] : undefined;
        return { ...rel, tuples: t ? [t] : [] };
      }
      case 'WINDOW': {
        const at = (vi: number, ti: number) => {
          const v = Math.trunc(num(this.evalScalar(args[vi], ctx)));
          if (word(args[ti]) === 'ABS') return v > 0 ? v - 1 : sorted.length + v;
          return pos + v;
        };
        if (pos < 0 && (word(args[1]) !== 'ABS' || word(args[3]) !== 'ABS')) return empty();
        const from = Math.max(0, at(0, 1));
        const to = Math.min(sorted.length - 1, at(2, 3));
        return { ...rel, tuples: from <= to ? sorted.slice(from, to + 1) : [] };
      }
      case 'ROWNUMBER':
        return pos < 0 ? null : pos + 1;
      case 'RANK': {
        if (pos < 0) return null;
        // ties share a rank: SKIP (default) is competition ranking (1, 2, 2, 4), DENSE has no gaps (1, 2, 2, 3)
        const keyOf = (i: number) => JSON.stringify(orders.map((_, k) => valueKey(keys[k][order[i]])));
        const mine = keyOf(pos);
        if (word(args[0]) !== 'DENSE') return sorted.findIndex((_, i) => keyOf(i) === mine) + 1;
        const seen = new Set<string>();
        for (let i = 0; i < sorted.length; i++) {
          seen.add(keyOf(i));
          if (keyOf(i) === mine) return seen.size;
        }
        return null;
      }
    }
    return null;
  }

  private listToTable(e: Extract<Expr, { type: 'list' }>, ctx: EvalContext): TuplesTable {
    return { kind: 'tuples', columns: [{ table: '', column: 'Value' }], tuples: e.items.map((i) => [this.evalScalar(i, ctx)]) };
  }

  private tableToScalar(t: TableValue): CellValue {
    const n = t.kind === 'rows' ? t.rows.length : t.tuples.length;
    if (n === 0) return null;
    if (n === 1 && t.kind === 'tuples' && t.columns.length === 1) return t.tuples[0][0];
    throw new DaxError('A table of multiple values was supplied where a single value was expected');
  }

  private tableTuples(t: TableValue): CellValue[][] {
    if (t.kind === 'tuples') return t.tuples;
    const tbl = this.model.table(t.table);
    const cols = [...tbl.columns.keys()];
    return t.rows.map((r) => cols.map((c) => tbl.value(c, r)));
  }

  private tableSize(t: TableValue): number {
    return t.kind === 'rows' ? t.rows.length : t.tuples.length;
  }

  private bindings(t: TableValue): RowBinding[] {
    if (t.kind === 'rows') return t.rows.map((row) => ({ kind: 'row', table: t.table, row }));
    return t.tuples.map((values) => ({ kind: 'tuple', columns: t.columns, values }));
  }

  /** Iterate `t`, evaluating `expr` in a row context for each row. */
  private iterate(t: TableValue, expr: Expr, ctx: EvalContext): CellValue[] {
    const f = t.kind === 'rows' ? this.rowFn(t.table, expr, ctx) : null;
    if (f && t.kind === 'rows') {
      const rows = t.rows;
      const out: CellValue[] = new Array(rows.length);
      for (let i = 0; i < rows.length; i++) out[i] = f(rows[i]);
      return out;
    }
    const out: CellValue[] = [];
    for (const b of this.bindings(t)) out.push(this.evalScalar(expr, { ...ctx, rows: [...(ctx.rows ?? []), b] }));
    return out;
  }

  /** `expr` compiled for a row context on `table`, or null when it needs the interpreter (or fast paths are off). */
  private rowFn(table: string, expr: Expr, ctx: EvalContext): RowFn | null {
    if (!fastPathsEnabled()) return null;
    const lenient = !ctx.rows?.length;
    let byTable = this.rowPlans.get(expr);
    if (!byTable) this.rowPlans.set(expr, (byTable = new Map()));
    const key = lenient ? `${table}|lenient` : table;
    let plan = byTable.get(key);
    if (plan === undefined) byTable.set(key, (plan = this.model.hasTable(table) ? compileRowExpr(this.model, table, expr, lenient) : null));
    return plan ? plan.bind() : null;
  }

  /** SUMX / AVERAGEX: compiled row expressions are summed in place, without materialising the values. */
  private sumX(name: 'SUMX' | 'AVERAGEX', args: Expr[], ctx: EvalContext): CellValue {
    const t = this.evalTable(args[0], ctx);
    const f = t.kind === 'rows' ? this.rowFn(t.table, args[1], ctx) : null;
    let sum = 0;
    let n = 0;
    if (f && t.kind === 'rows') {
      const rows = t.rows;
      for (let i = 0; i < rows.length; i++) {
        const v = f(rows[i]);
        if (v !== null) {
          sum += v;
          n++;
        }
      }
    } else {
      for (const v of this.iterate(t, args[1], ctx)) {
        if (v === null || v === '') continue;
        sum += num(v);
        n++;
      }
    }
    if (!n) return null;
    return name === 'SUMX' ? sum : sum / n;
  }

  private colArg(e: Expr | undefined, fn: string): ColumnRef {
    if (!e || e.type !== 'column') throw new DaxError(`${fn} expects a column reference like Table[Column]`);
    return this.model.resolveColumn({ table: e.table, column: e.column });
  }

  private columnValues(col: ColumnRef, ctx: EvalContext): CellValue[] {
    const rows = this.model.rowsOf(col.table, this.transitionIfNeeded(ctx));
    const vals = this.model.table(col.table).column(col.column).values;
    return rows.map((i) => vals[i]);
  }

  /** Aggregations ignore row context, except inside CALCULATE (handled by transition). */
  private transitionIfNeeded(ctx: EvalContext): readonly Filter[] {
    return ctx.filters;
  }

  // ------------------------------------------------------------ CALCULATE

  private applyModifiers(base: Filter[], args: Expr[], ctx: EvalContext): Filter[] {
    let filters = this.transition({ filters: base, rows: ctx.rows });
    const keep: Filter[] = [];
    const removals: Modifier[] = [];
    const adds: Filter[] = [];
    for (const a of args) {
      const r = this.filterArg(a, ctx);
      if ('mod' in r) {
        if (r.mod === 'keep') keep.push(...r.filters);
        else removals.push(r);
      } else adds.push(...r.filters);
      if ('clearTable' in r && r.clearTable) removals.push({ mod: 'removeTable', table: r.clearTable });
    }
    for (const m of removals) filters = this.removeFilters(filters, m);
    filters = overrideFilters(filters, adds);
    return [...filters, ...keep];
  }

  private removeFilters(filters: Filter[], m: Modifier): Filter[] {
    switch (m.mod) {
      case 'removeTable': {
        if (m.table === '*') return [];
        // removing filters from a table removes them from its expanded table too
        const exp = this.model.expanded(m.table);
        return filters.filter((f) => f.kind === 'rel' || !(f.kind === 'rows' ? exp.has(f.table) : f.columns.every((c) => exp.has(c.table))));
      }
      case 'removeColumns':
        return filters.filter((f) => f.kind !== 'columns' || !f.columns.some((c) => m.columns.some((d) => d.table === c.table && d.column === c.column)));
      case 'allExcept': {
        const exp = this.model.expanded(m.table);
        return filters.filter((f) => {
          if (f.kind === 'rel') return true;
          if (f.kind === 'rows') return !exp.has(f.table);
          if (!f.columns.every((c) => exp.has(c.table))) return true;
          return f.columns.every((c) => m.keep.some((k) => k.table === c.table && k.column === c.column));
        });
      }
      case 'allSelected':
        return filters.filter((f) => {
          if (f.kind !== 'columns' || f.origin !== 'group') return true;
          if (!m.tables && !m.columns) return false;
          if (m.tables && f.columns.every((c) => m.tables!.some((t) => this.model.expanded(t).has(c.table)))) return false;
          if (m.columns && f.columns.some((c) => m.columns!.some((d) => d.table === c.table && d.column === c.column))) return false;
          return true;
        });
      default:
        return filters;
    }
  }

  /** Interpret a CALCULATE filter argument. */
  private filterArg(a: Expr, ctx: EvalContext): Modifier | { filters: Filter[]; clearTable?: string } {
    if (a.type === 'call') {
      switch (a.name) {
        case 'ALL':
        case 'ALLNOBLANKROW':
        case 'REMOVEFILTERS':
          if (a.args.length === 0) return { mod: 'removeTable', table: '*' } as never;
          if (a.args[0].type === 'table') return { mod: 'removeTable', table: a.args[0].name };
          return { mod: 'removeColumns', columns: a.args.map((x) => this.colArg(x, a.name)) };
        case 'ALLEXCEPT': {
          const t = a.args[0];
          if (t?.type !== 'table') throw new DaxError('ALLEXCEPT expects a table as first argument');
          return { mod: 'allExcept', table: t.name, keep: a.args.slice(1).map((x) => this.colArg(x, 'ALLEXCEPT')) };
        }
        case 'ALLSELECTED':
          if (a.args.length === 0) return { mod: 'allSelected' };
          if (a.args[0].type === 'table') return { mod: 'allSelected', tables: [a.args[0].name] };
          return { mod: 'allSelected', columns: a.args.map((x) => this.colArg(x, 'ALLSELECTED')) };
        case 'KEEPFILTERS': {
          const inner = this.filterArg(a.args[0], ctx);
          if ('mod' in inner) return inner;
          return { mod: 'keep', filters: inner.filters };
        }
        case 'USERELATIONSHIP':
        case 'CROSSFILTER': {
          const a1 = this.colArg(a.args[0], a.name);
          const a2 = this.colArg(a.args[1], a.name);
          const rel = this.model.findRelationship(a1, a2);
          if (!rel) throw new DaxError(`${a.name}: no relationship between '${a1.table}'[${a1.column}] and '${a2.table}'[${a2.column}]`);
          if (a.name === 'USERELATIONSHIP') return { filters: [relFilter(rel.index, 'activate')] };
          const dir = this.intervalArg(a.args[2]);
          const mode = dir === 'BOTH' ? 'both' : dir === 'NONE' ? 'none' : 'oneway';
          return { filters: [relFilter(rel.index, mode)] };
        }
      }
    }
    if (a.type === 'binary' || (a.type === 'unary' && a.op === 'NOT') || (a.type === 'call' && ['NOT', 'AND', 'OR', 'CONTAINSSTRING', 'ISBLANK'].includes(a.name))) {
      return { filters: [this.booleanFilter(a, ctx)] };
    }
    const t = this.evalTable(a, ctx);
    return { filters: [this.tableAsFilter(t)], clearTable: t.kind === 'tuples' ? t.clearTable : undefined };
  }

  private tableAsFilter(t: TableValue): Filter {
    if (t.kind === 'rows') return rowsFilter(t.table, t.rows);
    if (t.columns.some((c) => !c.table)) throw new DaxError('Table filter must be based on model columns');
    if (t.columns.length === 1) return compileFilter({ target: t.columns[0], op: 'in', values: t.tuples.map((x) => x[0]) });
    return compileFilter({ targets: t.columns, op: 'tuples', tuples: t.tuples });
  }

  /** `Products[Color] = "Red"` → FILTER(ALL(Products[Color]), ...) → `in` filter. */
  private booleanFilter(a: Expr, ctx: EvalContext): ColumnsFilter {
    const cols = this.freeColumns(a);
    if (cols.length === 0) throw new DaxError('A boolean filter expression must reference a column');
    const table = cols[0].table;
    if (cols.some((c) => c.table !== table)) throw new DaxError('A boolean filter expression can only reference columns from a single table');
    const t = this.model.table(table);
    let tuples: CellValue[][];
    if (cols.length === 1) tuples = t.distinct(cols[0].column).map((v) => [v]);
    else {
      const seen = new Map<string, CellValue[]>();
      for (let i = 0; i < t.rowCount; i++) {
        const tu = cols.map((c) => t.value(c.column, i));
        seen.set(JSON.stringify(tu.map(valueKey)), tu);
      }
      tuples = [...seen.values()];
    }
    const keep = tuples.filter((tu) => truthy(this.evalScalar(a, { ...ctx, rows: [...(ctx.rows ?? []), { kind: 'tuple', columns: cols, values: tu }] })));
    if (cols.length === 1) return compileFilter({ target: cols[0], op: 'in', values: keep.map((x) => x[0]) });
    return compileFilter({ targets: cols, op: 'tuples', tuples: keep });
  }

  private freeColumns(e: Expr, out: ColumnRef[] = []): ColumnRef[] {
    const add = (c: ColumnRef) => {
      if (!out.some((o) => o.table === c.table && o.column === c.column)) out.push(c);
    };
    switch (e.type) {
      case 'column':
        add(this.model.resolveColumn({ table: e.table, column: e.column }));
        break;
      case 'binary':
        this.freeColumns(e.left, out);
        this.freeColumns(e.right, out);
        break;
      case 'unary':
        this.freeColumns(e.operand, out);
        break;
      case 'list':
        e.items.forEach((i) => this.freeColumns(i, out));
        break;
      case 'call':
        if (!CONTEXT_FUNCS.has(e.name)) e.args.forEach((x) => this.freeColumns(x, out));
        break;
      case 'var':
        e.bindings.forEach((b) => this.freeColumns(b.value, out));
        this.freeColumns(e.body, out);
        break;
    }
    return out;
  }

  // ------------------------------------------------------------ time intelligence

  private dateColumnValues(e: Expr, ctx: EvalContext): { col: ColumnRef; visible: Date[]; all: Date[] } {
    const col = this.colArg(e, 'Time intelligence');
    const visible = this.model.valuesOf(col, this.transition(ctx)).filter((d): d is Date => d instanceof Date);
    const all = this.model.table(col.table).distinct(col.column).filter((d): d is Date => d instanceof Date);
    return { col, visible, all };
  }

  private datesTable(col: ColumnRef, dates: Date[]): TuplesTable {
    return { kind: 'tuples', columns: [col], tuples: dates.map((d) => [d]), clearTable: col.table };
  }

  private periodToDate(args: Expr[], ctx: EvalContext, period: 'year' | 'quarter' | 'month', yearEnd?: string): TuplesTable {
    const { col, visible, all } = this.dateColumnValues(args[0], ctx);
    if (visible.length === 0) return this.datesTable(col, []);
    const last = visible.reduce((a, b) => (a > b ? a : b));
    let start: Date;
    if (period === 'year') {
      if (yearEnd) {
        const [mm, dd] = yearEnd.split(/[-/]/).map(Number);
        const fyEnd = new Date(last.getFullYear(), mm - 1, dd);
        start = last > fyEnd ? new Date(fyEnd.getTime() + MS_DAY) : new Date(new Date(last.getFullYear() - 1, mm - 1, dd).getTime() + MS_DAY);
      } else start = new Date(last.getFullYear(), 0, 1);
    } else if (period === 'quarter') start = new Date(last.getFullYear(), Math.floor(last.getMonth() / 3) * 3, 1);
    else start = new Date(last.getFullYear(), last.getMonth(), 1);
    return this.datesTable(col, all.filter((d) => d >= start && d <= last));
  }

  private shiftDates(args: Expr[], ctx: EvalContext, n: number, interval: string): TuplesTable {
    const { col, visible, all } = this.dateColumnValues(args[0], ctx);
    const unit = interval.toUpperCase();
    const shift = (d: Date): Date => {
      if (unit === 'DAY') return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
      if (unit === 'MONTH') return addMonths(d, n);
      if (unit === 'QUARTER') return addMonths(d, n * 3);
      if (unit === 'YEAR') return addMonths(d, n * 12);
      throw new DaxError(`Unknown interval ${interval}`);
    };
    const existing = new Set(all.map((d) => d.getTime()));
    const shifted = new Map<number, Date>();
    const lastDay = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    for (const d of visible) {
      const s = shift(d);
      if (existing.has(s.getTime())) shifted.set(s.getTime(), s);
      // as in DAX: a month's last day maps to the rest of the target month too (Feb 28, 2025 → Feb 28 and 29, 2024)
      if (unit !== 'DAY' && d.getDate() === lastDay(d))
        for (let day = s.getDate() + 1; day <= lastDay(s); day++) {
          const x = new Date(s.getFullYear(), s.getMonth(), day);
          if (existing.has(x.getTime())) shifted.set(x.getTime(), x);
        }
    }
    return this.datesTable(col, [...shifted.values()].sort((a, b) => a.getTime() - b.getTime()));
  }

  private intervalArg(e: Expr | undefined): string {
    if (!e) throw new DaxError('Interval expected (DAY, MONTH, QUARTER, YEAR)');
    if (e.type === 'table' || e.type === 'varRef') return e.name.toUpperCase();
    if (e.type === 'string') return e.value.toUpperCase();
    throw new DaxError('Interval expected (DAY, MONTH, QUARTER, YEAR)');
  }

  // ------------------------------------------------------------ functions

  /** Tight typed-array loops for the common column aggregations (same BLANK semantics as the general path). */
  private fastAgg(name: string, arg: Expr, ctx: EvalContext): CellValue | typeof UNHANDLED {
    if (arg.type !== 'column') return UNHANDLED;
    const col = this.colArg(arg, name);
    const t = this.model.table(col.table);
    const c = t.column(col.column);
    if (name !== 'DISTINCTCOUNT' && fastPathsEnabled()) {
      const numericOk = name === 'COUNT' || name === 'COUNTA' || c.type === 'number' || ((name === 'MIN' || name === 'MAX') && c.type === 'date');
      const v = numericOk ? this.partials.evaluate(name as PartialKind, col.table, col.column, ctx.filters) : undefined;
      if (v !== undefined) return v;
    }
    const rows = this.model.rowsOf(col.table, ctx.filters);
    switch (name) {
      case 'SUM':
      case 'AVERAGE': {
        if (c.type !== 'number') return UNHANDLED;
        const a = t.numeric(col.column);
        let sum = 0;
        let n = 0;
        for (let i = 0; i < rows.length; i++) {
          const v = a[rows[i]];
          if (v === v) {
            sum += v;
            n++;
          }
        }
        return n ? (name === 'SUM' ? sum : sum / n) : null;
      }
      case 'MIN':
      case 'MAX': {
        if (c.type !== 'number' && c.type !== 'date') return UNHANDLED;
        const a = t.numeric(col.column);
        let best = NaN;
        const min = name === 'MIN';
        for (let i = 0; i < rows.length; i++) {
          const v = a[rows[i]];
          if (v === v && (best !== best || (min ? v < best : v > best))) best = v;
        }
        if (best !== best) return null;
        return c.type === 'date' ? new Date(best) : best;
      }
      case 'COUNT':
      case 'COUNTA': {
        const vals = c.values;
        let n = 0;
        for (let i = 0; i < rows.length; i++) {
          const v = vals[rows[i]];
          if (v !== null && v !== '') n++;
        }
        return n || null;
      }
      case 'DISTINCTCOUNT': {
        const { codes, dict } = t.codes(col.column);
        const seen = new Uint8Array(dict.length + 1);
        let n = 0;
        for (let i = 0; i < rows.length; i++) {
          const k = codes[rows[i]] + 1;
          if (!seen[k]) {
            seen[k] = 1;
            n++;
          }
        }
        return n || null;
      }
    }
    return UNHANDLED;
  }

  private call(name: string, args: Expr[], ctx: EvalContext): Value {
    if (args.length === 1 && FAST_AGGS.has(name)) {
      const r = this.fastAgg(name, args[0], ctx);
      if (r !== UNHANDLED) return r;
    }
    const s = (i: number) => this.evalScalar(args[i], ctx);
    const opt = (i: number, d: CellValue = null) => (args[i] ? s(i) : d);
    const agg = (fn: (vals: CellValue[]) => CellValue): CellValue => fn(this.columnValues(this.colArg(args[0], name), ctx));
    const iter = (fn: (vals: CellValue[]) => CellValue): CellValue => fn(this.iterate(this.evalTable(args[0], ctx), args[1], ctx));
    const nums = (vals: CellValue[]) => vals.filter((v) => v !== null && v !== '').map(num);

    switch (name) {
      // ---- aggregations
      case 'SUM':
        return agg((v) => {
          const n = nums(v);
          return n.length ? n.reduce((a, b) => a + b, 0) : null;
        });
      case 'AVERAGE':
        return agg((v) => {
          const n = nums(v);
          return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null;
        });
      case 'MIN':
      case 'MAX': {
        if (args.length === 2) {
          const a = s(0);
          const b = s(1);
          if (a === null) return b;
          if (b === null) return a;
          return (compareValues(a, b) < 0) === (name === 'MIN') ? a : b;
        }
        return agg((v) => this.extreme(v, name === 'MIN'));
      }
      case 'MEDIAN':
        return agg((v) => median(nums(v)));
      case 'COUNT':
      case 'COUNTA':
        return agg((v) => v.filter((x) => x !== null && x !== '').length || null);
      case 'COUNTBLANK':
        return agg((v) => v.filter((x) => x === null || x === '').length || null);
      case 'DISTINCTCOUNT':
        return agg((v) => new Set(v.map(valueKey)).size || null);
      case 'DISTINCTCOUNTNOBLANK':
        return agg((v) => new Set(v.filter((x) => x !== null).map(valueKey)).size || null);
      case 'COUNTROWS': {
        const t = args.length ? this.evalTable(args[0], ctx) : null;
        if (!t) throw new DaxError('COUNTROWS expects a table');
        return this.tableSize(t) || null;
      }
      case 'PRODUCT':
        return agg((v) => {
          const n = nums(v);
          return n.length ? n.reduce((a, b) => a * b, 1) : null;
        });

      // ---- iterators
      case 'SUMX':
      case 'AVERAGEX':
        return this.sumX(name, args, ctx);
      case 'MINX':
        return iter((v) => this.extreme(v, true));
      case 'MAXX':
        return iter((v) => this.extreme(v, false));
      case 'MEDIANX':
        return iter((v) => median(nums(v)));
      case 'PRODUCTX':
        return iter((v) => {
          const n = nums(v);
          return n.length ? n.reduce((a, b) => a * b, 1) : null;
        });
      case 'COUNTX':
      case 'COUNTAX':
        return iter((v) => v.filter((x) => x !== null).length || null);
      case 'CONCATENATEX': {
        const t = this.evalTable(args[0], ctx);
        const vals = this.iterate(t, args[1], ctx);
        const delim = args[2] ? this.text(s(2)) : '';
        if (args[3]) {
          const order = this.iterate(t, args[3], ctx);
          const desc = args[4] && args[4].type === 'table' && args[4].name.toUpperCase() === 'DESC';
          const idx = vals.map((_, i) => i).sort((a, b) => compareValues(order[a], order[b]) * (desc ? -1 : 1));
          return idx.map((i) => this.text(vals[i])).join(delim);
        }
        return vals.map((v) => this.text(v)).join(delim);
      }
      case 'RANKX': {
        const t = this.evalTable(args[0], ctx);
        const all = this.iterate(t, args[1], ctx).filter((v) => v !== null);
        const value = args[2] ? s(2) : this.evalScalar(args[1], ctx);
        if (value === null) return null;
        const asc = args[3] && ((args[3].type === 'table' && args[3].name.toUpperCase() === 'ASC') || (args[3].type === 'number' && args[3].value === 1));
        const dense = args[4] && args[4].type === 'table' && args[4].name.toUpperCase() === 'DENSE';
        const cmp = (x: CellValue) => (asc ? compareValues(x, value) < 0 : compareValues(x, value) > 0);
        if (dense) return new Set(all.filter(cmp).map(valueKey)).size + 1;
        return all.filter(cmp).length + 1;
      }

      // ---- filter & context
      case 'CALCULATE': {
        if (!args.length) throw new DaxError('CALCULATE expects an expression');
        const filters = this.applyModifiers([...ctx.filters], args.slice(1), ctx);
        return this.evalScalar(args[0], { filters, vars: ctx.vars, selectedMeasure: ctx.selectedMeasure });
      }
      case 'CALCULATETABLE': {
        const filters = this.applyModifiers([...ctx.filters], args.slice(1), ctx);
        return this.evalTable(args[0], { filters, vars: ctx.vars, selectedMeasure: ctx.selectedMeasure });
      }
      case 'FILTER': {
        const t = this.evalTable(args[0], ctx);
        const keep = this.iterate(t, args[1], ctx).map(truthy);
        if (t.kind === 'rows') return { kind: 'rows', table: t.table, rows: t.rows.filter((_, i) => keep[i]) };
        return { ...t, tuples: t.tuples.filter((_, i) => keep[i]) };
      }
      case 'ALL':
      case 'ALLNOBLANKROW':
      case 'REMOVEFILTERS':
      case 'ALLSELECTED': {
        if (!args.length) throw new DaxError(`${name} without arguments is only valid as a CALCULATE filter`);
        let filters: readonly Filter[] = [];
        if (name === 'ALLSELECTED') filters = this.removeFilters([...this.transition(ctx)], { mod: 'allSelected' });
        if (args[0].type === 'table') return { kind: 'rows', table: args[0].name, rows: this.model.rowsOf(args[0].name, filters) };
        const cols = args.map((x) => this.colArg(x, name));
        if (cols.length === 1) return { kind: 'tuples', columns: cols, tuples: this.model.valuesOf(cols[0], filters).map((v) => [v]) };
        return this.distinctTuples(cols, filters);
      }
      case 'ALLEXCEPT': {
        const t = args[0];
        if (t?.type !== 'table') throw new DaxError('ALLEXCEPT expects a table');
        const filters = this.removeFilters(this.transition(ctx), { mod: 'allExcept', table: t.name, keep: args.slice(1).map((x) => this.colArg(x, name)) });
        return { kind: 'rows', table: t.name, rows: this.model.rowsOf(t.name, filters) };
      }
      case 'VALUES':
      case 'DISTINCT': {
        if (args[0]?.type === 'table') return this.evalTable(args[0], ctx);
        const col = this.colArg(args[0], name);
        return { kind: 'tuples', columns: [col], tuples: this.model.valuesOf(col, ctx.filters).map((v) => [v]) };
      }
      case 'OFFSET':
      case 'INDEX':
      case 'WINDOW':
      case 'RANK':
      case 'ROWNUMBER':
        return this.windowFunction(name, args, ctx);
      case 'ORDERBY':
      case 'PARTITIONBY':
      case 'MATCHBY':
        throw new DaxError(`${name} can only be used inside OFFSET, INDEX, WINDOW, RANK or ROWNUMBER`);
      case 'TOPN': {
        const n = num(s(0));
        const t = this.evalTable(args[1], ctx);
        const scores = this.iterate(t, args[2], ctx);
        const asc = args[3] && ((args[3].type === 'table' && args[3].name.toUpperCase() === 'ASC') || (args[3].type === 'number' && args[3].value === 1));
        const order = scores.map((_, i) => i).sort((a, b) => compareValues(scores[a], scores[b]) * (asc ? 1 : -1));
        let cut = Math.min(n, order.length);
        while (cut > 0 && cut < order.length && compareValues(scores[order[cut]], scores[order[cut - 1]]) === 0) cut++; // ties included
        const pick = new Set(order.slice(0, cut));
        if (t.kind === 'rows') return { kind: 'rows', table: t.table, rows: t.rows.filter((_, i) => pick.has(i)) };
        return { ...t, tuples: t.tuples.filter((_, i) => pick.has(i)) };
      }
      case 'SELECTEDVALUE': {
        const col = this.colArg(args[0], name);
        const vals = this.model.valuesOf(col, this.transition(ctx));
        return vals.length === 1 ? vals[0] : opt(1);
      }
      case 'HASONEVALUE':
        return this.model.valuesOf(this.colArg(args[0], name), this.transition(ctx)).length === 1;
      case 'ISFILTERED': {
        const filters = this.transition(ctx);
        if (args[0]?.type === 'table') {
          const tname = args[0].name;
          return filters.some((f) => (f.kind === 'rows' ? f.table === tname : f.kind === 'columns' && f.columns.some((c) => c.table === tname)));
        }
        const col = this.colArg(args[0], name);
        return filters.some((f) => f.kind === 'columns' && f.columns.some((c) => c.table === col.table && c.column === col.column));
      }
      case 'RELATED': {
        const col = this.colArg(args[0], name);
        const rows = ctx.rows ?? [];
        for (let i = rows.length - 1; i >= 0; i--) {
          const b = rows[i];
          if (b.kind === 'row' && this.model.expanded(b.table).has(col.table)) return this.model.relatedValue(b.table, b.row, col);
        }
        throw new DaxError(`RELATED(${col.table}[${col.column}]) needs a row context on a related table`);
      }
      case 'RELATEDTABLE': {
        const t = args[0];
        if (t?.type !== 'table') throw new DaxError('RELATEDTABLE expects a table');
        return { kind: 'rows', table: t.name, rows: this.model.rowsOf(t.name, this.transition(ctx)) };
      }
      case 'KEEPFILTERS':
        return this.eval(args[0], ctx);

      // ---- time intelligence
      case 'DATESYTD':
        return this.periodToDate(args, ctx, 'year', args[1] ? this.text(s(1)) : undefined);
      case 'DATESQTD':
        return this.periodToDate(args, ctx, 'quarter');
      case 'DATESMTD':
        return this.periodToDate(args, ctx, 'month');
      case 'TOTALYTD':
      case 'TOTALQTD':
      case 'TOTALMTD': {
        const period = name === 'TOTALYTD' ? 'year' : name === 'TOTALQTD' ? 'quarter' : 'month';
        const dates = this.periodToDate([args[1]], ctx, period, name === 'TOTALYTD' && args[3] ? this.text(s(3)) : undefined);
        let filters = this.removeFilters(this.transition(ctx), { mod: 'removeTable', table: dates.clearTable! });
        filters = overrideFilters(filters, [this.tableAsFilter(dates)]);
        if (args[2]) filters = this.applyModifiers(filters, [args[2]], { filters });
        return this.evalScalar(args[0], { filters, vars: ctx.vars, selectedMeasure: ctx.selectedMeasure });
      }
      case 'SAMEPERIODLASTYEAR':
        return this.shiftDates(args, ctx, -1, 'YEAR');
      case 'DATEADD':
        return this.shiftDates(args, ctx, num(s(1)), this.intervalArg(args[2]));
      case 'PARALLELPERIOD':
      case 'PREVIOUSMONTH':
      case 'PREVIOUSYEAR':
      case 'PREVIOUSQUARTER': {
        const { col, visible, all } = this.dateColumnValues(args[0], ctx);
        if (!visible.length) return this.datesTable(col, []);
        const unit = name === 'PARALLELPERIOD' ? this.intervalArg(args[2]) : name.replace('PREVIOUS', '');
        const n = name === 'PARALLELPERIOD' ? num(s(1)) : -1;
        const first = visible.reduce((a, b) => (a < b ? a : b));
        const months = unit === 'YEAR' ? 12 : unit === 'QUARTER' ? 3 : 1;
        const anchor = unit === 'YEAR' ? new Date(first.getFullYear(), 0, 1) : unit === 'QUARTER' ? new Date(first.getFullYear(), Math.floor(first.getMonth() / 3) * 3, 1) : new Date(first.getFullYear(), first.getMonth(), 1);
        const start = addMonths(anchor, n * months);
        const end = new Date(addMonths(start, months).getTime() - 1);
        return this.datesTable(col, all.filter((d) => d >= start && d <= end));
      }
      case 'DATESBETWEEN': {
        const col = this.colArg(args[0], name);
        const lo = s(1);
        const hi = s(2);
        const all = this.model.table(col.table).distinct(col.column).filter((d): d is Date => d instanceof Date);
        return this.datesTable(col, all.filter((d) => (lo === null || d >= (lo as Date)) && (hi === null || d <= (hi as Date))));
      }
      case 'FIRSTDATE':
      case 'LASTDATE': {
        const { col, visible } = this.dateColumnValues(args[0], ctx);
        if (!visible.length) return this.datesTable(col, []);
        const pick = visible.reduce((a, b) => ((name === 'FIRSTDATE' ? a < b : a > b) ? a : b));
        return this.datesTable(col, [pick]);
      }

      // ---- logical
      case 'IF': {
        const c = truthy(s(0));
        return c ? this.eval(args[1], ctx) : args[2] ? this.eval(args[2], ctx) : null;
      }
      case 'IFERROR':
        try {
          return this.evalScalar(args[0], ctx);
        } catch {
          return s(1);
        }
      case 'SWITCH': {
        const v = s(0);
        let i = 1;
        for (; i + 1 < args.length; i += 2) {
          const w = s(i);
          if (v === w || (v !== null && w !== null && compareValues(v, w) === 0)) return this.eval(args[i + 1], ctx);
        }
        return i < args.length ? this.eval(args[i], ctx) : null;
      }
      case 'AND':
        return truthy(s(0)) && truthy(s(1));
      case 'OR':
        return truthy(s(0)) || truthy(s(1));
      case 'NOT':
        return !truthy(s(0));
      case 'TRUE':
        return true;
      case 'FALSE':
        return false;
      case 'BLANK':
        return null;
      case 'ISBLANK':
        return s(0) === null;
      case 'ISNUMBER':
        return typeof s(0) === 'number';
      case 'ISTEXT':
        return typeof s(0) === 'string';
      case 'ISEMPTY': {
        const t = this.evalTable(args[0], ctx);
        return this.tableSize(t) === 0;
      }
      case 'COALESCE':
        for (let i = 0; i < args.length; i++) {
          const v = s(i);
          if (v !== null) return v;
        }
        return null;

      // ---- math
      case 'DIVIDE': {
        const a = s(0);
        const b = s(1);
        if (b === null || num(b) === 0) return opt(2);
        if (a === null) return null;
        return num(a) / num(b);
      }
      case 'ABS':
        return mapNum(s(0), Math.abs);
      case 'ROUND': {
        const d = num(opt(1, 0));
        return mapNum(s(0), (x) => roundTo(x, d, Math.round));
      }
      case 'ROUNDUP':
        return mapNum(s(0), (x) => roundTo(x, num(opt(1, 0)), (y) => Math.sign(y) * Math.ceil(Math.abs(y))));
      case 'ROUNDDOWN':
      case 'TRUNC':
        return mapNum(s(0), (x) => roundTo(x, num(opt(1, 0)), Math.trunc));
      case 'INT':
        return mapNum(s(0), Math.floor);
      case 'CEILING':
        return mapNum(s(0), (x) => Math.ceil(x / num(opt(1, 1))) * num(opt(1, 1)));
      case 'FLOOR':
        return mapNum(s(0), (x) => Math.floor(x / num(opt(1, 1))) * num(opt(1, 1)));
      case 'SQRT':
        return mapNum(s(0), Math.sqrt);
      case 'POWER':
        return Math.pow(num(s(0)), num(s(1)));
      case 'MOD': {
        const a = num(s(0));
        const b = num(s(1));
        return a - b * Math.floor(a / b);
      }
      case 'EXP':
        return Math.exp(num(s(0)));
      case 'LN':
        return Math.log(num(s(0)));
      case 'LOG':
        return Math.log(num(s(0))) / Math.log(num(opt(1, 10)));
      case 'LOG10':
        return Math.log10(num(s(0)));
      case 'SIGN':
        return Math.sign(num(s(0)));
      case 'PI':
        return Math.PI;

      // ---- text
      case 'CONCATENATE':
        return this.text(s(0)) + this.text(s(1));
      case 'UPPER':
        return this.text(s(0)).toUpperCase();
      case 'LOWER':
        return this.text(s(0)).toLowerCase();
      case 'LEN':
        return this.text(s(0)).length;
      case 'TRIM':
        return this.text(s(0)).trim().replace(/\s+/g, ' ');
      case 'LEFT':
        return this.text(s(0)).slice(0, num(opt(1, 1)));
      case 'RIGHT': {
        const t = this.text(s(0));
        return t.slice(Math.max(0, t.length - num(opt(1, 1))));
      }
      case 'MID':
        return this.text(s(0)).substr(num(s(1)) - 1, num(s(2)));
      case 'SUBSTITUTE':
        return this.text(s(0)).split(this.text(s(1))).join(this.text(s(2)));
      case 'REPT':
        return this.text(s(0)).repeat(Math.max(0, num(s(1))));
      case 'SEARCH':
      case 'FIND': {
        const needle = this.text(s(0));
        const hay = this.text(s(1));
        const start = num(opt(2, 1)) - 1;
        const i = name === 'SEARCH' ? hay.toLowerCase().indexOf(needle.toLowerCase(), start) : hay.indexOf(needle, start);
        if (i < 0) {
          if (args[3]) return s(3);
          throw new DaxError(`${name}: text "${needle}" not found`);
        }
        return i + 1;
      }
      case 'CONTAINSSTRING':
        return this.text(s(0)).toLowerCase().includes(this.text(s(1)).toLowerCase());
      case 'EXACT':
        return this.text(s(0)) === this.text(s(1));
      case 'VALUE':
        return num(s(0));
      case 'FORMAT':
        return formatValue(s(0), this.text(s(1)));

      // ---- date
      case 'DATE':
        return new Date(num(s(0)), num(s(1)) - 1, num(s(2)));
      case 'TODAY': {
        const d = new Date();
        return new Date(d.getFullYear(), d.getMonth(), d.getDate());
      }
      case 'NOW':
        return new Date();
      case 'YEAR':
        return mapDate(s(0), (d) => d.getFullYear());
      case 'MONTH':
        return mapDate(s(0), (d) => d.getMonth() + 1);
      case 'DAY':
        return mapDate(s(0), (d) => d.getDate());
      case 'QUARTER':
        return mapDate(s(0), (d) => Math.floor(d.getMonth() / 3) + 1);
      case 'HOUR':
        return mapDate(s(0), (d) => d.getHours());
      case 'MINUTE':
        return mapDate(s(0), (d) => d.getMinutes());
      case 'WEEKDAY': {
        const type = num(opt(1, 1));
        return mapDate(s(0), (d) => (type === 2 ? ((d.getDay() + 6) % 7) + 1 : type === 3 ? (d.getDay() + 6) % 7 : d.getDay() + 1));
      }
      case 'WEEKNUM':
        return mapDate(s(0), (d) => {
          const jan1 = new Date(d.getFullYear(), 0, 1);
          return Math.floor(((d.getTime() - jan1.getTime()) / MS_DAY + jan1.getDay()) / 7) + 1;
        });
      case 'EOMONTH':
        return mapDateD(s(0), (d) => new Date(d.getFullYear(), d.getMonth() + num(s(1)) + 1, 0));
      case 'EDATE':
        return mapDateD(s(0), (d) => addMonths(d, num(s(1))));
      case 'DATEDIFF': {
        const a = s(0);
        const b = s(1);
        if (!(a instanceof Date) || !(b instanceof Date)) return null;
        const unit = this.intervalArg(args[2]);
        if (unit === 'DAY') return Math.round((b.getTime() - a.getTime()) / MS_DAY);
        if (unit === 'WEEK') return Math.floor(Math.round((b.getTime() - a.getTime()) / MS_DAY) / 7);
        if (unit === 'MONTH') return (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth();
        if (unit === 'QUARTER') return (b.getFullYear() - a.getFullYear()) * 4 + Math.floor(b.getMonth() / 3) - Math.floor(a.getMonth() / 3);
        if (unit === 'YEAR') return b.getFullYear() - a.getFullYear();
        if (unit === 'HOUR') return Math.floor((b.getTime() - a.getTime()) / 3_600_000);
        if (unit === 'MINUTE') return Math.floor((b.getTime() - a.getTime()) / 60_000);
        if (unit === 'SECOND') return Math.floor((b.getTime() - a.getTime()) / 1000);
        throw new DaxError(`Unknown DATEDIFF interval ${unit}`);
      }
    }
    const more = this.callMore(name, args, ctx);
    if (more !== UNHANDLED) return more;
    throw new DaxError(`Function ${name} is not supported (yet). See docs/guide/expressions.md for the supported list.`);
  }

  // ------------------------------------------------------------ Phase 3: tables, lookups, stats, security, calc groups

  /** Any table value as tuples (physical rows expand to all their columns). */
  private toTuples(t: TableValue): TuplesTable {
    if (t.kind === 'tuples') return t;
    const tbl = this.model.table(t.table);
    const cols = [...tbl.columns.keys()].map((c) => ({ table: t.table, column: c }));
    return { kind: 'tuples', columns: cols, tuples: t.rows.map((r) => cols.map((c) => tbl.value(c.column, r))) };
  }

  /** Materialise a table expression into named columns + rows (DAX query EVALUATE). */
  evalTableToRows(expr: Expr, ctx: EvalContext): { columns: string[]; rows: CellValue[][]; formats: (string | undefined)[] } {
    const t = this.toTuples(this.evalTable(expr, ctx));
    const names = t.columns.map((c) => c.column);
    const columns = t.columns.map((c, i) => (names.indexOf(c.column) !== i || names.lastIndexOf(c.column) !== i ? (c.table ? `${c.table}[${c.column}]` : c.column) : c.column));
    const formats = t.columns.map((c, i) => t.formats?.[i] ?? (c.table && this.model.hasTable(c.table) && this.model.table(c.table).hasColumn(c.column) ? this.model.table(c.table).column(c.column).format : undefined));
    return { columns, rows: t.tuples.map((tu) => [...tu]), formats };
  }

  /** Format of a computed column: the measure's format when the expression is a plain measure reference. */
  private formatOf(e: Expr): string | undefined {
    return e.type === 'bracket' && this.model.hasMeasure(e.name) ? this.model.measure(e.name).format : undefined;
  }

  /** Split trailing "Name", expr pairs. */
  private namedPairs(args: Expr[], from: number, fn: string): { name: string; expr: Expr }[] {
    const out: { name: string; expr: Expr }[] = [];
    for (let i = from; i < args.length; i += 2) {
      const n = args[i];
      if (n.type !== 'string' || !args[i + 1]) throw new DaxError(`${fn}: expected "Name", expression pairs`);
      out.push({ name: n.value, expr: args[i + 1] });
    }
    return out;
  }

  private tupleKey(tu: CellValue[]): string {
    return JSON.stringify(tu.map(valueKey));
  }

  private stat(vals: number[], kind: 'stdevS' | 'stdevP' | 'varS' | 'varP'): CellValue {
    const n = vals.length;
    if (n === 0 || (n === 1 && (kind === 'stdevS' || kind === 'varS'))) return null;
    const mean = vals.reduce((a, b) => a + b, 0) / n;
    const ss = vals.reduce((a, b) => a + (b - mean) ** 2, 0);
    const v = ss / (kind === 'stdevS' || kind === 'varS' ? n - 1 : n);
    return kind.startsWith('stdev') ? Math.sqrt(v) : v;
  }

  private percentile(vals: number[], k: number, exclusive: boolean): CellValue {
    const sorted = [...vals].sort((a, b) => a - b);
    const n = sorted.length;
    if (!n) return null;
    if (k < 0 || k > 1) throw new DaxError('PERCENTILE: k must be between 0 and 1');
    let rank: number;
    if (exclusive) {
      rank = k * (n + 1) - 1;
      if (rank < 0 || rank > n - 1) throw new DaxError('PERCENTILE.EXC: k is outside the valid range for this many values');
    } else rank = k * (n - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
  }

  private callMore(name: string, args: Expr[], ctx: EvalContext): Value | typeof UNHANDLED {
    const s = (i: number) => this.evalScalar(args[i], ctx);
    const nums = (vals: CellValue[]) => vals.filter((v) => v !== null && v !== '').map(num);
    const colNums = () => nums(this.columnValues(this.colArg(args[0], name), ctx));
    const iterNums = () => nums(this.iterate(this.evalTable(args[0], ctx), args[1], ctx));
    switch (name) {
      // ---- table constructors & transformations
      case 'SUMMARIZE': {
        const base = this.evalTable(args[0], ctx);
        let i = 1;
        const groupCols: ColumnRef[] = [];
        while (i < args.length && args[i].type === 'column') groupCols.push(this.colArg(args[i++], name));
        const ext = this.namedPairs(args, i, name);
        const seen = new Map<string, CellValue[]>();
        if (base.kind === 'rows') {
          for (const r of base.rows) {
            const tu = groupCols.map((c) => this.model.relatedValue(base.table, r, c));
            seen.set(this.tupleKey(tu), tu);
          }
        } else {
          const idx = groupCols.map((c) => base.columns.findIndex((b) => b.table === c.table && b.column === c.column));
          if (idx.some((x) => x < 0)) throw new DaxError('SUMMARIZE: group columns must belong to the table');
          for (const row of base.tuples) {
            const tu = idx.map((x) => row[x]);
            seen.set(this.tupleKey(tu), tu);
          }
        }
        const baseFilters = this.transition(ctx);
        const tuples = [...seen.values()].map((tu) => {
          if (!ext.length) return tu;
          const f = overrideFilters(baseFilters, groupCols.map((c, k) => compileFilter({ target: c, op: 'eq', value: tu[k] })));
          return [...tu, ...ext.map((x) => this.evalScalar(x.expr, { filters: f, vars: ctx.vars, selectedMeasure: ctx.selectedMeasure }))];
        });
        return { kind: 'tuples', columns: [...groupCols, ...ext.map((x) => ({ table: '', column: x.name }))], tuples, formats: [...groupCols.map(() => undefined), ...ext.map((x) => this.formatOf(x.expr))] };
      }
      case 'SUMMARIZECOLUMNS': {
        let i = 0;
        const groupCols: ColumnRef[] = [];
        while (i < args.length && args[i].type === 'column') groupCols.push(this.colArg(args[i++], name));
        const filterArgs: Expr[] = [];
        while (i < args.length && args[i].type !== 'string') filterArgs.push(args[i++]);
        const ext = this.namedPairs(args, i, name);
        const filters = filterArgs.length ? this.applyModifiers([...ctx.filters], filterArgs, ctx) : this.transition(ctx);
        const combos = groupCols.length ? groupCombos(this.model, groupCols, filters, ext.length > 0) : [[]];
        const tuples: CellValue[][] = [];
        for (const keys of combos) {
          const f = [...filters, ...groupCols.map((c, k) => groupFilter(c, keys[k]))];
          const vals = ext.map((x) => this.evalScalar(x.expr, { filters: f, vars: ctx.vars, selectedMeasure: ctx.selectedMeasure }));
          if (ext.length && vals.every((v) => v === null)) continue;
          tuples.push([...keys, ...vals]);
        }
        return { kind: 'tuples', columns: [...groupCols, ...ext.map((x) => ({ table: '', column: x.name }))], tuples, formats: [...groupCols.map(() => undefined), ...ext.map((x) => this.formatOf(x.expr))] };
      }
      case 'ADDCOLUMNS':
      case 'SELECTCOLUMNS': {
        const base = this.evalTable(args[0], ctx);
        const ext = this.namedPairs(args, 1, name);
        const asTuples = this.toTuples(base);
        const binds = this.bindings(base);
        const tuples = binds.map((b, r) => {
          const vals = ext.map((x) => this.evalScalar(x.expr, { ...ctx, rows: [...(ctx.rows ?? []), b] }));
          return name === 'ADDCOLUMNS' ? [...asTuples.tuples[r], ...vals] : vals;
        });
        const extCols = ext.map((x) => ({ table: '', column: x.name }));
        const extFormats = ext.map((x) => this.formatOf(x.expr));
        return { kind: 'tuples', columns: name === 'ADDCOLUMNS' ? [...asTuples.columns, ...extCols] : extCols, tuples, formats: name === 'ADDCOLUMNS' ? [...asTuples.columns.map(() => undefined), ...extFormats] : extFormats };
      }
      case 'CROSSJOIN': {
        let acc: TuplesTable = { kind: 'tuples', columns: [], tuples: [[]] };
        for (const a of args) {
          const t = this.toTuples(this.evalTable(a, ctx));
          const next: CellValue[][] = [];
          for (const x of acc.tuples) for (const y of t.tuples) next.push([...x, ...y]);
          if (next.length > 1_000_000) throw new DaxError('CROSSJOIN result too large');
          acc = { kind: 'tuples', columns: [...acc.columns, ...t.columns], tuples: next };
        }
        return acc;
      }
      case 'UNION': {
        const ts = args.map((a) => this.toTuples(this.evalTable(a, ctx)));
        const width = ts[0]?.columns.length ?? 0;
        if (ts.some((t) => t.columns.length !== width)) throw new DaxError('UNION: all tables need the same number of columns');
        return { kind: 'tuples', columns: ts[0].columns, tuples: ts.flatMap((t) => t.tuples) };
      }
      case 'INTERSECT':
      case 'EXCEPT': {
        const a = this.toTuples(this.evalTable(args[0], ctx));
        const b = this.toTuples(this.evalTable(args[1], ctx));
        const keys = new Set(b.tuples.map((t) => this.tupleKey(t)));
        return { ...a, clearTable: undefined, tuples: a.tuples.filter((t) => keys.has(this.tupleKey(t)) === (name === 'INTERSECT')) };
      }
      case 'NATURALINNERJOIN':
      case 'NATURALLEFTOUTERJOIN': {
        // join on the columns both tables share (same table and column, or same name for computed columns)
        const a = this.toTuples(this.evalTable(args[0], ctx));
        const b = this.toTuples(this.evalTable(args[1], ctx));
        const same = (x: ColumnRef, y: ColumnRef) => x.column === y.column && (x.table === y.table || !x.table || !y.table);
        const pairs = a.columns.map((c, i) => [i, b.columns.findIndex((d) => same(c, d))] as const).filter(([, j]) => j >= 0);
        if (!pairs.length) throw new DaxError(`${name}: the tables have no common columns to join on`);
        const joinB = new Set(pairs.map(([, j]) => j));
        const restB = b.columns.map((_, j) => j).filter((j) => !joinB.has(j));
        const index = new Map<string, CellValue[][]>();
        for (const t of b.tuples) {
          const k = this.tupleKey(pairs.map(([, j]) => t[j]));
          const list = index.get(k);
          if (list) list.push(t);
          else index.set(k, [t]);
        }
        const tuples: CellValue[][] = [];
        for (const t of a.tuples) {
          const matches = index.get(this.tupleKey(pairs.map(([i]) => t[i])));
          if (matches) for (const m of matches) tuples.push([...t, ...restB.map((j) => m[j])]);
          else if (name === 'NATURALLEFTOUTERJOIN') tuples.push([...t, ...restB.map(() => null)]);
        }
        return { kind: 'tuples', columns: [...a.columns, ...restB.map((j) => b.columns[j])], tuples };
      }
      case 'SAMPLE': {
        // N rows spread evenly over the table sorted by the order expressions, first and last included
        const n = Math.max(0, Math.floor(num(s(0))));
        const t = this.evalTable(args[1], ctx);
        const binds = this.bindings(t);
        const keys: { values: CellValue[]; desc: boolean }[] = [];
        for (let i = 2; i < args.length; i++) {
          const next = args[i + 1];
          const dirArg = next && ((next.type === 'table' && /^(ASC|DESC)$/i.test(next.name)) || next.type === 'number');
          const desc = !!dirArg && ((next.type === 'table' && next.name.toUpperCase() === 'DESC') || (next.type === 'number' && next.value === 0));
          keys.push({ values: binds.map((b) => this.evalScalar(args[i], { ...ctx, rows: [...(ctx.rows ?? []), b] })), desc });
          if (dirArg) i++;
        }
        const order = binds.map((_, i) => i).sort((x, y) => {
          for (const k of keys) {
            const c = compareValues(k.values[x], k.values[y]);
            if (c) return k.desc ? -c : c;
          }
          return x - y;
        });
        const pick = n >= order.length ? order : n === 0 ? [] : n === 1 ? [order[0]] : Array.from({ length: n }, (_, k) => order[Math.round((k * (order.length - 1)) / (n - 1))]);
        const keep = new Set(pick);
        if (t.kind === 'rows') return { kind: 'rows', table: t.table, rows: t.rows.filter((_, i) => keep.has(i)) };
        return { ...t, tuples: t.tuples.filter((_, i) => keep.has(i)) };
      }
      case 'GENERATE': {
        const t1 = this.evalTable(args[0], ctx);
        const left = this.toTuples(t1);
        const binds = this.bindings(t1);
        let rightCols: ColumnRef[] = [];
        const tuples: CellValue[][] = [];
        binds.forEach((b, i) => {
          const t2 = this.toTuples(this.evalTable(args[1], { ...ctx, rows: [...(ctx.rows ?? []), b] }));
          rightCols = t2.columns;
          for (const y of t2.tuples) tuples.push([...left.tuples[i], ...y]);
        });
        return { kind: 'tuples', columns: [...left.columns, ...rightCols], tuples };
      }
      case 'ROW': {
        const ext = this.namedPairs(args, 0, name);
        return { kind: 'tuples', columns: ext.map((x) => ({ table: '', column: x.name })), tuples: [ext.map((x) => this.evalScalar(x.expr, ctx))], formats: ext.map((x) => this.formatOf(x.expr)) };
      }
      case 'DATATABLE': {
        const data = args[args.length - 1];
        if (data?.type !== 'list') throw new DaxError('DATATABLE: the last argument must be a list of rows {{...}, {...}}');
        const cols: ColumnRef[] = [];
        for (let i = 0; i < args.length - 1; i += 2) {
          const n = args[i];
          if (n.type !== 'string') throw new DaxError('DATATABLE: expected "Column", TYPE pairs');
          cols.push({ table: '', column: n.value });
        }
        const tuples = data.items.map((row) => {
          if (row.type !== 'list') throw new DaxError('DATATABLE: each row must be a list');
          return row.items.map((x) => this.evalScalar(x, ctx));
        });
        return { kind: 'tuples', columns: cols, tuples };
      }
      case 'GENERATESERIES': {
        const a = num(s(0));
        const b = num(s(1));
        const step = args[2] ? num(s(2)) : 1;
        if (step <= 0) throw new DaxError('GENERATESERIES: step must be positive');
        const tuples: CellValue[][] = [];
        for (let v = a; v <= b + step / 1e9 && tuples.length < 1_000_000; v += step) tuples.push([+v.toPrecision(12)]);
        return { kind: 'tuples', columns: [{ table: '', column: 'Value' }], tuples };
      }
      case 'CALENDAR': {
        const a = s(0);
        const b = s(1);
        if (!(a instanceof Date) || !(b instanceof Date)) throw new DaxError('CALENDAR expects two dates');
        const tuples: CellValue[][] = [];
        for (let d = new Date(a.getFullYear(), a.getMonth(), a.getDate()); d <= b && tuples.length < 200_000; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) tuples.push([d]);
        return { kind: 'tuples', columns: [{ table: '', column: 'Date' }], tuples };
      }
      case 'TREATAS': {
        const t = this.toTuples(this.evalTable(args[0], ctx));
        const cols = args.slice(1).map((x) => this.colArg(x, name));
        if (cols.length !== t.columns.length) throw new DaxError('TREATAS: the number of columns must match the table');
        return { kind: 'tuples', columns: cols, tuples: t.tuples };
      }
      case 'CONTAINS': {
        const t = this.evalTable(args[0], ctx);
        const tt = this.toTuples(t);
        const conds: { idx: number; v: CellValue }[] = [];
        for (let i = 1; i + 1 < args.length; i += 2) {
          const c = this.colArg(args[i], name);
          conds.push({ idx: tt.columns.findIndex((x) => x.table === c.table && x.column === c.column), v: s(i + 1) });
        }
        if (conds.some((c) => c.idx < 0)) throw new DaxError('CONTAINS: columns must belong to the table');
        return tt.tuples.some((tu) => conds.every((c) => valueKey(tu[c.idx]) === valueKey(c.v)));
      }

      // ---- lookups & row context
      case 'LOOKUPVALUE': {
        const result = this.colArg(args[0], name);
        const pairs: { col: ColumnRef; v: CellValue }[] = [];
        let i = 1;
        for (; i + 1 < args.length; i += 2) pairs.push({ col: this.colArg(args[i], name), v: s(i + 1) });
        const alternate = i < args.length ? args[i] : undefined;
        const t = this.model.table(result.table);
        const found = new Map<unknown, CellValue>();
        for (let r = 0; r < t.rowCount; r++) {
          if (pairs.every((p) => valueKey(this.model.relatedValue(result.table, r, p.col)) === valueKey(p.v))) {
            const v = t.value(result.column, r);
            found.set(valueKey(v), v);
          }
        }
        if (found.size === 1) return [...found.values()][0];
        if (found.size === 0 || alternate) return alternate ? this.evalScalar(alternate, ctx) : null;
        throw new DaxError('LOOKUPVALUE: a table of multiple values was supplied where a single value was expected');
      }
      case 'EARLIER':
      case 'EARLIEST': {
        const col = this.colArg(args[0], name);
        const depth = name === 'EARLIER' ? (args[1] ? num(s(1)) : 1) : Infinity;
        const matches = (ctx.rows ?? []).filter((b) => (b.kind === 'row' ? b.table === col.table : b.columns.some((c) => c.table === col.table && c.column === col.column)));
        if (matches.length < 2) throw new DaxError(`${name} refers to an earlier row context which doesn't exist`);
        const b = name === 'EARLIEST' ? matches[0] : matches[Math.max(0, matches.length - 1 - depth)];
        if (b.kind === 'row') return this.model.table(b.table).value(col.column, b.row);
        return b.values[b.columns.findIndex((c) => c.table === col.table && c.column === col.column)];
      }
      case 'PATH': {
        const idCol = this.colArg(args[0], name);
        const parentCol = this.colArg(args[1], name);
        const t = this.model.table(idCol.table);
        const idx = t.index(idCol.column);
        let id = this.evalScalar(args[0], ctx);
        const chain: string[] = [];
        const guard = new Set<unknown>();
        while (id !== null && id !== '') {
          if (guard.has(valueKey(id))) throw new DaxError('PATH: circular parent/child relationship');
          guard.add(valueKey(id));
          chain.unshift(this.text(id));
          const r = idx.get(valueKey(id))?.[0];
          if (r === undefined) break;
          id = t.value(parentCol.column, r);
        }
        return chain.join('|');
      }
      case 'PATHLENGTH': {
        const p = this.text(s(0));
        return p ? p.split('|').length : 0;
      }
      case 'PATHITEM':
      case 'PATHITEMREVERSE': {
        const parts = this.text(s(0)).split('|').filter((x) => x !== '');
        const pos = num(s(1));
        const item = name === 'PATHITEM' ? parts[pos - 1] : parts[parts.length - pos];
        if (item === undefined) return null;
        return args[2] && num(s(2)) === 1 ? Number(item) : item;
      }
      case 'PATHCONTAINS':
        return this.text(s(0)).split('|').includes(this.text(s(1)));
      case 'FIRSTNONBLANK':
      case 'LASTNONBLANK': {
        const col = this.colArg(args[0], name);
        const vals = this.model.valuesOf(col, this.transition(ctx));
        const ordered = name === 'FIRSTNONBLANK' ? vals : [...vals].reverse();
        for (const v of ordered) {
          const r = this.evalScalar(args[1], { ...ctx, rows: [...(ctx.rows ?? []), { kind: 'tuple', columns: [col], values: [v] }] });
          if (r !== null) return { kind: 'tuples', columns: [col], tuples: [[v]] };
        }
        return { kind: 'tuples', columns: [col], tuples: [] };
      }

      // ---- statistics
      case 'STDEV.S':
        return this.stat(colNums(), 'stdevS');
      case 'STDEV.P':
        return this.stat(colNums(), 'stdevP');
      case 'VAR.S':
        return this.stat(colNums(), 'varS');
      case 'VAR.P':
        return this.stat(colNums(), 'varP');
      case 'STDEVX.S':
        return this.stat(iterNums(), 'stdevS');
      case 'STDEVX.P':
        return this.stat(iterNums(), 'stdevP');
      case 'VARX.S':
        return this.stat(iterNums(), 'varS');
      case 'VARX.P':
        return this.stat(iterNums(), 'varP');
      case 'PERCENTILE.INC':
      case 'PERCENTILE.EXC':
        return this.percentile(colNums(), num(s(1)), name.endsWith('EXC'));
      case 'PERCENTILEX.INC':
      case 'PERCENTILEX.EXC':
        return this.percentile(iterNums(), num(s(2)), name.endsWith('EXC'));
      case 'GEOMEAN':
      case 'GEOMEANX': {
        const v = name === 'GEOMEAN' ? colNums() : iterNums();
        if (!v.length) return null;
        if (v.some((x) => x <= 0)) throw new DaxError(`${name} requires positive values`);
        return Math.exp(v.reduce((a, b) => a + Math.log(b), 0) / v.length);
      }
      case 'AVERAGEA':
      case 'MAXA':
      case 'MINA': {
        const v = this.columnValues(this.colArg(args[0], name), ctx).map((x) => (x === null ? null : typeof x === 'string' ? 0 : num(x))).filter((x): x is number => x !== null);
        if (!v.length) return null;
        return name === 'AVERAGEA' ? v.reduce((a, b) => a + b, 0) / v.length : name === 'MAXA' ? Math.max(...v) : Math.min(...v);
      }

      // ---- scope & security
      case 'ISINSCOPE': {
        const col = this.colArg(args[0], name);
        return ctx.filters.some((f) => f.kind === 'columns' && f.origin === 'group' && f.columns.some((c) => c.table === col.table && c.column === col.column));
      }
      case 'ISCROSSFILTERED': {
        const filters = this.transition(ctx);
        const table = args[0]?.type === 'table' ? args[0].name : this.colArg(args[0], name).table;
        return this.model.rowsOf(table, filters).length < this.model.table(table).rowCount;
      }
      case 'USERNAME':
      case 'USERPRINCIPALNAME':
        return this.model.currentUser;
      case 'CUSTOMDATA':
        return this.model.customData;

      // ---- calculation groups
      case 'SELECTEDMEASURE':
        if (!ctx.selectedMeasure) throw new DaxError('SELECTEDMEASURE() can only be used in a calculation item');
        return this.callMeasure(ctx.selectedMeasure, { filters: ctx.filters, rows: ctx.rows });
      case 'SELECTEDMEASURENAME':
        return ctx.selectedMeasure ?? null;
      case 'SELECTEDMEASUREFORMATSTRING':
        return ctx.selectedMeasure && this.model.hasMeasure(ctx.selectedMeasure) ? (this.model.measure(ctx.selectedMeasure).format ?? '') : null;
      case 'ISSELECTEDMEASURE':
        return args.some((a) => a.type === 'bracket' && a.name === ctx.selectedMeasure);

      case 'USERELATIONSHIP':
      case 'CROSSFILTER':
        throw new DaxError(`${name} can only be used as a filter argument of CALCULATE / CALCULATETABLE`);

      // ---- misc scalar
      case 'COMBINEVALUES': {
        const d = this.text(s(0));
        return args.slice(1).map((_, i) => this.text(s(i + 1))).join(d);
      }
      case 'DATEVALUE': {
        const v = s(0);
        if (v instanceof Date) return v;
        const t = this.text(v);
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
        const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(t);
        return Number.isNaN(d.getTime()) ? null : d;
      }
      case 'SECOND': {
        const v = s(0);
        return v instanceof Date ? v.getSeconds() : null;
      }
      case 'UTCNOW':
        return new Date();
      case 'UTCTODAY': {
        const d = new Date();
        return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      }
      case 'NETWORKDAYS': {
        const a = s(0);
        const b = s(1);
        if (!(a instanceof Date) || !(b instanceof Date)) return null;
        const sign = a <= b ? 1 : -1;
        let count = 0;
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        for (let d = new Date(lo.getFullYear(), lo.getMonth(), lo.getDate()); d <= hi; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) if (d.getDay() !== 0 && d.getDay() !== 6) count++;
        return count * sign;
      }
    }
    return UNHANDLED;
  }

  private extreme(v: CellValue[], min: boolean): CellValue {
    let best: CellValue = null;
    for (const x of v) {
      if (x === null || x === '') continue;
      if (best === null || (min ? compareValues(x, best) < 0 : compareValues(x, best) > 0)) best = x;
    }
    return best;
  }

  private distinctTuples(cols: ColumnRef[], filters: readonly Filter[]): TuplesTable {
    const table = cols[0].table;
    if (cols.some((c) => c.table !== table)) throw new DaxError('Multi-column ALL/VALUES must use columns from one table');
    const t = this.model.table(table);
    const seen = new Map<string, CellValue[]>();
    for (const i of this.model.rowsOf(table, filters)) {
      const tu = cols.map((c) => t.value(c.column, i));
      seen.set(JSON.stringify(tu.map(valueKey)), tu);
    }
    return { kind: 'tuples', columns: cols, tuples: [...seen.values()] };
  }
}

function mapNum(v: CellValue, f: (n: number) => number): CellValue {
  return v === null ? null : f(num(v));
}
function mapDate(v: CellValue, f: (d: Date) => number): CellValue {
  if (v === null) return null;
  const d = v instanceof Date ? v : new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : f(d);
}
function mapDateD(v: CellValue, f: (d: Date) => Date): CellValue {
  if (v === null) return null;
  const d = v instanceof Date ? v : new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : f(d);
}
function roundTo(x: number, digits: number, f: (n: number) => number): number {
  const p = Math.pow(10, digits);
  return f(x * p + (f === Math.round ? Math.sign(x) * 1e-9 : 0)) / p;
}
function median(n: number[]): CellValue {
  if (!n.length) return null;
  const s = [...n].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
