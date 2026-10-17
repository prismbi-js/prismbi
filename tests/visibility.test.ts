import { describe, expect, it } from 'vitest';
import { DataModel, Report } from '@prismbi/prismbi';
import type { UsageEvent } from '@prismbi/prismbi';

const model = () =>
  new DataModel()
    .addTable('T', [
      { region: 'North', v: 1 },
      { region: 'South', v: 2 },
    ])
    .addMeasure('Total', 'SUM(T[v])')
    .addRole('Managers', {});

function mount(onUsage?: (e: UsageEvent) => void) {
  const el = document.createElement('div');
  document.body.append(el);
  const m = model();
  const r = new Report(el, {
    model: m,
    onUsage,
    pages: [
      {
        id: 'p1',
        name: 'Main',
        visuals: [
          { id: 'sl', type: 'slicer', layout: { x: 0, y: 0, w: 3, h: 4 }, fields: { values: 'T[region]' } },
          { id: 'any', type: 'card', layout: { x: 3, y: 0, w: 3, h: 3 }, fields: { value: 'Total' }, visibleWhen: { field: 'T[region]' } },
          { id: 'south', type: 'card', layout: { x: 6, y: 0, w: 3, h: 3 }, fields: { value: 'Total' }, visibleWhen: { field: 'T[region]', is: ['South'] } },
          { id: 'none', type: 'card', layout: { x: 9, y: 0, w: 3, h: 3 }, fields: { value: 'Total' }, visibleWhen: { field: 'T[region]', is: 'notSelected' } },
          { id: 'mgr', type: 'card', layout: { x: 0, y: 4, w: 3, h: 3 }, fields: { value: 'Total' }, visibleWhen: { roles: ['Managers'] } },
        ],
      },
      { id: 'p2', name: 'Other', visuals: [] },
    ],
  });
  r.flush();
  return { el, m, r };
}

describe('conditional visibility', () => {
  it('shows visuals by filter state and role', () => {
    const { el, m, r } = mount();
    const shown = () => ['any', 'south', 'none', 'mgr'].filter((id) => r.isVisualVisible(id));
    expect(shown()).toEqual(['none']);
    expect(el.querySelectorAll('.pbi-visual.is-conditional-hidden')).toHaveLength(3);
    r.setSlicerFilter('sl', [{ target: 'T[region]', op: 'in', values: ['North'] }]);
    r.flush();
    expect(shown()).toEqual(['any']);
    r.setSlicerFilter('sl', [{ target: 'T[region]', op: 'eq', value: 'South' }]);
    r.flush();
    expect(shown()).toEqual(['any', 'south']);
    m.setRoles(['Managers']);
    r.flush();
    expect(shown()).toEqual(['any', 'south', 'mgr']);
    expect(el.querySelectorAll('.pbi-visual.is-conditional-hidden')).toHaveLength(1);
    r.destroy();
    el.remove();
  });
});

describe('usage analytics', () => {
  it('reports page views and interactions', () => {
    const events: UsageEvent[] = [];
    const { el, r } = mount((e) => events.push(e));
    r.setSlicerFilter('sl', [{ target: 'T[region]', op: 'eq', value: 'South' }]);
    r.goToPage('Other');
    expect(events.map((e) => `${e.type}:${e.action ?? ''}:${e.page}`)).toEqual(['pageView::Main', 'interaction:filter:Main', 'pageView::Other']);
    expect(events[1].visualId).toBe('sl');
    expect(typeof events[0].at).toBe('number');
    r.destroy();
    el.remove();
  });
});
