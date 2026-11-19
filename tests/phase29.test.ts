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

describe('Phase 29 Features', () => {
  describe('1. Table & Matrix Custom Totals & Subtotals Styling', () => {
    it('renders custom totals row at top position with custom label, fontColor, and background in table', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Table Totals Page',
            visuals: [
              {
                id: 'tblTotals',
                type: 'table',
                layout: { x: 0, y: 0, w: 10, h: 8 },
                fields: {
                  columns: ['Products[Category]', 'Total Sales'],
                },
                format: {
                  table: {
                    totals: {
                      show: true,
                      label: 'Grand Total',
                      position: 'top',
                      fontColor: '#1e3a8a',
                      background: '#dbeafe',
                      bold: true,
                    },
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const tableVis = el.querySelector('[data-visual-id="tblTotals"]')!;
      const thead = tableVis.querySelector('thead')!;
      expect(thead).not.toBeNull();

      // Top totals row rendered inside thead
      const topRow = thead.querySelector<HTMLTableRowElement>('.pbi-total-row-top');
      expect(topRow).not.toBeNull();
      expect(topRow!.textContent).toContain('Grand Total');
      expect(topRow!.style.color).toBe('rgb(30, 58, 138)');
      expect(topRow!.style.backgroundColor).toBe('rgb(219, 234, 254)');
      expect(topRow!.style.fontWeight).toBe('bold');
    });

    it('renders matrix custom subtotals label and custom grand totals label', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Matrix Page',
            visuals: [
              {
                id: 'mx1',
                type: 'matrix',
                layout: { x: 0, y: 0, w: 10, h: 8 },
                fields: {
                  rows: ['Products[Category]', 'Products[Name]'],
                  values: ['Total Sales'],
                },
                format: {
                  matrix: {
                    subtotals: {
                      label: 'Subtotal',
                      fontColor: '#b91c1c',
                    },
                    grandTotals: {
                      label: 'Final Summary',
                      position: 'top',
                      fontColor: '#047857',
                    },
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const matrixVis = el.querySelector('[data-visual-id="mx1"]')!;
      const grandTotalRow = matrixVis.querySelector<HTMLTableRowElement>('.pbi-matrix-grand-total');
      expect(grandTotalRow).not.toBeNull();
      expect(grandTotalRow!.textContent).toContain('Final Summary');
      expect(grandTotalRow!.style.color).toBe('rgb(4, 120, 87)');
    });
  });

  describe('2. Card Visual Callout Prefix, Suffix, Color Rules & Horizontal Layout', () => {
    it('renders prefix, suffix, and evaluates conditional color rules on card callout value', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Card Page',
            visuals: [
              {
                id: 'card1',
                type: 'card',
                layout: { x: 0, y: 0, w: 5, h: 4 },
                fields: { value: 'Total Sales' },
                format: {
                  card: {
                    prefix: '$',
                    suffix: ' USD',
                    rules: [
                      { min: 100, color: '#059669' },
                    ],
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const cardVis = el.querySelector('[data-visual-id="card1"]')!;
      const valEl = cardVis.querySelector<HTMLElement>('.pbi-card-value')!;
      expect(valEl).not.toBeNull();

      const prefixEl = valEl.querySelector<HTMLElement>('.pbi-card-prefix');
      expect(prefixEl).not.toBeNull();
      expect(prefixEl!.textContent).toBe('$');

      const suffixEl = valEl.querySelector<HTMLElement>('.pbi-card-suffix');
      expect(suffixEl).not.toBeNull();
      expect(suffixEl!.textContent).toBe(' USD');

      // Rule matched color
      expect(valEl.style.color).toBe('rgb(5, 150, 105)');
    });

    it('supports horizontal orientation on card', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Card Horizontal Page',
            visuals: [
              {
                id: 'cardHoriz',
                type: 'card',
                layout: { x: 0, y: 0, w: 6, h: 3 },
                fields: { value: 'Total Sales' },
                format: {
                  card: {
                    orientation: 'horizontal',
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const cardVis = el.querySelector('[data-visual-id="cardHoriz"]')!;
      const wrap = cardVis.querySelector<HTMLElement>('.pbi-card')!;
      expect(wrap.classList.contains('is-horizontal')).toBe(true);
    });
  });

  describe('3. Multi-Row Card Left Accent Bar & Grid Layout', () => {
    it('renders colored accent strip and applies custom grid columns on multi-row card', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'MRC Page',
            visuals: [
              {
                id: 'mrc1',
                type: 'multiRowCard',
                layout: { x: 0, y: 0, w: 10, h: 6 },
                fields: {
                  category: 'Products[Category]',
                  values: ['Total Sales'],
                },
                format: {
                  multiRowCard: {
                    showAccentBar: true,
                    accentColor: '#8b5cf6',
                    columns: 2,
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const mrcVis = el.querySelector('[data-visual-id="mrc1"]')!;
      const rows = mrcVis.querySelectorAll<HTMLElement>('.pbi-mrc-row');
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].style.borderLeftColor).toBe('rgb(139, 92, 246)');

      const grid = mrcVis.querySelector<HTMLElement>('.pbi-mrc-grid')!;
      expect(grid.style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))');
    });
  });

  describe('4. Radial Gauge Custom Target Label & Needle Customization', () => {
    it('renders custom target label and needle color on gauge', () => {
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
                layout: { x: 0, y: 0, w: 6, h: 5 },
                fields: {
                  value: 'Total Sales',
                  target: 'Total Sales',
                },
                format: {
                  gauge: {
                    needle: true,
                    needleColor: '#e11d48',
                    needleCapColor: '#9f1239',
                    targetLabel: 'Goal',
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const gaugeVis = el.querySelector('[data-visual-id="gauge1"]')!;
      const needle = gaugeVis.querySelector<SVGPolygonElement>('.pbi-gauge-needle');
      expect(needle).not.toBeNull();
      expect(needle!.getAttribute('fill')).toBe('#e11d48');

      const needleCap = gaugeVis.querySelector<SVGCircleElement>('.pbi-gauge-needle-cap');
      expect(needleCap).not.toBeNull();
      expect(needleCap!.getAttribute('fill')).toBe('#9f1239');

      // Target text contains 'Goal'
      const texts = Array.from(gaugeVis.querySelectorAll<SVGTextElement>('text')).map((t) => t.textContent ?? '');
      expect(texts.some((txt) => txt.includes('Goal'))).toBe(true);
    });
  });

  describe('5. Slicer Dropdown UX & Custom Select-All Labels', () => {
    it('uses custom selectAllLabel and auto-closes dropdown on single-select item click', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Slicer Page',
            visuals: [
              {
                id: 'slSelectAll',
                type: 'slicer',
                layout: { x: 0, y: 0, w: 4, h: 6 },
                fields: { field: 'Products[Category]' },
                format: {
                  slicer: {
                    style: 'list',
                    selectAllLabel: 'All Categories',
                  },
                },
              },
              {
                id: 'slDropdown',
                type: 'slicer',
                layout: { x: 4, y: 0, w: 4, h: 4 },
                fields: { field: 'Products[Category]' },
                format: {
                  slicer: {
                    style: 'dropdown',
                    singleSelect: true,
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const sl1 = el.querySelector('[data-visual-id="slSelectAll"]')!;
      const selectAllSpan = sl1.querySelector<HTMLElement>('.pbi-select-all span');
      expect(selectAllSpan).not.toBeNull();
      expect(selectAllSpan!.textContent).toBe('All Categories');

      // Test dropdown
      const slDrop = el.querySelector('[data-visual-id="slDropdown"]')!;
      const dropBtn = slDrop.querySelector<HTMLButtonElement>('.pbi-dropdown-btn')!;
      expect(dropBtn).not.toBeNull();

      // Open dropdown
      dropBtn.click();
      report.flush();

      const updatedDrop = el.querySelector('[data-visual-id="slDropdown"]')!;
      const panel = updatedDrop.querySelector<HTMLElement>('.pbi-dropdown-panel');
      expect(panel).not.toBeNull();

      // Click a radio item in single-select dropdown
      const radio = panel!.querySelector<HTMLInputElement>('input[type="radio"]')!;
      expect(radio).not.toBeNull();
      radio.click();
      radio.dispatchEvent(new Event('change', { bubbles: true }));
      report.flush();

      // Dropdown should automatically close
      const closedDrop = el.querySelector('[data-visual-id="slDropdown"]')!;
      expect(closedDrop.querySelector('.pbi-dropdown-panel')).toBeNull();
    });
  });
});
