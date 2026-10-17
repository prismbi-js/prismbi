import { describe, expect, it } from 'vitest';
import { DataModel, Report, buildXlsx, excelFormat, resultToSheet } from '../src/index';
import { makeModel } from './fixtures';
import { columnLetter, crc32, excelDate } from '../src/report/xlsx';

/** Read back a stored (uncompressed) ZIP: path → text. Checks every entry's CRC on the way. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map<string, string>();
  let p = 0;
  while (view.getUint32(p, true) === 0x04034b50) {
    expect(view.getUint16(p + 8, true)).toBe(0); // stored
    const crc = view.getUint32(p + 14, true);
    const size = view.getUint32(p + 18, true);
    const nameLen = view.getUint16(p + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 30, p + 30 + nameLen));
    const data = bytes.subarray(p + 30 + nameLen, p + 30 + nameLen + size);
    expect(crc32(data)).toBe(crc);
    out.set(name, new TextDecoder().decode(data));
    p += 30 + nameLen + size;
  }
  expect(view.getUint32(p, true)).toBe(0x02014b50); // central directory follows
  return out;
}

const parse = (xml: string) => {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
  return doc;
};

describe('xlsx export', () => {
  it('writes a well-formed workbook with typed cells', () => {
    const bytes = buildXlsx([
      {
        name: 'Sales / 2025?',
        columns: [{ header: 'Region' }, { header: 'Sales', format: '$#,0.00' }, { header: 'Day', format: 'shortDate' }, { header: 'Ok' }, { header: 'Share', format: 'percent' }],
        rows: [
          ['North & <East>', 1234.5, new Date(2025, 0, 31), true, 0.25],
          [null, -2, new Date(2025, 1, 1, 12), false, null],
          ['bad\u0001char', NaN, null, null, Infinity],
        ],
      },
      { name: 'Sales / 2025?', columns: [{ header: 'x' }], rows: [[1]] },
    ]);
    const files = unzip(bytes);
    expect([...files.keys()]).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/styles.xml']);
    for (const xml of files.values()) parse(xml);
    const sheets = [...parse(files.get('xl/workbook.xml')!).getElementsByTagName('sheet')].map((s) => s.getAttribute('name'));
    expect(sheets).toEqual(['Sales   2025', 'Sales   2025 2']);
    const sheet = parse(files.get('xl/worksheets/sheet1.xml')!);
    const cell = (ref: string) => [...sheet.getElementsByTagName('c')].find((c) => c.getAttribute('r') === ref);
    expect(cell('A1')!.textContent).toBe('Region');
    expect(cell('A2')!.textContent).toBe('North & <East>');
    expect(cell('B2')!.textContent).toBe('1234.5');
    expect(cell('C2')!.textContent).toBe(String(excelDate(new Date(2025, 0, 31))));
    expect(cell('D2')!.getAttribute('t')).toBe('b');
    expect(cell('A3')).toBeUndefined(); // BLANK
    expect(cell('A4')!.textContent).toBe('badchar');
    expect(cell('B4')).toBeUndefined(); // NaN / Infinity are left empty
    expect(cell('E4')).toBeUndefined();
    const styles = files.get('xl/styles.xml')!;
    expect(styles).toContain('formatCode="$#,0.00"');
    expect(styles).toContain('formatCode="yyyy-mm-dd"');
  });

  it('maps format strings and dates the way Excel reads them', () => {
    expect(excelFormat('$#,0.00')).toBe('$#,0.00');
    expect(excelFormat('0.0%')).toBe('0.0%');
    expect(excelFormat('#,0.0 "units"')).toBe('#,0.0 "units"');
    expect(excelFormat('€#,0K')).toBe('\\€#,0\\K');
    expect(excelFormat('longDate')).toBe('dddd, mmmm d, yyyy');
    expect(excelFormat('MMM yyyy')).toBe('mmm yyyy');
    expect(excelFormat('HH:mm')).toBe('hh:mm');
    expect(excelFormat('general')).toBe('General');
    expect(excelDate(new Date(1900, 0, 1))).toBe(2);
    expect(excelDate(new Date(2025, 0, 1, 18))).toBe(45658.75);
    expect(['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA'].map((_, i) => columnLetter([0, 25, 26, 51, 52, 701, 702][i]))).toEqual(['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA']);
  });

  it('turns a query result into a sheet with formats and totals', () => {
    const m = new DataModel()
      .addTable('Sales', [
        { Region: 'North', Day: new Date(2025, 0, 1), Amount: 10 },
        { Region: 'South', Day: new Date(2025, 0, 2), Amount: 20 },
      ])
      .addMeasure({ name: 'Total', expression: 'SUM(Sales[Amount])', format: '$#,0' });
    const sheet = resultToSheet(m.query({ groupBy: ['Sales[Region]', 'Sales[Day]'], values: ['Total'], totals: true }), 'By region');
    expect(sheet.columns.map((c) => [c.header, c.format])).toEqual([
      ['Region', undefined],
      ['Day', 'yyyy-MM-dd'],
      ['Total', '$#,0'],
    ]);
    expect(sheet.rows).toEqual([
      ['North', new Date(2025, 0, 1), 10],
      ['South', new Date(2025, 0, 2), 20],
      ['Total', null, 30],
    ]);
    expect(buildXlsx([sheet]).length).toBeGreaterThan(1000);
  });

  it('exports a report page and a single visual', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    const r = new Report(el, {
      model: makeModel(),
      pages: [
        {
          id: 'p1',
          name: 'Overview',
          visuals: [
            { id: 'cols', type: 'clusteredColumn', title: 'By category', layout: { x: 0, y: 4, w: 6, h: 6 }, fields: { category: 'Products[Category]', values: 'Total Sales' } },
            { id: 'card', type: 'card', layout: { x: 0, y: 0, w: 3, h: 2 }, fields: { value: 'Total Sales' } },
            { id: 'note', type: 'text', layout: { x: 3, y: 0, w: 3, h: 2 }, format: { text: { content: 'Hello' } } },
          ],
        },
        { id: 'p2', name: 'Detail', visuals: [{ id: 'bar', type: 'clusteredBar', layout: { x: 0, y: 0, w: 12, h: 8 }, fields: { category: 'Products[Name]', values: 'Total Sales' } }] },
      ],
    });
    r.flush();
    const names = (bytes: Uint8Array) => [...parse(unzip(bytes).get('xl/workbook.xml')!).getElementsByTagName('sheet')].map((s) => s.getAttribute('name'));
    // reading order (card above the chart); the text box has no data
    expect(names(await r.toXlsx())).toEqual(['Card', 'By category']);
    expect(names(await r.toXlsx({ pages: 'all' }))).toEqual(['Overview - Card', 'Overview - By category', 'Detail - Clustered bar chart']);
    const files = unzip(await r.visual('cols').toXlsx());
    const sheet = parse(files.get('xl/worksheets/sheet1.xml')!);
    expect(sheet.getElementsByTagName('row').length).toBe(r.visual('cols').data()!.rows.length + 1);
    r.destroy();
    el.remove();
  });
});
