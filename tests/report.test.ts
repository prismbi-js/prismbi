import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataModel, Report, createVisual, defineVisual, registerVisual } from '../src/index';
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

  it('exports TSV of what a visual shows and copies data/SVG to clipboard', async () => {
    const r = new Report(el, { model: makeModel(), ...definition() });
    r.flush();
    const tsv = r.visual('table').toTsv();
    expect(tsv.split('\n')[0]).toBe('Category\tTotal Sales\tMargin %');
    expect(tsv).toContain('Bikes\t6000');

    let writtenText = '';
    const origClipboard = (navigator as any).clipboard;
    Object.assign(navigator, {
      clipboard: {
        writeText: async (text: string) => {
          writtenText = text;
        },
      },
    });
    try {
      const okData = await r.visual('table').copyData();
      expect(okData).toBe(true);
      expect(writtenText).toBe(tsv);

      const okSvg = await r.visual('table').copySvg();
      expect(okSvg).toBe(true);
      expect(writtenText).toContain('<svg');
    } finally {
      Object.assign(navigator, { clipboard: origClipboard });
    }
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

  it('copies visual image to clipboard', async () => {
    const r = new Report(el, { model: makeModel(), ...definition() });
    r.flush();

    let clipboardWritten: unknown = null;
    class FakeClipboardItem {
      types: string[];
      data: Record<string, Blob>;
      constructor(data: Record<string, Blob>) {
        this.data = data;
        this.types = Object.keys(data);
      }
    }
    const origClipboardItem = (globalThis as any).ClipboardItem;
    const origImage = globalThis.Image;
    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    const origGetContext = HTMLCanvasElement.prototype.getContext;

    try {
      (globalThis as any).ClipboardItem = FakeClipboardItem;
      class MockImage {
        onload: (() => void) | null = null;
        width = 200;
        height = 100;
        set src(_v: string) {
          setTimeout(() => this.onload?.(), 0);
        }
      }
      (globalThis as any).Image = MockImage;
      HTMLCanvasElement.prototype.toBlob = function (cb: (b: Blob | null) => void) {
        cb(new Blob(['fake-png'], { type: 'image/png' }));
      };
      HTMLCanvasElement.prototype.getContext = (() => ({
        fillRect() {},
        scale() {},
        drawImage() {},
      })) as never;

      Object.assign(navigator, {
        clipboard: {
          write: async (items: unknown[]) => {
            clipboardWritten = items;
          },
        },
      });

      const ok = await r.visual('card').copyImage();
      expect(ok).toBe(true);
      expect(clipboardWritten).not.toBeNull();
    } finally {
      (globalThis as any).ClipboardItem = origClipboardItem;
      globalThis.Image = origImage;
      HTMLCanvasElement.prototype.toBlob = origToBlob;
      HTMLCanvasElement.prototype.getContext = origGetContext;
      r.destroy();
    }
  });

  it('renders line chart with data labels and avoids overlapping collision', () => {
    const m = new DataModel();
    m.addTable('T', [
      { Day: 'Mon', Val1: 100, Val2: 100 },
      { Day: 'Tue', Val1: 200, Val2: 200 },
    ]);
    m.addMeasure('V1', 'SUM(T[Val1])');
    m.addMeasure('V2', 'SUM(T[Val2])');
    const r = new Report(el, {
      model: m,
      pages: [{
        id: 'p1',
        name: 'P1',
        visuals: [{
          id: 'line1',
          type: 'line',
          layout: { x: 0, y: 0, w: 10, h: 6 },
          fields: { category: 'T[Day]', values: ['V1', 'V2'] },
          format: { dataLabels: { show: true } },
        }],
      }],
    });
    r.flush();
    const labels = el.querySelectorAll('[data-visual-id="line1"] text.pbi-label');
    expect(labels.length).toBeGreaterThan(0);
    const ys = [...labels].map((l) => Number(l.getAttribute('y')));
    const uniqueYs = new Set(ys);
    expect(uniqueYs.size).toBe(ys.length);
    r.destroy();
  });

  it('applies custom drop shadow and respects crosshair option', () => {
    const m = new DataModel().addTable('T', [{ x: 'A', y: 10 }]);
    const r = new Report(el, {
      model: m,
      pages: [{
        id: 'p1',
        name: 'P1',
        visuals: [
          {
            id: 'v1',
            type: 'card',
            fields: { value: 'T[y]' },
            format: {
              shadow: { show: true, color: 'rgba(255, 0, 0, 0.5)', blur: 16, x: 2, y: 6 },
            },
          },
          {
            id: 'v2',
            type: 'line',
            fields: { category: 'T[x]', values: 'T[y]' },
            format: {
              analytics: { referenceLines: [], trendLine: false, forecast: false, anomalies: false, crosshair: false },
            },
          },
        ],
      }],
    });
    r.flush();

    const v1El = el.querySelector<HTMLElement>('[data-visual-id="v1"]')!;
    expect(v1El.classList.contains('has-shadow')).toBe(true);
    expect(v1El.style.getPropertyValue('--pbi-v-shadow')).toBe('2px 6px 16px 0px rgba(255, 0, 0, 0.5)');

    const v2El = el.querySelector<HTMLElement>('[data-visual-id="v2"]')!;
    expect(v2El).toBeTruthy();
    r.destroy();
  });

  it('supports box brush multi-selection on scatter charts', () => {
    const m = new DataModel().addTable('ScatterData', [
      { id: 'P1', x: 10, y: 20 },
      { id: 'P2', x: 30, y: 40 },
      { id: 'P3', x: 50, y: 60 },
    ]);
    const r = new Report(el, {
      model: m,
      pages: [{
        id: 'p1',
        name: 'P1',
        visuals: [{
          id: 'sc1',
          type: 'scatter',
          fields: { details: 'ScatterData[id]', x: 'ScatterData[x]', y: 'ScatterData[y]' },
        }],
      }],
    });
    r.flush();

    const svg = el.querySelector<SVGSVGElement>('[data-visual-id="sc1"] svg')!;
    expect(svg).toBeTruthy();

    const pointer = (type: string, clientX = 0, clientY = 0) =>
      Object.assign(new MouseEvent(type, { bubbles: true, clientX, clientY, button: 0 }), { pointerId: 1 });

    // Drag over plot area (left is ~40px, so start at 100, 50)
    svg.dispatchEvent(pointer('pointerdown', 100, 50));
    svg.dispatchEvent(pointer('pointermove', 300, 200));
    expect(svg.querySelector('.pbi-brush')).toBeTruthy();
    svg.dispatchEvent(pointer('pointerup', 300, 200));
    expect(svg.querySelector('.pbi-brush')).toBeNull();

    // Selection on report page should be active
    expect(r.selectionSource()).toBe('sc1');
    r.destroy();
  });

  it('supports horizontal range brush multi-selection on line charts', () => {
    const m = new DataModel().addTable('LineData', [
      { date: '2026-01-01', val: 100 },
      { date: '2026-01-02', val: 120 },
      { date: '2026-01-03', val: 150 },
      { date: '2026-01-04', val: 90 },
      { date: '2026-01-05', val: 110 },
    ]);
    const r = new Report(el, {
      model: m,
      pages: [{
        id: 'p1',
        name: 'P1',
        visuals: [{
          id: 'ln1',
          type: 'line',
          fields: { axis: 'LineData[date]', values: 'LineData[val]' },
        }],
      }],
    });
    r.flush();

    const hit = el.querySelector<SVGRectElement>('[data-visual-id="ln1"] .pbi-hit')!;
    expect(hit).toBeTruthy();

    const pointer = (type: string, clientX = 0, clientY = 0) =>
      Object.assign(new MouseEvent(type, { bubbles: true, clientX, clientY, button: 0 }), { pointerId: 1 });

    // Drag horizontally across hit layer
    hit.dispatchEvent(pointer('pointerdown', 50, 50));
    window.dispatchEvent(pointer('pointermove', 250, 50));
    const svg = el.querySelector<SVGSVGElement>('[data-visual-id="ln1"] svg')!;
    expect(svg.querySelector('.pbi-brush')).toBeTruthy();
    window.dispatchEvent(pointer('pointerup', 250, 50));
    expect(svg.querySelector('.pbi-brush')).toBeNull();

    // Selection should be registered
    expect(r.selectionSource()).toBe('ln1');
    r.destroy();
  });

  it('supports box brush multi-selection on column / bar charts', () => {
    const m = new DataModel().addTable('Sales', [
      { cat: 'A', val: 100 },
      { cat: 'B', val: 200 },
      { cat: 'C', val: 300 },
      { cat: 'D', val: 400 },
    ]);
    const r = new Report(el, {
      model: m,
      pages: [{
        id: 'p1',
        name: 'P1',
        visuals: [{
          id: 'col1',
          type: 'column',
          fields: { category: 'Sales[cat]', values: 'Sales[val]' },
        }],
      }],
    });
    r.flush();

    const svg = el.querySelector<SVGSVGElement>('[data-visual-id="col1"] svg')!;
    expect(svg).toBeTruthy();

    const pointer = (type: string, clientX = 0, clientY = 0) =>
      Object.assign(new MouseEvent(type, { bubbles: true, clientX, clientY, button: 0 }), { pointerId: 1 });

    svg.dispatchEvent(pointer('pointerdown', 20, 20));
    window.dispatchEvent(pointer('pointermove', 250, 250));
    expect(svg.querySelector('.pbi-brush')).toBeTruthy();
    window.dispatchEvent(pointer('pointerup', 250, 250));
    expect(svg.querySelector('.pbi-brush')).toBeNull();

    expect(r.selectionSource()).toBe('col1');
    r.destroy();
  });

  it('exports report page as SVG string and image canvas/blob', async () => {
    const origSrc = Object.getOwnPropertyDescriptor(Image.prototype, 'src');
    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    Object.defineProperty(Image.prototype, 'src', {
      set(this: HTMLImageElement) {
        setTimeout(() => this.onload?.(new Event('load') as never), 0);
      },
      configurable: true,
    });
    HTMLCanvasElement.prototype.toBlob = function (cb) {
      cb(new Blob(['fake'], { type: 'image/png' }));
    };

    try {
      const m = new DataModel().addTable('T', [{ a: 1, b: 2 }]);
      const r = new Report(el, {
        model: m,
        pages: [{
          id: 'p1',
          name: 'Page 1',
          visuals: [{ id: 'v1', type: 'card', fields: { value: 'T[a]' } }],
        }],
      });
      r.flush();

      const svg = await r.toSvg('p1');
      expect(svg).toContain('<svg');
      expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');

      const blob = await r.toImage({ page: 'p1', type: 'png' });
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('image/png');

      r.destroy();
    } finally {
      if (origSrc) Object.defineProperty(Image.prototype, 'src', origSrc);
      HTMLCanvasElement.prototype.toBlob = origToBlob;
    }
  });

  it('searches across all pages and visuals with report.find()', () => {
    const m = new DataModel().addTable('Sales', [{ cat: 'Shoes', amt: 150 }]);
    const r = new Report(el, {
      model: m,
      pages: [
        {
          id: 'p1',
          name: 'Executive Overview',
          visuals: [
            { id: 'v1', type: 'card', title: 'Total Sales Revenue', fields: { value: 'Sales[amt]' } },
            { id: 'v2', type: 'pie', title: 'Category Breakdown', fields: { legend: 'Sales[cat]', values: 'Sales[amt]' } },
          ],
        },
        {
          id: 'p2',
          name: 'Detailed Trends',
          visuals: [
            { id: 'v3', type: 'line', title: 'Monthly Velocity', fields: { values: 'Sales[amt]' } },
          ],
        },
      ],
    });
    r.flush();

    // Query by title substring
    const res1 = r.find('Revenue');
    expect(res1.length).toBe(1);
    expect(res1[0].visualId).toBe('v1');
    expect(res1[0].pageName).toBe('Executive Overview');
    expect(res1[0].matches.some((m) => m.kind === 'title' && m.text.includes('Revenue'))).toBe(true);

    // Query by field reference RegExp
    const res2 = r.find(/Sales\[amt\]/i);
    expect(res2.length).toBe(3);
    expect(res2.map((x) => x.visualId)).toEqual(['v1', 'v2', 'v3']);

    // Query by visual type
    const res3 = r.find('pie');
    expect(res3.length).toBe(1);
    expect(res3[0].visualId).toBe('v2');

    r.destroy();
  });

  it('renders interactive bookmark navigation bar with report.renderBookmarksBar()', () => {
    const m = new DataModel().addTable('Sales', [{ a: 1 }]);
    const r = new Report(el, {
      model: m,
      pages: [{ id: 'p1', name: 'Page 1', visuals: [] }],
    });
    r.flush();

    r.captureBookmark('Default View');
    r.captureBookmark('Drilled View');
    expect(r.bookmarkList().length).toBe(2);

    const bar = r.renderBookmarksBar();
    expect(bar).toBeTruthy();
    expect(bar.classList.contains('pbi-bookmark-bar')).toBe(true);

    const pills = bar.querySelectorAll<HTMLButtonElement>('.pbi-bm-pill');
    expect(pills.length).toBe(2);
    expect(pills[0].textContent).toBe('Default View');
    expect(pills[1].textContent).toBe('Drilled View');

    // Click pill to apply
    pills[1].click();
    expect(pills[1].getAttribute('aria-pressed')).toBe('true');
    expect(pills[0].getAttribute('aria-pressed')).toBe('false');

    r.destroy();
  });

  it('exports visual raw data to CSV, TSV, and JSON via getVisualData and exportVisualData', async () => {
    const m = new DataModel().addTable('Products', [
      { Category: 'Bikes', Revenue: 1500 },
      { Category: 'Accessories', Revenue: 450 },
    ]);
    const r = new Report(el, {
      model: m,
      pages: [
        {
          id: 'p1',
          name: 'Sales Page',
          visuals: [
            { id: 'v1', type: 'table', title: 'Product Table', fields: { columns: ['Products[Category]', 'Products[Revenue]'] } },
          ],
        },
      ],
    });
    r.flush();

    // getVisualData in CSV
    const csv = r.getVisualData('v1', 'csv');
    expect(csv).toContain('Category,Revenue');
    expect(csv).toContain('Bikes,1500');
    expect(csv).toContain('Accessories,450');

    // getVisualData in TSV
    const tsv = r.getVisualData('v1', 'tsv');
    expect(tsv).toContain('Category\tRevenue');
    expect(tsv).toContain('Bikes\t1500');

    // getVisualData in JSON
    const jsonStr = r.getVisualData('v1', 'json');
    const parsed = JSON.parse(jsonStr);
    expect(parsed.length).toBe(2);
    expect(parsed.find((p: any) => p.Category === 'Bikes')?.Revenue).toBe(1500);
    expect(parsed.find((p: any) => p.Category === 'Accessories')?.Revenue).toBe(450);

    // exportVisualData returns a Blob
    const csvBlob = await r.exportVisualData('v1', 'csv');
    expect(csvBlob.type).toContain('text/csv');
    expect(csvBlob.size).toBeGreaterThan(0);

    const jsonBlob = await r.exportVisualData('v1', 'json');
    expect(jsonBlob.type).toContain('application/json');
    expect(jsonBlob.size).toBeGreaterThan(0);

    r.destroy();
  });

  it('supports visual annotations with callout pins and popovers', () => {
    const m = new DataModel().addTable('Sales', [{ cat: 'A', val: 100 }, { cat: 'B', val: 200 }]);
    const r = new Report(el, {
      model: m,
      pages: [
        {
          id: 'p1',
          name: 'Page 1',
          visuals: [
            { id: 'v1', type: 'bar', title: 'Sales Bar', fields: { category: 'Sales[cat]', values: 'Sales[val]' } },
          ],
        },
      ],
    });
    r.flush();

    expect(r.getAnnotations('v1')).toEqual([]);

    // Add annotation
    r.addAnnotation('v1', {
      text: 'Peak seasonal spike detected',
      title: 'Outlier Note',
      category: 'B',
      badge: '★',
      color: '#e74c3c',
    });
    r.flush();

    const anns = r.getAnnotations('v1');
    expect(anns.length).toBe(1);
    expect(anns[0].text).toBe('Peak seasonal spike detected');
    expect(anns[0].badge).toBe('★');

    const vHost = el.querySelector('[data-visual-id="v1"]')!;
    expect(vHost).toBeTruthy();

    const pin = vHost.querySelector<HTMLButtonElement>('.pbi-annotation-pin')!;
    expect(pin).toBeTruthy();
    expect(pin.querySelector('.pbi-annotation-badge')?.textContent).toBe('★');

    const popover = pin.querySelector<HTMLElement>('.pbi-annotation-popover')!;
    expect(popover).toBeTruthy();
    expect(popover.hidden).toBe(true);

    // Click pin to toggle popover
    pin.click();
    expect(popover.hidden).toBe(false);
    expect(popover.querySelector('.pbi-annotation-title')?.textContent).toBe('Outlier Note');
    expect(popover.querySelector('.pbi-annotation-text')?.textContent).toBe('Peak seasonal spike detected');

    // Remove annotation
    r.removeAnnotation('v1', anns[0].id!);
    r.flush();
    expect(r.getAnnotations('v1').length).toBe(0);
    expect(vHost.querySelector('.pbi-annotation-pin')).toBeNull();

    r.destroy();
  });

  it('supports grid visibility and snap-to-grid controls', () => {
    const m = new DataModel().addTable('Sales', [{ a: 1 }]);
    const r = new Report(el, {
      model: m,
      pages: [{ id: 'p1', name: 'Page 1', visuals: [] }],
    });
    r.flush();

    expect(r.isGridVisible()).toBe(false);
    expect(r.isSnapToGrid()).toBe(true);

    r.showGrid(true);
    expect(r.isGridVisible()).toBe(true);
    expect(el.querySelector('.pbi-report')?.classList.contains('pbi-grid-visible')).toBe(true);

    r.showGrid(false);
    expect(r.isGridVisible()).toBe(false);
    expect(el.querySelector('.pbi-report')?.classList.contains('pbi-grid-visible')).toBe(false);

    r.setSnapToGrid(false);
    expect(r.isSnapToGrid()).toBe(false);
    r.setSnapToGrid(true);
    expect(r.isSnapToGrid()).toBe(true);

    r.destroy();
  });

  it('supports presentation mode, fullscreen toggle, and auto-play slideshow carousel', async () => {
    const m = new DataModel().addTable('Sales', [{ a: 1 }]);
    const r = new Report(el, {
      model: m,
      pages: [
        { id: 'p1', name: 'Slide 1', visuals: [] },
        { id: 'p2', name: 'Slide 2', visuals: [] },
      ],
    });
    r.flush();

    expect(r.isAutoPlaying()).toBe(false);
    expect(r.isFullscreen()).toBe(false);

    // Fullscreen enter/exit
    await r.enterFullscreen();
    expect(r.isFullscreen()).toBe(true);
    expect(el.querySelector('.pbi-report')?.classList.contains('is-fullscreen')).toBe(true);

    await r.exitFullscreen();
    expect(r.isFullscreen()).toBe(false);
    expect(el.querySelector('.pbi-report')?.classList.contains('is-fullscreen')).toBe(false);

    // Start auto-play
    const stop = r.startAutoPlay({ intervalMs: 2000, loop: true, showControls: true });
    expect(r.isAutoPlaying()).toBe(true);

    const presBar = el.querySelector<HTMLElement>('.pbi-presentation-bar');
    expect(presBar).toBeTruthy();
    expect(presBar?.querySelector('.pbi-pres-label')?.textContent).toBe('1 / 2');

    // Next button advances page
    const nextBtn = presBar?.querySelectorAll<HTMLButtonElement>('.pbi-pres-btn')[2];
    expect(nextBtn).toBeTruthy();
    nextBtn?.click();
    expect(presBar?.querySelector('.pbi-pres-label')?.textContent).toBe('2 / 2');

    stop();
    expect(r.isAutoPlaying()).toBe(false);
    expect(el.querySelector('.pbi-presentation-bar')).toBeNull();

    r.destroy();
  });

  it('supports page wallpaper, background image, opacity, and watermark styling', () => {
    const m = new DataModel().addTable('Sales', [{ a: 1 }]);
    const r = new Report(el, {
      model: m,
      pages: [
        {
          id: 'p1',
          name: 'Executive Dashboard',
          visuals: [],
          background: {
            color: '#f8f9fa',
            opacity: 0.95,
            image: 'https://example.com/wallpaper.png',
            fit: 'fill',
            watermark: 'CONFIDENTIAL',
          },
        },
      ],
    });
    r.flush();

    const bg = r.getPageBackground('p1') as any;
    expect(bg).toBeTruthy();
    expect(bg.watermark).toBe('CONFIDENTIAL');
    expect(bg.fit).toBe('fill');

    const pageEl = el.querySelector<HTMLElement>('.pbi-page')!;
    expect(pageEl).toBeTruthy();
    expect(pageEl.style.backgroundImage).toContain('wallpaper.png');
    expect(pageEl.style.backgroundSize).toBe('cover');
    expect(pageEl.style.opacity).toBe('0.95');

    const wm = pageEl.querySelector('.pbi-watermark');
    expect(wm).toBeTruthy();
    expect(wm?.textContent).toBe('CONFIDENTIAL');

    // Update background dynamically
    r.setPageBackground({ color: '#ffffff', watermark: 'DRAFT' }, 'p1');
    r.flush();
    expect((r.getPageBackground('p1') as any).watermark).toBe('DRAFT');
    expect(pageEl.querySelector('.pbi-watermark')?.textContent).toBe('DRAFT');

    r.destroy();
  });

  it('supports bulk reordering and deletion of report pages', () => {
    const m = new DataModel().addTable('Sales', [{ a: 1 }]);
    const r = new Report(el, {
      model: m,
      pages: [
        { id: 'p1', name: 'Page A', visuals: [] },
        { id: 'p2', name: 'Page B', visuals: [] },
        { id: 'p3', name: 'Page C', visuals: [] },
      ],
    });
    r.flush();

    expect(r.pageList.map((p) => p.name)).toEqual(['Page A', 'Page B', 'Page C']);

    // Reorder pages
    r.reorderPages(['p3', 'p1', 'p2']);
    expect(r.pageList.map((p) => p.name)).toEqual(['Page C', 'Page A', 'Page B']);

    // Remove page
    const removed = r.removePage('p2');
    expect(removed).toBe(true);
    expect(r.pageList.map((p) => p.name)).toEqual(['Page C', 'Page A']);

    // Cannot remove last page (if single)
    r.removePage('p1');
    expect(r.pageList.length).toBe(1);
    r.removePage(r.pageList[0].id);
    expect(r.pageList.length).toBe(1); // keeps fallback Page 1

    r.destroy();
  });

  it('matches visual dimensions across selection with matchVisualSize', () => {
    const m = new DataModel().addTable('Sales', [{ a: 1 }]);
    const r = new Report(el, {
      model: m,
      pages: [
        {
          id: 'p1',
          name: 'Page 1',
          visuals: [
            { id: 'v1', type: 'card', layout: { x: 0, y: 0, w: 4, h: 6 } },
            { id: 'v2', type: 'card', layout: { x: 4, y: 0, w: 2, h: 3 } },
            { id: 'v3', type: 'card', layout: { x: 6, y: 0, w: 3, h: 4 } },
          ],
        },
      ],
    });
    r.flush();

    // Match width
    r.matchVisualSize('width', ['v1', 'v2', 'v3']);
    r.flush();
    expect(r.visual('v2').spec.layout?.w).toBe(4);
    expect(r.visual('v3').spec.layout?.w).toBe(4);

    // Match height
    r.matchVisualSize('height', ['v1', 'v2', 'v3']);
    r.flush();
    expect(r.visual('v2').spec.layout?.h).toBe(6);
    expect(r.visual('v3').spec.layout?.h).toBe(6);

    r.destroy();
  });
});
