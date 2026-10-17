import type { CellValue } from '../data/types';
import type { QueryField, QueryResult } from '../data/query';

/** Visuals whose content is already text (screen readers read them directly). */
const TEXTUAL = new Set(['table', 'matrix', 'slicer', 'text', 'qna', 'insights', 'button', 'image', 'shape']);

export interface NarrateOptions {
  /** Readable visual type, e.g. "Line chart". */
  typeName: string;
  title?: string;
  fmt: (field: QueryField | undefined, v: CellValue) => string;
}

const num = (v: CellValue): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * A short plain-language description of what a visual shows, for screen readers and alt text:
 * "Line chart of Total Sales by Month: 24 values from Jan 2024 to Dec 2025. Highest is Dec 2025 at $1.05M, …".
 */
export function narrate(type: string, data: QueryResult | null, opts: NarrateOptions): string {
  if (TEXTUAL.has(type) || !data) return '';
  const { fmt } = opts;
  const head = opts.title ? `${opts.typeName} "${opts.title}"` : opts.typeName;
  const values = data.values;
  if (!data.rows.length) return `${head}: no data for the current selection.`;
  if (!data.groups.length) {
    const parts = values.map((v, i) => `${v.name} is ${fmt(v, data.rows[0].values[i]) || 'blank'}`);
    return `${head}: ${parts.join('; ')}.`;
  }
  const g = data.groups[0];
  const v = values[0];
  if (!v) return `${head}: ${data.rows.length} ${g.name} values.`;
  const label = (i: number) => data.rows[i].keys.map((k, j) => fmt(data.groups[j], k)).join(', ') || '(blank)';
  const series = data.groups.length > 1 ? ` across ${new Set(data.rows.map((r) => JSON.stringify(r.keys.slice(1)))).size} ${data.groups[1].name} values` : '';
  const ys = data.rows.map((r) => num(r.values[0]));
  const valid = ys.map((y, i) => [y, i] as const).filter((p): p is readonly [number, number] => p[0] !== null);
  const sentences = [`${head} of ${v.name} by ${data.groups.map((x) => x.name).join(' and ')}: ${data.rows.length} values${series}${data.rows.length > 1 && !series ? ` from ${label(0)} to ${label(data.rows.length - 1)}` : ''}.`];
  if (valid.length) {
    const hi = valid.reduce((a, b) => (b[0] > a[0] ? b : a));
    const lo = valid.reduce((a, b) => (b[0] < a[0] ? b : a));
    if (valid.length > 1) sentences.push(`Highest is ${label(hi[1])} at ${fmt(v, hi[0])}, lowest is ${label(lo[1])} at ${fmt(v, lo[0])}.`);
    // ordered axes (time, numbers) get a trend; categories get the leader's share
    const ordered = g.type === 'date' || g.type === 'number' || /year|quarter|month|week|day|date|period/i.test(g.name);
    if (ordered && valid.length > 2 && !series) {
      const first = valid[0][0];
      const last = valid[valid.length - 1][0];
      if (first) {
        const pct = (last - first) / Math.abs(first);
        sentences.push(Math.abs(pct) < 0.005 ? 'Flat from first to last.' : `${pct > 0 ? 'Up' : 'Down'} ${Math.abs(pct * 100).toFixed(pct > 1 || pct < -1 ? 0 : 1)}% from first to last.`);
      }
    } else if (!ordered && !series && valid.every(([y]) => y >= 0) && valid.length <= 50) {
      const total = valid.reduce((s, [y]) => s + y, 0);
      if (total > 0) sentences.push(`${label(hi[1])} is the largest, with ${Math.round((hi[0] / total) * 100)}% of the total.`);
    }
  }
  if (values.length > 1) sentences.push(`Also shows ${values.slice(1).map((x) => x.name).join(', ')}.`);
  return sentences.join(' ');
}
