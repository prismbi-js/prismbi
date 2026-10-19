import { describe, expect, it } from 'vitest';
import { Report, createVisual } from '../src/index';
import type { FilterSpec } from '../src/index';
import { makeModel } from './fixtures';

const year = (y: number): FilterSpec => ({ target: 'Date[Year]', op: 'eq', value: y });
const item = (name: string): FilterSpec => ({ target: "'Time Intelligence'[Name]", op: 'eq', value: name });

describe('calculation-item format strings', () => {
  const m = makeModel()
    .addCalculationGroup({
      name: 'Time Intelligence',
      items: [
        { name: 'Current', expression: 'SELECTEDMEASURE()' },
        { name: 'YoY %', expression: 'VAR py = CALCULATE(SELECTEDMEASURE(), SAMEPERIODLASTYEAR(Date[Date])) RETURN DIVIDE(SELECTEDMEASURE() - py, py)', format: '0.0%' },
        { name: 'Labelled', expression: 'SELECTEDMEASURE()', formatExpression: 'SELECTEDMEASUREFORMATSTRING() & " (" & SELECTEDMEASURENAME() & ")"' },
      ],
    });

  it('a single selected item overrides the value format', () => {
    const r = m.query({ values: ['Total Sales'], filters: [year(2025), item('YoY %')] });
    expect(r.values[0].format).toBe('0.0%');
    const plain = m.query({ values: ['Total Sales'], filters: [year(2025), item('Current')] });
    expect(plain.values[0].format).toBe(m.measure('Total Sales').format);
  });

  it('dynamic format expressions see the measure', () => {
    const r = m.query({ values: ['Total Sales'], filters: [item('Labelled')] });
    expect(r.values[0].format).toBe(`${m.measure('Total Sales').format ?? ''} (Total Sales)`);
  });

  it('items as rows get per-row formats, used by tables and matrices', () => {
    const r = m.query({ groupBy: ["'Time Intelligence'[Name]"], values: ['Total Sales'], filters: [year(2025)] });
    const yoy = r.rows.find((x) => x.keys[0] === 'YoY %')!;
    expect(yoy.formats).toEqual(['0.0%']);
    expect(r.rows.find((x) => x.keys[0] === 'Current')!.formats).toBeUndefined();
    const el = document.createElement('div');
    document.body.append(el);
    const t = createVisual(el, { model: m, type: 'table', fields: { columns: ["'Time Intelligence'[Name]", 'Total Sales'] }, filters: [year(2025)] } as never);
    t.flush();
    const cells = [...el.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));
    expect(cells.find((c) => c[0] === 'YoY %')![1]).toMatch(/%$/);
    t.destroy();
    const mx = createVisual(el, { model: m, type: 'matrix', fields: { rows: 'Products[Category]', columns: "'Time Intelligence'[Name]", values: 'Total Sales' }, filters: [year(2025)] } as never);
    mx.flush();
    const head = [...el.querySelectorAll('thead th')].map((th) => th.textContent);
    const yoyCol = head.indexOf('YoY %');
    const firstRow = [...el.querySelector('tbody tr')!.querySelectorAll('th, td')].map((td) => td.textContent);
    expect(firstRow[yoyCol]).toMatch(/%$/);
    expect(firstRow[head.indexOf('Current')]).not.toMatch(/%$/);
    mx.destroy();
    el.remove();
  });
});

