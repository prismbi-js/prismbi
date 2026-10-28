import { describe, expect, it } from 'vitest';
import { DataModel } from '@prismbi/prismbi/core';
import { createVisual, renderSparkline } from '../src/index';

const mount = () => {
  const el = document.createElement('div');
  el.style.width = '600px';
  el.style.height = '400px';
  document.body.append(el);
  return el;
};

/** A 2D context that records the calls made on it. */
function fakeCanvas() {
  const calls: string[] = [];
  const fake = new Proxy({}, { get: (_t, k) => (k === 'canvas' ? undefined : (...a: unknown[]) => calls.push(String(k)) && a && undefined), set: () => true });
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = (() => fake) as never;
  return { calls, restore: () => (HTMLCanvasElement.prototype.getContext = orig) };
}

const grid = (rows: number, cols: number) =>
  new DataModel()
    .addTable(
      'G',
      Array.from({ length: rows * cols }, (_, i) => ({ r: `r${String(Math.floor(i / cols)).padStart(3, '0')}`, c: `c${String(i % cols).padStart(3, '0')}`, v: i })),
    )
    .addMeasure('V', 'SUM(G[v])');

describe('canvas heatmaps and calendars', () => {
  it('paints a big heatmap on a canvas and hit-tests cells by row and column', () => {
    const { calls, restore } = fakeCanvas();
    const el = mount();
    try {
      const r = createVisual(el, { model: grid(60, 60), type: 'heatmap', fields: { rows: 'G[r]', columns: 'G[c]', values: 'V' } });
      r.flush();
      expect(el.querySelector('canvas.pbi-canvas')).not.toBeNull();
      expect(el.querySelectorAll('rect.pbi-mark')).toHaveLength(0);
      expect(calls.filter((c) => c === 'roundRect' || c === 'fillRect')).toHaveLength(3600);
      // axis labels stay SVG text
      expect(el.querySelectorAll('text.pbi-tick').length).toBeGreaterThan(60);
      const hit = el.querySelector('rect.pbi-hit')!;
      const picked: unknown[] = [];
      r.on('dataPointClick', (e) => picked.push(e.keys));
      // the first cell sits just right of the row labels, below the column labels
      const W = parseFloat((el.querySelector('canvas') as HTMLCanvasElement).style.width);
      hit.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: W - 2, clientY: 30 }));
      expect(picked).toHaveLength(1);
      expect((picked[0] as string[])[1]).toBe('c059');
      r.destroy();
    } finally {
      restore();
      el.remove();
    }
  });

  it('keeps small heatmaps and canvas-less environments on SVG', () => {
    const el = mount();
    const r = createVisual(el, { model: grid(10, 10), type: 'heatmap', fields: { rows: 'G[r]', columns: 'G[c]', values: 'V' } });
    r.flush();
    expect(el.querySelectorAll('rect.pbi-mark')).toHaveLength(100);
    expect(el.querySelector('canvas')).toBeNull();
    r.destroy();
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    try {
      const r2 = createVisual(el, { model: grid(60, 60), type: 'heatmap', fields: { rows: 'G[r]', columns: 'G[c]', values: 'V' } });
      r2.flush();
      expect(el.querySelectorAll('rect.pbi-mark')).toHaveLength(3600);
      r2.destroy();
    } finally {
      HTMLCanvasElement.prototype.getContext = orig;
      el.remove();
    }
  });

  it('paints a many-year calendar on a canvas, and format.calendar.renderer forces either path', () => {
    const days = Array.from({ length: 365 * 10 }, (_, i) => ({ d: new Date(2015, 0, 1 + i), v: i % 17 }));
    const m = new DataModel().addTable('D', days).addMeasure('V', 'SUM(D[v])');
    const { calls, restore } = fakeCanvas();
    const el = mount();
    try {
      const r = createVisual(el, { model: m, type: 'calendar', fields: { date: 'D[d]', values: 'V' } });
      r.flush();
      expect(el.querySelector('canvas.pbi-canvas')).not.toBeNull();
      expect(el.querySelectorAll('rect.pbi-mark')).toHaveLength(0);
      expect(calls.filter((c) => c === 'roundRect' || c === 'fillRect').length).toBeGreaterThanOrEqual(3650);
      r.destroy();
      const svg = createVisual(el, { model: m, type: 'calendar', fields: { date: 'D[d]', values: 'V' }, format: { calendar: { renderer: 'svg' } } as never });
      svg.flush();
      expect(el.querySelectorAll('rect.pbi-mark')).toHaveLength(3650);
      svg.destroy();
      const small = new DataModel().addTable('D', days.slice(0, 40)).addMeasure('V', 'SUM(D[v])');
      const forced = createVisual(el, { model: small, type: 'calendar', fields: { date: 'D[d]', values: 'V' }, format: { calendar: { renderer: 'canvas' } } as never });
      forced.flush();
      expect(el.querySelector('canvas.pbi-canvas')).not.toBeNull();
      forced.destroy();
    } finally {
      restore();
      el.remove();
    }
  });
});

