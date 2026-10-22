import { afterEach, describe, expect, it } from 'vitest';
import { setFastQuery } from '../src/index';
import type { QuerySpec } from '../src/index';
import { fastGroupQuery } from '../src/data/fastQuery';
import { groupCombos, resolveGroupField, resolveValueField } from '../src/data/query';
import { buildModel } from '../examples/model';
import { makeSales } from '../examples/data';

const model = buildModel()
  .addMeasure('Sales QTD', 'TOTALQTD([Total Sales], Date[Date])')
  .addMeasure('Sales MTD', 'TOTALMTD([Total Sales], Date[Date])')
  .addMeasure('FY Sales', 'CALCULATE([Total Sales], DATESYTD(Date[Date], "6-30"))')
  .addMeasure('Prev Month Sales', 'CALCULATE([Total Sales], DATEADD(Date[Date], -1, MONTH))')
  .addMeasure('Prev Quarter Units', 'CALCULATE([Units], PREVIOUSQUARTER(Date[Date]))')
  .addMeasure('Bike Sales LY', 'CALCULATE([Total Sales], SAMEPERIODLASTYEAR(Date[Date]), Product[Category] = "Bikes")')
  .addMeasure('Orders LY', 'CALCULATE(COUNTROWS(Sales), SAMEPERIODLASTYEAR(Date[Date]))')
  .addMeasure('Avg Line LY', 'CALCULATE(AVERAGE(Sales[SalesAmount]), SAMEPERIODLASTYEAR(Date[Date]))')
  .addMeasure('Growth', '[Total Sales] - [Sales LY]')
  .addMeasure('Bike Sales', 'CALCULATE([Total Sales], Product[Category] = "Bikes")')
  .addMeasure('Growth Ratio', 'DIVIDE([Total Sales], [Sales LY])')
  .addMeasure('Profit YTD', 'TOTALYTD(SUMX(Sales, Sales[SalesAmount] - Sales[TotalCost]), Date[Date])')
  .addMeasure('Guarded LY', 'IF([Total Sales] > 0, CALCULATE([Total Sales], SAMEPERIODLASTYEAR(Date[Date])))')
  .addMeasure('Small Months Sales', 'IF([Units] <= 400, [Total Sales])')
  .addMeasure('Growth Or Same', 'IF([Sales LY] <> 0, [Total Sales] - [Sales LY], [Total Sales])');

const run = (spec: QuerySpec, mode: 'always' | 'off') => {
  setFastQuery(mode);
  model.evaluator.clearCache?.();
  return model.query(spec);
};

/** Did the single-pass path answer (rather than fall back to per-group evaluation)? */
const fastAnswers = (spec: QuerySpec) => {
  const groups = (spec.groupBy ?? []).map((g) => resolveGroupField(model, g));
  const values = (spec.values ?? []).map((v) => resolveValueField(model, v));
  const base = model.toContext(spec.filters ?? []);
  const cols = groups.map((g) => g.column!);
  return fastGroupQuery(model, cols, values.map((v) => v.ast), base, undefined, () => groupCombos(model, cols, base, true)) !== null;
};

afterEach(() => setFastQuery('auto'));

