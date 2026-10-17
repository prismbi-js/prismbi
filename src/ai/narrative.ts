import type { CellValue, DataModel, FieldSpec, FilterSpec, QueryResult } from '@prismbi/prismbi';
import { explain, formatter, measureName, previousPeriod } from './explain';
import { findInsights } from './insights';

/** A piece of narrative text; `value` pieces are numbers or names worth emphasising. */
export type NarrativePart = string | { value: string };

export interface NarrativeOptions {
  /** Measures to describe (the first gets the most detail). */
  measures: FieldSpec[];
  filters?: FilterSpec[];
  /** Optional breakdown already queried by the caller (groups × the first measure), e.g. a visual's data. */
  breakdown?: QueryResult;
  /** Insights to append from `findInsights` (default 2, 0 to skip). */
  insights?: number;
  /**
   * Custom text: `{[Measure]}` becomes the formatted measure value under the filters, and `{summary}` the automatic
   * summary. Without it, only the automatic summary is produced.
   */
  template?: string;
}

export interface Narrative {
  /** Sentences, each a list of parts. */
  sentences: NarrativePart[][];
  /** Plain text of the whole narrative. */
  text: string;
}

const plain = (parts: NarrativePart[]) => parts.map((p) => (typeof p === 'string' ? p : p.value)).join('');
const label = (v: CellValue) => (v instanceof Date ? v.toISOString().slice(0, 10) : v === null || v === '' ? '(blank)' : String(v));
const pct = (x: number) => `${Math.abs(x * 100).toFixed(Math.abs(x) >= 1 ? 0 : 1)}%`;
const specOf = (f: FilterSpec) => ((f as { spec?: FilterSpec }).spec ?? f) as FilterSpec;

/** "for Bikes, 2025" from the equality filters in context. */
export function filterPhrase(filters: FilterSpec[]): string {
  const vals: string[] = [];
  for (const raw of filters) {
    const f = specOf(raw);
    if (!('target' in f)) continue;
    if (f.op === 'eq') vals.push(label(f.value ?? null));
    else if (f.op === 'in' && f.values && f.values.length <= 3) vals.push(f.values.map(label).join(' or '));
  }
  return vals.length ? ` for ${vals.slice(0, 4).join(', ')}` : '';
}

/**
 * A plain-language summary of measures under filters: the value, its change from the previous period with the biggest
 * contributors, the shape of an optional breakdown, and the most notable insights. Rule-based and deterministic, so
 * it updates instantly with filters; the narrative visual can pass it to a language model for rewording.
 */
