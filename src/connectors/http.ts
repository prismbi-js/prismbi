import type { Row } from '../data/types';

export interface FetchOptions {
  /** Extra request headers (auth tokens etc.). */
  headers?: Record<string, string>;
  /** Cancel the request. */
  signal?: AbortSignal;
  /** Custom fetch implementation (tests, proxies, node < 18). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

function getFetch(opts: FetchOptions): typeof fetch {
  const f = opts.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
  if (!f) throw new Error('No fetch implementation available; pass `fetch` in the options');
  return f;
}

async function request(url: string, opts: FetchOptions, init: RequestInit = {}): Promise<Response> {
  const res = await getFetch(opts)(url, { ...init, headers: { ...opts.headers, ...(init.headers as Record<string, string>) }, signal: opts.signal });
  if (!res.ok) throw new Error(`Request to ${url} failed: ${res.status} ${res.statusText}`);
  return res;
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  return (await request(url, opts)).text();
}

/**
 * Read a value at a dotted path, e.g. `data.items` or `results.0.rows`.
 * An empty path returns the value itself.
 */
export function pick(value: unknown, path?: string): unknown {
  if (!path) return value;
  let cur = value;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Turn JSON into rows: an array of objects, an array of arrays (first = header) or column arrays `{ a: [...], b: [...] }`. */
export function toRows(value: unknown, what = 'JSON'): Row[] {
  if (Array.isArray(value)) {
    if (value.length && Array.isArray(value[0])) {
      const [head, ...rest] = value as unknown[][];
      return rest.map((r) => Object.fromEntries(head.map((h, i) => [String(h), r[i] ?? null])) as Row);
    }
    return value as Row[];
  }
  if (value && typeof value === 'object') {
    const cols = Object.entries(value as Record<string, unknown>);
    if (cols.length && cols.every(([, v]) => Array.isArray(v))) {
      const n = Math.max(...cols.map(([, v]) => (v as unknown[]).length));
      return Array.from({ length: n }, (_, i) => Object.fromEntries(cols.map(([k, v]) => [k, (v as unknown[])[i] ?? null])) as Row);
    }
  }
  throw new Error(`${what} did not contain rows (expected an array of objects); use \`path\` to point at the array`);
}

export interface JsonOptions extends FetchOptions {
  /** Dotted path to the rows inside the response, e.g. `data.items`. */
  path?: string;
}

/** Fetch JSON and return its rows. */
export async function loadJson(url: string, opts: JsonOptions = {}): Promise<Row[]> {
  return toRows(pick(await (await request(url, opts)).json(), opts.path), url);
}

export type Pagination =
  /** `?page=1`, `?page=2`, … until a page comes back short or empty. */
  | { type: 'page'; param?: string; sizeParam?: string; size?: number; start?: number }
  /** `?offset=0&limit=100`, … */
  | { type: 'offset'; param?: string; limitParam?: string; limit?: number }
  /** Follow a cursor read from the response (`next` path) and sent back as `param`. */
  | { type: 'cursor'; next: string; param?: string }
  /** Follow a next-page URL found in the response body (`next` path) or the `Link: <…>; rel="next"` header. */
  | { type: 'link'; next?: string };

export interface RestOptions extends JsonOptions {
  /** Query-string parameters added to every request. */
  params?: Record<string, string | number | boolean>;
  pagination?: Pagination;
  /** Safety stop for pagination (default 1000 pages). */
  maxPages?: number;
  /** Stop once this many rows were read. */
  maxRows?: number;
  /** Map each raw record to a row (rename / flatten fields). */
  map?: (record: Record<string, unknown>) => Row;
}

function withParams(url: string, params: Record<string, string | number | boolean | undefined>): string {
  const u = new URL(url, (globalThis as { location?: { href: string } }).location?.href ?? 'http://localhost/');
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, String(v));
  return /^[a-z]+:\/\//i.test(url) ? u.toString() : u.pathname + u.search + u.hash;
}

function linkNext(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part);
    if (m) return m[1];
  }
  return undefined;
}

/** Read every page of a REST endpoint into rows. */
export async function loadRest(url: string, opts: RestOptions = {}): Promise<Row[]> {
  const p = opts.pagination;
  const maxPages = opts.maxPages ?? 1000;
  const rows: Row[] = [];
  let next: string | undefined = withParams(url, opts.params ?? {});
  let page = p?.type === 'page' ? (p.start ?? 1) : 0;
  let offset = 0;
  for (let i = 0; next && i < maxPages; i++) {
    let target = next;
    if (p?.type === 'page') target = withParams(next, { [p.param ?? 'page']: page, ...(p.size ? { [p.sizeParam ?? 'per_page']: p.size } : {}) });
    if (p?.type === 'offset') target = withParams(next, { [p.param ?? 'offset']: offset, [p.limitParam ?? 'limit']: p.limit ?? 100 });
    const res = await request(target, opts);
    const body = await res.json();
    const batch = toRows(pick(body, opts.path), target);
    for (const r of batch) rows.push(opts.map ? opts.map(r as Record<string, unknown>) : r);
    if (opts.maxRows !== undefined && rows.length >= opts.maxRows) return rows.slice(0, opts.maxRows);
    if (!p || !batch.length) break;
    switch (p.type) {
      case 'page':
        if (p.size && batch.length < p.size) return rows;
        page++;
        break;
      case 'offset':
        if (batch.length < (p.limit ?? 100)) return rows;
        offset += batch.length;
        break;
      case 'cursor': {
        const cursor = pick(body, p.next);
        if (cursor === null || cursor === undefined || cursor === '') return rows;
        next = withParams(url, { ...opts.params, [p.param ?? 'cursor']: String(cursor) });
        break;
      }
      case 'link': {
        const n = p.next ? pick(body, p.next) : linkNext(res.headers.get('link'));
        next = typeof n === 'string' && n ? n : undefined;
        break;
      }
    }
  }
  return rows;
}

export interface GraphQLOptions extends FetchOptions {
  variables?: Record<string, unknown>;
  /** Dotted path to the rows inside `data`, e.g. `orders.nodes`. */
  path?: string;
}

/** Run a GraphQL query and return the rows found at `path` inside `data`. */
export async function loadGraphQL(url: string, query: string, opts: GraphQLOptions = {}): Promise<Row[]> {
  const res = await request(url, opts, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables: opts.variables ?? {} }) });
  const body = (await res.json()) as { data?: unknown; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(`GraphQL error: ${body.errors.map((e) => e.message).join('; ')}`);
  return toRows(pick(body.data, opts.path), 'GraphQL response');
}
