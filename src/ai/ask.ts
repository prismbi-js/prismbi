import type { CellValue, DataModel, FieldSpec, FilterSpec, VisualSpec } from '@prismbi/prismbi';
import { buildVocabulary, isAggWord, isStop, key, labelColumn, words, type Entity, type Vocabulary } from './vocab';

type Column = Extract<Entity, { kind: 'column' }>;
type Agg = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'distinctCount' | 'countRows';

/** One understood part of the question, for display as chips ("Total Sales", "by Category", "2025"). */
export interface Interpretation {
  kind: 'measure' | 'group' | 'filter' | 'top' | 'visual' | 'note';
  text: string;
}

export interface AskResult {
  /** Visual to render, or null when nothing in the question matched the model. */
  spec: Omit<VisualSpec, 'layout'> | null;
  interpretation: Interpretation[];
  /** Words that were not understood (ignoring filler words). */
  unmatched: string[];
  /** 0–1: how much of the question was understood. */
  confidence: number;
  /** Where the answer came from. */
  source: 'rules' | 'llm';
}

/** A structured plan, what an LLM is asked to produce and what the rule parser produces internally. */
export interface QueryPlan {
  measures: (string | { column: string; aggregation: Agg })[];
  groupBy: string[];
  filters: FilterSpec[];
  top?: { n: number; direction: 'top' | 'bottom' };
  visual?: string;
}

export interface AskOptions {
  /** Extra names: `{ 'Total Sales': ['revenue', 'turnover'], 'Product[Category]': ['line'] }`. */
  synonyms?: Record<string, string[]>;
  /**
   * Optional language model: receives a prompt describing the model and the question and returns JSON for a
   * {@link QueryPlan}. Answers that reference unknown fields fall back to the rule-based parser.
   */
  llm?: (prompt: string) => Promise<string>;
  /** Reference date for "last month", "this year"… Default: the latest date with data. */
  today?: Date;
}

const vocabCache = new WeakMap<DataModel, { version: number; synonyms: string; vocab: Vocabulary }>();

function vocabulary(model: DataModel, synonyms: Record<string, string[]> = {}): Vocabulary {
  const s = JSON.stringify(synonyms);
  const version = model.measureList().length * 1000 + model.tableNames().length;
  const hit = vocabCache.get(model);
  if (hit && hit.synonyms === s && hit.version === version) return hit.vocab;
  const vocab = buildVocabulary(model, synonyms);
  vocabCache.set(model, { version, synonyms: s, vocab });
  return vocab;
}

// ---------------------------------------------------------------- time

const DAY = 86_400_000;

function dateColumn(vocab: Vocabulary): Column | undefined {
  if (!vocab.dateTable) return vocab.columns.find((c) => c.isDate);
  return vocab.columns.find((c) => c.table === vocab.dateTable && c.isDate);
}

/** Latest date that has facts (dates related to the calendar), so "last month" means the last month with data. */
function referenceDate(model: DataModel, dc: Column | undefined): Date {
  let best = 0;
  if (dc) {
    for (const r of model.relationships()) {
      if (r.toTable !== dc.table || !r.active) continue;
      for (const v of model.table(r.fromTable).column(r.fromColumn).values) if (v instanceof Date && v.getTime() > best) best = v.getTime();
    }
    if (!best) for (const v of model.table(dc.table).column(dc.column).values) if (v instanceof Date && v.getTime() > best) best = v.getTime();
  }
  return best ? new Date(best) : new Date();
}

const startOf = (d: Date, unit: 'year' | 'quarter' | 'month') => new Date(d.getFullYear(), unit === 'year' ? 0 : unit === 'quarter' ? Math.floor(d.getMonth() / 3) * 3 : d.getMonth(), 1);
const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
const fmtDay = (d: Date) => d.toISOString().slice(0, 10);

interface Extracted {
  filters: FilterSpec[];
  notes: Interpretation[];
  rest: string;
}

