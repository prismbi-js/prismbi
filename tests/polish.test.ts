import { describe, expect, it } from 'vitest';
import { DataModel } from '@prismbi/prismbi/core';
import { createVisual } from '../src/index';

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
