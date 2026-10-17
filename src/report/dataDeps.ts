import type { Expr } from '../dax/ast';
import { parseDax } from '../dax/parser';
import type { DataModel } from '../data/model';

/**
 * Tables whose data can change what a visual shows, or null when that can't be bounded (row-level security in effect).
 *
 * Conservative by design: every string anywhere in the visual's query and spec is scanned for table, column and measure
 * references, measures are followed through their expressions, calculation items count as referenced, and the result is
 * widened to every table connected through any relationship (active or not, either direction).
 */
export function dataDependencies(model: DataModel, ...sources: unknown[]): Set<string> | null {
  if (model.activeRoleNames.length) return null;
  const tables = new Set<string>();
  const measures = new Set<string>();
  const addTable = (t: string) => {
    if (model.hasTable(t)) tables.add(t);
  };
  const walkExpr = (e: Expr): void => {
    switch (e.type) {
      case 'column':
        addTable(e.table);
        return;
      case 'table':
        addTable(e.name);
        return;
      case 'bracket':
        if (model.hasMeasure(e.name)) measures.add(e.name);
        return;
      case 'call':
        e.args.forEach(walkExpr);
        return;
      case 'unary':
        walkExpr(e.operand);
        return;
      case 'binary':
        walkExpr(e.left);
        walkExpr(e.right);
        return;
      case 'list':
        e.items.forEach(walkExpr);
        return;
      case 'var':
        e.bindings.forEach((b) => walkExpr(b.value));
        walkExpr(e.body);
        return;
    }
  };
  const walkString = (s: string) => {
    if (model.hasMeasure(s)) measures.add(s);
    addTable(s);
    if (!/[[(]/.test(s)) return;
    try {
      walkExpr(parseDax(s));
    } catch {
      // not DAX (a label, a format string…): pick out Table[...] references
      for (const m of s.matchAll(/'([^']+)'\s*\[|([A-Za-z_][\w ]*?)\s*\[/g)) addTable((m[1] ?? m[2]).trim());
    }
  };
  const seen = new Set<unknown>();
  const walk = (v: unknown): void => {
    if (typeof v === 'string') return walkString(v);
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (v instanceof Date || v instanceof Set || ArrayBuffer.isView(v)) return;
    if (Array.isArray(v)) return v.forEach(walk);
    for (const x of Object.values(v as Record<string, unknown>)) walk(x);
  };
  sources.forEach(walk);

  // measures, transitively, and every calculation item (they can rewrite any measure)
  for (const g of model.calculationGroups()) {
    addTable(g.table);
    for (const it of g.items.values()) {
      walkExpr(it.ast);
      if (it.formatAst) walkExpr(it.formatAst);
    }
  }
  const done = new Set<string>();
  for (let more = true; more; ) {
    more = false;
    for (const name of [...measures]) {
      if (done.has(name)) continue;
      done.add(name);
      more = true;
      const m = model.measure(name);
      if (m.table) addTable(m.table);
      walkExpr(m.ast);
    }
  }

  // filters travel along relationships: widen to the connected tables
  const rels = model.relationships();
  const queue = [...tables];
  while (queue.length) {
    const t = queue.pop()!;
    for (const r of rels) {
      const other = r.fromTable === t ? r.toTable : r.toTable === t ? r.fromTable : null;
      if (other && !tables.has(other)) {
        tables.add(other);
        queue.push(other);
      }
    }
  }
  return tables;
}