function extractTime(text: string, model: DataModel, vocab: Vocabulary, today?: Date): Extracted {
  const dc = dateColumn(vocab);
  const yearCol = vocab.columns.find((c) => c.table === (dc?.table ?? vocab.dateTable) && /^year$/i.test(c.column));
  const filters: FilterSpec[] = [];
  const notes: Interpretation[] = [];
  let rest = text;
  if (!dc && !yearCol) return { filters, notes, rest };
  const ref = today ?? referenceDate(model, dc);
  const between = (min: Date, max: Date, label: string) => {
    if (!dc) return;
    filters.push({ target: dc.ref, op: 'between', min, max });
    notes.push({ kind: 'filter', text: `${label} (${fmtDay(min)} – ${fmtDay(max)})` });
  };
  const take = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    const m = re.exec(rest);
    if (!m) return;
    fn(m);
    rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length);
  };
  take(/\b(?:last|past|previous)\s+(\d+)\s+(day|week|month|quarter|year)s?\b/i, (m) => {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const end = ref;
    const start = unit === 'day' ? new Date(end.getTime() - (n - 1) * DAY) : unit === 'week' ? new Date(end.getTime() - (n * 7 - 1) * DAY) : addMonths(new Date(end.getTime() + DAY), -(unit === 'month' ? n : unit === 'quarter' ? n * 3 : n * 12));
    between(start, end, `last ${n} ${unit}s`);
  });
  take(/\b(?:year to date|ytd|this year)\b/i, () => between(startOf(ref, 'year'), ref, 'this year to date'));
  take(/\b(?:quarter to date|qtd|this quarter)\b/i, () => between(startOf(ref, 'quarter'), ref, 'this quarter to date'));
  take(/\b(?:month to date|mtd|this month)\b/i, () => between(startOf(ref, 'month'), ref, 'this month to date'));
  take(/\blast year\b/i, () => {
    const y = ref.getFullYear() - 1;
    if (yearCol) {
      filters.push({ target: yearCol.ref, op: 'eq', value: y });
      notes.push({ kind: 'filter', text: `last year (${y})` });
    } else between(new Date(y, 0, 1), new Date(y, 11, 31), 'last year');
  });
  take(/\blast quarter\b/i, () => {
    const s = addMonths(startOf(ref, 'quarter'), -3);
    between(s, new Date(addMonths(s, 3).getTime() - DAY), 'last quarter');
  });
  take(/\blast month\b/i, () => {
    const s = addMonths(startOf(ref, 'month'), -1);
    between(s, new Date(startOf(ref, 'month').getTime() - DAY), 'last month');
  });
  const years: number[] = [];
  let m: RegExpExecArray | null;
  const yr = /\b(19[5-9]\d|20\d\d)\b/g;
  while ((m = yr.exec(rest))) years.push(Number(m[1]));
  if (years.length && yearCol) {
    filters.push(years.length === 1 ? { target: yearCol.ref, op: 'eq', value: years[0] } : { target: yearCol.ref, op: 'in', values: years });
    notes.push({ kind: 'filter', text: years.join(', ') });
    rest = rest.replace(yr, ' ');
  }
  return { filters, notes, rest };
}

// ---------------------------------------------------------------- hints

const VISUALS: [RegExp, string][] = [
  [/\b(?:pie|donut|doughnut)\b|\b(?:share|breakdown|proportion|composition|split)\b/i, 'donut'],
  [/\b(?:trend|trends|over time|timeline|history|evolution|line chart|line graph|as a line)\b/i, 'line'],
  [/\b(?:matrix|pivot|crosstab|cross tab)\b/i, 'matrix'],
  [/\b(?:table|list|details)\b/i, 'table'],
  [/\b(?:scatter|correlation|correlate|against)\b/i, 'scatter'],
  [/\b(?:treemap)\b/i, 'treemap'],
  [/\b(?:funnel)\b/i, 'funnel'],
  [/\b(?:waterfall)\b/i, 'waterfall'],
  [/\b(?:area chart|as an area)\b/i, 'area'],
  [/\b(?:bar chart|bars|as bars|horizontal)\b/i, 'clusteredBar'],
  [/\b(?:column chart|columns|as columns)\b/i, 'clusteredColumn'],
  [/\b(?:card|kpi|single number)\b/i, 'card'],
];

