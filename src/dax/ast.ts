export type Expr =
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'column'; table: string; column: string }
  /** `[Name]` – measure, or an unqualified column in row context. */
  | { type: 'bracket'; name: string }
  /** Bare table reference, e.g. `Sales` or `'Sales Data'`. */
  | { type: 'table'; name: string }
  | { type: 'call'; name: string; args: Expr[] }
  | { type: 'unary'; op: '-' | '+' | 'NOT'; operand: Expr }
  | { type: 'binary'; op: BinaryOp; left: Expr; right: Expr }
  /** `{ a, b }`; `row` marks a parenthesized tuple `(a, b)`, a row of a table constructor `{ (1, "x"), (2, "y") }`. */
  | { type: 'list'; items: Expr[]; row?: boolean }
  | { type: 'var'; bindings: { name: string; value: Expr }[]; body: Expr }
  | { type: 'varRef'; name: string };

export type BinaryOp = '+' | '-' | '*' | '/' | '^' | '&' | '=' | '==' | '<>' | '<' | '>' | '<=' | '>=' | '&&' | '||' | 'IN';
