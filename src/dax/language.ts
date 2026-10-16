import type { DataModel } from '../data/model';
import { formatValue } from '../format/format';
import type { Expr } from './ast';
import { formatDax } from './format';
import { DAX_FUNCTIONS, DAX_FUNCTION_MAP, DAX_KEYWORDS } from './functions';
import type { Token } from './parser';
import { DaxSyntaxError, parseDax, tokenize } from './parser';

export interface DaxCompletion {
  label: string;
  kind: 'function' | 'table' | 'column' | 'measure' | 'keyword' | 'variable';
  detail?: string;
  documentation?: string;
  /** Text to insert in place of [from, to). */
  insertText: string;
  from: number;
  to: number;
}

export interface DaxDiagnostic {
  from: number;
  to: number;
  severity: 'error' | 'warning';
  message: string;
}

export interface DaxHover {
  from: number;
  to: number;
  title: string;
  detail?: string;
  documentation?: string;
}

export interface DaxSignatureHelp {
  name: string;
  signature: string;
  description: string;
  activeParameter: number;
}

const quoteTable = (t: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t) ? t : `'${t.replace(/'/g, "''")}'`);

function safeTokens(text: string): Token[] {
  try {
    return tokenize(text);
  } catch {
    // unterminated string / bracket at the cursor: tokenize what we can
    for (let cut = text.length - 1; cut > 0; cut--) {
      try {
        return tokenize(text.slice(0, cut));
      } catch {
        /* keep shrinking */
      }
    }
    return [];
  }
}

/**
 * Editor tooling for DAX against a model: completion, hover, diagnostics, signature help and formatting.
 * Framework-agnostic: wire it to CodeMirror, Monaco or a plain textarea.
 */
export class DaxLanguageService {
  constructor(private model: DataModel) {}

