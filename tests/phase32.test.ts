import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Report, DataModel } from '../src/index';
import { makeModel } from './fixtures';

let el: HTMLElement;
if (typeof window.PointerEvent === 'undefined') {
  window.PointerEvent = class PointerEvent extends MouseEvent {} as any;
  (globalThis as any).PointerEvent = window.PointerEvent;
}

beforeEach(() => {
  el = document.createElement('div');
  el.style.width = '1000px';
  el.style.height = '800px';
  document.body.append(el);
});
afterEach(() => el.remove());

describe('Phase 32 Features', () => {
  describe('1. Radar / Spider Chart Circular Grid & Styling', () => {
    it('supports circular grid rings instead of polygon web, custom fill opacity, line width, and dot visibility', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Radar Page',
            visuals: [
              {
                id: 'radar1',
                type: 'radar',
                layout: { x: 0, y: 0, w: 10, h: 8 },
                fields: {
                  category: 'Products[Name]',
                  values: ['Total Sales', 'Total Cost'],
                },
                format: {
                  radar: {
                    circularGrid: true,
                    fillOpacity: 0.35,
                    lineWidth: 3,
                    showDots: false,
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const radarVis = el.querySelector('[data-visual-id="radar1"]')!;
      const svg = radarVis.querySelector('svg.pbi-svg')!;
      expect(svg).toBeTruthy();

      // Check circular grid rings
      const gridCircles = svg.querySelectorAll('circle[fill="none"]');
      expect(gridCircles.length).toBeGreaterThanOrEqual(2);

      // Check polygon fill-opacity and stroke-width
      const poly = svg.querySelector('polygon[fill-opacity="0.35"]');
      expect(poly).toBeTruthy();
      expect(poly?.getAttribute('stroke-width')).toBe('3');

      // Check dots disabled
      const dots = svg.querySelectorAll('circle[stroke-width="2"]');
      expect(dots.length).toBe(0);
    });
  });

  describe('2. Waterfall Chart Step Connector Line Customization', () => {
    it('supports disabling connectors or customizing connector color, stroke width, and dashed style', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Waterfall Page',
            visuals: [
              {
                id: 'wf1',
                type: 'waterfall',
                layout: { x: 0, y: 0, w: 10, h: 8 },
                fields: {
                  category: 'Products[Category]',
                  values: 'Total Sales',
                },
                format: {
                  waterfall: {
                    showConnectors: true,
                    connectorColor: 'rgb(239, 68, 68)',
                    connectorWidth: 2.5,
                    connectorStyle: 'dashed',
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const wfVis = el.querySelector('[data-visual-id="wf1"]')!;
      const connectors = wfVis.querySelectorAll('line[stroke="rgb(239, 68, 68)"]');
      expect(connectors.length).toBeGreaterThanOrEqual(1);
      expect(connectors[0].getAttribute('stroke-width')).toBe('2.5');
      expect(connectors[0].getAttribute('stroke-dasharray')).toBe('4,3');

      // Test with connectors disabled
      report.updateVisual('wf1', {
        format: {
          waterfall: {
            showConnectors: false,
          },
        },
      });
      report.flush();
      const updatedConnectors = wfVis.querySelectorAll('line[stroke="rgb(239, 68, 68)"]');
      expect(updatedConnectors.length).toBe(0);
    });
  });

  describe('3. Bullet Chart Qualitative Band Colors & Custom Target Marker', () => {
    it('renders custom band colors and custom target line color and stroke width', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Bullet Page',
            visuals: [
              {
                id: 'bullet1',
                type: 'bullet',
                layout: { x: 0, y: 0, w: 10, h: 8 },
                fields: {
                  category: 'Products[Category]',
                  value: 'Total Sales',
                  target: 'Total Cost',
                },
                format: {
                  bullet: {
                    bandColors: ['#fee2e2', '#fef3c7', '#dcfce7'],
                    targetColor: 'rgb(37, 99, 235)',
                    targetWidth: 4,
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const bulletVis = el.querySelector('[data-visual-id="bullet1"]')!;
      // Qualitative band rects
      const redBand = bulletVis.querySelector('rect[fill="#fee2e2"]');
      const greenBand = bulletVis.querySelector('rect[fill="#dcfce7"]');
      expect(redBand).toBeTruthy();
      expect(greenBand).toBeTruthy();

      // Target indicator lines
      const targetLines = bulletVis.querySelectorAll('line[stroke="rgb(37, 99, 235)"]');
      expect(targetLines.length).toBeGreaterThanOrEqual(1);
      expect(targetLines[0].getAttribute('stroke-width')).toBe('4');
    });
  });

  describe('4. Candlestick Financial Styling', () => {
    it('supports hollow bullish candles, custom wick widths, and custom volume bar colors', () => {
      const stockModel = new DataModel().addTable('Stock', [
        { Date: '2026-10-26', Open: 150, High: 155, Low: 148, Close: 154, Volume: 1200000 },
        { Date: '2026-10-27', Open: 154, High: 158, Low: 152, Close: 151, Volume: 950000 },
      ]);

      const report = new Report(el, {
        model: stockModel,
        pages: [
          {
            id: 'p1',
            name: 'Stock Page',
            visuals: [
              {
                id: 'candle1',
                type: 'candlestick',
                layout: { x: 0, y: 0, w: 10, h: 8 },
                fields: {
                  category: 'Stock[Date]',
                  open: 'Stock[Open]',
                  high: 'Stock[High]',
                  low: 'Stock[Low]',
                  close: 'Stock[Close]',
                  volume: 'Stock[Volume]',
                },
                format: {
                  candlestick: {
                    hollow: true,
                    wickWidth: 2.5,
                    volumeColor: 'rgb(147, 51, 234)',
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const candleVis = el.querySelector('[data-visual-id="candle1"]')!;
      // Bullish candle is hollow (fill="transparent")
      const hollowRect = candleVis.querySelector('rect[fill="transparent"]');
      expect(hollowRect).toBeTruthy();
      expect(hollowRect?.getAttribute('stroke-width')).toBe('1.5');

      // Wick stroke width
      const wicks = candleVis.querySelectorAll('line[stroke-width="2.5"]');
      expect(wicks.length).toBeGreaterThanOrEqual(2);

      // Volume bars
      const volumeBar = candleVis.querySelector('rect[fill="rgb(147, 51, 234)"]');
      expect(volumeBar).toBeTruthy();
    });
  });

  describe('5. Multi-Row Card Font & Padding Customization', () => {
    it('applies custom cardPadding, valueFontSize, labelFontSize, and labelColor', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'MRC Page',
            visuals: [
              {
                id: 'mrc1',
                type: 'multiRowCard',
                layout: { x: 0, y: 0, w: 10, h: 8 },
                fields: {
                  category: 'Products[Category]',
                  values: ['Total Sales', 'Total Cost'],
                },
                format: {
                  multiRowCard: {
                    cardPadding: 16,
                    valueFontSize: 22,
                    labelFontSize: 13,
                    labelColor: 'rgb(100, 116, 139)',
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const mrcVis = el.querySelector('[data-visual-id="mrc1"]')!;
      const rows = mrcVis.querySelectorAll('.pbi-mrc-row');
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect((rows[0] as HTMLElement).style.padding).toBe('16px');

      const values = mrcVis.querySelectorAll('.pbi-mrc-value');
      expect(values.length).toBeGreaterThanOrEqual(1);
      expect((values[0] as HTMLElement).style.fontSize).toBe('22px');

      const labels = mrcVis.querySelectorAll('.pbi-card-label');
      expect(labels.length).toBeGreaterThanOrEqual(1);
      expect((labels[0] as HTMLElement).style.fontSize).toBe('13px');
      expect((labels[0] as HTMLElement).style.color).toBe('rgb(100, 116, 139)');
    });
  });
});