export function writeNarrative(model: DataModel, opts: NarrativeOptions): Narrative {
  const filters = (opts.filters ?? []).map(specOf);
  const sentences: NarrativePart[][] = [];
  const ctx = filterPhrase(filters);
  const prev = previousPeriod(model, filters);

  opts.measures.slice(0, 3).forEach((m, i) => {
    const name = measureName(m);
    const fmt = formatter(model, m);
    if (i === 0) {
      const ex = explain(model, { measure: m, filters, maxDrivers: 6 });
      // levels of one hierarchy (Category › Subcategory) often carry the same change: keep the first of each
      const tableOf = (ref: string) => ref.replace(/\[.*$/, '');
      ex.drivers = ex.drivers.filter((d, k, all) => all.findIndex((o) => tableOf(o.column) === tableOf(d.column) && Math.abs(o.delta - d.delta) <= Math.abs(d.delta) * 0.02) === k).slice(0, 2);
      const s: NarrativePart[] = [`${name}${ctx} is `, { value: fmt(ex.current) }];
      if (ex.mode === 'change' && ex.change !== null) {
        s.push(`, ${ex.change > 0 ? 'up' : 'down'} `, ...(ex.changePct !== null ? [{ value: pct(ex.changePct) }, ' '] : []), 'from ', { value: fmt(ex.baseline) }, ` in ${ex.baselineLabel}`);
        if (ex.drivers.length) {
          s.push(', mostly from ');
          ex.drivers.forEach((d, k) => s.push(...(k ? [' and '] : []), { value: label(d.value) }, ` (${d.delta > 0 ? '+' : '−'}${fmt(Math.abs(d.delta))})`));
        }
      } else if (ex.mode === 'composition' && ex.drivers[0] && ex.current) {
        const d = ex.drivers[0];
        s.push('; ', { value: label(d.value) }, ` contributes ${Math.round(d.share * 100)}%`);
      }
      sentences.push([...s, '.']);
      return;
    }
    const cur = model.query({ values: [m], filters }).rows[0]?.values[0] as number | null | undefined;
    const s: NarrativePart[] = [`${name} is `, { value: fmt(cur ?? null) }];
    if (prev && typeof cur === 'number') {
      const before = model.query({ values: [m], filters: prev.filters }).rows[0]?.values[0];
      if (typeof before === 'number' && before !== 0 && before !== cur) s.push(` (${cur > before ? 'up' : 'down'} `, { value: pct((cur - before) / Math.abs(before)) }, ` from ${prev.label})`);
    }
    sentences.push([...s, '.']);
  });

  const b = opts.breakdown;
  if (b && b.groups.length && b.values.length && b.rows.length > 1) {
    const fmt = formatter(model, opts.measures[0]);
    const g = b.groups[0];
    const pts = b.rows.map((r) => [r.keys.map(label).join(', '), r.values[0]] as const).filter((p): p is readonly [string, number] => typeof p[1] === 'number');
    if (pts.length > 1) {
      const hi = pts.reduce((a, c) => (c[1] > a[1] ? c : a));
      const lo = pts.reduce((a, c) => (c[1] < a[1] ? c : a));
      const ordered = g.type === 'date' || g.type === 'number' || /year|quarter|month|week|day|date|period/i.test(g.name);
      if (ordered) {
        const [first, last] = [pts[0], pts[pts.length - 1]];
        const s: NarrativePart[] = [`Across ${g.name}, it went from `, { value: fmt(first[1]) }, ` in ${first[0]} to `, { value: fmt(last[1]) }, ` in ${last[0]}`];
        if (first[1]) s.push(` (${last[1] >= first[1] ? 'up' : 'down'} `, { value: pct((last[1] - first[1]) / Math.abs(first[1])) }, ')');
        s.push(', peaking at ', { value: fmt(hi[1]) }, ` in ${hi[0]}.`);
        sentences.push(s);
      } else {
        const total = pts.reduce((a, p) => a + p[1], 0);
        const share = total > 0 && pts.every((p) => p[1] >= 0) ? ` (${Math.round((hi[1] / total) * 100)}% of the total)` : '';
        sentences.push([{ value: hi[0] }, ` leads ${g.name} with `, { value: fmt(hi[1]) }, `${share}; `, { value: lo[0] }, ' is lowest at ', { value: fmt(lo[1]) }, '.']);
      }
    }
  }

  const nIns = opts.insights ?? 2;
  if (nIns > 0 && opts.measures[0]) {
    for (const ins of findInsights(model, { measure: opts.measures[0], filters, max: nIns + 2 }).filter((x) => x.kind !== 'concentration' || !b).slice(0, nIns)) sentences.push([`${ins.title}.`]);
  }

  let out = sentences;
  if (opts.template) {
    out = opts.template.split(/\n{2,}/).map((para) => {
      const parts: NarrativePart[] = [];
      let last = 0;
      for (const mt of para.matchAll(/\{(summary|\[[^\]]+\])\}/g)) {
        parts.push(para.slice(last, mt.index));
        if (mt[1] === 'summary') parts.push(...sentences.flatMap((s, k) => (k ? [' ', ...s] : s)));
        else {
          const name = mt[1].slice(1, -1);
          let v: string;
          try {
            v = formatter(model, name)(model.query({ values: [name], filters }).rows[0]?.values[0] as number | null);
          } catch {
            v = `[${name}?]`;
          }
          parts.push({ value: v });
        }
        last = mt.index! + mt[0].length;
      }
      parts.push(para.slice(last));
      return parts.filter((p) => p !== '');
    });
  }
  return { sentences: out, text: out.map(plain).join(' ') };
}
