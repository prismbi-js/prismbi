import type { CellValue, ColumnRef, ColumnSchema, DataType, MeasureDef, RelationshipDef, Row } from './types';
import { columnRefToString, parseColumnRef, valueKey } from './types';
import { DataTable } from './table';
import { generateDateTable } from './dates';
import type { DateTableOptions } from './dates';
import type { Filter, FilterContext, FilterSpec } from './filters';
import { compileFilter, contextKey } from './filters';
import type { Expr } from '../dax/ast';
import { parseDax } from '../dax/parser';
import { Evaluator } from '../dax/evaluator';
import type { QueryResult, QuerySpec } from './query';
import { runQuery } from './query';

export interface Relationship {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  crossFilter: 'single' | 'both';
  active: boolean;
}

export interface Measure extends MeasureDef {
  ast: Expr;
}

export interface FieldInfo {
  kind: 'column' | 'measure';
  table: string;
  name: string;
  /** Reference string usable in visual field wells. */
  ref: string;
  type?: DataType;
  format?: string;
  hidden?: boolean;
  description?: string;
  folder?: string;
}

type Listener = () => void;

const CACHE_LIMIT = 20_000;

/**
 * The semantic model: tables, relationships, measures and calculated columns.
 * Filters flow from the one side to the many side of each relationship (star / snowflake schemas).
 */
export class DataModel {
  private tables = new Map<string, DataTable>();
  private rels: Relationship[] = [];
  private measures = new Map<string, Measure>();
  private expandedCache = new Map<string, Set<string>>();
  private rowsCache = new Map<string, number[]>();
  private allRowsCache = new Map<string, number[]>();
  private listeners = new Set<Listener>();
  readonly evaluator: Evaluator;

  constructor() {
    this.evaluator = new Evaluator(this);
  }

  // ---------------------------------------------------------------- schema

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

  /** Replace a table's rows (e.g. on refresh), keeping calculated columns. */
  refreshTable(name: string, rows: Row[], schema?: Record<string, ColumnSchema>): this {
    const old = this.table(name);
    const calc = [...old.columns.values()].filter((c) => c.expression);
    const table = new DataTable(name, rows, schema);
    this.tables.set(name, table);
    this.changed();
    for (const c of calc) this.addCalculatedColumn(name, c.name, c.expression!, { format: c.format, type: c.type, hidden: c.hidden });
    return this;
  }