  /** Completion items at `offset`. */
  complete(text: string, offset: number): DaxCompletion[] {
    const before = text.slice(0, offset);
    const rank = (label: string, prefix: string) => {
      const l = label.toLowerCase();
      const p = prefix.toLowerCase();
      return !p ? 1 : l.startsWith(p) ? 0 : l.includes(p) ? 1 : -1;
    };
    const finish = (items: (DaxCompletion & { _r?: number })[], prefix: string) =>
      items
        .map((it) => ({ ...it, _r: rank(it.label, prefix) }))
        .filter((it) => it._r >= 0)
        .sort((a, b) => a._r - b._r || a.label.localeCompare(b.label))
        .map(({ _r: _x, ...it }) => it);

    // inside [ ... ] → columns of the preceding table, or measures
    const open = before.lastIndexOf('[');
    if (open >= 0 && before.indexOf(']', open) < 0) {
      const prefix = before.slice(open + 1);
      const m = /(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))\s*$/.exec(before.slice(0, open));
      const tableName = m ? (m[1] ?? m[2]).replace(/''/g, "'") : undefined;
      const closeAfter = text[offset] === ']' ? 1 : 0;
      if (tableName && this.model.hasTable(tableName)) {
        const t = this.model.table(tableName);
        return finish(
          [...t.columns.values()].map((c) => ({ label: c.name, kind: 'column' as const, detail: `${tableName} · ${c.type}`, documentation: c.description, insertText: `${c.name}]`, from: open + 1, to: offset + closeAfter })),
          prefix,
        );
      }
      return finish(
        this.model.measureList().map((ms) => ({ label: ms.name, kind: 'measure' as const, detail: 'Measure', documentation: ms.expression, insertText: `${ms.name}]`, from: open + 1, to: offset + closeAfter })),
        prefix,
      );
    }
    // inside '...' → table names
    const quotes = (before.match(/'/g) ?? []).length;
    if (quotes % 2 === 1) {
      const q = before.lastIndexOf("'");
      const prefix = before.slice(q + 1);
      return finish(this.model.tableNames().map((t) => ({ label: t, kind: 'table' as const, detail: `${this.model.table(t).rowCount} rows`, insertText: `${t.replace(/'/g, "''")}'`, from: q + 1, to: offset })), prefix);
    }
    const word = /[A-Za-z_][A-Za-z0-9_.]*$/.exec(before);
    const prefix = word?.[0] ?? '';
    const from = offset - prefix.length;
    const vars = [...before.matchAll(/\bVAR\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map((x) => x[1]);
    const items: DaxCompletion[] = [
      ...DAX_FUNCTIONS.map((f) => ({ label: f.name, kind: 'function' as const, detail: f.signature, documentation: f.description, insertText: `${f.name}(`, from, to: offset })),
      ...this.model.tableNames().map((t) => ({ label: t, kind: 'table' as const, detail: `${this.model.table(t).rowCount} rows`, insertText: quoteTable(t), from, to: offset })),
      ...DAX_KEYWORDS.map((k) => ({ label: k, kind: 'keyword' as const, insertText: k, from, to: offset })),
      ...[...new Set(vars)].map((v) => ({ label: v, kind: 'variable' as const, detail: 'Variable', insertText: v, from, to: offset })),
    ];
    return prefix ? finish(items, prefix) : finish(items.filter((i) => i.kind !== 'keyword'), '');
  }

  /** Hover documentation for the token under `offset`. */
  hover(text: string, offset: number): DaxHover | null {
    const toks = safeTokens(text);
    const i = toks.findIndex((t) => t.type !== 'eof' && offset >= t.pos && offset <= t.end);
    if (i < 0) return null;
    const t = toks[i];
    const next = toks[i + 1];
    const prev = toks[i - 1];
    if (t.type === 'ident' && next?.type === 'lparen') {
      const f = DAX_FUNCTION_MAP.get(t.value.toUpperCase());
      return f ? { from: t.pos, to: t.end, title: f.signature, detail: f.category, documentation: f.description } : { from: t.pos, to: t.end, title: `${t.value}()`, detail: 'Unknown function' };
    }
    if (t.type === 'bracket') {
      const table = prev && (prev.type === 'ident' || prev.type === 'qtable') && prev.end === t.pos ? prev.value : undefined;
      if (table && this.model.hasTable(table) && this.model.table(table).hasColumn(t.value)) {
        const c = this.model.table(table).column(t.value);
        return { from: prev!.pos, to: t.end, title: `${quoteTable(table)}[${c.name}]`, detail: `Column · ${c.type}${c.format ? ` · ${c.format}` : ''}`, documentation: c.expression ? `Calculated: ${c.expression}` : c.description };
      }
      if (this.model.hasMeasure(t.value)) {
        const m = this.model.measure(t.value);
        return { from: t.pos, to: t.end, title: `[${m.name}]`, detail: `Measure${m.format ? ` · ${m.format}` : ''}`, documentation: formatDax(m.expression) };
      }
      return null;
    }
    if ((t.type === 'ident' || t.type === 'qtable') && this.model.hasTable(t.value)) {
      const tb = this.model.table(t.value);
      return { from: t.pos, to: t.end, title: quoteTable(t.value), detail: `Table · ${formatValue(tb.rowCount, '#,0')} rows · ${tb.columns.size} columns` };
    }
    return null;
  }

  /** Signature help for the innermost call around `offset`. */
  signatureHelp(text: string, offset: number): DaxSignatureHelp | null {
    const toks = safeTokens(text.slice(0, offset));
    let depth = 0;
    let commas = 0;
    for (let i = toks.length - 1; i >= 0; i--) {
      const t = toks[i];
      if (t.type === 'rparen') depth++;
      else if (t.type === 'lparen') {
        if (depth === 0) {
          const fn = toks[i - 1];
          const f = fn?.type === 'ident' ? DAX_FUNCTION_MAP.get(fn.value.toUpperCase()) : undefined;
          return f ? { name: f.name, signature: f.signature, description: f.description, activeParameter: commas } : null;
        }
        depth--;
      } else if (t.type === 'comma' && depth === 0) commas++;
    }
    return null;
  }

  /** Syntax errors and unknown functions, tables, columns and measures. */
  diagnose(text: string): DaxDiagnostic[] {
    const out: DaxDiagnostic[] = [];
    try {
      parseDax(text);
    } catch (e) {
      if (e instanceof DaxSyntaxError) {
        out.push({ from: e.position, to: Math.min(text.length, e.position + 1), severity: 'error', message: e.message.replace(/ at position \d+:.*$/s, '') });
        return out;
      }
      throw e;
    }
    const toks = tokenize(text);
    const vars = new Set([...text.matchAll(/\bVAR\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map((x) => x[1].toUpperCase()));
    const keywords = new Set(DAX_KEYWORDS);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      const next = toks[i + 1];
      if (t.type === 'ident' && next?.type === 'lparen') {
        if (!DAX_FUNCTION_MAP.has(t.value.toUpperCase())) out.push({ from: t.pos, to: t.end, severity: 'error', message: `Unknown function ${t.value}` });
        continue;
      }
      if ((t.type === 'ident' || t.type === 'qtable') && next?.type === 'bracket' && next.pos === t.end) {
        if (!this.model.hasTable(t.value)) out.push({ from: t.pos, to: t.end, severity: 'error', message: `Unknown table '${t.value}'` });
        else if (!this.model.table(t.value).hasColumn(next.value)) out.push({ from: next.pos, to: next.end, severity: 'error', message: `Column [${next.value}] not found in table '${t.value}'` });
        i++;
        continue;
      }
      if (t.type === 'bracket') {
        if (!this.model.hasMeasure(t.value) && !this.model.findColumnByName(t.value))
          out.push({ from: t.pos, to: t.end, severity: 'error', message: `Unknown measure or column [${t.value}]` });
        continue;
      }
      if (t.type === 'qtable' && !this.model.hasTable(t.value)) out.push({ from: t.pos, to: t.end, severity: 'error', message: `Unknown table '${t.value}'` });
      if (t.type === 'ident') {
        const u = t.value.toUpperCase();
        if (!keywords.has(u) && !vars.has(u) && !this.model.hasTable(t.value)) out.push({ from: t.pos, to: t.end, severity: 'error', message: `Unknown table or variable ${t.value}` });
      }
    }
    return out;
  }

  /** Pretty-print (returns the input unchanged when it does not parse). */
  format(text: string): string {
    try {
      return formatDax(text);
    } catch {
      return text;
    }
  }
}

export interface DaxExplanation {
  formatted: string;
  functions: string[];
  /** Measures used, including indirect ones (dependency order). */
  measures: string[];
  columns: string[];
  tables: string[];
}

/** Dependencies of an expression: functions, measures (transitively), columns and tables. */
export function explainDax(model: DataModel, expression: string): DaxExplanation {
  const functions = new Set<string>();
  const measures: string[] = [];
  const columns = new Set<string>();
  const tables = new Set<string>();
  const visit = (e: Expr, seen: Set<string>) => {
    switch (e.type) {
      case 'call':
        functions.add(e.name);
        e.args.forEach((a) => visit(a, seen));
        break;
      case 'column':
        columns.add(`${quoteTable(e.table)}[${e.column}]`);
        tables.add(e.table);
        break;
      case 'table':
        tables.add(e.name);
        break;
      case 'bracket':
        if (model.hasMeasure(e.name) && !seen.has(e.name)) {
          seen.add(e.name);
          visit(model.measure(e.name).ast, seen);
          if (!measures.includes(e.name)) measures.push(e.name);
        }
        break;
      case 'binary':
        visit(e.left, seen);
        visit(e.right, seen);
        break;
      case 'unary':
        visit(e.operand, seen);
        break;
      case 'list':
        e.items.forEach((i) => visit(i, seen));
        break;
      case 'var':
        e.bindings.forEach((b) => visit(b.value, seen));
        visit(e.body, seen);
        break;
    }
  };
  visit(parseDax(expression), new Set());
  return { formatted: formatDax(expression), functions: [...functions].sort(), measures, columns: [...columns].sort(), tables: [...tables].sort() };
}
