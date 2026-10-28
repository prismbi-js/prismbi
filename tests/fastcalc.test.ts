import { afterEach, describe, expect, it } from 'vitest';
import { setFastQuery, DataModel } from '../src/index';
import type { QuerySpec } from '../src/index';
import { buildModel } from '../examples/model';

const model = buildModel()
  .addMeasure('Bike Sales', 'CALCULATE([Total Sales], Product[Category] = "Bikes")')
  .addMeasure('Online Units', 'CALCULATE([Units], Sales[Channel] = "Online")')
  .addMeasure('Big Line Sales', 'CALCULATE([Total Sales], Sales[SalesAmount] > 1000)')
  .addMeasure('Bike Share', 'DIVIDE([Bike Sales], [Total Sales])')
  .addMeasure('Two Regions', 'CALCULATE([Orders], Region[Country] IN {"Canada", "Germany"})')
  .addMeasure('Nested', 'CALCULATE(CALCULATE([Total Sales], Product[Category] = "Accessories"), Product[Category] = "Bikes")')
  .addMeasure('Kept', 'CALCULATE(CALCULATE([Total Sales], KEEPFILTERS(Product[Category] = "Accessories")), Product[Category] IN {"Bikes", "Accessories"})')
  .addMeasure('Bike Rows', 'CALCULATE(COUNTROWS(Sales), Product[Category] = "Bikes", Sales[Channel] <> "Store")')
  .addMeasure('Bike Profit X', 'CALCULATE(SUMX(Sales, Sales[SalesAmount] - Sales[TotalCost]), Product[Category] = "Bikes")');

const run = (spec: QuerySpec, mode: 'always' | 'off') => {
  setFastQuery(mode);
  model.evaluator.clearCache?.();
  return model.query(spec);
};

afterEach(() => setFastQuery('auto'));

const MEASURES = ['Total Sales', 'Bike Sales', 'Online Units', 'Big Line Sales', 'Bike Share', 'Two Regions', 'Nested', 'Kept', 'Bike Rows', 'Bike Profit X'];

describe('CALCULATE in the single-pass grouped path', () => {
  const cases: [string, QuerySpec][] = [
    ['two dimensions', { groupBy: ['Region[Country]', 'Date[Year]'], values: MEASURES, totals: true }],
    ['with query filters on other columns', { groupBy: ['Product[Subcategory]', 'Sales[Channel]'], values: ['Bike Sales', 'Two Regions', 'Bike Share'], filters: [{ target: 'Date[Year]', op: 'eq', value: 2025 }, { target: 'Region[Group]', op: 'in', values: ['Europe', 'Pacific'] }], totals: true }],
    ['with highlights', { groupBy: ['Region[Country]', 'Date[Quarter]'], values: ['Bike Sales', 'Online Units'], highlight: [{ target: 'Sales[Channel]', op: 'eq', value: 'Reseller' }] }],
  ];
  for (const [name, spec] of cases) {
    it(`matches the general engine: ${name}`, () => {
      const fast = run(spec, 'always');
      const slow = run(spec, 'off');
      expect(fast.rows.length).toBe(slow.rows.length);
      const byKey = new Map(slow.rows.map((r) => [JSON.stringify(r.keys), r]));
      for (const r of fast.rows) {
        const s = byKey.get(JSON.stringify(r.keys))!;
        expect(s).toBeDefined();
        r.values.forEach((v, i) => (typeof v === 'number' ? expect(v).toBeCloseTo(s.values[i] as number, 6) : expect(v).toBe(s.values[i])));
        r.highlights?.forEach((v, i) => (typeof v === 'number' ? expect(v).toBeCloseTo(s.highlights![i] as number, 6) : expect(v).toBe(s.highlights![i])));
      }
      fast.totals?.forEach((v, i) => (typeof v === 'number' ? expect(v).toBeCloseTo(slow.totals![i] as number, 6) : expect(v).toBe(slow.totals![i])));
    });
  }

  it('steps aside when CALCULATE replaces a filter the query uses', () => {
    // grouped by the filtered column: every category shows the Bikes value, which one pass over the rows can't produce
    const spec: QuerySpec = { groupBy: ['Product[Category]', 'Date[Year]'], values: ['Bike Sales'] };
    const fast = run(spec, 'always');
    const slow = run(spec, 'off');
    expect(fast.rows.map((r) => r.keys)).toEqual(slow.rows.map((r) => r.keys));
    fast.rows.forEach((r, i) => expect(r.values[0] as number).toBeCloseTo(slow.rows[i].values[0] as number, 4));
    expect(new Set(fast.rows.filter((r) => r.keys[1] === 2025).map((r) => Math.round(r.values[0] as number))).size).toBe(1);
  });
});

