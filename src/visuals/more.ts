import { s, measureText, fitText } from '../render/svg';
import { bandScale, linearScale } from '../render/scales';
import { mix } from '../render/color';
import type { CellValue } from '../data/types';
import { valueKey } from '../data/types';
import { defineVisual } from './registry';
import { drawCategoryLabels, categoryLabelLayout, drawValueAxisY, emptyState, identityOf, interactive, markOpacity, mergeIdentity, pivot, renderLegend, tooltipItems, valueAxisFormatter, withLegend } from './common';

// ------------------------------------------------------------------- bullet

interface BulletFormat {
  /** Qualitative band edges as fractions of the maximum (default [0.6, 0.85, 1]). */
  bands?: number[];
  /** One scale for every row (default true). */
  sharedScale?: boolean;
}

/** Bullet chart: actual vs target over qualitative bands, one row per category. */
export const bullet = /* @__PURE__ */ defineVisual({
  type: 'bullet',
  displayName: 'Bullet chart',
  category: 'chart',
  roles: [
    { name: 'category', displayName: 'Category', kind: 'grouping' },
    { name: 'value', displayName: 'Value', kind: 'measure', required: true },
    { name: 'target', displayName: 'Target', kind: 'measure' },
    { name: 'maximum', displayName: 'Maximum', kind: 'measure' },
  ],
  defaultSort: 'key',
  render(ctx) {
    const ci = ctx.role('category').indices[0];
    const vi = ctx.role('value').indices[0];
    const ti = ctx.role('target').indices[0];
    const mi = ctx.role('maximum').indices[0];
    if (vi === undefined || !ctx.data.rows.length) return emptyState(ctx);
    const t = ctx.theme;
    const f = ctx.format;
    const bf = (f.bullet ?? {}) as BulletFormat;
    const bands = (bf.bands ?? [0.6, 0.85, 1]).slice().sort((a, b) => a - b);
    const vField = ctx.data.values[vi];
    const cField = ci !== undefined ? ctx.data.groups[ci] : undefined;
    const num = (v: CellValue) => (typeof v === 'number' ? v : null);
    const rows = ctx.data.rows.map((r) => {
      const v = num(r.values[vi]) ?? 0;
      const tg = ti !== undefined ? num(r.values[ti]) : null;
      const mx = mi !== undefined ? num(r.values[mi]) : null;
      return { r, v, tg, max: mx ?? Math.max(v, tg ?? 0) * 1.15 };
    });
    const sharedMax = Math.max(...rows.map((x) => x.max));
    const fs = t.labelFontSize;
    const W = ctx.width;
    const H = ctx.height;
    const labels = rows.map((x) => (cField ? ctx.fmt(cField, x.r.keys[ci!]) || '(Blank)' : vField.name));
    const left = Math.min(f.categoryAxis.maxLabelWidth, Math.ceil(Math.max(...labels.map((l) => measureText(l, fs, t.fontFamily)))) + 12);
    const valueW = Math.ceil(Math.max(...rows.map((x) => measureText(ctx.fmt(vField, x.v, { displayUnits: 'auto' }), fs, t.fontFamily, 600)))) + 10;
    const band = bandScale(rows.length, [4, H - 4], 0.35, 0.1);
    const svg = s('svg', { width: W, height: H, class: 'pbi-svg', role: 'img', 'aria-label': ctx.spec.title ?? 'Bullet chart' });
    const color = f.colors.default ?? t.dataColors[0];
    // band shades: steps from the gridline grey towards the surface
    const shades = bands.map((_, k) => mix(t.gridline, t.mode === 'dark' ? '#000000' : t.surface, 0.15 + (0.55 * (bands.length - 1 - k)) / Math.max(1, bands.length - 1)));
    rows.forEach((row, i) => {
      const max = bf.sharedScale === false ? row.max : sharedMax;
      const x = linearScale(0, max, [left, W - valueW], { fixedMax: max });
      const y = band(i);
      const hgt = Math.min(band.bandwidth, 34);
      const y0 = y + (band.bandwidth - hgt) / 2;
      let prev = 0;
      bands.forEach((b, k) => {
        const end = b * max;
        svg.append(s('rect', { x: x(prev), y: y0, width: Math.max(0, x(end) - x(prev)), height: hgt, fill: shades[k] }));
        prev = end;
      });
      const identity = cField ? identityOf([cField], [row.r.keys[ci!]]) : null;
      const bar = s('rect', { x: left, y: y0 + hgt * 0.3, width: Math.max(1, x(row.v) - left), height: hgt * 0.4, rx: 2, fill: color, opacity: identity ? markOpacity(ctx, identity) : 1 });
      const tip = () => ({
        title: labels[i],
        items: [
          { label: vField.name, value: ctx.fmt(vField, row.v), color },
          ...(row.tg !== null ? [{ label: ctx.data.values[ti!].name, value: ctx.fmt(ctx.data.values[ti!], row.tg) }, { label: '% of target', value: row.tg ? `${((row.v / row.tg) * 100).toFixed(1)}%` : '—' }] : []),
        ],
      });
      if (identity) interactive(ctx, bar, identity, tip, [row.r.keys[ci!]]);
      svg.append(bar);
      if (row.tg !== null) {
        const tx = x(row.tg);
        svg.append(s('line', { x1: tx, x2: tx, y1: y0 + hgt * 0.12, y2: y0 + hgt * 0.88, stroke: t.foreground, 'stroke-width': 2.5, 'pointer-events': 'none' }));
      }
      svg.append(s('text', { x: left - 8, y: y0 + hgt / 2 + fs / 3, 'text-anchor': 'end', class: 'pbi-tick', fill: t.foregroundSecondary }, fitText(labels[i], left - 10, fs, t.fontFamily)));
      svg.append(s('text', { x: W - valueW + 6, y: y0 + hgt / 2 + fs / 3, class: 'pbi-label', fill: t.foreground, 'font-weight': 600 }, ctx.fmt(vField, row.v, { displayUnits: 'auto' })));
    });
    ctx.root.replaceChildren(svg);
  },
});

