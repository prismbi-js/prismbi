import type { Expr } from './ast';
import type { DataModel } from '../data/model';

/** A row expression compiled to a closure over typed arrays: the value for one row of the iterated table (null is BLANK). */
export type RowFn = (row: number) => number | null;

/**
 * A compiled plan. Arrays are fetched when `bind()` runs (not at compile time), so plans can be cached while the
 * table's cached views are rebuilt underneath them.
 */
export interface RowPlan {
  bind(): RowFn;
}

type Node = (m: DataModel) => RowFn;

/**
 * Compile a numeric row expression evaluated in a row context on `table`: number literals, number columns of the table,
 * RELATED (or, with `lenient`, bare references) to number columns of related one-side tables, unary minus and
 * `+ - * /` and DIVIDE with the evaluator's exact BLANK rules. Returns null when the full engine is needed.
 *
 * `lenient` must only be set when no outer row context exists: otherwise a bare reference to another table could be
 * bound by an outer iterator instead of following the relationship.
 */
export function compileRowExpr(model: DataModel, table: string, e: Expr, lenient: boolean): RowPlan | null {
  const node = compile(model, table, e, lenient);
  return node ? { bind: () => node(model) } : null;
}

function numberColumn(model: DataModel, table: string, column: string): boolean {
  return model.hasTable(table) && model.table(table).hasColumn(column) && model.table(table).column(column).type === 'number';
}

function columnNode(model: DataModel, table: string, ref: { table: string; column: string }, foreign: boolean): Node | null {
  if (!numberColumn(model, ref.table, ref.column)) return null;
  if (ref.table === table) {
    return (m) => {
      const a = m.table(table).numeric(ref.column);
      return (r) => {
        const v = a[r];
        return v === v ? v : null;
      };
    };
  }
  if (!foreign || !model.expanded(table).has(ref.table) || !model.relatedRows(table, ref.table)) return null;
  return (m) => {
    const map = m.relatedRows(table, ref.table)!;
    const a = m.table(ref.table).numeric(ref.column);
    return (r) => {
      const t = map[r];
      if (t < 0) return null;
      const v = a[t];
      return v === v ? v : null;
    };
  };
}

function compile(model: DataModel, table: string, e: Expr, lenient: boolean): Node | null {
  switch (e.type) {
    case 'number': {
      const v = e.value;
      return () => () => v;
    }
    case 'column':
      return columnNode(model, table, e, lenient);
    case 'bracket':
      if (model.hasMeasure(e.name) || !model.table(table).hasColumn(e.name)) return null;
      return columnNode(model, table, { table, column: e.name }, false);
    case 'unary': {
      if (e.op === 'NOT') return null;
      const x = compile(model, table, e.operand, lenient);
      if (!x) return null;
      const neg = e.op === '-';
      return (m) => {
        const f = x(m);
        return (r) => {
          const v = f(r);
          return v === null ? null : neg ? -v : v;
        };
      };
    }
    case 'binary': {
      const op = e.op;
      if (op !== '+' && op !== '-' && op !== '*' && op !== '/') return null;
      const l = compile(model, table, e.left, lenient);
      const rt = l && compile(model, table, e.right, lenient);
      if (!l || !rt) return null;
      return (m) => {
        const a = l(m);
        const b = rt(m);
        switch (op) {
          case '+':
            return (r) => {
              const x = a(r);
              const y = b(r);
              return x === null && y === null ? null : (x ?? 0) + (y ?? 0);
            };
          case '-':
            return (r) => {
              const x = a(r);
              const y = b(r);
              return x === null && y === null ? null : (x ?? 0) - (y ?? 0);
            };
          case '*':
            return (r) => {
              const x = a(r);
              if (x === null) return null;
              const y = b(r);
              return y === null ? null : x * y;
            };
          default:
            return (r) => {
              const x = a(r);
              const y = b(r);
              if (x === null && y === null) return null;
              const n = x ?? 0;
              const d = y ?? 0;
              if (d === 0) return n === 0 ? NaN : n > 0 ? Infinity : -Infinity;
              return n / d;
            };
        }
      };
    }
    case 'call': {
      if (e.name === 'RELATED' && e.args.length === 1 && e.args[0].type === 'column') return columnNode(model, table, e.args[0], true);
      if (e.name === 'DIVIDE' && (e.args.length === 2 || e.args.length === 3)) {
        const a = compile(model, table, e.args[0], lenient);
        const b = a && compile(model, table, e.args[1], lenient);
        const alt = e.args[2] ? compile(model, table, e.args[2], lenient) : undefined;
        if (!a || !b || alt === null) return null;
        return (m) => {
          const fa = a(m);
          const fb = b(m);
          const falt = alt ? alt(m) : null;
          return (r) => {
            const d = fb(r);
            if (d === null || d === 0) return falt ? falt(r) : null;
            const n = fa(r);
            return n === null ? null : n / d;
          };
        };
      }
      return null;
    }
  }
  return null;
}
