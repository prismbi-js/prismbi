/**
 * PrismBI worker engine: run the model (data, DAX, queries) off the main thread.
 *
 * ```ts
 * // model.worker.ts
 * import { serveModel } from '@prismbi/prismbi/worker';
 * serveModel(buildModel());
 *
 * // main thread
 * const engine = createWorkerEngine(new Worker(new URL('./model.worker.ts', import.meta.url), { type: 'module' }));
 * const result = await engine.query({ groupBy: ['Product[Category]'], values: ['Total Sales'] });
 * ```
 */
import type { DataModel, AppendOptions } from './data/model';
import type { QueryResult, QuerySpec } from './data/query';
import type { CellValue, ColumnSchema, MeasureDef, Row } from './data/types';
import type { Filter, FilterSpec } from './data/filters';

/** Filters that can cross a thread boundary: public filter specs (compiled filters carry functions). */
export type PortableFilter = FilterSpec;

export interface EngineQueryResult extends Omit<QueryResult, 'baseFilters'> {
  /** The base filters as specs (compiled row-set filters cannot be transferred and are dropped). */
  baseFilters: PortableFilter[];
}

export interface Engine {
  query(spec: QuerySpec, signal?: AbortSignal): Promise<EngineQueryResult>;
  evaluate(expression: string, filters?: PortableFilter[], signal?: AbortSignal): Promise<CellValue>;
  evaluateTable(expression: string, filters?: PortableFilter[], signal?: AbortSignal): Promise<{ columns: string[]; rows: CellValue[][] }>;
  addTable(name: string, rows: Row[], schema?: Record<string, ColumnSchema>): Promise<void>;
  refreshTable(name: string, rows: Row[], schema?: Record<string, ColumnSchema>): Promise<void>;
  appendRows(name: string, rows: Row[], opts?: AppendOptions): Promise<void>;
  /**
   * Add (or replace) a table from columns. Numbers and dates travel as `Float64Array`s and text as `Int32Array`
   * codes plus a dictionary, whose buffers are transferred to the worker rather than copied (much faster than
   * `addTable` with row objects for large data). Typed arrays you pass are detached unless `transfer: false`;
   * arrays backed by a `SharedArrayBuffer` (when `crossOriginIsolated`) are shared, never copied.
   */
  addColumns(name: string, columns: Record<string, ArrayLike<unknown>>, schema?: Record<string, ColumnSchema>, opts?: { transfer?: boolean }): Promise<void>;
  addMeasure(def: MeasureDef): Promise<void>;
  setRoles(roles: string[] | null, opts?: { user?: string; customData?: string }): Promise<void>;
  /** Model metadata (tables, columns, measures, relationships – no rows). */
  metadata(): Promise<ReturnType<DataModel['toJSON']>>;
  /** Stop the engine (terminates a dedicated worker). */
  dispose(): void;
}

type Method = Exclude<keyof Engine, 'dispose'>;

/** Compiled filters → their specs. `strict` throws for filters without one (row sets, relationship modifiers). */
function portable(filters: readonly (FilterSpec | Filter)[], strict: boolean): PortableFilter[] {
  const out: PortableFilter[] = [];
  for (const f of filters) {
    if (!('kind' in f)) out.push(f);
    else if (f.kind === 'columns' && f.spec) out.push(f.spec);
    else if (strict) throw new Error('Only filter specs can be sent to an engine (got a compiled ' + f.kind + ' filter)');
  }
  return out;
}

/** A column ready to cross a thread boundary: typed arrays move without copying. */
export type PackedColumn =
  | { kind: 'number' | 'date'; data: Float64Array }
  | { kind: 'text'; codes: Int32Array; dict: string[] }
  | { kind: 'values'; values: unknown[] };

const isTyped = (a: unknown): a is ArrayLike<number> & ArrayBufferView => ArrayBuffer.isView(a) && !(a instanceof DataView);
const isShared = (a: ArrayBufferView) => typeof SharedArrayBuffer !== 'undefined' && a.buffer instanceof SharedArrayBuffer;

/** Pack one column: numbers and dates → Float64Array (NaN for blank), text → codes and a dictionary, else as is. */
export function packColumn(values: ArrayLike<unknown>, type?: ColumnSchema['type']): PackedColumn {
  if (isTyped(values) && type !== 'string' && type !== 'boolean') return { kind: type === 'date' ? 'date' : 'number', data: values instanceof Float64Array ? values : Float64Array.from(values) };
  const n = values.length;
  let first: unknown = null;
  for (let i = 0; i < n && (first === null || first === undefined || first === ''); i++) first = values[i];
  const want = type ?? (typeof first === 'number' ? 'number' : first instanceof Date ? 'date' : typeof first === 'string' ? 'string' : undefined);
  if (want === 'number' || want === 'date') {
    const data = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (v === null || v === undefined) data[i] = NaN;
      else if (want === 'number' && typeof v === 'number') data[i] = v;
      else if (want === 'date' && v instanceof Date) data[i] = v.getTime();
      else return { kind: 'values', values: Array.from(values) };
    }
    return { kind: want, data };
  }
  if (want === 'string') {
    const codes = new Int32Array(n);
    const dict: string[] = [];
    const seen = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (v === null || v === undefined || v === '') codes[i] = -1;
      else if (typeof v !== 'string') return { kind: 'values', values: Array.from(values) };
      else {
        let c = seen.get(v);
        if (c === undefined) seen.set(v, (c = dict.push(v) - 1));
        codes[i] = c;
      }
    }
    return { kind: 'text', codes, dict };
  }
  return { kind: 'values', values: Array.from(values) };
}

