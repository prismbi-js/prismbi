import { applyRefreshPolicy, type IncrementalRefreshResult, type RefreshPolicy } from './refreshPolicy';
import type { CellValue, ColumnRef, ColumnSchema, DataType, MeasureDef, RelationshipDef, Row } from './types';
import { columnRefToString, isColumnRefString, parseColumnRef, valueKey } from './types';
import { DataTable } from './table';
import { generateDateTable } from './dates';
import type { DateTableOptions } from './dates';
import type { ColumnsFilter, Filter, FilterContext, FilterSpec, RelFilter, RowsFilter } from './filters';
import { compileFilter, contextKey } from './filters';
import type { Expr } from '../dax/ast';
import { parseDax } from '../dax/parser';
import { Evaluator } from '../dax/evaluator';
import type { QueryResult, QuerySpec } from './query';
import { runQuery } from './query';
import { applySteps, rowLocalSteps } from './transform';
import type { TransformStep } from './transform';

export interface AppendOptions {
  /** Keep at most this many rows, dropping the oldest (sliding window). */
  maxRows?: number;
}

/** Scalar functions whose result depends only on their arguments (safe for incremental calculated columns). */
const ROW_LOCAL_FNS = new Set(
  'IF SWITCH AND OR NOT TRUE FALSE BLANK ISBLANK COALESCE DIVIDE ABS ROUND ROUNDUP ROUNDDOWN TRUNC INT CEILING FLOOR MOD POWER SQRT EXP LN LOG LOG10 SIGN DATE TIME YEAR MONTH DAY HOUR MINUTE SECOND WEEKDAY WEEKNUM QUARTER EOMONTH EDATE DATEDIFF DATEVALUE VALUE FORMAT LEFT RIGHT MID LEN UPPER LOWER TRIM CONCATENATE SUBSTITUTE REPLACE SEARCH FIND CONTAINSSTRING EXACT REPT FIXED ISNUMBER ISTEXT ISERROR IFERROR'.split(' '),
);

export interface Relationship {
  /** Position in the model (used by USERELATIONSHIP / CROSSFILTER). */
  index: number;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  crossFilter: 'single' | 'both';
  active: boolean;
  cardinality: 'manyToOne' | 'manyToMany';
}

export interface Measure extends MeasureDef {
  ast: Expr;
}

export interface FieldInfo {
  kind: 'column' | 'measure' | 'hierarchy';
  table: string;
  name: string;
  /** Reference string usable in visual field wells. */
  ref: string;
  type?: DataType;
  format?: string;
  hidden?: boolean;
  description?: string;
  folder?: string;
  /** For hierarchies: level column refs. */
  levels?: string[];
}

export interface CalculationItemDef {
  name: string;
  /** DAX using SELECTEDMEASURE(), e.g. `CALCULATE(SELECTEDMEASURE(), DATESYTD(Date[Date]))`. */
  expression: string;
  ordinal?: number;
  /** Format string for values under this item, e.g. `'0.0%'` for a YoY % item. */
  format?: string;
  /** Dynamic format: DAX returning a format string; may use SELECTEDMEASUREFORMATSTRING() and SELECTEDMEASURENAME(). */
  formatExpression?: string;
}

export interface CalculationGroupDef {
  /** Table name, e.g. "Time Intelligence". */
  name: string;
  /** Column holding item names (default "Name"). */
  column?: string;
  items: CalculationItemDef[];
  /** Higher precedence applies first when several groups are active. */
  precedence?: number;
}

export interface CalculationGroup {
  table: string;
  column: string;
  precedence: number;
  items: Map<string, { name: string; ast: Expr; format?: string; formatAst?: Expr }>;
}

export interface FieldParameterDef {
  label: string;
  /** Measure name or Table[Column]. */
  field: string;
}

export interface WhatIfParameterDef {
  min: number;
  max: number;
  step?: number;
  default?: number;
  format?: string;
}

/** What changed, when only table data did (definitions unchanged). Without it, anything may have changed. */
export interface ModelChange {
  /** Tables whose rows changed. */
  tables: string[];
}

type Listener = (change?: ModelChange) => void;

const CACHE_LIMIT = 20_000;
/** Most row indices kept in the visible-rows cache at once (about 100 MB as JS arrays). */
const ROWS_CACHE_BUDGET = 12_000_000;

interface Effective {
  rels: Relationship[];
  key: string;
}

/**
 * The semantic model: tables, relationships, measures, calculated columns and tables, calculation
 * groups, parameters, hierarchies, perspectives and row-level security.
 *
 * Filters flow from the one side (`to`) to the many side (`from`) of each active relationship, and
 * back again for `crossFilter: 'both'`. Many-to-many relationships propagate filters but don't allow RELATED.
 */
export class DataModel {
  private tables = new Map<string, DataTable>();
  private rels: Relationship[] = [];
  private measures = new Map<string, Measure>();
  private expandedCache = new Map<string, Set<string>>();
  private reachCache = new Map<string, Set<string>>();
  private effectiveCache = new Map<string, Effective>();
  private rowsCache = new Map<string, number[]>();
  /** Row indices held by `rowsCache`, bounded by ROWS_CACHE_BUDGET. */
  private rowsCached = 0;
  private allRowsCache = new Map<string, number[]>();
  private pathCache = new Map<string, Relationship[] | null>();
  private relatedCache = new Map<string, Int32Array | null>();
  private listeners = new Set<Listener>();
  /** While positive, changes clear caches but don't notify (one notification follows). */
  private quiet = 0;
  private calcTables = new Map<string, string>();
  /** Power Query-style steps per table, with the untransformed source rows they replay over. */
  private transforms = new Map<string, { source: Row[]; steps: TransformStep[] }>();
  private policies = new Map<string, RefreshPolicy>();
  private calcGroupMap = new Map<string, CalculationGroup>();
  private fieldParams = new Map<string, { column: string; fields: FieldParameterDef[] }>();
  private hierarchies = new Map<string, { table: string; name: string; levels: string[] }>();
  private perspectives = new Map<string, Set<string>>();
  private roles = new Map<string, Record<string, string>>();
  private activeRoles: string[] = [];
  private securityFilters: RowsFilter[] | null = null;
  private computingSecurity = false;
  /** Value returned by USERNAME() / USERPRINCIPALNAME() (set with `setRoles`). */
  currentUser = '';
  /** Value returned by CUSTOMDATA(). */
  customData = '';
  readonly evaluator: Evaluator;

