import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Report, createVisual, defineVisual, registerVisual } from '../src/index';
import type { ReportDefinition } from '../src/index';
import { makeModel } from './fixtures';

let el: HTMLElement;
beforeEach(() => {
  el = document.createElement('div');
  el.style.height = '800px';
  document.body.append(el);
});
afterEach(() => el.remove());

const definition = (): ReportDefinition => ({
  name: 'Sales',
  pages: [
    {
      id: 'overview',
      name: 'Overview',
      visuals: [
        { id: 'slicer', type: 'slicer', layout: { x: 0, y: 0, w: 12, h: 2 }, fields: { field: 'Region[Name]' }, format: { slicer: { style: 'tiles' } } },
        { id: 'card', type: 'card', layout: { x: 0, y: 2, w: 3, h: 2 }, fields: { value: 'Total Sales' } },
        { id: 'cols', type: 'clusteredColumn', title: 'By category', layout: { x: 0, y: 4, w: 6, h: 6 }, fields: { category: ['Products[Category]', 'Products[Name]'], values: 'Total Sales' } },
        { id: 'line', type: 'line', layout: { x: 6, y: 4, w: 6, h: 6 }, fields: { category: 'Date[Month]', values: 'Total Sales' } },
        { id: 'pie', type: 'donut', layout: { x: 0, y: 10, w: 4, h: 6 }, fields: { legend: 'Region[Name]', values: 'Total Sales' } },
        { id: 'table', type: 'table', layout: { x: 4, y: 10, w: 8, h: 6 }, fields: { columns: ['Products[Category]', 'Total Sales', 'Margin %'] }, format: { table: { conditional: { 'Total Sales': { dataBars: true } } } } },
        { id: 'matrix', type: 'matrix', layout: { x: 0, y: 16, w: 12, h: 6 }, fields: { rows: ['Products[Category]', 'Products[Name]'], columns: 'Date[Year]', values: 'Total Sales' } },
      ],
    },
    { id: 'details', name: 'Details', visuals: [{ id: 'bar', type: 'clusteredBar', layout: { x: 0, y: 0, w: 12, h: 8 }, fields: { category: 'Products[Name]', values: 'Total Sales' } }] },
  ],
});

const cardText = () => el.querySelector('[data-visual-id="card"] .pbi-card-value')?.textContent;

