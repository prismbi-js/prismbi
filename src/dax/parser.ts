import type { BinaryOp, Expr } from './ast';

export type TokType = 'num' | 'str' | 'ident' | 'qtable' | 'bracket' | 'op' | 'lparen' | 'rparen' | 'lbrace' | 'rbrace' | 'comma' | 'eof';

export interface Token {
  type: TokType;
  value: string;
  pos: number;
  /** Offset just past the token. */
  end: number;
}

export class DaxSyntaxError extends Error {
  constructor(message: string, readonly position: number, readonly source: string) {
    super(`${message} at position ${position}: ${source.slice(Math.max(0, position - 15), position)}⟦${source.slice(position, position + 15)}⟧`);
    this.name = 'DaxSyntaxError';
  }
}

const OPS = ['<=', '>=', '<>', '==', '&&', '||', '+', '-', '*', '/', '^', '&', '=', '<', '>'];

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const prev = out[out.length - 1];
    if (prev && prev.end < 0) prev.end = i;
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    // comments: -- line, // line, /* block */
    if ((ch === '-' && src[i + 1] === '-') || (ch === '/' && src[i + 1] === '/')) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    const start = i;
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ type: 'num', value: m[0], pos: start, end: -1 });
      i += m[0].length;
      continue;
    }
    if (ch === '"') {
      let s = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new DaxSyntaxError('Unterminated string', start, src);
        if (src[i] === '"') {
          if (src[i + 1] === '"') {
            s += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += src[i++];
      }
      out.push({ type: 'str', value: s, pos: start, end: -1 });
      continue;
    }
    if (ch === "'") {
      let s = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new DaxSyntaxError('Unterminated table name', start, src);
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            s += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += src[i++];
      }
      out.push({ type: 'qtable', value: s, pos: start, end: -1 });
      continue;
    }
    if (ch === '[') {
      const end = src.indexOf(']', i);
      if (end < 0) throw new DaxSyntaxError('Unterminated [reference]', start, src);
      out.push({ type: 'bracket', value: src.slice(i + 1, end).trim(), pos: start, end: -1 });
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_À-￿]/.test(ch)) {
      const m = /^[A-Za-z_À-￿][A-Za-z0-9_.À-￿]*/.exec(src.slice(i))!;
      out.push({ type: 'ident', value: m[0], pos: start, end: -1 });
      i += m[0].length;
      continue;
    }
    const simple: Record<string, TokType> = { '(': 'lparen', ')': 'rparen', '{': 'lbrace', '}': 'rbrace', ',': 'comma', ';': 'comma' };
    if (simple[ch]) {
      out.push({ type: simple[ch], value: ch, pos: start, end: -1 });
      i++;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ type: 'op', value: op, pos: start, end: -1 });
      i += op.length;
      continue;
    }
    throw new DaxSyntaxError(`Unexpected character "${ch}"`, start, src);
  }
  const last = out[out.length - 1];
  if (last && last.end < 0) last.end = src.length;
  out.push({ type: 'eof', value: '', pos: src.length, end: src.length });
  return out;
}

const cache = new Map<string, Expr>();

/** Parse a DAX-like expression into an AST (memoised). */
export function parseDax(src: string): Expr {
  const hit = cache.get(src);
  if (hit) return hit;
  const ast = new Parser(src).parse();
  if (cache.size > 5000) cache.clear();
  cache.set(src, ast);
  return ast;
}

class Parser {
  private toks: Token[];
  private p = 0;
  private vars: Set<string>[] = [];

  constructor(private src: string) {
    this.toks = tokenize(src);
  }

  parse(): Expr {
    const e = this.expr();
    if (this.peek().type !== 'eof') this.fail(`Unexpected "${this.peek().value}"`);
    return e;
  }

  private peek(o = 0): Token {
    return this.toks[Math.min(this.p + o, this.toks.length - 1)];
  }
  private next(): Token {
    return this.toks[this.p++];
  }
  private fail(msg: string): never {
    throw new DaxSyntaxError(msg, this.peek().pos, this.src);
  }
  private expect(type: TokType, value?: string): Token {
    const t = this.peek();
    if (t.type !== type || (value !== undefined && t.value.toUpperCase() !== value)) this.fail(`Expected ${value ?? type}`);
    return this.next();
  }
  private isKeyword(word: string, o = 0): boolean {
    const t = this.peek(o);
    return t.type === 'ident' && t.value.toUpperCase() === word;
  }

