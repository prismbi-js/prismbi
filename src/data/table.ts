import type { CellValue, ColumnSchema, DataType, Row } from './types';
import { compareValues, valueKey } from './types';

export interface Column {
  name: string;
  type: DataType;
  values: CellValue[];
  format?: string;
  hidden?: boolean;
  sortBy?: string;
  description?: string;
  folder?: string;
  /** Set when the column is computed from a DAX expression. */
  expression?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export function inferType(values: unknown[]): DataType {
  let sawNumber = false;
  let sawDate = false;
  let sawBool = false;
  let sawString = false;
  const limit = Math.min(values.length, 500);
  for (let i = 0; i < limit; i++) {
    const v = values[i];
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'number') sawNumber = true;
    else if (typeof v === 'boolean') sawBool = true;
    else if (v instanceof Date) sawDate = true;
    else if (typeof v === 'string' && ISO_DATE.test(v)) sawDate = true;
    else sawString = true;
  }
  if (sawString) return 'string';
  if (sawDate && !sawNumber && !sawBool) return 'date';
  if (sawNumber && !sawDate && !sawBool) return 'number';
  if (sawBool && !sawNumber && !sawDate) return 'boolean';
  return sawNumber || sawDate || sawBool ? 'string' : 'string';
}

export function coerce(v: unknown, type: DataType): CellValue {
  if (v === null || v === undefined || v === '') return null;
  switch (type) {
    case 'number': {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    }
    case 'date': {
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
        const [y, m, d] = v.split('-').map(Number);
        return new Date(y, m - 1, d);
      }
      const d = new Date(v as string | number);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 1 || v === '1') return true;
      if (v === 'false' || v === 0 || v === '0') return false;
      return null;
    default:
      return v instanceof Date ? v.toISOString() : String(v);
  }
}

/**
 * Columnar, immutable-by-convention table. Each column is a typed value array;
 * per-column hash indexes are built lazily and power fast filtering.
 */
export class DataTable {
  readonly name: string;
  readonly columns = new Map<string, Column>();
  private _rowCount = 0;
  private indexes = new Map<string, Map<unknown, number[]>>();
  private distinctCache = new Map<string, CellValue[]>();
  private numericCache = new Map<string, Float64Array>();
  private codesCache = new Map<string, { codes: Int32Array; dict: CellValue[] }>();

  constructor(name: string, rows: Row[] = [], schema: Record<string, ColumnSchema> = {}) {
    this.name = name;
    this._rowCount = rows.length;
    const names = new Set<string>(Object.keys(schema));
    for (let i = 0; i < Math.min(rows.length, 1000); i++) for (const k of Object.keys(rows[i])) names.add(k);
    for (const col of names) {
      const raw = rows.map((r) => r[col]);
      const s = schema[col] ?? {};
      const type = s.type ?? inferType(raw);
      this.columns.set(col, {
        name: col,
        type,
        values: raw.map((v) => coerce(v, type)),
        format: s.format,
        hidden: s.hidden,
        sortBy: s.sortBy,
        description: s.description,
        folder: s.folder,
      });
    }
  }

  /** Build a table from column arrays (fast path for large data). */
  static fromColumns(name: string, cols: Record<string, unknown[]>, schema: Record<string, ColumnSchema> = {}): DataTable {
    const t = new DataTable(name, [], {});
    let count = -1;
    for (const [col, raw] of Object.entries(cols)) {
      if (count >= 0 && raw.length !== count) throw new Error(`Column "${col}" length mismatch in table "${name}"`);
      count = raw.length;
      const s = schema[col] ?? {};
      const type = s.type ?? inferType(raw);
      t.columns.set(col, { name: col, type, values: raw.map((v) => coerce(v, type)), format: s.format, hidden: s.hidden, sortBy: s.sortBy, description: s.description });
    }
    t._rowCount = Math.max(count, 0);
    return t;
  }

  get rowCount(): number {
    return this._rowCount;
  }

  hasColumn(name: string): boolean {
    return this.columns.has(name);
  }

  column(name: string): Column {
    const c = this.columns.get(name);
    if (!c) throw new Error(`Column "${name}" not found in table "${this.name}"`);
    return c;
  }

  value(column: string, row: number): CellValue {
    return this.column(column).values[row];
  }

