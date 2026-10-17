/**
 * PrismBI SQL pushdown: translate visual queries to SQL and run them on DuckDB (DuckDB-Wasm in the browser or
 * DuckDB on a server), Postgres or SQLite, so large fact tables never have to be loaded into memory.
 *
 * ```ts
 * import { sqlEngine, duckdbRunner } from '@prismbi/prismbi/sql';
 * const engine = sqlEngine(model, { run: duckdbRunner(conn) });
 * new Report(el, { model, engine, pages });
 * ```
 * @packageDocumentation
 */
import { parseDax, resolveGroupField, resolveValueField, visualCalcPlan } from '@prismbi/prismbi';
import type { CellValue, DataModel, Expr, Filter, FilterSpec, QueryField, QueryResult, QueryRow, QuerySpec } from '@prismbi/prismbi';

export type SqlDialect = 'duckdb' | 'postgres' | 'sqlite';

export interface SqlOptions {
  /** Model table → SQL table or view (default: the same name). May be schema-qualified: `'analytics.sales'`. */
  tables?: Record<string, string>;
  /** Model column → SQL column, per model table: `{ Sales: { SalesAmount: 'sales_amount' } }`. */
  columns?: Record<string, Record<string, string>>;
  dialect?: SqlDialect;
}

/** The query (or a measure in it) can't be expressed in SQL. */
export class SqlUnsupportedError extends Error {
  override name = 'SqlUnsupportedError';
}

export interface SqlPlan {
  /** Grouped query: columns `g0…` (group keys) and `v0…` (values). */
  sql: string;
  /** Grand totals (`spec.totals`). */
  totals?: string;
  /** The grouped query with the highlight filters added (`spec.highlight`). */
  highlight?: string;
  groups: QueryField[];
  values: QueryField[];
  /** Rows fetched to detect truncation (`limit + 1`), when grouping. */
  limit?: number;
  /** `'aggregate'`: one GROUP BY query. `'context'`: correlated subqueries with full filter-context semantics. */
  mode?: 'aggregate' | 'context';
}

const unsupported = (msg: string): never => {
  throw new SqlUnsupportedError(msg);
};

// dates are calendar dates in local time (as the model creates them); SQL DATE values have no time zone
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function toLocalDate(v: unknown): Date | null {
  if (typeof v === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ]00:00(?::00(?:\.0+)?)?(?:Z)?$)/.exec(v);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = v instanceof Date ? v : typeof v === 'number' ? new Date(v < 1e11 ? v * 86_400_000 : v) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  // midnight UTC (a DATE from the database) → the same calendar day, local midnight
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0 ? new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) : d;
}

const quoteIdent = (name: string) => name.split('.').map((p) => `"${p.replace(/"/g, '""')}"`).join('.');
const asRef = (ref: string) => {
  const m = /^'?(.*?)'?\[([^\]]+)\]$/.exec(ref.trim());
  return m ? { table: m[1], column: m[2] } : unsupported(`Not a column reference: ${ref}`);
};
const refOf = (t: { table: string; column: string } | string) => (typeof t === 'string' ? asRef(t) : t);

// ---------------------------------------------------------------- builder

/** FROM/JOIN/WHERE state for one SELECT. */
class Scope {
  private aliases = new Map<string, string>();
  private joins: string[] = [];
  constructor(
    private model: DataModel,
    readonly opts: SqlOptions,
    readonly base: string,
    /** Translates a calculated column's row expression. */
    private rowExpr: (s: Scope, e: Expr) => string,
    /** Alias prefix, so nested queries never collide. */
    readonly prefix = 't',
  ) {
    this.aliases.set(base, `${prefix}0`);
  }

  table(name: string): string {
    return quoteIdent(this.opts.tables?.[name] ?? name);
  }

  private alias(table: string): string {
    const known = this.aliases.get(table);
    if (known) return known;
    const path = this.model.pathTo(this.base, table) ?? unsupported(`No many-to-one relationship path from ${this.base} to ${table}`);
    let alias = `${this.prefix}0`;
    for (const rel of path) {
      const next = this.aliases.get(rel.toTable);
      if (next) {
        alias = next;
        continue;
      }
      const a = `${this.prefix}${this.aliases.size}`;
      this.aliases.set(rel.toTable, a);
      this.joins.push(`LEFT JOIN ${this.table(rel.toTable)} AS ${a} ON ${alias}.${this.columnName(rel.fromTable, rel.fromColumn)} = ${a}.${this.columnName(rel.toTable, rel.toColumn)}`);
      alias = a;
    }
    return alias;
  }

  columnName(table: string, column: string): string {
    return quoteIdent(this.opts.columns?.[table]?.[column] ?? column);
  }

  col(ref: { table: string; column: string }): string {
    if (!this.model.hasTable(ref.table) || !this.model.table(ref.table).hasColumn(ref.column)) unsupported(`Unknown column ${ref.table}[${ref.column}]`);
    const c = this.model.table(ref.table).column(ref.column);
    // calculated columns: a database column when mapped in `columns`, else their row expression inlined
    if (c.expression && !this.opts.columns?.[ref.table]?.[ref.column]) {
      if (c.type === 'date') unsupported(`Calculated date column ${ref.table}[${ref.column}]: add it to the database and map it in \`columns\``);
      return `(${this.rowExpr(this, parseDax(c.expression))})`;
    }
    return `${this.alias(ref.table)}.${this.columnName(ref.table, ref.column)}`;
  }

  from(): string {
    return [`FROM ${this.table(this.base)} AS ${this.prefix}0`, ...this.joins].join('\n');
  }
}

class Translator {
  constructor(
    private model: DataModel,
    private dialect: SqlDialect,
  ) {}

  literal(v: CellValue): string {
    if (v === null || v === undefined) return 'NULL';
    if (v instanceof Date) {
      const d = ymd(v);
      return this.dialect === 'sqlite' ? `'${d}'` : `DATE '${d}'`;
    }
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
    if (typeof v === 'boolean') return this.dialect === 'sqlite' ? (v ? '1' : '0') : v ? 'TRUE' : 'FALSE';
    return `'${String(v).replace(/'/g, "''")}'`;
  }

  // ------------------------------------------------------------ filters → WHERE

