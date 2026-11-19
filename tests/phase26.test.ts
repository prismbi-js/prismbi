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

describe('Phase 26 Features', () => {
  describe('1. Table & Matrix Cell Icon Indicators & KPI Rules', () => {
    it('renders arrow icon presets and respects right alignment', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Icons Table',
            visuals: [
              {
                id: 'table1',
                type: 'table',
                layout: { x: 0, y: 0, w: 10, h: 8 },
                fields: { columns: ['Products[Category]', 'Profit'] },
                format: {
                  table: {
                    conditional: {
                      Profit: {
                        icons: {
                          set: 'arrows',
                          align: 'right',
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
      const icons = tableVisual.querySelectorAll<HTMLElement>('.pbi-cf-icon');
      expect(icons.length).toBeGreaterThan(0);

      // Verify alignment right produces .pbi-cf-spacer
      const spacers = tableVisual.querySelectorAll<HTMLElement>('.pbi-cf-spacer');
      expect(spacers.length).toBeGreaterThan(0);

      // Verify arrow icon characters
      const iconTexts = Array.from(icons).map((i) => i.textContent?.trim());
      expect(iconTexts.some((t) => t === '▲' || t === '▼' || t === '▶')).toBe(true);

      report.destroy();
    });

    it('renders iconOnly mode and replaces cell text with icon', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Icon Only Table',
            visuals: [
              {
                id: 'table1',
                type: 'table',
                layout: { x: 0, y: 0, w: 10, h: 8 },
                fields: { columns: ['Products[Category]', 'Profit'] },
                format: {
                  table: {
                    conditional: {
                      Profit: {
                        icons: {
                          set: 'traffic-lights',
                          align: 'iconOnly',
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

      const firstCell = cells[0];
      const icon = firstCell.querySelector<HTMLElement>('.pbi-cf-icon');
      expect(icon).not.toBeNull();
      // Cell span should only contain the icon in iconOnly mode
      const span = firstCell.querySelector('span');
      expect(span?.children.length).toBe(1);
      expect(span?.children[0]).toBe(icon);

      report.destroy();
    });

    it('applies custom KPI rules with specific icons and colors', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Custom KPI Table',
            visuals: [
              {
                id: 'table1',
                type: 'table',
                layout: { x: 0, y: 0, w: 10, h: 8 },
                fields: { columns: ['Products[Category]', 'Total Sales'] },
                format: {
                  table: {
                    conditional: {
                      'Total Sales': {
                        icons: {
                          rules: [
                            { op: '>=', value: 1000, icon: '🌟', color: '#107c41' },
                            { op: '<', value: 1000, icon: '⚠️', color: '#d83b01' },
                          ],
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
      const icons = tableVisual.querySelectorAll<HTMLElement>('.pbi-cf-icon');
      expect(icons.length).toBeGreaterThan(0);

      const iconTexts = Array.from(icons).map((i) => i.textContent?.trim());
      expect(iconTexts.some((t) => t === '🌟')).toBe(true);
      expect(iconTexts.some((t) => t === '⚠️')).toBe(true);

      const highIcon = Array.from(icons).find((i) => i.textContent?.includes('🌟'));
      expect(highIcon?.style.color).toBe('rgb(16, 124, 65)');

      report.destroy();
    });
  });

  describe('2. Hierarchy Tree Slicer Live Subtree Search & Action Controls', () => {
    it('renders search input and action controls, highlights matches and handles expand/collapse all', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Slicer Page',
            visuals: [
              {
                id: 'slicer1',
                type: 'slicer',
                layout: { x: 0, y: 0, w: 6, h: 10 },
                fields: {
                  field: ['Products[Category]', 'Products[Name]'],
                },
                format: {
                  slicer: {
                    search: true,
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const slicerVisual = el.querySelector('[data-visual-id="slicer1"]')!;
      const searchInput = slicerVisual.querySelector<HTMLInputElement>('input.pbi-slicer-search');
      expect(searchInput).not.toBeNull();

      const expandAllBtn = slicerVisual.querySelector<HTMLButtonElement>('.pbi-slicer-action[title="Expand all"]');
      const collapseAllBtn = slicerVisual.querySelector<HTMLButtonElement>('.pbi-slicer-action[title="Collapse all"]');
      expect(expandAllBtn).not.toBeNull();
      expect(collapseAllBtn).not.toBeNull();

      // Click Expand all
      expandAllBtn!.click();
      report.flush();

      // Check child nodes are expanded
      const allLabels = slicerVisual.querySelectorAll<HTMLElement>('.pbi-slicer-item label');
      const texts = Array.from(allLabels).map((l) => l.textContent?.trim());
      expect(texts.some((t) => t === 'Road Bike')).toBe(true);

      // Perform live search for 'Road'
      searchInput!.value = 'Road';
      searchInput!.dispatchEvent(new Event('input', { bubbles: true }));
      report.flush();

      // Check highlighted mark
      const marks = slicerVisual.querySelectorAll<HTMLElement>('mark.pbi-highlight');
      expect(marks.length).toBeGreaterThan(0);
      expect(marks[0].textContent).toBe('Road');

      // Clear search query
      searchInput!.value = '';
      searchInput!.dispatchEvent(new Event('input', { bubbles: true }));
      report.flush();

      // Click Collapse all
      collapseAllBtn!.click();
      report.flush();

      // Only top-level category rows should be visible (3 root categories: Accessories, Bikes, Clothing)
      const collapsedItems = slicerVisual.querySelectorAll<HTMLElement>('.pbi-slicer-item');
      expect(collapsedItems.length).toBe(3);

      report.destroy();
    });
  });

  describe('3. Analytics Reference Line Shading & Range Band Hover Tooltips', () => {
    it('renders reference line shading rectangle', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Line Chart Page',
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
                  analytics: {
                    referenceLines: [
                      {
                        type: 'constant',
                        value: 1000,
                        shade: 'below',
                        shadeColor: 'rgba(255, 0, 0, 0.25)',
                        label: 'Min Target',
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

      const chartVisual = el.querySelector('[data-visual-id="chart1"]')!;
      const shadeRect = chartVisual.querySelector<SVGRectElement>('.pbi-refline-shade');
      expect(shadeRect).not.toBeNull();
      expect(shadeRect!.getAttribute('fill')).toBe('rgba(255, 0, 0, 0.25)');

      report.destroy();
    });

    it('renders reference band hit area and shows distribution tooltip on hover', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Band Chart Page',
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
                  analytics: {
                    referenceBands: [
                      {
                        from: 200,
                        to: 5000,
                        label: 'Optimal Zone',
                        color: 'rgba(0, 128, 0, 0.2)',
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

      const chartVisual = el.querySelector('[data-visual-id="chart1"]')!;
      const bandHit = chartVisual.querySelector<SVGRectElement>('.pbi-refband-hit');
      expect(bandHit).not.toBeNull();

      // Hover over reference band hit area
      let shownTooltip: any = null;
      const origShow = (report as any).tooltip.show;
      (report as any).tooltip.show = (_e: any, items: any, title: any) => {
        shownTooltip = { items, title };
      };

      try {
        bandHit!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 100 }));
        expect(shownTooltip).not.toBeNull();
        expect(shownTooltip.title).toBe('Optimal Zone');
        expect(shownTooltip.items.some((it: any) => it.label.toLowerCase().includes('in range'))).toBe(true);
      } finally {
        (report as any).tooltip.show = origShow;
        report.destroy();
      }
    });
  });

  describe('4. Studio Canvas Multi-Visual Proportional Resize', () => {
    it('resizes multiple selected visuals proportionally relative to selection bounding box', () => {
      const model = makeModel();
      const studio = new Studio(el, { model });
      const report = studio.report;
      report.flush();

      const id1 = report.addVisual({
        type: 'card',
        layout: { x: 2, y: 2, w: 4, h: 4 },
        fields: { value: ['Total Sales'] },
      });
      const id2 = report.addVisual({
        type: 'card',
        layout: { x: 6, y: 2, w: 4, h: 4 },
        fields: { value: ['Total Cost'] },
      });
      report.flush();

      // Multi-select both visuals
      report.selectVisuals([id1, id2]);

      const v1Host = (report as any).pages[0].hosts.get(id1);
      const v2Host = (report as any).pages[0].hosts.get(id2);
      const v1El = v1Host.el;
      const overlay = v1El.querySelector('.pbi-edit')!;

      const seHandle = v1El.querySelector('.pbi-handle-se') as HTMLElement | null;
      expect(seHandle).not.toBeNull();

      // Start drag resize from handle
      seHandle!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 200, clientY: 200 }));

      // Move pointer to expand width and height
      overlay.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 360, clientY: 296 }));

      // Release pointer
      overlay.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));

      // Both visuals should have increased in size proportionally
      expect(v1Host.spec.layout.w).toBeGreaterThan(4);
      expect(v2Host.spec.layout.w).toBeGreaterThan(4);

      studio.destroy();
    });
  });

  describe('5. Formatted vs Raw Data Export', () => {
    it('exports formatted values using measure and field format strings in CSV, TSV, and JSON', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Export Page',
            visuals: [
              {
                id: 'table1',
                type: 'table',
                layout: { x: 0, y: 0, w: 10, h: 8 },
                fields: {
                  columns: ['Products[Category]', 'Total Sales', 'Margin %'],
                },
              },
            ],
          },
        ],
      });
      report.flush();

      // 1. Raw CSV export
      const rawCsv = report.getVisualData('table1', 'csv', { formatted: false });
      expect(rawCsv).toContain('Category,Total Sales,Margin %');
      const rawBody = rawCsv.split('\n').slice(1).join('\n');
      // Raw data rows should contain raw numbers without $ or %
      expect(rawBody).not.toContain('$');
      expect(rawBody).not.toContain('%');

      // 2. Formatted CSV export
      const formattedCsv = report.getVisualData('table1', 'csv', { formatted: true });
      expect(formattedCsv).toContain('Category,Total Sales,Margin %');
      const formattedBody = formattedCsv.split('\n').slice(1).join('\n');
      // Formatted data rows should contain formatted currency ($) and percentage (%)
      expect(formattedBody).toContain('$');
      expect(formattedBody).toContain('%');

      // 3. Formatted TSV export
      const formattedTsv = report.getVisualData('table1', 'tsv', { formatted: true });
      expect(formattedTsv).toContain("Category\tTotal Sales\tMargin %");
      const formattedTsvBody = formattedTsv.split('\n').slice(1).join('\n');
      expect(formattedTsvBody).toContain('$');
      expect(formattedTsvBody).toContain('%');

      // 4. Formatted JSON export
      const formattedJson = report.getVisualData('table1', 'json', { formatted: true });
      const parsedJson = JSON.parse(formattedJson);
      expect(Array.isArray(parsedJson)).toBe(true);
      expect(parsedJson.length).toBeGreaterThan(0);
      const firstRow = parsedJson[0];
      expect(typeof firstRow['Total Sales']).toBe('string');
      expect(firstRow['Total Sales']).toContain('$');
      expect(typeof firstRow['Margin %']).toBe('string');
      expect(firstRow['Margin %']).toContain('%');

      report.destroy();
    });

    it('exportVisualData accepts formatted option', async () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Export Page',
            visuals: [
              {
                id: 'table1',
                type: 'table',
                layout: { x: 0, y: 0, w: 10, h: 8 },
                fields: {
                  columns: ['Products[Category]', 'Total Sales'],
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const blob = await report.exportVisualData('table1', 'csv', 'test.csv', { formatted: true });
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toContain('text/csv');
      expect(blob.size).toBeGreaterThan(0);

      report.destroy();
    });
  });
});