// ------------------------------------------------------------------- radar

/** Radar chart: one spoke per category, one polygon per series, on a shared radial scale. */
export const radar = /* @__PURE__ */ defineVisual({
  type: 'radar',
  displayName: 'Radar chart',
  category: 'chart',
  roles: [
    { name: 'category', displayName: 'Category (spokes)', kind: 'grouping', required: true },
    { name: 'legend', displayName: 'Legend', kind: 'grouping' },
    { name: 'values', displayName: 'Values', kind: 'measure', multiple: true, required: true },
  ],
  defaultSort: 'key',
  render(ctx) {
    const pv = pivot(ctx);
    if (pv.categories.length < 3 || !pv.series.length) return emptyState(ctx, 'A radar chart needs at least three categories');
    const t = ctx.theme;
    const legend = renderLegend(ctx, pv.series.map((se) => ({ name: se.name, color: se.color, identity: se.identity, shape: 'line' as const })));
    const { plot, width, height } = withLegend(ctx, legend);
    const fs = t.labelFontSize;
    const labelW = Math.min(110, Math.max(...pv.categories.map((c) => measureText(c.label, fs, t.fontFamily))));
    const R = Math.max(20, Math.min(width / 2 - labelW - 8, height / 2 - fs - 8));
    const cx = width / 2;
    const cy = height / 2;
    const max = Math.max(...pv.series.flatMap((se) => se.values.map((v) => v ?? 0)), 0);
    const scale = linearScale(0, max, [0, R], { tickCount: 4 });
    const n = pv.categories.length;
    const ang = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2;
    const pt = (i: number, r: number) => [cx + r * Math.cos(ang(i)), cy + r * Math.sin(ang(i))] as [number, number];
    const svg = s('svg', { width, height, class: 'pbi-svg', role: 'img', 'aria-label': ctx.spec.title ?? 'Radar chart' });
    plot.append(svg);
    const fmt = valueAxisFormatter(ctx, pv.valueFields[0], scale);
    for (const tk of scale.ticks) {
      if (tk === 0) continue;
      const r = scale(tk);
      svg.append(s('polygon', { points: pv.categories.map((_, i) => pt(i, r).join(',')).join(' '), fill: 'none', stroke: t.gridline, 'stroke-width': 1 }));
      // labels sit left of the vertical axis, and the outermost (next to the top category label) is left out
      if (r < R - fs) svg.append(s('text', { x: cx - 4, y: cy - r + fs / 3, 'text-anchor': 'end', class: 'pbi-tick', fill: t.foregroundMuted }, fmt(tk)));
    }
    pv.categories.forEach((c, i) => {
      const [x, y] = pt(i, R);
      svg.append(s('line', { x1: cx, y1: cy, x2: x, y2: y, stroke: t.gridline, 'stroke-width': 1 }));
      const [lx, ly] = pt(i, R + 10);
      const cos = Math.cos(ang(i));
      svg.append(s('text', { x: lx, y: ly + fs / 3, 'text-anchor': Math.abs(cos) < 0.2 ? 'middle' : cos > 0 ? 'start' : 'end', class: 'pbi-tick pbi-cat', fill: t.foregroundSecondary }, fitText(c.label, labelW, fs, t.fontFamily)));
    });
    pv.series.forEach((se) => {
      const pts = se.values.map((v, i) => pt(i, scale(v ?? 0)));
      const op = se.identity ? markOpacity(ctx, se.identity) : 1;
      svg.append(s('polygon', { points: pts.map((p) => p.join(',')).join(' '), fill: se.color, 'fill-opacity': 0.1, stroke: se.color, 'stroke-width': 2, 'stroke-linejoin': 'round', opacity: op, 'pointer-events': 'none' }));
      pts.forEach((p, i) => {
        if (se.values[i] === null) return;
        const cat = pv.categories[i];
        const dot = s('circle', { cx: p[0], cy: p[1], r: 4, fill: se.color, stroke: t.surface, 'stroke-width': 2, opacity: markOpacity(ctx, mergeIdentity(cat.identity, se.identity)) });
        interactive(ctx, dot, mergeIdentity(cat.identity, se.identity), () => ({ title: cat.label, items: tooltipItems(ctx, cat, pv.series, i) }), cat.keys);
        svg.append(dot);
      });
    });
  },
});

