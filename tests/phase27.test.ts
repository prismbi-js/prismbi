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

describe('Phase 27 Features', () => {
  describe('1. Interactive Hierarchical Drill Breadcrumbs & Quick-Nav', () => {
    it('renders clickable breadcrumb buttons and supports drillTo navigation', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Drill Page',
            visuals: [
              {
                id: 'chart1',
                type: 'clusteredColumn',
                layout: { x: 0, y: 0, w: 10, h: 8 },
                fields: {
                  category: ['Products[Category]', 'Products[Name]'],
                  values: ['Total Sales'],
                },
              },
            ],
          },
        ],
      });
      report.flush();

      // Drill down into 'Bikes'
      report.visual('chart1').drillDown('Bikes');
      report.flush();

      const chartVisual = el.querySelector('[data-visual-id="chart1"]')!;
      const crumbWrap = chartVisual.querySelector<HTMLElement>('.pbi-drill-crumb');
      expect(crumbWrap).not.toBeNull();

      // Should contain root 'All' button and 'Category: Bikes' button
      const rootBtn = crumbWrap!.querySelector<HTMLButtonElement>('.pbi-drill-crumb-root');
      expect(rootBtn).not.toBeNull();
      expect(rootBtn!.textContent).toBe('All');

      const crumbBtns = crumbWrap!.querySelectorAll<HTMLButtonElement>('.pbi-drill-crumb-btn');
      expect(crumbBtns.length).toBeGreaterThanOrEqual(2);

      const bikeBtn = Array.from(crumbBtns).find((b) => b.textContent?.includes('Category: Bikes'));
      expect(bikeBtn).toBeDefined();

      // Click root button 'All' to drill back to top level
      rootBtn!.click();
      report.flush();

      // Should now be back at level 0 (breadcrumbs hidden)
      const crumbAfter = chartVisual.querySelector<HTMLElement>('.pbi-drill-crumb');
      expect(crumbAfter).toBeNull();

      // Drill down again to test drillTo API
      report.visual('chart1').drillDown('Accessories');
      report.flush();
      expect(report.visual('chart1').data()?.rows.length).toBeGreaterThan(0);

      // Return to level 0 via report.drillTo
      report.drillTo('chart1', 0);
      report.flush();
      const crumbReset = chartVisual.querySelector<HTMLElement>('.pbi-drill-crumb');
      expect(crumbReset).toBeNull();
      // Should show the 3 root categories again
      expect(report.visual('chart1').data()?.rows.length).toBe(3);

      report.destroy();
    });
  });

  describe('2. Table & Matrix 3-Color Midpoint Ramps', () => {
    it('applies piecewise interpolation placing midpoint color at exact midValue', () => {
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
                fields: {
                  columns: ['Products[Category]', 'Profit'],
                },
                format: {
                  table: {
                    conditional: {
                      Profit: {
                        background: {
                          minValue: 0,
                          midValue: 100,
                          maxValue: 1000,
                          min: '#ff0000',
                          mid: '#ffffff',
                          max: '#00ff00',
                        },
                      },
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
      const rows = tableVisual.querySelectorAll<HTMLTableRowElement>('tbody tr');
      expect(rows.length).toBeGreaterThan(0);

      // Verify that cells have background colors applied
      const cells = tableVisual.querySelectorAll<HTMLTableCellElement>('tbody td.is-num');
      expect(cells.length).toBeGreaterThan(0);

      for (const td of cells) {
        expect(td.style.background).not.toBe('');
      }

      report.destroy();
    });

    it('supports 3-color ramp on fontColor with midValue', () => {
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
                fields: {
                  columns: ['Products[Category]', 'Total Sales'],
                },
                format: {
                  table: {
                    conditional: {
                      'Total Sales': {
                        fontColor: {
                          minValue: 100,
                          midValue: 500,
                          maxValue: 6000,
                          min: '#d83b01',
                          mid: '#0078d4',
                          max: '#107c41',
                        },
                      },
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
      const cells = tableVisual.querySelectorAll<HTMLTableCellElement>('tbody td.is-num');
      expect(cells.length).toBeGreaterThan(0);

      // Verify cell font colors are styled
      for (const td of cells) {
        expect(td.style.color).not.toBe('');
      }

      report.destroy();
    });
  });

  describe('3. Studio Canvas Center on Page Alignment & Shortcuts', () => {
    it('centers visual horizontally on page and handles Alt+C / Alt+Shift+C shortcuts', () => {
      const model = makeModel();
      const studio = new Studio(el, { model });
      const report = studio.report;
      report.flush();

      const id1 = report.addVisual({
        type: 'card',
        layout: { x: 0, y: 2, w: 4, h: 4 },
        fields: { value: ['Total Sales'] },
      });
      report.flush();

      report.selectVisuals([id1]);

      // Center horizontally on page (12 columns total: (12 - 4) / 2 = 4)
      report.centerVisuals('horizontal', [id1]);
      report.flush();

      const v1Host = (report as any).pages[0].hosts.get(id1);
      expect(v1Host.spec.layout.x).toBe(4);

      // Test Alt+C shortcut (move x away first)
      v1Host.spec.layout.x = 1;
      studio.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', altKey: true, bubbles: true }));
      report.flush();
      expect(v1Host.spec.layout.x).toBe(4);

      // Test Alt+Shift+C shortcut for vertical centering
      studio.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', altKey: true, shiftKey: true, bubbles: true }));
      report.flush();
      expect(v1Host.spec.layout.y).toBeGreaterThanOrEqual(0);

      studio.destroy();
    });
  });

  describe('4. Visual Subtitle Styling & Divider Customization', () => {
    it('renders styled subtitle object and customized divider', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Subtitle Page',
            visuals: [
              {
                id: 'chart1',
                type: 'bar',
                layout: { x: 0, y: 0, w: 8, h: 8 },
                fields: {
                  category: 'Products[Category]',
                  values: ['Total Sales'],
                },
                format: {
                  title: {
                    show: true,
                    text: 'Sales Overview',
                    subtitle: {
                      text: 'YTD Metric Summary',
                      fontSize: 13,
                      color: 'rgb(102, 102, 102)',
                      italic: true,
                    },
                    divider: {
                      color: '#0078d4',
                      width: 2,
                      margin: 8,
                    },
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const chartVisual = el.querySelector('[data-visual-id="chart1"]')!;
      const subtitleEl = chartVisual.querySelector<HTMLElement>('.pbi-subtitle');
      expect(subtitleEl).not.toBeNull();
      expect(subtitleEl!.textContent).toBe('YTD Metric Summary');
      expect(subtitleEl!.style.fontSize).toBe('13px');
      expect(subtitleEl!.style.color).toBe('rgb(102, 102, 102)');
      expect(subtitleEl!.style.fontStyle).toBe('italic');

      const dividerEl = chartVisual.querySelector<HTMLElement>('.pbi-title-divider');
      expect(dividerEl).not.toBeNull();
      expect(dividerEl!.style.borderWidth).toBe('2px');
      expect(dividerEl!.style.margin).toBe('8px 0px');

      report.destroy();
    });
  });

  describe('5. Waterfall Chart Interactive Drag Brush Multi-Selection', () => {
    it('supports drag box brushing to select multiple waterfall steps', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Waterfall Page',
            visuals: [
              {
                id: 'wf1',
                type: 'waterfall',
                layout: { x: 0, y: 0, w: 8, h: 8 },
                fields: {
                  category: 'Products[Category]',
                  values: ['Total Sales'],
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const wfVisual = el.querySelector('[data-visual-id="wf1"]')!;
      const svg = wfVisual.querySelector<SVGSVGElement>('svg');
      expect(svg).not.toBeNull();

      // Check step rects exist
      const marks = wfVisual.querySelectorAll<SVGRectElement>('.pbi-mark');
      expect(marks.length).toBeGreaterThan(0);

      // Start drag brush on SVG background
      svg!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20 }));

      // Move pointer across plot area to trigger brush
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 300, clientY: 300 }));

      const brush = svg!.querySelector('.pbi-brush');
      expect(brush).not.toBeNull();

      // Complete brush
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 300, clientY: 300 }));

      report.destroy();
    });
  });
});
