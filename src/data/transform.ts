import type { CellValue, Row } from './types';

/**
 * Power Query-style transform steps: plain, serialisable objects applied in order to rows. The same steps run in the
 * browser, a worker or on a server, and are stored with the model so they replay on refresh.
 */
export type TransformStep =
  | { op: 'filterRows'; column: string; test: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'notContains' | 'startsWith' | 'in' | 'notIn' | 'isBlank' | 'notBlank'; value?: CellValue; values?: CellValue[] }
  | { op: 'removeColumns'; columns: string[] }
  | { op: 'keepColumns'; columns: string[] }
  | { op: 'renameColumns'; names: Record<string, string> }
  | { op: 'changeType'; column: string; type: 'number' | 'string' | 'date' | 'boolean' }
  | { op: 'splitColumn'; column: string; delimiter: string; into: string[] }
  | { op: 'mergeColumns'; columns: string[]; separator?: string; as: string; keep?: boolean }
  | { op: 'addColumn'; name: string; template: string }
  | { op: 'replaceValues'; column: string; find: CellValue; replace: CellValue }
  | { op: 'transformText'; columns: string[]; fn: 'trim' | 'upper' | 'lower' | 'title' | 'clean' }
  | { op: 'fillDown'; columns: string[] }
  | { op: 'unpivot'; columns: string[]; attribute?: string; value?: string }
  | { op: 'pivot'; attribute: string; value: string; aggregate?: 'sum' | 'count' | 'first' | 'min' | 'max' | 'avg' }
  | { op: 'groupBy'; by: string[]; aggregations: { name: string; column?: string; agg: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'distinctCount' }[] }
  | { op: 'sort'; by: { column: string; desc?: boolean }[] }
  | { op: 'removeDuplicates'; columns?: string[] }
  | { op: 'keepTop'; n: number }
  | { op: 'merge'; with: string; on: [string, string][]; kind?: 'left' | 'inner'; columns?: string[]; prefix?: string }
  | { op: 'append'; with: string };

export interface TransformContext {
  /** Rows of another table or query, for `merge` and `append`. */
  lookup?: (name: string) => Row[];
}

const blank = (v: unknown) => v === null || v === undefined || v === '';
const key = (v: unknown) => (v instanceof Date ? `D${v.getTime()}` : `${typeof v}:${String(v)}`);
const cmp = (a: unknown, b: unknown): number => {
  if (blank(a)) return blank(b) ? 0 : -1;
  if (blank(b)) return 1;
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  return typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
};

