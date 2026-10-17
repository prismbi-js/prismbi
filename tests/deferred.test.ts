import { describe, expect, it } from 'vitest';
import { createVisual } from '../src/index';
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
