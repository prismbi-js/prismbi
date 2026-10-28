import type { ColumnSchema, Row } from '../data/types';
import { fetchText, type FetchOptions } from './http';

export interface CsvOptions {
  /** Field delimiter. Detected from the first line (`,` `;` tab `|`) when omitted. */
  delimiter?: string;
  /** First row holds column names (default true). Otherwise columns are named `Column1`, `Column2`, … */
  header?: boolean;
  /** Convert numeric / boolean columns (default true). Dates are typed by the table itself. */
  dynamicTyping?: boolean;
  /** Skip lines that are completely empty (default true). */
  skipEmptyLines?: boolean;
  /** Stop after this many data rows. */
  maxRows?: number;
}

export interface CsvColumnsResult {
  columns: Record<string, unknown[]>;
  schema: Record<string, ColumnSchema>;
  rowCount: number;
}

export interface StreamCsvOptions extends CsvOptions, FetchOptions {
  batchSize?: number;
  onBatch?: (batch: { columns: Record<string, unknown[]>; rows: Row[]; rowCount: number }) => void;
}

const CANDIDATES = [',', ';', '\t', '|'];

/** Pick the delimiter that occurs most often (outside quotes) in the first line. */
export function detectDelimiter(text: string): string {
  const end = text.indexOf('\n');
  const line = end < 0 ? text : text.slice(0, end);
  let best = ',';
  let bestCount = 0;
  for (const d of CANDIDATES) {
    let n = 0;
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === d) n++;
    }
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

/** Split CSV text into records of raw strings (RFC 4180: quoted fields, escaped quotes, embedded newlines). */
export function parseCsvRecords(text: string, delimiter = detectDelimiter(text), maxRecords = Infinity): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // byte-order mark
  const n = text.length;
  const endRow = () => {
    row.push(field);
    out.push(row);
    row = [];
    field = '';
  };
  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      endRow();
      if (out.length >= maxRecords) return out;
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else field += ch;
    i++;
  }
  if (field !== '' || row.length) endRow();
  return out;
}

const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/** A column is numeric when every non-empty value is a plain number without a significant leading zero (ZIP codes stay text). */
function columnKind(values: string[]): 'number' | 'boolean' | 'text' {
  let seen = false;
  let num = true;
  let bool = true;
  for (const v of values) {
    if (v === '') continue;
    seen = true;
    if (num && (!NUMBER.test(v) || /^[-+]?0\d/.test(v))) num = false;
    if (bool && !/^(true|false)$/i.test(v)) bool = false;
    if (!num && !bool) return 'text';
  }
  return !seen ? 'text' : num ? 'number' : bool ? 'boolean' : 'text';
}

/** Parse CSV text into rows ready for `model.addTable`. */
export function parseCsv(text: string, opts: CsvOptions = {}): Row[] {
  const records = parseCsvRecords(text, opts.delimiter ?? detectDelimiter(text));
  const skip = opts.skipEmptyLines ?? true;
  const recs = skip ? records.filter((r) => !(r.length === 1 && r[0] === '')) : records;
  if (!recs.length) return [];
  const header = opts.header ?? true;
  const width = Math.max(...recs.map((r) => r.length));
  const names = header ? uniqueNames(recs[0], width) : Array.from({ length: width }, (_, i) => `Column${i + 1}`);
  let data = header ? recs.slice(1) : recs;
  if (opts.maxRows !== undefined) data = data.slice(0, opts.maxRows);
  const kinds = names.map((_, c) => (opts.dynamicTyping === false ? 'text' : columnKind(data.map((r) => r[c] ?? ''))));
  return data.map((r) => {
    const row: Row = {};
    names.forEach((name, c) => {
      const v = r[c] ?? '';
      row[name] = v === '' ? null : kinds[c] === 'number' ? Number(v) : kinds[c] === 'boolean' ? v.toLowerCase() === 'true' : v;
    });
    return row;
  });
}