  /** Add or replace a column with pre-computed values. */
  setColumn(col: Column): void {
    if (col.values.length !== this._rowCount) throw new Error(`Column "${col.name}" must have ${this._rowCount} values`);
    this.columns.set(col.name, col);
    this.invalidate(col.name);
  }

  private invalidate(name?: string): void {
    for (const cache of [this.indexes, this.distinctCache, this.numericCache, this.codesCache] as Map<string, unknown>[]) {
      if (name === undefined) cache.clear();
      else cache.delete(name);
    }
  }

  /**
   * Numeric view of a column as a Float64Array (dates as epoch ms, booleans 0/1, BLANK as NaN).
   * Built once and cached; used by the fast aggregation paths.
   */
  numeric(column: string): Float64Array {
    let a = this.numericCache.get(column);
    if (!a) {
      const vals = this.column(column).values;
      a = new Float64Array(vals.length);
      for (let i = 0; i < vals.length; i++) {
        const v = vals[i];
        a[i] = v === null ? NaN : typeof v === 'number' ? v : v instanceof Date ? v.getTime() : typeof v === 'boolean' ? (v ? 1 : 0) : NaN;
      }
      this.numericCache.set(column, a);
    }
    return a;
  }

  /** Dictionary encoding of a column: a code per row (-1 for BLANK) and the distinct values by code. Cached. */
  codes(column: string): { codes: Int32Array; dict: CellValue[] } {
    let c = this.codesCache.get(column);
    if (!c) {
      const vals = this.column(column).values;
      const codes = new Int32Array(vals.length);
      const dict: CellValue[] = [];
      const seen = new Map<unknown, number>();
      for (let i = 0; i < vals.length; i++) {
        const v = vals[i];
        if (v === null) {
          codes[i] = -1;
          continue;
        }
        const k = valueKey(v);
        let code = seen.get(k);
        if (code === undefined) {
          code = dict.length;
          dict.push(v);
          seen.set(k, code);
        }
        codes[i] = code;
      }
      c = { codes, dict };
      this.codesCache.set(column, c);
    }
    return c;
  }

  /** Append rows (coerced to each column's type; unknown keys are ignored, missing ones are BLANK). */
  appendRows(rows: Row[]): void {
    if (!rows.length) return;
    for (const col of this.columns.values()) for (const r of rows) col.values.push(coerce(r[col.name], col.type));
    this._rowCount += rows.length;
    this.invalidate();
  }

  /** Drop the first `n` rows (sliding windows for streaming data). */
  removeFirst(n: number): void {
    if (n <= 0) return;
    const k = Math.min(n, this._rowCount);
    for (const col of this.columns.values()) col.values.splice(0, k);
    this._rowCount -= k;
    this.invalidate();
  }

  removeColumn(name: string): void {
    this.columns.delete(name);
    this.invalidate(name);
  }

  /** Hash index: value key → ascending row indices. */
  index(column: string): Map<unknown, number[]> {
    let idx = this.indexes.get(column);
    if (!idx) {
      idx = new Map();
      const values = this.column(column).values;
      for (let i = 0; i < values.length; i++) {
        const k = valueKey(values[i]);
        const list = idx.get(k);
        if (list) list.push(i);
        else idx.set(k, [i]);
      }
      this.indexes.set(column, idx);
    }
    return idx;
  }

  /** Sorted distinct values (honours `sortBy`). */
  distinct(column: string): CellValue[] {
    let d = this.distinctCache.get(column);
    if (!d) {
      const idx = this.index(column);
      const col = this.column(column);
      d = [...idx.values()].map((rows) => col.values[rows[0]]);
      if (col.sortBy && this.hasColumn(col.sortBy)) {
        const sortVals = this.column(col.sortBy).values;
        const first = new Map<unknown, CellValue>();
        for (const rows of idx.values()) first.set(valueKey(col.values[rows[0]]), sortVals[rows[0]]);
        d.sort((a, b) => compareValues(first.get(valueKey(a)) ?? null, first.get(valueKey(b)) ?? null) || compareValues(a, b));
      } else d.sort(compareValues);
      this.distinctCache.set(column, d);
    }
    return d;
  }

  /** Materialise rows back to objects. */
  toRows(rowIndices?: number[]): Row[] {
    const cols = [...this.columns.values()];
    const idx = rowIndices ?? Array.from({ length: this._rowCount }, (_, i) => i);
    return idx.map((i) => {
      const r: Row = {};
      for (const c of cols) r[c.name] = c.values[i];
      return r;
    });
  }
}
