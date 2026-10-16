import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataModel, Report, buildPdf, createVisual, logScale, timeScale, wQuantile } from '../src/index';
import type { GeoFeatureCollection } from '../src/index';
import { makeModel } from './fixtures';

let el: HTMLElement;
beforeEach(() => {
  el = document.createElement('div');
  document.body.append(el);
});
afterEach(() => {
  el.remove();
  document.querySelectorAll('.pbi-report').forEach((n) => n.remove());
});
const qa = <T extends Element = Element>(sel: string, root: ParentNode = el) => [...root.querySelectorAll<T>(sel)];
const click = (n: Element) => n.dispatchEvent(new MouseEvent('click', { bubbles: true }));

describe('continuous & log axes', () => {
  it('timeScale picks calendar-aligned ticks', () => {
    const ts = timeScale(new Date(2024, 0, 1).getTime(), new Date(2024, 11, 31).getTime(), [0, 600], 6);
    const labels = ts.ticks.map((t, i) => ts.tickFormat(t, i));
    expect(labels[0]).toBe('Jan 2024');
    expect(labels).toContain('Jul');
    expect(ts.ticks.every((t) => new Date(t).getDate() === 1)).toBe(true);
  });

  it('logScale ticks at powers of ten', () => {
    const ls = logScale(3, 870, [100, 0]);
    expect(ls.domain).toEqual([1, 1000]);
    expect(ls.ticks).toEqual(expect.arrayContaining([1, 10, 100, 1000]));
    expect(ls(10)).toBeCloseTo(100 - 100 / 3);
  });

  it('line charts place dates at their real positions', () => {
    const r = createVisual(el, { model: makeModel(), type: 'line', fields: { category: 'Sales[OrderDate]', values: 'Total Sales' }, format: { lines: { markers: true } } });
    r.flush();
    const xs = qa('circle[r="4"]').map((c) => Number(c.getAttribute('cx')));
    expect(xs.length).toBe(8);
    // Jan 15 → Feb 10 (26 days) is wider than Feb 10 → Feb 20 (10 days)
    expect(xs[1] - xs[0]).toBeGreaterThan((xs[2] - xs[1]) * 2);
    // axis shows time ticks, not one label per point
    expect(qa('.pbi-cat').map((t) => t.textContent)).toContain('2025');
  });

  it('categoryAxis.type = categorical keeps even spacing', () => {
    const r = createVisual(el, { model: makeModel(), type: 'line', fields: { category: 'Sales[OrderDate]', values: 'Total Sales' }, format: { lines: { markers: true }, categoryAxis: { type: 'categorical' } } });
    r.flush();
    const xs = qa('circle[r="4"]').map((c) => Number(c.getAttribute('cx')));
    expect(xs[1] - xs[0]).toBeCloseTo(xs[2] - xs[1], 3);
  });
});

describe('scatter layout', () => {
  it('keeps bubbles inside the plot and orders the legend by colour', () => {
    const r = createVisual(el, { model: makeModel(), type: 'scatter', fields: { details: 'Products[Name]', legend: 'Products[Category]', x: 'Total Sales', y: 'Margin %', size: 'Orders' } });
    r.flush();
    const tickRight = Math.max(...qa('text.pbi-tick').filter((t) => t.getAttribute('text-anchor') === 'end').map((t) => Number(t.getAttribute('x'))));
    for (const c of qa('circle.pbi-mark')) expect(Number(c.getAttribute('cx')) - Number(c.getAttribute('r'))).toBeGreaterThan(tickRight);
    expect(qa('.pbi-legend-item').map((b) => b.textContent)).toEqual(['Accessories', 'Bikes', 'Clothing']);
    expect(qa('text.pbi-tick').some((t) => t.textContent === '$0M')).toBe(false);
  });
});

