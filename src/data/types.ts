/** Primitive value stored in a cell. `null` represents BLANK (DAX semantics). */
export type CellValue = number | string | boolean | Date | null;

export type DataType = 'number' | 'string' | 'boolean' | 'date';

/** A reference to a column, e.g. `{ table: 'Sales', column: 'Amount' }`. */
export interface ColumnRef {
  table: string;
  column: string;
}

export type Row = Record<string, unknown>;

export interface ColumnSchema {
  type?: DataType;
  /** Format string such as `"#,0.00"`, `"0.0%"`, `"$#,0"`, `"MMM yyyy"`. */
  format?: string;
  /** Hide from field lists (keys, technical columns). */
  hidden?: boolean;
  /** Sort this column by another column of the same table (e.g. MonthName by MonthNumber). */
  sortBy?: string;
  description?: string;
}

export type CrossFilterDirection = 'single' | 'both';

export interface RelationshipDef {
  /** Many side, `'Sales[ProductId]'` or ColumnRef. */
  from: string | ColumnRef;
  /** One side, `'Products[Id]'` or ColumnRef. */
  to: string | ColumnRef;
  /** Phase 1 supports `'single'` (one → many). `'both'` is accepted and treated as `'single'`. */
  crossFilter?: CrossFilterDirection;
  active?: boolean;
}

export interface MeasureDef {
  name: string;
  /** DAX-like expression, e.g. `SUM(Sales[Amount])`. */
  expression: string;
  /** Home table used for display grouping in field lists. */
  table?: string;
  format?: string;
  description?: string;
  folder?: string;
}

/** Parse `"Table[Column]"` or `"'My Table'[Column]"`. */
export function parseColumnRef(ref: string | ColumnRef): ColumnRef {
  if (typeof ref !== 'string') return ref;
  const m = /^\s*(?:'((?:[^']|'')+)'|([^[\]']+?))\s*\[([^\]]+)\]\s*$/.exec(ref);
  if (!m) throw new Error(`Invalid column reference "${ref}". Expected "Table[Column]".`);
  const table = (m[1] ?? m[2]).replace(/''/g, "'").trim();
  return { table, column: m[3].trim() };
}

export function columnRefToString(ref: ColumnRef): string {
  const t = /^[A-Za-z_][A-Za-z0-9_]*$/.test(ref.table) ? ref.table : `'${ref.table.replace(/'/g, "''")}'`;
  return `${t}[${ref.column}]`;
}

export function isColumnRefString(s: string): boolean {
  return /\]\s*$/.test(s) && /\[/.test(s) && !/^\s*\[/.test(s);
}

/** Normalised key usable in Maps (Dates compare by time). */
export function valueKey(v: CellValue): string | number | boolean | null {
  if (v instanceof Date) return v.getTime();
  return v;
}

/** Total order across cell values: BLANK first, then numbers/dates, booleans, strings. */
export function compareValues(a: CellValue, b: CellValue): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (typeof av === 'number' && typeof bv === 'number') return av - bv;
  if (typeof av === 'boolean' && typeof bv === 'boolean') return av === bv ? 0 : av ? 1 : -1;
  return String(av).localeCompare(String(bv), undefined, { numeric: true });
}

export function valuesEqual(a: CellValue, b: CellValue): boolean {
  return valueKey(a) === valueKey(b);
}
