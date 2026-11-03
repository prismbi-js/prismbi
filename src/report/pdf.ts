/**
 * PDF 1.4 generator supporting both image XObjects and scalable vector graphics paths.
 * Zero dependencies.
 */

/** One PDF page holding a full-bleed JPEG image (with optional vector overlays). */
export interface PdfImagePage {
  jpeg: Uint8Array;
  /** Pixel dimensions of the JPEG. */
  pixelWidth: number;
  pixelHeight: number;
  /** Page size in CSS px (the image is scaled to fill it). */
  width: number;
  height: number;
  /** Optional scalable vector path commands overlaid onto the page. */
  vectorCommands?: string;
}

/** One PDF page holding scalable vector graphics instructions. */
export interface PdfVectorPage {
  /** Page size in CSS px (converted to 0.75 points). */
  width: number;
  height: number;
  /** PDF content stream commands (vector path operators: re, m, l, c, f, S, B, etc.). */
  vectorCommands: string;
}

export type PdfPage = PdfImagePage | PdfVectorPage;

const enc = new TextEncoder();

/**
 * Minimal PDF 1.4 writer: supports DCT (JPEG) image XObjects and scalable vector paths.
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
    return {
      index: i,
      page: p,
      pid,
      cid,
      iid,
      hasImage,
      w: +(p.width * 0.75).toFixed(2),
      h: +(p.height * 0.75).toFixed(2),
    };
  });

  const pageIds = entries.map((e) => e.pid);
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`));
  obj(3, () => push(`<< /Title (${title.replace(/[()\\]/g, (c) => `\\${c}`)}) /Producer (PrismBI) >>`));

  entries.forEach((e) => {
    let content = '';
    if (e.hasImage) {
      content += `q ${e.w} 0 0 ${e.h} 0 0 cm /Im${e.index} Do Q`;
      if (e.page.vectorCommands) content += `\n${e.page.vectorCommands}`;
    } else if (e.page.vectorCommands) {
      content = e.page.vectorCommands;
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
export function svgToPdf(svgInput: string | Element, _width: number, height: number): string {
  let doc: Element | null = null;
  if (typeof svgInput === 'string') {
    if (typeof DOMParser !== 'undefined') {
      const parser = new DOMParser();
      doc = parser.parseFromString(svgInput, 'image/svg+xml').documentElement;
    }
  } else {
    doc = svgInput;
  }

  const hPt = +(height * 0.75).toFixed(2);
  let out = `q 0.75 0 0 -0.75 0 ${hPt} cm\n`;

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
