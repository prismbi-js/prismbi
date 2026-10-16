import { describe, expect, it } from 'vitest';
import { DataModel, DataTable, parseColumnRef } from '../src/index';
import { makeModel } from './fixtures';

describe('DataTable', () => {
  it('infers column types and coerces ISO dates', () => {
    const t = new DataTable('T', [
      { a: 1, b: 'x', c: '2024-05-01', d: true },
      { a: 2, b: 'y', c: '2024-05-02', d: false },
    ]);
    expect(t.column('a').type).toBe('number');
    expect(t.column('b').type).toBe('string');
    expect(t.column('c').type).toBe('date');
    expect(t.column('c').values[0]).toBeInstanceOf(Date);
    expect(t.column('d').type).toBe('boolean');
  });

  it('builds from column arrays', () => {
    const t = DataTable.fromColumns('T', { x: [1, 2, 3], y: ['a', 'b', 'a'] });
    expect(t.rowCount).toBe(3);
    expect(t.distinct('y')).toEqual(['a', 'b']);
  });

  it('honours sortBy for distinct values', () => {
    const m = new DataModel().addDateTable('Date', '2024-01-01', '2024-12-31');
    expect(m.table('Date').distinct('Month').slice(0, 3)).toEqual(['January', 'February', 'March']);
  });
});

describe('column refs', () => {
  it('parses quoted and unquoted refs', () => {
    expect(parseColumnRef('Sales[Amount]')).toEqual({ table: 'Sales', column: 'Amount' });
    expect(parseColumnRef("'Sales Data'[Net Amount]")).toEqual({ table: 'Sales Data', column: 'Net Amount' });
  });
});

describe('DataModel filter propagation', () => {
  const m = makeModel();

  it('propagates dimension filters to the fact table', () => {
    expect(m.evaluate('[Total Sales]')).toBe(6750);
    expect(m.evaluate('[Total Sales]', [{ target: 'Products[Category]', op: 'eq', value: 'Bikes' }])).toBe(6000);
    expect(m.evaluate('[Total Sales]', [{ target: 'Region[Name]', op: 'in', values: ['South'] }])).toBe(2300);
  });

  it('combines filters across dimensions', () => {
    expect(
      m.evaluate('[Total Sales]', [
        { target: 'Products[Category]', op: 'eq', value: 'Bikes' },
        { target: 'Region[Name]', op: 'eq', value: 'North' },
      ]),
    ).toBe(4000);
  });

  it('supports advanced operators', () => {
    expect(m.evaluate('[Orders]', [{ target: 'Products[Name]', op: 'contains', value: 'bike' }])).toBe(3);
    expect(m.evaluate('[Orders]', [{ target: 'Sales[Amount]', op: 'between', min: 100, max: 250 }])).toBe(4);
    expect(m.evaluate('[Orders]', [{ target: 'Products[Color]', op: 'notIn', values: ['Red'] }])).toBe(4);
  });

  it('filters through the date table', () => {
    expect(m.evaluate('[Total Sales]', [{ target: 'Date[Year]', op: 'eq', value: 2025 }])).toBe(2300);
  });

  it('does not filter dimensions from the fact (single direction)', () => {
    expect(m.evaluate('COUNTROWS(Products)', [{ target: 'Sales[Amount]', op: 'gt', value: 1000 }])).toBe(5);
  });

  it('rejects relationships whose one side is not unique', () => {
    const bad = new DataModel().addTable('A', [{ k: 1 }]).addTable('B', [{ k: 1 }, { k: 1 }]);
    expect(() => bad.addRelationship({ from: 'A[k]', to: 'B[k]' })).toThrow(/unique/);
  });

  it('exposes a field list and serialisable metadata', () => {
    const fields = m.fields();
    expect(fields.some((f) => f.kind === 'measure' && f.name === 'Margin %')).toBe(true);
    const json = m.toJSON();
    expect(json.relationships).toHaveLength(3);
    expect(json.measures.find((x) => x.name === 'Total Sales')?.format).toBe('$#,0');
  });
});

