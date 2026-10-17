import { describe, expect, it } from 'vitest';
import { DataModel, DataTable, setBitmapIndexes } from '../src/index';
import type { Row } from '../src/index';

/** Appends and sliding windows extend/shift the table's caches; they must equal caches built from scratch. */
const COLS = ['Channel', 'Amount', 'When', 'Flag', 'Id'];

function rows(from: number, count: number): Row[] {
  return Array.from({ length: count }, (_, j) => {
    const i = from + j;
    return {
      Channel: i % 13 === 0 ? null : `C${(i * 7) % (i < 5000 ? 3 : 5)}`, // new values appear later
      Amount: i % 9 === 0 ? null : (i % 17) * 1.5,
      When: new Date(2024, 0, 1 + (i % 40)),
      Flag: i % 2 === 0,
      Id: i,
    };
  });
}

function warm(t: DataTable): void {
  for (const c of COLS) {
    t.numeric(c);
    t.codes(c);
    t.index(c);
    t.distinct(c);
    t.bitmap(c);
  }
}

function snapshot(t: DataTable) {
  return COLS.map((c) => {
    const { codes, dict } = t.codes(c);
    return {
      numeric: [...t.numeric(c)],
      decoded: [...codes].map((k) => (k < 0 ? null : dict[k])),
      index: [...t.index(c)].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      distinct: t.distinct(c),
      bitmap: t.bitmap(c) && [...t.bitmap(c)!].map(([k, b]) => [k, [...b]]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    };
  });
}

describe('incremental table caches', () => {
  it('appends match a fresh build (including crossing the bitmap threshold)', () => {
    const t = new DataTable('T', rows(0, 3000));
    warm(t);
    const before = t.index('Channel');
    const beforeList = before.get('C0')!.slice();
    for (const [from, count] of [
      [3000, 1],
      [3001, 1500],
      [4501, 3000],
    ])
      t.appendRows(rows(from, count));
    expect(snapshot(t)).toEqual(snapshot(new DataTable('T', rows(0, 7501))));
    // the old index object is untouched (copy on write)
    expect(before.get('C0')).toEqual(beforeList);
    // pure appends keep dictionary codes identical to a fresh build
    expect([...t.codes('Channel').codes]).toEqual([...new DataTable('T', rows(0, 7501)).codes('Channel').codes]);
  });

  it('sliding windows match a fresh build', () => {
    const t = new DataTable('T', rows(0, 6000));
    warm(t);
    t.appendRows(rows(6000, 700));
    t.removeFirst(700);
    expect(snapshot(t)).toEqual(snapshot(new DataTable('T', rows(700, 6000))));
    t.removeFirst(5990);
    expect(snapshot(t)).toEqual(snapshot(new DataTable('T', rows(6690, 10))));
  });

  it('streaming queries match a model loaded at once', () => {
    const build = (data: Row[]) =>
      new DataModel()
        .addTable('Sales', data)
        .addTable('Channel', [
          { Channel: 'C0', Group: 'A' },
          { Channel: 'C1', Group: 'A' },
          { Channel: 'C2', Group: 'B' },
          { Channel: 'C3', Group: 'B' },
          { Channel: 'C4', Group: 'B' },
        ])
        .addRelationship({ from: 'Sales[Channel]', to: 'Channel[Channel]' })
        .addMeasure('Total', 'SUM(Sales[Amount])')
        .addMeasure('Kinds', 'DISTINCTCOUNT(Sales[When])');
    const spec = { groupBy: ['Channel[Group]', 'Sales[Flag]'], values: ['Total', 'Kinds'], filters: [{ target: 'Sales[Channel]', op: 'in' as const, values: ['C0', 'C2', 'C4'] }], totals: true };
    for (const bitmaps of [true, false]) {
      setBitmapIndexes(bitmaps);
      const live = build(rows(0, 5000));
      live.query(spec);
      for (let i = 0; i < 4; i++) {
        live.appendRows('Sales', rows(5000 + i * 800, 800), { maxRows: 5500 });
        const all = rows(0, 5000 + (i + 1) * 800);
        const expected = build(all.slice(all.length - 5500)).query(spec);
        const got = live.query(spec);
        expect(got.rows).toEqual(expected.rows);
        expect(got.totals).toEqual(expected.totals);
      }
    }
    setBitmapIndexes(true);
  });
});