function extractHints(text: string): { visual?: string; top?: QueryPlan['top']; sortDir?: 'asc' | 'desc'; rest: string; notes: Interpretation[] } {
  let rest = text;
  const notes: Interpretation[] = [];
  let visual: string | undefined;
  for (const [re, v] of VISUALS) {
    const m = re.exec(rest);
    if (m) {
      visual ??= v;
      rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length);
    }
  }
  let top: QueryPlan['top'];
  const t = /\b(top|best|highest|largest|biggest|bottom|worst|lowest|smallest)\s+(\d{1,3})\b/i.exec(rest);
  if (t) {
    top = { n: Number(t[2]), direction: /top|best|highest|largest|biggest/i.test(t[1]) ? 'top' : 'bottom' };
    rest = rest.slice(0, t.index) + ' ' + rest.slice(t.index + t[0].length);
    notes.push({ kind: 'top', text: `${top.direction} ${top.n}` });
  }
  let sortDir: 'asc' | 'desc' | undefined;
  const s = /\b(highest|largest|biggest|most|best|lowest|smallest|least|worst)\b/i.exec(rest);
  if (s && !top) {
    sortDir = /lowest|smallest|least|worst/i.test(s[1]) ? 'asc' : 'desc';
    rest = rest.slice(0, s.index) + ' ' + rest.slice(s.index + s[0].length);
  }
  if (visual) notes.push({ kind: 'visual', text: visual });
  return { visual, top, sortDir, rest, notes };
}

// ---------------------------------------------------------------- entity matching

interface Match {
  entity: Entity;
  start: number;
  end: number;
}

function matchEntities(ws: string[], vocab: Vocabulary): { matches: Match[]; unmatched: string[] } {
  const matches: Match[] = [];
  const used = new Array(ws.length).fill(false);
  const rank = (e: Entity) => (e.kind === 'measure' ? 0 : e.kind === 'column' ? 1 : e.kind === 'table' ? 2 : 3);
  for (let len = vocab.maxLen; len >= 1; len--) {
    for (let i = 0; i + len <= ws.length; i++) {
      if (used.slice(i, i + len).some(Boolean)) continue;
      // "sales and profit" names two things, never one
      if (len > 1 && ws.slice(i, i + len).some((w) => /^(and|or|vs|versus|with|against|than)$/.test(w))) continue;
      const span = ws.slice(i, i + len).filter((w) => !isStop(w));
      if (!span.length || (span.length === 1 && isAggWord(span[0]))) continue;
      const cands = vocab.phrases.get(key(span));
      if (!cands?.length) continue;
      const best = [...cands].sort((a, b) => rank(a) - rank(b));
      // a phrase naming several values of different columns stays ambiguous: prefer measures/columns, else first value
      matches.push({ entity: best[0], start: i, end: i + len });
      for (let k = i; k < i + len; k++) used[k] = true;
    }
  }
  matches.sort((a, b) => a.start - b.start);
  const unmatched = ws.filter((w, i) => !used[i] && !isStop(w) && !isAggWord(w) && !/^(how|many|much|where|when|why|was|did|top|bottom)$/.test(w));
  return { matches, unmatched };
}

const GROUP_CUES = /\b(?:by|per|for each|each|across|split by|broken down by|grouped by|group by)\s*$/i;

function aggBefore(ws: string[], start: number): Agg | undefined {
  const before = ws.slice(Math.max(0, start - 3), start).join(' ');
  if (/\b(?:average|avg|mean)\b/.test(before)) return 'avg';
  if (/\b(?:max|maximum|highest|largest)\b/.test(before)) return 'max';
  if (/\b(?:min|minimum|lowest|smallest)\b/.test(before)) return 'min';
  if (/\b(?:distinct|unique)\b/.test(before)) return 'distinctCount';
  if (/\b(?:count|number|how many)\b/.test(before)) return 'count';
  if (/\b(?:sum|total)\b/.test(before)) return 'sum';
  return undefined;
}

