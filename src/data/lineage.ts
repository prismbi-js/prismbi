import { tokenize } from '../dax/parser';
import type { DataModel } from './model';
import type { ReportDefinition } from '../report/report';
import type { FieldSpec } from './query';

/** A model object something depends on, or that depends on something. */
export type LineageRef = { kind: 'measure'; name: string } | { kind: 'column'; table: string; name: string } | { kind: 'table'; name: string };

export interface LineageNode {
  id: string;
  kind: 'measure' | 'column' | 'table' | 'visual';
  label: string;
  /** For visuals: their page. */
  page?: { id: string; name: string };
}

export interface Lineage {
  nodes: LineageNode[];
  /** `[dependent, dependency]` pairs: "a uses b". */
  edges: [string, string][];
}

const lower = (s: string) => s.toLowerCase();
export const refId = (r: LineageRef) => (r.kind === 'measure' ? `measure:${r.name}` : r.kind === 'column' ? `column:${r.table}[${r.name}]` : `table:${r.name}`);

/** Fields a DAX expression refers to (measures, columns and tables), resolved against the model. */
export function expressionRefs(model: DataModel, expression: string, homeTable?: string): LineageRef[] {
  let toks: ReturnType<typeof tokenize>;
  try {
    toks = tokenize(expression);
  } catch {
    return [];
  }
  const tables = new Map(model.tableNames().map((t) => [lower(t), t]));
  const out = new Map<string, LineageRef>();
  const add = (r: LineageRef) => out.set(refId(r), r);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const next = toks[i + 1];
    if ((t.type === 'ident' || t.type === 'qtable') && tables.has(lower(t.value))) {
      const table = tables.get(lower(t.value))!;
      if (next?.type === 'bracket') {
        // Table[X]: a column, or a measure written with its home table
        if (model.table(table).hasColumn(next.value)) add({ kind: 'column', table, name: next.value });
        else if (model.hasMeasure(next.value)) add({ kind: 'measure', name: next.value });
        i++;
      } else if (next?.type !== 'lparen') add({ kind: 'table', name: table });
      continue;
    }
    if (t.type === 'bracket') {
      if (model.hasMeasure(t.value)) add({ kind: 'measure', name: t.value });
      else if (homeTable && model.hasTable(homeTable) && model.table(homeTable).hasColumn(t.value)) add({ kind: 'column', table: homeTable, name: t.value });
    }
  }
  return [...out.values()];
}

/** Model and report fields a visual field spec refers to. */
function fieldRefs(model: DataModel, f: FieldSpec): LineageRef[] {
  const s = typeof f === 'string' ? f : (f.field ?? f.expression ?? '');
  if (typeof f === 'object' && f.expression) return expressionRefs(model, f.expression);
  if (typeof f === 'object' && f.visualCalc) return [];
  const m = /^'?(.*?)'?\[(.*)\]$/.exec(s);
  if (m) {
    const table = m[1].replace(/''/g, "'");
    return model.hasTable(table) ? [{ kind: 'column', table, name: m[2] }] : [];
  }
  const name = s.replace(/^\[|\]$/g, '');
  return model.hasMeasure(name) ? [{ kind: 'measure', name }] : [];
}

/** The dependency graph of a model (and optionally a report's visuals). */
export function lineage(model: DataModel, report?: ReportDefinition): Lineage {
  const nodes = new Map<string, LineageNode>();
  const edges: [string, string][] = [];
  const node = (r: LineageRef) => {
    const id = refId(r);
    if (!nodes.has(id)) nodes.set(id, { id, kind: r.kind, label: r.kind === 'column' ? `${r.table}[${r.name}]` : r.kind === 'measure' ? `[${r.name}]` : r.name });
    return id;
  };
  for (const t of model.tableNames()) {
    node({ kind: 'table', name: t });
    for (const c of model.table(t).columns.values()) {
      const id = node({ kind: 'column', table: t, name: c.name });
      edges.push([id, `table:${t}`]);
      if (c.expression) for (const r of expressionRefs(model, c.expression, t)) if (refId(r) !== id) edges.push([id, node(r)]);
    }
  }
  for (const m of model.measureList()) {
    const id = node({ kind: 'measure', name: m.name });
    for (const r of expressionRefs(model, m.expression, m.table)) if (refId(r) !== id) edges.push([id, node(r)]);
  }
  for (const p of report?.pages ?? []) {
    for (const v of p.visuals) {
      const id = `visual:${p.id ?? p.name}/${v.id}`;
      nodes.set(id, { id, kind: 'visual', label: v.title ?? v.type, page: { id: p.id ?? p.name, name: p.name } });
      for (const f of Object.values(v.fields ?? {}).flat() as FieldSpec[]) for (const r of fieldRefs(model, f)) edges.push([id, node(r)]);
    }
  }
  return { nodes: [...nodes.values()], edges };
}

