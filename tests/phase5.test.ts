import { afterAll, describe, expect, it } from 'vitest';
import { DataModel } from 'prismbi/core';
import { runQuery } from '../src/data/query';
import { setFastQuery } from '../src/data/fastQuery';
import { buildModel } from '../examples/model';
import { createVisual } from '../src/index';
import { downsampleRuns, lttb } from '../src/render/lttb';
import type { QuerySpec } from '../src/data/query';

/** Run a query with the single-pass path on and off; both must agree exactly. */
function both(model: DataModel, spec: QuerySpec) {
  setFastQuery('off');
  const slow = runQuery(model, spec);
  setFastQuery('always');
  const fast = runQuery(model, spec);
  return { slow, fast };
}

const strip = (r: ReturnType<typeof runQuery>) => ({ rows: r.rows, totals: r.totals, truncated: r.truncated });

describe('fast grouped query path', () => {
  const model = buildModel();
  const specs: QuerySpec[] = [
    { groupBy: ['Product[Category]'], values: ['Total Sales', 'Margin %', 'Orders', 'Avg Order Value'], totals: true },
    { groupBy: ['Region[Country]', 'Product[Category]'], values: ['Total Sales', 'Units'], totals: true },
    { groupBy: ['Date[Year]', 'Date[Month]'], values: ['Total Sales', 'Orders'], orderBy: [{ field: 'Total Sales', direction: 'desc' }] },
    { groupBy: ['Product[Category]'], values: ['Total Sales'], filters: [{ target: 'Region[Country]', op: 'in', values: ['USA', 'Canada'] }] },
    { groupBy: ['Product[Category]'], values: ['Total Sales', 'Units'], highlight: [{ target: 'Date[Year]', op: 'eq', value: 2024 }] },
    { groupBy: ['Sales[OrderDate]'], values: ['Sales[SalesAmount]', { field: 'Sales[Quantity]', aggregation: 'avg' }, { field: 'Sales[OrderDate]', aggregation: 'max' }] },
    { groupBy: ['Product[Category]'], values: [{ expression: 'COUNTROWS(Sales) * 2 - SUM(Sales[Quantity]) / 3' }] },
  ];

  it.each(specs.map((s, i) => [i, s] as const))('matches the general engine (#%i)', (_i, spec) => {
    const { slow, fast } = both(model, spec);
    expect(strip(fast)).toEqual(strip(slow));
    expect(fast.rows.length).toBeGreaterThan(0);
  });

  it('falls back for measures that need the full engine', () => {
    for (const values of [['Sales YTD'], ['Share of Category'], ['Sales by Ship Date'], [{ expression: 'SUM(Sales[SalesAmount]) + 1' }]]) {
      const { slow, fast } = both(model, { groupBy: ['Product[Category]'], values, totals: true });
      expect(strip(fast)).toEqual(strip(slow));
    }
  });

  it('handles blanks, unmatched keys and dimension nulls like the general path', () => {
    const m = new DataModel()
      .addTable('F', [
        { k: 1, v: 10, t: 'a' },
        { k: 1, v: null, t: '' },
        { k: 2, v: 5, t: null },
        { k: 9, v: 7, t: 'z' }, // no matching dimension row
        { k: 3, v: null, t: null },
      ])
      .addTable('D', [
        { k: 1, name: 'one' },
        { k: 2, name: null },
        { k: 3, name: 'three' },
      ])
      .addRelationship({ from: 'F[k]', to: 'D[k]' })
      .addMeasure('S', 'SUM(F[v])')
      .addMeasure('C', 'COUNTA(F[t])')
      .addMeasure('N', 'COUNTROWS(F)')
      .addMeasure('DC', 'DISTINCTCOUNT(F[t])');
    for (const values of [['S'], ['C'], ['N', 'S'], ['DC'], [{ expression: 'DIVIDE([S], [N])' }]]) {
      for (const groupBy of [['D[name]'], ['D[name]', 'F[t]']]) {
        const { slow, fast } = both(m, { groupBy, values, totals: true });
        expect(strip(fast)).toEqual(strip(slow));
      }
    }
  });
});

afterAll(() => setFastQuery('auto'));

describe('model.appendRows', () => {
  const make = () =>
    new DataModel()
      .addTable('F', [
        { k: 1, v: 10 },
        { k: 2, v: 20 },
      ])
      .addTable('D', [
        { k: 1, name: 'a' },
        { k: 2, name: 'b' },
      ])
      .addRelationship({ from: 'F[k]', to: 'D[k]' })
      .addCalculatedColumn('F', 'Double', 'F[v] * 2')
      .addCalculatedColumn('F', 'Share', 'DIVIDE(F[v], SUM(F[v]))')
      .addCalculatedColumn('D', 'Total', 'CALCULATE(SUM(F[v]))')
      .addMeasure('S', 'SUM(F[v])');

  it('extends calculated columns, recomputes aggregating ones and notifies once', () => {
    const m = make();
    let n = 0;
    m.onChange(() => n++);
    m.evaluate('[S]'); // warm the measure cache
    m.appendRows('F', [{ k: 1, v: 30 }]);
    expect(n).toBeGreaterThan(0);
    expect(m.evaluate('[S]')).toBe(60);
    expect(m.table('F').column('Double').values).toEqual([20, 40, 60]);
    expect(m.table('F').column('Share').values).toEqual([10 / 60, 20 / 60, 30 / 60]);
    expect(m.table('D').column('Total').values).toEqual([40, 20]);
    expect(m.evaluate('SUM(F[Double])')).toBe(120);
    expect(m.query({ groupBy: ['D[name]'], values: ['S'] }).rows.map((r) => r.values[0])).toEqual([40, 20]);
  });

  it('keeps a sliding window with maxRows', () => {
    const m = make();
    m.appendRows('F', [
      { k: 2, v: 1 },
      { k: 2, v: 2 },
      { k: 1, v: 3 },
    ], { maxRows: 3 });
    expect(m.table('F').rowCount).toBe(3);
    expect(m.table('F').column('v').values).toEqual([1, 2, 3]);
    expect(m.table('F').column('Double').values).toEqual([2, 4, 6]);
    expect(m.evaluate('[S]')).toBe(6);
    // more new rows than the window: only the newest survive
    m.appendRows('F', [1, 2, 3, 4, 5].map((v) => ({ k: 1, v })), { maxRows: 2 });
    expect(m.table('F').column('Double').values).toEqual([8, 10]);
  });
});

