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
