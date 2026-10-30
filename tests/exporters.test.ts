import { describe, expect, it } from 'vitest';
import { DataModel, buildDocx, DOCX_MIME, buildStandaloneHtml } from '../src/index';

describe('executive exporters (DOCX & standalone HTML)', () => {
  it('buildDocx creates valid OpenXML .docx bytes with text and tables', () => {
    const docxBytes = buildDocx({
      title: 'Monthly Performance Review',
      subtitle: 'Q3 Financial Analysis',
      date: '2026-10-30',
      author: 'Finance Team',
      sections: [
        {
          heading: 'Executive Summary',
          text: 'Total revenue grew by 14.2% quarter-over-quarter.\n\nAll regions met or exceeded budgeted target margins.',
        },
        {
          heading: 'Key Metrics by Category',
          table: {
            title: 'Category Performance',
            headers: ['Category', 'Sales ($)', 'Margin %'],
            rows: [
              ['Bikes', 4500000, '42.5%'],
              ['Accessories', 1200000, '58.1%'],
              ['Clothing', 850000, '36.8%'],
            ],
          },
        },
      ],
    });

    expect(docxBytes).toBeInstanceOf(Uint8Array);
    expect(docxBytes.length).toBeGreaterThan(500);
    expect(DOCX_MIME).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');

    // Check standard ZIP PK header signature: 0x50 0x4B 0x03 0x04
    expect(docxBytes[0]).toBe(0x50);
    expect(docxBytes[1]).toBe(0x4b);
    expect(docxBytes[2]).toBe(0x03);
    expect(docxBytes[3]).toBe(0x04);
  });

  it('buildDocx embeds image drawing markup when image is provided', () => {
    // 1x1 transparent PNG bytes
    const dummyPng = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
      0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
      0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);

    const docxBytes = buildDocx({
      title: 'Chart Report',
      sections: [
        {
          heading: 'Sales Chart',
          image: { data: dummyPng, format: 'png', width: 640, height: 360 },
        },
      ],
    });

    expect(docxBytes.length).toBeGreaterThan(600);
  });

  it('buildStandaloneHtml produces autonomous single-file dashboard HTML', () => {
    const model = new DataModel()
      .addTable('Sales', [{ Product: 'Bike', Amount: 100 }])
      .addMeasure('Total Sales', 'SUM(Sales[Amount])');

    const html = buildStandaloneHtml(model, {
      pages: [
        {
          name: 'Overview',
          visuals: [{ type: 'card', fields: { value: 'Total Sales' } }],
        },
      ],
    });

    expect(html).toContain('<!doctype html>');
    expect(html).toContain('id="pbi-model"');
    expect(html).toContain('id="pbi-report"');
    expect(html).toContain('__PRISMBI_EMBED__');
    expect(html).toContain('Total Sales');
  });
});