  constructor() {
    this.evaluator = new Evaluator(this);
  }

  // ---------------------------------------------------------------- tables

  addTable(name: string, data: Row[] | DataTable, schema?: Record<string, ColumnSchema>): this {
    const table = data instanceof DataTable ? data : new DataTable(name, data, schema);
    if (data instanceof DataTable && data.name !== name) throw new Error(`Table name mismatch: "${name}" vs "${data.name}"`);
    this.tables.set(name, table);
    this.changed();
    return this;
  }

  /** Add a generated calendar table (see generateDateTable) – e.g. `model.addDateTable('Date', '2024-01-01', '2025-12-31')`. */
  addDateTable(name: string, start: Date | string, end: Date | string, opts?: DateTableOptions): this {
    const { rows, schema } = generateDateTable(start, end, opts);
    return this.addTable(name, rows, schema);
  }

  /** Replace a table's rows (e.g. on refresh), keeping calculated columns. Calculated tables are recomputed. */
  refreshTable(name: string, rows: Row[], schema?: Record<string, ColumnSchema>): this {
    // a transformed table treats new rows as its source and replays its steps
    const tf = this.transforms.get(name);
    if (tf) {
      tf.source = rows;
      rows = applySteps(rows, tf.steps, { lookup: (n) => this.rowsOfTable(n) });
    }
    const old = this.table(name);
    const calc = [...old.columns.values()].filter((c) => c.expression);
    const table = new DataTable(name, rows, schema);
    this.tables.set(name, table);
    this.changed();
    for (const c of calc) this.addCalculatedColumn(name, c.name, c.expression!, { format: c.format, type: c.type, hidden: c.hidden });
    this.recalculateTables();
    return this;
  }

  /** Set (or clear with null) a table's incremental refresh policy, used by {@link incrementalRefresh}. */
  setRefreshPolicy(name: string, policy: RefreshPolicy | null): this {
    const t = this.table(name);
    if (policy) {
      if (!t.hasColumn(policy.column) && !this.transforms.get(name)?.source.some((r) => policy.column in r)) throw new Error(`Table "${name}" has no column "${policy.column}"`);
      if (!(policy.refresh.last >= 1)) throw new Error('refresh.last must be at least 1');
      this.policies.set(name, policy);
    } else this.policies.delete(name);
    return this;
  }

  refreshPolicyOf(name: string): RefreshPolicy | undefined {
    return this.policies.get(name);
  }

  /**
   * Incremental refresh: `rows` holds the latest data for the refresh window (older rows in it are ignored). Rows in
   * the window are replaced, history before it is kept, and history older than `keep` is dropped. Uses the table's
   * policy, or `policy` for this call.
   */
  incrementalRefresh(name: string, rows: Row[], opts: { policy?: RefreshPolicy; now?: Date } = {}): IncrementalRefreshResult {
    const policy = opts.policy ?? this.policies.get(name);
    if (!policy) throw new Error(`Table "${name}" has no refresh policy (setRefreshPolicy)`);
    const tf = this.transforms.get(name);
    // transformed tables keep their source rows: the policy applies to the source, then the steps replay
    const existing = tf ? tf.source : this.rowsOfTable(name, true);
    const merged = applyRefreshPolicy(existing, rows, policy, opts.now);
    const old = this.table(name);
    const schema: Record<string, ColumnSchema> = {};
    for (const c of old.columns.values()) if (!c.expression) schema[c.name] = { type: c.type, format: c.format, hidden: c.hidden, sortBy: c.sortBy, description: c.description };
    this.refreshTable(name, merged.rows, tf ? undefined : schema);
    return merged.result;
  }

  /**
   * Append rows to a table (streaming / incremental refresh). Calculated columns that only read their own row are
   * computed for the new rows; the rest are recomputed. `maxRows` keeps a sliding window by dropping the oldest rows.
   */
  appendRows(name: string, rows: Row[], opts: AppendOptions = {}): this {
    const tf = this.transforms.get(name);
    if (tf) {
      tf.source.push(...rows);
      if (opts.maxRows !== undefined && tf.source.length > opts.maxRows) tf.source.splice(0, tf.source.length - opts.maxRows);
      // whole-table steps (group, sort, pivot, …) need the full source again
      if (!rowLocalSteps(tf.steps)) return this.refreshTable(name, tf.source);
      rows = applySteps(rows, tf.steps, { lookup: (n) => this.rowsOfTable(n) });
    }
    const t = this.table(name);
    const calc = [...t.columns.values()].filter((c) => c.expression);
    const before = t.rowCount;
    const touched = new Set([name]);
    this.quiet++;
    try {
      t.appendRows(rows);
      let firstNew = before;
      if (opts.maxRows !== undefined && t.rowCount > opts.maxRows) {
        const drop = t.rowCount - opts.maxRows;
        t.removeFirst(drop);
        firstNew = Math.max(0, before - drop);
      }
      this.clearCaches();
      for (const c of calc) {
        const ast = parseDax(c.expression!);
        if (!this.rowLocal(ast, name)) {
          this.addCalculatedColumn(name, c.name, c.expression!, { format: c.format, type: c.type, hidden: c.hidden, sortBy: c.sortBy, description: c.description, folder: c.folder });
          continue;
        }
        const values = c.values;
        this.evaluator.fillColumn(ast, name, values, firstNew, t.rowCount);
        t.setColumn(c);
      }
      // calculated columns elsewhere may aggregate over this table
      for (const other of this.tables.values()) {
        if (other.name === name) continue;
        for (const c of [...other.columns.values()]) {
          if (c.expression && !this.rowLocal(parseDax(c.expression), other.name)) {
            this.clearCaches();
            this.addCalculatedColumn(other.name, c.name, c.expression, { format: c.format, type: c.type, hidden: c.hidden, sortBy: c.sortBy, description: c.description, folder: c.folder });
            touched.add(other.name);
          }
        }
      }
      for (const ct of this.calcTables.keys()) touched.add(ct);
      this.recalculateTables();
    } finally {
      this.quiet--;
    }
    this.changed({ tables: [...touched] });
    return this;
  }

