import { h, s } from '../render/svg';
import { linearScale, pointScale } from '../render/scales';
import type { CellValue } from '../data/types';
import { defineVisual } from './registry';
import { emptyState } from './common';

/** One goal's settings, keyed by measure name in `format.scorecard.goals`. */
export interface GoalFormat {
  /** A fixed target (instead of, or overriding, a measure in the Targets role). */
  target?: number;
  /** `'up'` (default): higher is better. `'down'`: lower is better (costs, defects). */
  direction?: 'up' | 'down';
  /** Progress from which a goal is "at risk" rather than "behind" (default 0.9 of target). */
  atRisk?: number;
  /** Display name (default: the measure's). */
  label?: string;
  owner?: string;
  /** Due date, shown as given (e.g. `'2025-12-31'`). */
  due?: string;
}

export interface ScorecardFormat {
  goals?: Record<string, GoalFormat>;
  /** Show the trend sparkline column when a trend axis is set (default true). */
  sparklines?: boolean;
}

export type GoalStatus = 'on-track' | 'at-risk' | 'behind' | 'none';

/** Progress towards a target and the status it gives (lower-is-better goals invert the ratio). */
export function goalStatus(value: CellValue, target: CellValue, goal: GoalFormat = {}): { progress: number | null; status: GoalStatus } {
  if (typeof value !== 'number' || typeof target !== 'number' || target === 0) return { progress: null, status: 'none' };
  const progress = goal.direction === 'down' ? (value === 0 ? Infinity : target / value) : value / target;
  return { progress, status: progress >= 1 ? 'on-track' : progress >= (goal.atRisk ?? 0.9) ? 'at-risk' : 'behind' };
}

const STATUS: Record<GoalStatus, { label: string; color: string }> = {
  'on-track': { label: 'On track', color: 'var(--pbi-good)' },
  'at-risk': { label: 'At risk', color: 'var(--pbi-warning)' },
  behind: { label: 'Behind', color: 'var(--pbi-bad)' },
  none: { label: 'No target', color: 'var(--pbi-fg-3)' },
};

/**
 * Scorecard (goals): one row per measure with its current value, target, progress, status and trend. Targets come
 * from the Targets role (paired with Values in order) or `format.scorecard.goals[measure].target`.
 */