  removeTable(name: string): this {
    this.tables.delete(name);
    this.rels = this.rels.filter((r) => r.fromTable !== name && r.toTable !== name);
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

  addRelationship(def: RelationshipDef): this {
    const from = parseColumnRef(def.from);
    const to = parseColumnRef(def.to);
    this.table(from.table).column(from.column);
    this.table(to.table).column(to.column);
    const idx = this.table(to.table).index(to.column);
    for (const rows of idx.values())
      if (rows.length > 1) throw new Error(`Relationship target ${columnRefToString(to)} must contain unique values (one side of a many-to-one relationship)`);
    this.rels.push({
      fromTable: from.table,
      fromColumn: from.column,
      toTable: to.table,
      toColumn: to.column,
      crossFilter: def.crossFilter ?? 'single',
      active: def.active ?? true,
    });
    this.changed();
    return this;
  }

  relationships(): readonly Relationship[] {
    return this.rels;
  }

  addMeasure(name: string, expression: string, opts?: Omit<MeasureDef, 'name' | 'expression'>): this;
  addMeasure(def: MeasureDef): this;
  addMeasure(a: string | MeasureDef, expression?: string, opts: Omit<MeasureDef, 'name' | 'expression'> = {}): this {
    const def: MeasureDef = typeof a === 'string' ? { name: a, expression: expression!, ...opts } : a;
    if (this.findColumnByName(def.name)) {
      // allowed in DAX, but ambiguous for unqualified [refs]; warn via error to keep models clean
    }
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
    t.setColumn({ name, type, values, format: opts.format, hidden: opts.hidden, sortBy: opts.sortBy, description: opts.description, expression });
    this.changed();
    return this;
  }

  /** Field list for building UIs (like Power BI's Fields pane). */
  fields(): FieldInfo[] {
    const out: FieldInfo[] = [];
    for (const t of this.tables.values())
      for (const c of t.columns.values())
        out.push({ kind: 'column', table: t.name, name: c.name, ref: columnRefToString({ table: t.name, column: c.name }), type: c.type, format: c.format, hidden: c.hidden, description: c.description });
    for (const m of this.measures.values())
      out.push({ kind: 'measure', table: m.table ?? '', name: m.name, ref: m.name, format: m.format, description: m.description, folder: m.folder });
    return out;
  }

  /** Serialisable model metadata (no row data). */
  toJSON(): { tables: { name: string; columns: { name: string; type: DataType; format?: string; expression?: string }[] }[]; relationships: RelationshipDef[]; measures: MeasureDef[] } {
    return {
      tables: [...this.tables.values()].map((t) => ({
        name: t.name,
        columns: [...t.columns.values()].map((c) => ({ name: c.name, type: c.type, format: c.format, expression: c.expression })),
      })),
      relationships: this.rels.map((r) => ({
        from: columnRefToString({ table: r.fromTable, column: r.fromColumn }),
        to: columnRefToString({ table: r.toTable, column: r.toColumn }),
        crossFilter: r.crossFilter,
        active: r.active,
      })),
      measures: [...this.measures.values()].map(({ ast: _ast, ...m }) => m),
    };
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    this.expandedCache.clear();
    this.rowsCache.clear();
    this.allRowsCache.clear();
    for (const l of this.listeners) l();
  }

  // ---------------------------------------------------------------- evaluation API

  /** Evaluate a DAX expression to a scalar under the given filters. */
  evaluate(expression: string, filters: (FilterSpec | Filter)[] = []): CellValue {
    return this.evaluator.evalScalar(parseDax(expression), { filters: this.toContext(filters) });
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

  /** Relationships where `table` is the many side. */
  outgoing(table: string): Relationship[] {
    return this.rels.filter((r) => r.active && r.fromTable === table);
  }

  /** The "expanded table": the table plus every table reachable via many→one relationships. */
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

  /** Does filter `f` constrain rows of `table`? (all its columns live in the expanded table) */
  filterApplies(f: Filter, table: string): boolean {
    const exp = this.expanded(table);
    return f.kind === 'rows' ? exp.has(f.table) : f.columns.every((c) => exp.has(c.table));
  }

  allRows(table: string): number[] {
    let a = this.allRowsCache.get(table);
    if (!a) {
      a = Array.from({ length: this.table(table).rowCount }, (_, i) => i);
      this.allRowsCache.set(table, a);
    }
    return a;
  }

  /** Visible rows of `table` under filter context (sorted ascending). */
  rowsOf(table: string, ctx: FilterContext): number[] {
    const relevant = ctx.filter((f) => this.filterApplies(f, table));
    if (relevant.length === 0) return this.allRows(table);
    const key = `${table}::${contextKey(relevant)}`;
    const hit = this.rowsCache.get(key);
    if (hit) return hit;

    const t = this.table(table);
    let cand: number[] | null = null;
    const narrow = (list: number[]) => {
      cand = cand === null ? list : intersectSorted(cand, list);
    };
    const ownScan: Filter[] = [];
    const crossScan: Filter[] = [];
    const outgoing = this.outgoing(table);

    for (const f of relevant) {
      if (f.kind === 'rows') {
        if (f.table === table) narrow([...f.rows].sort((a, b) => a - b));
        continue; // rows filters on related tables are propagated below
      }
      if (f.columns.every((c) => c.table === table)) {
        if (f.lookupKeys && f.columns.length === 1) {
          const idx = t.index(f.columns[0].column);
          narrow(unionLists(f.lookupKeys.map((k) => idx.get(k) ?? []), t.rowCount));
        } else ownScan.push(f);
      } else if (!outgoing.some((r) => this.filterApplies(f, r.toTable))) {
        crossScan.push(f);
      }
    }

    for (const rel of outgoing) {
      if (!relevant.some((f) => this.filterApplies(f, rel.toTable))) continue;
      const dim = this.table(rel.toTable);
      const dimRows = this.rowsOf(rel.toTable, relevant);
      const fkIdx = t.index(rel.fromColumn);
      const pkCol = dim.column(rel.toColumn).values;
      narrow(unionLists(dimRows.map((i) => fkIdx.get(valueKey(pkCol[i])) ?? []), t.rowCount));
      if (cand!.length === 0) break;
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
    const seen = new Set<unknown>();
    const vals = t.column(col.column).values;
    const keep = new Set<unknown>();
    for (const i of rows) {
      const k = valueKey(vals[i]);
      if (!seen.has(k)) {
        seen.add(k);
        keep.add(k);
      }
    }
    return t.distinct(col.column).filter((v) => keep.has(valueKey(v)));
  }
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
