import { s, arcPath, measureText, fitText, h } from '../render/svg';
import { textOn } from '../render/color';
import type { CellValue } from '../data/types';
import type { QueryField } from '../data/query';
import type { DataPointIdentity, RenderContext } from './types';
import { defineVisual } from './registry';
import { animateIn, emptyState, identityOf, interactive, labelFormatter, markOpacity, renderLegend, withLegend } from './common';

interface Slice {
  label: string;
  value: number;
  highlight: number | null;
  color: string;
  identity: DataPointIdentity | null;
  keys: CellValue[];
}

/** Rows → slices; folds anything beyond the palette into a single "Other" slice. */
function slices(ctx: RenderContext, groupRole: string, max: number): { slices: Slice[]; field?: QueryField; total: number } {
  const g = ctx.role(groupRole);
  const v = ctx.role('values');
  if (!v.indices.length) return { slices: [], total: 0 };
  const gi = g.indices[0];
  const vi = v.indices[0];
  const gField = gi !== undefined ? ctx.data.groups[gi] : undefined;
  const vField = ctx.data.values[vi];
  let out: Slice[] = ctx.data.rows
    .map((r) => {
      const key = gi !== undefined ? r.keys[gi] : vField.name;
      const val = typeof r.values[vi] === 'number' ? (r.values[vi] as number) : 0;
      return {
        label: gField ? ctx.fmt(gField, key) || '(Blank)' : vField.name,
        value: val,
        highlight: r.highlights ? ((r.highlights[vi] as number | null) ?? 0) : null,
        color: gField ? ctx.colorFor(gField, key) : ctx.seriesColor(vField.name, 0),
        identity: gField ? identityOf([gField], [key]) : null,
        keys: [key],
      };
    })
    .filter((x) => x.value > 0);
  if (!ctx.spec.sort) out.sort((a, b) => b.value - a.value);
  if (out.length > max) {
    const rest = out.slice(max - 1);
    out = out.slice(0, max - 1);
    out.push({
      label: `Other (${rest.length})`,
      value: rest.reduce((a, x) => a + x.value, 0),
      highlight: rest.some((x) => x.highlight !== null) ? rest.reduce((a, x) => a + (x.highlight ?? 0), 0) : null,
      color: ctx.theme.otherColor,
      identity: null,
      keys: [],
    });
  }
  return { slices: out, field: vField, total: out.reduce((a, x) => a + x.value, 0) };
}

function renderPie(ctx: RenderContext, donut: boolean): void {
  const max = (ctx.format.pie as { maxSlices?: number } | undefined)?.maxSlices ?? ctx.theme.dataColors.length;
  const { slices: data, field, total } = slices(ctx, 'legend', max);
  if (!data.length) return emptyState(ctx);
  const t = ctx.theme;
  const legend = renderLegend(ctx, data.map((d) => ({ name: d.label, color: d.color, identity: d.identity ?? undefined })));
  const { plot, width, height } = withLegend(ctx, legend);
  const svg = s('svg', { width, height, class: 'pbi-svg', role: 'img', 'aria-label': ctx.spec.title ?? 'Pie chart' });
  plot.append(svg);
  const cx = width / 2;
  const cy = height / 2;
  const r1 = Math.max(10, Math.min(width, height) / 2 - 8);
  const inner = (ctx.format.donut as { innerRadius?: number } | undefined)?.innerRadius ?? 0.62;
  const r0 = donut ? r1 * inner : 0;
  const gapAngle = data.length > 1 ? 2 / r1 : 0; // ≈2px surface gap
  const fs = t.labelFontSize;
  const fmtLabel = labelFormatter(ctx, field);
  let a = 0;
  const g = s('g');
  svg.append(g);
  for (const d of data) {
    const sweep = (d.value / total) * Math.PI * 2;
    const a0 = a + gapAngle / 2;
    const a1 = a + sweep - gapAngle / 2;
    const op = d.identity ? markOpacity(ctx, d.identity) : 1;
    const hasHl = d.highlight !== null;
    const path = s('path', { d: arcPath(cx, cy, r0, r1, a0, Math.max(a0 + 0.001, a1)), fill: d.color, opacity: hasHl ? 0.3 : op });
    if (d.identity) interactive(ctx, path, d.identity, () => ({ title: d.label, items: [{ label: field?.name ?? '', value: ctx.fmt(field, d.value), color: d.color }, { label: 'Share', value: `${((d.value / total) * 100).toFixed(1)}%` }] }), d.keys);
    else path.classList.add('pbi-mark');
    animateIn(ctx, path, 'center');
    g.append(path);
    if (hasHl && d.highlight! > 0) {
      const hr = r0 + (r1 - r0) * Math.min(1, d.highlight! / d.value);
      g.append(s('path', { d: arcPath(cx, cy, r0, hr, a0, Math.max(a0 + 0.001, a1)), fill: d.color, 'pointer-events': 'none' }));
    }
    // percentage label inside when it fits
    const mid = (a0 + a1) / 2;
    const lr = donut ? (r0 + r1) / 2 : r1 * 0.66;
    const pct = `${((d.value / total) * 100).toFixed(d.value / total < 0.1 ? 1 : 0)}%`;
    const text = ctx.format.dataLabels.show ? fmtLabel(d.value) : pct;
    const arcLen = sweep * lr;
    if (arcLen > measureText(text, fs, t.fontFamily) + 8 && (r1 - r0 > fs + 6 || !donut))
      g.append(s('text', { x: cx + lr * Math.sin(mid), y: cy - lr * Math.cos(mid) + fs / 3, 'text-anchor': 'middle', class: 'pbi-label', fill: textOn(d.color, t.foreground), opacity: op, 'pointer-events': 'none' }, text));
    a += sweep;
  }
  if (donut && r0 > 30) {
    const center = (ctx.format.donut as { centerLabel?: boolean } | undefined)?.centerLabel ?? true;
    if (center) {
      const big = Math.min(22, r0 / 2.6);
      g.append(s('text', { x: cx, y: cy + big / 3 - 4, 'text-anchor': 'middle', class: 'pbi-center-value', fill: t.foreground, 'font-size': big, 'font-weight': 600 }, ctx.fmt(field, total, { displayUnits: 'auto' })));
      g.append(s('text', { x: cx, y: cy + big / 3 + 13, 'text-anchor': 'middle', class: 'pbi-tick', fill: t.foregroundMuted }, fitText(field?.name ?? 'Total', r0 * 1.6, fs, t.fontFamily)));
    }
  }
}

