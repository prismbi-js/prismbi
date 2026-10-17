import { parseDax } from '@prismbi/prismbi';
import type { CellValue, DataModel, Expr, FilterSpec } from '@prismbi/prismbi';
import { planQuestion, type AskOptions, type QueryPlan } from './ask';
import { contextToPrompt, getAIContext } from './agent';

export interface DaxSuggestion {
  expression: string;
  /** Suggested measure name. */
  name: string;
  format?: string;
  /** What was understood, or why a fallback was used. */
  note: string;
  /** Value with no filters (the expression was validated by evaluating it). */
  value: CellValue;
  source: 'rules' | 'llm';
}

export interface DaxCopilotOptions {
  /** Optional language model: receives a prompt and returns JSON `{ "expression", "name", "format" }`. */
  llm?: (prompt: string) => Promise<string>;
  synonyms?: AskOptions['synonyms'];
}

// ---------------------------------------------------------------- helpers

const quoteTable = (t: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t) ? t : `'${t.replace(/'/g, "''")}'`);
const parseRef = (ref: string) => /^'?(.*?)'?\[([^\]]+)\]$/.exec(ref);
const colRef = (ref: string) => {
  const m = parseRef(ref);
  return m ? `${quoteTable(m[1])}[${m[2]}]` : ref;
};

function literal(v: CellValue): string {
  if (v instanceof Date) return `DATE(${v.getUTCFullYear()}, ${v.getUTCMonth() + 1}, ${v.getUTCDate()})`;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE()' : 'FALSE()';
  if (v === null) return 'BLANK()';
  return `"${String(v).replace(/"/g, '""')}"`;
}

function filterDax(f: FilterSpec): string | null {
  if (!('target' in f) || f.op === 'topN') return null;
  const c = colRef(String(f.target));
  switch (f.op) {
    case 'eq':
      return `${c} = ${literal(f.value ?? null)}`;
    case 'in':
      return `${c} IN { ${(f.values ?? []).map(literal).join(', ')} }`;
    case 'between': {
      const parts = [f.min !== undefined && f.min !== null ? `${c} >= ${literal(f.min)}` : '', f.max !== undefined && f.max !== null ? `${c} <= ${literal(f.max)}` : ''].filter(Boolean);
      return parts.join(' && ') || null;
    }
    default:
      return null;
  }
}

const AGG_DAX: Record<string, string> = { sum: 'SUM', avg: 'AVERAGE', average: 'AVERAGE', min: 'MIN', max: 'MAX', count: 'COUNT', distinctCount: 'DISTINCTCOUNT', median: 'MEDIAN' };
const AGG_WORD: Record<string, string> = { sum: 'Total', avg: 'Average', average: 'Average', min: 'Min', max: 'Max', count: 'Count of', distinctCount: 'Distinct', countRows: 'Count of', median: 'Median' };

function measureDax(m: QueryPlan['measures'][number]): { dax: string; name: string } {
  if (typeof m === 'string') return { dax: `[${m}]`, name: m };
  if (m.aggregation === 'countRows') return { dax: `COUNTROWS(${quoteTable(m.column)})`, name: `Count of ${m.column}` };
  const col = parseRef(m.column)?.[2] ?? m.column;
  return { dax: `${AGG_DAX[m.aggregation] ?? 'SUM'}(${colRef(m.column)})`, name: `${AGG_WORD[m.aggregation] ?? 'Total'} ${col}` };
}

/** The calendar's date column, for time intelligence. */
export function dateColumn(model: DataModel): string | undefined {
  let fallback: string | undefined;
  for (const t of model.tableNames()) {
    const cols = [...model.table(t).columns.values()];
    const d = cols.find((c) => c.type === 'date' && !c.expression);
    if (!d) continue;
    const ref = `${quoteTable(t)}[${d.name}]`;
    if (cols.some((c) => /^year$/i.test(c.name))) return ref;
    fallback ??= ref;
  }
  return fallback;
}

interface Pattern {
  re: RegExp;
  suffix: string;
  format?: string;
  needsDate?: boolean;
  build: (base: string, date: string) => string;
}

