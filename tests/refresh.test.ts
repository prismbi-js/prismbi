import { describe, expect, it } from 'vitest';
import { DataModel, applyRefreshPolicy, periodStart } from '@prismbi/prismbi';
import { scheduleRefresh } from '@prismbi/prismbi/connectors';

const d = (y: number, m: number, day = 1) => new Date(y, m - 1, day);
const now = d(2025, 10, 17);

describe('periodStart', () => {
  it('counts back whole periods from the current one', () => {
    expect(periodStart(now, 'month', 3)).toEqual(d(2025, 8, 1));
    expect(periodStart(now, 'day', 1)).toEqual(d(2025, 10, 17));
    expect(periodStart(now, 'week', 2)).toEqual(d(2025, 10, 6)); // Monday of the previous week
    expect(periodStart(now, 'quarter', 2)).toEqual(d(2025, 7, 1));
    expect(periodStart(now, 'year', 2)).toEqual(d(2024, 1, 1));
    expect(periodStart(d(2025, 1, 15), 'month', 3)).toEqual(d(2024, 11, 1));
  });
});

describe('incremental refresh', () => {
  const history = [
    { Date: d(2022, 6, 1), Amount: 1 },
    { Date: d(2024, 3, 1), Amount: 2 },
    { Date: d(2025, 7, 31), Amount: 3 },
    { Date: d(2025, 8, 15), Amount: 4 },
    { Date: d(2025, 10, 1), Amount: 5 },
  ];

  it('replaces the refresh window, keeps and trims history', () => {
    const m = new DataModel().addTable('Sales', history, { Amount: { format: '$#,0' } }).addMeasure('Total', 'SUM(Sales[Amount])');
    m.addCalculatedColumn('Sales', 'Double', 'Sales[Amount] * 2');
    m.setRefreshPolicy('Sales', { column: 'Date', refresh: { last: 3, unit: 'month' }, keep: { last: 3, unit: 'year' } });
    const r = m.incrementalRefresh('Sales', [{ Date: d(2025, 8, 15), Amount: 40 }, { Date: d(2025, 10, 16), Amount: 60 }, { Date: d(2025, 5, 1), Amount: 999 }], { now });
    expect(r).toEqual({ from: d(2025, 8, 1), keepFrom: d(2023, 1, 1), kept: 2, replaced: 2, added: 2, ignored: 1, dropped: 1 });
    expect(m.evaluate('[Total]')).toBe(2 + 3 + 40 + 60);
    expect(m.evaluate('SUM(Sales[Double])')).toBe(210);
    expect(m.table('Sales').column('Amount').format).toBe('$#,0');
    expect(m.toJSON().refreshPolicies.Sales.refresh).toEqual({ last: 3, unit: 'month' });
  });

  it('works on transformed tables and from scheduleRefresh', async () => {
    const m = new DataModel().addTable('Sales', history).addMeasure('Total', 'SUM(Sales[Amount])');
    m.transformTable('Sales', [{ op: 'filterRows', column: 'Amount', test: 'notBlank' }]);
    m.setRefreshPolicy('Sales', { column: 'Date', refresh: { last: 1, unit: 'year' } });
    const res = m.incrementalRefresh('Sales', [{ Date: d(2025, 2, 1), Amount: 100 }, { Date: d(2025, 3, 1), Amount: null }], { now });
    expect(res).toMatchObject({ kept: 2, replaced: 3, added: 2 });
    expect(m.evaluate('[Total]')).toBe(103);
    expect(m.sourceRowsOf('Sales')).toHaveLength(4);
    // scheduleRefresh with mode 'incremental' (uses today's date: the window is the current year)
    const thisYear = new Date(new Date().getFullYear(), 0, 2);
    const h = scheduleRefresh(m, 'Sales', async () => [{ Date: thisYear, Amount: 7 }], { intervalMs: 60_000, mode: 'incremental' });
    await new Promise((r) => setTimeout(r, 0));
    h.stop();
    expect(m.sourceRowsOf('Sales')!.some((r) => r.Amount === 7)).toBe(true);
  });

  it('validates policies', () => {
    const m = new DataModel().addTable('Sales', history);
    expect(() => m.setRefreshPolicy('Sales', { column: 'Nope', refresh: { last: 1, unit: 'day' } })).toThrow(/no column "Nope"/);
    expect(() => m.incrementalRefresh('Sales', [])).toThrow(/no refresh policy/);
    expect(applyRefreshPolicy([{ Date: 'not a date' }], [], { column: 'Date', refresh: { last: 1, unit: 'day' } }, now).result.kept).toBe(1);
  });
});
