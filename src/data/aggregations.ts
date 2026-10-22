import type { Expr } from '../dax/ast';
import type { ColumnRef } from './types';
import type { DataModel } from './model';
import type { Filter, FilterSpec } from './filters';
import type { FieldSpec, QuerySpec } from './query';

/**
 * A pre-aggregated table standing in for a detail table (Power BI's "manage aggregations"). Queries whose columns
 * and aggregations it covers are answered from it; everything else goes to the detail table.
 */
export interface AggregationDef {
  /** The aggregation table, already in the model, related to the dimensions it covers like the detail table. */
  table: string;
  /** The detail (fact) table it summarizes; it may be empty locally when an SQL engine holds the rows. */
  detail: string;
  /** Detail columns the aggregation is grouped by → its column holding them (e.g. a date or product key). */
  groupBy?: Record<string, string>;
  /** Detail columns → the aggregation columns summarizing them. `count` is the number of non-blank values. */
  columns?: Record<string, { sum?: string; min?: string; max?: string; count?: string }>;
  /** The aggregation column holding each group's detail row count (for COUNTROWS). */
  rows?: string;
  /** When several cover a query, the higher precedence wins (then the smaller table). */
  precedence?: number;
}

type Call = Expr & { type: 'call' };

/** Value fields the rewrite builds, with their expressions already parsed (resolveValueField reads them). */
export const parsedValues = new WeakMap<object, Expr>();

/** A query rewritten to read an aggregation table, or null when no aggregation covers it. */
export function aggregationRewrite(model: DataModel, spec: QuerySpec, aggs: readonly AggregationDef[], resolve: Resolve): { spec: QuerySpec; table: string } | null {
  // row-level security filters the detail table, which an aggregation can't reproduce; calculation-group tables are
  // disconnected, so a query using one is never covered
  if (!aggs.length || model.activeRoleNames.length) return null;
  const ordered = [...aggs].sort((a, b) => (b.precedence ?? 0) - (a.precedence ?? 0) || model.table(a.table).rowCount - model.table(b.table).rowCount);
  for (const agg of ordered) {
    const out = rewriteFor(model, spec, agg, resolve);
    if (out) return { spec: out, table: agg.table };
  }
  return null;
}

/** A value field as an expression with its display name and format (query.ts's resolveValueField). */
type Resolve = (model: DataModel, f: FieldSpec) => { ast: Expr; name: string; format?: string };