const TIME_NAME = /(^|\b)(year|quarter|month|week|day|date|period|fiscal)/i;

/** Rule-based plan for a question. */
export function planQuestion(model: DataModel, question: string, opts: AskOptions = {}): { plan: QueryPlan; notes: Interpretation[]; unmatched: string[]; understood: number; total: number } {
  const vocab = vocabulary(model, opts.synonyms);
  const time = extractTime(question, model, vocab, opts.today);
  const hints = extractHints(time.rest);
  const ws = words(hints.rest);
  const { matches, unmatched } = matchEntities(ws, vocab);
  const plan: QueryPlan = { measures: [], groupBy: [], filters: [...time.filters], top: hints.top, visual: hints.visual };
  const notes: Interpretation[] = [];
  const valueFilters = new Map<string, CellValue[]>();
  const pendingTables: { table: string; start: number; grouped: boolean }[] = [];
  const raw = ws;
  for (const m of matches) {
    const before = raw.slice(0, m.start).join(' ');
    const grouped = GROUP_CUES.test(before);
    const e = m.entity;
    if (e.kind === 'measure') {
      if (!plan.measures.includes(e.name)) plan.measures.push(e.name);
    } else if (e.kind === 'value') {
      const list = valueFilters.get(e.ref) ?? [];
      list.push(e.value);
      valueFilters.set(e.ref, list);
    } else if (e.kind === 'column') {
      const agg = aggBefore(raw, m.start);
      if (e.numeric && !grouped && !TIME_NAME.test(e.column)) plan.measures.push({ column: e.ref, aggregation: agg ?? 'sum' });
      else if (agg === 'count' || agg === 'distinctCount') plan.measures.push({ column: e.ref, aggregation: agg === 'count' ? 'distinctCount' : agg });
      else if (!plan.groupBy.includes(e.ref)) plan.groupBy.push(e.ref);
    } else pendingTables.push({ table: e.table, start: m.start, grouped });
  }
  for (const t of pendingTables) {
    const agg = aggBefore(raw, t.start);
    if (agg === 'count' || agg === 'distinctCount') {
      plan.measures.push({ column: t.table, aggregation: 'countRows' });
      continue;
    }
    const lc = labelColumn(vocab, t.table);
    if (lc && (t.grouped || plan.groupBy.length === 0) && !plan.groupBy.includes(lc.ref)) plan.groupBy.push(lc.ref);
  }
  for (const [ref, values] of valueFilters) plan.filters.push(values.length === 1 ? { target: ref, op: 'eq', value: values[0] } : { target: ref, op: 'in', values });
  // "by month" without a single year means calendar months in sequence (Jan 2024 … Dec 2025), not 12 merged buckets
  const singleYear = plan.filters.some((f) => ('op' in f && f.op === 'eq' && /\[year\]$/i.test(String((f as { target: string }).target))) || ('min' in f && f.min instanceof Date && f.max instanceof Date && f.min.getFullYear() === f.max.getFullYear()));
  const monthYear = vocab.columns.find((c) => c.table === vocab.dateTable && /month.?year|year.?month/i.test(c.column) && c.type === 'string');
  if (!singleYear && monthYear)
    plan.groupBy = plan.groupBy.map((g) => {
      const c = vocab.columns.find((x) => x.ref === g);
      return c && c.table === vocab.dateTable && /^month(name|short)?$/i.test(c.column) ? monthYear.ref : g;
    });
  const understood = matches.reduce((n, m) => n + (m.end - m.start), 0) + time.notes.length + hints.notes.length;
  if (!plan.measures.length && vocab.measures[0] && (plan.groupBy.length || plan.filters.length)) {
    const first = vocab.measures[0] as Extract<Entity, { kind: 'measure' }>;
    plan.measures.push(first.name);
    notes.push({ kind: 'note', text: `assumed ${first.name}` });
  }
  if (hints.sortDir) (plan as QueryPlan & { sortDir?: string }).sortDir = hints.sortDir;
  return { plan, notes: [...notes, ...time.notes, ...hints.notes], unmatched, understood, total: understood + unmatched.length };
}