export const pieChart = defineVisual({
  type: 'pie',
  displayName: 'Pie chart',
  category: 'chart',
  roles: [
    { name: 'legend', displayName: 'Legend', kind: 'grouping', drillable: true, multiple: true },
    { name: 'values', displayName: 'Values', kind: 'measure', required: true },
  ],
  supportsHighlight: true,
  defaultFormat: { legend: { position: 'right' } },
  render: (c) => renderPie(c, false),
});

export const donutChart = defineVisual({ ...pieChart, type: 'donut', displayName: 'Donut chart', render: (c) => renderPie(c, true) });

// ------------------------------------------------------------- treemap

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Squarified treemap layout (Bruls et al.). Values must be sorted descending. */
export function squarify(values: number[], rect: Rect): Rect[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return values.map(() => ({ x: rect.x, y: rect.y, w: 0, h: 0 }));
  const area = values.map((v) => (v / total) * rect.w * rect.h);
  const out: Rect[] = new Array(values.length);
  let { x, y, w, h: hh } = rect;
  let i = 0;
  const worst = (row: number[], side: number) => {
    const sum = row.reduce((a, b) => a + b, 0);
    const mx = Math.max(...row);
    const mn = Math.min(...row);
    return Math.max((side * side * mx) / (sum * sum), (sum * sum) / (side * side * mn));
  };
  while (i < area.length) {
    const side = Math.min(w, hh);
    const row = [area[i]];
    let j = i + 1;
    while (j < area.length && worst([...row, area[j]], side) <= worst(row, side)) row.push(area[j++]);
    const sum = row.reduce((a, b) => a + b, 0);
    if (w >= hh) {
      const cw = sum / hh;
      let cy = y;
      row.forEach((ar, k) => {
        out[i + k] = { x, y: cy, w: cw, h: ar / cw };
        cy += ar / cw;
      });
      x += cw;
      w -= cw;
    } else {
      const ch = sum / w;
      let cx = x;
      row.forEach((ar, k) => {
        out[i + k] = { x: cx, y, w: ar / ch, h: ch };
        cx += ar / ch;
      });
      y += ch;
      hh -= ch;
    }
    i = j;
  }
  return out;
}

export const treemap = defineVisual({
  type: 'treemap',
  displayName: 'Treemap',
  category: 'chart',
  roles: [
    { name: 'category', displayName: 'Category', kind: 'grouping', drillable: true, multiple: true },
    { name: 'values', displayName: 'Values', kind: 'measure', required: true },
  ],
  supportsHighlight: true,
  render(ctx) {
    const { slices: data, field, total } = slices(ctx, 'category', 30);
    if (!data.length) return emptyState(ctx);
    // treemaps colour by entity but have many tiles: tiles beyond the palette use the "other" colour
    const t = ctx.theme;
    ctx.root.replaceChildren();
    const svg = s('svg', { width: ctx.width, height: ctx.height, class: 'pbi-svg', role: 'img', 'aria-label': ctx.spec.title ?? 'Treemap' });
    ctx.root.append(svg);
    const rects = squarify(data.map((d) => d.value), { x: 0, y: 0, w: ctx.width, h: ctx.height });
    const fs = t.labelFontSize;
    data.forEach((d, i) => {
      const r = rects[i];
      const gap = 1;
      const x = r.x + gap;
      const y = r.y + gap;
      const w = Math.max(0, r.w - gap * 2);
      const hgt = Math.max(0, r.h - gap * 2);
      const op = d.identity ? markOpacity(ctx, d.identity) : 1;
      const rect = s('rect', { x, y, width: w, height: hgt, rx: 3, fill: d.color, opacity: d.highlight !== null ? 0.35 : op });
      if (d.identity) interactive(ctx, rect, d.identity, () => ({ title: d.label, items: [{ label: field?.name ?? '', value: ctx.fmt(field, d.value), color: d.color }, { label: 'Share', value: `${((d.value / total) * 100).toFixed(1)}%` }] }), d.keys);
      svg.append(rect);
      if (w > 40 && hgt > fs * 2 + 8) {
        const ink = textOn(d.color, t.foreground);
        svg.append(s('text', { x: x + 6, y: y + fs + 5, class: 'pbi-label', fill: ink, 'font-weight': 600, 'pointer-events': 'none', opacity: op }, fitText(d.label, w - 12, fs, t.fontFamily)));
        svg.append(s('text', { x: x + 6, y: y + fs * 2 + 9, class: 'pbi-label', fill: ink, 'pointer-events': 'none', opacity: op }, ctx.fmt(field, d.value, { displayUnits: 'auto' })));
      }
    });
  },
});

