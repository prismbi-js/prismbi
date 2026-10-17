import { describe, expect, it } from 'vitest';
import { filterPhrase, setNarrativeWriter, writeNarrative } from '@prismbi/prismbi/ai';
import { Report } from '../src/index';
import { buildModel } from '../examples/model';

const model = buildModel();
const y2025 = [{ target: 'Date[Year]', op: 'eq' as const, value: 2025 }];

describe('writeNarrative', () => {
  it('describes the value, its change, drivers and a breakdown', () => {
    const breakdown = model.query({ groupBy: ['Product[Category]'], values: ['Total Sales'], filters: y2025 });
    const n = writeNarrative(model, { measures: ['Total Sales', 'Orders'], filters: y2025, breakdown, insights: 0 });
    expect(n.text).toMatch(/^Total Sales for 2025 is \S+, (up|down) [\d.]+% from \S+ in 2024, mostly from /);
    expect(n.text).toMatch(/Orders is [\d,.]+K? \((up|down) [\d.]+% from 2024\)\./);
    expect(n.text).toMatch(/leads Category with .*% of the total\); .* is lowest at /);
    const drivers = /mostly from (.*?)\./.exec(n.text)![1];
    expect(new Set(drivers.match(/\([+−]\S+\)/g)).size).toBe(drivers.match(/\([+−]\S+\)/g)!.length); // no repeated hierarchy levels
    // emphasised parts are the numbers and names
    expect(n.sentences[0].some((p) => typeof p !== 'string')).toBe(true);
  });

  it('describes trends over ordered axes and appends insights', () => {
    const breakdown = model.query({ groupBy: ['Date[MonthNumber]'], values: ['Total Sales'], filters: y2025 });
    const n = writeNarrative(model, { measures: ['Total Sales'], filters: y2025, breakdown, insights: 1 });
    expect(n.text).toMatch(/Across MonthNumber, it went from .* in 1 to .* in 12 \((up|down) .*\), peaking at /);
    expect(n.sentences.length).toBe(3);
  });

  it('fills custom text templates', () => {
    const n = writeNarrative(model, { measures: ['Total Sales'], filters: y2025, insights: 0, template: 'Sales: {[Total Sales]}. Orders: {[Orders]}. Bad: {[Nope]}\n\n{summary}' });
    expect(n.sentences).toHaveLength(2);
    expect(n.text).toMatch(/^Sales: \S+\. Orders: [\d,.]+K?\. Bad: \[Nope\?\] Total Sales for 2025 is/);
  });

  it('phrases filter context', () => {
    expect(filterPhrase([{ target: 'Product[Category]', op: 'in', values: ['Bikes', 'Clothing'] }, ...y2025])).toBe(' for Bikes or Clothing, 2025');
    expect(filterPhrase([{ target: 'Date[Year]', op: 'between', min: 2024, max: 2025 }])).toBe('');
  });
});

describe('narrative visual', () => {
  it('renders, follows slicers, and uses the narrative writer when set', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    const r = new Report(el, {
      model,
      pages: [{ name: 'P', filters: y2025, visuals: [
        { id: 'sl', type: 'slicer', layout: { x: 0, y: 0, w: 3, h: 6 }, fields: { values: 'Product[Category]' } },
        { id: 'n', type: 'narrative', layout: { x: 3, y: 0, w: 6, h: 6 }, fields: { values: ['Total Sales'], category: 'Region[Country]' }, format: { narrative: { insights: 0 } } },
      ] }],
    });
    r.flush();
    const text = () => el.querySelector('[data-visual-id="n"] .pbi-ai-narrative')?.textContent ?? el.querySelector('.pbi-ai-narrative')!.textContent!;
    expect(text()).toMatch(/^Total Sales for 2025 is/);
    expect(el.querySelectorAll('.pbi-ai-narrative strong').length).toBeGreaterThan(2);
    r.setSlicerFilter('sl', [{ target: 'Product[Category]', op: 'in', values: ['Bikes'] }]);
    r.flush();
    expect(text()).toMatch(/^Total Sales for 2025, Bikes is/);
    const seen: string[] = [];
    setNarrativeWriter(async (facts) => (seen.push(facts), 'Sales held up well.\n\nBikes did the heavy lifting.'));
    try {
      r.visual('n')!.update({ title: 'Story' });
      r.flush();
      await new Promise((res) => setTimeout(res, 0));
      expect(seen[0]).toMatch(/^Total Sales for 2025, Bikes is/);
      expect(el.querySelectorAll('.pbi-ai-narrative p')).toHaveLength(2);
      expect(text()).toContain('AI-written');
    } finally {
      setNarrativeWriter(null);
      r.destroy();
      el.remove();
    }
  });
});
