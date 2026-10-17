import type { CellValue } from '../data/types';
import type { QueryResult } from '../data/query';
import { FORMAT_PRESETS } from '../format/format';

/**
 * Minimal, dependency-free .xlsx writer: typed cells (numbers, dates, booleans, text), number and date formats, a bold
 * frozen header row and column widths. Files are stored uncompressed (a valid ZIP with no compression), which keeps the
 * writer tiny and synchronous; Excel, LibreOffice, Numbers and Google Sheets all open them.
 */

export interface XlsxColumn {
  header: string;
  /** PrismBI / Excel format string (or preset name), e.g. `'$#,0.00'`, `'0.0%'`, `'yyyy-MM-dd'`. */
  format?: string;
  /** Width in characters (default: fitted to the content, 6–60). */
  width?: number;
}

export interface XlsxSheet {
  /** Sheet tab name (made unique and trimmed to Excel's 31 characters). */
  name: string;
  columns: XlsxColumn[];
  rows: CellValue[][];
}

/** One sheet from a query result: group columns, then value columns, then the totals row when present. */
export function resultToSheet(result: QueryResult, name = 'Data'): XlsxSheet {
  const fields = [...result.groups, ...result.values];
  const rows = result.rows.map((r) => [...r.keys, ...r.values]);
  if (result.totals && result.groups.length) rows.push(['Total', ...result.groups.slice(1).map(() => null), ...result.totals]);
  return { name, columns: fields.map((f) => ({ header: f.name, format: f.format ?? (f.type === 'date' ? 'yyyy-MM-dd' : undefined) })), rows };
}

/** Build a workbook. Returns the file's bytes (`new Blob([bytes], { type: XLSX_MIME })` to download). */
export function buildXlsx(sheets: XlsxSheet[]): Uint8Array {
  if (!sheets.length) throw new Error('buildXlsx needs at least one sheet');
  const styles = new StyleTable();
  const names = uniqueNames(sheets.map((s) => s.name));
  const files: [string, string][] = [
    ['[Content_Types].xml', contentTypes(sheets.length)],
    ['_rels/.rels', `${XML}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_DOC_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    [
      'xl/workbook.xml',
      `${XML}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_DOC_REL}"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `${XML}<Relationships xmlns="${NS_PKG_REL}">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_DOC_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${NS_DOC_REL}/styles" Target="styles.xml"/></Relationships>`,
    ],
  ];
  sheets.forEach((s, i) => files.push([`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s, styles)]));
  files.push(['xl/styles.xml', styles.xml()]);
  return zip(files.map(([path, text]) => [path, utf8(text)]));
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ---------------------------------------------------------------- sheets

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

