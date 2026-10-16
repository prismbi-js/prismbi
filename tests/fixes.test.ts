import { expect, it } from 'vitest';
import { createVisual, prismCss } from '../src/index';
import { makeModel } from './fixtures';

it('cross-highlighted lines stay inside the plot area', () => {
  const el = document.createElement('div');
  document.body.append(el);
  // yearly totals are 4450 / 2300, the highlighted (South) values 250 / 2050 sit far below the totals
  const r = createVisual(el, { model: makeModel(), type: 'line', fields: { category: 'Date[Year]', values: 'Total Sales' }, format: { lines: { markers: true } } });
  (r as unknown as { highlightFor: () => unknown }).highlightFor = () => [{ target: 'Region[Name]', op: 'eq', value: 'South' }];
  const host = (r as unknown as { pages: { hosts: Map<string, { invalidate(): void; render(): void }> }[] }).pages[0].hosts.get(r.visualIds()[0])!;
  host.invalidate();
  host.render();
  const axisBottom = Math.max(...[...el.querySelectorAll('line.pbi-baseline, line.pbi-grid')].map((l) => Number(l.getAttribute('y1'))));
  const ys = [...el.querySelector('.pbi-line-highlight')!.getAttribute('d')!.matchAll(/,(-?[\d.]+)/g)].map((m) => Number(m[1]));
  expect(Math.max(...ys)).toBeLessThanOrEqual(axisBottom + 0.5);
  // full-value markers fade, highlighted markers are drawn solid
  expect(el.querySelectorAll('.pbi-marker-highlight')).toHaveLength(2);
  r.destroy();
  el.remove();
});

it('the hidden attribute always wins over display rules', () => {
  expect(prismCss).toContain('.pbi-report [hidden]');
});

it('evaluateTable reports measure and column formats', () => {
  const t = makeModel().evaluateTable('SUMMARIZECOLUMNS(Products[Category], "Sales", [Total Sales], "Margin", [Margin %])');
  expect(t.formats).toEqual([undefined, '$#,0', '0.0%']);
});
