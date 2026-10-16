import type { CellValue, ColumnRef, ColumnSchema, DataType, MeasureDef, RelationshipDef, Row } from './types';
import { columnRefToString, isColumnRefString, parseColumnRef, valueKey } from './types';
import { DataTable } from './table';
import { generateDateTable } from './dates';
import type { DateTableOptions } from './dates';
import type { Filter, FilterContext, FilterSpec, RelFilter, RowsFilter } from './filters';
import { compileFilter, contextKey } from './filters';
import type { Expr } from '../dax/ast';
import { parseDax } from '../dax/parser';
import { Evaluator } from '../dax/evaluator';
import type { QueryResult, QuerySpec } from './query';
import { runQuery } from './query';

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
  items: Map<string, { name: string; ast: Expr }>;
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

type Listener = () => void;

const CACHE_LIMIT = 20_000;

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
  private allRowsCache = new Map<string, number[]>();
  private listeners = new Set<Listener>();
  private calcTables = new Map<string, string>();
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
    const old = this.table(name);
    const calc = [...old.columns.values()].filter((c) => c.expression);
    const table = new DataTable(name, rows, schema);
    this.tables.set(name, table);
    this.changed();
    for (const c of calc) this.addCalculatedColumn(name, c.name, c.expression!, { format: c.format, type: c.type, hidden: c.hidden });
    this.recalculateTables();
    return this;
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
    const values: CellValue[] = new Array(t.rowCount);
    for (let i = 0; i < t.rowCount; i++) values[i] = this.evaluator.evalScalarInRow(ast, table, i);
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
      items: new Map(items.map((it) => [it.name, { name: it.name, ast: parseDax(it.expression) }])),
    });
    this.changed();
    return this;
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
    };
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    this.expandedCache.clear();
    this.reachCache.clear();
    this.effectiveCache.clear();
    this.rowsCache.clear();
    this.allRowsCache.clear();
    for (const l of this.listeners) l();
  }

  // ---------------------------------------------------------------- evaluation API

  /** Evaluate a DAX expression to a scalar under the given filters. */
  evaluate(expression: string, filters: (FilterSpec | Filter)[] = []): CellValue {
    return this.evaluator.evalScalar(parseDax(expression), { filters: this.toContext(filters) });
  }

  /** Evaluate a DAX table expression (like a DAX query's EVALUATE). */
  evaluateTable(expression: string, filters: (FilterSpec | Filter)[] = []): { columns: string[]; rows: CellValue[][] } {
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

  /** Relationship path from `from` (many side) to `to` (one side). */
  pathTo(from: string, to: string): Relationship[] | undefined {
    if (from === to) return [];
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

  /** Row index in `targetTable` related to `row` of `table` (RELATED semantics). */
  relatedRow(table: string, row: number, targetTable: string): number | undefined {
    const path = this.pathTo(table, targetTable);
    if (!path) return undefined;
    let r: number | undefined = row;
    let cur = table;
    for (const rel of path) {
      const key = this.table(cur).value(rel.fromColumn, r!);
      r = this.table(rel.toTable).index(rel.toColumn).get(valueKey(key))?.[0];
      if (r === undefined) return undefined;
      cur = rel.toTable;
    }
    return r;
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

    let result: number[] = cand ?? this.allRows(table);
    if (ownScan.length || crossScan.length) {
      result = result.filter((i) => {
        for (const f of ownScan) if (f.kind === 'columns' && !f.test(f.columns.map((c) => t.column(c.column).values[i]))) return false;
        for (const f of crossScan) if (f.kind === 'columns' && !f.test(f.columns.map((c) => this.relatedValue(table, i, c)))) return false;
        return true;
      });
    }
    if (this.rowsCache.size > CACHE_LIMIT) this.rowsCache.clear();
    this.rowsCache.set(key, result);
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
