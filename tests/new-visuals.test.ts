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

  it('renders force-directed network graph with nodes and interconnecting edges', () => {
    const model = new DataModel().addTable('Topology', [
      { Src: 'Router-A', Dst: 'Switch-1', Traffic: 450, Zone: 'Core' },
      { Src: 'Router-A', Dst: 'Switch-2', Traffic: 300, Zone: 'Core' },
      { Src: 'Switch-1', Dst: 'Server-1', Traffic: 120, Zone: 'Access' },
      { Src: 'Switch-1', Dst: 'Server-2', Traffic: 180, Zone: 'Access' },
      { Src: 'Switch-2', Dst: 'Server-3', Traffic: 250, Zone: 'Access' },
      { Src: 'Server-2', Dst: 'Server-3', Traffic: 90, Zone: 'Peer' },
    ]);

    const el = document.createElement('div');
    el.style.width = '600px';
    el.style.height = '500px';
    document.body.append(el);

    const v = createVisual(el, {
      type: 'network',
      model,
      fields: {
        source: 'Topology[Src]',
        target: 'Topology[Dst]',
        values: 'Topology[Traffic]',
        group: 'Topology[Zone]',
      },
      format: {
        network: {
          arrows: true,
          nodeSize: 10,
          labels: true,
        },
      },
    });
    v.flush();

    expect(el.querySelector('.pbi-error')).toBeNull();
    const svg = el.querySelector('svg.pbi-network');
    expect(svg).toBeTruthy();

    // Check nodes (5 distinct entities: Router-A, Switch-1, Switch-2, Server-1, Server-2, Server-3)
    const nodes = el.querySelectorAll('.pbi-network-node');
    expect(nodes.length).toBe(6);

    // Check edges (6 links)
    const edges = el.querySelectorAll('.pbi-network-edge');
    expect(edges.length).toBe(6);

    // Check arrow marker defs
    const marker = el.querySelector('#pbi-net-arrow');
    expect(marker).toBeTruthy();

    // Check labels
    const labels = el.querySelectorAll('.pbi-network-label');
    expect(labels.length).toBe(6);

    // Check interactive selection
    const firstCircle = el.querySelector('.pbi-network-circle') as SVGElement;
    expect(firstCircle).toBeTruthy();
    firstCircle.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    v.destroy();
    el.remove();
  });
});
