// @vitest-environment node
/**
 * Bitmap index benchmark: `npm run bench`. Filters on low-cardinality columns of a 1M-row fact table (and through
 * relationships to small dimensions), timed with bitmap indexes off and on. Each run uses a fresh model (no caches).
 */
import { expect, it } from 'vitest';
import { DataModel, setBitmapIndexes } from '../src/index';
import type { QuerySpec } from '../src/index';

function generate(n: number): DataModel {
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const channels = ['Online', 'Store', 'Reseller', 'Partner'];
  const sales = Array.from({ length: n }, () => ({
    ProductKey: Math.floor(rnd() * 400),
    RegionKey: Math.floor(rnd() * 40),
    Channel: channels[Math.floor(rnd() * 4)],
    Priority: Math.floor(rnd() * 5),
    SalesAmount: Math.round(rnd() * 50000) / 100,
  }));
  return new DataModel()
    .addTable('Sales', sales)
    .addTable('Product', Array.from({ length: 400 }, (_, i) => ({ ProductKey: i, Category: `C${i % 12}` })))
    .addTable('Region', Array.from({ length: 40 }, (_, i) => ({ RegionKey: i, Country: `K${i % 6}` })))
    .addRelationship({ from: 'Sales[ProductKey]', to: 'Product[ProductKey]' })
    .addRelationship({ from: 'Sales[RegionKey]', to: 'Region[RegionKey]' })
    .addMeasure('Total Sales', 'SUM(Sales[SalesAmount])');
}

const QUERIES: [string, QuerySpec][] = [
  ['channel in (2 of 4) × priority in (3 of 5)', { values: ['Total Sales'], filters: [{ target: 'Sales[Channel]', op: 'in', values: ['Online', 'Store'] }, { target: 'Sales[Priority]', op: 'in', values: [0, 1, 2] }] }],
  ['country (via 40 regions) × channel', { values: ['Total Sales'], filters: [{ target: 'Region[Country]', op: 'in', values: ['K0', 'K1', 'K2'] }, { target: 'Sales[Channel]', op: 'eq', value: 'Online' }] }],
  ['country × channel × priority, by channel', { groupBy: ['Sales[Channel]'], values: ['Total Sales'], filters: [{ target: 'Region[Country]', op: 'in', values: ['K0', 'K3'] }, { target: 'Sales[Priority]', op: 'in', values: [1, 2, 3, 4] }] }],
];

it('bitmap index benchmark', () => {
  const n = 1_000_000;
  const lines = [`\n${n.toLocaleString('en-US')} rows, filters on low-cardinality columns (fresh model per run)`];
  for (const [name, spec] of QUERIES) {
    const time = (on: boolean) => {
      setBitmapIndexes(on);
      const m = generate(n);
      m.query({ values: ['Total Sales'] }); // build column indexes outside the timing
      m.table('Sales').index('Channel');
      m.table('Sales').index('Priority');
      m.table('Sales').index('RegionKey');
      if (on) for (const c of ['Channel', 'Priority', 'RegionKey']) m.table('Sales').bitmap(c);
      const t0 = performance.now();
      const r = m.query(spec);
      return { ms: performance.now() - t0, r };
    };
    const off = time(false);
    const on = time(true);
    setBitmapIndexes(true);
    expect(on.r.rows).toEqual(off.r.rows);
    lines.push(`  ${name.padEnd(46)} lists ${off.ms.toFixed(0).padStart(5)} ms · bitmaps ${on.ms.toFixed(0).padStart(5)} ms (${(off.ms / Math.max(0.1, on.ms)).toFixed(1)}×)`);
  }
  console.log(lines.join('\n'));
}, 600_000);
