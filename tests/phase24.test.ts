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

describe('Phase 24 Features', () => {
  describe('Interactive Table & Matrix Column Width Drag-Resizing', () => {
    it('renders column resizers and persists resized widths in state on drag', () => {
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
                      'Products[Category]': 160,
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
      expect(headers.length).toBe(2);

      const catHeader = headers[0];
      expect(catHeader.style.width).toBe('160px');

      const resizer = catHeader.querySelector<HTMLElement>('.pbi-col-resizer');
      expect(resizer).not.toBeNull();

      let resizeEventData: { visualId: string; column: string; width: number; widths: Record<string, number> } | null = null;
      report.on('columnResize', (data) => {
        resizeEventData = data as any;
      });

      // Simulate pointerdown on resizer
      resizer!.dispatchEvent(new PointerEvent('pointerdown', { clientX: 200, bubbles: true }));

      // Simulate pointermove on window (+50px)
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 250 }));
      expect(catHeader.style.width).toBe('210px');

      // Simulate pointerup on window
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 250 }));

      // Check event emitted
      expect(resizeEventData).not.toBeNull();
      expect(resizeEventData!.column).toBe('Products[Category]');
      expect(resizeEventData!.width).toBe(210);
      expect(resizeEventData!.widths['Products[Category]']).toBe(210);

      // Verify host state persistence
      const host = (report as any).pages[0].hosts.get('table1');
      expect(host.state.columnWidths['Products[Category]']).toBe(210);

      report.destroy();
    });

    it('supports column resizing in matrix visual headers', () => {
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
                format: {
                  matrix: {
                    columnWidths: {
                      'Products[Category]': 180,
                      'Total Sales': 140,
                    },
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const matrixVisual = el.querySelector('[data-visual-id="mat1"]')!;
      const headers = matrixVisual.querySelectorAll<HTMLTableCellElement>('thead th');
      expect(headers.length).toBeGreaterThanOrEqual(2);

      const rowHeader = headers[0];
      expect(rowHeader.style.width).toBe('180px');
      const resizer = rowHeader.querySelector('.pbi-col-resizer');
      expect(resizer).not.toBeNull();

      let resizeFired = false;
      report.on('columnResize', () => {
        resizeFired = true;
      });

      resizer!.dispatchEvent(new PointerEvent('pointerdown', { clientX: 180, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 220 }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 220 }));

      expect(resizeFired).toBe(true);
      report.destroy();
    });
  });

  describe('Radial Gauge Multi-Tier Threshold Zones & Needle', () => {
    it('renders segmented multi-tier colored tracks and needle polygon', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Gauge Page',
            visuals: [
              {
                id: 'gauge1',
                type: 'gauge',
                layout: { x: 0, y: 0, w: 6, h: 6 },
                fields: {
                  value: 'Total Sales',
                },
                format: {
                  gauge: {
                    thresholds: [
                      { value: 1000, color: '#e74c3c' },
                      { value: 3000, color: '#f39c12' },
                      { value: 5000, color: '#2ecc71' },
                    ],
                    needle: true,
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const gaugeEl = el.querySelector('[data-visual-id="gauge1"]')!;
      const svg = gaugeEl.querySelector('svg.pbi-svg')!;
      expect(svg).not.toBeNull();

      // Should have 3 threshold zones
      const zones = svg.querySelectorAll('.pbi-gauge-zone');
      expect(zones.length).toBe(3);
      expect(zones[0].getAttribute('fill')).toBe('#e74c3c');
      expect(zones[1].getAttribute('fill')).toBe('#f39c12');
      expect(zones[2].getAttribute('fill')).toBe('#2ecc71');

      // Needle and cap circle should be rendered
      const needle = svg.querySelector('.pbi-gauge-needle');
      expect(needle).not.toBeNull();
      expect(needle?.tagName.toLowerCase()).toBe('polygon');

      const needleCap = svg.querySelector('.pbi-gauge-needle-cap');
      expect(needleCap).not.toBeNull();
      expect(needleCap?.tagName.toLowerCase()).toBe('circle');

      report.destroy();
    });

    it('gracefully renders default arc and track when gauge thresholds and needle are omitted', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Gauge Page',
            visuals: [
              {
                id: 'gauge-default',
                type: 'gauge',
                layout: { x: 0, y: 0, w: 6, h: 6 },
                fields: {
                  value: 'Total Sales',
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const gaugeEl = el.querySelector('[data-visual-id="gauge-default"]')!;
      const zones = gaugeEl.querySelectorAll('.pbi-gauge-zone');
      expect(zones.length).toBe(0);

      const needle = gaugeEl.querySelector('.pbi-gauge-needle');
      expect(needle).toBeNull();

      // Standard progress arc is present
      const paths = gaugeEl.querySelectorAll('path');
      expect(paths.length).toBe(2); // background track + value arc

      report.destroy();
    });
  });

  describe('Visual Header Active Selection Clear & Applied Filter Badge', () => {
    it('surfaces 1-click Clear Selection button when visual has active cross-filtering', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Interaction Page',
            visuals: [
              {
                id: 'bar1',
                type: 'bar',
                layout: { x: 0, y: 0, w: 6, h: 6 },
                fields: { category: 'Products[Category]', values: 'Total Sales' },
              },
              {
                id: 'card1',
                type: 'card',
                layout: { x: 6, y: 0, w: 4, h: 4 },
                fields: { value: 'Total Sales' },
              },
            ],
          },
        ],
      });
      report.flush();

      const barVisual = el.querySelector('[data-visual-id="bar1"]')!;
      let clearBtn = barVisual.querySelector('.pbi-header-clear-selection');
      expect(clearBtn).toBeNull();

      // Trigger selection on bar1
      const host1 = (report as any).pages[0].hosts.get('bar1');
      host1.select({
        columns: [{ table: 'Products', column: 'Category' }],
        values: ['Beverages'],
      });
      report.flush();

      // Now clear button should be present in bar1 header
      clearBtn = barVisual.querySelector('.pbi-header-clear-selection');
      expect(clearBtn).not.toBeNull();
      expect(clearBtn?.textContent).toBe('⌧');

      // Clicking clear button should clear selection
      (clearBtn as HTMLButtonElement).click();
      report.flush();

      expect(report.currentSelection).toBeNull();
      expect(barVisual.querySelector('.pbi-header-clear-selection')).toBeNull();

      report.destroy();
    });

    it('displays applied filter badge and accessible filter details popover', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Filtered Page',
            filters: [
              { target: 'Products[Category]', op: 'in', values: ['Beverages', 'Produce'] },
            ],
            visuals: [
              {
                id: 'table1',
                type: 'table',
                layout: { x: 0, y: 0, w: 8, h: 8 },
                fields: { columns: ['Products[Category]', 'Total Sales'] },
              },
            ],
          },
        ],
      });
      report.flush();

      const tableVisual = el.querySelector('[data-visual-id="table1"]')!;
      const filterBtn = tableVisual.querySelector<HTMLButtonElement>('.pbi-header-filter');
      expect(filterBtn).not.toBeNull();
      expect(filterBtn?.textContent).toBe('⏚');
      expect(filterBtn?.title).toContain('Applied filters');

      // Click filter badge to open popover
      filterBtn!.click();

      const popover = tableVisual.querySelector('.pbi-filter-popover');
      expect(popover).not.toBeNull();
      expect(popover?.textContent).toContain('Beverages');
      expect(popover?.textContent).toContain('Filters applied');

      // Clicking again toggles/closes popover
      filterBtn!.click();
      expect(tableVisual.querySelector('.pbi-filter-popover')).toBeNull();

      report.destroy();
    });
  });

  describe('Studio Canvas Device Viewport Emulation Presets', () => {
    it('applies device viewport frames and orientation rotations', () => {
      const model = makeModel();
      const studio = new Studio(el, { model });
      studio.report.flush();

      expect(studio.devicePreset).toBe('auto');

      let deviceEvents: { preset: string; orientation: string }[] = [];
      studio.on('deviceChange', (data) => {
        deviceEvents.push(data as any);
      });

      // Emulate Desktop
      studio.setDevicePreset('desktop');
      expect(studio.devicePreset).toBe('desktop');
      expect(studio.deviceOrientation).toBe('landscape');
      const canvas = (studio as any).els.canvas as HTMLElement;
      expect(canvas.classList.contains('pbs-device-frame')).toBe(true);
      expect(canvas.style.width).toBe('1280px');
      expect(canvas.style.height).toBe('720px');

      // Emulate Tablet (default portrait 768x1024)
      studio.setDevicePreset('tablet');
      expect(studio.devicePreset).toBe('tablet');
      expect(studio.deviceOrientation).toBe('portrait');
      expect(canvas.style.width).toBe('768px');
      expect(canvas.style.height).toBe('1024px');

      // Toggle Tablet Orientation to landscape
      studio.toggleDeviceOrientation();
      expect(studio.deviceOrientation).toBe('landscape');
      expect(canvas.style.width).toBe('1024px');
      expect(canvas.style.height).toBe('768px');

      // Emulate Mobile (375x667)
      studio.setDevicePreset('mobile');
      expect(studio.devicePreset).toBe('mobile');
      expect(studio.deviceOrientation).toBe('portrait');
      expect(canvas.style.width).toBe('375px');
      expect(canvas.style.height).toBe('667px');

      // Revert to Auto / Responsive
      studio.setDevicePreset('auto');
      expect(studio.devicePreset).toBe('auto');
      expect(canvas.classList.contains('pbs-device-frame')).toBe(false);
      expect(canvas.style.width).toBe('');
      expect(canvas.style.height).toBe('');

      expect(deviceEvents.length).toBe(5);

      studio.destroy();
    });
  });
});
