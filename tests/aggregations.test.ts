import { describe, expect, it } from 'vitest';
import { DataModel } from '@prismbi/prismbi/core';
import type { QuerySpec } from '@prismbi/prismbi';
import { buildModel } from '../examples/model';

/** The demo model plus Sales summarized by day and product, as Power BI's "manage aggregations" would hold it. */
function withAggregation(model: DataModel, detailRows = true) {
  const src = buildModel();
  const g = src.query({ groupBy: ['Sales[OrderDate]', 'Sales[ProductKey]'], values: [{ field: 'Sales[SalesAmount]', aggregation: 'sum' }, { field: 'Sales[Quantity]', aggregation: 'sum' }, { field: 'Sales[Profit]', aggregation: 'sum' }, { name: 'Rows', expression: 'COUNTROWS(Sales)' }, { name: 'MaxQ', expression: 'MAX(Sales[Quantity])' }, { name: 'CountQ', expression: 'COUNT(Sales[Quantity])' }], limit: 1e7 });
  const rows = g.rows.map((r) => ({ OrderDate: r.keys[0], ProductKey: r.keys[1], Amount: r.values[0], Qty: r.values[1], Profit: r.values[2], Rows: r.values[3], MaxQ: r.values[4], CountQ: r.values[5] }));
  if (!detailRows) {
    // keep the schema: the rows would live in a database (sqlEngine)
    const schema = Object.fromEntries([...model.table('Sales').columns.values()].filter((c) => !c.expression).map((c) => [c.name, { type: c.type, format: c.format, hidden: c.hidden }]));
    model.refreshTable('Sales', [], schema);
  }
  return model
    .addTable('SalesAgg', rows)
    .addRelationship({ from: 'SalesAgg[OrderDate]', to: 'Date[Date]' })
    .addRelationship({ from: 'SalesAgg[ProductKey]', to: 'Product[ProductKey]' })
    .addAggregation({ table: 'SalesAgg', detail: 'Sales', groupBy: { OrderDate: 'OrderDate', ProductKey: 'ProductKey' }, columns: { SalesAmount: { sum: 'Amount' }, Quantity: { sum: 'Qty', max: 'MaxQ', count: 'CountQ' }, Profit: { sum: 'Profit' } }, rows: 'Rows' });
}

/** The demo model with the measures these tests use. */
const demo = () =>
  buildModel()
    .addMeasure('Lines', 'COUNTROWS(Sales)')
    .addMeasure('Avg Qty', 'AVERAGE(Sales[Quantity])')
    .addMeasure('Max Qty', 'MAX(Sales[Quantity])')
    .addMeasure('Products Sold', 'DISTINCTCOUNT(Sales[ProductKey])')
    .addMeasure('Bike Sales', 'CALCULATE([Total Sales], Product[Category] = "Bikes")');

const norm = (v: unknown) => (typeof v === 'number' ? Number(v.toPrecision(10)) : v instanceof Date ? v.getTime() : v);
const same = (a: ReturnType<DataModel['query']>, b: ReturnType<DataModel['query']>) => {
  expect(a.groups.map((x) => x.ref)).toEqual(b.groups.map((x) => x.ref));
  expect(a.values.map((x) => [x.name, x.format])).toEqual(b.values.map((x) => [x.name, x.format]));
  expect(a.rows.map((r) => [r.keys.map(norm), r.values.map(norm), r.highlights?.map(norm)])).toEqual(b.rows.map((r) => [r.keys.map(norm), r.values.map(norm), r.highlights?.map(norm)]));
  expect(a.totals?.map(norm)).toEqual(b.totals?.map(norm));
};

