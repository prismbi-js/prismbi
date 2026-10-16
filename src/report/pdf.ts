/** One PDF page holding a full-bleed JPEG image. Sizes are in CSS pixels (converted to points). */
export interface PdfImagePage {
  jpeg: Uint8Array;
  /** Pixel dimensions of the JPEG. */
  pixelWidth: number;
  pixelHeight: number;
  /** Page size in CSS px (the image is scaled to fill it). */
  width: number;
  height: number;
}

const enc = new TextEncoder();

/**
 * Minimal PDF 1.4 writer: each page is one DCT (JPEG) image XObject. No dependencies.
 */
export function buildPdf(pages: PdfImagePage[], title = 'Report'): Uint8Array {
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
  // ids: 1 catalog, 2 pages, 3 info, then per page: page, content, image
  const pageIds = pages.map((_, i) => 4 + i * 3);
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`));
  obj(3, () => push(`<< /Title (${title.replace(/[()\\]/g, (c) => `\\${c}`)}) /Producer (PrismBI) >>`));
  pages.forEach((p, i) => {
    const pid = pageIds[i];
    const w = +(p.width * 0.75).toFixed(2);
    const h = +(p.height * 0.75).toFixed(2);
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im${i} Do Q`;
    obj(pid, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im${i} ${pid + 2} 0 R >> >> /Contents ${pid + 1} 0 R >>`));
    obj(pid + 1, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    obj(pid + 2, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${p.pixelWidth} /Height ${p.pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
      push(p.jpeg);
      push('\nendstream');
    });
  });
  const xref = length;
  const count = 4 + pages.length * 3;
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

/** Decode a `data:image/jpeg;base64,...` URL to bytes. */
export function dataUrlToBytes(url: string): Uint8Array {
  const b64 = url.slice(url.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
