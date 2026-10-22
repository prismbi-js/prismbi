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
  /** Grand totals (`spec.totals`), when they need their own statement. */
  totals?: string;
  /**
   * The grand-totals row comes back inside `sql` (`GROUPING SETS`, DuckDB and Postgres): it is the row whose
   * `gt` column is 1, ordered first.
   */
  totalsInline?: boolean;
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

/** A relationship to join along instead of the active one between the same tables (USERELATIONSHIP). */
interface RelSwap {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

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
    /** Relationships that replace the active one between the same two tables. */
    private rels: RelSwap[] = [],
  ) {
    this.aliases.set(base, `${prefix}0`);
  }

  table(name: string): string {
    return quoteIdent(this.opts.tables?.[name] ?? name);
  }

  private alias(table: string): string {
    const known = this.aliases.get(table);
    if (known) return known;
    let path: RelSwap[] | undefined = this.model.pathTo(this.base, table);
    // an inactive relationship turned on by USERELATIONSHIP may be the only link
    if (!path) path = this.rels.filter((r) => r.fromTable === this.base && r.toTable === table).slice(0, 1);
    if (!path.length && this.base !== table) unsupported(`No many-to-one relationship path from ${this.base} to ${table}`);
    let alias = `${this.prefix}0`;
    for (const step of path) {
      const rel = this.rels.find((r) => r.fromTable === step.fromTable && r.toTable === step.toTable) ?? step;
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
  /** `security` entries (row-level security) survive ALL / REMOVEFILTERS. */
  kind: 'base' | 'group' | 'calc' | 'security';
  /** USERELATIONSHIP: join along this relationship instead (not a predicate). */
  rel?: RelSwap;
  /** CROSSFILTER: whether this relationship filters both ways here (not a predicate). */
  cross?: { fromTable: string; toTable: string; mode: 'both' | 'oneway' | 'none' };
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

  /**
   * Scalars that depend only on the group (not on fact rows), such as the first and last date in context, are
   * computed once per group in a layer around the group combinations and referenced as `c.hN`. Databases without
   * subquery decorrelation (SQLite) would otherwise evaluate them once per fact row.
   */
  private hoisted = new Map<string, string>();
  hoistTo: 'groups' | null = null;
  hoist(sql: string): string {
    // only group-correlated scalars can move out (Top N scores correlate with their own member rows)
    if (this.hoistTo !== 'groups' || sql.includes('tn.m')) return sql;
    let name = this.hoisted.get(sql);
    if (!name) {
      name = `h${this.hoisted.size}`;
      this.hoisted.set(sql, name);
    }
    return `c.${name}`;
  }

  /** Number of grouping columns of the query being built (for hoisted sets). */
  groupCount = 0;
  private sets = new Map<string, string>();

  /** The hoisted scalars (`expr AS hN` select items) and sets (`[query, name]`) of the last build, and reset. */
  takeHoisted(): { scalars: string[]; sets: [string, string][] } {
    const out = { scalars: [...this.hoisted].map(([sql, name]) => `${sql} AS ${name}`), sets: [...this.sets] };
    this.hoisted.clear();
    this.sets.clear();
    return out;
  }

  /**
   * "The current row of `s` is one of the rows of `table` (under `inner`) that satisfy `cond`", for FILTER
   * conditions with measures. When grouping, the set is computed once per group in a materialized CTE and each fact
   * row only does a lookup; the measure inside runs per member row, not per fact row.
   */
  private membership(s: Scope, table: string, row: { table: string; column: string }[], inner: CtxEntry[], cond: (y: Scope) => string): string {
    const y = this.scope(table, inner);
    const keys = row.map((c) => y.col(c));
    const preds = [...this.filterPreds(table, inner, y), cond(y)];
    const lhs = row.length === 1 ? s.col(row[0]) : `(${row.map((c) => s.col(c)).join(', ')})`;
    if (this.hoistTo !== 'groups') return `${lhs} IN (SELECT ${keys.join(', ')}\n${y.from()}\nWHERE ${preds.join(' AND ')})`;
    return `${lhs} IN ${this.groupSet(keys, y.from(), preds)}`;
  }

  /**
   * A set that depends only on the group, computed once per group: `SELECT c.g…, keys… FROM hz AS c CROSS JOIN
   * <from> WHERE <preds>` becomes a materialized CTE, and this returns `(SELECT k… FROM hsN WHERE <this group>)`.
   */
  private groupSet(keys: string[], from: string, preds: string[]): string {
    const g = Array.from({ length: this.groupCount }, (_, i) => i);
    const sql = `SELECT ${[...g.map((i) => `c.g${i}`), ...keys.map((k, i) => `${k} AS k${i}`)].join(', ')}\nFROM hz AS c CROSS JOIN ${from.replace(/^FROM /, '')}${preds.length ? `\nWHERE ${preds.join(' AND ')}` : ''}`;
    let name = this.sets.get(sql);
    if (!name) {
      name = `hs${this.sets.size}`;
      this.sets.set(sql, name);
    }
    const match = g.map((i) => this.isNotDistinct(`${name}.g${i}`, `c.g${i}`));
    return `(SELECT ${keys.map((_, i) => `${name}.k${i}`).join(', ')} FROM ${name}${match.length ? ` WHERE ${match.join(' AND ')}` : ''})`;
  }

  /** Whether a condition needs a per-row context transition (a measure or CALCULATE). */
  private transitions(e: Expr): boolean {
    if (e.type === 'bracket') return this.model.hasMeasure(e.name);
    if (e.type === 'call') return e.name.toUpperCase() === 'CALCULATE' || e.args.some((x) => this.transitions(x));
    if (e.type === 'binary') return this.transitions(e.left) || this.transitions(e.right);
    if (e.type === 'unary') return this.transitions(e.operand);
    return false;
  }

  scope(table: string, ctx: CtxEntry[] = []): Scope {
    const rels = ctx.flatMap((e) => (e.rel ? [e.rel] : []));
    return new Scope(this.model, this.opts, table, (sc, e) => this.tr.rowExpr(sc, e), `q${++this.seq}_`, rels);
  }

  isNotDistinct(a: string, b: string): string {
    return this.dialect === 'sqlite' ? `${a} IS ${b}` : `${a} IS NOT DISTINCT FROM ${b}`;
  }

  /**
   * The tables whose filters reach `table` along many-to-one relationships, without the ones CROSSFILTER(…, NONE)
   * switches off in `ctx`.
   */
  private expandedIn(table: string, ctx: CtxEntry[]): Set<string> {
    // the innermost CROSSFILTER for a relationship wins
    const modes = new Map<string, string>();
    for (const e of ctx) if (e.cross) modes.set(`${e.cross.fromTable}|${e.cross.toTable}`, e.cross.mode);
    const off = new Set([...modes].filter(([, m]) => m === 'none').map(([k]) => k));
    if (!off.size) return this.model.expanded(table);
    const out = new Set([table]);
    const queue = [table];
    while (queue.length)
      for (const r of this.model.outgoing(queue.shift()!))
        if (!off.has(`${r.fromTable}|${r.toTable}`) && !out.has(r.toTable)) {
          out.add(r.toTable);
          queue.push(r.toTable);
        }
    return out;
  }

  private reaches(table: string, e: CtxEntry, ctx: CtxEntry[] = []): boolean {
    const exp = this.expandedIn(table, ctx);
    return e.tables.every((t) => exp.has(t));
  }

  /** Entries that filter `table` (directly or through its many-to-one relationships). */
  applicable(table: string, ctx: CtxEntry[]): CtxEntry[] {
    return ctx.filter((e) => this.reaches(table, e, ctx));
  }

  /**
   * The predicates that filter `table` in scope `s`: the entries reaching it along many-to-one relationships, plus,
   * for each bidirectional relationship whose "one" side is in its expanded table, the filters that reach the "many"
   * side but not `table`, flowing back as `key IN (SELECT foreign key FROM many side WHERE …)`.
   */
  filterPreds(table: string, ctx: CtxEntry[], s: Scope, seen: ReadonlySet<string> = new Set([table])): string[] {
    const pred = (e: CtxEntry) => !e.rel && !e.cross;
    const out = this.applicable(table, ctx).filter(pred).map((e) => e.build(s));
    const exp = this.expandedIn(table, ctx);
    for (const r of this.model.relationships()) {
      // CROSSFILTER in CALCULATE overrides the model's direction (the innermost one wins)
      const over = ctx.filter((e) => e.cross?.fromTable === r.fromTable && e.cross.toTable === r.toTable).pop()?.cross;
      if (!r.active || !(over ? over.mode === 'both' : r.crossFilter === 'both') || !exp.has(r.toTable) || seen.has(r.fromTable)) continue;
      if (!ctx.some((e) => pred(e) && this.reaches(r.fromTable, e, ctx) && !this.reaches(table, e, ctx))) continue;
      const y = this.scope(r.fromTable, ctx);
      const inner = this.filterPreds(r.fromTable, ctx, y, new Set([...seen, r.fromTable]));
      out.push(`${s.col({ table: r.toTable, column: r.toColumn })} IN (SELECT ${y.col({ table: r.fromTable, column: r.fromColumn })}
${y.from()}
WHERE ${inner.join(' AND ')})`);
    }
    return out;
  }

  /** `(SELECT <select> FROM table … WHERE <filters in ctx that reach table>)`. */
  subquery(table: string, select: (s: Scope) => string, ctx: CtxEntry[], extra: ((s: Scope) => string)[] = []): string {
    const s = this.scope(table, ctx);
    const sel = select(s);
    const preds = [...this.filterPreds(table, ctx, s), ...extra.map((f) => f(s))];
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

  daysBetween(a: string, b: string): string {
    if (this.dialect === 'sqlite') return `CAST(julianday(${b}) - julianday(${a}) AS INTEGER)`;
    if (this.dialect === 'postgres') return `(${b} - ${a})`;
    return `date_diff('day', ${a}, ${b})`;
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
      const s = this.scope(date.table, ctx);
      const x = s.col(date);
      const preds = [...this.filterPreds(date.table, ctx, s), ...more(x)];
      return `(SELECT ${select(x)}\n${s.from()}${preds.length ? `\nWHERE ${preds.join(' AND ')}` : ''})`;
    };
    // the sets depend only on the group: when grouping, materialize them once per group (databases without
    // subquery decorrelation, like SQLite, would otherwise rebuild them for every fact row)
    const setOf = (select: (x: string) => string, more: (x: string) => string[] = () => []) => {
      if (this.hoistTo !== 'groups') return set(select, more);
      const y = this.scope(date.table, ctx);
      const x = y.col(date);
      const preds = [...this.filterPreds(date.table, ctx, y), ...more(x)];
      // a set the group doesn't filter is uncorrelated already: the database computes it once
      if (!preds.some((p) => /\bc\.g\d/.test(p))) return set(select, more);
      return this.groupSet([select(x)], y.from(), preds);
    };
    const direct = setOf((x) => this.shift(x, n, unit));
    const monthEnds = setOf((x) => x, (x) => [`${x} = ${this.monthEnd(x)}`]);
    const general = (col: string) => {
      if (unit === 'day') return `${col} IN ${direct}`;
      // the context month-end that col would extend: the last day of col's month shifted back
      const me = this.monthEnd(this.shift(col, -n, unit));
      return `(${col} IN ${direct} OR (${me} IN ${monthEnds} AND ${this.shift(me, n, unit)} < ${col}))`;
    };
    // the usual case: the dates in context are one unbroken range (a year, a month, a date filter), so the shifted
    // dates are a range too, checked with scalars that are computed once per group
    const min = this.hoist(set((x) => `MIN(${x})`));
    const max = this.hoist(set((x) => `MAX(${x})`));
    const count = this.hoist(set(() => 'COUNT(*)'));
    const hi = unit === 'day' ? this.shift(max, n, unit) : `(CASE WHEN ${max} = ${this.monthEnd(max)} THEN ${this.monthEnd(this.shift(max, n, unit))} ELSE ${this.shift(max, n, unit)} END)`;
    const contiguous = `${count} = ${this.daysBetween(min, max)} + 1`;
    return (col) => `(CASE WHEN ${contiguous} THEN ${col} >= ${this.shift(min, n, unit)} AND ${col} <= ${hi} ELSE ${general(col)} END)`;
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
    const max = this.hoist(this.dates(date, ctx, (x) => `MAX(${x})`));
    const min = this.hoist(this.dates(date, ctx, (x) => `MIN(${x})`));
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

  /** Columns that identify a row of a table: its key on the one side of a relationship, else every stored column. */
  private keyCols(table: string): { table: string; column: string }[] {
    const rel = this.model.relationships().find((r) => r.toTable === table);
    if (rel) return [{ table, column: rel.toColumn }];
    return [...this.model.table(table).columns.values()].filter((c) => !c.expression).map((c) => ({ table, column: c.name }));
  }

  /**
   * The table a table expression iterates, how it changes the filters on it (ALL removes them), and the columns
   * that identify one of its rows (for context transition in the condition).
   */
  private tableArg(e: Expr, ctx: CtxEntry[]): { table: string; ctx: CtxEntry[]; row: { table: string; column: string }[] } {
    if (e.type === 'table') return { table: e.name, ctx, row: this.keyCols(e.name) };
    if (e.type === 'call') {
      const n = e.name.toUpperCase();
      const x = e.args[0];
      if (n === 'ALL' || n === 'REMOVEFILTERS' || n === 'ALLSELECTED') {
        if (x?.type === 'table') return { table: x.name, ctx: this.applyOne(e, ctx), row: this.keyCols(x.name) };
        if (x?.type === 'column') return { table: x.table, ctx: this.applyOne(e, ctx), row: e.args.filter((c) => c.type === 'column').map((c) => ({ table: (c as { table: string }).table, column: (c as { column: string }).column })) };
        return unsupported(`${n}() inside FILTER needs a table or column`);
      }
      if (n === 'VALUES' || n === 'DISTINCT') {
        if (x?.type === 'table') return { table: x.name, ctx, row: this.keyCols(x.name) };
        if (x?.type === 'column') return { table: x.table, ctx, row: [{ table: x.table, column: x.column }] };
      }
    }
    return unsupported('FILTER over this table expression is not pushed down to SQL');
  }

  /**
   * Context transition for a row of the table FILTER iterates: the outer filters, with the row's identifying
   * columns fixed to the current row of scope `s` (a correlated reference).
   */
  private transition(outer: CtxEntry[], row: { table: string; column: string }[], s: Scope): CtxEntry[] {
    const keys = row.map(colKey);
    return [
      ...outer.filter((e) => e.kind === 'security' || !e.cols.some((c) => keys.includes(c))),
      ...row.map((c): CtxEntry => ({ kind: 'calc', cols: [colKey(c)], tables: [c.table], build: (z) => this.isNotDistinct(z.col(c), s.col(c)) })),
    ];
  }

  /** Row-level security can't be removed by ALL / REMOVEFILTERS / time intelligence: put it back. */
  private secure(before: CtxEntry[], after: CtxEntry[]): CtxEntry[] {
    const sec = before.filter((e) => e.kind === 'security');
    return sec.length ? [...after.filter((e) => e.kind !== 'security'), ...sec] : after;
  }

  /** Apply one CALCULATE filter argument to a context. */
  applyOne(f: Expr, ctx: CtxEntry[], keep = false): CtxEntry[] {
    return this.secure(ctx, this.applyRaw(f, ctx, keep));
  }

  private applyRaw(f: Expr, ctx: CtxEntry[], keep: boolean): CtxEntry[] {
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
        const { table, ctx: inner, row } = this.tableArg(a[0], ctx);
        const cond = a[1];
        const cols = this.columnsIn(cond).filter((c) => c.table === table || this.model.expanded(table).has(c.table));
        // aggregates in the condition (e.g. MAX(Date[Date])) see the context outside FILTER; measures transition per row
        if (this.transitions(cond)) return [...inner, { kind: 'calc', cols: [], tables: [table], build: (s) => this.membership(s, table, row, inner, (y) => this.rowCond(y, cond, ctx, row)) }];
        return [...inner, { kind: 'calc', cols: [], tables: [table, ...cols.map((c) => c.table)], build: (s) => this.rowCond(s, cond, ctx, row) }];
      }
      if (n === 'USERELATIONSHIP') {
        const [x, y] = a;
        if (x?.type !== 'column' || y?.type !== 'column') return unsupported('USERELATIONSHIP needs two columns');
        const hit = (r: RelSwap, p: { table: string; column: string }, q: { table: string; column: string }) => r.fromTable === p.table && r.fromColumn === p.column && r.toTable === q.table && r.toColumn === q.column;
        const r = this.model.relationships().find((rr) => hit(rr, x, y) || hit(rr, y, x)) ?? unsupported(`USERELATIONSHIP: no relationship between ${x.table}[${x.column}] and ${y.table}[${y.column}]`);
        const rel: RelSwap = { fromTable: r.fromTable, fromColumn: r.fromColumn, toTable: r.toTable, toColumn: r.toColumn };
        return [...ctx.filter((e) => !(e.rel && e.rel.fromTable === rel.fromTable && e.rel.toTable === rel.toTable)), { kind: 'calc', cols: [], tables: [], rel, build: () => 'TRUE' }];
      }
      if (n === 'CROSSFILTER') {
        const [x, y, d] = a;
        if (x?.type !== 'column' || y?.type !== 'column') return unsupported('CROSSFILTER needs two columns');
        const dir = d?.type === 'table' || d?.type === 'varRef' ? d.name.toUpperCase() : d?.type === 'string' ? d.value.toUpperCase() : '';
        const hit = (r: RelSwap, p: { table: string; column: string }, q: { table: string; column: string }) => r.fromTable === p.table && r.fromColumn === p.column && r.toTable === q.table && r.toColumn === q.column;
        const r = this.model.relationships().find((rr) => rr.active && (hit(rr, x, y) || hit(rr, y, x))) ?? unsupported(`CROSSFILTER: no active relationship between ${x.table}[${x.column}] and ${y.table}[${y.column}]`);
        return [...ctx, { kind: 'calc', cols: [], tables: [], cross: { fromTable: r.fromTable, toTable: r.toTable, mode: dir === 'BOTH' ? 'both' : dir === 'NONE' ? 'none' : 'oneway' }, build: () => 'TRUE' }];
      }
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
  rowCond(s: Scope, e: Expr, outer: CtxEntry[], row?: { table: string; column: string }[]): string {
    const rec = (x: Expr) => this.rowCond(s, x, outer, row);
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
        if (n === 'USERNAME' || n === 'USERPRINCIPALNAME') return this.tr.literal(this.model.currentUser);
        if (n === 'CUSTOMDATA') return this.tr.literal(this.model.customData);
        // CALCULATE in a row context transitions the row into filters
        if (n === 'CALCULATE' && row) return this.value(e, this.transition(outer, row, s));
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
        // a measure in a row context: evaluated with the row's identity as filters (context transition)
        if (this.model.hasMeasure(e.name)) return row ? `(${this.value(parseDax(this.model.measure(e.name).expression), this.transition(outer, row, s))})` : unsupported(`[${e.name}] outside a row context in a filter condition`);
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
          const { table, ctx: inner, row } = this.tableArg(t.args[0], ctx);
          return `NULLIF(${this.subquery(table, () => 'COUNT(*)', inner, [(s) => this.rowCond(s, t.args[1], ctx, row)])}, 0)`;
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
          const { table, ctx: inner, row } = this.tableArg(t.args[0], ctx);
          return this.subquery(table, (s) => `${fn}(${this.tr.rowExpr(s, a[1])})`, inner, [(s) => this.rowCond(s, t.args[1], ctx, row)]);
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
        return rec(a[0], this.secure(ctx, this.timeFilter(n.replace('TOTAL', 'DATES'), [a[1]], ctx)));
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
  // row-level security: per table, the rows any active role allows (as the in-memory engine); ALL can't remove it
  const roles = model.activeRoleNames.length ? (model.toJSON().roles as Record<string, Record<string, string>>) : {};
  const ruleTables = new Map<string, string[]>();
  for (const role of model.activeRoleNames) for (const [table, rule] of Object.entries(roles[role] ?? {})) ruleTables.set(table, [...(ruleTables.get(table) ?? []), rule]);
  const securityEntries: CtxEntry[] = [...ruleTables].map(([table, rules]) => ({ kind: 'security', cols: [], tables: [table], build: (s) => `(${rules.map((r) => `COALESCE(${cx.rowCond(s, parseDax(r), [])}, FALSE)`).join(' OR ')})` }));
  const baseEntries = [...securityEntries, ...filters.map((f) => entryOf(f, filters, () => cx))];
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
    const hoisting = grouped && groups.length > 0;
    cx.hoistTo = hoisting ? 'groups' : null;
    cx.groupCount = groups.length;
    const vs = values.map((v) => cx.value(v.ast, ctx));
    cx.hoistTo = null;
    const { scalars: hoisted, sets } = cx.takeHoisted();
    if (!hoisting) return `SELECT ${vs.map((v, i) => `${v} AS v${i}`).join(', ') || 'NULL AS v0'}`;
    const cols = [...groups.map((_, i) => `c.g${i}`), ...vs.map((v, i) => `${v} AS v${i}`), ...sortCols.flatMap((sc, i) => (sc ? [`c.s${i}`] : []))];
    // group-only scalars are computed once per group, in a layer around the combinations
    // (a materialized CTE, so SQLite's query flattener doesn't inline them back into every fact row)
    // FILTER sets with measures are materialized per group as well
    const mat = dialect === 'duckdb' ? '' : 'MATERIALIZED ';
    const ctes = hoisted.length || sets.length ? [`hz AS ${mat}(SELECT c.*${hoisted.length ? `, ${hoisted.join(',\n  ')}` : ''}\nFROM ${combos} AS c)`, ...sets.map(([sql, name]) => `${name} AS ${mat}(${sql})`)] : [];
    const withClause = ctes.length ? `WITH ${ctes.join(',\n')}\n` : '';
    const parts = [`${withClause}SELECT * FROM (SELECT ${cols.join(', ')}\nFROM ${ctes.length ? 'hz' : combos} AS c) AS r`];
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
  if (model.activeRoleNames.length) unsupported('Row-level security is applied in filter-context mode');
  const dialect = opts.dialect ?? 'duckdb';
  const groups = (spec.groupBy ?? []).map((g) => resolveGroupField(model, g));
  const values = (spec.values ?? []).map((v) => resolveValueField(model, v));
  const filters = (spec.filters ?? []).map(toSpec);
  const highlight = (spec.highlight ?? []).map(toSpec);
  const base = factTable(model, values.map((v) => v.ast)) ?? groups[0]?.column?.table ?? unsupported('Nothing to query');
  if (!values.length && new Set(groups.map((g) => g.column!.table)).size > 1) unsupported('Grouping columns of several tables without a measure');

  const tr = new Translator(model, dialect);
  for (const g of groups) tr.touched.add(`${g.column!.table}[${g.column!.column}]`);
  // DuckDB and Postgres return the grand totals with the grouped rows (one round trip); SQLite runs a second statement
  const inline = !!spec.totals && values.length > 0 && groups.length > 0 && dialect !== 'sqlite';
  const build = (extra: FilterSpec[], grouped: boolean, withTotals = false): string => {
    const s = new Scope(model, opts, base, (sc, e) => tr.rowExpr(sc, e));
    const all = [...filters, ...extra];
    // joins in reading order: grouping columns, then values, then filters
    const gs = grouped ? groups.map((g, i) => `${s.col(g.column!)} AS g${i}`) : [];
    const vs = values.map((v) => tr.value(s, v.ast, [], all));
    const where = all.map((f) => tr.filter(s, f, all));
    const select = [...gs, ...vs.map((v, i) => `${v} AS v${i}`)];
    if (withTotals) select.push(`GROUPING(${s.col(groups[0].column!)}) AS gt`);
    const parts = [`SELECT ${grouped && !values.length ? 'DISTINCT ' : ''}${select.join(', ')}`, s.from()];
    if (where.length) parts.push(`WHERE ${where.join(' AND ')}`);
    if (grouped && groups.length && values.length) {
      parts.push(withTotals ? `GROUP BY GROUPING SETS ((${groups.map((g) => s.col(g.column!)).join(', ')}), ())` : `GROUP BY ${groups.map((_, i) => i + 1).join(', ')}`);
      if (!spec.includeEmpty) parts.push(`HAVING NOT (${vs.map((v) => `${v} IS NULL`).join(' AND ')})`);
    }
    if (grouped && groups.length) {
      const order: string[] = withTotals ? ['gt DESC'] : [];
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
      const cap = Math.min(spec.top ?? Infinity, (spec.limit ?? 30_000) + 1) + (withTotals ? 1 : 0);
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
  const sql = build([], true, inline);
  return {
    sql,
    totals: spec.totals && values.length && !inline ? build([], false) : undefined,
    totalsInline: inline || undefined,
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
  /**
   * Cache results by SQL text: identical statements (a visual re-rendering, two visuals asking the same thing,
   * concurrent duplicates) run once. Cleared when the model changes and by `clearCache()`; `ttlMs` bounds how
   * stale a cached answer may get when the database changes underneath. `true` means `{ max: 200 }`.
   */
  cache?: boolean | { max?: number; ttlMs?: number };
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
  type Rows = Awaited<ReturnType<SqlRunner>>;
  const cacheOpts = opts.cache === true ? {} : opts.cache || undefined;
  const max = cacheOpts?.max ?? 200;
  const cache = new Map<string, { at: number; rows: Promise<Rows> }>();
  const clearCache = () => cache.clear();
  const unsubscribe = cacheOpts ? model.onChange(clearCache) : undefined;
  const exec = (sql: string, signal?: AbortSignal): Promise<Rows> => {
    if (!cacheOpts) return (opts.onSql?.(sql), opts.run(sql, signal));
    const hit = cache.get(sql);
    if (hit && (cacheOpts.ttlMs === undefined || Date.now() - hit.at < cacheOpts.ttlMs)) {
      // most recently used goes last
      cache.delete(sql);
      cache.set(sql, hit);
      return signal ? abortable(hit.rows, signal) : hit.rows;
    }
    opts.onSql?.(sql);
    // shared by concurrent callers, so one caller's abort must not cancel the others
    const rows = opts.run(sql);
    const entry = { at: Date.now(), rows };
    cache.set(sql, entry);
    rows.catch(() => cache.get(sql) === entry && cache.delete(sql));
    while (cache.size > max) cache.delete(cache.keys().next().value!);
    return signal ? abortable(rows, signal) : rows;
  };
  const runPlan = async (spec: QuerySpec, signal?: AbortSignal) => {
    const plan = toSql(model, spec, opts);
    const [main, totals, hl] = await Promise.all([exec(plan.sql, signal), plan.totals ? exec(plan.totals, signal) : null, plan.highlight ? exec(plan.highlight, signal) : null]);
    const ng = plan.groups.length;
    const toRow = (r: Record<string, unknown> | unknown[]): QueryRow => ({
      keys: plan.groups.map((g, i) => normalize(cell(r, `g${i}`, i), g)),
      values: plan.values.map((v, i) => normalize(cell(r, `v${i}`, ng + i), v)),
    });
    let inlineTotals: Record<string, unknown> | unknown[] | undefined;
    let mainRows = main;
    if (plan.totalsInline) {
      // the totals row is ordered first; its GROUPING() flag is the column after the values
      const flag = (r: Record<string, unknown> | unknown[]) => Number(cell(r, 'gt', ng + plan.values.length)) === 1;
      if (main.length && flag(main[0])) {
        inlineTotals = main[0];
        mainRows = main.slice(1);
      }
    }
    let rows = mainRows.map(toRow);
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
      totals: totals ? plan.values.map((v, i) => normalize(cell(totals[0] ?? {}, `v${i}`, i), v)) : plan.totalsInline ? plan.values.map((v, i) => normalize(inlineTotals ? cell(inlineTotals, `v${i}`, ng + i) : null, v)) : undefined,
      truncated,
      baseFilters: (spec.filters ?? []).map(toSpec),
    };
  };
  return {
    /** The SQL a query would run (for logging and tests). */
    toSql: (spec: QuerySpec) => toSql(model, spec, opts),
    /** Forget cached results (`cache` option), e.g. after the database was reloaded. */
    clearCache,
    /** Stop listening to the model (only needed with `cache`). */
    dispose: () => (unsubscribe?.(), clearCache()),
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

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** A runner for a DuckDB connection: DuckDB-Wasm's `AsyncDuckDBConnection`, or anything whose `query(sql)` returns an Arrow table or rows. */
export function duckdbRunner(conn: { query(sql: string): Promise<unknown> }): SqlRunner {
  return async (sql) => {
    const res = (await conn.query(sql)) as { toArray?: () => unknown[] } | unknown[];
    const rows = Array.isArray(res) ? res : (res.toArray?.() ?? []);
    return rows.map((r) => (r && typeof r === 'object' && 'toJSON' in r && typeof (r as { toJSON: unknown }).toJSON === 'function' ? (r as { toJSON: () => Record<string, unknown> }).toJSON() : (r as Record<string, unknown>)));
  };
}
