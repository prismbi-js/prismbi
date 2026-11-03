import { describe, expect, it } from 'vitest';
import { DataModel, Report, createVisual, detectAnomalies } from '../src/index';

describe('streaming data pushdown (Report.pushData)', () => {
  it('appends streaming rows and updates visuals immediately', () => {
    const model = new DataModel().addTable('Telemetry', [
      { Time: '10:00', Sensor: 'A', Temp: 22 },
      { Time: '10:01', Sensor: 'A', Temp: 23 },
    ]);

    const el = document.createElement('div');
    el.style.width = '600px';
    el.style.height = '400px';
    document.body.append(el);

    const r = new Report(el, {
      model,
      pages: [
        {
          name: 'Live Page',
          visuals: [
            {
              id: 'card',
              type: 'card',
              fields: { value: 'Telemetry[Temp]' },
            },
          ],
        },
      ],
    });
    r.flush();

    expect(el.querySelector('.pbi-card-value')?.textContent).toBe('45'); // Sum 22+23

    const pushedEvents: unknown[] = [];
    r.on('dataPushed', (e) => pushedEvents.push(e));

    // Stream 1 new row
    r.pushData('Telemetry', [{ Time: '10:02', Sensor: 'A', Temp: 25 }], { immediate: true });

    expect(pushedEvents).toHaveLength(1);
    expect(pushedEvents[0]).toEqual({ table: 'Telemetry', rowCount: 1 });
    expect(el.querySelector('.pbi-card-value')?.textContent).toBe('70'); // 45 + 25

    r.destroy();
    el.remove();
  });

  it('bounds stream with maxRows FIFO eviction', () => {
    const model = new DataModel().addTable('Feed', [
      { Id: 1, Val: 10 },
      { Id: 2, Val: 20 },
      { Id: 3, Val: 30 },
    ]);

    const el = document.createElement('div');
    document.body.append(el);

    const r = new Report(el, {
      model,
      pages: [
        {
          name: 'Feed Page',
          visuals: [
            {
              id: 'card',
              type: 'card',
              fields: { value: 'Feed[Val]' },
            },
          ],
        },
      ],
    });
    r.flush();

    expect(el.querySelector('.pbi-card-value')?.textContent).toBe('60'); // 10+20+30

    // Push 2 more rows with maxRows: 3 (sliding window drops Id 1 and 2)
    r.pushData('Feed', [{ Id: 4, Val: 40 }, { Id: 5, Val: 50 }], { maxRows: 3, immediate: true });

    // Surviving rows should be Id 3 (30), 4 (40), 5 (50) -> sum = 120
    expect(model.table('Feed').rowCount).toBe(3);
    expect(el.querySelector('.pbi-card-value')?.textContent).toBe('120');

    r.destroy();
    el.remove();
  });
});

describe('time-series anomaly detection', () => {
  it('detects high and low outliers via IQR', () => {
    // Normal series around 100 with one spike and one drop
    const values = [100, 102, 98, 101, 99, 103, 350, 97, 100, 102, 10, 99, 101];
    const anomalies = detectAnomalies(values, { method: 'iqr', sensitivity: 1.5 });

    expect(anomalies.length).toBe(2);

    const high = anomalies.find((a) => a.direction === 'high')!;
    expect(high).toBeDefined();
    expect(high.value).toBe(350);
    expect(high.score).toBeGreaterThan(2);

    const low = anomalies.find((a) => a.direction === 'low')!;
    expect(low).toBeDefined();
    expect(low.value).toBe(10);
  });

  it('detects outliers via z-score', () => {
    const values = [50, 52, 49, 51, 50, 200, 51, 48, 52];
    const anomalies = detectAnomalies(values, { method: 'zscore', sensitivity: 2.0 });

    expect(anomalies.length).toBe(1);
    expect(anomalies[0].value).toBe(200);
    expect(anomalies[0].direction).toBe('high');
    expect(anomalies[0].score).toBeGreaterThan(2.0);
  });

  it('detrends sloped series accurately without false positives', () => {
    // Linear progression +10 per step: 10, 20, 30, 40, 50, 60, 70, 80
    const cleanTrend = [10, 20, 30, 40, 50, 60, 70, 80];
    expect(detectAnomalies(cleanTrend)).toHaveLength(0);

    // One true departure in the middle
    const withDeparture = [10, 20, 30, 120, 50, 60, 70, 80];
    const anomalies = detectAnomalies(withDeparture);
    expect(anomalies.length).toBe(1);
    expect(anomalies[0].index).toBe(3);
    expect(anomalies[0].value).toBe(120);
  });

  it('renders anomaly beacon and halo rings on line chart', () => {
    const model = new DataModel().addTable('Metric', [
      { Date: '2026-01-01', Val: 100 },
      { Date: '2026-01-02', Val: 102 },
      { Date: '2026-01-03', Val: 99 },
      { Date: '2026-01-04', Val: 101 },
      { Date: '2026-01-05', Val: 103 },
      { Date: '2026-01-06', Val: 380 }, // Outlier
      { Date: '2026-01-07', Val: 98 },
      { Date: '2026-01-08', Val: 100 },
      { Date: '2026-01-09', Val: 102 },
    ]);

    const el = document.createElement('div');
    el.style.width = '600px';
    el.style.height = '400px';
    document.body.append(el);

    const v = createVisual(el, {
      type: 'line',
      model,
      fields: {
        category: 'Metric[Date]',
        values: 'Metric[Val]',
      },
      format: {
        analytics: {
          anomalies: { enabled: true, sensitivity: 1.5 },
        },
      },
    });
    v.flush();

    expect(el.querySelector('.pbi-error')).toBeNull();

    // Check anomaly beacon
    const beacon = el.querySelector('.pbi-anomaly-beacon');
    expect(beacon).toBeTruthy();

    const ring = el.querySelector('.pbi-anomaly-ring');
    expect(ring).toBeTruthy();

    const dot = el.querySelector('.pbi-anomaly-dot');
    expect(dot).toBeTruthy();

    v.destroy();
    el.remove();
  });
});

