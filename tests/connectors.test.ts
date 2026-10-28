import { describe, expect, it, vi } from 'vitest';
import { DataModel } from '@prismbi/prismbi/core';
import {
  addArrowTable,
  detectDelimiter,
  googleSheetCsvUrl,
  loadCsv,
  loadGraphQL,
  loadJson,
  loadRest,
  loadSqlTables,
  parseCsv,
  parseCsvColumns,
  streamCsv,
  scheduleRefresh,
  streamInto,
  type MessageSourceLike,
} from '@prismbi/prismbi/connectors';

/** fetch stub answering from a url → body map (functions get the parsed URL / init). */
function fakeFetch(routes: (url: URL, init?: RequestInit) => { body: unknown; headers?: Record<string, string> } | undefined) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost/');
    const hit = routes(url, init);
    if (!hit) return new Response('nope', { status: 404, statusText: 'Not Found' });
    const body = typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body);
    return new Response(body, { status: 200, headers: hit.headers });
  }) as unknown as typeof fetch;
}

describe('CSV', () => {
  it('parses quotes, escaped quotes, embedded newlines, CRLF and a BOM', () => {
    const text = '﻿name,qty,note\r\n"Smith, J",3,"said ""hi"""\r\n"multi\nline",4,\r\n';
    expect(parseCsv(text)).toEqual([
      { name: 'Smith, J', qty: 3, note: 'said "hi"' },
      { name: 'multi\nline', qty: 4, note: null },
    ]);
  });

  it('detects delimiters and types columns as a whole', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\n1\t2')).toBe('\t');
    const rows = parseCsv('zip;amount;ok;when\n02134;1.5;TRUE;2024-01-02\n10001;-2e3;false;2024-02-03');
    expect(rows[0]).toEqual({ zip: '02134', amount: 1.5, ok: true, when: '2024-01-02' });
    expect(rows[1].amount).toBe(-2000);
    // dates are typed by the table
    const m = new DataModel().addTable('T', rows);
    expect(m.table('T').column('when').type).toBe('date');
    expect(m.table('T').column('zip').type).toBe('string');
  });

  it('supports headerless files, duplicate headers and maxRows', () => {
    expect(parseCsv('1,2\n3,4', { header: false })).toEqual([
      { Column1: 1, Column2: 2 },
      { Column1: 3, Column2: 4 },
    ]);
    expect(Object.keys(parseCsv('a,a,\n1,2,3')[0])).toEqual(['a', 'a_2', 'Column3']);
    expect(parseCsv('a\n1\n2\n3', { maxRows: 2 })).toHaveLength(2);
    expect(parseCsv('a\n1', { dynamicTyping: false })).toEqual([{ a: '1' }]);
  });

  it('loads CSV over fetch and builds Google Sheets export URLs', async () => {
    const f = fakeFetch((u) => (u.pathname === '/data.csv' ? { body: 'x,y\n1,2' } : undefined));
    expect(await loadCsv('/data.csv', { fetch: f })).toEqual([{ x: 1, y: 2 }]);
    await expect(loadCsv('/missing.csv', { fetch: f })).rejects.toThrow(/404/);
    expect(googleSheetCsvUrl('https://docs.google.com/spreadsheets/d/abc-123_X/edit#gid=42')).toBe('https://docs.google.com/spreadsheets/d/abc-123_X/export?format=csv&gid=42');
    expect(googleSheetCsvUrl('abc', 7)).toBe('https://docs.google.com/spreadsheets/d/abc/export?format=csv&gid=7');
  });

  it('parses directly into columnar arrays without row object overhead', () => {
    const csv = 'product,price,active\nWidget,19.99,true\nGadget,49.50,false\nGizmo,,true\n';
    const res = parseCsvColumns(csv);
    expect(res.rowCount).toBe(3);
    expect(res.columns.product).toEqual(['Widget', 'Gadget', 'Gizmo']);
    expect(res.columns.price).toEqual([19.99, 49.5, null]);
    expect(res.columns.active).toEqual([true, false, true]);
    expect(res.schema.price.type).toBe('number');
    expect(res.schema.active.type).toBe('boolean');
    expect(res.schema.product.type).toBe('string');

    // add directly to DataModel via addColumns
    const m = new DataModel().addColumns('Products', res.columns, res.schema);
    expect(m.table('Products').rowCount).toBe(3);
    expect(m.table('Products').column('price').type).toBe('number');
  });

  it('streams CSV in chunks with multiline quote preservation and batch callbacks', async () => {
    async function* chunkGenerator() {
      yield 'id,name,value\n1,"Alpha';
      yield '\nBeta",100\n2,"Gamma",200\n';
      yield '3,"Delta",300\n';
    }
    const batches: number[] = [];
    const res = await streamCsv(chunkGenerator(), {
      batchSize: 2,
      onBatch: (b) => batches.push(b.rowCount),
    });
    expect(res.rowCount).toBe(3);
    expect(res.columns.id).toEqual([1, 2, 3]);
    expect(res.columns.name).toEqual(['Alpha\nBeta', 'Gamma', 'Delta']);
    expect(res.columns.value).toEqual([100, 200, 300]);
    expect(batches).toEqual([2, 1]);
  });
});

