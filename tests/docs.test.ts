import { expect, it } from 'vitest';
import { bandScale, chart, createVisual, defineVisual, linearScale, registerVisual, svg as s } from '../src/index';
import { makeModel } from './fixtures';

// mirrors docs/guide/custom-visuals.md
it('the custom visual guide example works', () => {
  registerVisual(defineVisual({
    type: 'lollipop',
    displayName: 'Lollipop chart',
    category: 'chart',
    roles: [
      { name: 'category', displayName: 'Category', kind: 'grouping', required: true, drillable: true, multiple: true },
      { name: 'values', displayName: 'Value', kind: 'measure', required: true },
    ],
    defaultSort: 'value',
    render(ctx) {
      const pv = chart.pivot(ctx);
      if (!pv.categories.length) return chart.emptyState(ctx);
      const [series] = pv.series;
      const { width, height } = ctx;
      const x = bandScale(pv.categories.length, [40, width - 8]);
      const y = linearScale(0, Math.max(...series.values.map((v) => v ?? 0)), [height - 24, 8]);
      const root = s('svg', { width, height, class: 'pbi-svg' });
      pv.categories.forEach((cat, i) => {
        const v = series.values[i];
        if (v === null) return;
        const cx = x(i) + x.bandwidth / 2;
        root.append(s('line', { x1: cx, x2: cx, y1: y(0), y2: y(v), stroke: ctx.theme.axis, 'stroke-width': 2 }));
        const dot = s('circle', { cx, cy: y(v), r: 6, fill: series.color, opacity: chart.markOpacity(ctx, cat.identity) });
        chart.interactive(ctx, dot, cat.identity, () => ({ title: cat.label, items: [{ label: series.name, value: ctx.fmt(series.field, v) }] }), cat.keys);
        root.append(dot);
      });
      ctx.root.replaceChildren(root);
    },
  }));
  const el = document.createElement('div');
  document.body.append(el);
  const r = createVisual(el, { model: makeModel(), type: 'lollipop', fields: { category: 'Products[Name]', values: 'Total Sales' } });
  r.flush();
  expect(el.querySelectorAll('circle.pbi-mark')).toHaveLength(5);
  el.querySelector('circle.pbi-mark')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  r.flush();
  expect(el.querySelectorAll('circle[opacity="0.3"]')).toHaveLength(4);
});
