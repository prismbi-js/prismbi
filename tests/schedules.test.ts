// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { runSubscriptions, watchAlerts } from '@prismbi/prismbi/server';
import { DataModel } from '@prismbi/prismbi';
import type { ReportDefinition } from '@prismbi/prismbi';

const { window } = new JSDOM('<!doctype html><html><head></head><body></body></html>');

describe('report subscriptions and alerts', () => {
  it('sends subscribed pages on schedule and fires alerts from the definition', async () => {
    vi.useFakeTimers();
    try {
      const model = new DataModel().addTable('T', [{ g: 'a', v: 10 }]).addMeasure('Total', 'SUM(T[v])');
      const def: ReportDefinition = {
        name: 'Ops',
        pages: [{ id: 'p', name: 'Main', visuals: [{ id: 'k', type: 'card', layout: { x: 0, y: 0, w: 4, h: 3 }, fields: { value: 'Total' } }] }],
        subscriptions: [
          { id: 's1', name: 'Hourly', page: 'Main', schedule: 3_600_000, recipients: ['ops@example.com'] },
          { id: 's2', name: 'Off', page: 'Main', schedule: 1000, recipients: ['x@example.com'], enabled: false },
        ],
        alerts: [{ id: 'a1', name: 'Low total', measure: 'Total', when: { below: 5 }, recipients: ['ops@example.com'] }],
      };
      const sent: { to: string[]; html: string }[] = [];
      const stop = runSubscriptions(model, def, { window: window as never, send: (s, html) => void sent.push({ to: s.recipients, html }) });
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toEqual(['ops@example.com']);
      expect(sent[0].html).toContain('<title>Ops · Hourly</title>');
      expect(sent[0].html).toContain('10');
      stop();
      const fired: string[] = [];
      const off = watchAlerts(model, def, (a, e) => fired.push(`${a.name}:${e.value}`));
      model.appendRows('T', [{ g: 'b', v: -7 }]);
      expect(fired).toEqual(['Low total:3']);
      off();
    } finally {
      vi.useRealTimers();
    }
  });
});