describe('calculated columns', () => {
  it('evaluates per row, including RELATED', () => {
    const m = makeModel()
      .addCalculatedColumn('Sales', 'Margin', 'Sales[Amount] - Sales[Cost]')
      .addCalculatedColumn('Sales', 'Category', 'RELATED(Products[Category])');
    expect(m.table('Sales').column('Margin').values[0]).toBe(300);
    expect(m.table('Sales').column('Category').values[2]).toBe('Accessories');
    expect(m.evaluate('SUM(Sales[Margin])')).toBe(6750 - 4615);
  });

  it('keeps calculated columns after refresh', () => {
    const m = makeModel().addCalculatedColumn('Sales', 'Double', 'Sales[Amount] * 2');
    m.refreshTable('Sales', [{ OrderId: 1, ProductId: 1, RegionId: 10, OrderDate: '2024-01-15', Qty: 1, Amount: 5, Cost: 1 }]);
    expect(m.evaluate('SUM(Sales[Double])')).toBe(10);
  });
});

describe('query engine', () => {
  const m = makeModel();

  it('groups across related tables with auto-exist', () => {
    const r = m.query({ groupBy: ['Products[Category]'], values: ['Total Sales'] });
    const map = Object.fromEntries(r.rows.map((x) => [x.keys[0], x.values[0]]));
    expect(map).toEqual({ Accessories: 500, Bikes: 6000, Clothing: 250 });
  });

  it('groups by columns from two dimensions', () => {
    const r = m.query({ groupBy: ['Products[Category]', 'Region[Name]'], values: ['Total Sales'] });
    expect(r.rows).toHaveLength(6);
    expect(r.rows.find((x) => x.keys[0] === 'Bikes' && x.keys[1] === 'South')?.values[0]).toBe(2000);
  });

  it('applies implicit aggregations', () => {
    const r = m.query({ groupBy: ['Region[Name]'], values: ['Sales[Qty]', { field: 'Sales[Amount]', aggregation: 'avg' }, { field: 'Sales[OrderId]', aggregation: 'distinctCount' }] });
    expect(r.values.map((v) => v.name)).toEqual(['Sum of Qty', 'Average of Amount', 'Count (Distinct) of OrderId']);
    const north = r.rows.find((x) => x.keys[0] === 'North')!;
    expect(north.values).toEqual([12, 1112.5, 4]);
  });

  it('sorts, limits and computes real totals', () => {
    const r = m.query({ groupBy: ['Products[Name]'], values: ['Margin %'], orderBy: [{ field: 'Margin %', direction: 'desc' }], top: 2, totals: true });
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].keys[0]).toBe('Bottle');
    // total is the measure over all rows, not the sum of row values
    expect(r.totals![0]).toBeCloseTo((6750 - 4615) / 6750);
  });

  it('resolves Top N filters', () => {
    const r = m.query({ groupBy: ['Products[Name]'], values: ['Total Sales'], filters: [{ target: 'Products[Name]', op: 'topN', n: 2, by: 'Total Sales' }] });
    expect(r.rows.map((x) => x.keys[0]).sort()).toEqual(['Mountain Bike', 'Road Bike']);
  });

  it('returns highlight values alongside filtered values', () => {
    const r = m.query({ groupBy: ['Products[Category]'], values: ['Total Sales'], highlight: [{ target: 'Region[Name]', op: 'eq', value: 'North' }] });
    const bikes = r.rows.find((x) => x.keys[0] === 'Bikes')!;
    expect(bikes.values[0]).toBe(6000);
    expect(bikes.highlights![0]).toBe(4000);
  });

  it('keeps natural order for sort-by columns', () => {
    const r = m.query({ groupBy: ['Date[Month]'], values: ['Total Sales'] });
    expect(r.rows.map((x) => x.keys[0])).toEqual(['January', 'February', 'March']);
  });

  it('handles tuple (multi-column) filters', () => {
    const v = m.evaluate('[Total Sales]', [
      { targets: ['Products[Category]', 'Region[Name]'], op: 'tuples', tuples: [['Bikes', 'South'], ['Clothing', 'North']] },
    ]);
    expect(v).toBe(2200);
  });
});