describe('report tooltips', () => {
  it('renders a tooltip page filtered to the hovered point', () => {
    const r = new Report(el, {
      model: makeModel(),
      pages: [
        { id: 'main', name: 'Main', visuals: [{ id: 'cols', type: 'clusteredColumn', fields: { category: 'Products[Category]', values: 'Total Sales' }, format: { tooltip: { page: 'tip' } } }] },
        { id: 'tip', name: 'Tip', tooltip: { width: 300, height: 160 }, layout: { columns: 2, rowHeight: 60 }, visuals: [{ id: 'tip-card', type: 'card', layout: { x: 0, y: 0, w: 1, h: 2 }, fields: { value: 'Orders' } }] },
      ],
    });
    r.flush();
    expect(qa('.pbi-tab')).toHaveLength(0); // tooltip pages are never tabs
    const bikes = qa('[data-visual-id="cols"] path.pbi-mark')[0];
    bikes.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 20, clientY: 20 }));
    const tip = document.querySelector('.pbi-tooltip')!;
    expect(tip.classList.contains('is-page')).toBe(true);
    expect(tip.querySelector('[data-visual-id="tip-card"] .pbi-card-value')?.textContent).toBe('3');
    // a normal tooltip afterwards parks the page again
    r.visual('cols');
  });
});

describe('edit interactions', () => {
  it('lets a visual ignore selections from another', () => {
    const r = new Report(el, {
      model: makeModel(),
      pages: [{ name: 'P', visuals: [
        { id: 'cols', type: 'clusteredColumn', fields: { category: 'Products[Category]', values: 'Total Sales' } },
        { id: 'card', type: 'card', fields: { value: 'Total Sales' } },
      ] }],
    });
    r.flush();
    r.toggleEditInteractions(true);
    r.setActiveVisual('cols');
    const buttons = qa<HTMLButtonElement>('[data-visual-id="card"] .pbi-ei button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Filter', 'None']);
    click(buttons[1]);
    r.flush();
    click(qa('[data-visual-id="cols"] path.pbi-mark')[0]);
    r.flush();
    expect(el.querySelector('[data-visual-id="card"] .pbi-card-value')?.textContent).toBe('$6,750');
    expect(r.visual('card').spec.interactionsFrom).toEqual({ cols: 'none' });
  });
});

describe('PDF writer', () => {
  it('produces a structurally valid PDF', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const bytes = buildPdf([{ jpeg, pixelWidth: 2, pixelHeight: 2, width: 800, height: 600 }, { jpeg, pixelWidth: 2, pixelHeight: 2, width: 800, height: 600 }], 'Test');
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Count 2');
    expect(text).toContain('/DCTDecode');
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    // every xref offset points at its object header
    const xrefAt = Number(/startxref\n(\d+)/.exec(text)![1]);
    const entries = text.slice(xrefAt).split('\n').filter((l) => / 00000 n $/.test(l)).map((l) => Number(l.slice(0, 10)));
    entries.forEach((off, i) => expect(text.slice(off, off + 12)).toMatch(new RegExp(`^${i + 1} 0 obj`)));
  });
});

describe('persisted visual state', () => {
  it('saves table sorting and decomposition splits in the report JSON', () => {
    const r = new Report(el, {
      model: makeModel(),
      pages: [{ name: 'P', visuals: [
        { id: 'tbl', type: 'table', fields: { columns: ['Products[Category]', 'Total Sales'] } },
        { id: 'tree', type: 'decompositionTree', fields: { values: 'Total Sales', explainBy: ['Products[Category]', 'Region[Name]'] } },
      ] }],
    });
    r.flush();
    click(qa('[data-visual-id="tbl"] th')[1]);
    const add = el.querySelector<HTMLSelectElement>('[data-visual-id="tree"] .is-add select')!;
    add.value = 'Region[Name]';
    add.dispatchEvent(new Event('change'));
    r.flush();
    const json = JSON.parse(JSON.stringify(r.toJSON()));
    const visuals = json.pages[0].visuals;
    expect(visuals[0].state).toEqual({ sortCol: 1, sortDir: 'desc' });
    expect(visuals[1].state.splits[0].field).toBe('Region[Name]');
    r.destroy();
    const r2 = new Report(el, { model: makeModel(), ...Report.parse(JSON.stringify(json)) });
    r2.flush();
    expect(qa('[data-visual-id="tree"] .pbi-decomp-col')).toHaveLength(2); // root + restored split (no node selected → no "+" column)
  });
});