describe('iterators over VALUES evaluated set-wise', () => {
  const m = buildModel()
    .addMeasure('Avg Daily Sales', 'AVERAGEX(VALUES(Date[Date]), [Total Sales])')
    .addMeasure('Best Product Sales', 'MAXX(VALUES(Product[Name]), [Total Sales])')
    .addMeasure('Worst Country Margin', 'MINX(VALUES(Region[Country]), [Margin %])')
    .addMeasure('Selling Days', 'COUNTX(VALUES(Date[Date]), [Total Sales])')
    .addMeasure('Rolling 3M Daily Avg', 'CALCULATE(AVERAGEX(VALUES(Date[Date]), [Total Sales]), DATESINPERIOD(Date[Date], MAX(Date[Date]), -3, MONTH))')
    .addMeasure('Sum Of Category Shares', 'SUMX(VALUES(Product[Category]), DIVIDE([Total Sales], CALCULATE([Total Sales], ALL(Product))))');
  const spec: QuerySpec = { groupBy: ['Product[Category]', 'Date[Year]'], values: ['Avg Daily Sales', 'Best Product Sales', 'Worst Country Margin', 'Selling Days', 'Rolling 3M Daily Avg', 'Sum Of Category Shares'], filters: [{ target: 'Region[Group]', op: 'in', values: ['Europe', 'North America'] }], totals: true };
  const q = (mode: 'off' | 'auto') => {
    setFastQuery(mode);
    m.evaluator.clearCache?.();
    const r = m.query(spec);
    const norm = (v: unknown) => (typeof v === 'number' ? Number(v.toPrecision(10)) : v);
    return { rows: r.rows.map((x) => [x.keys, x.values.map(norm)]), totals: r.totals?.map(norm) };
  };
  it('matches row-by-row evaluation', () => {
    expect(q('auto')).toEqual(q('off'));
  });
});

describe('high-cardinality BigInt composite grouping', () => {
  it('groups correctly across composite spaces exceeding MAX_SAFE_INTEGER', () => {
    // 6 columns with 600 distinct values each: (600)^6 = 4.66e16 > Number.MAX_SAFE_INTEGER (9.0e15)
    const n = 100;
    const rows = Array.from({ length: n }, (_, i) => ({
      c1: `c1_${i % 600}`,
      c2: `c2_${i % 600}`,
      c3: `c3_${i % 600}`,
      c4: `c4_${i % 600}`,
      c5: `c5_${i % 600}`,
      c6: `c6_${i % 600}`,
      amount: i * 10,
    }));
    const dm = new DataModel().addTable('LargeSpace', rows).addMeasure('Total', 'SUM(LargeSpace[amount])');
    const spec: QuerySpec = {
      groupBy: ['LargeSpace[c1]', 'LargeSpace[c2]', 'LargeSpace[c3]', 'LargeSpace[c4]', 'LargeSpace[c5]', 'LargeSpace[c6]'],
      values: ['Total'],
      totals: true,
    };
    setFastQuery('always');
    const fast = dm.query(spec);
    setFastQuery('off');
    const slow = dm.query(spec);
    expect(fast.rows.length).toBe(slow.rows.length);
    expect(fast.totals).toEqual(slow.totals);
  });
});
