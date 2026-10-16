import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Report, createVisual } from '../src/index';
import type { ReportDefinition } from '../src/index';
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

const q = <T extends Element = Element>(sel: string, root: ParentNode = el) => root.querySelector<T>(sel);
const qa = <T extends Element = Element>(sel: string, root: ParentNode = el) => [...root.querySelectorAll<T>(sel)];
const cardText = (id = 'card') => q(`[data-visual-id="${id}"] .pbi-card-value`)?.textContent;
const click = (n: Element, init: MouseEventInit = {}) => n.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }));
const menuItem = (label: string) => qa<HTMLButtonElement>('.pbi-menu-item').find((b) => b.textContent?.startsWith(label));

const def = (): ReportDefinition => ({
  pages: [
    {
      id: 'main',
      name: 'Main',
      visuals: [
        { id: 'yr', type: 'slicer', fields: { field: 'Date[Year]' }, format: { slicer: { style: 'tiles', syncGroup: 'year' } } },
        { id: 'card', type: 'card', fields: { value: 'Total Sales' } },
        { id: 'cols', type: 'clusteredColumn', fields: { category: ['Products[Category]', 'Products[Name]'], values: 'Total Sales' } },
        { id: 'line', type: 'line', fields: { category: 'Date[Month]', values: 'Total Sales' } },
      ],
    },
    {
      id: 'details',
      name: 'Category details',
      hidden: true,
      drillthrough: { fields: ['Products[Category]'] },
      visuals: [
        { id: 'd-card', type: 'card', fields: { value: 'Total Sales' } },
        { id: 'd-yr', type: 'slicer', fields: { field: 'Date[Year]' }, format: { slicer: { syncGroup: 'year' } } },
      ],
    },
  ],
});