// ---------------------------------------------------------------- plan → visual

const refName = (ref: string) => /\[([^\]]+)\]$/.exec(ref)?.[1] ?? ref;

function measureField(m: QueryPlan['measures'][number]): FieldSpec {
  if (typeof m === 'string') return m;
  if (m.aggregation === 'countRows') return { expression: `COUNTROWS(${/^[A-Za-z_][A-Za-z0-9_]*$/.test(m.column) ? m.column : `'${m.column}'`})`, name: `Count of ${m.column}` };
  return { field: m.column, aggregation: m.aggregation };
}

function measureLabel(m: QueryPlan['measures'][number]): string {
  if (typeof m === 'string') return m;
  const names: Record<Agg, string> = { sum: 'Total', avg: 'Average', min: 'Min', max: 'Max', count: 'Count of', distinctCount: 'Distinct', countRows: 'Count of' };
  return `${names[m.aggregation]} ${m.aggregation === 'countRows' ? m.column : refName(m.column)}`;
}

/** Turn a plan into a visual spec, choosing a sensible chart type. */
export function planToSpec(model: DataModel, plan: QueryPlan & { sortDir?: 'asc' | 'desc' }): Omit<VisualSpec, 'layout'> {
  const ms = plan.measures.slice(0, 4).map(measureField);
  const gs = plan.groupBy.slice(0, 2);
  const isTime = (ref: string) => TIME_NAME.test(refName(ref)) || (() => {
    const m = /^'?(.*?)'?\[(.*)\]$/.exec(ref);
    return !!m && model.hasTable(m[1]) && model.table(m[1]).hasColumn(m[2]) && model.table(m[1]).column(m[2]).type === 'date';
  })();
  const distinct = (ref: string) => {
    const m = /^'?(.*?)'?\[(.*)\]$/.exec(ref);
    return m && model.hasTable(m[1]) && model.table(m[1]).hasColumn(m[2]) ? model.table(m[1]).distinct(m[2]).length : 0;
  };
  let type = plan.visual;
  const timeGroup = gs.find(isTime);
  if (!gs.length) type = ms.length > 1 ? 'multiRowCard' : 'card';
  else if (type === 'scatter' && (ms.length < 2 || gs.length !== 1)) type = undefined;
  else if (type === 'donut' && (gs.length !== 1 || ms.length !== 1)) type = undefined;
  else if (type === 'card' || type === 'multiRowCard') type = undefined;
  if (!type) {
    if (gs.length === 2) type = timeGroup && ms.length === 1 ? 'line' : distinct(gs[0]) * distinct(gs[1]) > 60 || ms.length > 1 ? 'matrix' : 'clusteredColumn';
    else if (timeGroup) type = 'line';
    else type = distinct(gs[0]) > 8 || plan.top ? 'clusteredBar' : 'clusteredColumn';
  }
  const spec: Omit<VisualSpec, 'layout'> = { type, fields: {} };
  const f = spec.fields as Record<string, FieldSpec | FieldSpec[]>;
  switch (type) {
    case 'card':
      f.value = ms[0];
      break;
    case 'multiRowCard':
      f.values = ms;
      break;
    case 'donut':
    case 'treemap':
    case 'funnel':
      f[type === 'donut' ? 'legend' : 'category'] = gs[0];
      f.values = ms[0];
      break;
    case 'scatter':
      f.details = gs[0];
      f.x = ms[0];
      f.y = ms[1];
      break;
    case 'table':
      f.columns = [...gs, ...ms];
      break;
    case 'matrix':
      f.rows = gs[0];
      if (gs[1]) f.columns = gs[1];
      f.values = ms;
      break;
    case 'waterfall':
      f.category = gs[0];
      f.values = ms[0];
      break;
    default: {
      // line / area / bars: a time group goes on the axis, the other becomes the legend
      const axis = timeGroup ?? gs[0];
      const legend = gs.find((g) => g !== axis);
      f.category = axis;
      if (legend && ms.length === 1) f.legend = legend;
      f.values = ms;
    }
  }
  if (plan.filters.length) spec.filters = plan.filters;
  const firstMeasure = plan.measures[0];
  const sortName = firstMeasure === undefined ? undefined : typeof firstMeasure === 'string' ? firstMeasure : (measureField(firstMeasure) as { name?: string }).name ?? measureLabel(firstMeasure);
  if (plan.top) {
    spec.top = plan.top.n;
    if (sortName && typeof firstMeasure === 'string') spec.sort = { field: sortName, direction: plan.top.direction === 'top' ? 'desc' : 'asc' };
  } else if (gs.length && !timeGroup && sortName && typeof firstMeasure === 'string' && type !== 'matrix') spec.sort = { field: sortName, direction: plan.sortDir ?? 'desc' };
  const parts = [plan.measures.map(measureLabel).join(', ') || 'Value', gs.length ? `by ${gs.map(refName).join(' and ')}` : ''].filter(Boolean);
  spec.title = parts.join(' ');
  return spec;
}