const py = (base: string, date: string) => `CALCULATE(${base}, SAMEPERIODLASTYEAR(${date}))`;
// order matters: the first match wins
const PATTERNS: Pattern[] = [
  { re: /\b(?:yoy|year[- ]over[- ]year|vs\.?|versus|compared (?:to|with)|growth|change)\b.*%|%.*\b(?:growth|change)\b|\b(?:growth|change) (?:rate|percent(?:age)?)\b|\b(?:yoy|year[- ]over[- ]year) growth\b|\bgrowth\b(?!.*\babsolute\b)/i, suffix: 'YoY %', format: '0.0%', needsDate: true, build: (b, d) => `VAR Prev = ${py(b, d)}\nRETURN DIVIDE(${b} - Prev, Prev)` },
  { re: /\b(?:yoy|year[- ]over[- ]year|change|difference|vs\.?|versus|compared (?:to|with))\b/i, suffix: 'YoY Change', needsDate: true, build: (b, d) => `${b} - ${py(b, d)}` },
  { re: /\b(?:ytd|year[- ]to[- ]date)\b/i, suffix: 'YTD', needsDate: true, build: (b, d) => `TOTALYTD(${b}, ${d})` },
  { re: /\b(?:qtd|quarter[- ]to[- ]date)\b/i, suffix: 'QTD', needsDate: true, build: (b, d) => `TOTALQTD(${b}, ${d})` },
  { re: /\b(?:mtd|month[- ]to[- ]date)\b/i, suffix: 'MTD', needsDate: true, build: (b, d) => `TOTALMTD(${b}, ${d})` },
  { re: /\b(?:last|previous|prior|same period last) year\b|\bpy\b/i, suffix: 'PY', needsDate: true, build: py },
  { re: /\b(?:running total|cumulative|to date)\b/i, suffix: 'Running Total', needsDate: true, build: (b, d) => `CALCULATE(${b}, FILTER(ALLSELECTED(${d}), ${d} <= MAX(${d})))` },
  { re: /(?:%|\bpercent(?:age)?) of (?:the )?total\b|\bshare\b/i, suffix: '% of Total', format: '0.0%', build: (b) => `DIVIDE(${b}, CALCULATE(${b}, ALLSELECTED()))` },
];

// words that belong to the pattern, not to the measure or its filters
const PATTERN_WORDS = /\b(?:yoy|year[- ]over[- ]year|vs\.?|versus|compared (?:to|with)|growth|change|difference|rate|percent(?:age)?|ytd|year[- ]to[- ]date|qtd|quarter[- ]to[- ]date|mtd|month[- ]to[- ]date|(?:last|previous|prior|same period last) year|py|running total|cumulative|to date|of (?:the )?total|share|absolute|measure|calculate|create|make|give me|show)\b|%/gi;

// ---------------------------------------------------------------- write

/**
 * Plain English → a DAX measure, rule-based: understands the model's measures, columns and values (via the same
 * vocabulary as `ask`), ratios ("profit per order", "profit margin"), and time intelligence (YTD, QTD, MTD, last
 * year, year-over-year change and %, running totals, share of total). The result is validated by evaluating it.
 */