export interface Impact {
  measures: string[];
  columns: string[];
  visuals: { pageId: string; pageName: string; visualId: string; title: string }[];
}

/** Everything that depends on `target` (directly or through other measures and columns). */
export function impactOf(model: DataModel, target: LineageRef, report?: ReportDefinition): Impact {
  const g = lineage(model, report);
  const dependents = new Map<string, string[]>();
  for (const [a, b] of g.edges) {
    const list = dependents.get(b);
    if (list) list.push(a);
    else dependents.set(b, [a]);
  }
  const seen = new Set<string>();
  const queue = [refId(target)];
  // a table's columns count as the table
  if (target.kind === 'table') for (const n of g.nodes) if (n.id.startsWith(`column:${target.name}[`)) queue.push(n.id);
  while (queue.length) {
    const id = queue.shift()!;
    for (const d of dependents.get(id) ?? []) {
      if (seen.has(d)) continue;
      seen.add(d);
      queue.push(d);
    }
  }
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const impact: Impact = { measures: [], columns: [], visuals: [] };
  for (const id of seen) {
    const n = byId.get(id)!;
    if (n.kind === 'measure') impact.measures.push(id.slice('measure:'.length));
    else if (n.kind === 'column' && !(target.kind === 'table' && id.startsWith(`column:${target.name}[`))) impact.columns.push(id.slice('column:'.length));
    else if (n.kind === 'visual') impact.visuals.push({ pageId: n.page!.id, pageName: n.page!.name, visualId: id.slice(id.indexOf('/') + 1), title: n.label });
  }
  return impact;
}

const quoteTable = (t: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t) ? t : `'${t.replace(/'/g, "''")}'`);

/**
 * Rewrite references in a DAX expression: a renamed measure (`[Old]` → `[New]`) or a renamed column
 * (`Table[Old]` → `Table[New]`, and unqualified `[Old]` in its own table's calculated columns). Text inside
 * strings and comments is never touched.
 */
export function renameInExpression(expression: string, target: LineageRef, newName: string, model: DataModel, homeTable?: string): string {
  let toks: ReturnType<typeof tokenize>;
  try {
    toks = tokenize(expression);
  } catch {
    return expression;
  }
  const edits: [number, number, string][] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const prev = toks[i - 1];
    if (t.type !== 'bracket' || t.value !== target.name) continue;
    const qualified = prev && (prev.type === 'ident' || prev.type === 'qtable') && model.hasTable(prev.value);
    if (target.kind === 'measure') {
      // Table[Old] stays a column when that table has such a column
      if (qualified && model.table(prev.value).hasColumn(t.value)) continue;
      edits.push([t.pos, t.end, `[${newName}]`]);
    } else if (target.kind === 'column') {
      if (qualified ? lower(prev.value) === lower(target.table) : homeTable === target.table && !model.hasMeasure(t.value)) edits.push([t.pos, t.end, `[${newName}]`]);
    }
  }
  let out = expression;
  for (const [a, b, s] of edits.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + s + out.slice(b);
  return out;
}