  /** Does `ast` only read columns of the current row of `table` (no aggregation, measures or other tables)? */
  private rowLocal(ast: Expr, table: string): boolean {
    const walk = (e: Expr): boolean => {
      switch (e.type) {
        case 'number':
        case 'string':
        case 'boolean':
        case 'varRef':
          return true;
        case 'column':
          return e.table === table;
        case 'bracket':
          return !this.hasMeasure(e.name);
        case 'table':
          return false;
        case 'call':
          return ROW_LOCAL_FNS.has(e.name) && e.args.every(walk);
        case 'unary':
          return walk(e.operand);
        case 'binary':
          return walk(e.left) && walk(e.right);
        case 'list':
          return e.items.every(walk);
        case 'var':
          return e.bindings.every((b) => walk(b.value)) && walk(e.body);
      }
    };
    return walk(ast);
  }

  /**
   * Apply Power Query-style steps to a table (see {@link TransformStep}). The current rows, or the rows
   * given as `source`, become the source the steps replay over on every refresh and append; calling it
   * again replaces the steps. An empty list restores the source.
   */
  transformTable(name: string, steps: TransformStep[], opts: { source?: Row[] } = {}): this {
    const existing = this.transforms.get(name);
    const source = opts.source ?? existing?.source ?? this.rowsOfTable(name, true);
    if (!steps.length) {
      this.transforms.delete(name);
      return this.refreshTable(name, source);
    }
    this.transforms.set(name, { source, steps: steps.map((st) => ({ ...st })) });
    return this.refreshTable(name, source);
  }

  /** The transform steps of a table, if any. */
  transformsOf(name: string): TransformStep[] | undefined {
    const tf = this.transforms.get(name);
    return tf ? tf.steps.map((st) => ({ ...st })) : undefined;
  }

  /** The untransformed rows of a transformed table (a copy), for previews and editors. */
  sourceRowsOf(name: string): Row[] | undefined {
    return this.transforms.get(name)?.source.slice();
  }

  /** Rows of a table as objects (calculated columns optional). */
  private rowsOfTable(name: string, withoutCalculated = false): Row[] {
    const t = this.table(name);
    const rows = t.toRows();
    if (!withoutCalculated) return rows;
    const calc = [...t.columns.values()].filter((c) => c.expression).map((c) => c.name);
    if (!calc.length) return rows;
    return rows.map((r) => {
      const o = { ...r };
      for (const c of calc) delete o[c];
      return o;
    });
  }

  removeTable(name: string): this {
    this.tables.delete(name);
    this.rels = this.rels.filter((r) => r.fromTable !== name && r.toTable !== name).map((r, i) => ({ ...r, index: i }));
    this.calcTables.delete(name);
    this.calcGroupMap.delete(name);
    this.fieldParams.delete(name);
    this.changed();
    return this;
  }

  hasTable(name: string): boolean {
    return this.tables.has(name);
  }

  table(name: string): DataTable {
    const t = this.tables.get(name);
    if (!t) throw new Error(`Table "${name}" not found`);
    return t;
  }

  tableNames(): string[] {
    return [...this.tables.keys()];
  }

  /**
   * Add a table computed from a DAX table expression, e.g.
   * `addCalculatedTable('Top Products', 'TOPN(10, Products, [Total Sales])')`.
   */
  addCalculatedTable(name: string, expression: string, schema: Record<string, ColumnSchema> = {}): this {
    const { columns, rows } = this.evaluateTable(expression);
    const cols: Record<string, unknown[]> = {};
    columns.forEach((c, i) => (cols[c] = rows.map((r) => r[i])));
    const t = DataTable.fromColumns(name, cols, schema);
    this.calcTables.set(name, expression);
    this.tables.set(name, t);
    this.changed();
    return this;
  }

  /** Recompute every calculated table (after data changes). */
  recalculateTables(): this {
    for (const [name, expr] of this.calcTables) {
      const { columns, rows } = this.evaluateTable(expr);
      const cols: Record<string, unknown[]> = {};
      columns.forEach((c, i) => (cols[c] = rows.map((r) => r[i])));
      this.tables.set(name, DataTable.fromColumns(name, cols));
    }
    if (this.calcTables.size) this.changed();
    return this;
  }

  // ---------------------------------------------------------------- relationships

  addRelationship(def: RelationshipDef): this {
    const from = parseColumnRef(def.from);
    const to = parseColumnRef(def.to);
    this.table(from.table).column(from.column);
    this.table(to.table).column(to.column);
    const cardinality = def.cardinality ?? 'manyToOne';
    if (cardinality === 'manyToOne') {
      const idx = this.table(to.table).index(to.column);
      for (const rows of idx.values())
        if (rows.length > 1)
          throw new Error(`Relationship target ${columnRefToString(to)} must contain unique values (one side of a many-to-one relationship). Use cardinality: 'manyToMany' if duplicates are expected.`);
    }
    this.rels.push({
      index: this.rels.length,
      fromTable: from.table,
      fromColumn: from.column,
      toTable: to.table,
      toColumn: to.column,
      crossFilter: def.crossFilter ?? 'single',
      active: def.active ?? true,
      cardinality,
    });
    this.changed();
    return this;
  }

  relationships(): readonly Relationship[] {
    return this.rels;
  }

  /** Change a relationship's direction or active state. */
  updateRelationship(index: number, patch: Partial<Pick<Relationship, 'crossFilter' | 'active'>>): this {
    const r = this.rels[index];
    if (!r) throw new Error(`Relationship #${index} not found`);
    Object.assign(r, patch);
    this.changed();
    return this;
  }

