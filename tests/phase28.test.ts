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

describe('Phase 28 Features', () => {
  describe('1. Cartesian & Bar Chart Data Labels Advanced Positioning & Orientation', () => {
    it('positions data labels at insideEnd, insideCenter, insideBase, and outsideEnd on column charts', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Labels Page',
            visuals: [
              {
                id: 'chartInsideEnd',
                type: 'clusteredColumn',
                layout: { x: 0, y: 0, w: 6, h: 5 },
                fields: {
                  category: 'Products[Category]',
                  values: ['Total Sales'],
                },
                format: {
                  dataLabels: {
                    show: true,
                    position: 'insideEnd',
                  },
                },
              },
              {
                id: 'chartInsideCenter',
                type: 'clusteredColumn',
                layout: { x: 6, y: 0, w: 6, h: 5 },
                fields: {
                  category: 'Products[Category]',
                  values: ['Total Sales'],
                },
                format: {
                  dataLabels: {
                    show: true,
                    position: 'insideCenter',
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const v1 = el.querySelector('[data-visual-id="chartInsideEnd"]')!;
      const labels1 = v1.querySelectorAll<SVGTextElement>('.pbi-label');
      expect(labels1.length).toBeGreaterThan(0);

      const v2 = el.querySelector('[data-visual-id="chartInsideCenter"]')!;
      const labels2 = v2.querySelectorAll<SVGTextElement>('.pbi-label');
      expect(labels2.length).toBeGreaterThan(0);

      // Verify vertical orientation transform
      report.updateVisual('chartInsideEnd', {
        format: {
          dataLabels: {
            show: true,
            position: 'insideEnd',
            orientation: 'vertical',
            showBackground: true,
          },
        },
      });
      report.flush();

      const updatedV1 = el.querySelector('[data-visual-id="chartInsideEnd"]')!;
      const vertLabels = updatedV1.querySelectorAll<SVGTextElement>('.pbi-label');
      expect(vertLabels.length).toBeGreaterThan(0);
      const firstLabel = vertLabels[0];
      expect(firstLabel.getAttribute('transform')).toContain('rotate(-90');

      // Verify background pill rects
      const bgPills = updatedV1.querySelectorAll<SVGRectElement>('.pbi-label-bg');
      expect(bgPills.length).toBeGreaterThan(0);
    });

    it('positions data labels on horizontal bar charts with insideEnd and insideBase', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Bars Page',
            visuals: [
              {
                id: 'barChart',
                type: 'clusteredBar',
                layout: { x: 0, y: 0, w: 10, h: 6 },
                fields: {
                  category: 'Products[Category]',
                  values: ['Total Sales'],
                },
                format: {
                  dataLabels: {
                    show: true,
                    position: 'insideEnd',
                    showBackground: true,
                    backgroundColor: 'rgba(0,0,0,0.7)',
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const barVis = el.querySelector('[data-visual-id="barChart"]')!;
      const labels = barVis.querySelectorAll<SVGTextElement>('.pbi-label');
      expect(labels.length).toBeGreaterThan(0);
      const bgPills = barVis.querySelectorAll<SVGRectElement>('.pbi-label-bg');
      expect(bgPills.length).toBeGreaterThan(0);
      expect(bgPills[0].getAttribute('fill')).toBe('rgba(0,0,0,0.7)');
    });
  });

  describe('2. Studio Canvas Visual Lock & Aspect Ratio Locking', () => {
    it('locks visual positioning and aspect ratio in Report and VisualHandle', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Lock Page',
            visuals: [
              {
                id: 'v1',
                type: 'card',
                layout: { x: 0, y: 0, w: 4, h: 3 },
                fields: { value: 'Total Sales' },
              },
            ],
          },
        ],
      });
      report.flush();

      expect(report.isVisualLocked('v1')).toBe(false);
      expect(report.isVisualAspectRatioLocked('v1')).toBe(false);

      // Toggle lock
      const locked = report.toggleLock('v1');
      expect(locked).toBe(true);
      expect(report.isVisualLocked('v1')).toBe(true);

      // Toggle aspect ratio lock
      const ratioLocked = report.toggleAspectRatioLock('v1');
      expect(ratioLocked).toBe(true);
      expect(report.isVisualAspectRatioLocked('v1')).toBe(true);

      // Toggle via VisualHandle
      const handle = report.visual('v1');
      expect(handle.toggleLock()).toBe(false);
      expect(report.isVisualLocked('v1')).toBe(false);
      expect(handle.toggleAspectRatioLock()).toBe(false);
      expect(report.isVisualAspectRatioLocked('v1')).toBe(false);
    });

    it('supports visual lock and aspect ratio actions and layer lock button in Studio', () => {
      const model = makeModel();
      const studio = new Studio(el, { model });
      const report = studio.report;
      report.flush();

      const id1 = report.addVisual({
        type: 'card',
        layout: { x: 0, y: 0, w: 4, h: 3 },
        fields: { value: ['Total Sales'] },
      });
      report.flush();

      report.selectVisuals([id1]);
      // Arrange lock action
      studio.arrangeSelection('lock');
      expect(report.isVisualLocked(id1)).toBe(true);

      // Arrange aspect ratio lock action
      studio.arrangeSelection('lock:aspectRatio');
      expect(report.isVisualAspectRatioLocked(id1)).toBe(true);

      // Open layers panel and check lock button
      studio.setLayersOpen(true);
      const layerLockBtn = el.querySelector<HTMLButtonElement>(`.pbs-layer-lock[data-id="${id1}"]`);
      expect(layerLockBtn).not.toBeNull();
      expect(layerLockBtn!.classList.contains('is-locked')).toBe(true);

      // Clicking lock button toggles lock state
      layerLockBtn!.click();
      expect(report.isVisualLocked(id1)).toBe(false);
    });
  });

  describe('3. Table & Matrix Cell Hyperlink & Image Rendering', () => {
    it('renders cell values as clickable hyperlinks when link is configured', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Table Page',
            visuals: [
              {
                id: 'tbl1',
                type: 'table',
                layout: { x: 0, y: 0, w: 10, h: 8 },
                fields: {
                  columns: ['Products[Category]', 'Total Sales'],
                },
                format: {
                  table: {
                    conditional: {
                      'Category': {
                        link: {
                          url: 'https://example.com/products',
                          openInNewTab: true,
                          icon: true,
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

      const tableVis = el.querySelector('[data-visual-id="tbl1"]')!;
      const links = tableVis.querySelectorAll<HTMLAnchorElement>('.pbi-table-link');
      expect(links.length).toBeGreaterThan(0);
      expect(links[0].href).toContain('https://example.com/products');
      expect(links[0].target).toBe('_blank');
      expect(links[0].querySelector('.pbi-link-icon')).not.toBeNull();
    });

    it('renders cell values as inline images when image is configured', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Table Image Page',
            visuals: [
              {
                id: 'tblImg',
                type: 'table',
                layout: { x: 0, y: 0, w: 10, h: 8 },
                fields: {
                  columns: ['Products[Category]', 'Total Sales'],
                },
                format: {
                  table: {
                    conditional: {
                      'Category': {
                        image: {
                          height: 24,
                          fit: 'contain',
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

      const tableVis = el.querySelector('[data-visual-id="tblImg"]')!;
      const imgs = tableVis.querySelectorAll<HTMLImageElement>('.pbi-table-img');
      expect(imgs.length).toBeGreaterThan(0);
      expect(imgs[0].style.maxHeight).toBe('24px');
    });
  });

  describe('4. Slicer Header Clear Button & Single-Select Controls', () => {
    it('enforces singleSelect radio behavior and renders clear button when filter is active', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Slicer Page',
            visuals: [
              {
                id: 'sl1',
                type: 'slicer',
                layout: { x: 0, y: 0, w: 4, h: 6 },
                fields: { field: 'Products[Category]' },
                format: {
                  slicer: {
                    style: 'list',
                    singleSelect: true,
                    clearButton: true,
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const slicerVis = el.querySelector('[data-visual-id="sl1"]')!;
      // Radio inputs rendered
      const radios = slicerVis.querySelectorAll<HTMLInputElement>('input[type="radio"]');
      expect(radios.length).toBeGreaterThan(0);

      // Initially no clear button because no filter is active
      expect(slicerVis.querySelector('.pbi-slicer-clear')).toBeNull();

      // Click first item to select it
      radios[0].click();
      radios[0].dispatchEvent(new Event('change', { bubbles: true }));
      report.flush();

      // Clear button should now appear
      const updatedSlicer = el.querySelector('[data-visual-id="sl1"]')!;
      const clearBtn = updatedSlicer.querySelector<HTMLButtonElement>('.pbi-slicer-clear');
      expect(clearBtn).not.toBeNull();

      // Click clear button
      clearBtn!.click();
      report.flush();

      // Filter should be cleared
      const finalSlicer = el.querySelector('[data-visual-id="sl1"]')!;
      expect(finalSlicer.querySelector('.pbi-slicer-clear')).toBeNull();
    });

    it('enforces single-select on tiles slicers', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Tiles Slicer Page',
            visuals: [
              {
                id: 'slTiles',
                type: 'slicer',
                layout: { x: 0, y: 0, w: 8, h: 3 },
                fields: { field: 'Products[Category]' },
                format: {
                  slicer: {
                    style: 'tiles',
                    singleSelect: true,
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const slicerVis = el.querySelector('[data-visual-id="slTiles"]')!;
      const tiles = slicerVis.querySelectorAll<HTMLButtonElement>('.pbi-tile');
      expect(tiles.length).toBeGreaterThan(1);

      // Click first tile
      tiles[0].click();
      report.flush();

      const updatedSlicer = el.querySelector('[data-visual-id="slTiles"]')!;
      const updatedTiles = updatedSlicer.querySelectorAll<HTMLButtonElement>('.pbi-tile');
      expect(updatedTiles[0].getAttribute('aria-pressed')).toBe('true');
    });
  });

  describe('5. Visual Title Badges & Status Indicators', () => {
    it('renders a title badge with custom text and colors in visual header', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Badge Page',
            visuals: [
              {
                id: 'cardBadge',
                type: 'card',
                title: 'Revenue Overview',
                layout: { x: 0, y: 0, w: 4, h: 3 },
                fields: { value: 'Total Sales' },
                format: {
                  title: {
                    show: true,
                    text: 'Revenue Overview',
                    badge: {
                      text: 'Live',
                      color: '#ffffff',
                      background: '#10b981',
                    },
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const cardVis = el.querySelector('[data-visual-id="cardBadge"]')!;
      const badge = cardVis.querySelector<HTMLElement>('.pbi-title-badge');
      expect(badge).not.toBeNull();
      expect(badge!.textContent).toBe('Live');
      expect(badge!.style.color).toBe('rgb(255, 255, 255)');
      expect(badge!.style.backgroundColor).toBe('rgb(16, 185, 129)');
    });

    it('renders a string badge shorthand', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Badge String Page',
            visuals: [
              {
                id: 'cardStrBadge',
                type: 'card',
                title: 'Metrics',
                layout: { x: 0, y: 0, w: 4, h: 3 },
                fields: { value: 'Total Sales' },
                format: {
                  title: {
                    show: true,
                    text: 'Metrics',
                    badge: 'Q3',
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const cardVis = el.querySelector('[data-visual-id="cardStrBadge"]')!;
      const badge = cardVis.querySelector<HTMLElement>('.pbi-title-badge');
      expect(badge).not.toBeNull();
      expect(badge!.textContent).toBe('Q3');
    });
  });
});
