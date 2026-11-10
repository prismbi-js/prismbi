import type { DataModel } from '../data/model';
import type { ColumnSchema, Row } from '../data/types';

export interface ArrowVectorLike {
  get(i: number): unknown;
  toArray?(): ArrayLike<unknown>;
  nullCount?: number;
  isValid?(i: number): boolean;
}

/** The parts of an Apache Arrow `Table` (apache-arrow ≥ 9) that PrismBI reads – no dependency on the package. */
export interface ArrowTableLike {
  numRows: number;
  schema: { fields: { name: string; type: { typeId: number } }[] };
  getChild(name: string): ArrowVectorLike | null;
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
  return model.hasTable(name) ? model.refreshColumns(name, cols, schema) : model.addColumns(name, cols, schema);
}

/** Minimal DuckDB connection interface (compatible with DuckDB-Wasm and DuckDB Node bindings). */
export interface DuckDbConnectionLike {
  query(sql: string): Promise<ArrowTableLike | unknown>;
}

export interface DuckDbTableSpec {
  /** Target table name in the DataModel. */
  table: string;
  /** Custom SQL query to execute. Defaults to `SELECT * FROM "${table}"` or `SELECT * FROM read_parquet('${parquet}')`. */
  query?: string;
  /** Path or URL to a Parquet file (e.g. `'data.parquet'` or `'https://.../data.parquet'`). */
  parquet?: string;
  /** Optional column schemas (types, formats, hidden, sortBy). */
  schema?: Record<string, ColumnSchema>;
}

/**
 * Ingest a table directly from DuckDB-Wasm or a Parquet file into the DataModel's columnar storage.
 * If `spec.parquet` is provided, executes `SELECT * FROM read_parquet('...')`.
 */
export async function loadDuckDbTable(
  model: DataModel,
  conn: DuckDbConnectionLike,
  spec: DuckDbTableSpec
): Promise<DataModel> {
  const sql = spec.query ?? (spec.parquet ? `SELECT * FROM read_parquet('${spec.parquet.replace(/'/g, "''")}')` : `SELECT * FROM "${spec.table.replace(/"/g, '""')}"`);
  const res = await conn.query(sql);
  if (res && typeof res === 'object' && 'schema' in res && 'numRows' in res && typeof (res as ArrowTableLike).getChild === 'function') {
    return addArrowTable(model, spec.table, res as ArrowTableLike, spec.schema);
  }
  const rows = Array.isArray(res) ? res : ((res as { toArray?: () => unknown[] })?.toArray?.() ?? []);
  const jsonRows = rows.map((r) => (r && typeof r === 'object' && 'toJSON' in r && typeof (r as { toJSON: unknown }).toJSON === 'function' ? (r as { toJSON: () => Row }).toJSON() : (r as Row)));
  return model.hasTable(spec.table) ? model.refreshTable(spec.table, jsonRows, spec.schema) : model.addTable(spec.table, jsonRows, spec.schema);
}

/** Ingest multiple tables or Parquet files from DuckDB-Wasm in parallel. */
export async function loadDuckDbTables(
  model: DataModel,
  conn: DuckDbConnectionLike,
  specs: DuckDbTableSpec[]
): Promise<DataModel> {
  await Promise.all(specs.map((s) => loadDuckDbTable(model, conn, s)));
  return model;
}
