import { describe, expect, it } from 'vitest';
import { diffReports, formatDiff, joinReport, splitReport, stableStringify } from '@prismbi/prismbi/files';
import type { ReportDefinition } from '../src/index';

const report = (): ReportDefinition => ({
  name: 'Sales',
  filters: [{ target: 'Date[Date]', op: 'between', min: new Date(2024, 0, 1), max: new Date(2025, 11, 31) }],
  pages: [
    {
      id: 'overview',
      name: 'Overview',
      visuals: [
        { id: 'year', type: 'slicer', layout: { x: 0, y: 0, w: 3, h: 2 }, fields: { field: 'Date[Year]' } },
        { id: 'cols', type: 'clusteredColumn', title: 'By category', layout: { x: 3, y: 0, w: 9, h: 6 }, fields: { category: 'Products[Category]', values: 'Total Sales' }, format: { dataLabels: { show: true } } },
        { type: 'card', layout: { x: 0, y: 2, w: 3, h: 2 }, fields: { value: 'Total Sales' } },
      ],
    },
    { name: 'Details & Notes', hidden: true, visuals: [{ id: 'tbl', type: 'table', layout: { x: 0, y: 0, w: 12, h: 8 }, fields: { columns: ['Products[Name]', 'Total Sales'] } }] },
  ],
  bookmarks: [{ name: 'Bikes only', pageId: 'overview', reportFilters: [], pageFilters: {}, slicers: {}, selection: null, drill: {} }],
});

describe('report files', () => {
  it('splits into one stable file per page, visual and bookmark', () => {
    const files = splitReport(report());
    expect(Object.keys(files).sort()).toEqual([
      'bookmarks/bikes-only.json',
      'pages/details-notes/page.json',
      'pages/details-notes/visuals/tbl.json',
      'pages/overview/page.json',
      'pages/overview/visuals/card-3.json',
      'pages/overview/visuals/cols.json',
      'pages/overview/visuals/year.json',
      'report.json',
    ]);
    // readable, diff-friendly JSON: small objects inline, id lists one per line, dates tagged
    expect(files['pages/overview/visuals/cols.json']).toContain('"layout": {"x": 3, "y": 0, "w": 9, "h": 6}');
    expect(files['pages/overview/page.json']).toContain('"visuals": [\n    "year",\n    "cols",\n    "card-3"\n  ]');
    expect(files['report.json']).toContain('"$date"');
    expect(files['pages/overview/visuals/cols.json'].indexOf('"id"')).toBeLessThan(files['pages/overview/visuals/cols.json'].indexOf('"type"'));
    // deterministic regardless of key insertion order
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
    expect(splitReport(report())).toEqual(files);
  });

  it('joins back to the same report (ids filled in) and tolerates merges', () => {
    const files = splitReport(report());
    const back = joinReport(files);
    expect(back.pages.map((p) => p.id)).toEqual(['overview', 'details-notes']);
    expect(back.pages[0].visuals.map((v) => v.id)).toEqual(['year', 'cols', 'card-3']);
    expect((back.filters![0] as { min: Date }).min).toBeInstanceOf(Date);
    expect(back.bookmarks![0].name).toBe('Bikes only');
    // idempotent: splitting the joined report gives the same files
    expect(splitReport(back)).toEqual(files);
    expect(back.pages[0].visuals[1]).toMatchObject(report().pages[0].visuals[1]);
    expect(back.pages[1]).toMatchObject({ name: 'Details & Notes', hidden: true });
    // a visual file added on another branch, and a listed visual whose file was deleted
    const merged = { ...files, 'pages/overview/visuals/new-kpi.json': '{ "id": "new-kpi", "type": "card", "fields": { "value": "Orders" } }' };
    delete (merged as Record<string, string>)['pages/overview/visuals/year.json'];
    expect(joinReport(merged).pages[0].visuals.map((v) => v.id)).toEqual(['cols', 'card-3', 'new-kpi']);
    expect(() => joinReport({})).toThrow(/report\.json/);
    expect(() => joinReport({ ...files, 'pages/overview/visuals/cols.json': '{ oops' })).toThrow(/cols\.json/);
  });

  it('describes changes in plain language', () => {
    const before = report();
    const after = report();
    after.pages[0].visuals[1].format = { dataLabels: { show: false } };
    after.pages[0].visuals[1].title = 'Sales by category';
    after.pages[0].visuals.splice(0, 1);
    after.pages[1].visuals.push({ id: 'kpi', type: 'kpi', layout: { x: 0, y: 8, w: 4, h: 3 }, fields: { value: 'Total Sales' } });
    after.pages.reverse();
    const changes = diffReports(before, after);
    const text = formatDiff(changes);
    expect(text).toContain('+ page "Details & Notes" › visual "kpi"');
    expect(text).toContain('- page "Overview" › visual "year"');
    expect(text).toContain('~ page "Overview" › visual "Sales by category" › format.dataLabels.show: true → false');
    expect(text).toContain('~ page "Overview" › visual "Sales by category" › title: "By category" → "Sales by category"');
    expect(text).toContain('↕ page order');
    expect(formatDiff(diffReports(before, report()))).toBe('No changes.');
  });
});