function contentTypes(n: number): string {
  const sheets = Array.from({ length: n }, (_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  return `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets}</Types>`;
}

function uniqueNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw, i) => {
    const base = (raw.replace(/[\\/?*[\]:]/g, ' ').trim() || `Sheet${i + 1}`).slice(0, 31);
    let name = base;
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base.slice(0, 31 - String(k).length - 1)} ${k}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** A1-style column letters for a zero-based index. */
export function columnLetter(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function sheetXml(sheet: XlsxSheet, styles: StyleTable): string {
  const cols = sheet.columns;
  const header = styles.header();
  const colStyles = cols.map((c) => styles.forFormat(c.format));
  const dateStyles = cols.map((c) => styles.forFormat(c.format && isDateFormat(c.format) ? c.format : 'yyyy-MM-dd'));
  const widths = cols.map((c, j) => c.width ?? fitWidth(c.header, sheet.rows, j));
  const out: string[] = [];
  out.push(`${XML}<worksheet xmlns="${NS_MAIN}">`);
  out.push('<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>');
  if (cols.length) out.push(`<cols>${widths.map((w, j) => `<col min="${j + 1}" max="${j + 1}" width="${w.toFixed(1)}" customWidth="1"/>`).join('')}</cols>`);
  out.push('<sheetData>');
  out.push(`<row r="1">${cols.map((c, j) => `<c r="${columnLetter(j)}1" t="inlineStr" s="${header}"><is><t xml:space="preserve">${esc(c.header)}</t></is></c>`).join('')}</row>`);
  sheet.rows.forEach((row, i) => {
    const r = i + 2;
    let cells = '';
    row.forEach((v, j) => {
      if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return;
      const ref = `${columnLetter(j)}${r}`;
      if (typeof v === 'number') cells += `<c r="${ref}"${styleAttr(colStyles[j])}><v>${v}</v></c>`;
      else if (v instanceof Date) cells += `<c r="${ref}"${styleAttr(dateStyles[j])}><v>${excelDate(v)}</v></c>`;
      else if (typeof v === 'boolean') cells += `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
      else cells += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
    });
    out.push(`<row r="${r}">${cells}</row>`);
  });
  out.push('</sheetData>');
  if (cols.length) out.push(`<autoFilter ref="A1:${columnLetter(cols.length - 1)}${sheet.rows.length + 1}"/>`);
  out.push('</worksheet>');
  return out.join('');
}

const styleAttr = (s: number) => (s ? ` s="${s}"` : '');

function fitWidth(header: string, rows: CellValue[][], j: number): number {
  let w = header.length + 2;
  for (let i = 0; i < Math.min(rows.length, 200); i++) {
    const v = rows[i][j];
    const len = v instanceof Date ? 10 : typeof v === 'number' ? String(Math.round(v * 100) / 100).length + 3 : v === null || v === undefined ? 0 : String(v).length;
    if (len > w) w = len;
  }
  return Math.min(60, Math.max(6, w + 1));
}

/** Excel serial date (days since 1899-12-30) from the date's local calendar fields; Excel has no time zones. */
export function excelDate(d: Date): number {
  const utc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
  return (utc - Date.UTC(1899, 11, 30)) / 86_400_000;
}

const esc = (s: string) =>
  s
    // characters XML 1.0 can't carry at all
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// ---------------------------------------------------------------- formats and styles

function isDateFormat(fmt: string): boolean {
  const f = FORMAT_PRESETS[fmt] ?? fmt;
  return /[yMdHhs]/.test(f.replace(/"[^"]*"|\\./g, '')) && !/[#0]/.test(f.replace(/"[^"]*"|\\./g, ''));
}

/** PrismBI format string → Excel number format code. Characters Excel can't take literally are escaped. */
export function excelFormat(fmt: string): string {
  const f = FORMAT_PRESETS[fmt] ?? fmt;
  if (!f) return 'General';
  const date = isDateFormat(f);
  let out = '';
  for (let i = 0; i < f.length; i++) {
    const ch = f[i];
    if (ch === '"') {
      const end = f.indexOf('"', i + 1);
      const lit = end < 0 ? f.slice(i + 1) : f.slice(i + 1, end);
      out += `"${lit}"`;
      i = end < 0 ? f.length : end;
    } else if (ch === '\\' && i + 1 < f.length) out += f.slice(i, ++i + 1);
    else if (date ? /[yMdHhsm:/.\- ,]/.test(ch) : /[0#?.,%Ee+\-;$ ()/:]/.test(ch)) out += date ? (ch === 'M' ? 'm' : ch === 'H' ? 'h' : ch) : ch;
    else if (date && f.startsWith('AM/PM', i)) {
      out += 'AM/PM';
      i += 4;
    } else out += `\\${ch}`;
  }
  return out;
}

/** Built-in Excel number formats that needn't be declared. */
const BUILTIN: Record<string, number> = { General: 0, '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4, '0%': 9, '0.00%': 10 };

class StyleTable {
  private fmts = new Map<string, number>(); // code → numFmtId
  private xfs: { numFmtId: number; bold: boolean }[] = [{ numFmtId: 0, bold: false }];
  private byKey = new Map<string, number>();

  header(): number {
    return this.xf(0, true);
  }

  /** Cell style index for a format string (0 = General). */
  forFormat(fmt: string | undefined): number {
    if (!fmt) return 0;
    const code = excelFormat(fmt);
    let id: number | undefined = BUILTIN[code] ?? this.fmts.get(code);
    if (id === undefined) this.fmts.set(code, (id = 164 + this.fmts.size));
    return this.xf(id, false);
  }

  private xf(numFmtId: number, bold: boolean): number {
    const k = `${numFmtId}|${bold}`;
    let i = this.byKey.get(k);
    if (i === undefined) {
      i = this.xfs.length;
      this.xfs.push({ numFmtId, bold });
      this.byKey.set(k, i);
    }
    return i;
  }

  xml(): string {
    const fmts = [...this.fmts].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${esc(code)}"/>`).join('');
    const xfs = this.xfs.map((x) => `<xf numFmtId="${x.numFmtId}" fontId="${x.bold ? 1 : 0}" fillId="0" borderId="0" xfId="0"${x.numFmtId ? ' applyNumberFormat="1"' : ''}${x.bold ? ' applyFont="1"' : ''}/>`).join('');
    return (
      `${XML}<styleSheet xmlns="${NS_MAIN}">` +
      (this.fmts.size ? `<numFmts count="${this.fmts.size}">${fmts}</numFmts>` : '') +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${this.xfs.length}">${xfs}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>'
    );
  }
}

// ---------------------------------------------------------------- zip (stored)

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

let crcTable: Uint32Array | undefined;
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A ZIP archive with every entry stored (no compression). */
export function zip(entries: [string, Uint8Array][]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  // fixed DOS timestamp (1980-01-01): output is deterministic
  const time = 0;
  const date = (0 << 9) | (1 << 5) | 1;
  for (const [path, data] of entries) {
    const name = utf8(path);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true); // version made by
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const a of all) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}
