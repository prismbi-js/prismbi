import { describe, expect, it } from 'vitest';
import { createVisual, listVisuals, getTheme } from '../src/index';
import { buildModel } from '../examples/model';

const model = buildModel();
const mount = (spec: Record<string, unknown>) => {
  const el = document.createElement('div');
  el.style.height = '360px';
  document.body.append(el);
  const r = createVisual(el, { model, ...(spec as object) } as never);
  r.flush();
  return { el, r, text: el.querySelector('[aria-description]')?.getAttribute('aria-description') ?? '' };
};

describe('chart narration', () => {
  it('describes trends, extremes and shares in plain language', () => {
    const line = mount({ type: 'line', title: 'Monthly sales', fields: { category: 'Date[MonthYear]', values: 'Total Sales' } });
    expect(line.text).toMatch(/^Line chart "Monthly sales" of Total Sales by MonthYear: 24 values from Jan 2024 to Dec 2025\./);
    expect(line.text).toMatch(/Highest is [A-Z][a-z]{2} \d{4} at \$[\d.]+[KM], lowest is/);
    expect(line.text).toMatch(/(Up|Down) [\d.]+% from first to last\./);
    expect(line.el.querySelector('.pbi-sr-only')?.textContent).toBe(line.text);
    const bars = mount({ type: 'clusteredColumn', fields: { category: 'Product[Category]', values: 'Total Sales' } });
    expect(bars.text).toMatch(/Bikes is the largest, with \d+% of the total\./);
    const card = mount({ type: 'card', fields: { value: 'Total Sales' } });
    expect(card.text).toBe('Card: Total Sales is $18.4M.');
    expect(bars.r.visual(bars.r.visualIds()[0]).describe()).toBe(bars.text);
    // opt out
    const quiet = mount({ type: 'line', fields: { category: 'Date[MonthYear]', values: 'Total Sales' }, format: { accessibility: { narration: false } } });
    expect(quiet.text).toBe('');
    for (const m of [line, bars, card, quiet]) (m.r.destroy(), m.el.remove());
  });

  it('every chart type exposes an accessible name and a narration', () => {
    const specs: Record<string, Record<string, unknown>> = {
      clusteredColumn: { category: 'Product[Category]', values: 'Total Sales' },
      clusteredBar: { category: 'Region[Region]', values: 'Total Sales' },
      line: { category: 'Date[MonthYear]', values: 'Total Sales' },
      area: { category: 'Date[MonthShort]', values: 'Total Sales' },
      pie: { legend: 'Sales[Channel]', values: 'Total Sales' },
      donut: { legend: 'Region[Group]', values: 'Total Sales' },
      treemap: { category: 'Product[Subcategory]', values: 'Total Sales' },
      funnel: { category: 'Sales[Channel]', values: 'Total Sales' },
      scatter: { details: 'Product[Name]', x: 'Total Sales', y: 'Margin %' },
      waterfall: { category: 'Product[Category]', values: 'Sales Change' },
      heatmap: { rows: 'Region[Region]', columns: 'Date[MonthShort]', values: 'Total Sales' },
      calendar: { date: 'Date[Date]', values: 'Total Sales' },
      gauge: { value: 'Margin %' },
      kpi: { trend: 'Date[MonthYear]', value: 'Total Sales', target: 'Sales Target' },
    };
    for (const [type, fields] of Object.entries(specs)) {
      expect(listVisuals()).toContain(type);
      const m = mount({ type, fields });
      expect(m.el.querySelector('.pbi-error'), type).toBeNull();
      expect(m.text.length, `${type} narration`).toBeGreaterThan(20);
      const svg = m.el.querySelector('svg[role="img"]');
      if (svg) expect(svg.getAttribute('aria-label'), `${type} aria-label`).toBeTruthy();
      m.r.destroy();
      m.el.remove();
    }
  });

  it('ships a high-contrast theme', () => {
    const t = getTheme('high-contrast');
    expect(t.background).toBe('#000000');
    expect(t.foreground).toBe('#ffffff');
    expect(new Set(t.dataColors).size).toBe(8);
  });
});
