import type { DataModel } from '../data/model';
import type { Row } from '../data/types';
import { toRows } from './http';

/** Minimal interface of a Report for streaming pushdown without importing full Report runtime. */
export interface ReportLike {
  model: DataModel;
  pushData(table: string, rows: Row[], options?: { maxRows?: number; immediate?: boolean }): void;
}

export type StreamTarget = DataModel | ReportLike;

export type StreamConnectionState = 'connecting' | 'open' | 'closed' | 'reconnecting' | 'error';

/** Anything that delivers messages: a WebSocket, an EventSource, a BroadcastChannel, a worker port… */
export interface MessageSourceLike {
  addEventListener(type: string, fn: (e: any) => void): void;
  removeEventListener(type: string, fn: (e: any) => void): void;
  close?(): void;
  readyState?: number;
}

export interface ReconnectOptions {
  /** Whether automatic reconnection is enabled (default true when URL string is passed). */
  enabled?: boolean;
  /** Maximum reconnection attempts (default Infinity). */
  maxRetries?: number;
  /** Initial delay in ms before reconnection (default 1000). */
  delayMs?: number;
  /** Maximum delay in ms with exponential backoff (default 30000). */
  maxDelayMs?: number;
  /** Backoff multiplier (default 1.5). */
  backoffMultiplier?: number;
}

export interface StreamOptions {
  /** Turn one message into rows. Default: JSON-parse strings; accept a row object or an array of rows. */
  parse?: (data: unknown) => Row[] | Row | null | undefined;
  /** Optional row transform or filter predicate. Return null or undefined to discard row. */
  transform?: (row: Row) => Row | null | undefined;
  /** Sliding window: keep at most this many rows in the table. */
  maxRows?: number;
  /** Batch incoming rows and apply them at most this often (default 250 ms), so visuals re-render once per batch. */
  intervalMs?: number;
  /** When pushing to a Report, immediately render scheduled visual queries rather than waiting for next RAF. */
  immediate?: boolean;
  /** Automatic reconnection policy when connecting via URL string. */
  reconnect?: boolean | ReconnectOptions;
  /** Called when the connection status changes. */
  onStateChange?: (state: StreamConnectionState, detail?: unknown) => void;
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
  /** Current connection state. */
  readonly state: StreamConnectionState;
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

function resolveSource(url: string): MessageSourceLike {
  const g = globalThis as any;
  if (/^wss?:\/\//i.test(url)) {
    if (typeof g.WebSocket !== 'undefined') return new g.WebSocket(url);
    throw new Error(`WebSocket is not supported in this environment: ${url}`);
  }
  if (typeof g.EventSource !== 'undefined') return new g.EventSource(url);
  throw new Error(`EventSource is not supported in this environment: ${url}`);
}

/**
 * Append rows arriving on a message source (or WebSocket / EventSource URL) to `table` in a DataModel or Report.
 * Rows are batched (`intervalMs`) and the oldest are dropped beyond `maxRows`, so a live dashboard stays
 * bounded in memory and re-renders smoothly.
 */
export function streamInto(
  target: StreamTarget,
  table: string,
  source: MessageSourceLike | string,
  opts: StreamOptions = {}
): StreamHandle {
  const parse = opts.parse ?? defaultParse;
  const interval = opts.intervalMs ?? 250;
  let buffer: Row[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let received = 0;
  let closed = false;
  let state: StreamConnectionState = 'connecting';
  let activeSource: MessageSourceLike | undefined;
  let retryCount = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const isUrl = typeof source === 'string';
  const recOpts = typeof opts.reconnect === 'object' ? opts.reconnect : {};
  const allowReconnect = opts.reconnect === true || (opts.reconnect !== false && isUrl);
  const maxRetries = recOpts.maxRetries ?? Infinity;
  const initialDelay = recOpts.delayMs ?? 1000;
  const maxDelay = recOpts.maxDelayMs ?? 30000;
  const backoff = recOpts.backoffMultiplier ?? 1.5;

  const setState = (next: StreamConnectionState, detail?: unknown) => {
    state = next;
    opts.onStateChange?.(next, detail);
  };

  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    try {
      if (typeof (target as any).pushData === 'function') {
        (target as ReportLike).pushData(table, batch, {
          maxRows: opts.maxRows,
          immediate: opts.immediate,
        });
      } else {
        (target as DataModel).appendRows(table, batch, { maxRows: opts.maxRows });
      }
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
      const raw = Array.isArray(out) ? out : [out];
      const rows: Row[] = [];
      for (const r of raw) {
        const item = opts.transform ? opts.transform(r) : r;
        if (item) rows.push(item);
      }
      if (!rows.length) return;
      buffer.push(...rows);
      received += rows.length;
    } catch (err) {
      opts.onError?.(err);
      return;
    }
    if (interval <= 0) flush();
    else if (timer === undefined) timer = setTimeout(flush, interval);
  };

  const onOpen = () => {
    if (closed) return;
    retryCount = 0;
    setState('open');
  };

  const onError = (e: any) => {
    if (closed) return;
    opts.onError?.(e);
    if (isUrl && allowReconnect && retryCount < maxRetries && state !== 'reconnecting') {
      scheduleReconnect();
    }
  };

  const onClose = () => {
    if (closed) return;
    if (isUrl && allowReconnect && retryCount < maxRetries) {
      scheduleReconnect();
    } else {
      setState('closed');
    }
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== undefined) return;
    setState('reconnecting', { attempt: retryCount + 1 });
    const delay = Math.min(maxDelay, Math.round(initialDelay * Math.pow(backoff, retryCount++)));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  };