function uniqueNames(raw: string[], width: number): string[] {
  const seen = new Map<string, number>();
  return Array.from({ length: width }, (_, i) => {
    const base = (raw[i] ?? '').trim() || `Column${i + 1}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}_${n + 1}` : base;
  });
}

/** Parse CSV text directly into columnar arrays without intermediate row objects. */
export function parseCsvColumns(text: string, opts: CsvOptions = {}): CsvColumnsResult {
  const records = parseCsvRecords(text, opts.delimiter ?? detectDelimiter(text));
  const skip = opts.skipEmptyLines ?? true;
  const recs = skip ? records.filter((r) => !(r.length === 1 && r[0] === '')) : records;
  if (!recs.length) return { columns: {}, schema: {}, rowCount: 0 };
  const header = opts.header ?? true;
  const width = Math.max(...recs.map((r) => r.length));
  const names = header ? uniqueNames(recs[0], width) : Array.from({ length: width }, (_, i) => `Column${i + 1}`);
  let data = header ? recs.slice(1) : recs;
  if (opts.maxRows !== undefined) data = data.slice(0, opts.maxRows);
  const rowCount = data.length;
  const kinds = names.map((_, c) => (opts.dynamicTyping === false ? 'text' : columnKind(data.map((r) => r[c] ?? ''))));
  const columns: Record<string, unknown[]> = {};
  const schema: Record<string, ColumnSchema> = {};
  names.forEach((name, c) => {
    const k = kinds[c];
    schema[name] = { type: k === 'number' ? 'number' : k === 'boolean' ? 'boolean' : 'string' };
    const col = new Array(rowCount);
    for (let r = 0; r < rowCount; r++) {
      const v = data[r][c] ?? '';
      col[r] = v === '' ? null : k === 'number' ? Number(v) : k === 'boolean' ? v.toLowerCase() === 'true' : v;
    }
    columns[name] = col;
  });
  return { columns, schema, rowCount };
}

function splitCompleteRecords(text: string, delimiter: string): { records: string[][]; remainder: string } {
  let quoted = false;
  let lastCut = -1;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && (ch === '\n' || ch === '\r')) {
      lastCut = i;
    }
  }
  if (lastCut === -1) {
    return { records: [], remainder: text };
  }
  const completeText = text.slice(0, lastCut + 1);
  const remainder = text.slice(lastCut + 1);
  const records = parseCsvRecords(completeText, delimiter);
  return { records, remainder };
}