describe('context menu: include / exclude', () => {
  it('excludes and includes data points as visual filters', () => {
    const r = new Report(el, { model: makeModel(), ...def() });
    r.flush();
    const bikes = qa('[data-visual-id="cols"] path.pbi-mark')[0];
    bikes.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    expect(menuItem('Exclude')).toBeTruthy();
    click(menuItem('Exclude')!);
    r.flush();
    expect(qa('[data-visual-id="cols"] path.pbi-mark')).toHaveLength(2);
    expect(r.visual('cols').spec.filters).toEqual([{ target: { table: 'Products', column: 'Category' }, op: 'notIn', values: ['Bikes'] }]);

    qa('[data-visual-id="cols"] path.pbi-mark')[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    click(menuItem('Include')!);
    r.flush();
    expect(qa('[data-visual-id="cols"] path.pbi-mark')).toHaveLength(1);
  });
});

describe('drill-through', () => {
  it('navigates with the data point and source filters, then goes back', () => {
    const r = new Report(el, { model: makeModel(), ...def() });
    r.setSlicerSelection('yr', [{ target: 'Date[Year]', op: 'in', values: [2024] }]);
    r.flush();
    const events: string[] = [];
    r.on('drillThrough', (e) => events.push(e.toPageId));
    qa('[data-visual-id="cols"] path.pbi-mark')[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    click(menuItem('Drill through: Category details')!);
    r.flush();
    expect(r.currentPage.id).toBe('details');
    expect(events).toEqual(['details']);
    // Bikes in 2024 (slicer carried along) = 4000
    expect(cardText('d-card')).toBe('$4,000');
    expect(q('.pbi-back')?.textContent).toContain('Main');
    r.back();
    r.flush();
    expect(r.currentPage.id).toBe('main');
  });

  it('can be triggered programmatically with filters', () => {
    const r = new Report(el, { model: makeModel(), ...def() });
    r.drillThrough('details', [{ target: 'Products[Category]', op: 'eq', value: 'Clothing' }]);
    r.flush();
    expect(cardText('d-card')).toBe('$250');
  });
});

describe('slicer sync groups', () => {
  it('shares a selection across pages', () => {
    const r = new Report(el, { model: makeModel(), ...def() });
    r.setSlicerSelection('yr', [{ target: 'Date[Year]', op: 'in', values: [2025] }]);
    r.goToPage('details');
    r.flush();
    expect(cardText('d-card')).toBe('$2,300');
    r.setSlicerSelection('d-yr', null);
    r.goToPage('main');
    r.flush();
    expect(cardText()).toBe('$6,750');
  });
});

describe('hierarchy slicer', () => {
  it('renders a tree and filters by full paths', () => {
    const r = new Report(el, {
      model: makeModel(),
      pages: [{ name: 'P', visuals: [
        { id: 'h', type: 'slicer', fields: { field: ['Products[Category]', 'Products[Name]'] } },
        { id: 'card', type: 'card', fields: { value: 'Total Sales' } },
      ] }],
    });
    r.flush();
    const items = qa('[data-visual-id="h"] .pbi-tree-item');
    expect(items.map((i) => i.textContent?.replace(/[▸▾]/g, '').trim())).toEqual(['Accessories', 'Bikes', 'Clothing']);
    const bikes = items[1].querySelector('input')!;
    bikes.checked = true;
    bikes.dispatchEvent(new Event('change'));
    r.flush();
    expect(cardText()).toBe('$6,000');
    // expand Bikes and untick Road Bike → only Mountain Bike remains
    click(qa('[data-visual-id="h"] .pbi-tree-toggle')[1]);
    r.flush();
    const road = qa('[data-visual-id="h"] .pbi-tree-item').find((i) => i.textContent?.includes('Road Bike'))!.querySelector('input')!;
    road.checked = false;
    road.dispatchEvent(new Event('change'));
    r.flush();
    expect(cardText()).toBe('$3,000');
    expect((q('[data-visual-id="h"] .pbi-tree-item input') as HTMLInputElement | null) && qa<HTMLInputElement>('[data-visual-id="h"] .pbi-tree-item input')[1].indeterminate).toBe(true);
  });
});

describe('expand all down one level', () => {
  it('shows parent and child levels together', () => {
    const r = new Report(el, { model: makeModel(), ...def() });
    r.flush();
    r.visual('cols').expandAll();
    r.flush();
    const data = r.visual('cols').data()!;
    expect(data.groups.map((g) => g.name)).toEqual(['Category', 'Name']);
    expect(data.rows).toHaveLength(5);
    r.visual('cols').drillUp();
    r.flush();
    expect(r.visual('cols').data()!.groups.map((g) => g.name)).toEqual(['Category']);
  });
});

describe('analytics & highlighting', () => {
  it('cross-highlights line charts', () => {
    const r = new Report(el, { model: makeModel(), ...def() });
    r.flush();
    click(qa('[data-visual-id="cols"] path.pbi-mark')[0]);
    r.flush();
    expect(qa('[data-visual-id="line"] .pbi-line-highlight')).toHaveLength(1);
  });

  it('draws reference and trend lines and colours bars by rule', () => {
    const r = createVisual(el, {
      model: makeModel(),
      type: 'clusteredColumn',
      fields: { category: 'Products[Name]', values: 'Total Sales' },
      format: {
        analytics: { referenceLines: [{ type: 'average' }, { type: 'constant', value: 1000, label: 'Goal {value}' }], trendLine: true },
        colors: { rules: [{ op: '>=', value: 1000, color: '#008300' }] },
      },
    });
    r.flush();
    expect(qa('.pbi-refline')).toHaveLength(2);
    expect(qa('.pbi-refline-label').map((x) => x.textContent)).toContain('Goal $1,000');
    expect(qa('.pbi-trend')).toHaveLength(1);
    const fills = qa('path.pbi-mark').map((p) => p.getAttribute('fill'));
    expect(fills.filter((f) => f === '#008300')).toHaveLength(2); // the two bikes (3000 each)
  });
});

describe('new visuals', () => {
  it('waterfall renders a step per category plus a total', () => {
    const r = createVisual(el, { model: makeModel(), type: 'waterfall', fields: { category: 'Date[Month]', values: 'Total Sales' } });
    r.flush();
    expect(qa('rect.pbi-mark')).toHaveLength(3);
    expect(qa('rect')).toHaveLength(4);
    expect(q('.pbi-error')).toBeNull();
  });

  it('heatmap renders one cell per combination', () => {
    const r = createVisual(el, { model: makeModel(), type: 'heatmap', fields: { rows: 'Products[Category]', columns: 'Region[Name]', values: 'Total Sales' } });
    r.flush();
    expect(qa('rect.pbi-mark')).toHaveLength(6);
  });

  it('small multiples split a chart into panels with one legend', () => {
    const r = createVisual(el, { model: makeModel(), type: 'clusteredColumn', fields: { category: 'Products[Category]', values: 'Total Sales', smallMultiples: 'Region[Name]' } });
    r.flush();
    expect(qa('.pbi-sm-cell').map((c) => c.querySelector('.pbi-sm-title')?.textContent)).toEqual(['North', 'South']);
    expect(q('.pbi-error')).toBeNull();
  });

  it('decomposition tree splits, narrows and cross-filters', () => {
    const r = new Report(el, {
      model: makeModel(),
      pages: [{ name: 'P', visuals: [
        { id: 'tree', type: 'decompositionTree', fields: { values: 'Total Sales', explainBy: ['Products[Category]', 'Region[Name]'] } },
        { id: 'card', type: 'card', fields: { value: 'Orders' } },
      ] }],
    });
    r.flush();
    const add = q<HTMLSelectElement>('[data-visual-id="tree"] .is-add select')!;
    add.value = 'Products[Category]';
    add.dispatchEvent(new Event('change'));
    r.flush();
    const nodes = qa<HTMLButtonElement>('[data-visual-id="tree"] .pbi-decomp-node');
    expect(nodes.map((n) => n.querySelector('.pbi-decomp-label')?.textContent)).toEqual(['Total Sales', 'Bikes', 'Accessories', 'Clothing']);
    click(nodes[1]);
    r.flush();
    expect(cardText()).toBe('3'); // Bikes orders
    const next = q<HTMLSelectElement>('[data-visual-id="tree"] .is-add select')!;
    next.value = '__high__';
    next.dispatchEvent(new Event('change'));
    r.flush();
    expect(qa('[data-visual-id="tree"] .pbi-decomp-auto')).toHaveLength(1);
    expect(qa('[data-visual-id="tree"] .pbi-decomp-col')).toHaveLength(3);
  });
});

describe('export', () => {
  it('produces a standalone SVG snapshot', () => {
    const r = createVisual(el, { model: makeModel(), type: 'card', fields: { value: 'Total Sales' } });
    r.flush();
    const svg = r.visual(r.visualIds()[0]).toSvg();
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('foreignObject');
    expect(svg).toContain('$6,750');
  });
});

describe('exclude tuples', () => {
  it('removes specific combinations', () => {
    const m = makeModel();
    expect(m.evaluate('[Total Sales]', [{ targets: ['Products[Category]', 'Region[Name]'], op: 'tuples', tuples: [['Bikes', 'North']], exclude: true }])).toBe(2750);
  });
});