  filter(s: Scope, f: FilterSpec, ctxFilters: FilterSpec[]): string {
    if (f.op === 'tuples') {
      const cols = f.targets.map((t) => s.col(refOf(t as string)));
      const any = f.tuples.map((tu) => `(${tu.map((v, i) => (v === null ? `${cols[i]} IS NULL` : `${cols[i]} = ${this.literal(v)}`)).join(' AND ')})`).join(' OR ') || 'FALSE';
      return f.exclude ? `NOT (${any})` : `(${any})`;
    }
    const col = s.col(refOf(f.target as string));
    const lit = (v: CellValue | undefined) => this.literal(v ?? null);
    const like = (pattern: string) => `LOWER(CAST(${col} AS VARCHAR)) LIKE ${this.literal(pattern.toLowerCase())} ESCAPE '\\'`;
    const esc = (v: CellValue | undefined) => String(v ?? '').replace(/[\\%_]/g, (c) => `\\${c}`);
    switch (f.op) {
      case 'eq':
        return f.value === null || f.value === undefined ? `${col} IS NULL` : `${col} = ${lit(f.value)}`;
      case 'neq':
        return f.value === null || f.value === undefined ? `${col} IS NOT NULL` : `(${col} <> ${lit(f.value)} OR ${col} IS NULL)`;
      case 'in':
      case 'notIn': {
        const vals = f.values ?? [];
        const nonNull = vals.filter((v) => v !== null && v !== undefined);
        const hasNull = nonNull.length < vals.length;
        const inList = nonNull.length ? `${col} IN (${nonNull.map(lit).join(', ')})` : 'FALSE';
        if (f.op === 'in') return hasNull ? `(${inList} OR ${col} IS NULL)` : inList;
        return hasNull ? `(NOT ${inList} AND ${col} IS NOT NULL)` : `(NOT ${inList} OR ${col} IS NULL)`;
      }
      case 'gt':
        return `${col} > ${lit(f.value)}`;
      case 'gte':
        return `${col} >= ${lit(f.value)}`;
      case 'lt':
        return `${col} < ${lit(f.value)}`;
      case 'lte':
        return `${col} <= ${lit(f.value)}`;
      case 'between':
        return [f.min !== undefined && f.min !== null ? `${col} >= ${lit(f.min)}` : '', f.max !== undefined && f.max !== null ? `${col} <= ${lit(f.max)}` : ''].filter(Boolean).join(' AND ') || 'TRUE';
      case 'contains':
        return like(`%${esc(f.value)}%`);
      case 'notContains':
        return `(NOT ${like(`%${esc(f.value)}%`)} OR ${col} IS NULL)`;
      case 'startsWith':
        return like(`${esc(f.value)}%`);
      case 'endsWith':
        return like(`%${esc(f.value)}`);
      case 'isBlank':
        return `${col} IS NULL`;
      case 'isNotBlank':
        return `${col} IS NOT NULL`;
      case 'topN':
        return this.topN(s, f, ctxFilters);
      default:
        return unsupported(`Filter operator ${(f as { op: string }).op}`);
    }
  }

  private topN(s: Scope, f: Extract<FilterSpec, { op: 'topN' }>, ctxFilters: FilterSpec[]): string {
    const target = refOf(f.target as string);
    const by = resolveValueField(this.model, f.by);
    const sub = new Scope(this.model, s.opts, s.base, (sc, e) => this.rowExpr(sc, e));
    const others = ctxFilters.filter((x) => x !== (f as FilterSpec) && x.op !== 'topN');
    const where = others.map((x) => this.filter(sub, x, others));
    const g = sub.col(target);
    const v = this.value(sub, by.ast, [], ctxFilters);
    const dir = f.direction === 'bottom' ? 'ASC' : 'DESC';
    return `${s.col(target)} IN (SELECT g FROM (SELECT ${g} AS g, ${v} AS s\n${sub.from()}${where.length ? `\nWHERE ${where.join(' AND ')}` : ''}\nGROUP BY 1 ORDER BY 2 ${dir} NULLS LAST LIMIT ${Math.max(0, Math.floor(f.n))}) AS topn)`;
  }

  // ------------------------------------------------------------ DAX → SQL

  /** A measure expression as an aggregate SQL expression. `cond` holds CALCULATE filters in effect. */
  value(s: Scope, e: Expr, cond: string[], ctxFilters: FilterSpec[], vars: Map<string, string> = new Map(), depth = 0): string {
    if (depth > 40) unsupported('Measures nest too deeply');
    const rec = (x: Expr, c = cond) => this.value(s, x, c, ctxFilters, vars, depth + 1);
    const filt = (c: string[]) => (c.length ? ` FILTER (WHERE ${c.join(' AND ')})` : '');
    switch (e.type) {
      case 'number':
      case 'string':
      case 'boolean':
        return this.literal(e.value);
      case 'bracket':
        if (this.model.hasMeasure(e.name)) return `(${rec(parseDax(this.model.measure(e.name).expression))})`;
        return unsupported(`[${e.name}] is not a measure`);
      case 'varRef':
        return vars.get(e.name) ?? unsupported(`Unknown variable ${e.name}`);
      case 'var': {
        const inner = new Map(vars);
        for (const b of e.bindings) inner.set(b.name, `(${this.value(s, b.value, cond, ctxFilters, inner, depth + 1)})`);
        return this.value(s, e.body, cond, ctxFilters, inner, depth + 1);
      }
      case 'unary':
        return e.op === 'NOT' ? `(NOT ${rec(e.operand)})` : e.op === '-' ? `(-${rec(e.operand)})` : rec(e.operand);
      case 'binary': {
        const a = rec(e.left);
        const b = rec(e.right);
        // DAX: BLANK + 5 = 5, BLANK + BLANK = BLANK
        if (e.op === '+' || e.op === '-') return `(CASE WHEN ${a} IS NULL AND ${b} IS NULL THEN NULL ELSE COALESCE(${a}, 0) ${e.op} COALESCE(${b}, 0) END)`;
        if (e.op === '*') return `(${a} * ${b})`;
        if (e.op === '/') return `(${a} * 1.0 / NULLIF(${b}, 0))`;
        const ops: Record<string, string> = { '=': '=', '==': '=', '<>': '<>', '<': '<', '>': '>', '<=': '<=', '>=': '>=', '&&': 'AND', '||': 'OR', '&': '||' };
        return ops[e.op] ? `(${a} ${ops[e.op]} ${b})` : unsupported(`Operator ${e.op}`);
      }
      case 'call':
        return this.call(s, e.name.toUpperCase(), e.args, cond, ctxFilters, vars, depth, filt);
      case 'column':
        return unsupported(`${e.table}[${e.column}] needs an aggregation (SUM, AVERAGE…) in a measure`);
      default:
        return unsupported(`${e.type} expressions`);
    }
  }

  private call(s: Scope, n: string, a: Expr[], cond: string[], ctxFilters: FilterSpec[], vars: Map<string, string>, depth: number, filt: (c: string[]) => string): string {
    const rec = (x: Expr, c = cond) => this.value(s, x, c, ctxFilters, vars, depth + 1);
    const colArg = (x: Expr | undefined) => (x?.type === 'column' ? s.col({ table: x.table, column: x.column }) : unsupported(`${n} needs a column`));
    const AGG: Record<string, string> = { SUM: 'SUM', AVERAGE: 'AVG', MIN: 'MIN', MAX: 'MAX' };
    if (AGG[n]) return `${AGG[n]}(${colArg(a[0])})${filt(cond)}`;
    switch (n) {
      case 'COUNT':
      case 'COUNTA':
        return `NULLIF(COUNT(${colArg(a[0])})${filt(cond)}, 0)`;
      case 'DISTINCTCOUNT':
        return `NULLIF(COUNT(DISTINCT ${colArg(a[0])})${filt(cond)}, 0)`;
      case 'MEDIAN':
        if (this.dialect !== 'duckdb') unsupported('MEDIAN is only pushed down to DuckDB');
        return `MEDIAN(${colArg(a[0])})${filt(cond)}`;
      case 'COUNTROWS':
        if (a[0]?.type !== 'table' || a[0].name !== s.base) unsupported(`COUNTROWS of anything but the fact table (${s.base})`);
        return `NULLIF(COUNT(*)${filt(cond)}, 0)`;
      case 'SUMX':
      case 'AVERAGEX':
      case 'MINX':
      case 'MAXX': {
        if (a[0]?.type !== 'table' || a[0].name !== s.base) unsupported(`${n} over anything but the fact table (${s.base})`);
        const fn = ({ SUMX: 'SUM', AVERAGEX: 'AVG', MINX: 'MIN', MAXX: 'MAX' } as Record<string, string>)[n];
        return `${fn}(${this.rowExpr(s, a[1])})${filt(cond)}`;
      }
      case 'DIVIDE': {
        const x = rec(a[0]);
        const y = rec(a[1]);
        return `(CASE WHEN COALESCE(${y}, 0) = 0 THEN ${a[2] ? rec(a[2]) : 'NULL'} ELSE ${x} * 1.0 / ${y} END)`;
      }
      case 'IF':
        return `(CASE WHEN ${rec(a[0])} THEN ${rec(a[1])} ELSE ${a[2] ? rec(a[2]) : 'NULL'} END)`;
      case 'BLANK':
        return 'NULL';
      case 'ISBLANK':
        return `(${rec(a[0])} IS NULL)`;
      case 'COALESCE':
        return `COALESCE(${a.map((x) => rec(x)).join(', ')})`;
      case 'ABS':
        return `ABS(${rec(a[0])})`;
      case 'ROUND':
        return `ROUND(${rec(a[0])}, ${a[1] ? rec(a[1]) : '0'})`;
      case 'CALCULATE': {
        const extra = a.slice(1).map((f) => this.predicate(s, f, ctxFilters));
        return rec(a[0], [...cond, ...extra]);
      }
      default:
        return unsupported(`${n}() is not pushed down to SQL`);
    }
  }