// ---------------------------------------------------------------- LLM

/** The prompt sent to `options.llm`: model schema plus the question, asking for a JSON plan. */
export function llmPrompt(model: DataModel, question: string): string {
  const tables = model.tableNames().map((t) => {
    const cols = [...model.table(t).columns.values()].filter((c) => !c.hidden).map((c) => `${c.name} (${c.type})`);
    return `- ${t}: ${cols.join(', ')}`;
  });
  const measures = model.measureList().map((m) => `- [${m.name}]${m.description ? `: ${m.description}` : ''}`);
  return [
    'You turn questions about a business data model into a JSON query plan.',
    'Tables and columns:',
    ...tables,
    'Measures:',
    ...measures,
    '',
    'Reply with JSON only, shaped like:',
    '{"measures":["Measure name" | {"column":"Table[Column]","aggregation":"sum|avg|min|max|count|distinctCount"}],',
    ' "groupBy":["Table[Column]"], "filters":[{"target":"Table[Column]","op":"eq|in|between|gt|lt","value":…,"values":[…],"min":…,"max":…}],',
    ' "top":{"n":5,"direction":"top|bottom"}, "visual":"line|clusteredColumn|clusteredBar|donut|table|matrix|scatter|card"}',
    'Use only the names listed above. Dates as "YYYY-MM-DD".',
    '',
    `Question: ${question}`,
  ].join('\n');
}

function validPlan(model: DataModel, p: unknown): QueryPlan | null {
  if (!p || typeof p !== 'object') return null;
  const plan = p as QueryPlan;
  const colOk = (ref: unknown) => {
    if (typeof ref !== 'string') return false;
    const m = /^'?(.*?)'?\[(.*)\]$/.exec(ref);
    return !!m && model.hasTable(m[1]) && model.table(m[1]).hasColumn(m[2]);
  };
  const measures = Array.isArray(plan.measures) ? plan.measures : [];
  if (!measures.length) return null;
  for (const m of measures) {
    if (typeof m === 'string' ? !model.hasMeasure(m.replace(/^\[|\]$/g, '')) : !(m && (m.aggregation === 'countRows' ? model.hasTable(m.column) : colOk(m.column)))) return null;
  }
  const groupBy = Array.isArray(plan.groupBy) ? plan.groupBy : [];
  if (!groupBy.every(colOk)) return null;
  const filters = (Array.isArray(plan.filters) ? plan.filters : []).map((f) => {
    const out = { ...f } as FilterSpec & { min?: unknown; max?: unknown; value?: unknown };
    for (const k of ['min', 'max', 'value'] as const) if (typeof out[k] === 'string' && /^\d{4}-\d{2}-\d{2}/.test(out[k] as string)) out[k] = new Date(out[k] as string);
    return out as FilterSpec;
  });
  if (!filters.every((f) => 'target' in f && colOk(f.target))) return null;
  return { measures: measures.map((m) => (typeof m === 'string' ? m.replace(/^\[|\]$/g, '') : m)), groupBy, filters, top: plan.top, visual: plan.visual };
}

// ---------------------------------------------------------------- public

