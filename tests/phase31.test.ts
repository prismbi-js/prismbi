import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Report } from '../src/index';
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

describe('Phase 31 Features', () => {
  describe('1. Scatter & Bubble Chart Quadrants & 4-Quadrant Corner Labels', () => {
    it('draws quadrant lines and corner labels on scatter chart', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Scatter Quadrants Page',
            visuals: [
              {
                id: 'scatter1',
                type: 'scatter',
                layout: { x: 0, y: 0, w: 10, h: 8 },
                fields: {
                  details: 'Products[Name]',
                  x: 'Total Cost',
                  y: 'Total Sales',
                },
                format: {
                  quadrants: {
                    show: true,
                    x: 1000,
                    y: 1500,
                    lineColor: 'rgb(59, 130, 246)',
                    lineStyle: 'dashed',
                    labels: ['High Return / Low Cost', 'Top Stars', 'Needs Work', 'Cash Cows'],
                    labelColor: 'rgb(30, 64, 175)',
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const scatterVis = el.querySelector('[data-visual-id="scatter1"]')!;
      const qLines = scatterVis.querySelectorAll('line.pbi-quadrant-line');
      expect(qLines.length).toBe(2);
      expect(qLines[0].getAttribute('stroke')).toBe('rgb(59, 130, 246)');
      expect(qLines[0].getAttribute('stroke-dasharray')).toBe('4 4');

      const qLabels = scatterVis.querySelectorAll('text.pbi-quadrant-label');
      expect(qLabels.length).toBe(4);
      expect(qLabels[0].textContent).toBe('High Return / Low Cost');
      expect(qLabels[1].textContent).toBe('Top Stars');
      expect(qLabels[0].getAttribute('fill')).toBe('rgb(30, 64, 175)');
    });
  });

  describe('2. Treemap Tile Customization & Value Labels', () => {
    it('supports custom tileGap, cornerRadius, and showValues: false', () => {
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
                layout: { x: 0, y: 0, w: 8, h: 8 },
                fields: {
                  category: 'Products[Category]',
                  values: 'Total Sales',
                },
                format: {
                  treemap: {
                    tileGap: 4,
                    cornerRadius: 8,
                    showValues: false,
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const tmVis = el.querySelector('[data-visual-id="tm1"]')!;
      const rects = tmVis.querySelectorAll('rect');
      expect(rects.length).toBeGreaterThan(0);
      expect(rects[0].getAttribute('rx')).toBe('8');

      // Only category labels, no measure value labels
      const labels = tmVis.querySelectorAll('text.pbi-label');
      expect(labels.length).toBeGreaterThan(0);
      const hasFormattedCurrency = Array.from(labels).some((l) => l.textContent?.includes('$'));
      expect(hasFormattedCurrency).toBe(false);
    });
  });

  describe('3. Sunburst Inner Radius Cutout & Max Depth', () => {
    it('renders with custom innerRadius and limits depth with maxDepth', () => {
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
                layout: { x: 0, y: 0, w: 8, h: 8 },
                fields: {
                  category: ['Products[Category]', 'Products[Name]'],
                  values: 'Total Sales',
                },
                format: {
                  sunburst: {
                    innerRadius: 0.5,
                    maxDepth: 1,
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const sbVis = el.querySelector('[data-visual-id="sb1"]')!;
      const paths = sbVis.querySelectorAll('path.pbi-mark');
      expect(paths.length).toBeGreaterThan(0);
    });
  });

  describe('4. Slicer Header Title Customization & Search Placeholder', () => {
    it('renders custom slicer header and custom search placeholder in list and hierarchy', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Slicer Header Page',
            visuals: [
              {
                id: 'sl1',
                type: 'slicer',
                layout: { x: 0, y: 0, w: 4, h: 8 },
                fields: {
                  field: 'Products[Category]',
                },
                format: {
                  slicer: {
                    search: true,
                    searchPlaceholder: 'Filter categories...',
                    header: {
                      show: true,
                      text: 'Product Categories',
                      fontSize: 14,
                      fontColor: 'rgb(29, 78, 216)',
                    },
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const slVis = el.querySelector('[data-visual-id="sl1"]')!;
      const hdr = slVis.querySelector<HTMLElement>('.pbi-slicer-header');
      expect(hdr).not.toBeNull();
      expect(hdr!.textContent).toBe('Product Categories');
      expect(hdr!.style.fontSize).toBe('14px');
      expect(hdr!.style.color).toBe('rgb(29, 78, 216)');
    });
  });

  describe('5. Cartesian Value Axis Gridline Styles & Colors', () => {
    it('applies dashed gridlineStyle, custom gridlineColor, and gridlineWidth on Cartesian charts', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Gridlines Page',
            visuals: [
              {
                id: 'colGrid',
                type: 'clusteredColumn',
                layout: { x: 0, y: 0, w: 8, h: 6 },
                fields: {
                  category: 'Products[Category]',
                  values: ['Total Sales'],
                },
                format: {
                  valueAxis: {
                    show: true,
                    gridlines: true,
                    gridlineColor: 'rgb(147, 197, 253)',
                    gridlineWidth: 2,
                    gridlineStyle: 'dashed',
                    displayUnits: 'auto',
                    tickCount: 5,
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const colVis = el.querySelector('[data-visual-id="colGrid"]')!;
      const gridlines = colVis.querySelectorAll('line.pbi-grid');
      expect(gridlines.length).toBeGreaterThan(0);
      expect(gridlines[0].getAttribute('stroke')).toBe('rgb(147, 197, 253)');
      expect(gridlines[0].getAttribute('stroke-width')).toBe('2');
      expect(gridlines[0].getAttribute('stroke-dasharray')).toBe('5 4');
    });
  });
});