  /** A row-level expression (inside SUMX): columns of the fact table or related tables, arithmetic, RELATED. */
  rowExpr(s: Scope, e: Expr): string {
    switch (e.type) {
      case 'number':
      case 'string':
      case 'boolean':
        return this.literal(e.value);
      case 'column':
        return s.col({ table: e.table, column: e.column });
      case 'unary':
        return e.op === '-' ? `(-${this.rowExpr(s, e.operand)})` : this.rowExpr(s, e.operand);
      case 'binary': {
        const ops: Record<string, string> = { '+': '+', '-': '-', '*': '*' };
        if (e.op === '/') return `(${this.rowExpr(s, e.left)} * 1.0 / NULLIF(${this.rowExpr(s, e.right)}, 0))`;
        return ops[e.op] ? `(${this.rowExpr(s, e.left)} ${ops[e.op]} ${this.rowExpr(s, e.right)})` : unsupported(`Operator ${e.op} in a row expression`);
      }
      case 'call':
        if (e.name.toUpperCase() === 'RELATED') return this.rowExpr(s, e.args[0]);
        return unsupported(`${e.name}() in a row expression`);
      default:
        return unsupported(`${e.type} in a row expression`);
    }
  }

  /** A CALCULATE filter argument → a condition. Column filters that the query also filters or groups by would replace them in DAX, which SQL can't do. */
  private predicate(s: Scope, f: Expr, ctxFilters: FilterSpec[], keep = false): string {
    if (f.type === 'call' && f.name.toUpperCase() === 'KEEPFILTERS') return this.predicate(s, f.args[0], ctxFilters, true);
    if (f.type === 'binary' && (f.op === '&&' || f.op === '||')) return `(${this.predicate(s, f.left, ctxFilters, keep)} ${f.op === '&&' ? 'AND' : 'OR'} ${this.predicate(s, f.right, ctxFilters, keep)})`;
    if (f.type === 'binary' && f.left.type === 'column') {
      const ref = { table: f.left.table, column: f.left.column };
      if (!keep && (this.touched.has(`${ref.table}[${ref.column}]`) || ctxFilters.some((x) => 'target' in x && sameRef(x.target as string, ref))))
        unsupported(`CALCULATE replaces the filter on ${ref.table}[${ref.column}], which this query also uses (wrap it in KEEPFILTERS to intersect)`);
      const col = s.col(ref);
      if (f.op === 'IN' && f.right.type === 'list') return `${col} IN (${f.right.items.map((x) => (x.type === 'number' || x.type === 'string' || x.type === 'boolean' ? this.literal(x.value) : unsupported('IN lists must hold constants'))).join(', ')})`;
      const right = f.right.type === 'number' || f.right.type === 'string' || f.right.type === 'boolean' ? this.literal(f.right.value) : f.right.type === 'call' && f.right.name.toUpperCase() === 'BLANK' ? 'NULL' : unsupported('CALCULATE filters must compare a column with a constant');
      const ops: Record<string, string> = { '=': '=', '==': '=', '<>': '<>', '<': '<', '>': '>', '<=': '<=', '>=': '>=' };
      if (right === 'NULL') return f.op === '<>' ? `${col} IS NOT NULL` : `${col} IS NULL`;
      return ops[f.op] ? `${col} ${ops[f.op]} ${right}` : unsupported(`Operator ${f.op} in a CALCULATE filter`);
    }
    return unsupported(f.type === 'call' ? `${f.name.toUpperCase()}() is not pushed down to SQL (CALCULATE supports column comparisons)` : 'CALCULATE filters other than column comparisons');
  }

  /** Group-by columns of the current query (CALCULATE can't override them in SQL). */
  touched = new Set<string>();
}

const sameRef = (a: string, b: { table: string; column: string }) => {
  const x = asRef(a);
  return x.table === b.table && x.column === b.column;
};

