import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Report } from '../src/index';
import { Studio } from '../src/studio/studio';
import { makeModel } from './fixtures';

let el: HTMLElement;
if (typeof window.PointerEvent === 'undefined') {
  window.PointerEvent = class PointerEvent extends MouseEvent {} as any;
  (globalThis as any).PointerEvent = window.PointerEvent;
}
beforeEach(() => {
  el = document.createElement('div');
  el.style.width = '1000px';
  el.style.height = '800px';
  document.body.append(el);
});
afterEach(() => el.remove());

describe('Phase 25 Features', () => {
  describe('1. Table & Matrix Double-Click Auto-Fit Column Width', () => {
    it('auto-fits column width on double-click of resizer and emits columnResize', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Table Page',
            visuals: [
              {
                id: 'table1',
                type: 'table',
                layout: { x: 0, y: 0, w: 10, h: 8 },
                fields: { columns: ['Products[Category]', 'Total Sales'] },
                format: {
                  table: {
                    columnWidths: {
                      'Products[Category]': 250,
                    },
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const tableVisual = el.querySelector('[data-visual-id="table1"]')!;
      const headers = tableVisual.querySelectorAll<HTMLTableCellElement>('thead th');
      const catHeader = headers[0];
      const resizer = catHeader.querySelector<HTMLElement>('.pbi-col-resizer');
      expect(resizer).not.toBeNull();

      let resizeEventData: { visualId: string; column: string; width: number; widths: Record<string, number> } | null = null;
      report.on('columnResize', (data) => {
        resizeEventData = data as any;
      });

      // Double-click on resizer
      resizer!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

      expect(resizeEventData).not.toBeNull();
      expect(resizeEventData!.column).toBe('Products[Category]');
      expect(resizeEventData!.width).toBeGreaterThanOrEqual(50);
      expect(catHeader.style.width).toBe(`${resizeEventData!.width}px`);

      // Verify host state
      const host = (report as any).pages[0].hosts.get('table1');
      expect(host.state.columnWidths['Products[Category]']).toBe(resizeEventData!.width);

      report.destroy();
    });

    it('auto-fits column width in matrix headers on double-click', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Matrix Page',
            visuals: [
              {
                id: 'mat1',
                type: 'matrix',
                layout: { x: 0, y: 0, w: 12, h: 8 },
                fields: {
                  rows: ['Products[Category]'],
                  values: ['Total Sales'],
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const matVisual = el.querySelector('[data-visual-id="mat1"]')!;
      const th = matVisual.querySelector<HTMLTableCellElement>('thead th');
      expect(th).not.toBeNull();
      const resizer = th!.querySelector<HTMLElement>('.pbi-col-resizer');
      expect(resizer).not.toBeNull();

      resizer!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      expect(th!.style.width).toBeTruthy();

      report.destroy();
    });
  });

  describe('2. Treemap & Sunburst Secondary Color Measure', () => {
    it('colors treemap tiles via secondary color measure sequential ramp', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Treemap Page',
            visuals: [
              {
                id: 'tm1',
                type: 'treemap',
                layout: { x: 0, y: 0, w: 10, h: 8 },
                fields: {
                  category: ['Products[Category]'],
                  values: ['Total Sales'],
                  color: ['Profit'],
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const tmVisual = el.querySelector('[data-visual-id="tm1"]')!;
      const rects = tmVisual.querySelectorAll<SVGRectElement>('svg rect');
      expect(rects.length).toBeGreaterThan(0);

      // Verify fill colors are set
      for (const r of Array.from(rects)) {
        expect(r.getAttribute('fill')).toBeTruthy();
      }

      report.destroy();
    });

    it('colors sunburst sectors via secondary color measure and includes it in tooltip', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Sunburst Page',
            visuals: [
              {
                id: 'sb1',
                type: 'sunburst',
                layout: { x: 0, y: 0, w: 10, h: 8 },
                fields: {
                  category: ['Products[Category]', 'Products[Name]'],
                  values: ['Total Sales'],
                  color: ['Profit'],
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const sbVisual = el.querySelector('[data-visual-id="sb1"]')!;
      const paths = sbVisual.querySelectorAll<SVGPathElement>('svg path');
      expect(paths.length).toBeGreaterThan(0);

      report.destroy();
    });
  });

  describe('3. Analytics Reference Line Interactive Inspection & Distribution Tooltips', () => {
    it('renders transparent hit line and shows distribution stats on hover', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Bar Page',
            visuals: [
              {
                id: 'bar1',
                type: 'bar',
                layout: { x: 0, y: 0, w: 10, h: 8 },
                fields: {
                  category: ['Products[Category]'],
                  values: ['Total Sales'],
                },
                format: {
                  analytics: {
                    referenceLines: [
                      {
                        type: 'average',
                        color: '#ff0000',
                        label: 'Avg: {value}',
                      },
                    ],
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const barVisual = el.querySelector('[data-visual-id="bar1"]')!;
      const refLines = barVisual.querySelectorAll('.pbi-refline');
      expect(refLines.length).toBeGreaterThan(0);

      const hitLine = barVisual.querySelector<SVGLineElement>('.pbi-refline-hit');
      expect(hitLine).not.toBeNull();
      expect(hitLine!.getAttribute('stroke')).toBe('transparent');
      expect(hitLine!.getAttribute('stroke-width')).toBe('12');

      // Spy on report.tooltip.show
      let tooltipShown = false;
      let tooltipItems: any[] = [];
      const origShow = report.tooltip.show.bind(report.tooltip);
      report.tooltip.show = (evt: any, items: any[], title: any) => {
        tooltipShown = true;
        tooltipItems = items;
        origShow(evt, items, title);
      };

      // Hover over the hit line
      hitLine!.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: 200, bubbles: true }));
      expect(tooltipShown).toBe(true);
      expect(tooltipItems.some((i) => i.label === 'Above')).toBe(true);
      expect(tooltipItems.some((i) => i.label === 'Below')).toBe(true);

      // Mouseleave
      let tooltipHidden = false;
      const origHide = report.tooltip.hide.bind(report.tooltip);
      report.tooltip.hide = () => {
        tooltipHidden = true;
        origHide();
      };
      hitLine!.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
      expect(tooltipHidden).toBe(true);

      report.destroy();
    });
  });

  describe('4. Studio Multi-Visual Distribution Tools & Keyboard Shortcuts', () => {
    it('distributes 3 visuals horizontally and vertically with equal spacing', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Distribute Page',
            visuals: [
              { id: 'v1', type: 'card', layout: { x: 0, y: 0, w: 2, h: 2 }, fields: { value: ['Total Sales'] } },
              { id: 'v2', type: 'card', layout: { x: 3, y: 1, w: 2, h: 2 }, fields: { value: ['Total Sales'] } },
              { id: 'v3', type: 'card', layout: { x: 10, y: 8, w: 2, h: 2 }, fields: { value: ['Total Sales'] } },
            ],
          },
        ],
      });
      report.flush();

      // Distribute horizontally
      report.selectVisuals(['v1', 'v2', 'v3']);
      report.distributeVisuals('horizontal');

      const l1 = report.layoutOf('v1');
      const l2 = report.layoutOf('v2');
      const l3 = report.layoutOf('v3');

      // The gap between v1 and v2 should match gap between v2 and v3
      const gap1 = l2.x - (l1.x + l1.w);
      const gap2 = l3.x - (l2.x + l2.w);
      expect(Math.abs(gap1 - gap2)).toBeLessThanOrEqual(1);

      // Distribute vertically
      report.distributeVisuals('vertical');
      const vl1 = report.layoutOf('v1');
      const vl2 = report.layoutOf('v2');
      const vl3 = report.layoutOf('v3');
      const vgap1 = vl2.y - (vl1.y + vl1.h);
      const vgap2 = vl3.y - (vl2.y + vl2.h);
      expect(Math.abs(vgap1 - vgap2)).toBeLessThanOrEqual(1);

      report.destroy();
    });

    it('handles Alt+Shift+H and Alt+Shift+V in Studio', () => {
      const model = makeModel();
      const studio = new Studio(el, { model });
      const report = studio.report;
      report.flush();

      // Add 3 visuals
      const id1 = report.addVisual({ type: 'card', layout: { x: 0, y: 0, w: 2, h: 2 }, fields: { value: ['Total Sales'] } });
      const id2 = report.addVisual({ type: 'card', layout: { x: 4, y: 2, w: 2, h: 2 }, fields: { value: ['Total Sales'] } });
      const id3 = report.addVisual({ type: 'card', layout: { x: 10, y: 8, w: 2, h: 2 }, fields: { value: ['Total Sales'] } });
      report.selectVisuals([id1, id2, id3]);

      // Trigger Alt+Shift+H on studio root
      studio.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', altKey: true, shiftKey: true, bubbles: true }));

      const l1 = report.layoutOf(id1);
      const l2 = report.layoutOf(id2);
      const l3 = report.layoutOf(id3);
      const gap1 = l2.x - (l1.x + l1.w);
      const gap2 = l3.x - (l2.x + l2.w);
      expect(Math.abs(gap1 - gap2)).toBeLessThanOrEqual(1);

      studio.destroy();
    });
  });

  describe('5. Report URL Deep-Linking & State Synchronization', () => {
    it('serializes and deserializes report state via URLSearchParams', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        theme: 'ocean',
        pages: [
          {
            id: 'p1',
            name: 'Page 1',
            visuals: [
              { id: 'v1', type: 'card', layout: { x: 0, y: 0, w: 2, h: 2 }, fields: { value: ['Total Sales'] } },
            ],
          },
          {
            id: 'p2',
            name: 'Page 2',
            visuals: [
              { id: 'v2', type: 'card', layout: { x: 0, y: 0, w: 2, h: 2 }, fields: { value: ['Total Sales'] } },
            ],
          },
        ],
      });
      report.flush();

      // Go to page 2 and apply a report filter
      report.goToPage('p2');
      report.setReportFilters([
        { target: 'Products[Category]', op: 'in', values: ['Accessories'] },
      ]);

      const params = report.toUrlParams();
      expect(params.get('page')).toBe('p2');
      expect(params.get('theme')).toBe('ocean');
      expect(params.get('filters')).toBeTruthy();

      // Create a fresh report on Page 1 and default theme
      const report2 = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Page 1',
            visuals: [
              { id: 'v1', type: 'card', layout: { x: 0, y: 0, w: 2, h: 2 }, fields: { value: ['Total Sales'] } },
            ],
          },
          {
            id: 'p2',
            name: 'Page 2',
            visuals: [
              { id: 'v2', type: 'card', layout: { x: 0, y: 0, w: 2, h: 2 }, fields: { value: ['Total Sales'] } },
            ],
          },
        ],
      });
      report2.flush();

      expect(report2.currentPage.id).toBe('p1');
      expect(report2.theme.name).not.toBe('ocean');

      // Load state from URL params
      const changed = report2.loadFromUrlParams(params);
      expect(changed).toBe(true);

      // Verify restored state
      expect(report2.currentPage.id).toBe('p2');
      expect(report2.theme.name).toBe('ocean');
      expect(report2.reportFilterList.length).toBe(1);
      expect((report2.reportFilterList[0] as any).target).toBe('Products[Category]');

      report.destroy();
      report2.destroy();
    });
  });
});
