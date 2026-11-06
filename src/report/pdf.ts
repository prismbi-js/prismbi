/**
 * PDF 1.4 generator supporting both image XObjects and scalable vector graphics paths.
 * Zero dependencies.
 */

/** Standard paper formats (dimensions in 1/72-inch PDF points). */
export type PdfPaperFormat = 'a4' | 'letter' | 'legal' | 'ledger' | 'a3' | 'auto';

/** Page orientation ('portrait' or 'landscape'). */
export type PdfOrientation = 'portrait' | 'landscape';

/** Page margin options in PDF points (1/72 inch). */
export interface PdfMarginOptions {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

/** Information passed to running header and footer generator functions. */
export interface PdfHeaderFooterContext {
  pageNumber: number;
  totalPages: number;
  pageName: string;
  reportName: string;
}

/** Dynamic header or footer generator callback. */
export type PdfHeaderFooterFn = (ctx: PdfHeaderFooterContext) => string;

/** Export options for generating PDF documents. */
export interface PdfExportOptions {
  /** 'current' exports only the active page; 'all' exports all non-hidden report pages (default: 'current'). */
  pages?: 'current' | 'all';
  /** Vector mode translates SVG paths directly into PDF drawing operators (default: false). */
  vector?: boolean;
  /** Custom output file name for browser download. */
  filename?: string;
  /** Standard paper format preset ('a4', 'letter', 'legal', 'ledger', 'a3', or 'auto'). Default: 'auto'. */
  format?: PdfPaperFormat;
  /** Paper orientation ('portrait' or 'landscape'). Default: 'landscape' when format is specified, else 'auto'. */
  orientation?: PdfOrientation;
  /** Margins in PDF points. Accepts a single number or top/right/bottom/left object. Default: 20 when format specified, else 0. */
  margin?: number | PdfMarginOptions;
  /** Running header text or function. */
  header?: string | PdfHeaderFooterFn;
  /** Running footer text or function. Pass `true` for standard 'Page X of Y'. */
  footer?: string | boolean | PdfHeaderFooterFn;
}

/** Configuration options for translating SVG elements to a PDF vector content stream. */
export interface SvgToPdfOptions {
  /** Uniform scale factor relative to 0.75 pt/px (default: 1). */
  scale?: number;
  /** Horizontal origin offset in PDF points from the left edge (default: 0). */
  x?: number;
  /** Vertical origin offset in PDF points from the top edge (default: 0). */
  y?: number;
  /** Target paper height in PDF points (used to invert the coordinate system). */
  pageHeight?: number;
}

/** One PDF page holding a full-bleed or scaled JPEG image (with optional vector overlays). */
export interface PdfImagePage {
  jpeg: Uint8Array;
  /** Pixel dimensions of the JPEG. */
  pixelWidth: number;
  pixelHeight: number;
  /** Source content width in CSS px. */
  width: number;
  /** Source content height in CSS px. */
  height: number;
  /** Optional scalable vector path commands overlaid onto the page. */
  vectorCommands?: string;
  /** Explicit target paper width in PDF points. Defaults to width * 0.75. */
  pageWidth?: number;
  /** Explicit target paper height in PDF points. Defaults to height * 0.75. */
  pageHeight?: number;
  /** Printable x offset in PDF points from left. Defaults to 0. */
  x?: number;
  /** Printable y offset in PDF points from top. Defaults to 0. */
  y?: number;
  /** Target fitted width in PDF points. Defaults to pageWidth. */
  targetWidth?: number;
  /** Target fitted height in PDF points. Defaults to pageHeight. */
  targetHeight?: number;
  /** Running header string. */
  header?: string;
  /** Running footer string. */
  footer?: string;
}

/** One PDF page holding scalable vector graphics instructions. */
export interface PdfVectorPage {
  /** Source content width in CSS px. */
  width: number;
  /** Source content height in CSS px. */
  height: number;
  /** PDF content stream commands (vector path operators: re, m, l, c, f, S, B, etc.). */
  vectorCommands: string;
  /** Explicit target paper width in PDF points. Defaults to width * 0.75. */
  pageWidth?: number;
  /** Explicit target paper height in PDF points. Defaults to height * 0.75. */
  pageHeight?: number;
  /** Printable x offset in PDF points from left. Defaults to 0. */
  x?: number;
  /** Printable y offset in PDF points from top. Defaults to 0. */
  y?: number;
  /** Target fitted width in PDF points. Defaults to pageWidth. */
  targetWidth?: number;
  /** Target fitted height in PDF points. Defaults to pageHeight. */
  targetHeight?: number;
  /** Running header string. */
  header?: string;
  /** Running footer string. */
  footer?: string;
}

export type PdfPage = PdfImagePage | PdfVectorPage;

export const STANDARD_PAPER_SIZES: Record<Exclude<PdfPaperFormat, 'auto'>, { width: number; height: number }> = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612.0, height: 792.0 },
  legal: { width: 612.0, height: 1008.0 },
  ledger: { width: 792.0, height: 1224.0 },
  a3: { width: 841.89, height: 1190.55 },
};

