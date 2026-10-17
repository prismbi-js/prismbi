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
