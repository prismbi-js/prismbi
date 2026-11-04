import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Report } from '../src/index';
import { makeModel } from './fixtures';

describe('Combo Chart (lineClusteredColumn) Dual Y-Axis', () => {
  let el: HTMLElement;
  beforeEach(() => {
    el = document.createElement('div');
    document.body.append(el);
  });
  afterEach(() => {
    el.remove();
    document.querySelectorAll('.pbi-report').forEach((n) => n.remove());
  });

  it('renders both column bars and lines with independent secondary Y-axis', () => {
    const r = new Report(el, {
      model: makeModel(),
      pages: [
        {
          name: 'Combo Page',
          visuals: [
            {
              id: 'combo1',
              type: 'lineClusteredColumn',
              fields: {
                category: 'Products[Category]',
                values: 'Total Sales',
                lineValues: 'Margin %',
              },
              layout: { x: 0, y: 0, w: 8, h: 6 },
            },
          ],
        },
      ],
    });
    r.flush();

    const vis = el.querySelector('[data-visual-id="combo1"]')!;
    expect(vis).toBeTruthy();

    // Bars and lines rendered
    const marks = vis.querySelectorAll('path.pbi-mark');
    expect(marks.length).toBeGreaterThan(0);
    const lines = vis.querySelectorAll('path.pbi-line');
    expect(lines.length).toBeGreaterThan(0);

    // Secondary Y-axis tick labels rendered on the right
    const secondaryTicks = vis.querySelectorAll('.pbi-tick-secondary');
    expect(secondaryTicks.length).toBeGreaterThan(0);
  });

  it('renders primary and secondary axis titles when specified', () => {
    const r = new Report(el, {
      model: makeModel(),
      pages: [
        {
          name: 'Titles Page',
          visuals: [
            {
              id: 'combo2',
              type: 'lineClusteredColumn',
              fields: {
                category: 'Products[Category]',
                values: 'Total Sales',
                lineValues: 'Margin %',
              },
              format: {
                valueAxis: {
                  show: true,
                  title: 'Revenue ($)',
                },
                secondaryValueAxis: {
                  show: true,
                  title: 'Profit Margin (%)',
                  mode: 'on',
                },
              },
            },
          ],
        },
      ],
    });
    r.flush();

    const vis = el.querySelector('[data-visual-id="combo2"]')!;
    const primaryTitle = vis.querySelector('.pbi-axis-title:not(.pbi-axis-title-secondary)');
    expect(primaryTitle?.textContent).toBe('Revenue ($)');

    const secondaryTitle = vis.querySelector('.pbi-axis-title-secondary');
    expect(secondaryTitle?.textContent).toBe('Profit Margin (%)');
  });

  it('respects secondaryValueAxis mode: off to force a single shared axis', () => {
    const r = new Report(el, {
      model: makeModel(),
      pages: [
        {
          name: 'Off Page',
          visuals: [
            {
              id: 'combo3',
              type: 'lineClusteredColumn',
              fields: {
                category: 'Products[Category]',
                values: 'Total Sales',
                lineValues: 'Margin %',
              },
              format: {
                secondaryValueAxis: {
                  mode: 'off',
                },
              },
            },
          ],
        },
      ],
    });
    r.flush();

    const vis = el.querySelector('[data-visual-id="combo3"]')!;
    const secondaryTicks = vis.querySelectorAll('.pbi-tick-secondary');
    expect(secondaryTicks.length).toBe(0);
  });

  it('renders data labels on both columns and lines when enabled', () => {
    const r = new Report(el, {
      model: makeModel(),
      pages: [
        {
          name: 'Labels Page',
          visuals: [
            {
              id: 'combo4',
              type: 'lineClusteredColumn',
              fields: {
                category: 'Products[Category]',
                values: 'Total Sales',
                lineValues: 'Margin %',
              },
              format: {
                dataLabels: {
                  show: true,
                },
              },
            },
          ],
        },
      ],
    });
    r.flush();

    const vis = el.querySelector('[data-visual-id="combo4"]')!;
    const labels = vis.querySelectorAll('text.pbi-label:not(.pbi-end-label)');
    // Both column bars and line points should have labels
    expect(labels.length).toBeGreaterThan(4);
  });
});