function convert(v: unknown, type: 'number' | 'string' | 'date' | 'boolean'): CellValue {
  if (blank(v)) return null;
  switch (type) {
    case 'number': {
      const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s$€£%]/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    case 'string':
      return v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
    case 'date': {
      if (v instanceof Date) return v;
      const s = String(v);
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
      const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    case 'boolean':
      return typeof v === 'boolean' ? v : /^(true|yes|1)$/i.test(String(v).trim());
  }
}

function test(step: Extract<TransformStep, { op: 'filterRows' }>, v: CellValue): boolean {
  const s = (x: unknown) => String(x ?? '').toLowerCase();
  switch (step.test) {
    case 'eq':
      return key(v) === key(step.value);
    case 'neq':
      return key(v) !== key(step.value);
    case 'gt':
      return !blank(v) && cmp(v, step.value) > 0;
    case 'gte':
      return !blank(v) && cmp(v, step.value) >= 0;
    case 'lt':
      return !blank(v) && cmp(v, step.value) < 0;
    case 'lte':
      return !blank(v) && cmp(v, step.value) <= 0;
    case 'contains':
      return s(v).includes(s(step.value));
    case 'notContains':
      return !s(v).includes(s(step.value));
    case 'startsWith':
      return s(v).startsWith(s(step.value));
    case 'in':
      return (step.values ?? []).some((x) => key(x) === key(v));
    case 'notIn':
      return !(step.values ?? []).some((x) => key(x) === key(v));
    case 'isBlank':
      return blank(v);
    case 'notBlank':
      return !blank(v);
  }
}

function aggregate(values: CellValue[], agg: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'distinctCount' | 'first'): CellValue {
  const nums = values.filter((v): v is number => typeof v === 'number');
  switch (agg) {
    case 'sum':
      return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
    case 'avg':
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    case 'min':
      return values.filter((v) => !blank(v)).sort(cmp)[0] ?? null;
    case 'max':
      return values.filter((v) => !blank(v)).sort(cmp).pop() ?? null;
    case 'count':
      return values.filter((v) => !blank(v)).length;
    case 'distinctCount':
      return new Set(values.filter((v) => !blank(v)).map(key)).size;
    case 'first':
      return values[0] ?? null;
  }
}

const title = (s: string) => s.toLowerCase().replace(/(^|[\s\-_'])(\p{L})/gu, (_m, a, b) => a + b.toUpperCase());

/** Apply one step. */
export function applyStep(rows: Row[], step: TransformStep, ctx: TransformContext = {}): Row[] {
  switch (step.op) {
    case 'filterRows':
      return rows.filter((r) => test(step, r[step.column] as CellValue));
    case 'removeColumns':
      return rows.map((r) => {
        const o = { ...r };
        for (const c of step.columns) delete o[c];
        return o;
      });
    case 'keepColumns':
      return rows.map((r) => Object.fromEntries(step.columns.map((c) => [c, r[c] ?? null])));
    case 'renameColumns':
      return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [step.names[k] ?? k, v])));
    case 'changeType':
      return rows.map((r) => ({ ...r, [step.column]: convert(r[step.column], step.type) }));
    case 'splitColumn':
      return rows.map((r) => {
        const parts = blank(r[step.column]) ? [] : String(r[step.column]).split(step.delimiter);
        const o: Row = { ...r };
        step.into.forEach((name, i) => (o[name] = i < step.into.length - 1 ? (parts[i] ?? null) : parts.slice(i).join(step.delimiter) || null));
        if (!step.into.includes(step.column)) delete o[step.column];
        return o;
      });
    case 'mergeColumns':
      return rows.map((r) => {
        const o: Row = { ...r, [step.as]: step.columns.map((c) => (blank(r[c]) ? '' : String(r[c]))).join(step.separator ?? ' ').trim() || null };
        if (!step.keep) for (const c of step.columns) if (c !== step.as) delete o[c];
        return o;
      });
    case 'addColumn':
      return rows.map((r) => ({ ...r, [step.name]: step.template.replace(/\{([^}]+)\}/g, (_m, c: string) => (blank(r[c]) ? '' : String(r[c]))) }));
    case 'replaceValues':
      return rows.map((r) => (key(r[step.column]) === key(step.find) || (blank(step.find) && blank(r[step.column])) ? { ...r, [step.column]: step.replace } : r));
    case 'transformText': {
      const fn = { trim: (s: string) => s.trim(), upper: (s: string) => s.toUpperCase(), lower: (s: string) => s.toLowerCase(), title, clean: (s: string) => s.replace(/\s+/g, ' ').trim() }[step.fn];
      return rows.map((r) => {
        const o = { ...r };
        for (const c of step.columns) if (typeof o[c] === 'string') o[c] = fn(o[c] as string);
        return o;
      });
    }
    case 'fillDown': {
      const last: Record<string, unknown> = {};
      return rows.map((r) => {
        const o = { ...r };
        for (const c of step.columns) {
          if (blank(o[c])) o[c] = last[c] ?? null;
          else last[c] = o[c];
        }
        return o;
      });
    }
    case 'unpivot': {
      const attribute = step.attribute ?? 'Attribute';
      const value = step.value ?? 'Value';
      const out: Row[] = [];
      for (const r of rows) {
        const rest = Object.fromEntries(Object.entries(r).filter(([k]) => !step.columns.includes(k)));
        for (const c of step.columns) if (!blank(r[c])) out.push({ ...rest, [attribute]: c, [value]: r[c] });
      }
      return out;
    }
    case 'pivot': {
      const groups = new Map<string, { base: Row; cells: Map<string, CellValue[]> }>();
      const names: string[] = [];
      for (const r of rows) {
        const base = Object.fromEntries(Object.entries(r).filter(([k]) => k !== step.attribute && k !== step.value));
        const k = JSON.stringify(Object.values(base).map(key));
        let g = groups.get(k);
        if (!g) groups.set(k, (g = { base, cells: new Map() }));
        const name = String(r[step.attribute] ?? '(blank)');
        if (!names.includes(name)) names.push(name);
        const list = g.cells.get(name) ?? [];
        list.push(r[step.value] as CellValue);
        g.cells.set(name, list);
      }
      return [...groups.values()].map((g) => ({ ...g.base, ...Object.fromEntries(names.map((n) => [n, g.cells.has(n) ? aggregate(g.cells.get(n)!, step.aggregate ?? 'sum') : null])) }));
    }
    case 'groupBy': {
      const groups = new Map<string, Row[]>();
      for (const r of rows) {
        const k = JSON.stringify(step.by.map((c) => key(r[c])));
        const list = groups.get(k);
        if (list) list.push(r);
        else groups.set(k, [r]);
      }
      return [...groups.values()].map((list) => ({
        ...Object.fromEntries(step.by.map((c) => [c, list[0][c] ?? null])),
        ...Object.fromEntries(step.aggregations.map((a) => [a.name, a.agg === 'count' && !a.column ? list.length : aggregate(list.map((r) => r[a.column!] as CellValue), a.agg)])),
      }));
    }
    case 'sort':
      return [...rows].sort((a, b) => {
        for (const s of step.by) {
          const c = cmp(a[s.column], b[s.column]);
          if (c) return s.desc ? -c : c;
        }
        return 0;
      });
    case 'removeDuplicates': {
      const seen = new Set<string>();
      return rows.filter((r) => {
        const k = JSON.stringify((step.columns ?? Object.keys(r)).map((c) => key(r[c])));
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    case 'keepTop':
      return rows.slice(0, Math.max(0, step.n));
    case 'merge': {
      const other = ctx.lookup?.(step.with);
      if (!other) throw new Error(`Merge: table "${step.with}" not found`);
      const index = new Map<string, Row>();
      for (const r of other) index.set(JSON.stringify(step.on.map(([, rc]) => key(r[rc]))), r);
      const cols = step.columns ?? Object.keys(other[0] ?? {}).filter((c) => !step.on.some(([, rc]) => rc === c));
      const prefix = step.prefix ?? '';
      const out: Row[] = [];
      for (const r of rows) {
        const m = index.get(JSON.stringify(step.on.map(([lc]) => key(r[lc]))));
        if (!m && step.kind === 'inner') continue;
        out.push({ ...r, ...Object.fromEntries(cols.map((c) => [`${prefix}${c}`, m ? (m[c] ?? null) : null])) });
      }
      return out;
    }
    case 'append': {
      const other = ctx.lookup?.(step.with);
      if (!other) throw new Error(`Append: table "${step.with}" not found`);
      return [...rows, ...other];
    }
  }
}

/** Apply steps in order; errors name the failing step. */
export function applySteps(rows: Row[], steps: TransformStep[], ctx: TransformContext = {}): Row[] {
  let out = rows;
  steps.forEach((step, i) => {
    try {
      out = applyStep(out, step, ctx);
    } catch (e) {
      throw new Error(`Step ${i + 1} (${step.op}): ${(e as Error).message}`);
    }
  });
  return out;
}

/** Steps that transform each row on its own, so new rows can be transformed without re-running the rest. */
const ROW_LOCAL = new Set<TransformStep['op']>(['filterRows', 'removeColumns', 'keepColumns', 'renameColumns', 'changeType', 'splitColumn', 'mergeColumns', 'addColumn', 'replaceValues', 'transformText', 'unpivot', 'merge']);
export const rowLocalSteps = (steps: TransformStep[]) => steps.every((s) => ROW_LOCAL.has(s.op));

/** Plain-language summary of a step (for step lists in editors). */
export function describeStep(s: TransformStep): string {
  switch (s.op) {
    case 'filterRows':
      return `Keep rows where ${s.column} ${s.test}${s.values ? ` ${s.values.join(', ')}` : s.value !== undefined ? ` ${String(s.value)}` : ''}`;
    case 'removeColumns':
      return `Remove ${s.columns.join(', ')}`;
    case 'keepColumns':
      return `Keep only ${s.columns.join(', ')}`;
    case 'renameColumns':
      return `Rename ${Object.entries(s.names).map(([a, b]) => `${a} → ${b}`).join(', ')}`;
    case 'changeType':
      return `${s.column} as ${s.type}`;
    case 'splitColumn':
      return `Split ${s.column} by "${s.delimiter}" into ${s.into.join(', ')}`;
    case 'mergeColumns':
      return `Merge ${s.columns.join(' + ')} into ${s.as}`;
    case 'addColumn':
      return `Add ${s.name} = ${s.template}`;
    case 'replaceValues':
      return `Replace "${String(s.find ?? '(blank)')}" with "${String(s.replace ?? '(blank)')}" in ${s.column}`;
    case 'transformText':
      return `${s.fn} text in ${s.columns.join(', ')}`;
    case 'fillDown':
      return `Fill down ${s.columns.join(', ')}`;
    case 'unpivot':
      return `Unpivot ${s.columns.join(', ')}`;
    case 'pivot':
      return `Pivot ${s.attribute} with ${s.aggregate ?? 'sum'} of ${s.value}`;
    case 'groupBy':
      return `Group by ${s.by.join(', ')}: ${s.aggregations.map((a) => `${a.name} = ${a.agg}${a.column ? `(${a.column})` : ''}`).join(', ')}`;
    case 'sort':
      return `Sort by ${s.by.map((b) => `${b.column}${b.desc ? ' ↓' : ''}`).join(', ')}`;
    case 'removeDuplicates':
      return `Remove duplicates${s.columns ? ` by ${s.columns.join(', ')}` : ''}`;
    case 'keepTop':
      return `Keep first ${s.n} rows`;
    case 'merge':
      return `${s.kind === 'inner' ? 'Inner' : 'Left'} merge with ${s.with} on ${s.on.map(([a, b]) => `${a} = ${b}`).join(', ')}`;
    case 'append':
      return `Append ${s.with}`;
  }
}