export function writeDaxSync(model: DataModel, request: string, opts: DaxCopilotOptions = {}): DaxSuggestion {
  const text = request.trim();
  if (!text) throw new Error('Describe the measure first');
  const notes: string[] = [];

  // ratios: "X per Y", "X divided by Y", "ratio of X to Y", "X / Y", "X margin" (X ÷ sales)
  const ratio = /^(?:ratio of\s+)?(.+?)\s+(?:per|divided by|over|\/|to)\s+(.+)$/i.exec(text.replace(PATTERN_WORDS, ' ').replace(/\s+/g, ' ').trim());
  const margin = /^(.+?)\s+margin$/i.exec(text.trim());
  if (ratio || margin) {
    const left = planQuestion(model, ratio ? ratio[1] : margin![1], { synonyms: opts.synonyms });
    const rightQ = ratio ? ratio[2] : (model.measureList().find((m) => /^(total )?(sales|revenue)$/i.test(m.name))?.name ?? 'sales');
    const right = planQuestion(model, rightQ, { synonyms: opts.synonyms });
    const a = left.plan.measures[0];
    let b = right.plan.measures[0];
    // "per order", "per customer": a table or a key column means "count of"
    if (!b && right.plan.groupBy[0]) b = { column: right.plan.groupBy[0], aggregation: 'distinctCount' };
    if (a && b) {
      const x = measureDax(a);
      const y = measureDax(b);
      const filters = [...left.plan.filters, ...right.plan.filters].map(filterDax).filter((f): f is string => !!f);
      let expr = `DIVIDE(${x.dax}, ${y.dax})`;
      if (filters.length) expr = `CALCULATE(${expr}, ${filters.join(', ')})`;
      const name = margin ? `${x.name} Margin` : `${x.name} per ${y.name.replace(/^(Distinct|Count of) /, '')}`;
      return finish(model, expr, name, margin ? '0.0%' : undefined, `${x.name} divided by ${y.name}`, 'rules');
    }
  }

  const pattern = PATTERNS.find((p) => p.re.test(text));
  const rest = pattern ? text.replace(PATTERN_WORDS, ' ').replace(/\s+/g, ' ').trim() : text;
  const { plan, notes: understood } = planQuestion(model, rest || text, { synonyms: opts.synonyms });
  const m = plan.measures[0];
  if (!m) throw new Error(`Couldn't find a measure or numeric column in “${text}”. Name one, e.g. “total sales year to date”.`);
  const base = measureDax(m);
  if (plan.groupBy.length) notes.push(`ignored “by ${plan.groupBy.map((g) => parseRef(g)?.[2] ?? g).join(', ')}” (put fields on a visual to split a measure)`);
  const filters = plan.filters.map(filterDax).filter((f): f is string => !!f);
  let expr = base.dax;
  let name = base.name;
  let format: string | undefined;
  if (pattern) {
    const date = dateColumn(model);
    if (pattern.needsDate && !date) throw new Error('Time intelligence needs a date column (a calendar table with a date column).');
    expr = pattern.build(base.dax, date ?? '');
    name = `${base.name} ${pattern.suffix}`;
    format = pattern.format;
  }
  if (filters.length) {
    expr = expr.startsWith('VAR ') ? `CALCULATE(\n  ${expr.replace(/\n/g, '\n  ')},\n  ${filters.join(', ')}\n)` : `CALCULATE(${expr}, ${filters.join(', ')})`;
    const labels = plan.filters.flatMap((f) => ('value' in f && f.value !== undefined ? [String(f.value)] : 'values' in f && f.values ? f.values.map(String) : []));
    if (labels.length) name += ` (${labels.join(', ')})`;
  }
  const what = [pattern ? pattern.suffix : '', ...understood.map((n) => n.text)].filter(Boolean);
  return finish(model, expr, name, format, [`Understood: ${base.name}${what.length ? `; ${what.join('; ')}` : ''}`, ...notes].join('. '), 'rules');
}

function finish(model: DataModel, expression: string, name: string, format: string | undefined, note: string, source: DaxSuggestion['source']): DaxSuggestion {
  const value = model.evaluate(expression); // throws on syntax and reference errors
  let unique = name;
  for (let i = 2; model.hasMeasure(unique); i++) unique = `${name} ${i}`;
  return { expression, name: unique, ...(format ? { format } : {}), note, value, source };
}

/** Prompt for a language model that writes one measure. */
export function daxPrompt(model: DataModel, request: string): string {
  return [
    'You write DAX measures for a PrismBI data model (DAX as in Power BI).',
    contextToPrompt(getAIContext(model, { examples: 3 })),
    'Reference measures as [Name] and columns as Table[Column]. Prefer DIVIDE for ratios and VAR for repeated parts.',
    'Answer with JSON only: {"expression": "...", "name": "...", "format": "optional format string like 0.0% or $#,0"}',
    `Request: ${request}`,
  ].join('\n\n');
}

function parseJson(text: string): { expression?: string; name?: string; format?: string } {
  const body = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(body) as { expression?: string; name?: string; format?: string };
}

/**
 * Plain English → a validated DAX measure. With `llm`, the model writes it (with one retry that includes the error)
 * and the rules are the fallback; without, {@link writeDaxSync}.
 */
export async function writeDax(model: DataModel, request: string, opts: DaxCopilotOptions = {}): Promise<DaxSuggestion> {
  if (!opts.llm) return writeDaxSync(model, request, opts);
  let prompt = daxPrompt(model, request);
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = parseJson(await opts.llm(prompt));
      if (!out.expression) throw new Error('The answer had no "expression"');
      return finish(model, out.expression.trim(), out.name?.trim() || request.slice(0, 40), out.format || undefined, 'Written by the language model and checked by evaluating it.', 'llm');
    } catch (e) {
      lastError = (e as Error).message;
      prompt = `${daxPrompt(model, request)}\n\nYour previous answer failed: ${lastError}. Fix it.`;
    }
  }
  try {
    const r = writeDaxSync(model, request, opts);
    return { ...r, note: `${r.note}. (The language model's answer failed: ${lastError})` };
  } catch {
    throw new Error(`Couldn't write a valid measure: ${lastError}`);
  }
}

