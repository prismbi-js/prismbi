/**
 * Columns packed as typed arrays (numbers and dates as `Float64Array`, text as `Int32Array` codes plus a dictionary):
 * they cross thread boundaries without copying and store compactly (worker engine, table cache).
 */
import type { DataModel } from './model';
import type { ColumnSchema } from './types';

/** A column ready to cross a thread boundary: typed arrays move without copying. */
export type PackedColumn =
  | { kind: 'number' | 'date'; data: Float64Array }
  | { kind: 'text'; codes: Int32Array; dict: string[] }
  | { kind: 'values'; values: unknown[] };

const isTyped = (a: unknown): a is ArrayLike<number> & ArrayBufferView => ArrayBuffer.isView(a) && !(a instanceof DataView);
export const isShared = (a: ArrayBufferView) => typeof SharedArrayBuffer !== 'undefined' && a.buffer instanceof SharedArrayBuffer;

/** Pack one column: numbers and dates → Float64Array (NaN for blank), text → codes and a dictionary, else as is. */
export function packColumn(values: ArrayLike<unknown>, type?: ColumnSchema['type']): PackedColumn {
  if (isTyped(values) && type !== 'string' && type !== 'boolean') return { kind: type === 'date' ? 'date' : 'number', data: values instanceof Float64Array ? values : Float64Array.from(values) };
  const n = values.length;
  let first: unknown = null;
  for (let i = 0; i < n && (first === null || first === undefined || first === ''); i++) first = values[i];
  const want = type ?? (typeof first === 'number' ? 'number' : first instanceof Date ? 'date' : typeof first === 'string' ? 'string' : undefined);
  if (want === 'number' || want === 'date') {
    const data = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (v === null || v === undefined) data[i] = NaN;
      else if (want === 'number' && typeof v === 'number') data[i] = v;
      else if (want === 'date' && v instanceof Date) data[i] = v.getTime();
      else return { kind: 'values', values: Array.from(values) };
    }
    return { kind: want, data };
  }
  if (want === 'string') {
    const codes = new Int32Array(n);
    const dict: string[] = [];
    const seen = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (v === null || v === undefined || v === '') codes[i] = -1;
      else if (typeof v !== 'string') return { kind: 'values', values: Array.from(values) };
      else {
        let c = seen.get(v);
        if (c === undefined) seen.set(v, (c = dict.push(v) - 1));
        codes[i] = c;
      }
    }
    return { kind: 'text', codes, dict };
  }
  return { kind: 'values', values: Array.from(values) };
}

/** Add (or replace) a table from packed columns; the typed arrays become its numeric and dictionary views. */
export function addPackedTable(model: DataModel, name: string, cols: Record<string, PackedColumn>, schema: Record<string, ColumnSchema> = {}): void {
  const raw: Record<string, unknown[]> = {};
  const types: Record<string, ColumnSchema> = { ...schema };
  for (const [col, c] of Object.entries(cols)) {
    if (c.kind === 'values') raw[col] = c.values;
    else if (c.kind === 'text') {
      const { codes, dict } = c;
      const v = new Array<string | null>(codes.length);
      for (let i = 0; i < codes.length; i++) v[i] = codes[i] < 0 ? null : dict[codes[i]];
      raw[col] = v;
      types[col] = { ...schema[col], type: 'string' };
    } else {
      const d = c.data;
      const v = new Array<number | Date | null>(d.length);
      for (let i = 0; i < d.length; i++) v[i] = Number.isFinite(d[i]) ? (c.kind === 'date' ? new Date(d[i]) : d[i]) : null;
      raw[col] = v;
      types[col] = { ...schema[col], type: c.kind };
    }
  }
  const t = model.addColumns(name, raw, types).table(name);
  for (const [col, c] of Object.entries(cols)) {
    if (c.kind === 'text') t.adoptViews(col, { codes: c.codes, dict: c.dict });
    else if (c.kind !== 'values') {
      // blanks (and infinities, which load as blank) are NaN in the numeric view; copy rather than change the sender's array
      let d = c.data;
      for (let i = 0; i < d.length; i++)
        if (d[i] === Infinity || d[i] === -Infinity) {
          if (d === c.data) d = d.slice();
          d[i] = NaN;
        }
      t.adoptViews(col, { numeric: d });
    }
  }
}

