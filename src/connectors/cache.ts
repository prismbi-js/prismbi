/**
 * Warm start: keep loaded tables in the browser (IndexedDB) as packed typed columns, so a returning visitor skips
 * fetching and parsing. Only data is stored; relationships, measures and calculated columns stay in your code and
 * are defined again after the tables are restored.
 */
import type { DataModel } from '../data/model';
import type { ColumnSchema } from '../data/types';
import { addPackedTable, packColumn, type PackedColumn } from '../data/packed';

/** Where cached tables live: IndexedDB by default ({@link idbStore}); anything with these methods works. */
export interface TableStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface TableCacheOptions {
  /** Tables to save (default: every table). */
  tables?: string[];
  /** Ignore a saved copy older than this. */
  maxAgeMs?: number;
  /** Ignore a saved copy made for another version of your data or code (e.g. a deploy id or an ETag). */
  version?: string;
  store?: TableStore;
}

interface Saved {
  format: 1;
  at: number;
  version?: string;
  tables: { name: string; columns: Record<string, PackedColumn>; schema: Record<string, ColumnSchema> }[];
}

/** An IndexedDB object store as a {@link TableStore}. */
export function idbStore(dbName = 'prismbi-cache', storeName = 'tables'): TableStore {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(storeName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const run = async <T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const req = op(tx.objectStore(storeName));
      tx.oncomplete = () => (db.close(), resolve(req.result as T));
      tx.onerror = tx.onabort = () => (db.close(), reject(tx.error ?? req.error));
    });
  };
  return {
    get: (key) => run('readonly', (s) => s.get(key)),
    set: (key, value) => run('readwrite', (s) => s.put(value, key)),
    delete: (key) => run('readwrite', (s) => s.delete(key)),
  };
}

/** Save tables' stored columns (not calculated ones) under `key`. */
export async function saveTables(model: DataModel, key: string, opts: TableCacheOptions = {}): Promise<void> {
  const tables = (opts.tables ?? model.tableNames()).map((name) => {
    const t = model.table(name);
    const columns: Record<string, PackedColumn> = {};
    const schema: Record<string, ColumnSchema> = {};
    for (const c of t.columns.values()) {
      if (c.expression) continue;
      // numbers and dates reuse the table's numeric view (BLANK as NaN)
      columns[c.name] = c.type === 'number' || c.type === 'date' ? { kind: c.type, data: t.numeric(c.name).slice() } : packColumn(c.values, c.type);
      schema[c.name] = { type: c.type, format: c.format, hidden: c.hidden, sortBy: c.sortBy, description: c.description, folder: c.folder };
    }
    return { name, columns, schema };
  });
  const saved: Saved = { format: 1, at: Date.now(), version: opts.version, tables };
  await (opts.store ?? idbStore()).set(key, saved);
}

/**
 * Restore tables saved under `key` into the model. Returns their names, or null when there is no usable copy
 * (missing, older than `maxAgeMs`, another `version`, or storage unavailable).
 */
export async function loadTables(model: DataModel, key: string, opts: TableCacheOptions = {}): Promise<string[] | null> {
  let saved: Saved | undefined;
  try {
    saved = (await (opts.store ?? idbStore()).get(key)) as Saved | undefined;
  } catch {
    return null;
  }
  if (!saved || saved.format !== 1 || saved.version !== opts.version) return null;
  if (opts.maxAgeMs !== undefined && Date.now() - saved.at > opts.maxAgeMs) return null;
  const wanted = opts.tables && new Set(opts.tables);
  const tables = saved.tables.filter((t) => !wanted || wanted.has(t.name));
  for (const t of tables) addPackedTable(model, t.name, t.columns, t.schema);
  return tables.map((t) => t.name);
}

/**
 * Restore tables from the cache, or run `load` (which adds them to the model) and save the result.
 * Resolves to where the data came from.
 *
 * ```ts
 * await cachedTables(model, 'sales-v3', async () => model.addTable('Sales', await loadCsv('/sales.csv')), { maxAgeMs: 864e5 });
 * model.addRelationship(...).addMeasure(...);
 * ```
 */
export async function cachedTables(model: DataModel, key: string, load: () => unknown, opts: TableCacheOptions = {}): Promise<'cache' | 'loaded'> {
  if ((await loadTables(model, key, opts))?.length) return 'cache';
  const before = new Set(model.tableNames());
  await load();
  // save what `load` added (or the tables asked for); a failing store must not fail the page
  const tables = opts.tables ?? model.tableNames().filter((n) => !before.has(n));
  await saveTables(model, key, { ...opts, tables }).catch(() => undefined);
  return 'loaded';
}

/** Forget a saved copy. */
export async function clearCachedTables(key: string, store: TableStore = idbStore()): Promise<void> {
  await store.delete(key);
}