/** Buffers to transfer for packed columns (shared buffers are skipped: they are shared, not moved). */
function transferables(cols: Record<string, PackedColumn>): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const c of Object.values(cols)) {
    const a = c.kind === 'number' || c.kind === 'date' ? c.data : c.kind === 'text' ? c.codes : undefined;
    if (a && !isShared(a)) out.add(a.buffer as ArrayBuffer);
  }
  return [...out];
}

/** Add (or replace) a table from packed columns; the typed arrays become its numeric and dictionary views. */
export function addPackedTable(model: DataModel, name: string, cols: Record<string, PackedColumn>, schema: Record<string, ColumnSchema> = {}): void {
  const raw: Record<string, unknown[]> = {};
  const types: Record<string, ColumnSchema> = { ...schema };
  for (const [col, c] of Object.entries(cols)) {
    if (c.kind === 'values') raw[col] = c.values;
    else if (c.kind === 'text') {
      const { codes, dict } = c;
      const v = new Array<string | null>(codes.length);
      for (let i = 0; i < codes.length; i++) v[i] = codes[i] < 0 ? null : dict[codes[i]];
      raw[col] = v;
      types[col] = { ...schema[col], type: 'string' };
    } else {
      const d = c.data;
      const v = new Array<number | Date | null>(d.length);
      for (let i = 0; i < d.length; i++) v[i] = Number.isFinite(d[i]) ? (c.kind === 'date' ? new Date(d[i]) : d[i]) : null;
      raw[col] = v;
      types[col] = { ...schema[col], type: c.kind };
    }
  }
  const t = model.addColumns(name, raw, types).table(name);
  for (const [col, c] of Object.entries(cols)) {
    if (c.kind === 'text') t.adoptViews(col, { codes: c.codes, dict: c.dict });
    else if (c.kind !== 'values') {
      // blanks (and infinities, which load as blank) are NaN in the numeric view; copy rather than change the sender's array
      let d = c.data;
      for (let i = 0; i < d.length; i++)
        if (d[i] === Infinity || d[i] === -Infinity) {
          if (d === c.data) d = d.slice();
          d[i] = NaN;
        }
      t.adoptViews(col, { numeric: d });
    }
  }
}

/** Run one engine call against a model (shared by the worker server and the in-process engine). */
function dispatch(model: DataModel, method: Method, args: unknown[]): unknown {
  switch (method) {
    case 'query': {
      const r = model.query(args[0] as QuerySpec);
      return { ...r, baseFilters: portable(r.baseFilters, false) };
    }
    case 'evaluate':
      return model.evaluate(args[0] as string, (args[1] as FilterSpec[]) ?? []);
    case 'evaluateTable': {
      const { columns, rows } = model.evaluateTable(args[0] as string, (args[1] as FilterSpec[]) ?? []);
      return { columns, rows };
    }
    case 'addTable':
      model.addTable(args[0] as string, args[1] as Row[], args[2] as Record<string, ColumnSchema>);
      return undefined;
    case 'refreshTable':
      model.refreshTable(args[0] as string, args[1] as Row[], args[2] as Record<string, ColumnSchema>);
      return undefined;
    case 'appendRows':
      model.appendRows(args[0] as string, args[1] as Row[], args[2] as AppendOptions);
      return undefined;
    case 'addColumns':
      addPackedTable(model, args[0] as string, args[1] as Record<string, PackedColumn>, args[2] as Record<string, ColumnSchema>);
      return undefined;
    case 'addMeasure':
      model.addMeasure(args[0] as MeasureDef);
      return undefined;
    case 'setRoles':
      model.setRoles(args[0] as string[] | null, args[1] as { user?: string });
      return undefined;
    case 'metadata':
      return JSON.parse(JSON.stringify(model.toJSON()));
  }
  throw new Error(`Unknown engine method "${String(method)}"`);
}

function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

/** Same API as the worker engine, running on the current thread (tests, SSR, small models). */
export function createLocalEngine(model: DataModel): Engine {
  const call = (method: Method, args: unknown[], signal?: AbortSignal) =>
    new Promise<never>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      // yield first so callers can cancel superseded requests, like with a worker
      setTimeout(() => {
        if (signal?.aborted) return reject(abortError());
        try {
          resolve(dispatch(model, method, args) as never);
        } catch (e) {
          reject(e);
        }
      }, 0);
    });
  return build(call, () => undefined);
}