export const scorecard = /* @__PURE__ */ defineVisual({
  type: 'scorecard',
  displayName: 'Scorecard',
  category: 'card',
  roles: [
    { name: 'values', displayName: 'Goals', kind: 'measure', multiple: true, required: true },
    { name: 'targets', displayName: 'Targets', kind: 'measure', multiple: true },
    { name: 'trend', displayName: 'Trend axis', kind: 'grouping' },
  ],
  defaultSort: 'key',
  buildQuery(_b, base) {
    return { ...base, totals: true };
  },
  render(ctx) {
    const vis = ctx.role('values').indices;
    if (!vis.length) return emptyState(ctx, 'Add measures as goals');
    const tis = ctx.role('targets').indices;
    const gi = ctx.role('trend').indices[0];
    const f = (ctx.format.scorecard ?? {}) as ScorecardFormat;
    const { data, theme: t } = ctx;
    const rows = data.rows;
    const spark = gi !== undefined && rows.length > 1 && f.sparklines !== false;
    // current = the latest trend point with a value (as Power BI goals), or the total without a trend
    const current = (i: number): CellValue => {
      if (gi === undefined) return data.totals?.[i] ?? rows[0]?.values[i] ?? null;
      for (let r = rows.length - 1; r >= 0; r--) if (rows[r].values[i] !== null) return rows[r].values[i];
      return null;
    };
    const cell = 'padding:6px 8px;border-bottom:1px solid var(--pbi-grid);white-space:nowrap';
    const table = h('table', { class: 'pbi-scorecard', style: 'width:100%;border-collapse:collapse;font-size:13px;color:var(--pbi-fg)' });
    const head = h('tr', {});
    for (const label of ['Goal', 'Current', 'Target', 'Progress', 'Status', ...(spark ? ['Trend'] : []), 'Owner', 'Due'])
      head.append(h('th', { style: `${cell};text-align:${label === 'Current' || label === 'Target' ? 'right' : 'left'};font-weight:600;color:var(--pbi-fg-2);font-size:12px` }, label));
    table.append(h('thead', {}, head));
    const body = h('tbody', {});
    let anyOwner = false;
    let anyDue = false;
    vis.forEach((vi, k) => {
      const field = data.values[vi];
      const goal = f.goals?.[field.name] ?? {};
      const value = current(vi);
      const ti = tis[k];
      const target: CellValue = goal.target ?? (ti !== undefined ? current(ti) : null);
      const { progress, status } = goalStatus(value, target, goal);
      const st = STATUS[status];
      anyOwner ||= !!goal.owner;
      anyDue ||= !!goal.due;
      const tr = h('tr', { 'data-status': status });
      tr.append(h('td', { style: `${cell};font-weight:600` }, goal.label ?? field.name));
      tr.append(h('td', { style: `${cell};text-align:right;font-variant-numeric:tabular-nums` }, ctx.fmt(field, value, { blank: '(Blank)' })));
      tr.append(h('td', { style: `${cell};text-align:right;font-variant-numeric:tabular-nums;color:var(--pbi-fg-2)` }, target === null ? '–' : ctx.fmt(ti !== undefined && goal.target === undefined ? data.values[ti] : field, target)));
      const bar = h('td', { style: `${cell};min-width:76px` });
      if (progress !== null) {
        const pct = Math.max(0, Math.min(1, progress));
        const track = h('div', { style: 'position:relative;height:6px;border-radius:3px;background:var(--pbi-grid);min-width:40px;flex:1' });
        track.append(h('div', { style: `position:absolute;left:0;top:0;bottom:0;width:${(pct * 100).toFixed(1)}%;border-radius:3px;background:${st.color}` }));
        bar.append(h('div', { style: 'display:flex;align-items:center;gap:6px' }, track, h('span', { style: 'font-size:11px;color:var(--pbi-fg-2);font-variant-numeric:tabular-nums' }, Number.isFinite(progress) ? `${Math.round(progress * 100)}%` : '–')));
      }
      tr.append(bar);
      tr.append(h('td', { style: cell }, h('span', { style: `display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;color:${st.color}` }, h('span', { style: `width:8px;height:8px;border-radius:50%;background:${st.color}` }), st.label)));
      if (spark) {
        const w = 90;
        const hh = 22;
        const vals = rows.map((r) => (typeof r.values[vi] === 'number' ? (r.values[vi] as number) : null));
        const nums = vals.filter((v): v is number => v !== null);
        const td = h('td', { style: cell });
        if (nums.length > 1) {
          const y = linearScale(Math.min(...nums), Math.max(...nums), [hh - 3, 3], { includeZero: false });
          const x = pointScale(vals.length, [2, w - 4]);
          const pts = vals.map((v, i) => (v === null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean);
          const svg = s('svg', { width: w, height: hh, class: 'pbi-svg', role: 'img', 'aria-label': `${field.name} trend` });
          svg.append(s('path', { d: `M${pts.join('L')}`, fill: 'none', stroke: t.dataColors[0], 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
          td.append(svg);
        }
        tr.append(td);
      }
      tr.append(h('td', { style: `${cell};color:var(--pbi-fg-2)` }, goal.owner ?? ''));
      tr.append(h('td', { style: `${cell};color:var(--pbi-fg-2)` }, goal.due ?? ''));
      body.append(tr);
    });
    table.append(body);
    // owner and due columns only when some goal has them
    const drop = (label: string) => {
      const idx = [...head.children].findIndex((c) => c.textContent === label);
      if (idx >= 0) for (const tr of table.querySelectorAll('tr')) tr.children[idx]?.remove();
    };
    if (!anyDue) drop('Due');
    if (!anyOwner) drop('Owner');
    // in a narrow tile, leave out the least important columns first; Goal, Current and Status always stay
    const widths: Record<string, number> = { Goal: Math.min(180, Math.max(70, ...vis.map((vi) => (f.goals?.[data.values[vi].name]?.label ?? data.values[vi].name).length * 7 + 16))), Current: 90, Target: 90, Progress: 80, Status: 85, Trend: 106, Owner: 90, Due: 96 };
    const shown = () => [...head.children].map((c) => c.textContent ?? '');
    for (const label of ['Due', 'Owner', 'Trend', 'Target', 'Progress'])
      if (shown().reduce((a, c) => a + (widths[c] ?? 0), 0) > ctx.width && shown().includes(label)) drop(label);
    ctx.root.replaceChildren(h('div', { style: 'height:100%;overflow:auto' }, table));
  },
});
