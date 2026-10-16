import type { Expr } from './ast';
import { parseDax } from './parser';

export interface FormatDaxOptions {
  /** Indentation unit (default four spaces). */
  indent?: string;
  /** Break function calls onto several lines past this width (default 80). */
  maxLine?: number;
}

const PREC: Record<string, number> = { '||': 1, '&&': 2, '=': 4, '==': 4, '<>': 4, '<': 4, '>': 4, '<=': 4, '>=': 4, IN: 4, '&': 5, '+': 6, '-': 6, '*': 7, '/': 7, '^': 8 };

const quoteTable = (t: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t) ? t : `'${t.replace(/'/g, "''")}'`);

/** Pretty-print a DAX expression (like daxformatter): consistent spacing, long calls broken over lines. */
export function formatDax(src: string | Expr, opts: FormatDaxOptions = {}): string {
  const unit = opts.indent ?? '    ';
  const max = opts.maxLine ?? 80;
  const ast = typeof src === 'string' ? parseDax(src) : src;

  const prec = (e: Expr) => (e.type === 'binary' ? PREC[e.op] : e.type === 'unary' && e.op === 'NOT' ? 3 : 10);

  const fmt = (e: Expr, level: number): string => {
    const pad = unit.repeat(level);
    switch (e.type) {
      case 'number':
        return String(e.value);
      case 'string':
        return `"${e.value.replace(/"/g, '""')}"`;
      case 'boolean':
        return e.value ? 'TRUE' : 'FALSE';
      case 'column':
        return `${quoteTable(e.table)}[${e.column}]`;
      case 'bracket':
        return `[${e.name}]`;
      case 'table':
        return quoteTable(e.name);
      case 'varRef':
        return e.name;
      case 'list':
        return `{ ${e.items.map((i) => fmt(i, level)).join(', ')} }`;
      case 'unary':
        return e.op === 'NOT' ? `NOT ${wrap(e.operand, 3, level)}` : `${e.op}${wrap(e.operand, 9, level)}`;
      case 'binary': {
        const p = PREC[e.op];
        const left = wrap(e.left, e.op === '^' ? p + 1 : p, level);
        const right = wrap(e.right, e.op === '^' ? p : p + 1, level);
        return `${left} ${e.op} ${right}`;
      }
      case 'call': {
        const inline = `${e.name}(${e.args.map((a) => fmt(a, 0)).join(', ')})`;
        if (!inline.includes('\n') && pad.length + inline.length <= max) return inline;
        const inner = unit.repeat(level + 1);
        return `${e.name}(\n${e.args.map((a) => inner + fmt(a, level + 1)).join(',\n')}\n${pad})`;
      }
      case 'var': {
        const inner = unit.repeat(level + 1);
        const binds = e.bindings.map((b) => `VAR ${b.name} = ${fmt(b.value, level + 1)}`).join(`\n${pad}`);
        return `${binds}\n${pad}RETURN\n${inner}${fmt(e.body, level + 1)}`;
      }
    }
  };
  const wrap = (e: Expr, min: number, level: number) => {
    const s = fmt(e, level);
    return prec(e) < min ? `(${s})` : s;
  };
  return fmt(ast, 0);
}
