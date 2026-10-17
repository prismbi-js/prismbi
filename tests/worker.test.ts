// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createLocalEngine, createWorkerEngine, serveModel, type PortLike } from 'prismbi/worker';
import { buildModel } from '../examples/model';

/** A DOM-style message port (node's global MessagePort supports addEventListener; messages are structured-cloned). */
function adapt(port: MessagePort): PortLike {
  return { postMessage: (m) => port.postMessage(m), addEventListener: (t, fn) => port.addEventListener(t, fn as never), removeEventListener: (t, fn) => port.removeEventListener(t, fn as never), start: () => port.start(), terminate: () => port.close() };
}

function pair() {
  const ch = new MessageChannel();
  const model = buildModel();
  serveModel(model, adapt(ch.port1));
  return { model, engine: createWorkerEngine(adapt(ch.port2)), close: () => ch.port1.close() };
}

describe('worker engine', () => {
  it('answers queries and evaluations across a message channel like the model itself', async () => {
    const { model, engine, close } = pair();
    try {
      const spec = { groupBy: ['Product[Category]'], values: ['Total Sales', 'Margin %'], filters: [{ target: 'Date[Year]', op: 'eq' as const, value: 2024 }], totals: true };
      const res = await engine.query(spec);
      const direct = model.query(spec);
      expect(res.rows).toEqual(direct.rows);
      expect(res.totals).toEqual(direct.totals);
      expect(res.baseFilters).toEqual([spec.filters[0]]);
      expect(await engine.evaluate('[Total Sales]', spec.filters)).toBe(model.evaluate('[Total Sales]', spec.filters));
      const t = await engine.evaluateTable('TOPN(2, VALUES(Product[Category]), [Total Sales])');
      expect(t.columns).toEqual(['Category']);
      expect(t.rows).toHaveLength(2);
      const meta = await engine.metadata();
      expect(meta.measures.some((m) => m.name === 'Total Sales')).toBe(true);
    } finally {
      engine.dispose();
      close();
    }
  });

  it('mutates the served model and reports errors', async () => {
    const { engine, close } = pair();
    try {
      await engine.addTable('Extra', [{ x: 1 }, { x: 2 }]);
      await engine.addMeasure({ name: 'X', expression: 'SUM(Extra[x])' });
      expect(await engine.evaluate('[X]')).toBe(3);
      await engine.appendRows('Extra', [{ x: 10 }], { maxRows: 2 });
      expect(await engine.evaluate('[X]')).toBe(12);
      await expect(engine.evaluate('[Nope]')).rejects.toThrow(/Nope/);
      await expect(engine.query({ values: ['X'], filters: [{ kind: 'rows', table: 'Extra', rows: new Set([0]), key: 'k' }] })).rejects.toThrow(/filter specs/);
    } finally {
      engine.dispose();
      close();
    }
  });

  it('cancels superseded requests', async () => {
    const { engine, close } = pair();
    try {
      const ctrl = new AbortController();
      const first = engine.query({ groupBy: ['Date[Date]'], values: ['Total Sales'] }, ctrl.signal);
      const second = engine.evaluate('1 + 1');
      ctrl.abort();
      await expect(first).rejects.toMatchObject({ name: 'AbortError' });
      expect(await second).toBe(2);
      const pre = new AbortController();
      pre.abort();
      await expect(engine.evaluate('1', [], pre.signal)).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      engine.dispose();
      close();
    }
  });

  it('runs in-process with the same API', async () => {
    const model = buildModel();
    const engine = createLocalEngine(model);
    expect(await engine.evaluate('[Orders]')).toBe(model.evaluate('[Orders]'));
    const ctrl = new AbortController();
    const p = engine.evaluate('[Orders]', [], ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