export function resolvePaperSize(
  format: PdfPaperFormat = 'auto',
  orientation?: PdfOrientation,
  fallbackWidth = 1200,
  fallbackHeight = 800
): { width: number; height: number } {
  if (format === 'auto') {
    let w = fallbackWidth * 0.75;
    let h = fallbackHeight * 0.75;
    if (orientation === 'portrait' && w > h) [w, h] = [h, w];
    else if (orientation === 'landscape' && h > w) [w, h] = [h, w];
    return { width: +w.toFixed(2), height: +h.toFixed(2) };
  }
  const base = STANDARD_PAPER_SIZES[format] || STANDARD_PAPER_SIZES.a4;
  const isLandscape = orientation === 'landscape' || (!orientation && base.width < base.height);
  const w = isLandscape ? Math.max(base.width, base.height) : Math.min(base.width, base.height);
  const h = isLandscape ? Math.min(base.width, base.height) : Math.max(base.width, base.height);
  return { width: +w.toFixed(2), height: +h.toFixed(2) };
}

export function resolveMargins(
  margin?: number | PdfMarginOptions,
  hasFormat = false
): { top: number; right: number; bottom: number; left: number } {
  if (typeof margin === 'number') {
    return { top: margin, right: margin, bottom: margin, left: margin };
  }
  const def = hasFormat ? 20 : 0;
  return {
    top: margin?.top ?? def,
    right: margin?.right ?? def,
    bottom: margin?.bottom ?? def,
    left: margin?.left ?? def,
  };
}

export function escapePdfText(str: string): string {
  return str.replace(/[()\\]/g, (c) => `\\${c}`);
}

const enc = new TextEncoder();

/**
 * Minimal PDF 1.4 writer: supports DCT (JPEG) image XObjects, scalable vector paths,
 * standard paper sizes, margins, and running headers/footers.
 */