/** The table that the measures aggregate (all must agree). */
function factTable(model: DataModel, asts: Expr[]): string | undefined {
  const tables = new Set<string>();
  const seen = new Set<string>();
  const walk = (e: Expr): void => {
    if (e.type === 'call') {
      const n = e.name.toUpperCase();
      if (['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'DISTINCTCOUNT', 'MEDIAN'].includes(n) && e.args[0]?.type === 'column') tables.add(e.args[0].table);
      if (['COUNTROWS', 'SUMX', 'AVERAGEX', 'MINX', 'MAXX'].includes(n) && e.args[0]?.type === 'table') tables.add(e.args[0].name);
      e.args.forEach(walk);
    } else if (e.type === 'bracket' && model.hasMeasure(e.name) && !seen.has(e.name)) {
      seen.add(e.name);
      walk(parseDax(model.measure(e.name).expression));
    } else if (e.type === 'binary') (walk(e.left), walk(e.right));
    else if (e.type === 'unary') walk(e.operand);
    else if (e.type === 'var') (e.bindings.forEach((b) => walk(b.value)), walk(e.body));
  };
  asts.forEach(walk);
  if (tables.size > 1) {
    // a dimension aggregated next to the fact (e.g. COUNTROWS(Product)) has no single-table SQL equivalent
    unsupported(`Measures aggregate several tables (${[...tables].join(', ')})`);
  }
  return [...tables][0];
}

const toSpec = (f: FilterSpec | Filter): FilterSpec => {
  if (!('kind' in f)) return f;
  if (f.kind === 'columns' && f.spec) return f.spec;
  return unsupported('Row-level security and relationship filters are not pushed down to SQL');
};

// ---------------------------------------------------------------- filter-context mode

/**
 * One filter in a DAX filter context. `cols` are the columns it filters (for CALCULATE's replace semantics), `tables`
 * the tables it touches (a filter only applies to a query whose table can reach them), `build` writes the predicate
 * for a given FROM scope.
 */
interface CtxEntry {
  kind: 'base' | 'group' | 'calc';
  cols: string[];
  tables: string[];
  build: (s: Scope) => string;
}

type DateUnit = 'year' | 'quarter' | 'month' | 'day';

const colKey = (r: { table: string; column: string }) => `${r.table}[${r.column}]`;

/**
 * Translates measures with full filter-context semantics: every aggregate becomes a correlated subquery over its own
 * table with the filters in effect at that point. CALCULATE replaces, removes (ALL…) or adds filters, and time
 * intelligence turns the dates in context into shifted or extended date ranges. Filters only reach a table along its
 * many-to-one relationships, as in DAX.
 */
class ContextTranslator {
  private seq = 0;
  constructor(
    private model: DataModel,
    private opts: SqlOptions,
    private tr: Translator,
    private dialect: SqlDialect,
    /** The query's own filters (what ALLSELECTED restores). */
    readonly base: CtxEntry[],
  ) {}

  scope(table: string): Scope {
    return new Scope(this.model, this.opts, table, (sc, e) => this.tr.rowExpr(sc, e), `q${++this.seq}_`);
  }

  isNotDistinct(a: string, b: string): string {
    return this.dialect === 'sqlite' ? `${a} IS ${b}` : `${a} IS NOT DISTINCT FROM ${b}`;
  }

  private reaches(table: string, e: CtxEntry): boolean {
    const exp = this.model.expanded(table);
    return e.tables.every((t) => exp.has(t));
  }

  /** Entries that filter `table` (directly or through its many-to-one relationships). */
  applicable(table: string, ctx: CtxEntry[]): CtxEntry[] {
    return ctx.filter((e) => this.reaches(table, e));
  }

  /** `(SELECT <select> FROM table … WHERE <filters in ctx that reach table>)`. */
  subquery(table: string, select: (s: Scope) => string, ctx: CtxEntry[], extra: ((s: Scope) => string)[] = []): string {
    const s = this.scope(table);
    const sel = select(s);
    const preds = [...this.applicable(table, ctx).map((e) => e.build(s)), ...extra.map((f) => f(s))];
    return `(SELECT ${sel}\n${s.from()}${preds.length ? `\nWHERE ${preds.join(' AND ')}` : ''})`;
  }

  // ------------------------------------------------------------ dates

  shift(col: string, n: number, unit: DateUnit): string {
    if (!n) return col;
    const months = unit === 'year' ? n * 12 : unit === 'quarter' ? n * 3 : unit === 'month' ? n : 0;
    const days = unit === 'day' ? n : 0;
    if (this.dialect === 'sqlite') {
      if (!months) return `date(${col}, '${days >= 0 ? '+' : ''}${days} days')`;
      // clamp to the target month's last day (Mar 31 - 1 month = Feb 28), as DAX and the other databases do
      return `MIN(date(${col}, 'start of month', '${months >= 0 ? '+' : ''}${months} months', '+' || (CAST(strftime('%d', ${col}) AS INTEGER) - 1) || ' days'), date(${col}, 'start of month', '${months + 1 >= 0 ? '+' : ''}${months + 1} months', '-1 day'))`;
    }
    if (this.dialect === 'postgres') return `CAST(${col} + make_interval(months => ${months}, days => ${days}) AS DATE)`;
    return months ? `CAST(${col} + to_months(${months}) AS DATE)` : `CAST(${col} + to_days(${days}) AS DATE)`;
  }

  monthEnd(x: string): string {
    if (this.dialect === 'sqlite') return `date(${x}, 'start of month', '+1 month', '-1 day')`;
    if (this.dialect === 'postgres') return `CAST(date_trunc('month', ${x}) + INTERVAL '1 month - 1 day' AS DATE)`;
    return `last_day(${x})`;
  }

  /**
   * "Fact date `col` is one of the context dates shifted by n units". As in DAX, a month's last day also brings the
   * rest of the target month (Feb 28, 2025 - 1 year gives Feb 28 and 29, 2024). Written as membership tests against
   * the context's date set, which databases evaluate once per group rather than once per fact row.
   */
  private shiftedDates(date: { table: string; column: string }, ctx: CtxEntry[], n: number, unit: DateUnit): (col: string) => string {
    const set = (select: (x: string) => string, more: (x: string) => string[] = () => []) => {
      const s = this.scope(date.table);
      const x = s.col(date);
      const preds = [...this.applicable(date.table, ctx).map((e) => e.build(s)), ...more(x)];
      return `(SELECT ${select(x)}\n${s.from()}${preds.length ? `\nWHERE ${preds.join(' AND ')}` : ''})`;
    };
    const direct = set((x) => this.shift(x, n, unit));
    if (unit === 'day') return (col) => `${col} IN ${direct}`;
    const monthEnds = set((x) => x, (x) => [`${x} = ${this.monthEnd(x)}`]);
    return (col) => {
      // the context month-end that col would extend: the last day of col's month shifted back
      const me = this.monthEnd(this.shift(col, -n, unit));
      return `(${col} IN ${direct} OR (${me} IN ${monthEnds} AND ${this.shift(me, n, unit)} < ${col}))`;
    };
  }

  startOf(unit: 'year' | 'quarter' | 'month', x: string): string {
    if (this.dialect !== 'sqlite') return `CAST(date_trunc('${unit}', ${x}) AS DATE)`;
    if (unit === 'year') return `date(${x}, 'start of year')`;
    if (unit === 'month') return `date(${x}, 'start of month')`;
    return `date(${x}, 'start of month', '-' || ((CAST(strftime('%m', ${x}) AS INTEGER) - 1) % 3) || ' months')`;
  }

  /** Dates in the current context, as a subquery over the date table: `(SELECT <agg>(x.Date) FROM Date x WHERE …)`. */
  private dates(date: { table: string; column: string }, ctx: CtxEntry[], select: (col: string) => string): string {
    return this.subquery(date.table, (s) => select(s.col(date)), ctx);
  }

  /** A time-intelligence table function used as a filter: replaces every filter on the date table. */
  private timeFilter(name: string, a: Expr[], ctx: CtxEntry[]): CtxEntry[] {
    const d = a[0];
    if (d?.type !== 'column') return unsupported(`${name} needs a date column`);
    const date = { table: d.table, column: d.column };
    const rest = ctx.filter((e) => !e.tables.includes(date.table));
    const entry = (build: (col: string) => string): CtxEntry[] => [...rest, { kind: 'calc', cols: [colKey(date)], tables: [date.table], build: (s) => build(s.col(date)) }];
    const shifted = (n: number, unit: DateUnit) => this.shiftedDates(date, ctx, n, unit);
    const unitOf = (e: Expr | undefined): DateUnit => {
      const u = (e?.type === 'table' ? e.name : e?.type === 'string' ? e.value : '').toLowerCase();
      return u === 'year' || u === 'quarter' || u === 'month' || u === 'day' ? u : unsupported(`${name}: unknown interval ${u || '(none)'}`);
    };
    const max = this.dates(date, ctx, (x) => `MAX(${x})`);
    const min = this.dates(date, ctx, (x) => `MIN(${x})`);
    switch (name) {
      case 'SAMEPERIODLASTYEAR':
        return entry(shifted(-1, 'year'));
      case 'DATEADD': {
        const n = a[1]?.type === 'number' ? a[1].value : a[1]?.type === 'unary' && a[1].op === '-' && a[1].operand.type === 'number' ? -a[1].operand.value : unsupported('DATEADD needs a constant number of intervals');
        return entry(shifted(n, unitOf(a[2])));
      }
      case 'DATESYTD':
      case 'DATESQTD':
      case 'DATESMTD': {
        const unit = name === 'DATESYTD' ? 'year' : name === 'DATESQTD' ? 'quarter' : 'month';
        return entry((c) => `${c} >= ${this.startOf(unit, max)} AND ${c} <= ${max}`);
      }
      case 'PREVIOUSYEAR':
      case 'PREVIOUSQUARTER':
      case 'PREVIOUSMONTH': {
        const unit = name === 'PREVIOUSYEAR' ? 'year' : name === 'PREVIOUSQUARTER' ? 'quarter' : 'month';
        const start = this.startOf(unit, min);
        return entry((c) => `${c} >= ${this.shift(start, -1, unit)} AND ${c} < ${start}`);
      }
      case 'DATESBETWEEN': {
        const from = this.value(a[1], ctx);
        const to = this.value(a[2], ctx);
        return entry((c) => `${c} >= ${from} AND ${c} <= ${to}`);
      }
      default:
        return unsupported(`${name}() is not pushed down to SQL`);
    }
  }

  // ------------------------------------------------------------ CALCULATE filters

  private columnsIn(e: Expr, out: { table: string; column: string }[] = []): { table: string; column: string }[] {
    if (e.type === 'column') out.push({ table: e.table, column: e.column });
    else if (e.type === 'binary') (this.columnsIn(e.left, out), this.columnsIn(e.right, out));
    else if (e.type === 'unary') this.columnsIn(e.operand, out);
    else if (e.type === 'list') e.items.forEach((x) => this.columnsIn(x, out));
    else if (e.type === 'call' && !AGG_NAMES.has(e.name.toUpperCase())) e.args.forEach((x) => this.columnsIn(x, out));
    return out;
  }

  /** The table a table expression iterates, and how it changes the filters on it (ALL removes them). */
  private tableArg(e: Expr, ctx: CtxEntry[]): { table: string; ctx: CtxEntry[] } {
    if (e.type === 'table') return { table: e.name, ctx };
    if (e.type === 'call') {
      const n = e.name.toUpperCase();
      if (n === 'ALL' || n === 'REMOVEFILTERS' || n === 'ALLSELECTED') {
        const t = e.args[0]?.type === 'table' ? e.args[0].name : e.args[0]?.type === 'column' ? e.args[0].table : unsupported(`${n}() inside FILTER needs a table or column`);
        return { table: t, ctx: this.applyOne(e, ctx) };
      }
      if (n === 'VALUES' || n === 'DISTINCT') {
        const c = e.args[0];
        if (c?.type === 'table') return { table: c.name, ctx };
        if (c?.type === 'column') return { table: c.table, ctx };
      }
    }
    return unsupported('FILTER over this table expression is not pushed down to SQL');
  }

  /** Apply one CALCULATE filter argument to a context. */
  applyOne(f: Expr, ctx: CtxEntry[], keep = false): CtxEntry[] {
    const tablesOf = (t: string) => [...this.model.expanded(t)];
    const touches = (e: CtxEntry, tables: string[]) => e.tables.some((t) => tables.includes(t));
    if (f.type === 'call') {
      const n = f.name.toUpperCase();
      const a = f.args;
      if (n === 'KEEPFILTERS') return this.applyOne(a[0], ctx, true);
      if ((n === 'ALL' || n === 'REMOVEFILTERS') && !a.length) return [];
      if (n === 'ALL' || n === 'REMOVEFILTERS') {
        if (a.every((x) => x.type === 'table')) {
          const tables = a.flatMap((x) => tablesOf((x as { name: string }).name));
          return ctx.filter((e) => !touches(e, tables));
        }
        const cols = a.map((x) => (x.type === 'column' ? colKey(x) : unsupported(`${n} takes a table or columns`)));
        const tables = a.map((x) => (x as { table: string }).table);
        return ctx.filter((e) => !(e.cols.some((c) => cols.includes(c)) || (!e.cols.length && touches(e, tables))));
      }
      if (n === 'ALLSELECTED') {
        if (!a.length) return [...this.base];
        const tables = a.flatMap((x) => (x.type === 'table' ? tablesOf(x.name) : x.type === 'column' ? [x.table] : unsupported('ALLSELECTED takes a table or columns')));
        const cols = a.filter((x) => x.type === 'column').map((x) => colKey(x as { table: string; column: string }));
        const hit = (e: CtxEntry) => (cols.length ? e.cols.some((c) => cols.includes(c)) : touches(e, tables));
        return [...ctx.filter((e) => !hit(e)), ...this.base.filter(hit)];
      }
      if (n === 'ALLEXCEPT') {
        const t = a[0]?.type === 'table' ? a[0].name : unsupported('ALLEXCEPT needs a table first');
        const keepCols = a.slice(1).map((x) => (x.type === 'column' ? colKey(x) : unsupported('ALLEXCEPT keeps columns')));
        const tables = tablesOf(t);
        return ctx.filter((e) => !touches(e, tables) || (e.cols.length > 0 && e.cols.every((c) => keepCols.includes(c))));
      }
      if (n === 'FILTER') {
        const { table, ctx: inner } = this.tableArg(a[0], ctx);
        const cond = a[1];
        const cols = this.columnsIn(cond).filter((c) => c.table === table || this.model.expanded(table).has(c.table));
        // aggregates in the condition (e.g. MAX(Date[Date])) see the context outside FILTER
        return [...inner, { kind: 'calc', cols: [], tables: [table, ...cols.map((c) => c.table)], build: (s) => this.rowCond(s, cond, ctx) }];
      }
      if (n === 'USERELATIONSHIP' || n === 'CROSSFILTER') return unsupported(`${n} is not pushed down to SQL`);
      if (TIME_FILTERS.has(n)) return this.timeFilter(n, a, ctx);
      return unsupported(`${n}() as a CALCULATE filter is not pushed down to SQL`);
    }
    // a boolean over one column: replaces the filters on that column (unless KEEPFILTERS)
    const cols = this.columnsIn(f);
    if (!cols.length) return unsupported('CALCULATE filter without a column');
    const keys = [...new Set(cols.map(colKey))];
    const kept = keep ? ctx : ctx.filter((e) => !e.cols.some((c) => keys.includes(c)));
    return [...kept, { kind: 'calc', cols: keys, tables: [...new Set(cols.map((c) => c.table))], build: (s) => this.rowCond(s, f, ctx) }];
  }

  /** A row-level condition: columns come from the scope; aggregates and measures are scalars in `outer`. */
  rowCond(s: Scope, e: Expr, outer: CtxEntry[]): string {
    const rec = (x: Expr) => this.rowCond(s, x, outer);
    switch (e.type) {
      case 'number':
      case 'string':
      case 'boolean':
        return this.tr.literal(e.value);
      case 'column':
        return s.col({ table: e.table, column: e.column });
      case 'unary':
        return e.op === 'NOT' ? `(NOT ${rec(e.operand)})` : e.op === '-' ? `(-${rec(e.operand)})` : rec(e.operand);
      case 'list':
        return `(${e.items.map(rec).join(', ')})`;
      case 'binary': {
        if (e.op === 'IN') return `${rec(e.left)} IN ${e.right.type === 'list' ? rec(e.right) : unsupported('IN needs a list')}`;
        const ops: Record<string, string> = { '=': '=', '==': '=', '<>': '<>', '<': '<', '>': '>', '<=': '<=', '>=': '>=', '&&': 'AND', '||': 'OR', '+': '+', '-': '-', '*': '*', '&': '||' };
        if (e.op === '/') return `(${rec(e.left)} * 1.0 / NULLIF(${rec(e.right)}, 0))`;
        if ((e.op === '=' || e.op === '==') && e.right.type === 'call' && e.right.name.toUpperCase() === 'BLANK') return `(${rec(e.left)} IS NULL)`;
        return ops[e.op] ? `(${rec(e.left)} ${ops[e.op]} ${rec(e.right)})` : unsupported(`Operator ${e.op}`);
      }
      case 'call': {
        const n = e.name.toUpperCase();
        if (n === 'RELATED') return rec(e.args[0]);
        if (n === 'BLANK') return 'NULL';
        if (n === 'ISBLANK') return `(${rec(e.args[0])} IS NULL)`;
        if (n === 'DATE') return this.tr.literal(new Date(Number((e.args[0] as { value: number }).value), Number((e.args[1] as { value: number }).value) - 1, Number((e.args[2] as { value: number }).value)));
        if (n === 'YEAR' || n === 'MONTH' || n === 'DAY') {
          const x = rec(e.args[0]);
          if (this.dialect === 'sqlite') return `CAST(strftime('${n === 'YEAR' ? '%Y' : n === 'MONTH' ? '%m' : '%d'}', ${x}) AS INTEGER)`;
          return `EXTRACT(${n} FROM ${x})`;
        }
        // aggregates and anything else scalar: evaluated in the outer context
        return this.value(e, outer);
      }
      case 'bracket':
        if (this.model.hasMeasure(e.name)) return unsupported('Measures inside FILTER conditions (per-row context transition) are not pushed down to SQL');
        return unsupported(`[${e.name}] is not a measure`);
      default:
        return unsupported(`${e.type} in a filter condition`);
    }
  }

  // ------------------------------------------------------------ measures

  value(e: Expr, ctx: CtxEntry[], vars: Map<string, string> = new Map(), depth = 0): string {
    if (depth > 60) unsupported('Measures nest too deeply');
    const rec = (x: Expr, c = ctx) => this.value(x, c, vars, depth + 1);
    switch (e.type) {
      case 'number':
      case 'string':
      case 'boolean':
        return this.tr.literal(e.value);
      case 'bracket':
        if (this.model.hasMeasure(e.name)) return `(${rec(parseDax(this.model.measure(e.name).expression))})`;
        return unsupported(`[${e.name}] is not a measure`);
      case 'varRef':
        return vars.get(e.name) ?? unsupported(`Unknown variable ${e.name}`);
      case 'var': {
        const inner = new Map(vars);
        for (const b of e.bindings) inner.set(b.name, `(${this.value(b.value, ctx, inner, depth + 1)})`);
        return this.value(e.body, ctx, inner, depth + 1);
      }
      case 'unary':
        return e.op === 'NOT' ? `(NOT ${rec(e.operand)})` : e.op === '-' ? `(-${rec(e.operand)})` : rec(e.operand);
      case 'binary': {
        const a = rec(e.left);
        const b = rec(e.right);
        if (e.op === '+' || e.op === '-') return `(CASE WHEN ${a} IS NULL AND ${b} IS NULL THEN NULL ELSE COALESCE(${a}, 0) ${e.op} COALESCE(${b}, 0) END)`;
        if (e.op === '*') return `(${a} * ${b})`;
        if (e.op === '/') return `(${a} * 1.0 / NULLIF(${b}, 0))`;
        const ops: Record<string, string> = { '=': '=', '==': '=', '<>': '<>', '<': '<', '>': '>', '<=': '<=', '>=': '>=', '&&': 'AND', '||': 'OR', '&': '||' };
        return ops[e.op] ? `(${a} ${ops[e.op]} ${b})` : unsupported(`Operator ${e.op}`);
      }
      case 'call':
        return this.call(e.name.toUpperCase(), e.args, ctx, rec);
      case 'column':
        return unsupported(`${e.table}[${e.column}] needs an aggregation (SUM, AVERAGE…) in a measure`);
      default:
        return unsupported(`${e.type} expressions`);
    }
  }

  private call(n: string, a: Expr[], ctx: CtxEntry[], rec: (x: Expr, c?: CtxEntry[]) => string): string {
    const col = (x: Expr | undefined) => (x?.type === 'column' ? { table: x.table, column: x.column } : unsupported(`${n} needs a column`));
    const agg = (fn: string, c: { table: string; column: string }, distinct = false) => this.subquery(c.table, (s) => `${fn}(${distinct ? 'DISTINCT ' : ''}${s.col(c)})`, ctx);
    switch (n) {
      case 'SUM':
        return agg('SUM', col(a[0]));
      case 'AVERAGE':
        return agg('AVG', col(a[0]));
      case 'MIN':
      case 'MAX':
        return a.length === 2 ? `${n === 'MIN' ? 'LEAST' : 'GREATEST'}(${rec(a[0])}, ${rec(a[1])})` : agg(n, col(a[0]));
      case 'COUNT':
      case 'COUNTA':
        return `NULLIF(${agg('COUNT', col(a[0]))}, 0)`;
      case 'DISTINCTCOUNT':
        return `NULLIF(${agg('COUNT', col(a[0]), true)}, 0)`;
      case 'MEDIAN':
        if (this.dialect !== 'duckdb') unsupported('MEDIAN is only pushed down to DuckDB');
        return agg('MEDIAN', col(a[0]));
      case 'COUNTROWS': {
        const t = a[0];
        if (t?.type === 'table') return `NULLIF(${this.subquery(t.name, () => 'COUNT(*)', ctx)}, 0)`;
        if (t?.type === 'call' && t.name.toUpperCase() === 'FILTER') {
          const { table, ctx: inner } = this.tableArg(t.args[0], ctx);
          return `NULLIF(${this.subquery(table, () => 'COUNT(*)', inner, [(s) => this.rowCond(s, t.args[1], ctx)])}, 0)`;
        }
        if (t?.type === 'call' && (t.name.toUpperCase() === 'VALUES' || t.name.toUpperCase() === 'DISTINCT') && t.args[0]?.type === 'column') return `NULLIF(${agg('COUNT', col(t.args[0]), true)}, 0)`;
        return unsupported('COUNTROWS of this table expression is not pushed down to SQL');
      }
      case 'SUMX':
      case 'AVERAGEX':
      case 'MINX':
      case 'MAXX': {
        const fn = ({ SUMX: 'SUM', AVERAGEX: 'AVG', MINX: 'MIN', MAXX: 'MAX' } as Record<string, string>)[n];
        const t = a[0];
        if (t?.type === 'table') return this.subquery(t.name, (s) => `${fn}(${this.tr.rowExpr(s, a[1])})`, ctx);
        if (t?.type === 'call' && t.name.toUpperCase() === 'FILTER') {
          const { table, ctx: inner } = this.tableArg(t.args[0], ctx);
          return this.subquery(table, (s) => `${fn}(${this.tr.rowExpr(s, a[1])})`, inner, [(s) => this.rowCond(s, t.args[1], ctx)]);
        }
        return unsupported(`${n} over this table expression is not pushed down to SQL`);
      }
      case 'DIVIDE': {
        const x = rec(a[0]);
        const y = rec(a[1]);
        return `(CASE WHEN COALESCE(${y}, 0) = 0 THEN ${a[2] ? rec(a[2]) : 'NULL'} ELSE ${x} * 1.0 / ${y} END)`;
      }
      case 'IF':
        return `(CASE WHEN ${rec(a[0])} THEN ${rec(a[1])} ELSE ${a[2] ? rec(a[2]) : 'NULL'} END)`;
      case 'BLANK':
        return 'NULL';
      case 'ISBLANK':
        return `(${rec(a[0])} IS NULL)`;
      case 'COALESCE':
        return `COALESCE(${a.map((x) => rec(x)).join(', ')})`;
      case 'ABS':
        return `ABS(${rec(a[0])})`;
      case 'ROUND':
        return `ROUND(${rec(a[0])}, ${a[1] ? rec(a[1]) : '0'})`;
      case 'CALCULATE': {
        let c = ctx;
        for (const f of a.slice(1)) c = this.applyOne(f, c);
        return rec(a[0], c);
      }
      case 'TOTALYTD':
      case 'TOTALQTD':
      case 'TOTALMTD':
        return rec(a[0], this.timeFilter(n.replace('TOTAL', 'DATES'), [a[1]], ctx));
      default:
        return unsupported(`${n}() is not pushed down to SQL`);
    }
  }
}

const AGG_NAMES = new Set(['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'COUNTROWS', 'DISTINCTCOUNT', 'MEDIAN', 'SUMX', 'AVERAGEX', 'MINX', 'MAXX', 'CALCULATE']);
const TIME_FILTERS = new Set(['SAMEPERIODLASTYEAR', 'DATEADD', 'DATESYTD', 'DATESQTD', 'DATESMTD', 'PREVIOUSYEAR', 'PREVIOUSQUARTER', 'PREVIOUSMONTH', 'DATESBETWEEN']);

/** The query in filter-context mode: group combinations first, then one correlated subquery per value. */
function contextPlan(model: DataModel, spec: QuerySpec, opts: SqlOptions): SqlPlan {
  const dialect = opts.dialect ?? 'duckdb';
  const groups = (spec.groupBy ?? []).map((g) => resolveGroupField(model, g));
  const values = (spec.values ?? []).map((v) => resolveValueField(model, v));
  const filters = (spec.filters ?? []).map(toSpec);
  const highlight = (spec.highlight ?? []).map(toSpec);
  const tr = new Translator(model, dialect);
  const entryOf = (f: FilterSpec, all: FilterSpec[], cx: () => ContextTranslator): CtxEntry => {
    const targets = (f.op === 'tuples' ? f.targets : [f.target]).map((t) => asRef(String(t)));
    if (f.op !== 'topN') return { kind: 'base', cols: targets.map(colKey), tables: [...new Set(targets.map((t) => t.table))], build: (s) => tr.filter(s, f, all) };
    // Top N: the N members of the column with the highest (lowest) measure under the other filters
    const target = targets[0];
    const by = resolveValueField(model, f.by);
    return {
      kind: 'base',
      cols: [colKey(target)],
      tables: [target.table],
      build: (s) => {
        const c = cx();
        const others = c.base.filter((e) => !e.cols.includes(colKey(target)));
        const members = c.subquery(target.table, (y) => `DISTINCT ${y.col(target)} AS m`, others);
        const score = c.value(by.ast, [...others, { kind: 'group', cols: [colKey(target)], tables: [target.table], build: (z) => c.isNotDistinct(z.col(target), 'tn.m') }]);
        return `${s.col(target)} IN (SELECT tn.m FROM ${members} AS tn ORDER BY ${score} ${f.direction === 'bottom' ? 'ASC' : 'DESC'} NULLS LAST LIMIT ${Math.max(0, Math.floor(f.n))})`;
      },
    };
  };
  let cx!: ContextTranslator;
  const baseEntries = filters.map((f) => entryOf(f, filters, () => cx));
  cx = new ContextTranslator(model, opts, tr, dialect, baseEntries);
  const groupEntries: CtxEntry[] = groups.map((g, i) => ({ kind: 'group', cols: [colKey(g.column!)], tables: [g.column!.table], build: (s) => cx.isNotDistinct(s.col(g.column!), `c.g${i}`) }));

  // group combinations, as the in-memory engine finds them: one table → its values; several → rows of a table reaching all
  const gTables = [...new Set(groups.map((g) => g.column!.table))];
  const anchor = gTables.length <= 1 ? gTables[0] : (model.tableNames().find((t) => gTables.every((g) => model.expanded(t).has(g))) ?? unsupported(`Grouping columns of unrelated tables (${gTables.join(', ')})`));
  const sortCols = groups.map((g) => model.table(g.column!.table).column(g.column!.column).sortBy);
  const combos = anchor
    ? cx.subquery(anchor, (s) => `DISTINCT ${[...groups.map((g, i) => `${s.col(g.column!)} AS g${i}`), ...sortCols.flatMap((sc, i) => (sc ? [`${s.col({ table: groups[i].column!.table, column: sc })} AS s${i}`] : []))].join(', ')}`, baseEntries).replace(/^\(SELECT DISTINCT/, '(SELECT DISTINCT')
    : '';

  const build = (extra: FilterSpec[], grouped: boolean): string => {
    const ctx = [...baseEntries, ...extra.map((f) => entryOf(f, [...filters, ...extra], () => cx)), ...(grouped ? groupEntries : [])];
    const vs = values.map((v) => cx.value(v.ast, ctx));
    if (!grouped || !groups.length) return `SELECT ${vs.map((v, i) => `${v} AS v${i}`).join(', ') || 'NULL AS v0'}`;
    const cols = [...groups.map((_, i) => `c.g${i}`), ...vs.map((v, i) => `${v} AS v${i}`), ...sortCols.flatMap((sc, i) => (sc ? [`c.s${i}`] : []))];
    const parts = [`SELECT * FROM (SELECT ${cols.join(', ')}\nFROM ${combos} AS c) AS r`];
    if (values.length && !spec.includeEmpty) parts.push(`WHERE NOT (${values.map((_, i) => `r.v${i} IS NULL`).join(' AND ')})`);
    const order: string[] = [];
    const groupOrder = (i: number, dir: string) => `r.${sortCols[i] ? 's' : 'g'}${i} ${dir} NULLS FIRST`;
    for (const o of spec.orderBy ?? []) {
      const dir = o.direction === 'desc' ? 'DESC' : 'ASC';
      let gi = -1;
      let vi = -1;
      if (typeof o.field === 'object') {
        if ('value' in o.field) vi = o.field.value;
        else gi = o.field.group;
      } else {
        gi = groups.findIndex((g) => g.ref === o.field || g.name === o.field);
        if (gi < 0) vi = values.findIndex((v) => v.name === o.field || v.ref === o.field);
      }
      if (vi >= 0 && vi < values.length) order.push(`r.v${vi} ${dir} NULLS LAST`);
      else if (gi >= 0) order.push(groupOrder(gi, dir));
    }
    groups.forEach((_, i) => order.push(groupOrder(i, 'ASC')));
    parts.push(`ORDER BY ${order.join(', ')}`);
    const cap = Math.min(spec.top ?? Infinity, (spec.limit ?? 30_000) + 1);
    if (Number.isFinite(cap)) parts.push(`LIMIT ${cap}`);
    return parts.join('\n');
  };
  return {
    sql: build([], true),
    totals: spec.totals && values.length ? build([], false) : undefined,
    highlight: highlight.length && values.length ? build(highlight, groups.length > 0) : undefined,
    groups,
    values: values.map(({ ast: _a, ...v }) => v),
    limit: groups.length ? (spec.limit ?? 30_000) : undefined,
    mode: 'context',
  };
}

/** Translate a query to SQL. Throws {@link SqlUnsupportedError} for what SQL can't express. */
export function toSql(model: DataModel, spec: QuerySpec, opts: SqlOptions = {}): SqlPlan {
  if (model.activeRoleNames.length) unsupported('Row-level security roles are active; they are not pushed down to SQL');
  if (visualCalcPlan(spec)) unsupported('Run visual calculations through sqlEngine (it applies them after the query)');
  // plain aggregates become one GROUP BY query; anything else (ALL, time intelligence, CALCULATE replacing filters…)
  // is translated with full filter-context semantics
  try {
    return aggregatePlan(model, spec, opts);
  } catch (e) {
    if (!(e instanceof SqlUnsupportedError)) throw e;
    return contextPlan(model, spec, opts);
  }
}

function aggregatePlan(model: DataModel, spec: QuerySpec, opts: SqlOptions): SqlPlan {
  const dialect = opts.dialect ?? 'duckdb';
  const groups = (spec.groupBy ?? []).map((g) => resolveGroupField(model, g));
  const values = (spec.values ?? []).map((v) => resolveValueField(model, v));
  const filters = (spec.filters ?? []).map(toSpec);
  const highlight = (spec.highlight ?? []).map(toSpec);
  const base = factTable(model, values.map((v) => v.ast)) ?? groups[0]?.column?.table ?? unsupported('Nothing to query');
  if (!values.length && new Set(groups.map((g) => g.column!.table)).size > 1) unsupported('Grouping columns of several tables without a measure');

  const tr = new Translator(model, dialect);
  for (const g of groups) tr.touched.add(`${g.column!.table}[${g.column!.column}]`);
  const build = (extra: FilterSpec[], grouped: boolean): string => {
    const s = new Scope(model, opts, base, (sc, e) => tr.rowExpr(sc, e));
    const all = [...filters, ...extra];
    // joins in reading order: grouping columns, then values, then filters
    const gs = grouped ? groups.map((g, i) => `${s.col(g.column!)} AS g${i}`) : [];
    const vs = values.map((v) => tr.value(s, v.ast, [], all));
    const where = all.map((f) => tr.filter(s, f, all));
    const select = [...gs, ...vs.map((v, i) => `${v} AS v${i}`)];
    const parts = [`SELECT ${grouped && !values.length ? 'DISTINCT ' : ''}${select.join(', ')}`, s.from()];
    if (where.length) parts.push(`WHERE ${where.join(' AND ')}`);
    if (grouped && groups.length && values.length) {
      parts.push(`GROUP BY ${groups.map((_, i) => i + 1).join(', ')}`);
      if (!spec.includeEmpty) parts.push(`HAVING NOT (${vs.map((v) => `${v} IS NULL`).join(' AND ')})`);
    }
    if (grouped && groups.length) {
      const order: string[] = [];
      for (const o of spec.orderBy ?? []) {
        const dir = o.direction === 'desc' ? 'DESC' : 'ASC';
        let gi = -1;
        let vi = -1;
        if (typeof o.field === 'object') {
          if ('value' in o.field) vi = o.field.value;
          else gi = o.field.group;
        } else {
          gi = groups.findIndex((g) => g.ref === o.field || g.name === o.field);
          if (gi < 0) vi = values.findIndex((v) => v.name === o.field || v.ref === o.field);
        }
        if (vi >= 0 && vi < values.length) order.push(`v${vi} ${dir} NULLS LAST`);
        else if (gi >= 0) order.push(groupOrder(s, gi, dir));
      }
      groups.forEach((_, i) => order.push(groupOrder(s, i, 'ASC')));
      parts.push(`ORDER BY ${order.join(', ')}`);
      const cap = Math.min(spec.top ?? Infinity, (spec.limit ?? 30_000) + 1);
      if (Number.isFinite(cap)) parts.push(`LIMIT ${cap}`);
    }
    return parts.join('\n');
  };
  // honour "sort by column": order a month name by its month number
  const groupOrder = (s: Scope, i: number, dir: string) => {
    const g = groups[i].column!;
    const sortBy = model.table(g.table).column(g.column).sortBy;
    const key = sortBy ? (values.length ? `MIN(${s.col({ table: g.table, column: sortBy })})` : s.col({ table: g.table, column: sortBy })) : `g${i}`;
    return `${key} ${dir} NULLS FIRST`;
  };
  const sql = build([], true);
  return {
    sql,
    totals: spec.totals && values.length ? build([], false) : undefined,
    highlight: highlight.length && values.length ? build(highlight, groups.length > 0) : undefined,
    groups,
    values: values.map(({ ast: _a, ...v }) => v),
    limit: groups.length ? (spec.limit ?? 30_000) : undefined,
    mode: 'aggregate',
  };
}

// ---------------------------------------------------------------- engine

/** Executes SQL and returns rows as objects keyed by column alias (or as arrays in select order). */
export type SqlRunner = (sql: string, signal?: AbortSignal) => Promise<(Record<string, unknown> | unknown[])[]>;

export interface SqlEngineOptions extends SqlOptions {
  run: SqlRunner;
  /** What to do with queries SQL can't express: `'error'` (default) or `'model'` to answer them from the in-memory model. */
  fallback?: 'error' | 'model';
  /** Called with each SQL statement before it runs (logging, debugging). */
  onSql?: (sql: string) => void;
}

function normalize(v: unknown, field: QueryField | undefined): CellValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'bigint') return Number(v);
  if (field?.type === 'date') return toLocalDate(v) ?? (v as CellValue);
  if (v instanceof Date) return v;
  if (typeof v === 'string' && field && (field.kind === 'value' || field.type === 'number') && field.type !== 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  if (typeof v === 'object' && v !== null && 'valueOf' in v && typeof (v as { valueOf: () => unknown }).valueOf() === 'number') return (v as { valueOf: () => number }).valueOf();
  return v as CellValue;
}

const cell = (row: Record<string, unknown> | unknown[], name: string, index: number) => (Array.isArray(row) ? row[index] : row[name]);

/**
 * A query engine (for `ReportOptions.engine`) that answers visual queries with SQL. Keep the model's schema,
 * relationships and measures in memory (dimension tables may hold their rows for slicers); the fact table can be
 * empty locally and live only in the database.
 */
export function sqlEngine(model: DataModel, opts: SqlEngineOptions) {
  const runPlan = async (spec: QuerySpec, signal?: AbortSignal) => {
    const plan = toSql(model, spec, opts);
    const exec = (sql: string) => (opts.onSql?.(sql), opts.run(sql, signal));
    const [main, totals, hl] = await Promise.all([exec(plan.sql), plan.totals ? exec(plan.totals) : null, plan.highlight ? exec(plan.highlight) : null]);
    const ng = plan.groups.length;
    const toRow = (r: Record<string, unknown> | unknown[]): QueryRow => ({
      keys: plan.groups.map((g, i) => normalize(cell(r, `g${i}`, i), g)),
      values: plan.values.map((v, i) => normalize(cell(r, `v${i}`, ng + i), v)),
    });
    let rows = main.map(toRow);
    if (!ng && !plan.values.length) rows = [];
    if (!ng && plan.values.length && !rows.length) rows = [{ keys: [], values: plan.values.map(() => null) }];
    let truncated = false;
    if (plan.limit !== undefined && spec.top === undefined && rows.length > plan.limit) {
      rows = rows.slice(0, plan.limit);
      truncated = true;
    }
    if (hl) {
      const byKey = new Map(hl.map((r) => {
        const row = toRow(r);
        return [JSON.stringify(row.keys), row.values] as const;
      }));
      for (const r of rows) r.highlights = byKey.get(JSON.stringify(r.keys)) ?? plan.values.map(() => null);
    }
    return {
      groups: plan.groups,
      values: plan.values,
      rows,
      totals: totals ? plan.values.map((v, i) => normalize(cell(totals[0] ?? {}, `v${i}`, i), v)) : undefined,
      truncated,
      baseFilters: (spec.filters ?? []).map(toSpec),
    };
  };
  return {
    /** The SQL a query would run (for logging and tests). */
    toSql: (spec: QuerySpec) => toSql(model, spec, opts),
    async query(spec: QuerySpec, signal?: AbortSignal): Promise<Omit<QueryResult, 'baseFilters'> & { baseFilters: readonly unknown[] }> {
      try {
        const calc = visualCalcPlan(spec);
        return calc ? calc.finish(await runPlan(calc.spec, signal)) : await runPlan(spec, signal);
      } catch (e) {
        if (e instanceof SqlUnsupportedError && opts.fallback === 'model') return model.query(spec);
        throw e;
      }
    },
  };
}

/** A runner for a DuckDB connection: DuckDB-Wasm's `AsyncDuckDBConnection`, or anything whose `query(sql)` returns an Arrow table or rows. */
export function duckdbRunner(conn: { query(sql: string): Promise<unknown> }): SqlRunner {
  return async (sql) => {
    const res = (await conn.query(sql)) as { toArray?: () => unknown[] } | unknown[];
    const rows = Array.isArray(res) ? res : (res.toArray?.() ?? []);
    return rows.map((r) => (r && typeof r === 'object' && 'toJSON' in r && typeof (r as { toJSON: unknown }).toJSON === 'function' ? (r as { toJSON: () => Record<string, unknown> }).toJSON() : (r as Record<string, unknown>)));
  };
}
