import type { Expr } from '../dax/ast';
import { parseDax } from '../dax/parser';
import type { CellValue } from './types';
import type { QueryField, QueryRow } from './query';

/**
 * Visual calculations: DAX-style expressions evaluated over a visual's own result rows (after sorting and Top N),
 * like Power BI's visual calculations. `[Name]` refers to another value field of the visual.
 *
 * Window functions: RUNNINGSUM, MOVINGAVERAGE(x, n), PREVIOUS(x [, k]), NEXT(x [, k]), FIRST, LAST,
 * RANK(x [, "ASC"]), ROWNUMBER(), PERCENTOFTOTAL(x). Scalars: + - * /, comparisons, DIVIDE, ABS, ROUND, IF,
 * BLANK, ISBLANK, MIN/MAX of two values.
 */
export interface VisualCalcSpec {
  expression: string;
  /** `'parent'` restarts window functions whenever the outer group(s) change (needs two or more group columns). */
  reset?: 'none' | 'parent';
}

type Num = number | null;
type Vec = Num[];

const num = (v: CellValue | undefined): Num => (typeof v === 'number' && Number.isFinite(v) ? v : v === true ? 1 : v === false ? 0 : null);

/** Row indices grouped into partitions, in display order. */
function partitions(rows: QueryRow[], groupCount: number, reset: VisualCalcSpec['reset']): number[][] {
  if (reset !== 'parent' || groupCount < 2) return [rows.map((_, i) => i)];
  const parts = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const k = JSON.stringify(r.keys.slice(0, groupCount - 1), (_k, v) => (v instanceof Date ? v.getTime() : v));
    const list = parts.get(k);
    if (list) list.push(i);
    else parts.set(k, [i]);
  });
  return [...parts.values()];
}

