import { afterEach, describe, expect, it } from 'vitest';
import { DataModel, setFastQuery } from '../src/index';

/** Compiled row expressions (SUMX/AVERAGEX/iterators, RELATED maps) must match the interpreter exactly. */
function model(): DataModel {
  const countries = [
    { CountryKey: 1, Country: 'A', Tax: 0.1 },
    { CountryKey: 2, Country: 'B', Tax: null },
  ];
  const products = [
    { ProductKey: 1, Category: 'X', Price: 10, CountryKey: 1 },
    { ProductKey: 2, Category: 'X', Price: 0, CountryKey: 2 },
    { ProductKey: 3, Category: 'Y', Price: null, CountryKey: 9 },
    { ProductKey: 4, Category: 'Y', Price: 2.5, CountryKey: 1 },
  ];
  const sales = Array.from({ length: 60 }, (_, i) => ({
    Id: i,
    // 5 is unmatched, and some keys are blank
    ProductKey: i % 11 === 0 ? null : [1, 2, 3, 4, 5][i % 5],
    Quantity: i % 7 === 0 ? null : i % 4,
    Discount: i % 3 === 0 ? 0 : i % 5 === 0 ? null : i / 10,
    Label: `L${i % 3}`,
  }));
  return new DataModel()
    .addTable('Sales', sales)
    .addTable('Product', products)
    .addTable('Country', countries)
    .addRelationship({ from: 'Sales[ProductKey]', to: 'Product[ProductKey]' })
    .addRelationship({ from: 'Product[CountryKey]', to: 'Country[CountryKey]' });
}

const EXPRESSIONS = [
  'SUMX(Sales, Sales[Quantity] * Sales[Discount])',
  'SUMX(Sales, Sales[Quantity] - Sales[Discount])',
  'SUMX(Sales, Sales[Quantity] + 1)',
  'SUMX(Sales, Sales[Quantity] / Sales[Discount])',
  'SUMX(Sales, DIVIDE(Sales[Quantity], Sales[Discount]))',
  'SUMX(Sales, DIVIDE(Sales[Quantity], Sales[Discount], -1))',
  'SUMX(Sales, -Sales[Quantity] * RELATED(Product[Price]))',
  'SUMX(Sales, Sales[Quantity] * Product[Price])',
  'SUMX(Sales, [Quantity] * 2)',
  'SUMX(Sales, Sales[Quantity] * RELATED(Country[Tax]))',
  'AVERAGEX(Sales, Sales[Quantity] * RELATED(Product[Price]))',
  'AVERAGEX(FILTER(Sales, Sales[Quantity] > 1), Sales[Quantity] / 2)',
  'MINX(Sales, Sales[Quantity] - RELATED(Product[Price]))',
  'MAXX(Sales, Sales[Discount] * 3)',
  'COUNTX(Sales, Sales[Discount] * Sales[Quantity])',
  'SUMX(Product, Product[Price] * SUMX(RELATEDTABLE(Sales), Sales[Quantity]))',
  'SUMX(Product, SUMX(RELATEDTABLE(Sales), Sales[Quantity] * Product[Price]))',
  'RANKX(ALL(Sales), Sales[Quantity] * 2, 3)',
];

describe('compiled row expressions', () => {
  afterEach(() => setFastQuery('auto'));

  it('evaluate to the same values as the interpreter', () => {
    for (const e of EXPRESSIONS) {
      for (const filters of [[], [{ target: 'Product[Category]', op: 'eq' as const, value: 'X' }], [{ target: 'Sales[Label]', op: 'eq' as const, value: 'L1' }]]) {
        setFastQuery('off');
        const slow = model().evaluate(e, filters);
        setFastQuery('auto');
        const fast = model().evaluate(e, filters);
        expect(fast, `${e} ${JSON.stringify(filters)}`).toStrictEqual(slow);
      }
    }
  });

  it('match the per-group engine inside grouped queries', () => {
    const build = () =>
      model()
        .addMeasure('Rev', 'SUMX(Sales, Sales[Quantity] * RELATED(Product[Price]))')
        .addMeasure('AvgRev', 'AVERAGEX(Sales, Sales[Quantity] * Product[Price])')
        .addMeasure('Ratio', 'DIVIDE([Rev], SUM(Sales[Quantity]))')
        .addMeasure('Taxed', 'SUMX(Sales, Sales[Quantity] * RELATED(Country[Tax]))');
    const specs = [
      { groupBy: ['Product[Category]'], values: ['Rev', 'AvgRev', 'Ratio', 'Taxed'], totals: true },
      { groupBy: ['Product[Category]', 'Sales[Label]'], values: ['Rev', 'Ratio'], totals: true },
      { groupBy: ['Country[Country]', 'Sales[Label]'], values: ['Taxed', 'AvgRev'], totals: true },
    ];
    for (const spec of specs) {
      setFastQuery('off');
      const slow = build().query(spec);
      setFastQuery('always');
      const fast = build().query(spec);
      expect(fast.rows, JSON.stringify(spec)).toEqual(slow.rows);
      expect(fast.totals).toStrictEqual(slow.totals);
    }
  });

  it('compute calculated columns like the interpreter', () => {
    const exprs = ['Sales[Quantity] * RELATED(Product[Price])', 'DIVIDE(Sales[Quantity], Sales[Discount], 0) - Country[Tax]', '[Quantity] / Sales[Discount]'];
    for (const e of exprs) {
      setFastQuery('off');
      const slow = model().addCalculatedColumn('Sales', 'C', e).table('Sales').column('C');
      setFastQuery('auto');
      const fast = model().addCalculatedColumn('Sales', 'C', e).table('Sales').column('C');
      expect(fast.values, e).toStrictEqual(slow.values);
      expect(fast.type).toBe(slow.type);
    }
  });

  it('follows relationship changes and appended rows', () => {
    const m = model().addMeasure('Rev', 'SUMX(Sales, Sales[Quantity] * RELATED(Product[Price]))');
    const before = m.evaluate('[Rev]');
    m.table('Product').column('Price').values[0] = 100;
    m.table('Product').setColumn({ ...m.table('Product').column('Price') });
    m.addMeasure('Touch', '1'); // any model change drops caches
    const after = m.evaluate('[Rev]');
    setFastQuery('off');
    const ref = model().addMeasure('Rev', 'SUMX(Sales, Sales[Quantity] * RELATED(Product[Price]))');
    ref.table('Product').column('Price').values[0] = 100;
    expect(after).toBe(ref.evaluate('[Rev]'));
    expect(after).not.toBe(before);
  });
});
