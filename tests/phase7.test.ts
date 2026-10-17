import { describe, expect, it } from 'vitest';
import { createVisual } from '../src/index';
import { buildModel } from '../examples/model';

const model = buildModel();
const by = (q: ReturnType<typeof model.query>, col: number) => q.rows.map((r) => r.values[col]);

describe('visual calculations', () => {
  it('computes window functions over the visual rows in display order', () => {
    const q = model.query({
      groupBy: ['Date[MonthNumber]'],
      values: [
        'Total Sales',
        { name: 'Running', visualCalc: 'RUNNINGSUM([Total Sales])' },
        { name: 'vs previous', visualCalc: '[Total Sales] - PREVIOUS([Total Sales])' },
        { name: 'Avg 3', visualCalc: 'MOVINGAVERAGE([Total Sales], 3)' },
        { name: 'Share', visualCalc: 'PERCENTOFTOTAL([Total Sales])', format: '0.0%' },
        { name: 'Rank', visualCalc: 'RANK([Total Sales])' },
        { name: 'Row', visualCalc: 'ROWNUMBER()' },
      ],
      filters: [{ target: 'Date[Year]', op: 'eq', value: 2025 }],
      totals: true,
    });
    const sales = by(q, 0) as number[];
    expect(q.values.map((v) => v.name)).toEqual(['Total Sales', 'Running', 'vs previous', 'Avg 3', 'Share', 'Rank', 'Row']);
    expect(by(q, 1)).toEqual(sales.map((_, i) => sales.slice(0, i + 1).reduce((a, b) => a + b, 0)).map((x) => expect.closeTo(x, 6)));
    expect(by(q, 2)[0]).toBe(sales[0]); // no previous row: BLANK subtracts as 0
    expect(by(q, 2)[1]).toBeCloseTo(sales[1] - sales[0], 6);
    expect(by(q, 3)[2]).toBeCloseTo((sales[0] + sales[1] + sales[2]) / 3, 6);
    expect((by(q, 4) as number[]).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(by(q, 5)[sales.indexOf(Math.max(...sales))]).toBe(1);
    expect(by(q, 6)).toEqual(sales.map((_, i) => i + 1));
    expect(q.values[4].format).toBe('0.0%');
    expect(q.totals![4]).toBe(1);
  });

  it('follows sorting and Top N, and restarts per parent group', () => {
    const q = model.query({ groupBy: ['Product[Category]'], values: ['Total Sales', { name: 'Running', visualCalc: 'RUNNINGSUM([Total Sales])' }], orderBy: [{ field: 'Total Sales', direction: 'desc' }], top: 2 });
    expect(q.rows).toHaveLength(2);
    expect(q.rows[1].values[1]).toBeCloseTo((q.rows[0].values[0] as number) + (q.rows[1].values[0] as number), 6);
    const nested = model.query({ groupBy: ['Date[Year]', 'Date[MonthNumber]'], values: ['Total Sales', { name: 'YTD', visualCalc: 'RUNNINGSUM([Total Sales])', reset: 'parent' }] });
    const jan2025 = nested.rows.find((r) => r.keys[0] === 2025 && r.keys[1] === 1)!;
    expect(jan2025.values[1]).toBe(jan2025.values[0]); // restarted for the new year
    expect(() => model.query({ groupBy: ['Product[Category]'], values: ['Total Sales', { visualCalc: 'RUNNINGSUM([Nope])' }] })).toThrow(/\[Nope\]/);
  });

  it('works in visuals through field wells', () => {
    const el = document.createElement('div');
    el.style.height = '400px';
    document.body.append(el);
    const r = createVisual(el, { model, type: 'line', fields: { category: 'Date[MonthYear]', values: ['Total Sales', { name: 'Running total', visualCalc: 'RUNNINGSUM([Total Sales])' }] } });
    r.flush();
    expect(el.querySelector('.pbi-error')).toBeNull();
    expect(el.querySelectorAll('path.pbi-line')).toHaveLength(2);
    expect(el.textContent).toContain('Running total');
    r.destroy();
    el.remove();
  });
});

describe('DAX window functions', () => {
  const m = buildModel()
    .addMeasure('Prev Year Sales', 'CALCULATE([Total Sales], OFFSET(-1, ALLSELECTED(Date[Year]), ORDERBY(Date[Year])))')
    .addMeasure('First Year Sales', 'CALCULATE([Total Sales], INDEX(1, ALLSELECTED(Date[Year]), ORDERBY(Date[Year])))')
    .addMeasure('Running Months', 'CALCULATE([Total Sales], WINDOW(1, ABS, 0, REL, ALLSELECTED(Date[MonthNumber]), ORDERBY(Date[MonthNumber])))')
    .addMeasure('Moving 3', 'AVERAGEX(WINDOW(-2, REL, 0, REL, ALLSELECTED(Date[MonthNumber]), ORDERBY(Date[MonthNumber])), [Total Sales])')
    .addMeasure('Category Rank', 'RANK(DENSE, ALLSELECTED(Product[Category]), ORDERBY([Total Sales], DESC))')
    .addMeasure('Row In Year', 'ROWNUMBER(ALLSELECTED(Date[Year], Date[MonthNumber]), ORDERBY(Date[MonthNumber]), PARTITIONBY(Date[Year]))');

  it('OFFSET and INDEX pick neighbouring and absolute rows', () => {
    const q = m.query({ groupBy: ['Date[Year]'], values: ['Total Sales', 'Prev Year Sales', 'First Year Sales'] });
    const [y2024, y2025] = q.rows;
    expect(y2024.values[1]).toBeNull();
    expect(y2025.values[1]).toBe(y2024.values[0]);
    expect(y2025.values[2]).toBe(y2024.values[0]);
  });

  it('WINDOW gives running and moving aggregates that match visual calculations', () => {
    const q = m.query({
      groupBy: ['Date[MonthNumber]'],
      values: ['Total Sales', 'Running Months', 'Moving 3', { name: 'vc', visualCalc: 'RUNNINGSUM([Total Sales])' }, { name: 'vm', visualCalc: 'MOVINGAVERAGE([Total Sales], 3)' }],
      filters: [{ target: 'Date[Year]', op: 'eq', value: 2025 }],
    });
    for (const r of q.rows) {
      expect(r.values[1]).toBeCloseTo(r.values[3] as number, 6);
      expect(r.values[2]).toBeCloseTo(r.values[4] as number, 6);
    }
  });

  it('RANK and ROWNUMBER with measures in ORDERBY and partitions', () => {
    const q = m.query({ groupBy: ['Product[Category]'], values: ['Total Sales', 'Category Rank'], orderBy: [{ field: 'Total Sales', direction: 'desc' }] });
    expect(q.rows.map((r) => r.values[1])).toEqual([1, 2, 3, 4]);
    const months = m.query({ groupBy: ['Date[Year]', 'Date[MonthNumber]'], values: ['Row In Year'] });
    const mar2025 = months.rows.find((r) => r.keys[0] === 2025 && r.keys[1] === 3)!;
    expect(mar2025.values[0]).toBe(3);
    expect(() => m.evaluate('ORDERBY(Date[Year])')).toThrow(/only be used inside/);
  });
});

describe('transform steps', () => {
  const raw = [
    { Order: 'A-1', Customer: '  ana lopez ', Region: 'North', Q1: 10, Q2: 12, Date: '2025-01-05', Amount: '1,200' },
    { Order: 'A-2', Customer: 'ben ito', Region: '', Q1: 5, Q2: null, Date: '2025-02-10', Amount: '300' },
    { Order: 'A-3', Customer: 'cara day', Region: 'South', Q1: 7, Q2: 9, Date: '2025-02-11', Amount: 'n/a' },
    { Order: 'A-3', Customer: 'cara day', Region: 'South', Q1: 7, Q2: 9, Date: '2025-02-11', Amount: 'n/a' },
  ];

  it('cleans, reshapes and aggregates like Power Query', async () => {
    const { applySteps, describeStep } = await import('../src/index');
    const clean = applySteps(raw, [
      { op: 'removeDuplicates' },
      { op: 'transformText', columns: ['Customer'], fn: 'clean' },
      { op: 'transformText', columns: ['Customer'], fn: 'title' },
      { op: 'fillDown', columns: ['Region'] },
      { op: 'changeType', column: 'Amount', type: 'number' },
      { op: 'changeType', column: 'Date', type: 'date' },
      { op: 'splitColumn', column: 'Order', delimiter: '-', into: ['Series', 'Number'] },
      { op: 'renameColumns', names: { Customer: 'Name' } },
      { op: 'addColumn', name: 'Label', template: '{Name} ({Region})' },
    ]);
    expect(clean).toHaveLength(3);
    expect(clean[0]).toMatchObject({ Name: 'Ana Lopez', Series: 'A', Number: '1', Amount: 1200, Label: 'Ana Lopez (North)' });
    expect(clean[1].Region).toBe('North'); // filled down
    expect(clean[2].Amount).toBeNull(); // "n/a" is not a number
    expect(clean[0].Date).toBeInstanceOf(Date);
    const long = applySteps(clean, [{ op: 'keepColumns', columns: ['Name', 'Q1', 'Q2'] }, { op: 'unpivot', columns: ['Q1', 'Q2'], attribute: 'Quarter', value: 'Units' }]);
    expect(long).toHaveLength(5); // Ben's blank Q2 is dropped
    const wide = applySteps(long, [{ op: 'pivot', attribute: 'Quarter', value: 'Units' }]);
    expect(wide.find((r) => r.Name === 'Cara Day')).toEqual({ Name: 'Cara Day', Q1: 7, Q2: 9 });
    const grouped = applySteps(clean, [{ op: 'groupBy', by: ['Region'], aggregations: [{ name: 'Orders', agg: 'count' }, { name: 'Units', column: 'Q1', agg: 'sum' }] }, { op: 'sort', by: [{ column: 'Units', desc: true }] }]);
    expect(grouped).toEqual([{ Region: 'North', Orders: 2, Units: 15 }, { Region: 'South', Orders: 1, Units: 7 }]);
    const joined = applySteps(clean, [{ op: 'merge', with: 'Regions', on: [['Region', 'Code']], columns: ['Manager'] }, { op: 'filterRows', column: 'Manager', test: 'notBlank' }], { lookup: () => [{ Code: 'North', Manager: 'Dee' }] });
    expect(joined.map((r) => r.Manager)).toEqual(['Dee', 'Dee']);
    expect(() => applySteps(clean, [{ op: 'append', with: 'Nope' }])).toThrow(/Step 1 \(append\)/);
    expect(describeStep({ op: 'groupBy', by: ['Region'], aggregations: [{ name: 'Orders', agg: 'count' }] })).toBe('Group by Region: Orders = count');
  });

  it('replays steps on refresh and append, and stores them with the model', async () => {
    const { DataModel } = await import('../src/index');
    const m = new DataModel().addTable('Sales', raw).addMeasure('Units', 'SUM(Sales[Q1])');
    m.transformTable('Sales', [
      { op: 'removeDuplicates' },
      { op: 'filterRows', column: 'Region', test: 'notBlank' },
      { op: 'changeType', column: 'Amount', type: 'number' },
    ]);
    expect(m.table('Sales').rowCount).toBe(2);
    expect(m.table('Sales').column('Amount').type).toBe('number');
    expect(m.evaluate('[Units]')).toBe(17);
    // appended rows go through the (row-local) steps
    m.appendRows('Sales', [{ Order: 'B-1', Customer: 'x', Region: '', Q1: 100 }, { Order: 'B-2', Customer: 'y', Region: 'East', Q1: 1, Amount: '50' }]);
    expect(m.evaluate('[Units]')).toBe(18);
    // a whole-table step re-runs over the full source
    m.transformTable('Sales', [...m.transformsOf('Sales')!, { op: 'keepTop', n: 1 }]);
    m.appendRows('Sales', [{ Order: 'C-1', Customer: 'z', Region: 'West', Q1: 3 }]);
    expect(m.table('Sales').rowCount).toBe(1);
    expect(m.sourceRowsOf('Sales')).toHaveLength(7);
    expect(m.toJSON().transforms.Sales).toHaveLength(4);
    // refresh treats rows as the new source
    m.refreshTable('Sales', [{ Order: 'Z', Customer: 'q', Region: 'R', Q1: 2, Amount: '7' }]);
    expect(m.table('Sales').column('Amount').values).toEqual([7]);
    // clearing restores the source
    m.transformTable('Sales', []);
    expect(m.transformsOf('Sales')).toBeUndefined();
    expect(m.table('Sales').column('Amount').values).toEqual(['7']);
  });
});

describe('studio transforms', () => {
  it('persists steps in the studio document and re-applies them on load', async () => {
    const { Studio } = await import('../src/studio');
    const { makeModel } = await import('./fixtures');
    const el = document.createElement('div');
    el.style.height = '700px';
    document.body.append(el);
    const model = makeModel();
    const studio = new Studio(el, { model });
    const table = model.tableNames().find((t) => model.table(t).rowCount > 3)!;
    const before = model.table(table).rowCount;
    model.transformTable(table, [{ op: 'keepTop', n: 2 }]);
    (studio as unknown as { commit(): void }).commit();
    const doc = studio.document;
    expect(doc.model.transforms?.[table]).toEqual([{ op: 'keepTop', n: 2 }]);
    // a fresh studio on a fresh model applies the saved steps
    const el2 = document.createElement('div');
    el2.style.height = '700px';
    document.body.append(el2);
    const model2 = makeModel();
    const studio2 = new Studio(el2, { model: model2 });
    studio2.load(doc);
    expect(model2.table(table).rowCount).toBe(2);
    // loading a document without transforms restores the source rows
    studio2.load({ ...doc, model: { ...doc.model, transforms: undefined } });
    expect(model2.table(table).rowCount).toBe(before);
    studio.destroy();
    studio2.destroy();
    el.remove();
    el2.remove();
  });
});