/** Evaluate `ast` for every row of one partition (vectorised). */
function evalVec(ast: Expr, n: number, column: (name: string) => Vec): Vec {
  const ev = (e: Expr): Vec => evalVec(e, n, column);
  const fill = (v: Num): Vec => new Array(n).fill(v);
  switch (ast.type) {
    case 'number':
      return fill(ast.value);
    case 'boolean':
      return fill(ast.value ? 1 : 0);
    case 'bracket':
      return column(ast.name);
    case 'unary': {
      const v = ev(ast.operand);
      return ast.op === '-' ? v.map((x) => (x === null ? null : -x)) : ast.op === 'NOT' ? v.map((x) => (x ? 0 : 1)) : v;
    }
    case 'binary': {
      const a = ev(ast.left);
      const b = ev(ast.right);
      return a.map((x, i) => {
        const y = b[i];
        switch (ast.op) {
          case '+':
            return x === null && y === null ? null : (x ?? 0) + (y ?? 0);
          case '-':
            return x === null && y === null ? null : (x ?? 0) - (y ?? 0);
          case '*':
            return x === null || y === null ? null : x * y;
          case '/':
            return x === null || y === null || y === 0 ? null : x / y;
          case '>':
            return (x ?? 0) > (y ?? 0) ? 1 : 0;
          case '>=':
            return (x ?? 0) >= (y ?? 0) ? 1 : 0;
          case '<':
            return (x ?? 0) < (y ?? 0) ? 1 : 0;
          case '<=':
            return (x ?? 0) <= (y ?? 0) ? 1 : 0;
          case '=':
            return x === y ? 1 : 0;
          case '<>':
            return x !== y ? 1 : 0;
          case '&&':
            return x && y ? 1 : 0;
          case '||':
            return x || y ? 1 : 0;
          default:
            throw new Error(`Operator ${ast.op} is not supported in visual calculations`);
        }
      });
    }
    case 'call': {
      const args = ast.args;
      const arg = (i: number) => ev(args[i]);
      const lit = (i: number, d: number) => (args[i] ? (ev(args[i])[0] ?? d) : d);
      switch (ast.name) {
        case 'RUNNINGSUM': {
          const v = arg(0);
          let acc = 0;
          let seen = false;
          return v.map((x) => {
            if (x !== null) {
              acc += x;
              seen = true;
            }
            return seen ? acc : null;
          });
        }
        case 'MOVINGAVERAGE': {
          const v = arg(0);
          const w = Math.max(1, Math.round(lit(1, 3)));
          return v.map((_, i) => {
            const win = v.slice(Math.max(0, i - w + 1), i + 1).filter((x): x is number => x !== null);
            return win.length ? win.reduce((s, x) => s + x, 0) / win.length : null;
          });
        }
        case 'PREVIOUS':
        case 'NEXT': {
          const v = arg(0);
          const k = Math.round(lit(1, 1)) * (ast.name === 'PREVIOUS' ? -1 : 1);
          return v.map((_, i) => v[i + k] ?? null);
        }
        case 'FIRST':
          return fill(arg(0)[0] ?? null);
        case 'LAST': {
          const v = arg(0);
          return fill(v[v.length - 1] ?? null);
        }
        case 'ROWNUMBER':
          return Array.from({ length: n }, (_, i) => i + 1);
        case 'RANK': {
          const v = arg(0);
          const asc = args[1]?.type === 'string' && args[1].value.toUpperCase() === 'ASC';
          // competition ranking (1, 2, 2, 4); blanks rank last
          return v.map((x) => (x === null ? null : 1 + v.filter((y) => y !== null && (asc ? y < x : y > x)).length));
        }
        case 'PERCENTOFTOTAL': {
          const v = arg(0);
          const total = v.reduce<number>((s, x) => s + (x ?? 0), 0);
          return v.map((x) => (x === null || !total ? null : x / total));
        }
        case 'DIVIDE': {
          const a = arg(0);
          const b = arg(1);
          const alt = args[2] ? arg(2) : fill(null);
          return a.map((x, i) => (b[i] === null || b[i] === 0 ? alt[i] : x === null ? null : x / b[i]!));
        }
        case 'ABS':
          return arg(0).map((x) => (x === null ? null : Math.abs(x)));
        case 'ROUND': {
          const d = Math.round(lit(1, 0));
          return arg(0).map((x) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d));
        }
        case 'MIN':
        case 'MAX': {
          if (args.length !== 2) throw new Error(`${ast.name} takes two values in visual calculations`);
          const a = arg(0);
          const b = arg(1);
          const f = ast.name === 'MIN' ? Math.min : Math.max;
          return a.map((x, i) => (x === null ? b[i] : b[i] === null ? x : f(x, b[i]!)));
        }
        case 'IF': {
          const c = arg(0);
          const t = arg(1);
          const e = args[2] ? arg(2) : fill(null);
          return c.map((x, i) => (x ? t[i] : e[i]));
        }
        case 'BLANK':
          return fill(null);
        case 'ISBLANK':
          return arg(0).map((x) => (x === null ? 1 : 0));
        default:
          throw new Error(`${ast.name} is not available in visual calculations`);
      }
    }
    default:
      throw new Error(`Unsupported expression in a visual calculation (${ast.type})`);
  }
}

/**
 * Compute a visual calculation for every row. `fields` are the visual's value fields aligned with `row.values`;
 * `pick` chooses values or highlights.
 */
export function computeVisualCalc(spec: VisualCalcSpec, rows: QueryRow[], fields: QueryField[], groupCount: number, pick: (r: QueryRow) => CellValue[] | undefined = (r) => r.values): Num[] {
  const ast = parseDax(spec.expression);
  const out: Num[] = new Array(rows.length).fill(null);
  for (const part of partitions(rows, groupCount, spec.reset)) {
    const column = (name: string): Vec => {
      const i = fields.findIndex((f) => f.name === name || f.ref === name || f.ref === `[${name}]`);
      if (i < 0) throw new Error(`Visual calculation refers to [${name}], which is not a value of this visual`);
      return part.map((r) => num(pick(rows[r])?.[i]));
    };
    const v = evalVec(ast, part.length, column);
    part.forEach((r, k) => (out[r] = v[k]));
  }
  return out;
}
