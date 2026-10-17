import type { DataModel } from '../data/model';
import type { Row } from '../data/types';
import { toRows } from './http';

/** Anything that delivers messages: a WebSocket, an EventSource, a BroadcastChannel, a worker port… */
export interface MessageSourceLike {
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
  removeEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
  close?(): void;
}

export interface StreamOptions {
  /** Turn one message into rows. Default: JSON-parse strings; accept a row object or an array of rows. */
  parse?: (data: unknown) => Row[] | Row | null | undefined;
  /** Sliding window: keep at most this many rows in the table. */
  maxRows?: number;
  /** Batch incoming rows and apply them at most this often (default 250 ms), so visuals re-render once per batch. */
  intervalMs?: number;
  /** Called after each batch is appended. */
  onBatch?: (rows: Row[]) => void;
  onError?: (error: unknown) => void;
}

export interface StreamHandle {
  /** Apply buffered rows now. */
  flush(): void;
  /** Stop listening (and close the source if it supports it). */
  close(): void;
  /** Rows received so far. */
  readonly received: number;
}

function defaultParse(data: unknown): Row[] | Row | null {
  const v = typeof data === 'string' ? JSON.parse(data) : data;
  if (Array.isArray(v)) return v as Row[];
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    // { rows: [...] } envelopes and column-oriented payloads
    if (Array.isArray(o.rows)) return o.rows as Row[];
    if (Object.values(o).length && Object.values(o).every(Array.isArray)) return toRows(o);
    return o;
  }
  return null;
}

/**
 * Append rows arriving on a message source to `table`. Rows are batched (`intervalMs`) and the oldest are dropped
 * beyond `maxRows`, so a live dashboard stays bounded in memory and re-renders at a steady rate.
 */
export function streamInto(model: DataModel, table: string, source: MessageSourceLike, opts: StreamOptions = {}): StreamHandle {
  const parse = opts.parse ?? defaultParse;
  const interval = opts.intervalMs ?? 250;
  let buffer: Row[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let received = 0;
  let closed = false;

  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    try {
      model.appendRows(table, batch, { maxRows: opts.maxRows });
      opts.onBatch?.(batch);
    } catch (e) {
      opts.onError?.(e);
    }
  };

  const onMessage = (e: { data: unknown }) => {
    if (closed) return;
    try {
      const out = parse(e.data);
      if (!out) return;
      const rows = Array.isArray(out) ? out : [out];
      buffer.push(...rows);
      received += rows.length;
    } catch (err) {
      opts.onError?.(err);
      return;
    }
    if (interval <= 0) flush();
    else if (timer === undefined) timer = setTimeout(flush, interval);
  };

  source.addEventListener('message', onMessage);
  return {
    flush,
    close() {
      if (closed) return;
      flush();
      closed = true;
      source.removeEventListener('message', onMessage);
      source.close?.();
    },
    get received() {
      return received;
    },
  };
}

export interface RefreshOptions {
  /** Refresh period in milliseconds. */
  intervalMs: number;
  /** `replace` (default) swaps the table's rows; `append` adds them (use with `maxRows`). */
  mode?: 'replace' | 'append';
  maxRows?: number;
  /** Load once immediately (default true). */
  immediate?: boolean;
  /** Skip refreshes while the page is hidden (default true). */
  pauseWhenHidden?: boolean;
  onRefresh?: (rows: Row[]) => void;
  onError?: (error: unknown) => void;
}

export interface RefreshHandle {
  /** Run a refresh now (resolves when the table is updated). */
  refresh(): Promise<void>;
  stop(): void;
}

/** Periodically reload a table from any async loader (`() => loadCsv(url)`, `() => loadRest(api)`, a SQL query…). */
export function scheduleRefresh(model: DataModel, table: string, load: (signal: AbortSignal) => Promise<Row[]>, opts: RefreshOptions): RefreshHandle {
  let stopped = false;
  let running: AbortController | undefined;
  const doc = (globalThis as { document?: { hidden?: boolean } }).document;

  const refresh = async () => {
    running?.abort();
    const ctrl = new AbortController();
    running = ctrl;
    try {
      const rows = await load(ctrl.signal);
      if (ctrl.signal.aborted || stopped) return;
      if (opts.mode === 'append') model.appendRows(table, rows, { maxRows: opts.maxRows });
      else if (model.hasTable(table)) model.refreshTable(table, rows);
      else model.addTable(table, rows);
      opts.onRefresh?.(rows);
    } catch (e) {
      if (!ctrl.signal.aborted) opts.onError?.(e);
    } finally {
      if (running === ctrl) running = undefined;
    }
  };

  const timer = setInterval(() => {
    if (stopped || running) return;
    if ((opts.pauseWhenHidden ?? true) && doc?.hidden) return;
    void refresh();
  }, opts.intervalMs);
  if (opts.immediate ?? true) void refresh();

  return {
    refresh,
    stop() {
      stopped = true;
      clearInterval(timer);
      running?.abort();
    },
  };
}
