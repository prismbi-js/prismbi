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
