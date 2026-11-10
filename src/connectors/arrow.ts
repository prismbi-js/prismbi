import type { DataModel } from '../data/model';
import type { ColumnSchema, Row } from '../data/types';
import type { MessageSourceLike, ReconnectOptions, StreamConnectionState, StreamHandle, StreamTarget } from './stream';

export interface ArrowVectorLike {
  get(i: number): unknown;
  toArray?(): ArrayLike<unknown>;
  nullCount?: number;
  isValid?(i: number): boolean;
}

/** The parts of an Apache Arrow `Table` (apache-arrow ≥ 9) that PrismBI reads – no dependency on the package. */
export interface ArrowTableLike {
  numRows: number;
  schema: { fields: { name: string; type: { typeId: number } }[] };
  getChild(name: string): ArrowVectorLike | null;
}

// Arrow Type ids (apache-arrow `Type` enum)
const DATE = 8;
const TIMESTAMP = 10;

function cell(v: unknown, temporal: boolean): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') v = Number(v);
  if (temporal && typeof v === 'number') return new Date(v);
  // structs, lists, decimals
  if (typeof v === 'object' && v !== null && !(v instanceof Date)) {
    const j = (v as { toJSON?: () => unknown }).toJSON;
    return j ? JSON.stringify(j.call(v)) : String(v);
  }
  return v;
}

/** Convert an Arrow table into plain column arrays (BigInt → number, dates/timestamps → Date). */
export function arrowColumns(table: ArrowTableLike): Record<string, unknown[]> {
  const cols: Record<string, unknown[]> = {};
  for (const f of table.schema.fields) {
    const vec = table.getChild(f.name);
    if (!vec) continue;
    const temporal = f.type.typeId === DATE || f.type.typeId === TIMESTAMP;
    const out = new Array(table.numRows);
    for (let i = 0; i < table.numRows; i++) out[i] = cell(vec.get(i), temporal);
    cols[f.name] = out;
  }
  return cols;
}

/** Add (or replace) a model table from an Arrow table, e.g. one read from Parquet with DuckDB-Wasm. */
export function addArrowTable(model: DataModel, name: string, table: ArrowTableLike, schema?: Record<string, ColumnSchema>): DataModel {
  const cols = arrowColumns(table);
  return model.hasTable(name) ? model.refreshColumns(name, cols, schema) : model.addColumns(name, cols, schema);
}

/** Minimal DuckDB connection interface (compatible with DuckDB-Wasm and DuckDB Node bindings). */
export interface DuckDbConnectionLike {
  query(sql: string): Promise<ArrowTableLike | unknown>;
}

export interface DuckDbTableSpec {
  /** Target table name in the DataModel. */
  table: string;
  /** Custom SQL query to execute. Defaults to `SELECT * FROM "${table}"` or `SELECT * FROM read_parquet('${parquet}')`. */
  query?: string;
  /** Path or URL to a Parquet file (e.g. `'data.parquet'` or `'https://.../data.parquet'`). */
  parquet?: string;
  /** Optional column schemas (types, formats, hidden, sortBy). */
  schema?: Record<string, ColumnSchema>;
}

/**
 * Ingest a table directly from DuckDB-Wasm or a Parquet file into the DataModel's columnar storage.
 * If `spec.parquet` is provided, executes `SELECT * FROM read_parquet('...')`.
 */
export async function loadDuckDbTable(
  model: DataModel,
  conn: DuckDbConnectionLike,
  spec: DuckDbTableSpec
): Promise<DataModel> {
  const sql = spec.query ?? (spec.parquet ? `SELECT * FROM read_parquet('${spec.parquet.replace(/'/g, "''")}')` : `SELECT * FROM "${spec.table.replace(/"/g, '""')}"`);
  const res = await conn.query(sql);
  if (res && typeof res === 'object' && 'schema' in res && 'numRows' in res && typeof (res as ArrowTableLike).getChild === 'function') {
    return addArrowTable(model, spec.table, res as ArrowTableLike, spec.schema);
  }
  const rows = Array.isArray(res) ? res : ((res as { toArray?: () => unknown[] })?.toArray?.() ?? []);
  const jsonRows = rows.map((r) => (r && typeof r === 'object' && 'toJSON' in r && typeof (r as { toJSON: unknown }).toJSON === 'function' ? (r as { toJSON: () => Row }).toJSON() : (r as Row)));
  return model.hasTable(spec.table) ? model.refreshTable(spec.table, jsonRows, spec.schema) : model.addTable(spec.table, jsonRows, spec.schema);
}

