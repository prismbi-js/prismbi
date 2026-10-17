// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { msUntilDaily, renderReportHtml, renderVisualSvg, scheduleReport, watchMeasure, withDom } from '@prismbi/prismbi/server';
import { DataModel } from '@prismbi/prismbi';
import { buildModel } from '../examples/model';

const { window } = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true });
const win = window as unknown as Parameters<typeof withDom>[0];

describe('headless rendering', () => {
  it('installs and restores DOM globals', () => {
    const g = globalThis as Record<string, unknown>;
    expect(g.document).toBeUndefined();
    const tag = withDom(win, () => document.createElement('p').tagName);
    expect(tag).toBe('P');
    expect(g.document).toBeUndefined();
  });

  it('renders a chart to a standalone vector SVG at the requested size', () => {
    const model = buildModel();
    const svg = renderVisualSvg(model, { type: 'clusteredColumn', fields: { category: 'Product[Category]', values: 'Total Sales' } }, { window: win, width: 520, height: 300 });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('width="520"');
    expect((svg.match(/class="pbi-mark/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(svg).toContain('Bikes');
    expect(svg).not.toContain('foreignObject');
  });

  it('wraps HTML visuals (cards) in a foreignObject with styles', () => {
    const svg = renderVisualSvg(buildModel(), { type: 'card', fields: { value: 'Total Sales' } }, { window: win, width: 300, height: 160, theme: 'dark' });
    expect(svg).toContain('<foreignObject');
    expect(svg).toContain('$18.4M');
    expect(svg).toContain('data-mode="dark"');
    expect(() => renderVisualSvg(buildModel(), { type: 'card', fields: { value: 'Nope[x]' } }, { window: win })).toThrow(/Cannot render card/);
  });

  it('renders a report page to self-contained HTML', () => {
    const html = renderReportHtml(
      buildModel(),
      {
        name: 'Daily <brief>',
        pages: [
          {
            id: 'p',
            name: 'Overview',
            visuals: [
              { id: 'k', type: 'card', title: 'Sales', layout: { x: 0, y: 0, w: 4, h: 3 }, fields: { value: 'Total Sales' } },
              { id: 'c', type: 'line', title: 'Trend', layout: { x: 4, y: 0, w: 8, h: 6 }, fields: { category: 'Date[MonthYear]', values: 'Total Sales' } },
            ],
          },
        ],
      },
      { window: win, width: 1200 },
    );
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Daily &lt;brief></title>');
    expect(html).toContain('.pbi-report{');
    expect(html).not.toContain('<script');
    expect(html).toContain('data-visual-id="c"');
    expect(html).toMatch(/position:absolute;left:\d/);
    expect(html).toContain('path');
  });
});

describe('alerts and schedules', () => {
  const live = () =>
    new DataModel()
      .addTable('T', [{ v: 10 }])
      .addMeasure('Total', 'SUM(T[v])');

  it('alerts once per threshold crossing', () => {
    const m = live();
    const events: number[] = [];
    const stop = watchMeasure(m, { measure: 'Total', when: { above: 50 }, onAlert: (e) => events.push(e.value!) });
    m.appendRows('T', [{ v: 20 }]); // 30
    m.appendRows('T', [{ v: 30 }]); // 60 → crosses
    m.appendRows('T', [{ v: 5 }]); // 65, still above: no repeat
    expect(events).toEqual([60]);
    m.appendRows('T', [{ v: -40 }]); // 25, back below
    m.appendRows('T', [{ v: 40 }]); // 65 → crosses again
    expect(events).toEqual([60, 65]);
    stop();
    m.appendRows('T', [{ v: -100 }, { v: 200 }]);
    expect(events).toHaveLength(2);
  });

  it('alerts on relative change and debounces bursts', () => {
    vi.useFakeTimers();
    try {
      const m = live();
      const events: { value: number | null; previous: number | null }[] = [];
      watchMeasure(m, { measure: 'Total', when: { changeBy: 0.5 }, onAlert: (e) => events.push(e), debounceMs: 100 });
      m.appendRows('T', [{ v: 1 }]);
      m.appendRows('T', [{ v: 1 }]); // 12: +20%, below threshold
      vi.advanceTimersByTime(100);
      expect(events).toHaveLength(0);
      m.appendRows('T', [{ v: 4 }]); // 16: +60% from 10
      vi.advanceTimersByTime(100);
      expect(events).toEqual([expect.objectContaining({ value: 16, previous: 10 })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('schedules interval and daily jobs', async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      const stop = scheduleReport({ every: 1000, run: () => void runs++, immediate: true });
      await vi.advanceTimersByTimeAsync(3500);
      expect(runs).toBe(4);
      stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(runs).toBe(4);
      expect(msUntilDaily('08:30', new Date(2026, 0, 1, 8, 0))).toBe(30 * 60_000);
      expect(msUntilDaily('08:30', new Date(2026, 0, 1, 9, 0))).toBe(23.5 * 3_600_000);
      expect(() => msUntilDaily('8am')).toThrow(/HH:MM/);
    } finally {
      vi.useRealTimers();
    }
  });
});
