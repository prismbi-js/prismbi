import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Report,
  STANDARD_PAPER_SIZES,
  buildPdf,
  parseColor,
  resolveMargins,
  resolvePaperSize,
  svgPathToPdf,
  svgToPdf,
} from '../src/index';
import type { PdfPage, PdfVectorPage } from '../src/index';
import { makeModel } from './fixtures';

describe('PDF Vector Engine', () => {
  describe('parseColor', () => {
    it('parses 3-digit and 6-digit hex colors', () => {
      expect(parseColor('#f00')).toEqual({ r: 1, g: 0, b: 0 });
      expect(parseColor('#00ff00')).toEqual({ r: 0, g: 1, b: 0 });
      expect(parseColor('#0000ff')).toEqual({ r: 0, g: 0, b: 1 });
    });

    it('parses rgb and rgba strings', () => {
      const c = parseColor('rgb(255, 128, 0)');
      expect(c?.r).toBeCloseTo(1, 2);
      expect(c?.g).toBeCloseTo(128 / 255, 2);
      expect(c?.b).toBe(0);

      const ca = parseColor('rgba(0, 255, 0, 0.5)');
      expect(ca).toEqual({ r: 0, g: 1, b: 0 });
    });

    it('handles named colors and transparent/none', () => {
      expect(parseColor('white')).toEqual({ r: 1, g: 1, b: 1 });
      expect(parseColor('black')).toEqual({ r: 0, g: 0, b: 0 });
      expect(parseColor('red')).toEqual({ r: 1, g: 0, b: 0 });
      expect(parseColor('none')).toBeNull();
      expect(parseColor('transparent')).toBeNull();
      expect(parseColor(null)).toBeNull();
      expect(parseColor(undefined)).toBeNull();
    });
  });

  describe('svgPathToPdf', () => {
    it('translates absolute M, L, H, V, C, Z commands', () => {
      const pdf = svgPathToPdf('M 10 20 L 30 40 H 50 V 60 C 10 10 20 20 30 30 Z');
      expect(pdf).toContain('10.00 20.00 m');
      expect(pdf).toContain('30.00 40.00 l');
      expect(pdf).toContain('50.00 40.00 l');
      expect(pdf).toContain('50.00 60.00 l');
      expect(pdf).toContain('10.00 10.00 20.00 20.00 30.00 30.00 c');
      expect(pdf).toContain('h');
    });

    it('translates relative commands (m, l, z)', () => {
      const pdf = svgPathToPdf('m 10 20 l 5 5 z');
      expect(pdf).toContain('10.00 20.00 m');
      expect(pdf).toContain('15.00 25.00 l');
      expect(pdf).toContain('h');
    });

    it('converts quadratic Bézier Q curves to cubic Bézier c operators', () => {
      const pdf = svgPathToPdf('M 0 0 Q 30 60 60 0');
      expect(pdf).toContain('m');
      expect(pdf).toContain('c');
    });
  });

  describe('svgToPdf', () => {
    it('translates rect elements with fill and stroke', () => {
      const svg = `<svg><rect x="10" y="20" width="100" height="50" fill="#ff0000" stroke="#0000ff" stroke-width="2"/></svg>`;
      const stream = svgToPdf(svg, 800, 600);
      expect(stream).toContain('1.000 0.000 0.000 rg');
      expect(stream).toContain('0.000 0.000 1.000 RG');
      expect(stream).toContain('2.00 w');
      expect(stream).toContain('10.00 20.00 100.00 50.00 re B');
    });

    it('translates circles and ellipses', () => {
      const svg = `<svg><circle cx="50" cy="50" r="25" fill="#00ff00"/><ellipse cx="100" cy="80" rx="30" ry="15" stroke="#ff0000"/></svg>`;
      const stream = svgToPdf(svg, 800, 600);
      expect(stream).toContain('0.000 1.000 0.000 rg');
      expect(stream).toContain('f');
      expect(stream).toContain('1.000 0.000 0.000 RG');
      expect(stream).toContain('S');
    });

    it('translates polylines and polygons', () => {
      const svg = `<svg><polyline points="0,0 20,20 40,10" stroke="#000000"/><polygon points="50,50 70,70 60,90" fill="#ff0000"/></svg>`;
      const stream = svgToPdf(svg, 800, 600);
      expect(stream).toContain('0.00 0.00 m 20.00 20.00 l 40.00 10.00 l S');
      expect(stream).toContain('50.00 50.00 m 70.00 70.00 l 60.00 90.00 l h f');
    });

    it('translates text elements with font size and text-anchor', () => {
      const svg = `<svg><text x="50" y="100" font-size="14" fill="#000000" text-anchor="middle">Revenue Overview</text></svg>`;
      const stream = svgToPdf(svg, 800, 600);
      expect(stream).toContain('BT /F1 14.0 Tf');
      expect(stream).toContain('(Revenue Overview) Tj ET');
    });

    it('handles nested group transforms and skips hidden elements', () => {
      const svg = `<svg>
        <g transform="translate(40, 60)">
          <line x1="0" y1="0" x2="100" y2="100" stroke="#ff0000"/>
        </g>
        <rect x="0" y="0" width="10" height="10" display="none" fill="#000"/>
      </svg>`;
      const stream = svgToPdf(svg, 800, 600);
      expect(stream).toContain('q 1 0 0 1 40.00 60.00 cm');
      expect(stream).toContain('0.00 0.00 m 100.00 100.00 l S');
      expect(stream).not.toContain('0.00 0.00 10.00 10.00 re');
    });
  });

  describe('buildPdf vector pages', () => {
    it('produces valid PDF 1.4 output with pure vector pages', () => {
      const pages: PdfVectorPage[] = [
        {
          width: 800,
          height: 600,
          vectorCommands: '1.000 0.000 0.000 rg 10.00 10.00 200.00 100.00 re f\n',
        },
      ];
      const bytes = buildPdf(pages, 'Vector Test Report');
      const text = new TextDecoder('latin1').decode(bytes);

      expect(text.startsWith('%PDF-1.4')).toBe(true);
      expect(text).toContain('/Count 1');
      expect(text).toContain('/MediaBox [0 0 600 450]');
      expect(text).toContain('/Title (Vector Test Report)');
      expect(text).toContain('/Producer (PrismBI)');
      expect(text).toContain('/Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >>');
      expect(text).toContain('1.000 0.000 0.000 rg 10.00 10.00 200.00 100.00 re f');
      expect(text.trimEnd().endsWith('%%EOF')).toBe(true);

      // Verify XRef offsets
      const xrefMatch = /startxref\n(\d+)/.exec(text);
      expect(xrefMatch).toBeTruthy();
      const xrefAt = Number(xrefMatch![1]);
      const entries = text
        .slice(xrefAt)
        .split('\n')
        .filter((l) => / 00000 n $/.test(l))
        .map((l) => Number(l.slice(0, 10)));
      entries.forEach((off, i) => expect(text.slice(off, off + 12)).toMatch(new RegExp(`^${i + 1} 0 obj`)));
    });

    it('supports hybrid pages with both JPEG image and vector overlays', () => {
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
      const pages: PdfPage[] = [
        {
          jpeg,
          pixelWidth: 2,
          pixelHeight: 2,
          width: 800,
          height: 600,
          vectorCommands: 'q 1 0 0 1 10 10 cm /F1 12 Tf (Overlay Text) Tj Q',
        },
      ];
      const bytes = buildPdf(pages, 'Hybrid Test');
      const text = new TextDecoder('latin1').decode(bytes);
      expect(text).toContain('/DCTDecode');
      expect(text).toContain('/Im0 Do');
      expect(text).toContain('(Overlay Text) Tj');
    });
  });

  describe('Report.toPdf integration', () => {
    let el: HTMLElement;
    beforeEach(() => {
      el = document.createElement('div');
      document.body.append(el);
    });
    afterEach(() => {
      el.remove();
      document.querySelectorAll('.pbi-report').forEach((n) => n.remove());
    });

    it('generates vector PDF bytes directly via r.toPdf({ vector: true })', async () => {
      const r = new Report(el, {
        model: makeModel(),
        pages: [
          {
            name: 'Vector Page',
            visuals: [
              { id: 'c1', type: 'card', fields: { value: 'Total Sales' }, layout: { x: 0, y: 0, w: 4, h: 4 } },
              { id: 'b1', type: 'bar', fields: { category: 'Products[Category]', values: 'Total Sales' }, layout: { x: 4, y: 0, w: 8, h: 6 } },
            ],
          },
        ],
      });
      r.flush();

      const pdfBytes = await r.toPdf({ vector: true });
      expect(pdfBytes).toBeInstanceOf(Uint8Array);
      expect(pdfBytes.length).toBeGreaterThan(100);

      const text = new TextDecoder('latin1').decode(pdfBytes);
      expect(text.startsWith('%PDF-1.4')).toBe(true);
      expect(text).toContain('/MediaBox');
      expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    });

    it('renders with standard paper formats (A4 landscape) and running footers', async () => {
      const r = new Report(el, {
        model: makeModel(),
        pages: [
          {
            name: 'Financial Summary',
            visuals: [
              { id: 'c1', type: 'card', fields: { value: 'Total Sales' }, layout: { x: 0, y: 0, w: 6, h: 4 } },
            ],
          },
        ],
      });
      r.flush();

      const pdfBytes = await r.toPdf({
        format: 'a4',
        orientation: 'landscape',
        vector: true,
        footer: true,
        header: 'Confidential Executive Report',
      });
      const text = new TextDecoder('latin1').decode(pdfBytes);

      expect(text.startsWith('%PDF-1.4')).toBe(true);
      expect(text).toContain(`/MediaBox [0 0 841.89 595.28]`);
      expect(text).toContain('Confidential Executive Report');
      expect(text).toContain('Page 1 of 1');
    });

    it('renders Letter portrait with custom margin and dynamic footer callback', async () => {
      const r = new Report(el, {
        model: makeModel(),
        pages: [
          {
            name: 'Operations',
            visuals: [
              { id: 'c1', type: 'card', fields: { value: 'Total Sales' }, layout: { x: 0, y: 0, w: 12, h: 4 } },
            ],
          },
        ],
      });
      r.flush();

      const pdfBytes = await r.toPdf({
        format: 'letter',
        orientation: 'portrait',
        vector: true,
        margin: 30,
        footer: (ctx) => `${ctx.pageName} - Document #${ctx.pageNumber}/${ctx.totalPages}`,
      });
      const text = new TextDecoder('latin1').decode(pdfBytes);

      expect(text.startsWith('%PDF-1.4')).toBe(true);
      expect(text).toContain(`/MediaBox [0 0 612 792]`);
      expect(text).toContain('Operations - Document #1/1');
    });
  });

  describe('Standard Paper Sizes & Layout Math', () => {
    it('resolves paper sizes correctly across orientations', () => {
      expect(STANDARD_PAPER_SIZES.a4).toEqual({ width: 595.28, height: 841.89 });
      expect(resolvePaperSize('a4', 'landscape')).toEqual({ width: 841.89, height: 595.28 });
      expect(resolvePaperSize('a4', 'portrait')).toEqual({ width: 595.28, height: 841.89 });

      expect(resolvePaperSize('letter', 'landscape')).toEqual({ width: 792.0, height: 612.0 });
      expect(resolvePaperSize('letter', 'portrait')).toEqual({ width: 612.0, height: 792.0 });

      expect(resolvePaperSize('legal', 'landscape')).toEqual({ width: 1008.0, height: 612.0 });
      expect(resolvePaperSize('legal', 'portrait')).toEqual({ width: 612.0, height: 1008.0 });

      expect(resolvePaperSize('ledger', 'landscape')).toEqual({ width: 1224.0, height: 792.0 });
      expect(resolvePaperSize('ledger', 'portrait')).toEqual({ width: 792.0, height: 1224.0 });

      expect(resolvePaperSize('a3', 'landscape')).toEqual({ width: 1190.55, height: 841.89 });
      expect(resolvePaperSize('a3', 'portrait')).toEqual({ width: 841.89, height: 1190.55 });

      expect(resolvePaperSize('auto', undefined, 1000, 600)).toEqual({ width: 750, height: 450 });
    });

    it('resolves margins accurately with defaults', () => {
      expect(resolveMargins(25)).toEqual({ top: 25, right: 25, bottom: 25, left: 25 });
      expect(resolveMargins({ top: 10, bottom: 15 }, true)).toEqual({ top: 10, right: 20, bottom: 15, left: 20 });
      expect(resolveMargins(undefined, true)).toEqual({ top: 20, right: 20, bottom: 20, left: 20 });
      expect(resolveMargins(undefined, false)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    });

    it('svgToPdf transforms coordinates with custom scale, offset, and page height', () => {
      const svg = `<svg><rect x="0" y="0" width="100" height="100" fill="#f00"/></svg>`;
      const stream = svgToPdf(svg, 100, 100, {
        scale: 0.5,
        x: 20,
        y: 30,
        pageHeight: 600,
      });

      // 0.75 * 0.5 = 0.375
      expect(stream).toContain('q 0.375 0 0 -0.375 20 570 cm');
      expect(stream).toContain('0.00 0.00 100.00 100.00 re');
    });

    it('buildPdf renders headers, footers and explicit page dimensions', () => {
      const pages: PdfVectorPage[] = [
        {
          width: 800,
          height: 600,
          pageWidth: 841.89,
          pageHeight: 595.28,
          x: 20,
          y: 20,
          targetWidth: 801.89,
          targetHeight: 555.28,
          header: 'Header Title',
          footer: 'Page 1 of 5',
          vectorCommands: '1.000 0.000 0.000 rg 0.00 0.00 100.00 100.00 re f\n',
        },
      ];
      const bytes = buildPdf(pages, 'Header Footer Test');
      const text = new TextDecoder('latin1').decode(bytes);

      expect(text).toContain('/MediaBox [0 0 841.89 595.28]');
      expect(text).toContain('(Header Title) Tj');
      expect(text).toContain('(Page 1 of 5) Tj');
    });
  });
});
