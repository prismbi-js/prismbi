// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createLocalEngine, createWorkerEngine, serveModel, type PortLike } from '@prismbi/prismbi/worker';
import { buildModel } from '../examples/model';

/** A DOM-style message port (node's global MessagePort supports addEventListener; messages are structured-cloned). */
function adapt(port: MessagePort): PortLike {
  return { postMessage: (m, transfer) => port.postMessage(m, transfer ?? []), addEventListener: (t, fn) => port.addEventListener(t, fn as never), removeEventListener: (t, fn) => port.removeEventListener(t, fn as never), start: () => port.start(), terminate: () => port.close() };
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

describe('packed columns', () => {
  it('transfers typed buffers to the worker and answers like a table built from rows', async () => {
    const { DataModel } = await import('@prismbi/prismbi/core');
    const { packColumn, addPackedTable } = await import('@prismbi/prismbi/worker');
    const n = 5000;
    const amount = new Float64Array(n).map((_, i) => (i % 97 === 0 ? NaN : (i * 37) % 1000));
    const category = Array.from({ length: n }, (_, i) => (i % 50 === 0 ? null : ['Bikes', 'Clothing', 'Accessories'][i % 3]));
    const day = Array.from({ length: n }, (_, i) => new Date(2025, 0, 1 + (i % 365)));
    const flag = Array.from({ length: n }, (_, i) => i % 2 === 0);
    const rows = Array.from({ length: n }, (_, i) => ({ Amount: Number.isNaN(amount[i]) ? null : amount[i], Category: category[i], Day: day[i], Flag: flag[i] }));
    const ref = new DataModel().addTable('S', rows).addMeasure('Total', 'SUM(S[Amount])').addMeasure('Rows', 'COUNTROWS(S)');

    const ch = new MessageChannel();
    const model = new DataModel();
    serveModel(model, adapt(ch.port1));
    const engine = createWorkerEngine(adapt(ch.port2));
    try {
      await engine.addColumns('S', { Amount: amount, Category: category, Day: day, Flag: flag });
      // the number buffer moved to the worker: the sender's array is detached
      expect(amount.length).toBe(0);
      await engine.addMeasure({ name: 'Total', expression: 'SUM(S[Amount])' });
      await engine.addMeasure({ name: 'Rows', expression: 'COUNTROWS(S)' });
      const spec = { groupBy: ['S[Category]', 'S[Flag]'], values: ['Total', 'Rows'], filters: [{ target: 'S[Day]', op: 'between' as const, min: new Date(2025, 1, 1), max: new Date(2025, 5, 30) }], totals: true };
      const res = await engine.query(spec);
      const direct = ref.query(spec);
      expect(res.rows).toEqual(direct.rows);
      expect(res.totals).toEqual(direct.totals);
      const meta = await engine.metadata();
      expect(meta.tables.find((t) => t.name === 'S')?.columns.map((c) => [c.name, c.type])).toEqual([['Amount', 'number'], ['Category', 'string'], ['Day', 'date'], ['Flag', 'boolean']]);
    } finally {
      engine.dispose();
      ch.port1.close();
    }

    // transfer: false keeps the caller's arrays; views are adopted, equal to the ones built from values
    const kept = new Float64Array([1, 2, NaN, Infinity]);
    const local = createLocalEngine(new DataModel());
    await local.addColumns('K', { v: kept, s: ['a', '', 'b', 'a'] }, undefined, { transfer: false });
    expect(kept.length).toBe(4);
    const km = new DataModel();
    addPackedTable(km, 'K', { v: packColumn(kept), s: packColumn(['a', '', 'b', 'a']) });
    const t = km.table('K');
    expect(t.column('v').values).toEqual([1, 2, null, null]);
    expect([...t.numeric('v')]).toEqual([1, 2, NaN, NaN]);
    expect(kept[3]).toBe(Infinity);
    expect(t.column('s').values).toEqual(['a', null, 'b', 'a']);
    expect(t.codes('s')).toMatchObject({ codes: new Int32Array([0, -1, 1, 0]), dict: ['a', 'b'] });
    // mixed columns travel as plain values
    expect(packColumn([1, 'x']).kind).toBe('values');
  });
});