describe('rendering at scale', () => {
  const big = (n: number) =>
    new DataModel()
      .addTable(
        'P',
        Array.from({ length: n }, (_, i) => ({ id: i, t: i, x: Math.sin(i / 50) * 100 + (i % 7), y: Math.cos(i / 30) * 50 + (i % 5), g: i % 3 === 0 ? 'a' : 'b' })),
      )
      .addMeasure('X', 'SUM(P[x])')
      .addMeasure('Y', 'SUM(P[y])');
  const mount = () => {
    const el = document.createElement('div');
    el.style.width = '600px';
    el.style.height = '400px';
    document.body.append(el);
    return el;
  };

  it('LTTB keeps endpoints, extremes and gaps', () => {
    const pts = Array.from({ length: 1000 }, (_, i) => [i, i === 500 ? 1000 : Math.sin(i / 10)] as [number, number]);
    const out = lttb(pts, 50);
    expect(out).toHaveLength(50);
    expect(out[0]).toEqual(pts[0]);
    expect(out[49]).toEqual(pts[999]);
    expect(out.some((p) => p[1] === 1000)).toBe(true);
    const gappy = downsampleRuns([...pts.slice(0, 400), null, ...pts.slice(400)], 60);
    expect(gappy.filter((p) => p === null)).toHaveLength(1);
    expect(gappy.length).toBeLessThanOrEqual(62);
    expect(lttb(pts.slice(0, 10), 50)).toHaveLength(10);
  });

  it('thins dense lines but hovers every point', () => {
    const el = mount();
    const r = createVisual(el, { model: big(5000), type: 'line', fields: { category: 'P[t]', values: 'X' } });
    r.flush();
    const d = el.querySelector('path.pbi-line')!.getAttribute('d')!;
    const n = d.split(/[ML]/).filter(Boolean).length;
    expect(n).toBeGreaterThanOrEqual(300);
    expect(n).toBeLessThan(5000);
    r.destroy();
    el.remove();
  });

  it('windows large tables and keeps banding parity', () => {
    const el = mount();
    const r = createVisual(el, { model: big(2000), type: 'table', fields: { columns: ['P[id]', 'X'] } });
    r.flush();
    const body = el.querySelector('tbody')!;
    const dataRows = body.querySelectorAll('tr:not(.pbi-spacer)');
    expect(dataRows.length).toBeGreaterThan(10);
    expect(dataRows.length).toBeLessThan(200);
    expect(body.querySelectorAll('tr.pbi-spacer').length).toBe(1);
    // scroll to the middle: a top spacer appears and the first data row index is odd
    const scroller = el.querySelector('.pbi-table-scroll') as HTMLElement;
    scroller.scrollTop = 28 * 1000;
    scroller.dispatchEvent(new Event('scroll'));
    return new Promise<void>((done) =>
      setTimeout(() => {
        const rows = [...body.children];
        expect(rows[0].classList.contains('pbi-spacer')).toBe(true);
        expect(rows[rows.length - 1].classList.contains('pbi-spacer')).toBe(true);
        const firstId = Number(rows[1].children[0].textContent!.replace(/,/g, ''));
        expect(firstId % 2).toBe(1);
        expect(firstId).toBeGreaterThan(900);
        r.destroy();
        el.remove();
        done();
      }, 40),
    );
  });

  it('paints big scatters on a canvas with pointer hit-testing', () => {
    const calls: string[] = [];
    const fake = new Proxy({}, { get: (_t, k) => (k === 'canvas' ? undefined : (...a: unknown[]) => calls.push(String(k)) && a && undefined), set: () => true });
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => fake) as never;
    const el = mount();
    try {
      const r = createVisual(el, { model: big(4000), type: 'scatter', fields: { details: 'P[id]', x: 'X', y: 'Y', legend: 'P[g]' } });
      r.flush();
      expect(el.querySelector('canvas.pbi-canvas')).not.toBeNull();
      expect(el.querySelectorAll('circle.pbi-mark')).toHaveLength(0);
      expect(calls.filter((c) => c === 'arc')).toHaveLength(4000);
      expect(el.querySelector('rect.pbi-hit')).not.toBeNull();
      r.destroy();
    } finally {
      HTMLCanvasElement.prototype.getContext = orig;
      el.remove();
    }
    // without canvas support it falls back to SVG marks
    const el2 = mount();
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    try {
      const r = createVisual(el2, { model: big(3500), type: 'scatter', fields: { details: 'P[id]', x: 'X', y: 'Y' } });
      r.flush();
      expect(el2.querySelectorAll('circle.pbi-mark')).toHaveLength(3500);
      r.destroy();
    } finally {
      HTMLCanvasElement.prototype.getContext = orig;
      el2.remove();
    }
  });
});