  removeRelationship(index: number): this {
    if (!this.rels[index]) throw new Error(`Relationship #${index} not found`);
    this.rels.splice(index, 1);
    this.rels.forEach((r, i) => (r.index = i));
    this.changed();
    return this;
  }

  /** Remove a (calculated) column. */
  /** Rename a column; relationships follow. (Use `renameModelField` to also rewrite DAX and reports.) */
  renameColumn(table: string, from: string, to: string): this {
    this.table(table).renameColumn(from, to);
    this.rels = this.rels.map((r) => ({
      ...r,
      fromColumn: r.fromTable === table && r.fromColumn === from ? to : r.fromColumn,
      toColumn: r.toTable === table && r.toColumn === from ? to : r.toColumn,
    }));
    this.changed();
    return this;
  }

  removeColumn(table: string, column: string): this {
    this.table(table).removeColumn(column);
    this.rels = this.rels.filter((r) => !((r.fromTable === table && r.fromColumn === column) || (r.toTable === table && r.toColumn === column))).map((r, i) => ({ ...r, index: i }));
    this.changed();
    return this;
  }

  /** Find the relationship between two columns (either orientation). */
  findRelationship(a: ColumnRef, b: ColumnRef): Relationship | undefined {
    const same = (t: string, c: string, r: ColumnRef) => t === r.table && c === r.column;
    return this.rels.find((r) => (same(r.fromTable, r.fromColumn, a) && same(r.toTable, r.toColumn, b)) || (same(r.fromTable, r.fromColumn, b) && same(r.toTable, r.toColumn, a)));
  }

  // ---------------------------------------------------------------- measures & columns

  addMeasure(name: string, expression: string, opts?: Omit<MeasureDef, 'name' | 'expression'>): this;
  addMeasure(def: MeasureDef): this;
  addMeasure(a: string | MeasureDef, expression?: string, opts: Omit<MeasureDef, 'name' | 'expression'> = {}): this {
    const def: MeasureDef = typeof a === 'string' ? { name: a, expression: expression!, ...opts } : a;
    this.measures.set(def.name, { ...def, ast: parseDax(def.expression) });
    this.changed();
    return this;
  }

  removeMeasure(name: string): this {
    this.measures.delete(name);
    this.changed();
    return this;
  }

  hasMeasure(name: string): boolean {
    return this.measures.has(name);
  }

  measure(name: string): Measure {
    const m = this.measures.get(name);
    if (!m) throw new Error(`Measure "[${name}]" not found`);
    return m;
  }

  measureList(): Measure[] {
    return [...this.measures.values()];
  }

  /** Add a column computed per row, e.g. `addCalculatedColumn('Sales', 'Profit', 'Sales[Amount] - Sales[Cost]')`. */
  addCalculatedColumn(table: string, name: string, expression: string, opts: ColumnSchema = {}): this {
    const t = this.table(table);
    const ast = parseDax(expression);
    const values = this.evaluator.evalColumn(ast, table, t.rowCount);
    let type: DataType = opts.type ?? 'string';
    if (!opts.type) {
      const sample = values.find((v) => v !== null);
      type = typeof sample === 'number' ? 'number' : typeof sample === 'boolean' ? 'boolean' : sample instanceof Date ? 'date' : 'string';
    }
    t.setColumn({ name, type, values, format: opts.format, hidden: opts.hidden, sortBy: opts.sortBy, description: opts.description, folder: opts.folder, expression });
    this.changed();
    return this;
  }

  // ---------------------------------------------------------------- calculation groups & parameters

  /**
   * Calculation group: a table whose items rewrite whatever measure is evaluated while one item is
   * selected (slicer, filter or visual grouping), e.g. Current / YTD / Prior year / YoY %.
   */
  addCalculationGroup(def: CalculationGroupDef): this {
    const column = def.column ?? 'Name';
    const items = def.items.map((it, i) => ({ ...it, ordinal: it.ordinal ?? i }));
    this.addTable(def.name, items.map((it) => ({ [column]: it.name, Ordinal: it.ordinal })), { [column]: { type: 'string', sortBy: 'Ordinal' }, Ordinal: { type: 'number', hidden: true } });
    this.calcGroupMap.set(def.name, {
      table: def.name,
      column,
      precedence: def.precedence ?? 0,
      items: new Map(items.map((it) => [it.name, { name: it.name, ast: parseDax(it.expression), format: it.format, formatAst: it.formatExpression ? parseDax(it.formatExpression) : undefined }])),
    });
    this.changed();
    return this;
  }

  /** True when some calculation item sets a format (queries then resolve formats per context). */
  get hasCalculationFormats(): boolean {
    for (const g of this.calcGroupMap.values()) for (const it of g.items.values()) if (it.format || it.formatAst) return true;
    return false;
  }

  calculationGroups(): CalculationGroup[] {
    return [...this.calcGroupMap.values()].sort((a, b) => b.precedence - a.precedence);
  }

  /**
   * Field parameter: a table listing measures/columns; a slicer on it decides which field(s) a visual shows.
   * Bind `'<name>'[<name>]` in any field well.
   */
  addFieldParameter(name: string, fields: FieldParameterDef[], opts: { column?: string } = {}): this {
    const column = opts.column ?? name;
    for (const f of fields)
      if (!this.hasMeasure(f.field) && !(isColumnRefString(f.field) && this.resolveColumn(parseColumnRef(f.field)))) throw new Error(`Field parameter "${name}": unknown field "${f.field}"`);
    this.addTable(name, fields.map((f, i) => ({ [column]: f.label, Order: i, Field: f.field })), { [column]: { type: 'string', sortBy: 'Order' }, Order: { type: 'number', hidden: true }, Field: { type: 'string', hidden: true } });
    this.fieldParams.set(name, { column, fields });
    this.changed();
    return this;
  }

