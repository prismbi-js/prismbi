import { s, measureText, fitText, h } from '../render/svg';
import { ramp, textOn } from '../render/color';
import type { CellValue } from '../data/types';
import { valueKey } from '../data/types';
import { defineVisual } from './registry';
import { emptyState, identityOf, interactive, markOpacity } from './common';
import { valueColor } from './analytics';
import { paintRects, useRaster, type RasterLabel, type RasterRect } from './raster';

/** Heatmap: rows × columns grid coloured by a measure on a single-hue sequential ramp. */
export const heatmap = /* @__PURE__ */ defineVisual({
  type: 'heatmap',
  displayName: 'Heatmap',
  category: 'chart',
  roles: [
    { name: 'rows', displayName: 'Rows', kind: 'grouping', required: true },
    { name: 'columns', displayName: 'Columns', kind: 'grouping', required: true },
    { name: 'values', displayName: 'Value', kind: 'measure', required: true },
  ],
  defaultSort: 'key',
  render(ctx) {
    const ri = ctx.role('rows').indices[0];
    const ci = ctx.role('columns').indices[0];
    const vi = ctx.role('values').indices[0];
    if (ri === undefined || ci === undefined || vi === undefined || !ctx.data.rows.length) return emptyState(ctx);
    const { data, theme: t, format: f } = ctx;
    const rField = data.groups[ri];
    const cField = data.groups[ci];
    const vField = data.values[vi];
    const uniq = (idx: number) => [...new Map(data.rows.map((r) => [valueKey(r.keys[idx]), r.keys[idx]])).values()];
    const rowKeys = uniq(ri);
    const colOrder = new Map<unknown, number>();
    ctx.model.table(cField.column!.table).distinct(cField.column!.column).forEach((v, i) => colOrder.set(valueKey(v), i));
    const colKeys = uniq(ci).sort((a, b) => (colOrder.get(valueKey(a)) ?? 0) - (colOrder.get(valueKey(b)) ?? 0));
    const cell = new Map<string, CellValue>();
    for (const r of data.rows) cell.set(`${valueKey(r.keys[ri])}|${valueKey(r.keys[ci])}`, r.values[vi]);
    const nums = data.rows.map((r) => r.values[vi]).filter((v): v is number => typeof v === 'number');
    const lo = Math.min(...nums);
    const hi = Math.max(...nums);
    const stops = t.mode === 'dark' ? [...t.sequential].reverse() : t.sequential;
    const colorOf = (v: number) => (f.colors.gradient || f.colors.rules?.length ? valueColor(ctx, v, [lo, hi], stops[3]) : ramp(stops.slice(0, -1), hi === lo ? 1 : (v - lo) / (hi - lo)));

    const fs = t.labelFontSize;
    const W = ctx.width;
    const H = ctx.height;
    const legendH = 26;
    const left = Math.min(f.categoryAxis.maxLabelWidth, Math.ceil(Math.max(...rowKeys.map((k) => measureText(ctx.fmt(rField, k), fs, t.fontFamily)))) + 10);
    const top = fs + 10;
    const cw = Math.max(4, (W - left) / colKeys.length);
    const ch = Math.max(4, (H - top - legendH) / rowKeys.length);
    const svg = s('svg', { width: W, height: H, class: 'pbi-svg', role: 'img', 'aria-label': ctx.spec.title ?? 'Heatmap' });
    colKeys.forEach((ck, j) => {
      const label = fitText(ctx.fmt(cField, ck), cw - 4, fs, t.fontFamily);
      svg.append(s('text', { x: left + j * cw + cw / 2, y: fs + 2, 'text-anchor': 'middle', class: 'pbi-tick', fill: t.foregroundSecondary }, label));
    });
    const showLabels = f.dataLabels.show !== false && ch >= fs + 6;
    // large grids paint on a canvas (hit-tested by row and column) instead of one element per cell
    const raster = useRaster(ctx, 'heatmap', rowKeys.length * colKeys.length);
    const rects: RasterRect[] = [];
    const labels: RasterLabel[] = [];
    rowKeys.forEach((rk, i) => {
      svg.append(s('text', { x: left - 8, y: top + i * ch + ch / 2 + fs / 3, 'text-anchor': 'end', class: 'pbi-tick', fill: t.foregroundSecondary }, fitText(ctx.fmt(rField, rk), left - 10, fs, t.fontFamily)));
      colKeys.forEach((ck, j) => {
        const v = cell.get(`${valueKey(rk)}|${valueKey(ck)}`) ?? null;
        const x = left + j * cw + 1;
        const y = top + i * ch + 1;
        const identity = identityOf([rField, cField], [rk, ck]);
        const fill = typeof v === 'number' ? colorOf(v) : t.gridline;
        const tooltip = () => ({ title: `${ctx.fmt(rField, rk)} · ${ctx.fmt(cField, ck)}`, items: [{ label: vField.name, value: ctx.fmt(vField, v, { blank: '(Blank)' }) }] });
        const label = showLabels && typeof v === 'number' ? ctx.fmt(vField, v, { displayUnits: 'auto' }) : '';
        const fits = label && measureText(label, fs, t.fontFamily) + 6 <= cw;
        if (raster) {
          rects.push({ x, y, w: Math.max(1, cw - 2), h: Math.max(1, ch - 2), fill, alpha: markOpacity(ctx, identity), identity, keys: [rk, ck], tooltip });
          if (fits) labels.push({ x: x + cw / 2 - 1, y: y + ch / 2 + fs / 3 - 1, text: label, fill: textOn(fill, t.foreground) });
          return;
        }
        const rect = s('rect', { x, y, width: Math.max(1, cw - 2), height: Math.max(1, ch - 2), rx: 2, fill, opacity: markOpacity(ctx, identity) });
        interactive(ctx, rect, identity, tooltip, [rk, ck]);
        svg.append(rect);
        if (fits) svg.append(s('text', { x: x + cw / 2 - 1, y: y + ch / 2 + fs / 3 - 1, 'text-anchor': 'middle', class: 'pbi-label', fill: textOn(fill, t.foreground) }, label));
      });
    });
    // gradient legend
    const gid = `pbi-hm-${Math.random().toString(36).slice(2, 8)}`;
    const defs = s('defs');
    const lg = s('linearGradient', { id: gid, x1: 0, x2: 1, y1: 0, y2: 0 });
    stops.slice(0, -1).forEach((c, k, arr) => lg.append(s('stop', { offset: `${(k / Math.max(1, arr.length - 1)) * 100}%`, 'stop-color': c })));
    defs.append(lg);
    svg.append(defs);
    const lw = Math.min(180, W - left);
    const ly = H - legendH + 8;
    svg.append(s('text', { x: left, y: ly + 10, 'text-anchor': 'end', dx: -6, class: 'pbi-tick', fill: t.foregroundMuted }, ctx.fmt(vField, lo, { displayUnits: 'auto' })));
    svg.append(s('rect', { x: left, y: ly, width: lw, height: 10, rx: 3, fill: `url(#${gid})` }));
    svg.append(s('text', { x: left + lw + 6, y: ly + 10, class: 'pbi-tick', fill: t.foregroundMuted }, ctx.fmt(vField, hi, { displayUnits: 'auto' })));
    ctx.root.replaceChildren(svg);
    const find = (px: number, py: number) => {
      const j = Math.floor((px - left) / cw);
      const i = Math.floor((py - top) / ch);
      return j >= 0 && j < colKeys.length && i >= 0 && i < rowKeys.length ? rects[i * colKeys.length + j] : undefined;
    };
    if (raster && !paintRects(ctx, svg, rects, W, H, cw >= 6 && ch >= 6 ? 2 : 0, find, labels)) {
      // no 2D canvas (headless export): fall back to SVG cells
      for (const r of rects) {
        const rect = s('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 2, fill: r.fill, opacity: r.alpha });
        interactive(ctx, rect, r.identity, r.tooltip, r.keys);
        svg.insertBefore(rect, svg.querySelector('defs'));
      }
      for (const l of labels) svg.insertBefore(s('text', { x: l.x, y: l.y, 'text-anchor': 'middle', class: 'pbi-label', fill: l.fill }, l.text), svg.querySelector('defs'));
    }
    void h;
  },
});
