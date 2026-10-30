import { s, measureText, fitText } from '../render/svg';
import { bandScale, timeScale } from '../render/scales';
import { mix } from '../render/color';
import type { CellValue } from '../data/types';
import { defineVisual } from './registry';
import { emptyState, identityOf, interactive, markOpacity } from './common';

export interface GanttFormat {
  barHeight?: number;
  showProgress?: boolean;
}

const MS_DAY = 86_400_000;

function toDate(v: CellValue): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Gantt chart: project schedule visual with task bars, progress fills and milestones. */
export const gantt = /* @__PURE__ */ defineVisual({
  type: 'gantt',
  displayName: 'Gantt chart',
  category: 'chart',
  roles: [
    { name: 'task', displayName: 'Task', kind: 'grouping', required: true },
    { name: 'start', displayName: 'Start date', kind: 'measure', required: true },
    { name: 'end', displayName: 'End date', kind: 'measure' },
    { name: 'progress', displayName: 'Progress %', kind: 'measure' },
    { name: 'resource', displayName: 'Resource', kind: 'grouping' },
  ],
  defaultSort: 'key',
  render(ctx) {
    const ti = ctx.role('task').indices[0];
    const si = ctx.role('start').indices[0];
    const ei = ctx.role('end').indices[0];
    const pi = ctx.role('progress').indices[0];
    const ri = ctx.role('resource').indices[0];

    if (ti === undefined || si === undefined || !ctx.data.rows.length) return emptyState(ctx);

    const t = ctx.theme;
    const taskField = ctx.data.groups[ti];
    const W = ctx.width;
    const H = ctx.height;
    const fs = t.labelFontSize;

    interface TaskItem {
      name: string;
      start: Date;
      end: Date;
      progress: number;
      resource?: string;
      identity: ReturnType<typeof identityOf>;
      opacity: number;
    }

    const items: TaskItem[] = [];
    for (const row of ctx.data.rows) {
      const name = ctx.fmt(taskField, row.keys[ti]) || '(Blank)';
      const sDate = toDate(row.values[si]);
      if (!sDate) continue;
      const eDate = (ei !== undefined ? toDate(row.values[ei]) : null) ?? new Date(sDate.getTime() + MS_DAY);
      let prog = pi !== undefined ? Number(row.values[pi]) : 0;
      if (prog > 1) prog /= 100; // handle 0-100% vs 0-1
      prog = Math.max(0, Math.min(1, Number.isNaN(prog) ? 0 : prog));
      const res = ri !== undefined ? String(row.keys[ri] ?? '') : undefined;
      const ident = identityOf(ctx.data.groups, row.keys);
      const op = markOpacity(ctx, ident);
      items.push({ name, start: sDate, end: eDate, progress: prog, resource: res, identity: ident, opacity: op });
    }

    if (!items.length) return emptyState(ctx);

    const minDate = new Date(Math.min(...items.map((x) => x.start.getTime())));
    const maxDate = new Date(Math.max(...items.map((x) => Math.max(x.start.getTime() + MS_DAY, x.end.getTime()))));

    // Pad dates slightly
    minDate.setDate(minDate.getDate() - 1);
    maxDate.setDate(maxDate.getDate() + 2);

    const maxLabelW = Math.min(160, Math.ceil(Math.max(...items.map((it) => measureText(it.name, fs, t.fontFamily)))) + 16);
    const left = Math.max(80, maxLabelW);
    const top = 32;
    const bottom = 24;
    const right = 20;

    const chartW = Math.max(40, W - left - right);
    const chartH = Math.max(40, H - top - bottom);

    const xTime = timeScale(minDate.getTime(), maxDate.getTime(), [left, left + chartW]);
    const yBand = bandScale(items.length, [top, top + chartH], 0.35, 0.1);

    const svg = s('svg', { width: W, height: H, class: 'pbi-svg', role: 'img', 'aria-label': ctx.spec.title ?? 'Gantt chart' });

    // Grid lines & Time axis ticks
    for (let i = 0; i < xTime.ticks.length; i++) {
      const dt = xTime.ticks[i];
      const x = xTime(dt);
      svg.append(
        s('line', { x1: x, y1: top - 6, x2: x, y2: top + chartH, stroke: t.gridline, 'stroke-width': 1, 'stroke-dasharray': '2,2' }),
        s('text', { x, y: top - 10, 'text-anchor': 'middle', fill: t.axis, 'font-size': fs - 1, 'font-family': t.fontFamily }, xTime.tickFormat(dt, i)),
      );
    }

    // Task rows
    items.forEach((item, i) => {
      const y = yBand(i);
      const h = Math.max(8, yBand.bandwidth);
      const x1 = Math.max(left, xTime(item.start.getTime()));
      const x2 = Math.min(left + chartW, xTime(item.end.getTime()));
      const barW = Math.max(4, x2 - x1);

      // Task label
      const labelText = fitText(item.name, left - 12, fs, t.fontFamily);
      svg.append(
        s('text', { x: left - 8, y: y + h / 2 + 4, 'text-anchor': 'end', fill: t.foreground, 'font-size': fs, 'font-family': t.fontFamily }, labelText),
      );

      const color = ctx.seriesColor('Task', 0);
      const progColor = mix(color, '#000000', 0.25);

      const g = s('g', { class: 'pbi-mark', opacity: item.opacity });

      // Is it a milestone (start == end or width <= 6)?
      if (item.start.getTime() === item.end.getTime() || Math.abs(x2 - x1) < 6) {
        const mx = x1;
        const my = y + h / 2;
        const size = h * 0.7;
        const diamond = `M ${mx} ${my - size} L ${mx + size} ${my} L ${mx} ${my + size} L ${mx - size} ${my} Z`;
        g.append(s('path', { d: diamond, fill: color, stroke: t.background, 'stroke-width': 1.5 }));
      } else {
        // Base task bar
        g.append(s('rect', { x: x1, y, width: barW, height: h, rx: 3, fill: color, opacity: 0.8 }));

        // Progress bar fill
        if (item.progress > 0) {
          const pw = Math.max(2, barW * item.progress);
          g.append(s('rect', { x: x1, y, width: pw, height: h, rx: 3, fill: progColor }));
        }

        // Percentage text inside or beside bar
        if (barW > 36) {
          g.append(
            s('text', { x: x1 + 6, y: y + h / 2 + 3.5, fill: '#ffffff', 'font-size': fs - 2, 'font-family': t.fontFamily, 'font-weight': 600 }, `${Math.round(item.progress * 100)}%`),
          );
        }
      }

      interactive(
        ctx,
        g,
        item.identity,
        () => ({
          title: item.name,
          items: [
            { label: 'Start', value: item.start.toLocaleDateString() },
            { label: 'End', value: item.end.toLocaleDateString() },
            { label: 'Duration', value: `${Math.round((item.end.getTime() - item.start.getTime()) / MS_DAY)} days` },
            { label: 'Progress', value: `${Math.round(item.progress * 100)}%` },
            ...(item.resource ? [{ label: 'Resource', value: item.resource }] : []),
          ],
        }),
        [item.name],
      );

      svg.append(g);
    });

    ctx.root.replaceChildren(svg);
  },
});