  /** If `ref` points at a field parameter, the field refs selected under `filters` (all when none selected). */
  resolveFieldParameter(ref: string, filters: readonly (FilterSpec | Filter)[] = []): string[] | null {
    if (!isColumnRefString(ref)) return null;
    const col = parseColumnRef(ref);
    const p = this.fieldParams.get(col.table);
    if (!p || col.column !== p.column) return null;
    const visible = new Set(this.valuesOf(col, this.toContext(filters)).map(String));
    return p.fields.filter((f) => visible.has(f.label)).map((f) => f.field);
  }

  /**
   * What-if parameter: a one-column table of values plus a `<name> Value` measure returning the
   * selected value (or the default). Use it in measures and drive it from a slider slicer.
   */
  addWhatIfParameter(name: string, def: WhatIfParameterDef): this {
    const step = def.step ?? 1;
    const values: number[] = [];
    for (let v = def.min; v <= def.max + step / 1e6; v += step) values.push(+v.toPrecision(12));
    this.addTable(name, values.map((v) => ({ [name]: v })), { [name]: { type: 'number', format: def.format } });
    const tableRef = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
    this.addMeasure(`${name} Value`, `SELECTEDVALUE(${tableRef}[${name}], ${def.default ?? def.min})`, { format: def.format });
    return this;
  }

  /** Named hierarchy, e.g. `addHierarchy('Date', 'Calendar', ['Year', 'Quarter', 'Month'])`. Use `Date[Calendar]` in drillable wells. */
  addHierarchy(table: string, name: string, levels: string[]): this {
    const t = this.table(table);
    for (const l of levels) t.column(l);
    this.hierarchies.set(`${table}[${name}]`, { table, name, levels: levels.map((l) => columnRefToString({ table, column: l })) });
    this.changed();
    return this;
  }

  /** Level refs of a hierarchy ref like `Date[Calendar]`, or null. */
  resolveHierarchy(ref: string): string[] | null {
    if (!isColumnRefString(ref)) return null;
    const c = parseColumnRef(ref);
    const h = this.hierarchies.get(`${c.table}[${c.column}]`);
    return h && !this.table(c.table).hasColumn(c.column) ? h.levels : null;
  }

  /** Perspective: a named subset of tables / fields for simpler field lists. */
  addPerspective(name: string, include: string[]): this {
    this.perspectives.set(name, new Set(include));
    return this;
  }

  // ---------------------------------------------------------------- row-level security

  /**
   * Define a security role: per table, a DAX boolean evaluated for each row
   * (e.g. `{ Region: 'Region[Manager] = USERNAME()' }`).
   */
  addRole(name: string, rules: Record<string, string>): this {
    for (const [t, expr] of Object.entries(rules)) {
      this.table(t);
      parseDax(expr);
    }
    this.roles.set(name, rules);
    if (this.activeRoles.includes(name)) this.applySecurity();
    return this;
  }

  /** Activate roles (rows are the union of what each role allows). `null`/`[]` removes security. */
  setRoles(roles: string[] | null, opts: { user?: string; customData?: string } = {}): this {
    for (const r of roles ?? []) if (!this.roles.has(r)) throw new Error(`Role "${r}" not found`);
    this.activeRoles = roles ?? [];
    if (opts.user !== undefined) this.currentUser = opts.user;
    if (opts.customData !== undefined) this.customData = opts.customData;
    this.applySecurity();
    return this;
  }

  get activeRoleNames(): readonly string[] {
    return this.activeRoles;
  }

  private applySecurity(): void {
    this.securityFilters = null;
    this.changed();
    if (!this.activeRoles.length) return;
    this.computingSecurity = true;
    try {
      const perTable = new Map<string, Set<number>>();
      for (const role of this.activeRoles) {
        for (const [table, expr] of Object.entries(this.roles.get(role)!)) {
          const t = this.table(table);
          const ast = parseDax(expr);
          const set = perTable.get(table) ?? new Set<number>();
          for (let i = 0; i < t.rowCount; i++) if (truthy(this.evaluator.evalScalarInRow(ast, table, i))) set.add(i);
          perTable.set(table, set);
        }
      }
      const key = this.activeRoles.slice().sort().join(',') + '|' + this.currentUser + '|' + this.customData;
      this.securityFilters = [...perTable].map(([table, rows]) => ({ kind: 'rows', table, rows, key: `rls#${table}#${key}` }));
    } finally {
      this.computingSecurity = false;
    }
    this.changed();
  }

  // ---------------------------------------------------------------- field list & metadata

  /** Field list for building UIs (like Power BI's Fields pane). Optionally limited to a perspective. */
  fields(opts: { perspective?: string } = {}): FieldInfo[] {
    const out: FieldInfo[] = [];
    for (const t of this.tables.values())
      for (const c of t.columns.values())
        out.push({ kind: 'column', table: t.name, name: c.name, ref: columnRefToString({ table: t.name, column: c.name }), type: c.type, format: c.format, hidden: c.hidden, description: c.description, folder: c.folder });
    for (const h of this.hierarchies.values()) out.push({ kind: 'hierarchy', table: h.table, name: h.name, ref: columnRefToString({ table: h.table, column: h.name }), levels: h.levels });
    for (const m of this.measures.values()) out.push({ kind: 'measure', table: m.table ?? '', name: m.name, ref: m.name, format: m.format, description: m.description, folder: m.folder });
    if (!opts.perspective) return out;
    const p = this.perspectives.get(opts.perspective);
    if (!p) throw new Error(`Perspective "${opts.perspective}" not found`);
    return out.filter((f) => p.has(f.ref) || p.has(f.table) || p.has(f.name));
  }

