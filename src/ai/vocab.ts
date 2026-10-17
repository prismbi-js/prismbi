import type { CellValue, DataModel } from '@prismbi/prismbi';

/** Something in the model a phrase can refer to. */
export type Entity =
  | { kind: 'measure'; name: string; label: string }
  | { kind: 'column'; table: string; column: string; ref: string; type: string; label: string; isDate: boolean; numeric: boolean }
  | { kind: 'value'; table: string; column: string; ref: string; value: CellValue; label: string }
  | { kind: 'table'; table: string; label: string };

const STOP = new Set('a an the of in on at to for by per with and or is are was were be been what which who how show me give list display get find tell all each every do does did my our their its this that these those please chart graph visual plot as from over across during between vs versus than'.split(' '));
/** Words that describe an aggregation rather than name a field. */
const AGG_WORDS = new Set('total sum count number average avg mean max maximum min minimum distinct unique amount'.split(' '));

export function words(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9%]+/)
    .filter(Boolean);
}

/** Light stemming so "products", "categories" and "sales" match their singular forms. */
export function stem(w: string): string {
  if (w.length <= 3 || /^\d+$/.test(w)) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith('ses') || w.endsWith('xes') || w.endsWith('ches') || w.endsWith('shes')) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
}

export const key = (ws: string[]) => ws.map(stem).join(' ');
export const isStop = (w: string) => STOP.has(w);
export const isAggWord = (w: string) => AGG_WORDS.has(w);

export interface Vocabulary {
  /** Phrase (stemmed words) → entities, longest phrases first when matching. */
  phrases: Map<string, Entity[]>;
  maxLen: number;
  measures: Entity[];
  columns: Extract<Entity, { kind: 'column' }>[];
  dateTable?: string;
}

const KEYISH = /(^|[a-z])(key|id|guid|code)$/i;

export function buildVocabulary(model: DataModel, synonyms: Record<string, string[]> = {}): Vocabulary {
  const phrases = new Map<string, Entity[]>();
  let maxLen = 1;
  const add = (phrase: string[], e: Entity) => {
    const k = key(phrase.filter((w) => !isStop(w)));
    if (!k) return;
    maxLen = Math.max(maxLen, k.split(' ').length);
    const list = phrases.get(k) ?? [];
    if (!list.some((x) => JSON.stringify(x) === JSON.stringify(e))) list.push(e);
    phrases.set(k, list);
  };
  const measures: Entity[] = [];
  for (const m of model.measureList()) {
    if ((m as { hidden?: boolean }).hidden) continue;
    const e: Entity = { kind: 'measure', name: m.name, label: m.name };
    measures.push(e);
    const ws = words(m.name);
    add(ws, e);
    // "Total Sales" also answers to "sales"
    const core = ws.filter((w) => !isAggWord(w));
    if (core.length && core.length < ws.length) add(core, e);
    for (const s of synonyms[m.name] ?? []) add(words(s), e);
  }
  const columns: Extract<Entity, { kind: 'column' }>[] = [];
  let dateTable: string | undefined;
  for (const tname of model.tableNames()) {
    const t = model.table(tname);
    const cols = [...t.columns.values()];
    const hasDateCol = cols.some((c) => c.type === 'date');
    if (hasDateCol && cols.some((c) => /^year$/i.test(c.name)) && !dateTable) dateTable = tname;
    add(words(tname), { kind: 'table', table: tname, label: tname });
    for (const s of synonyms[tname] ?? []) add(words(s), { kind: 'table', table: tname, label: tname });
    for (const c of cols) {
      if (c.hidden || KEYISH.test(c.name)) continue;
      const ref = `${/^[A-Za-z_][A-Za-z0-9_]*$/.test(tname) ? tname : `'${tname}'`}[${c.name}]`;
      const e = { kind: 'column' as const, table: tname, column: c.name, ref, type: c.type, label: c.name, isDate: c.type === 'date', numeric: c.type === 'number' };
      columns.push(e);
      add(words(c.name), e);
      add([...words(tname), ...words(c.name)], e);
      for (const s of synonyms[`${tname}[${c.name}]`] ?? []) add(words(s), e);
      // short text values become filters: "in Canada", "for bikes"
      if (c.type === 'string') {
        const values = t.distinct(c.name);
        if (values.length >= 2 && values.length <= 300)
          for (const v of values) if (typeof v === 'string' && v.length > 1 && v.length <= 40) add(words(v), { kind: 'value', table: tname, column: c.name, ref, value: v, label: v });
      }
    }
  }
  return { phrases, maxLen: Math.min(maxLen, 5), measures, columns, dateTable };
}

/** The most readable text column of a table (for "by product"). */
export function labelColumn(vocab: Vocabulary, table: string): Extract<Entity, { kind: 'column' }> | undefined {
  const cols = vocab.columns.filter((c) => c.table === table && c.type === 'string');
  const t = table.toLowerCase().replace(/s$/, '');
  return cols.find((c) => /^name$/i.test(c.column)) ?? cols.find((c) => c.column.toLowerCase().replace(/s$/, '') === t) ?? cols.find((c) => /name$/i.test(c.column)) ?? cols[0];
}