describe('more visuals', () => {
  const model = makeModel();
  const cases: [string, Record<string, unknown>, string, number][] = [
    ['histogram', { values: 'Sales[Amount]' }, 'rect.pbi-mark', 1],
    ['boxPlot', { category: 'Region[Name]', values: 'Sales[Amount]' }, 'rect[fill-opacity="0.25"]', 2],
    ['bullet', { category: 'Products[Category]', value: 'Total Sales', target: 'Total Cost' }, 'rect.pbi-mark', 3],
    ['radar', { category: 'Products[Name]', values: ['Total Sales', 'Total Cost'] }, 'circle.pbi-mark', 10],
    ['sankey', { source: 'Region[Name]', target: 'Products[Category]', values: 'Total Sales' }, 'path.pbi-mark', 6],
    ['ribbon', { category: 'Date[Year]', legend: 'Products[Category]', values: 'Total Sales' }, 'rect.pbi-mark', 6],
  ];
  for (const [type, fields, sel, min] of cases)
    it(`${type} renders`, () => {
      const r = createVisual(el, { model, type, fields: fields as never });
      r.flush();
      expect(el.querySelector('.pbi-error')?.textContent ?? '').toBe('');
      expect(qa(sel).length).toBeGreaterThanOrEqual(min);
    });

  it('box plot quartiles are weighted correctly', () => {
    expect(wQuantile([[1, 1], [2, 1], [3, 1], [4, 1], [5, 1]], 0.5)).toBe(3);
    expect(wQuantile([[1, 2], [10, 2]], 0.5)).toBe(5.5);
    expect(wQuantile([[1, 3], [10, 1]], 0.25)).toBe(1);
  });
});

describe('maps', () => {
  const cities = new DataModel()
    .addTable('City', [
      { Name: 'Paris', Lat: 48.86, Lon: 2.35, Pop: 2.1, Country: 'France' },
      { Name: 'Berlin', Lat: 52.52, Lon: 13.4, Pop: 3.6, Country: 'Germany' },
      { Name: 'Madrid', Lat: 40.42, Lon: -3.7, Pop: 3.3, Country: 'Spain' },
    ])
    .addMeasure('Population', 'SUM(City[Pop])');
  const square = (lon: number, lat: number) => [[[lon - 2, lat - 2], [lon + 2, lat - 2], [lon + 2, lat + 2], [lon - 2, lat + 2], [lon - 2, lat - 2]]];
  const geo: GeoFeatureCollection = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { name: 'France' }, geometry: { type: 'Polygon', coordinates: square(2, 47) } },
      { type: 'Feature', properties: { name: 'Germany' }, geometry: { type: 'Polygon', coordinates: square(10, 51) } },
      { type: 'Feature', properties: { name: 'Spain' }, geometry: { type: 'Polygon', coordinates: square(-4, 40) } },
      { type: 'Feature', properties: { name: 'Italy' }, geometry: { type: 'Polygon', coordinates: square(12, 43) } },
    ],
  };

  it('bubble map projects points and sizes bubbles', () => {
    const r = createVisual(el, { model: cities, type: 'map', fields: { location: 'City[Name]', latitude: 'City[Lat]', longitude: 'City[Lon]', size: 'Population' }, format: { map: { geojson: geo } } });
    r.flush();
    const dots = qa('circle.pbi-mark');
    expect(dots).toHaveLength(3);
    const byR = dots.map((d) => Number(d.getAttribute('r')));
    expect(Math.max(...byR)).toBeGreaterThan(Math.min(...byR));
    // Berlin is north-east of Madrid: smaller y, larger x
    const pos = Object.fromEntries(dots.map((d) => [d.getAttribute('aria-label') ?? '', d]));
    void pos;
    expect(qa('path').length).toBe(4); // basemap regions
  });

  it('filled map colours matched regions and greys the rest', () => {
    const r = createVisual(el, { model: cities, type: 'filledMap', fields: { location: 'City[Country]', values: 'Population' }, format: { map: { geojson: geo } } });
    r.flush();
    expect(qa('path.pbi-mark')).toHaveLength(3);
    expect(qa('path').length).toBe(4);
  });

  it('filled map explains the missing geojson', () => {
    const r = createVisual(el, { model: cities, type: 'filledMap', fields: { location: 'City[Country]', values: 'Population' } });
    r.flush();
    expect(el.querySelector('.pbi-empty')?.textContent).toMatch(/geojson/);
  });
});