describe('keyboard walkthrough', () => {
  const key = (el: Element, k: string, extra: KeyboardEventInit = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
  const mount = (editMode = false) => {
    const el = document.createElement('div');
    el.style.cssText = 'width:1200px;height:800px';
    document.body.append(el);
    const r = new Report(el, {
      model: makeModel(),
      pages: [
        { id: 'p1', name: 'Overview', visuals: [
          { id: 'cat', type: 'clusteredColumn', layout: { x: 0, y: 0, w: 6, h: 6 }, fields: { category: 'Products[Category]', values: 'Total Sales' } },
          { id: 'tbl', type: 'table', layout: { x: 6, y: 0, w: 6, h: 6 }, fields: { columns: ['Products[Category]', 'Total Sales'] } },
        ] },
        { id: 'p2', name: 'Details', visuals: [] },
        { id: 'p3', name: 'Appendix', visuals: [] },
      ],
    });
    if (editMode) r.setEditMode(true);
    r.flush();
    return { el, r };
  };

  it('data points: one tab stop per visual, arrows, Enter, Escape', () => {
    const { el, r } = mount();
    const marks = () => [...el.querySelectorAll<SVGElement>('[data-visual-id="cat"] .pbi-mark, .pbi-visual .pbi-mark')];
    const all = marks();
    expect(all.length).toBeGreaterThan(2);
    expect(all.filter((m) => m.getAttribute('tabindex') === '0')).toHaveLength(1);
    all[0].focus();
    key(all[0], 'ArrowRight');
    expect(document.activeElement).toBe(all[1]);
    expect(all[1].getAttribute('tabindex')).toBe('0');
    expect(all[0].getAttribute('tabindex')).toBe('-1');
    key(all[1], 'End');
    expect(document.activeElement).toBe(all[all.length - 1]);
    key(document.activeElement!, 'Home');
    expect(document.activeElement).toBe(all[0]);
    const selections: unknown[] = [];
    r.on('selectionChanged', (e) => selections.push(e.identities.length));
    key(all[0], 'Enter');
    expect(selections).toEqual([1]);
    // the tab stop survives re-rendering
    r.flush();
    key(r.container.querySelector('.pbi-report')!, 'Escape');
    expect(selections).toEqual([1, 0]);
    r.destroy();
    el.remove();
  });

  it('context menu from the keyboard, with focus returned on Escape', () => {
    const { el, r } = mount();
    const mark = el.querySelector<SVGElement>('.pbi-mark')!;
    mark.focus();
    key(mark, 'F10', { shiftKey: true });
    const menu = el.querySelector<HTMLElement>('.pbi-menu')!;
    expect(menu.hidden).toBe(false);
    const items = [...menu.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
    expect(document.activeElement).toBe(items[0]);
    key(document.activeElement!, 'End');
    expect(document.activeElement).toBe(items[items.length - 1]);
    key(document.activeElement!, 'Escape');
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(mark);
    r.destroy();
    el.remove();
  });

  it('page tabs: roving tabindex and arrow keys', () => {
    const { el, r } = mount();
    const tabs = () => [...el.querySelectorAll<HTMLButtonElement>('.pbi-tab')];
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    tabs()[0].focus();
    key(tabs()[0], 'ArrowRight');
    expect(r.currentPage.name).toBe('Details');
    expect((document.activeElement as HTMLElement).textContent).toBe('Details');
    key(document.activeElement!, 'End');
    expect(r.currentPage.name).toBe('Appendix');
    key(document.activeElement!, 'ArrowRight');
    expect(r.currentPage.name).toBe('Overview');
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    r.destroy();
    el.remove();
  });

  it('table headers sort with Enter', () => {
    const { el, r } = mount();
    const header = () => [...el.querySelectorAll<HTMLElement>('th')].find((x) => x.textContent?.includes('Total Sales'))!;
    const sales = () => [...el.querySelectorAll('tbody tr')].map((tr) => Number(tr.querySelectorAll('td')[1]?.textContent?.replace(/[^\d.-]/g, ''))).filter((n) => !Number.isNaN(n));
    const sorted = (xs: number[], dir: number) => xs.every((x, k) => !k || (x - xs[k - 1]) * dir >= 0);
    key(header(), 'Enter');
    r.flush();
    const once = sales();
    key(header(), 'Enter');
    r.flush();
    const twice = sales();
    expect(once.length).toBeGreaterThan(2);
    // one press sorts one way, the next press the other way
    expect((sorted(once, 1) && sorted(twice, -1)) || (sorted(once, -1) && sorted(twice, 1))).toBe(true);
    expect(once).not.toEqual(twice);
    r.destroy();
    el.remove();
  });

  it('edit mode: arrows move a visual one cell, Shift+arrows resize, focus stays', () => {
    const { el, r } = mount(true);
    const overlay = () => el.querySelector<HTMLElement>('[data-edit-for="cat"]')!;
    overlay().focus();
    expect(r.selectedVisuals).toContain('cat');
    key(overlay(), 'ArrowDown');
    key(overlay(), 'ArrowDown');
    key(overlay(), 'ArrowRight', { shiftKey: true });
    const layout = r.toJSON().pages[0].visuals.find((v) => v.id === 'cat')!.layout!;
    expect(layout).toMatchObject({ x: 0, y: 2, w: 7, h: 6 });
    key(overlay(), 'ArrowLeft');
    expect(r.toJSON().pages[0].visuals.find((v) => v.id === 'cat')!.layout!.x).toBe(0); // clamped at the edge
    expect(document.activeElement).toBe(overlay());
    r.destroy();
    el.remove();
  });
});

describe('animated transitions', () => {
  it('tweens data points from their previous geometry when the data changes', async () => {
    const el = document.createElement('div');
    el.style.cssText = 'width:800px;height:500px';
    document.body.append(el);
    const r = new Report(el, {
      model: makeModel(),
      pages: [{ id: 'p', name: 'P', visuals: [{ id: 'c', type: 'clusteredColumn', layout: { x: 0, y: 0, w: 12, h: 8 }, fields: { category: 'Products[Category]', values: 'Total Sales' }, format: { animation: { enabled: true, duration: 120 } } }] }],
      measure: () => ({ width: 700, height: 400 }),
    });
    r.flush();
    const bars = () => [...el.querySelectorAll<SVGPathElement>('path.pbi-mark')];
    const ds = () => bars().map((b) => b.getAttribute('d'));
    const round = (d: string | null) => d?.replace(/-?\d*\.?\d+/g, (n) => String(+(+n).toFixed(2)));
    const keys = bars().map((b) => b.getAttribute('data-key'));
    const before = ds();
    r.setReportFilters([{ target: 'Date[Year]', op: 'eq', value: 2025 }]);
    r.flush();
    const changed = bars().findIndex((b) => keys.includes(b.getAttribute('data-key')) && b.getAttribute('d') === round(before[keys.indexOf(b.getAttribute('data-key'))]) && b.getAttribute('d') !== before[keys.indexOf(b.getAttribute('data-key'))]);
    expect(changed).toBeGreaterThanOrEqual(0); // a bar that moves starts where it was
    await new Promise((res) => setTimeout(res, 400));
    const after = ds();
    expect(after).not.toEqual(before); // and ends at the new value
    // exporting mid-transition shows the final state
    r.setReportFilters([]);
    r.flush();
    r.visual('c')!.toSvg();
    expect(ds()).toEqual(before);
    r.destroy();
    el.remove();
  });
});

describe('geo upgrades', () => {
  const geoModel = async () => {
    const { DataModel } = await import('../src/index');
    return new DataModel()
      .addTable('Sales', [
        { Country: 'France', City: 'Paris', Lat: 48.86, Lon: 2.35, Amount: 500 },
        { Country: 'Germany', City: 'Berlin', Lat: 52.52, Lon: 13.4, Amount: 300 },
        { Country: 'USA', City: 'New York', Lat: 40.71, Lon: -74.0, Amount: 900 },
        { Country: 'BR', City: 'São Paulo', Lat: -23.55, Lon: -46.63, Amount: 150 },
        { Country: 'Belgium', City: 'Brussels', Lat: 50.85, Lon: 4.35, Amount: 120 },
        { Country: 'Netherlands', City: 'Amsterdam', Lat: 52.37, Lon: 4.9, Amount: 80 },
        { Country: 'Atlantis', City: 'Nowhere', Lat: 0, Lon: 0, Amount: 1 },
      ])
      .addMeasure('Total', 'SUM(Sales[Amount])');
  };
  const host = () => {
    const el = document.createElement('div');
    el.style.cssText = 'width:900px;height:500px';
    document.body.append(el);
    return el;
  };

  it('registers world countries and US states', async () => {
    const { worldCountries, usStates } = await import('@prismbi/prismbi/geo');
    const { getBoundaries, featureCentroid } = await import('../src/index');
    expect(worldCountries.features.length).toBeGreaterThan(170);
    expect(usStates.features).toHaveLength(51);
    expect(getBoundaries('world')).toBe(worldCountries);
    const france = worldCountries.features.find((f) => f.properties?.iso_a3 === 'FRA')!;
    const [lon, lat] = featureCentroid(france)!;
    expect(Math.abs(lon - 2.5)).toBeLessThan(2);
    expect(Math.abs(lat - 46.6)).toBeLessThan(2);
  });

  it('filled maps use built-in boundaries, match names, codes and aliases, and show classed legends', async () => {
    await import('@prismbi/prismbi/geo');
    const el = host();
    const v = createVisual(el, { model: await geoModel(), type: 'filledMap', fields: { location: 'Sales[Country]', values: 'Total' }, format: { map: { boundaries: 'world', legend: 'classes', classes: 3 } } } as never);
    v.flush();
    // France, Germany, USA (alias), BR (ISO code), Belgium, Netherlands match; Atlantis doesn't
    expect(el.querySelectorAll('path.pbi-mark')).toHaveLength(6);
    const legend = [...el.querySelectorAll('.pbi-map-legend text')].map((t) => t.textContent);
    expect(legend).toHaveLength(3);
    expect(legend[0]).toMatch(/^up to /);
    v.destroy();
    el.remove();
  });

  it('bubble maps place bubbles at region centres and cluster nearby ones', async () => {
    await import('@prismbi/prismbi/geo');
    const el = host();
    const model = await geoModel();
    const byCountry = createVisual(el, { model, type: 'map', fields: { location: 'Sales[Country]', size: 'Total' }, format: { map: { boundaries: 'world' } } } as never);
    byCountry.flush();
    expect(el.querySelectorAll('circle.pbi-mark')).toHaveLength(6);
    byCountry.destroy();
    const clustered = createVisual(el, { model, type: 'map', fields: { location: 'Sales[City]', latitude: 'Sales[Lat]', longitude: 'Sales[Lon]', size: 'Total' }, format: { map: { cluster: { radius: 80 } } } } as never);
    clustered.flush();
    const cluster = el.querySelector<SVGGElement>('.pbi-cluster')!;
    expect(cluster).toBeTruthy();
    const count = Number(cluster.querySelector('text')!.textContent);
    expect(count).toBeGreaterThanOrEqual(3); // Paris, Brussels, Amsterdam (and Berlin) sit close together
    expect(cluster.getAttribute('aria-label')).toMatch(/locations: .*Press Enter to zoom in/);
    const before = el.querySelectorAll('.pbi-cluster').length + el.querySelectorAll('circle.pbi-mark').length;
    // each Enter zooms in 2.5x around the cluster; keep zooming until it splits
    for (let i = 0; i < 4 && el.querySelector('.pbi-cluster'); i++) {
      el.querySelector('.pbi-cluster')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      clustered.flush();
    }
    const after = el.querySelectorAll('.pbi-cluster').length + el.querySelectorAll('circle.pbi-mark').length;
    expect(after).toBeGreaterThan(before); // zooming in splits the cluster
    clustered.destroy();
    el.remove();
  });

  it('quantile breaks and clustering helpers', async () => {
    const { quantileBreaks, clusterPoints } = await import('../src/index');
    expect(quantileBreaks([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5)).toEqual([2, 4, 6, 8, 10]);
    expect(quantileBreaks([5, 5, 5], 4)).toEqual([5]);
    const groups = clusterPoints([{ i: 0, x: 0, y: 0, size: 5 }, { i: 1, x: 10, y: 0, size: 1 }, { i: 2, x: 100, y: 0, size: 2 }], 20);
    expect(groups.map((g) => g.map((p) => p.i))).toEqual([[0, 1], [2]]);
  });
});

describe('NATURALINNERJOIN, NATURALLEFTOUTERJOIN and SAMPLE', () => {
  const m = makeModel();
  it('joins on common columns', () => {
    const inner = m.evaluateTable('NATURALINNERJOIN(SUMMARIZE(Sales, Products[Category], "Sales", [Total Sales]), DATATABLE("Category", STRING, "Target", INTEGER, {{"Bikes", 100}, {"Nope", 1}}))');
    expect(inner.columns).toEqual(['Category', 'Sales', 'Target']);
    expect(inner.rows).toHaveLength(1);
    expect(inner.rows[0][0]).toBe('Bikes');
    expect(inner.rows[0][2]).toBe(100);
    const left = m.evaluateTable('NATURALLEFTOUTERJOIN(VALUES(Products[Category]), DATATABLE("Category", STRING, "Target", INTEGER, {{"Bikes", 100}}))');
    expect(left.rows.length).toBe(m.table('Products').distinct('Category').length);
    expect(left.rows.filter((r) => r[1] === null).length).toBe(left.rows.length - 1);
    expect(() => m.evaluateTable('NATURALINNERJOIN(VALUES(Products[Category]), VALUES(Region[Name]))')).toThrow(/no common columns/);
  });

  it('samples evenly with first and last rows', () => {
    const all = m.evaluateTable('VALUES(Sales[OrderId])').rows.length;
    const s = m.evaluateTable('SAMPLE(3, VALUES(Sales[OrderId]), Sales[OrderId], ASC)');
    expect(s.rows.map((r) => r[0])).toEqual([1, Math.round((all - 1) / 2) + 1, all]);
    expect(m.evaluateTable('SAMPLE(100, VALUES(Sales[OrderId]), Sales[OrderId])').rows).toHaveLength(all);
    expect(m.evaluateTable('SAMPLE(0, VALUES(Sales[OrderId]), Sales[OrderId])').rows).toHaveLength(0);
    expect(m.evaluate('COUNTROWS(SAMPLE(2, Sales, Sales[Amount], DESC))')).toBe(2);
  });
});

describe('bitmap indexes', () => {
  it('give the same results as row lists on a large table, and stay correct after appends', async () => {
    const { DataModel, setBitmapIndexes } = await import('../src/index');
    const regions = ['North', 'South', 'East', 'West'];
    const channels = ['Online', 'Store', 'Reseller'];
    const rows = Array.from({ length: 20_000 }, (_, i) => ({ id: i, region: regions[i % 4], channel: channels[(i * 7) % 3], cat: (i * 13) % 9, amount: (i % 100) + 1 }));
    const build = () => new DataModel()
      .addTable('Sales', rows)
      .addTable('Cat', Array.from({ length: 9 }, (_, k) => ({ cat: k, group: k < 4 ? 'A' : 'B' })))
      .addRelationship({ from: 'Sales[cat]', to: 'Cat[cat]' })
      .addMeasure('Total', 'SUM(Sales[amount])')
      .addMeasure('N', 'COUNTROWS(Sales)');
    const m = build();
    const spec = {
      groupBy: ['Sales[channel]'],
      values: ['Total', 'N'],
      filters: [
        { target: 'Sales[region]', op: 'in' as const, values: ['North', 'East'] },
        { target: 'Cat[group]', op: 'eq' as const, value: 'A' },
      ],
    };
    const t = m.table('Sales');
    expect(t.bitmap('region')!.size).toBe(4);
    expect(t.bitmap('id')).toBeNull(); // too many distinct values
    try {
      // separate models, so nothing is answered from a cache
      setBitmapIndexes(false);
      const lists = build().query(spec);
      setBitmapIndexes(true);
      const withBits = m.query(spec);
      expect(withBits.rows).toEqual(lists.rows);
      expect(withBits.rows.reduce((n, r) => n + (r.values[1] as number), 0)).toBe(rows.filter((r) => (r.region === 'North' || r.region === 'East') && r.cat < 4).length);
      m.appendRows('Sales', [{ id: 99_999, region: 'North', channel: 'Online', cat: 0, amount: 1000 }]);
      const after = m.query({ values: ['Total'], filters: [{ target: 'Sales[region]', op: 'eq', value: 'North' }] });
      expect(after.rows[0].values[0]).toBe(rows.filter((r) => r.region === 'North').reduce((n, r) => n + r.amount, 0) + 1000);
    } finally {
      setBitmapIndexes(true);
    }
  });
});

describe('scatter renderers', () => {
  it('falls back from WebGL to canvas to SVG, and honours renderer: svg', async () => {
    const { DataModel } = await import('../src/index');
    const rows = Array.from({ length: 4000 }, (_, i) => ({ id: i, x: i % 97, y: (i * 7) % 89 }));
    const m = new DataModel().addTable('T', rows).addMeasure('X', 'SUM(T[x])').addMeasure('Y', 'SUM(T[y])');
    const el = document.createElement('div');
    document.body.append(el);
    // a browser without WebGL or a 2D canvas returns null from getContext; the scatter still renders, as SVG
    // (stubbed because jsdom throws a noisy "not implemented" instead)
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const v = createVisual(el, { id: 'sc', model: m, type: 'scatter', fields: { details: 'T[id]', x: 'X', y: 'Y' }, format: { scatter: { renderer: 'webgl' } } } as never);
    v.flush();
    expect(el.querySelector('.pbi-error')).toBeNull();
    expect(el.querySelectorAll('circle.pbi-mark').length).toBe(4000);
    v.visual('sc')!.update({ format: { scatter: { renderer: 'svg' } } } as never);
    v.flush();
    expect(el.querySelectorAll('circle.pbi-mark').length).toBe(4000);
    v.destroy();
    el.remove();
    getContext.mockRestore();
  });
});
