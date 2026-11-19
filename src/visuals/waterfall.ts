import { s, measureText } from '../render/svg';
import { bandScale, linearScale } from '../render/scales';
import { defineVisual } from './registry';
import { renderSmallMultiples } from './multiples';
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
  resolveDataLabelColor,
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
    { name: 'smallMultiples', displayName: 'Small multiples', kind: 'grouping', multiple: true },
  ],
  defaultSort: 'key',
  defaultFormat: { dataLabels: { show: true } },
  render(ctx) {
    if (renderSmallMultiples(ctx, (p) => waterfall.render(p))) return;
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
    const markMap: { identity: any; rect: { x: number; y: number; w: number; h: number } }[] = [];
    steps.forEach((st, i) => {
      const x = band(i) + (band.bandwidth - thick) / 2;
      const y0 = scale(Math.max(st.start, st.end));
      const y1 = scale(Math.min(st.start, st.end));
      const color = st.kind === 'up' ? up : st.kind === 'down' ? down : totalC;
      const cat = st.ci >= 0 ? pv.categories[st.ci] : null;
      const rect = s('rect', { x, y: y0, width: thick, height: Math.max(1, y1 - y0), rx: 3, fill: color, opacity: cat ? markOpacity(ctx, cat.identity) : 1 });
      if (cat) {
        interactive(ctx, rect, cat.identity, () => ({ title: cat.label, items: [{ label: se.name, value: ctx.fmt(se.field, st.end - st.start), color }, { label: 'Running total', value: ctx.fmt(se.field, st.end) }] }), cat.keys);
        markMap.push({ identity: cat.identity, rect: { x, y: y0, w: thick, h: Math.max(1, y1 - y0) } });
      }
      g.append(rect);
      // connector from this step's end to the next step's start
      if (i < steps.length - 1) {
        const yc = Math.round(scale(st.end)) + 0.5;
        g.append(s('line', { x1: x + thick, x2: band(i + 1) + (band.bandwidth - thick) / 2, y1: yc, y2: yc, stroke: t.axis, 'stroke-width': 1, 'pointer-events': 'none' }));
      }
      if (f.dataLabels.show) {
        const delta = st.kind === 'total' ? st.end : st.end - st.start;
        const text = st.kind === 'total' || delta < 0 ? fmtLabel(delta) : `+${fmtLabel(delta)}`;
        if (measureText(text, fs, t.fontFamily) <= band.step + 4) {
          const lColor = resolveDataLabelColor(delta, color, f.dataLabels, f.dataLabels.color ?? t.foregroundSecondary);
          g.append(s('text', { x: x + thick / 2, y: delta >= 0 || st.kind === 'total' ? y0 - 5 : y1 + fs + 3, 'text-anchor': 'middle', class: 'pbi-label', fill: lColor }, text));
        }
      }
    });
    wireWaterfallBrush(svg, ctx, width, height, markMap);
  },
});

function wireWaterfallBrush(
  svg: SVGSVGElement,
  ctx: import('./types').RenderContext,
  width: number,
  height: number,
  markMap: { identity: any; rect: { x: number; y: number; w: number; h: number } }[],
): void {
  let dragStart: { clientX: number; clientY: number; pX: number; pY: number } | null = null;
  let brushEl: SVGElement | null = null;
  let didBrush = false;

  const plotCoords = (clientX: number, clientY: number) => {
    const r = svg.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      return {
        x: Math.max(0, Math.min(width, ((clientX - r.left) * width) / r.width)),
        y: Math.max(0, Math.min(height, ((clientY - r.top) * height) / r.height)),
      };
    }
    const attrW = parseFloat(svg.getAttribute('width') || String(width)) || width;
    const attrH = parseFloat(svg.getAttribute('height') || String(height)) || height;
    return {
      x: Math.max(0, Math.min(width, (clientX * width) / attrW)),
      y: Math.max(0, Math.min(height, (clientY * height) / attrH)),
    };
  };

  const onWindowPointerMove = (e: PointerEvent) => {
    if (!dragStart) return;
    const cur = plotCoords(e.clientX, e.clientY);
    const dx = Math.abs(e.clientX - dragStart.clientX);
    const dy = Math.abs(e.clientY - dragStart.clientY);
    if (!didBrush && Math.hypot(dx, dy) < 4) return;
    didBrush = true;
    ctx.host.hideTooltip();
    const bx = Math.min(dragStart.pX, cur.x);
    const by = Math.min(dragStart.pY, cur.y);
    const bw = Math.abs(cur.x - dragStart.pX);
    const bh = Math.abs(cur.y - dragStart.pY);
    if (!brushEl) {
      brushEl = s('rect', { class: 'pbi-brush' });
      svg.append(brushEl);
    }
    brushEl.setAttribute('x', String(bx));
    brushEl.setAttribute('y', String(by));
    brushEl.setAttribute('width', String(bw));
    brushEl.setAttribute('height', String(bh));
  };

  const onWindowPointerUp = (e: PointerEvent) => {
    if (!dragStart) return;
    const start = dragStart;
    dragStart = null;
    window.removeEventListener('pointermove', onWindowPointerMove);
    window.removeEventListener('pointerup', onWindowPointerUp);
    window.removeEventListener('pointercancel', onWindowPointerUp);
    if (brushEl) {
      brushEl.remove();
      brushEl = null;
    }
    if (didBrush) {
      const cur = plotCoords(e.clientX, e.clientY);
      const bx0 = Math.min(start.pX, cur.x);
      const bx1 = Math.max(start.pX, cur.x);
      const by0 = Math.min(start.pY, cur.y);
      const by1 = Math.max(start.pY, cur.y);
      const hitIds: any[] = [];
      const seen = new Set<string>();
      for (const m of markMap) {
        const mx0 = m.rect.x;
        const mx1 = m.rect.x + m.rect.w;
        const my0 = m.rect.y;
        const my1 = m.rect.y + m.rect.h;
        if (mx0 <= bx1 && mx1 >= bx0 && my0 <= by1 && my1 >= by0) {
          const key = JSON.stringify(m.identity.values);
          if (!seen.has(key)) {
            seen.add(key);
            hitIds.push(m.identity);
          }
        }
      }
      if (hitIds.length) ctx.host.select(hitIds, { multi: e.ctrlKey || e.metaKey || e.shiftKey });
    }
  };

  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const target = e.target as Element | null;
    if (target?.closest('.pbi-mark')) return;
    const p = plotCoords(e.clientX, e.clientY);
    dragStart = { clientX: e.clientX, clientY: e.clientY, pX: p.x, pY: p.y };
    didBrush = false;
    window.addEventListener('pointermove', onWindowPointerMove);
    window.addEventListener('pointerup', onWindowPointerUp);
    window.addEventListener('pointercancel', onWindowPointerUp);
  });
}