/** A field spec with a renamed measure or column swapped in. */
function renameField(f: FieldSpec, target: LineageRef, newName: string, model: DataModel): FieldSpec {
  const oldRef = target.kind === 'column' ? `${target.table}[${target.name}]` : target.name;
  const newRef = target.kind === 'column' ? `${quoteTable(target.table)}[${newName}]` : newName;
  const same = (s: string) => (target.kind === 'column' ? s.replace(/^'(.*)'(\[)/, '$1$2').replace(/''/g, "'") === oldRef : s.replace(/^\[|\]$/g, '') === oldRef);
  if (typeof f === 'string') return same(f) ? newRef : f;
  const out = { ...f };
  if (out.field && same(out.field)) out.field = newRef;
  if (out.expression) out.expression = renameInExpression(out.expression, target, newName, model);
  if (out.visualCalc && target.kind === 'measure') out.visualCalc = renameInExpression(out.visualCalc, target, newName, model);
  return out;
}

export interface RenameResult {
  /** The report with visual fields and filters updated (when one was given). */
  report?: ReportDefinition;
  /** Measures whose DAX was rewritten. */
  measures: string[];
  /** Calculated columns whose DAX was rewritten. */
  columns: string[];
}

/**
 * Rename a measure or a column and update everything that refers to it: other measures, calculated columns and
 * (when given) the report's visual fields and filters.
 */
export function renameModelField(model: DataModel, target: LineageRef, newName: string, report?: ReportDefinition): RenameResult {
  if (target.kind === 'table') throw new Error('Renaming tables is not supported yet');
  if (!newName.trim() || newName === target.name) return { report, measures: [], columns: [] };
  const result: RenameResult = { measures: [], columns: [] };
  if (target.kind === 'measure') {
    if (!model.hasMeasure(target.name)) throw new Error(`Measure "${target.name}" not found`);
    if (model.hasMeasure(newName)) throw new Error(`A measure named "${newName}" already exists`);
  } else {
    if (!model.hasTable(target.table) || !model.table(target.table).hasColumn(target.name)) throw new Error(`Column ${target.table}[${target.name}] not found`);
    if (model.table(target.table).hasColumn(newName)) throw new Error(`${target.table} already has a column "${newName}"`);
  }
  // the object itself (DAX of dependents is computed against the old names, before anything moves)
  const measureEdits = model
    .measureList()
    .map((m) => ({ m, expr: renameInExpression(m.expression, target, newName, model, m.table) }))
    .filter((x) => x.expr !== x.m.expression);
  const columnEdits: { table: string; name: string; expr: string }[] = [];
  for (const t of model.tableNames())
    for (const c of model.table(t).columns.values())
      if (c.expression) {
        const expr = renameInExpression(c.expression, target, newName, model, t);
        if (expr !== c.expression) columnEdits.push({ table: t, name: c.name, expr });
      }
  if (target.kind === 'measure') {
    const { ast: _a, ...def } = model.measure(target.name);
    model.removeMeasure(target.name);
    model.addMeasure({ ...def, name: newName });
  } else model.renameColumn(target.table, target.name, newName);
  for (const { m, expr } of measureEdits) {
    const name = m.name === target.name && target.kind === 'measure' ? newName : m.name;
    const { ast: _a, ...def } = model.measure(name);
    model.addMeasure({ ...def, expression: expr });
    result.measures.push(name);
  }
  for (const c of columnEdits) {
    const name = target.kind === 'column' && c.table === target.table && c.name === target.name ? newName : c.name;
    const col = model.table(c.table).column(name);
    model.removeColumn(c.table, name);
    model.addCalculatedColumn(c.table, name, c.expr, { format: col.format, type: col.type, hidden: col.hidden, folder: col.folder, description: col.description });
    result.columns.push(`${c.table}[${name}]`);
  }
  if (report) {
    const filterTarget = (x: unknown) => (typeof x === 'string' ? renameField(x, target, newName, model) : x);
    result.report = {
      ...report,
      ...(report.filters ? { filters: report.filters.map((f) => ('target' in f ? { ...f, target: filterTarget(f.target) } : f)) as never } : {}),
      pages: report.pages.map((p) => ({
        ...p,
        ...(p.filters ? { filters: p.filters.map((f) => ('target' in f ? { ...f, target: filterTarget(f.target) } : f)) as never } : {}),
        visuals: p.visuals.map((v) => ({
          ...v,
          fields: Object.fromEntries(Object.entries(v.fields ?? {}).map(([role, f]) => [role, Array.isArray(f) ? f.map((x) => renameField(x, target, newName, model)) : renameField(f as FieldSpec, target, newName, model)])) as never,
          ...(v.filters ? { filters: v.filters.map((f) => ('target' in f ? { ...f, target: filterTarget(f.target) } : f)) as never } : {}),
        })),
      })),
    };
  }
  return result;
}
