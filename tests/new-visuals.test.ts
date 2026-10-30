import { describe, expect, it } from 'vitest';
import { DataModel, createVisual } from '../src/index';

describe('new visuals (Gantt & Candlestick)', () => {
  it('renders gantt chart with task bars and progress', () => {
    const model = new DataModel().addTable('Tasks', [
      { Task: 'Design Architecture', Start: '2026-11-01', End: '2026-11-05', Progress: 1.0 },
      { Task: 'Core Implementation', Start: '2026-11-06', End: '2026-11-15', Progress: 0.65 },
      { Task: 'Beta Release Milestone', Start: '2026-11-15', End: '2026-11-15', Progress: 0.0 },
    ]);

    const el = document.createElement('div');
    el.style.width = '600px';
    el.style.height = '400px';
    document.body.append(el);

    const v = createVisual(el, {
      type: 'gantt',
      model,
      fields: {
        task: 'Tasks[Task]',
        start: 'Tasks[Start]',
        end: 'Tasks[End]',
        progress: 'Tasks[Progress]',
      },
    });
    v.flush();
    const err = el.querySelector('.pbi-error');
    if (err) console.error('Visual error text:', err.textContent, (v as any).lastError?.stack ?? (v as any).lastError);
    expect(el.querySelector('.pbi-error')).toBeNull();
    const svg = el.querySelector('svg.pbi-svg');
    expect(svg).toBeTruthy();

    const marks = el.querySelectorAll('.pbi-mark');
    expect(marks.length).toBe(3);

    // Milestone has diamond path
    const milestonePath = marks[2].querySelector('path');
    expect(milestonePath).toBeTruthy();

    v.destroy();
    el.remove();
  });

  it('renders candlestick chart with OHLC and volume', () => {
    const model = new DataModel().addTable('Stock', [
      { Date: '2026-10-26', Open: 150, High: 155, Low: 148, Close: 154, Volume: 1200000 },
      { Date: '2026-10-27', Open: 154, High: 158, Low: 152, Close: 157, Volume: 950000 },
      { Date: '2026-10-28', Open: 157, High: 159, Low: 149, Close: 150, Volume: 1800000 },
    ]);

    const el = document.createElement('div');
    el.style.width = '600px';
    el.style.height = '400px';
    document.body.append(el);

    const v = createVisual(el, {
      type: 'candlestick',
      model,
      fields: {
        category: 'Stock[Date]',
        open: 'Stock[Open]',
        high: 'Stock[High]',
        low: 'Stock[Low]',
        close: 'Stock[Close]',
        volume: 'Stock[Volume]',
      },
    });
    v.flush();
    const err = el.querySelector('.pbi-error');
    if (err) console.error('Visual error text:', err.textContent, (v as any).lastError?.stack ?? (v as any).lastError);
    expect(el.querySelector('.pbi-error')).toBeNull();
    const svg = el.querySelector('svg.pbi-svg');
    expect(svg).toBeTruthy();

    const marks = el.querySelectorAll('.pbi-mark');
    expect(marks.length).toBe(3);

    // Each candle has wick line and body rect
    expect(marks[0].querySelector('line')).toBeTruthy();
    expect(marks[0].querySelector('rect')).toBeTruthy();

    v.destroy();
    el.remove();
  });

  it('renders chord diagram with perimeter node arcs and flow ribbons', () => {
    const model = new DataModel().addTable('Migrations', [
      { Origin: 'Europe', Dest: 'North America', Flow: 1500 },
      { Origin: 'North America', Dest: 'Asia', Flow: 2200 },
      { Origin: 'Asia', Dest: 'Europe', Flow: 1800 },
      { Origin: 'Europe', Dest: 'Asia', Flow: 900 },
    ]);

    const el = document.createElement('div');
    el.style.width = '600px';
    el.style.height = '600px';
    document.body.append(el);

    const v = createVisual(el, {
      type: 'chord',
      model,
      fields: {
        source: 'Migrations[Origin]',
        target: 'Migrations[Dest]',
        values: 'Migrations[Flow]',
      },
    });
    v.flush();
    const err = el.querySelector('.pbi-error');
    if (err) console.error('Visual error text:', err.textContent, (v as any).lastError?.stack ?? (v as any).lastError);
    expect(el.querySelector('.pbi-error')).toBeNull();
    const svg = el.querySelector('svg.pbi-svg');
    expect(svg).toBeTruthy();

    // Node arcs
    const marks = el.querySelectorAll('.pbi-mark');
    expect(marks.length).toBe(3); // 3 unique regions (Europe, North America, Asia)

    // Ribbons
    const ribbons = el.querySelectorAll('.pbi-chord-ribbon');
    expect(ribbons.length).toBe(4);

    v.destroy();
    el.remove();
  });
});
