import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Report } from '../src/index';
import { Studio } from '../src/studio/studio';
import { getTheme, registeredThemes } from '../src/theme/theme';
import { makeModel } from './fixtures';

let el: HTMLElement;
beforeEach(() => {
  el = document.createElement('div');
  el.style.width = '1000px';
  el.style.height = '800px';
  document.body.append(el);
});
afterEach(() => el.remove());

describe('Phase 23 Features', () => {
  describe('Canvas Action Buttons & Dynamic Drill-Through', () => {
    it('executes page navigation and back action buttons', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Page 1',
            visuals: [
              {
                id: 'btn-nav',
                type: 'actionButton',
                layout: { x: 0, y: 0, w: 4, h: 2 },
                format: {
                  button: {
                    text: 'Go to Details',
                    icon: 'arrow-right',
                    variant: 'primary',
                    action: { type: 'page', destination: 'p2' },
                  },
                },
              },
            ],
          },
          {
            id: 'p2',
            name: 'Details',
            visuals: [
              {
                id: 'btn-back',
                type: 'button',
                layout: { x: 0, y: 0, w: 3, h: 2 },
                format: {
                  button: {
                    text: 'Go Back',
                    icon: 'back',
                    action: { type: 'back' },
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      expect(report.currentPage.id).toBe('p1');
      const navBtn = el.querySelector<HTMLButtonElement>('[data-visual-id="btn-nav"] button.pbi-action-btn')!;
      expect(navBtn).not.toBeNull();
      expect(navBtn.textContent).toContain('Go to Details');
      expect(navBtn.classList.contains('is-primary')).toBe(true);
      expect(navBtn.querySelector('svg')).not.toBeNull();

      // Click to navigate to page 2
      navBtn.click();
      report.flush();
      expect(report.currentPage.id).toBe('p2');

      // Click to navigate back
      const backBtn = el.querySelector<HTMLButtonElement>('[data-visual-id="btn-back"] button.pbi-action-btn')!;
      expect(backBtn).not.toBeNull();
      backBtn.click();
      report.flush();
      expect(report.currentPage.id).toBe('p1');

      report.destroy();
    });

    it('manages drill-through action button enabled state and execution', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'summary',
            name: 'Summary',
            visuals: [
              {
                id: 'table1',
                type: 'table',
                layout: { x: 0, y: 0, w: 6, h: 6 },
                fields: { columns: ['Products[Category]', 'Total Sales'] },
              },
              {
                id: 'btn-dt',
                type: 'actionButton',
                layout: { x: 6, y: 0, w: 4, h: 2 },
                format: {
                  button: {
                    text: 'Drill to Details',
                    action: { type: 'drillthrough', destination: 'dt-page' },
                  },
                },
              },
            ],
          },
          {
            id: 'dt-page',
            name: 'Category Detail',
            drillthrough: { fields: ['Products[Category]'] },
            visuals: [
              {
                id: 'dt-table',
                type: 'table',
                layout: { x: 0, y: 0, w: 12, h: 6 },
                fields: { columns: ['Products[Name]', 'Total Sales'] },
              },
            ],
          },
        ],
      });
      report.flush();

      const dtBtn = el.querySelector<HTMLButtonElement>('[data-visual-id="btn-dt"] button.pbi-action-btn')!;
      expect(dtBtn).not.toBeNull();
      // Initially disabled because no matching category is selected
      expect(dtBtn.disabled).toBe(true);

      // Select a category row
      const firstRow = el.querySelector<HTMLTableRowElement>('[data-visual-id="table1"] tbody tr')!;
      expect(firstRow).not.toBeNull();
      firstRow.click();
      report.flush();

      // Now drill-through button should be enabled!
      const dtBtnActive = el.querySelector<HTMLButtonElement>('[data-visual-id="btn-dt"] button.pbi-action-btn')!;
      expect(dtBtnActive.disabled).toBe(false);

      // Clicking it executes drill-through to 'dt-page'
      dtBtnActive.click();
      report.flush();

      expect(report.currentPage.id).toBe('dt-page');
      expect(report.toJSON().pages[1].id).toBe('dt-page');

      report.destroy();
    });

    it('clears filters when clearFilters button is triggered', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'P1',
            visuals: [
              {
                id: 'table1',
                type: 'table',
                layout: { x: 0, y: 0, w: 6, h: 6 },
                fields: { columns: ['Products[Category]', 'Total Sales'] },
              },
              {
                id: 'btn-clear',
                type: 'actionButton',
                layout: { x: 6, y: 0, w: 4, h: 2 },
                format: {
                  button: {
                    text: 'Clear All Filters',
                    icon: 'reset',
                    action: { type: 'clearFilters' },
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      // Click a row to establish a selection
      const firstRow = el.querySelector<HTMLTableRowElement>('[data-visual-id="table1"] tbody tr')!;
      firstRow.click();
      report.flush();
      expect(report.currentSelection).not.toBeNull();

      // Click clear filters button
      const clearBtn = el.querySelector<HTMLButtonElement>('[data-visual-id="btn-clear"] button.pbi-action-btn')!;
      clearBtn.click();
      report.flush();

      expect(report.currentSelection).toBeNull();
      report.destroy();
    });
  });

  describe('Table & Matrix Quick Search', () => {
    it('renders quick search input and filters table rows interactively', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Search Test',
            visuals: [
              {
                id: 'search-table',
                type: 'table',
                layout: { x: 0, y: 0, w: 8, h: 8 },
                fields: { columns: ['Products[Category]', 'Products[Name]', 'Total Sales'] },
                format: { table: { search: true } },
              },
            ],
          },
        ],
      });
      report.flush();

      const searchBox = el.querySelector('[data-visual-id="search-table"] .pbi-table-search')!;
      expect(searchBox).not.toBeNull();

      const searchInput = searchBox.querySelector<HTMLInputElement>('.pbi-table-search-input')!;
      expect(searchInput).not.toBeNull();
      expect(searchBox.querySelector('.pbi-table-search-count')?.textContent).toContain('rows');

      const initialRows = el.querySelectorAll('[data-visual-id="search-table"] tbody tr').length;
      expect(initialRows).toBeGreaterThan(1);

      // Simulate search input query
      searchInput.value = 'Bike';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      report.flush();

      const filteredRows = el.querySelectorAll('[data-visual-id="search-table"] tbody tr').length;
      expect(filteredRows).toBeLessThan(initialRows);
      expect(filteredRows).toBeGreaterThan(0);

      // Verify search count updates
      const searchCount = el.querySelector('[data-visual-id="search-table"] .pbi-table-search-count')!;
      expect(searchCount.textContent).toContain('of');

      report.destroy();
    });

    it('renders quick search input and filters matrix rows', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Matrix Search Test',
            visuals: [
              {
                id: 'search-matrix',
                type: 'matrix',
                layout: { x: 0, y: 0, w: 8, h: 8 },
                fields: { rows: ['Products[Category]', 'Products[Name]'], values: 'Total Sales' },
                format: { matrix: { search: true, expandAll: true } },
              },
            ],
          },
        ],
      });
      report.flush();

      const searchBox = el.querySelector('[data-visual-id="search-matrix"] .pbi-table-search')!;
      expect(searchBox).not.toBeNull();

      const searchInput = searchBox.querySelector<HTMLInputElement>('.pbi-table-search-input')!;
      expect(searchInput).not.toBeNull();

      searchInput.value = 'Bikes';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      report.flush();

      const rows = el.querySelectorAll('[data-visual-id="search-matrix"] tbody tr');
      expect(rows.length).toBeGreaterThan(0);

      report.destroy();
    });
  });

  describe('Line and Scatter Error Bars', () => {
    it('renders error whiskers on continuous line charts with errorLower and errorUpper', () => {
      const model = makeModel();
      model.addMeasure('Lower Bound', '[Total Sales] * 0.9');
      model.addMeasure('Upper Bound', '[Total Sales] * 1.1');

      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Line Error Bars',
            visuals: [
              {
                id: 'err-line',
                type: 'line',
                layout: { x: 0, y: 0, w: 10, h: 6 },
                fields: {
                  category: 'Date[MonthNumber]',
                  values: 'Total Sales',
                  errorLower: 'Lower Bound',
                  errorUpper: 'Upper Bound',
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const errBars = el.querySelector('[data-visual-id="err-line"] .pbi-error-bars');
      expect(errBars).not.toBeNull();

      const stems = el.querySelectorAll('[data-visual-id="err-line"] .pbi-error-stem');
      expect(stems.length).toBeGreaterThan(0);

      const caps = el.querySelectorAll('[data-visual-id="err-line"] .pbi-error-cap');
      expect(caps.length).toBeGreaterThan(0);

      report.destroy();
    });

    it('renders error whiskers on scatter charts with errorLower and errorUpper', () => {
      const model = makeModel();
      model.addMeasure('Cost Lower', '[Total Cost] * 0.85');
      model.addMeasure('Cost Upper', '[Total Cost] * 1.15');

      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Scatter Error Bars',
            visuals: [
              {
                id: 'err-scatter',
                type: 'scatter',
                layout: { x: 0, y: 0, w: 8, h: 6 },
                fields: {
                  details: 'Products[Name]',
                  x: 'Total Sales',
                  y: 'Total Cost',
                  errorLower: 'Cost Lower',
                  errorUpper: 'Cost Upper',
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const stems = el.querySelectorAll('[data-visual-id="err-scatter"] .pbi-error-stem');
      expect(stems.length).toBeGreaterThan(0);

      const caps = el.querySelectorAll('[data-visual-id="err-scatter"] .pbi-error-cap');
      expect(caps.length).toBeGreaterThan(0);

      report.destroy();
    });
  });

  describe('Theme Presets & Customizer', () => {
    it('provides ocean, sunset, and emerald theme presets', () => {
      const ocean = getTheme('ocean');
      expect(ocean.name).toBe('ocean');
      expect(ocean.accent).toBe('#0077b6');
      expect(ocean.dataColors.length).toBeGreaterThanOrEqual(8);

      const sunset = getTheme('sunset');
      expect(sunset.name).toBe('sunset');
      expect(sunset.accent).toBe('#f72585');

      const emerald = getTheme('emerald');
      expect(emerald.name).toBe('emerald');
      expect(emerald.accent).toBe('#2d6a4f');

      const all = registeredThemes();
      const names = all.map((t) => t.name);
      expect(names).toContain('light');
      expect(names).toContain('dark');
      expect(names).toContain('high-contrast');
      expect(names).toContain('ocean');
      expect(names).toContain('sunset');
      expect(names).toContain('emerald');
    });

    it('allows Studio to customize theme and switch presets', () => {
      const model = makeModel();
      const studio = new Studio(el, { model });

      studio.setThemeOverrides({ name: 'sunset', accent: '#f72585' });
      expect(studio.report.theme.name).toBe('sunset');

      // Theme dialog invocation
      expect(typeof studio.editTheme).toBe('function');
      studio.editTheme();

      const dialog = el.querySelector('.pbs-dialog');
      expect(dialog).not.toBeNull();
      expect(dialog?.textContent).toContain('Customize Theme');

      // Close modal
      (dialog?.querySelector('footer button') as HTMLButtonElement | null)?.click();
      expect(el.querySelector('.pbs-dialog')).toBeNull();

      studio.destroy();
    });
  });
});