// ------------------------------------------------------------------- sankey

interface SankeyNode {
  id: string;
  label: string;
  value: CellValue;
  depth: number;
  inflow: number;
  outflow: number;
  y: number;
  h: number;
  side: 'source' | 'target';
  colorIndex: number;
}

/** Sankey diagram: flows between source and target members (multi-stage when targets are also sources). */
export const sankey = /* @__PURE__ */ defineVisual({
  type: 'sankey',
  displayName: 'Sankey diagram',
  category: 'chart',
  roles: [
    { name: 'source', displayName: 'Source', kind: 'grouping', required: true },
    { name: 'target', displayName: 'Destination', kind: 'grouping', required: true },
    { name: 'values', displayName: 'Weight', kind: 'measure', required: true },
  ],
  render(ctx) {
    const si = ctx.role('source').indices[0];
    const ti = ctx.role('target').indices[0];
    const vi = ctx.role('values').indices[0];
    if (si === undefined || ti === undefined || vi === undefined) return emptyState(ctx);
    const sField = ctx.data.groups[si];
    const tField = ctx.data.groups[ti];
    const vField = ctx.data.values[vi];
    const links = ctx.data.rows
      .filter((r) => typeof r.values[vi] === 'number' && (r.values[vi] as number) > 0)
      .map((r) => ({ s: String(r.keys[si] ?? '(Blank)'), t: String(r.keys[ti] ?? '(Blank)'), sv: r.keys[si], tv: r.keys[ti], v: r.values[vi] as number }))
      .filter((l) => l.s !== l.t);
    if (!links.length) return emptyState(ctx);
    const t = ctx.theme;
    const nodes = new Map<string, SankeyNode>();
    const node = (id: string, value: CellValue, side: 'source' | 'target') => {
      let n = nodes.get(id);
      if (!n) nodes.set(id, (n = { id, label: id, value, depth: 0, inflow: 0, outflow: 0, y: 0, h: 0, side, colorIndex: nodes.size }));
      return n;
    };
    for (const l of links) {
      node(l.s, l.sv, 'source').outflow += l.v;
      node(l.t, l.tv, 'target').inflow += l.v;
    }
    // depth = longest path from a pure source (guarded against cycles)
    for (let iter = 0; iter < nodes.size; iter++) {
      let changed = false;
      for (const l of links) {
        const a = nodes.get(l.s)!;
        const b = nodes.get(l.t)!;
        if (b.depth < a.depth + 1 && a.depth + 1 < nodes.size) {
          b.depth = a.depth + 1;
          changed = true;
        }
      }
      if (!changed) break;
    }
    const depthMax = Math.max(...[...nodes.values()].map((n) => n.depth));
    const W = ctx.width;
    const H = ctx.height;
    const fs = t.labelFontSize;
    const nodeW = 12;
    const pad = 8;
    const labelRoom = Math.min(130, Math.max(...[...nodes.values()].map((n) => measureText(n.label, fs, t.fontFamily))) + 10);
    const colX = (d: number) => (depthMax === 0 ? 0 : ((W - nodeW) * d) / depthMax);
    const columns = new Map<number, SankeyNode[]>();
    for (const n of nodes.values()) columns.set(n.depth, [...(columns.get(n.depth) ?? []), n]);
    const size = (n: SankeyNode) => Math.max(n.inflow, n.outflow);
    const ky = Math.min(...[...columns.values()].map((col) => (H - pad * (col.length - 1)) / col.reduce((a, n) => a + size(n), 0)));
    for (const col of columns.values()) {
      col.sort((a, b) => size(b) - size(a));
      let y = 0;
      for (const n of col) {
        n.h = Math.max(1, size(n) * ky);
        n.y = y;
        y += n.h + pad;
      }
      const offset = (H - (y - pad)) / 2;
      for (const n of col) n.y += Math.max(0, offset);
    }
    const colorOf = (n: SankeyNode) => (n.side === 'source' ? ctx.colorFor(sField, n.value, n.colorIndex) : ctx.colorFor(tField, n.value, n.colorIndex));
    const svg = s('svg', { width: W, height: H, class: 'pbi-svg', role: 'img', 'aria-label': ctx.spec.title ?? 'Sankey diagram' });
    const outY = new Map<string, number>();
    const inY = new Map<string, number>();
    const sorted = links.slice().sort((a, b) => nodes.get(a.t)!.y - nodes.get(b.t)!.y);
    for (const l of sorted) {
      const a = nodes.get(l.s)!;
      const b = nodes.get(l.t)!;
      const w = l.v * ky;
      const y0 = a.y + (outY.get(a.id) ?? 0);
      const y1 = b.y + (inY.get(b.id) ?? 0);
      outY.set(a.id, (outY.get(a.id) ?? 0) + w);
      inY.set(b.id, (inY.get(b.id) ?? 0) + w);
      const x0 = colX(a.depth) + nodeW;
      const x1 = colX(b.depth);
      const mx = (x0 + x1) / 2;
      const identity = identityOf([sField, tField], [l.sv, l.tv]);
      const path = s('path', {
        d: `M${x0},${y0}C${mx},${y0} ${mx},${y1} ${x1},${y1}L${x1},${y1 + w}C${mx},${y1 + w} ${mx},${y0 + w} ${x0},${y0 + w}Z`,
        fill: colorOf(a),
        'fill-opacity': 0.35,
        opacity: markOpacity(ctx, identity),
      });
      interactive(ctx, path, identity, () => ({ title: `${l.s} → ${l.t}`, items: [{ label: vField.name, value: ctx.fmt(vField, l.v), color: colorOf(a) }] }), [l.sv, l.tv]);
      svg.append(path);
    }
    for (const n of nodes.values()) {
      const x = colX(n.depth);
      const color = colorOf(n);
      const field = n.side === 'source' ? sField : tField;
      const identity = identityOf([field], [n.value]);
      const rect = s('rect', { x, y: n.y, width: nodeW, height: n.h, rx: 2, fill: color, opacity: markOpacity(ctx, identity) });
      interactive(ctx, rect, identity, () => ({ title: n.label, items: [{ label: 'In', value: ctx.fmt(vField, n.inflow) }, { label: 'Out', value: ctx.fmt(vField, n.outflow) }] }), [n.value]);
      svg.append(rect);
      const rightSide = n.depth < depthMax || depthMax === 0;
      svg.append(s('text', { x: rightSide ? x + nodeW + 6 : x - 6, y: n.y + n.h / 2 + fs / 3, 'text-anchor': rightSide ? 'start' : 'end', class: 'pbi-label', fill: t.foregroundSecondary }, fitText(n.label, labelRoom - 8, fs, t.fontFamily)));
    }
    ctx.root.replaceChildren(svg);
  },
});

