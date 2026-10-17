import { formatValue } from 'prismbi';
import type { CellValue, DataModel, FieldSpec, FilterSpec, VisualSpec } from 'prismbi';

const KEYISH = /(^|[a-z])(key|id|guid|code)$/i;
const refOf = (table: string, column: string) => `${/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) ? table : `'${table}'`}[${column}]`;
/** "Product[Name]" reads as "Product"; other columns by their own name. */
const nameOf = (ref: string) => {
  const m = /^'?(.*?)'?\[([^\]]+)\]$/.exec(ref);
  return !m ? ref : /^name$/i.test(m[2]) ? m[1] : m[2];
};
const vk = (v: CellValue) => (v instanceof Date ? `D${v.getTime()}` : `${typeof v}:${String(v)}`);

export function measureName(m: FieldSpec): string {
  if (typeof m === 'string') return m.replace(/^\[|\]$/g, '');
  return m.name ?? (m.field ? `${m.aggregation ?? 'sum'} of ${nameOf(m.field)}` : m.expression ?? 'value');
}

function measureFormat(model: DataModel, m: FieldSpec): string | undefined {
  const n = measureName(m);
  if (typeof m === 'string' && model.hasMeasure(n)) return model.measure(n).format;
  if (typeof m !== 'string' && m.format) return m.format;
  return undefined;
}

/** Number formatter for a measure, using its format string. */
export function formatter(model: DataModel, m: FieldSpec): (v: number | null) => string {
  const f = measureFormat(model, m);
  return (v) => (v === null ? '(blank)' : formatValue(v, f, { displayUnits: Math.abs(v) >= 10_000 ? 'auto' : 'none' }));
}

const scalar = (model: DataModel, m: FieldSpec, filters: FilterSpec[]): number | null => {
  const r = model.query({ values: [m], filters });
  const v = r.rows[0]?.values[0];
  return typeof v === 'number' ? v : null;
};

/** Text columns worth splitting by: visible, not keys, 2–50 distinct values, outside the calendar. */
export function candidateDimensions(model: DataModel, exclude: string[] = []): string[] {
  const out: { ref: string; n: number }[] = [];
  // only tables wired into the model: calculation groups, field and what-if parameters are disconnected
  const related = new Set(model.relationships().flatMap((r) => [r.fromTable, r.toTable]));
  for (const t of model.tableNames()) {
    if (!related.has(t)) continue;
    const table = model.table(t);
    const cols = [...table.columns.values()];
    const isCalendar = cols.some((c) => c.type === 'date') && cols.some((c) => /^year$/i.test(c.name));
    if (isCalendar) continue;
    for (const c of cols) {
      if (c.hidden || c.type !== 'string' || KEYISH.test(c.name)) continue;
      const ref = refOf(t, c.name);
      if (exclude.some((e) => e.replace(/'/g, '') === ref.replace(/'/g, ''))) continue;
      const n = table.distinct(c.name).length;
      if (n >= 2 && n <= 50) out.push({ ref, n });
    }
  }
  return out.sort((a, b) => a.n - b.n).slice(0, 12).map((x) => x.ref);
}

// ---------------------------------------------------------------- baseline

/** The same filters one period earlier (Year = 2025 → 2024; a date range → the range before it), or null. */
export function previousPeriod(model: DataModel, filters: FilterSpec[]): { filters: FilterSpec[]; label: string } | null {
  let shifted = false;
  let label = '';
  const out = filters.map((f): FilterSpec => {
    if (!('target' in f)) return f;
    const target = String(f.target);
    const col = nameOf(target);
    if (/^year$/i.test(col) && f.op === 'eq' && typeof f.value === 'number') {
      shifted = true;
      label = String(f.value - 1);
      return { ...f, value: f.value - 1 };
    }
    if (/^year$/i.test(col) && f.op === 'in' && f.values?.length && f.values.every((v) => typeof v === 'number')) {
      shifted = true;
      const span = Math.max(...(f.values as number[])) - Math.min(...(f.values as number[])) + 1;
      label = f.values.length === 1 ? String((f.values[0] as number) - 1) : 'the previous period';
      return { ...f, values: (f.values as number[]).map((v) => v - span) };
    }
    if (f.op === 'between' && f.min instanceof Date && f.max instanceof Date) {
      shifted = true;
      const len = f.max.getTime() - f.min.getTime() + 86_400_000;
      const min = new Date(f.min.getTime() - len);
      const max = new Date(f.max.getTime() - len);
      label = `${min.toISOString().slice(0, 10)} – ${max.toISOString().slice(0, 10)}`;
      return { ...f, min, max };
    }
    if (f.op === 'eq' && f.value instanceof Date) {
      shifted = true;
      const d = new Date(f.value.getTime() - 86_400_000);
      label = d.toISOString().slice(0, 10);
      return { ...f, value: d };
    }
    return f;
  });
  void model;
  return shifted ? { filters: out, label } : null;
}

// ---------------------------------------------------------------- explain

export interface ExplainOptions {
  /** Measure name or field (`{ field: 'Sales[Amount]', aggregation: 'sum' }`). */
  measure: FieldSpec;
  /** The data point's context: page filters plus the point's own identity. */
  filters?: FilterSpec[];
  /** `'auto'` (previous period when the filters contain a period, else composition), `'none'`, or explicit filters. */
  baseline?: 'auto' | 'none' | FilterSpec[];
  /** Columns to look for drivers in. Default: categorical columns of the model. */
  dimensions?: string[];
  maxDrivers?: number;
}

export interface Driver {
  column: string;
  value: CellValue;
  current: number | null;
  baseline: number | null;
  /** Change (change mode) or value (composition mode). */
  delta: number;
  /** Share of the total change, or of the total value. */
  share: number;
}