  const teardownActive = () => {
    if (!activeSource) return;
    activeSource.removeEventListener('message', onMessage);
    activeSource.removeEventListener('open', onOpen);
    activeSource.removeEventListener('error', onError);
    activeSource.removeEventListener('close', onClose);
    activeSource.close?.();
    activeSource = undefined;
  };

  const connect = () => {
    if (closed) return;
    teardownActive();
    try {
      activeSource = isUrl ? resolveSource(source as string) : (source as MessageSourceLike);
      activeSource.addEventListener('message', onMessage);
      activeSource.addEventListener('open', onOpen);
      activeSource.addEventListener('error', onError);
      activeSource.addEventListener('close', onClose);

      // If already open (e.g. mock or pre-opened source)
      if (activeSource.readyState === 1) {
        setState('open');
      } else {
        setState('connecting');
      }
    } catch (err) {
      opts.onError?.(err);
      if (isUrl && allowReconnect && retryCount < maxRetries) {
        scheduleReconnect();
      } else {
        setState('error', err);
      }
    }
  };

  connect();

  return {
    flush,
    close() {
      if (closed) return;
      flush();
      closed = true;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      teardownActive();
      setState('closed');
    },
    get received() {
      return received;
    },
    get state() {
      return state;
    },
  };
}

export interface RefreshOptions {
  /** Refresh period in milliseconds. */
  intervalMs: number;
  /** `replace` (default) swaps the table's rows; `append` adds them (use with `maxRows`); `incremental` applies the table's refresh policy. */
  mode?: 'replace' | 'append' | 'incremental';
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
export function scheduleRefresh(
  target: StreamTarget,
  table: string,
  load: (signal: AbortSignal) => Promise<Row[]>,
  opts: RefreshOptions
): RefreshHandle {
  let stopped = false;
  let running: AbortController | undefined;
  const doc = (globalThis as { document?: { hidden?: boolean } }).document;
  const model = 'model' in target ? target.model : target;

  const refresh = async () => {
    running?.abort();
    const ctrl = new AbortController();
    running = ctrl;
    try {
      const rows = await load(ctrl.signal);
      if (ctrl.signal.aborted || stopped) return;
      if (opts.mode === 'append') {
        if (typeof (target as any).pushData === 'function') {
          (target as ReportLike).pushData(table, rows, { maxRows: opts.maxRows, immediate: opts.immediate });
        } else {
          model.appendRows(table, rows, { maxRows: opts.maxRows });
        }
      } else if (opts.mode === 'incremental') {
        model.incrementalRefresh(table, rows);
      } else if (model.hasTable(table)) {
        model.refreshTable(table, rows);
      } else {
        model.addTable(table, rows);
      }
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