// ------------------------------------------------------------------- ribbon

/** Ribbon chart: stacked columns ranked within each category, with ribbons showing rank changes. */
export const ribbon = /* @__PURE__ */ defineVisual({
  type: 'ribbon',
  displayName: 'Ribbon chart',
  category: 'chart',
  roles: [
    { name: 'category', displayName: 'X-axis', kind: 'grouping', required: true },
    { name: 'legend', displayName: 'Legend', kind: 'grouping', required: true },
    { name: 'values', displayName: 'Y-axis', kind: 'measure', required: true },
  ],
  defaultSort: 'key',
  render(ctx) {
    const pv = pivot(ctx);
    if (!pv.categories.length || !pv.series.length) return emptyState(ctx);
    const t = ctx.theme;
    const f = ctx.format;
    const legend = renderLegend(ctx, pv.series.map((se) => ({ name: se.name, color: se.color, identity: se.identity })));
    const { plot, width, height } = withLegend(ctx, legend);
    const fs = t.labelFontSize;
    const totals = pv.categories.map((_, ci) => pv.series.reduce((a, se) => a + Math.max(0, se.values[ci] ?? 0), 0));
    let y = linearScale(0, Math.max(...totals), [height - 30, 8]);
    const fmtY = valueAxisFormatter(ctx, pv.valueFields[0], y);
    const left = Math.ceil(Math.max(...y.ticks.map((v) => measureText(fmtY(v), fs, t.fontFamily)))) + 12;
    const band = bandScale(pv.categories.length, [left, width - 8], 0.5, 0.1);
    const labels = pv.categories.map((c) => c.label);
    const layout = categoryLabelLayout(ctx, labels, band.step);
    const bottom = height - layout.height - 2;
    y = linearScale(0, Math.max(...totals), [bottom, 8], { tickCount: Math.max(2, Math.floor((bottom - 8) / 36)) });
    const svg = s('svg', { width, height, class: 'pbi-svg', role: 'img', 'aria-label': ctx.spec.title ?? 'Ribbon chart' });
    plot.append(svg);
    const g = s('g');
    svg.append(g);
    drawValueAxisY(ctx, g, y, left, width - 8, valueAxisFormatter(ctx, pv.valueFields[0], y));
    drawCategoryLabels(ctx, g, labels, (i) => band(i) + band.bandwidth / 2, bottom, layout);
    const gap = f.bars.gap;
    // per category: segments stacked with the largest on top
    const seg = pv.categories.map((_, ci) => {
      const order = pv.series.map((se, si) => ({ si, v: Math.max(0, se.values[ci] ?? 0) })).sort((a, b) => a.v - b.v);
      const out = new Map<number, { y0: number; y1: number }>();
      let acc = 0;
      for (const o of order) {
        out.set(o.si, { y0: y(acc), y1: y(acc + o.v) });
        acc += o.v;
      }
      return out;
    });
    const bw = Math.min(band.bandwidth, 44);
    const xL = (ci: number) => band(ci) + (band.bandwidth - bw) / 2;
    // ribbons first (behind the columns)
    pv.series.forEach((se, si) => {
      for (let ci = 0; ci < pv.categories.length - 1; ci++) {
        const a = seg[ci].get(si)!;
        const b = seg[ci + 1].get(si)!;
        if (a.y0 === a.y1 && b.y0 === b.y1) continue;
        const x0 = xL(ci) + bw;
        const x1 = xL(ci + 1);
        const mx = (x0 + x1) / 2;
        g.append(
          s('path', {
            d: `M${x0},${a.y1 + gap / 2}C${mx},${a.y1 + gap / 2} ${mx},${b.y1 + gap / 2} ${x1},${b.y1 + gap / 2}L${x1},${b.y0 - gap / 2}C${mx},${b.y0 - gap / 2} ${mx},${a.y0 - gap / 2} ${x0},${a.y0 - gap / 2}Z`,
            fill: se.color,
            'fill-opacity': 0.28,
            opacity: se.identity ? markOpacity(ctx, se.identity) : 1,
            'pointer-events': 'none',
          }),
        );
      }
    });
    pv.categories.forEach((cat, ci) => {
      pv.series.forEach((se, si) => {
        const v = se.values[ci];
        if (!v) return;
        const sg = seg[ci].get(si)!;
        // never let a non-zero value vanish: at least a 1px sliver
        const hgt = Math.max(1, sg.y0 - sg.y1 - gap);
        const identity = mergeIdentity(cat.identity, se.identity);
        const rect = s('rect', { x: xL(ci), y: sg.y1 + gap / 2, width: bw, height: hgt, rx: 2, fill: se.color, opacity: markOpacity(ctx, identity) });
        interactive(ctx, rect, identity, () => ({ title: cat.label, items: tooltipItems(ctx, cat, pv.series, ci) }), cat.keys);
        g.append(rect);
      });
    });
    void valueKey;
  },
});
