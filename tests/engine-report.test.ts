import { describe, expect, it } from 'vitest';
import { Report } from '../src/index';
import { createLocalEngine } from '@prismbi/prismbi/worker';
import { makeModel } from './fixtures';

describe('reports on an engine', () => {
  it('render asynchronously, show loading then results, and re-query on slicing', async () => {
    const el = document.createElement('div');
    el.style.height = '800px';
    document.body.append(el);
    try {
      const model = makeModel();
      const queries: string[] = [];
      const local = createLocalEngine(model);
      const engine = { query: (spec: Parameters<typeof local.query>[0], signal?: AbortSignal) => (queries.push(JSON.stringify(spec.groupBy ?? [])), local.query(spec, signal)) };
      const r = new Report(el, {
        model,
        engine,
        pages: [
          {
            id: 'p',
            name: 'P',
            visuals: [
              { id: 'slicer', type: 'slicer', layout: { x: 0, y: 0, w: 12, h: 2 }, fields: { field: 'Region[Name]' }, format: { slicer: { style: 'tiles' } } },
              { id: 'card', type: 'card', layout: { x: 0, y: 2, w: 3, h: 2 }, fields: { value: 'Total Sales' } },
              { id: 'cols', type: 'clusteredColumn', layout: { x: 3, y: 2, w: 9, h: 6 }, fields: { category: 'Products[Category]', values: 'Total Sales' } },
            ],
          },
        ],
      });
      r.flush();
      // slicer renders synchronously from the local model; measures wait for the engine
      expect(el.querySelectorAll('.pbi-tile').length).toBeGreaterThan(0);
      expect(el.querySelectorAll('.pbi-loading')).toHaveLength(2);
      const settle = () => new Promise((res) => setTimeout(res, 20));
      await settle();
      expect(el.querySelectorAll('.pbi-loading')).toHaveLength(0);
      expect(el.querySelector('[data-visual-id="card"] .pbi-card-value')?.textContent).toBe('$6,750');
      expect(el.querySelectorAll('[data-visual-id="cols"] path.pbi-mark')).toHaveLength(3);
      const before = queries.length;
      r.setSlicerSelection('slicer', [{ target: 'Region[Name]', op: 'in', values: ['South'] }]);
      r.flush();
      // previous results stay on screen, dimmed, while the engine works
      expect(el.querySelector('[data-visual-id="card"]')!.classList.contains('is-busy')).toBe(true);
      await settle();
      expect(el.querySelector('[data-visual-id="card"]')!.classList.contains('is-busy')).toBe(false);
      expect(el.querySelector('[data-visual-id="card"] .pbi-card-value')?.textContent).toBe('$2,300');
      expect(queries.length).toBe(before + 2);
      r.destroy();
    } finally {
      el.remove();
    }
  });
});