describe('Report', () => {
  it('renders every visual without errors', () => {
    const r = new Report(el, { model: makeModel(), ...definition() });
    r.flush();
    expect(el.querySelectorAll('.pbi-error')).toHaveLength(0);
    expect(cardText()).toBe('$6,750');
    expect(el.querySelectorAll('[data-visual-id="cols"] path.pbi-mark').length).toBe(3);
    expect(el.querySelectorAll('[data-visual-id="table"] tbody tr').length).toBe(3);
    expect(el.querySelector('[data-visual-id="matrix"] tfoot')?.textContent).toContain('$6,750');
    expect(el.querySelectorAll('.pbi-tab').length).toBe(2);
    r.destroy();
  });

  it('slicers filter other visuals', () => {
    const r = new Report(el, { model: makeModel(), ...definition() });
    r.flush();
    r.setSlicerSelection('slicer', [{ target: 'Region[Name]', op: 'in', values: ['South'] }]);
    r.flush();
    expect(cardText()).toBe('$2,300');
    const tile = [...el.querySelectorAll<HTMLButtonElement>('.pbi-tile')].find((b) => b.textContent === 'South')!;
    expect(tile.getAttribute('aria-pressed')).toBe('true');
    r.reset();
    r.flush();
    expect(cardText()).toBe('$6,750');
  });

  it('clicking a column cross-filters cards and highlights other charts', () => {
    const r = new Report(el, { model: makeModel(), ...definition() });
    r.flush();
    const events: unknown[] = [];
    r.on('selectionChanged', (e) => events.push(e));
    const bars = [...el.querySelectorAll<SVGPathElement>('[data-visual-id="cols"] path.pbi-mark')];
    bars[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    r.flush();
    expect(events).toHaveLength(1);
    expect(cardText()).toBe('$6,000'); // Bikes (largest, sorted first)
    // donut supports highlight → shows highlight overlay paths
    expect(el.querySelectorAll('[data-visual-id="pie"] path[pointer-events="none"]').length).toBeGreaterThan(0);
    // clicking the same bar again clears
    el.querySelectorAll<SVGPathElement>('[data-visual-id="cols"] path.pbi-mark')[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    r.flush();
    expect(cardText()).toBe('$6,750');
  });

  it('drills down and up a hierarchy', () => {
    const r = new Report(el, { model: makeModel(), ...definition() });
    r.flush();
    r.visual('cols').drillDown('Bikes');
    r.flush();
    const data = r.visual('cols').data()!;
    expect(data.rows.map((x) => x.keys[0]).sort()).toEqual(['Mountain Bike', 'Road Bike']);
    expect(el.querySelector('[data-visual-id="cols"] .pbi-drill-crumb')?.textContent).toContain('Category: Bikes');
    r.visual('cols').drillUp();
    r.flush();
    expect(r.visual('cols').data()!.rows).toHaveLength(3);
  });

  it('page, report and visual filters compose', () => {
    const r = new Report(el, { model: makeModel(), ...definition() });
    r.setReportFilters([{ target: 'Date[Year]', op: 'eq', value: 2024 }]);
    r.setPageFilters('overview', [{ target: 'Products[Category]', op: 'eq', value: 'Bikes' }]);
    r.flush();
    expect(cardText()).toBe('$4,000');
    r.setVisualFilters('card', [{ target: 'Region[Name]', op: 'eq', value: 'South' }]);
    r.flush();
    expect(cardText()).toBe('(Blank)');
  });

  it('switches pages and themes', () => {
    const r = new Report(el, { model: makeModel(), ...definition() });
    const pages: string[] = [];
    r.on('pageChanged', (p) => pages.push(p.name));
    r.goToPage('Details');
    r.flush();
    expect(pages).toEqual(['Details']);
    expect(el.querySelectorAll('[data-visual-id="bar"] path.pbi-mark').length).toBe(5);
    r.setTheme('dark');
    expect(r.root.dataset.mode).toBe('dark');
  });

  it('captures and applies bookmarks, and round-trips JSON with dates', () => {
    const r = new Report(el, { model: makeModel(), ...definition() });
    r.setSlicerSelection('slicer', [{ target: 'Region[Name]', op: 'in', values: ['North'] }]);
    r.setPageFilters('overview', [{ target: 'Date[Date]', op: 'between', min: new Date(2024, 0, 1), max: new Date(2024, 11, 31) }]);
    const bm = r.captureBookmark('North 2024');
    r.reset();
    r.setPageFilters('overview', []);
    r.flush();
    expect(cardText()).toBe('$6,750');
    r.applyBookmark('North 2024');
    r.flush();
    expect(cardText()).toBe('$4,200');
    const json = JSON.stringify(r.toJSON());
    const parsed = Report.parse(json);
    const f = parsed.pages[0].filters![0] as { min: Date };
    expect(f.min).toBeInstanceOf(Date);
    expect(parsed.bookmarks![0].name).toBe(bm.name);
  });

  it('exports CSV of what a visual shows', () => {
    const r = new Report(el, { model: makeModel(), ...definition() });
    r.flush();
    const csv = r.visual('table').toCsv();
    expect(csv.split('\n')[0]).toBe('Category,Total Sales,Margin %');
    expect(csv).toContain('Bikes,6000');
  });

  it('shows a readable error for a bad field', () => {
    const r = new Report(el, { model: makeModel(), pages: [{ name: 'P', visuals: [{ id: 'x', type: 'card', fields: { value: 'Nope' } }] }] });
    const errors: string[] = [];
    r.on('error', (e) => errors.push(e.error.message));
    r.flush();
    expect(el.querySelector('.pbi-error')?.textContent).toMatch(/Unknown field "Nope"/);
    expect(errors).toHaveLength(1);
  });

  it('supports custom visuals', () => {
    registerVisual(
      defineVisual({
        type: 'bigNumber',
        displayName: 'Big number',
        roles: [{ name: 'value', displayName: 'Value', kind: 'measure' }],
        render(ctx) {
          ctx.root.textContent = `★ ${ctx.fmt(ctx.data.values[0], ctx.data.rows[0].values[0])}`;
        },
      }),
    );
    const r = createVisual(el, { model: makeModel(), type: 'bigNumber', fields: { value: 'Total Sales' } });
    r.flush();
    expect(el.textContent).toContain('★ $6,750');
  });

  it('renders every built-in visual type', () => {
    const model = makeModel();
    const specs = [
      { type: 'stackedColumn', fields: { category: 'Products[Category]', legend: 'Region[Name]', values: 'Total Sales' } },
      { type: 'percentStackedBar', fields: { category: 'Products[Category]', legend: 'Region[Name]', values: 'Total Sales' } },
      { type: 'area', fields: { category: 'Date[Month]', values: ['Total Sales', 'Total Cost'] } },
      { type: 'stackedArea', fields: { category: 'Date[Month]', legend: 'Region[Name]', values: 'Total Sales' } },
      { type: 'lineClusteredColumn', fields: { category: 'Date[Month]', values: 'Total Sales', lineValues: 'Total Cost' } },
      { type: 'pie', fields: { legend: 'Products[Name]', values: 'Total Sales' } },
      { type: 'treemap', fields: { category: 'Products[Name]', values: 'Total Sales' } },
      { type: 'funnel', fields: { category: 'Products[Category]', values: 'Total Sales' } },
      { type: 'scatter', fields: { details: 'Products[Name]', x: 'Total Sales', y: 'Margin %', size: 'Orders' } },
      { type: 'multiRowCard', fields: { category: 'Region[Name]', values: ['Total Sales', 'Orders'] } },
      { type: 'kpi', fields: { trend: 'Date[Month]', value: 'Total Sales', target: 'Total Cost' } },
      { type: 'gauge', fields: { value: 'Total Sales', target: 'Total Cost' } },
      { type: 'slicer', fields: { field: 'Date[Date]' } },
      { type: 'slicer', fields: { field: 'Products[Category]' }, format: { slicer: { style: 'dropdown' } } },
      { type: 'slicer', fields: { field: 'Date[Date]' }, format: { slicer: { style: 'relative' } } },
      { type: 'text', fields: { values: 'Total Sales' }, format: { text: { content: '# Hello\nSales are **{{Total Sales}}**' } } },
    ];
    for (const spec of specs) {
      const host = document.createElement('div');
      document.body.append(host);
      const r = createVisual(host, { model, ...spec } as never);
      r.flush();
      expect(host.querySelector('.pbi-error')?.textContent ?? '', spec.type).toBe('');
      r.destroy();
      host.remove();
    }
  });
});
