import { describe, expect, it } from 'vitest';
import { CollabDoc, connectReport, memoryHub } from '@prismbi/prismbi/collab';
import { Report } from '../src/index';
import type { ReportDefinition } from '../src/index';
import { makeModel } from './fixtures';

const tick = () => new Promise((r) => setTimeout(r, 0));
const definition = (): ReportDefinition => ({
  name: 'Sales',
  filters: [{ target: 'Date[Date]', op: 'between', min: new Date(2024, 0, 1), max: new Date(2025, 11, 31) }],
  pages: [
    {
      id: 'p1',
      name: 'Overview',
      visuals: [
        { id: 'card', type: 'card', layout: { x: 0, y: 0, w: 3, h: 2 }, fields: { value: 'Total Sales' } },
        { id: 'cols', type: 'clusteredColumn', layout: { x: 3, y: 0, w: 9, h: 6 }, fields: { category: 'Products[Category]', values: 'Total Sales' } },
      ],
    },
  ],
});

function mount(def = definition()) {
  const el = document.createElement('div');
  el.style.height = '600px';
  document.body.append(el);
  const report = new Report(el, { model: makeModel(), ...def });
  report.flush();
  return { el, report };
}

describe('CollabDoc', () => {
  it('converges whatever order entries arrive in (last writer wins)', () => {
    const a = new CollabDoc('a');
    const b = new CollabDoc('b');
    const ea = a.diff(definition());
    b.merge(ea);
    const one = a.set('visual:p1:card', { id: 'card', type: 'kpi', order: 0 });
    const two = b.set('visual:p1:card', { id: 'card', type: 'gauge', order: 0 });
    // deliver in opposite orders
    a.merge([two]);
    b.merge([one]);
    expect(a.get('visual:p1:card')).toEqual(b.get('visual:p1:card'));
    expect(a.toDefinition()).toEqual(b.toDefinition());
    // dates survive the round trip
    expect((a.toDefinition().filters![0] as { min: Date }).min).toBeInstanceOf(Date);
    // deletes are tombstones that also converge
    const del = a.set('visual:p1:cols', null);
    b.merge([del]);
    expect(b.toDefinition().pages[0].visuals.map((v) => v.id)).toEqual(['card']);
  });
});

describe('co-editing reports', () => {
  it('syncs edits both ways, keeps ids and order, and shares comments', async () => {
    const hub = memoryHub();
    const A = mount();
    const B = mount({ pages: [{ id: 'p1', name: 'Overview', visuals: [] }] }); // joins with an empty report
    const sa = connectReport(A.report, hub.connect(), { user: 'Ana', joinTimeoutMs: 5 });
    await new Promise((r) => setTimeout(r, 20)); // Ana is alone: seeds the room
    const sb = connectReport(B.report, hub.connect(), { user: 'Ben', joinTimeoutMs: 50 });
    await tick();
    await tick();
    // the newcomer adopts the room's report instead of merging its own
    expect(B.report.visualIds()).toEqual(['card', 'cols']);
    expect(A.report.pageList).toHaveLength(1);
    expect(sa.peers().map((p) => p.name)).toContain('Ben');
    expect(sb.peers().map((p) => p.name)).toContain('Ana');

    // A edits a visual → B sees it
    A.report.updateVisual('cols', { title: 'Sales by category' });
    await tick();
    expect(B.report.pageDefinition().visuals.find((v) => v.id === 'cols')?.title).toBe('Sales by category');

    // B adds a visual → A sees it
    B.report.addVisual({ id: 'tbl', type: 'table', layout: { x: 0, y: 6, w: 12, h: 4 }, fields: { columns: ['Products[Category]', 'Total Sales'] } });
    await tick();
    expect(A.report.visualIds()).toContain('tbl');

    // comments sync and show as badges
    sa.addComment({ visualId: 'cols', text: 'Why is Bikes so high?' });
    await tick();
    expect(sb.comments().map((c) => c.text)).toEqual(['Why is Bikes so high?']);
    expect(sb.comments()[0].author).toBe('Ana');
    B.report.flush();
    expect(B.el.querySelector('[data-visual-id="cols"] .pbi-comment-badge')?.textContent).toContain('1');
    sb.resolveComment(sb.comments()[0].id);
    await tick();
    expect(sa.comments()).toHaveLength(0);
    expect(sa.comments({ includeResolved: true })).toHaveLength(1);

    // presence: B selects a visual in edit mode → A shows an outline with B's name
    B.report.setEditMode(true);
    B.report.setActiveVisual('card');
    (B.report as unknown as { emit(e: string, p: unknown): void }).emit('visualSelected', { visualId: 'card' });
    await tick();
    expect(A.el.querySelector('[data-visual-id="card"] .pbi-presence')?.textContent).toBe('Ben');

    // leaving removes presence
    sb.disconnect();
    await tick();
    expect(sa.peers()).toHaveLength(0);
    sa.disconnect();
    A.report.destroy();
    B.report.destroy();
    A.el.remove();
    B.el.remove();
  });
});
