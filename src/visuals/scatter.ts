import { s, measureText } from '../render/svg';
import { linearScale } from '../render/scales';
import { defineVisual } from './registry';
import { drawValueAxisY, emptyState, identityOf, interactive, markOpacity, renderLegend, valueAxisFormatter, withLegend } from './common';
import type { DataPointIdentity } from './types';

export const scatter = defineVisual({
  type: 'scatter',
  displayName: 'Scatter chart',
  category: 'chart',
  roles: [
    { name: 'details', displayName: 'Values (points)', kind: 'grouping', multiple: true, required: true },
    { name: 'legend', displayName: 'Legend', kind: 'grouping' },
    { name: 'x', displayName: 'X-axis', kind: 'measure', required: true },
    { name: 'y', displayName: 'Y-axis', kind: 'measure', required: true },
    { name: 'size', displayName: 'Size', kind: 'measure' },
  ],
  render(ctx) {
    const d = ctx.role('details');
    const l = ctx.role('legend');
    const xi = ctx.role('x').indices[0];
    const yi = ctx.role('y').indices[0];
    const si = ctx.role('size').indices[0];
    if (xi === undefined || yi === undefined) return emptyState(ctx, 'Add X and Y measures');
    const rows = ctx.data.rows.filter((r) => typeof r.values[xi] === 'number' && typeof r.values[yi] === 'number');
    if (!rows.length) return emptyState(ctx);
    const t = ctx.theme;
    const fs = t.labelFontSize;
    const dFields = d.indices.map((i) => ctx.data.groups[i]);
    const lField = l.indices.length ? ctx.data.groups[l.indices[0]] : undefined;
    const xField = ctx.data.values[xi];
    const yField = ctx.data.values[yi];
    const sField = si !== undefined ? ctx.data.values[si] : undefined;

    const legendItems = new Map<unknown, { name: string; color: string; identity: DataPointIdentity }>();
    if (lField)
      for (const r of rows) {
        const v = r.keys[l.indices[0]];
        if (!legendItems.has(v)) legendItems.set(v, { name: ctx.fmt(lField, v), color: ctx.colorFor(lField, v), identity: identityOf([lField], [v]) });
      }
    const legend = renderLegend(ctx, [...legendItems.values()].map((x) => ({ ...x, shape: 'dot' as const })));
    const { plot, width, height } = withLegend(ctx, legend);

    const xs = rows.map((r) => r.values[xi] as number);
    const ys = rows.map((r) => r.values[yi] as number);
    const sizes = sField ? rows.map((r) => Math.max(0, (r.values[si!] as number) ?? 0)) : [];
    const maxSize = Math.max(1, ...sizes);
    const yScale0 = linearScale(Math.min(...ys), Math.max(...ys), [height - 30, 10], { includeZero: false });
    const fmtY = valueAxisFormatter(ctx, yField, yScale0);
    const left = Math.ceil(Math.max(...yScale0.ticks.map((v) => measureText(fmtY(v), fs, t.fontFamily)))) + 12;
    const bottom = height - fs - 22;
    const x = linearScale(Math.min(...xs), Math.max(...xs), [left + 8, width - 12], { includeZero: false, tickCount: Math.max(2, Math.floor(width / 90)) });
    const y = linearScale(Math.min(...ys), Math.max(...ys), [bottom - 6, 10], { includeZero: false, tickCount: Math.max(2, Math.floor(height / 45)) });
    const svg = s('svg', { width, height, class: 'pbi-svg', role: 'img', 'aria-label': ctx.spec.title ?? 'Scatter chart' });
    plot.append(svg);
    const g = s('g');
    svg.append(g);
    drawValueAxisY(ctx, g, y, left, width - 8, valueAxisFormatter(ctx, yField, y));
    const fmtX = valueAxisFormatter(ctx, xField, x);
    for (const tick of x.ticks) g.append(s('text', { x: x(tick), y: bottom + fs + 4, 'text-anchor': 'middle', class: 'pbi-tick', fill: t.foregroundMuted }, fmtX(tick)));
    g.append(s('text', { x: (left + width) / 2, y: height - 4, 'text-anchor': 'middle', class: 'pbi-axis-title', fill: t.foregroundSecondary }, xField.name));

    const marks = s('g');
    g.append(marks);
    // draw bigger bubbles first so small ones stay clickable
    const order = rows.map((_, i) => i).sort((a, b) => (sizes[b] ?? 0) - (sizes[a] ?? 0));
    for (const i of order) {
      const r = rows[i];
      const color = lField ? ctx.colorFor(lField, r.keys[l.indices[0]]) : ctx.format.colors.default ?? t.dataColors[0];
      const radius = sField ? 4 + Math.sqrt(sizes[i] / maxSize) * Math.min(28, width / 18) : 5;
      const keys = d.indices.map((k) => r.keys[k]);
      const identity = identityOf(dFields, keys);
      const c = s('circle', { cx: x(xs[i]), cy: y(ys[i]), r: radius, fill: color, 'fill-opacity': sField ? 0.7 : 1, stroke: t.surface, 'stroke-width': 2, opacity: markOpacity(ctx, identity) });
      interactive(
        ctx,
        c,
        identity,
        () => ({
          title: keys.map((k, j) => ctx.fmt(dFields[j], k)).join(' · '),
          items: [
            { label: xField.name, value: ctx.fmt(xField, xs[i]) },
            { label: yField.name, value: ctx.fmt(yField, ys[i]) },
            ...(sField ? [{ label: sField.name, value: ctx.fmt(sField, r.values[si!]) }] : []),
            ...(lField ? [{ label: lField.name, value: ctx.fmt(lField, r.keys[l.indices[0]]), color }] : []),
          ],
        }),
        keys,
      );
      marks.append(c);
    }
  },
});