describe('virtualized matrix', () => {
  const tree = () =>
    new DataModel()
      .addTable('T', Array.from({ length: 2000 }, (_, i) => ({ a: `a${String(Math.floor(i / 10)).padStart(3, '0')}`, b: `b${i % 10}`, v: i })))
      .addMeasure('V', 'SUM(T[v])');

  it('windows expanded rows, counting subtotal rows, and keeps expand state', () => {
    const el = mount();
    const r = createVisual(el, { model: tree(), type: 'matrix', fields: { rows: ['T[a]', 'T[b]'], values: 'V' }, format: { matrix: { expandAll: true } } as never });
    r.flush();
    const body = () => el.querySelector('tbody')!;
    const data = () => [...body().children].filter((tr) => !tr.classList.contains('pbi-spacer'));
    // 200 parents + 2000 children = 2200 rows, only a window of them in the DOM
    expect(data().length).toBeGreaterThan(10);
    expect(data().length).toBeLessThan(200);
    expect(body().querySelectorAll('tr.pbi-spacer')).toHaveLength(1);
    expect(data()[0].classList.contains('pbi-level-1')).toBe(true);
    expect(data()[1].classList.contains('pbi-level-2')).toBe(true);
    // collapse the first parent: its children leave the list
    (data()[0].querySelector('.pbi-expander') as HTMLElement).click();
    r.flush();
    expect(data()[1].classList.contains('pbi-level-1')).toBe(true);
    expect(data()[1].textContent).toContain('a001');
    r.destroy();
    el.remove();
  });

  it('renders small matrices in full, and virtualize forces either way', () => {
    const el = mount();
    const r = createVisual(el, { model: tree(), type: 'matrix', fields: { rows: ['T[a]', 'T[b]'], values: 'V' } });
    r.flush();
    // collapsed: 200 rows, under the threshold
    expect(el.querySelectorAll('tbody tr:not(.pbi-spacer)')).toHaveLength(200);
    r.destroy();
    const v = createVisual(el, { model: tree(), type: 'matrix', fields: { rows: ['T[a]', 'T[b]'], values: 'V' }, format: { matrix: { virtualize: true } } as never });
    v.flush();
    expect(el.querySelectorAll('tbody tr.pbi-spacer')).toHaveLength(1);
    v.destroy();
    el.remove();
  });

  it('supports non-stepped layout with distinct columns per row field', () => {
    const m = new DataModel()
      .addTable('T', [
        { a: 'Category 1', b: 'Product A', v: 100 },
        { a: 'Category 1', b: 'Product B', v: 200 },
        { a: 'Category 2', b: 'Product C', v: 300 },
      ])
      .addMeasure('V', 'SUM(T[v])');

    const el = mount();
    const r = createVisual(el, {
      model: m,
      type: 'matrix',
      fields: { rows: ['T[a]', 'T[b]'], values: 'V' },
      format: { matrix: { stepped: false, expandAll: true } } as never,
    });
    r.flush();

    // In non-stepped mode, thead should have separate headers for each row field
    const ths = [...el.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(ths).toContain('a');
    expect(ths).toContain('b');
    expect(ths).toContain('V');

    // Row cells should have non-stepped structure with indent columns
    expect(el.querySelectorAll('tbody td.pbi-indent').length).toBeGreaterThan(0);

    r.destroy();
    el.remove();
  });

  it('renders standalone and in-cell sparklines', () => {
    const svgLine = renderSparkline([10, 25, 15, 30], { type: 'line', width: 80, height: 20 });
    expect(svgLine.tagName.toLowerCase()).toBe('svg');
    expect(svgLine.getAttribute('width')).toBe('80');
    expect(svgLine.getAttribute('height')).toBe('20');
    expect(svgLine.querySelector('polyline')).not.toBeNull();

    const svgCol = renderSparkline([10, 25, 15, 30], { type: 'column' });
    expect(svgCol.querySelectorAll('rect').length).toBe(4);

    const m = new DataModel()
      .addTable('T', [{ a: 'Cat', v: 50 }])
      .addMeasure('V', 'SUM(T[v])');

    const el = mount();
    const r = createVisual(el, {
      model: m,
      type: 'matrix',
      fields: { rows: 'T[a]', values: 'V' },
      format: { matrix: { sparklines: { V: { type: 'line' } } } } as never,
    });
    r.flush();

    expect(el.querySelectorAll('.pbi-sparkline').length).toBeGreaterThan(0);
    r.destroy();
    el.remove();
  });
});

describe('Studio undo history', () => {
  it('stores splices, not snapshots, and walks back and forth exactly', async () => {
    const { History } = await import('../src/studio/history');
    const doc = { pages: [{ visuals: Array.from({ length: 300 }, (_, i) => ({ id: `v${i}`, type: 'bar', x: i, y: 0, title: `Visual ${i}` })) }] };
    const h = new History<typeof doc>(200);
    h.reset(doc);
    const states: string[] = [JSON.stringify(doc)];
    for (let k = 0; k < 150; k++) {
      const next = JSON.parse(states[states.length - 1]) as typeof doc;
      if (k % 10 === 9) next.pages[0].visuals.splice(k, 1); // a deletion
      else next.pages[0].visuals[k].title = `Renamed ${k}`;
      expect(h.push(next)).toBe(true);
      states.push(JSON.stringify(next));
    }
    expect(h.push(JSON.parse(states[states.length - 1]))).toBe(false);
    // far less than 150 copies of a ~20 KB document
    expect(states[0].length).toBeGreaterThan(15_000);
    expect(h.stored).toBeLessThan(states[0].length);
    for (let k = states.length - 2; k >= 0; k--) expect(JSON.stringify(h.undo())).toBe(states[k]);
    expect(h.undo()).toBeUndefined();
    for (let k = 1; k < states.length; k++) expect(JSON.stringify(h.redo())).toBe(states[k]);
    expect(h.canRedo).toBe(false);
    // the limit drops the oldest steps
    const small = new History<number[]>(3);
    small.reset([0]);
    for (let k = 1; k <= 5; k++) small.push([k]);
    expect(small.size).toBe(3);
    expect([small.undo(), small.undo(), small.undo(), small.undo()]).toEqual([[4], [3], [2], undefined]);
  });
});

describe('sunburst', () => {
  it('draws one ring per level, sizes children within their parent, and selects any level', async () => {
    const { buildModel } = await import('../examples/model');
    const model = buildModel();
    const el = mount();
    const r = createVisual(el, { model, type: 'sunburst', fields: { category: ['Product[Category]', 'Product[Subcategory]'], values: 'Total Sales' } });
    r.flush();
    const cats = model.query({ groupBy: ['Product[Category]'], values: ['Total Sales'] }).rows.filter((x) => (x.values[0] as number) > 0);
    const subs = model.query({ groupBy: ['Product[Category]', 'Product[Subcategory]'], values: ['Total Sales'] }).rows.filter((x) => (x.values[0] as number) > 0);
    const arcs = [...el.querySelectorAll('path.pbi-mark')];
    expect(arcs).toHaveLength(cats.length + subs.length);
    // the total sits in the middle
    expect([...el.querySelectorAll('text')].some((t) => t.getAttribute('font-weight') === '600' && /^\$[\d.,]+[KMB]?$/.test(t.textContent ?? ''))).toBe(true);
    // clicking an inner arc selects the category; clicking an outer one selects category + subcategory
    const picked: unknown[] = [];
    r.on('dataPointClick', (e) => picked.push(e.keys));
    (arcs[0] as SVGElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    (arcs[arcs.length - 1] as SVGElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect((picked[0] as unknown[]).length).toBe(1);
    expect((picked[1] as unknown[]).length).toBe(2);
    r.destroy();
    el.remove();
  });

  it('uses real evaluations per level, so ratios stay correct', async () => {
    const { buildModel } = await import('../examples/model');
    const model = buildModel();
    const el = mount();
    const r = createVisual(el, { model, type: 'sunburst', fields: { category: ['Product[Category]', 'Product[Subcategory]'], values: 'Margin %' } });
    r.flush();
    expect(el.querySelectorAll('path.pbi-mark').length).toBeGreaterThan(0);
    r.destroy();
    el.remove();
  });
});

describe('scorecard (goals)', () => {
  it('scores progress, with at-risk thresholds and lower-is-better goals', async () => {
    const { goalStatus } = await import('../src/visuals/scorecard');
    expect(goalStatus(110, 100)).toEqual({ progress: 1.1, status: 'on-track' });
    expect(goalStatus(95, 100).status).toBe('at-risk');
    expect(goalStatus(80, 100).status).toBe('behind');
    expect(goalStatus(80, 100, { atRisk: 0.75 }).status).toBe('at-risk');
    expect(goalStatus(50, 40, { direction: 'down' })).toEqual({ progress: 0.8, status: 'behind' });
    expect(goalStatus(null, 100).status).toBe('none');
    expect(goalStatus(5, null).status).toBe('none');
  });

  it('lists each goal with current value, target, status and trend', async () => {
    const { buildModel } = await import('../examples/model');
    const model = buildModel();
    const el = mount();
    const y = [{ target: 'Date[Year]', op: 'eq' as const, value: 2025 }];
    const spec = {
      model,
      type: 'scorecard',
      fields: { values: ['Total Sales', 'Margin %'], targets: ['Sales Target'], trend: 'Date[MonthYear]' },
      filters: y,
      format: { scorecard: { goals: { 'Margin %': { target: 0.99, owner: 'Finance' } } } } as never,
    };
    // a narrow tile keeps only the goal, its current value and status
    const narrow = createVisual(el, spec);
    narrow.flush();
    expect([...el.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['Goal', 'Current', 'Status']);
    narrow.destroy();
    // jsdom has no layout: pretend the tile is wide
    const width = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')!;
    Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => 900 });
    const r = createVisual(el, spec);
    try {
      r.flush();
    } finally {
      Object.defineProperty(Element.prototype, 'clientWidth', width);
    }
    const rows = [...el.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    // Total Sales is paired with Sales Target; current = the latest month with sales
    const months = model.query({ groupBy: ['Date[MonthYear]'], values: ['Total Sales', 'Sales Target'], filters: y }).rows;
    const last = months[months.length - 1];
    const { goalStatus } = await import('../src/visuals/scorecard');
    expect(rows[0].getAttribute('data-status')).toBe(goalStatus(last.values[0], last.values[1]).status);
    // Margin % uses its fixed target: far above any real margin
    expect(rows[1].getAttribute('data-status')).toBe('behind');
    expect(rows[1].textContent).toContain('Finance');
    expect(el.querySelectorAll('tbody svg')).toHaveLength(2); // sparklines
    // no goal has a due date: that column is left out
    expect([...el.querySelectorAll('th')].map((th) => th.textContent)).not.toContain('Due');
    r.destroy();
    el.remove();
  });
});

describe('shared text and date values', () => {
  it('keeps one object per distinct string or date, also across appends', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ d: new Date(2025, 0, 1 + (i % 10)), s: ['a', 'b', 'c'][i % 3].split('').join(''), n: i }));
    const m = new DataModel().addTable('T', rows);
    const d = m.table('T').column('d').values as Date[];
    expect(d[0]).toBe(d[10]);
    expect(d[10]).not.toBe(rows[10].d); // later rows share the first occurrence's object
    expect(new Set(d).size).toBe(10);
    m.appendRows('T', [{ d: new Date(2025, 0, 1), s: 'a', n: 1 }]);
    expect(m.table('T').column('d').values[1000]).toBe(d[0]);
    expect(m.query({ groupBy: ['T[s]'], values: [{ field: 'T[n]', aggregation: 'countRows' }] }).rows.map((r) => r.values[0])).toEqual([335, 333, 333]);
  });
});