  /** Serialisable model metadata (no row data). */
  toJSON() {
    return {
      tables: [...this.tables.values()].map((t) => ({
        name: t.name,
        expression: this.calcTables.get(t.name),
        columns: [...t.columns.values()].map((c) => ({ name: c.name, type: c.type, format: c.format, expression: c.expression, folder: c.folder })),
      })),
      relationships: this.rels.map((r) => ({
        from: columnRefToString({ table: r.fromTable, column: r.fromColumn }),
        to: columnRefToString({ table: r.toTable, column: r.toColumn }),
        crossFilter: r.crossFilter,
        active: r.active,
        cardinality: r.cardinality,
      })) as RelationshipDef[],
      measures: [...this.measures.values()].map(({ ast: _ast, ...m }) => m) as MeasureDef[],
      calculationGroups: [...this.calcGroupMap.values()].map((g) => ({ name: g.table, column: g.column, precedence: g.precedence, items: [...g.items.values()].map((i) => i.name) })),
      hierarchies: [...this.hierarchies.values()],
      perspectives: Object.fromEntries([...this.perspectives].map(([k, v]) => [k, [...v]])),
      roles: Object.fromEntries(this.roles),
      transforms: Object.fromEntries([...this.transforms].map(([k, v]) => [k, v.steps])),
      refreshPolicies: Object.fromEntries(this.policies),
    };
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(change?: ModelChange): void {
    this.clearCaches();
    if (this.quiet) return;
    for (const l of this.listeners) l(change);
  }

  private clearCaches(): void {
    this.expandedCache.clear();
    this.reachCache.clear();
    this.effectiveCache.clear();
    this.rowsCache.clear();
    this.rowsCached = 0;
    this.allRowsCache.clear();
    this.pathCache.clear();
    this.relatedCache.clear();
    this.evaluator.clearCache();
  }

  // ---------------------------------------------------------------- evaluation API

  /** Evaluate a DAX expression to a scalar under the given filters. */
  evaluate(expression: string, filters: (FilterSpec | Filter)[] = []): CellValue {
    return this.evaluator.evalScalar(parseDax(expression), { filters: this.toContext(filters) });
  }

  /** Evaluate a DAX table expression (like a DAX query's EVALUATE). */
  evaluateTable(expression: string, filters: (FilterSpec | Filter)[] = []): { columns: string[]; rows: CellValue[][]; formats: (string | undefined)[] } {
    return this.evaluator.evalTableToRows(parseDax(expression), { filters: this.toContext(filters) });
  }

  /** Run a grouped query (what visuals use). */
  query(spec: QuerySpec): QueryResult {
    return runQuery(this, spec);
  }

  toContext(filters: readonly (FilterSpec | Filter)[]): Filter[] {
    return filters.map((f) => ('kind' in f ? f : compileFilter(f as never)));
  }

  // ---------------------------------------------------------------- engine internals

  resolveColumn(ref: ColumnRef): ColumnRef {
    this.table(ref.table).column(ref.column);
    return ref;
  }

  findColumnByName(column: string, preferTable?: string): ColumnRef | undefined {
    if (preferTable && this.tables.get(preferTable)?.hasColumn(column)) return { table: preferTable, column };
    for (const t of this.tables.values()) if (t.hasColumn(column)) return { table: t.name, column };
    return undefined;
  }

  /** Active many-to-one relationships where `table` is the many side (used for RELATED and lookups). */
  outgoing(table: string): Relationship[] {
    return this.rels.filter((r) => r.active && r.cardinality === 'manyToOne' && r.fromTable === table);
  }

  /** Relationships in effect under a filter context (USERELATIONSHIP / CROSSFILTER applied). */
  private effective(ctx: FilterContext): Effective {
    const mods = ctx.filter((f): f is RelFilter => f.kind === 'rel');
    const key = mods.map((m) => m.key).sort().join('|');
    let e = this.effectiveCache.get(key);
    if (e) return e;
    let rels = this.rels.map((r) => ({ ...r }));
    for (const m of mods) {
      const r = rels[m.rel];
      if (!r) continue;
      if (m.mode === 'activate') {
        // the chosen relationship wins over any other active one between the same tables
        for (const o of rels) if (o !== r && ((o.fromTable === r.fromTable && o.toTable === r.toTable) || (o.fromTable === r.toTable && o.toTable === r.fromTable))) o.active = false;
        r.active = true;
      } else if (m.mode === 'none') r.active = false;
      else r.crossFilter = m.mode === 'both' ? 'both' : 'single';
    }
    rels = rels.filter((r) => r.active);
    e = { rels, key };
    this.effectiveCache.set(key, e);
    return e;
  }

  /** The "expanded table": the table plus every table reachable via active many→one relationships. */
  expanded(table: string): Set<string> {
    let s = this.expandedCache.get(table);
    if (!s) {
      s = new Set([table]);
      const queue = [table];
      while (queue.length) {
        const t = queue.shift()!;
        for (const r of this.outgoing(t))
          if (!s.has(r.toTable)) {
            s.add(r.toTable);
            queue.push(r.toTable);
          }
      }
      this.expandedCache.set(table, s);
    }
    return s;
  }

  /**
   * Tables whose filters reach `table` under the effective relationships: one→many always,
   * many→one for bidirectional relationships (unless that direction is blocked to avoid cycles).
   */
  private reach(table: string, eff: Effective, blocked: ReadonlySet<string>): Set<string> {
    const key = `${table}|${eff.key}|${[...blocked].sort().join(',')}`;
    let s = this.reachCache.get(key);
    if (s) return s;
    s = new Set([table]);
    const queue = [table];
    while (queue.length) {
      const t = queue.shift()!;
      for (const r of eff.rels) {
        if (r.fromTable === t && !s.has(r.toTable)) {
          s.add(r.toTable);
          queue.push(r.toTable);
        }
        if (r.crossFilter === 'both' && r.toTable === t && !blocked.has(t) && !s.has(r.fromTable)) {
          s.add(r.fromTable);
          queue.push(r.fromTable);
        }
      }
    }
    if (this.reachCache.size > CACHE_LIMIT) this.reachCache.clear();
    this.reachCache.set(key, s);
    return s;
  }

  /** Relationship path from `from` (many side) to `to` (one side). Cached; callers must not mutate it. */
  pathTo(from: string, to: string): Relationship[] | undefined {
    if (from === to) return [];
    const key = `${from}|${to}`;
    const hit = this.pathCache.get(key);
    if (hit !== undefined) return hit ?? undefined;
    const path = this.findPath(from, to);
    this.pathCache.set(key, path ?? null);
    return path;
  }

  private findPath(from: string, to: string): Relationship[] | undefined {
    const prev = new Map<string, Relationship>();
    const queue = [from];
    const seen = new Set([from]);
    while (queue.length) {
      const t = queue.shift()!;
      for (const r of this.outgoing(t)) {
        if (seen.has(r.toTable)) continue;
        seen.add(r.toTable);
        prev.set(r.toTable, r);
        if (r.toTable === to) {
          const path: Relationship[] = [];
          let cur = to;
          while (cur !== from) {
            const rel = prev.get(cur)!;
            path.unshift(rel);
            cur = rel.fromTable;
          }
          return path;
        }
        queue.push(r.toTable);
      }
    }
    return undefined;
  }

  /**
   * Row of `targetTable` related to each row of `table` (-1 when there is none), or null without a path. Each hop maps
   * the foreign key's dictionary codes through the key index once, so RELATED costs two typed-array reads per row.
   */
  relatedRows(table: string, targetTable: string): Int32Array | null {
    const key = `${table}|${targetTable}`;
    const n = this.table(table).rowCount;
    let map = this.relatedCache.get(key);
    // the length check catches tables mutated without a model change notification
    if (map !== undefined && (map === null || map.length === n)) return map;
    const path = this.pathTo(table, targetTable);
    map = null;
    if (path && path.length) {
      let rows: Int32Array | null = null; // rows of the current hop's "to" table, per row of `table`
      for (const rel of path) {
        const pk = this.table(rel.toTable).index(rel.toColumn);
        const { codes, dict } = this.table(rel.fromTable).codes(rel.fromColumn);
        // slot 0 is the blank key; slot k + 1 is dictionary entry k
        const lookup = new Int32Array(dict.length + 1);
        lookup[0] = pk.get(valueKey(null))?.[0] ?? -1;
        for (let k = 0; k < dict.length; k++) lookup[k + 1] = pk.get(valueKey(dict[k]))?.[0] ?? -1;
        const out = new Int32Array(n);
        if (!rows) for (let r = 0; r < n; r++) out[r] = lookup[codes[r] + 1];
        else
          for (let r = 0; r < n; r++) {
            const from = rows[r];
            out[r] = from < 0 ? -1 : lookup[codes[from] + 1];
          }
        rows = out;
      }
      map = rows;
    }
    if (this.relatedCache.size > CACHE_LIMIT) this.relatedCache.clear();
    this.relatedCache.set(key, map);
    return map;
  }

  /** Row index in `targetTable` related to `row` of `table` (RELATED semantics). */
  relatedRow(table: string, row: number, targetTable: string): number | undefined {
    if (table === targetTable) return row;
    const map = this.relatedRows(table, targetTable);
    if (!map) return undefined;
    const r = map[row];
    return r < 0 ? undefined : r;
  }

  relatedValue(table: string, row: number, col: ColumnRef): CellValue {
    if (col.table === table) return this.table(table).value(col.column, row);
    const r = this.relatedRow(table, row, col.table);
    return r === undefined ? null : this.table(col.table).value(col.column, r);
  }

  /** Does filter `f` constrain rows of `table`? */
  filterApplies(f: Filter, table: string, eff?: Effective, blocked: ReadonlySet<string> = EMPTY): boolean {
    if (f.kind === 'rel') return false;
    const reach = eff ? this.reach(table, eff, blocked) : this.expanded(table);
    return f.kind === 'rows' ? reach.has(f.table) : f.columns.every((c) => reach.has(c.table));
  }

  allRows(table: string): number[] {
    let a = this.allRowsCache.get(table);
    if (!a) {
      a = Array.from({ length: this.table(table).rowCount }, (_, i) => i);
      this.allRowsCache.set(table, a);
    }
    return a;
  }

  /** Visible rows of `table` under filter context (sorted ascending). Row-level security always applies. */
  rowsOf(table: string, ctx: FilterContext, blocked: ReadonlySet<string> = EMPTY): number[] {
    const eff = this.effective(ctx);
    const security = this.securityFilters && !this.computingSecurity ? this.securityFilters : null;
    const all: Filter[] = security ? [...ctx, ...security] : (ctx as Filter[]);
    const relevant = all.filter((f) => this.filterApplies(f, table, eff, blocked));
    if (relevant.length === 0) return this.allRows(table);
    const mods = ctx.filter((f) => f.kind === 'rel');
    const key = `${table}::${contextKey(relevant)}::${eff.key}::${[...blocked].sort().join(',')}`;
    const hit = this.rowsCache.get(key);
    if (hit) return hit;

    const t = this.table(table);
    let cand: number[] | null = null;
    const narrow = (list: number[]) => {
      cand = cand === null ? list : intersectSorted(cand, list);
    };
    // low-cardinality columns of large tables combine as bitmaps (OR within a filter, AND across filters)
    let bits: Uint32Array | null = null;
    const narrowBits = (column: string, keys: Iterable<unknown>): boolean => {
      const bm = bitmapsEnabled ? t.bitmap(column) : null;
      if (!bm) return false;
      const words = (t.rowCount + 31) >>> 5;
      const or = new Uint32Array(words);
      for (const k of keys) {
        const b = bm.get(k);
        if (b) for (let w = 0; w < words; w++) or[w] |= b[w];
      }
      if (bits) for (let w = 0; w < words; w++) bits[w] &= or[w];
      else bits = or;
      return true;
    };
    const ownScan: Filter[] = [];
    const crossScan: Filter[] = [];
    const forward = eff.rels.filter((r) => r.fromTable === table);
    const backward = blocked.has(table) ? [] : eff.rels.filter((r) => r.toTable === table && r.crossFilter === 'both');
    const nextBlocked = new Set([...blocked, table]);
    const ctxFor = (filters: Filter[]) => [...filters, ...mods];

    for (const f of relevant) {
      if (f.kind === 'rel') continue;
      if (f.kind === 'rows') {
        if (f.table === table) narrow([...f.rows].sort((a, b) => a - b));
        continue; // rows filters on related tables are propagated below
      }
      if (f.columns.every((c) => c.table === table)) {
        if (f.lookupKeys && f.columns.length === 1) {
          if (narrowBits(f.columns[0].column, f.lookupKeys)) continue;
          const idx = t.index(f.columns[0].column);
          narrow(unionLists(f.lookupKeys.map((k) => idx.get(k) ?? []), t.rowCount));
        } else ownScan.push(f);
      } else if (!forward.some((r) => this.filterApplies(f, r.toTable, eff, blocked)) && !backward.some((r) => this.filterApplies(f, r.fromTable, eff, nextBlocked))) {
        crossScan.push(f);
      }
    }

    // one → many: rows of the related one-side table select this table's foreign keys
    for (const rel of forward) {
      const dimFilters = relevant.filter((f) => this.filterApplies(f, rel.toTable, eff, blocked));
      if (!dimFilters.length) continue;
      const dim = this.table(rel.toTable);
      const dimRows = this.rowsOf(rel.toTable, ctxFor(dimFilters), blocked);
      const fkIdx = t.index(rel.fromColumn);
      const pkCol = dim.column(rel.toColumn).values;
      const keys = new Set<unknown>();
      for (const i of dimRows) keys.add(valueKey(pkCol[i]));
      if (narrowBits(rel.fromColumn, keys)) continue;
      narrow(unionLists([...keys].map((k) => fkIdx.get(k) ?? []), t.rowCount));
      if (cand!.length === 0) break;
    }

    // many → one for bidirectional relationships: only filters that come from the other side
    for (const rel of backward) {
      if (cand !== null && (cand as number[]).length === 0) break;
      const foreign = relevant.filter((f) => this.filterApplies(f, rel.fromTable, eff, nextBlocked) && !this.filterApplies(f, table, eff, nextBlocked));
      if (!foreign.length) continue;
      const src = this.table(rel.fromTable);
      const srcRows = this.rowsOf(rel.fromTable, ctxFor(foreign), nextBlocked);
      const fkCol = src.column(rel.fromColumn).values;
      const pkIdx = t.index(rel.toColumn);
      const keys = new Set<unknown>();
      for (const i of srcRows) keys.add(valueKey(fkCol[i]));
      narrow(unionLists([...keys].map((k) => pkIdx.get(k) ?? []), t.rowCount));
    }

    if (bits) {
      const b = bits as Uint32Array;
      const list: number[] = [];
      for (let w = 0; w < b.length; w++) {
        let x = b[w];
        while (x) {
          const low = x & -x;
          list.push((w << 5) + 31 - Math.clz32(low));
          x ^= low;
        }
      }
      narrow(list);
    }
    let result: number[] = cand ?? this.allRows(table);
    if (ownScan.length || crossScan.length) {
      // per filter: a reader per column and one reused tuple, so the scan doesn't allocate per row
      const scans = [...ownScan, ...crossScan].map((f) => {
        const cf = f as ColumnsFilter;
        const readers = cf.columns.map((c): ((row: number) => CellValue) => {
          const vals = this.table(c.table).column(c.column).values;
          if (c.table === table) return (row) => vals[row];
          const map = this.relatedRows(table, c.table);
          return map ? (row) => (map[row] < 0 ? null : vals[map[row]]) : () => null;
        });
        return { test: cf.test, readers, tuple: new Array<CellValue>(readers.length) };
      });
      result = result.filter((i) => {
        for (const s of scans) {
          for (let j = 0; j < s.readers.length; j++) s.tuple[j] = s.readers[j](i);
          if (!s.test(s.tuple)) return false;
        }
        return true;
      });
    }
    // bounded by entries and by total row indices (many large row sets would otherwise pin a lot of memory)
    if (this.rowsCache.size > CACHE_LIMIT || this.rowsCached + result.length > ROWS_CACHE_BUDGET) {
      this.rowsCache.clear();
      this.rowsCached = 0;
    }
    this.rowsCache.set(key, result);
    this.rowsCached += result.length;
    return result;
  }

  /** Distinct visible values of a column (VALUES semantics). */
  valuesOf(col: ColumnRef, ctx: FilterContext): CellValue[] {
    const t = this.table(col.table);
    const rows = this.rowsOf(col.table, ctx);
    if (rows.length === t.rowCount) return t.distinct(col.column);
    const vals = t.column(col.column).values;
    const keep = new Set<unknown>();
    for (const i of rows) keep.add(valueKey(vals[i]));
    return t.distinct(col.column).filter((v) => keep.has(valueKey(v)));
  }
}

const EMPTY: ReadonlySet<string> = new Set();

let bitmapsEnabled = true;
/** Turn bitmap indexes on or off (on by default; used for low-cardinality columns of large tables). */
export function setBitmapIndexes(on: boolean): void {
  bitmapsEnabled = on;
}

function truthy(v: CellValue): boolean {
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return v !== '';
}

export function intersectSorted(a: number[], b: number[]): number[] {
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(a[i]);
      i++;
      j++;
    } else if (a[i] < b[j]) i++;
    else j++;
  }
  return out;
}

/** Union of ascending row lists. Large unions use a bitmap pass (O(rows)) instead of sorting. */
function unionLists(lists: number[][], rowCount: number): number[] {
  const nonEmpty = lists.filter((l) => l.length);
  if (nonEmpty.length === 0) return [];
  if (nonEmpty.length === 1) return nonEmpty[0];
  let total = 0;
  for (const l of nonEmpty) total += l.length;
  if (nonEmpty.length > 8 || total > rowCount / 8) {
    const mark = new Uint8Array(rowCount);
    for (const l of nonEmpty) for (const x of l) mark[x] = 1;
    const out: number[] = [];
    for (let r = 0; r < rowCount; r++) if (mark[r]) out.push(r);
    return out;
  }
  const out: number[] = [];
  for (const l of nonEmpty) for (const x of l) out.push(x);
  out.sort((a, b) => a - b);
  let w = 0;
  for (let r = 0; r < out.length; r++) if (r === 0 || out[r] !== out[r - 1]) out[w++] = out[r];
  out.length = w;
  return out;
}
