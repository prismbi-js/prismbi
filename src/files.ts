/**
 * PrismBI report files: store a report as a folder of small, stable JSON files (one per page, visual and
 * bookmark) for version control and code review, and diff two report versions in plain language.
 *
 * ```ts
 * import { splitReport, joinReport, diffReports, formatDiff } from 'prismbi/files';
 * const files = splitReport(report.toJSON());     // { 'report.json': '…', 'pages/overview/page.json': '…', … }
 * const def = joinReport(files);
 * console.log(formatDiff(diffReports(before, after)));
 * ```
 */
import type { Bookmark, PageDefinition, ReportDefinition } from './report/report';
import type { VisualSpec } from './visuals/types';
import { migrateReport } from './report/migrate';

const DATE_TAG = '$date';

/** Report files keyed by forward-slash path. */
export type ReportFiles = Record<string, string>;

// ---------------------------------------------------------------- stable JSON

/** Keys that read best first; everything else follows alphabetically. */
const KEY_ORDER = ['version', 'id', 'name', 'type', 'title', 'hidden', 'layout', 'fields', 'filters', 'format', 'visuals', 'pages', 'x', 'y', 'w', 'h', 'z'];

function keyRank(k: string): number {
  const i = KEY_ORDER.indexOf(k);
  return i < 0 ? KEY_ORDER.length : i;
}

function plain(value: unknown): unknown {
  if (value instanceof Date) return { [DATE_TAG]: value.toISOString() };
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value).sort((a, b) => keyRank(a) - keyRank(b) || (a < b ? -1 : a > b ? 1 : 0));
    for (const k of keys) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined && typeof v !== 'function') out[k] = plain(v);
    }
    return out;
  }
  return value;
}

/** Pretty JSON with deterministic key order; small flat objects and arrays stay on one line. */
export function stableStringify(value: unknown): string {
  const write = (v: unknown, indent: string): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    const inner = indent + '  ';
    // id lists (several strings) go one per line so concurrent additions merge cleanly
    const isFlat = Array.isArray(v) ? v.every((x) => x === null || typeof x !== 'object') && !(v.length > 1 && v.every((x) => typeof x === 'string')) : Object.values(v).every((x) => x === null || typeof x !== 'object');
    if (isFlat) {
      const flat = Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${JSON.stringify(x)}`).join(', ')}}`;
      if (flat.length <= 72) return flat;
    }
    if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => inner + write(x, inner)).join(',\n')}\n${indent}]` : '[]';
    const entries = Object.entries(v);
    return entries.length ? `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${write(x, inner)}`).join(',\n')}\n${indent}}` : '{}';
  };
  return write(plain(value), '') + '\n';
}

function reviveDates(_k: string, v: unknown): unknown {
  if (v && typeof v === 'object' && DATE_TAG in (v as object) && Object.keys(v as object).length === 1) return new Date((v as Record<string, string>)[DATE_TAG]);
  return v;
}