export function buildPdf(pages: PdfPage[], title = 'Report'): Uint8Array {
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (data: Uint8Array | string) => {
    const b = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(b);
    length += b.length;
  };
  const obj = (id: number, body: () => void) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
    body();
    push('\nendobj\n');
  };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  // Allocate object IDs dynamically
  let nextId = 4;
  const entries = pages.map((p, i) => {
    const pid = nextId++;
    const cid = nextId++;
    const hasImage = 'jpeg' in p && p.jpeg && p.jpeg.length > 0;
    const iid = hasImage ? nextId++ : undefined;
    const w = p.pageWidth !== undefined ? +p.pageWidth.toFixed(2) : +(p.width * 0.75).toFixed(2);
    const h = p.pageHeight !== undefined ? +p.pageHeight.toFixed(2) : +(p.height * 0.75).toFixed(2);
    return {
      index: i,
      page: p,
      pid,
      cid,
      iid,
      hasImage,
      w,
      h,
    };
  });

  const pageIds = entries.map((e) => e.pid);
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`));
  obj(3, () => push(`<< /Title (${escapePdfText(title)}) /Producer (PrismBI) >>`));

  entries.forEach((e) => {
    let content = '';
    const targetW = e.page.targetWidth !== undefined ? e.page.targetWidth : e.w;
    const targetH = e.page.targetHeight !== undefined ? e.page.targetHeight : e.h;
    const targetX = e.page.x ?? 0;
    const targetY = e.page.y ?? 0;
    const pdfY = +(e.h - (targetY + targetH)).toFixed(2);

    if (e.hasImage) {
      content += `q ${targetW.toFixed(2)} 0 0 ${targetH.toFixed(2)} ${targetX.toFixed(2)} ${pdfY.toFixed(2)} cm /Im${e.index} Do Q\n`;
      if (e.page.vectorCommands) content += e.page.vectorCommands;
    } else if (e.page.vectorCommands) {
      content = e.page.vectorCommands;
    }

    if (e.page.header) {
      const hText = escapePdfText(e.page.header);
      const hY = +(e.h - Math.min(24, Math.max(12, targetY / 2 || 14))).toFixed(2);
      const hX = +(targetX || 20).toFixed(2);
      content += `q BT /F1 9 Tf 0.35 0.35 0.35 rg ${hX} ${hY} Td (${hText}) Tj ET Q\n`;
    }

    if (e.page.footer) {
      const fText = escapePdfText(e.page.footer);
      const fY = +(Math.min(20, Math.max(8, pdfY / 2 || 12))).toFixed(2);
      const textLen = fText.length * 9 * 0.52;
      const fX = +Math.max(20, (e.w - textLen) / 2).toFixed(2);
      content += `q BT /F1 9 Tf 0.45 0.45 0.45 rg ${fX} ${fY} Td (${fText}) Tj ET Q\n`;
    }

    const res = e.hasImage
      ? `<< /XObject << /Im${e.index} ${e.iid} 0 R >> /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >>`
      : `<< /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >>`;

    const contentBytes = enc.encode(content);
    obj(e.pid, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${e.w} ${e.h}] /Resources ${res} /Contents ${e.cid} 0 R >>`));
    obj(e.cid, () => {
      push(`<< /Length ${contentBytes.length} >>\nstream\n`);
      push(contentBytes);
      push('\nendstream');
    });

    if (e.hasImage && e.iid) {
      const imgPage = e.page as PdfImagePage;
      obj(e.iid, () => {
        push(`<< /Type /XObject /Subtype /Image /Width ${imgPage.pixelWidth} /Height ${imgPage.pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imgPage.jpeg.length} >>\nstream\n`);
        push(imgPage.jpeg);
        push('\nendstream');
      });
    }
  });

  const xref = length;
  const count = nextId;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) table += `${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * Render a Report instance's pages into a PDF 1.4 Uint8Array.
 * Lazy-loaded on demand to keep the core bundle lightweight.
 */
export async function exportReportPdf(report: any, opts: PdfExportOptions = {}): Promise<Uint8Array> {
  const { elementToSvg, svgToCanvas } = await import('./snapshot');
  const start = report.current;
  const targets = opts.pages === 'all'
    ? report.pages.map((_: any, i: number) => i).filter((i: number) => !report.pages[i].def.hidden && !report.pages[i].def.tooltip)
    : [start];
  const totalPages = targets.length;
  const hasFormat = Boolean(opts.format && opts.format !== 'auto');
  const margins = resolveMargins(opts.margin, hasFormat);
  const out = [];

  for (let pageNum = 1; pageNum <= targets.length; pageNum++) {
    const i = targets[pageNum - 1];
    if (i !== report.current) report.showPage(i, false);
    report.flush();
    const el = report.page.el!;
    const w = Math.max(1, el.scrollWidth || el.offsetWidth || 1200);
    const hh = Math.max(1, el.scrollHeight || el.offsetHeight || 800);
    const pageName = report.page.def.name ?? `Page ${pageNum}`;

    const paper = resolvePaperSize(opts.format, opts.orientation, w, hh);
    const pageW = paper.width;
    const pageH = paper.height;

    const headerSpace = opts.header ? 18 : 0;
    const footerSpace = opts.footer ? 18 : 0;
    const ctxInfo: PdfHeaderFooterContext = {
      pageNumber: pageNum,
      totalPages,
      pageName,
      reportName: report.name,
    };

    let headerText: string | undefined;
    if (typeof opts.header === 'function') {
      headerText = opts.header(ctxInfo);
    } else if (typeof opts.header === 'string') {
      headerText = opts.header;
    }

    let footerText: string | undefined;
    if (typeof opts.footer === 'function') {
      footerText = opts.footer(ctxInfo);
    } else if (typeof opts.footer === 'string') {
      footerText = opts.footer;
    } else if (opts.footer === true) {
      footerText = `Page ${pageNum} of ${totalPages}`;
    }

    const printW = Math.max(10, pageW - margins.left - margins.right);
    const printH = Math.max(10, pageH - margins.top - margins.bottom - headerSpace - footerSpace);

    const contentWPt = w * 0.75;
    const contentHPt = hh * 0.75;

    const fitScale = hasFormat || opts.margin !== undefined
      ? Math.min(printW / contentWPt, printH / contentHPt)
      : 1;

    const targetWPt = +(contentWPt * fitScale).toFixed(2);
    const targetHPt = +(contentHPt * fitScale).toFixed(2);
    const targetX = +(margins.left + (printW - targetWPt) / 2).toFixed(2);
    const targetY = +(margins.top + headerSpace + (printH - targetHPt) / 2).toFixed(2);

    const svg = elementToSvg(el, report._theme, w, hh);
    if (opts.vector) {
      const vectorCommands = svgToPdf(svg, w, hh, {
        scale: fitScale,
        x: targetX,
        y: targetY,
        pageHeight: pageH,
      });
      out.push({
        vectorCommands,
        width: w,
        height: hh,
        pageWidth: pageW,
        pageHeight: pageH,
        x: targetX,
        y: targetY,
        targetWidth: targetWPt,
        targetHeight: targetHPt,
        header: headerText,
        footer: footerText,
      });
    } else {
      const canvas = await svgToCanvas(svg, report._theme.background, 2);
      out.push({
        jpeg: dataUrlToBytes(canvas.toDataURL('image/jpeg', 0.92)),
        pixelWidth: canvas.width,
        pixelHeight: canvas.height,
        width: w,
        height: hh,
        pageWidth: pageW,
        pageHeight: pageH,
        x: targetX,
        y: targetY,
        targetWidth: targetWPt,
        targetHeight: targetHPt,
        header: headerText,
        footer: footerText,
      });
    }
  }
  if (report.current !== start) report.showPage(start, false);
  return buildPdf(out, report.name);
}

/** Parse a CSS/SVG color string to RGB 0-1 values. */
export function parseColor(c?: string | null): { r: number; g: number; b: number } | null {
  if (!c || c === 'none' || c === 'transparent') return null;
  const s = c.trim();
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16) / 255,
        g: parseInt(hex[1] + hex[1], 16) / 255,
        b: parseInt(hex[2] + hex[2], 16) / 255,
      };
    }
    if (hex.length >= 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16) / 255,
        g: parseInt(hex.slice(2, 4), 16) / 255,
        b: parseInt(hex.slice(4, 6), 16) / 255,
      };
    }
  }
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s);
  if (rgb) {
    return {
      r: Number(rgb[1]) / 255,
      g: Number(rgb[2]) / 255,
      b: Number(rgb[3]) / 255,
    };
  }
  const NAMED: Record<string, { r: number; g: number; b: number }> = {
    white: { r: 1, g: 1, b: 1 },
    black: { r: 0, g: 0, b: 0 },
    red: { r: 1, g: 0, b: 0 },
    green: { r: 0, g: 0.5, b: 0 },
    blue: { r: 0, g: 0, b: 1 },
    gray: { r: 0.5, g: 0.5, b: 0.5 },
    grey: { r: 0.5, g: 0.5, b: 0.5 },
  };
  return NAMED[s.toLowerCase()] ?? null;
}

/** Translate an SVG path command string into PDF vector drawing operators. */
export function svgPathToPdf(d: string): string {
  const tokens = d.match(/[a-df-z]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/gi) || [];
  let out = '';
  let i = 0;
  let currCmd = '';
  let curX = 0;
  let curY = 0;
  let startX = 0;
  let startY = 0;

  while (i < tokens.length) {
    const token = tokens[i];
    if (/^[a-df-z]$/i.test(token)) {
      currCmd = token;
      i++;
    }
    const isRel = currCmd === currCmd.toLowerCase();
    const cmd = currCmd.toUpperCase();

    if (cmd === 'M') {
      const x = isRel ? curX + Number(tokens[i++]) : Number(tokens[i++]);
      const y = isRel ? curY + Number(tokens[i++]) : Number(tokens[i++]);
      out += `${x.toFixed(2)} ${y.toFixed(2)} m `;
      curX = x;
      curY = y;
      startX = x;
      startY = y;
      currCmd = isRel ? 'l' : 'L';
    } else if (cmd === 'L') {
      const x = isRel ? curX + Number(tokens[i++]) : Number(tokens[i++]);
      const y = isRel ? curY + Number(tokens[i++]) : Number(tokens[i++]);
      out += `${x.toFixed(2)} ${y.toFixed(2)} l `;
      curX = x;
      curY = y;
    } else if (cmd === 'H') {
      const x = isRel ? curX + Number(tokens[i++]) : Number(tokens[i++]);
      out += `${x.toFixed(2)} ${curY.toFixed(2)} l `;
      curX = x;
    } else if (cmd === 'V') {
      const y = isRel ? curY + Number(tokens[i++]) : Number(tokens[i++]);
      out += `${curX.toFixed(2)} ${y.toFixed(2)} l `;
      curY = y;
    } else if (cmd === 'C') {
      const x1 = isRel ? curX + Number(tokens[i++]) : Number(tokens[i++]);
      const y1 = isRel ? curY + Number(tokens[i++]) : Number(tokens[i++]);
      const x2 = isRel ? curX + Number(tokens[i++]) : Number(tokens[i++]);
      const y2 = isRel ? curY + Number(tokens[i++]) : Number(tokens[i++]);
      const x = isRel ? curX + Number(tokens[i++]) : Number(tokens[i++]);
      const y = isRel ? curY + Number(tokens[i++]) : Number(tokens[i++]);
      out += `${x1.toFixed(2)} ${y1.toFixed(2)} ${x2.toFixed(2)} ${y2.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} c `;
      curX = x;
      curY = y;
    } else if (cmd === 'Q') {
      const qx = isRel ? curX + Number(tokens[i++]) : Number(tokens[i++]);
      const qy = isRel ? curY + Number(tokens[i++]) : Number(tokens[i++]);
      const x = isRel ? curX + Number(tokens[i++]) : Number(tokens[i++]);
      const y = isRel ? curY + Number(tokens[i++]) : Number(tokens[i++]);
      const cx1 = curX + (2 / 3) * (qx - curX);
      const cy1 = curY + (2 / 3) * (qy - curY);
      const cx2 = x + (2 / 3) * (qx - x);
      const cy2 = y + (2 / 3) * (qy - y);
      out += `${cx1.toFixed(2)} ${cy1.toFixed(2)} ${cx2.toFixed(2)} ${cy2.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} c `;
      curX = x;
      curY = y;
    } else if (cmd === 'Z') {
      out += 'h ';
      curX = startX;
      curY = startY;
    } else {
      i++;
    }
  }
  return out;
}

/** Translate an SVG root element or SVG string into a PDF vector content stream. */
export function svgToPdf(
  svgInput: string | Element,
  _width: number,
  height: number,
  options?: SvgToPdfOptions
): string {
  let doc: Element | null = null;
  if (typeof svgInput === 'string') {
    if (typeof DOMParser !== 'undefined') {
      const parser = new DOMParser();
      doc = parser.parseFromString(svgInput, 'image/svg+xml').documentElement;
    }
  } else {
    doc = svgInput;
  }

  const scale = options?.scale ?? 1;
  const sx = +(0.75 * scale).toFixed(4);
  const sy = +(-0.75 * scale).toFixed(4);
  const ox = +(options?.x ?? 0).toFixed(2);
  const oy = options?.pageHeight !== undefined
    ? +(options.pageHeight - (options.y ?? 0)).toFixed(2)
    : +(height * 0.75).toFixed(2);

  let out = `q ${sx} 0 0 ${sy} ${ox} ${oy} cm\n`;

  if (!doc) {
    return out + 'Q\n';
  }

  const walk = (el: Element, inherited: { fill?: string; stroke?: string; strokeWidth?: number }): void => {
    if (el.getAttribute('display') === 'none' || el.getAttribute('visibility') === 'hidden') return;

    const fillAttr = el.getAttribute('fill') ?? el.getAttribute('style')?.match(/(?:^|;)fill:\s*([^;]+)/)?.[1];
    const strokeAttr = el.getAttribute('stroke') ?? el.getAttribute('style')?.match(/(?:^|;)stroke:\s*([^;]+)/)?.[1];
    const swAttr = el.getAttribute('stroke-width') ?? el.getAttribute('style')?.match(/(?:^|;)stroke-width:\s*([^;]+)/)?.[1];

    const currentFill = fillAttr !== undefined ? fillAttr : inherited.fill;
    const currentStroke = strokeAttr !== undefined ? strokeAttr : inherited.stroke;
    const currentSw = swAttr !== undefined ? Number(swAttr) || 1 : inherited.strokeWidth ?? 1;

    const fillRgb = parseColor(currentFill);
    const strokeRgb = parseColor(currentStroke);

    let tx = 0;
    let ty = 0;
    let hasTransform = false;

    const transform = el.getAttribute('transform');
    if (transform) {
      const trans = /translate\(\s*([-+]?\d*\.?\d+)(?:[,\s]+([-+]?\d*\.?\d+))?\s*\)/.exec(transform);
      if (trans) {
        tx += Number(trans[1]);
        ty += Number(trans[2] || 0);
        hasTransform = true;
      }
    }

    const dl = el.getAttribute('data-offset-left');
    const dt = el.getAttribute('data-offset-top');
    if (dl !== null || dt !== null) {
      tx += Number(dl || 0);
      ty += Number(dt || 0);
      hasTransform = true;
    }

    if (hasTransform) {
      out += `q 1 0 0 1 ${tx.toFixed(2)} ${ty.toFixed(2)} cm\n`;
    }

    const tag = el.tagName.toLowerCase();
    let paintOp = '';
    if (fillRgb && strokeRgb) paintOp = 'B';
    else if (fillRgb) paintOp = 'f';
    else if (strokeRgb) paintOp = 'S';

    let colorSetup = '';
    if (fillRgb) colorSetup += `${fillRgb.r.toFixed(3)} ${fillRgb.g.toFixed(3)} ${fillRgb.b.toFixed(3)} rg `;
    if (strokeRgb) colorSetup += `${strokeRgb.r.toFixed(3)} ${strokeRgb.g.toFixed(3)} ${strokeRgb.b.toFixed(3)} RG ${currentSw.toFixed(2)} w `;

    if (tag === 'rect') {
      const x = Number(el.getAttribute('x') || 0);
      const y = Number(el.getAttribute('y') || 0);
      const w = Number(el.getAttribute('width') || 0);
      const h = Number(el.getAttribute('height') || 0);
      if (w > 0 && h > 0 && paintOp) {
        out += `${colorSetup}${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${paintOp}\n`;
      }
    } else if (tag === 'circle') {
      const cx = Number(el.getAttribute('cx') || 0);
      const cy = Number(el.getAttribute('cy') || 0);
      const r = Number(el.getAttribute('r') || 0);
      if (r > 0 && paintOp) {
        const k = 0.55228475 * r;
        out += `${colorSetup}${cx.toFixed(2)} ${(cy - r).toFixed(2)} m ` +
          `${(cx + k).toFixed(2)} ${(cy - r).toFixed(2)} ${(cx + r).toFixed(2)} ${(cy - k).toFixed(2)} ${(cx + r).toFixed(2)} ${cy.toFixed(2)} c ` +
          `${(cx + r).toFixed(2)} ${(cy + k).toFixed(2)} ${(cx + k).toFixed(2)} ${(cy + r).toFixed(2)} ${cx.toFixed(2)} ${(cy + r).toFixed(2)} c ` +
          `${(cx - k).toFixed(2)} ${(cy + r).toFixed(2)} ${(cx - r).toFixed(2)} ${(cy + k).toFixed(2)} ${(cx - r).toFixed(2)} ${cy.toFixed(2)} c ` +
          `${(cx - r).toFixed(2)} ${(cy - k).toFixed(2)} ${(cx - k).toFixed(2)} ${(cy - r).toFixed(2)} ${cx.toFixed(2)} ${(cy - r).toFixed(2)} c ` +
          `${paintOp}\n`;
      }
    } else if (tag === 'ellipse') {
      const cx = Number(el.getAttribute('cx') || 0);
      const cy = Number(el.getAttribute('cy') || 0);
      const rx = Number(el.getAttribute('rx') || 0);
      const ry = Number(el.getAttribute('ry') || 0);
      if (rx > 0 && ry > 0 && paintOp) {
        const kx = 0.55228475 * rx;
        const ky = 0.55228475 * ry;
        out += `${colorSetup}${cx.toFixed(2)} ${(cy - ry).toFixed(2)} m ` +
          `${(cx + kx).toFixed(2)} ${(cy - ry).toFixed(2)} ${(cx + rx).toFixed(2)} ${(cy - ky).toFixed(2)} ${(cx + rx).toFixed(2)} ${cy.toFixed(2)} c ` +
          `${(cx + rx).toFixed(2)} ${(cy + ky).toFixed(2)} ${(cx + kx).toFixed(2)} ${(cy + ry).toFixed(2)} ${cx.toFixed(2)} ${(cy + ry).toFixed(2)} c ` +
          `${(cx - kx).toFixed(2)} ${(cy + ry).toFixed(2)} ${(cx - rx).toFixed(2)} ${(cy + ky).toFixed(2)} ${(cx - rx).toFixed(2)} ${cy.toFixed(2)} c ` +
          `${(cx - rx).toFixed(2)} ${(cy - ky).toFixed(2)} ${(cx - kx).toFixed(2)} ${(cy - ry).toFixed(2)} ${cx.toFixed(2)} ${(cy - ry).toFixed(2)} c ` +
          `${paintOp}\n`;
      }
    } else if (tag === 'line') {
      const x1 = Number(el.getAttribute('x1') || 0);
      const y1 = Number(el.getAttribute('y1') || 0);
      const x2 = Number(el.getAttribute('x2') || 0);
      const y2 = Number(el.getAttribute('y2') || 0);
      if (strokeRgb) {
        out += `${colorSetup}${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S\n`;
      }
    } else if (tag === 'polyline' || tag === 'polygon') {
      const pointsAttr = el.getAttribute('points') || '';
      const coords = pointsAttr.trim().split(/[\s,]+/).map(Number).filter((n) => !isNaN(n));
      if (coords.length >= 4) {
        out += `${colorSetup}${coords[0].toFixed(2)} ${coords[1].toFixed(2)} m `;
        for (let p = 2; p < coords.length; p += 2) {
          out += `${coords[p].toFixed(2)} ${coords[p + 1].toFixed(2)} l `;
        }
        if (tag === 'polygon') out += 'h ';
        const op = tag === 'polygon' ? paintOp : strokeRgb ? 'S' : '';
        if (op) out += `${op}\n`;
      }
    } else if (tag === 'path') {
      const d = el.getAttribute('d');
      if (d && paintOp) {
        const p = svgPathToPdf(d);
        if (p) out += `${colorSetup}${p}${paintOp}\n`;
      }
    } else if (tag === 'text') {
      const x = Number(el.getAttribute('x') || 0);
      const y = Number(el.getAttribute('y') || 0);
      const fs = Number(el.getAttribute('font-size') || 11);
      const text = el.textContent || '';
      if (text) {
        const anchor = el.getAttribute('text-anchor');
        let adjX = x;
        if (anchor === 'middle') adjX -= (text.length * fs * 0.52) / 2;
        else if (anchor === 'end') adjX -= text.length * fs * 0.52;
        const safe = text.replace(/[^\x20-\x7E]/g, ' ').replace(/[()\\]/g, '\\$&');
        const fill = fillRgb ? `${fillRgb.r.toFixed(3)} ${fillRgb.g.toFixed(3)} ${fillRgb.b.toFixed(3)} rg ` : '0 0 0 rg ';
        out += `BT /F1 ${fs.toFixed(1)} Tf ${fill}1 0 0 -1 ${adjX.toFixed(2)} ${y.toFixed(2)} Tm (${safe}) Tj ET\n`;
      }
    }

    for (let c = 0; c < el.children.length; c++) {
      walk(el.children[c], { fill: currentFill, stroke: currentStroke, strokeWidth: currentSw });
    }

    if (hasTransform) {
      out += 'Q\n';
    }
  };

  walk(doc, {});
  out += 'Q\n';
  return out;
}

/** Decode a `data:image/jpeg;base64,...` URL to bytes. */
export function dataUrlToBytes(url: string): Uint8Array {
  const b64 = url.slice(url.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
