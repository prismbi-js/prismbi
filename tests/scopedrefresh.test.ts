import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataModel, Report } from '../src/index';
import type { ModelChange } from '../src/index';

/** Appends re-query only the visuals that read the changed tables (on every page); everything else keeps its DOM. */
let el: HTMLElement;
beforeEach(() => {
  el = document.createElement('div');
  el.style.height = '800px';
  document.body.append(el);
});
afterEach(() => el.remove());

const model = () =>
  new DataModel()
    .addTable('Sales', [
      { RegionKey: 1, Amount: 10 },
      { RegionKey: 2, Amount: 20 },
    ])
    .addTable('Region', [
      { RegionKey: 1, Name: 'North' },
      { RegionKey: 2, Name: 'South' },
    ])
    .addTable('Stock', [{ Item: 'a', Qty: 5 }])
    .addTable('Notes', [{ Text: 'x' }])
    .addRelationship({ from: 'Sales[RegionKey]', to: 'Region[RegionKey]' })
    .addMeasure('Total Sales', 'SUM(Sales[Amount])')
    .addMeasure('Units', 'SUM(Stock[Qty])')
    .addMeasure('Per Unit', 'DIVIDE([Total Sales], [Units])');

const card = (id: string, value: string) => ({ id, type: 'card', layout: { x: 0, y: 0, w: 3, h: 2 }, fields: { value } });
const text = (id: string) => el.querySelector(`[data-visual-id="${id}"] .pbi-card-value`)?.textContent;
const root = (id: string) => el.querySelector(`[data-visual-id="${id}"] .pbi-vroot`);

describe('scoped refresh', () => {
  it('re-renders only the visuals that depend on the appended table', () => {
    const m = model();
    const changes: (ModelChange | undefined)[] = [];
    m.onChange((c) => changes.push(c));
    const r = new Report(el, {
      model: m,
      pages: [
        { id: 'p1', name: 'One', visuals: [card('sales', 'Total Sales'), card('units', 'Units'), card('ratio', 'Per Unit'), { ...card('byRegion', 'Total Sales'), type: 'clusteredColumn', fields: { category: 'Region[Name]', values: 'Total Sales' } }] },
        { id: 'p2', name: 'Two', visuals: [card('units2', 'Units')] },
      ],
    });
    r.flush();
    expect([text('sales'), text('units'), text('ratio')]).toEqual(['30', '5', '6']);
    const salesRoot = root('sales');
    const chartRoot = root('byRegion');

    m.appendRows('Stock', [{ Item: 'b', Qty: 10 }]);
    expect(changes[changes.length - 1]).toEqual({ tables: ['Stock'] });
    r.flush();
    expect([text('units'), text('ratio')]).toEqual(['15', '2']);
    // Sales visuals were not rebuilt
    expect(root('sales')).toBe(salesRoot);
    expect(root('byRegion')).toBe(chartRoot);

    // a visual on another page picks up the change when shown
    r.goToPage('p2');
    r.flush();
    expect(text('units2')).toBe('15');
    r.goToPage('p1');
    r.flush();

    m.appendRows('Sales', [{ RegionKey: 1, Amount: 30 }]);
    r.flush();
    expect([text('sales'), text('ratio')]).toEqual(['60', '4']);

    // a related dimension reaches the fact's visuals
    const before = root('sales');
    m.appendRows('Region', [{ RegionKey: 3, Name: 'East' }]);
    r.flush();
    expect(root('sales')).not.toBe(before);

    // an unrelated table touches nothing
    const units = root('units');
    m.appendRows('Notes', [{ Text: 'y' }]);
    r.flush();
    expect(root('units')).toBe(units);

    // definition changes still refresh everything
    m.addMeasure('Other', '1');
    expect(changes[changes.length - 1]).toBeUndefined();
    r.flush();
    expect(root('units')).not.toBe(units);
    r.destroy();
  });

  it('treats row-level security as touching everything', () => {
    const m = model().addRole('north', { Region: 'Region[Name] = "North"' });
    m.setRoles(['north']);
    const r = new Report(el, { model: m, pages: [{ id: 'p', name: 'P', visuals: [card('units', 'Units')] }] });
    r.flush();
    const units = root('units');
    m.appendRows('Notes', [{ Text: 'y' }]);
    r.flush();
    expect(root('units')).not.toBe(units);
    r.destroy();
  });
});
