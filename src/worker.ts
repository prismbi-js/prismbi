/**
 * PrismBI worker engine: run the model (data, DAX, queries) off the main thread.
 *
 * ```ts
 * // model.worker.ts
 * import { serveModel } from 'prismbi/worker';
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
  postMessage(message: unknown): void;
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
  const call = (method: Method, args: unknown[], signal?: AbortSignal) =>
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
      port.postMessage({ id, method, args } satisfies Request);
    });
  return build(call, () => {
    port.removeEventListener?.('message', onMessage);
    for (const p of pending.values()) p.reject(abortError());
    pending.clear();
    port.terminate?.();
  });
}

function build(call: (method: Method, args: unknown[], signal?: AbortSignal) => Promise<never>, dispose: () => void): Engine {
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
    addMeasure: (def) => call('addMeasure', [def]),
    setRoles: (roles, opts) => call('setRoles', [roles, opts]),
    metadata: () => call('metadata', []),
    dispose,
  };
}