const y2025 = [{ target: 'Date[Year]', op: 'eq' as const, value: 2025 }];
const CASES: [string, QuerySpec][] = [
  ['year × SAMEPERIODLASTYEAR, growth', { groupBy: ['Date[Year]'], values: ['Total Sales', 'Sales LY', 'Growth', 'Growth Ratio'], totals: true }],
  ['month × YTD / QTD / MTD in a year', { groupBy: ['Date[MonthNumber]'], values: ['Sales YTD', 'Sales QTD', 'Sales MTD'], filters: y2025, totals: true }],
  ['day × YTD (every date, including days without sales)', { groupBy: ['Date[Date]'], values: ['Sales YTD', 'Total Sales'], filters: y2025 }],
  ['year, month × DATEADD and PREVIOUSQUARTER', { groupBy: ['Date[Year]', 'Date[MonthNumber]'], values: ['Prev Month Sales', 'Prev Quarter Units'], totals: true }],
  ['fiscal year end', { groupBy: ['Date[Year]', 'Date[Quarter]'], values: ['FY Sales'] }],
  ['other filters stay, date filters are replaced', { groupBy: ['Date[MonthShort]'], values: ['Sales LY', 'Bike Sales LY', 'Orders LY', 'Avg Line LY'], filters: [...y2025, { target: 'Region[Country]', op: 'in', values: ['Canada', 'Germany'] }, { target: 'Date[Quarter]', op: 'in', values: ['Q1', 'Q2'] }], totals: true }],
  ['plain measures summed from the same partials, under date and other filters', { groupBy: ['Date[Year]', 'Date[MonthShort]'], values: ['Total Sales', 'Units', 'Bike Sales', 'Sales LY', 'Growth'], filters: [{ target: 'Region[Group]', op: 'in', values: ['Europe', 'Pacific'] }, { target: 'Date[Quarter]', op: 'in', values: ['Q2', 'Q4'] }], totals: true }],
  ['a distinct count keeps its own pass', { groupBy: ['Date[Year]', 'Date[Quarter]'], values: ['Orders', 'Sales LY'], totals: true }],
  ['IF guards around time intelligence and plain measures', { groupBy: ['Date[Year]', 'Date[MonthNumber]'], values: ['Guarded LY', 'Small Months Sales', 'Growth Or Same'], totals: true }],
  ['SUMX under TOTALYTD', { groupBy: ['Date[MonthNumber]'], values: ['Profit YTD'], filters: y2025 }],
  ['product × month: partials per group and date', { groupBy: ['Product[Name]', 'Date[MonthShort]'], values: ['Total Sales', 'Sales YTD', 'Sales LY', 'Growth'], filters: y2025, totals: true }],
  ['groups outside the date table only', { groupBy: ['Product[Category]'], values: ['Total Sales', 'Sales LY', 'Sales YTD', 'Prev Quarter Units'], totals: true }],
  ['two dimensions, a CALCULATE filter and a distinct count', { groupBy: ['Region[Country]', 'Product[Subcategory]', 'Date[Year]'], values: ['Orders', 'Bike Sales LY', 'Avg Line LY'], filters: [{ target: 'Date[Quarter]', op: 'in', values: ['Q1', 'Q3'] }], totals: true }],
];

const norm = (v: unknown) => (v instanceof Date ? v.getTime() : typeof v === 'number' ? Number(v.toPrecision(9)) : v);

describe('time intelligence in the single-pass grouped path', () => {
  for (const [name, spec] of CASES) {
    it(`matches the general engine: ${name}`, () => {
      expect(fastAnswers(spec)).toBe(true);
      const fast = run(spec, 'always');
      const slow = run(spec, 'off');
      expect(fast.rows.map((r) => r.keys.map(norm))).toEqual(slow.rows.map((r) => r.keys.map(norm)));
      expect(fast.rows.map((r) => r.values.map(norm))).toEqual(slow.rows.map((r) => r.values.map(norm)));
      expect(fast.totals?.map(norm)).toEqual(slow.totals?.map(norm));
    });
  }

  it('counts fact rows whose date is missing from the date table where no date restricts them', () => {
    const sales = makeSales();
    sales.push({ ...sales[0], OrderDate: new Date(2030, 0, 5), SalesAmount: 1e6 });
    const m = buildModel(sales);
    for (const spec of [
      { groupBy: ['Date[Year]'], values: ['Total Sales', 'Sales LY'], totals: true },
      { groupBy: ['Product[Category]'], values: ['Total Sales', 'Sales YTD'], totals: true },
    ] as QuerySpec[]) {
      setFastQuery('always');
      const fast = m.query(spec);
      setFastQuery('off');
      m.evaluator.clearCache?.();
      const slow = m.query(spec);
      expect(fast.rows.map((r) => r.values.map(norm))).toEqual(slow.rows.map((r) => r.values.map(norm)));
      expect(fast.totals?.map(norm)).toEqual(slow.totals?.map(norm));
    }
  });

  it('falls back where it would differ: highlights, distinct counts', () => {
    model.addMeasure('Customers LY', 'CALCULATE(DISTINCTCOUNT(Sales[OrderNumber]), SAMEPERIODLASTYEAR(Date[Date]))');
    expect(fastAnswers({ groupBy: ['Date[Year]'], values: ['Customers LY'] })).toBe(false);
    const spec: QuerySpec = { groupBy: ['Date[Year]'], values: ['Sales LY'], highlight: [{ target: 'Region[Country]', op: 'eq', value: 'Canada' }] };
    const fast = run(spec, 'always');
    const slow = run(spec, 'off');
    expect(fast.rows.map((r) => r.highlights?.map(norm))).toEqual(slow.rows.map((r) => r.highlights?.map(norm)));
  });
});