// ---------------------------------------------------------------- explain

const FUNC_PHRASE: Record<string, string> = {
  SUM: 'the sum of',
  AVERAGE: 'the average of',
  MIN: 'the smallest',
  MAX: 'the largest',
  COUNT: 'the count of',
  COUNTA: 'the count of',
  COUNTROWS: 'the number of rows in',
  DISTINCTCOUNT: 'the number of distinct',
  MEDIAN: 'the median of',
};
const ITER_PHRASE: Record<string, string> = { SUMX: 'the sum', AVERAGEX: 'the average', MINX: 'the smallest', MAXX: 'the largest', COUNTX: 'the count', MEDIANX: 'the median' };
const OP_PHRASE: Record<string, string> = { '+': 'plus', '-': 'minus', '*': 'times', '/': 'divided by', '^': 'to the power of', '&': 'joined with', '=': 'is', '==': 'is exactly', '<>': 'is not', '<': 'is below', '>': 'is above', '<=': 'is at most', '>=': 'is at least', '&&': 'and', '||': 'or', IN: 'is one of' };

function phrase(e: Expr): string {
  switch (e.type) {
    case 'number':
      return String(e.value);
    case 'string':
      return `"${e.value}"`;
    case 'boolean':
      return e.value ? 'true' : 'false';
    case 'column':
      return `${e.table}[${e.column}]`;
    case 'bracket':
      return `[${e.name}]`;
    case 'table':
      return e.name;
    case 'varRef':
      return e.name;
    case 'list':
      return `{${e.items.map(phrase).join(', ')}}`;
    case 'unary':
      return e.op === 'NOT' ? `not (${phrase(e.operand)})` : `${e.op === '-' ? 'minus ' : ''}${phrase(e.operand)}`;
    case 'binary': {
      // nested operations of another kind get parentheses: "(A minus B) divided by B"
      const side = (x: Expr) => (x.type === 'binary' && x.op !== e.op && !['&&', '||'].includes(e.op) ? `(${phrase(x)})` : phrase(x));
      return `${side(e.left)} ${OP_PHRASE[e.op] ?? e.op} ${side(e.right)}`;
    }
    case 'var':
      return `${e.bindings.map((b) => `${b.name} = ${phrase(b.value)}`).join('; ')}; result: ${phrase(e.body)}`;
    case 'call':
      return callPhrase(e.name.toUpperCase(), e.args);
  }
}

function filterPhrase(e: Expr): string {
  if (e.type === 'call') {
    const n = e.name.toUpperCase();
    const a = e.args;
    if ((n === 'ALL' || n === 'REMOVEFILTERS') && !a.length) return 'ignoring all filters';
    if (n === 'ALL' || n === 'REMOVEFILTERS') return `ignoring filters on ${a.map(phrase).join(', ')}`;
    if (n === 'ALLSELECTED') return a.length ? `over all selected ${a.map(phrase).join(', ')}` : 'over everything selected on the page (the visual total)';
    if (n === 'ALLEXCEPT') return `ignoring filters on ${phrase(a[0])} except ${a.slice(1).map(phrase).join(', ')}`;
    if (n === 'SAMEPERIODLASTYEAR') return 'for the same period last year';
    if (n === 'DATEADD') return `shifted by ${phrase(a[1])} ${phrase(a[2]).toLowerCase().replace(/"/g, '')}(s)`;
    if (n === 'PARALLELPERIOD') return `for the whole ${phrase(a[2]).toLowerCase()} ${phrase(a[1])} period(s) away`;
    if (n === 'DATESYTD') return 'year to date';
    if (n === 'DATESQTD') return 'quarter to date';
    if (n === 'DATESMTD') return 'month to date';
    if (n === 'DATESINPERIOD') return `for the ${phrase(a[2]).replace(/^minus /, '')} ${String(phrase(a[3])).toLowerCase()}(s) up to ${phrase(a[1])}`;
    if (n === 'USERELATIONSHIP') return `using the relationship between ${phrase(a[0])} and ${phrase(a[1])}`;
    if (n === 'CROSSFILTER') return `with cross-filtering between ${phrase(a[0])} and ${phrase(a[1])} set to ${phrase(a[2])}`;
    if (n === 'KEEPFILTERS') return `${filterPhrase(a[0])} (on top of existing filters)`;
    if (n === 'FILTER') return `keeping rows of ${phrase(a[0])} where ${phrase(a[1])}`;
    if (n === 'VALUES') return `for the current ${phrase(a[0])}`;
  }
  if (e.type === 'binary') return `where ${phrase(e)}`;
  return `filtered by ${phrase(e)}`;
}