/**
 * Answer a plain-language question with a visual: `ask(model, 'top 5 products by sales in 2025')`.
 * Offline and deterministic by default; pass `llm` to use a language model with validation and fallback.
 */
export async function ask(model: DataModel, question: string, opts: AskOptions = {}): Promise<AskResult> {
  if (opts.llm) {
    try {
      const text = await opts.llm(llmPrompt(model, question));
      const json = JSON.parse(/\{[\s\S]*\}/.exec(text)?.[0] ?? 'null');
      const plan = validPlan(model, json);
      if (plan) {
        const spec = planToSpec(model, plan);
        return { spec, interpretation: describe(plan), unmatched: [], confidence: 0.9, source: 'llm' };
      }
    } catch {
      // fall through to the rules
    }
  }
  return askSync(model, question, opts);
}

/** Synchronous, rule-based {@link ask}. */
export function askSync(model: DataModel, question: string, opts: Omit<AskOptions, 'llm'> = {}): AskResult {
  const { plan, notes, unmatched, understood, total } = planQuestion(model, question, opts);
  if (!plan.measures.length) return { spec: null, interpretation: notes, unmatched, confidence: 0, source: 'rules' };
  const spec = planToSpec(model, plan);
  return { spec, interpretation: [...describe(plan), ...notes.filter((n) => n.kind === 'note' || n.kind === 'visual' || (n.kind === 'filter' && !plan.filters.length))], unmatched, confidence: total ? Math.min(1, understood / total) : 0, source: 'rules' };
}

function describe(plan: QueryPlan): Interpretation[] {
  const out: Interpretation[] = plan.measures.map((m) => ({ kind: 'measure' as const, text: measureLabel(m) }));
  // "Product[Name]" reads as "by Product"
  for (const g of plan.groupBy) out.push({ kind: 'group', text: `by ${/^name$/i.test(refName(g)) ? (/^'?(.*?)'?\[/.exec(g)?.[1] ?? refName(g)) : refName(g)}` });
  for (const f of plan.filters) {
    const t = 'target' in f ? refName(String(f.target)) : '';
    const v = 'values' in f && f.values ? f.values.join(', ') : 'value' in f && f.value !== undefined ? String(f.value) : 'min' in f ? `${f.min instanceof Date ? fmtDay(f.min) : f.min} – ${f.max instanceof Date ? fmtDay(f.max as Date) : f.max}` : '';
    out.push({ kind: 'filter', text: `${t}: ${v}` });
  }
  if (plan.top) out.push({ kind: 'top', text: `${plan.top.direction} ${plan.top.n}` });
  return out;
}

/** A few questions that work on this model, for empty Q&A boxes. */
export function suggestQuestions(model: DataModel, max = 5): string[] {
  const vocab = vocabulary(model);
  const m = (vocab.measures[0] as Extract<Entity, { kind: 'measure' }> | undefined)?.name;
  if (!m) return [];
  // categorical columns with a handful of values make the best examples
  const cats = vocab.columns
    .filter((c) => c.type === 'string' && c.table !== vocab.dateTable)
    .map((c) => ({ c, n: model.table(c.table).distinct(c.column).length }))
    .filter((x) => x.n >= 2 && x.n <= 60)
    .sort((a, b) => a.n - b.n)
    .map((x) => ({ ...x.c, column: /^name$/i.test(x.c.column) ? x.c.table : x.c.column }))
    .slice(0, 3);
  const month = vocab.columns.find((c) => c.table === vocab.dateTable && /month/i.test(c.column));
  const second = (vocab.measures[1] as Extract<Entity, { kind: 'measure' }> | undefined)?.name;
  const out = [`${m} by ${cats[0]?.column ?? 'month'}`];
  if (month) out.push(`${m} trend by ${month.column.replace(/short|name/i, '').trim() || 'month'}`);
  if (cats[1]) out.push(`top 5 ${cats[1].column} by ${m}`);
  if (second && cats[0]) out.push(`${m} and ${second} by ${cats[0].column} as a table`);
  if (cats[2]) out.push(`share of ${m} by ${cats[2].column}`);
  return out.slice(0, max);
}