describe('JSON, REST and GraphQL', () => {
  it('reads rows at a path and column-oriented payloads', async () => {
    const f = fakeFetch((u) => (u.pathname === '/a' ? { body: { data: { items: [{ id: 1 }, { id: 2 }] } } } : { body: { id: [1, 2], v: ['a', 'b'] } }));
    expect(await loadJson('/a', { fetch: f, path: 'data.items' })).toEqual([{ id: 1 }, { id: 2 }]);
    expect(await loadJson('/b', { fetch: f })).toEqual([
      { id: 1, v: 'a' },
      { id: 2, v: 'b' },
    ]);
    await expect(loadJson('/a', { fetch: f })).rejects.toThrow(/did not contain rows/);
  });

  it('follows page, offset, cursor and link pagination', async () => {
    const all = Array.from({ length: 25 }, (_, i) => ({ id: i }));
    const f = fakeFetch((u) => {
      const q = u.searchParams;
      if (u.pathname === '/page') {
        const p = Number(q.get('page'));
        return { body: all.slice((p - 1) * 10, p * 10) };
      }
      if (u.pathname === '/offset') return { body: { rows: all.slice(Number(q.get('offset')), Number(q.get('offset')) + Number(q.get('limit'))) } };
      if (u.pathname === '/cursor') {
        const c = Number(q.get('after') ?? 0);
        return { body: { items: all.slice(c, c + 10), next: c + 10 < 25 ? c + 10 : null } };
      }
      if (u.pathname === '/link') {
        const p = Number(q.get('p') ?? 0);
        return { body: all.slice(p * 10, p * 10 + 10), headers: p < 2 ? { link: `</link?p=${p + 1}>; rel="next"` } : undefined };
      }
      return undefined;
    });
    expect(await loadRest('/page', { fetch: f, pagination: { type: 'page', size: 10 } })).toEqual(all);
    expect(await loadRest('/offset', { fetch: f, path: 'rows', pagination: { type: 'offset', limit: 10 } })).toEqual(all);
    expect(await loadRest('/cursor', { fetch: f, path: 'items', pagination: { type: 'cursor', next: 'next', param: 'after' } })).toEqual(all);
    expect(await loadRest('/link', { fetch: f, pagination: { type: 'link' } })).toEqual(all);
    expect(await loadRest('/page', { fetch: f, pagination: { type: 'page', size: 10 }, maxRows: 12, map: (r) => ({ key: r.id }) })).toEqual(all.slice(0, 12).map((r) => ({ key: r.id })));
  });

  it('runs GraphQL queries and surfaces errors', async () => {
    const f = fakeFetch((_u, init) => {
      const { query, variables } = JSON.parse(String(init?.body));
      if (query.includes('bad')) return { body: { errors: [{ message: 'Syntax' }] } };
      return { body: { data: { orders: { nodes: [{ n: variables.n }] } } } };
    });
    expect(await loadGraphQL('/gql', '{ orders { nodes { n } } }', { fetch: f, path: 'orders.nodes', variables: { n: 5 } })).toEqual([{ n: 5 }]);
    await expect(loadGraphQL('/gql', 'bad', { fetch: f })).rejects.toThrow(/GraphQL error: Syntax/);
  });
});

