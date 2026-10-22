// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DataModel } from '@prismbi/prismbi/core';
import { cachedTables, clearCachedTables, loadTables, saveTables, type TableStore } from '@prismbi/prismbi/connectors';
import { buildModel } from '../examples/model';

/** A store that structured-clones what it keeps, like IndexedDB. */
function memoryStore(): TableStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return { data, get: async (k) => structuredClone(data.get(k)), set: async (k, v) => void data.set(k, structuredClone(v)), delete: async (k) => void data.delete(k) };
}

describe('table cache (warm start)', () => {
  it('restores stored columns exactly, keeping types, formats and sort-by', async () => {
    const src = buildModel();
    const store = memoryStore();
    await saveTables(src, 'demo', { store, tables: ['Sales', 'Product', 'Date'] });
    const m = new DataModel();
    expect(await loadTables(m, 'demo', { store })).toEqual(['Sales', 'Product', 'Date']);
    for (const name of ['Sales', 'Product', 'Date']) {
      const a = src.table(name);
      const b = m.table(name);
      expect(b.rowCount).toBe(a.rowCount);
      for (const c of b.columns.values()) {
        const o = a.column(c.name);
        expect(o.expression).toBeUndefined(); // calculated columns are not stored
        expect([c.type, c.format, c.sortBy, c.hidden]).toEqual([o.type, o.format, o.sortBy, o.hidden]);
        expect(c.values.map((v) => (v instanceof Date ? v.getTime() : v))).toEqual(o.values.map((v) => (v instanceof Date ? v.getTime() : v)));
      }
    }
    // the restored model answers like the original once modelled again
    m.addRelationship({ from: 'Sales[ProductKey]', to: 'Product[ProductKey]' }).addRelationship({ from: 'Sales[OrderDate]', to: 'Date[Date]' }).addMeasure('Total Sales', 'SUM(Sales[SalesAmount])');
    const q = { groupBy: ['Product[Category]', 'Date[Year]'], values: ['Total Sales'] };
    expect(m.query(q).rows).toEqual(src.query(q).rows);
  });

  it('loads once, then serves from the cache until it is stale, versioned out or cleared', async () => {
    const store = memoryStore();
    let loads = 0;
    const load = (m: DataModel) => async () => {
      loads++;
      m.addTable('T', [{ k: 'a', v: 1 }, { k: null, v: null }, { k: 'b', v: 2.5 }]);
    };
    const m1 = new DataModel();
    expect(await cachedTables(m1, 't', load(m1), { store, version: '1' })).toBe('loaded');
    const m2 = new DataModel();
    expect(await cachedTables(m2, 't', load(m2), { store, version: '1' })).toBe('cache');
    expect(m2.table('T').column('k').values).toEqual(['a', null, 'b']);
    expect(m2.table('T').column('v').values).toEqual([1, null, 2.5]);
    expect(loads).toBe(1);
    expect(await cachedTables(new DataModel(), 't', async () => loads++, { store, version: '2' })).toBe('loaded');
    expect(await loadTables(new DataModel(), 't', { store, version: '2', maxAgeMs: -1 })).toBeNull();
    await clearCachedTables('t', store);
    expect(await loadTables(new DataModel(), 't', { store, version: '2' })).toBeNull();
    // storage failures are a miss, not an error
    const broken: TableStore = { get: async () => Promise.reject(new Error('quota')), set: async () => Promise.reject(new Error('quota')), delete: async () => undefined };
    const m3 = new DataModel();
    expect(await cachedTables(m3, 't', load(m3), { store: broken })).toBe('loaded');
    expect(m3.table('T').rowCount).toBe(3);
  });
});
