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
