import { describe, expect, it } from 'vitest';
import { DataModel, DataTable } from '@prismbi/prismbi/core';

describe('Memory Diagnostics & Compaction', () => {
  it('reports table and column memory breakdown accurately', () => {
    const table = new DataTable('Sales', [
      { id: 1, region: 'North', amount: 100 },
      { id: 2, region: 'South', amount: 200 },
      { id: 3, region: 'North', amount: 150 },
    ]);

    // Force index and bitmap on region
    table.index('region');

    const stats = table.memoryStats();
    expect(stats.name).toBe('Sales');
    expect(stats.rowCount).toBe(3);
    expect(stats.columnCount).toBe(3);
    expect(stats.totalBytes).toBeGreaterThan(0);
    expect(stats.indexesCount).toBe(1);

    const regStats = stats.columns['region'];
    expect(regStats.name).toBe('region');
    expect(regStats.type).toBe('string');
    expect(regStats.rowCount).toBe(3);
    expect(regStats.distinctCount).toBe(2);
    expect(regStats.valuesBytes).toBe(3 * 8);
    expect(regStats.dictionaryBytes).toBeGreaterThan(0);
    expect(regStats.indexBytes).toBeGreaterThan(0);
  });

  it('prunes inactive dictionary entries and transient caches on compact()', () => {
    const model = new DataModel();
    model.addTable('Live', [
      { tag: 'Alpha', val: 10 },
      { tag: 'Beta', val: 20 },
      { tag: 'Gamma', val: 30 },
    ]);

    const table = model.table('Live');
    // Force index and distinct cache
    table.index('tag');
    expect(table.distinct('tag')).toEqual(['Alpha', 'Beta', 'Gamma']);

    // Remove first 2 rows ('Alpha' and 'Beta' no longer exist in values)
    table.removeFirst(2);
    expect(table.rowCount).toBe(1);
    expect(table.column('tag').values).toEqual(['Gamma']);

    // Before compaction, dictionary pool retains old entries
    const beforeStats = table.memoryStats();
    expect(beforeStats.columns['tag'].dictionaryBytes).toBeGreaterThan(0);

    // Run compaction on model
    model.compact();

    // After compaction, distinct and numeric caches are cleared and rebuilt on demand
    const afterStats = table.memoryStats();
    expect(afterStats.columns['tag'].distinctCount).toBe(1);
    expect(table.distinct('tag')).toEqual(['Gamma']);
  });

  it('model.memoryStats() aggregates across multiple tables', () => {
    const model = new DataModel();
    model.addTable('Orders', [{ id: 1 }, { id: 2 }]);
    model.addTable('Customers', [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Charlie' }]);

    const stats = model.memoryStats();
    expect(stats.tableCount).toBe(2);
    expect(stats.rowCount).toBe(5);
    expect(stats.tables['Orders'].rowCount).toBe(2);
    expect(stats.tables['Customers'].rowCount).toBe(3);
    expect(stats.totalBytes).toBe(stats.tables['Orders'].totalBytes + stats.tables['Customers'].totalBytes);
  });
});
