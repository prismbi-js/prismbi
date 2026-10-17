import { describe, expect, it } from 'vitest';
import { watchAnomalies } from '@prismbi/prismbi/ai';
import type { AnomalyEvent } from '@prismbi/prismbi/ai';
import { watchAlerts } from '@prismbi/prismbi/server';
import { DataModel } from '@prismbi/prismbi';
import type { ReportDefinition } from '@prismbi/prismbi';

/** 24 steady months (with a little wobble) on a calendar table. */
function steadyModel() {
  const dates: { Date: Date; Year: number }[] = [];
  const sales: { Date: Date; Amount: number }[] = [];
  for (let i = 0; i < 26; i++) {
    const d = new Date(Date.UTC(2024, i, 1));
    dates.push({ Date: d, Year: d.getUTCFullYear() });
    if (i < 24) sales.push({ Date: d, Amount: 100 + ((i * 7) % 5) });
  }
  return new DataModel()
    .addTable('Calendar', dates)
    .addTable('Sales', sales)
    .addRelationship({ from: 'Sales[Date]', to: 'Calendar[Date]' })
    .addMeasure('Total', 'SUM(Sales[Amount])');
}

describe('watchAnomalies', () => {
  it('alerts once per new spike, not for existing data', () => {
    const model = steadyModel();
    const events: AnomalyEvent[] = [];
    const stop = watchAnomalies(model, { measure: 'Total', onAnomaly: (e) => events.push(e) });
    model.appendRows('Sales', [{ Date: new Date(Date.UTC(2026, 0, 1)), Amount: 101 }]);
    expect(events).toHaveLength(0);
    model.appendRows('Sales', [{ Date: new Date(Date.UTC(2026, 1, 1)), Amount: 900 }]);
    expect(events).toHaveLength(1);
    expect(events[0].insight.kind).toBe('anomaly');
    expect(events[0].insight.title).toMatch(/spike/i);
    expect(events[0].measure).toBe('Total');
    // more unrelated rows: the same spike doesn't alert again
    model.appendRows('Sales', [{ Date: new Date(Date.UTC(2025, 5, 1)), Amount: 0.5 }]);
    expect(events).toHaveLength(1);
    stop();
    model.appendRows('Sales', [{ Date: new Date(Date.UTC(2025, 2, 1)), Amount: -2000 }]);
    expect(events).toHaveLength(1);
  });

  it('alertExisting reports what is already unusual', () => {
    const model = steadyModel();
    model.appendRows('Sales', [{ Date: new Date(Date.UTC(2026, 0, 1)), Amount: 900 }]);
    const events: AnomalyEvent[] = [];
    watchAnomalies(model, { measure: 'Total', alertExisting: true, onAnomaly: (e) => events.push(e) })();
    expect(events).toHaveLength(1);
  });
});

describe('report anomaly alerts', () => {
  it('watchAlerts handles { anomaly: true }', () => {
    const model = steadyModel();
    const def: ReportDefinition = { pages: [{ name: 'P', visuals: [] }], alerts: [{ id: 'a', name: 'Unusual sales', measure: 'Total', when: { anomaly: true }, recipients: ['ops@example.com'] }] };
    const fired: string[] = [];
    const stop = watchAlerts(model, def, (a, e) => fired.push(`${a.name}|${e.insight?.kind}|${e.condition}|${e.value}`));
    model.appendRows('Sales', [{ Date: new Date(Date.UTC(2026, 0, 1)), Amount: 900 }]);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatch(/^Unusual sales\|anomaly\|.*spike.*\|\d+/i);
    stop();
  });
});
