import type { Row } from '../data/types';
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
