import { formatValue } from 'prismbi';
import type { CellValue, DataModel, FieldSpec, FilterSpec, QuerySpec, Report, VisualSpec } from 'prismbi';
import { askSync, ask, type AskOptions } from './ask';
import { explain } from './explain';
import { findInsights } from './insights';

// ---------------------------------------------------------------- context

export interface AIColumn {
  name: string;
  type: string;
  format?: string;
  description?: string;
  /** Number of distinct values. */
  distinct: number;
  /** A few example values (text and dates; numbers show min/max instead). */
  examples?: CellValue[];
  min?: CellValue;
  max?: CellValue;
  /** DAX of a calculated column. */
  expression?: string;
}

export interface AIContext {
  model: {
    tables: { name: string; rows: number; columns: AIColumn[] }[];
    relationships: { from: string; to: string; active: boolean; crossFilter?: string; cardinality?: string }[];
    measures: { name: string; expression?: string; format?: string; description?: string; folder?: string }[];
  };
  /** Live report state, when a report is attached. */
  report?: {
    name: string;
    currentPage: { id: string; name: string };
    pages: { id: string; name: string; hidden: boolean }[];
    visuals: { id: string; type: string; title?: string; fields: VisualSpec['fields']; filters?: FilterSpec[] }[];
    reportFilters: FilterSpec[];
    pageFilters: FilterSpec[];
    slicers: Record<string, FilterSpec[]>;
    selection: { visualId: string; values: { column: string; value: CellValue }[][] } | null;
  };
}

export interface ContextOptions {
  report?: Report;
  /** Example values per column (default 5, 0 to omit). */
  examples?: number;
  /** Include measure and calculated-column DAX (default true). */
  expressions?: boolean;
  /** Leave out hidden columns and measures (default true). */
  skipHidden?: boolean;
}

const ref = (t: string, c: string) => `${/^[A-Za-z_][A-Za-z0-9_]*$/.test(t) ? t : `'${t}'`}[${c}]`;

/**
 * A serialisable description of the model (and the report's live state) for language models and agent
 * frameworks: schema, measures with their DAX, relationships, example values, current page, filters and selection.
 */
export function getAIContext(model: DataModel, opts: ContextOptions = {}): AIContext {
  const nEx = opts.examples ?? 5;
  const withExpr = opts.expressions ?? true;
  const skipHidden = opts.skipHidden ?? true;
  const tables = model.tableNames().map((name) => {
    const t = model.table(name);
    const columns: AIColumn[] = [];
    for (const c of t.columns.values()) {
      if (skipHidden && c.hidden) continue;
      const distinct = t.distinct(c.name);
      const col: AIColumn = { name: c.name, type: c.type, distinct: distinct.length };
      if (c.format) col.format = c.format;
      if (c.description) col.description = c.description;
      if (withExpr && c.expression) col.expression = c.expression;
      const nonBlank = distinct.filter((v) => v !== null);
      if (c.type === 'number' || c.type === 'date') {
        if (nonBlank.length) {
          col.min = nonBlank[0];
          col.max = nonBlank[nonBlank.length - 1];
        }
      } else if (nEx > 0) col.examples = nonBlank.slice(0, nEx);
      columns.push(col);
    }
    return { name, rows: t.rowCount, columns };
  });
  const relationships = model.relationships().map((r) => ({ from: ref(r.fromTable, r.fromColumn), to: ref(r.toTable, r.toColumn), active: r.active, crossFilter: r.crossFilter, cardinality: r.cardinality }));
  const measures = model
    .measureList()
    .filter((m) => !(skipHidden && (m as { hidden?: boolean }).hidden))
    .map((m) => ({ name: m.name, ...(withExpr ? { expression: m.expression } : {}), ...(m.format ? { format: m.format } : {}), ...(m.description ? { description: m.description } : {}), ...(m.folder ? { folder: m.folder } : {}) }));
  const ctx: AIContext = { model: { tables, relationships, measures } };
  const r = opts.report;
  if (r) {
    const page = r.pageDefinition();
    const slicers: Record<string, FilterSpec[]> = {};
    for (const id of r.visualIds()) {
      const f = r.slicerFilter(id);
      if (f?.length) slicers[id] = f;
    }
    const sel = r.currentSelection;
    ctx.report = {
      name: r.name,
      currentPage: r.currentPage,
      pages: r.pageList,
      visuals: page.visuals.map((v) => ({ id: v.id!, type: v.type, title: v.title, fields: v.fields, ...(v.filters?.length ? { filters: v.filters } : {}) })),
      reportFilters: r.reportFilterList,
      pageFilters: page.filters ?? [],
      slicers,
      selection: sel ? { visualId: sel.visualId, values: sel.identities.map((id) => id.columns.map((c, i) => ({ column: ref(c.table, c.column), value: id.values[i] }))) } : null,
    };
  }
  return ctx;
}

