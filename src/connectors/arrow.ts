import type { DataModel } from '../data/model';
import type { ColumnSchema, Row } from '../data/types';

/** The parts of an Apache Arrow `Table` (apache-arrow ≥ 9) that PrismBI reads – no dependency on the package. */
export interface ArrowTableLike {
  numRows: number;
  schema: { fields: { name: string; type: { typeId: number } }[] };
  getChild(name: string): { get(i: number): unknown; toArray?(): ArrayLike<unknown> } | null;
}

// Arrow Type ids (apache-arrow `Type` enum)
const DATE = 8;
const TIMESTAMP = 10;

function cell(v: unknown, temporal: boolean): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') v = Number(v);
  if (temporal && typeof v === 'number') return new Date(v);
  // structs, lists, decimals
  if (typeof v === 'object' && v !== null && !(v instanceof Date)) {
    const j = (v as { toJSON?: () => unknown }).toJSON;
    return j ? JSON.stringify(j.call(v)) : String(v);
  }
  return v;
}

/** Convert an Arrow table into plain column arrays (BigInt → number, dates/timestamps → Date). */
export function arrowColumns(table: ArrowTableLike): Record<string, unknown[]> {
  const cols: Record<string, unknown[]> = {};
  for (const f of table.schema.fields) {
    const vec = table.getChild(f.name);
    if (!vec) continue;
    const temporal = f.type.typeId === DATE || f.type.typeId === TIMESTAMP;
    const out = new Array(table.numRows);
    for (let i = 0; i < table.numRows; i++) out[i] = cell(vec.get(i), temporal);
    cols[f.name] = out;
  }
  return cols;
}

/** Add (or replace) a model table from an Arrow table, e.g. one read from Parquet with DuckDB-Wasm. */
export function addArrowTable(model: DataModel, name: string, table: ArrowTableLike, schema?: Record<string, ColumnSchema>): DataModel {
  const cols = arrowColumns(table);
  const names = Object.keys(cols);
  const rows = Array.from({ length: table.numRows }, (_, i) => Object.fromEntries(names.map((n) => [n, cols[n][i]])));
  return model.hasTable(name) ? model.refreshTable(name, rows as Row[], schema) : model.addTable(name, rows as Row[], schema);
}