function rewriteFor(model: DataModel, spec: QuerySpec, agg: AggregationDef, resolve: Resolve): QuerySpec | null {
  const reach = model.expanded(agg.table);
  let usesDetail = false;
  /** A column reference as seen from the aggregation table, or null when it isn't covered. */
  const column = (c: ColumnRef): ColumnRef | null => {
    if (c.table === agg.detail) {
      const mapped = agg.groupBy?.[c.column];
      if (!mapped) return null;
      usesDetail = true;
      return { table: agg.table, column: mapped };
    }
    return c.table === agg.table || reach.has(c.table) ? c : null;
  };
  const ref = (s: string | ColumnRef): string | null => {
    const m = typeof s === 'string' ? /^'?(.*?)'?\[([^\]]+)\]$/.exec(s) : null;
    const c = typeof s === 'string' ? (m ? { table: m[1], column: m[2] } : null) : s;
    const r = c && column(c);
    return r ? `'${r.table.replace(/'/g, "''")}'[${r.column}]` : null;
  };
  const aggCol = (column: string): Expr => ({ type: 'column', table: agg.table, column });
  const seen = new Set<string>();
  const expr = (e: Expr): Expr | null => {
    switch (e.type) {
      case 'column': {
        const c = column(e);
        return c ? { type: 'column', table: c.table, column: c.column } : null;
      }
      case 'table':
        // the detail table itself (iterators, FILTER, ALL(detail)…) isn't covered; other names pass (MONTH, YEAR)
        return e.name === agg.detail ? null : e;
      case 'bracket': {
        if (!model.hasMeasure(e.name) || seen.has(e.name)) return null;
        seen.add(e.name);
        const r = expr(model.measure(e.name).ast);
        seen.delete(e.name);
        return r;
      }
      case 'call':
        return call(e);
      case 'unary': {
        const o = expr(e.operand);
        return o && { ...e, operand: o };
      }
      case 'binary': {
        const l = expr(e.left);
        const r = l && expr(e.right);
        return r && { ...e, left: l!, right: r };
      }
      case 'list': {
        const items = e.items.map(expr);
        return items.every(Boolean) ? { ...e, items: items as Expr[] } : null;
      }
      case 'var': {
        const bindings = e.bindings.map((b) => ({ name: b.name, value: expr(b.value) }));
        const body = expr(e.body);
        return body && bindings.every((b) => b.value) ? { ...e, bindings: bindings as { name: string; value: Expr }[], body } : null;
      }
      default:
        return e;
    }
  };
  const call = (e: Call): Expr | null => {
    const name = e.name.toUpperCase();
    const a = e.args[0];
    if (name === 'COUNTROWS' && a?.type === 'table' && a.name === agg.detail) {
      if (!agg.rows) return null;
      usesDetail = true;
      return { type: 'call', name: 'SUM', args: [aggCol(agg.rows)] };
    }
    if (e.args.length === 1 && a?.type === 'column' && a.table === agg.detail && ['SUM', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'AVERAGE', 'DISTINCTCOUNT'].includes(name)) {
      const grouped = agg.groupBy?.[a.column];
      // a grouped-by column keeps its distinct values and extremes; sums need a summary column
      if (grouped && (name === 'MIN' || name === 'MAX' || name === 'DISTINCTCOUNT')) {
        usesDetail = true;
        return { type: 'call', name, args: [aggCol(grouped)] };
      }
      const m = agg.columns?.[a.column];
      const sum = (col?: string): Expr | null => (col ? { type: 'call', name: 'SUM', args: [aggCol(col)] } : null);
      let out: Expr | null = null;
      if (name === 'SUM') out = sum(m?.sum);
      else if (name === 'MIN' && m?.min) out = { type: 'call', name: 'MIN', args: [aggCol(m.min)] };
      else if (name === 'MAX' && m?.max) out = { type: 'call', name: 'MAX', args: [aggCol(m.max)] };
      else if (name === 'COUNT' || name === 'COUNTA') out = sum(m?.count);
      else if (name === 'AVERAGE' && m?.sum && m.count) out = { type: 'call', name: 'DIVIDE', args: [sum(m.sum)!, sum(m.count)!] };
      if (out) usesDetail = true;
      return out;
    }
    const args = e.args.map(expr);
    return args.every(Boolean) ? { ...e, args: args as Expr[] } : null;
  };

  // values: rewritten expressions keep their names and formats
  const values: FieldSpec[] = [];
  for (const v of spec.values ?? []) {
    if (typeof v === 'object' && v.visualCalc) {
      values.push(v);
      continue;
    }
    const resolved = resolve(model, v);
    const e = expr(resolved.ast);
    if (!e) return null;
    const field = { name: resolved.name, expression: resolved.name, format: resolved.format };
    parsedValues.set(field, e);
    values.push(field);
  }
  const groupBy: string[] = [];
  for (const g of spec.groupBy ?? []) {
    const r = ref(g);
    if (!r) return null;
    groupBy.push(r);
  }
  const filters = (fs: (FilterSpec | Filter)[] | undefined): FilterSpec[] | null | undefined => {
    if (!fs) return undefined;
    const out: FilterSpec[] = [];
    for (const f of fs) {
      const s = 'kind' in f ? (f.kind === 'columns' ? f.spec : undefined) : f;
      if (!s || s.op === 'topN') return null;
      if (s.op === 'tuples') {
        const targets = s.targets.map(ref);
        if (!targets.every(Boolean)) return null;
        out.push({ ...s, targets: targets as string[] });
      } else {
        const target = ref(s.target);
        if (!target) return null;
        out.push({ ...s, target });
      }
    }
    return out;
  };
  const f = filters(spec.filters);
  const hl = filters(spec.highlight);
  if (f === null || hl === null || !usesDetail) return null;
  const orderBy = spec.orderBy?.map((o) => (typeof o.field === 'string' && /\[.*\]$/.test(o.field) ? { ...o, field: ref(o.field) ?? o.field } : o));
  return { ...spec, values, groupBy: spec.groupBy && groupBy, filters: f, highlight: hl, orderBy };
}
