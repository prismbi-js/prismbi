import type { DataModel } from '../data/model';
import type { ColumnSchema, Row } from '../data/types';

/**
 * Minimal contract for SQL sources. Wrap DuckDB-Wasm, sql.js, a server-side endpoint, … in a few lines:
 *
 * ```ts
 * const duck: SqlAdapter = { query: async (sql) => (await conn.query(sql)).toArray().map((r) => r.toJSON()) };
 * ```
 */
export interface SqlAdapter {
  query(sql: string, params?: unknown[], signal?: AbortSignal): Promise<Row[]>;
}

export interface SqlTableSpec {
  /** Model table name. */
  table: string;
  sql: string;
  params?: unknown[];
  schema?: Record<string, ColumnSchema>;
}

/** Load (or reload) model tables from SQL queries; tables load in parallel. */
export async function loadSqlTables(model: DataModel, adapter: SqlAdapter, specs: SqlTableSpec[], signal?: AbortSignal): Promise<DataModel> {
  const results = await Promise.all(specs.map((s) => adapter.query(s.sql, s.params, signal)));
  specs.forEach((s, i) => (model.hasTable(s.table) ? model.refreshTable(s.table, results[i], s.schema) : model.addTable(s.table, results[i], s.schema)));
  return model;
}
