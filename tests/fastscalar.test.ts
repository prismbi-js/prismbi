import { afterEach, describe, expect, it } from 'vitest';
import { setFastQuery } from '../src/index';
import type { QuerySpec } from '../src/index';
import { fastGroupQuery } from '../src/data/fastQuery';
import { buildModel } from '../examples/model';

const model = buildModel()
  .addMeasure('Switch Band', 'SWITCH(TRUE(), [Total Sales] > 200000, "High", [Total Sales] > 50000, "Mid", "Low")')
  .addMeasure('Zero If Blank', 'IF(ISBLANK([Total Sales]), 0, [Total Sales])')
  .addMeasure('Coalesced', 'COALESCE([Total Sales], 0)')
  .addMeasure('Both', 'IF([Total Sales] > 1000 && [Units] > 10, [Total Sales])')
  .addMeasure('Either', 'IF([Total Sales] > 500000 || [Units] < 50, [Units])')
  .addMeasure('Per Unit', 'VAR s = [Total Sales] VAR u = [Units] RETURN DIVIDE(s, u)')
  .addMeasure('Var In Calc', 'VAR all = [Total Sales] RETURN CALCULATE(DIVIDE([Total Sales], all), Sales[Channel] = "Online")')
  .addMeasure('Rounded', 'ROUND([Total Sales] / 1000, 1)')
  .addMeasure('Distance', 'ABS([Total Sales] - 100000)')
  .addMeasure('Larger', 'MAX([Total Sales], [Total Profit] * 3)')
  .addMeasure('Label', 'FORMAT([Units], "#,0") & " units"')
  .addMeasure('Not Small', 'NOT [Units] < 100')
  .addMeasure('Biggest Line', 'MAXX(Sales, Sales[SalesAmount] * Sales[Quantity])')
  .addMeasure('Smallest Line', 'MINX(Sales, Sales[SalesAmount] - Sales[TotalCost])')
  .addMeasure('Lines', 'COUNTX(Sales, Sales[SalesAmount])')
  .addMeasure('Distinct Orders', 'COUNTROWS(VALUES(Sales[OrderNumber]))')
  .addMeasure('Online F', 'CALCULATE([Total Sales], FILTER(Sales, Sales[Channel] = "Online"))')
  .addMeasure('Big F', 'CALCULATE([Units], FILTER(Sales, Sales[SalesAmount] * Sales[Quantity] > 2000 && RELATED(Product[Category]) <> "Bikes"))')
  .addMeasure('Nested F', 'CALCULATE(CALCULATE([Total Sales], FILTER(Sales, Sales[Channel] = "Online"), Product[Category] = "Bikes"), Product[Category] = "Accessories")')
  .addMeasure('Or F', 'CALCULATE(COUNTROWS(Sales), FILTER(Sales, ISBLANK(Sales[ShipDate]) || Sales[Quantity] >= 3))')
  .addMeasure('Keep F', 'CALCULATE([Total Sales], KEEPFILTERS(FILTER(Sales, NOT (Sales[Channel] = "Store"))))')
  .addMeasure('Count F', 'COUNTROWS(FILTER(Sales, Sales[Channel] = "Online" && Sales[Quantity] > 2))')
  .addMeasure('Iterated F', 'SUMX(VALUES(Product[Category]), CALCULATE(COUNTROWS(FILTER(Sales, Sales[Quantity] > 1 && UPPER(Sales[Channel]) = "ONLINE"))))')
  .addMeasure('Pct All', 'DIVIDE([Total Sales], CALCULATE([Total Sales], ALL(Product)))')
  .addMeasure('Pct Sub', 'DIVIDE([Total Sales], CALCULATE([Total Sales], REMOVEFILTERS(Product[Subcategory])))')
  .addMeasure('Pct Group', 'DIVIDE([Total Sales], CALCULATE([Total Sales], ALLEXCEPT(Region, Region[Group])))')
  .addMeasure('Pct Grand', 'DIVIDE([Units], CALCULATE([Units], ALL()))')
  .addMeasure('All Bikes', 'CALCULATE([Total Sales], ALL(Product), Product[Category] = "Bikes")')
  .addMeasure('Var Share', 'VAR s = [Total Sales] VAR t = CALCULATE([Total Sales], ALL(Product)) RETURN DIVIDE(s, t)')
  .addMeasure('Nested All', 'DIVIDE([Pct All], CALCULATE([Pct All], ALL(Region)))')
  .addMeasure('Rank Sub', 'RANKX(ALL(Product[Subcategory]), [Total Sales])')
  .addMeasure('Rank Country', 'RANKX(ALL(Region[Country]), [Units], [Units], ASC, DENSE)')
  .addMeasure('Rank Selected', 'RANKX(ALLSELECTED(Product[Subcategory]), [Margin %])')
  .addMeasure('Rank Of Value', 'RANKX(ALL(Product[Subcategory]), [Total Sales], [Total Sales] * 1.5)')
  .addMeasure('Top 3', 'IF(RANKX(ALL(Product[Subcategory]), [Total Sales]) <= 3, [Total Sales])')
  .addMeasure('Rolling 3M', 'CALCULATE([Total Sales], DATESINPERIOD(Date[Date], MAX(Date[Date]), -3, MONTH))')
  .addMeasure('Next 2Q', 'CALCULATE([Units], DATESINPERIOD(Date[Date], MIN(Date[Date]), 2, QUARTER))')
  .addMeasure('Last 30D', 'CALCULATE([Total Sales], DATESINPERIOD(Date[Date], LASTDATE(Date[Date]), -30, DAY))')
  .addMeasure('Rolling Avg', 'DIVIDE([Rolling 3M], 3)')
  .addMeasure('Avg Daily', 'AVERAGEX(VALUES(Date[Date]), [Total Sales])')
  .addMeasure('Best Sub', 'MAXX(VALUES(Product[Subcategory]), [Margin %])')
  .addMeasure('Worst Country', 'MINX(DISTINCT(Region[Country]), [Units])')
  .addMeasure('Active Days', 'COUNTX(VALUES(Date[Date]), [Orders])')
  .addMeasure('Sum Of Shares', 'SUMX(VALUES(Product[Category]), DIVIDE([Total Sales], CALCULATE([Total Sales], ALL(Product))))')
  .addMeasure('Per Order Line', 'SUMX(VALUES(Sales[OrderNumber]), [Units]) / [Orders]')
  .addMeasure('YoY Guarded', 'IF(ISBLANK([Sales LY]), BLANK(), DIVIDE([Total Sales] - [Sales LY], [Sales LY]))');