export interface Explanation {
  measure: string;
  mode: 'change' | 'composition';
  current: number | null;
  baseline: number | null;
  change: number | null;
  changePct: number | null;
  baselineLabel?: string;
  drivers: Driver[];
  /** One-paragraph plain-language answer. */
  summary: string;
  /** A visual showing the top driver dimension. */
  spec?: Omit<VisualSpec, 'layout'>;
}

/**
 * Why is this value what it is? With a period in the filters, compares to the previous period and ranks the members
 * of each dimension by their contribution to the change; otherwise explains the composition of the value.
 */
export function explain(model: DataModel, opts: ExplainOptions): Explanation {
  const filters = opts.filters ?? [];
  const m = opts.measure;
  const name = measureName(m);
  const fmt = formatter(model, m);
  const current = scalar(model, m, filters);
  const fixed = filters.filter((f) => 'target' in f && (f.op === 'eq' || (f.op === 'in' && (f.values?.length ?? 0) <= 1))).map((f) => String((f as { target: string }).target));
  const dims = opts.dimensions ?? candidateDimensions(model, fixed);
  const maxDrivers = opts.maxDrivers ?? 5;
  const base = opts.baseline === 'none' ? null : Array.isArray(opts.baseline) ? { filters: opts.baseline, label: 'the baseline' } : previousPeriod(model, filters);
  const baseline = base ? scalar(model, m, base.filters) : null;

  const perDim = dims.map((d) => {
    const cur = model.query({ groupBy: [d], values: [m], filters });
    const prev = base ? model.query({ groupBy: [d], values: [m], filters: base.filters }) : null;
    const prevMap = new Map(prev?.rows.map((r) => [vk(r.keys[0]), r.values[0] as number | null]) ?? []);
    const seen = new Set<string>();
    const members: Driver[] = cur.rows.map((r) => {
      seen.add(vk(r.keys[0]));
      const c = typeof r.values[0] === 'number' ? (r.values[0] as number) : null;
      const b = prev ? (prevMap.get(vk(r.keys[0])) ?? null) : null;
      return { column: d, value: r.keys[0], current: c, baseline: b, delta: base ? (c ?? 0) - (b ?? 0) : (c ?? 0), share: 0 };
    });
    if (prev) for (const r of prev.rows) if (!seen.has(vk(r.keys[0]))) members.push({ column: d, value: r.keys[0], current: null, baseline: r.values[0] as number | null, delta: -((r.values[0] as number | null) ?? 0), share: 0 });
    return { d, members };
  });

  let drivers: Driver[] = [];
  if (base && current !== null && baseline !== null && current !== baseline) {
    const total = current - baseline;
    for (const { members } of perDim) {
      for (const mem of members) mem.share = total ? mem.delta / total : 0;
      // the members that moved the same way as the total, biggest first (at most two per dimension)
      drivers.push(...members.filter((x) => Math.sign(x.delta) === Math.sign(total)).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 2));
    }
    drivers = drivers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, maxDrivers);
    const pct = baseline ? total / Math.abs(baseline) : null;
    const dir = total > 0 ? 'rose' : 'fell';
    const parts = drivers.slice(0, 3).map((x) => `${nameOf(x.column)} ${String(x.value)} (${x.delta > 0 ? '+' : '−'}${fmt(Math.abs(x.delta))}, ${Math.round(Math.abs(x.share) * 100)}% of the change)`);
    const summary = `${name} ${dir} ${pct !== null ? `${Math.abs(pct * 100).toFixed(1)}% ` : ''}to ${fmt(current)} from ${fmt(baseline)} in ${base.label}.${parts.length ? ` Biggest contributors: ${parts.join('; ')}.` : ''}`;
    const top = drivers[0];
    return {
      measure: name,
      mode: 'change',
      current,
      baseline,
      change: total,
      changePct: pct,
      baselineLabel: base.label,
      drivers,
      summary,
      spec: top ? { type: 'clusteredBar', title: `${name} by ${nameOf(top.column)}`, fields: { category: top.column, values: [m] }, filters, sort: { field: name, direction: 'desc' } } : undefined,
    };
  }

  // composition: which members make up the value, ranked by how concentrated each dimension is
  const scored = perDim
    .map(({ d, members }) => {
      const total = members.reduce((s, x) => s + Math.max(0, x.current ?? 0), 0);
      for (const x of members) x.share = total ? (x.current ?? 0) / total : 0;
      const sorted = members.filter((x) => (x.current ?? 0) > 0).sort((a, b) => b.share - a.share);
      const lead = sorted[0];
      return { d, lead, score: lead ? lead.share - 1 / Math.max(1, sorted.length) : 0, n: sorted.length };
    })
    .filter((x) => x.lead && x.n > 1)
    .sort((a, b) => b.score - a.score);
  drivers = scored.slice(0, maxDrivers).map((x) => x.lead!);
  const parts = scored.slice(0, 3).map((x) => `${String(x.lead!.value)} makes up ${Math.round(x.lead!.share * 100)}% (of ${x.n} ${nameOf(x.d)} values)`);
  const summary = current === null ? `${name} is blank here.` : `${name} is ${fmt(current)}.${parts.length ? ` ${parts.join('; ')}.` : ''}`;
  const top = scored[0];
  return {
    measure: name,
    mode: 'composition',
    current,
    baseline: null,
    change: null,
    changePct: null,
    drivers,
    summary,
    spec: top ? { type: 'donut', title: `${name} by ${nameOf(top.d)}`, fields: { legend: top.d, values: m }, filters } : undefined,
  };
}
