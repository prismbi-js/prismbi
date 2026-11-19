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

describe('Phase 30 Features', () => {
  describe('1. Table & Matrix Alternating Row Backgrounds, Header Styling & Gridlines', () => {
    it('applies alternateRowColor, headerBackground, headerFontColor, and gridlines on table', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Table Formatting',
            visuals: [
              {
                id: 'tblFmt',
                type: 'table',
                layout: { x: 0, y: 0, w: 8, h: 6 },
                fields: {
                  columns: ['Products[Category]', 'Total Sales'],
                },
                format: {
                  table: {
                    alternateRowColor: 'rgb(243, 244, 246)',
                    headerBackground: 'rgb(30, 41, 59)',
                    headerFontColor: 'rgb(255, 255, 255)',
                    gridlines: {
                      vertical: true,
                      horizontal: true,
                      color: 'rgb(203, 213, 225)',
                      width: 2,
                    },
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const tableVis = el.querySelector('[data-visual-id="tblFmt"]')!;
      const thead = tableVis.querySelector('thead')!;
      const thList = thead.querySelectorAll('th');
      expect(thList.length).toBeGreaterThan(0);
      expect(thList[0].style.backgroundColor).toBe('rgb(30, 41, 59)');
      expect(thList[0].style.color).toBe('rgb(255, 255, 255)');
      expect(thList[0].style.borderRight).toContain('rgb(203, 213, 225)');

      const tbody = tableVis.querySelector('tbody')!;
      const rows = tbody.querySelectorAll<HTMLTableRowElement>('tr:not(.pbi-spacer)');
      expect(rows.length).toBeGreaterThan(1);
      // Row 0 is even, row 1 is odd
      expect(rows[1].style.backgroundColor).toBe('rgb(243, 244, 246)');

      // Cells have vertical and horizontal gridlines
      const td = rows[0].querySelector<HTMLTableCellElement>('td')!;
      expect(td.style.borderRight).toContain('rgb(203, 213, 225)');
      expect(td.style.borderBottom).toContain('rgb(203, 213, 225)');
    });

    it('applies alternateRowColor, headerBackground, and gridlines on matrix', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Matrix Formatting',
            visuals: [
              {
                id: 'mxFmt',
                type: 'matrix',
                layout: { x: 0, y: 0, w: 8, h: 6 },
                fields: {
                  rows: ['Products[Category]', 'Products[Name]'],
                  values: ['Total Sales'],
                },
                format: {
                  matrix: {
                    alternateRowColor: 'rgb(254, 242, 242)',
                    headerBackground: 'rgb(15, 23, 42)',
                    headerFontColor: 'rgb(248, 250, 252)',
                    gridlines: {
                      vertical: true,
                      color: 'rgb(226, 232, 240)',
                    },
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const matrixVis = el.querySelector('[data-visual-id="mxFmt"]')!;
      const thead = matrixVis.querySelector('thead')!;
      const thList = thead.querySelectorAll('th');
      expect(thList.length).toBeGreaterThan(0);
      expect(thList[0].style.backgroundColor).toBe('rgb(15, 23, 42)');
      expect(thList[0].style.color).toBe('rgb(248, 250, 252)');
      expect(thList[0].style.borderRight).toContain('rgb(226, 232, 240)');

      const tbody = matrixVis.querySelector('tbody')!;
      const rows = tbody.querySelectorAll<HTMLTableRowElement>('tr');
      expect(rows.length).toBeGreaterThan(1);
      expect(rows[1].style.backgroundColor).toBe('rgb(254, 242, 242)');
    });
  });

  describe('2. Pie & Donut Chart Label Content Styles & Cutout Thickness Customization', () => {
    it('renders category and percent label content and custom center title on donut chart', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Donut Page',
            visuals: [
              {
                id: 'donut1',
                type: 'donut',
                layout: { x: 0, y: 0, w: 10, h: 10 },
                fields: {
                  legend: 'Products[Category]',
                  values: 'Total Sales',
                },
                format: {
                  donut: {
                    labelContents: 'category, percent',
                    innerRadius: 0.6,
                    centerTitle: 'Global Sales',
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const donutVis = el.querySelector('[data-visual-id="donut1"]')!;
      const labels = donutVis.querySelectorAll('text.pbi-label');
      expect(labels.length).toBeGreaterThan(0);
      // Check that at least one label has Category name and percent
      const hasCatAndPct = Array.from(labels).some((lbl) => lbl.textContent?.includes('(') && lbl.textContent?.includes('%'));
      expect(hasCatAndPct).toBe(true);

      // Check custom center title
      const centerTitle = donutVis.querySelector('.pbi-tick');
      expect(centerTitle).not.toBeNull();
      expect(centerTitle!.textContent).toBe('Global Sales');
    });

    it('renders all label contents (category: value (percent)) on pie chart', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Pie Page',
            visuals: [
              {
                id: 'pie1',
                type: 'pie',
                layout: { x: 0, y: 0, w: 12, h: 12 },
                fields: {
                  legend: 'Products[Category]',
                  values: 'Total Sales',
                },
                format: {
                  pie: {
                    labelContents: 'all',
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const pieVis = el.querySelector('[data-visual-id="pie1"]')!;
      const labels = pieVis.querySelectorAll('text.pbi-label');
      expect(labels.length).toBeGreaterThan(0);
      const hasAll = Array.from(labels).some((lbl) => lbl.textContent?.includes(':') && lbl.textContent?.includes('%'));
      expect(hasAll).toBe(true);
    });
  });

  describe('3. Funnel Chart Conversion Rates & Multi-Color Steps', () => {
    it('calculates percentOfPrevious conversion rate and supports colorByStep', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Funnel Page',
            visuals: [
              {
                id: 'fnl1',
                type: 'funnel',
                layout: { x: 0, y: 0, w: 8, h: 6 },
                fields: {
                  category: 'Products[Category]',
                  values: 'Total Sales',
                },
                format: {
                  funnel: {
                    percentOfPrevious: true,
                    colorByStep: true,
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const funnelVis = el.querySelector('[data-visual-id="fnl1"]')!;
      const rects = funnelVis.querySelectorAll('rect:not([pointer-events=none])');
      expect(rects.length).toBeGreaterThan(0);

      // Multiple rects have different colors due to colorByStep
      const fills = Array.from(rects).map((r) => r.getAttribute('fill'));
      const uniqueFills = new Set(fills);
      expect(uniqueFills.size).toBeGreaterThan(1);

      // Stage 2+ labels contain 'prev'
      const labels = funnelVis.querySelectorAll('text.pbi-label');
      expect(labels.length).toBeGreaterThan(0);
      const hasPrev = Array.from(labels).some((lbl) => lbl.textContent?.includes('prev'));
      expect(hasPrev).toBe(true);
    });
  });

  describe('4. Cartesian Reference Lines Styling & Label Alignment', () => {
    it('applies dotted style, left label alignment, and custom labelColor to reference line', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Ref Line Page',
            visuals: [
              {
                id: 'col1',
                type: 'clusteredColumn',
                layout: { x: 0, y: 0, w: 8, h: 6 },
                fields: {
                  category: 'Products[Category]',
                  values: ['Total Sales'],
                },
                format: {
                  analytics: {
                    referenceLines: [
                      {
                        type: 'constant',
                        value: 500,
                        label: 'Target: {value}',
                        style: 'dotted',
                        labelPosition: 'left',
                        labelColor: 'rgb(220, 38, 38)',
                      },
                    ],
                    trendLine: false,
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const colVis = el.querySelector('[data-visual-id="col1"]')!;
      const refLine = colVis.querySelector('line.pbi-refline');
      expect(refLine).not.toBeNull();
      expect(refLine!.getAttribute('stroke-dasharray')).toBe('2 2');

      const refLabel = colVis.querySelector('text.pbi-refline-label');
      expect(refLabel).not.toBeNull();
      expect(refLabel!.getAttribute('text-anchor')).toBe('start');
      expect(refLabel!.getAttribute('fill')).toBe('rgb(220, 38, 38)');
      expect(refLabel!.textContent).toContain('Target:');
    });
  });

  describe('5. KPI Visual Custom Goal Label & Value Status Coloring', () => {
    it('customizes goal label, applies statusColor, and styles trend sparkline', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'KPI Page',
            visuals: [
              {
                id: 'kpi1',
                type: 'kpi',
                layout: { x: 0, y: 0, w: 6, h: 5 },
                fields: {
                  value: 'Total Sales',
                  target: 'Total Cost',
                  trend: 'Date[Date]',
                },
                format: {
                  kpi: {
                    goalLabel: 'vs budget',
                    statusColor: true,
                    sparklineColor: 'rgb(16, 185, 129)',
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const kpiVis = el.querySelector('[data-visual-id="kpi1"]')!;
      const deltaEl = kpiVis.querySelector('.pbi-card-delta');
      expect(deltaEl).not.toBeNull();
      expect(deltaEl!.textContent).toContain('vs budget');

      // Value colored by status
      const valEl = kpiVis.querySelector<HTMLElement>('.pbi-card-value');
      expect(valEl).not.toBeNull();
      expect(valEl!.style.color).toBeTruthy();

      // Sparkline stroke colored with sparklineColor
      const sparkSvg = kpiVis.querySelector('svg.pbi-spark');
      expect(sparkSvg).not.toBeNull();
      const path = sparkSvg!.querySelectorAll('path')[1];
      expect(path).not.toBeNull();
      expect(path.getAttribute('stroke')).toBe('rgb(16, 185, 129)');
    });
  });
});
