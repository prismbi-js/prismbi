import { describe, expect, it } from 'vitest';
import { createVisual } from '../src/index';
import { buildModel } from '../examples/model';

const model = buildModel();
const by = (q: ReturnType<typeof model.query>, col: number) => q.rows.map((r) => r.values[col]);

describe('visual calculations', () => {
  it('computes window functions over the visual rows in display order', () => {
    const q = model.query({
      groupBy: ['Date[MonthNumber]'],
      values: [
        'Total Sales',
        { name: 'Running', visualCalc: 'RUNNINGSUM([Total Sales])' },
        { name: 'vs previous', visualCalc: '[Total Sales] - PREVIOUS([Total Sales])' },
        { name: 'Avg 3', visualCalc: 'MOVINGAVERAGE([Total Sales], 3)' },
        { name: 'Share', visualCalc: 'PERCENTOFTOTAL([Total Sales])', format: '0.0%' },
        { name: 'Rank', visualCalc: 'RANK([Total Sales])' },
        { name: 'Row', visualCalc: 'ROWNUMBER()' },
      ],
      filters: [{ target: 'Date[Year]', op: 'eq', value: 2025 }],
      totals: true,
    });
    const sales = by(q, 0) as number[];
    expect(q.values.map((v) => v.name)).toEqual(['Total Sales', 'Running', 'vs previous', 'Avg 3', 'Share', 'Rank', 'Row']);
    expect(by(q, 1)).toEqual(sales.map((_, i) => sales.slice(0, i + 1).reduce((a, b) => a + b, 0)).map((x) => expect.closeTo(x, 6)));
    expect(by(q, 2)[0]).toBe(sales[0]); // no previous row: BLANK subtracts as 0
    expect(by(q, 2)[1]).toBeCloseTo(sales[1] - sales[0], 6);
    expect(by(q, 3)[2]).toBeCloseTo((sales[0] + sales[1] + sales[2]) / 3, 6);
    expect((by(q, 4) as number[]).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(by(q, 5)[sales.indexOf(Math.max(...sales))]).toBe(1);
    expect(by(q, 6)).toEqual(sales.map((_, i) => i + 1));
    expect(q.values[4].format).toBe('0.0%');
    expect(q.totals![4]).toBe(1);
  });

  it('follows sorting and Top N, and restarts per parent group', () => {
    const q = model.query({ groupBy: ['Product[Category]'], values: ['Total Sales', { name: 'Running', visualCalc: 'RUNNINGSUM([Total Sales])' }], orderBy: [{ field: 'Total Sales', direction: 'desc' }], top: 2 });
    expect(q.rows).toHaveLength(2);
    expect(q.rows[1].values[1]).toBeCloseTo((q.rows[0].values[0] as number) + (q.rows[1].values[0] as number), 6);
    const nested = model.query({ groupBy: ['Date[Year]', 'Date[MonthNumber]'], values: ['Total Sales', { name: 'YTD', visualCalc: 'RUNNINGSUM([Total Sales])', reset: 'parent' }] });
    const jan2025 = nested.rows.find((r) => r.keys[0] === 2025 && r.keys[1] === 1)!;
    expect(jan2025.values[1]).toBe(jan2025.values[0]); // restarted for the new year
    expect(() => model.query({ groupBy: ['Product[Category]'], values: ['Total Sales', { visualCalc: 'RUNNINGSUM([Nope])' }] })).toThrow(/\[Nope\]/);
  });

  it('works in visuals through field wells', () => {
    const el = document.createElement('div');
    el.style.height = '400px';
    document.body.append(el);
    const r = createVisual(el, { model, type: 'line', fields: { category: 'Date[MonthYear]', values: ['Total Sales', { name: 'Running total', visualCalc: 'RUNNINGSUM([Total Sales])' }] } });
    r.flush();
    expect(el.querySelector('.pbi-error')).toBeNull();
    expect(el.querySelectorAll('path.pbi-line')).toHaveLength(2);
    expect(el.textContent).toContain('Running total');
    r.destroy();
    el.remove();
  });
});

describe('DAX window functions', () => {
  const m = buildModel()
    .addMeasure('Prev Year Sales', 'CALCULATE([Total Sales], OFFSET(-1, ALLSELECTED(Date[Year]), ORDERBY(Date[Year])))')
    .addMeasure('First Year Sales', 'CALCULATE([Total Sales], INDEX(1, ALLSELECTED(Date[Year]), ORDERBY(Date[Year])))')
    .addMeasure('Running Months', 'CALCULATE([Total Sales], WINDOW(1, ABS, 0, REL, ALLSELECTED(Date[MonthNumber]), ORDERBY(Date[MonthNumber])))')
    .addMeasure('Moving 3', 'AVERAGEX(WINDOW(-2, REL, 0, REL, ALLSELECTED(Date[MonthNumber]), ORDERBY(Date[MonthNumber])), [Total Sales])')
    .addMeasure('Category Rank', 'RANK(DENSE, ALLSELECTED(Product[Category]), ORDERBY([Total Sales], DESC))')
    .addMeasure('Row In Year', 'ROWNUMBER(ALLSELECTED(Date[Year], Date[MonthNumber]), ORDERBY(Date[MonthNumber]), PARTITIONBY(Date[Year]))');

  it('OFFSET and INDEX pick neighbouring and absolute rows', () => {
    const q = m.query({ groupBy: ['Date[Year]'], values: ['Total Sales', 'Prev Year Sales', 'First Year Sales'] });
    const [y2024, y2025] = q.rows;
    expect(y2024.values[1]).toBeNull();
    expect(y2025.values[1]).toBe(y2024.values[0]);
    expect(y2025.values[2]).toBe(y2024.values[0]);
  });

  it('WINDOW gives running and moving aggregates that match visual calculations', () => {
    const q = m.query({
      groupBy: ['Date[MonthNumber]'],
      values: ['Total Sales', 'Running Months', 'Moving 3', { name: 'vc', visualCalc: 'RUNNINGSUM([Total Sales])' }, { name: 'vm', visualCalc: 'MOVINGAVERAGE([Total Sales], 3)' }],
      filters: [{ target: 'Date[Year]', op: 'eq', value: 2025 }],
    });
    for (const r of q.rows) {
      expect(r.values[1]).toBeCloseTo(r.values[3] as number, 6);
      expect(r.values[2]).toBeCloseTo(r.values[4] as number, 6);
    }
  });

  it('RANK and ROWNUMBER with measures in ORDERBY and partitions', () => {
    const q = m.query({ groupBy: ['Product[Category]'], values: ['Total Sales', 'Category Rank'], orderBy: [{ field: 'Total Sales', direction: 'desc' }] });
    expect(q.rows.map((r) => r.values[1])).toEqual([1, 2, 3, 4]);
    const months = m.query({ groupBy: ['Date[Year]', 'Date[MonthNumber]'], values: ['Row In Year'] });
    const mar2025 = months.rows.find((r) => r.keys[0] === 2025 && r.keys[1] === 3)!;
    expect(mar2025.values[0]).toBe(3);
    expect(() => m.evaluate('ORDERBY(Date[Year])')).toThrow(/only be used inside/);
  });
});

describe('transform steps', () => {
  const raw = [
    { Order: 'A-1', Customer: '  ana lopez ', Region: 'North', Q1: 10, Q2: 12, Date: '2025-01-05', Amount: '1,200' },
    { Order: 'A-2', Customer: 'ben ito', Region: '', Q1: 5, Q2: null, Date: '2025-02-10', Amount: '300' },
    { Order: 'A-3', Customer: 'cara day', Region: 'South', Q1: 7, Q2: 9, Date: '2025-02-11', Amount: 'n/a' },
    { Order: 'A-3', Customer: 'cara day', Region: 'South', Q1: 7, Q2: 9, Date: '2025-02-11', Amount: 'n/a' },
  ];

  it('cleans, reshapes and aggregates like Power Query', async () => {
    const { applySteps, describeStep } = await import('../src/index');
    const clean = applySteps(raw, [
      { op: 'removeDuplicates' },
      { op: 'transformText', columns: ['Customer'], fn: 'clean' },
      { op: 'transformText', columns: ['Customer'], fn: 'title' },
      { op: 'fillDown', columns: ['Region'] },
      { op: 'changeType', column: 'Amount', type: 'number' },
      { op: 'changeType', column: 'Date', type: 'date' },
      { op: 'splitColumn', column: 'Order', delimiter: '-', into: ['Series', 'Number'] },
      { op: 'renameColumns', names: { Customer: 'Name' } },
      { op: 'addColumn', name: 'Label', template: '{Name} ({Region})' },
    ]);
    expect(clean).toHaveLength(3);
    expect(clean[0]).toMatchObject({ Name: 'Ana Lopez', Series: 'A', Number: '1', Amount: 1200, Label: 'Ana Lopez (North)' });
    expect(clean[1].Region).toBe('North'); // filled down
    expect(clean[2].Amount).toBeNull(); // "n/a" is not a number
    expect(clean[0].Date).toBeInstanceOf(Date);
    const long = applySteps(clean, [{ op: 'keepColumns', columns: ['Name', 'Q1', 'Q2'] }, { op: 'unpivot', columns: ['Q1', 'Q2'], attribute: 'Quarter', value: 'Units' }]);
    expect(long).toHaveLength(5); // Ben's blank Q2 is dropped
    const wide = applySteps(long, [{ op: 'pivot', attribute: 'Quarter', value: 'Units' }]);
    expect(wide.find((r) => r.Name === 'Cara Day')).toEqual({ Name: 'Cara Day', Q1: 7, Q2: 9 });
    const grouped = applySteps(clean, [{ op: 'groupBy', by: ['Region'], aggregations: [{ name: 'Orders', agg: 'count' }, { name: 'Units', column: 'Q1', agg: 'sum' }] }, { op: 'sort', by: [{ column: 'Units', desc: true }] }]);
    expect(grouped).toEqual([{ Region: 'North', Orders: 2, Units: 15 }, { Region: 'South', Orders: 1, Units: 7 }]);
    const joined = applySteps(clean, [{ op: 'merge', with: 'Regions', on: [['Region', 'Code']], columns: ['Manager'] }, { op: 'filterRows', column: 'Manager', test: 'notBlank' }], { lookup: () => [{ Code: 'North', Manager: 'Dee' }] });
    expect(joined.map((r) => r.Manager)).toEqual(['Dee', 'Dee']);
    expect(() => applySteps(clean, [{ op: 'append', with: 'Nope' }])).toThrow(/Step 1 \(append\)/);
    expect(describeStep({ op: 'groupBy', by: ['Region'], aggregations: [{ name: 'Orders', agg: 'count' }] })).toBe('Group by Region: Orders = count');
  });

  it('replays steps on refresh and append, and stores them with the model', async () => {
    const { DataModel } = await import('../src/index');
    const m = new DataModel().addTable('Sales', raw).addMeasure('Units', 'SUM(Sales[Q1])');
    m.transformTable('Sales', [
      { op: 'removeDuplicates' },
      { op: 'filterRows', column: 'Region', test: 'notBlank' },
      { op: 'changeType', column: 'Amount', type: 'number' },
    ]);
    expect(m.table('Sales').rowCount).toBe(2);
    expect(m.table('Sales').column('Amount').type).toBe('number');
    expect(m.evaluate('[Units]')).toBe(17);
    // appended rows go through the (row-local) steps
    m.appendRows('Sales', [{ Order: 'B-1', Customer: 'x', Region: '', Q1: 100 }, { Order: 'B-2', Customer: 'y', Region: 'East', Q1: 1, Amount: '50' }]);
    expect(m.evaluate('[Units]')).toBe(18);
    // a whole-table step re-runs over the full source
    m.transformTable('Sales', [...m.transformsOf('Sales')!, { op: 'keepTop', n: 1 }]);
    m.appendRows('Sales', [{ Order: 'C-1', Customer: 'z', Region: 'West', Q1: 3 }]);
    expect(m.table('Sales').rowCount).toBe(1);
    expect(m.sourceRowsOf('Sales')).toHaveLength(7);
    expect(m.toJSON().transforms.Sales).toHaveLength(4);
    // refresh treats rows as the new source
    m.refreshTable('Sales', [{ Order: 'Z', Customer: 'q', Region: 'R', Q1: 2, Amount: '7' }]);
    expect(m.table('Sales').column('Amount').values).toEqual([7]);
    // clearing restores the source
    m.transformTable('Sales', []);
    expect(m.transformsOf('Sales')).toBeUndefined();
    expect(m.table('Sales').column('Amount').values).toEqual(['7']);
  });
});

describe('studio transforms', () => {
  it('persists steps in the studio document and re-applies them on load', async () => {
    const { Studio } = await import('../src/studio');
    const { makeModel } = await import('./fixtures');
    const el = document.createElement('div');
    el.style.height = '700px';
    document.body.append(el);
    const model = makeModel();
    const studio = new Studio(el, { model });
    const table = model.tableNames().find((t) => model.table(t).rowCount > 3)!;
    const before = model.table(table).rowCount;
    model.transformTable(table, [{ op: 'keepTop', n: 2 }]);
    (studio as unknown as { commit(): void }).commit();
    const doc = studio.document;
    expect(doc.model.transforms?.[table]).toEqual([{ op: 'keepTop', n: 2 }]);
    // a fresh studio on a fresh model applies the saved steps
    const el2 = document.createElement('div');
    el2.style.height = '700px';
    document.body.append(el2);
    const model2 = makeModel();
    const studio2 = new Studio(el2, { model: model2 });
    studio2.load(doc);
    expect(model2.table(table).rowCount).toBe(2);
    // loading a document without transforms restores the source rows
    studio2.load({ ...doc, model: { ...doc.model, transforms: undefined } });
    expect(model2.table(table).rowCount).toBe(before);
    studio.destroy();
    studio2.destroy();
    el.remove();
    el2.remove();
  });
});

describe('phone layouts', () => {
  it('generates, applies, edits and saves a phone layout', async () => {
    const { Report, autoMobileLayout } = await import('../src/index');
    const { makeModel } = await import('./fixtures');
    const page = {
      id: 'p',
      name: 'P',
      visuals: [
        { id: 'k1', type: 'card', layout: { x: 0, y: 0, w: 3, h: 3 }, fields: { value: 'Total Sales' } },
        { id: 'k2', type: 'card', layout: { x: 3, y: 0, w: 3, h: 3 }, fields: { value: 'Orders' } },
        { id: 'chart', type: 'clusteredColumn', layout: { x: 0, y: 3, w: 12, h: 7 }, fields: { category: 'Products[Category]', values: 'Total Sales' } },
        { id: 'tbl', type: 'table', layout: { x: 6, y: 0, w: 6, h: 3 }, fields: { columns: ['Products[Category]', 'Total Sales'] } },
      ],
    };
    // reading order, two cards on one row share it
    const auto = autoMobileLayout(page as never);
    expect(auto.visuals.map((v) => v.id)).toEqual(['k1', 'k2', 'tbl', 'chart']);
    expect(auto.visuals[0].layout).toEqual({ x: 0, y: 0, w: 2, h: 3 });
    expect(auto.visuals[1].layout).toEqual({ x: 2, y: 0, w: 2, h: 3 });

    const el = document.createElement('div');
    el.style.height = '700px';
    document.body.append(el);
    const r = new Report(el, { model: makeModel(), pages: [page as never], layoutMode: 'mobile' });
    r.flush();
    const pageEl = el.querySelector('.pbi-page') as HTMLElement;
    expect(r.isMobileLayout).toBe(true);
    expect(pageEl.classList.contains('is-mobile')).toBe(true);
    expect(pageEl.style.getPropertyValue('--pbi-cols')).toBe('4');
    const chart = el.querySelector('[data-visual-id="chart"]') as HTMLElement;
    expect(chart.style.getPropertyValue('--w')).toBe('4');
    // hide the table on phones, move the chart, and check the definition
    r.setMobileVisibility('tbl', false);
    expect(el.querySelector('[data-visual-id="tbl"]')!.classList.contains('is-phone-hidden')).toBe(true);
    r.setMobileLayout('chart', { x: 0, y: 3, w: 4, h: 9 });
    expect(chart.style.getPropertyValue('--h')).toBe('9');
    const def = r.toJSON().pages[0];
    expect(def.mobile?.visuals.map((v) => v.id)).toEqual(['k1', 'k2', 'chart']);
    // desktop mode keeps the desktop layout
    r.setLayoutMode('desktop');
    expect(r.isMobileLayout).toBe(false);
    expect(chart.style.getPropertyValue('--w')).toBe('12');
    expect(el.querySelector('[data-visual-id="tbl"]')!.classList.contains('is-phone-hidden')).toBe(false);
    r.destroy();
    el.remove();
  });
});

describe('multi-select editing', () => {
  const setup = async () => {
    const { Report } = await import('../src/index');
    const { makeModel } = await import('./fixtures');
    const el = document.createElement('div');
    el.style.height = '700px';
    document.body.append(el);
    const r = new Report(el, {
      model: makeModel(),
      pages: [
        {
          id: 'p',
          name: 'P',
          visuals: [
            { id: 'a', type: 'card', layout: { x: 0, y: 0, w: 2, h: 2 }, fields: { value: 'Total Sales' } },
            { id: 'b', type: 'card', layout: { x: 4, y: 1, w: 3, h: 2 }, fields: { value: 'Orders' } },
            { id: 'c', type: 'card', layout: { x: 9, y: 3, w: 2, h: 2 }, fields: { value: 'Total Cost' } },
          ],
        },
      ],
    });
    r.setEditMode(true);
    r.flush();
    const layout = (id: string) => r.pageDefinition().visuals.find((v) => v.id === id)!.layout!;
    return { el, r, layout };
  };

  it('selects several visuals, aligns, distributes, groups and orders them', async () => {
    const { el, r, layout } = await setup();
    let changes = 0;
    r.on('definitionChanged', () => changes++);
    r.setActiveVisual('a');
    r.toggleVisualSelection('b');
    r.toggleVisualSelection('c');
    expect(r.selectedVisuals).toEqual(['a', 'b', 'c']);
    expect(el.querySelectorAll('[data-selected]')).toHaveLength(3);
    r.alignVisuals('top');
    expect(['a', 'b', 'c'].map((id) => layout(id).y)).toEqual([0, 0, 0]);
    expect(changes).toBe(1); // one edit for the whole batch
    r.distributeVisuals('horizontal');
    // span 0..11, widths 2+3+2 = 7, two gaps of 2
    expect(['a', 'b', 'c'].map((id) => layout(id).x)).toEqual([0, 4, 9]);
    r.alignVisuals('right', ['a', 'b']);
    expect(layout('a').x + layout('a').w).toBe(layout('b').x + layout('b').w);
    // groups select together
    r.groupVisuals(['a', 'b']);
    r.setActiveVisual('a');
    expect(r.selectedVisuals.sort()).toEqual(['a', 'b']);
    r.toggleVisualSelection('b'); // removes the whole group
    expect(r.selectedVisuals).toEqual([]);
    r.ungroupVisuals(['a', 'b']);
    r.setActiveVisual('a');
    expect(r.selectedVisuals).toEqual(['a']);
    // ordering
    r.arrange('c', 'front');
    r.arrange('a', 'backward');
    expect(layout('c').z).toBeGreaterThan(layout('b').z ?? 0);
    expect(layout('a').z).toBe(-1);
    r.destroy();
    el.remove();
  });

  it('drags the whole selection together, clamped to the grid', async () => {
    const { el, r, layout } = await setup();
    r.setActiveVisual('a');
    r.toggleVisualSelection('c');
    const overlay = el.querySelector('.pbi-edit[data-edit-for="a"]') as HTMLElement;
    const fire = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) => overlay.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, ...extra }), { pointerId: 1 }));
    fire('pointerdown', 100, 100);
    fire('pointermove', 100 + 80 * 3, 100 + 56); // 3 columns right, 1 row down (c would leave the 12-col grid at +3)
    fire('pointerup', 100 + 80 * 3, 100 + 56);
    // c (x 9, w 2) can move at most 1 column: the whole selection moves by 1
    expect(layout('a')).toMatchObject({ x: 1, y: 1 });
    expect(layout('c')).toMatchObject({ x: 10, y: 4 });
    expect(layout('b')).toMatchObject({ x: 4, y: 1 }); // not selected: unchanged
    // Ctrl-click toggles selection without dragging
    const ob = el.querySelector('.pbi-edit[data-edit-for="b"]') as HTMLElement;
    ob.dispatchEvent(Object.assign(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0, button: 0, ctrlKey: true }), { pointerId: 2 }));
    expect(r.selectedVisuals.sort()).toEqual(['a', 'b', 'c']);
    r.destroy();
    el.remove();
  });
});