const y2025 = { target: 'Date[Year]', op: 'eq' as const, value: 2025 };
const COVERED: [string, QuerySpec][] = [
  ['sums, ratios of sums, row counts and averages by dimension columns', { groupBy: ['Product[Category]', 'Date[Year]'], values: ['Total Sales', 'Units', 'Margin %', 'Lines', 'Avg Qty', 'Max Qty'], totals: true }],
  ['grouped-by detail columns: distinct counts, and grouping by them', { groupBy: ['Sales[OrderDate]'], values: ['Products Sold', 'Total Sales'], filters: [{ target: 'Sales[OrderDate]', op: 'between', min: new Date(2025, 0, 1), max: new Date(2025, 0, 31) }] }],
  ['CALCULATE filters, time intelligence, highlights', { groupBy: ['Date[MonthNumber]'], values: ['Bike Sales', 'Sales LY', 'Sales YTD', 'YoY %'], filters: [y2025, { target: 'Product[Category]', op: 'in', values: ['Bikes', 'Clothing'] }], highlight: [{ target: 'Product[Subcategory]', op: 'eq', value: 'Road Bikes' }], totals: true }],
  ['column aggregations and sort', { groupBy: ['Product[Subcategory]'], values: [{ field: 'Sales[SalesAmount]', aggregation: 'sum' }], orderBy: [{ field: 'Sum of SalesAmount', direction: 'desc' }], top: 5 }],
];
const NOT_COVERED: [string, QuerySpec][] = [
  ['a dimension the aggregation is not related to', { groupBy: ['Region[Country]'], values: ['Total Sales'] }],
  ['a distinct count of a column it does not keep', { groupBy: ['Product[Category]'], values: ['Orders'] }],
  ['a detail column it is not grouped by', { groupBy: ['Sales[Channel]'], values: ['Total Sales'] }],
  ['an iterator over the detail table', { values: [{ name: 'x', expression: 'SUMX(Sales, Sales[Quantity] * 2)' }] }],
];

describe('aggregation tables', () => {
  const plain = demo();
  const model = withAggregation(demo());
  for (const [name, spec] of COVERED)
    it(`answers from the aggregation: ${name}`, () => {
      const r = model.query(spec);
      expect(r.aggregation).toBe('SalesAgg');
      same(r, plain.query(spec));
    });
  for (const [name, spec] of NOT_COVERED)
    it(`falls back to the detail table: ${name}`, () => {
      const r = model.query(spec);
      expect(r.aggregation).toBeUndefined();
      same(r, plain.query(spec));
    });

  it('works with the detail rows elsewhere (an empty local fact table)', () => {
    const remote = withAggregation(demo(), false);
    for (const [, spec] of COVERED) same(remote.query(spec), plain.query(spec));
  });

  it('validates definitions, follows row-level security, and can be removed', () => {
    const m = withAggregation(demo());
    expect(() => m.addAggregation({ table: 'SalesAgg', detail: 'Sales', columns: { SalesAmount: { sum: 'Nope' } } })).toThrow(/no column "Nope"/);
    m.addRole('Bikes', { Product: 'Product[Category] = "Bikes"' }).setRoles(['Bikes']);
    expect(m.query({ values: ['Total Sales'] }).aggregation).toBeUndefined();
    m.setRoles(null);
    expect(m.query({ values: ['Total Sales'] }).aggregation).toBe('SalesAgg');
    expect(m.toJSON().aggregations).toHaveLength(1);
    m.removeAggregation('SalesAgg');
    expect(m.query({ values: ['Total Sales'] }).aggregation).toBeUndefined();
  });
});

describe('aggregation tables with SQL', () => {
  it('answers covered queries in memory and sends the rest to the database', async () => {
    const { sqlEngine } = await import('@prismbi/prismbi/sql');
    const model = withAggregation(demo(), false);
    const sent: string[] = [];
    const engine = sqlEngine(model, { run: async (sql) => (sent.push(sql), [{ g0: 'Canada', v0: 1 }]) });
    const covered = await engine.query({ groupBy: ['Product[Category]'], values: ['Total Sales'] });
    expect(sent).toHaveLength(0);
    expect(covered.aggregation).toBe('SalesAgg');
    same(covered as never, demo().query({ groupBy: ['Product[Category]'], values: ['Total Sales'] }));
    await engine.query({ groupBy: ['Region[Country]'], values: ['Total Sales'] });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('FROM "Sales"');
  });
});