  private expr(): Expr {
    if (this.isKeyword('VAR')) return this.varBlock();
    return this.or();
  }

  private varBlock(): Expr {
    const bindings: { name: string; value: Expr }[] = [];
    const scope = new Set<string>();
    this.vars.push(scope);
    while (this.isKeyword('VAR')) {
      this.next();
      const name = this.expect('ident').value;
      this.expect('op', '=');
      bindings.push({ name, value: this.expr() });
      scope.add(name.toUpperCase());
    }
    this.expect('ident', 'RETURN');
    const body = this.expr();
    this.vars.pop();
    return { type: 'var', bindings, body };
  }

  private binaryLevel(ops: string[], nextLevel: () => Expr): Expr {
    let left = nextLevel();
    while (this.peek().type === 'op' && ops.includes(this.peek().value)) {
      const op = this.next().value as BinaryOp;
      left = { type: 'binary', op, left, right: nextLevel() };
    }
    return left;
  }

  private or = (): Expr => this.binaryLevel(['||'], this.and);
  private and = (): Expr => this.binaryLevel(['&&'], this.not);

  private not = (): Expr => {
    if (this.isKeyword('NOT') && this.peek(1).type !== 'lparen') {
      this.next();
      return { type: 'unary', op: 'NOT', operand: this.not() };
    }
    return this.comparison();
  };

  private comparison = (): Expr => {
    let left = this.concat();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && ['=', '==', '<>', '<', '>', '<=', '>='].includes(t.value)) {
        this.next();
        left = { type: 'binary', op: t.value as BinaryOp, left, right: this.concat() };
      } else if (this.isKeyword('IN')) {
        this.next();
        left = { type: 'binary', op: 'IN', left, right: this.concat() };
      } else return left;
    }
  };

  private concat = (): Expr => this.binaryLevel(['&'], this.additive);
  private additive = (): Expr => this.binaryLevel(['+', '-'], this.multiplicative);
  private multiplicative = (): Expr => this.binaryLevel(['*', '/'], this.power);

  private power = (): Expr => {
    const base = this.unary();
    if (this.peek().type === 'op' && this.peek().value === '^') {
      this.next();
      return { type: 'binary', op: '^', left: base, right: this.power() };
    }
    return base;
  };

  private unary = (): Expr => {
    const t = this.peek();
    if (t.type === 'op' && (t.value === '-' || t.value === '+')) {
      this.next();
      return { type: 'unary', op: t.value, operand: this.unary() };
    }
    return this.primary();
  };

  private primary(): Expr {
    const t = this.next();
    switch (t.type) {
      case 'num':
        return { type: 'number', value: Number(t.value) };
      case 'str':
        return { type: 'string', value: t.value };
      case 'bracket':
        return { type: 'bracket', name: t.value };
      case 'qtable':
        return this.tableOrColumn(t.value);
      case 'lparen': {
        const e = this.expr();
        // (a, b): a row of a table constructor
        if (this.peek().type === 'comma') {
          const items = [e];
          while (this.peek().type === 'comma' && this.next()) items.push(this.expr());
          this.expect('rparen');
          return { type: 'list', items, row: true };
        }
        this.expect('rparen');
        return e;
      }
      case 'lbrace': {
        const items: Expr[] = [];
        if (this.peek().type !== 'rbrace') {
          do items.push(this.expr());
          while (this.peek().type === 'comma' && this.next());
        }
        this.expect('rbrace');
        return { type: 'list', items };
      }
      case 'ident': {
        const upper = t.value.toUpperCase();
        if (this.peek().type === 'lparen') {
          this.next();
          const args: Expr[] = [];
          if (this.peek().type !== 'rparen') {
            do args.push(this.expr());
            while (this.peek().type === 'comma' && this.next());
          }
          this.expect('rparen');
          return { type: 'call', name: upper, args };
        }
        if (upper === 'TRUE') return { type: 'boolean', value: true };
        if (upper === 'FALSE') return { type: 'boolean', value: false };
        if (this.vars.some((s) => s.has(upper)) && this.peek().type !== 'bracket') return { type: 'varRef', name: t.value };
        return this.tableOrColumn(t.value);
      }
      default:
        this.p--;
        this.fail(t.type === 'eof' ? 'Unexpected end of expression' : `Unexpected "${t.value}"`);
    }
  }

  private tableOrColumn(name: string): Expr {
    if (this.peek().type === 'bracket') {
      const col = this.next().value;
      return { type: 'column', table: name, column: col };
    }
    return { type: 'table', name };
  }
}