// ------------------------------------------------------------- funnel

export const funnel = defineVisual({
  type: 'funnel',
  displayName: 'Funnel',
  category: 'chart',
  roles: [
    { name: 'category', displayName: 'Category', kind: 'grouping', required: true },
    { name: 'values', displayName: 'Values', kind: 'measure', required: true },
  ],
  supportsHighlight: true,
  defaultSort: 'value',
  render(ctx) {
    const g = ctx.role('category');
    const v = ctx.role('values');
    const gi = g.indices[0];
    const vi = v.indices[0];
    if (gi === undefined || vi === undefined || !ctx.data.rows.length) return emptyState(ctx);
    const gField = ctx.data.groups[gi];
    const vField = ctx.data.values[vi];
    const rows = ctx.data.rows.filter((r) => typeof r.values[vi] === 'number');
    if (!rows.length) return emptyState(ctx);
    const t = ctx.theme;
    const fs = t.labelFontSize;
    ctx.root.replaceChildren();
    const svg = s('svg', { width: ctx.width, height: ctx.height, class: 'pbi-svg', role: 'img', 'aria-label': ctx.spec.title ?? 'Funnel' });
    ctx.root.append(svg);
    const first = rows[0].values[vi] as number;
    const max = Math.max(...rows.map((r) => r.values[vi] as number));
    const labelW = Math.min(ctx.width * 0.3, Math.max(...rows.map((r) => measureText(ctx.fmt(gField, r.keys[gi]), fs, t.fontFamily))) + 12);
    const plotW = ctx.width - labelW - 8;
    const step = ctx.height / rows.length;
    const thick = Math.min(step - 4, 40);
    const color = ctx.format.colors.default ?? t.dataColors[0];
    rows.forEach((r, i) => {
      const val = r.values[vi] as number;
      const w = Math.max(2, (val / max) * plotW);
      const x = labelW + (plotW - w) / 2;
      const y = i * step + (step - thick) / 2;
      const identity = identityOf([gField], [r.keys[gi]]);
      const op = markOpacity(ctx, identity);
      const rect = s('rect', { x, y, width: w, height: thick, rx: 4, fill: color, opacity: r.highlights ? 0.3 : op });
      interactive(ctx, rect, identity, () => ({ title: ctx.fmt(gField, r.keys[gi]), items: [{ label: vField.name, value: ctx.fmt(vField, val), color }, { label: '% of first', value: `${((val / first) * 100).toFixed(1)}%` }] }), [r.keys[gi]]);
      svg.append(rect);
      const hl = r.highlights?.[vi];
      if (typeof hl === 'number') svg.append(s('rect', { x: labelW + (plotW - (hl / max) * plotW) / 2, y, width: (hl / max) * plotW, height: thick, rx: 4, fill: color, 'pointer-events': 'none' }));
      svg.append(s('text', { x: labelW - 8, y: y + thick / 2 + fs / 3, 'text-anchor': 'end', class: 'pbi-tick', fill: t.foregroundSecondary }, fitText(ctx.fmt(gField, r.keys[gi]), labelW - 10, fs, t.fontFamily)));
      const label = `${ctx.fmt(vField, val, { displayUnits: 'auto' })} · ${((val / first) * 100).toFixed(0)}%`;
      const lw = measureText(label, fs, t.fontFamily);
      if (lw + 10 < w) svg.append(s('text', { x: labelW + plotW / 2, y: y + thick / 2 + fs / 3, 'text-anchor': 'middle', class: 'pbi-label', fill: textOn(color, t.foreground), 'pointer-events': 'none' }, label));
      else svg.append(s('text', { x: x + w + 6, y: y + thick / 2 + fs / 3, class: 'pbi-label', fill: t.foregroundSecondary }, label));
    });
    void h;
  },
});