const parse = <T>(text: string, path: string): T => {
  try {
    return JSON.parse(text, reviveDates) as T;
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
};

// ---------------------------------------------------------------- split / join

/** File-system-safe, stable id fragment. */
export function slug(text: string): string {
  return (
    text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'item'
  );
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

/**
 * Split a report into files:
 *
 * ```
 * report.json                        name, version, report filters, page and bookmark order
 * pages/<page>/page.json             page settings and visual order
 * pages/<page>/visuals/<visual>.json one file per visual
 * bookmarks/<bookmark>.json          one file per bookmark
 * ```
 *
 * Pages and visuals without an `id` get one derived from their name or type, so the output is stable.
 */
export function splitReport(input: ReportDefinition | string): ReportFiles {
  const def = typeof input === 'string' ? migrateReport(input, reviveDates) : migrateReport(JSON.parse(JSON.stringify(plain(input)), reviveDates));
  const files: ReportFiles = {};
  const pageIds = new Set<string>();
  const pages: string[] = [];
  for (const page of def.pages) {
    const pid = uniqueId(page.id ? slug(page.id) === page.id ? page.id : slug(page.id) : slug(page.name), pageIds);
    pages.push(pid);
    const visualIds = new Set<string>();
    const order: string[] = [];
    page.visuals.forEach((v, i) => {
      const vid = uniqueId(v.id ? (slug(v.id) === v.id ? v.id : slug(v.id)) : `${slug(v.type)}-${i + 1}`, visualIds);
      order.push(vid);
      files[`pages/${pid}/visuals/${vid}.json`] = stableStringify({ ...v, id: v.id ?? vid });
    });
    const { visuals: _v, ...rest } = page;
    files[`pages/${pid}/page.json`] = stableStringify({ ...rest, id: page.id ?? pid, visuals: order });
  }
  const bookmarkIds = new Set<string>();
  const bookmarks = (def.bookmarks ?? []).map((b) => {
    const bid = uniqueId(slug(b.name), bookmarkIds);
    files[`bookmarks/${bid}.json`] = stableStringify(b);
    return bid;
  });
  const { pages: _p, bookmarks: _b, ...top } = def;
  files['report.json'] = stableStringify({ ...top, pages, ...(bookmarks.length ? { bookmarks } : {}) });
  return files;
}

/**
 * Rebuild a report from files made by {@link splitReport}. Tolerant of merges: files missing from an order list
 * are appended (sorted by path), and listed ids without a file are skipped.
 */
export function joinReport(files: ReportFiles): ReportDefinition {
  const norm: ReportFiles = {};
  for (const [k, v] of Object.entries(files)) norm[k.replace(/\\/g, '/').replace(/^\.\//, '')] = v;
  const rootText = norm['report.json'];
  if (rootText === undefined) throw new Error('report.json not found');
  const root = parse<Record<string, unknown> & { pages?: string[]; bookmarks?: string[] }>(rootText, 'report.json');
  const pageDirs = [...new Set(Object.keys(norm).map((p) => /^pages\/([^/]+)\/page\.json$/.exec(p)?.[1]).filter(Boolean) as string[])];
  const pageOrder = [...(root.pages ?? []).filter((p) => pageDirs.includes(p)), ...pageDirs.filter((p) => !(root.pages ?? []).includes(p)).sort()];
  const pages: PageDefinition[] = pageOrder.map((pid) => {
    const page = parse<PageDefinition & { visuals: unknown }>(norm[`pages/${pid}/page.json`], `pages/${pid}/page.json`);
    const prefix = `pages/${pid}/visuals/`;
    const available = Object.keys(norm)
      .filter((p) => p.startsWith(prefix) && p.endsWith('.json') && !p.slice(prefix.length).includes('/'))
      .map((p) => p.slice(prefix.length, -5));
    const listed = Array.isArray(page.visuals) ? (page.visuals as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    const order = [...listed.filter((v) => available.includes(v)), ...available.filter((v) => !listed.includes(v)).sort()];
    const visuals = order.map((vid) => parse<VisualSpec>(norm[`${prefix}${vid}.json`], `${prefix}${vid}.json`));
    return { ...page, visuals };
  });
  const bmFiles = Object.keys(norm)
    .map((p) => /^bookmarks\/([^/]+)\.json$/.exec(p)?.[1])
    .filter(Boolean) as string[];
  const bmOrder = [...(root.bookmarks ?? []).filter((b) => bmFiles.includes(b)), ...bmFiles.filter((b) => !(root.bookmarks ?? []).includes(b)).sort()];
  const bookmarks = bmOrder.map((b) => parse<Bookmark>(norm[`bookmarks/${b}.json`], `bookmarks/${b}.json`));
  const { pages: _p, bookmarks: _b, ...top } = root;
  return migrateReport({ ...top, pages, ...(bookmarks.length ? { bookmarks } : {}) });
}

// ---------------------------------------------------------------- diff

export interface ReportChange {
  kind: 'added' | 'removed' | 'changed' | 'moved';
  /** What changed, e.g. `page "Overview" › visual "Sales by category" › format.dataLabels.show`. */
  where: string;
  before?: unknown;
  after?: unknown;
}

const label = (kind: string, x: { id?: string; name?: string; title?: string; type?: string }) => `${kind} "${x.title ?? x.name ?? x.id ?? x.type ?? '?'}"`;

function idOf(x: { id?: string; name?: string }, i: number): string {
  return x.id ?? x.name ?? `#${i}`;
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(plain(a)) === JSON.stringify(plain(b));
}

/** Leaf-level differences between two plain values. */
function deep(a: unknown, b: unknown, path: string, out: ReportChange[], where: string): void {
  if (eq(a, b)) return;
  const isObj = (x: unknown) => x !== null && typeof x === 'object' && !Array.isArray(x) && !(x instanceof Date);
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])].sort();
    for (const k of keys) {
      const av = (a as Record<string, unknown>)[k];
      const bv = (b as Record<string, unknown>)[k];
      const p = path ? `${path}.${k}` : k;
      if (av === undefined && bv !== undefined) out.push({ kind: 'added', where: `${where} › ${p}`, after: bv });
      else if (av !== undefined && bv === undefined) out.push({ kind: 'removed', where: `${where} › ${p}`, before: av });
      else deep(av, bv, p, out, where);
    }
    return;
  }
  out.push({ kind: 'changed', where: path ? `${where} › ${path}` : where, before: a, after: b });
}

/** Keyed list diff (pages, visuals, bookmarks): added, removed, reordered, and per-item changes. */
function keyed<T extends { id?: string; name?: string }>(a: T[], b: T[], kind: string, where: string, out: ReportChange[], each: (x: T, y: T, w: string) => void): void {
  const ka = a.map(idOf);
  const kb = b.map(idOf);
  b.forEach((y, i) => {
    if (!ka.includes(kb[i])) out.push({ kind: 'added', where: `${where}${label(kind, y)}`, after: y });
  });
  a.forEach((x, i) => {
    if (!kb.includes(ka[i])) out.push({ kind: 'removed', where: `${where}${label(kind, x)}`, before: x });
  });
  const common = ka.filter((k) => kb.includes(k));
  const orderB = kb.filter((k) => ka.includes(k));
  if (common.join('\u0001') !== orderB.join('\u0001')) out.push({ kind: 'moved', where: `${where}${kind} order`, before: common, after: orderB });
  for (const k of common) {
    const x = a[ka.indexOf(k)];
    const y = b[kb.indexOf(k)];
    each(x, y, `${where}${label(kind, y)}`);
  }
}

/** Plain-language differences between two report versions (definitions or JSON). */
export function diffReports(before: ReportDefinition | string, after: ReportDefinition | string): ReportChange[] {
  const a = typeof before === 'string' ? migrateReport(before, reviveDates) : before;
  const b = typeof after === 'string' ? migrateReport(after, reviveDates) : after;
  const out: ReportChange[] = [];
  const { pages: pa, bookmarks: ba, ...ta } = a;
  const { pages: pb, bookmarks: bb, ...tb } = b;
  deep(ta, tb, '', out, 'report');
  keyed(pa, pb, 'page', '', out, (x, y, w) => {
    const { visuals: va, ...ra } = x;
    const { visuals: vb, ...rb } = y;
    deep(ra, rb, '', out, w);
    keyed(va, vb, 'visual', `${w} › `, out, (vx, vy, vw) => deep(vx, vy, '', out, vw));
  });
  keyed(ba ?? [], bb ?? [], 'bookmark', '', out, (x, y, w) => deep(x, y, '', out, w));
  return out;
}

const short = (v: unknown) => {
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(plain(v));
  return s === undefined ? 'undefined' : s.length > 60 ? `${s.slice(0, 57)}…` : s;
};

/** One line per change, for logs, CLIs and pull-request comments. */
export function formatDiff(changes: ReportChange[]): string {
  if (!changes.length) return 'No changes.';
  const sign = { added: '+', removed: '-', changed: '~', moved: '↕' } as const;
  return changes
    .map((c) => {
      const tail = c.kind === 'changed' || c.kind === 'moved' ? `: ${short(c.before)} → ${short(c.after)}` : c.kind === 'added' && !/^(page|visual|bookmark) "/.test(c.where.split(' › ').pop()!) ? ` = ${short(c.after)}` : '';
      return `${sign[c.kind]} ${c.where}${tail}`;
    })
    .join('\n');
}