/** Stream and parse CSV from a URL or stream in chunks, emitting batches to minimize peak memory. */
export async function streamCsv(
  source: string | ReadableStream<Uint8Array | string> | AsyncIterable<Uint8Array | string>,
  opts: StreamCsvOptions = {},
): Promise<CsvColumnsResult & { rows: Row[] }> {
  let stream: ReadableStream<Uint8Array | string> | AsyncIterable<Uint8Array | string>;
  if (typeof source === 'string') {
    const fetchFn = opts.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch ?? fetch;
    const res = await fetchFn(source, {
      headers: opts.headers,
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    if (!res.body) {
      const text = await res.text();
      const colRes = parseCsvColumns(text, opts);
      const rows = parseCsv(text, opts);
      if (opts.onBatch) opts.onBatch({ columns: colRes.columns, rows, rowCount: colRes.rowCount });
      return { ...colRes, rows };
    }
    stream = res.body as ReadableStream<Uint8Array>;
  } else {
    stream = source;
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buffer = '';
  let delimiter = opts.delimiter;
  let headerNames: string[] = [];
  let colKinds: ('number' | 'boolean' | 'text')[] = [];
  const accumulatedColumns: Record<string, unknown[]> = {};
  const accumulatedRows: Row[] = [];
  const batchSize = opts.batchSize ?? 5000;
  let totalRows = 0;
  let batchRows: Row[] = [];
  let batchCols: Record<string, unknown[]> = {};

  const processRecords = (records: string[][]) => {
    if (!records.length) return;
    let recs = records;
    if (opts.skipEmptyLines ?? true) {
      recs = recs.filter((r) => !(r.length === 1 && r[0] === ''));
    }
    if (!recs.length) return;

    if (!headerNames.length) {
      if (!delimiter) {
        delimiter = detectDelimiter(buffer || recs[0].join(','));
      }
      const header = opts.header ?? true;
      const width = Math.max(...recs.map((r) => r.length));
      if (header) {
        headerNames = uniqueNames(recs[0], width);
        recs = recs.slice(1);
      } else {
        headerNames = Array.from({ length: width }, (_, i) => `Column${i + 1}`);
      }
      for (const name of headerNames) {
        accumulatedColumns[name] = [];
        batchCols[name] = [];
      }
    }
    if (!recs.length) return;

    if (!colKinds.length) {
      colKinds = headerNames.map((_, c) => (opts.dynamicTyping === false ? 'text' : columnKind(recs.map((r) => r[c] ?? ''))));
    }

    for (const r of recs) {
      if (opts.maxRows !== undefined && totalRows >= opts.maxRows) break;
      const row: Row = {};
      headerNames.forEach((name, c) => {
        const v = r[c] ?? '';
        const k = colKinds[c] ?? 'text';
        const val = v === '' ? null : k === 'number' ? Number(v) : k === 'boolean' ? v.toLowerCase() === 'true' : v;
        row[name] = val;
        accumulatedColumns[name].push(val);
        batchCols[name].push(val);
      });
      accumulatedRows.push(row);
      batchRows.push(row);
      totalRows++;

      if (batchRows.length >= batchSize) {
        if (opts.onBatch) {
          opts.onBatch({ columns: batchCols, rows: batchRows, rowCount: batchRows.length });
        }
        batchRows = [];
        batchCols = {};
        for (const name of headerNames) batchCols[name] = [];
      }
    }
  };

  if ('getReader' in stream) {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunkText = typeof value === 'string' ? value : decoder.decode(value, { stream: true });
        buffer += chunkText;
        const lines = splitCompleteRecords(buffer, delimiter ?? ',');
        buffer = lines.remainder;
        processRecords(lines.records);
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    for await (const chunk of stream) {
      const chunkText = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      buffer += chunkText;
      const lines = splitCompleteRecords(buffer, delimiter ?? ',');
      buffer = lines.remainder;
      processRecords(lines.records);
    }
  }

  if (buffer.length > 0) {
    const remainingRecords = parseCsvRecords(buffer, delimiter ?? detectDelimiter(buffer));
    processRecords(remainingRecords);
  }

  if (batchRows.length > 0 && opts.onBatch) {
    opts.onBatch({ columns: batchCols, rows: batchRows, rowCount: batchRows.length });
  }

  const schema: Record<string, ColumnSchema> = {};
  if (headerNames.length && colKinds.length) {
    headerNames.forEach((name, c) => {
      const k = colKinds[c] ?? 'text';
      schema[name] = { type: k === 'number' ? 'number' : k === 'boolean' ? 'boolean' : 'string' };
    });
  }

  return { columns: accumulatedColumns, schema, rows: accumulatedRows, rowCount: totalRows };
}

/** Fetch and parse a CSV file. */
export async function loadCsv(url: string, opts: CsvOptions & FetchOptions = {}): Promise<Row[]> {
  return parseCsv(await fetchText(url, opts), opts);
}

/**
 * CSV export URL for a Google Sheet that is shared "anyone with the link" (or published to the web).
 * Accepts a sheet id or a full sheet URL; `gid` picks the tab (taken from the URL when present).
 */
export function googleSheetCsvUrl(sheet: string, gid?: string | number): string {
  const id = /\/d\/([a-zA-Z0-9-_]+)/.exec(sheet)?.[1] ?? sheet;
  const tab = gid ?? /[#&?]gid=(\d+)/.exec(sheet)?.[1] ?? 0;
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${tab}`;
}