/** Ingest multiple tables or Parquet files from DuckDB-Wasm in parallel. */
export async function loadDuckDbTables(
  model: DataModel,
  conn: DuckDbConnectionLike,
  specs: DuckDbTableSpec[]
): Promise<DataModel> {
  await Promise.all(specs.map((s) => loadDuckDbTable(model, conn, s)));
  return model;
}

export type ArrowSourceLike = MessageSourceLike | string | AsyncIterable<ArrowTableLike>;

export interface StreamArrowOptions {
  /** Sliding window: keep at most this many rows in the table. */
  maxRows?: number;
  /** Batch incoming arrow chunks and apply them at most this often (default 0 for immediate apply, or >0 ms to batch). */
  intervalMs?: number;
  /** When pushing to a Report, immediately render scheduled visual queries. */
  immediate?: boolean;
  /** Column schema overrides if table does not yet exist. */
  schema?: Record<string, ColumnSchema>;
  /** Automatic reconnection policy when connecting via URL string. */
  reconnect?: boolean | ReconnectOptions;
  /** Custom parser for raw binary/string message events (e.g. from Arrow IPC tableFromIPC). */
  parse?: (data: unknown) => ArrowTableLike | null | undefined;
  /** Called when the connection status changes. */
  onStateChange?: (state: StreamConnectionState, detail?: unknown) => void;
  /** Called after each Arrow batch is ingested. */
  onBatch?: (cols: Record<string, unknown[]>, count: number) => void;
  onError?: (error: unknown) => void;
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
 * Stream Arrow RecordBatches / Tables directly into columnar storage in a DataModel or Report.
 * Accepts an AsyncIterable of Arrow tables, a WebSocket, an EventSource, or an SSE/WS URL string.
 */
export function streamArrow(
  target: StreamTarget,
  table: string,
  source: ArrowSourceLike,
  opts: StreamArrowOptions = {}
): StreamHandle {
  const interval = opts.intervalMs ?? 0;
  let bufferCols: Record<string, unknown[]> = {};
  let bufferCount = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let received = 0;
  let closed = false;
  let state: StreamConnectionState = 'connecting';
  let activeSource: MessageSourceLike | undefined;
  let retryCount = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const isAsyncIterable = typeof source === 'object' && source !== null && Symbol.asyncIterator in source;
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

  const applyBuffered = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (bufferCount <= 0) return;
    const colsToApply = bufferCols;
    const countToApply = bufferCount;
    bufferCols = {};
    bufferCount = 0;

    try {
      const m: DataModel = (target as any).model ?? (target as DataModel);
      if (!m.hasTable(table)) {
        m.addColumns(table, colsToApply, opts.schema);
        if (typeof (target as any).flush === 'function' && opts.immediate) {
          (target as any).flush();
        }
      } else {
        if (typeof (target as any).pushColumns === 'function') {
          (target as any).pushColumns(table, colsToApply, {
            maxRows: opts.maxRows,
            immediate: opts.immediate,
          });
        } else {
          m.appendColumns(table, colsToApply, { maxRows: opts.maxRows });
          if (typeof (target as any).flush === 'function' && opts.immediate) {
            (target as any).flush();
          }
        }
      }
      opts.onBatch?.(colsToApply, countToApply);
    } catch (e) {
      opts.onError?.(e);
    }
  };

  const processChunk = (chunk: ArrowTableLike) => {
    const cols = arrowColumns(chunk);
    const count = chunk.numRows;
    if (count <= 0) return;
    received += count;

    for (const [k, v] of Object.entries(cols)) {
      if (!bufferCols[k]) bufferCols[k] = [];
      bufferCols[k].push(...v);
    }
    bufferCount += count;

    if (interval <= 0) applyBuffered();
    else if (timer === undefined) timer = setTimeout(applyBuffered, interval);
  };

  const onMessage = (e: { data: unknown }) => {
    if (closed) return;
    try {
      const chunk = opts.parse ? opts.parse(e.data) : (e.data as ArrowTableLike);
      if (!chunk || typeof chunk !== 'object' || !('schema' in chunk) || !('numRows' in chunk)) return;
      processChunk(chunk);
    } catch (err) {
      opts.onError?.(err);
    }
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

  if (isAsyncIterable) {
    setState('open');
    (async () => {
      try {
        for await (const chunk of source as AsyncIterable<ArrowTableLike>) {
          if (closed) break;
          processChunk(chunk);
        }
        if (!closed) {
          applyBuffered();
          setState('closed');
        }
      } catch (err) {
        if (!closed) {
          opts.onError?.(err);
          setState('error', err);
        }
      }
    })();
  } else {
    connect();
  }

  return {
    flush: applyBuffered,
    close() {
      if (closed) return;
      applyBuffered();
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
