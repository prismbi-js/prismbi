import type { Expr } from './ast';
import { parseDax } from './parser';

export interface FormatDaxOptions {
  /** Indentation unit (default four spaces). */
  indent?: string;
  /** Break function calls onto several lines past this width (default 80). */
  maxLine?: number;
  /** Convert function names to canonical uppercase (default: true). */
  uppercaseFunctions?: boolean;
  /** Format SWITCH cases with aligned condition-value pairs (default: true). */
  alignSwitch?: boolean;
  /** Place CALCULATE filter arguments on separate lines when multi-line (default: true). */
  breakCalculateFilters?: boolean;
}

const PREC: Record<string, number> = { '||': 1, '&&': 2, '=': 4, '==': 4, '<>': 4, '<': 4, '>': 4, '<=': 4, '>=': 4, IN: 4, '&': 5, '+': 6, '-': 6, '*': 7, '/': 7, '^': 8 };

const quoteTable = (t: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t) ? t : `'${t.replace(/'/g, "''")}'`);

/** Pretty-print a DAX expression or measure definition with canonical formatting and smart indentation. */
export function formatDax(src: string | Expr, opts: FormatDaxOptions = {}): string {
  const unit = opts.indent ?? '    ';
  const max = opts.maxLine ?? 80;

  if (typeof src === 'string') {
    const trimmed = src.trim();
    // Preserve leading comments
    const lines = trimmed.split('\n');
    const leadingComments: string[] = [];
    let lineIdx = 0;
    while (lineIdx < lines.length) {
      const l = lines[lineIdx].trim();
      if (l.startsWith('//') || l.startsWith('--') || (l.startsWith('/*') && l.endsWith('*/'))) {
        leadingComments.push(lines[lineIdx]);
        lineIdx++;
      } else break;
    }
    const cleanSrc = lines.slice(lineIdx).join('\n').trim();

    // Check for Measure = Expression header
    const headerMatch = /^(\[[^\]]+\]|[A-Za-z_][\w ]*|'[^']+'\[[^\]]+\])\s*=\s*([\s\S]+)$/.exec(cleanSrc);
    if (headerMatch) {
      const header = headerMatch[1].trim();
      const bodyText = headerMatch[2].trim();
      try {
        const formattedBody = formatDax(parseDax(bodyText), opts);
        let res: string;
        if (!formattedBody.includes('\n') && header.length + formattedBody.length + 3 <= max) {
          res = `${header} = ${formattedBody}`;
        } else {
          res = `${header} =\n${unit}${formattedBody.split('\n').join('\n' + unit)}`;
        }
        return leadingComments.length ? `${leadingComments.join('\n')}\n${res}` : res;
      } catch {
        // Fall back to general parsing
      }
    }

    const ast = parseDax(cleanSrc);
    const formatted = formatAst(ast, 0, unit, max, opts);
    return leadingComments.length ? `${leadingComments.join('\n')}\n${formatted}` : formatted;
  }

  return formatAst(src, 0, unit, max, opts);
}

function formatAst(ast: Expr, startLevel: number, unit: string, max: number, opts: FormatDaxOptions): string {
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
        return e.row ? `(${e.items.map((i) => fmt(i, level)).join(', ')})` : `{ ${e.items.map((i) => fmt(i, level)).join(', ')} }`;
      case 'unary':
        return e.op === 'NOT' ? `NOT ${wrap(e.operand, 3, level)}` : `${e.op}${wrap(e.operand, 9, level)}`;
      case 'binary': {
        const p = PREC[e.op];
        const left = wrap(e.left, e.op === '^' ? p + 1 : p, level);
        const right = wrap(e.right, e.op === '^' ? p : p + 1, level);
        return `${left} ${e.op} ${right}`;
      }
      case 'call': {
        const name = opts.uppercaseFunctions !== false ? e.name.toUpperCase() : e.name;
        if (!e.args.length) return `${name}()`;
        const inline = `${name}(${e.args.map((a) => fmt(a, 0)).join(', ')})`;
        const inner = unit.repeat(level + 1);

        // Special case: SWITCH
        if (name === 'SWITCH' && opts.alignSwitch !== false && e.args.length > 2) {
          const lines: string[] = [];
          lines.push(inner + fmt(e.args[0], level + 1));
          let i = 1;
          while (i < e.args.length - 1) {
            const c = fmt(e.args[i], level + 1);
            const r = fmt(e.args[i + 1], level + 1);
            lines.push(`${inner}${c}, ${r}`);
            i += 2;
          }
          if (i < e.args.length) {
            lines.push(inner + fmt(e.args[i], level + 1));
          }
          return `${name}(\n${lines.join(',\n')}\n${pad})`;
        }

        // Special case: CALCULATE and CALCULATETABLE
        if ((name === 'CALCULATE' || name === 'CALCULATETABLE') && opts.breakCalculateFilters !== false && e.args.length > 1) {
          if (!inline.includes('\n') && pad.length + inline.length <= max) return inline;
          const exprStr = fmt(e.args[0], level + 1);
          const filterStrs = e.args.slice(1).map((a) => fmt(a, level + 1));
          return `${name}(\n${inner}${exprStr},\n${filterStrs.map((f) => inner + f).join(',\n')}\n${pad})`;
        }

        if (!inline.includes('\n') && pad.length + inline.length <= max) return inline;
        return `${name}(\n${e.args.map((a) => inner + fmt(a, level + 1)).join(',\n')}\n${pad})`;
      }
      case 'var': {
        const inner = unit.repeat(level + 1);
        const binds = e.bindings.map((b) => {
          const val = fmt(b.value, level + 1);
          if (val.includes('\n')) {
            return `VAR ${b.name} =\n${inner}${val}`;
          }
          return `VAR ${b.name} = ${val}`;
        }).join(`\n${pad}`);
        const body = fmt(e.body, level + 1);
        return `${binds}\n${pad}RETURN\n${inner}${body}`;
      }
    }
  };

  const wrap = (e: Expr, min: number, level: number) => {
    const s = fmt(e, level);
    return prec(e) < min ? `(${s})` : s;
  };

  return fmt(ast, startLevel);
}