describe('forecast', () => {
  it('continues trend and seasonality with a widening interval', async () => {
    const { forecastSeries, detectSeason, futureKeys } = await import('../src/visuals/forecast');
    const season = [10, 14, 9, 20];
    const xs = Array.from({ length: 24 }, (_, i) => 100 + i * 2 + season[i % 4]);
    expect(detectSeason(xs)).toBe(4);
    const f = forecastSeries(xs, { periods: 8 })!;
    expect(f.season).toBe(4);
    const expected = Array.from({ length: 8 }, (_, k) => 100 + (24 + k) * 2 + season[(24 + k) % 4]);
    f.mean.forEach((v, k) => expect(Math.abs(v - expected[k])).toBeLessThan(6));
    const widths = f.upper.map((u, k) => u - f.lower[k]);
    expect(widths[7]).toBeGreaterThan(widths[0]);
    const trend = forecastSeries([1, 2, 3, 4, 5, 6, 7, 8], { periods: 2, seasonality: 'none' })!;
    expect(trend.mean[0]).toBeCloseTo(9, 0);
    expect(forecastSeries([1, 2, 3], { periods: 2 })).toBeNull();
    // calendar months step by month, not by 30 days
    const months = [0, 1, 2, 3].map((m) => new Date(2025, m, 1).getTime());
    expect(futureKeys(months, true, 2).map((t) => new Date(t).getMonth())).toEqual([4, 5]);
  });

  it('draws a band and a dashed forecast line on continuous axes', async () => {
    const { createVisual } = await import('../src/index');
    const el = document.createElement('div');
    el.style.height = '400px';
    document.body.append(el);
    const r = createVisual(el, { model: buildModel(), type: 'line', fields: { category: 'Date[Date]', values: 'Total Sales' }, filters: [{ target: 'Date[Date]', op: 'between', min: new Date(2025, 9, 1), max: new Date(2025, 11, 31) }], format: { analytics: { forecast: { periods: 14 } } } });
    r.flush();
    expect(el.querySelector('.pbi-error')).toBeNull();
    expect(el.querySelectorAll('path.pbi-forecast')).toHaveLength(1);
    expect(el.querySelector('path.pbi-forecast-band title')?.textContent).toBe('Forecast, 95% interval');
    r.destroy();
    el.remove();
  });
});

describe('error bars', () => {
  it('draws whiskers from lower/upper measures and widens the axis', async () => {
    const { createVisual } = await import('../src/index');
    const model = buildModel().addMeasure('Sales Low', '[Total Sales] * 0.9').addMeasure('Sales High', '[Total Sales] * 1.25');
    for (const type of ['clusteredColumn', 'clusteredBar']) {
      const el = document.createElement('div');
      el.style.height = '360px';
      document.body.append(el);
      const r = createVisual(el, { model, type, fields: { category: 'Product[Category]', values: 'Total Sales', errorLower: 'Sales Low', errorUpper: 'Sales High' } });
      r.flush();
      expect(el.querySelector('.pbi-error')).toBeNull();
      expect(el.querySelectorAll('path.pbi-error-bar'), type).toHaveLength(4);
      // the top tick covers the highest upper bound (Bikes × 1.25)
      const ticks = [...el.querySelectorAll('text.pbi-tick')].map((t) => t.textContent ?? '');
      expect(ticks.length).toBeGreaterThan(2);
      r.destroy();
      el.remove();
    }
  });
});
