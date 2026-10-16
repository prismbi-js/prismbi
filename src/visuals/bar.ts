import { s, barPath, measureText } from '../render/svg';
import { bandScale, linearScale } from '../render/scales';
import { textOn } from '../render/color';
import type { RenderContext, VisualDefinition } from './types';
import { defineVisual } from './registry';
import {
  animateIn,
  categoryLabelLayout,
  drawCategoryLabels,
  drawValueAxisX,
  drawValueAxisY,
  emptyState,
  interactive,
  labelFormatter,
  markOpacity,
  mergeIdentity,
  pivot,
  renderLegend,
  tooltipItems,
  valueAxisFormatter,
  withLegend,
} from './common';
import { fitText } from '../render/svg';

type Mode = 'clustered' | 'stacked' | 'percent';

const ROLES = [
  { name: 'category', displayName: 'Axis', kind: 'grouping' as const, multiple: true, drillable: true },
  { name: 'legend', displayName: 'Legend', kind: 'grouping' as const },
  { name: 'values', displayName: 'Values', kind: 'measure' as const, multiple: true, required: true },
];

function renderBars(ctx: RenderContext, horizontal: boolean, mode: Mode): void {
  const pv = pivot(ctx, 'category', 'legend', 'values', mode !== 'clustered');
  if (!pv.categories.length || !pv.series.length) return emptyState(ctx);
  const { categories, series } = pv;
  const t = ctx.theme;
  const f = ctx.format;
  const legend = renderLegend(ctx, series.map((se) => ({ name: se.name, color: se.color, identity: se.identity })));
  const { plot, width, height } = withLegend(ctx, legend);

  // ---- value domain
  const totals = categories.map((_, ci) => series.reduce((a, se) => a + Math.abs(se.values[ci] ?? 0), 0));
  const norm = (v: number | null, ci: number) => (v === null ? null : mode === 'percent' ? (totals[ci] ? v / totals[ci] : 0) : v);
  let lo = 0;
  let hi = 0;
  categories.forEach((_, ci) => {
    if (mode === 'clustered') {
      for (const se of series) {
        const v = se.values[ci] ?? 0;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    } else {
      let pos = 0;
      let neg = 0;
      for (const se of series) {
        const v = norm(se.values[ci], ci) ?? 0;
        if (v >= 0) pos += v;
        else neg += v;
      }
      lo = Math.min(lo, neg);
      hi = Math.max(hi, pos);
    }
  });
  const va = f.valueAxis;
  const valueField = mode === 'percent' ? { name: '%', ref: '%', kind: 'value' as const, format: '0%' } : pv.valueFields[0];
  const labelFmt = labelFormatter(ctx, valueField);
  const fs = t.labelFontSize;
  const showLabels = f.dataLabels.show;

  // ---- layout
  const svg = s('svg', { width, height, class: 'pbi-svg', role: 'img', 'aria-label': ctx.spec.title ?? 'Bar chart' });
  const g = s('g');
  svg.append(g);
  plot.append(svg);
  const labels = categories.map((c) => c.label);

  if (!horizontal) {
    const top = showLabels && mode === 'clustered' ? fs + 8 : 8;
    // provisional scale to size the y axis
    let scale = linearScale(lo, hi, [height - 30, top], { fixedMin: va.min, fixedMax: mode === 'percent' ? 1 : va.max, tickCount: Math.max(2, Math.min(va.tickCount, Math.floor(height / 40))) });
    const fmtAxis = valueAxisFormatter(ctx, valueField, scale);
    const left = va.show ? Math.ceil(Math.max(...scale.ticks.map((x) => measureText(fmtAxis(x), fs, t.fontFamily)))) + 12 : 8;
    const right = 8;
    const prelimBand = bandScale(categories.length, [left, width - right], f.bars.categoryGap, 0.15);
    const catLayout = categoryLabelLayout(ctx, labels, prelimBand.step);
    const bottom = height - catLayout.height - 2;
    scale = linearScale(lo, hi, [bottom, top], { fixedMin: va.min, fixedMax: mode === 'percent' ? 1 : va.max, tickCount: Math.max(2, Math.min(va.tickCount, Math.floor((bottom - top) / 36))) });
    drawValueAxisY(ctx, g, scale, left, width - right, valueAxisFormatter(ctx, valueField, scale));
    const band = bandScale(categories.length, [left, width - right], f.bars.categoryGap, 0.15);
    drawCategoryLabels(ctx, g, labels, (i) => band(i) + band.bandwidth / 2, bottom, catLayout);
    const marks = s('g', { class: 'pbi-marks' });
    g.append(marks);
    const gap = f.bars.gap;

    categories.forEach((cat, ci) => {
      if (mode === 'clustered') {
        const n = series.length;
        const thick = Math.max(1, Math.min(f.bars.maxThickness, (band.bandwidth - gap * (n - 1)) / n));
        const groupW = thick * n + gap * (n - 1);
        const x0 = band(ci) + (band.bandwidth - groupW) / 2;
        series.forEach((se, si) => {
          const v = se.values[ci];
          if (v === null) return;
          const x = x0 + si * (thick + gap);
          const y0 = scale(0);
          const y1 = scale(v);
          const identity = mergeIdentity(cat.identity, se.identity);
          const hl = se.highlights?.[ci];
          const op = markOpacity(ctx, identity);
          const path = s('path', { d: barPath(x, Math.min(y0, y1), thick, Math.abs(y1 - y0), f.bars.radius, v >= 0 ? 'top' : 'bottom'), fill: se.color, opacity: se.highlights ? 0.3 : op });
          interactive(ctx, path, identity, () => ({ title: cat.label, items: tooltipItems(ctx, cat, series, ci) }), cat.keys);
          animateIn(ctx, path, v >= 0 ? 'bottom' : 'top');
          marks.append(path);
          if (se.highlights && hl !== null && hl !== undefined) {
            const yh = scale(hl);
            const hp = s('path', { d: barPath(x, Math.min(y0, yh), thick, Math.abs(yh - y0), f.bars.radius, hl >= 0 ? 'top' : 'bottom'), fill: se.color, 'pointer-events': 'none' });
            marks.append(hp);
          }
          if (showLabels) {
            const text = labelFmt(se.highlights && hl !== null && hl !== undefined ? hl : v);
            if (measureText(text, fs, t.fontFamily) <= Math.max(thick + gap * 2 + 24, band.step - 2) / Math.max(1, n > 2 ? n / 2 : 1))
              marks.append(s('text', { x: x + thick / 2, y: v >= 0 ? y1 - 5 : y1 + fs + 3, 'text-anchor': 'middle', class: 'pbi-label', fill: f.dataLabels.color ?? t.foregroundSecondary, opacity: op }, text));
          }
        });
      } else {
        const thick = Math.min(f.bars.maxThickness * 1.6, band.bandwidth);
        const x = band(ci) + (band.bandwidth - thick) / 2;
        let pos = 0;
        let neg = 0;
        const lastPos = series.map((se) => norm(se.values[ci], ci) ?? 0).reduce((acc, v, i) => (v > 0 ? i : acc), -1);
        const lastNeg = series.map((se) => norm(se.values[ci], ci) ?? 0).reduce((acc, v, i) => (v < 0 ? i : acc), -1);
        series.forEach((se, si) => {
          const v = norm(se.values[ci], ci);
          if (v === null || v === 0) return;
          const base = v >= 0 ? pos : neg;
          const end = base + v;
          if (v >= 0) pos = end;
          else neg = end;
          const ya = scale(base);
          const yb = scale(end);
          const isEnd = v >= 0 ? si === lastPos : si === lastNeg;
          let yTop = Math.min(ya, yb);
          let hgt = Math.abs(yb - ya);
          // 2px surface gap between stacked segments
          if (!isEnd && hgt > gap + 1) {
            if (v >= 0) {
              yTop += gap;
              hgt -= gap;
            } else hgt -= gap;
          }
          const identity = mergeIdentity(cat.identity, se.identity);
          const op = markOpacity(ctx, identity);
          const path = s('path', { d: isEnd ? barPath(x, yTop, thick, hgt, f.bars.radius, v >= 0 ? 'top' : 'bottom') : `M${x},${yTop}h${thick}v${hgt}h${-thick}Z`, fill: se.color, opacity: se.highlights ? 0.3 : op });
          interactive(ctx, path, identity, () => ({ title: cat.label, items: tooltipItems(ctx, cat, series, ci) }), cat.keys);
          animateIn(ctx, path, 'bottom');
          marks.append(path);
          const hl = se.highlights?.[ci];
          if (se.highlights && hl !== null && hl !== undefined) {
            const hv = norm(hl, ci) ?? 0;
            const yh = scale(base + hv);
            marks.append(s('path', { d: `M${x},${Math.min(ya, yh)}h${thick}v${Math.abs(yh - ya)}h${-thick}Z`, fill: se.color, 'pointer-events': 'none' }));
          }
          if (showLabels) {
            const text = labelFmt(mode === 'percent' ? v : se.values[ci]);
            if (hgt >= fs + 4 && measureText(text, fs, t.fontFamily) + 6 <= thick)
              marks.append(s('text', { x: x + thick / 2, y: yTop + hgt / 2 + fs / 3, 'text-anchor': 'middle', class: 'pbi-label', fill: textOn(se.color, t.foreground), opacity: op }, text));
          }
        });
      }
    });
    return;
  }

  // ---- horizontal bars
  const catW = f.categoryAxis.show ? Math.min(f.categoryAxis.maxLabelWidth, Math.ceil(Math.max(...labels.map((l) => measureText(l, fs, t.fontFamily)))) + 10) : 6;
  const left = catW;
  const labelRoom = showLabels && mode === 'clustered' ? 46 : 12;
  const bottom = height - (va.show ? fs + 10 : 4);
  const scale = linearScale(lo, hi, [left, width - labelRoom], { fixedMin: va.min, fixedMax: mode === 'percent' ? 1 : va.max, tickCount: Math.max(2, Math.min(va.tickCount, Math.floor(width / 90))) });
  drawValueAxisX(ctx, g, scale, 4, bottom, valueAxisFormatter(ctx, valueField, scale));
  const band = bandScale(categories.length, [4, bottom], f.bars.categoryGap, 0.1);
  if (f.categoryAxis.show)
    labels.forEach((l, i) => {
      if (band.step < fs * 0.9 && i % Math.ceil((fs * 1.2) / band.step) !== 0) return;
      g.append(s('text', { x: left - 8, y: band(i) + band.bandwidth / 2 + fs / 3, 'text-anchor': 'end', class: 'pbi-tick pbi-cat', fill: t.foregroundSecondary }, fitText(l, catW - 10, fs, t.fontFamily)));
    });
  const marks = s('g', { class: 'pbi-marks' });
  g.append(marks);
  const gap = f.bars.gap;
  categories.forEach((cat, ci) => {
    if (mode === 'clustered') {
      const n = series.length;
      const thick = Math.max(1, Math.min(f.bars.maxThickness, (band.bandwidth - gap * (n - 1)) / n));
      const groupH = thick * n + gap * (n - 1);
      const y0 = band(ci) + (band.bandwidth - groupH) / 2;
      series.forEach((se, si) => {
        const v = se.values[ci];
        if (v === null) return;
        const y = y0 + si * (thick + gap);
        const xa = scale(0);
        const xb = scale(v);
        const identity = mergeIdentity(cat.identity, se.identity);
        const op = markOpacity(ctx, identity);
        const path = s('path', { d: barPath(Math.min(xa, xb), y, Math.abs(xb - xa), thick, f.bars.radius, v >= 0 ? 'right' : 'left'), fill: se.color, opacity: se.highlights ? 0.3 : op });
        interactive(ctx, path, identity, () => ({ title: cat.label, items: tooltipItems(ctx, cat, series, ci) }), cat.keys);
        animateIn(ctx, path, v >= 0 ? 'left' : 'right');
        marks.append(path);
        const hl = se.highlights?.[ci];
        if (se.highlights && hl !== null && hl !== undefined) {
          const xh = scale(hl);
          marks.append(s('path', { d: barPath(Math.min(xa, xh), y, Math.abs(xh - xa), thick, f.bars.radius, hl >= 0 ? 'right' : 'left'), fill: se.color, 'pointer-events': 'none' }));
        }
        if (showLabels)
          marks.append(s('text', { x: v >= 0 ? xb + 5 : xb - 5, y: y + thick / 2 + fs / 3, 'text-anchor': v >= 0 ? 'start' : 'end', class: 'pbi-label', fill: f.dataLabels.color ?? t.foregroundSecondary, opacity: op }, labelFmt(v)));
      });
    } else {
      const thick = Math.min(f.bars.maxThickness * 1.6, band.bandwidth);
      const y = band(ci) + (band.bandwidth - thick) / 2;
      let pos = 0;
      let neg = 0;
      const vals = series.map((se) => norm(se.values[ci], ci) ?? 0);
      const lastPos = vals.reduce((acc, v, i) => (v > 0 ? i : acc), -1);
      const lastNeg = vals.reduce((acc, v, i) => (v < 0 ? i : acc), -1);
      series.forEach((se, si) => {
        const v = norm(se.values[ci], ci);
        if (v === null || v === 0) return;
        const base = v >= 0 ? pos : neg;
        const end = base + v;
        if (v >= 0) pos = end;
        else neg = end;
        const xa = scale(base);
        const xb = scale(end);
        const isEnd = v >= 0 ? si === lastPos : si === lastNeg;
        let x = Math.min(xa, xb);
        let w = Math.abs(xb - xa);
        if (!isEnd && w > gap + 1) {
          if (v < 0) x += gap;
          w -= gap;
        }
        const identity = mergeIdentity(cat.identity, se.identity);
        const op = markOpacity(ctx, identity);
        const path = s('path', { d: isEnd ? barPath(x, y, w, thick, f.bars.radius, v >= 0 ? 'right' : 'left') : `M${x},${y}h${w}v${thick}h${-w}Z`, fill: se.color, opacity: se.highlights ? 0.3 : op });
        interactive(ctx, path, identity, () => ({ title: cat.label, items: tooltipItems(ctx, cat, series, ci) }), cat.keys);
        animateIn(ctx, path, 'left');
        marks.append(path);
        if (showLabels) {
          const text = labelFmt(mode === 'percent' ? v : se.values[ci]);
          if (thick >= fs + 2 && measureText(text, fs, t.fontFamily) + 8 <= w)
            marks.append(s('text', { x: x + w / 2, y: y + thick / 2 + fs / 3, 'text-anchor': 'middle', class: 'pbi-label', fill: textOn(se.color, t.foreground), opacity: op }, text));
        }
      });
    }
  });
}

function barVisual(type: string, displayName: string, horizontal: boolean, mode: Mode): VisualDefinition {
  return defineVisual({
    type,
    displayName,
    category: 'chart',
    roles: ROLES,
    supportsHighlight: true,
    defaultSort: 'value',
    render: (ctx) => renderBars(ctx, horizontal, mode),
  });
}

export const clusteredColumn = barVisual('clusteredColumn', 'Clustered column chart', false, 'clustered');
export const stackedColumn = barVisual('stackedColumn', 'Stacked column chart', false, 'stacked');
export const percentStackedColumn = barVisual('percentStackedColumn', '100% stacked column chart', false, 'percent');
export const clusteredBar = barVisual('clusteredBar', 'Clustered bar chart', true, 'clustered');
export const stackedBar = barVisual('stackedBar', 'Stacked bar chart', true, 'stacked');
export const percentStackedBar = barVisual('percentStackedBar', '100% stacked bar chart', true, 'percent');
