import { s, measureText } from '../render/svg';
import { ramp } from '../render/color';
import { defineVisual } from './registry';
import { emptyState, identityOf, interactive, markOpacity } from './common';
import { valueColor } from './analytics';
import { paintRects, useRaster, type RasterRect } from './raster';

const DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Mon', '', 'Wed', '', 'Fri', '', ''];

/** Calendar heatmap: one square per day, weeks as columns and weekdays as rows, one band per year. */
export const calendarHeatmap = /* @__PURE__ */ defineVisual({
  type: 'calendar',
  displayName: 'Calendar heatmap',
  category: 'chart',
  roles: [
    { name: 'date', displayName: 'Date', kind: 'grouping', required: true },
    { name: 'values', displayName: 'Value', kind: 'measure', required: true },
  ],
  defaultSort: 'key',
  render(ctx) {
    const di = ctx.role('date').indices[0];
    const vi = ctx.role('values').indices[0];
    if (di === undefined || vi === undefined) return emptyState(ctx, 'Add a date column and a measure');
    const dField = ctx.data.groups[di];
    const vField = ctx.data.values[vi];
    // one value per local calendar day
    const days = new Map<number, { date: Date; value: number }>();
    for (const r of ctx.data.rows) {
      const d = r.keys[di];
      const v = r.values[vi];
      if (!(d instanceof Date) || typeof v !== 'number') continue;
      const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      days.set(day.getTime(), { date: day, value: v });
    }
    if (!days.size) return emptyState(ctx, dField?.type !== 'date' ? 'The Date role needs a date column' : undefined);
    const t = ctx.theme;
    const f = ctx.format;
    const fs = t.labelFontSize;
    const values = [...days.values()].map((d) => d.value);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const stops = t.mode === 'dark' ? [...t.sequential].reverse() : t.sequential;
    const colorOf = (v: number) => (f.colors.gradient || f.colors.rules?.length ? valueColor(ctx, v, [lo, hi], stops[3]) : ramp(stops.slice(0, -1), hi === lo ? 1 : (v - lo) / (hi - lo)));
    const years = [...new Set([...days.values()].map((d) => d.date.getFullYear()))].sort();
    // geometry: 53 week columns plus a weekday gutter; years stack vertically
    // weekday labels only when the cells can carry them
    const roughCell = Math.floor((ctx.width - 38) / 53);
    const showWeekdays = roughCell >= 9;
    const gutter = showWeekdays ? 30 : 4;
    const cell = Math.max(4, Math.min(18, Math.floor((ctx.width - gutter - 8) / 53), Math.floor((ctx.height - years.length * (fs + 8)) / (years.length * 7 + 1))));
    const gap = cell >= 8 ? 2 : 1;
    const step = cell;
    const bandH = 7 * step + fs + 10;
    const width = gutter + 53 * step + 4;
    const offsetY = Math.max(0, (ctx.height - years.length * bandH) / 2);
    const monthFs = Math.min(fs, Math.max(8, cell + 3));
    // month names collapse to initials when a month is too narrow for them
    const monthName = (m: number) => (measureText(MONTHS[m], monthFs, t.fontFamily) <= 4.2 * step ? MONTHS[m] : MONTHS[m][0]);
    const svg = s('svg', { width: Math.max(ctx.width, width), height: Math.max(ctx.height, years.length * bandH), class: 'pbi-svg', role: 'img', 'aria-label': ctx.spec.title ?? 'Calendar heatmap' });
    const monday = (d: Date) => (d.getDay() + 6) % 7;
    // many years of days paint on a canvas, hit-tested by band, week and weekday
    const raster = useRaster(ctx, 'calendar', years.length * 366);
    const rects: RasterRect[] = [];
    const marks = new Map<number, RasterRect>();
    const bandTop = (yi: number) => offsetY + yi * bandH + fs + 6;
    years.forEach((year, yi) => {
      const top = bandTop(yi);
      const jan1 = new Date(year, 0, 1);
      const startOffset = monday(jan1);
      svg.append(s('text', { x: gutter, y: top - 6 - (showWeekdays ? 0 : monthFs + 2), class: 'pbi-tick', fill: t.foregroundSecondary, 'font-weight': 600 }, String(year)));
      if (showWeekdays) WEEKDAYS.forEach((w, i) => w && svg.append(s('text', { x: gutter - 4, y: top + i * step + cell * 0.75, 'text-anchor': 'end', class: 'pbi-tick', fill: t.foregroundMuted, 'font-size': Math.min(fs, cell + 2) }, w)));
      for (let m = 0; m < 12; m++) {
        const first = new Date(year, m, 1);
        const week = Math.floor((Math.round((first.getTime() - jan1.getTime()) / DAY) + startOffset) / 7);
        svg.append(s('text', { x: gutter + week * step, y: top - 6, class: 'pbi-tick', fill: t.foregroundMuted, 'font-size': monthFs }, m === 0 ? '' : monthName(m)));
      }
      for (let d = new Date(year, 0, 1); d.getFullYear() === year; d = new Date(year, d.getMonth(), d.getDate() + 1)) {
        const idx = Math.round((d.getTime() - jan1.getTime()) / DAY) + startOffset;
        const x = gutter + Math.floor(idx / 7) * step;
        const y = top + monday(d) * step;
        const entry = days.get(d.getTime());
        if (raster) {
          const r: RasterRect = { x, y, w: cell - gap, h: cell - gap, fill: entry ? colorOf(entry.value) : t.gridline, alpha: 0.5, identity: identityOf([dField], [d]), keys: [d], tooltip: () => ({ items: [] }) };
          if (entry) {
            r.identity = identityOf([dField], [entry.date]);
            r.alpha = markOpacity(ctx, r.identity);
            r.tooltip = () => ({ title: ctx.fmt(dField, entry.date) || entry.date.toDateString(), items: [{ label: vField.name, value: ctx.fmt(vField, entry.value) }] });
            marks.set(yi * 400 + idx, r);
          }
          rects.push(r);
          continue;
        }
        const rect = s('rect', { x, y, width: cell - gap, height: cell - gap, rx: Math.min(3, cell / 4), fill: entry ? colorOf(entry.value) : t.gridline, opacity: entry ? 1 : 0.5 });
        if (entry) {
          const identity = identityOf([dField], [entry.date]);
          rect.setAttribute('opacity', String(markOpacity(ctx, identity)));
          interactive(ctx, rect, identity, () => ({ title: ctx.fmt(dField, entry.date) || entry.date.toDateString(), items: [{ label: vField.name, value: ctx.fmt(vField, entry.value) }] }), [entry.date]);
        }
        svg.append(rect);
      }
    });
    ctx.root.replaceChildren(svg);
    if (!raster) return;
    const find = (px: number, py: number) => {
      const yi = years.findIndex((_, i) => py >= bandTop(i) && py < bandTop(i) + 7 * step);
      const wk = Math.floor((px - gutter) / step);
      return yi < 0 || wk < 0 || wk > 53 ? undefined : marks.get(yi * 400 + wk * 7 + Math.floor((py - bandTop(yi)) / step));
    };
    if (!paintRects(ctx, svg, rects, Number(svg.getAttribute('width')), Number(svg.getAttribute('height')), cell >= 8 ? Math.min(3, cell / 4) : 0, find)) {
      // no 2D canvas (headless export): fall back to SVG cells
      const live = new Set(marks.values());
      for (const r of rects) {
        const rect = s('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: Math.min(3, cell / 4), fill: r.fill, opacity: r.alpha });
        if (live.has(r)) interactive(ctx, rect, r.identity, r.tooltip, r.keys);
        svg.append(rect);
      }
    }
  },
});
