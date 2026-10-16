import { s, measureText } from '../render/svg';
import { bandScale, linearScale } from '../render/scales';
import { defineVisual } from './registry';
import {
  categoryLabelLayout,
  drawCategoryLabels,
  drawValueAxisY,
  emptyState,
  interactive,
  labelFormatter,
  markOpacity,
  pivot,
  renderLegend,
  valueAxisFormatter,
  withLegend,
} from './common';

interface WaterfallFormat {
  showTotal?: boolean;
  totalLabel?: string;
  increaseColor?: string;
  decreaseColor?: string;
  totalColor?: string;
}

/** Waterfall: each category is a step up or down from the running total, ending in a total bar. */
export const waterfall = /* @__PURE__ */ defineVisual({
  type: 'waterfall',
  displayName: 'Waterfall chart',
  category: 'chart',
  roles: [
    { name: 'category', displayName: 'Category', kind: 'grouping', required: true, drillable: true, multiple: true },
    { name: 'values', displayName: 'Y-axis', kind: 'measure', required: true },
  ],
  defaultSort: 'key',
  defaultFormat: { dataLabels: { show: true } },
  render(ctx) {
    const pv = pivot(ctx, 'category', '__none__', 'values');
    const se = pv.series[0];
    if (!se || !pv.categories.length) return emptyState(ctx);
    const t = ctx.theme;
    const f = ctx.format;
    const wf = (f.waterfall ?? {}) as WaterfallFormat;
    const up = wf.increaseColor ?? t.dataColors[0];
    const down = wf.decreaseColor ?? t.diverging[2];
    const totalC = wf.totalColor ?? t.otherColor;
    const showTotal = wf.showTotal ?? true;

    // running totals
    const steps: { label: string; start: number; end: number; kind: 'up' | 'down' | 'total'; ci: number }[] = [];
    let run = 0;
    pv.categories.forEach((c, ci) => {
      const v = se.values[ci] ?? 0;
      steps.push({ label: c.label, start: run, end: run + v, kind: v >= 0 ? 'up' : 'down', ci });
      run += v;
    });
    if (showTotal) steps.push({ label: wf.totalLabel ?? 'Total', start: 0, end: run, kind: 'total', ci: -1 });

    const legend = renderLegend(ctx, [
      { name: 'Increase', color: up },
      { name: 'Decrease', color: down },
      ...(showTotal ? [{ name: 'Total', color: totalC }] : []),
    ]);
    const { plot, width, height } = withLegend(ctx, legend);
    const fs = t.labelFontSize;
    const lo = Math.min(0, ...steps.map((x) => Math.min(x.start, x.end)));
    const hi = Math.max(0, ...steps.map((x) => Math.max(x.start, x.end)));
    let scale = linearScale(lo, hi, [height - 30, 10], { fixedMin: f.valueAxis.min, fixedMax: f.valueAxis.max });
    const fmtAxis = valueAxisFormatter(ctx, se.field, scale);
    const left = f.valueAxis.show ? Math.ceil(Math.max(...scale.ticks.map((x) => measureText(fmtAxis(x), fs, t.fontFamily)))) + 12 : 8;
    const band0 = bandScale(steps.length, [left, width - 8], 0.3, 0.1);
    const labels = steps.map((x) => x.label);
    const catLayout = categoryLabelLayout(ctx, labels, band0.step);
    const bottom = height - catLayout.height - 2;
    const top = f.dataLabels.show ? fs + 8 : 8;
    scale = linearScale(lo, hi, [bottom, top], { fixedMin: f.valueAxis.min, fixedMax: f.valueAxis.max, tickCount: Math.max(2, Math.min(f.valueAxis.tickCount, Math.floor((bottom - top) / 36))) });

    const svg = s('svg', { width, height, class: 'pbi-svg', role: 'img', 'aria-label': ctx.spec.title ?? 'Waterfall chart' });
    const g = s('g');
    svg.append(g);
    plot.append(svg);
    drawValueAxisY(ctx, g, scale, left, width - 8, valueAxisFormatter(ctx, se.field, scale));
    const band = bandScale(steps.length, [left, width - 8], 0.3, 0.1);
    drawCategoryLabels(ctx, g, labels, (i) => band(i) + band.bandwidth / 2, bottom, catLayout);
    const fmtLabel = labelFormatter(ctx, se.field);
    const thick = Math.min(band.bandwidth, f.bars.maxThickness * 1.6);
    steps.forEach((st, i) => {
      const x = band(i) + (band.bandwidth - thick) / 2;
      const y0 = scale(Math.max(st.start, st.end));
      const y1 = scale(Math.min(st.start, st.end));
      const color = st.kind === 'up' ? up : st.kind === 'down' ? down : totalC;
      const cat = st.ci >= 0 ? pv.categories[st.ci] : null;
      const rect = s('rect', { x, y: y0, width: thick, height: Math.max(1, y1 - y0), rx: 3, fill: color, opacity: cat ? markOpacity(ctx, cat.identity) : 1 });
      if (cat) interactive(ctx, rect, cat.identity, () => ({ title: cat.label, items: [{ label: se.name, value: ctx.fmt(se.field, st.end - st.start), color }, { label: 'Running total', value: ctx.fmt(se.field, st.end) }] }), cat.keys);
      g.append(rect);
      // connector from this step's end to the next step's start
      if (i < steps.length - 1) {
        const yc = Math.round(scale(st.end)) + 0.5;
        g.append(s('line', { x1: x + thick, x2: band(i + 1) + (band.bandwidth - thick) / 2, y1: yc, y2: yc, stroke: t.axis, 'stroke-width': 1, 'pointer-events': 'none' }));
      }
      if (f.dataLabels.show) {
        const delta = st.kind === 'total' ? st.end : st.end - st.start;
        const text = st.kind === 'total' || delta < 0 ? fmtLabel(delta) : `+${fmtLabel(delta)}`;
        if (measureText(text, fs, t.fontFamily) <= band.step + 4)
          g.append(s('text', { x: x + thick / 2, y: delta >= 0 || st.kind === 'total' ? y0 - 5 : y1 + fs + 3, 'text-anchor': 'middle', class: 'pbi-label', fill: f.dataLabels.color ?? t.foregroundSecondary }, text));
      }
    });
  },
});
