import { s, h, barPath, measureText } from '../render/svg';
import { downsampleRuns } from '../render/lttb';
import { forecastSeries, futureKeys, type Forecast } from './forecast';
import { bandScale, linearScale, logScale, pointScale, timeScale } from '../render/scales';
import type { RenderContext } from './types';
import { defineVisual } from './registry';
import type { Series } from './common';
import { drawReferenceLines, drawTrendLine } from './analytics';
import { renderSmallMultiples } from './multiples';
import { categoryLabelLayout, drawCategoryLabels, drawValueAxisY, emptyState, labelFormatter, markOpacity, mergeIdentity, pivot, renderLegend, tooltipItems, valueAxisFormatter, withLegend } from './common';

type Kind = 'line' | 'area' | 'stackedArea' | 'combo';

function linePath(pts: ([number, number] | null)[], smooth: boolean): string {
  let d = '';
  let run: [number, number][] = [];
  const flush = () => {
    if (!run.length) return;
    if (!smooth || run.length < 3) d += `M${run.map((p) => p.join(',')).join('L')}`;
    else {
      // monotone-ish cardinal spline
      d += `M${run[0].join(',')}`;
      for (let i = 0; i < run.length - 1; i++) {
        const p0 = run[i - 1] ?? run[i];
        const p1 = run[i];
        const p2 = run[i + 1];
        const p3 = run[i + 2] ?? p2;
        const t = 0.18;
        d += `C${p1[0] + (p2[0] - p0[0]) * t},${p1[1] + (p2[1] - p0[1]) * t} ${p2[0] - (p3[0] - p1[0]) * t},${p2[1] - (p3[1] - p1[1]) * t} ${p2[0]},${p2[1]}`;
      }
    }
    run = [];
  };
  for (const p of pts) {
    if (p) run.push(p);
    else flush();
  }
  flush();
  return d;
}

