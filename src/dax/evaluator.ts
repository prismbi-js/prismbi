import type { Expr } from './ast';
import type { CellValue, ColumnRef } from '../data/types';
import { compareValues, valueKey } from '../data/types';
import type { ColumnsFilter, Filter } from '../data/filters';
import { compileFilter, contextKey, overrideFilters, rowsFilter } from '../data/filters';
import type { DataModel } from '../data/model';
import { formatValue } from '../format/format';

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
}

export type TableValue = RowsTable | TuplesTable;
export type Value = CellValue | TableValue;

type RowBinding = { kind: 'row'; table: string; row: number } | { kind: 'tuple'; columns: ColumnRef[]; values: CellValue[] };

export interface EvalContext {
  filters: readonly Filter[];
  rows?: readonly RowBinding[];
  vars?: ReadonlyMap<string, Value>;
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
  'SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'COUNTBLANK', 'COUNTROWS', 'DISTINCTCOUNT', 'DISTINCTCOUNTNOBLANK', 'MEDIAN',
  'SUMX', 'AVERAGEX', 'MINX', 'MAXX', 'COUNTX', 'COUNTAX', 'MEDIANX', 'CONCATENATEX', 'RANKX', 'PRODUCTX', 'PRODUCT',
  'CALCULATE', 'CALCULATETABLE', 'FILTER', 'ALL', 'ALLSELECTED', 'ALLEXCEPT', 'REMOVEFILTERS', 'VALUES', 'DISTINCT', 'SELECTEDVALUE',
  'HASONEVALUE', 'ISFILTERED', 'TOPN', 'RELATEDTABLE', 'FIRSTDATE', 'LASTDATE', 'TOTALYTD', 'TOTALMTD', 'TOTALQTD',
]);

const MS_DAY = 86_400_000;

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
  private stack: string[] = [];

  constructor(private model: DataModel) {
    model.onChange(() => this.measureCache.clear());
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
        if (!ctx.vars?.has(e.name)) throw new DaxError(`Variable ${e.name} is not defined`);
        return ctx.vars.get(e.name)!;
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
        if (a instanceof Date && !(b instanceof Date)) return new Date(a.getTime() + (op === '+' ? 1 : -1) * num(b) * MS_DAY);
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

  /** Context transition: row context becomes equivalent filter context. */
  private transition(ctx: EvalContext): Filter[] {
    let filters = [...ctx.filters];
    for (const b of ctx.rows ?? []) {
      if (b.kind === 'row') filters = overrideFilters(filters, [rowsFilter(b.table, [b.row])]);
      else filters = overrideFilters(filters, b.columns.map((c, i) => compileFilter({ target: c, op: 'eq', value: b.values[i] })));
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
      return { kind: 'rows', table: e.name, rows: this.model.rowsOf(e.name, this.transition(ctx)) };
    }
    if (e.type === 'column') {
      const col = this.model.resolveColumn({ table: e.table, column: e.column });
      return { kind: 'tuples', columns: [col], tuples: this.model.valuesOf(col, this.transition(ctx)).map((v) => [v]) };
    }
    const v = this.eval(e, ctx);
    if (!isTable(v)) throw new DaxError('A table expression was expected');
    return v;
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
    const out: CellValue[] = [];
    for (const b of this.bindings(t)) out.push(this.evalScalar(expr, { ...ctx, rows: [...(ctx.rows ?? []), b] }));
    return out;
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
        return filters.filter((f) => !(f.kind === 'rows' ? exp.has(f.table) : f.columns.every((c) => exp.has(c.table))));
      }
      case 'removeColumns':
        return filters.filter((f) => f.kind === 'rows' || !f.columns.some((c) => m.columns.some((d) => d.table === c.table && d.column === c.column)));
      case 'allExcept': {
        const exp = this.model.expanded(m.table);
        return filters.filter((f) => {
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
          throw new DaxError('USERELATIONSHIP is planned for Phase 3 (inactive relationships)');
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
    for (const d of visible) {
      const s = shift(d);
      if (existing.has(s.getTime())) shifted.set(s.getTime(), s);
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

  private call(name: string, args: Expr[], ctx: EvalContext): Value {
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
        return iter((v) => {
          const n = nums(v);
          return n.length ? n.reduce((a, b) => a + b, 0) : null;
        });
      case 'AVERAGEX':
        return iter((v) => {
          const n = nums(v);
          return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null;
        });
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
        return this.evalScalar(args[0], { filters, vars: ctx.vars });
      }
      case 'CALCULATETABLE': {
        const filters = this.applyModifiers([...ctx.filters], args.slice(1), ctx);
        return this.evalTable(args[0], { filters, vars: ctx.vars });
      }
      case 'FILTER': {
        const t = this.evalTable(args[0], ctx);
        const keep = this.iterate(t, args[1], ctx).map(truthy);
        if (t.kind === 'rows') return { kind: 'rows', table: t.table, rows: t.rows.filter((_, i) => keep[i]) };
        return { ...t, tuples: t.tuples.filter((_, i) => keep[i]) };
      }
      case 'ALL':
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
        return { kind: 'tuples', columns: [col], tuples: this.model.valuesOf(col, this.transition(ctx)).map((v) => [v]) };
      }
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
          return filters.some((f) => (f.kind === 'rows' ? f.table === tname : f.columns.some((c) => c.table === tname)));
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
        return this.evalScalar(args[0], { filters, vars: ctx.vars });
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
    throw new DaxError(`Function ${name} is not supported (yet). See docs/guide/expressions.md for the supported list.`);
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