const fmtVal = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : JSON.stringify(v));

/** Compact text form of {@link getAIContext} for a system prompt. */
export function contextToPrompt(ctx: AIContext): string {
  const lines: string[] = ['# Data model', ''];
  for (const t of ctx.model.tables) {
    lines.push(`## ${t.name} (${t.rows.toLocaleString('en-US')} rows)`);
    for (const c of t.columns) {
      const extra = [c.format && `format ${c.format}`, c.examples?.length && `e.g. ${c.examples.map(fmtVal).join(', ')}`, c.min !== undefined && `${fmtVal(c.min)} … ${fmtVal(c.max)}`, c.expression && `= ${c.expression}`, c.description].filter(Boolean);
      lines.push(`- ${ref(t.name, c.name)}: ${c.type}, ${c.distinct} distinct${extra.length ? `; ${extra.join('; ')}` : ''}`);
    }
    lines.push('');
  }
  if (ctx.model.relationships.length) {
    lines.push('## Relationships');
    for (const r of ctx.model.relationships) lines.push(`- ${r.from} → ${r.to}${r.active ? '' : ' (inactive)'}${r.crossFilter === 'both' ? ' (both directions)' : ''}${r.cardinality === 'manyToMany' ? ' (many-to-many)' : ''}`);
    lines.push('');
  }
  if (ctx.model.measures.length) {
    lines.push('## Measures');
    for (const m of ctx.model.measures) lines.push(`- [${m.name}]${m.expression ? ` = ${m.expression}` : ''}${m.format ? ` (format ${m.format})` : ''}${m.description ? ` — ${m.description}` : ''}`);
    lines.push('');
  }
  const r = ctx.report;
  if (r) {
    lines.push('# Report state', '', `Report "${r.name}", page "${r.currentPage.name}" (${r.pages.map((p) => p.name).join(', ')}).`);
    lines.push('Visuals on this page:');
    for (const v of r.visuals) lines.push(`- ${v.id}: ${v.type}${v.title ? ` "${v.title}"` : ''} ${JSON.stringify(v.fields)}`);
    const filters = [...r.reportFilters, ...r.pageFilters, ...Object.values(r.slicers).flat()];
    lines.push(`Active filters: ${filters.length ? JSON.stringify(filters) : 'none'}.`);
    if (r.selection) lines.push(`Selected in ${r.selection.visualId}: ${JSON.stringify(r.selection.values)}.`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- tools

/** A provider-agnostic tool: JSON-schema input and an async implementation. */
export interface AgentTool<I = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  run(input: I): Promise<unknown>;
}

export interface AgentToolOptions {
  model: DataModel;
  /** Attach a report to read its state and let the agent add visuals, filter and navigate. */
  report?: Report;
  /** Allow tools that change the model or report (default true when a report is attached). */
  allowWrites?: boolean;
  /** Rows returned by queries (default 200). */
  maxRows?: number;
  ask?: AskOptions;
}

const FILTER_SCHEMA = {
  type: 'array',
  description: 'Filters, e.g. {"target":"Date[Year]","op":"eq","value":2025} or {"target":"Product[Category]","op":"in","values":["Bikes"]} or {"target":"Date[Date]","op":"between","min":"2025-01-01","max":"2025-03-31"}',
  items: { type: 'object' },
};
const FIELD_SCHEMA = { description: 'Measure name, or {"field":"Table[Column]","aggregation":"sum|avg|min|max|count|distinctCount"}' };

/** Dates arrive as strings from language models: revive ISO dates in filters. */
function reviveFilters(filters: unknown): FilterSpec[] {
  if (!Array.isArray(filters)) return [];
  return filters.map((f) => {
    const out = { ...(f as Record<string, unknown>) };
    for (const k of ['value', 'min', 'max']) if (typeof out[k] === 'string' && /^\d{4}-\d{2}-\d{2}(T|$)/.test(out[k] as string)) out[k] = new Date(out[k] as string);
    if (Array.isArray(out.values)) out.values = (out.values as unknown[]).map((v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v) : v));
    return out as unknown as FilterSpec;
  });
}

const plainValue = (v: CellValue) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);