/** The subset of `Worker` / `MessagePort` / worker `self` used for messaging. */
export interface PortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
  removeEventListener?(type: 'message', fn: (e: { data: unknown }) => void): void;
  start?(): void;
  terminate?(): void;
}

interface Request {
  id: number;
  method: Method | 'cancel';
  args: unknown[];
}

interface Response {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: { name: string; message: string };
}

/**
 * Answer engine calls for `model` on a port – inside a worker call `serveModel(model)`.
 * Requests run one at a time in arrival order; cancelled requests that have not started are skipped.
 */
export function serveModel(model: DataModel, port: PortLike = globalThis as unknown as PortLike): () => void {
  const queue: Request[] = [];
  const cancelled = new Set<number>();
  let scheduled = false;
  const pump = () => {
    scheduled = false;
    const req = queue.shift();
    if (!req) return;
    if (cancelled.delete(req.id)) port.postMessage({ id: req.id, ok: false, error: { name: 'AbortError', message: 'The operation was aborted' } } satisfies Response);
    else {
      try {
        port.postMessage({ id: req.id, ok: true, value: dispatch(model, req.method as Method, req.args) } satisfies Response);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        port.postMessage({ id: req.id, ok: false, error: { name: err.name, message: err.message } } satisfies Response);
      }
    }
    // one request per task so cancel messages are seen between requests
    if (queue.length) schedule();
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(pump, 0);
  };
  const onMessage = (e: { data: unknown }) => {
    const req = e.data as Request;
    if (!req || typeof req.id !== 'number') return;
    if (req.method === 'cancel') {
      cancelled.add(req.args[0] as number);
      return;
    }
    queue.push(req);
    schedule();
  };
  port.addEventListener('message', onMessage);
  port.start?.();
  return () => port.removeEventListener?.('message', onMessage);
}

/** Talk to a model served with `serveModel` in a Worker (or on any MessagePort). */
export function createWorkerEngine(port: PortLike): Engine {
  let seq = 0;
  const pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
  const onMessage = (e: { data: unknown }) => {
    const res = e.data as Response;
    const p = pending.get(res?.id);
    if (!p) return;
    pending.delete(res.id);
    if (res.ok) p.resolve(res.value as never);
    else {
      const err = new Error(res.error?.message ?? 'Engine error');
      err.name = res.error?.name ?? 'Error';
      p.reject(err);
    }
  };
  port.addEventListener('message', onMessage);
  port.start?.();
  const call = (method: Method, args: unknown[], signal?: AbortSignal, transfer?: Transferable[]) =>
    new Promise<never>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const id = ++seq;
      pending.set(id, { resolve, reject });
      signal?.addEventListener(
        'abort',
        () => {
          if (!pending.delete(id)) return;
          port.postMessage({ id: ++seq, method: 'cancel', args: [id] } satisfies Request);
          reject(abortError());
        },
        { once: true },
      );
      if (transfer?.length) port.postMessage({ id, method, args } satisfies Request, transfer);
      else port.postMessage({ id, method, args } satisfies Request);
    });
  return build(call, () => {
    port.removeEventListener?.('message', onMessage);
    for (const p of pending.values()) p.reject(abortError());
    pending.clear();
    port.terminate?.();
  });
}

function build(call: (method: Method, args: unknown[], signal?: AbortSignal, transfer?: Transferable[]) => Promise<never>, dispose: () => void): Engine {
  return {
    query: (spec, signal) => {
      try {
        return call('query', [{ ...spec, filters: spec.filters && portable(spec.filters, true), highlight: spec.highlight && portable(spec.highlight, true) }], signal);
      } catch (e) {
        return Promise.reject(e);
      }
    },
    evaluate: (expression, filters = [], signal) => call('evaluate', [expression, filters], signal),
    evaluateTable: (expression, filters = [], signal) => call('evaluateTable', [expression, filters], signal),
    addTable: (name, rows, schema) => call('addTable', [name, rows, schema]),
    refreshTable: (name, rows, schema) => call('refreshTable', [name, rows, schema]),
    appendRows: (name, rows, opts) => call('appendRows', [name, rows, opts]),
    addColumns: (name, columns, schema, opts) => {
      const packed: Record<string, PackedColumn> = {};
      for (const [col, values] of Object.entries(columns)) {
        let p = packColumn(values, schema?.[col]?.type);
        // keep the caller's typed arrays usable when asked to (a copy is transferred instead)
        if (opts?.transfer === false && (p.kind === 'number' || p.kind === 'date') && p.data === values && !isShared(p.data)) p = { kind: p.kind, data: p.data.slice() };
        packed[col] = p;
      }
      return call('addColumns', [name, packed, schema], undefined, transferables(packed));
    },
    addMeasure: (def) => call('addMeasure', [def]),
    setRoles: (roles, opts) => call('setRoles', [roles, opts]),
    metadata: () => call('metadata', []),
    dispose,
  };
}