describe('Arrow and SQL', () => {
  it('adds an Arrow-like table (BigInt, timestamps, structs)', () => {
    const cols: Record<string, unknown[]> = { id: [1n, 2n], at: [Date.UTC(2024, 0, 1), null], meta: [{ toJSON: () => ({ a: 1 }) }, null] };
    const arrow = {
      numRows: 2,
      schema: { fields: [{ name: 'id', type: { typeId: 2 } }, { name: 'at', type: { typeId: 10 } }, { name: 'meta', type: { typeId: 13 } }] },
      getChild: (n: string) => ({ get: (i: number) => cols[n][i] }),
    };
    const m = addArrowTable(new DataModel(), 'A', arrow);
    expect(m.table('A').column('id').values).toEqual([1, 2]);
    expect((m.table('A').column('at').values[0] as Date).getTime()).toBe(Date.UTC(2024, 0, 1));
    expect(m.table('A').column('meta').values).toEqual(['{"a":1}', null]);
  });

  it('loads tables through a SQL adapter', async () => {
    const adapter = { query: vi.fn(async (sql: string) => (sql.includes('a') ? [{ x: 1 }] : [{ y: 2 }])) };
    const m = await loadSqlTables(new DataModel(), adapter, [
      { table: 'A', sql: 'select a' },
      { table: 'B', sql: 'select b' },
    ]);
    expect(m.evaluate('SUM(A[x]) + SUM(B[y])')).toBe(3);
  });
});

describe('streaming and refresh', () => {
  class Source implements MessageSourceLike {
    fns = new Set<(e: { data: unknown }) => void>();
    closed = false;
    addEventListener(_t: 'message', fn: (e: { data: unknown }) => void) {
      this.fns.add(fn);
    }
    removeEventListener(_t: 'message', fn: (e: { data: unknown }) => void) {
      this.fns.delete(fn);
    }
    close() {
      this.closed = true;
    }
    send(data: unknown) {
      for (const f of this.fns) f({ data });
    }
  }

  it('batches messages into appendRows with a sliding window', () => {
    vi.useFakeTimers();
    try {
      const m = new DataModel().addTable('Ticks', [{ t: 0, v: 0 }]).addMeasure('Total', 'SUM(Ticks[v])');
      let renders = 0;
      m.onChange(() => renders++);
      const src = new Source();
      const errors: unknown[] = [];
      const h = streamInto(m, 'Ticks', src, { maxRows: 3, intervalMs: 100, onError: (e) => errors.push(e) });
      src.send(JSON.stringify({ t: 1, v: 1 }));
      src.send([{ t: 2, v: 2 }, { t: 3, v: 3 }]);
      src.send('not json');
      expect(m.table('Ticks').rowCount).toBe(1);
      vi.advanceTimersByTime(100);
      expect(m.table('Ticks').column('v').values).toEqual([1, 2, 3]);
      expect(m.evaluate('[Total]')).toBe(6);
      expect(renders).toBe(1);
      expect(errors).toHaveLength(1);
      src.send({ rows: [{ t: 4, v: 4 }] });
      h.close();
      expect(m.table('Ticks').column('v').values).toEqual([2, 3, 4]);
      expect(src.closed).toBe(true);
      expect(h.received).toBe(4);
      src.send({ t: 5, v: 5 });
      expect(m.table('Ticks').rowCount).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes on a schedule and cancels in-flight loads on stop', async () => {
    vi.useFakeTimers();
    try {
      const m = new DataModel();
      let n = 0;
      const h = scheduleRefresh(m, 'T', async () => [{ n: ++n }], { intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(m.table('T').column('n').values).toEqual([1]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(m.table('T').column('n').values).toEqual([2]);
      await h.refresh();
      expect(m.table('T').column('n').values).toEqual([3]);
      h.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(n).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
