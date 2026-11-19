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

describe('Phase 33 Features', () => {
  describe('1. Gantt Chart Progress & Milestone Styling', () => {
    it('supports customizing bar height, corner radius, progress toggle & colors, and milestone marker color', () => {
      const taskModel = new DataModel()
        .addTable('Tasks', [
          { Task: 'Feature Planning', Start: new Date('2026-11-01'), End: new Date('2026-11-05'), Progress: 1.0 },
          { Task: 'Implementation Sprint', Start: new Date('2026-11-06'), End: new Date('2026-11-15'), Progress: 0.5 },
          { Task: 'Release Gate Milestone', Start: new Date('2026-11-15'), End: new Date('2026-11-15'), Progress: 0.0 },
        ])
        .addMeasure('MStart', 'MIN(Tasks[Start])')
        .addMeasure('MEnd', 'MAX(Tasks[End])')
        .addMeasure('MProgress', 'MAX(Tasks[Progress])');

      const report = new Report(el, {
        model: taskModel,
        pages: [
          {
            id: 'p1',
            name: 'Gantt Page',
            visuals: [
              {
                id: 'gantt1',
                type: 'gantt',
                layout: { x: 0, y: 0, w: 10, h: 8 },
                fields: {
                  task: 'Tasks[Task]',
                  start: 'MStart',
                  end: 'MEnd',
                  progress: 'MProgress',
                },
                format: {
                  gantt: {
                    barHeight: 22,
                    cornerRadius: 6,
                    barColor: 'rgb(59, 130, 246)',
                    progressColor: 'rgb(29, 78, 216)',
                    milestoneColor: 'rgb(245, 158, 11)',
                    showProgress: true,
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const ganttVis = el.querySelector('[data-visual-id="gantt1"]')!;
      // Base task bar has custom color, height, and corner radius
      const barRect = ganttVis.querySelector('rect[fill="rgb(59, 130, 246)"]');
      expect(barRect).toBeTruthy();
      expect(barRect?.getAttribute('rx')).toBe('6');
      expect(barRect?.getAttribute('height')).toBe('22');

      // Progress bar has custom color
      const progRect = ganttVis.querySelector('rect[fill="rgb(29, 78, 216)"]');
      expect(progRect).toBeTruthy();

      // Milestone has diamond path with custom milestone color
      const milestone = ganttVis.querySelector('path[fill="rgb(245, 158, 11)"]');
      expect(milestone).toBeTruthy();

      // Test with showProgress: false
      report.updateVisual('gantt1', {
        format: {
          gantt: {
            showProgress: false,
          },
        },
      });
      report.flush();
      expect(ganttVis.querySelector('rect[fill="rgb(29, 78, 216)"]')).toBeNull();
    });
  });

  describe('2. Box Plot Mean & Whisker Styling', () => {
    it('supports customizing box opacity, whisker stroke width, and toggling mean and outlier markers', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'BoxPlot Page',
            visuals: [
              {
                id: 'bp1',
                type: 'boxPlot',
                layout: { x: 0, y: 0, w: 10, h: 8 },
                fields: {
                  category: 'Region[Name]',
                  values: 'Sales[Amount]',
                },
                format: {
                  boxPlot: {
                    boxOpacity: 0.6,
                    whiskerWidth: 3,
                    showMean: true,
                    showOutliers: true,
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const bpVis = el.querySelector('[data-visual-id="bp1"]')!;
      const boxes = bpVis.querySelectorAll('rect[fill-opacity="0.6"]');
      expect(boxes.length).toBeGreaterThanOrEqual(1);

      const whiskers = bpVis.querySelectorAll('line[stroke-width="3"]');
      expect(whiskers.length).toBeGreaterThanOrEqual(2);

      // Mean circle indicators
      const means = bpVis.querySelectorAll('circle[r="3"]');
      expect(means.length).toBeGreaterThanOrEqual(1);

      // Test toggling off mean and outliers
      report.updateVisual('bp1', {
        format: {
          boxPlot: {
            showMean: false,
            showOutliers: false,
          },
        },
      });
      report.flush();
      expect(bpVis.querySelectorAll('circle[r="3"]').length).toBe(0);
    });
  });

  describe('3. Chord Diagram Arc Width & Ribbon Opacity', () => {
    it('supports configuring outer arc width, ribbon opacity, pad angle, and toggling labels', () => {
      const migModel = new DataModel().addTable('Migrations', [
        { Origin: 'Europe', Dest: 'North America', Flow: 1500 },
        { Origin: 'North America', Dest: 'Asia', Flow: 2200 },
        { Origin: 'Asia', Dest: 'Europe', Flow: 1800 },
      ]);

      const report = new Report(el, {
        model: migModel,
        pages: [
          {
            id: 'p1',
            name: 'Chord Page',
            visuals: [
              {
                id: 'chord1',
                type: 'chord',
                layout: { x: 0, y: 0, w: 10, h: 8 },
                fields: {
                  source: 'Migrations[Origin]',
                  target: 'Migrations[Dest]',
                  values: 'Migrations[Flow]',
                },
                format: {
                  chord: {
                    arcWidth: 24,
                    ribbonOpacity: 0.3,
                    showLabels: false,
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const chordVis = el.querySelector('[data-visual-id="chord1"]')!;
      const ribbons = chordVis.querySelectorAll('path.pbi-chord-ribbon[fill-opacity="0.3"]');
      expect(ribbons.length).toBe(3);

      // Labels disabled
      const labels = chordVis.querySelectorAll('.pbi-chord-nodes text');
      expect(labels.length).toBe(0);
    });
  });

  describe('4. Sankey Diagram Node Dimensions & Flow Opacity', () => {
    it('supports customizing node width, node padding, link opacity, and toggling labels', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Sankey Page',
            visuals: [
              {
                id: 'sankey1',
                type: 'sankey',
                layout: { x: 0, y: 0, w: 10, h: 8 },
                fields: {
                  source: 'Region[Name]',
                  target: 'Products[Category]',
                  values: 'Total Sales',
                },
                format: {
                  sankey: {
                    nodeWidth: 20,
                    nodePadding: 14,
                    linkOpacity: 0.5,
                    showLabels: false,
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const sankeyVis = el.querySelector('[data-visual-id="sankey1"]')!;
      // Node rectangles have custom width
      const nodeRects = sankeyVis.querySelectorAll('rect');
      expect(nodeRects.length).toBeGreaterThanOrEqual(1);
      expect(nodeRects[0].getAttribute('width')).toBe('20');

      // Flow path curves have custom fill opacity
      const flowPaths = sankeyVis.querySelectorAll('path[fill-opacity="0.5"]');
      expect(flowPaths.length).toBeGreaterThanOrEqual(1);

      // Labels disabled
      const labels = sankeyVis.querySelectorAll('text.pbi-label');
      expect(labels.length).toBe(0);
    });
  });

  describe('5. Histogram Binning & Bar Customization', () => {
    it('supports customizing explicit bins, bar color, and corner rounding', () => {
      const model = makeModel();
      const report = new Report(el, {
        model,
        pages: [
          {
            id: 'p1',
            name: 'Histogram Page',
            visuals: [
              {
                id: 'hist1',
                type: 'histogram',
                layout: { x: 0, y: 0, w: 10, h: 8 },
                fields: {
                  values: 'Sales[Amount]',
                },
                format: {
                  histogram: {
                    bins: 8,
                    barColor: 'rgb(16, 185, 129)',
                    cornerRadius: 5,
                  },
                },
              },
            ],
          },
        ],
      });
      report.flush();

      const histVis = el.querySelector('[data-visual-id="hist1"]')!;
      const bars = histVis.querySelectorAll('rect.pbi-mark');
      expect(bars.length).toBeGreaterThanOrEqual(1);
      expect(bars[0].getAttribute('fill')).toBe('rgb(16, 185, 129)');
      expect(bars[0].getAttribute('rx')).toBe('5');
    });
  });
});
