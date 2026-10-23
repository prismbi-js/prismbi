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

/** A compiled row condition: does row `row` of the iterated table pass? */
export type RowTest = (row: number) => boolean;

export interface RowTestPlan {
  bind(): RowTest;
}

/**
 * Which values of one column make a condition true, by dictionary slot (0 is BLANK, k + 1 is entry k of the column's
 * dictionary). Supplied by the evaluator, so text comparison, BLANK handling and functions keep its exact semantics.
 */
export type Judge = (e: Expr, col: { table: string; column: string }) => Uint8Array;

type TestNode = (m: DataModel) => RowTest;

/**
 * Compile a FILTER condition evaluated in a row context on `table`: `&&`, `||`, AND, OR and NOT over conditions that
 * read one column of the table (or of a related one-side table, through RELATED or with `lenient`), each judged once
 * per distinct value, and comparisons between numeric row expressions. Null when the full engine is needed.
 */
export function compileRowTest(model: DataModel, table: string, e: Expr, lenient: boolean, judge: Judge): RowTestPlan | null {
  const node = compileTest(model, table, e, lenient, judge);
  return node ? { bind: () => node(model) } : null;
}

const COMPARISONS = new Set(['=', '==', '<>', '<', '>', '<=', '>=']);
/** Functions a judged condition may use: deterministic, reading only their arguments. */
const PURE = new Set(['BLANK', 'TRUE', 'FALSE', 'DATE', 'NOT', 'AND', 'OR', 'IF', 'ISBLANK', 'LEFT', 'RIGHT', 'MID', 'UPPER', 'LOWER', 'LEN', 'TRIM', 'CONTAINSSTRING', 'CONTAINSSTRINGEXACT', 'SEARCH', 'FIND', 'YEAR', 'MONTH', 'DAY', 'QUARTER', 'WEEKDAY', 'ABS', 'ROUND', 'INT', 'VALUE', 'FORMAT', 'EXACT']);

function compileTest(model: DataModel, table: string, e: Expr, lenient: boolean, judge: Judge): TestNode | null {
  const both = (a: Expr, b: Expr, and: boolean): TestNode | null => {
    const l = compileTest(model, table, a, lenient, judge);
    const r = l && compileTest(model, table, b, lenient, judge);
    if (!l || !r) return null;
    return (m) => {
      const x = l(m);
      const y = r(m);
      return and ? (row) => x(row) && y(row) : (row) => x(row) || y(row);
    };
  };
  const not = (a: Expr): TestNode | null => {
    const x = compileTest(model, table, a, lenient, judge);
    return x && ((m) => ((f) => (row: number) => !f(row))(x(m)));
  };
  if (e.type === 'binary' && (e.op === '&&' || e.op === '||')) return both(e.left, e.right, e.op === '&&');
  if (e.type === 'call' && (e.name === 'AND' || e.name === 'OR') && e.args.length === 2) return both(e.args[0], e.args[1], e.name === 'AND');
  if ((e.type === 'unary' && e.op === 'NOT') || (e.type === 'call' && e.name === 'NOT' && e.args.length === 1)) return not(e.type === 'unary' ? e.operand : e.args[0]);
  // numeric comparisons run on the typed views; other single-column conditions are judged per distinct value
  if (e.type === 'binary' && COMPARISONS.has(e.op)) {
    const l = compile(model, table, e.left, lenient);
    const r = l && compile(model, table, e.right, lenient);
    if (l && r) return compareNode(e.op, l, r);
  }
  const single = singleColumn(model, table, e, lenient);
  return single ? judged(table, single.expr, single.col, judge) : null;
}

function compareNode(op: string, l: Node, r: Node): TestNode {
  return (m) => {
    const a = l(m);
    const b = r(m);
    return (row) => {
      const x = a(row);
      const y = b(row);
      if (op === '==') return x === y;
      // the evaluator compares BLANK as 0 against a number
      const c = (x ?? 0) - (y ?? 0);
      return op === '=' ? c === 0 : op === '<>' ? c !== 0 : op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
    };
  };
}

/** The one column a pure condition reads, with RELATED(x) replaced by x for judging, or null. */
function singleColumn(model: DataModel, table: string, e: Expr, lenient: boolean): { expr: Expr; col: { table: string; column: string } } | null {
  let col: { table: string; column: string } | null = null;
  let ok = true;
  const use = (c: { table: string; column: string }, viaRelated: boolean) => {
    if (!model.hasTable(c.table) || !model.table(c.table).hasColumn(c.column)) return (ok = false);
    if (c.table !== table && !((viaRelated || lenient) && model.expanded(table).has(c.table) && model.relatedRows(table, c.table))) return (ok = false);
    if (col && (col.table !== c.table || col.column !== c.column)) return (ok = false);
    col = c;
    return true;
  };
  const walk = (x: Expr): Expr => {
    if (!ok) return x;
    switch (x.type) {
      case 'column':
        use(x, false);
        return x;
      case 'number':
      case 'string':
      case 'boolean':
        return x;
      case 'unary':
        return { ...x, operand: walk(x.operand) };
      case 'binary':
        return { ...x, left: walk(x.left), right: walk(x.right) };
      case 'list':
        return { ...x, items: x.items.map(walk) };
      case 'call':
        if (x.name === 'RELATED' && x.args.length === 1 && x.args[0].type === 'column') {
          use(x.args[0], true);
          return x.args[0];
        }
        if (!PURE.has(x.name.toUpperCase())) ok = false;
        return { ...x, args: x.args.map(walk) };
      default:
        ok = false;
        return x;
    }
  };
  const expr = walk(e);
  return ok && col ? { expr, col } : null;
}

function judged(table: string, expr: Expr, col: { table: string; column: string }, judge: Judge): TestNode {
  // judged per dictionary: appended rows can extend it, so the verdicts are redone when it grows
  let seen: unknown[] | null = null;
  let size = -1;
  let allowed = new Uint8Array(0);
  const verdicts = (m: DataModel) => {
    const { dict } = m.table(col.table).codes(col.column);
    if (dict !== seen || dict.length !== size) (allowed = judge(expr, col)), (seen = dict), (size = dict.length);
    return allowed;
  };
  if (col.table === table)
    return (m) => {
      const ok = verdicts(m);
      const codes = m.table(table).codes(col.column).codes;
      return (row) => ok[codes[row] + 1] === 1;
    };
  return (m) => {
    const ok = verdicts(m);
    const map = m.relatedRows(table, col.table)!;
    const codes = m.table(col.table).codes(col.column).codes;
    // a row without a related row sees BLANK
    return (row) => {
      const t = map[row];
      return ok[t < 0 ? 0 : codes[t] + 1] === 1;
    };
  };
}