function renderLine(ctx: RenderContext, kind: Kind): void {
  if (kind !== 'combo' && renderSmallMultiples(ctx, (panel) => renderLine(panel, kind), kind === 'stackedArea')) return;
  const pv = pivot(ctx, 'category', 'legend', 'values');
  let lineSeries: Series[] = [];
  let colSeries: Series[] = [];
  if (kind === 'combo') {
    colSeries = pv.series;
    const lp = pivot(ctx, 'category', '__none__', 'lineValues');
    // align line values to column categories
    lineSeries = lp.series.map((se, i) => ({ ...se, color: ctx.seriesColor(se.name, colSeries.length + i) }));
    if (!pv.categories.length && lp.categories.length) pv.categories.push(...lp.categories);
  } else lineSeries = pv.series;
  const { categories } = pv;
  if (!categories.length || (!lineSeries.length && !colSeries.length)) return emptyState(ctx);
  const t = ctx.theme;
  const f = ctx.format;
  // continuous axis: a single date or number field (auto), unless forced categorical
  const catType = pv.categoryFields.length === 1 ? pv.categoryFields[0].type : undefined;
  const continuous = kind !== 'combo' && f.categoryAxis.type !== 'categorical' && (catType === 'date' || catType === 'number') && categories.every((c) => c.keys[0] !== null);
  const keyNum = (i: number) => {
    const k = categories[i].keys[0];
    return k instanceof Date ? k.getTime() : Number(k);
  };
  if (continuous) {
    // points must be drawn in x order
    const order = categories.map((_, i) => i).sort((a, b) => keyNum(a) - keyNum(b));
    if (order.some((v, i) => v !== i)) {
      const re = <T,>(arr: T[]) => order.map((i) => arr[i]);
      const cats = re(categories);
      categories.splice(0, categories.length, ...cats);
      for (const se of [...lineSeries, ...colSeries]) {
        se.values = re(se.values);
        if (se.highlights) se.highlights = re(se.highlights);
      }
    }
  }
  // axis zoom: keep the chosen slice of categories (view state only; nothing is re-queried)
  const zoomOn = !!f.categoryAxis.zoom && kind !== 'combo' && categories.length > 4;
  const allLabels = categories.map((c) => c.label);
  const fullCount = categories.length;
  const zs = ctx.host.state as { zoom?: [number, number] };
  let z0 = 0;
  let z1 = fullCount - 1;
  if (zoomOn && zs.zoom) {
    z0 = Math.max(0, Math.min(fullCount - 2, zs.zoom[0]));
    z1 = Math.max(z0 + 1, Math.min(fullCount - 1, zs.zoom[1]));
  }
  if (zoomOn && (z0 > 0 || z1 < fullCount - 1)) {
    categories.splice(0, categories.length, ...categories.slice(z0, z1 + 1));
    for (const se of [...lineSeries, ...colSeries]) {
      se.values = se.values.slice(z0, z1 + 1);
      if (se.highlights) se.highlights = se.highlights.slice(z0, z1 + 1);
    }
  }
  const all = [...colSeries, ...lineSeries];
  const legend = renderLegend(
    ctx,
    all.map((se, i) => ({ name: se.name, color: se.color, identity: se.identity, shape: i >= colSeries.length ? 'line' : 'square' })),
  );
  const { plot, width, height: fullHeight } = withLegend(ctx, legend);
  const zoomH = zoomOn ? 30 : 0;
  const height = fullHeight - zoomH;
  const fs = t.labelFontSize;
  const va = f.valueAxis;

  const stacked = kind === 'stackedArea';
  // forecast: continuous axis, plain lines/areas, at most three series
  const fcOpt = f.analytics.forecast;
  const forecasts: { se: Series; fc: Forecast }[] =
    continuous && fcOpt && fcOpt.periods > 0 && !stacked
      ? lineSeries.slice(0, 3).flatMap((se) => {
          const xs = se.values.filter((v): v is number => v !== null);
          const fc = forecastSeries(xs, fcOpt);
          return fc ? [{ se, fc }] : [];
        })
      : [];
  const futureNums = forecasts.length ? futureKeys(categories.map((_, i) => keyNum(i)), catType === 'date', fcOpt ? fcOpt.periods : 0) : [];
  let lo = 0;
  let hi = 0;
  categories.forEach((_, ci) => {
    if (stacked) {
      let sum = 0;
      for (const se of lineSeries) sum += se.values[ci] ?? 0;
      hi = Math.max(hi, sum);
      lo = Math.min(lo, sum);
    } else
      for (const se of all) {
        // highlighted portions must fit the axis too (they are usually smaller than the totals)
        for (const v of [se.values[ci], se.highlights?.[ci] ?? null]) {
          if (v === null) continue;
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
  });
  const includeZero = kind !== 'line' || va.min === 0;
  if (!includeZero) {
    lo = Infinity;
    hi = -Infinity;
    for (const se of all) for (const v of [...se.values, ...(se.highlights ?? [])]) if (v !== null) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
  }
  for (const { fc } of forecasts) for (const v of [...fc.lower, ...fc.upper]) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
  // combo: lines on a very different scale (or a different kind of unit) get their own axis on the right
  const extent = (list: Series[]) => {
    let a = Infinity;
    let b = -Infinity;
    for (const se of list) for (const v of se.values) if (v !== null) (a = Math.min(a, v)), (b = Math.max(b, v));
    return a <= b ? [a, b] : [0, 0];
  };
  const isPct = (se: Series | undefined) => /%/.test(se?.field?.format ?? '');
  const [, colMax] = extent(colSeries);
  const [lineMin, lineMax] = extent(lineSeries);
  const ratio = Math.max(Math.abs(colMax), 1e-9) / Math.max(Math.abs(lineMax), Math.abs(lineMin), 1e-9);
  const secondary = kind === 'combo' && colSeries.length > 0 && lineSeries.length > 0 && (ratio > 8 || ratio < 1 / 8 || isPct(colSeries[0]) !== isPct(lineSeries[0]));
  if (secondary) {
    const [cMin] = extent(colSeries);
    lo = Math.min(0, cMin);
    hi = Math.max(0, colMax);
  }
  const lineField = secondary ? lineSeries[0].field : undefined;
  const makeY2 = (range: [number, number], tickCount: number) => linearScale(Math.min(0, lineMin), Math.max(0, lineMax), range, { includeZero: true, tickCount });
  const valueField = all[0]?.field;
  // end labels would sit on top of a forecast
  const endLabels = f.lines.endLabels && lineSeries.length <= 4 && kind !== 'combo' && !forecasts.length;
  const labelFmt = labelFormatter(ctx, valueField);
  const fmtOf = (se: Series) => (se.field && se.field !== valueField ? labelFormatter(ctx, se.field) : labelFmt);
  const endW = endLabels ? Math.max(...lineSeries.map((se) => measureText(fmtOf(se)(lastValue(se)), fs, t.fontFamily, 600))) + 12 : 10;

  const top = 10;
  const useLog = va.scale === 'log' && kind === 'line';
  const positives = all.flatMap((se) => se.values.filter((v): v is number => v !== null && v > 0));
  const makeY = (range: [number, number], tickCount: number) =>
    useLog && positives.length ? logScale(va.min ?? Math.min(...positives), va.max ?? Math.max(...positives), range) : linearScale(lo, hi, range, { includeZero, fixedMin: va.min, fixedMax: va.max, tickCount });
  let scale = makeY([height - 30, top], Math.max(2, Math.min(va.tickCount, Math.floor(height / 40))));
  const fmtAxis = valueAxisFormatter(ctx, valueField, scale);
  const left = va.show ? Math.ceil(Math.max(...scale.ticks.map((x) => measureText(fmtAxis(x), fs, t.fontFamily)))) + 12 : 8;
  const fmtAxis2 = lineField ? valueAxisFormatter(ctx, lineField, makeY2([height - 30, top], 4)) : null;
  const right = fmtAxis2 ? Math.max(endW, Math.ceil(Math.max(...makeY2([height - 30, top], 4).ticks.map((x) => measureText(fmtAxis2(x), fs, t.fontFamily)))) + 14) : endW;
  const useBand = kind === 'combo';
  let xs = useBand ? bandScale(categories.length, [left, width - right], f.bars.categoryGap, 0.15) : pointScale(categories.length, [left, width - right], 6);
  let xAt = (i: number) => (useBand ? xs(i) + xs.bandwidth / 2 : xs(i));
  // continuous x: time or linear scale; points sit at their real positions
  let contTicks: { at: number; label: string }[] = [];
  let futurePos: ((v: number) => number) | null = null;
  if (continuous) {
    const nums = categories.map((_, i) => keyNum(i));
    const range: [number, number] = [left + 6, width - right - 6];
    const approx = Math.max(2, Math.floor((width - left - right) / 90));
    let pos: (v: number) => number;
    if (catType === 'date') {
      const ts = timeScale(nums[0], futureNums.length ? futureNums[futureNums.length - 1] : nums[nums.length - 1], range, approx);
      pos = ts;
      contTicks = ts.ticks.map((tk, i) => ({ at: ts(tk), label: ts.tickFormat(tk, i) }));
    } else {
      const end = futureNums.length ? futureNums[futureNums.length - 1] : nums[nums.length - 1];
      const ls = linearScale(nums[0], end, range, { includeZero: false, fixedMin: nums[0], fixedMax: end, tickCount: approx });
      pos = ls;
      const field = pv.categoryFields[0];
      contTicks = ls.ticks.map((tk) => ({ at: ls(tk), label: ctx.fmt(field, tk) }));
    }
    const px = nums.map(pos);
    futurePos = pos;
    xAt = (i: number) => px[i];
    const nearest = (x: number) => {
      let lo2 = 0;
      let hi2 = px.length - 1;
      while (hi2 - lo2 > 1) {
        const mid = (lo2 + hi2) >> 1;
        if (px[mid] < x) lo2 = mid;
        else hi2 = mid;
      }
      return Math.abs(px[lo2] - x) <= Math.abs(px[hi2] - x) ? lo2 : hi2;
    };
    const cont = ((i: number) => px[i]) as typeof xs;
    cont.bandwidth = 0;
    cont.step = px.length > 1 ? (px[px.length - 1] - px[0]) / (px.length - 1) : 0;
    cont.count = px.length;
    cont.indexAt = nearest;
    xs = cont;
  }
  const labels = categories.map((c) => c.label);
  const catLayout = continuous ? { angle: 0 as const, height: f.categoryAxis.show ? fs + 10 : 4, every: 1, maxWidth: 0 } : categoryLabelLayout(ctx, labels, Math.max(xs.step, 1));
  const bottom = height - catLayout.height - 2;
  scale = makeY([bottom, top], Math.max(2, Math.min(va.tickCount, Math.floor((bottom - top) / 36))));
  const lscale = secondary ? makeY2([bottom, top], Math.max(2, Math.min(va.tickCount, Math.floor((bottom - top) / 36)))) : scale;

  const svg = s('svg', { width, height, class: 'pbi-svg', role: 'img', 'aria-label': ctx.spec.title ?? 'Line chart' });
  const g = s('g');
  svg.append(g);
  plot.append(svg);
  drawValueAxisY(ctx, g, scale, left, width - right, valueAxisFormatter(ctx, valueField, scale));
  if (secondary && va.show) {
    const fmt2 = valueAxisFormatter(ctx, lineField, lscale);
    for (const tick of lscale.ticks) g.append(s('text', { x: width - right + 8, y: lscale(tick) + fs / 3, 'text-anchor': 'start', class: 'pbi-tick pbi-tick-secondary', fill: lineSeries[0].color }, fmt2(tick)));
  }
  if (continuous) {
    if (f.categoryAxis.show)
      for (const tk of contTicks) {
        g.append(s('line', { x1: tk.at, x2: tk.at, y1: bottom, y2: bottom + 4, stroke: t.axis, 'stroke-width': 1 }));
        g.append(s('text', { x: tk.at, y: bottom + fs + 6, 'text-anchor': 'middle', class: 'pbi-tick pbi-cat', fill: t.foregroundSecondary }, tk.label));
      }
  } else drawCategoryLabels(ctx, g, labels, xAt, bottom, catLayout);
  const marks = s('g', { class: 'pbi-marks' });
  g.append(marks);

  // combo columns
  if (colSeries.length) {
    const n = colSeries.length;
    const gap = f.bars.gap;
    const thick = Math.max(1, Math.min(f.bars.maxThickness, (xs.bandwidth - gap * (n - 1)) / n));
    categories.forEach((cat, ci) => {
      const groupW = thick * n + gap * (n - 1);
      const x0 = xs(ci) + (xs.bandwidth - groupW) / 2;
      colSeries.forEach((se, si) => {
        const v = se.values[ci];
        if (v === null) return;
        const y0 = scale(0);
        const y1 = scale(v);
        const identity = mergeIdentity(cat.identity, se.identity);
        const path = s('path', { d: barPath(x0 + si * (thick + gap), Math.min(y0, y1), thick, Math.abs(y1 - y0), f.bars.radius, v >= 0 ? 'top' : 'bottom'), fill: se.color, opacity: markOpacity(ctx, identity), class: 'pbi-mark' });
        marks.append(path);
      });
    });
  }

  // dense series are thinned to ~2 points per pixel for drawing (hover still reads every point)
  const maxPts = Math.max(300, Math.round((width - right - left) * 2));
  const thin = (p: ([number, number] | null)[]) => downsampleRuns(p, maxPts);
  // stacked baselines
  const base = categories.map(() => 0);
  lineSeries.forEach((se) => {
    const pts = se.values.map((v, i) => {
      if (v === null && !stacked) return null;
      const y = stacked ? base[i] + (v ?? 0) : (v as number);
      return [xAt(i), lscale(y)] as [number, number];
    });
    if (kind === 'area' || stacked || f.lines.area) {
      const lower = categories.map((_, i) => [xAt(i), lscale(stacked ? base[i] : 0)] as [number, number]);
      const valid = pts.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
      if (valid.length) {
        // stacked areas need every point to meet the series below; flat baselines can be thinned
        const upper = stacked ? valid.map((i) => pts[i]!) : (thin(pts).filter(Boolean) as [number, number][]);
        const low = stacked ? valid.map((i) => lower[i]).reverse() : upper.map((p) => [p[0], lscale(0)] as [number, number]).reverse();
        marks.append(s('path', { d: `M${upper.map((p) => p.join(',')).join('L')}L${low.map((p) => p.join(',')).join('L')}Z`, fill: se.color, 'fill-opacity': stacked ? 0.55 : f.lines.areaOpacity, stroke: 'none', 'pointer-events': 'none', 'data-key': `area:${se.name}` }));
      }
    }
    const path = s('path', { d: linePath(stacked ? pts : thin(pts), f.lines.smooth), fill: 'none', stroke: se.color, 'stroke-width': f.lines.width, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: se.highlights ? 0.3 : se.identity ? markOpacity(ctx, se.identity) : 1, class: 'pbi-line', 'data-key': `line:${se.name}` });
    if (ctx.animate && f.animation.enabled) {
      // pathLength=1 makes the dash keyframes length-independent; nothing is hidden outside the animation
      path.setAttribute('pathLength', '1');
      path.classList.add('pbi-draw');
      path.addEventListener('animationend', () => (path.classList.remove('pbi-draw'), path.removeAttribute('pathLength')), { once: true });
      path.style.animationDuration = `${f.animation.duration * 2}ms`;
    }
    marks.append(path);
    if (se.highlights && !stacked) {
      // cross-highlight: the selected portion drawn solid over the faded full line
      const hp = se.highlights.map((v, i) => (v === null ? null : ([xAt(i), lscale(v)] as [number, number])));
      marks.append(s('path', { d: linePath(thin(hp), f.lines.smooth), fill: 'none', stroke: se.color, 'stroke-width': f.lines.width, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', class: 'pbi-line pbi-line-highlight', 'pointer-events': 'none' }));
    }
    const showMarkers = f.lines.markers === true || (f.lines.markers === 'auto' && categories.length <= 16);
    if (showMarkers)
      pts.forEach((p, i) => {
        if (!p) return;
        const op = se.highlights && !stacked ? 0.3 : markOpacity(ctx, mergeIdentity(categories[i].identity, se.identity));
        marks.append(s('circle', { cx: p[0], cy: p[1], r: 4, fill: se.color, stroke: t.surface, 'stroke-width': 2, opacity: op, 'pointer-events': 'none' }));
        // the highlighted value gets the solid marker, like the solid highlight line
        const hv = se.highlights && !stacked ? se.highlights[i] : null;
        if (hv !== null && hv !== undefined) marks.append(s('circle', { cx: p[0], cy: lscale(hv), r: 4, fill: se.color, stroke: t.surface, 'stroke-width': 2, class: 'pbi-marker-highlight', 'pointer-events': 'none' }));
      });
    if (stacked) se.values.forEach((v, i) => (base[i] += v ?? 0));
  });

  if (futurePos && forecasts.length) {
    const fx = futureNums.map(futurePos);
    const conf = Math.round((fcOpt ? (fcOpt.confidence ?? 0.95) : 0.95) * 100);
    for (const { se, fc } of forecasts) {
      const li = lastIndex(se);
      if (li < 0) continue;
      const start: [number, number] = [xAt(li), lscale(se.values[li]!)];
      const up = fc.upper.map((v, k) => [fx[k], lscale(v)] as [number, number]);
      const down = fc.lower.map((v, k) => [fx[k], lscale(v)] as [number, number]).reverse();
      const band = s('path', { d: `M${[start, ...up].map((p) => p.join(',')).join('L')}L${[...down, start].map((p) => p.join(',')).join('L')}Z`, fill: se.color, 'fill-opacity': 0.14, stroke: 'none', class: 'pbi-forecast-band' });
      band.append(s('title', {}, `Forecast, ${conf}% interval`));
      marks.append(band);
      const mean = [start, ...fc.mean.map((v, k) => [fx[k], lscale(v)] as [number, number])];
      marks.append(s('path', { d: `M${mean.map((p) => p.join(',')).join('L')}`, fill: 'none', stroke: se.color, 'stroke-width': f.lines.width, 'stroke-dasharray': '5 4', class: 'pbi-forecast', 'pointer-events': 'none' }));
    }
  }
  drawReferenceLines(ctx, g, scale, 'y', [left, width - right], (secondary ? colSeries : all).flatMap((se) => se.values.filter((v): v is number => v !== null)), valueField);
  if (!stacked) lineSeries.forEach((se) => drawTrendLine(ctx, g, se.values, xAt, lscale, se.color));

  // end labels (value at the end of each line)
  if (endLabels) {
    const placed: number[] = [];
    lineSeries.forEach((se) => {
      const li = lastIndex(se);
      if (li < 0) return;
      let y = lscale(stacked ? cumulative(lineSeries, se, li) : se.values[li]!) + fs / 3;
      if (placed.some((p) => Math.abs(p - y) < fs + 1)) return; // collisions → legend/tooltip carry it
      placed.push(y);
      y = Math.max(fs, Math.min(bottom, y));
      marks.append(s('text', { x: xAt(li) + 8, y, class: 'pbi-label pbi-end-label', fill: t.foreground, 'font-weight': 600 }, fmtOf(se)(se.values[li])));
    });
  }
  if (f.dataLabels.show && !endLabels)
    lineSeries.forEach((se) => {
      const fmt = fmtOf(se);
      const placed: [number, number, number][] = [];
      se.values.forEach((v, i) => {
        if (v === null) return;
        const text = fmt(v);
        const w = measureText(text, fs, t.fontFamily);
        const x = xAt(i);
        const y = lscale(v) - 8;
        if (placed.some(([a, b, py]) => x - w / 2 < b && x + w / 2 > a && Math.abs(py - y) < fs)) return;
        placed.push([x - w / 2 - 2, x + w / 2 + 2, y]);
        marks.append(s('text', { x, y, 'text-anchor': 'middle', class: 'pbi-label', fill: t.foregroundSecondary }, text));
      });
    });

  if (zoomOn) {
    const max = fullCount - 1;
    const r1 = h('input', { type: 'range', min: 0, max, value: z0, class: 'pbi-range', 'aria-label': `Zoom from (${allLabels[z0]})` }) as HTMLInputElement;
    const r2 = h('input', { type: 'range', min: 0, max, value: z1, class: 'pbi-range', 'aria-label': `Zoom to (${allLabels[z1]})` }) as HTMLInputElement;
    const fill = h('i', { class: 'pbi-range-fill' });
    fill.style.left = `${(z0 / max) * 100}%`;
    fill.style.right = `${100 - (z1 / max) * 100}%`;
    const commit = () => {
      let a = Number(r1.value);
      let b = Number(r2.value);
      if (a > b) [a, b] = [b, a];
      if (b - a < 1) b = Math.min(max, a + 1);
      ctx.host.setState({ zoom: a === 0 && b === max ? undefined : [a, b] });
      ctx.host.rerender();
    };
    r1.addEventListener('change', commit);
    r2.addEventListener('change', commit);
    const reset = h('button', { type: 'button', class: 'pbi-link pbi-zoom-reset', title: 'Show the whole axis' }, 'Reset');
    reset.hidden = z0 === 0 && z1 === max;
    reset.addEventListener('click', () => (ctx.host.setState({ zoom: undefined }), ctx.host.rerender()));
    const bar = h('div', { class: 'pbi-zoom', style: `margin-left:${left}px;margin-right:${right}px` }, h('div', { class: 'pbi-dual-range' }, h('div', { class: 'pbi-range-track' }, fill), r1, r2), reset);
    plot.append(bar);
  }
  // crosshair + hit layer
  const cross = s('line', { y1: top, y2: bottom, stroke: t.axis, 'stroke-width': 1, visibility: 'hidden', 'pointer-events': 'none' });
  const dots = s('g', { 'pointer-events': 'none' });
  g.append(cross, dots);
  const hit = s('rect', { x: left, y: top, width: Math.max(0, width - right - left), height: Math.max(0, bottom - top), fill: 'transparent', class: 'pbi-hit' });
  g.append(hit);
  const indexAt = (e: MouseEvent) => {
    const r = svg.getBoundingClientRect();
    return xs.indexAt(((e.clientX - r.left) * width) / (r.width || width));
  };
  hit.addEventListener('mousemove', (e) => {
    const i = indexAt(e);
    const x = xAt(i);
    cross.setAttribute('x1', String(x));
    cross.setAttribute('x2', String(x));
    cross.setAttribute('visibility', 'visible');
    dots.replaceChildren();
    const cum = categories.map(() => 0);
    for (const se of lineSeries) {
      const v = se.values[i];
      if (v === null) continue;
      const yv = stacked ? (cum[i] += v) : v;
      dots.append(s('circle', { cx: x, cy: lscale(yv), r: 4, fill: se.color, stroke: t.surface, 'stroke-width': 2 }));
    }
    if (f.tooltip.show) ctx.host.showTooltip(e, tooltipItems(ctx, categories[i], all, i), categories[i].label, categories[i].identity);
  });
  hit.addEventListener('mouseleave', () => {
    cross.setAttribute('visibility', 'hidden');
    dots.replaceChildren();
    ctx.host.hideTooltip();
  });
  hit.addEventListener('click', (e) => {
    e.stopPropagation();
    const i = indexAt(e);
    ctx.host.select(categories[i].identity, { multi: e.ctrlKey || e.metaKey });
    ctx.host.emit('dataPointClick', { keys: categories[i].keys, identity: categories[i].identity, event: e });
  });
  hit.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    ctx.host.contextMenu(e, categories[indexAt(e)].identity);
  });
  hit.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    if (ctx.host.drill.levels > 1 && ctx.host.drill.level < ctx.host.drill.levels - 1) {
      const i = indexAt(e);
      ctx.host.drillDown(categories[i].keys[categories[i].keys.length - 1]);
    }
  });
}

function lastIndex(se: Series): number {
  for (let i = se.values.length - 1; i >= 0; i--) if (se.values[i] !== null) return i;
  return -1;
}
function lastValue(se: Series): number | null {
  const i = lastIndex(se);
  return i < 0 ? null : se.values[i];
}
function cumulative(all: Series[], upto: Series, i: number): number {
  let sum = 0;
  for (const se of all) {
    sum += se.values[i] ?? 0;
    if (se === upto) break;
  }
  return sum;
}

const ROLES = [
  { name: 'category', displayName: 'X-axis', kind: 'grouping' as const, multiple: true, drillable: true },
  { name: 'legend', displayName: 'Legend', kind: 'grouping' as const },
  { name: 'values', displayName: 'Y-axis', kind: 'measure' as const, multiple: true, required: true },
  { name: 'smallMultiples', displayName: 'Small multiples', kind: 'grouping' as const },
];

export const lineChart = /* @__PURE__ */ defineVisual({ type: 'line', displayName: 'Line chart', category: 'chart', roles: ROLES, supportsHighlight: true, defaultSort: 'key', render: (c) => renderLine(c, 'line') });
export const areaChart = /* @__PURE__ */ defineVisual({ type: 'area', displayName: 'Area chart', category: 'chart', roles: ROLES, supportsHighlight: true, defaultSort: 'key', render: (c) => renderLine(c, 'area') });
export const stackedAreaChart = /* @__PURE__ */ defineVisual({ type: 'stackedArea', displayName: 'Stacked area chart', category: 'chart', roles: ROLES, defaultSort: 'key', render: (c) => renderLine(c, 'stackedArea') });
export const comboChart = /* @__PURE__ */ defineVisual({
  type: 'lineClusteredColumn',
  displayName: 'Line and clustered column chart',
  category: 'chart',
  roles: [
    { name: 'category', displayName: 'X-axis', kind: 'grouping', multiple: true, drillable: true },
    { name: 'legend', displayName: 'Column legend', kind: 'grouping' },
    { name: 'values', displayName: 'Column y-axis', kind: 'measure', multiple: true },
    { name: 'lineValues', displayName: 'Line y-axis', kind: 'measure', multiple: true },
  ],
  defaultSort: 'key',
  render: (c) => renderLine(c, 'combo'),
});