const grouped = (x: Expr) => (x.type === 'binary' ? `(${phrase(x)})` : phrase(x));

function callPhrase(n: string, a: Expr[]): string {
  if (FUNC_PHRASE[n]) return `${FUNC_PHRASE[n]} ${a.map(phrase).join(', ')}`;
  if (ITER_PHRASE[n]) return `${ITER_PHRASE[n]} of ${phrase(a[1])} for each row of ${phrase(a[0])}`;
  switch (n) {
    case 'CALCULATE':
      return a.length > 1 ? `${phrase(a[0])}, ${a.slice(1).map(filterPhrase).join(' and ')}` : `${phrase(a[0])} (with row context turned into filters)`;
    case 'CALCULATETABLE':
      return `${phrase(a[0])}, ${a.slice(1).map(filterPhrase).join(' and ')}`;
    case 'DIVIDE':
      return `${grouped(a[0])} divided by ${grouped(a[1])} (${a[2] ? `${phrase(a[2])}` : 'blank'} when that is zero)`;
    case 'TOTALYTD':
    case 'TOTALQTD':
    case 'TOTALMTD':
      return `${phrase(a[0])} ${({ TOTALYTD: 'year', TOTALQTD: 'quarter', TOTALMTD: 'month' } as Record<string, string>)[n]} to date`;
    case 'IF':
      return `if ${phrase(a[0])} then ${phrase(a[1])}${a[2] ? `, otherwise ${phrase(a[2])}` : ''}`;
    case 'SWITCH':
      return `${phrase(a[0])} matched against ${Math.floor((a.length - 1) / 2)} case(s)`;
    case 'BLANK':
      return 'blank';
    case 'COALESCE':
      return `the first non-blank of ${a.map(phrase).join(', ')}`;
    case 'RANKX':
      return `the rank of ${phrase(a[1])} among ${phrase(a[0])}`;
    case 'SELECTEDVALUE':
      return `the selected ${phrase(a[0])}${a[1] ? ` (or ${phrase(a[1])})` : ''}`;
    case 'HASONEVALUE':
      return `whether exactly one ${phrase(a[0])} is in context`;
    case 'ISBLANK':
      return `${phrase(a[0])} is blank`;
    case 'RELATED':
      return `the related ${phrase(a[0])}`;
    default:
      return `${n}(${a.map(phrase).join(', ')})`;
  }
}

/** DAX → a plain-English explanation, including the measures it uses (one level deep). */
export function explainDax(model: DataModel, expression: string): string {
  const ast = parseDax(expression);
  const used = new Set<string>();
  const walk = (e: Expr) => {
    if (e.type === 'bracket' && model.hasMeasure(e.name)) used.add(e.name);
    for (const v of Object.values(e)) {
      if (Array.isArray(v)) v.forEach((x) => x && typeof x === 'object' && ('type' in x ? walk(x as Expr) : 'value' in x && walk((x as { value: Expr }).value)));
      else if (v && typeof v === 'object' && 'type' in v) walk(v as Expr);
    }
  };
  walk(ast);
  const lines = [`Calculates ${phrase(ast)}.`];
  for (const name of used) lines.push(`[${name}] is ${phrase(parseDax(model.measure(name).expression))}.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- studio

/** A Studio `copilot` (StudioOptions.copilot or `studio.setCopilot`) backed by {@link writeDax} and {@link explainDax}. */
export function daxCopilot(model: DataModel, opts: DaxCopilotOptions = {}) {
  return {
    write: async (request: string) => {
      const r = await writeDax(model, request, opts);
      return { expression: r.expression, name: r.name, format: r.format, note: r.note };
    },
    explain: (expression: string) => explainDax(model, expression),
  };
}
