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

/** Numeric view of a value: dates as epoch ms, booleans 0/1, BLANK and text as NaN. */
function toNumber(v: CellValue): number {
  return v === null ? NaN : typeof v === 'number' ? v : v instanceof Date ? v.getTime() : typeof v === 'boolean' ? (v ? 1 : 0) : NaN;
}

/** Dictionary code of a value (-1 for BLANK), adding it to the dictionary when new. */
function encode(v: CellValue, dict: CellValue[], seen: Map<unknown, number>): number {
  if (v === null) return -1;
  const k = valueKey(v);
  let code = seen.get(k);
  if (code === undefined) {
    code = dict.length;
    dict.push(v);
    seen.set(k, code);
  }
  return code;
}

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

/** Distinct values a column's pool keeps; past this, a column is mostly unique and sharing saves little. */
const POOL_MAX = 100_000;

/**
 * Coerce a column's values, sharing one object per distinct text or date. A parser makes a new string or `Date` per
 * row; sharing them keeps 1M dates in about 8 MB instead of 120 MB, and repeated text in 8 MB instead of 40 MB.
 * Cell values are never mutated, so sharing is safe.
 */
function coerceColumn(raw: ArrayLike<unknown>, type: DataType, pool: Map<unknown, CellValue> = new Map()): CellValue[] {
  const share = type === 'string' || type === 'date';
  // map makes an exact-size packed array (pushing leaves growth slack)
  return Array.prototype.map.call(raw, (x: unknown) => {
    const v = coerce(x, type);
    if (!share || v === null) return v;
    const key = v instanceof Date ? v.getTime() : v;
    const hit = pool.get(key);
    if (hit !== undefined) return hit;
    if (pool.size < POOL_MAX) pool.set(key, v);
    return v;
  }) as CellValue[];
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
/** Bitmap indexes are built for columns with at most this many values… */
export const BITMAP_MAX_VALUES = 512;
/** …in tables with at least this many rows (below it, row lists are already fast). */
export const BITMAP_MIN_ROWS = 4096;

export class DataTable {
  readonly name: string;
  readonly columns = new Map<string, Column>();
  private _rowCount = 0;
  private indexes = new Map<string, Map<unknown, number[]>>();
  private distinctCache = new Map<string, CellValue[]>();
  private numericCache = new Map<string, Float64Array>();
  private codesCache = new Map<string, { codes: Int32Array; dict: CellValue[]; seen: Map<unknown, number> }>();
  private bitmaps = new Map<string, Map<unknown, Uint32Array> | null>();
  /** Shared text and date objects per column, kept for appends. */
  private pools = new Map<string, Map<unknown, CellValue>>();
  private pool(column: string): Map<unknown, CellValue> {
    let p = this.pools.get(column);
    if (!p) this.pools.set(column, (p = new Map()));
    return p;
  }

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
        values: coerceColumn(raw, type, this.pool(col)),
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
      t.columns.set(col, { name: col, type, values: coerceColumn(raw, type, t.pool(col)), format: s.format, hidden: s.hidden, sortBy: s.sortBy, description: s.description });
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
    for (const cache of [this.indexes, this.distinctCache, this.numericCache, this.codesCache, this.bitmaps] as Map<string, unknown>[]) {
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
      for (let i = 0; i < vals.length; i++) a[i] = toNumber(vals[i]);
      this.numericCache.set(column, a);
    }
    return a;
  }

  /**
   * Adopt prebuilt views of a column (packed columns sent to a worker) instead of building them from its values.
   * `numeric` must hold NaN for BLANK; `codes` -1 for BLANK, indexing `dict`.
   * @internal
   */
  adoptViews(column: string, views: { numeric?: Float64Array; codes?: Int32Array; dict?: CellValue[] }): void {
    if (views.numeric) this.numericCache.set(column, views.numeric);
    if (views.codes && views.dict) this.codesCache.set(column, { codes: views.codes, dict: views.dict, seen: new Map(views.dict.map((v, i) => [valueKey(v), i])) });
  }

  /** Dictionary encoding of a column: a code per row (-1 for BLANK) and the distinct values by code. Cached. */
  codes(column: string): { codes: Int32Array; dict: CellValue[] } {
    let c = this.codesCache.get(column);
    if (!c) {
      const vals = this.column(column).values;
      const codes = new Int32Array(vals.length);
      const dict: CellValue[] = [];
      const seen = new Map<unknown, number>();
      for (let i = 0; i < vals.length; i++) codes[i] = encode(vals[i], dict, seen);
      c = { codes, dict, seen };
      this.codesCache.set(column, c);
    }
    return c;
  }

  /**
   * Append rows (coerced to each column's type; unknown keys are ignored, missing ones are BLANK). Cached views,
   * dictionaries, indexes and bitmaps are extended for the new rows instead of being rebuilt. Cached objects are
   * replaced, never mutated, so results computed before the append stay as they were.
   */
  appendRows(rows: Row[]): void {
    if (!rows.length) return;
    for (const col of this.columns.values()) for (const v of coerceColumn(rows.map((r) => r[col.name]), col.type, this.pool(col.name))) col.values.push(v);
    const from = this._rowCount;
    this._rowCount += rows.length;
    const n = this._rowCount;
    for (const [name, old] of this.numericCache) {
      const vals = this.column(name).values;
      const a = new Float64Array(n);
      a.set(old);
      for (let i = from; i < n; i++) a[i] = toNumber(vals[i]);
      this.numericCache.set(name, a);
    }
    for (const [name, old] of this.codesCache) {
      const vals = this.column(name).values;
      const codes = new Int32Array(n);
      codes.set(old.codes);
      const dict = old.dict.slice();
      const seen = new Map(old.seen);
      for (let i = from; i < n; i++) codes[i] = encode(vals[i], dict, seen);
      this.codesCache.set(name, { codes, dict, seen });
    }
    for (const [name, old] of this.indexes) {
      const vals = this.column(name).values;
      const idx = new Map(old);
      const touched = new Set<unknown>();
      let added = false;
      for (let i = from; i < n; i++) {
        const k = valueKey(vals[i]);
        const list = idx.get(k);
        if (!list) {
          idx.set(k, [i]);
          added = true;
        } else if (touched.has(k)) list.push(i);
        else idx.set(k, [...list, i]); // copy on first write: the old index keeps its lists
        touched.add(k);
      }
      this.indexes.set(name, idx);
      if (added) this.distinctCache.delete(name);
      this.extendBitmap(name, idx, touched, from);
    }
    // views of columns that were never indexed are built on demand as usual
    for (const name of [...this.bitmaps.keys()]) if (!this.indexes.has(name)) this.bitmaps.delete(name);
    for (const name of [...this.distinctCache.keys()]) if (!this.indexes.has(name)) this.distinctCache.delete(name);
  }

  /** Grow a column's bitmaps after an append (`touched`: values with rows added since `from`). */
  private extendBitmap(name: string, idx: Map<unknown, number[]>, touched: Set<unknown>, from: number): void {
    if (!this.bitmaps.has(name)) return;
    const old = this.bitmaps.get(name)!;
    const qualifies = this._rowCount >= BITMAP_MIN_ROWS && idx.size <= BITMAP_MAX_VALUES;
    if (!old || !qualifies) {
      // newly large enough: built on demand; too many values now: none
      if (qualifies) this.bitmaps.delete(name);
      else this.bitmaps.set(name, null);
      return;
    }
    const words = (this._rowCount + 31) >>> 5;
    const out = new Map<unknown, Uint32Array>();
    for (const [k, rows] of idx) {
      const prev = old.get(k);
      if (prev && prev.length === words && !touched.has(k)) {
        out.set(k, prev);
        continue;
      }
      const b = new Uint32Array(words);
      if (prev) b.set(prev);
      for (let j = rows.length - 1; j >= 0 && rows[j] >= from; j--) {
        const r = rows[j];
        b[r >>> 5] |= 1 << (r & 31);
      }
      out.set(k, b);
    }
    this.bitmaps.set(name, out);
  }

  /**
   * Drop the first `n` rows (sliding windows for streaming data). Numeric views, codes and indexes are shifted rather
   * than rebuilt; bitmaps are rebuilt on demand.
   */
  removeFirst(n: number): void {
    if (n <= 0) return;
    const k = Math.min(n, this._rowCount);
    for (const col of this.columns.values()) col.values.splice(0, k);
    this._rowCount -= k;
    this.bitmaps.clear();
    for (const [name, a] of this.numericCache) this.numericCache.set(name, a.slice(k));
    for (const [name, old] of this.indexes) {
      const idx = new Map<unknown, number[]>();
      for (const [key, rows] of old) {
        // rows are ascending: find the first one that survives
        let lo = 0;
        let hi = rows.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (rows[mid] < k) lo = mid + 1;
          else hi = mid;
        }
        if (lo === rows.length) continue;
        const list = new Array<number>(rows.length - lo);
        for (let j = lo; j < rows.length; j++) list[j - lo] = rows[j] - k;
        idx.set(key, list);
      }
      if (idx.size !== old.size) this.distinctCache.delete(name);
      this.indexes.set(name, idx);
    }
    for (const name of [...this.distinctCache.keys()]) if (!this.indexes.has(name)) this.distinctCache.delete(name);
    for (const [name, c] of this.codesCache) {
      // dictionary entries of dropped values linger (harmless to every reader); rebuild once they dominate
      const live = this.indexes.get(name)?.size;
      if (live === undefined || c.dict.length > 2 * live + 64) this.codesCache.delete(name);
      else this.codesCache.set(name, { ...c, codes: c.codes.slice(k) });
    }
  }

  /** Rename a column in place (order and values kept; sort-by references follow). */
  renameColumn(from: string, to: string): void {
    if (!this.columns.has(from)) throw new Error(`Column "${from}" not found in table "${this.name}"`);
    if (this.columns.has(to)) throw new Error(`Column "${to}" already exists in table "${this.name}"`);
    const entries = [...this.columns];
    this.columns.clear();
    for (const [k, c] of entries) {
      const col = k === from ? { ...c, name: to } : c;
      if (col.sortBy === from) col.sortBy = to;
      this.columns.set(col.name, col);
    }
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

  /**
   * Bitmap index: one bitset (32 rows per word) per value, for low-cardinality columns of large tables, so filters
   * combine with word-wide OR / AND instead of merging row lists. Null when the column doesn't qualify.
   */
  bitmap(column: string): Map<unknown, Uint32Array> | null {
    if (this.bitmaps.has(column)) return this.bitmaps.get(column)!;
    let out: Map<unknown, Uint32Array> | null = null;
    const idx = this.index(column);
    if (this._rowCount >= BITMAP_MIN_ROWS && idx.size <= BITMAP_MAX_VALUES) {
      const words = (this._rowCount + 31) >>> 5;
      out = new Map();
      for (const [k, rows] of idx) {
        const b = new Uint32Array(words);
        for (const r of rows) b[r >>> 5] |= 1 << (r & 31);
        out.set(k, b);
      }
    }
    this.bitmaps.set(column, out);
    return out;
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
