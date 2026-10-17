// @vitest-environment node
/**
 * Scale benchmark: `npm run bench`. Generates fact tables of 200k and 1M rows and times typical report queries
 * cold (caches cleared before each run). Budgets are generous ceilings for regressions, not targets.
 */
import { expect, it } from 'vitest';
import { DataModel, setFastQuery } from '../src/index';
import type { QuerySpec } from '../src/index';

function generate(n: number): DataModel {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const products = Array.from({ length: 400 }, (_, i) => ({ ProductKey: i, Name: `P${i}`, Category: `C${i % 12}` }));
  const regions = Array.from({ length: 40 }, (_, i) => ({ RegionKey: i, Region: `R${i}`, Country: `K${i % 6}` }));
  const start = new Date(2024, 0, 1).getTime();
  const sales = Array.from({ length: n }, (_, i) => ({
    OrderNumber: Math.floor(i / 3),
    ProductKey: Math.floor(rnd() * 400),
    RegionKey: Math.floor(rnd() * 40),
    OrderDate: new Date(start + Math.floor(rnd() * 730) * 86_400_000),
    Quantity: 1 + Math.floor(rnd() * 5),
    SalesAmount: Math.round(rnd() * 50000) / 100,
  }));
  return new DataModel()
    .addTable('Sales', sales)
    .addTable('Product', products)
    .addTable('Region', regions)
    .addDateTable('Date', '2024-01-01', '2025-12-31')
    .addRelationship({ from: 'Sales[ProductKey]', to: 'Product[ProductKey]' })
    .addRelationship({ from: 'Sales[RegionKey]', to: 'Region[RegionKey]' })
    .addRelationship({ from: 'Sales[OrderDate]', to: 'Date[Date]' })
    .addMeasure('Total Sales', 'SUM(Sales[SalesAmount])')
    .addMeasure('Orders', 'DISTINCTCOUNT(Sales[OrderNumber])')
    .addMeasure('AOV', 'DIVIDE([Total Sales], [Orders])')
    .addMeasure('YTD', 'TOTALYTD([Total Sales], Date[Date])')
    .addMeasure('C1 Sales', 'CALCULATE([Total Sales], Product[Category] = "C1")');
}

const year = [{ target: 'Date[Year]', op: 'eq' as const, value: 2025 }];
const QUERIES: [string, QuerySpec, number][] = [
  // name, query, budget in ms at 1M rows
  ['category × sales, AOV', { groupBy: ['Product[Category]'], values: ['Total Sales', 'AOV'], filters: year, totals: true }, 1500],
  ['product × region (16k groups)', { groupBy: ['Product[Name]', 'Region[Region]'], values: ['Total Sales'], filters: year }, 1500],
  ['day × sales (365 groups)', { groupBy: ['Date[Date]'], values: ['Total Sales'], filters: year }, 800],
  ['product × region, CALCULATE filter', { groupBy: ['Product[Name]', 'Region[Region]'], values: ['C1 Sales'], filters: year }, 1500],
  ['day × YTD (time intelligence)', { groupBy: ['Date[Date]'], values: ['YTD'], filters: year }, 1500],
];

it('scale benchmark', () => {
  const lines: string[] = [];
  for (const n of [200_000, 1_000_000]) {
    const t0 = performance.now();
    const m = generate(n);
    lines.push(`\n${n.toLocaleString('en-US')} rows · generate + load ${(performance.now() - t0).toFixed(0)} ms`);
    const cold = (spec: QuerySpec) => {
      (m as unknown as { clearCaches(): void }).clearCaches();
      const a = performance.now();
      m.query(spec);
      return performance.now() - a;
    };
    for (const [name, spec, budget] of QUERIES) {
      setFastQuery('auto');
      cold(spec); // first run builds column views and indexes
      const auto = cold(spec);
      let general = NaN;
      if (n <= 200_000) {
        setFastQuery('off');
        general = cold(spec);
        setFastQuery('auto');
      }
      lines.push(`  ${name.padEnd(32)} ${auto.toFixed(0).padStart(6)} ms${Number.isNaN(general) ? '' : `   (per-group engine ${general.toFixed(0)} ms)`}`);
      if (n === 1_000_000) expect(auto, name).toBeLessThan(budget);
    }
  }
  console.log(lines.join('\n'));
}, 600_000);