/**
 * Tools an AI agent can call to explore and drive PrismBI: describe the model, list values, run queries, evaluate
 * DAX, ask questions, explain values, find insights, and (with a report) read state, add visuals, filter and
 * navigate. Convert with {@link toAnthropicTools}, {@link toOpenAITools} or {@link toMcpTools}.
 */
export function createAgentTools(opts: AgentToolOptions): AgentTool[] {
  const { model, report } = opts;
  const maxRows = opts.maxRows ?? 200;
  const writes = opts.allowWrites ?? !!report;
  const tools: AgentTool[] = [
    {
      name: 'describe_model',
      description: 'Describe the data model: tables, columns (type, distinct count, examples), relationships and measures with their DAX. Call this first.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => getAIContext(model, { examples: 5 }).model,
    },
    {
      name: 'list_values',
      description: 'Distinct values of a column, optionally containing some text. Use it to find exact filter values.',
      inputSchema: { type: 'object', properties: { column: { type: 'string', description: 'Table[Column]' }, search: { type: 'string' }, limit: { type: 'number' } }, required: ['column'] },
      run: async (i) => {
        const m = /^'?(.*?)'?\[(.*)\]$/.exec(String(i.column));
        if (!m || !model.hasTable(m[1]) || !model.table(m[1]).hasColumn(m[2])) throw new Error(`Unknown column ${String(i.column)}`);
        const s = typeof i.search === 'string' ? i.search.toLowerCase() : '';
        const all = model.table(m[1]).distinct(m[2]).filter((v) => !s || String(v).toLowerCase().includes(s));
        return { total: all.length, values: all.slice(0, Number(i.limit) || 50).map(plainValue) };
      },
    },
    {
      name: 'run_query',
      description: 'Group and aggregate: returns rows of group keys and measure values (formatted and raw), plus totals.',
      inputSchema: {
        type: 'object',
        properties: {
          groupBy: { type: 'array', items: { type: 'string' }, description: 'Table[Column] list' },
          values: { type: 'array', items: FIELD_SCHEMA, description: 'Measures or aggregated columns' },
          filters: FILTER_SCHEMA,
          orderBy: { type: 'string', description: 'Measure or column to sort by' },
          direction: { type: 'string', enum: ['asc', 'desc'] },
          top: { type: 'number' },
        },
        required: ['values'],
      },
      run: async (i) => {
        const values = (i.values as FieldSpec[]) ?? [];
        const spec: QuerySpec = { groupBy: (i.groupBy as string[]) ?? [], values, filters: reviveFilters(i.filters), totals: true, ...(i.top ? { top: Number(i.top) } : {}) };
        if (i.orderBy) spec.orderBy = [{ field: String(i.orderBy), direction: i.direction === 'asc' ? 'asc' : 'desc' }];
        const r = model.query(spec);
        const fmt = (v: CellValue, k: number) => formatValue(v, r.values[k]?.format);
        return {
          columns: [...r.groups.map((g) => g.name), ...r.values.map((v) => v.name)],
          rows: r.rows.slice(0, maxRows).map((row) => [...row.keys.map(plainValue), ...row.values.map((v, k) => ({ value: plainValue(v), text: fmt(v, k) }))]),
          totals: r.totals?.map((v, k) => ({ value: plainValue(v), text: fmt(v, k) })),
          rowCount: r.rows.length,
          truncated: r.rows.length > maxRows,
        };
      },
    },
    {
      name: 'evaluate_dax',
      description: 'Evaluate a DAX scalar expression (e.g. "[Total Sales] / [Orders]") or, when it starts with EVALUATE, a table expression.',
      inputSchema: { type: 'object', properties: { expression: { type: 'string' }, filters: FILTER_SCHEMA }, required: ['expression'] },
      run: async (i) => {
        const expr = String(i.expression).trim();
        const filters = reviveFilters(i.filters);
        if (/^evaluate\s/i.test(expr)) {
          const t = model.evaluateTable(expr.replace(/^evaluate\s+/i, ''), filters);
          return { columns: t.columns, rows: t.rows.slice(0, maxRows).map((r) => r.map(plainValue)), rowCount: t.rows.length };
        }
        return { value: plainValue(model.evaluate(expr, filters)) };
      },
    },
    {
      name: 'ask',
      description: 'Turn a plain-language question into a visual spec (and see how it was understood). Combine with add_visual to show it.',
      inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
      run: async (i) => (opts.ask?.llm ? ask(model, String(i.question), opts.ask) : askSync(model, String(i.question), opts.ask)),
    },
    {
      name: 'explain_value',
      description: 'Explain a measure value under filters: change versus the previous period with the biggest contributors, or its composition.',
      inputSchema: { type: 'object', properties: { measure: FIELD_SCHEMA, filters: FILTER_SCHEMA }, required: ['measure'] },
      run: async (i) => explain(model, { measure: i.measure as FieldSpec, filters: reviveFilters(i.filters) }),
    },
    {
      name: 'find_insights',
      description: 'Automatic insights for a measure: anomalies, trends, biggest movers, concentration and outliers.',
      inputSchema: { type: 'object', properties: { measure: FIELD_SCHEMA, filters: FILTER_SCHEMA, max: { type: 'number' } }, required: ['measure'] },
      run: async (i) => findInsights(model, { measure: i.measure as FieldSpec, filters: reviveFilters(i.filters), max: Number(i.max) || 8 }),
    },
  ];
  if (report) {
    tools.push({
      name: 'get_report_state',
      description: 'Current page, pages, visuals on the page with their fields, active filters, slicer selections and the cross-filter selection.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => getAIContext(model, { report, examples: 0 }).report,
    });
    tools.push({
      name: 'go_to_page',
      description: 'Show a report page by id or name.',
      inputSchema: { type: 'object', properties: { page: { type: 'string' } }, required: ['page'] },
      run: async (i) => {
        report.goToPage(String(i.page));
        return report.currentPage;
      },
    });
  }
  if (report && writes) {
    tools.push({
      name: 'add_visual',
      description: 'Add a visual to the current page. Pass a spec from the ask tool, or {type, title, fields, filters}. It is placed in the first free spot.',
      inputSchema: { type: 'object', properties: { spec: { type: 'object' }, width: { type: 'number', description: 'grid columns (default 6)' }, height: { type: 'number', description: 'grid rows (default 7)' } }, required: ['spec'] },
      run: async (i) => {
        const spec = i.spec as VisualSpec;
        const w = Number(i.width) || 6;
        const h = Number(i.height) || 7;
        const at = report.findFreeSpot(w, h);
        const id = report.addVisual({ ...spec, filters: reviveFilters(spec.filters), layout: { x: at.x, y: at.y, w, h } });
        return { id, layout: { ...at, w, h } };
      },
    });
    tools.push({
      name: 'remove_visual',
      description: 'Remove a visual by id.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: async (i) => (report.removeVisual(String(i.id)), { removed: i.id }),
    });
    tools.push({
      name: 'set_filters',
      description: 'Replace report-level or current-page filters (empty list clears them).',
      inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['report', 'page'] }, filters: FILTER_SCHEMA }, required: ['filters'] },
      run: async (i) => {
        const f = reviveFilters(i.filters);
        if (i.scope === 'page') report.setPageFilters(report.currentPage.id, f);
        else report.setReportFilters(f);
        return { scope: i.scope ?? 'report', filters: f.length };
      },
    });
  }
  if (writes) {
    tools.push({
      name: 'create_measure',
      description: 'Add a DAX measure to the model (validated by evaluating it once).',
      inputSchema: { type: 'object', properties: { name: { type: 'string' }, expression: { type: 'string' }, format: { type: 'string' }, description: { type: 'string' } }, required: ['name', 'expression'] },
      run: async (i) => {
        const name = String(i.name);
        if (model.hasMeasure(name)) throw new Error(`Measure "${name}" already exists`);
        model.evaluate(String(i.expression)); // throws on syntax or reference errors
        model.addMeasure(name, String(i.expression), { ...(i.format ? { format: String(i.format) } : {}), ...(i.description ? { description: String(i.description) } : {}) });
        return { created: name, value: plainValue(model.evaluate(`[${name}]`)) };
      },
    });
  }
  return tools;
}

/** Run a tool by name; errors come back as `{ error }` so an agent can recover. */
export async function runTool(tools: AgentTool[], name: string, input: unknown): Promise<unknown> {
  const t = tools.find((x) => x.name === name);
  if (!t) return { error: `Unknown tool "${name}"` };
  try {
    return await t.run((input ?? {}) as Record<string, unknown>);
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Anthropic Messages API `tools` format. */
export const toAnthropicTools = (tools: AgentTool[]) => tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));

/** OpenAI-style function tools. */
export const toOpenAITools = (tools: AgentTool[]) => tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.inputSchema } }));

/** Model Context Protocol tool listing (`tools/list`); answer `tools/call` with {@link runTool}. */
export const toMcpTools = (tools: AgentTool[]) => tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