const MEASURES = ['Switch Band', 'Zero If Blank', 'Coalesced', 'Both', 'Either', 'Per Unit', 'Var In Calc', 'Rounded', 'Distance', 'Larger', 'Label', 'Not Small', 'Biggest Line', 'Smallest Line', 'Lines', 'Distinct Orders', 'Online F', 'Big F', 'Nested F', 'Or F', 'Keep F'];
const GENERAL = ['Count F', 'Iterated F'];
const ITERS = ['Avg Daily', 'Best Sub', 'Worst Country', 'Active Days', 'Sum Of Shares', 'Per Order Line'];
const RANKS = ['Rank Sub', 'Rank Country', 'Rank Selected', 'Rank Of Value', 'Top 3'];
const SHARES = ['Total Sales', 'Pct All', 'Pct Sub', 'Pct Group', 'Pct Grand', 'All Bikes', 'Nested All', 'Share of Category', 'Var Share'];

const run = (spec: QuerySpec, mode: 'always' | 'off') => {
  setFastQuery(mode);
  model.evaluator.clearCache?.();
  const r = model.query(spec);
  const norm = (v: unknown) => (typeof v === 'number' ? Number(v.toPrecision(10)) : v);
  const rows = r.rows.map((x) => [JSON.stringify(x.keys), x.values.map(norm), x.highlights?.map(norm)] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { rows, totals: r.totals?.map(norm) };
};

afterEach(() => setFastQuery('auto'));

describe('scalar functions, VAR and iterators in the single-pass grouped path', () => {
  const cases: [string, QuerySpec][] = [
    ['two dimensions', { groupBy: ['Region[Country]', 'Date[Year]'], values: MEASURES, totals: true }],
    ['with query filters', { groupBy: ['Product[Subcategory]', 'Sales[Channel]'], values: MEASURES, filters: [{ target: 'Date[Year]', op: 'eq', value: 2025 }], totals: true }],
    ['with highlights', { groupBy: ['Region[Country]', 'Date[Quarter]'], values: ['Switch Band', 'Per Unit', 'Biggest Line', 'Lines'], highlight: [{ target: 'Sales[Channel]', op: 'eq', value: 'Online' }] }],
    ['FILTER through the general engine', { groupBy: ['Region[Country]', 'Date[Year]'], values: GENERAL, totals: true }],
    ['shares of totals', { groupBy: ['Product[Subcategory]', 'Region[Country]'], values: SHARES, filters: [{ target: 'Date[Year]', op: 'eq', value: 2025 }, { target: 'Product[Category]', op: 'in', values: ['Bikes', 'Accessories'] }], totals: true }],
    ['shares of totals by one dimension', { groupBy: ['Product[Category]', 'Sales[Channel]'], values: SHARES, totals: true }],
    ['ranks', { groupBy: ['Product[Subcategory]', 'Region[Country]'], values: RANKS, filters: [{ target: 'Date[Year]', op: 'eq', value: 2025 }], totals: true }],
    ['ranks outside the ranked column', { groupBy: ['Product[Category]', 'Date[Year]'], values: RANKS, totals: true }],
    ['ranks with a slicer on the ranked column', { groupBy: ['Product[Subcategory]', 'Sales[Channel]'], values: RANKS, filters: [{ target: 'Product[Subcategory]', op: 'in', values: ['Mountain Bikes', 'Road Bikes', 'Helmets', 'Gloves'] }], totals: true }],
    ['iterators over the values of a column', { groupBy: ['Product[Subcategory]', 'Region[Country]'], values: ITERS, filters: [{ target: 'Date[Year]', op: 'eq', value: 2025 }], totals: true }],
    ['iterators grouped by the iterated column', { groupBy: ['Product[Subcategory]', 'Date[Year]'], values: ITERS, totals: true }],
    ['highlighted shares, ranks and iterators', { groupBy: ['Product[Subcategory]', 'Region[Country]'], values: [...SHARES, ...RANKS, ...ITERS, 'Coalesced'], filters: [{ target: 'Date[Year]', op: 'eq', value: 2025 }], highlight: [{ target: 'Sales[Channel]', op: 'eq', value: 'Online' }], totals: true }],
    ['highlight on a removed table', { groupBy: ['Product[Category]', 'Region[Country]'], values: ['Pct All', 'Pct Sub', 'Rank Sub', 'Best Sub'], highlight: [{ target: 'Product[Subcategory]', op: 'in', values: ['Road Bikes', 'Mountain Bikes'] }] }],
    ['with time intelligence', { groupBy: ['Date[Year]', 'Date[MonthNumber]'], values: ['Total Sales', 'YoY Guarded', 'Rolling 3M', 'Next 2Q', 'Last 30D', 'Rolling Avg'], totals: true }],
    ['rolling windows by product and month', { groupBy: ['Product[Category]', 'Date[MonthNumber]'], values: ['Rolling 3M', 'Next 2Q', 'Last 30D'], filters: [{ target: 'Date[Year]', op: 'eq', value: 2025 }], totals: true }],
    ['rolling windows by product only', { groupBy: ['Product[Subcategory]', 'Sales[Channel]'], values: ['Rolling 3M', 'Last 30D'], filters: [{ target: 'Date[Year]', op: 'eq', value: 2024 }], totals: true }],
  ];
  for (const [name, spec] of cases) {
    it(`matches the general engine: ${name}`, () => {
      expect(run(spec, 'always')).toEqual(run(spec, 'off'));
    });
  }

  it('takes the single pass with highlights too', () => {
    setFastQuery('always');
    const cols = [model.resolveColumn({ table: 'Product', column: 'Subcategory' }), model.resolveColumn({ table: 'Region', column: 'Country' })];
    const hl = model.toContext([{ target: 'Sales[Channel]', op: 'eq', value: 'Online' }]);
    for (const m of [...SHARES, ...RANKS, ...ITERS, 'Coalesced']) expect(fastGroupQuery(model, cols, [model.measure(m).ast], [], hl, () => []), m).not.toBeNull();
  });

  it('takes the single pass for each of them', () => {
    setFastQuery('always');
    const cols = [model.resolveColumn({ table: 'Region', column: 'Country' }), model.resolveColumn({ table: 'Date', column: 'Year' })];
    for (const m of [...MEASURES, ...SHARES, ...RANKS, ...ITERS, 'YoY Guarded', 'Rolling 3M', 'Next 2Q', 'Last 30D']) expect(fastGroupQuery(model, cols, [model.measure(m).ast], [], undefined, () => []), m).not.toBeNull();
  });

  it('groups like the general engine when a value is not BLANK for empty groups', () => {
    const spec: QuerySpec = { groupBy: ['Region[Country]', 'Product[Category]'], values: ['Coalesced'], filters: [{ target: 'Sales[SalesAmount]', op: 'gt', value: 2500 }] };
    const fast = run(spec, 'always');
    expect(fast).toEqual(run(spec, 'off'));
    expect(fast.rows.length).toBeGreaterThan(0);
  });
});
